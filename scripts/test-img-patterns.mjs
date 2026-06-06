import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "danawa_search.html"), "utf-8");

// Get first 10 pcodes from the HTML
const pcodes = [...new Set([...html.matchAll(/pcode=(\d+)/g)].map(m => m[1]))].slice(0, 10);
console.log("Testing pcodes:", pcodes);

// Test different image URL patterns
const patterns = [
  (pcode) => {
    const p = pcode.padStart(9, "0");
    return `https://img.danawa.com/prod_img/500000/${p.slice(-3)}/${p.slice(-6,-3)}/img/${pcode}_1.jpg`;
  },
  (pcode) => {
    const p = pcode.padStart(9, "0");
    return `https://img.danawa.com/images/prodImg/500000/${p.slice(-3)}/${p.slice(-6,-3)}/img/${pcode}_1.jpg`;
  },
  (pcode) => {
    const p = pcode.padStart(9, "0");
    return `https://img.danawa.com/prod_img/500000/${p.slice(-3)}/${p.slice(-6,-3)}/img/${pcode}_1.png`;
  },
  (pcode) => {
    // shorter pcode might use different depth
    const p = String(pcode);
    if (p.length <= 6) {
      return `https://img.danawa.com/prod_img/500000/${p.slice(-3)}/${p.slice(-6,-3) || '000'}/img/${pcode}_1.jpg`;
    }
    return null;
  },
];

for (const pcode of pcodes.slice(0, 5)) {
  console.log(`\n── pcode=${pcode} ──`);
  for (let i = 0; i < patterns.length; i++) {
    const url = patterns[i](pcode);
    if (!url) continue;
    try {
      const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
      if (res.status === 200) {
        console.log(`  ✅ Pattern ${i}: ${url.slice(40, 100)}`);
        break;
      }
    } catch {
      // timeout
    }
  }
}

// Also check price in HTML for these products
console.log("\n\n── Price patterns in HTML ──");
const priceMatches = [...html.matchAll(/([0-9,]{5,})원/g)];
console.log(`Total '원' hits: ${priceMatches.length}`);
priceMatches.slice(0, 15).forEach(m => console.log(" ", m[0]));
