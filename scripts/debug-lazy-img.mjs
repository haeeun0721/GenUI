import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "danawa_search.html"), "utf-8");

// prod_name 이후 영역(1.4M+)에서 이미지 패턴 찾기
const prodSection = html.slice(1394000); // prod_name 이후
console.log(`prod_name 이후 섹션 길이: ${prodSection.length}`);

// data-original, data-src, data-lazy 확인
const lazyPatterns = [
  /data-original="([^"]+)"/g,
  /data-src="([^"]+)"/g,
  /data-lazy="([^"]+)"/g,
  /data-img="([^"]+)"/g,
];

for (const pattern of lazyPatterns) {
  const matches = [...prodSection.matchAll(pattern)];
  if (matches.length > 0) {
    const attrName = pattern.source.split('"')[0].replace("data-", "data-");
    console.log(`\n${pattern.source.split('"')[0]}: ${matches.length}개`);
    matches.slice(0, 3).forEach(m => console.log("  ", m[1].slice(0, 100)));
  }
}

// src= 속성 전체 (이미지 url 포함)
const srcMatches = [...prodSection.matchAll(/src="(https?:\/\/[^"]+\.(jpg|png|webp|gif)[^"]*?)"/g)];
console.log(`\nsrc 이미지 총: ${srcMatches.length}`);
srcMatches.slice(0, 10).forEach((m, i) => console.log(`  [${i}] ${m[1].slice(0, 100)}`));

// img 태그 전체 보기 (첫 5개)
const imgTags = [...prodSection.matchAll(/<img[^>]+>/g)];
console.log(`\nimg 태그 총: ${imgTags.length}`);
imgTags.slice(0, 5).forEach((m, i) => console.log(`  [${i}] ${m[0].slice(0, 200)}`));
