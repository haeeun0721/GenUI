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

function loadData(category: string): { products: StoredProduct[]; embeddings: EmbeddingMap } | null {
  if (cache[category]) return cache[category];
  const productsPath = join(process.cwd(), "data", `products-${category}.json`);
  const embeddingsPath = join(process.cwd(), "data", `embeddings-${category}.json`);
  if (!existsSync(productsPath) || !existsSync(embeddingsPath)) {
    console.warn(`[RAG] 데이터 파일 없음: ${productsPath}`);
    return null;
  }
  const products: StoredProduct[] = JSON.parse(readFileSync(productsPath, "utf8"));
  const embeddings: EmbeddingMap = JSON.parse(readFileSync(embeddingsPath, "utf8"));
  cache[category] = { products, embeddings };
  console.log(`[RAG] 로드 완료: ${products.length}개 상품, ${Object.keys(embeddings).length}개 임베딩 (${category})`);
  return cache[category];
}

// ---------------------------------------------------------------------------
// Embedding — Google gemini-embedding-001
// ---------------------------------------------------------------------------

const EMBED_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "";
const EMBED_MODEL = "gemini-embedding-001";

export async function embedQuery(text: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${EMBED_API_KEY}`;
  const body = {
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text }] },
    taskType: "RETRIEVAL_QUERY",
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[embedQuery] Google API ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json() as { embedding: { values: number[] } };
  return data.embedding.values;
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
// Spec / Price parsers
// ---------------------------------------------------------------------------

function parseWeightKg(specs: string[]): number | null {
  for (const s of specs) {
    const m = s.match(/(?:중량|무게)[^:]*[:\s]+([\d.]+)\s*kg/i);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

function parsePriceWon(price: string): number | null {
  const m = price.replace(/,/g, "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Query Constraint Parser
// ---------------------------------------------------------------------------

const BRAND_NAMES = [
  "삼성", "lg", "로보락", "샤오미", "다이슨", "드리미", "에코백스", "아이로봇",
  "나르왈", "eufy", "shark", "bosch", "irobot", "neato", "roborock", "dreame",
  "부가부", "스토케", "마클라렌", "사이벡스", "누나", "줄즈", "베이비젠",
  "소니", "캐논", "니콘", "후지필름", "파나소닉", "올림푸스", "라이카",
];

interface NumericConstraints {
  maxPriceWon?: number;
  minPriceWon?: number;
  maxWeightKg?: number;
  minWeightKg?: number;
  minSuctionPa?: number;
  maxSuctionPa?: number;
  maxNoiseDb?: number;
  brand?: string;
}

function parseSpecNumber(specs: string[], keyPatterns: RegExp[]): number | null {
  for (const spec of specs) {
    const colonIdx = spec.indexOf(":");
    if (colonIdx === -1) continue;
    const key = spec.substring(0, colonIdx).trim();
    const value = spec.substring(colonIdx + 1).trim();
    if (keyPatterns.some((p) => p.test(key))) {
      const numMatch = value.replace(/,/g, "").match(/[\d.]+/);
      if (numMatch) return parseFloat(numMatch[0]);
    }
  }
  return null;
}

function parseConstraints(query: string): NumericConstraints {
  const c: NumericConstraints = {};

  const maxPriceMan = query.match(/([\d.]+)\s*만\s*원?\s*(?:이하|미만)/i);
  if (maxPriceMan) { c.maxPriceWon = parseFloat(maxPriceMan[1]) * 10000; }
  else { const m = query.match(/([\d,]+)\s*원\s*(?:이하|미만)/i); if (m) c.maxPriceWon = parseInt(m[1].replace(/,/g, ""), 10); }

  const minPriceMan = query.match(/([\d.]+)\s*만\s*원?\s*(?:이상|초과)/i);
  if (minPriceMan) { c.minPriceWon = parseFloat(minPriceMan[1]) * 10000; }
  else { const m = query.match(/([\d,]+)\s*원\s*(?:이상|초과)/i); if (m) c.minPriceWon = parseInt(m[1].replace(/,/g, ""), 10); }

  const maxWt = query.match(/([\d.]+)\s*(?:kg|킬로(?:그램)?)\s*(?:이하|미만)/i);
  if (maxWt) c.maxWeightKg = parseFloat(maxWt[1]);
  const minWt = query.match(/([\d.]+)\s*(?:kg|킬로(?:그램)?)\s*(?:이상|초과)/i);
  if (minWt) c.minWeightKg = parseFloat(minWt[1]);

  const minSuction = query.match(/([\d,]+)\s*[Pp][Aa]\s*(?:이상|초과)/i) ?? query.match(/흡입력\s*([\d,]+)/i);
  if (minSuction) c.minSuctionPa = parseInt(minSuction[1].replace(/,/g, ""), 10);
  const maxSuction = query.match(/([\d,]+)\s*[Pp][Aa]\s*(?:이하|미만)/i);
  if (maxSuction) c.maxSuctionPa = parseInt(maxSuction[1].replace(/,/g, ""), 10);

  const maxNoise = query.match(/([\d.]+)\s*[dD][bB]\s*(?:이하|미만)/i) ?? query.match(/소음\s*([\d.]+)/i);
  if (maxNoise) c.maxNoiseDb = parseFloat(maxNoise[1]);

  const queryLower = query.toLowerCase();
  for (const brand of BRAND_NAMES) {
    if (queryLower.includes(brand.toLowerCase())) { c.brand = brand.toLowerCase(); break; }
  }

  if (Object.keys(c).length > 0) console.log("[RAG] 하드필터 조건 감지:", JSON.stringify(c));
  return c;
}

// ---------------------------------------------------------------------------
// Hard Filter (결정론적) — 수치/가격/브랜드를 코드로 직접 비교
// 스펙에 해당 정보 없으면 통과 (정보 없다고 배제하지 않음)
// ---------------------------------------------------------------------------

function applyHardFilter(products: StoredProduct[], constraints: NumericConstraints): StoredProduct[] {
  if (Object.keys(constraints).length === 0) return products;
  const SUCTION = [/흡입력/i, /suction/i, /압력/i];
  const NOISE   = [/소음/i, /noise/i, /db/i];
  const filtered = products.filter((p) => {
    const priceWon  = parsePriceWon(p.price);
    const weightKg  = parseWeightKg(p.specs);
    const suctionPa = parseSpecNumber(p.specs, SUCTION);
    const noiseDb   = parseSpecNumber(p.specs, NOISE);
    const nameLower = (p.name + " " + (p.brand ?? "")).toLowerCase();
    if (constraints.maxPriceWon  !== undefined && priceWon  !== null && priceWon  > constraints.maxPriceWon)  return false;
    if (constraints.minPriceWon  !== undefined && priceWon  !== null && priceWon  < constraints.minPriceWon)  return false;
    if (constraints.maxWeightKg  !== undefined && weightKg  !== null && weightKg  > constraints.maxWeightKg)  return false;
    if (constraints.minWeightKg  !== undefined && weightKg  !== null && weightKg  < constraints.minWeightKg)  return false;
    if (constraints.minSuctionPa !== undefined && suctionPa !== null && suctionPa < constraints.minSuctionPa) return false;
    if (constraints.maxSuctionPa !== undefined && suctionPa !== null && suctionPa > constraints.maxSuctionPa) return false;
    if (constraints.maxNoiseDb   !== undefined && noiseDb   !== null && noiseDb   > constraints.maxNoiseDb)   return false;
    if (constraints.brand !== undefined && !nameLower.includes(constraints.brand)) return false;
    return true;
  });
  console.log(`[RAG] 하드필터: ${products.length}개 → ${filtered.length}개 (${products.length - filtered.length}개 제거)`);
  return filtered;
}

// ---------------------------------------------------------------------------
// Main RAG Search
// ---------------------------------------------------------------------------

export async function ragSearch(
  query: string,
  category: string,
  topK: number = 20,
  excludeNames: string[] = []
): Promise<ProductData[]> {
  console.log(`\n[RAG] 검색: "${query}" (category=${category}, topK=${topK})`);

  const data = loadData(category);
  if (!data) return [];
  const { products, embeddings } = data;

  // 하드필터(로컬) + 쿼리 임베딩(Google API) 병렬 실행
  const constraints = parseConstraints(query);
  const [queryVec, rawFiltered] = await Promise.all([
    embedQuery(query),
    Promise.resolve(applyHardFilter(products, constraints)),
  ]);
  console.log(`[RAG] 쿼리 임베딩 완료 (${queryVec.length}D)`);

  let filteredProducts = rawFiltered;
  if (filteredProducts.length === 0 && constraints.brand) {
    console.warn("[RAG] 브랜드 조건 완화");
    filteredProducts = applyHardFilter(products, { ...constraints, brand: undefined });
  }
  if (filteredProducts.length === 0) {
    console.warn("[RAG] 모든 조건 완화 — 전체 후보 사용");
    filteredProducts = products;
  }

  const scored = filteredProducts
    .filter((p) => {
      if (excludeNames.some((ex) => p.name.includes(ex) || ex.includes(p.name))) return false;
      return !!embeddings[p.id];
    })
    .map((p) => ({ product: p, score: cosineSimilarity(queryVec, embeddings[p.id]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  console.log(
    `[RAG] TOP ${scored.length} 결과:\n` +
    scored.slice(0, 5).map((s) => `  ${s.score.toFixed(3)} | ${s.product.name.slice(0, 40)}`).join("\n")
  );

  return scored.map((s) => ({
    id: s.product.id,
    name: s.product.name,
    price: s.product.price,
    image: s.product.image,
    link: s.product.link,
    brand: s.product.brand,
    specs: s.product.specs,
    description: s.product.description,
  }));
}

// ---------------------------------------------------------------------------
// SYNONYM_MAP — 자연어 기준을 DB 스펙 키로 매핑
// ---------------------------------------------------------------------------

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
  [/애완동물|반려동물|반려\s*가구|강아지|고양이|털\s*제거|털\s*흡입|펫\s*케어|pet/i, ["펫케어", "엉킴방지재질", "먼지엉킴방지"]],

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
  criterion: string;
  matchedKeys: string[];
  productCount: number;
  covered: boolean;
}

/**
 * 자연어 기준 목록을 받아 전체 DB에서 각 기준의 커버리지를 확인한다.
 * LLM 호출 없음 — 동의어 맵 + 부분 문자열 매칭으로 처리.
 */
export function checkDbCoverage(criteria: string[], category: string): CoverageResult[] {
  const data = loadData(category);
  if (!data) return criteria.map(c => ({ criterion: c, matchedKeys: [], productCount: 0, covered: false }));

  const allSpecKeys = new Set<string>();
  for (const p of data.products) {
    for (const spec of p.specs) {
      const key = spec.split(":")[0].trim();
      allSpecKeys.add(key);
    }
  }

  return criteria.map(criterion => {
    const cLower = criterion.toLowerCase();
    let candidateKeys: string[] = [];

    for (const [pattern, keys] of SYNONYM_MAP) {
      if (pattern.test(criterion)) {
        candidateKeys = keys.filter(k => allSpecKeys.has(k));
        break;
      }
    }

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
