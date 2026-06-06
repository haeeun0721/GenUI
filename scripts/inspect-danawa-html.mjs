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

console.log("Scraping Danawa search (HTML format)...");
const result = await app.scrape(
  "https://search.danawa.com/dsearch.php?query=로봇청소기&limit=5&sort=pd",
  { formats: ["html"], waitFor: 5000 }
);

const html = result?.html ?? "";
writeFileSync(join(__dirname, "danawa_search.html"), html, "utf-8");
console.log(`HTML 길이: ${html.length}자`);

// spec_list div 추출 테스트
const specMatches = [...html.matchAll(/<div[^>]+class="[^"]*spec_list[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
console.log(`\nspec_list 블록 수: ${specMatches.length}`);

if (specMatches.length > 0) {
  // 텍스트 내용만 추출 (태그 제거)
  const cleanText = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  specMatches.slice(0, 3).forEach((m, i) => {
    console.log(`\n--- spec_list ${i+1} ---`);
    console.log(cleanText(m[1]));
  });
} else {
  console.log("spec_list 없음 — 다른 class명 탐색:");
  // 비슷한 class 찾기
  const classMatches = [...html.matchAll(/class="([^"]*spec[^"]*)"/g)];
  const classes = [...new Set(classMatches.map(m => m[1]))].slice(0, 10);
  console.log("spec 포함 class:", classes);
}

// pcode + 제품명 + 가격 패턴 확인
const pcodeMatches = [...html.matchAll(/pcode=(\d+)/g)];
const pcodes = [...new Set(pcodeMatches.map(m => m[1]))];
console.log(`\n추출된 pcode 수: ${pcodes.length}`);
console.log("처음 5개:", pcodes.slice(0, 5));
