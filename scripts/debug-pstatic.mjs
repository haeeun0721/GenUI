import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "danawa_search.html"), "utf-8");

// Find all pstatic URLs and their surrounding context (class name)
const pstaticMatches = [...html.matchAll(/src="(https?:\/\/shopping-phinf\.pstatic\.net[^"]+)"/g)];
console.log(`pstatic 이미지 총 ${pstaticMatches.length}개:\n`);

for (const m of pstaticMatches.slice(0, 9)) {
  const ctx = html.slice(Math.max(0, m.index - 100), m.index + m[0].length + 100);
  // Extract class from same img tag
  const classMatch = ctx.match(/class="([^"]+)"/);
  const altMatch = ctx.match(/alt="([^"]{0,60})"/);
  console.log(`URL: ${m[1].slice(0, 80)}`);
  console.log(`  class: ${classMatch?.[1] ?? '없음'}`);
  console.log(`  alt: ${altMatch?.[1] ?? '없음'}`);
  console.log();
}

// How far is each pstatic image from the nearest prod_name?
console.log("=== prod_name 기준 pstatic 이미지 거리 ===");
const prodNames = [...html.matchAll(/class="prod_name"/g)];
console.log(`prod_name 수: ${prodNames.length}`);

for (const imgM of pstaticMatches.slice(0, 5)) {
  // Find nearest prod_name
  let nearest = null;
  let minDist = Infinity;
  for (const pnM of prodNames) {
    const dist = Math.abs(imgM.index - pnM.index);
    if (dist < minDist) { minDist = dist; nearest = pnM; }
  }
  console.log(`img at ${imgM.index} → nearest prod_name at ${nearest?.index} (거리: ${minDist}자)`);
}
