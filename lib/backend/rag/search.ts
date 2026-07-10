/**
 * lib/backend/rag/search.ts
 * RAG 벡터 검색 모듈.
 * 1. 사용자 쿼리에서 수치 제약(무게/가격) 파싱 → 하드 필터링 (Pre-filter)
 * 2. 사용자 쿼리를 Google 임베딩으로 변환
 * 3. 하드 필터 통과 상품만 코사인 유사도 기반 TOP-K 검색
 * 4. ProductData[] 반환
 * 5. (신규) checkDbCoverage — 전체 DB에서 기준별 커버리지 체크 (LLM 호출 없음)
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { ProductData } from "../agents/data_agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredProduct {
  id: string;
  category: string;
  name: string;
  price: string;
  image: string;
  link: string;
  brand: string;
  specs: string[];
  description: string;
  crawledAt: string;
}

type EmbeddingMap = Record<string, number[]>;

// ---------------------------------------------------------------------------
// Local Data Cache
// ---------------------------------------------------------------------------

const cache: Record<string, { products: StoredProduct[]; embeddings: EmbeddingMap }> = {};

function loadData(category: string) {
  if (cache[category]) return cache[category];

  const dataDir = join(process.cwd(), "data");
  const productsPath = join(dataDir, `products-${category}.json`);
  const embPath = join(dataDir, `embeddings-${category}.json`);

  if (!existsSync(productsPath) || !existsSync(embPath)) {
    console.warn(`[RAG] 데이터 파일 없음: ${category}. 크롤링 스크립트를 먼저 실행하세요.`);
    return null;
  }

  const products: StoredProduct[] = JSON.parse(readFileSync(productsPath, "utf8"));
  const embeddings: EmbeddingMap = JSON.parse(readFileSync(embPath, "utf8"));

  cache[category] = { products, embeddings };
  console.log(`[RAG] 로드 완료: ${products.length}개 상품, ${Object.keys(embeddings).length}개 임베딩 (${category})`);
  return cache[category];
}

// ---------------------------------------------------------------------------
// Embedding (Google API)
// ---------------------------------------------------------------------------

const EMBED_MODEL = "gemini-embedding-001";

async function embedQuery(text: string): Promise<number[]> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY 없음");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${apiKey}`;
  const body = {
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text }] },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google Embed API ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.embedding.values as number[];
}

// ---------------------------------------------------------------------------
// Cosine Similarity
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Image Proxy
// ---------------------------------------------------------------------------

function proxyImage(url: string): string {
  if (!url) return "";
  if (url.startsWith("/api/image-proxy")) return url;
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

// ---------------------------------------------------------------------------
// Metadata Parsers: extract numeric values from spec text
// ---------------------------------------------------------------------------

/** 스펙 배열에서 무게(kg) 추출. 없으면 null. */
function parseWeightKg(specs: string[]): number | null {
  for (const s of specs) {
    // "중량: 4.8kg", "무게: 5 kg", "본체 중량: 3.5kg" 등
    const m = s.match(/(?:중량|무게)[^:]*[:\s]+([\d.]+)\s*kg/i);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

/** 가격 문자열에서 원화 숫자 추출. "148,360원" → 148360 */
function parsePriceWon(price: string): number | null {
  const m = price.replace(/,/g, "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Query Constraint Parser
// 사용자 문장에서 정량 조건을 파싱 (벡터 검색 전 하드 필터에 사용)
// ---------------------------------------------------------------------------

interface NumericConstraints {
  maxWeightKg?: number; // "5kg 이하"
  minWeightKg?: number; // "3kg 이상"
  maxPriceWon?: number; // "30만원 이하"
  minPriceWon?: number; // "10만원 이상"
}

function parseConstraints(query: string): NumericConstraints {
  const c: NumericConstraints = {};

  // 무게: "5kg 이하", "5 kg 미만", "5킬로 이하"
  const maxWt = query.match(/([\d.]+)\s*(?:kg|킬로(?:그램)?)\s*(?:이하|미만)/i);
  if (maxWt) c.maxWeightKg = parseFloat(maxWt[1]);

  const minWt = query.match(/([\d.]+)\s*(?:kg|킬로(?:그램)?)\s*(?:이상|초과)/i);
  if (minWt) c.minWeightKg = parseFloat(minWt[1]);

  // 가격: "30만원 이하", "300,000원 이하"
  const maxPriceMan = query.match(/([\d.]+)\s*만\s*원?\s*(?:이하|미만)/i);
  if (maxPriceMan) {
    c.maxPriceWon = parseFloat(maxPriceMan[1]) * 10000;
  } else {
    const maxPriceWon = query.match(/([\d,]+)\s*원\s*(?:이하|미만)/i);
    if (maxPriceWon) c.maxPriceWon = parseInt(maxPriceWon[1].replace(/,/g, ""), 10);
  }

  const minPriceMan = query.match(/([\d.]+)\s*만\s*원?\s*(?:이상|초과)/i);
  if (minPriceMan) {
    c.minPriceWon = parseFloat(minPriceMan[1]) * 10000;
  } else {
    const minPriceWon = query.match(/([\d,]+)\s*원\s*(?:이상|초과)/i);
    if (minPriceWon) c.minPriceWon = parseInt(minPriceWon[1].replace(/,/g, ""), 10);
  }

  if (Object.keys(c).length > 0) {
    console.log("[RAG] 수치 제약 감지:", JSON.stringify(c));
  }

  return c;
}

// ---------------------------------------------------------------------------
// Hard Filter
// 수치 제약 조건으로 후보풀을 먼저 축소. 스펙에 정보가 없는 상품은 통과시킴.
// ---------------------------------------------------------------------------

function applyHardFilter(
  products: StoredProduct[],
  constraints: NumericConstraints
): StoredProduct[] {
  if (Object.keys(constraints).length === 0) return products;

  const filtered = products.filter((p) => {
    const weightKg = parseWeightKg(p.specs);
    const priceWon = parsePriceWon(p.price);

    // 무게 조건 (스펙에 무게 정보가 있을 때만 적용)
    if (constraints.maxWeightKg !== undefined && weightKg !== null) {
      if (weightKg > constraints.maxWeightKg) return false;
    }
    if (constraints.minWeightKg !== undefined && weightKg !== null) {
      if (weightKg < constraints.minWeightKg) return false;
    }

    // 가격 조건 (가격 정보가 있을 때만 적용)
    if (constraints.maxPriceWon !== undefined && priceWon !== null) {
      if (priceWon > constraints.maxPriceWon) return false;
    }
    if (constraints.minPriceWon !== undefined && priceWon !== null) {
      if (priceWon < constraints.minPriceWon) return false;
    }

    return true;
  });

  console.log(
    `[RAG] 하드 필터: ${products.length}개 → ${filtered.length}개 ` +
    `(${products.length - filtered.length}개 조건 미충족 제거)`
  );

  return filtered;
}

// ---------------------------------------------------------------------------
// Main: RAG Search
// ---------------------------------------------------------------------------

export async function ragSearch(
  query: string,
  category: string,
  topK: number = 20,
  excludeNames: string[] = []
): Promise<ProductData[]> {
  console.log(`\n[RAG] 검색: "${query}" (category=${category}, topK=${topK})`);

  // 1. 데이터 로드
  const data = loadData(category);
  if (!data) return [];

  const { products, embeddings } = data;

  // 2. 쿼리에서 수치 제약 추출 → 하드 필터 (벡터 검색 이전 단계)
  const constraints = parseConstraints(query);
  const filteredProducts = applyHardFilter(products, constraints);

  // 3. 쿼리 임베딩
  const queryVec = await embedQuery(query);
  console.log(`[RAG] 쿼리 임베딩 완료 (${queryVec.length}D)`);

  // 4. 코사인 유사도 계산 + 정렬 (하드 필터 통과 상품만 대상)
  const scored = filteredProducts
    .filter((p) => {
      if (excludeNames.some((ex) => p.name.includes(ex) || ex.includes(p.name))) return false;
      return !!embeddings[p.id];
    })
    .map((p) => ({
      product: p,
      score: cosineSimilarity(queryVec, embeddings[p.id]),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  console.log(
    `[RAG] TOP ${scored.length} 결과:\n` +
    scored.slice(0, 5).map((s) => `  ${s.score.toFixed(3)} | ${s.product.name.slice(0, 40)}`).join("\n")
  );

  // 5. ProductData 형식으로 변환
  return scored.map(({ product }) => ({
    id: product.id,
    name: product.name,
    price: product.price,
    image: proxyImage(product.image),
    link: product.link,
    brand: product.brand,
    mallName: "다나와",
    specs: product.specs,
    description: product.description,
  }));
}

// ---------------------------------------------------------------------------
// DB Coverage Check
// LLM 호출 없이 전체 DB 대상으로 기준별 스펙 존재 여부를 체크한다.
// ---------------------------------------------------------------------------

// 자연어 표현 → 실제 DB 스펙 키 동의어 맵
// 사용자가 쓰는 말과 다나와 스펙 키 사이의 간극을 흡수
const SYNONYM_MAP: [RegExp, string[]][] = [
  // ── 로봇청소기 ────────────────────────────────────────────────────────────
  [/머리카락\s*(엉킴|컷팅|방지)/,   ["머리카락컷팅", "먼지엉킴방지", "엉킴방지재질"]],
  [/엉킴\s*방지|엉킴\s*방지\s*브러시|엉킴\s*방지\s*재질/, ["엉킴방지재질", "먼지엉킴방지", "머리카락컷팅"]],
  [/물\s*걸레|물걸레/,              ["물걸레", "물탱크", "물분사"]],
  [/uv\s*살균|자외선\s*살균/i,       ["UV살균"]],
  [/흡입\s*력|흡입력/,              ["흡입력", "압력"]],
  [/자동\s*먼지\s*비움|자동집진/,    ["먼지비움", "먼지자동집진"]],
  [/소음|dB|데시벨/i,               ["소음"]],
  [/헤파|hepa/i,                    ["헤파필터등급", "필터"]],
  [/스팀\s*살균|스팀/,              ["물걸레100℃스팀살균"]],
  [/장애물\s*인식|장애물\s*회피/,    ["장애물회피", "AI사물인식", "사물인식"]],
  [/lds|라이다|lidar/i,             ["LDS"]],
  [/tof/i,                          ["ToF"]],
  [/카펫/,                          ["카펫부스트", "카펫회피"]],
  [/브러시|브러쉬/,                  ["메인", "메인2개", "사이드", "사이드2개"]],
  [/배터리|사용\s*시간/,             ["배터리용량", "사용시간", "충전시간"]],
  [/무게|중량/,                      ["무게"]],
  [/금지\s*구역|가상\s*벽/,          ["금지구역"]],
  [/홈\s*캠|홈캠/,                  ["홈캠"]],

  // ── 카메라 ────────────────────────────────────────────────────────────────
  [/손\s*떨림\s*보정|ois|손떨방/i,                 ["손떨림보정"]],
  [/미러리스/,                                      ["디카 분류"]],
  [/dslr/i,                                         ["디카 분류"]],
  [/하이엔드|컴팩트\s*카메라/,                      ["디카 분류"]],
  [/즉석\s*카메라|인스탁스|폴라로이드/,             ["즉석필름크기"]],
  [/4k|4K|4k\s*촬영/,                               ["동영상 해상도"]],
  [/8k|8K/,                                         ["동영상 해상도"]],
  [/fhd|full\s*hd|풀hd/i,                           ["동영상 해상도"]],
  [/동영상|영상\s*촬영|비디오/,                     ["동영상 해상도", "동영상 연속촬영"]],
  [/iso\s*감도|고감도|저조도/i,                     ["최고 감도", "최저 감도"]],
  [/af\s*트래킹|피사체\s*추적|트래킹/i,             ["AF트래킹"]],
  [/뷰파인더|evf/i,                                 ["뷰파인더 픽셀수", "뷰파인더 종류"]],
  [/회전\s*액정|회전\s*화면|틸트\s*액정|플립\s*스크린/,  ["화면형태"]],
  [/wi-?fi|무선|wifi/i,                             ["Wi-Fi"]],
  [/블루투스|bluetooth/i,                           ["블루투스"]],
  [/gps/i,                                          ["GPS태그"]],
  [/방진\s*방적|방진|방적|weather\s*seal/i,         ["방진,방적"]],
  [/듀얼\s*슬롯|이중\s*슬롯/,                       ["듀얼슬롯"]],
  [/raw\s*촬영|raw/i,                               ["RAW"]],
  [/log\s*촬영|log|로그\s*촬영/i,                   ["Log촬영"]],
  [/hdmi/i,                                         ["HDMI"]],
  [/usb-?c|타입-?c/i,                               ["USB-C"]],
  [/마이크\s*(단자|입력)|외장\s*마이크/,             ["마이크"]],
  [/핫슈|플래시\s*슈/,                              ["핫슈"]],
  [/연사|초당\s*\d+매/,                             ["최고 연사"]],
  [/셔터\s*스피드|셔터속도/,                        ["최고 셔터스피드"]],
  [/웹캠|webcam/i,                                  ["웹캠모드"]],
  [/먼지\s*제거|센서\s*클리닝/,                     ["먼지제거"]],
  [/nd\s*필터|내장\s*nd/i,                          ["ND필터 내장"]],
];

export interface CoverageResult {
  /** 입력된 기준 텍스트 */
  criterion: string;
  /** DB 스펙 키 중 매칭된 키들 */
  matchedKeys: string[];
  /** 매칭된 키를 가진 제품 수 (전체 DB 기준) */
  productCount: number;
  /** DB에 해당 기준 스펙이 존재하는지 여부 */
  covered: boolean;
}

/**
 * 자연어 기준 목록을 받아 전체 DB에서 각 기준의 커버리지를 확인한다.
 * LLM 호출 없음 — 동의어 맵 + 부분 문자열 매칭으로 처리.
 *
 * @param criteria  사용자 요청에서 추출된 기준 문자열 배열 (e.g. ["물걸레", "머리카락컷팅"])
 * @param category  제품 카테고리 (e.g. "로봇 청소기")
 * @returns CoverageResult[]
 */
export function checkDbCoverage(criteria: string[], category: string): CoverageResult[] {
  const data = loadData(category);
  if (!data) return criteria.map(c => ({ criterion: c, matchedKeys: [], productCount: 0, covered: false }));

  // 전체 DB 스펙 키 집합 수집 (e.g. "흡입력", "물걸레", ...)
  const allSpecKeys = new Set<string>();
  for (const p of data.products) {
    for (const spec of p.specs) {
      const key = spec.split(":")[0].trim();
      allSpecKeys.add(key);
    }
  }

  return criteria.map(criterion => {
    const cLower = criterion.toLowerCase();

    // 1. 동의어 맵으로 후보 키 결정
    let candidateKeys: string[] = [];
    for (const [pattern, keys] of SYNONYM_MAP) {
      if (pattern.test(criterion)) {
        candidateKeys = keys.filter(k => allSpecKeys.has(k));
        break;
      }
    }

    // 2. 동의어 미매칭 → 공백 정규화 후 부분 문자열 매칭
    if (candidateKeys.length === 0) {
      const cNorm = criterion.replace(/\s+/g, "").toLowerCase();
      for (const key of allSpecKeys) {
        const kNorm = key.replace(/\s+/g, "").toLowerCase();
        if (kNorm.includes(cNorm) || cNorm.includes(kNorm) ||
            key.toLowerCase().includes(cLower) || cLower.includes(key.toLowerCase())) {
          candidateKeys.push(key);
        }
      }
    }

    if (candidateKeys.length === 0) {
      console.log(`[Coverage] "${criterion}" → 매칭 스펙 키 없음`);
      return { criterion, matchedKeys: [], productCount: 0, covered: false };
    }

    // 3. 매칭된 키를 가진 제품 수 카운트
    const count = data.products.filter(p =>
      p.specs.some(spec => {
        const key = spec.split(":")[0].trim();
        return candidateKeys.includes(key);
      })
    ).length;

    console.log(`[Coverage] "${criterion}" → 키: [${candidateKeys.join(", ")}], ${count}개 제품`);
    return { criterion, matchedKeys: candidateKeys, productCount: count, covered: count > 0 };
  });
}

