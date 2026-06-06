import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "danawa_search.html"), "utf-8");

// Check if image__thumb pattern exists
const imgMatches = [...html.matchAll(/class="image__thumb"\s+src="([^"]+)"/g)];
console.log(`image__thumb 수: ${imgMatches.length}`);
imgMatches.slice(0, 5).forEach((m, i) => console.log(`  [${i}] ${m[1].slice(0, 100)}`));

// Also try reversed attribute order
const imgMatches2 = [...html.matchAll(/src="([^"]+)"\s[^>]*class="image__thumb"/g)];
console.log(`\nReversed order 수: ${imgMatches2.length}`);
imgMatches2.slice(0, 3).forEach((m, i) => console.log(`  [${i}] ${m[1].slice(0, 100)}`));

// Find any image__thumb tag
const thumbTags = [...html.matchAll(/image__thumb[^>]{0,200}/g)];
console.log(`\nimage__thumb 전체 태그 (첫 3개):`);
thumbTags.slice(0, 3).forEach(m => console.log(" ", m[0].slice(0, 150)));

// Check for phinf.pstatic.net (Naver Shopping image CDN)
const phinf = [...html.matchAll(/phinf\.pstatic\.net[^"']{0,100}/g)];
console.log(`\npstatic 이미지 수: ${phinf.length}`);
phinf.slice(0, 3).forEach(m => console.log("  https://shopping-" + m[0].slice(0, 80)));
