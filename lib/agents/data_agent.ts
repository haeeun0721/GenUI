import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { tool } from "ai";
import { z } from "zod";
import FirecrawlApp from "firecrawl";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATA_AGENT_MODEL = "gemini-2.5-flash" as const;

const firecrawlApp = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY ?? "",
});

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

interface RawProduct {
  pcode: string;
  name: string;
  price: string;
  image: string;
  specText: string; // full raw spec_list text — preserved for contextSummary
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripTags(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Accessory spec_list patterns to skip
const ACCESSORY_PREFIXES = [
  "액세서리", "충전기", "배터리", "브러쉬", "필터", "먼지봉투", "걸레패드",
  "부품", "소모품", "교체용", "적용모델", "사이드브러쉬",
];

function isAccessory(specText: string): boolean {
  const lower = specText.toLowerCase().trim();
  return ACCESSORY_PREFIXES.some(p => lower.startsWith(p)) ||
    lower.includes("적용모델:") ||
    lower.includes("호환");
}

// ---------------------------------------------------------------------------
// Danawa category code map: query keywords → cate parameter
// These ensure we only scrape products from the exact Danawa category page,
// preventing cross-category contamination (e.g., dog strollers, car seats).
// ---------------------------------------------------------------------------

const DANAWA_CATEGORY_MAP: Array<{ keywords: string[]; cate: string; label: string }> = [
  {
    keywords: ["유모차", "stroller", "베이비카"],
    cate: "16249192",
    label: "유모차",
  },
  {
    keywords: ["로봇청소기", "로봇 청소기", "robot vacuum", "로봇청소기"],
    cate: "10243069",
    label: "로봇청소기",
  },
];

function detectCategory(query: string): { cate: string; label: string } | null {
  const q = query.toLowerCase();
  for (const entry of DANAWA_CATEGORY_MAP) {
    if (entry.keywords.some(k => q.includes(k))) return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extract lowest price from Danawa HTML — price_sect ONLY (최저가).
// No MSRP / spec-value fallbacks.
// ---------------------------------------------------------------------------

function extractLowestPrice(html: string, searchStart: number): string {
  // Search up to 30,000 chars forward from product name
  const chunk = html.slice(searchStart, searchStart + 30000);

  // Primary: <a class="click_log_product_standard_price_"><strong>N,NNN</strong>원</a>
  // This is the direct price anchor class on Danawa listing/detail pages
  const m1 = chunk.match(/class="click_log_product_standard_price_"[^>]*><strong>([0-9,]+)<\/strong>/);
  if (m1) return `${m1[1]}원`;

  // Fallback: parent <p class="price_sect"> ... <strong>N,NNN</strong>
  const m2 = chunk.match(/class="price_sect"[\s\S]{0,2000}?<strong>([0-9,]+)<\/strong>/);
  if (m2) return `${m2[1]}원`;

  return "가격 미정";
}

// ---------------------------------------------------------------------------
// Build Danawa CDN image URL from pcode
// Pattern: /prod_img/500000/{last3}/{mid3}/img/{pcode}_1.jpg
// ---------------------------------------------------------------------------

function buildDanawaImageUrl(pcode: string): string {
  const p = pcode.padStart(9, "0");
  const last3 = p.slice(-3);
  const mid3 = p.slice(-6, -3);
  return `https://img.danawa.com/prod_img/500000/${last3}/${mid3}/img/${pcode}_1.jpg`;
}

// ---------------------------------------------------------------------------
// Upgrade danuri.io CDN image URL to highest available resolution (500x500).
// The category/search listing pages request shrunk thumbnails (130:130 or
// 160:160). Replacing the shrink param with 500:500 gives the native catalog
// image — no upscaling, just removing artificial downscaling.
// ---------------------------------------------------------------------------

function upgradeDanuriImageUrl(url: string): string {
  // Replace existing shrink parameter with 500:500
  if (url.includes("shrink=")) {
    return url.replace(/shrink=\d+:\d+/, "shrink=500:500");
  }
  // No shrink param present — append it (keeps other params like _v= intact)
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}shrink=500:500`;
}

// ---------------------------------------------------------------------------
// Scrape Danawa category list page (e.g. cate=16249192 for 유모차)
// This avoids cross-category contamination from the search endpoint.
// ---------------------------------------------------------------------------

async function scrapeDanawaCategoryList(cate: string, count: number): Promise<RawProduct[]> {
  const url = `https://prod.danawa.com/list/?cate=${cate}&limit=${count * 4}&sort=pd`;
  console.log(`[DATA_AGENT] Scraping Danawa category list: ${url}`);

  let html = "";
  try {
    const result = await firecrawlApp.scrape(url, {
      formats: ["html"],
      waitFor: 6000,
    });
    html = (result as any).html ?? "";
  } catch (err) {
    console.warn("[DATA_AGENT] Firecrawl category scrape failed:", err);
    return [];
  }

  if (!html) return [];
  console.log(`[DATA_AGENT] Category HTML length: ${html.length}`);

  return parseProductsFromHtml(html, count, cate);
}

// ---------------------------------------------------------------------------
// Classify query: generic category search vs specific product name search
//
// "유모차" or "로봇청소기"         → generic  → use category list page
// "리안 그램플러스 유모차"          → specific → use search URL with cate filter
//
// Heuristic: if the query, after stripping the category label, still has
// meaningful words (≥ 3 chars), treat it as a specific product query.
// ---------------------------------------------------------------------------

function isGenericCategoryQuery(query: string, categoryLabel: string): boolean {
  const stripped = query
    .toLowerCase()
    .replace(new RegExp(categoryLabel.toLowerCase(), "g"), "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length < 3;
}

// ---------------------------------------------------------------------------
// Scrape Danawa search results HTML
// Routing:
//  - generic category query  → category list page (clean, no cross-category)
//  - specific product query  → search URL with cate= filter
//  - other queries           → plain search URL, no cate filter
// ---------------------------------------------------------------------------

async function scrapeDanawaSearch(query: string, count: number): Promise<RawProduct[]> {
  // Strip synthetic ranking prefix added by LLM (e.g. "인기 순위 10 뉴나 트래블" → "뉴나 트래블")
  // This prefix doesn't exist in actual Danawa product names and causes search failures.
  const cleanQuery = query.replace(/^인기\s*순위\s*\d+\s*/i, '').trim() || query;
  if (cleanQuery !== query) {
    console.log(`[DATA_AGENT] Stripped ranking prefix: "${query}" → "${cleanQuery}"`);
  }

  const categoryMatch = detectCategory(cleanQuery);


  if (categoryMatch) {
    if (isGenericCategoryQuery(cleanQuery, categoryMatch.label)) {
      console.log(`[DATA_AGENT] Generic category query "${cleanQuery}" → category list (cate=${categoryMatch.cate})`);
      return scrapeDanawaCategoryList(categoryMatch.cate, count);
    } else {
      // Specific product query ("리안 그램플러스 기내반입형 휴대용 유모차") → plain search URL, NO cate filter.
      // Reason: strollers span multiple Danawa subcategories (16249192 일반, 16349195 기내반입형, etc.).
      // Forcing cate=16249192 blocks valid products in other subcategories.
      // The specific product name itself prevents cross-category contamination (e.g. dog strollers).
      // cate guard is only needed for GENERIC queries like "유모차" where unrelated items appear.
      console.log(`[DATA_AGENT] Specific product query "${cleanQuery}" → unconstrained search (product name is the filter)`);
      const url = `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(cleanQuery)}&limit=${count * 4}&sort=pd`;
      console.log(`[DATA_AGENT] Search URL: ${url}`);
      let html = "";
      try {
        const result = await firecrawlApp.scrape(url, { formats: ["html"], waitFor: 5000 });
        html = (result as any).html ?? "";
      } catch (err) {
        console.warn("[DATA_AGENT] Firecrawl search scrape failed:", err);
        return [];
      }
      if (!html) return [];
      console.log(`[DATA_AGENT] HTML length: ${html.length}`);
      // null = no cate guard: product name specificity is the cross-category filter here
      return parseProductsFromHtml(html, count, null);
    }
  }

  const url = `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(cleanQuery)}&limit=${count * 4}&sort=pd`;
  console.log(`[DATA_AGENT] Scraping Danawa search HTML: ${url}`);

  let html = "";
  try {
    const result = await firecrawlApp.scrape(url, {
      formats: ["html"],
      waitFor: 5000,
    });
    html = (result as any).html ?? "";
  } catch (err) {
    console.warn("[DATA_AGENT] Firecrawl HTML scrape failed:", err);
    return [];
  }

  if (!html) return [];
  console.log(`[DATA_AGENT] HTML length: ${html.length}`);

  return parseProductsFromHtml(html, count, null);
}

// ---------------------------------------------------------------------------
// Shared HTML parser: extracts RawProduct[] from Danawa listing HTML
// Pass cate to enforce category filtering on product links (category pages only).
// ---------------------------------------------------------------------------

function parseProductsFromHtml(html: string, count: number, cate: string | null): RawProduct[] {
  const products: RawProduct[] = [];
  const seenPcodes = new Set<string>();

  // Find each prod_name block → pcode + name → then search forward for spec_list
  // Use a flexible regex: class attribute may have extra attrs or whitespace before ">"
  const prodNameRegex = /class="prod_name"[^>]*>([\s\S]{0,2000}?)<\/p>/g;
  let nameMatch: RegExpExecArray | null;

  while ((nameMatch = prodNameRegex.exec(html)) !== null && products.length < count * 3) {
    const nameBlock = nameMatch[1];

    // Extract pcode from href inside prod_name
    const pcodeMatch = nameBlock.match(/pcode=(\d+)/);
    if (!pcodeMatch) continue;
    const pcode = pcodeMatch[1];
    if (seenPcodes.has(pcode)) continue;
    seenPcodes.add(pcode);

    // Category guard: block products whose href explicitly carries a *different* cate.
    // If the href has no cate parameter at all (common on search result pages), the
    // product is allowed through — we rely on the search URL's cate= scope in that case.
    // Products from adjacent/related categories (e.g. dog strollers cate=14241801 or
    // car seats cate=4779315) always carry their own cate in the href and are blocked.
    if (cate !== null) {
      const hrefMatch = nameBlock.match(/href="([^"]+)"/);
      if (hrefMatch) {
        const href = hrefMatch[1];
        const hrefCate = href.match(/cate=(\d+)/)?.[1];
        // Only skip if there IS a cate in the href AND it doesn't match ours.
        if (hrefCate && hrefCate !== cate) {
          console.log(`[DATA_AGENT] Skipping product pcode=${pcode} — cate mismatch (${hrefCate} != ${cate})`);
          continue;
        }
      }
    }

    // Extract product name (strip all tags including <b>)
    const name = stripTags(nameBlock).replace(/\s+/g, " ").trim();
    if (!name || name.length < 3) continue;

    // Search forward from prod_name for the next spec_list (within ~3000 chars)
    const forwardStart = nameMatch.index + nameMatch[0].length;
    const forwardChunk = html.slice(forwardStart, forwardStart + 3000);

    const specListMatch = forwardChunk.match(/<div[^>]+class="spec_list"[^>]*>([\s\S]*?)<\/div>/);
    const specText = specListMatch ? stripTags(specListMatch[1]) : "";

    // Skip accessories
    if (isAccessory(specText)) {
      console.log(`[DATA_AGENT] Skipping accessory: ${name.slice(0, 40)}`);
      continue;
    }

    // Extract price — price_sect ONLY (Danawa 최저가).
    // No MSRP fallback, no fuzzy number matching to avoid spec values being misread as price.
    const price = extractLowestPrice(html, forwardStart);

    // Extract image: danuri.io CDN images are always ~600-1100 chars BEFORE prod_name.
    // Upgrade shrink param to 500:500 for maximum catalog resolution (vs default 130:130).
    const backChunk = html.slice(Math.max(0, nameMatch.index - 2000), nameMatch.index);
    let image = "";
    const imgMatch = backChunk.match(/src="(https?:\/\/img\.danuri\.io[^"]+)"/);
    if (imgMatch) {
      image = upgradeDanuriImageUrl(imgMatch[1]);
      // Ensure .jpg/.jpeg/.webp extension (some URLs lack extension)
      if (!/\.(jpg|jpeg|png|webp|gif)/.test(image.split("?")[0])) {
        const qIdx = image.indexOf("?");
        image = qIdx >= 0 ? image.slice(0, qIdx) + ".jpg" + image.slice(qIdx) : image + ".jpg";
      }
    }
    // Fallback: pcode-based Danawa CDN URL
    if (!image) image = buildDanawaImageUrl(pcode);

    // Require at least some spec data
    if (specText.length < 10) continue;

    console.log(`[DATA_AGENT] Found: ${name.slice(0, 50)} | price=${price}`);
    products.push({ pcode, name, price, image, specText });
  }

  console.log(`[DATA_AGENT] Parsed ${products.length} products from HTML`);
  return products;
}

// ---------------------------------------------------------------------------
// Fallback: scrape individual product page when search parse fails
// ---------------------------------------------------------------------------

async function scrapeProductPageFallback(
  pcode: string,
  name: string,
  userQuery: string
): Promise<Partial<RawProduct>> {
  const url = `https://prod.danawa.com/info/?pcode=${pcode}`;
  console.log(`[DATA_AGENT] Fallback scrape: ${url}`);

  let markdown = "";
  try {
    const result = await firecrawlApp.scrape(url, { formats: ["markdown"], waitFor: 5000 });
    markdown = (result as any).markdown ?? "";
  } catch { return {}; }

  if (!markdown) return {};

  const { text } = await generateText({
    model: google(DATA_AGENT_MODEL),
    system: "Extract product data from Danawa product page. Return ONLY valid JSON, no markdown.",
    prompt: `User query: "${userQuery}"\nProduct: ${name}\n\nPage content (first 10000 chars):\n${markdown.slice(0, 10000)}\n\nReturn JSON with these fields:\n{"name":"full product name in Korean","price":"...원~","image":"https://img.danawa.com/...","specText":"spec1/spec2/spec3"}\nIf a field is unavailable, use null for that field.`,
    temperature: 0,
  });

  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch { /* ignore */ }
  return {};
}

// ---------------------------------------------------------------------------
// Scrape individual product detail page for full spec table.
// Firecrawl returns markdown; we parse | key | value | table rows.
// ---------------------------------------------------------------------------

function parseMarkdownSpecTable(markdown: string): Record<string, string> {
  const specs: Record<string, string> = {};
  // Match markdown table rows: | col1 | col2 | (any number of columns)
  const rowRe = /^\|(.+)\|$/gm;
  let match;
  while ((match = rowRe.exec(markdown)) !== null) {
    const cells = match[1].split("|").map(c => c.trim());
    if (cells.length < 2) continue;
    // Skip separator rows (---|---)
    if (cells.every(c => /^[-:\s]+$/.test(c))) continue;
    // Iterate as key-value pairs within the row
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const key = cells[i].replace(/\*\*/g, "").trim();
      const value = cells[i + 1].replace(/\*\*/g, "").trim();
      if (!key || !value || key.length > 30) continue;
      // Skip header-like values that are the same as the key
      if (key === value) continue;
      // Skip obvious navigation/layout cells
      if (["항목", "내용", "구분", "상세", "제품명", "사진", "이미지"].includes(key)) continue;
      specs[key] = value;
    }
  }
  return specs;
}

async function scrapeProductDetailSpecs(pcode: string): Promise<Record<string, string>> {
  const url = `https://prod.danawa.com/info/?pcode=${pcode}`;
  console.log(`[DATA_AGENT] Scraping detail specs: ${url}`);
  try {
    const result = await firecrawlApp.scrape(url, {
      formats: ["markdown"],
      waitFor: 5000,
    });
    const markdown = (result as any).markdown ?? "";
    if (!markdown) return {};
    const specs = parseMarkdownSpecTable(markdown);
    console.log(`[DATA_AGENT] DetailedSpecs for pcode=${pcode}: ${Object.keys(specs).length} fields`);
    return specs;
  } catch (err) {
    console.warn(`[DATA_AGENT] Detail spec scrape failed pcode=${pcode}:`, err);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Parse spec_list text → specs array
// ---------------------------------------------------------------------------

function parseSpecList(specText: string, maxSpecs = 8): string[] {
  const SKIP = /^(로봇\s*청소기|청소기|로봇|유모차|흡입전용|흡입\+물걸레|흡입 \+ 물걸레|절충형|휴대용|디럭스형|기내반입형)$/i;
  return specText
    .split("/")
    .map(s => s.replace(/\s*:\s*/g, ": ").replace(/\s*,\s*/g, ", ").trim())
    .filter(s => s.length > 1 && !SKIP.test(s))
    .slice(0, maxSpecs);
}

// ---------------------------------------------------------------------------
// Extract brand
// ---------------------------------------------------------------------------

const KNOWN_BRANDS = [
  "삼성", "LG", "로보락", "다이슨", "에코백스", "드리미", "나르왈", "아이로봇",
  "샤오미", "치후360", "모바", "클라쎄", "카처", "롤리봇", "부가부", "줄즈",
  "베이비젠", "스토케", "마클라렌", "사이벡스", "누나", "조이", "치코",
];

function extractBrand(name: string): string {
  for (const b of KNOWN_BRANDS) {
    if (name.includes(b)) return b;
  }
  return name.split(/\s+/)[0] ?? "";
}

// ---------------------------------------------------------------------------
// Deduplicate
// ---------------------------------------------------------------------------

const COLOR_SUFFIX = /\s*(블랙|화이트|그레이|베이지|네이비|실버|골드|크림|차콜|새틴그레이지)\s*$/i;

function deduplicate(products: ProductData[]): ProductData[] {
  const seen = new Set<string>();
  return products.filter(p => {
    const base = p.name.replace(COLOR_SUFFIX, "").trim().toLowerCase();
    if (seen.has(base)) return false;
    seen.add(base);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Build ProductData
// ---------------------------------------------------------------------------

function buildProductData(raw: RawProduct): ProductData & { rawSpecText: string } {
  const specs = parseSpecList(raw.specText);
  const brand = extractBrand(raw.name);
  const descSpecs = specs.slice(0, 3).join(", ");
  return {
    id: raw.pcode,
    name: raw.name,
    price: raw.price,
    image: raw.image,
    link: `https://prod.danawa.com/info/?pcode=${raw.pcode}`,
    brand,
    mallName: "다나와",
    description: descSpecs ? `${raw.name} — ${descSpecs}` : raw.name,
    specs,
    rawSpecText: raw.specText, // full spec string for contextSummary
  };
}

// ---------------------------------------------------------------------------
// Data Agent Tool
// ---------------------------------------------------------------------------

export const searchProducts = tool({
  description:
    "Search for real products from Danawa. Scrapes Danawa search results HTML and parses " +
    "structured spec_list elements directly — precise, fast, and no LLM parsing overhead. " +
    "Falls back to individual product page scraping if search results don't yield specs. " +
    "ALWAYS call this BEFORE renderInChat when ui_intent_category is 3 or 2.",
  inputSchema: z.object({
    query: z.string().describe(
      "Product search query in Korean (e.g., '로봇청소기 반려동물'). Include user constraints. When the user has a My Items entry with a link (name|URL format), use only the name part as the query."
    ),
    count: z.number().optional().default(4).describe("Number of products (default: 4, max: 6)"),
    excludeNames: z.array(z.string()).optional().default([]).describe(
      "List of product names already shown to the user in previous turns. " +
      "These will be excluded from results so the user sees fresh products each time."
    ),
    link: z.string().optional().describe(
      "Direct product URL (Danawa detail page) from My Items. When provided, scrape this URL directly instead of searching. " +
      "Extract pcode from the URL and use prod.danawa.com/info/?pcode=XXXX for scraping."
    ),
  }),
  execute: async ({ query, count = 4, excludeNames = [], link }) => {
    console.log(`[DATA_AGENT] Danawa: "${query}" link=${link ? link.slice(0, 60) : 'none'} (count: ${count}, excluding: ${excludeNames.length})`);

    // ---------------------------------------------------------------------------
    // Fast path: if a direct product link is provided, scrape it and return immediately.
    // This is used for My Items comparison where we already know the exact Danawa URL.
    // ---------------------------------------------------------------------------
    if (link) {
      // Resolve canonical Danawa detail page URL
      let detailUrl = link;
      if (!link.includes("prod.danawa.com/info")) {
        const pcodeFromLink = link.match(/pcode=(\d+)/)?.[1];
        if (pcodeFromLink) {
          detailUrl = `https://prod.danawa.com/info/?pcode=${pcodeFromLink}`;
        }
      }
      const pcode = detailUrl.match(/pcode=(\d+)/)?.[1] ?? query;
      console.log(`[DATA_AGENT] Direct link path — scraping: ${detailUrl}`);

      try {
        const detailSpecs = await scrapeProductDetailSpecs(pcode);
        const detailSpecsStr = Object.entries(detailSpecs)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n");

        const contextSummary =
          `[Product 1]\n` +
          `Name: ${query}\n` +
          `Link: ${detailUrl}\n` +
          (detailSpecsStr ? `DetailedSpecs:\n${detailSpecsStr}\n` : "");

        // Build a minimal ProductData so the UI Agent can render it properly
        const product: ProductData = {
          id: pcode,
          name: query,
          price: detailSpecs["출시가"] ?? detailSpecs["가격"] ?? "가격 미정",
          image: buildDanawaImageUrl(pcode),
          link: detailUrl,
          brand: extractBrand(query),
          mallName: "다나와",
          description: query,
          specs: Object.entries(detailSpecs).slice(0, 5).map(([k, v]) => `${k}: ${v}`),
        };

        return { products: [product], contextSummary };
      } catch (err) {
        console.warn(`[DATA_AGENT] Direct link scrape failed, falling back to search:`, err);
        // Fall through to normal search below
      }
    }
    // Normalize exclusion list for fuzzy matching
    const normExclude = excludeNames.map(n => n.toLowerCase().replace(/\s+/g, ""));
    const isExcluded = (name: string) => {
      const normName = name.toLowerCase().replace(/\s+/g, "");
      return normExclude.some(ex => normName.includes(ex) || ex.includes(normName));
    };
    try {
      let rawProducts = await scrapeDanawaSearch(query, count);

      // Fallback: if too few results, scrape individual pages for first few pcodes
      if (rawProducts.length < Math.min(count, 2)) {
        console.log("[DATA_AGENT] Too few results from search parse, trying fallback...");

        // Re-scrape with links format to get pcodes.
        // For specific product queries, use the search URL (not the category list)
        // so we find the actual product being searched for.
        const cleanQueryFallback = query.replace(/^인기\s*순위\s*\d+\s*/i, '').trim() || query;
        const categoryMatch2 = detectCategory(cleanQueryFallback);
        const isGenericFallback = categoryMatch2 && isGenericCategoryQuery(cleanQueryFallback, categoryMatch2.label);
        const fallbackScrapeUrl = isGenericFallback
          ? `https://prod.danawa.com/list/?cate=${categoryMatch2.cate}&limit=10&sort=pd`
          : `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(cleanQueryFallback)}&limit=10&sort=pd`;
        console.log(`[DATA_AGENT] Fallback URL: ${fallbackScrapeUrl}`);
        const linksResult = await firecrawlApp.scrape(fallbackScrapeUrl, { formats: ["links"], waitFor: 4000 });
        const allLinks: string[] = (linksResult as any).links ?? [];
        // No cate filter — strollers span multiple subcategories (16249192, 16349195 etc.)
        const pcodes = [...new Set(
          allLinks
            .filter(l => l.includes("prod.danawa.com/info") && l.includes("pcode="))
            .map(l => l.match(/pcode=(\d+)/)?.[1] ?? "")
            .filter(Boolean)
        )].slice(0, count * 2);


        // Scrape individual pages
        const fallbackResults = await Promise.all(
          pcodes.slice(0, count).map(async (pcode) => {
            const extra = await scrapeProductPageFallback(pcode, "", query);
            if (!extra.specText) return null;
            return {
              pcode,
              name: extra.name ?? `제품 ${pcode}`,
              price: extra.price ?? "가격 미정",
              image: extra.image ?? "",
              specText: extra.specText ?? "",
            } as RawProduct;
          })
        );
        rawProducts = [...rawProducts, ...fallbackResults.filter((r): r is RawProduct => r !== null)];
      }

      if (rawProducts.length === 0) {
        return { products: [], message: "다나와에서 검색 결과를 찾을 수 없습니다." };
      }

      // Filter out previously shown products before deduplication
      const freshProducts = rawProducts.filter(r => !isExcluded(r.name));
      console.log(`[DATA_AGENT] After exclusion filter: ${freshProducts.length} / ${rawProducts.length} products remain.`);

      const products = deduplicate(freshProducts.map(buildProductData)).slice(0, count);
      console.log(`[DATA_AGENT] Returning ${products.length} products.`);

      // Scrape individual product detail pages in parallel for full spec tables.
      // This is the primary source of accurate spec data for the Table component.
      console.log(`[DATA_AGENT] Scraping detail pages for ${products.length} products in parallel...`);
      const detailSpecsArray = await Promise.all(
        products.map((p: any) => scrapeProductDetailSpecs(p.id))
      );
      const detailSpecsMap = new Map<string, Record<string, string>>();
      products.forEach((p: any, i: number) => {
        detailSpecsMap.set(p.id, detailSpecsArray[i] ?? {});
      });

      const contextSummary = products
        .map(
          (p: any, i: number) => {
            const detailedSpecs = detailSpecsMap.get(p.id) ?? {};
            const detailedSpecsStr = Object.entries(detailedSpecs)
              .map(([k, v]) => `  ${k}: ${v}`)
              .join("\n");
            return (
              `[Product ${i + 1}]\n` +
              `Name: ${p.name}\n` +
              `Price: ${p.price}\n` +
              `Brand: ${p.brand}\n` +
              `Mall: ${p.mallName}\n` +
              `Image: ${p.image}\n` +
              `Link: ${p.link}\n` +
              `Specs: ${p.specs.join(" / ")}\n` +
              `RawSpecs: ${p.rawSpecText ?? p.specs.join(" / ")}\n` +
              (detailedSpecsStr ? `DetailedSpecs:\n${detailedSpecsStr}\n` : "") +
              `Description: ${p.description}`
            );
          }
        )
        .join("\n\n");

      return { products, contextSummary };
    } catch (error) {
      console.error("[DATA_AGENT] Error:", error);
      return {
        products: [],
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});
