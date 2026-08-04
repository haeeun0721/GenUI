import { tool, generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { getSpec, setSpec, makeCacheKey as sharedMakeCacheKey } from "../services/spec-cache";
import { computeWsmRanking } from "../../shared/wsm-ranking";

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

export async function scrapeDanawaDetail(
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

export interface TavilySearchOptions {
  /** 기본 5, Tavily 최대 20 */
  maxResults?: number;
  /** URL 하나당 뽑아낼 스니펫 개수 (1~3). advanced 검색에서만 의미 있음 */
  chunksPerSource?: number;
  /** 이 도메인들은 애초에 검색 결과에서 제외 (진짜 Tavily API 파라미터 — 쿼리 텍스트 "-단어"와 달리 실제로 지켜짐) */
  excludeDomains?: string[];
  /** Tavily가 검색 결과를 요약한 "AI Answer"도 같이 요청 (수치 fast-path가 이걸 읽음) */
  includeAnswer?: boolean;
}

export async function tavilySearch(
  query: string,
  searchDepth: "basic" | "advanced" = "basic",
  options: TavilySearchOptions = {}
): Promise<TavilyResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) { console.warn("[Tavily] API 키 없음"); return []; }
  const body: Record<string, unknown> = {
    query,
    search_depth: searchDepth,
    max_results: options.maxResults ?? 5,
  };
  if (searchDepth === "advanced" && options.chunksPerSource) body.chunks_per_source = options.chunksPerSource;
  if (options.excludeDomains?.length) body.exclude_domains = options.excludeDomains;
  if (options.includeAnswer) body.include_answer = "basic";

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    // advanced + 더 많은 결과 요청은 basic보다 느리므로 타임아웃을 넉넉하게
    signal: AbortSignal.timeout(searchDepth === "advanced" ? 20000 : 10000),
  });
  if (!res.ok) { console.warn(`[Tavily] ${res.status}`); return []; }
  const data = await res.json() as { results?: TavilyResult[]; answer?: string };
  const results = data.results ?? [];
  // include_answer로 받은 요약은 results[] 밖의 별도 필드로 오므로, 기존 코드(spec-lookup.ts의
  // tryExtractFromAIAnswer)가 찾는 형태에 맞춰 title="Tavily AI Answer Overview"인 가짜 결과로
  // 앞에 끼워 넣는다 — 반환 타입을 안 바꾸면서 이 필드를 실제로 쓰이게 하기 위함.
  if (data.answer) {
    results.unshift({ title: "Tavily AI Answer Overview", url: "", content: data.answer, score: 1 });
  }
  return results;
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
export function parseSpecEntry(entry: string): { key: string; rawValue: string } {
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
export function toDisplayValue(rawValue: string): string {
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
  type?: string;
  props?: {
    columns?: Array<{ key: string; label: string; imageUrl?: string }>;
    rows?: Array<Record<string, string>>;
    _rankReasoning?: string;
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

// ── 유의어 캐시 (프로세스 수명 동안 유지) ─────────────────────────────
const synonymsCache = new Map<string, Record<string, string[]>>();

export async function expandCriterionSynonyms(criteria: string[]): Promise<Record<string, string[]>> {
  if (criteria.length === 0) return {};

  // 정렬한 키로 캐시 조회 (순서 무관)
  const cacheKey = [...criteria].sort().join('|');
  if (synonymsCache.has(cacheKey)) {
    console.log(`\x1b[36m[Synonyms] 캐시 히트: [${criteria.join(', ')}]\x1b[0m`);
    return synonymsCache.get(cacheKey)!;
  }

  const { text } = await generateText({
    model: openai("gpt-4o"),
    system: "You are a Korean product spec synonym generator. Given a list of product criteria in Korean, return a JSON object where each key is the criterion and the value is an array of 2-3 Korean synonyms or related search terms. Output only valid JSON.",
    prompt: `Generate synonyms for these criteria: ${JSON.stringify(criteria)}`,
    temperature: 0,
  });
  let result: Record<string, string[]> = {};
  try {
    const match = text.match(/\{[\s\S]*\}/);
    result = match ? JSON.parse(match[0]) : {};
  } catch { result = {}; }

  synonymsCache.set(cacheKey, result);
  return result;
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

/** 기준명/유의어 비교용 정규화 (공백·구두점·대소문자 제거) */
function normalizeTerm(s: string): string {
  return s.toLowerCase().replace(/[\s\-·,()\[\].\/]/g, "");
}

/**
 * 추출된 값이 기준명/유의어를 그대로 되풀이한 것인지 판별.
 * 검색 쿼리가 "<제품명> <기준명>"처럼 포괄적일 때, LLM이 스니펫에 등장하는
 * 기준명 자체를 "값"으로 착각해 반환하는 것을 기준(criterion)과 무관하게 범용적으로 차단한다.
 */
function isLiteralEcho(rawValue: string, criterion: string, synonyms: string[]): boolean {
  const normVal = normalizeTerm(rawValue);
  if (!normVal) return false;
  const terms = [criterion, ...synonyms].map(normalizeTerm).filter(t => t.length >= 2);
  return terms.some(t => t === normVal);
}

/**
 * 스니펫 텍스트를 인용 가능한 짧은 단위(문장/스펙 나열 구절)로 쪼갠다.
 * 다나와식 스펙은 완결된 문장이 아니라 "항목 / 항목 / 항목" 나열이 많아서,
 * 마침표뿐 아니라 줄바꿈·"/"·"·" 도 구절 경계로 취급한다.
 */
function splitIntoSegments(text: string): string[] {
  return text
    .split(/[\n]+|(?<=[.!?])\s+|[/·]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 4);
}

export async function judgeCell(
  productName: string,
  criterion: string,
  snippets: TavilyResult[],
  locale: string,
  criterionType: "boolean" | "value" = detectCriterionType(criterion),
  synonyms: string[] = [],
  siblingExcludeTokens: string[] = []
): Promise<{ value: string; sourceUrl?: string; usedSnippet?: string }> {
  if (snippets.length === 0) return { value: "-" };

  // ── 1. 제품명 사전 필터: 해당 제품명이 등장하는 스니펫만 통과 ─────────────
  // 다른 모델 정보가 포함된 페이지에서 교차 오염을 제거
  const productTokens = productName.split(/\s+/).filter(w => w.length >= 2);
  const validSnippets = snippets.filter(r => {
    const hits = productTokens.filter(t => r.content.toLowerCase().includes(t.toLowerCase()));
    return hits.length / Math.max(productTokens.length, 1) >= 0.5;
  });
  // 필터 후 유효한 스니펫이 없으면 원본 전체 사용 (fallback)
  const usableSnippets = validSnippets.length > 0 ? validSnippets : snippets;

  const keywords = [
    criterion, ...synonyms, ...criterion.split(/\s+/), productName, ...productTokens,
  ].filter(w => w.length >= 2);

  // ── 2. 스니펫을 번호 매긴 구절 단위로 쪼갬 ─────────────────────────────────
  // LLM이 인용문을 직접 타이핑하게 하는 대신 "몇 번 구절"인지만 고르게 해서,
  // 근거 텍스트가 항상 원문 그대로가 되도록 한다 — 사후에 fuzzy 대조로 검증하는 게
  // 아니라,애초에 LLM이 텍스트를 왜곡할 수 있는 경로 자체를 없앤다.
  // 300자였던 창을 500자로 넓힘 — 스펙표에서 원하는 항목이 다른 키워드 없이 혼자
  // 뚝 떨어져 있으면 좁은 창 밖으로 밀려나 판단 재료 자체가 없어지는 경우가 있었다.
  const segments: { text: string; url: string }[] = [];
  usableSnippets.slice(0, 8).forEach((r) => {
    const window = extractKeywordWindow(r.content, keywords, 500);
    splitIntoSegments(window).forEach((seg) => segments.push({ text: seg, url: r.url }));
  });

  if (segments.length === 0) return { value: "-" };

  const snippetText = segments.map((s, i) => `[${i + 1}] ${s.text}`).join("\n");

  // ── 3. Extractive QA 프롬프트 ─────────────────────────────────────────────
  const systemPrompt = criterionType === "value"
    ? `You are a product spec extractor using extractive QA.
Given numbered text segments, find the value for the criterion ONLY if explicitly stated in one segment.
Respond with ONLY a JSON object:
{ "value": "<extracted value or null>", "segmentId": <1-based segment number that states this value, or null> }
Rules:
- value: specific measurable value (e.g., "75dB", "약 200분", "6,400mAh"). Max 15 chars. Prices in "000,000원" format.
- segmentId: MUST be the number of the segment that explicitly states this value. Never invent a number.
- If the segment is about a DIFFERENT model than the specified product, set all fields to null.
- CRITICAL — sibling variant check: the exact product name above may share almost all of its name with a
  DIFFERENT sibling model in the same product line (e.g. a "직배수"/direct-drain version, "Ultra", "Slim",
  "Pro", or a different trailing model code). If the segment you would cite names such a variant/suffix that
  is NOT part of the exact product name given above, that text is about the SIBLING model, not this one —
  set all fields to null even if the rest of the segment looks relevant. Never carry a sibling model's spec
  over to this product just because most of the name matches.
- If the value is not explicitly stated in any segment, set all fields to null.`
    : `You are a product spec verifier using extractive QA.
Given numbered text segments, determine if the product explicitly has or lacks the specified feature/criterion, and extract concrete detail if named.
Respond with ONLY a JSON object:
{ "value": "<see rules>", "segmentId": <1-based segment number this is based on, or null> }
Rules for "value":
- If a segment names concrete, specific sub-features or technologies (e.g. proper nouns like "AI 장애물 회피", "원격제어", "홈캠", "LDS 라이다"), return them as a short comma-separated list, max 40 chars total. Only include items explicitly named in the text.
- If a segment only confirms the feature/criterion exists in general terms, WITHOUT naming any specific sub-feature, return "○".
- If a segment explicitly says the feature is absent, return "X".
- NEVER return the criterion name itself, a generic category label, or a synonym of the criterion as the value — that adds no information. If that is all you can find, use "○" instead.
- segmentId: MUST be the number of the segment that supports this "value". Never invent a number.
- If no segment is about this product, or nothing relevant is stated, set all fields to null.
- CRITICAL — sibling variant check: the exact product name above may share almost all of its name with a
  DIFFERENT sibling model in the same product line (e.g. a "직배수"/direct-drain version, "Ultra", "Slim",
  "Pro", or a different trailing model code). If the segment you would cite names such a variant/suffix that
  is NOT part of the exact product name given above, that text is about the SIBLING model, not this one —
  set all fields to null even if the rest of the segment looks relevant. Never carry a sibling model's
  feature over to this product just because most of the name matches.`;

  const { text } = await generateText({
    model: openai("gpt-4o"),
    system: systemPrompt,
    prompt: `Product: ${productName}\nCriterion: ${criterion} (Synonyms/Related terms: ${synonyms.join(", ")})\n\nText segments:\n${snippetText}`,
    temperature: 0,
  });

  try {
    const match = text.match(/\{[\s\S]*?\}/);
    const result = match ? JSON.parse(match[0]) : {};
    const rawValue: string | null = result.value ?? null;
    const segId: number | null = result.segmentId ?? null;

    if (!rawValue) return { value: "-" };

    // ── 4. Evidence Verification ───────────────────────────────────────────
    // 예전엔 LLM이 다시 타이핑한 evidence_quote를 원문과 fuzzy 토큰 대조했는데,
    // 이제 LLM은 번호만 고르므로 그 번호가 실존하는지만 확인하면 된다 — 확률적 대조가
    // 아니라 "근거가 있다/없다"가 확정적으로 갈린다. 번호가 없거나 범위를 벗어나면
    // 근거 없는 값으로 간주해 폐기한다(값은 있는데 근거를 못 대는 경우도 포함).
    const evidenceSeg = (segId != null && segId >= 1 && segId <= segments.length)
      ? segments[segId - 1]
      : null;

    if (!evidenceSeg) {
      console.log(`\x1b[31m[EvidenceCheck] FAILED (근거 segmentId 없음/범위 밖) "${rawValue}" 폐기\x1b[0m`);
      return { value: "-" };
    }
    console.log(`\x1b[32m[EvidenceCheck] PASSED (segment #${segId}): "${evidenceSeg.text.slice(0, 60)}"\x1b[0m`);

    const evidenceQuote = evidenceSeg.text;

    // ── 4.5 Sibling Guard ───────────────────────────────────────────────────
    // 근거 구절이 이 제품명에는 없는 "형제 제품" 구분 토큰(예: "직배수", "Ultra")을
    // 포함하면, 근거가 실존하는 원문이어도 그건 형제 제품 얘기다. 이제 근거 텍스트가
    // 항상 진짜 원문이라(4번에서 보장), 이 체크의 신뢰도도 예전보다 높아졌다.
    if (siblingExcludeTokens.length > 0) {
      const quoteLower = evidenceQuote.toLowerCase();
      const hitToken = siblingExcludeTokens.find((t) => quoteLower.includes(t.toLowerCase()));
      if (hitToken) {
        console.log(`\x1b[31m[SiblingGuard] 근거 구절에 형제 제품 토큰 "${hitToken}" 포함 → 폐기\x1b[0m`);
        return { value: "-" };
      }
    }

    // ── 5. Echo Guard ───────────────────────────────────────────────────────
    // 추출된 값이 기준명/유의어를 그대로 되풀이한 것이면(예: 기준 "스마트 기능" → 값 "스마트 기능")
    // 정보 가치가 없으므로 폐기한다. 어떤 기준명이 오든 동일하게 적용되는 범용 가드.
    let finalValue = rawValue;
    if (isLiteralEcho(rawValue, criterion, synonyms)) {
      if (criterionType === "boolean") {
        // 근거 텍스트는 있으나 구체 항목이 아님 → "존재 확인"으로 다운그레이드
        console.log(`\x1b[33m[EchoGuard] "${rawValue}" == 기준/유의어 → "○"로 대체\x1b[0m`);
        finalValue = "○";
      } else {
        console.log(`\x1b[31m[EchoGuard] "${rawValue}" == 기준/유의어 → 폐기\x1b[0m`);
        return { value: "-" };
      }
    }

    return { value: finalValue, sourceUrl: evidenceSeg.url, usedSnippet: evidenceQuote };
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
  locale: string,
  prebuiltFullNameMap?: Map<string, string>
): Promise<void> {
  const columns = tableJson.props?.columns ?? [];
  const productCols = columns.filter(c => c.key !== "criterion");
  const allRows = tableJson.props?.rows ?? [];

  // shortLabel → 전체 제품명 매핑
  // prebuiltFullNameMap이 있으면 buildAndAssembleTable()에서 이미 정확히 만들었으므로 그대로 사용.
  // 없으면 uiContext 파싱으로 복원 (하위 호환성 유지).
  const fullNameMap = prebuiltFullNameMap ?? (() => {
    const map = new Map<string, string>();
    const nameMatches = [...uiContext.matchAll(/Name:\s*(.+)/g)].map(m => m[1].trim());
    for (const col of productCols) {
      const labelWords = col.label.split(/\s+/).filter(w => w.length >= 2);
      if (labelWords.length === 0) continue;
      const candidates = nameMatches.filter(name => {
        const nameLower = name.toLowerCase();
        return labelWords.every(w => nameLower.includes(w.toLowerCase()));
      });
      if (candidates.length === 0) continue;
      const matched = candidates.reduce((best, curr) => curr.length < best.length ? curr : best);
      map.set(col.label, matched);
      const note = candidates.length > 1 ? ` (후보 ${candidates.length}개 중 최단 선택)` : "";
      console.log(`\x1b[90m[Data Agent] 제품명 매핑: "${col.label}" → "${matched}"${note}\x1b[0m`);
    }
    return map;
  })();

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

  // STEP 3: 정적 유의어 사전으로 synonymMap 구성 (LLM 호출 없음)
  // spec-lookup.ts의 STATIC_SYNONYMS와 동일한 패턴을 data_agent 내부에서 인라인 적용
  const STATIC_SYNONYMS_LOCAL: Record<string, string[]> = {
    "소음":       ["소음 수준", "noise level", "작동음", "데시벨"],
    "소음 수준":  ["소음 dB", "noise", "작동음", "데시벨"],
    "흡입력":     ["흡입 파워", "파스칼", "suction power", "Pa"],
    "배터리":     ["배터리 용량", "battery", "mAh", "충전 용량"],
    "배터리 수명":["사용 시간", "작동 시간", "연속 사용", "최대 사용시간"],
    "배터리용량": ["mAh", "배터리 크기", "battery capacity"],
    "무게":       ["중량", "weight", "본체 무게"],
    "충전시간":   ["충전 소요", "charge time", "완충"],
    "사용시간":   ["배터리 지속", "runtime", "최대 사용"],
    "물탱크":     ["물탱크 용량", "water tank", "탱크 용량"],
    "먼지통":     ["집진통", "더스트빈", "dustbin", "집진 용량"],
    "화소":       ["해상도", "megapixel", "MP"],
    "손떨림보정": ["OIS", "이미지 안정화", "image stabilization"],
    "방수":       ["생활방수", "IPX", "방진"],
  };

  function getStaticSynonymsLocal(criterion: string): string[] {
    const clean = criterion.replace(/\s*\[[^\]]*\]/g, "").replace(/\s*\([^)]*\)/g, "").trim().toLowerCase();
    for (const [key, syns] of Object.entries(STATIC_SYNONYMS_LOCAL)) {
      if (clean.includes(key.toLowerCase()) || key.toLowerCase().includes(clean)) return syns;
    }
    return [];
  }

  const uniqueCriteria = [...new Set(allCellsToVerify.map(c => c.rowCriterion))];
  const synonymMap: Record<string, string[]> = {};
  for (const c of uniqueCriteria) {
    synonymMap[c] = getStaticSynonymsLocal(c);
  }
  console.log(`\x1b[33m[Data Agent STEP 3-A] 정적 유의어 사전 적용 (LLM 없음):${uniqueCriteria.map(c => `\n         "${c}" → [${synonymMap[c].join(", ")}]`).join("")}\x1b[0m`);

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
        // 1차부터 유의어 + 사양표 키워드를 포함한 스마트 쿼리로 advanced 검색
        // (STEP 4.5/4.7 재검색이 불필요해질 만큼 충분히 강한 쿼리를 처음부터 사용)
        const cleanedCriterion = rowCriterion.replace(/\s*\[[^\]]*\]/g, "").replace(/\s*\([^)]*\)/g, "").trim();
        const synonyms = synonymMap[rowCriterion] ?? [];
        const terms = [cleanedCriterion, ...synonyms.slice(0, 2), "제원 사양표"].join(" ");
        const fullName = fullNameMap.get(productLabel) ?? productLabel;
        const results = await tavilySearch(`${fullName} ${terms}`, "advanced");
        searchResultMap.set(key, results);
        // ── Tavily 원본 결과 상세 로그 ──────────────────────────────────
        console.log(`         🔍 "${fullName} × ${cleanedCriterion}" → ${results.length}개 결과`);
        results.forEach((r, idx) => {
          console.log(`            [${idx + 1}] score=${r.score?.toFixed(2) ?? '?'} | ${r.url}`);
          console.log(`                 ${r.content.replace(/\s+/g, ' ').slice(0, 150)}...`);
        });
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
        // judgeCell에 실제로 넘어가는 키워드 창(300자)을 미리 표시
        if (snippets.length > 0) {
          const kws = [rowCriterion, ...(synonymMap[rowCriterion] ?? []), productLabel];
          console.log(`\n         \x1b[90m[judgeCell 입력] "${productLabel}" × "${rowCriterion}"\x1b[0m`);
          snippets.slice(0, 3).forEach((r, idx) => {
            const window = extractKeywordWindow(r.content, kws, 300);
            console.log(`            [${idx + 1}] ${r.url}`);
            console.log(`                 ${window.replace(/\s+/g, ' ').slice(0, 200)}`);
          });
        }
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

    // spec-cache는 setSpec 호출 시 자동 저장됨
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

/**
 * 로컬 DB에서 productName과 이름이 70% 이상 겹치는 "형제 제품"(같은 라인업의 다른 변형,
 * 예: "...Slim" vs "...Slim 직배수")을 찾아, 그 형제 제품에만 있는 구분 토큰을 반환한다.
 * 브랜드/카테고리별 접미어("직배수", "Ultra" 등)를 하드코딩하지 않고 DB에 실제로 존재하는
 * 이름 차이를 계산하므로 카테고리에 무관하게 동작한다.
 */
export function getSiblingExcludeTokens(productName: string, category: string): string[] {
  const excludeTokens = new Set<string>();
  const fileName = CATEGORY_FILE_MAP[category];
  if (!fileName) return [];

  try {
    const filePath = path.join(process.cwd(), "data", fileName);
    const allProducts: { name: string }[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const targetTokens = new Set(productName.split(/\s+/).filter((w) => w.length >= 2));

    for (const p of allProducts) {
      if (!p.name || p.name === productName) continue;
      const pTokens = p.name.split(/\s+/).filter((w) => w.length >= 2);
      if (pTokens.length === 0) continue;
      const overlap = pTokens.filter((t) => targetTokens.has(t)).length;
      const overlapRatio = overlap / Math.max(pTokens.length, targetTokens.size);
      if (overlapRatio >= 0.7) {
        pTokens.filter((t) => !targetTokens.has(t)).forEach((t) => excludeTokens.add(t));
      }
    }
  } catch (e) {
    console.warn(`[getSiblingExcludeTokens] DB 읽기 실패:`, e);
  }

  return [...excludeTokens];
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

// enrichContextWithTavily는 lib/backend/services/spec-lookup.ts로 이동했다 —
// lookupProductSpec()을 재사용하도록 다시 짜면서, data_agent.ts에 두면
// spec-lookup.ts(이 파일을 import함)와 순환 참조가 생기기 때문.

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
    model: openai("gpt-4o"),
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
    maxOutputTokens: 128,  // 인덱스 배열만 반환 — 6개 기준 ~20토큰
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


export async function computeRankingAndReasoning(
  tableJson: CompTableJson,
  decisionCriteria: string[],
  locale: string
): Promise<{ reasoning: string }> {
  const finalRows = tableJson.props?.rows ?? [];
  const hasRankRow = finalRows.some(r => r["criterion"] === "순위" || r["criterion"] === "Rank");
  const productCols = (tableJson.props?.columns ?? []).filter(c => c.key !== "criterion");

  if (!hasRankRow || productCols.length === 0) return { reasoning: "" };

  // WSM 가중합 순위 계산은 프론트(app/page.tsx의 즉시 재계산)와 로직이 갈라지지 않도록
  // lib/shared/wsm-ranking.ts의 공용 함수를 쓴다. 가중치 소스만 여기(문자열 "[중요]" 태그
  // 파싱)와 프론트(구조화된 criteria 배열)가 서로 달라 getWeight로 어댑터를 넘긴다.
  const rankedRows = computeWsmRanking(finalRows, tableJson.props?.columns ?? [], (criterion) =>
    findCriterionWeight(criterion, decisionCriteria)
  );
  tableJson.props!.rows = rankedRows; // 호출자들이 tableJson을 그대로 참조하므로 in-place로 반영
  const rankRow = rankedRows.find(r => r["criterion"] === "순위" || r["criterion"] === "Rank")!;

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
      model: openai("gpt-4o"),
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


// ---------------------------------------------------------------------------
// ComparisonTable Pipeline Orchestrator  (리팩토링: 9단계 → 3단계)
//
// STEP 1: buildAndAssembleTable()   — 코드로 구조 생성 + DB 값 즉시 주입 (LLM 없음, ~0ms)
// STEP 2: enrichCompTableCells()    — DB 미커버 셀 → Tavily + LLM 판단 (~4-5s)
// STEP 3: computeRankingAndReasoning() — WSM 순위 + 이유 (~1s)
// ---------------------------------------------------------------------------

import { currentLocale as _currentLocale } from "../tools/sidebar-store";

/**
 * 제품명을 열 헤더 표시용으로 정리한다 (접미사 제거만, 잘라내지 않음).
 * 검색(Tavily)에는 사용하지 않음 — 검색은 항상 uiContext의 전체 이름을 사용.
 */
function shortenProductName(name: string): string {
  const SUFFIX_STRIP = /\s*(직배수|직충전|업그레이드|에디션|한정판|특별판|리미티드|스페셜)\s*$/g;
  return name.replace(SUFFIX_STRIP, "").trim();
}

/**
 * uiContext를 파싱해서 CompTable JSON을 코드로 생성하고
 * DB에서 확인 가능한 셀 값을 즉시 주입한다.
 * 이전의 STEP 0 + STEP 1(LLM) + STEP 1 post + STEP 1.5를 단일 함수로 통합.
 *
 * @returns { tableJson, fullNameMap }
 *   tableJson  — 완성된 구조 + DB 채워진 셀 (미확인 셀은 "-")
 *   fullNameMap — short label → full name 매핑 (enrichCompTableCells에서 재사용)
 */
function buildAndAssembleTable(
  uiContext: string,
  decisionCriteria: string[],
  locale: string
): { tableJson: CompTableJson; fullNameMap: Map<string, string> } {
  // 1. [Product N] 블록 파싱 —————————————————————————————————————————————
  const blocks = uiContext.split(/\[Product \d+\]/).filter(b => b.trim());
  const products = blocks.map((block, idx) => {
    const name     = block.match(/Name:\s*(.+)/)?.[1].trim() ?? `Product ${idx + 1}`;
    const imageUrl = block.match(/Image:\s*(\S+)/)?.[1]?.trim() ?? "";
    const specs    = block.match(/Specs:\s*(.+)/)?.[1]?.split(" / ").map(s => s.trim()).filter(Boolean) ?? [];
    return { key: `prod_${idx}`, name, imageUrl, specs };
  });

  // 2. short label → full name 매핑 (검색용) ——————————————————————————————
  const fullNameMap = new Map<string, string>();
  products.forEach(p => {
    const label = shortenProductName(p.name);
    fullNameMap.set(label, p.name);
    console.log(`\x1b[90m[Build] 제품명 매핑: "${label}" → "${p.name}"\x1b[0m`);
  });

  // 3. columns 구성 ————————————————————————————————————————————————————————
  const columns = [
    { key: "criterion", label: locale === "ko" ? "비교 항목" : "Criteria" },
    ...products.map(p => ({
      key:      p.key,
      label:    shortenProductName(p.name),
      imageUrl: p.imageUrl,
    })),
  ];

  // 4. rows 구성 — 순위 행 + criteria 행 (DB 값 즉시 주입) ——————————————————
  const prodKeys = products.map(p => p.key);
  const emptyRow = Object.fromEntries(prodKeys.map(k => [k, "-"]));

  const rows: Array<Record<string, string>> = [
    // 순위 행 (항상 "-", WSM 계산 후 STEP 3에서 채워짐)
    { criterion: locale === "ko" ? "순위" : "Rank", ...emptyRow },
    // criteria 행
    ...decisionCriteria.map(criterion => {
      const label = cleanLabel(criterion);   // 브라켓/괄호 제거
      const cells = Object.fromEntries(
        products.map((p, i) => [p.key, lookupCellValue(label, p.specs)])
      );
      return { criterion: label, ...cells };
    }),
  ];

  // 5. DB 주입 결과 로깅 ——————————————————————————————————————————————————
  console.log(`\x1b[33m[STEP 1] 구조 생성 + DB 값 주입 완료 (${decisionCriteria.length}개 기준 × ${products.length}개 제품):\x1b[0m`);
  rows.filter(r => r.criterion !== "순위" && r.criterion !== "Rank").forEach(r => {
    const vals = prodKeys.map(k => `${k}:${r[k]}`).join(" | ");
    console.log(`         "${r.criterion}" → ${vals}`);
  });

  const tableJson: CompTableJson = {
    type: "Table",
    props: { _rankReasoning: "", columns, rows },
  };

  return { tableJson, fullNameMap };
}

export async function orchestrateCompTablePipeline(
  uiContext: string,
  decisionCriteria: string[],
  savedItems: string[],
  currentRows: string[] = []
): Promise<string> {
  const locale = _currentLocale;

  const t0 = Date.now();
  console.log("\n\x1b[35m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");
  console.log("\x1b[35m [CompTable Pipeline Start] (코드 구조 생성 + Tavily + WSM)\x1b[0m");
  console.log("\x1b[35m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n");

  // ── STEP 1: 코드로 구조 생성 + DB 값 즉시 주입 (LLM 없음) ───────────────
  console.log("\x1b[33m[STEP 1] 코드로 테이블 구조 생성 + DB 값 즉시 주입...\x1b[0m");
  const { tableJson, fullNameMap } = buildAndAssembleTable(uiContext, decisionCriteria, locale);

  // ── STEP 2: DB 미커버 셀 → Tavily + LLM 판단 ────────────────────────────
  await enrichCompTableCells(tableJson, uiContext, locale, fullNameMap);

  // ── STEP 3: WSM 순위 결정 + 이유 생성 ────────────────────────────────────
  {
    const { reasoning } = await computeRankingAndReasoning(tableJson, decisionCriteria, locale);
    if (tableJson.props && reasoning) {
      (tableJson.props as any)._rankReasoning = reasoning;
    }
  }

  console.log(`\n\x1b[32m━━ Pipeline complete (${Date.now() - t0}ms) ━━\x1b[0m\n`);
  return JSON.stringify(tableJson);
}

