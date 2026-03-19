require("dotenv").config();
const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

const CACHE_TTL_MS = 10 * 60 * 1000;
const responseCache = new Map();

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
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

    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
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
      timeout: 10000
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

        const fraction = (fractionEl.textContent || "").replace(/[^\d]/g, "");
        const cents = centsEl ? (centsEl.textContent || "").replace(/[^\d]/g, "") : "";

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

      function getNodeContextText(node) {
        if (!node) return "";
        const parent = node.parentElement;
        const grandParent = parent ? parent.parentElement : null;
        const container = grandParent || parent || node;
        return normalize(container.textContent || "").toLowerCase();
      }

      function isInstallmentContext(node) {
        const text = getNodeContextText(node);
        return (
          text.includes("sin intereses") ||
          text.includes("meses") ||
          text.includes("mensual") ||
          text.includes("cuota") ||
          text.includes("ver los medios de pago") ||
          /x\s*\$/i.test(text)
        );
      }

      function isPreviousMoneyNode(node) {
        if (!node) return false;
        const cls = String(node.className || "");
        return cls.includes("andes-money-amount--previous") || !!node.closest("s");
      }

      function extractMoneyCandidates(root) {
        if (!root) return [];

        const moneyNodes = Array.from(root.querySelectorAll(".andes-money-amount"));
        const candidates = [];

        for (const money of moneyNodes) {
          const price = parseMoneyNode(money);
          if (price == null) continue;

          candidates.push({
            price,
            isPrevious: isPreviousMoneyNode(money),
            isInstallment: isInstallmentContext(money),
            text: getNodeContextText(money)
          });
        }

        return candidates;
      }

      function chooseMainPriceFromCandidates(candidates) {
        if (!candidates.length) return { current_price: null, previous_price: null };

        const previousCandidates = candidates
          .filter(c => c.isPrevious)
          .map(c => c.price);

        const primaryCurrent = candidates.filter(c => !c.isPrevious && !c.isInstallment);
        const fallbackCurrent = candidates.filter(c => !c.isPrevious);

        let currentPrice = null;

        if (primaryCurrent.length) {
          currentPrice = Math.max(...primaryCurrent.map(c => c.price));
        } else if (fallbackCurrent.length) {
          currentPrice = Math.max(...fallbackCurrent.map(c => c.price));
        }

        const previousPrice = previousCandidates.length
          ? Math.max(...previousCandidates)
          : null;

        return {
          current_price: currentPrice,
          previous_price: previousPrice
        };
      }

      function collectMainOffer() {
        const roots = [
          document.querySelector("#price"),
          document.querySelector(".ui-pdp-price__main-container"),
          document.querySelector('[data-testid="price-part"]')
        ].filter(Boolean);

        for (const root of roots) {
          const candidates = extractMoneyCandidates(root);
          const chosen = chooseMainPriceFromCandidates(candidates);

          if (chosen.current_price != null || chosen.previous_price != null) {
            return {
              current_price: chosen.current_price,
              previous_price: chosen.previous_price,
              row_text: normalize(root.textContent),
              candidates
            };
          }
        }

        return null;
      }

      function collectOfferBlocks() {
        const blocks = [];
        const seen = new Set();
        const divs = Array.from(document.querySelectorAll("div"));

        for (const div of divs) {
          const text = normalize(div.textContent);
          const lower = text.toLowerCase();

          const looksLikeOffer =
            text.includes("$") &&
            (
              lower.includes("comprar ahora") ||
              lower.includes("agregar al carrito") ||
              lower.includes("llega") ||
              lower.includes("retiro gratis")
            );

          if (!looksLikeOffer) continue;

          const candidates = extractMoneyCandidates(div);

          const currentCandidates = candidates.filter(c => !c.isPrevious && !c.isInstallment);
          const fallbackCandidates = candidates.filter(c => !c.isPrevious);
          const previousCandidates = candidates.filter(c => c.isPrevious);

          if (!currentCandidates.length && !fallbackCandidates.length) continue;

          const currentPrice = currentCandidates.length
            ? Math.max(...currentCandidates.map(c => c.price))
            : Math.max(...fallbackCandidates.map(c => c.price));

          const previousPrice = previousCandidates.length
            ? Math.max(...previousCandidates.map(c => c.price))
            : null;

          const block = {
            current_price: currentPrice,
            previous_price: previousPrice,
            row_text: text,
            has_today:
              lower.includes("llega hoy") ||
              lower.includes("llega gratis hoy"),
            has_tomorrow:
              lower.includes("llega mañana") ||
              lower.includes("a partir de mañana"),
            has_delivery:
              lower.includes("llega") || lower.includes("retiro gratis")
          };

          const key = `${block.current_price}|${block.previous_price}|${block.row_text.slice(0, 180)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          blocks.push(block);
        }

        return blocks;
      }

      function chooseOffer(offerRows, mainOffer, offerType) {
        if (offerType === "SAMEDAY_DELIVERY") {
          const todayRows = offerRows.filter(r => r.has_today && r.current_price != null);
          if (todayRows.length) {
            todayRows.sort((a, b) => a.current_price - b.current_price);
            return { source: "today_row", ...todayRows[0] };
          }

          const tomorrowRows = offerRows.filter(r => r.has_tomorrow && r.current_price != null);
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
            if (row.current_price != null) {
              candidates.push({ source: "offer_row", ...row });
            }
          }

          candidates.sort((a, b) => a.current_price - b.current_price);
          return candidates[0] || null;
        }

        if (mainOffer && mainOffer.current_price != null) {
          return { source: "main_offer", ...mainOffer };
        }

        const validRows = offerRows.filter(r => r.current_price != null);
        if (validRows.length) {
          validRows.sort((a, b) => a.current_price - b.current_price);
          return { source: "offer_row", ...validRows[0] };
        }

        return null;
      }

      const mainOffer = collectMainOffer();
      const offerRows = collectOfferBlocks();
      const chosen = chooseOffer(offerRows, mainOffer, offerType);

      return {
        title: getTitle(),
        mainOffer,
        offerRows,
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
        main_offer_previous_price: result.mainOffer ? result.mainOffer.previous_price : null,
        main_offer_candidates: result.mainOffer ? result.mainOffer.candidates : [],
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
