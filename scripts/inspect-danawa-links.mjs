import FirecrawlApp from "firecrawl";
import { readFileSync } from "fs";
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

// links 포맷 — 페이지에서 모든 링크 추출
const result = await app.scrape(
  "https://search.danawa.com/dsearch.php?query=로봇청소기&limit=10&sort=pd",
  { formats: ["links"], waitFor: 4000 }
);

const allLinks = result?.links ?? [];
console.log(`전체 링크 수: ${allLinks.length}`);

// pcode 있는 prod.danawa.com 링크만 필터
const productLinks = [...new Set(
  allLinks.filter(l => l.includes("prod.danawa.com/info") && l.includes("pcode="))
)];

console.log(`\n제품 페이지 링크 수: ${productLinks.length}`);
console.log("\n--- 추출된 pcode 링크 ---");
productLinks.slice(0, 15).forEach((l, i) => {
  const pcode = l.match(/pcode=(\d+)/)?.[1] ?? "?";
  console.log(`${i+1}. pcode=${pcode} → ${l.slice(0, 80)}`);
});
