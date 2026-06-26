/**
 * scripts/embed-products.mjs
 * 크롤링된 상품 데이터를 Google text-embedding-004로 임베딩하여 저장.
 * 실행: node scripts/embed-products.mjs
 *
 * 필요: .env.local에 GOOGLE_GENERATIVE_AI_API_KEY 설정
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CATEGORY = "유모차";

// Google Generative AI API 직접 호출 (SDK 없이)
const GOOGLE_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!GOOGLE_API_KEY) {
  console.error("❌ GOOGLE_GENERATIVE_AI_API_KEY 환경변수가 없습니다.");
  console.error("   .env.local 파일에 GOOGLE_GENERATIVE_AI_API_KEY=... 를 추가하세요.");
  process.exit(1);
}

const EMBED_MODEL = "gemini-embedding-001";
const BATCH_SIZE = 20;
const DELAY_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 상품을 임베딩용 텍스트로 변환 ─────────────────────────────────────────
function productToText(product) {
  const parts = [
    product.name,
    product.brand ? `브랜드: ${product.brand}` : "",
    product.price ? `가격: ${product.price}` : "",
    ...product.specs,
    product.description || "",
  ].filter(Boolean);
  return parts.join(" | ").slice(0, 2000);
}

// ── Google Embedding API 배치 호출 ────────────────────────────────────────
async function embedBatch(texts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents?key=${GOOGLE_API_KEY}`;

  const body = {
    requests: texts.map((text) => ({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text }] },
    })),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google API ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.embeddings.map((e) => e.values);
}

// ── 단일 쿼리 임베딩 (검색 시 사용) ─────────────────────────────────────
export async function embedQuery(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GOOGLE_API_KEY}`;
  const body = {
    model: "models/text-embedding-004",
    content: { parts: [{ text }] },
    taskType: "RETRIEVAL_QUERY",
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Google API ${res.status}`);
  const data = await res.json();
  return data.embedding.values;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const productsPath = join(ROOT, "data", `products-${CATEGORY}.json`);
  if (!existsSync(productsPath)) {
    console.error(`❌ ${productsPath} 파일이 없습니다. 먼저 crawl-products.mjs를 실행하세요.`);
    process.exit(1);
  }

  const products = JSON.parse(readFileSync(productsPath, "utf8"));
  console.log(`\n🚀 임베딩 생성 시작: ${products.length}개 상품\n`);

  // 기존 임베딩 파일이 있으면 이어서 처리 (중단 재개)
  const embPath = join(ROOT, "data", `embeddings-${CATEGORY}.json`);
  const existingEmb = existsSync(embPath) ? JSON.parse(readFileSync(embPath, "utf8")) : {};
  const doneIds = new Set(Object.keys(existingEmb));
  console.log(`   이미 완료된 항목: ${doneIds.size}개\n`);

  const pending = products.filter((p) => !doneIds.has(p.id));
  console.log(`   처리 예정: ${pending.length}개\n`);

  const embeddings = { ...existingEmb };

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const texts = batch.map(productToText);

    try {
      const batchEmbeddings = await embedBatch(texts);
      batch.forEach((p, j) => {
        embeddings[p.id] = batchEmbeddings[j];
      });

      // 중간 저장 (중단 시 재개 가능)
      writeFileSync(embPath, JSON.stringify(embeddings), "utf8");

      const done = Math.min(i + BATCH_SIZE, pending.length);
      process.stdout.write(`  [EMB] ${done}/${pending.length} (${Math.round(done / pending.length * 100)}%)\r`);
    } catch (err) {
      console.error(`\n  [EMB] Batch ${i}-${i + BATCH_SIZE} 실패: ${err.message}`);
    }

    if (i + BATCH_SIZE < pending.length) await sleep(DELAY_MS);
  }

  console.log(`\n\n🎉 임베딩 완료: ${Object.keys(embeddings).length}개`);
  console.log(`   저장: ${embPath}`);
  console.log(`   차원: ${Object.values(embeddings)[0]?.length ?? "?"}D`);
}

main().catch(console.error);
