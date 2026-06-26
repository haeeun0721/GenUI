/**
 * lib/backend/rag/search.ts
 * RAG 벡터 검색 모듈.
 * 1. 사용자 쿼리를 Google 임베딩으로 변환
 * 2. 로컬 JSON 벡터 DB에서 코사인 유사도 기반 TOP-K 검색
 * 3. ProductData[] 반환
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { ProductData } from "../agents/data_agent";

// ── 타입 ──────────────────────────────────────────────────────────────────

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

type EmbeddingMap = Record<string, number[]>; // productId → vector

// ── 로컬 데이터 캐시 (서버 메모리에 올려두고 재사용) ─────────────────────

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

// ── 임베딩 생성 (Google API 직접 호출) ───────────────────────────────────

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

// ── 코사인 유사도 ──────────────────────────────────────────────────────────

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

// ── 이미지 프록시 ──────────────────────────────────────────────────────────

function proxyImage(url: string): string {
  if (!url) return "";
  if (url.startsWith("/api/image-proxy")) return url;
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

// ── 메인: RAG 검색 ─────────────────────────────────────────────────────────

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

  // 2. 쿼리 임베딩
  const queryVec = await embedQuery(query);
  console.log(`[RAG] 쿼리 임베딩 완료 (${queryVec.length}D)`);

  // 3. 코사인 유사도 계산 + 정렬
  const scored = products
    .filter((p) => {
      // 이미 보여준 상품 제외
      if (excludeNames.some((ex) => p.name.includes(ex) || ex.includes(p.name))) return false;
      // 임베딩 없는 상품 제외
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

  // 4. ProductData 형식으로 변환 (이미지 프록시 적용)
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
