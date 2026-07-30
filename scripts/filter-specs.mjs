/**
 * scripts/filter-specs.mjs
 * products-*.json에서 의사결정에 무관한 노이즈 스펙을 제거하고 재저장.
 * 실행: node scripts/filter-specs.mjs [카테고리]
 *   예: node scripts/filter-specs.mjs 로봇 청소기
 *   예: node scripts/filter-specs.mjs 카메라
 *   예: node scripts/filter-specs.mjs  (전체 처리)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── 공통 노이즈 키 (모든 카테고리에 해당) ─────────────────────────────────
const COMMON_NOISE_KEYS = new Set([
  "적합성평가인증",
  "안전확인인증",
  "전파인증",
  "KC인증",
  "에너지소비효율등급",
  "제조회사",    // brand 필드로 이미 있음
  "품목",        // category로 이미 있음
]);

// ── 값에 이 패턴이 있으면 제거 (인증번호, 홍보문구 등) ────────────────────
const NOISE_VALUE_PATTERNS = [
  /인증번호\s*확인/,
  /판매\s*사이트\s*문의/,
  /상세설명/,
];

// ── 카테고리별 추가 노이즈 키 ─────────────────────────────────────────────
const CATEGORY_NOISE_KEYS = {
  "로봇 청소기": new Set([
    "삼성감사페스티벌",
    "쿠팡로켓",
    "LG전자페스티벌",
  ]),
  "카메라": new Set([
    "출시년도",    // 중요도 낮음
    "분류",        // 중복 (디카 분류와 겹침)
  ]),
  "유모차": new Set([
    "쳙산",
    "유모차",       // 카테고리명 자체
    "디럭스형",    // 분류 태그
    "절충형",
    "유아용품",
    "육아용품",
    "제조국",
    "AS센터",
    "출시년도",
    "제조화사명",
  ]),
};

// ── 키가 홍보성인지 판단 (브랜드명+이벤트명 패턴) ───────────────────────
function isPromotionalKey(key) {
  // 브랜드 행사 패턴: "삼성XXX", "LG전자XXX" 등이 value도 같은 단어인 경우
  return /페스티벌|이벤트|프로모션|기획전|할인|특가/.test(key);
}

// ── 스펙 필터 함수 ─────────────────────────────────────────────────────────
function filterSpecs(specs, category) {
  const categoryNoise = CATEGORY_NOISE_KEYS[category] ?? new Set();

  return specs.filter(spec => {
    const colonIdx = spec.indexOf(":");
    const key = colonIdx !== -1 ? spec.slice(0, colonIdx).trim() : spec.trim();
    const value = colonIdx !== -1 ? spec.slice(colonIdx + 1).trim() : "";

    // 1. 공통 노이즈 키
    if (COMMON_NOISE_KEYS.has(key)) return false;

    // 2. 카테고리별 노이즈 키
    if (categoryNoise.has(key)) return false;

    // 3. 홍보성 키
    if (isPromotionalKey(key)) return false;

    // 4. 노이즈 값 패턴
    if (NOISE_VALUE_PATTERNS.some(p => p.test(value))) return false;

    // 5. 빈 값
    if (!key || (!value && colonIdx !== -1)) return false;

    return true;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────
async function processCategory(category) {
  const filePath = join(ROOT, "data", `products-${category}.json`);
  if (!existsSync(filePath)) {
    console.warn(`⚠️  ${filePath} 없음 — 건너뜀`);
    return;
  }

  const products = JSON.parse(readFileSync(filePath, "utf8"));
  const before = products.reduce((s, p) => s + p.specs.length, 0);

  const filtered = products.map(p => ({
    ...p,
    specs: filterSpecs(p.specs, category),
  }));

  const after = filtered.reduce((s, p) => s + p.specs.length, 0);
  const removed = before - after;

  writeFileSync(filePath, JSON.stringify(filtered, null, 2), "utf8");

  console.log(`✅ [${category}] ${products.length}개 제품`);
  console.log(`   스펙 제거: ${before} → ${after} (${removed}개 제거, ${((removed/before)*100).toFixed(1)}%)`);

  // 상위 스펙 키 재집계
  const keyCount = {};
  filtered.forEach(p => p.specs.forEach(s => {
    const key = s.split(":")[0].trim();
    keyCount[key] = (keyCount[key] || 0) + 1;
  }));
  const top10 = Object.entries(keyCount).sort((a,b) => b[1]-a[1]).slice(0, 10);
  console.log(`   잔존 스펙 TOP 10:`);
  top10.forEach(([k, v]) => console.log(`     ${v}개\t${k}`));
  console.log();
}

const targetCategories = process.argv[2]
  ? [process.argv.slice(2).join(" ")]
  : ["유모차", "로봇 청소기", "카메라"];

console.log(`\n🧹 스펙 노이즈 필터링 시작: [${targetCategories.join(", ")}]\n`);
for (const cat of targetCategories) {
  await processCategory(cat);
}
console.log("🎉 완료. 변경된 카테고리는 embed-products.mjs를 다시 실행하세요.");
