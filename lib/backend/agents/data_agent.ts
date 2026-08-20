import { tool, generateText, generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { currentOptionListCards, currentParticipantId } from "../tools/sidebar-store";
import { getCachedSpec, setCachedSpec } from "../services/spec-cache";

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
  | "db_hit"              // 성공 — 로컬 DB에서 찾음
  | "tavily_empty"        // Tavily 검색 결과 0건
  | "llm_parse_error"     // LLM 응답 파싱 실패
  | "light_extract_hit"   // 성공 — 경량 파이프라인(Tavily answer + 단일 LLM 질문) 추출
  | "light_extract_empty" // 경량 파이프라인이 명확한 값을 찾지 못함
  | "not_applicable";     // 성공 — 이 제품 카테고리엔 원래 없는 속성으로 분류됨

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
  /**
   * Tavily가 검색 결과를 AI로 합성한 answer를 함께 반환 — extractCellValueLight가 이 answer
   * 하나만 보고 값을 추출하므로 반드시 "advanced"를 써야 한다. "advanced"는 더 많은 소스를
   * 훑어 더 길고 상세한 answer를 만들어서, 소음 수준처럼 덜 두드러진 필드도 answer에 실릴
   * 확률이 올라간다 — true(=basic)는 answer가 짧아 요청한 필드가 아예 빠지기 쉽다.
   */
  includeAnswer?: boolean | "advanced";
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
  if (options.includeAnswer) body.include_answer = options.includeAnswer;

  // 호출부(enrichContextWithTavily/enrichCompTableCells)는 제품×기준 조합마다 이 함수를
  // Promise.all로 동시에 여러 개 호출한다 — 여기서 예외가 던져지면 Promise.all이 fail-fast로
  // 전체를 reject해서, 이미 성공한 나머지 조회 결과까지 통째로 버려지고(ComparisonTable
  // 경로는 route.ts에 이 호출을 감싸는 try/catch도 없어 스트림 자체가 죽는다) 요청 하나가
  // 타임아웃/네트워크 순간 장애 하나로 재시도 없이 전부 실패한다. 그래서 !res.ok와 동일하게
  // "결과 없음"으로 fail-open 처리한다 — 상위 파이프라인은 이미 빈 results를 "값 없음"으로
  // 정상 처리하도록 되어 있다(extractCellValueLight의 tavily_empty 분기 등).
  try {
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
  } catch (err: any) {
    const reason = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : (err?.message ?? String(err));
    console.warn(`[Tavily] 요청 실패(${reason}), 빈 결과로 폴백: "${query.slice(0, 60)}"`);
    return { results: [] };
  }
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

  // "6400mAh"처럼 값이 숫자로 시작하는 경우
  const leading = rawValue.match(/^([\d,]+(?:\.\d+)?)\s*([^\d\s].*)?$/);
  // "NP-FZ100(2280mAh)"처럼 모델명 뒤 괄호 안에 수치+단위가 붙는 경우
  const parenthesized = rawValue.match(/\(([\d,]+(?:\.\d+)?)\s*([^\d\s)]+)\)/);
  const unitPart = (leading?.[2] ?? parenthesized?.[2] ?? "").trim();
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

  const rule = UNIT_RULES.find(r => r.pattern.test(fieldKey));
  if (rule) {
    let working = value;
    let mutated = false;

    // "3시간10분"처럼 큰 단위+작은 단위가 붙어 하나의 값을 이루는 복합 표기는, 조각을
    // 각각 따로 변환하면 "180분10분"처럼 그냥 이어붙여져 버린다 — 반드시 합산한 총량
    // 하나로 먼저 치환해야 한다. (UNIT_RULES 중 이 패턴이 나오는 건 시간류(분) 규칙뿐.)
    if (rule.canonical === "분") {
      working = working.replace(/([\d,]+)\s*시간\s*([\d,]+)?\s*분/g, (whole, hourStr: string, minStr?: string) => {
        const hours = parseFloat(hourStr.replace(/,/g, ""));
        if (isNaN(hours)) return whole;
        const mins = minStr ? parseFloat(minStr.replace(/,/g, "")) : 0;
        const total = hours * 60 + (isNaN(mins) ? 0 : mins);
        mutated = true;
        return `${total.toLocaleString("en-US")}분`;
      });
    }

    // 값 전체가 "숫자+단위" 하나만은 아닐 수 있다 — "본체 7.95cm / 도크 30cm"처럼
    // 라벨이 붙은 복합 값도 흔하므로, 문자열 전체를 매칭하려 하지 않고 "숫자+단위"
    // 조각을 전역으로 찾아 각각 변환한다.
    const result = working.replace(/([\d,]+(?:\.\d+)?)\s*([a-zA-Z가-힣]+)/g, (whole, numStr: string, unitToken: string) => {
      const found = rule.units.find(([unitPattern]) => unitPattern.test(unitToken));
      if (!found) return whole; // 이 조각의 단위가 이 규칙 소관이 아니면 그대로 둔다 (예: "장", "회")
      const [, factor] = found;
      const num = parseFloat(numStr.replace(/,/g, ""));
      if (isNaN(num)) return whole;
      const val = num * factor;
      const formatted = Number.isInteger(val)
        ? val.toLocaleString("en-US")
        : String(Math.round(val * 100) / 100);
      mutated = true;
      return `${formatted}${rule.canonical}`;
    });
    return mutated ? result : value;
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
  const normalized = fieldKey ? normalizeUnitValue(rawValue, fieldKey) : rawValue;
  // 15자 초과 시 앞부분 자르기
  return normalized.length > 15 ? normalized.slice(0, 15) : normalized;
}

// ---------------------------------------------------------------------------
// "화면에 이미 떠 있는 값" 매칭 — Option List 카드 / Comparison Table 셀처럼 이번
// 요청과 함께 실려온, 이미 확정된 스펙 목록에서 fieldKey에 해당하는 값을 찾는다.
// spec-lookup.ts(findProductSpecInDB, lookupKnownSpecValue)가 이 함수들에 의존해서
// spec-lookup.ts에 있었는데, spec-lookup.ts는 이미 data_agent.ts를 import하고 있어
// (순환 참조 방지) 반대 방향(data_agent.ts → spec-lookup.ts)은 만들 수 없다 — Option
// List/Comparison Table 양쪽 생성 경로 모두(enrichCompTableCells 포함) 이 매칭 로직이
// 필요해져서, 의존성이 실제로 향하는 이 파일로 옮기고 spec-lookup.ts는 여기서 re-export한다.
// ---------------------------------------------------------------------------

const FIELD_SYNONYMS: [RegExp, string[]][] = [
  [/무게|weight/i,                    ["무게", "중량"]],
  // 배터리 "수명/사용시간"(지속시간)과 배터리 "용량"(mAh)은 서로 다른 물리량이다.
  // 이 패턴을 아래 배터리 패턴보다 먼저 검사해야 "배터리 수명" 같은 필드키가
  // "배터리"/"배터리용량"(mAh) 스펙에 먼저 매칭돼 잘못된 단위로 반환되지 않는다.
  [/수명|사용\s*시간|런타임|run.*time/i, ["사용시간", "배터리 수명", "런타임"]],
  [/배터리|battery/i,                 ["배터리용량", "배터리"]],
  [/충전\s*시간|charge/i,            ["충전시간", "충전"]],
  [/소음|noise/i,                     ["소음", "소음수준"]],
  [/흡입\s*력|suction/i,             ["흡입력", "흡입"]],
  [/담한\s*면적|area/i,              ["담한면적", "사용고도지 면적"]],
  [/먼지통|집진통|dust.*bin|bin/i,  ["먼지통", "집진통", "먼지통용량"]],
  [/물통|water.*tank|tank/i,         ["물통", "물탱크", "물탱크용량"]],
  [/먼지\s*비움|empty/i,             ["먼지비움", "자동먼지비움", "비움"]],
  [/걸레\s*세척|wash/i,              ["걸레세척", "자동걸레세척", "세척"]],
  [/걸레\s*건조|dry/i,               ["걸레건조", "온풍건조", "건조"]],
];

export function expandFieldKeySynonyms(fieldKey: string): string[] {
  for (const [pattern, synonyms] of FIELD_SYNONYMS) {
    if (pattern.test(fieldKey)) return synonyms;
  }
  return [fieldKey];
}

// 소음/흡입력/배터리처럼 "모드"에 따라 값이 갈리는 기준은, 화면에 이미 떠 있는 스펙이 그
// 제품의 표준/일반 모드 값일 뿐인데 fieldKey는 "조용한 모드"처럼 특정 모드를 콕 집어 묻는
// 경우가 있다 — 이때 화면 값을 그대로 재사용하면 다른 조건의 값을 정답으로 오인시킨다.
// fieldKey에 이런 모드 수식어가 있는데 매칭된 스펙 원문에 그 수식어가 전혀 없으면 이 후보를
// 건너뛰어(재검색으로 넘겨) 잘못된 재사용을 막는다.
const MODE_QUALIFIER_WORDS = [
  "조용한", "저소음", "무소음", "quiet", "silent",
  "터보", "turbo", "부스트", "boost", "강력", "파워", "맥스", "max", "최대",
  "절전", "에코", "eco", "저전력",
  "일반", "표준", "normal", "standard",
];

function hasUnmatchedModeQualifier(fieldKey: string, candidateSpec: string): boolean {
  const fieldLower = fieldKey.toLowerCase();
  const specLower = candidateSpec.toLowerCase();
  const fieldQualifiers = MODE_QUALIFIER_WORDS.filter(w => fieldLower.includes(w));
  if (fieldQualifiers.length === 0) return false;
  return !fieldQualifiers.some(w => specLower.includes(w));
}

/**
 * "무게 150g의 초경량 콤팩트"처럼 콜론 없는 자유 문장 안에, fieldKey가 속한 단위군의
 * 숫자+단위가 정확히 하나만 등장하면 그것을 뽑아 반환한다(예: "150g"). UNIT_RULES에
 * 정의된, 그 기준이 실제로 쓰는 단위(무게라면 kg/g)만 찾으므로 "5년 무상 A/S" 같은
 * 무관한 숫자를 잘못 집어올 위험이 없다. 여러 개(또는 0개) 나오면 어느 게 맞는 값인지
 * 확신할 수 없으므로 null을 반환해 호출부가 재검색하게 한다 — 억지로 하나를 고르지 않는다.
 */
function extractValueFromFreeText(fieldKey: string, text: string): string | null {
  const rule = UNIT_RULES.find(r => r.pattern.test(fieldKey));
  if (!rule) return null;

  const matches = new Set<string>();
  for (const [unitPattern] of rule.units) {
    const unitSrc = unitPattern.source.replace(/^\^/, "").replace(/\$$/, "");
    // 단위 뒤에 한글 조사가 바로 붙는 게 정상 표기다(예: "150g의", "1.2kg으로") — 그 경우까지
    // 걸러내면 정상 매칭이 전부 실패한다. 알파벳만 걸러 "5generation" 같은 오매칭을 막는다.
    const re = new RegExp(`([\\d,]+(?:\\.\\d+)?)\\s?(${unitSrc})(?![a-zA-Z])`, unitPattern.flags.includes("i") ? "gi" : "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) matches.add(`${m[1]}${m[2]}`);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

/**
 * 스펙 문자열 목록("흡입력: 30,000Pa" 등)에서 fieldKey에 해당하는 값을 찾는다.
 * findProductSpecInDB(로컬 DB)와 lookupKnownSpecValue(화면에 이미 떠 있는 카드/테이블 값)가
 * 공유하는 핵심 매칭 로직 — 동의어 확장 후 단위 불일치를 걸러내며 값을 뽑는다.
 */
export function findSpecValueInList(
  specs: string[],
  fieldKey: string,
  criterionType?: "value" | "boolean"
): string | null {
  const synonyms = expandFieldKeySynonyms(fieldKey);
  // 명시적으로 안 넘어오면 detectCriterionType의 키워드 휴리스틱으로 폴백 — "무게"/"가격"/
  // "크기" 등은 여기서 "value"로 분류된다(data_agent.ts VALUE_KEYWORDS 참고).
  const type = criterionType ?? detectCriterionType(fieldKey);
  for (const key of synonyms) {
    const keyNormalized = key.toLowerCase().replace(/\s+/g, "");
    const candidates = specs.filter(s => s.toLowerCase().replace(/\s+/g, "").includes(keyNormalized));
    for (const matchedSpec of candidates) {
      if (hasUnmatchedModeQualifier(fieldKey, matchedSpec)) continue;
      const { rawValue } = parseSpecEntry(matchedSpec);
      // 콜론 없는 스펙 문구엔 두 가지 경우가 섞여 있다: (a) "USB충전 지원"처럼 진짜 태그형
      // boolean 스펙 — key 매칭 자체가 "있음"의 근거라 "○"로 확정해도 안전하다. (b) "무게
      // 150g의 초경량 콤팩트"처럼 값(150g)이 문장 속에 자연어로 녹아있는 value형 기준 —
      // 이걸 "○"로 확정하면 Comparison Table의 무게 칸에 숫자 대신 체크마크가 붙는 오류가
      // 된다. criterionType이 "value"면 먼저 그 기준의 단위(무게라면 kg/g)로 문장 속에서
      // 숫자를 직접 뽑아본다 — 이미 있는 정보를 재검색 없이 바로 쓰기 위함. 그 단위의
      // 숫자가 정확히 하나만 나오면(모호하지 않으면) 그 값을 쓰고, 못 찾거나 여러 개
      // 겹치면 억지로 고르지 않고 건너뛰어(=아직 못 찾음) 호출부가 재검색하게 한다.
      if (!rawValue) {
        if (type === "value") {
          const extracted = extractValueFromFreeText(fieldKey, matchedSpec);
          if (extracted) return toDisplayValue(extracted, fieldKey);
          continue;
        }
        return "○";
      }
      if (hasUnitDimensionMismatch(fieldKey, rawValue)) continue;
      return toDisplayValue(rawValue, fieldKey);
    }
  }
  return null;
}

export interface KnownProductSpecs {
  name: string;
  specs: string[];
}

function normalizeProductName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "");
}

/**
 * 후보 목록에서 queryName과 "같은 제품"인 항목을 찾는다. 정규화 후 완전 일치를 최우선으로
 * 하고, 완전 일치가 없을 때만 느슨한 포함 관계(접두어 등)를 보되 그 조건을 만족하는 후보가
 * 정확히 하나일 때만 채택한다.
 *
 * 원래는 "한쪽 이름이 다른 쪽 이름을 포함하면 같은 제품"이라는 단순 includes() 매칭이었는데,
 * "로보락 S10 MaxV Slim"과 "로보락 S10 MaxV Slim 직배수"처럼 실제로는 다른 두 SKU인데 한쪽
 * 이름이 다른 쪽 이름의 접두어인 경우까지 같은 제품으로 오판했다 — 그 결과 Comparison Table이
 * "직배수" 카드의 필터 종류 값을 가져와 "Slim"(비직배수) 컬럼에 붙이는 등, 실제로 다른 두
 * 제품의 스펙이 섞이는 문제로 이어졌다. 후보가 여럿이면(=어느 쪽인지 확신할 수 없으면)
 * 틀린 값을 자신 있게 반환하는 대신 null(모름)을 반환해 상위 호출부가 새로 검색하게 한다.
 */
export function findExactMatchingProduct<T extends { name: string }>(
  queryName: string,
  candidates: T[]
): T | null {
  const qNorm = normalizeProductName(queryName);

  const exact = candidates.filter(c => normalizeProductName(c.name) === qNorm);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null; // 동명이인 — 어느 것인지 확신 불가

  const loose = candidates.filter(c => {
    const cNorm = normalizeProductName(c.name);
    return cNorm.includes(qNorm) || qNorm.includes(cNorm);
  });
  return loose.length === 1 ? loose[0] : null;
}

/** productName/fieldKey가 knownProducts(화면에 이미 떠 있는 카드/테이블 값) 안에 있으면 그 값을 반환. */
export function lookupKnownSpecValue(
  productName: string,
  fieldKey: string,
  knownProducts?: KnownProductSpecs[],
  criterionType?: "value" | "boolean"
): string | null {
  if (!knownProducts || knownProducts.length === 0) return null;
  const matched = findExactMatchingProduct(productName, knownProducts);
  if (!matched) return null;
  return findSpecValueInList(matched.specs, fieldKey, criterionType);
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
    model: anthropic("claude-haiku-4-5"),
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
  /**
   * 이 기준이 제품/제조사마다 서로 다른 측정 조건(모드)으로 보고되는 경우, 제품 간
   * 비교가 가능하도록 우선적으로 찾아야 할 "기준 조건" 한 문구 (예: 배터리 수명 →
   * "1회 완충 시 표준/일반 모드 기준 사용 시간"). 검색 쿼리에 덧붙여 그 조건을 다루는
   * 페이지를 우선 찾게 하고, 추출 프롬프트에도 "여러 조건이 있으면 이 조건을 우선"
   * 하도록 넘긴다. 조건에 따라 갈리지 않는 기준(예: 무게, 가격)은 null.
   */
  preferredCondition: string | null;
  /**
   * "boolean": 예/아니오로 답할 수 있는 단일 특징 유무 질문(예: "자동 충전 기능", "DSLR 여부") —
   * 답은 ○/X 두 값뿐이고, 원문에 딸려온 세부 스펙(수치 등)은 각자의 행에 속하므로 버린다.
   * "value": "무엇인지/어떤 것들이 있는지"를 묻는 질문(예: "필터 종류", "스마트 기능") — 원문에
   * 나열된 구체적인 항목을 그대로 답으로 남긴다(항목이 없으면 "○"로 축약).
   * detectCriterionType()의 키워드 휴리스틱은 이 필드가 없을 때(예: 배치 호출 전 폴백)만 쓰는
   * 근사치다 — 새로 생기는 기준까지 정확히 분류하려면 이 값을 우선한다.
   */
  type: "value" | "boolean";
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
        model: anthropic("claude-haiku-4-5"),
        system: `You are a product spec analyst. For each Korean product criterion, provide:
1. "formatHint": ONE short Korean sentence describing (a) what unit or format the correct value should take, and (b) what commonly-confused OTHER spec it must NOT be mistaken for. Be specific and concrete — this will be injected into an extraction prompt to prevent a model from picking the wrong kind of value.
2. "canonicalUnit": the standard unit abbreviation this criterion's numeric values should be normalized to (e.g. "mm", "kg", "dB", "Pa", "mAh", "L", "분"). If the criterion has no meaningful single unit (e.g. it's a boolean/feature-presence criterion, or a list of named items, or a format/resolution criterion with multiple valid notations like "4K"/"6000x4000"), set this to null.
3. "preferredCondition": if this criterion's value commonly depends on an operating mode/power setting that products report differently (quiet/eco/normal/turbo/max, etc.) — e.g. noise level, suction power, power consumption, battery life (standard-mode minutes vs. max-power minutes vs. charge-cycle count), continuous shooting count (viewfinder vs. LCD) — name the ONE standard/baseline condition to search for and prioritize so values line up across products, as a short Korean phrase usable inside a search query (e.g. "일반 모드 기준", "1회 완충 시 표준 모드 기준 사용 시간"). Prefer "일반/표준 모드" and exclude the quietest/most-flattering marketing mode. If this criterion is normally reported only one way (e.g. weight, price, dimensions), set this to null — do not invent a condition that doesn't typically vary.
4. "type": "boolean" if this criterion is a single yes/no feature-presence check whose name already fully identifies ONE specific thing (e.g. "자동 충전 기능", "DSLR 여부", "손떨림 보정") — any extra detail found alongside it belongs in other rows, so a plain ○/X is the correct answer. "value" if the criterion is asking WHAT something is or WHICH ones it has — this covers any criterion naming a category rather than one specific fact: endings like "종류"/"방식"/"유형"/"타입" (asks what kind), umbrella/collective nouns like "기능"/"서비스"/"모드" without a specific action named (e.g. "스마트 기능", "부가 서비스", "청소 모드" — these ask "which ones", not "does it have one"), plus anything with a unit/number/name/category answer (weight, price, brand, filter type, etc.). When genuinely unsure whether a request wants yes/no or a specific answer, prefer "value" — it degrades gracefully to "○" when the source text truly has no further detail, whereas "boolean" would have destroyed real detail if it existed.

Output ONLY valid JSON in this exact shape:
{ "<criterion>": { "formatHint": "...", "canonicalUnit": "mm" | null, "preferredCondition": "..." | null, "type": "value" | "boolean" }, ... }`,
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
    // "종류"/"방식"/"유형"/"타입"으로 끝나는 기준은 "무엇인지"를 묻는 것이라 예/아니오로
    // 답할 수 없다 — 예: "필터 종류" → "HEPA 필터, 워터필터" (boolean으로 잘못 분류되면
    // 이 detail이 통째로 버려지고 "○"(=원문 그대로 "지원")만 남는다).
    "종류", "방식", "유형", "타입",
  ];
  const lower = criterion.toLowerCase();
  if (VALUE_KEYWORDS.some(k => lower.includes(k))) return "value";

  // "OO 기능"에서 OO가 "자동 충전"/"AI 사물 인식"처럼 특정 동작 하나를 가리키면 예/아니오가
  // 맞지만(그 자체로 이미 하나의 완결된 기능명), "스마트"/"편의"처럼 포괄적인 수식어가 붙으면
  // "구체적으로 어떤 기능들이 있는지"를 묻는 것이다 — 이 경우도 boolean으로 분류되면 원문에
  // 나열된 구체적 기능명이 전부 버려지고 "○"(=지원)만 남는다.
  const UMBRELLA_FEATURE_PREFIXES = ["스마트", "편의", "특수", "부가", "추가", "다양한"];
  if (/기능$/.test(criterion.trim()) && UMBRELLA_FEATURE_PREFIXES.some(p => criterion.includes(p))) {
    return "value";
  }

  return "boolean";
}

/**
 * judgeCell(세그먼트 분할 → 임베딩 재랭킹 → 인용 구절 기반 추출 → SiblingGuard/EchoGuard/
 * Sanity Check)을 대체하는 경량 버전. Tavily 스니펫(및 answer, 호출자가 이미 합쳐서 넘김)을
 * 그대로 LLM에 보여주고 "이 기준 값이 뭐야?"를 한 번만 물어본다 — 다단계 검증은 없다.
 *
 * 형제 제품 구분(siblingExcludeTokens)과 단위/형식 힌트(formatHint/canonicalUnit)는
 * 호출자가 이미 계산해둔 값이라 프롬프트에 얹는 비용이 거의 없어 그대로 살렸지만,
 * judgeCell의 인용 번호 검증·거리 기반 SiblingGuard 같은 별도 검증 단계는 없다 — 즉
 * "형제 제품과 헷갈리지 마라"는 지시만 있고, 실제로 안 헷갈렸는지 코드로 재확인하지는 않는다.
 */
/**
 * "정보를 못 찾음"(검색/재시도하면 나올 수도 있음)과 "이 제품군엔 원래 이 속성이 없음"
 * (예: 카메라 바디에 초점거리)을 구분하기 위한 분류 단계. extractCellValueLight는 주어진
 * 텍스트만 보고 판단하는 반면(출처 없는 지식 사용 금지), 이 함수는 반대로 일반 지식을
 * 써서 "이 속성이 이 제품 카테고리에 개념적으로 존재하는가"만 판단한다 — 구체적인 값을
 * 아는지는 무관하다. 애매하면 false(적용됨/그냥 못 찾은 것)로 판단해 재시도 기회를
 * 죽이지 않는 쪽으로 보수적으로 설계했다.
 */
async function classifyFieldApplicability(
  productName: string,
  criterion: string,
  locale: string
): Promise<boolean> {
  try {
    const { object } = await generateObject({
      model: anthropic("claude-haiku-4-5"),
      schema: z.object({
        notApplicable: z.boolean().describe(
          `True ONLY if "${criterion}" is a property that products of this general type structurally never ` +
          `have at all (e.g. focal length for a camera body, since focal length belongs to the lens, not the ` +
          `body) — a category mismatch, not just "I don't know the number." False if the product type could ` +
          `plausibly have this spec but the value simply wasn't found this time.`
        ),
      }),
      system: `You classify whether a spec field is structurally inapplicable to a product's category, using ` +
        `general product knowledge (not tied to any specific search result). Be conservative: when uncertain, ` +
        `answer false — a wrong "true" permanently hides a field that might actually have a value.`,
      prompt: `Product: "${productName}"\nSpec field: "${criterion}"\n\nDoes this general type of product ever have a meaningful value for this spec field?`,
      temperature: 0,
    });
    return object.notApplicable === true;
  } catch {
    return false;
  }
}

export const NOT_APPLICABLE_TEXT: Record<string, string> = { ko: "스펙 없음", en: "Not applicable" };

export async function extractCellValueLight(
  productName: string,
  criterion: string,
  snippets: TavilyResult[],
  locale: string,
  siblingExcludeTokens: string[] = [],
  formatHint?: string,
  canonicalUnit?: string | null,
  preferredCondition?: string | null,
  criterionType?: "boolean" | "value"
): Promise<{ value: string; sourceUrl?: string; usedSnippet?: string; uncertain?: boolean; trace: LookupTrace }> {
  if (snippets.length === 0) {
    if (await classifyFieldApplicability(productName, criterion, locale)) {
      return { value: NOT_APPLICABLE_TEXT[locale] ?? NOT_APPLICABLE_TEXT.en, trace: { stage: "not_applicable", detail: "field structurally absent for this product category" } };
    }
    return { value: "-", trace: { stage: "tavily_empty", detail: "snippets array empty at extractCellValueLight entry" } };
  }

  const answerSource = snippets[0];
  const answerText = answerSource.content.slice(0, 2000);

  const siblingNote = siblingExcludeTokens.length > 0
    ? `\nCAUTION: do not confuse this with sibling/variant models such as: ${siblingExcludeTokens.join(", ")}. Only use the text if it is clearly about "${productName}" itself.`
    : "";
  const hintNote = formatHint ? `\nFormat guidance for this field: ${formatHint}` : "";
  const unitNote = canonicalUnit ? `\nIf the value is a numeric measurement, express it in ${canonicalUnit}.` : "";
  // 제품마다 다른 측정 조건으로 보고되는 기준(배터리 수명 등)을 여러 제품 간에 최대한
  // 같은 조건으로 비교할 수 있게 하기 위함 — 텍스트에 여러 조건이 섞여 있으면 이 조건을
  // 최우선/대표 값으로 앞세우되, 없는 조건을 지어내진 않는다(원문에 있는 다른 조건 값은
  // 그대로 라벨을 붙여 부가로 남긴다).
  const conditionNote = preferredCondition
    ? `\nThis field is commonly reported under different conditions across products — for comparability, if the ` +
      `text offers a value for this specific condition, lead with it as the primary value: "${preferredCondition}". ` +
      `If the text offers other conditions too, you may still label and include them after the primary one. If the ` +
      `text does NOT offer this specific condition at all, do not invent it — use whatever condition the text does ` +
      `report, clearly labeled as usual.`
    : "";
  // "DSLR"처럼 "이 제품이 이 카테고리/기능에 해당하는가"만 묻는 boolean 필드는, 일반 프롬프트를
  // 그대로 쓰면 텍스트에 딸려온 세부 스펙(화소수, ISO 범위 등)까지 그대로 베껴온다 — 그 세부
  // 스펙은 각자의 행에 따로 들어가야 할 내용이라 이 필드에서는 노이즈다. boolean 행임을 알 때만
  // ○/X 두 값으로만 답하도록 별도로 강하게 지시한다.
  const booleanNote = criterionType === "boolean"
    ? `\nIMPORTANT: "${criterion}" is a YES/NO field asking only whether "${productName}" IS/HAS this category or ` +
      `feature — it is NOT a place for detailed specs. Respond with ONLY "○" (yes) or "X" (no), even if the text ` +
      `lists specific numbers/specs alongside the yes/no fact (e.g. resolution, ISO range, fps) — leave those out, ` +
      `they belong in their own separate rows. Use "-" only if the text never addresses whether this is true or false.`
    : "";

  try {
    const { object } = await generateObject({
      model: anthropic("claude-haiku-4-5"),
      schema: z.object({
        value: z.string().describe(
          `The "${criterion}" value for "${productName}" as explicitly stated in the answer text. Strip filler ` +
          `words and don't restate the question or write a full sentence — but if the text names specific ` +
          `items (modes, numbers, standards, options, etc.), list them verbatim/concisely (comma-separated if ` +
          `there are several) — do NOT summarize a concrete list into a vague word like "여러" or "지원". ` +
          `Cap it at the 4-5 most notable/distinguishing items — if the text names many more than that (e.g. ` +
          `a long marketing bullet list of "smart features"), do NOT dump the entire list; pick just the ` +
          `handful that best differentiate this product, not generic filler. If the values come from DIFFERENT ` +
          `conditions/modes (e.g. viewfinder vs LCD screen, photo count vs video recording time, normal vs ` +
          `power-saving mode), prefix EACH value with a short label naming that condition (e.g. "EVF 550장 / ` +
          `LCD 570장 / 동영상 95분") instead of a bare comma-separated list of numbers — a reader must be able ` +
          `to tell which number belongs to which condition. Only return "○" when the text confirms the ` +
          `feature is present WITHOUT naming any specific modes/numbers/options at all. If the text explicitly ` +
          `states it is NOT present or NOT supported, return "X" (a clear negative answer is still a value). ` +
          `Use "-" ONLY if the answer text does not address this field at all for this exact product.`
        ),
      }),
      system: `You are given a short answer text about "${productName}". Answer using ONLY what's stated in that text — do not use outside knowledge or guess. ` +
        `Cut filler words and never restate the question or answer in a full sentence — but if the text names specific items (modes, numbers, standards, options, etc.) for "${criterion}", list them, comma-separated (e.g. "진공 전용, 물걸레 전용, 진공+물걸레 동시"). ` +
        `Cap it at 4-5 items max — if the text names a long marketing-style list (e.g. a dozen+ "smart features"), don't dump all of them; pick only the handful that best differentiate this product from competitors. ` +
        `If the values come from different conditions/modes (e.g. viewfinder vs LCD, photo count vs video time, normal vs power-saving mode), prefix each value with a short condition label instead of listing bare numbers (e.g. "EVF 550장 / LCD 570장 / 동영상 95분") — the reader must be able to tell which number belongs to which condition. ` +
        `Never collapse a concrete list into a vague summary word like "여러" or "지원" — only use "○" when the text confirms "${criterion}" is present but names no specific modes/numbers/options at all. ` +
        `If the text explicitly says this product does NOT have/support "${criterion}", that is a real answer — respond with "X", not "-". ` +
        `Only respond with "-" when the text simply never mentions "${criterion}" for this product at all. ` +
        `Write the value in ${locale === "en" ? "English" : "Korean"}.${siblingNote}${hintNote}${unitNote}${conditionNote}${booleanNote}`,
      prompt: `Answer text:\n${answerText}\n\nFollow-up question: What is the "${criterion}" for "${productName}" mentioned in this text?`,
      temperature: 0,
    });

    if (!object.value || object.value === "-") {
      if (await classifyFieldApplicability(productName, criterion, locale)) {
        return { value: NOT_APPLICABLE_TEXT[locale] ?? NOT_APPLICABLE_TEXT.en, trace: { stage: "not_applicable", detail: "field structurally absent for this product category" } };
      }
      return { value: "-", trace: { stage: "light_extract_empty", detail: "no clear value in answer text" } };
    }

    // 프롬프트가 "4-5개까지만"이라고 지시해도 "렌즈 종류"처럼 원문에 항목이 수십 개
    // 나열된 필드에서는 LLM이 종종 다 베껴온다 — 셀이 안 잘리게 코드로 한 번 더 강제한다.
    let finalValue = object.value.trim();
    const parts = finalValue.split(/,\s*/);
    if (parts.length > 5) {
      finalValue = parts.slice(0, 5).join(", ") + " 등";
    }

    // boolean 행인데도 프롬프트 지시를 무시하고 스펙 텍스트를 그대로 돌려주는 경우에 대한
    // 안전망 — 이미 답을 찾았다는 뜻이므로(못 찾았으면 위에서 "-"로 걸러짐) ○로 접는다.
    if (criterionType === "boolean" && finalValue !== "○" && finalValue !== "X") {
      finalValue = "○";
    }

    return {
      value: finalValue,
      sourceUrl: answerSource.url,
      usedSnippet: answerText.slice(0, 200),
      trace: { stage: "light_extract_hit", detail: "answer-based extraction" },
    };
  } catch (err) {
    return { value: "-", trace: { stage: "llm_parse_error", detail: String(err) } };
  }
}

/**
 * 같은 기준(criterion)의 여러 제품 값을 한 번에 놓고 비교해 (1) 단위를 하나로 통일하고
 * (2) 그 기준과 무관한 값(예: "청소기 높이" 기준에 섞여 들어온 도크/베이스 높이)을 제거한다.
 * extractCellValueLight/lookupCellValue는 제품 하나씩 독립적으로 값을 뽑기 때문에, 다른
 * 제품과 나란히 놓고 비교해야만 드러나는 이상치(단위 불일치, 엉뚱한 부속품 수치)를 스스로
 * 걸러내지 못한다 — 이 함수가 행(criterion) 단위로 한 번 더 묶어서 봐야만 그 판단이 가능하다.
 */
export async function normalizeCriterionRowAcrossProducts(
  criterion: string,
  entries: Array<{ colKey: string; label: string; value: string }>,
  locale: string
): Promise<Record<string, string>> {
  if (entries.length < 2) return {};

  const lang = locale === "en" ? "English" : "Korean";
  const rawJson = Object.fromEntries(entries.map(e => [e.colKey, e.value]));
  const lines = entries.map(e => `${e.colKey} (${e.label}): ${e.value}`).join("\n");

  try {
    const { object } = await generateObject({
      model: anthropic("claude-haiku-4-5"),
      schema: z.object({
        values: z.array(z.object({
          key: z.string().describe("The exact product key as given (must match one of the input keys)."),
          value: z.string().describe(
            `The "${criterion}" value for that product, converted to the SAME unit as the others (so they ` +
            `become directly comparable), and containing ONLY the measurement that actually answers ` +
            `"${criterion}" — if a raw value bundles in a number for a different part/accessory/mode than ` +
            `what the other products report (e.g. a dock/base/accessory measurement mixed in with the ` +
            `device's own measurement), drop that irrelevant part and keep only the part comparable to the ` +
            `others. Never invent a number that isn't in the raw value. If this product's raw value reports ` +
            `a DIFFERENT metric than what most other products report for "${criterion}" (e.g. one product's ` +
            `only reported figure is a charge-cycle count while the others report per-charge runtime), do NOT ` +
            `blank it to "-" and do NOT convert/estimate it into the other metric — keep its own value as-is, ` +
            `labeled with what THIS SPECIFIC value actually measures (read that from its own raw text below, ` +
            `never assume a domain-specific label from an unrelated product category), so it reads as ` +
            `real-but-not-directly-comparable rather than missing. Only use "-" when there is truly no usable ` +
            `number left after removing an irrelevant bundled part.`
          ),
        })).describe("One entry per given product key — return ALL of them, in any order."),
      }),
      system: `You are comparing the already-extracted "${criterion}" values of several products, listed ` +
        `below (one raw value per product — each was extracted independently, so they may use different ` +
        `units, or may bundle in a measurement that isn't really about "${criterion}" itself). ` +
        `Your job is ONLY to reformat what's already given — never invent or look up new numbers: ` +
        `(1) pick one consistent unit and convert every value to it so they become directly comparable, ` +
        `(2) if a value contains a number for something other than "${criterion}" itself (e.g. an ` +
        `accessory/dock/base measured separately from the main product), remove that number and keep only ` +
        `the part that matches what the other products are reporting for this same criterion, ` +
        `(3) if a product's raw value is simply measured under a different metric than the majority (not a ` +
        `bundled-in irrelevant number, but its ONLY reported figure for this criterion), keep that product's ` +
        `value and label as-is — don't erase real information just because it isn't directly comparable, and ` +
        `never invent/convert a number to make it look comparable. ` +
        `Return one entry per product key, using the EXACT keys given. Write result values in ${lang}, ` +
        `concise — no full sentences.`,
      prompt: `Criterion: ${criterion}\n\nRaw values (one per product):\n${lines}\n\nkeys/values JSON:\n${JSON.stringify(rawJson, null, 2)}`,
      temperature: 0,
    });

    return Object.fromEntries((object.values ?? []).map(v => [v.key, v.value]));
  } catch (err) {
    console.warn(`\x1b[33m[RowNormalize] "${criterion}" 행 정규화 실패, 원본 유지: ${err}\x1b[0m`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// ComparisonTable 데이터 해석 (comp_table.ts STEP 1~2에서 이동)
// 표 구조를 코드로 만들고(buildAndAssembleTable) DB 미커버/근거없는 셀을
// Tavily+extractCellValueLight로 채운다(enrichCompTableCells). comp_table.ts는
// 이 결과(완성된 CompTableJson)를 받아 순위만 매긴다.
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
  // 라벨이 기대하는 단위군과 값의 실제 단위군이 다르면(예: "배터리 수명"(분) vs
  // "배터리: NP-FZ100(2280mAh)"(용량)) 키가 부분 포함되더라도 매칭에서 제외한다 —
  // 2순위와 동일한 가드를 여기서도 적용해야 "배터리수명".includes("배터리") 같은
  // 느슨한 포함 매칭이 서로 다른 물리량을 잘못 채가는 걸 막는다.
  for (const spec of specs) {
    const { key, rawValue } = parseSpecEntry(spec);
    const keyLower = key.toLowerCase().replace(/\s+/g, "");
    if (keyLower === labelLower || keyLower.includes(labelLower) || labelLower.includes(keyLower)) {
      // 콜론 없는 태그형 스펙(예: "미러리스 카메라", "5축 광학식 손떨림보정")은 값이 아니라
      // 문구 전체가 key로 파싱되어 rawValue가 빈 문자열이다 — 키 매칭까지 됐다는 것 자체가
      // 이미 "해당 기능 있음"의 근거이므로, 빈 값을 "-"로 흘려보내지 않고 "○"로 확정한다.
      if (!rawValue) return "○";
      if (hasUnitDimensionMismatch(label, rawValue)) continue;
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
      if (!rawValue) return "○";
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

  // 표에 등장하는 모든 기준(criterion)에 대해 한 번에 형식 힌트/정규 단위/조건/타입을
  // 배치 요청(캐싱됨) — STEP 1.5의 boolean/value 판단과 STEP 4의 추출 힌트 양쪽에서 이
  // 값을 그대로 재사용한다(뒤에서 다시 계산하지 않음). "센서 크기"처럼 하드코딩 못 한 새
  // 기준도, "필터 종류"처럼 boolean으로 잘못 분류되면 세부 답이 통째로 버려지는 기준도
  // 여기서 LLM이 매번 판단한다 — detectCriterionType()의 키워드 휴리스틱은 이 값이 없을
  // 때(예: 이 배치 호출과 무관한 다른 진입점)만 쓰는 폴백이다.
  const allRowCriteria = [...new Set(
    allRows.map(r => r["criterion"] ?? "").filter(c => c && c !== "순위" && c !== "Rank")
  )];
  const criterionMeta = await expandCriterionMeta(allRowCriteria);

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
    let rowType = criterionMeta[criterion]?.type ?? detectCriterionType(criterion);
    for (const col of productCols) {
      const val = String((row as Record<string, string>)[col.key] ?? "");
      if (val && val !== "-" && val !== "○" && val !== "X") { rowType = "value"; break; }
    }
    rowTypeMap.set(criterion, rowType);
  }
  console.log("\x1b[33m[CompTable STEP 1.5] 행 유형 결정:\x1b[0m");
  for (const [crit, type] of rowTypeMap)
    console.log(`         "${crit}" → ${type}`);

  // STEP 5(모든 채우기 완료 후 실행): "value" 행에 한해, 그 행의 모든 제품 값을 한 번에
  // LLM에 보여줘서 단위 통일 + 무관 값(도크/베이스 등) 제거를 시킨다. 셀 채우기 경로가
  // 어느 쪽이든(DB만으로 끝나든, Tavily까지 거치든) 항상 마지막에 한 번 돌려야 하므로
  // 함수로 빼서 두 종료 지점(조기 return / 정상 종료) 모두에서 호출한다.
  async function runRowNormalization(): Promise<void> {
    const valueCriteria = [...rowTypeMap.entries()].filter(([, type]) => type === "value").map(([c]) => c);
    if (valueCriteria.length === 0) return;

    const rowsNow = tableJson.props?.rows ?? [];
    console.log(`\n\x1b[35m[CompTable STEP 5] 기준별 교차 검증(단위 통일 + 무관 값 제거)...\x1b[0m`);
    await Promise.all(
      valueCriteria.map(async (criterion) => {
        const row = rowsNow.find(r => r["criterion"] === criterion);
        if (!row) return;
        const entries = productCols
          .map(col => ({ colKey: col.key, label: col.label, value: String((row as Record<string, string>)[col.key] ?? "-") }))
          .filter(e => e.value && e.value !== "-" && e.value !== "○" && e.value !== "X" && !Object.values(NOT_APPLICABLE_TEXT).includes(e.value));
        if (entries.length < 2) return;

        const updates = await normalizeCriterionRowAcrossProducts(criterion, entries, locale);
        for (const e of entries) {
          const updated = updates[e.colKey]?.trim();
          if (updated && updated !== e.value) {
            (row as Record<string, string>)[e.colKey] = updated;
            console.log(`         \x1b[35m🔁 "${criterion}" × "${e.label}": "${e.value}" → "${updated}"\x1b[0m`);
          }
        }
      })
    );
  }

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
    await runRowNormalization();
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

  // criterionMeta는 함수 상단에서 allRowCriteria 기준으로 이미 배치 계산해뒀다(STEP 1.5와
  // 공유) — uniqueCriteria는 그 결과의 부분집합이라 다시 요청할 필요 없다.

  // Tavily 검색 전 Pre-enrich 존재 여부 확인
  const rows = tableJson.props?.rows ?? [];
  const cellChecks = await Promise.all(allCellsToVerify.map(async ({ rowCriterion, colKey, productLabel }) => {
    // Pre-enrich 히트 (enrichContextWithTavily에서 이미 가져온 스니펫)
    const preSnippets = getPreEnrichedSnippets(productLabel, rowCriterion);
    if (preSnippets) {
      preEnrichedCells.push({ rowCriterion, colKey, productLabel, snippets: preSnippets });
      console.log(`\x1b[36m[Pre-enrich HIT] "${productLabel}" × "${rowCriterion}" → Tavily 생략\x1b[0m`);
      return null;
    }

    // Option List가 이 제품×기준을 이미 화면에 표시 중이면(currentOptionListCards, 이번
    // 요청과 함께 실려온 request-scoped 값) 그 값을 그대로 재사용한다 — 여기서 새로
    // Tavily 검색을 돌리면 두 컴포넌트가 같은 제품×기준을 독립적으로 재조회해 값이
    // 갈릴 수 있다(예: 초점거리가 Option List엔 "-", Comparison Table엔 "0.3m").
    const fullName = fullNameMap.get(productLabel) ?? productLabel;
    const known = lookupKnownSpecValue(fullName, rowCriterion, currentOptionListCards, rowTypeMap.get(rowCriterion));
    if (known) {
      const targetRow = rows.find(r => r["criterion"] === rowCriterion);
      if (targetRow) (targetRow as Record<string, string>)[colKey] = known;
      console.log(`\x1b[36m🔗 [Screen HIT] "${productLabel}" × "${rowCriterion}" → "${known}" (source=screen, Tavily 생략)\x1b[0m`);
      return null;
    }

    // 화면에 없어도, 이 참가자가 예전 턴/다른 패널에서 같은 제품×기준을 이미 조회한
    // 적이 있으면(spec-cache.ts, 참가자별로 격리됨) 그 값을 재사용한다 — 화면 상태
    // 유무와 무관하게 같은 참가자 안에서는 항상 같은 값으로 수렴하게 한다.
    const cached = await getCachedSpec(currentParticipantId, fullName, rowCriterion);
    if (cached) {
      const targetRow = rows.find(r => r["criterion"] === rowCriterion);
      if (targetRow) (targetRow as Record<string, string>)[colKey] = cached;
      return null;
    }

    return { rowCriterion, colKey, productLabel };
  }));
  const needsTavily = cellChecks.filter((c): c is NonNullable<typeof c> => c !== null);

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
        // preferredCondition: 제품마다 다른 조건(모드)으로 보고되는 기준(배터리 수명 등)은
        // 쿼리에 그 조건을 덧붙여, 애초에 같은 조건을 다루는 페이지가 검색되도록 유도한다.
        const preferredCondition = criterionMeta[rowCriterion]?.preferredCondition;
        const terms = [cleanedCriterion, ...synonyms.slice(0, 2), "제원 사양표", preferredCondition].filter(Boolean).join(" ");
        const fullName = fullNameMap.get(productLabel) ?? productLabel;
        const { results, answer } = await tavilySearch(`${fullName} ${terms}`, "advanced", { includeAnswer: "advanced" });
        if (answer) console.log(`\x1b[36m💡 [Tavily Answer] "${fullName} × ${rowCriterion}"\n   ${answer.slice(0, 200)}\x1b[0m`);
        // extractCellValueLight는 snippets[0]만 컨텍스트로 쓰므로, Tavily가 answer를
        // 합성했다면 그걸 맨 앞에 세운다(spec-lookup.ts의 answerSegment 패턴과 동일).
        const answerSegment = answer
          ? [{ url: results[0]?.url ?? "https://tavily.com", content: answer, score: 999, title: "Tavily Answer" }]
          : [];
        searchResultMap.set(key, [...answerSegment, ...results]);
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
          const { value: rawValue, uncertain } = await extractCellValueLight(
            productLabel, rowCriterion, snippets, locale, [],
            criterionMeta[rowCriterion]?.formatHint, criterionMeta[rowCriterion]?.canonicalUnit,
            criterionMeta[rowCriterion]?.preferredCondition, rowTypeMap.get(rowCriterion)
          );
          const value = normalizeUnitValue(rawValue, rowCriterion, criterionMeta[rowCriterion]?.canonicalUnit);
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
    console.log(`\n\x1b[33m[CompTable STEP 4] extractCellValueLight로 셀 값 판단...\x1b[0m`);
    const s4 = Date.now();
    await Promise.all(
      needsTavily.map(async ({ rowCriterion, colKey, productLabel }) => {
        const snippets = searchResultMap.get(`${productLabel}__${rowCriterion}`) ?? [];
        const { value: rawValue, sourceUrl, usedSnippet, uncertain, trace } = await extractCellValueLight(
          productLabel, rowCriterion, snippets, locale, [],
          criterionMeta[rowCriterion]?.formatHint, criterionMeta[rowCriterion]?.canonicalUnit,
          criterionMeta[rowCriterion]?.preferredCondition, rowTypeMap.get(rowCriterion)
        );
        const value = normalizeUnitValue(rawValue, rowCriterion, criterionMeta[rowCriterion]?.canonicalUnit);
        const displayValue = (uncertain && value !== "-") ? `${value} (추정)` : value;
        const targetRow = rows.find(r => r["criterion"] === rowCriterion);
        if (targetRow) targetRow[colKey] = displayValue;
        if (value !== "-" && !uncertain) {
          const fullName = fullNameMap.get(productLabel) ?? productLabel;
          void setCachedSpec(currentParticipantId, fullName, rowCriterion, value);
        }
        const symbol = value === "○" ? "\x1b[32m○\x1b[0m" : value === "X" ? "\x1b[31mX\x1b[0m" : uncertain ? "\x1b[33m?\x1b[0m" : "\x1b[90m-\x1b[0m";
        console.log(`         ${symbol} ${productLabel} × "${rowCriterion}" → "${displayValue}"${sourceUrl ? ` ← ${sourceUrl.slice(0, 60)}` : " (증거 없음)"}`);
        if (value === "-") console.log(`         \x1b[90m🕳️  [LookupTrace] stage=${trace.stage}${trace.detail ? ` | ${trace.detail}` : ""}\x1b[0m`);
        if (usedSnippet) console.log(`            \x1b[90m📄 "${usedSnippet}"\x1b[0m`);
      })
    );
    console.log(`\x1b[33m[CompTable STEP 4] 완료 (${Date.now() - s4}ms)\x1b[0m`);
  }

  await runRowNormalization();
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
    const specsRaw = block.match(/Specs:\s*(.+)/)?.[1]?.split(" / ").map(s => s.trim()).filter(Boolean) ?? [];
    // enrichContextWithTavily가 DB 미커버 기준에 대해 Tavily로 검증까지 마친 값을
    // "WebSpecs (from web search): 기준: 값 | 기준2: 값2" 형태로 블록에 덧붙인다. 이미
    // hasUnitDimensionMismatch + extractCellValueLight 검증을 거친 값이므로, DB의 느슨한
    // 부분일치 매칭(예: "배터리수명".includes("배터리"))보다 먼저 와야 lookupCellValue가
    // 정확한 값을 먼저 찾고 반환한다. 이전엔 이 줄을 아예 파싱하지 않아 Tavily가 애써
    // 찾은 값이 조용히 버려지고 DB의 잘못된 단위 값이 그대로 채워졌었다.
    const webSpecs = block.match(/WebSpecs \(from web search\):\s*(.+)/)?.[1]?.split(" | ").map(s => s.trim()).filter(Boolean) ?? [];
    const specs    = [...webSpecs, ...specsRaw];
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

// 요청마다(마이 아이템 개수만큼) 동기 readFileSync+JSON.parse를 반복하면 Node 이벤트
// 루프가 그 시간만큼 블로킹되어 같은 프로세스가 처리 중인 다른 동시 요청까지 지연시킨다.
// 프로세스 수명 동안 카테고리별로 한 번만 읽어 캐싱한다(search.ts의 loadData 캐시와 동일한 패턴).
const localDbCache: Record<string, any[]> = {};

function loadLocalDbProducts(fileName: string): any[] {
  if (localDbCache[fileName]) return localDbCache[fileName];
  const filePath = path.join(process.cwd(), "data", fileName);
  const raw = fs.readFileSync(filePath, "utf-8");
  const products: any[] = JSON.parse(raw);
  localDbCache[fileName] = products;
  return products;
}

export function findProductInLocalDB(productCategory: string, name: string): string | null {
  const fileName = CATEGORY_FILE_MAP[productCategory];
  if (!fileName) return null;

  try {
    const products = loadLocalDbProducts(fileName);

    // 정확히 일치, 그게 없으면 후보가 유일할 때만 부분 일치(RAG가 이름을 약간 다르게 저장한
    // 경우 대비) — 후보가 여럿이면(예: "로보락 S10 MaxV Slim" vs "...Slim 직배수"처럼 실제로
    // 다른 두 제품이 서로를 포함하는 경우) 확신할 수 없으므로 null을 반환한다.
    const found = findExactMatchingProduct(name, products);

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

  // 이 인덱스 배열은 LLM 자유 텍스트 출력을 파싱한 것이라(generateObject 스키마 검증 없음)
  // 같은 인덱스를 두 번 내놓는 걸 막을 장치가 없다 — 그러면 같은 제품이 카드 두 장으로
  // 중복 생성되고, 프론트에서 카드 name을 React key로 쓰므로(ProductCardList) 키 충돌로
  // 이어진다. 처음 등장한 순서만 유지하고 재등장은 버린다.
  const seenIdx = new Set<number>();
  const validated: RankedProduct[] = indices
    .filter((idx) => typeof idx === "number" && idx >= 0 && idx < candidates.length)
    .filter((idx) => {
      if (seenIdx.has(idx)) return false;
      seenIdx.add(idx);
      return true;
    })
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





