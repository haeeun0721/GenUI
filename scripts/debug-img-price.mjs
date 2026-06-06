import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use general search HTML (more products)
const html = readFileSync(join(__dirname, "danawa_search.html"), "utf-8");

// Find first prod_name
const idx = html.indexOf('class="prod_name"');
if (idx < 0) { console.log("prod_name not found"); process.exit(1); }

// Check 5000 chars BEFORE prod_name for image
const before = html.slice(Math.max(0, idx - 5000), idx);
console.log("=== Image patterns (before prod_name) ===");
const imgMatches = [...before.matchAll(/(src|data-src)="([^"]*danawa[^"]*\.(jpg|png|gif|webp)[^"]*)"/g)];
imgMatches.slice(0, 5).forEach(m => console.log(m[0].slice(0, 100)));

// Check 3000 chars AFTER prod_name for price
const after = html.slice(idx, idx + 3000);
console.log("\n=== Price patterns (after prod_name) ===");
const priceClass = [...after.matchAll(/class="[^"]*price[^"]*"[^>]*>([^<]{1,60})/g)];
priceClass.slice(0, 5).forEach(m => console.log(m[0].slice(0, 100)));

const numPrices = [...after.matchAll(/[0-9,]{5,}\s*원/g)];
numPrices.slice(0, 5).forEach(m => console.log("  NUM:", m[0]));

// Also check: what does the full product card block look like?
console.log("\n=== Full context 500 chars around prod_name ===");
console.log(html.slice(Math.max(0, idx - 500), idx + 500));
