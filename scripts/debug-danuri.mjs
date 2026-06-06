import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "danawa_search.html"), "utf-8");

// Find all danuri.io images and their distance from nearest prod_name
const prodNames = [...html.matchAll(/class="prod_name"/g)];
const danuriImgs = [...html.matchAll(/src="(https?:\/\/img\.danuri\.io[^"]+)"/g)];

console.log(`prod_name 수: ${prodNames.length}`);
console.log(`danuri.io 이미지 수: ${danuriImgs.length}\n`);

// For each prod_name, find the nearest danuri.io image
prodNames.slice(0, 5).forEach((pn, i) => {
  const pnIdx = pn.index;
  let nearest = null;
  let minDist = Infinity;
  for (const img of danuriImgs) {
    const dist = Math.abs(img.index - pnIdx);
    if (dist < minDist) { minDist = dist; nearest = img; }
  }
  // Check if image comes BEFORE or AFTER prod_name
  const direction = nearest && nearest.index < pnIdx ? "앞" : "뒤";
  console.log(`prod_name[${i}] at ${pnIdx}`);
  console.log(`  nearest img: ${nearest?.index} (거리: ${minDist}자, ${direction})`);
  console.log(`  url: ${nearest?.[1]?.slice(0, 80)}`);
  console.log();
});

// Check: are images always BEFORE prod_name?
let beforeCount = 0, afterCount = 0;
for (const pn of prodNames) {
  let nearest = null;
  let minDist = Infinity;
  for (const img of danuriImgs) {
    const dist = Math.abs(img.index - pn.index);
    if (dist < minDist) { minDist = dist; nearest = img; }
  }
  if (nearest) {
    if (nearest.index < pn.index) beforeCount++;
    else afterCount++;
  }
}
console.log(`이미지가 prod_name 앞: ${beforeCount}개, 뒤: ${afterCount}개`);
