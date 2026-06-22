import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import * as cheerio from "cheerio";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATA_AGENT_MODEL = "claude-sonnet-4-6" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProductData {
  id: string;
  name: string;
  price: string;
  image: string;
  link: string;
  brand: string;
  mallName: string;
  description: string;
  specs: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractJson(text: string): any[] {
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(text.slice(firstBracket, lastBracket + 1));
    } catch { /* continue */ }
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return [JSON.parse(text.slice(firstBrace, lastBrace + 1))];
    } catch { /* continue */ }
  }
  return [];
}

const KNOWN_BRANDS = [
  "삼성", "LG", "로보락", "다이슨", "에코백스", "드리미", "나르왈", "아이로봇",
  "샤오미", "치후360", "부가부", "줄즈", "베이비젠", "스토케", "마클라렌",
  "사이벡스", "누나", "조이", "치코", "페도라", "디트로네", "콤비", "UPPAbaby",
];

function extractBrand(name: string): string {
  for (const b of KNOWN_BRANDS) {
    if (name.toLowerCase().includes(b.toLowerCase())) return b;
  }
  return name.split(/\s+/)[0] ?? "";
}

function normalizeImageUrl(imageUrl: string, productLink: string): string {
  if (!imageUrl) return "";
  if (imageUrl.startsWith("//")) return `https:${imageUrl}`;
  if (imageUrl.startsWith("/") && productLink) {
    try {
      const urlObj = new URL(productLink);
      return `${urlObj.origin}${imageUrl}`;
    } catch { /* ignore */ }
  }
  return imageUrl;
}

function proxyImageUrl(url: string): string {
  if (!url) return "";
  // Already a proxy URL or relative path — skip
  if (url.startsWith("/api/image-proxy")) return url;
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

function buildContextSummary(products: ProductData[]): string {
  return products
    .map(
      (p, i) =>
        `[Product ${i + 1}]\n` +
        `Name: ${p.name}\n` +
        `Price: ${p.price}\n` +
        `Brand: ${p.brand}\n` +
        `Mall: ${p.mallName}\n` +
        `Image: ${proxyImageUrl(p.image)}\n` +
        `Link: ${p.link}\n` +
        `Specs: ${p.specs.join(" / ")}\n` +
        `Description: ${p.description}`
    )
    .join("\n\n");
}


// ---------------------------------------------------------------------------
// Danawa Scraper — Korean IP, cheerio HTML parsing
// ---------------------------------------------------------------------------

const DANAWA_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  Referer: "https://www.danawa.com/",
};

// Danawa placeholder image patterns — skip if matched
const PLACEHOLDER_PATTERNS = ["noImg_160.gif", "noData", "no_image", "blank.gif", "loading."];

function isPlaceholder(url: string): boolean {
  if (!url) return true;
  if (url.startsWith("data:")) return true;
  return PLACEHOLDER_PATTERNS.some((p) => url.includes(p));
}

async function scrapeDanawa(
  query: string,
  count: number,
  excludeNames: string[]
): Promise<ProductData[]> {
  const searchUrl = `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(query)}&tab=goods`;
  console.log(`[DANAWA] Fetching: ${searchUrl}`);

  const res = await fetch(searchUrl, { headers: DANAWA_HEADERS });
  if (!res.ok) throw new Error(`Danawa HTTP ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);
  const products: ProductData[] = [];

  $("ul.product_list > li.prod_item").each((i, el) => {
    if (products.length >= count) return false;

    // Skip ad items
    const elId = $(el).attr("id") ?? "";
    if (elId.startsWith("ad") || elId.startsWith("Ad")) return;

    // --- Name ---
    const nameEl = $(el).find(".prod_name a").first();
    const name = nameEl.text().trim();
    if (!name) return;
    if (excludeNames.some((ex) => name.includes(ex) || ex.includes(name))) return;

    const href = nameEl.attr("href") ?? "";
    const fullLink = href.startsWith("http") ? href : `https://www.danawa.com${href}`;

    // --- Price: .price_sect strong ---
    const priceEl = $(el).find(".price_sect strong").first();
    const priceText = priceEl.text().replace(/[^\d,]/g, "").trim();
    const price = priceText ? `${priceText}원` : "가격 미정";

    // --- Image: .thumb_link img or .thumb_image img ---
    // data-src = lazy-load real URL; src may be placeholder
    const imgEl = $(el).find(".thumb_link img, .thumb_image img").first();
    const rawImage = [
      imgEl.attr("data-src"),
      imgEl.attr("data-original"),
      imgEl.attr("data-lazy"),
      imgEl.attr("src"),
    ].find((c) => c && !isPlaceholder(c)) ?? "";
    const image = normalizeImageUrl(rawImage, fullLink);

    console.log(`[DANAWA] #${i + 1} "${name.slice(0, 30)}" | img=${image.slice(0, 70)}`);

    // --- Specs: .spec_list text split by '/' ---
    const specText = $(el).find(".spec_list").text().trim();
    const specs = specText
      ? specText.split("/").map((s) => s.trim()).filter(Boolean).slice(0, 5)
      : [];

    products.push({
      id: `dw-${Date.now()}-${i}`,
      name,
      price,
      image,
      link: fullLink,
      brand: extractBrand(name),
      mallName: "다나와",
      description: name,
      specs,
    });
  });

  console.log(`[DANAWA] Scraped ${products.length} products for "${query}"`);
  return products;
}

// ---------------------------------------------------------------------------
// Claude Knowledge Fallback
// ---------------------------------------------------------------------------

async function claudeKnowledgeFallback(
  query: string,
  count: number,
  excludeNames: string[]
): Promise<ProductData[]> {
  console.log(`[FALLBACK] Claude knowledge for "${query}"`);

  const excludeClause =
    excludeNames.length > 0
      ? `\n이미 보여준 제품이므로 제외: ${excludeNames.join(", ")}`
      : "";

  const result = await generateText({
    model: anthropic(DATA_AGENT_MODEL),
    temperature: 0,
    // image URL은 요청하지 않음 — Claude가 없는 URL을 hallucinate하기 때문
    system: `You are a Korean product expert. Return ONLY a valid JSON array. No markdown, no explanation.
JSON structure: [{"name":"...","price":"...원","link":"https://...","specs":["...","..."]}]
Rules:
- price: in Korean won format e.g. "1,290,000원". Use your training knowledge.
- link: official product page or major Korean shopping link (e.g. smartstore.naver.com, coupang.com).
- specs: 3-5 key specs in Korean.
- Do NOT include an image field.`,
    prompt: `"${query}" 제품 ${count}개를 추천해줘. 실제 존재하는 제품만.${excludeClause}\nJSON 배열로만 반환.`,
  });

  const parsed = extractJson(result.text);
  if (parsed.length === 0) {
    console.warn("[FALLBACK] Failed to parse Claude response:", result.text.slice(0, 300));
    return [];
  }

  return parsed.slice(0, count).map((p: any, i: number) => ({
    id: `cl-${Date.now()}-${i}`,
    name: String(p.name ?? `제품 ${i + 1}`),
    price: String(p.price ?? "가격 미정"),
    image: "",   // 이미지 없음 — 프론트에서 placeholder 표시
    link: String(p.link ?? ""),
    brand: extractBrand(String(p.name ?? "")),
    mallName: "AI 추천",
    description: String(p.name ?? ""),
    specs: Array.isArray(p.specs) ? p.specs.map(String) : [],
  }));
}

// ---------------------------------------------------------------------------
// Direct URL fetch (My Items with known link)
// ---------------------------------------------------------------------------

async function fetchFromUrl(query: string, link: string): Promise<ProductData[]> {
  console.log(`[URL_FETCH] Fetching product from URL: ${link.slice(0, 60)}`);

  const result = await generateText({
    model: anthropic(DATA_AGENT_MODEL),
    tools: {
      webFetch: anthropic.tools.webFetch_20250910({ maxUses: 3 }),
    } as any,
    temperature: 0,
    system: `You are a product data extractor. Return ONLY a valid JSON array. No markdown.
JSON structure: [{"name":"...","price":"...원","image":"https://...","link":"https://...","specs":["...","..."]}]`,
    prompt: `다음 URL에서 제품 정보를 추출해줘.
URL: ${link}
제품명 참고: ${query}
webFetch로 페이지 열고 제품명, 가격(원화), 이미지 URL(og:image 또는 data-src 우선), 스펙을 추출해 JSON 배열로만 반환.`,
  });

  const parsed = extractJson(result.text);
  if (parsed.length === 0) return [];

  return parsed.slice(0, 1).map((p: any, i: number) => ({
    id: `url-${Date.now()}-${i}`,
    name: String(p.name ?? query),
    price: String(p.price ?? "가격 미정"),
    image: normalizeImageUrl(String(p.image ?? ""), link),
    link,
    brand: extractBrand(String(p.name ?? query)),
    mallName: new URL(link).hostname.replace("www.", ""),
    description: String(p.name ?? query),
    specs: Array.isArray(p.specs) ? p.specs.map(String) : [],
  }));
}

// ---------------------------------------------------------------------------
// Main Tool Export
// ---------------------------------------------------------------------------

export const searchProducts = tool({
  description:
    "Search for real Korean products. Tries Danawa scraping first (Korean IP), " +
    "then falls back to Claude knowledge if scraping yields no results. " +
    "ALWAYS call this BEFORE renderInChat when ui_intent_category is 3 or 2.",
  inputSchema: z.object({
    query: z.string().describe(
      "Product search query in Korean (e.g., '신생아 서스펜션 유모차'). Include user constraints."
    ),
    count: z.number().optional().default(4).describe(
      "Number of products to return (default: 4, max: 6)"
    ),
    excludeNames: z.array(z.string()).optional().default([]).describe(
      "List of product names already shown to the user. These will be excluded from results."
    ),
    link: z.string().optional().describe(
      "Direct product URL from My Items. When provided, fetch product info from this URL directly."
    ),
  }),
  execute: async ({ query, count = 4, excludeNames = [], link }) => {
    console.log(
      `[DATA_AGENT] query="${query}" link=${link ? link.slice(0, 60) : "none"} count=${count}`
    );

    try {
      let products: ProductData[] = [];

      if (link) {
        // Path A: Direct URL (My Items with known link)
        products = await fetchFromUrl(query, link);
        if (products.length === 0) {
          products = await claudeKnowledgeFallback(query, 1, []);
        }
      } else {
        // Path B: Danawa scraping
        try {
          products = await scrapeDanawa(query, count, excludeNames);
        } catch (scrapeErr) {
          console.warn("[DANAWA] Scraping failed:", scrapeErr);
        }

        // Path C: Claude knowledge fallback
        if (products.length === 0) {
          console.log("[DATA_AGENT] Danawa 0 results → Claude fallback");
          products = await claudeKnowledgeFallback(query, count, excludeNames);
        }
      }

      console.log(`[DATA_AGENT] Returning ${products.length} products.`);
      const contextSummary = buildContextSummary(products);
      return { products, contextSummary };
    } catch (error) {
      console.error("[DATA_AGENT] Fatal error:", error);
      return {
        products: [],
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});
