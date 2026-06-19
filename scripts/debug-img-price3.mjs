import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "danawa_search.html"), "utf-8");

console.log("Total HTML:", html.length, "chars");

// 1. 전체 HTML에서 img.danawa.com 패턴 찾기
console.log("\n=== img.danawa.com ALL occurrences (first 10) ===");
const allImgs = [...html.matchAll(/img\.danawa\.com[^"'\s>]{5,100}/g)];
console.log("Total danawa img refs:", allImgs.length);
allImgs.slice(0, 10).forEach(m => console.log("  ", m[0]));

// 2. 가격 관련 숫자 패턴 전체
console.log("\n=== All 원 occurrences (first 10) ===");
const allPrices = [...html.matchAll(/[0-9,]{5,}\s*원/g)];
console.log("Total 원 occurrences:", allPrices.length);
allPrices.slice(0, 10).forEach(m => console.log("  ", m[0]));

// 3. 출시가 패턴
console.log("\n=== 출시가 pattern ===");
const startPrices = [...html.matchAll(/출시가[^<]{1,30}/g)];
startPrices.slice(0, 5).forEach(m => console.log("  ", m[0]));

// 4. pcode=108229415 주변 이미지
const pcode = "108229415";
const pcodeIdx = html.indexOf(`pcode=${pcode}`);
console.log(`\n=== Around pcode=${pcode} (3000 chars context) ===`);
if (pcodeIdx > 0) {
  const ctx = html.slice(Math.max(0, pcodeIdx - 3000), pcodeIdx + 500);
  // img tags
  const imgs = [...ctx.matchAll(/<img[^>]+>/g)];
  imgs.forEach(m => console.log("IMG:", m[0].slice(0, 150)));
}
