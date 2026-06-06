import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "danawa_search.html"), "utf-8");

const idx = html.indexOf('class="prod_name"');
console.log("prod_name at index:", idx);

// ── IMAGE: check data-original, data-src, etc. in wider backward window
const before = html.slice(Math.max(0, idx - 8000), idx);
console.log("\n=== All image-like attributes (before prod_name, 8000 chars) ===");
const dataImg = [...before.matchAll(/(data-original|data-src|data-lazy)="([^"]+)"/g)];
dataImg.slice(0, 5).forEach(m => console.log(m[1], "→", m[2].slice(0, 100)));

// Also check regular src with img.danawa
const srcImg = [...before.matchAll(/src="(https?:\/\/img\.danawa[^"]+)"/g)];
srcImg.slice(0, 5).forEach(m => console.log("src →", m[1].slice(0, 100)));

// ── PRICE: check further forward (spec_list is ~2000 chars, price comes after)
const after = html.slice(idx, idx + 6000);
console.log("\n=== Price patterns (after prod_name, 6000 chars) ===");
const priceEl = [...after.matchAll(/class="[^"]*(?:price|pricelist|lowest)[^"]*"[^>]*>([\s\S]{0,200}?)<\/(?:div|span|p)/g)];
priceEl.slice(0, 5).forEach(m => {
  const text = m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  console.log("→", text.slice(0, 80));
});

// ── COMBINED: look at 1000 chars right before spec_list (price often near spec)
const specIdx = after.indexOf('class="spec_list"');
if (specIdx > 0) {
  const nearSpec = after.slice(specIdx, specIdx + 3000);
  console.log("\n=== Price near spec_list ===");
  const priceNear = [...nearSpec.matchAll(/[0-9,]{5,}\s*원/g)];
  priceNear.slice(0, 5).forEach(m => console.log("  ", m[0]));
  
  // price class near spec
  const priceClass2 = [...nearSpec.matchAll(/class="[^"]*price[^"]*"[^>]*>([\s\S]{0,100}?)<\//g)];
  priceClass2.slice(0, 5).forEach(m => {
    console.log("  CLASS:", m[1].replace(/<[^>]+>/g, "").replace(/\s+/g," ").trim().slice(0,80));
  });
}
