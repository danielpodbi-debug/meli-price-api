require("dotenv").config();
const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const responseCache = new Map();

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true
    });
  }
  return browserPromise;
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "meli-price-api" });
});

app.get("/meli-price", async (req, res) => {
  let context = null;
  let page = null;
  let stage = "init";

  try {
    const rawUrl = String(req.query.url || "").trim();

    if (!rawUrl) {
      return res.status(400).json({
        ok: false,
        error: "Falta el parametro url"
      });
    }

    stage = "parse_url";
    const urlObj = new URL(rawUrl);

    if (!/mercadolibre\./i.test(urlObj.hostname)) {
      return res.status(400).json({
        ok: false,
        error: "Dominio no permitido"
      });
    }

    const offerType = urlObj.searchParams.get("offer_type") || null;
    const idInfo = extraerId(rawUrl);

    if (!idInfo) {
      return res.status(400).json({
        ok: false,
        error: "No se pudo extraer un ID valido desde la URL"
      });
    }

    const cacheKey = `${rawUrl}|${offerType || ""}`;
    const cached = responseCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
      return res.json({
        ...cached.data,
        debug: {
          ...cached.data.debug,
          cache_hit: true
        }
      });
    }

    stage = "get_browser";
    const browser = await getBrowser();

    stage = "new_context";
    context = await browser.newContext({
      locale: "es-MX",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    });

    page = await context.newPage();

    stage = "goto";
    await page.goto(rawUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    stage = "wait_selectors";
    await page.waitForSelector("#price, .ui-pdp-price__main-container, h1", {
      timeout: 8000
    }).catch(() => {});

    stage = "evaluate";
    const result = await page.evaluate((offerType) => {
      function normalize(text) {
        return String(text || "").replace(/\s+/g, " ").trim();
      }

      function parseMoneyNode(node) {
        if (!node) return null;

        const fractionEl = node.querySelector(".andes-money-amount__fraction");
        const centsEl = node.querySelector(".andes-money-amount__cents");

        if (!fractionEl) return null;

        const fraction = fractionEl.textContent.replace(/[^\d]/g, "");
        const cents = centsEl ? centsEl.textContent.replace(/[^\d]/g, "") : "";

        if (!fraction) return null;
        return cents ? Number(`${fraction}.${cents}`) : Number(fraction);
      }

      function getTitle() {
        const selectors = ["h1", '[data-testid="header-title"]', ".ui-pdp-title"];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && normalize(el.textContent)) return normalize(el.textContent);
        }
        return null;
      }

      function collectOffersBlocks() {
        const blocks = [];
        const seen = new Set();
        const allDivs = Array.from(document.querySelectorAll("div"));

        for (const div of allDivs) {
          const text = normalize(div.textContent);
          const lower = text.toLowerCase();

          const looksLikeOffer =
            text.includes("$") &&
            (lower.includes("comprar ahora") || lower.includes("agregar al carrito"));

          if (!looksLikeOffer) continue;

          const moneyNodes = Array.from(div.querySelectorAll(".andes-money-amount"));
          const parsed = [];

          for (const money of moneyNodes) {
            const price = parseMoneyNode(money);
            if (price == null) continue;

            const cls = String(money.className || "");
            const isPrevious =
              cls.includes("andes-money-amount--previous") || !!money.closest("s");

            parsed.push({ price, isPrevious });
          }

          const currentPrices = parsed
            .filter(p => !p.isPrevious)
            .map(p => p.price);

          const previousPrices = parsed
            .filter(p => p.isPrevious)
            .map(p => p.price);

          if (!currentPrices.length) continue;

          const block = {
            current_price: Math.min(...currentPrices),
            previous_price: previousPrices.length ? Math.max(...previousPrices) : null,
            row_text: text,
            has_today: lower.includes("llega hoy") || lower.includes("llega gratis hoy"),
            has_tomorrow: lower.includes("llega mañana") || lower.includes("a partir de mañana"),
            has_delivery: lower.includes("llega") || lower.includes("retiro gratis")
          };

          const key = `${block.current_price}|${block.previous_price}|${block.row_text.slice(0, 180)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          blocks.push(block);
        }

        return blocks;
      }

      function collectMainOffer() {
        const root =
          document.querySelector("#price") ||
          document.querySelector(".ui-pdp-price__main-container");

        if (!root) return null;

        const moneyNodes = Array.from(root.querySelectorAll(".andes-money-amount"));
        const parsed = [];

        for (const money of moneyNodes) {
          const price = parseMoneyNode(money);
          if (price == null) continue;

          const cls = String(money.className || "");
          const isPrevious =
            cls.includes("andes-money-amount--previous") || !!money.closest("s");

          parsed.push({ price, isPrevious });
        }

        const currentPrices = parsed.filter(p => !p.isPrevious).map(p => p.price);
        const previousPrices = parsed.filter(p => p.isPrevious).map(p => p.price);

        return {
          current_price: currentPrices.length ? Math.min(...currentPrices) : null,
          previous_price: previousPrices.length ? Math.max(...previousPrices) : null,
          row_text: normalize(root.textContent)
        };
      }

      function chooseOffer(offerRows, mainOffer, offerType) {
        if (offerType === "SAMEDAY_DELIVERY") {
          const todayRows = offerRows.filter(r => r.has_today);
          if (todayRows.length) {
            todayRows.sort((a, b) => a.current_price - b.current_price);
            return { source: "today_row", ...todayRows[0] };
          }

          const tomorrowRows = offerRows.filter(r => r.has_tomorrow);
          if (tomorrowRows.length) {
            tomorrowRows.sort((a, b) => a.current_price - b.current_price);
            return { source: "tomorrow_row_fallback", ...tomorrowRows[0] };
          }
        }

        if (offerType === "BEST_PRICE") {
          const candidates = [];

          if (mainOffer && mainOffer.current_price != null) {
            candidates.push({ source: "main_offer", ...mainOffer });
          }

          for (const row of offerRows) {
            candidates.push({ source: "offer_row", ...row });
          }

          const valid = candidates.filter(c => c.current_price != null);
          valid.sort((a, b) => a.current_price - b.current_price);
          return valid[0] || null;
        }

        if (mainOffer && mainOffer.current_price != null) {
          return { source: "main_offer", ...mainOffer };
        }

        if (offerRows.length) {
          const sorted = [...offerRows].sort((a, b) => a.current_price - b.current_price);
          return { source: "offer_row", ...sorted[0] };
        }

        return null;
      }

      const offerRows = collectOffersBlocks();
      const mainOffer = collectMainOffer();
      const chosen = chooseOffer(offerRows, mainOffer, offerType);

      return {
        title: getTitle(),
        offerRows,
        mainOffer,
        chosen
      };
    }, offerType);

    const payload = {
      ok: true,
      source_type: "catalog_offer_resolution",
      product_or_item_id: idInfo.id,
      title: result.title || null,
      price: result.chosen ? result.chosen.current_price : null,
      previous_price: result.chosen ? result.chosen.previous_price : null,
      currency: "MXN",
      permalink: rawUrl,
      offer_type: offerType,
      debug: {
        chosen_source: result.chosen ? result.chosen.source : null,
        chosen_row_text: result.chosen ? result.chosen.row_text : null,
        offer_rows_found: result.offerRows ? result.offerRows.length : 0,
        main_offer_price: result.mainOffer ? result.mainOffer.current_price : null,
        cache_hit: false
      }
    };

    responseCache.set(cacheKey, {
      timestamp: Date.now(),
      data: payload
    });

    return res.json(payload);
  } catch (error) {
    console.error("Error en /meli-price:", error);

    return res.status(500).json({
      ok: false,
      error: error.message,
      stage
    });
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (_) {}
    }

    if (context) {
      try {
        await context.close();
      } catch (_) {}
    }
  }
});

function extraerId(url) {
  const itemMatch = url.match(/\b(ML[A-Z]-\d+)\b/i);
  if (itemMatch) {
    return {
      type: "item",
      id: itemMatch[1].replace("-", "").toUpperCase()
    };
  }

  const productMatch = url.match(/\b(ML[A-Z]\d+)\b/i);
  if (productMatch) {
    return {
      type: "product",
      id: productMatch[1].toUpperCase()
    };
  }

  return null;
}

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
