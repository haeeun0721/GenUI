import { tool, generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";

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
  // 시간류 — 정규 단위: 분
  { pattern: /사용시간|충전시간|런타임|runtime|시간/, canonical: "분", units: [
    [/^시간$/, 60], [/^분$/, 1], [/^min$/i, 1],
  ] },
  // 흡입력 — 정규 단위: Pa
  { pattern: /흡입/, canonical: "Pa", units: [
    [/^kpa$/i, 1000], [/^pa$/i, 1],
  ] },
];

/**
 * 값 문자열에서 숫자+단위를 분리해 해당 기준(fieldKey)의 정규 단위로 변환한다.
 * 매칭되는 규칙이 없거나, 단위를 못 알아보거나, 라벨 있는 값("배터리: 6400mAh")·
 * boolean 값(○/X/-)이면 원본을 그대로 반환한다 — 오탈락보다 원본 유지가 안전하다.
 */
function normalizeUnitValue(value: string, fieldKey: string): string {
  if (!value || value === "-" || value === "○" || value === "X") return value;
  if (value.includes(":")) return value;

  const rule = UNIT_RULES.find(r => r.pattern.test(fieldKey));
  if (!rule) return value;

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
  feature over to this product just because most of the name matches.`;

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
      return { value: "-" };
    }

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

    // ── 6. 단위 정규화 ───────────────────────────────────────────────────────
    // 같은 기준을 검색해도 출처마다 mm/cm, Ah/mAh처럼 단위가 다를 수 있다 —
    // criterionType이 "value"인 수치 기준만 정규 단위로 통일한다.
    if (criterionType === "value") {
      const normalized = normalizeUnitValue(finalValue, criterion);
      if (normalized !== finalValue) {
        console.log(`\x1b[36m[UnitNormalize] "${finalValue}" → "${normalized}"\x1b[0m`);
        finalValue = normalized;
      }
    }

    return { value: finalValue, sourceUrl: evidenceSeg.url, usedSnippet: evidenceQuote };
  } catch { return { value: "-" }; }
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





