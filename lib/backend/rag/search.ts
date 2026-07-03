/**
 * lib/backend/rag/search.ts
 * RAG 벡터 검색 모듈.
 * 1. 사용자 쿼리에서 수치 제약(무게/가격) 파싱 → 하드 필터링 (Pre-filter)
 * 2. 사용자 쿼리를 Google 임베딩으로 변환
 * 3. 하드 필터 통과 상품만 코사인 유사도 기반 TOP-K 검색
 * 4. ProductData[] 반환
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
