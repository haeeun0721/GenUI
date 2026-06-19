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

const QUERY = "로보락 S5 Max";
const url = `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(QUERY)}&limit=5&sort=pd`;

console.log(`Scraping: ${url}`);
const result = await app.scrape(url, { formats: ["html"], waitFor: 5000 });
const html = result?.html ?? "";
writeFileSync(join(__dirname, "danawa_debug.html"), html, "utf-8");
console.log(`HTML 길이: ${html.length}자`);

// 1. spec_list 확인
const specMatches = [...html.matchAll(/<div[^>]+class="[^"]*spec_list[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
console.log(`\nspec_list 수: ${specMatches.length}`);
specMatches.slice(0, 3).forEach((m, i) => {
  const text = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  console.log(`  [${i}] (${text.length}자): ${text.slice(0, 120)}`);
});

// 2. prod_name class 확인
const nameMatches = [...html.matchAll(/class="([^"]*prod_name[^"]*)"/g)];
console.log(`\nprod_name class 수: ${nameMatches.length}`);
nameMatches.slice(0, 3).forEach((m, i) => {
  const start = m.index - 10;
  const snippet = html.slice(start, m.index + 300).replace(/\n/g, " ");
  console.log(`  [${i}]: ...${snippet.slice(0, 200)}...`);
});

// 3. 실제 product name 패턴 탐색
console.log("\n다른 class명 탐색 (name, title, product):");
const classMatches = [...html.matchAll(/class="([^"]*(?:prod|item|name|title)[^"]*)"/g)];
const classes = [...new Set(classMatches.map(m => m[1]))].slice(0, 15);
classes.forEach(c => console.log("  ", c));

// 4. pcode 수
const pcodes = [...new Set([...html.matchAll(/pcode=(\d+)/g)].map(m => m[1]))];
console.log(`\npcode 수: ${pcodes.length}, 처음 3개: ${pcodes.slice(0, 3)}`);
