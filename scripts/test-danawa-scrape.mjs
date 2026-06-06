import FirecrawlApp from "firecrawl";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Manually parse .env.local
try {
  const env = readFileSync(join(__dirname, "../.env.local"), "utf-8");
  for (const line of env.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
} catch {}

const apiKey = process.env.FIRECRAWL_API_KEY;
if (!apiKey) {
  console.error("❌ FIRECRAWL_API_KEY not set in .env.local");
  process.exit(1);
}

const app = new FirecrawlApp({ apiKey });

// ─── TEST 1: 다나와 검색 결과 페이지 ─────────────────────────────
const SEARCH_URL = "https://search.danawa.com/dsearch.php?query=로봇청소기&limit=5";

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("🔍 TEST 1: 다나와 검색 결과 스크래핑");
console.log(`URL: ${SEARCH_URL}`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

try {
  const searchResult = await app.scrape(SEARCH_URL, {
    formats: ["markdown"],
    waitFor: 4000,
  });

  const md = searchResult?.markdown ?? "";
  console.log(`✅ 성공! 내용 길이: ${md.length}자`);
  console.log("\n--- 상위 3000자 미리보기 ---");
  console.log(md.slice(0, 3000));
} catch (err) {
  console.error("❌ 검색 결과 스크래핑 실패:", err.message);
}

// ─── TEST 2: 다나와 개별 제품 스펙 페이지 ────────────────────────
// 로보락 S10 MaxV Slim 다나와 페이지 (공개 URL)
const PRODUCT_URL = "https://prod.danawa.com/info/?pcode=21617793";

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("🔍 TEST 2: 다나와 개별 제품 스펙 페이지");
console.log(`URL: ${PRODUCT_URL}`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

try {
  const specResult = await app.scrape(PRODUCT_URL, {
    formats: ["markdown"],
    waitFor: 5000,
  });

  const md = specResult?.markdown ?? "";
  console.log(`✅ 성공! 내용 길이: ${md.length}자`);
  console.log("\n--- 상위 3000자 미리보기 ---");
  console.log(md.slice(0, 3000));
} catch (err) {
  console.error("❌ 제품 스펙 페이지 스크래핑 실패:", err.message);
}
