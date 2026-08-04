/**
 * Tavily API 검증 스크립트
 * 사용법:
 *   npx tsx test-tavily-debug.ts "로보락 S10 MaxV Ultra 소음 수준"
 *   npx tsx test-tavily-debug.ts "드리미 X50 Master 배터리 수명 사용시간" advanced
 */
import fs from "fs";

function getEnv(key: string): string | undefined {
  try {
    const envFile = fs.readFileSync(".env.local", "utf8");
    const match = envFile.match(new RegExp(`^${key}=(.*)`, "m"));
    return match ? match[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

async function testTavilyDebug() {
  const apiKey = getEnv("TAVILY_API_KEY");
  if (!apiKey) {
    console.error("TAVILY_API_KEY not set in .env.local");
    process.exit(1);
  }

  const query       = process.argv[2] ?? "로보락 S10 MaxV Ultra 소음 수준 제원 사양표";
  const depth       = (process.argv[3] ?? "advanced") as "basic" | "advanced";
  const maxResults  = parseInt(process.argv[4] ?? "5", 10);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[Query]  "${query}"`);
  console.log(`[Depth]  ${depth} | [Max Results] ${maxResults}`);
  console.log(`${"=".repeat(60)}\n`);

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      search_depth: depth,
      max_results: maxResults,
      include_answer: true,
    }),
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}:`, await res.text());
    process.exit(1);
  }

  const data = await res.json() as {
    answer?: string;
    results?: Array<{ title: string; url: string; score: number; content: string }>;
  };

  // AI Answer
  if (data.answer) {
    console.log("[AI Answer]");
    console.log(data.answer);
    console.log();
  } else {
    console.log("[AI Answer] (none)\n");
  }

  // 개별 결과
  const results = data.results ?? [];
  console.log(`[Results] ${results.length}건\n`);
  results.forEach((r, i) => {
    console.log(`--- [${i + 1}] score=${r.score.toFixed(3)} ---`);
    console.log(`URL  : ${r.url}`);
    console.log(`Title: ${r.title}`);
    console.log(`Content (${r.content.length}chars):`);
    (r.content.match(/.{1,100}/g) ?? []).forEach(line => console.log(`  ${line}`));
    console.log();
  });

  // 자동 검증
  console.log("=".repeat(60));
  console.log("[Verification]");

  // 1. 키워드 히트율
  const keywords = query.split(/\s+/).filter(k => k.length >= 2);
  results.forEach((r, i) => {
    const hits = keywords.filter(k => r.content.toLowerCase().includes(k.toLowerCase()));
    const ratio = hits.length / keywords.length;
    const status = ratio >= 0.5 ? "OK" : ratio >= 0.3 ? "WARN" : "MISS";
    console.log(`  [${i + 1}] keyword hit ${Math.round(ratio * 100)}% (${hits.length}/${keywords.length}) [${status}] -> [${hits.join(", ")}]`);
  });

  // 2. 저신뢰 도메인
  const LOW_TRUST = ["tistory.com", "blog.naver.com", "namu.wiki", "youtube.com", "reddit.com"];
  const lowTrustResults = results.filter(r => LOW_TRUST.some(d => r.url.includes(d)));
  console.log(`\n  Low-trust domains: ${lowTrustResults.length > 0 ? lowTrustResults.map(r => r.url).join(", ") : "none"}`);

  // 3. 수치 자동 감지
  const numPattern = /(\d[\d,.]*\s*(?:dB|Pa|mAh|분|시간|kg|g|mL|L|원|rpm|W))/gi;
  const allNums: string[] = [];
  results.forEach(r => {
    const matches = r.content.match(numPattern) ?? [];
    allNums.push(...matches.slice(0, 5));
  });
  const uniqueNums = [...new Set(allNums)];
  console.log(`\n  Numeric values found: ${uniqueNums.length > 0 ? uniqueNums.slice(0, 10).join(", ") : "(none - no spec data?)"}`);
}

testTavilyDebug().catch(console.error);
