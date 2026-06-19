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

// ── TEST A: onlyMainContent 옵션 ──
console.log("=== TEST A: onlyMainContent: true ===");
const a = await app.scrape(
  "https://search.danawa.com/dsearch.php?query=로봇청소기&limit=5&sort=pd",
  { formats: ["markdown"], waitFor: 4000, onlyMainContent: true }
);
const mdA = a?.markdown ?? "";
writeFileSync(join(__dirname, "danawa_main.md"), mdA, "utf-8");
console.log(`길이: ${mdA.length}자`);
console.log("처음 3000자:\n", mdA.slice(0, 3000));

// ── TEST B: 다나와 카테고리 리스트 페이지 ──
console.log("\n=== TEST B: 카테고리 리스트 페이지 ===");
const b = await app.scrape(
  "https://prod.danawa.com/list/?cate=10243069&limit=5",
  { formats: ["markdown"], waitFor: 4000, onlyMainContent: true }
);
const mdB = b?.markdown ?? "";
writeFileSync(join(__dirname, "danawa_list.md"), mdB, "utf-8");
console.log(`길이: ${mdB.length}자`);
console.log("처음 3000자:\n", mdB.slice(0, 3000));
