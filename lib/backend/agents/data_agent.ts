import { tool, generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { getSpec, setSpec, makeCacheKey as sharedMakeCacheKey } from "../services/spec-cache";

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
  [/로봇\s*청소기|robot\s*vacuum|룸바/i, "로봇 청소기"],
  [/카메라|미러리스|dslr|camera/i, "카메라"],
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

// ---------------------------------------------------------------------------
// 비교표 스펙 보강 파이프라인 (Tavily 기반)
// UI Agent는 JSON 생성만 담당하고, 데이터 보강은 여기서 처리
// ---------------------------------------------------------------------------



type TavilyResult = { title: string; url: string; content: string; score: number };

// Cell Value Cache — spec-cache.ts로 이전 (공유 캐시)
// 두 파이프라인이 동일한 data/cell-cache.json을 공유
// import는 파일 최상단으로 이동됨 (ES 모듈 규칙)

function makeCacheKey(productName: string, criterion: string): string {
  return sharedMakeCacheKey(productName, criterion);
}

export async function tavilySearch(
  query: string,
  searchDepth: "basic" | "advanced" = "basic"
): Promise<TavilyResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) { console.warn("[Tavily] API 키 없음"); return []; }
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ query, search_depth: searchDepth, max_results: 5 }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) { console.warn(`[Tavily] ${res.status}`); return []; }
  const data = await res.json() as { results?: TavilyResult[] };
  return data.results ?? [];
}


// ---------------------------------------------------------------------------
// STEP 0: DB 스펙 키 기반 셀 값 사전 결정 (LLM 호출 없음)
// UI Agent(Claude)가 DB 데이터를 "추론"하는 문제를 원천 차단.
// 각 (기준 × 제품) 셀에 대해 다나와 스펙 키를 검색하고 값을 프로그래밍적으로 결정.
// - 스펙 키 매칭 시: 해당 값 복사 (○, 구체적 값, 또는 없음이면 "X")
// - 미매칭 시: "-" → Data Agent의 Tavily 파이프라인이 이후 보강
// ---------------------------------------------------------------------------

export interface PreFilledRow {
  /** 기준 표시 레이블 (중요도/괄호 제거 후) */
  criterion: string;
  /** { "prod_0": "5축광학식", "prod_1": "-", ... } */
  cells: Record<string, string>;
}

export interface PreFilledTable {
  rows: PreFilledRow[];
  productCols: Array<{ key: string; name: string; imageUrl: string }>;
}

/** [중요], [보통], [낮음] 및 괄호 주석 제거 */
function cleanLabel(c: string): string {
  return c.replace(/\s*\[.*?\]/g, "").replace(/\s*\(.*?\)/g, "").trim();
}

/**
 * 스펙 항목 문자열(e.g. "손떨림보정: 5축광학식")에서 key/value 분리.
 * 다나와 스펙은 "셔터스피드:1/8000초", "프로세서:Bionz XR" 처럼
 * value 내부에 "내부키:" 접두어가 붙는 경우가 있어서 이를 제거.
 */
function parseSpecEntry(entry: string): { key: string; rawValue: string } {
  const idx = entry.indexOf(":");
  if (idx === -1) return { key: entry.trim(), rawValue: "" };
  const key = entry.substring(0, idx).trim();
  let rawValue = entry.substring(idx + 1).trim();
  // 내부 "단어:" 접두어 제거 (e.g. "프로세서:Bionz XR" → "Bionz XR")
  const inner = rawValue.match(/^([가-힣A-Za-z]{1,10}):(.+)/);
  if (inner) rawValue = inner[2].trim();
  return { key, rawValue };
}

/** 스펙 rawValue를 표시용 셀 값으로 변환 */
function toDisplayValue(rawValue: string): string {
  if (!rawValue || rawValue === "-") return "-";
  if (rawValue === "○") return "○";
  // 명시적 부재 표현 → "X"
  if (/없음|미지원|해당없음|불가/.test(rawValue)) return "X";
  // 15자 초과 시 앞부분 자르기
  return rawValue.length > 15 ? rawValue.slice(0, 15) : rawValue;
}

/** 기준 레이블에 맞는 스펙 항목을 찾아 셀 값 반환. 없으면 "-". */
function lookupCellValue(label: string, specs: string[]): string {
  const labelLower = label.toLowerCase().replace(/\s+/g, "");
  const keywords   = label.toLowerCase().split(/\s+/).filter(w => w.length >= 2);

  // 1순위: 스펙 키 정규화 후 완전 포함 매칭
  for (const spec of specs) {
    const { key, rawValue } = parseSpecEntry(spec);
    const keyLower = key.toLowerCase().replace(/\s+/g, "");
    if (keyLower === labelLower || keyLower.includes(labelLower) || labelLower.includes(keyLower)) {
      return toDisplayValue(rawValue);
    }
  }

  // 2순위: 키워드 하나라도 스펙 키에 포함
  for (const spec of specs) {
    const { key, rawValue } = parseSpecEntry(spec);
    const keyLower = key.toLowerCase().replace(/\s+/g, "");
    if (keywords.some(kw => keyLower.includes(kw) || kw.includes(keyLower))) {
      return toDisplayValue(rawValue);
    }
  }

  // 3순위: 스펙 값(value)에 기준명이 정확히 포함
  // e.g., 기준 "DSLR" → 스펙 "디카 분류: DSLR" → value "DSLR" 매칭 → "○" 반환
  for (const spec of specs) {
    const { rawValue } = parseSpecEntry(spec);
    const valueLower = rawValue.toLowerCase().replace(/\s+/g, "");
    if (valueLower === labelLower ||
        (labelLower.length >= 3 && valueLower === labelLower)) {
      return "○"; // 해당 스펙 값이 기준명과 일치 → 제품이 해당 카테고리임을 확인
    }
  }

  return "-";
}

/**
 * 비교표 셀 값을 DB 스펙에서 프로그래밍적으로 사전 결정한다.
 * UI Agent(Claude)에게 데이터 판단을 맡기지 않고,
 * 이 함수의 결과를 프롬프트에 포함하여 Claude는 JSON 구조 생성에만 집중하게 한다.
 */
export function preFillTableCells(
  criteria: string[],
  productDataText: string
): PreFilledTable {
  // [Product N] 블록 파싱
  const blocks = productDataText.split(/\[Product \d+\]/).filter(b => b.trim());

  const productCols: PreFilledTable["productCols"] = [];
  const allSpecs: string[][] = [];

  blocks.forEach((block, idx) => {
    const nameMatch  = block.match(/Name:\s*(.+)/);
    const imageMatch = block.match(/Image:\s*(\S+)/);
    const specsMatch = block.match(/Specs:\s*(.+)/);
    if (!nameMatch) return;

    productCols.push({
      key:      `prod_${idx}`,
      name:     nameMatch[1].trim(),
      imageUrl: imageMatch?.[1]?.trim() ?? "",
    });
    allSpecs.push(
      specsMatch?.[1]?.split(" / ").map(s => s.trim()).filter(Boolean) ?? []
    );
  });

  const rows: PreFilledRow[] = criteria.map(criterion => {
    const label = cleanLabel(criterion);
    const cells: Record<string, string> = {};
    productCols.forEach(({ key }, idx) => {
      cells[key] = lookupCellValue(label, allSpecs[idx] ?? []);
    });
    return { criterion: label, cells };
  });

  console.log(`[STEP 0] DB 스펙 키 사전 결정 완료 (${rows.length}개 기준 × ${productCols.length}개 제품):`);
  rows.forEach(r => {
    const vals = Object.entries(r.cells).map(([k, v]) => `${k}:${v}`).join(" | ");
    console.log(`         "${r.criterion}" → ${vals}`);
  });

  return { rows, productCols };
}

type CompTableJson = {
  props?: {
    columns?: Array<{ key: string; label: string }>;
    rows?: Array<Record<string, string>>;
  };
  [k: string]: unknown;
};

function findMissingCells(tableJson: CompTableJson) {
  const columns = tableJson.props?.columns ?? [];
  const rows = tableJson.props?.rows ?? [];
  const productCols = columns.filter(c => c.key !== "criterion");
  const missing: Array<{ rowCriterion: string; colKey: string; productLabel: string }> = [];
  for (const row of rows) {
    const criterion = row["criterion"] ?? "";
    if (!criterion || criterion === "순위" || criterion === "Rank") continue;
    for (const col of productCols) {
      if (!row[col.key] || row[col.key] === "-")
        missing.push({ rowCriterion: criterion, colKey: col.key, productLabel: col.label });
    }
  }
  return missing;
}

function parseProductSpecsFromContext(uiContext: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const blocks = uiContext.split(/\[Product \d+\]/);
  for (const block of blocks) {
    const nameMatch = block.match(/Name:\s*(.+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    const specsMatch = block.match(/Specs:\s*(.+)/);
    const descMatch = block.match(/Description:\s*(.+)/);
    const specs = (specsMatch?.[1] ?? "").split("/").map(s => s.trim()).filter(Boolean);
    if (descMatch?.[1]) specs.push(descMatch[1].trim());
    map.set(name, specs);
  }
  return map;
}

function findSpecsForLabel(shortLabel: string, specMap: Map<string, string[]>): string[] {
  const lower = shortLabel.toLowerCase().trim();
  for (const [name, specs] of specMap) {
    const nameLower = name.toLowerCase();
    if (nameLower.includes(lower) || lower.includes(nameLower.slice(0, 8))) return specs;
  }
  const firstWord = lower.split(/\s+/)[0] ?? "";
  if (firstWord.length >= 2) {
    for (const [name, specs] of specMap) {
      if (name.toLowerCase().includes(firstWord)) return specs;
    }
  }
  return [];
}

function isCriterionGrounded(criterion: string, specs: string[]): boolean {
  if (specs.length === 0) return false;
  const specText = specs.join(" ").toLowerCase();
  const keywords = criterion.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  return keywords.some(kw => specText.includes(kw));
}

function findUngroundedCells(tableJson: CompTableJson, uiContext: string) {
  const specMap = parseProductSpecsFromContext(uiContext);
  const columns = tableJson.props?.columns ?? [];
  const rows = tableJson.props?.rows ?? [];
  const productCols = columns.filter(c => c.key !== "criterion");
  const ungrounded: Array<{ rowCriterion: string; colKey: string; productLabel: string; originalValue: string }> = [];
  for (const row of rows) {
    const criterion = row["criterion"] ?? "";
    if (!criterion || criterion === "순위" || criterion === "Rank") continue;
    for (const col of productCols) {
      const val = row[col.key];
      if (val !== "○" && val !== "X") continue;
      const specs = findSpecsForLabel(col.label, specMap);
      if (!isCriterionGrounded(criterion, specs))
        ungrounded.push({ rowCriterion: criterion, colKey: col.key, productLabel: col.label, originalValue: val });
    }
  }
  return ungrounded;
}

export async function expandCriterionSynonyms(criteria: string[]): Promise<Record<string, string[]>> {
  if (criteria.length === 0) return {};
  const { text } = await generateText({
    model: anthropic("claude-haiku-4-5"),
    system: "You are a Korean product spec synonym generator. Given a list of product criteria in Korean, return a JSON object where each key is the criterion and the value is an array of 2-3 Korean synonyms or related search terms. Output only valid JSON.",
    prompt: `Generate synonyms for these criteria: ${JSON.stringify(criteria)}`,
    temperature: 0,
  });
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  } catch { return {}; }
}

export function detectCriterionType(criterion: string): "value" | "boolean" {
  const VALUE_KEYWORDS = [
    "무게", "중량", "가격", "가격대", "크기", "사이즈", "길이", "너비", "높이", "두께",
    "용량", "배터리", "소음", "흡입력", "수명", "시간", "속도", "rpm", "파스칼", "pa",
    "db", "watt", "mah", "mm", "cm", "kg", "g", "먼지통", "물탱크", "바구니", "장바구니",
    "물통", "차양막"
  ];
  const lower = criterion.toLowerCase();
  return VALUE_KEYWORDS.some(k => lower.includes(k)) ? "value" : "boolean";
}

function extractKeywordWindow(content: string, keywords: string[], windowSize = 300): string {
  if (!content) return "";
  const lower = content.toLowerCase();
  const kwLower = keywords.map(k => k.toLowerCase()).filter(k => k.length >= 2);
  let bestStart = 0, bestScore = -1;
  for (let i = 0; i <= Math.max(0, content.length - windowSize); i += 50) {
    const window = lower.slice(i, i + windowSize);
    const score = kwLower.reduce((acc, kw) => acc + (window.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; bestStart = i; }
  }
  return content.slice(bestStart, bestStart + windowSize).trim();
}

export async function judgeCell(
  productName: string,
  criterion: string,
  snippets: TavilyResult[],
  locale: string,
  criterionType: "boolean" | "value" = detectCriterionType(criterion),
  synonyms: string[] = []
): Promise<{ value: string; sourceUrl?: string; usedSnippet?: string }> {
  if (snippets.length === 0) return { value: "-" };
  const productNameWords = productName.split(/\s+/).filter(w => w.length >= 2);
  const keywords = [
    criterion,
    ...synonyms,
    ...criterion.split(/\s+/),
    productName,
    ...productNameWords
  ].filter(w => w.length >= 2);
  const snippetText = snippets.slice(0, 3).map((r, i) => {
    const window = extractKeywordWindow(r.content, keywords, 300);
    return `[${i + 1}] (${r.url})\n${window}`;
  }).join("\n\n");

  const systemPrompt = criterionType === "value"
    ? `You are a product spec extractor. Given search snippets, extract the specific value for the criterion.\nRespond with ONLY a JSON object: { "value": "<extracted value or '-'>", "sourceIndex": <1-based index or null> }\nIf a specific measurable value is found (e.g., "6.2kg", "최대 22kg", "75dB"), extract it verbatim (max 15 chars). If the value is a price, ALWAYS format it in Korean Won (KRW) like "000,000원". If not found, output "-".`
    : `You are a product spec verifier. Given search snippets, determine if the product has the specified feature.\nRespond with ONLY a JSON object: { "value": "○" | "X" | "-", "sourceIndex": <1-based index or null> }\n"○" = confirmed present, "X" = confirmed absent, "-" = cannot determine.`;

  const { text } = await generateText({
    model: anthropic("claude-haiku-4-5"),
    system: systemPrompt,
    prompt: `Product: ${productName}\nFeature/Criterion: ${criterion}\n\nSearch Snippets:\n${snippetText}`,
    temperature: 0,
  });
  try {
    const match = text.match(/\{[\s\S]*?\}/);
    const result = match ? JSON.parse(match[0]) : { value: "-" };
    const srcIdx: number | null = result.sourceIndex ?? null;
    const usedSnippetObj = srcIdx != null ? snippets[srcIdx - 1] : null;
    const usedSnippet = usedSnippetObj
      ? extractKeywordWindow(usedSnippetObj.content, keywords, 120).replace(/\s+/g, " ")
      : undefined;
    return { value: result.value ?? "-", sourceUrl: usedSnippetObj?.url, usedSnippet };
  } catch { return { value: "-" }; }
}

/**
 * 비교표 스펙 보강 (STEP 1.5 ~ 4.5)
 * UI Agent가 생성한 1차 tableJson을 받아 Tavily 검색으로 누락 셀을 채우고
 * 원본 객체를 in-place 업데이트한다.
 */
export async function enrichCompTableCells(
  tableJson: CompTableJson,
  uiContext: string,
  locale: string
): Promise<void> {
  const columns = tableJson.props?.columns ?? [];
  const productCols = columns.filter(c => c.key !== "criterion");
  const allRows = tableJson.props?.rows ?? [];

  // shortLabel → 전체 제품명 매핑 (uiContext의 "Name: ..." 파싱)
  // find()는 첫 번째 매칭을 반환하므로 "EOS 6D"가 "EOS 6D Mark II"에 잘못 매핑되는 문제가 있었음.
  // → 후보 전체를 수집하고 가장 짧은(= 가장 정확한) 이름을 선택하도록 수정.
  const fullNameMap = new Map<string, string>();
  {
    const nameMatches = [...uiContext.matchAll(/Name:\s*(.+)/g)].map(m => m[1].trim());
    for (const col of productCols) {
      const labelWords = col.label.split(/\s+/).filter(w => w.length >= 2);
      if (labelWords.length === 0) continue;

      // 레이블 단어를 모두 포함하는 후보 수집
      const candidates = nameMatches.filter(name => {
        const nameLower = name.toLowerCase();
        return labelWords.every(w => nameLower.includes(w.toLowerCase()));
      });

      if (candidates.length === 0) continue;

      // 후보 중 가장 짧은 이름 선택 (불필요한 단어가 가장 적음 = 가장 정확한 매칭)
      const matched = candidates.reduce((best, curr) =>
        curr.length < best.length ? curr : best
      );

      fullNameMap.set(col.label, matched);
      const note = candidates.length > 1 ? ` (후보 ${candidates.length}개 중 최단 선택)` : "";
      console.log(`\x1b[90m[Data Agent] 제품명 매핑: "${col.label}" → "${matched}"${note}\x1b[0m`);
    }
  }

  // ── Pre-enrich 스니펫 캐시 ─────────────────────────────────────────────
  // enrichContextWithTavily가 uiContext에 주입한 WebSpecs를 파싱해
  // Data Agent가 동일 스펙을 Tavily에서 재검색하는 낭비를 방지한다.
  // Format: "WebSpecs (from web search): criterion: snippet | criterion2: snippet2"
  type PreEnrichedCell = { rowCriterion: string; colKey: string; productLabel: string; snippets: TavilyResult[] };
  const preEnrichedCells: PreEnrichedCell[] = [];

  const preEnrichCache = new Map<string, string>();  // `productLabel||criterion` → snippet
  {
    const blockRe = /Name:\s*(.+?)[\s\S]*?WebSpecs \(from web search\):\s*([^\n]+)/g;
    let bm;
    while ((bm = blockRe.exec(uiContext)) !== null) {
      const productName = bm[1].trim();
      const webLine = bm[2].trim();
      // label 역조회
      let label = productName;
      for (const [l, n] of fullNameMap) { if (n === productName) { label = l; break; } }
      for (const item of webLine.split(" | ")) {
        const idx = item.indexOf(": ");
        if (idx === -1) continue;
        preEnrichCache.set(`${label}||${item.slice(0, idx).trim()}`, item.slice(idx + 2).trim());
      }
    }
    if (preEnrichCache.size > 0)
      console.log(`\x1b[36m[Data Agent] Pre-enrich 캐시: ${preEnrichCache.size}개 항목 로드\x1b[0m`);
  }

  function getPreEnrichedSnippets(label: string, rowCriterion: string): TavilyResult[] | null {
    const cleanRow = rowCriterion.replace(/\s*[\[\(].*?[\]\)]/g, "").trim().toLowerCase();
    for (const [key, snippet] of preEnrichCache) {
      const [cachedLabel, cachedCrit] = key.split("||");
      if (cachedLabel !== label) continue;
      const cleanCrit = cachedCrit.replace(/\s*[\[\(].*?[\]\)]/g, "").trim().toLowerCase();
      if (cleanRow.includes(cleanCrit) || cleanCrit.includes(cleanRow))
        return [{ title: "Pre-enriched", url: "pre-enrich", content: snippet, score: 1.0 }];
    }
    return null;
  }

  // STEP 1.5: 행 단위 타입 결정
  const rowTypeMap = new Map<string, "boolean" | "value">();
  for (const row of allRows) {
    const criterion = row["criterion"] ?? "";
    if (!criterion || criterion === "순위" || criterion === "Rank") continue;
    let rowType = detectCriterionType(criterion);
    for (const col of productCols) {
      const val = String((row as Record<string, string>)[col.key] ?? "");
      if (val && val !== "-" && val !== "○" && val !== "X") { rowType = "value"; break; }
    }
    rowTypeMap.set(criterion, rowType);
  }
  console.log("\x1b[33m[Data Agent STEP 1.5] 행 유형 결정:\x1b[0m");
  for (const [crit, type] of rowTypeMap)
    console.log(`         "${crit}" → ${type}`);

  // STEP 2: 미확인 셀 + 근거 없는 셀 탐지
  console.log("\n\x1b[33m[Data Agent STEP 2] 1차 표 분석:\x1b[0m");
  const missingCells = findMissingCells(tableJson);
  const ungroundedCells = findUngroundedCells(tableJson, uiContext);
  const ungroundedKeys = new Set(ungroundedCells.map(c => `${c.colKey}__${c.rowCriterion}`));

  for (const row of allRows) {
    const criterion = row["criterion"] ?? "";
    if (!criterion) continue;
    const cells = productCols.map(col => {
      const val = row[col.key];
      const missing = !val || val === "-";
      const isUngrounded = ungroundedKeys.has(`${col.key}__${criterion}`);
      const symbol = missing ? "\x1b[31m?\x1b[0m" : isUngrounded ? `\x1b[33m⚠${val}\x1b[0m` : `\x1b[32m${val}\x1b[0m`;
      return `${col.label.slice(0, 8)}: ${symbol}`;
    }).join("  |  ");
    console.log(`         ${criterion.padEnd(15)} │ ${cells}`);
  }

  const verifyKeySet = new Set<string>();
  const allCellsToVerify: Array<{ rowCriterion: string; colKey: string; productLabel: string }> = [];
  const addToVerify = (cell: { rowCriterion: string; colKey: string; productLabel: string }) => {
    const k = `${cell.colKey}__${cell.rowCriterion}`;
    if (!verifyKeySet.has(k)) { verifyKeySet.add(k); allCellsToVerify.push(cell); }
  };
  missingCells.forEach(addToVerify);
  ungroundedCells.map(c => ({ rowCriterion: c.rowCriterion, colKey: c.colKey, productLabel: c.productLabel })).forEach(addToVerify);

  // "value" 유형 행에서 ○만 있는 셀도 구체값으로 교체 시도
  for (const row of allRows) {
    const criterion = row["criterion"] ?? "";
    if (!criterion || criterion === "순위" || criterion === "Rank") continue;
    if (rowTypeMap.get(criterion) !== "value") continue;
    for (const col of productCols) {
      if (String((row as Record<string, string>)[col.key] ?? "") === "○")
        addToVerify({ rowCriterion: criterion, colKey: col.key, productLabel: col.label });
    }
  }

  if (allCellsToVerify.length === 0) {
    console.log("\x1b[32m[Data Agent STEP 2] 모든 셀 확인됨 → 웹 검색 생략\x1b[0m\n");
    return;
  }

  if (missingCells.length > 0) {
    console.log(`\n\x1b[33m[Data Agent STEP 2] 미확인 셀 ${missingCells.length}개:\x1b[0m`);
    missingCells.forEach(c => console.log(`         • ${c.productLabel} × "${c.rowCriterion}"`));
  }
  if (ungroundedCells.length > 0) {
    console.log(`\n\x1b[33m[Data Agent STEP 2] 근거 불명 셀 ${ungroundedCells.length}개:\x1b[0m`);
    ungroundedCells.forEach(c => console.log(`         • ${c.productLabel} × "${c.rowCriterion}" ("${c.originalValue}" → 스펙 근거 없음)`));
  }
  console.log(`\n\x1b[33m[Data Agent STEP 2] 총 ${allCellsToVerify.length}개 셀 웹 검색 대상\x1b[0m`);

  // spec-cache를 통한 공유 캐시 사용 (loadCellCache 대체)
  let cacheHits = 0;

  // STEP 3: 유의어 생성 + Tavily 병렬 검색
  const uniqueCriteria = [...new Set(allCellsToVerify.map(c => c.rowCriterion))];
  console.log(`\n\x1b[33m[Data Agent STEP 3-A] 유의어 생성: ${JSON.stringify(uniqueCriteria)}\x1b[0m`);
  const s3a = Date.now();
  const synonymMap = await expandCriterionSynonyms(uniqueCriteria);
  console.log(`\x1b[33m[Data Agent STEP 3-A] 완료 (${Date.now() - s3a}ms)\x1b[0m`);
  for (const [crit, syns] of Object.entries(synonymMap))
    console.log(`         "${crit}" → [${(syns as string[]).join(", ")}]`);

  // Tavily 검색 전 캐시 + Pre-enrich 존재 여부 확인
  const rows = tableJson.props?.rows ?? [];
  const needsTavily = allCellsToVerify.filter(({ rowCriterion, colKey, productLabel }) => {
    const fullName = fullNameMap.get(productLabel) ?? productLabel;
    const cacheKey = makeCacheKey(fullName, rowCriterion);

    // ① spec-cache 히트 확인 (getSpec으로 조회)
    const cached = getSpec(fullName, rowCriterion);
    if (cached) {
      const targetRow = rows.find(r => r["criterion"] === rowCriterion);
      if (targetRow) {
        const col2 = productCols.find((c: any) => c.label === productLabel);
        if (col2) {
          (targetRow as Record<string, string>)[col2.key] = cached.value;
          cacheHits++;
          console.log(`\x1b[36m[Cache HIT] "${productLabel}" × "${rowCriterion}" → "${cached.value}"\x1b[0m`);
        }
      }
      return false;
    }

    // ② Pre-enrich 캐시 히트 (enrichContextWithTavily에서 이미 가져온 스니펫)
    const preSnippets = getPreEnrichedSnippets(productLabel, rowCriterion);
    if (preSnippets) {
      preEnrichedCells.push({ rowCriterion, colKey, productLabel, snippets: preSnippets });
      console.log(`\x1b[36m[Pre-enrich HIT] "${productLabel}" × "${rowCriterion}" → Tavily 생략\x1b[0m`);
      return false;
    }

    return true;
  });

  if (cacheHits > 0) console.log(`\x1b[36m[Cache] ${cacheHits}개 쫚8 히트 (Tavily 생략)\x1b[0m`);

  if (needsTavily.length === 0) {
    console.log("\x1b[32m[Data Agent STEP 3-B] 모든 셀 쫚8 트 확인 → Tavily 생략\x1b[0m");
  } else {
    console.log(`\n\x1b[33m[Data Agent STEP 3-B] Tavily 병렬 검색 (${needsTavily.length}개)...\x1b[0m`);
    const s3b = Date.now();
    const searchResultMap = new Map<string, TavilyResult[]>();
    await Promise.all(
      needsTavily.map(async ({ rowCriterion, productLabel }) => {
        const key = `${productLabel}__${rowCriterion}`;
        if (searchResultMap.has(key)) return;
        const synonyms = synonymMap[rowCriterion] ?? [];
        const cleanCriterion = rowCriterion.replace(/\s*\([^)]*\)/g, "").trim();
        const terms = [cleanCriterion, ...synonyms.slice(0, 2)].join(" ");
        const fullName = fullNameMap.get(productLabel) ?? productLabel;
        const results = await tavilySearch(`${fullName} ${terms}`);
        searchResultMap.set(key, results);
        console.log(`         🔍 "${fullName} × ${cleanCriterion}" → ${results.length}개 결과`);
      })
    );
    console.log(`\x1b[33m[Data Agent STEP 3-B] 완료 (${Date.now() - s3b}ms)\x1b[0m`);

    // STEP 3.5: Pre-enrich 캐시 셀 직접 판단 (Tavily 재검색 없음)
    if (preEnrichedCells.length > 0) {
      console.log(`\n\x1b[36m[Data Agent STEP 3.5] Pre-enrich 셀 ${preEnrichedCells.length}개 직접 판단 (Tavily 생략)...\x1b[0m`);
      await Promise.all(
        preEnrichedCells.map(async ({ rowCriterion, colKey, productLabel, snippets }) => {
          const { value, sourceUrl } = await judgeCell(
            productLabel, rowCriterion, snippets, locale,
            rowTypeMap.get(rowCriterion) ?? detectCriterionType(rowCriterion),
            synonymMap[rowCriterion] ?? []
          );
          const targetRow = rows.find(r => r["criterion"] === rowCriterion);
          if (targetRow && value !== "-") {
            (targetRow as Record<string, string>)[colKey] = value;
            console.log(`   \x1b[36m✅ Pre-enrich "${productLabel}" × "${rowCriterion}" → "${value}"\x1b[0m`);
            // spec-cache에 저장 (setSpec)
            const fullName = fullNameMap.get(productLabel) ?? productLabel;
            setSpec(fullName, rowCriterion, value, "tavily", sourceUrl);
          }
        })
      );
    }

    // STEP 4: 셀 값 판단 + 업데이트
    console.log(`\n\x1b[33m[Data Agent STEP 4] Claude Haiku로 셀 값 판단...\x1b[0m`);
    const s4 = Date.now();
    await Promise.all(
      needsTavily.map(async ({ rowCriterion, colKey, productLabel }) => {
        const snippets = searchResultMap.get(`${productLabel}__${rowCriterion}`) ?? [];
        const { value, sourceUrl, usedSnippet } = await judgeCell(
          productLabel, rowCriterion, snippets, locale,
          rowTypeMap.get(rowCriterion) ?? detectCriterionType(rowCriterion),
          synonymMap[rowCriterion] ?? []
        );
        const targetRow = rows.find(r => r["criterion"] === rowCriterion);
        if (targetRow) targetRow[colKey] = value;
        const symbol = value === "○" ? "\x1b[32m○\x1b[0m" : value === "X" ? "\x1b[31mX\x1b[0m" : "\x1b[90m-\x1b[0m";
        console.log(`         ${symbol} ${productLabel} × "${rowCriterion}"${sourceUrl ? ` ← ${sourceUrl.slice(0, 60)}` : " (증거 없음)"}`);
        if (usedSnippet) console.log(`            \x1b[90m📄 "${usedSnippet}"\x1b[0m`);
        // spec-cache에 저장 (non-"-" 값만)
        if (value !== "-") {
          const fullName = fullNameMap.get(productLabel) ?? productLabel;
          setSpec(fullName, rowCriterion, value, "tavily", sourceUrl, usedSnippet);
        }
      })
    );
    console.log(`\x1b[33m[Data Agent STEP 4] 완료 (${Date.now() - s4}ms)\x1b[0m`);

    // STEP 4.5: 재검색 (advanced + 역순 유의어)
    const stillMissing = needsTavily.filter(({ rowCriterion, colKey }) => {
      const targetRow = (tableJson.props?.rows ?? []).find(r => r["criterion"] === rowCriterion);
      return !targetRow || String((targetRow as Record<string, string>)[colKey] ?? "-") === "-";
    });
    if (stillMissing.length > 0) {
      console.log(`\n\x1b[33m[Data Agent STEP 4.5] 재검색 대상: ${stillMissing.length}개 셀...\x1b[0m`);
      const s45 = Date.now();
      await Promise.all(
        stillMissing.map(async ({ rowCriterion, colKey, productLabel }) => {
          const synonyms: string[] = synonymMap[rowCriterion] ?? [];
          const cleanCriterion = rowCriterion.replace(/\s*\([^)]*\)/g, "").trim();
          const altTerms = [...synonyms.slice(0, 2), cleanCriterion].join(" ");
          const fullName = fullNameMap.get(productLabel) ?? productLabel;
          const altResults = await tavilySearch(`${fullName} ${altTerms} 스펙`, "advanced");
          console.log(`         🔄 재검색 "${fullName} × ${cleanCriterion}" → ${altResults.length}개 결과`);
          const { value, sourceUrl, usedSnippet } = await judgeCell(
            productLabel, rowCriterion, altResults, locale,
            rowTypeMap.get(rowCriterion) ?? detectCriterionType(rowCriterion),
            synonyms
          );
          if (value !== "-") {
            const targetRow = (tableJson.props?.rows ?? []).find(r => r["criterion"] === rowCriterion);
            if (targetRow) (targetRow as Record<string, string>)[colKey] = value;
            setSpec(fullName, rowCriterion, value, "tavily", sourceUrl, usedSnippet);
            console.log(`         ${value === "○" ? "\x1b[32m○\x1b[0m" : "\x1b[31mX\x1b[0m"} [재검색 성공] ${productLabel} × "${rowCriterion}"${sourceUrl ? ` ← ${sourceUrl.slice(0, 60)}` : ""}`);
            if (usedSnippet) console.log(`            \x1b[90m📄 "${usedSnippet}"\x1b[0m`);
          } else {
            console.log(`         \x1b[90m- [재검색도 미확인] ${productLabel} × "${rowCriterion}"\x1b[0m`);
          }
        })
      );
      console.log(`\x1b[33m[Data Agent STEP 4.5] 완료 (${Date.now() - s45}ms)\x1b[0m`);
    }

    // STEP 4.7: 3샨 재검색 (full name + 기준명 단독 + "제원 사양표")
    const stillMissing2 = needsTavily.filter(({ rowCriterion, colKey }) => {
      const targetRow = (tableJson.props?.rows ?? []).find(r => r["criterion"] === rowCriterion);
      return !targetRow || String((targetRow as Record<string, string>)[colKey] ?? "-") === "-";
    });
    if (stillMissing2.length > 0) {
      console.log(`\n\x1b[33m[Data Agent STEP 4.7] 3샨 재검색 대상: ${stillMissing2.length}개 셀...\x1b[0m`);
      const s47 = Date.now();
      await Promise.all(
        stillMissing2.map(async ({ rowCriterion, colKey, productLabel }) => {
          const synonyms: string[] = synonymMap[rowCriterion] ?? [];
          const cleanCriterion = rowCriterion.replace(/\s*\([^)]*\)/g, "").trim();
          const fullName = fullNameMap.get(productLabel) ?? productLabel;
          const altResults = await tavilySearch(`${fullName} ${cleanCriterion} 제원 사양표`, "advanced");
          console.log(`         🔁 3샨 재검색 "${fullName} × ${cleanCriterion}" → ${altResults.length}개 결과`);
          const { value, sourceUrl, usedSnippet } = await judgeCell(
            productLabel, rowCriterion, altResults, locale,
            rowTypeMap.get(rowCriterion) ?? detectCriterionType(rowCriterion),
            synonyms
          );
          if (value !== "-") {
            const targetRow = (tableJson.props?.rows ?? []).find(r => r["criterion"] === rowCriterion);
            if (targetRow) (targetRow as Record<string, string>)[colKey] = value;
            console.log(`         ${value === "○" ? "\x1b[32m○\x1b[0m" : "\x1b[31mX\x1b[0m"} [3차 성공] ${productLabel} × "${rowCriterion}"${sourceUrl ? ` ← ${sourceUrl.slice(0, 60)}` : ""}`);
            if (usedSnippet) console.log(`            \x1b[90m📄 "${usedSnippet}"\x1b[0m`);
          } else {
            console.log(`         \x1b[90m- [3차도 미확인] ${productLabel} × "${rowCriterion}"\x1b[0m`);
          }
        })
      );
      console.log(`\x1b[33m[Data Agent STEP 4.7] 완료 (${Date.now() - s47}ms)\x1b[0m`);
    }

    // spec-cache는 setSpec 호출 시 자동 저장됨 (saveCellCache 불필요)
    console.log(`\x1b[36m[Cache] spec-cache 저장 완료\x1b[0m`);
  }
}

// ---------------------------------------------------------------------------
// Local DB Lookup — 제품명으로 로컬 JSON DB에서 스펙 요약 문자열 반환
// route.ts에서 이동. 데이터 조회는 Data Agent 책임.
// ---------------------------------------------------------------------------



const CATEGORY_FILE_MAP: Record<string, string> = {
  "유모차": "products-유모차.json",
  "로봇 청소기": "products-로봇 청소기.json",
  "카메라": "products-카메라.json",
};

function proxyImageForLocalDB(url: string): string {
  if (!url) return "";
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

export function findProductInLocalDB(productCategory: string, name: string): string | null {
  const fileName = CATEGORY_FILE_MAP[productCategory];
  if (!fileName) return null;

  try {
    const filePath = path.join(process.cwd(), "data", fileName);
    const raw = fs.readFileSync(filePath, "utf-8");
    const products: any[] = JSON.parse(raw);

    // 정확히 일치하는 제품 먼저 탐색
    let found = products.find((p) => p.name === name);

    // 없으면 부분 일치 (RAG가 이름을 약간 다르게 저장한 경우 대비)
    if (!found) {
      found = products.find(
        (p) =>
          p.name?.includes(name) ||
          name.includes(p.name ?? "")
      );
    }

    if (!found) return null;

    const specs = Array.isArray(found.specs)
      ? found.specs.join(" / ")
      : typeof found.specs === "string"
      ? found.specs
      : "정보 없음";

    return (
      `[Product 1]\n` +
      `Name: ${found.name}\n` +
      `Price: ${found.price}\n` +
      `Brand: ${found.brand ?? ""}\n` +
      `Mall: ${found.mallName ?? ""}\n` +
      `Image: ${proxyImageForLocalDB(found.image ?? found.imageUrl ?? "")}\n` +
      `Link: ${found.link ?? ""}\n` +
      `Specs: ${specs}\n` +
      `Description: ${found.description || "정보 없음"}`
    );
  } catch (e) {
    console.warn(`[LocalDB] Failed to read ${fileName}:`, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tavily 단순 스니펫 검색 — render-to-comp-table.ts에서 이동
// ---------------------------------------------------------------------------

export async function tavilySearchSnippet(
  query: string
): Promise<{ url: string; snippet: string } | null> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: 3,
        include_answer: true,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { results?: Array<{ content: string; url: string }>; answer?: string };
    if (data.answer) {
      return { url: (data.results ?? [])[0]?.url ?? "https://tavily.com", snippet: data.answer.slice(0, 500) };
    }
    const top = (data.results ?? [])[0];
    if (!top) return null;
    return { url: top.url, snippet: top.content.slice(0, 300) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 컨텍스트 사전 보강 — render-to-comp-table.ts에서 이동
// Claude 호출 전에 미확인 기준을 Tavily 웹 검색으로 채움
// ---------------------------------------------------------------------------

export interface WebResultForContext {
  criterion: string;
  url: string;
  snippet: string;
}

export interface ProductLogForContext {
  name: string;
  localSpecs: string[];
  coveredCriteria: string[];
  missingCriteria: string[];
  webResults: WebResultForContext[];
}

export async function enrichContextWithTavily(
  contextSummary: string,
  decisionCriteria: string[]
): Promise<{ enriched: string; productLogs: ProductLogForContext[] }> {
  const productLogs: ProductLogForContext[] = [];

  if (!contextSummary.trim() || decisionCriteria.length === 0) {
    return { enriched: contextSummary, productLogs };
  }

  const parts = contextSummary.split(/(\[Product \d+\])/);
  const blocks: Array<{ header: string; body: string }> = [];

  for (let i = 0; i < parts.length; i++) {
    if (/^\[Product \d+\]$/.test(parts[i].trim())) {
      blocks.push({ header: parts[i], body: parts[i + 1] ?? "" });
      i++;
    }
  }

  if (blocks.length === 0) return { enriched: contextSummary, productLogs };

  const enrichedBlocks = await Promise.all(
    blocks.map(async ({ header, body }) => {
      const nameMatch = body.match(/Name:\s*(.+)/);
      if (!nameMatch) return header + body;
      const productName = nameMatch[1].trim();

      const specsMatch = body.match(/Specs:\s*(.+)/);
      const localSpecs = specsMatch?.[1]?.split(" / ").map(s => s.trim()).filter(Boolean) ?? [];

      // 스펙 키만 추출 ("손떨림보정: 5축광학식" → "손떨림보정")
      const specKeys = localSpecs.map(s => s.split(":")[0].trim().toLowerCase());

      // 기준명에서 [중요/보통/낮음]과 괄호 설명 제거 후 키워드 추출
      function cleanCriterion(c: string): string {
        return c.replace(/\s*\[.*?\]/g, "").replace(/\s*\(.*?\)/g, "").trim().toLowerCase();
      }

      // 스펙 키 기반 커버리지 판단:
      // 기준 키워드가 스펙 키 중 하나라도 포함/역포함되면 covered
      // (전체 스펙 텍스트가 아닌 키만 보므로 오탐 방지)
      function isCoveredBySpecKey(criterion: string): boolean {
        const clean = cleanCriterion(criterion);
        const keywords = clean.split(/\s+/).filter(w => w.length >= 2);
        return specKeys.some(key =>
          keywords.some(kw => key.includes(kw) || kw.includes(key))
        );
      }

      const coveredCriteria: string[] = [];
      const missingCriteria: string[] = [];

      decisionCriteria.forEach((criterion) => {
        if (isCoveredBySpecKey(criterion)) coveredCriteria.push(criterion);
        else missingCriteria.push(criterion);
      });

      console.log(`\n\x1b[36m[Spec Coverage] "${productName}"\x1b[0m`);
      console.log(`  Danawa 스펙 (${localSpecs.length}개): ${localSpecs.slice(0, 5).join(" / ")}${localSpecs.length > 5 ? " ..." : ""}`);
      coveredCriteria.forEach(c => console.log(`  ✅ "${c}" → DB에서 커버`));
      missingCriteria.forEach(c => console.log(`  ❌ "${c}" → DB 미커버 (웹 검색 필요)`));

      if (missingCriteria.length === 0) {
        productLogs.push({ name: productName, localSpecs, coveredCriteria, missingCriteria, webResults: [] });
        return header + body;
      }

      const webResultRaw = await Promise.all(
        missingCriteria.slice(0, 5).map(async (criterion) => {
          const query = `${productName} ${criterion}`;
          const result = await tavilySearchSnippet(query);
          if (result) {
            console.log(`   🔍 "${query}" → ${result.snippet.slice(0, 60)}...`);
            console.log(`       출처: ${result.url}`);
            return { criterion, url: result.url, snippet: result.snippet };
          }
          console.log(`   🔍 "${query}" → 결과 없음`);
          return null;
        })
      );

      const webResults = webResultRaw.filter(Boolean) as WebResultForContext[];
      productLogs.push({ name: productName, localSpecs, coveredCriteria, missingCriteria, webResults });

      if (webResults.length === 0) return header + body;

      const webSpecText = webResults.map(w => `${w.criterion}: ${w.snippet}`).join(" | ");
      return header + body + `\nWebSpecs (from web search): ${webSpecText}`;
    })
  );

  return { enriched: enrichedBlocks.join(""), productLogs };
}

// ---------------------------------------------------------------------------
// AI Reranker — render-to-option-list.ts에서 이동
// 실제 Danawa 제품 목록에서 기준에 맞는 제품을 AI로 선별.
// AI는 절대 제품을 생성하지 않고 제공된 목록에서 인덱스만 선택.
// ---------------------------------------------------------------------------

export interface RankedProduct {
  index: number;        // 0-based index into the candidateList
  reason: string;       // why this product fits the criteria
  appliedCriteria: string[];  // 이 제품에서 실제로 확인된 기준들
}

// RAG 결과가 0개이거나 요청 feature가 DB에 없을 때 반환하는 sentinel
export const RAG_NOT_FOUND = "__RAG_NOT_FOUND__" as const;

export async function reRankByAI(
  candidates: ProductData[],
  userQuery: string,
  productCategory: string,
  targetCount: number = 6,
  coverableCriteria: string[] = []
): Promise<RankedProduct[] | typeof RAG_NOT_FOUND> {
  if (candidates.length === 0) return RAG_NOT_FOUND;

  const productList = candidates.map((p, i) =>
    `[${i}] ${p.name} | ${p.price}\nSpecs: ${p.specs.slice(0, 20).join(" / ") || "스펙 없음"}`
  ).join("\n\n");

  const criteriaForReranker = coverableCriteria.length > 0
    ? `검색 기준 (DB에서 확인 가능한 것들만): ${coverableCriteria.join(", ")}`
    : `사용자 요청: ${userQuery}`;

  const { text } = await generateText({
    model: anthropic("claude-haiku-4-5"),
    system: `You are a qualitative product ranker. You receive a list of pre-filtered products from a Korean price comparison site.
All products have already passed hard filters (price, brand, numeric specs). Do NOT re-check or re-verify those conditions.
Your ONLY job: select the best-matching products by qualitative fit (use case, lifestyle, feature presence).

RULES:
1. Select ONLY from the numbered list [0], [1], [2], ...
2. Output a JSON array of selected indices, best first. Example: [2, 0, 5, 3]
3. Select at most ${targetCount} indices.
4. If NO product fits qualitatively, output: [-1]
5. Output the JSON array ONLY. No explanation, no other text.`,
    prompt: `Category: ${productCategory || "consumer product"}
${criteriaForReranker}

Products:
${productList}

Output index array only:`,
    temperature: 0,
    maxTokens: 128,  // 인덱스 배열만 반환 — 6개 기준 ~20토큰
  });

  // 인덱스 배열 파싱: [2, 0, 5] 또는 [-1]
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1) {
    console.warn("[reRankByAI] No JSON array found in response");
    return RAG_NOT_FOUND;
  }

  let indices: number[];
  try {
    indices = JSON.parse(text.slice(firstBracket, lastBracket + 1));
  } catch {
    console.warn("\x1b[31m[reRankByAI] JSON parse failed:\x1b[0m", text.slice(0, 200));
    return RAG_NOT_FOUND;
  }

  if (!Array.isArray(indices) || (indices.length === 1 && indices[0] === -1)) {
    console.warn("\x1b[33m[AI Reranker] 해당 기능 없음 → NOT_FOUND\x1b[0m");
    return RAG_NOT_FOUND;
  }

  const validated: RankedProduct[] = indices
    .filter((idx) => typeof idx === "number" && idx >= 0 && idx < candidates.length)
    .map((idx) => ({ index: idx, reason: "", appliedCriteria: [] }));

  if (validated.length === 0) {
    console.warn("\x1b[33m[AI Reranker] 유효 인덱스 0개 → NOT_FOUND\x1b[0m");
    return RAG_NOT_FOUND;
  }

  console.log(
    `\n\x1b[36m[AI Reranker] ${validated.length}/${candidates.length} 선별:\x1b[0m ` +
    validated.map((r) => `[${r.index}] ${candidates[r.index].name.slice(0, 25)}`).join(" | ") + "\n"
  );

  return validated;
}




// ---------------------------------------------------------------------------
// WSM 랭킹 + 분석 코멘트 생성 — ui_agent.ts에서 이동
// 비교표 데이터를 입력받아 가중합 기반 순위를 계산하고
// 사용자에게 보여줄 _rankReasoning 텍스트를 반환한다.
// ---------------------------------------------------------------------------


function parseCriterionWeight(str: string): { name: string; weight: number } {
  const bracket = str.match(/\[(중요|보통|낮음|high|medium|low)\]/i);
  const raw = bracket?.[1]?.toLowerCase() ?? "보통";
  const weight = raw === "중요" || raw === "high" ? 0.5
    : raw === "낮음" || raw === "low" ? 0.2
    : 0.3;
  const name = str.replace(/\s*\([^)]*\)/g, "").replace(/\s*\[.*?\]/g, "").trim();
  return { name, weight };
}

function findCriterionWeight(rowLabel: string, criteriaList: string[]): number {
  const rowLower = rowLabel.toLowerCase();
  for (const c of criteriaList) {
    const { name, weight } = parseCriterionWeight(c);
    const nameLower = name.toLowerCase();
    if (nameLower.includes(rowLower) || rowLower.includes(nameLower)) return weight;
    const words = nameLower.split(/\s+/).filter(w => w.length >= 2);
    if (words.some(w => rowLower.includes(w))) return weight;
  }
  return 0.3;
}

function extractNumericValue(val: string): number | null {
  const m = val.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function isLowerBetterCriterion(crit: string): boolean {
  return /소음|무게|충전\s*시간|두께|noise|weight|dB/i.test(crit);
}

function scoreCellValue(val: string): number {
  if (!val || val === "-") return 0.5;
  if (val === "○") return 1.0;
  if (val === "X") return 0.0;
  return 0.6;
}

export async function computeRankingAndReasoning(
  tableJson: CompTableJson,
  decisionCriteria: string[],
  locale: string
): Promise<{ reasoning: string }> {
  const finalRows = tableJson.props?.rows ?? [];
  const rankRow = finalRows.find(r => r["criterion"] === "순위" || r["criterion"] === "Rank");
  const productCols = (tableJson.props?.columns ?? []).filter(c => c.key !== "criterion");

  if (!rankRow || productCols.length === 0) return { reasoning: "" };

  const wsmScores: Record<string, number> = {};
  const weightSums: Record<string, number> = {};
  for (const col of productCols) { wsmScores[col.key] = 0; weightSums[col.key] = 0; }

  for (const row of finalRows) {
    const criterion = row["criterion"] ?? "";
    if (!criterion || criterion === "순위" || criterion === "Rank") continue;
    const w = findCriterionWeight(criterion, decisionCriteria);

    const nums: Record<string, number> = {};
    for (const col of productCols) {
      const n = extractNumericValue(String(row[col.key] ?? "-"));
      if (n !== null) nums[col.key] = n;
    }
    const numVals = Object.values(nums);
    const numMin = numVals.length ? Math.min(...numVals) : 0;
    const numMax = numVals.length ? Math.max(...numVals) : 0;
    const hasVariance = Object.keys(nums).length >= 2 && numMin !== numMax;
    const lower = isLowerBetterCriterion(criterion);

    for (const col of productCols) {
      const cellVal = String(row[col.key] ?? "-");
      let s: number;
      if (hasVariance && col.key in nums) {
        const norm = (nums[col.key] - numMin) / (numMax - numMin);
        s = 0.2 + (lower ? 1 - norm : norm) * 0.8;
      } else {
        s = scoreCellValue(cellVal);
      }
      wsmScores[col.key] += s * w;
      weightSums[col.key] += w;
    }
  }

  for (const col of productCols) {
    wsmScores[col.key] = weightSums[col.key] > 0
      ? wsmScores[col.key] / weightSums[col.key] : 0;
  }

  const sorted = Object.entries(wsmScores).sort((a, b) => b[1] - a[1]);

  // 공동 순위 처리
  let rankIdx = 1;
  let i = 0;
  while (i < sorted.length) {
    const currentScore = sorted[i][1];
    let j = i;
    while (j < sorted.length && sorted[j][1] === currentScore) j++;
    const tiedCount = j - i;
    const label = tiedCount > 1 ? `공동 ${rankIdx}위` : `${rankIdx}위`;
    for (let k = i; k < j; k++) { rankRow[sorted[k][0]] = label; }
    rankIdx += tiedCount;
    i = j;
  }

  console.log(`\x1b[32m\n[STEP 5] WSM 순위 결정 (중요도 가중합):`);
  const actualRankLines = productCols.map(col => {
    const rank = String((rankRow as Record<string, string>)[col.key] ?? "-");
    return `${col.label}: ${rank}`;
  }).join(", ");

  const lang = locale === "en" ? "English" : "Korean";
  const dataRows = finalRows.filter(r => r["criterion"] && r["criterion"] !== "순위" && r["criterion"] !== "Rank");

  const fullTableLines = dataRows.map(row => {
    const criterion = row["criterion"] ?? "";
    const w = findCriterionWeight(criterion, decisionCriteria);
    const wLabel = w === 0.5 ? "[중요]" : w === 0.2 ? "[낮음]" : "[보통]";
    const vals = productCols.map(col => {
      const val = String((row as Record<string, string>)[col.key] ?? "-");
      return `${col.label}: ${val}`;
    }).join(" | ");
    return `  - ${criterion} ${wLabel}: ${vals}`;
  }).join("\n");

  try {
    const { text: reasoning } = await generateText({
      model: anthropic("claude-haiku-4-5"),
      system: `You are a shopping advisor. Your ONLY job is to explain WHY one product ranked higher than another, using EXCLUSIVELY the data in the comparison table below.

ABSOLUTE RULES:
1. You MUST reference only the criterion names and cell values that appear in the table. Do NOT invent, guess, or add ANY information not explicitly shown in the table cells.
2. If a cell says "미확인" or "-", say so or ignore that criterion — do NOT infer what it might mean.
3. Do NOT mention product features, specs, or qualities that are not column rows in the table (e.g., do NOT say "quiet" unless "소음" is a criterion row).
4. Do NOT give purchasing advice or suggestions about things outside the table.
5. Do NOT use markdown formatting (no **, *, #, _). Plain text only.
6. Write 2-3 sentences in ${lang}.
7. If all products are tied, say they are equal on all measured criteria.`,
      prompt: `Ranking result: ${actualRankLines}

Comparison table (use ONLY these values in your explanation):
${fullTableLines}

Based solely on the table values above, explain why the top-ranked product scored higher.`,
      temperature: 0.3,
    });

    const cleanReasoning = reasoning.trim()
      .replace(/\*\*/g, "").replace(/\*/g, "").replace(/^#+\s*/gm, "").replace(/_/g, "");
    return { reasoning: cleanReasoning };
  } catch {
    return { reasoning: "" };
  }
}
