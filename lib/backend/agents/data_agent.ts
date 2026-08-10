import { tool, generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { embedQuery, embedBatch, cosineSimilarity } from "../rag/search";

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

    const SPEC_VALUE_SPLIT_LEN = 30;

    const addSpec = (label: string, value: string) => {
      const trimmedLabel = label.trim();
      const trimmedValue = value.trim();
      if (!trimmedLabel || !trimmedValue || trimmedValue === "-") return;

      // "스마트 기능: 앱 연동, 청소 예약, 실시간 모니터링, ..."처럼 콤마로 여러 항목이
      // 나열된 긴 값은 다른 스펙(예: 배터리 수명: 6,400mAh)과 크기가 맞도록 항목별로 쪼갠다.
      const parts = trimmedValue.length > SPEC_VALUE_SPLIT_LEN && trimmedValue.includes(",")
        ? trimmedValue.split(",").map(s => s.trim()).filter(Boolean)
        : [trimmedValue];

      for (const part of parts) {
        const key = `${trimmedLabel}: ${part}`;
        if (!seen.has(key)) {
          seen.add(key);
          specs.push(key);
        }
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



export type TavilyResult = { title: string; url: string; content: string; score: number };

// ---------------------------------------------------------------------------
// Lookup Trace — judgeCell/lookupProductSpec이 값을 못 찾았을 때 "어느 단계에서,
// 왜" 버려졌는지 남기기 위한 진단 정보. 예전엔 전부 { value: "-" }로 뭉개져서
// "검색 자체가 0건이었다"와 "값은 찾았는데 sibling guard가 버렸다"를 구분할 방법이
// 없었다 — 이 타입/로그가 그 구분을 만들어준다.
// ---------------------------------------------------------------------------

export type LookupDiscardStage =
  | "db_hit"             // 성공 — 로컬 DB에서 찾음
  | "tavily_empty"       // Tavily 검색 결과 0건
  | "no_segments"        // 스니펫은 있지만 키워드 창에서 인용 가능한 구절이 안 나옴
  | "llm_parse_error"     // LLM 응답이 JSON으로 파싱 안 됨
  | "extractive_qa_null" // LLM이 "명시적으로 이 값이라고 말하는 구절 없음"으로 판단
  | "evidence_missing"   // LLM이 값은 냈지만 segmentId가 없거나 범위 밖 — 폐기 대신 uncertain=true로 값 유지
  | "sibling_guard"      // 값이 타겟 제품보다 형제 제품(Slim/직배수 등)에 압도적으로 가깝게 위치해 폐기
  | "sibling_guard_uncertain" // 형제 제품 토큰이 있지만 격차가 압도적이지 않음/binding 불명 — 폐기 대신 uncertain=true로 값 유지
  | "echo_guard"         // 추출값이 기준명/유의어 자체를 되풀이한 것이라 폐기 (value 타입만)
  | "sanity_check"       // 수치가 물리적으로 불가능한 범위라 폐기
  | "tavily_hit";        // 성공 — Tavily + judgeCell 검증 통과

export interface LookupTrace {
  stage: LookupDiscardStage;
  detail?: string;
}

export interface TavilySearchOptions {
  /** 기본 5, Tavily 최대 20 */
  maxResults?: number;
  /** URL 하나당 뽑아낼 스니펫 개수 (1~3). advanced 검색에서만 의미 있음 */
  chunksPerSource?: number;
  /** 이 도메인들은 애초에 검색 결과에서 제외 (진짜 Tavily API 파라미터 — 쿼리 텍스트 "-단어"와 달리 실제로 지켜짐) */
  excludeDomains?: string[];
  /** 이 도메인들로만 검색 범위를 좁힘 — 1차 검색 실패 후 신뢰 도메인 재검색에 사용 */
  includeDomains?: string[];
  /** true 시 Tavily가 검색 결과를 AI로 합성한 answer를 함께 반환 — judgeCell 이전 fast-path로 활용 */
  includeAnswer?: boolean;
}

export async function tavilySearch(
  query: string,
  searchDepth: "basic" | "advanced" = "basic",
  options: TavilySearchOptions = {}
): Promise<{ results: TavilyResult[]; answer?: string }> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) { console.warn("[Tavily] API 키 없음"); return { results: [] }; }
  const body: Record<string, unknown> = {
    query,
    search_depth: searchDepth,
    max_results: options.maxResults ?? 5,
  };
  if (searchDepth === "advanced" && options.chunksPerSource) body.chunks_per_source = options.chunksPerSource;
  if (options.excludeDomains?.length) body.exclude_domains = options.excludeDomains;
  if (options.includeDomains?.length) body.include_domains = options.includeDomains;
  if (options.includeAnswer) body.include_answer = true;

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    // advanced + 더 많은 결과 요청은 basic보다 느리므로 타임아웃을 넉넉하게
    signal: AbortSignal.timeout(searchDepth === "advanced" ? 20000 : 10000),
  });
  if (!res.ok) { console.warn(`[Tavily] ${res.status}`); return { results: [] }; }
  const data = await res.json() as { results?: TavilyResult[]; answer?: string };
  return { results: data.results ?? [], answer: data.answer };
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

// ---------------------------------------------------------------------------
// 단위 정규화 — 같은 기준(criterion)인데 제품마다 mm/cm, Ah/mAh, dB/데시벨처럼
// 단위 표기가 다르면 표에서 비교가 안 된다. fieldKey로 단위군을 판별해
// 정규 단위로 변환한다. DB 값(toDisplayValue)과 Tavily 판단 값(judgeCell) 양쪽에서
// 이 함수를 거치므로 두 파이프라인(Option List/Comp Table) 모두 동일하게 적용된다.
// ---------------------------------------------------------------------------

interface UnitRule {
  /** fieldKey 매칭 패턴 */
  pattern: RegExp;
  /** 정규 단위 표시 문자열 */
  canonical: string;
  /** [단위 표기 패턴(값에서 숫자를 뗀 나머지와 정확히 일치해야 함), 정규 단위로 변환할 배율] */
  units: [RegExp, number][];
}

const UNIT_RULES: UnitRule[] = [
  // 길이류 — 정규 단위: cm
  { pattern: /높이|너비|폭|길이|두께|지름|직경/, canonical: "cm", units: [
    [/^mm$/i, 0.1], [/^cm$/i, 1], [/^m$/i, 100],
  ] },
  // 무게류 — 정규 단위: kg
  { pattern: /무게|중량/, canonical: "kg", units: [
    [/^kg$/i, 1], [/^g$/i, 0.001],
  ] },
  // 시간류(지속시간) — 정규 단위: 분. 배터리 "용량"(mAh) 패턴보다 반드시 먼저 검사해야
  // "배터리 수명"처럼 "배터리"를 포함하지만 실제로는 지속시간을 묻는 fieldKey가
  // 아래 배터리 용량 규칙에 잘못 걸리지 않는다.
  { pattern: /수명|사용시간|충전시간|런타임|runtime|시간/, canonical: "분", units: [
    [/^시간$/, 60], [/^분$/, 1], [/^min$/i, 1],
  ] },
  // 배터리 용량 — 정규 단위: mAh (배터리 패턴을 물탱크/먼지통보다 먼저 검사해야
  // "배터리 용량" 같은 fieldKey가 "용량" 키워드로 물탱크 규칙에 잘못 걸리지 않는다)
  { pattern: /배터리|battery/i, canonical: "mAh", units: [
    [/^mah$/i, 1], [/^ah$/i, 1000],
  ] },
  // 물탱크/먼지통 용량 — 정규 단위: L
  { pattern: /물탱크|먼지통|집진통|탱크|용량/, canonical: "L", units: [
    [/^ml$/i, 0.001], [/^l$/i, 1],
  ] },
  // 소음 — 정규 단위: dB (배율 변환 없이 "데시벨" 표기만 통일)
  { pattern: /소음/, canonical: "dB", units: [
    [/^db$/i, 1], [/^데시벨$/, 1],
  ] },
  // 흡입력 — 정규 단위: Pa
  { pattern: /흡입/, canonical: "Pa", units: [
    [/^kpa$/i, 1000], [/^pa$/i, 1],
  ] },
];

/**
 * label(기준명)이 기대하는 단위군과 rawValue의 실제 단위가 다른 물리량이면 true.
 * "배터리 수명"(시간류)이 "배터리: 6400mAh"(용량류) 스펙에 잘못 매칭되는 것처럼,
 * 서로 다른 물리량이 같은 키워드("배터리")를 공유할 때 걸러내기 위한 범용 가드 —
 * 새 UNIT_RULES 항목이 추가돼도 코드 수정 없이 동일하게 적용된다.
 * 단위를 못 알아보거나(라벨 있는 값·boolean 값 포함) 라벨이 어느 단위군에도 안 걸리면
 * 판단 불가로 보고 false(불일치 아님)를 반환한다 — 오탈락보다 원본 유지가 안전하다.
 */
export function hasUnitDimensionMismatch(label: string, rawValue: string): boolean {
  if (!rawValue || rawValue === "-" || rawValue === "○" || rawValue === "X" || rawValue.includes(":")) return false;
  const labelRule = UNIT_RULES.find(r => r.pattern.test(label));
  if (!labelRule) return false;

  const match = rawValue.match(/^([\d,]+(?:\.\d+)?)\s*([^\d\s].*)?$/);
  const unitPart = (match?.[2] ?? "").trim();
  if (!unitPart) return false;

  const valueRule = UNIT_RULES.find(r => r.units.some(([unitPattern]) => unitPattern.test(unitPart)));
  if (!valueRule) return false;

  return valueRule.canonical !== labelRule.canonical;
}

/**
 * 값 문자열에서 숫자+단위를 분리해 해당 기준(fieldKey)의 정규 단위로 변환한다.
 * 매칭되는 규칙이 없거나, 단위를 못 알아보거나, 라벨 있는 값("배터리: 6400mAh")·
 * boolean 값(○/X/-)이면 원본을 그대로 반환한다 — 오탈락보다 원본 유지가 안전하다.
 */
function normalizeUnitValue(value: string, fieldKey: string, canonicalUnit?: string | null): string {
  if (!value || value === "-" || value === "○" || value === "X") return value;
  if (value.includes(":")) return value;

  const rule = UNIT_RULES.find(r => r.pattern.test(fieldKey));
  if (rule) {
    const match = value.match(/^([\d,]+(?:\.\d+)?)\s*([^\d\s].*)?$/);
    if (!match) return value;
    const unitPart = (match[2] ?? "").trim();
    if (!unitPart) return value;

    const found = rule.units.find(([unitPattern]) => unitPattern.test(unitPart));
    if (!found) return value; // 인식 못하는 단위 표기 → 원본 유지

    const [, factor] = found;
    const num = parseFloat(match[1].replace(/,/g, ""));
    const converted = num * factor;
    const formatted = Number.isInteger(converted)
      ? converted.toLocaleString("en-US")
      : String(Math.round(converted * 100) / 100);

    return `${formatted}${rule.canonical}`;
  }

  // UNIT_RULES에 매칭되는 하드코딩 규칙이 없는 기준 → expandCriterionMeta()가 LLM으로 준
  // canonicalUnit으로 표기만 통일한다. 배율 변환表(mm→cm 같은)은 모르므로 순수 숫자값에
  // 단위만 붙인다 — 이미 단위가 붙어 있으면(정규식이 숫자만 매칭이라 그대로 통과) 건드리지 않는다.
  if (canonicalUnit) {
    const numOnly = value.match(/^[\d,]+(?:\.\d+)?$/);
    if (numOnly) return `${value}${canonicalUnit}`;
  }

  return value;
}

/** 스펙 rawValue를 표시용 셀 값으로 변환. fieldKey를 주면 단위도 정규화한다. */
export function toDisplayValue(rawValue: string, fieldKey?: string): string {
  if (!rawValue || rawValue === "-") return "-";
  if (rawValue === "○") return "○";
  // 명시적 부재 표현 → "X"
  if (/없음|미지원|해당없음|불가/.test(rawValue)) return "X";
  const normalized = rawValue;
  // 15자 초과 시 앞부분 자르기
  return normalized.length > 15 ? normalized.slice(0, 15) : normalized;
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

// ── 기준 메타데이터 (형식 힌트 + 정규 단위) — LLM 1회 생성 후 캐싱 ─────────
// UNIT_RULES처럼 개발자가 미리 정규식을 하드코딩하지 않고도, 사용자가 임의로
// 만드는 새 기준(예: "센서 크기", "AF 포인트 수")에 자동으로 대응하기 위함.
// judgeCell의 값 추출 판단과 normalizeUnitValue의 단위 통일 양쪽에서 재사용.
export interface CriterionMeta {
  /** judgeCell 프롬프트에 삽입할 한 문장 힌트 — 예상 형식 + 흔히 혼동되는 다른 스펙과의 구분 */
  formatHint: string;
  /** 정규 단위 (단위가 있는 수치 기준만, 없으면 null — 예: boolean 기준, 목록형 기준) */
  canonicalUnit: string | null;
}

// Promise 자체를 캐시한다(값이 아니라) — enrichContextWithTavily/lookupProductSpec처럼 같은
// 기준을 여러 제품에 대해 Promise.all로 동시에 조회하는 호출부에서, 값을 캐시하면 Map.set()이
// 첫 요청의 await 완료 후에나 이뤄져서 그 전에 시작된 동시 호출들이 전부 캐시 미스로 판정되어
// 각자 LLM을 따로 부르는 레이스 컨디션이 있었다(예: 제품 3개가 "해상도"를 동시에 조회 → LLM
// 3번 호출). Promise를 동기적으로 캐시에 먼저 넣으면, 동시에 들어오는 중복 호출이 같은
// in-flight 요청을 공유하게 된다.
const criterionMetaCache = new Map<string, Promise<Record<string, CriterionMeta>>>();

export async function expandCriterionMeta(
  criteria: string[]
): Promise<Record<string, CriterionMeta>> {
  if (criteria.length === 0) return {};

  const cacheKey = [...criteria].sort().join("|");
  const cached = criterionMetaCache.get(cacheKey);
  if (cached) {
    console.log(`\x1b[36m[CriterionMeta] 캐시 히트(진행 중인 요청 포함): [${criteria.join(", ")}]\x1b[0m`);
    return cached;
  }

  const promise = (async (): Promise<Record<string, CriterionMeta>> => {
    try {
      const { text } = await generateText({
        model: openai("gpt-4o"),
        system: `You are a product spec analyst. For each Korean product criterion, provide:
1. "formatHint": ONE short Korean sentence describing (a) what unit or format the correct value should take, and (b) what commonly-confused OTHER spec it must NOT be mistaken for. Be specific and concrete — this will be injected into an extraction prompt to prevent a model from picking the wrong kind of value.
2. "canonicalUnit": the standard unit abbreviation this criterion's numeric values should be normalized to (e.g. "mm", "kg", "dB", "Pa", "mAh", "L", "분"). If the criterion has no meaningful single unit (e.g. it's a boolean/feature-presence criterion, or a list of named items, or a format/resolution criterion with multiple valid notations like "4K"/"6000x4000"), set this to null.

Output ONLY valid JSON in this exact shape:
{ "<criterion>": { "formatHint": "...", "canonicalUnit": "mm" | null }, ... }`,
        prompt: `Criteria: ${JSON.stringify(criteria)}`,
        temperature: 0,
      });

      let result: Record<string, CriterionMeta> = {};
      try {
        const match = text.match(/\{[\s\S]*\}/);
        result = match ? JSON.parse(match[0]) : {};
      } catch {
        console.warn("[CriterionMeta] JSON parse failed:", text.slice(0, 200));
        result = {};
      }

      console.log(`\x1b[36m[CriterionMeta] 생성 완료: [${criteria.join(", ")}]\x1b[0m`);
      return result;
    } catch (err) {
      // LLM 호출 자체가 실패하면(네트워크/레이트리밋) 캐시에서 지워서 다음(동시가 아닌) 호출이
      // 재시도할 수 있게 한다 — 실패를 영구히 캐시하면 안 된다. judgeCell은 formatHint 없이
      // 기존처럼 동작하면 되므로 여기서 던지지 않는다 — 검색 파이프라인 전체를 막지 않기 위함.
      criterionMetaCache.delete(cacheKey);
      console.warn("[CriterionMeta] 생성 실패, 힌트 없이 진행:", err);
      return {};
    }
  })();

  criterionMetaCache.set(cacheKey, promise);
  return promise;
}

export function detectCriterionType(criterion: string): "value" | "boolean" {
  const VALUE_KEYWORDS = [
    "무게", "중량", "가격", "가격대", "크기", "사이즈", "길이", "너비", "높이", "두께",
    "용량", "배터리", "소음", "흡입력", "수명", "시간", "속도", "rpm", "파스칼", "pa",
    "db", "watt", "mah", "mm", "cm", "kg", "g", "먼지통", "물탱크", "바구니", "장바구니",
    "물통", "차양막",
    // 수치는 아니지만 "예/아니오"가 아니라 구체적인 답(국가/소재/색상 등)이 필요한 개방형
    // 기준 — 여기 없으면 boolean으로 분류돼 "○/X/하위기능목록" 프롬프트가 걸리는데, 애초에
    // 안 맞는 질문 형태라 LLM이 "원산지 지원"처럼 근거 문장의 조사만 값으로 뽑는 일이 있었다.
    "원산지", "생산지", "제조국", "색상", "소재", "재질", "브랜드", "제조사", "모델명", "등급",
  ];
  const lower = criterion.toLowerCase();
  return VALUE_KEYWORDS.some(k => lower.includes(k)) ? "value" : "boolean";
}

export function extractKeywordWindow(content: string, keywords: string[], windowSize = 300): string {
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

/** 기준명 뒤에 붙어도 정보량이 0인 범용 확인 단어 — "원산지 지원"처럼 기준명+이 단어뿐이면 값이 아니라 되풀이다. */
const GENERIC_CONFIRM_SUFFIXES = ["지원", "가능", "제공", "있음", "됨", "지원함", "지원됨", "가능함", "제공됨"];

/**
 * 추출된 값이 기준명/유의어를 그대로 되풀이한 것인지 판별.
 * 검색 쿼리가 "<제품명> <기준명>"처럼 포괄적일 때, LLM이 스니펫에 등장하는
 * 기준명 자체를 "값"으로 착각해 반환하는 것을 기준(criterion)과 무관하게 범용적으로 차단한다.
 * 완전 일치("원산지" == "원산지")뿐 아니라, 기준명 뒤에 "지원"처럼 정보량 없는 확인 단어만
 * 붙은 경우("원산지지원")도 같은 취급 — "원산지: 지원합니다" 같은 원문에서 국가명 대신
 * 이 접미어를 값으로 잘못 추출하는 경우가 실제로 관찰됐다.
 */
function isLiteralEcho(rawValue: string, criterion: string, synonyms: string[]): boolean {
  const normVal = normalizeTerm(rawValue);
  if (!normVal) return false;
  const terms = [criterion, ...synonyms].map(normalizeTerm).filter(t => t.length >= 2);
  if (terms.some(t => t === normVal)) return true;
  return terms.some(t => {
    if (!normVal.startsWith(t)) return false;
    const rest = normVal.slice(t.length);
    return rest === "" || GENERIC_CONFIRM_SUFFIXES.includes(rest);
  });
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
  siblingExcludeTokens: string[] = [],
  /** expandCriterionMeta()가 준 형식 힌트 — 혼동되기 쉬운 다른 스펙과 구분하도록 프롬프트에 삽입 */
  formatHint?: string,
  /** expandCriterionMeta()가 준 정규 단위 — UNIT_RULES에 없는 기준의 단위 표기 통일에 사용 */
  canonicalUnit?: string | null
): Promise<{ value: string; sourceUrl?: string; usedSnippet?: string; uncertain?: boolean; trace: LookupTrace }> {
  if (snippets.length === 0) {
    return { value: "-", trace: { stage: "tavily_empty", detail: "snippets array empty at judgeCell entry" } };
  }

  // ── 1. 제품명 사전 필터: 차단이 아니라 매칭률로 재정렬만 한다 ─────────────
  // 예전엔 토큰 매칭 50% 미만 스니펫을 통째로 버렸는데, 다나와/에누리 같은 스펙표는
  // 문서 상단에 모델코드만 있고 본문에 전체 제품명이 반복되지 않는 경우가 많아
  // 정답이 담긴 스니펫이 이 컷오프에 걸려 사라지는 역설이 있었다. 대신 매칭률로
  // 정렬만 해서 관련도 높은 스니펫을 앞쪽(뒤에서 후보 100개로 잘릴 때 유리한 자리)에
  // 두고, "명시적 값만 인정"하는 아래 LLM Extractive QA가 2차 필터 역할을 하게 둔다.
  const productTokens = productName.split(/\s+/).filter(w => w.length >= 2);
  const matchRatio = (r: TavilyResult) => {
    const hits = productTokens.filter(t => r.content.toLowerCase().includes(t.toLowerCase()));
    return hits.length / Math.max(productTokens.length, 1);
  };
  const usableSnippets = [...snippets].sort((a, b) => matchRatio(b) - matchRatio(a));
  // 이후 어느 단계에서 discard되든 trace.detail에 같이 실어서, 옛 50% 기준으로 봤을 때
  // 얼마나 통과했을지를 진단용으로 남긴다(실제 필터링에는 더 이상 안 쓰임).
  const productFilterInfo = `productFilter=rerank-only(구컷오프 기준 ${snippets.filter(r => matchRatio(r) >= 0.5).length}/${snippets.length}matched)`;

  const keywords = [
    criterion, ...synonyms, ...criterion.split(/\s+/), productName, ...productTokens,
  ].filter(w => w.length >= 2);

  // ── 2. 스니펫을 번호 매긴 구절 단위로 쪼갬 ─────────────────────────────────
  // LLM이 인용문을 직접 타이핑하게 하는 대신 "몇 번 구절"인지만 고르게 해서,
  // 근거 텍스트가 항상 원문 그대로가 되도록 한다 — 사후에 fuzzy 대조로 검증하는 게
  // 아니라,애초에 LLM이 텍스트를 왜곡할 수 있는 경로 자체를 없앤다.
  // 300자였던 창을 500자로 넓힘 — 스펙표에서 원하는 항목이 다른 키워드 없이 혼자
  // 뚝 떨어져 있으면 좁은 창 밖으로 밀려나 판단 재료 자체가 없어지는 경우가 있었다.
  //
  // 예전엔 여기서 usableSnippets 중 앞 8개(Tavily 자체 관련도 순서일 뿐 이 기준과의
  // 관련도는 아님)만 썼다 — lookupProductSpec이 advanced+20개를 받아오는데도 나머지
  // 60%가 LLM에게 보여지지도 못한 채 버려졌다. 이제 받아온 스니펫 전체에서 구절을
  // 뽑은 뒤, "제품명+기준"과의 임베딩 유사도로 재랭킹해 상위 TOP_SEGMENTS만 LLM에
  // 넘긴다 — 뒤쪽 결과에 있던 정답도 살아남고, 동시에 LLM이 한 번에 봐야 하는 구절
  // 수는 오히려 줄어든다(예전에 128개 구절을 통째로 던져 근거 인용을 놓친 사례 있음).
  // Google batchEmbedContents는 한 번에 최대 100개 요청까지만 허용한다.
  const MAX_CANDIDATE_SEGMENTS = 100;
  const TOP_SEGMENTS = 30;

  const allSegments: { text: string; url: string }[] = [];
  usableSnippets.forEach((r) => {
    const window = extractKeywordWindow(r.content, keywords, 1000);
    splitIntoSegments(window).forEach((seg) => allSegments.push({ text: seg, url: r.url }));
  });

  if (allSegments.length === 0) {
    return { value: "-", trace: { stage: "no_segments", detail: `${productFilterInfo}, usableSnippets=${usableSnippets.length}` } };
  }

  const candidateSegments = allSegments.length > MAX_CANDIDATE_SEGMENTS
    ? allSegments.slice(0, MAX_CANDIDATE_SEGMENTS)
    : allSegments;

  let segments = candidateSegments;
  let rerankInfo = "no_rerank(within_top_limit)";
  if (candidateSegments.length > TOP_SEGMENTS) {
    const [queryVec, docVecs] = await Promise.all([
      embedQuery(`${productName} ${criterion}`),
      embedBatch(candidateSegments.map((s) => s.text)),
    ]);
    if (docVecs) {
      segments = candidateSegments
        .map((seg, i) => ({ seg, score: cosineSimilarity(queryVec, docVecs[i]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_SEGMENTS)
        .map((r) => r.seg);
      rerankInfo = `reranked(${allSegments.length}→${candidateSegments.length}→${segments.length})`;
    } else {
      segments = candidateSegments.slice(0, TOP_SEGMENTS);
      rerankInfo = `rerank_failed_fallback(${allSegments.length}→${segments.length})`;
    }
  }
  console.log(`\x1b[90m[SegmentRerank] "${productName}" × "${criterion}": ${rerankInfo}\x1b[0m`);

  // JSON 직렬화 불가 제어 문자 제거 — 웹 콘텐츠(YouTube·Reddit·Amazon 등)에
  // null byte(\u0000)나 \x01~\x1F 같은 제어 문자가 섞이면 OpenAI API가 400을 반환.
  const sanitize = (t: string) => t.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  const snippetText = segments.map((s, i) => `[${i + 1}] ${sanitize(s.text)}`).join("\n");

  // ── 3. Extractive QA 프롬프트 ─────────────────────────────────────────────
  const hintLine = formatHint
    ? `\n- IMPORTANT format guidance for this specific criterion: ${formatHint}`
    : "";

  const systemPrompt = criterionType === "value"
    ? `You are a product spec extractor using extractive QA.
Given numbered text segments, find the value for the criterion ONLY if explicitly stated in one segment.
Respond with ONLY a JSON object:
{ "value": "<extracted value or null>", "segmentId": <1-based segment number that states this value, or null> }
Rules:
- value: specific measurable value (e.g., "75dB", "약 200분", "6,400mAh"). Max 15 chars. Prices in "000,000원" format.
- UNIT NORMALIZATION — always convert to these standard units before returning:
  · Battery capacity → mAh  (e.g. 6.4Ah → "6400mAh", 3200mAh stays "3200mAh")
  · Noise → dB  (e.g. "65데시벨" → "65dB")
  · Suction → Pa  (e.g. "4.5kPa" → "4500Pa")
  · Weight → kg  (e.g. "3500g" → "3.5kg")
  · Length/height/width → cm  (e.g. "92mm" → "9.2cm")
  · Runtime/charge time → 분  (e.g. "3시간" → "180분", "1시간 30분" → "90분")
  · Water tank/dustbin capacity → L  (e.g. "350ml" → "0.35L")
- SANITY CHECK — if the numeric value is physically impossible for that criterion (e.g. noise > 120dB, suction < 10Pa or > 100000Pa, battery < 50mAh or > 30000mAh, weight > 50kg), set all fields to null.
- segmentId: MUST be the number of the segment that explicitly states this value. Never invent a number.
- If the segment is about a DIFFERENT model than the specified product, set all fields to null.
- CRITICAL — sibling variant check: the exact product name above may share almost all of its name with a
  DIFFERENT sibling model in the same product line (e.g. a "직배수"/direct-drain version, "Ultra", "Slim",
  "Pro", or a different trailing model code). If the segment you would cite names such a variant/suffix that
  is NOT part of the exact product name given above, that text is about the SIBLING model, not this one —
  set all fields to null even if the rest of the segment looks relevant. Never carry a sibling model's spec
  over to this product just because most of the name matches.
- If the value is not explicitly stated in any segment, set all fields to null.
- Write "value" in ${locale === "en" ? "English" : "Korean"} — translate faithfully from the source segment if it is in a different language. Numbers/units stay as normalized above.${hintLine}`
    : `You are a product spec verifier using extractive QA.
Given numbered text segments, determine if the product explicitly has or lacks the specified feature/criterion, and extract concrete detail if named.
Respond with ONLY a JSON object:
{ "value": "<see rules>", "segmentId": <1-based segment number this is based on, or null> }
Rules for "value":
- If any segment names concrete, specific sub-features, actions, or functions (e.g. "AI 장애물 회피", "원격제어", "홈캠", "가구 인식", "사람 감지"), return them as a short comma-separated list, max 40 chars total. Only include items explicitly named in the text.
- Prefer FUNCTIONAL descriptions (what the feature actually DOES) over a bare marketing/brand name for the underlying technology (e.g. "Reactive AI 3.0", "PreciSense", "LDS 라이다 X1"). A brand/product name alone does not tell the user what it does. If a segment only names such a brand/product name WITHOUT explaining its function, and no other segment states the function, treat this the same as finding no specific sub-feature — return "○" instead of the bare brand name.
- If a segment only confirms the feature/criterion exists in general terms, WITHOUT naming any specific sub-feature or function, return "○".
- If a segment explicitly says the feature is absent, return "X".
- NEVER return the criterion name itself, a generic category label or head noun, a bare acronym that just restates the criterion (e.g. "AI" for criterion "AI 기능", "센서" for criterion "센서 기능"), or a synonym of the criterion as the value — none of these add information beyond the criterion itself. If that is all you can find, use "○" instead.
- If the criterion is a broad umbrella category (e.g. "편의 기능", "스마트 기능"), actively scan ALL segments for an enumerated list of the actual named sub-features before giving up and returning "○" — don't settle for a generic confirmation if a specific list is stated anywhere in the segments.
- segmentId: MUST be the number of the segment that supports this "value". Never invent a number.
- If no segment is about this product, or nothing relevant is stated, set all fields to null.
- CRITICAL — sibling variant check: the exact product name above may share almost all of its name with a
  DIFFERENT sibling model in the same product line (e.g. a "직배수"/direct-drain version, "Ultra", "Slim",
  "Pro", or a different trailing model code). If the segment you would cite names such a variant/suffix that
  is NOT part of the exact product name given above, that text is about the SIBLING model, not this one —
  set all fields to null even if the rest of the segment looks relevant. Never carry a sibling model's
  feature over to this product just because most of the name matches.
- When "value" is a feature list (not the bare "○"/"X" symbols), write it in ${locale === "en" ? "English" : "Korean"} — translate faithfully from the source segment if it is in a different language.${hintLine}`;

  const { text } = await generateText({
    model: openai("gpt-4o-mini"),
    system: systemPrompt,
    prompt: `Product: ${productName}\nCriterion: ${criterion} (Synonyms/Related terms: ${synonyms.join(", ")})\n\nText segments:\n${snippetText}`,
    temperature: 0,
  });

  try {
    const match = text.match(/\{[\s\S]*?\}/);
    const result = match ? JSON.parse(match[0]) : {};
    const rawValue: string | null = result.value ?? null;
    const segId: number | null = result.segmentId ?? null;

    if (!rawValue) {
      console.log(`\x1b[31m[ExtractiveQA] FAILED — "${productName}" × "${criterion}": LLM이 ${segments.length}개 구절 중 명시적 값을 찾지 못함 (null)\x1b[0m`);
      segments.forEach((s, i) => {
        console.log(`\x1b[90m  [${i + 1}] (${s.url}) ${s.text}\x1b[0m`);
      });
      return { value: "-", trace: { stage: "extractive_qa_null", detail: `${segments.length} segments considered, ${productFilterInfo}` } };
    }

    // ── 4. Evidence Verification ───────────────────────────────────────────
    // 예전엔 LLM이 다시 타이핑한 evidence_quote를 원문과 fuzzy 토큰 대조했는데,
    // 이제 LLM은 번호만 고르므로 그 번호가 실존하는지만 확인하면 된다 — 확률적 대조가
    // 아니라 "근거가 있다/없다"가 확정적으로 갈린다. 번호가 없거나 범위를 벗어나면
    // 근거 없는 값으로 간주해 폐기한다(값은 있는데 근거를 못 대는 경우도 포함).
    let evidenceSeg = (segId != null && segId >= 1 && segId <= segments.length)
      ? segments[segId - 1]
      : null;

    if (!evidenceSeg) {
      // 값은 냈는데 인용 번호를 못 댄 경우 — 그 값(또는 "○"/"X"처럼 원문에 그대로 없는
      // 기호라면 기준/유의어)이 실제로 들어있는 세그먼트가 있는지 코드 레벨로 다시
      // 찾아본다. LLM의 판단을 그냥 믿는 게 아니라 여전히 원문에 그 텍스트가 실제로
      // 있어야만 통과시키므로 grounding 원칙은 그대로 두고, 번호 인용 서식 실수만 구제한다.
      const needles = [rawValue, criterion, ...synonyms, ...keywords].filter((t) => t.length >= 2);
      evidenceSeg = segments.find((s) =>
        needles.some((n) => s.text.toLowerCase().includes(n.toLowerCase()))
      ) ?? null;
      if (evidenceSeg) {
        console.log(`\x1b[33m[EvidenceCheck] 번호 인용 실패 → 텍스트 매치로 구제: "${evidenceSeg.text.slice(0, 60)}"\x1b[0m`);
      }
    }

    if (!evidenceSeg) {
      console.log(`\x1b[33m[EvidenceCheck] 근거 segmentId 없음/범위 밖, 텍스트 매치도 실패 → "${rawValue}" (추정)으로 표시\x1b[0m`);
      return { value: rawValue, uncertain: true, trace: { stage: "evidence_missing", detail: `rawValue="${rawValue}", segId=${segId}` } };
    }
    console.log(`\x1b[32m[EvidenceCheck] PASSED (segment #${segId ?? "text-match"}): "${evidenceSeg.text.slice(0, 60)}"\x1b[0m`);

    const evidenceQuote = evidenceSeg.text;

    // ── 4.5 Sibling Guard ───────────────────────────────────────────────────
    // 형제 제품 토큰이 근거 구절에 "같이 언급"된다고 그 값이 형제 제품 것이란 뜻은
    // 아니다 — "S10 MaxV Ultra has a height of 79.8mm, unlike the Slim..." 같은
    // 비교 구문에서는 값이 명백히 target(Ultra)에 귀속된다. 단순 co-occurrence
    // 대신, 값 위치에서 가장 가까운 제품 토큰이 target인지 sibling인지(binding)로
    // 판단한다 — 값과 제품명 사이의 거리가 "누구 얘기인지"의 신호다. (대소문자 구분 +
    // 단어 경계 매칭도 함께 적용 — "Ultra"(모델명)와 "ultra-slim"의 "ultra"(형용사)를
    // 구분하기 위함)
    if (siblingExcludeTokens.length > 0) {
      const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const findAllIndices = (text: string, token: string): number[] => {
        // JS \b는 \w(=[A-Za-z0-9_]) 기준이라 한글에는 경계가 전혀 안 잡힌다 —
        // "\\b직배수\\b"가 "직배수 모델을"에서 매치 0건이 되는 실제 버그였다.
        // \p{L}/\p{N}(유니코드 레터/숫자, 한글 포함) 기준 lookaround로 대체해
        // 한글·영문 토큰 모두에서 실제 단어 경계로 동작하게 한다.
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(token)}(?![\\p{L}\\p{N}])`, "gu");
        const indices: number[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) indices.push(m.index);
        return indices;
      };

      const siblingHitIdx = siblingExcludeTokens.flatMap((t) => findAllIndices(evidenceQuote, t));

      if (siblingHitIdx.length > 0) {
        const numMatch = rawValue.match(/[\d.]+/);
        const valueIdx = evidenceQuote.indexOf(rawValue) !== -1
          ? evidenceQuote.indexOf(rawValue)
          : (numMatch ? evidenceQuote.indexOf(numMatch[0]) : -1);
        const targetHitIdx = productTokens.flatMap((t) => findAllIndices(evidenceQuote, t));

        // binding을 아예 판단할 수 없는 경우("값/target 위치 못 찾음")는 "틀렸다는 증거"가
        // 아니라 "확인이 안 된다"는 뜻이라, 하드 폐기 대신 근거 인용 실패와 같은 레벨로
        // 낮춘다(uncertain=true) — 값은 살리고 "(추정)"으로 표시한다.
        if (valueIdx === -1 || targetHitIdx.length === 0) {
          console.log(`\x1b[33m[SiblingGuard] 형제 제품 토큰 포함 + binding 판단 불가(값/target 위치 못 찾음) → uncertain 다운그레이드\x1b[0m`);
          return { value: rawValue, uncertain: true, sourceUrl: evidenceSeg.url, usedSnippet: evidenceQuote, trace: { stage: "sibling_guard_uncertain", detail: "binding 판단 불가(값/target 위치 못 찾음)" } };
        }

        const nearestDist = (indices: number[]) => Math.min(...indices.map((i) => Math.abs(i - valueIdx)));
        const distToSibling = nearestDist(siblingHitIdx);
        const distToTarget = nearestDist(targetHitIdx);

        // 거리 하나로 이진 판정하면, 값·제품명·형제모델이 한 줄에 촘촘히 붙어 나오는
        // 스펙표 포맷에서 정답까지 같이 폐기되는 역설이 있었다. 그래서 거리 차이가
        // 압도적일 때(형제 토큰이 값 바로 옆 5자 이내인데 타깃 토큰은 근처에 전혀 없음)만
        // 하드 폐기로 남기고, 애매한 구간은 uncertain으로 살려서 "(추정)"과 함께 노출한다.
        if (distToSibling <= distToTarget) {
          const isOverwhelminglySibling = distToSibling <= 5 && distToTarget > 80;
          if (isOverwhelminglySibling) {
            console.log(`\x1b[31m[SiblingGuard] 값이 형제 제품에 압도적으로 가까움 (target ${distToTarget}자 vs sibling ${distToSibling}자) → 폐기\x1b[0m`);
            return { value: "-", trace: { stage: "sibling_guard", detail: `target ${distToTarget}자 vs sibling ${distToSibling}자 (압도적)` } };
          }
          console.log(`\x1b[33m[SiblingGuard] 값이 형제 제품에 더 가깝게 위치하나 격차는 크지 않음 (target ${distToTarget}자 vs sibling ${distToSibling}자) → uncertain 다운그레이드\x1b[0m`);
          return { value: rawValue, uncertain: true, sourceUrl: evidenceSeg.url, usedSnippet: evidenceQuote, trace: { stage: "sibling_guard_uncertain", detail: `target ${distToTarget}자 vs sibling ${distToSibling}자` } };
        }
        console.log(`\x1b[36m[SiblingGuard] 형제 토큰 존재하지만 값은 target에 더 가까움 (target ${distToTarget}자 vs sibling ${distToSibling}자) → 통과\x1b[0m`);
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
        return { value: "-", trace: { stage: "echo_guard", detail: `rawValue="${rawValue}" echoes criterion/synonym` } };
      }
    }

    // ── 6. 단위 정규화 → LLM 프롬프트로 통합
    // judgeCell 프롬프트에 UNIT NORMALIZATION 지시가 있으므로 별도 후처리 불필요.

    return { value: finalValue, sourceUrl: evidenceSeg.url, usedSnippet: evidenceQuote, trace: { stage: "tavily_hit" } };
  } catch {
    return { value: "-", trace: { stage: "llm_parse_error", detail: `raw="${text.slice(0, 120)}"` } };
  }
}

// ---------------------------------------------------------------------------
// ComparisonTable 데이터 해석 (comp_table.ts STEP 1~2에서 이동)
// 표 구조를 코드로 만들고(buildAndAssembleTable) DB 미커버/근거없는 셀을
// Tavily+judgeCell로 채운다(enrichCompTableCells). comp_table.ts는 이 결과
// (완성된 CompTableJson)를 받아 순위만 매긴다.
// ---------------------------------------------------------------------------

export type CompTableJson = {
  type?: string;
  props?: {
    columns?: Array<{ key: string; label: string; imageUrl?: string }>;
    rows?: Array<Record<string, string>>;
    _rankReasoning?: string;
  };
  [k: string]: unknown;
};

// STEP 0: DB 스펙 키 기반 셀 값 사전 결정 (LLM 호출 없음)
// 각 (기준 × 제품) 셀에 대해 다나와 스펙 키를 검색하고 값을 프로그래밍적으로 결정.
// - 스펙 키 매칭 시: 해당 값 복사 (○, 구체적 값, 또는 없음이면 "X")
// - 미매칭 시: "-" → 이후 enrichCompTableCells의 Tavily 판단이 보강

/** [중요], [보통], [낮음] 및 괄호 주석 제거 */
function cleanLabel(c: string): string {
  return c.replace(/\s*\[.*?\]/g, "").replace(/\s*\(.*?\)/g, "").trim();
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
      return toDisplayValue(rawValue, label);
    }
  }

  // 2순위: 키워드 하나라도 스펙 키에 포함.
  // 단, 라벨이 기대하는 단위군과 값의 실제 단위군이 다르면(예: "배터리 수명"(분) vs
  // "배터리: 6400mAh"(용량)) 서로 다른 물리량이므로 키워드가 겹쳐도 매칭에서 제외한다.
  for (const spec of specs) {
    const { key, rawValue } = parseSpecEntry(spec);
    const keyLower = key.toLowerCase().replace(/\s+/g, "");
    if (hasUnitDimensionMismatch(label, rawValue)) continue;
    if (keywords.some(kw => keyLower.includes(kw) || kw.includes(keyLower))) {
      return toDisplayValue(rawValue, label);
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

// 표 분석 헬퍼 — 미확인 셀 / 근거 없는 셀 탐지 (enrichCompTableCells 전용)

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

// 비교표 셀을 채운다. 값 판단(Tavily 검색 + judgeCell 검증)은 이 함수가 직접
// 하고, 어떤 셀이 비어있는지 찾아 그 판단 결과를 표에 반영하는 역할까지 맡는다.
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
      console.log(`\x1b[90m[CompTable] 제품명 매핑: "${col.label}" → "${matched}"${note}\x1b[0m`);
    }
    return map;
  })();

  // ── Pre-enrich 스니펫 캐시 ─────────────────────────────────────────────
  // enrichContextWithTavily가 uiContext에 주입한 WebSpecs를 파싱해
  // 동일 스펙을 Tavily에서 재검색하는 낭비를 방지한다.
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
      console.log(`\x1b[36m[CompTable] Pre-enrich 캐시: ${preEnrichCache.size}개 항목 로드\x1b[0m`);
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
  console.log("\x1b[33m[CompTable STEP 1.5] 행 유형 결정:\x1b[0m");
  for (const [crit, type] of rowTypeMap)
    console.log(`         "${crit}" → ${type}`);

  // STEP 2: 미확인 셀 + 근거 없는 셀 탐지
  console.log("\n\x1b[33m[CompTable STEP 2] 1차 표 분석:\x1b[0m");
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

  // "value" 유형 행에서 ○만 있는 셀도 구체값으로 교체 시도.
  // "boolean" 유형 행은 같은 행의 다른 칸이 이미 구체적 텍스트(예: "전방 센서, AI 인식")를
  // 갖고 있는데 어떤 칸만 "○"로 남아있으면, 같은 semantic dimension으로 맞추기 위해
  // 그 칸도 재검색을 시도한다 — 그래도 못 찾으면 "○" 그대로 둔다("○"는 boolean 기준에서
  // 그 자체로 유효한 답이라 강제로 다운그레이드하지 않는다).
  for (const row of allRows) {
    const criterion = row["criterion"] ?? "";
    if (!criterion || criterion === "순위" || criterion === "Rank") continue;
    const rowType = rowTypeMap.get(criterion);
    if (rowType === "value") {
      for (const col of productCols) {
        if (String((row as Record<string, string>)[col.key] ?? "") === "○")
          addToVerify({ rowCriterion: criterion, colKey: col.key, productLabel: col.label });
      }
      continue;
    }
    if (rowType === "boolean") {
      const values = productCols.map(col => String((row as Record<string, string>)[col.key] ?? ""));
      const hasDetailText = values.some(v => v && v !== "-" && v !== "○" && v !== "X");
      if (!hasDetailText) continue;
      for (const col of productCols) {
        if (String((row as Record<string, string>)[col.key] ?? "") === "○")
          addToVerify({ rowCriterion: criterion, colKey: col.key, productLabel: col.label });
      }
    }
  }

  if (allCellsToVerify.length === 0) {
    console.log("\x1b[32m[CompTable STEP 2] 모든 셀 확인됨 → 웹 검색 생략\x1b[0m\n");
    return;
  }

  if (missingCells.length > 0) {
    console.log(`\n\x1b[33m[CompTable STEP 2] 미확인 셀 ${missingCells.length}개:\x1b[0m`);
    missingCells.forEach(c => console.log(`         • ${c.productLabel} × "${c.rowCriterion}"`));
  }
  if (ungroundedCells.length > 0) {
    console.log(`\n\x1b[33m[CompTable STEP 2] 근거 불명 셀 ${ungroundedCells.length}개:\x1b[0m`);
    ungroundedCells.forEach(c => console.log(`         • ${c.productLabel} × "${c.rowCriterion}" ("${c.originalValue}" → 스펙 근거 없음)`));
  }
  console.log(`\n\x1b[33m[CompTable STEP 2] 총 ${allCellsToVerify.length}개 셀 웹 검색 대상\x1b[0m`);

  // STEP 3: 정적 유의어 사전으로 synonymMap 구성 (LLM 호출 없음)
  // spec-lookup.ts의 STATIC_SYNONYMS와 동일한 패턴을 인라인 적용
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
  console.log(`\x1b[33m[CompTable STEP 3-A] 정적 유의어 사전 적용 (LLM 없음):${uniqueCriteria.map(c => `\n         "${c}" → [${synonymMap[c].join(", ")}]`).join("")}\x1b[0m`);

  // 형식 힌트 + 정규 단위 — 표에 등장하는 모든 기준을 한 번에 배치 요청(캐싱됨).
  // "센서 크기" vs "화소 수"처럼 개발자가 미리 정규식을 하드코딩 못 한 새 기준도
  // judgeCell 프롬프트에 구분 힌트가 실리게 한다.
  const criterionMeta = await expandCriterionMeta(uniqueCriteria);

  // Tavily 검색 전 Pre-enrich 존재 여부 확인
  const rows = tableJson.props?.rows ?? [];
  const needsTavily = allCellsToVerify.filter(({ rowCriterion, colKey, productLabel }) => {
    // Pre-enrich 히트 (enrichContextWithTavily에서 이미 가져온 스니펫)
    const preSnippets = getPreEnrichedSnippets(productLabel, rowCriterion);
    if (preSnippets) {
      preEnrichedCells.push({ rowCriterion, colKey, productLabel, snippets: preSnippets });
      console.log(`\x1b[36m[Pre-enrich HIT] "${productLabel}" × "${rowCriterion}" → Tavily 생략\x1b[0m`);
      return false;
    }

    return true;
  });

  if (needsTavily.length === 0) {
    console.log("\x1b[32m[CompTable STEP 3-B] 모든 셀 Pre-enrich로 확인 → Tavily 생략\x1b[0m");
  } else {
    console.log(`\n\x1b[33m[CompTable STEP 3-B] Tavily 병렬 검색 (${needsTavily.length}개)...\x1b[0m`);
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
        const { results } = await tavilySearch(`${fullName} ${terms}`, "advanced");
        searchResultMap.set(key, results);
        // ── Tavily 원본 결과 상세 로그 ──────────────────────────────────
        console.log(`         🔍 "${fullName} × ${cleanedCriterion}" → ${results.length}개 결과`);
        results.forEach((r, idx) => {
          console.log(`            [${idx + 1}] score=${r.score?.toFixed(2) ?? '?'} | ${r.url}`);
          console.log(`                 ${r.content.replace(/\s+/g, ' ').slice(0, 150)}...`);
        });
      })
    );
    console.log(`\x1b[33m[CompTable STEP 3-B] 완료 (${Date.now() - s3b}ms)\x1b[0m`);

    // STEP 3.5: Pre-enrich 캐시 셀 직접 판단 (Tavily 재검색 없음)
    if (preEnrichedCells.length > 0) {
      console.log(`\n\x1b[36m[CompTable STEP 3.5] Pre-enrich 셀 ${preEnrichedCells.length}개 직접 판단 (Tavily 생략)...\x1b[0m`);
      await Promise.all(
        preEnrichedCells.map(async ({ rowCriterion, colKey, productLabel, snippets }) => {
          const { value, uncertain } = await judgeCell(
            productLabel, rowCriterion, snippets, locale,
            rowTypeMap.get(rowCriterion) ?? detectCriterionType(rowCriterion),
            synonymMap[rowCriterion] ?? [], [],
            criterionMeta[rowCriterion]?.formatHint, criterionMeta[rowCriterion]?.canonicalUnit
          );
          const targetRow = rows.find(r => r["criterion"] === rowCriterion);
          if (targetRow && value !== "-") {
            const displayValue = uncertain ? `${value} (추정)` : value;
            (targetRow as Record<string, string>)[colKey] = displayValue;
            console.log(`   \x1b[36m${uncertain ? "⚠️ " : "✅"} Pre-enrich "${productLabel}" × "${rowCriterion}" → "${displayValue}"\x1b[0m`);
          }
        })
      );
    }

    // STEP 4: 셀 값 판단 + 업데이트
    console.log(`\n\x1b[33m[CompTable STEP 4] judgeCell로 셀 값 판단...\x1b[0m`);
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
        const { value, sourceUrl, usedSnippet, uncertain, trace } = await judgeCell(
          productLabel, rowCriterion, snippets, locale,
          rowTypeMap.get(rowCriterion) ?? detectCriterionType(rowCriterion),
          synonymMap[rowCriterion] ?? [], [],
          criterionMeta[rowCriterion]?.formatHint, criterionMeta[rowCriterion]?.canonicalUnit
        );
        const displayValue = (uncertain && value !== "-") ? `${value} (추정)` : value;
        const targetRow = rows.find(r => r["criterion"] === rowCriterion);
        if (targetRow) targetRow[colKey] = displayValue;
        const symbol = value === "○" ? "\x1b[32m○\x1b[0m" : value === "X" ? "\x1b[31mX\x1b[0m" : uncertain ? "\x1b[33m?\x1b[0m" : "\x1b[90m-\x1b[0m";
        console.log(`         ${symbol} ${productLabel} × "${rowCriterion}" → "${displayValue}"${sourceUrl ? ` ← ${sourceUrl.slice(0, 60)}` : " (증거 없음)"}`);
        if (value === "-") console.log(`         \x1b[90m🕳️  [LookupTrace] stage=${trace.stage}${trace.detail ? ` | ${trace.detail}` : ""}\x1b[0m`);
        if (usedSnippet) console.log(`            \x1b[90m📄 "${usedSnippet}"\x1b[0m`);
      })
    );
    console.log(`\x1b[33m[CompTable STEP 4] 완료 (${Date.now() - s4}ms)\x1b[0m`);
  }
}

/** 제품명을 열 헤더 표시용으로 정리한다 (접미사 제거만, 잘라내지 않음).
 *  검색(Tavily)에는 사용하지 않음 — 검색은 항상 uiContext의 전체 이름을 사용. */
function shortenProductName(name: string): string {
  const SUFFIX_STRIP = /\s*(직배수|직충전|업그레이드|에디션|한정판|특별판|리미티드|스페셜)\s*$/g;
  return name.replace(SUFFIX_STRIP, "").trim();
}

/**
 * uiContext를 파싱해서 CompTable JSON을 코드로 생성하고
 * DB에서 확인 가능한 셀 값을 즉시 주입한다.
 *
 * @returns { tableJson, fullNameMap }
 *   tableJson  — 완성된 구조 + DB 채워진 셀 (미확인 셀은 "-")
 *   fullNameMap — short label → full name 매핑 (enrichCompTableCells에서 재사용)
 */
export function buildAndAssembleTable(
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

  // 행 id — 컬럼의 "prod_N" key와 같은 목적: 편집(remove_criteria 등)이 라벨 문자열
  // 대신 이 id로 행을 정확히 지목할 수 있게 한다. 라벨은 사람이 읽는 표시용, id는 참조용.
  const rows: Array<Record<string, string>> = [
    // 순위 행 (항상 "-", WSM 계산 후 STEP 3에서 채워짐)
    { id: "rank", criterion: locale === "ko" ? "순위" : "Rank", ...emptyRow },
    // criteria 행
    ...decisionCriteria.map((criterion, i) => {
      const label = cleanLabel(criterion);   // 브라켓/괄호 제거
      const cells = Object.fromEntries(
        products.map(p => [p.key, lookupCellValue(label, p.specs)])
      );
      return { id: `crit_${i}`, criterion: label, ...cells };
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





