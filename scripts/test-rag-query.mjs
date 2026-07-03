import { readFileSync } from "fs";

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedQuery(text, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "models/gemini-embedding-001", content: { parts: [{ text }] } }),
    }
  );
  const data = await res.json();
  return data.embedding.values;
}

async function main() {
  const category = process.argv[2] || "유모차";
  const query = process.argv[3] || "등받이 각도 조절 가능한 유모차";

  console.log(`\n🔍 카테고리: ${category} | 쿼리: "${query}"\n`);

  const products = JSON.parse(readFileSync(`./data/products-${category}.json`, "utf8"));
  const embeddings = JSON.parse(readFileSync(`./data/embeddings-${category}.json`, "utf8"));
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  if (!apiKey) {
    console.error("❌ GOOGLE_GENERATIVE_AI_API_KEY 환경변수가 설정되지 않았습니다.");
    process.exit(1);
  }

  const qVec = await embedQuery(query, apiKey);

  const scored = products
    .filter((p) => embeddings[p.id])
    .map((p) => ({ p, score: cosineSim(qVec, embeddings[p.id]) }))
    .sort((a, b) => b.score - a.score);

  console.log(`\n쿼리: "${query}"\n`);
  console.log("TOP 5 결과:");
  scored.slice(0, 5).forEach(({ p, score }) => {
    console.log(`\n  [${score.toFixed(4)}] ${p.name.slice(0, 45)}`);
    console.log(`  스펙: ${p.specs.slice(0, 5).join(" | ")}`);
  });

  // 실제로 등받이/각도 스펙이 있는 상품이 몇 위에 있는지 확인
  console.log("\n\n--- 등받이/각도 관련 스펙 보유 상품의 순위 ---");
  scored.forEach(({ p, score }, idx) => {
    const hasAngle = p.specs.some((s) =>
      s.includes("등받이") || s.includes("각도") || s.includes("리클라인")
    );
    if (hasAngle) console.log(`  ${idx + 1}위 [${score.toFixed(4)}] ${p.name.slice(0, 40)}`);
  });
}

main().catch(console.error);
