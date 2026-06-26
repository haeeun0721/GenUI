import { tool } from "ai";
import { z } from "zod";
import * as cheerio from "cheerio";

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
        `Specs: ${p.specs.length > 0 ? p.specs.join(" / ") : "정보 없음"}\n` +
        `Description: ${p.description || "정보 없음"}`
    )
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Keyword Extractor — fallback only (query already cleaned upstream)
// ---------------------------------------------------------------------------

const CATEGORY_KEYWORD_MAP: [RegExp, string][] = [
  [/유모차|stroller|베이비카|pram/i, "유모차"],
  [/로봇\s*청소기|robot\s*vacuum|룸바/i, "로봇청소기"],
  [/에어프라이어|air\s*fryer/i, "에어프라이어"],
  [/노트북|laptop|맥북/i, "노트북"],
  [/청소기|vacuum/i, "청소기"],
  [/세탁기|washing\s*machine/i, "세탁기"],
  [/냉장고|refrigerator/i, "냉장고"],
  [/공기청정기|air\s*purifier/i, "공기청정기"],
];

function extractDanawaKeyword(query: string): string {
  for (const [pattern, keyword] of CATEGORY_KEYWORD_MAP) {
    if (pattern.test(query)) {
      console.log(`[KEYWORD] Extracted "${keyword}" from query: "${query.slice(0, 60)}"`);
      return keyword;
    }
  }
  const cleaned = query
    .replace(/추천해줘|알려줘|찾아줘|조건으로|이상|이하|기준|구매|제품|상품|보여줘|검색/g, "")
    .trim();
  const keyword = cleaned.split(/\s+/).slice(0, 2).join(" ");
  console.log(`[KEYWORD] Fallback keyword: "${keyword}" from query: "${query.slice(0, 60)}"`);
  return keyword;
}

// ---------------------------------------------------------------------------
// Danawa Headers
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

// ---------------------------------------------------------------------------
// Danawa Detail Page Scraper
// 상품 상세 페이지에서 전체 스펙 테이블을 실제로 긁어옴.
// AI가 스펙을 임의 생성하지 않고 실제 HTML에서만 추출.
// ---------------------------------------------------------------------------

async function scrapeDanawaDetail(
  link: string
): Promise<{ specs: string[]; description: string; price: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(link, {
      headers: DANAWA_HEADERS,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return { specs: [], description: "", price: "" };

    const html = await res.text();
    const $ = cheerio.load(html);
    const specs: string[] = [];
    const seen = new Set<string>();

    const addSpec = (label: string, value: string) => {
      const key = `${label.trim()}: ${value.trim()}`;
      if (label.trim() && value.trim() && value.trim() !== "-" && !seen.has(key)) {
        seen.add(key);
        specs.push(key);
      }
    };

    // ── 1. 모든 스펙 테이블 형태 (th/td) ─────────────────────────────────
    $(`
      .spec_list_wrap .spec_tbl tr,
      .spec_tbl tr,
      .detail_spec table tr,
      .prod_spec_table tr,
      .spec_info_area table tr,
      .detail_info_wrap table tr,
      .tbl_wrap table tr,
      table.spec tr
    `).each((_, row) => {
      const th = $(row).find("th").text().trim();
      const td = $(row).find("td").text().trim().replace(/\s+/g, " ");
      addSpec(th, td);
    });

    // ── 2. dl/dt/dd 형태 ────────────────────────────────────────────────
    $(".spec_list dl, .spec_list_wrap dl, .prod_spec dl").each((_, dl) => {
      const dt = $(dl).find("dt").text().trim();
      const dd = $(dl).find("dd").text().trim().replace(/\s+/g, " ");
      addSpec(dt, dd);
    });

    // ── 3. li 항목 형태 ─────────────────────────────────────────────────
    if (specs.length < 5) {
      $(".spec_list > li").each((_, el) => {
        const text = $(el).text().trim().replace(/\s+/g, " ");
        if (text && text.length > 2 && !seen.has(text)) {
          seen.add(text);
          specs.push(text);
        }
      });
    }

    // ── 4. 제품 주요 특징 (스티커/배지) ─────────────────────────────────
    $(".prod_point_list li, .prod_sticker span, .point_list li").each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, " ");
      if (text && text.length > 2 && text.length < 60 && !seen.has(text)) {
        seen.add(text);
        specs.push(`특징: ${text}`);
      }
    });

    // ── 5. 가격 추출 ────────────────────────────────────────────────────
    const priceRaw = $(".lowest_price strong, .price_sect strong, .low_price strong, .prod_price strong")
      .first().text().replace(/[^\d,]/g, "").trim();
    const price = priceRaw ? `${priceRaw}원` : "";

    // ── 6. 설명 추출 ────────────────────────────────────────────────────
    const description =
      $(".item_intro_content, .prod_description, .prod_intro_area, .prod_summary_area")
        .first()
        .text()
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 400) || "";

    console.log(`[DETAIL] ${link.slice(0, 60)} → ${specs.length} specs, price=${price}`);
    return { specs: specs.slice(0, 25), description, price }; // 최대 25개 스펙
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn(`[DETAIL] Timeout: ${link.slice(0, 60)}`);
    } else {
      console.warn(`[DETAIL] Failed: ${link.slice(0, 60)}:`, err?.message ?? err);
    }
    return { specs: [], description: "", price: "" };
  }
}

// ---------------------------------------------------------------------------
// Danawa Category URL Scraper
// 검색어 대신 카테고리 cate 코드로 직접 접근 → 더 정확한 모수 확보
// sort=posCnt: 인기순, 페이지네이션으로 최대 50개까지 수집
// ---------------------------------------------------------------------------

async function scrapeDanawaByCategory(
  cateCode: string,
  count: number,
  excludeNames: string[]
): Promise<ProductData[]> {
  const allBasic: ProductData[] = [];
  const perPage = 30;
  const maxPages = Math.ceil(count / perPage) + 1;

  for (let page = 1; page <= maxPages && allBasic.length < count * 1.5; page++) {
    const url = `https://www.danawa.com/product/?cate=${cateCode}&sort=posCnt&limit=${perPage}&page=${page}`;
    console.log(`[CATE] Page ${page}: ${url}`);

    try {
      const res = await fetch(url, { headers: DANAWA_HEADERS, signal: AbortSignal.timeout(10000) });
      if (!res.ok) break;

      const html = await res.text();
      const $ = cheerio.load(html);
      let pageCount = 0;

      $("ul.product_list > li.prod_item").each((i, el) => {
        const elId = $(el).attr("id") ?? "";
        if (elId.startsWith("ad") || elId.startsWith("Ad")) return;

        const nameEl = $(el).find(".prod_name a").first();
        const name = nameEl.text().trim();
        if (!name) return;
        if (excludeNames.some((ex) => name.includes(ex) || ex.includes(name))) return;
        if (allBasic.some((p) => p.name === name)) return; // 중복 제거

        const href = nameEl.attr("href") ?? "";
        const fullLink = href.startsWith("http") ? href : `https://www.danawa.com${href}`;
        const priceText = $(el).find(".price_sect strong").first().text().replace(/[^\d,]/g, "").trim();
        const price = priceText ? `${priceText}원` : "가격 미정";
        const imgEl = $(el).find(".thumb_link img, .thumb_image img").first();
        const rawImage = [
          imgEl.attr("data-src"), imgEl.attr("data-original"),
          imgEl.attr("data-lazy"), imgEl.attr("src"),
        ].find((c) => c && !isPlaceholder(c)) ?? "";
        const image = normalizeImageUrl(rawImage, fullLink);
        const specText = $(el).find(".spec_list").text().trim();
        const basicSpecs = specText
          ? specText.split("/").map((s) => s.trim()).filter(Boolean).slice(0, 5)
          : [];

        allBasic.push({
          id: `cate-${Date.now()}-${allBasic.length}`,
          name, price, image, link: fullLink,
          brand: extractBrand(name),
          mallName: "다나와",
          description: "",
          specs: basicSpecs,
        });
        pageCount++;
      });

      console.log(`[CATE] Page ${page}: ${pageCount} products (total: ${allBasic.length})`);
      if (pageCount === 0) break; // 더 이상 결과 없음
    } catch (err: any) {
      console.warn(`[CATE] Page ${page} failed:`, err?.message ?? err);
      break;
    }
  }

  console.log(`[CATE] Total collected: ${allBasic.length} products for cate=${cateCode}`);
  if (allBasic.length === 0) return [];

  // 상세 페이지 병렬 스크래핑 (count개만)
  const targets = allBasic.slice(0, count);
  const detailResults = await Promise.allSettled(targets.map((p) => scrapeDanawaDetail(p.link)));

  return targets.map((p, idx) => {
    const detail = detailResults[idx];
    if (detail.status === "fulfilled" && detail.value.specs.length > 0) {
      return { ...p, specs: detail.value.specs, description: detail.value.description || p.name };
    }
    return { ...p, description: p.description || p.name };
  });
}

// ---------------------------------------------------------------------------
// Danawa List Page Scraper + Detail Enrichment
// ---------------------------------------------------------------------------

async function scrapeDanawa(
  query: string,
  count: number,
  excludeNames: string[]
): Promise<ProductData[]> {
  // query는 buildSearchKeyword()에서 이미 정제된 상태로 옴 ("디럭스 유모차" 등)
  // extractDanawaKeyword()를 한 번 더 거치면 "유모차"로 잘릴 수 있어서 직접 사용
  const searchUrl = `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(query)}&tab=goods`;
  console.log(`[DANAWA] Fetching: ${searchUrl}`);

  const res = await fetch(searchUrl, { headers: DANAWA_HEADERS });
  if (!res.ok) throw new Error(`Danawa HTTP ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);
  const basicProducts: ProductData[] = [];

  $("ul.product_list > li.prod_item").each((i, el) => {
    if (basicProducts.length >= count * 2) return false; // 상세 긁어올 것 감안해 여유분 확보

    const elId = $(el).attr("id") ?? "";
    if (elId.startsWith("ad") || elId.startsWith("Ad")) return;

    const nameEl = $(el).find(".prod_name a").first();
    const name = nameEl.text().trim();
    if (!name) return;
    if (excludeNames.some((ex) => name.includes(ex) || ex.includes(name))) return;

    const href = nameEl.attr("href") ?? "";
    const fullLink = href.startsWith("http") ? href : `https://www.danawa.com${href}`;

    const priceEl = $(el).find(".price_sect strong").first();
    const priceText = priceEl.text().replace(/[^\d,]/g, "").trim();
    const price = priceText ? `${priceText}원` : "가격 미정";

    const imgEl = $(el).find(".thumb_link img, .thumb_image img").first();
    const rawImage = [
      imgEl.attr("data-src"),
      imgEl.attr("data-original"),
      imgEl.attr("data-lazy"),
      imgEl.attr("src"),
    ].find((c) => c && !isPlaceholder(c)) ?? "";
    const image = normalizeImageUrl(rawImage, fullLink);

    // 목록 페이지의 기본 스펙 (상세 페이지 접근 실패 시 fallback으로 사용)
    const specText = $(el).find(".spec_list").text().trim();
    const basicSpecs = specText
      ? specText.split("/").map((s) => s.trim()).filter(Boolean).slice(0, 5)
      : [];

    console.log(`[DANAWA] #${i + 1} "${name.slice(0, 30)}" | img=${image.slice(0, 60)}`);

    basicProducts.push({
      id: `dw-${Date.now()}-${i}`,
      name,
      price,
      image,
      link: fullLink,
      brand: extractBrand(name),
      mallName: "다나와",
      description: "", // 상세 페이지에서 채울 예정
      specs: basicSpecs,
    });
  });

  console.log(`[DANAWA] List scraped: ${basicProducts.length} products for "${query}"`);

  if (basicProducts.length === 0) return [];

  // 상세 페이지 병렬 스크래핑 (count개만 / 5초 타임아웃)
  const targets = basicProducts.slice(0, count);
  const detailResults = await Promise.allSettled(
    targets.map((p) => scrapeDanawaDetail(p.link))
  );

  const enriched = targets.map((p, idx) => {
    const detail = detailResults[idx];
    if (detail.status === "fulfilled" && detail.value.specs.length > 0) {
      return {
        ...p,
        specs: detail.value.specs,
        description: detail.value.description || p.name,
      };
    }
    // 상세 실패 시 목록 스펙 그대로 사용 (임의 생성 없음)
    return { ...p, description: p.description || p.name };
  });

  return enriched;
}


// ---------------------------------------------------------------------------
// Main Tool Export
// ---------------------------------------------------------------------------

export const searchProducts = tool({
  description:
    "Search for real Korean products by scraping Danawa (list + detail pages). " +
    "No AI-generated product data — only real scraped values.",
  inputSchema: z.object({
    query: z.string().describe(
      "Product search intent in Korean (e.g., '신생아 서스펜션 유모차 추천'). A category keyword will be extracted automatically for Danawa."
    ),
    count: z.number().optional().default(4).describe(
      "Number of products to return (default: 4, max: 6)"
    ),
    excludeNames: z.array(z.string()).optional().default([]).describe(
      "List of product names already shown to the user. These will be excluded from results."
    ),
    link: z.string().optional().describe(
      "Direct Danawa product page URL. If provided, scrapes that page directly instead of searching."
    ),
  }),
  execute: async ({ query, count = 4, excludeNames = [], link }) => {
    // link가 있으면 해당 페이지에서 직접 스펙 긁어옴 (이름 검색 없이)
    if (link) {
      console.log(`[DATA_AGENT] Direct scrape via link: ${link.slice(0, 80)}`);
      const detail = await scrapeDanawaDetail(link);
      const product: ProductData = {
        id: `direct-${Date.now()}`,
        name: query,
        price: detail.price || "가격 미정",
        image: "",
        link,
        brand: extractBrand(query),
        mallName: "다나와",
        description: detail.description || query,
        specs: detail.specs,
      };
      const contextSummary = buildContextSummary([product]);
      return { products: [product], contextSummary };
    }

    console.log(`[DATA_AGENT] query="${query.slice(0, 80)}" count=${count}`);
    try {
      // Node.js + Cheerio 직접 크롤링 (단일 경로)
      const products = await scrapeDanawa(query, count, excludeNames);

      if (products.length === 0) {
        console.warn("[DATA_AGENT] 0 results. Danawa may have blocked or changed structure.");
      }

      console.log(`[DATA_AGENT] Returning ${products.length} products.`);
      const contextSummary = buildContextSummary(products);
      return { products, contextSummary };
    } catch (error) {
      console.error("[DATA_AGENT] Fatal error:", error);
      return {
        products: [],
        contextSummary: "",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});
