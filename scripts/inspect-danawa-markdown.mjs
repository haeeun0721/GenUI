import FirecrawlApp from "firecrawl";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const env = readFileSync(join(__dirname, "../.env.local"), "utf-8");
  for (const line of env.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
} catch {}

const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

const SEARCH_URL = "https://search.danawa.com/dsearch.php?query=로봇청소기&limit=5&sort=pd";

console.log("Scraping Danawa search...");
const result = await app.scrape(SEARCH_URL, { formats: ["markdown"], waitFor: 4000 });
const md = result?.markdown ?? "";

// 전체 저장
writeFileSync(join(__dirname, "danawa_raw.md"), md, "utf-8");
console.log(`✅ 전체 markdown 저장 완료: danawa_raw.md (${md.length}자)`);

// 제품명으로 보이는 줄 주변 300자씩 출력
const lines = md.split("\n");
console.log("\n━━━━━━ 제품 카드 패턴 샘플 (처음 5개) ━━━━━━");
let found = 0;
for (let i = 0; i < lines.length && found < 5; i++) {
  const line = lines[i];
  // 가격 라인 또는 제품명 패턴 탐색
  if (/\d{3},\d{3}/.test(line) || /로봇청소기|robot|청소기/.test(line)) {
    const start = Math.max(0, i - 3);
    const end = Math.min(lines.length, i + 8);
    console.log(`\n--- 라인 ${i} 주변 ---`);
    console.log(lines.slice(start, end).join("\n"));
    found++;
  }
}
