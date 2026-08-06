/**
 * Tavily API 원본 응답 점검 스크립트.
 * 실제 DB(data/products-*.json)에 존재하는 "형제 제품"(로보락 S10 MaxV Ultra vs
 * 로보락 S10 MaxV Ultra 직배수 등)을 일부러 골라 쿼리를 날리고, 응답에
 * 형제 제품을 가리키는 토큰이 섞여 들어오는지까지 자동 점검한다.
 * 결과는 scripts/tavily-debug-report.md 로 저장.
 *
 * 사용법: node scripts/test-tavily-report.mjs
 */
import fs from "fs";

function getEnv(key) {
  const envFile = fs.readFileSync(".env.local", "utf8");
  const match = envFile.match(new RegExp(`^${key}=(.*)`, "m"));
  return match ? match[1].trim() : undefined;
}

const apiKey = getEnv("TAVILY_API_KEY");
if (!apiKey) {
  console.error("TAVILY_API_KEY not set in .env.local");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 테스트 케이스 — 실제 DB에 존재하는 "형제 제품" 쌍을 일부러 포함시켜
// Tavily 응답에 형제 모델 정보가 섞이는지(cross-contamination) 확인한다.
// ---------------------------------------------------------------------------
const CASES = [
  {
    label: "로보락 S10 MaxV Ultra 소음",
    query: "로보락 S10 MaxV Ultra 소음",
    depth: "basic",
    // 이 제품명에는 없는, DB상 형제 제품을 구분짓는 토큰들
    siblingTokens: ["직배수"],
  },
  {
    label: "로보락 S10 MaxV Ultra 직배수 배터리 사용시간",
    query: "로보락 S10 MaxV Ultra 직배수 배터리 사용시간",
    depth: "basic",
    siblingTokens: [], // 얘가 오히려 "직배수 없는 버전"과 섞이는지 확인하려면 content에서 별도 체크 필요(아래 특수 로직)
  },
  {
    label: "삼성전자 비스포크 AI 스팀 울트라 VR90F01AAG 흡입력",
    query: "삼성전자 비스포크 AI 스팀 울트라 VR90F01AAG 흡입력",
    depth: "basic",
    siblingTokens: ["VR90F01SAG", "VR90F01AAH", "직배수"],
  },
  {
    label: "삼성전자 비스포크 AI 스팀 울트라 직배수 VR90F01SAG 흡입력",
    query: "삼성전자 비스포크 AI 스팀 울트라 직배수 VR90F01SAG 흡입력",
    depth: "basic",
    siblingTokens: ["VR90F01AAG", "VR90F01AAH"],
  },
  {
    label: "SONY 알파 A7 V 바디 손떨림보정",
    query: "SONY 알파 A7 V 바디 손떨림보정",
    depth: "basic",
    siblingTokens: ["A7C II", "A7R VI", "A7CR"],
  },
  {
    label: "SONY 알파 A7C II 바디 동영상 해상도",
    query: "SONY 알파 A7C II 바디 동영상 해상도",
    depth: "basic",
    siblingTokens: ["A7 V", "A7R VI"],
  },
  {
    label: "캐논 파워샷 V1 무게",
    query: "캐논 파워샷 V1 무게",
    depth: "basic",
    siblingTokens: [],
  },
  {
    label: "후지필름 INSTAX 미니 에보 즉석필름크기",
    query: "후지필름 INSTAX 미니 에보 즉석필름크기",
    depth: "basic",
    siblingTokens: ["미니12", "미니 12"],
  },
];

const LOW_TRUST = ["tistory.com", "blog.naver.com", "namu.wiki", "youtube.com", "reddit.com", "cafe.naver.com"];
const NUM_PATTERN = /(\d[\d,.]*\s*(?:dB|Pa|mAh|분|시간|kg|g|mL|L|원|rpm|W))/gi;

async function tavilySearch(query, depth, maxResults = 5) {
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
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function analyzeResult(query, r, siblingTokens) {
  const keywords = query.split(/\s+/).filter((k) => k.length >= 2);
  const contentLower = r.content.toLowerCase();
  const hits = keywords.filter((k) => contentLower.includes(k.toLowerCase()));
  const hitRatio = hits.length / keywords.length;

  const isLowTrust = LOW_TRUST.some((d) => r.url.includes(d));
  const nums = [...new Set((r.content.match(NUM_PATTERN) ?? []).slice(0, 8))];
  const siblingHits = siblingTokens.filter((t) => contentLower.includes(t.toLowerCase()));

  return { hits, hitRatio, isLowTrust, nums, siblingHits };
}

async function run() {
  const lines = [];
  lines.push(`# Tavily API 응답 점검 리포트`);
  lines.push(``);
  lines.push(`생성 시각: ${new Date().toLocaleString("ko-KR")}`);
  lines.push(``);
  lines.push(
    `실제 DB(\`data/products-*.json\`)에 존재하는 "형제 제품" 쌍(예: 로보락 S10 MaxV Ultra / 직배수, ` +
    `삼성 비스포크 VR90F01AAG / VR90F01SAG / VR90F01AAH)을 의도적으로 포함시켜, ` +
    `Tavily 검색 결과에 형제 모델의 스펙이 섞여 들어오는지(cross-contamination)를 자동 점검했다.`
  );
  lines.push(``);

  const summary = [];

  for (const c of CASES) {
    console.log(`\n[QUERY] "${c.query}"`);
    lines.push(`---`);
    lines.push(``);
    lines.push(`## "${c.label}"`);
    lines.push(``);
    lines.push(`- Query: \`${c.query}\``);
    lines.push(`- Depth: ${c.depth}`);
    if (c.siblingTokens.length > 0) {
      lines.push(`- 형제 제품 감시 토큰: ${c.siblingTokens.map((t) => `\`${t}\``).join(", ")}`);
    }
    lines.push(``);

    let data;
    try {
      data = await tavilySearch(c.query, c.depth);
    } catch (err) {
      lines.push(`**요청 실패**: ${err.message}`);
      lines.push(``);
      summary.push({ label: c.label, status: "ERROR", detail: err.message });
      continue;
    }

    if (data.answer) {
      lines.push(`**AI Answer**: ${data.answer}`);
      lines.push(``);
    }

    const results = data.results ?? [];
    lines.push(`**결과 ${results.length}건**`);
    lines.push(``);

    let anySiblingHit = false;
    let lowTrustCount = 0;
    let missCount = 0;

    results.forEach((r, i) => {
      const a = analyzeResult(c.query, r, c.siblingTokens);
      if (a.siblingHits.length > 0) anySiblingHit = true;
      if (a.isLowTrust) lowTrustCount++;
      if (a.hitRatio < 0.3) missCount++;

      const status = a.hitRatio >= 0.5 ? "OK" : a.hitRatio >= 0.3 ? "WARN" : "MISS";
      lines.push(`### [${i + 1}] score=${r.score.toFixed(3)} | keyword hit ${Math.round(a.hitRatio * 100)}% [${status}]${a.isLowTrust ? " | ⚠️ 저신뢰 도메인" : ""}${a.siblingHits.length > 0 ? ` | 🚨 형제제품 토큰 감지: ${a.siblingHits.join(", ")}` : ""}`);
      lines.push(`- URL: ${r.url}`);
      lines.push(`- Title: ${r.title}`);
      lines.push(`- 수치 감지: ${a.nums.length > 0 ? a.nums.join(", ") : "(없음)"}`);
      lines.push(`- Content:`);
      lines.push("  ```");
      lines.push("  " + r.content.slice(0, 600).replace(/\n/g, "\n  "));
      lines.push("  ```");
      lines.push(``);
    });

    summary.push({
      label: c.label,
      status: anySiblingHit ? "🚨 SIBLING RISK" : missCount === results.length && results.length > 0 ? "MISS" : "OK",
      detail: `results=${results.length}, lowTrust=${lowTrustCount}, miss=${missCount}, siblingHit=${anySiblingHit}`,
    });
  }

  lines.push(`---`);
  lines.push(``);
  lines.push(`## 요약`);
  lines.push(``);
  lines.push(`| 쿼리 | 상태 | 상세 |`);
  lines.push(`|---|---|---|`);
  for (const s of summary) {
    lines.push(`| ${s.label} | ${s.status} | ${s.detail} |`);
  }
  lines.push(``);

  const outPath = "scripts/tavily-debug-report.md";
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`\n리포트 저장 완료: ${outPath}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
