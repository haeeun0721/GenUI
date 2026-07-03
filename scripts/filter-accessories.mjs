/**
 * 유모차 JSON에서 액세서리/관련용품 제거
 * 실행: node scripts/filter-accessories.mjs
 */
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// 제품 자체가 액세서리인 경우를 판단하는 키워드
// (이 단어들이 제품의 핵심 설명인 경우 제외)
const ACCESSORY_KEYWORDS = [
  "커버", "모기장", "블랭킷", "손잡이", "방풍커버", "방한커버",
  "레인커버", "가방", "파우치", "매트", "쿠션", "트레이",
  "식판", "컵홀더", "발판", "우비", "팔걸이", "보냉백", "보온파우치",
  "핸들커버", "거즈", "개모차", "강아지", "고양이", "반려", "펫",
  "애견", "카시트", "확장바",
];

// 이 단어가 있으면 무조건 유모차로 인정
const STROLLER_MUST_KEEP = [
  "절충형", "디럭스형", "휴대용", "기내반입", "쌍둥이", "폴딩",
  "오토폴딩", "양대면",
];

function isAccessory(name) {
  // 유명 유모차 브랜드라면 유지
  const brands = [
    "부가부", "줄즈", "베이비젠", "스토케", "마클라렌", "싸이벡스", "사이벡스",
    "누나", "조이", "치코", "페도라", "디트로네", "콤비", "리안", "에그", "오이스터",
    "오르빗", "오브맘", "잉글레시나", "쉬크", "베이블퓨어리", "다이치", "웰본",
    "UPPAbaby", "베이비조거", "무무브", "피에고", "해피박스",
  ];
  if (brands.some(b => name.toLowerCase().includes(b.toLowerCase()))) {
    // 브랜드가 있더라도 주 제품이 액세서리면 제외
    const accessorySuffixes = ["커버", "모기장", "블랭킷", "가방", "파우치", "손잡이커버", "핸들커버"];
    if (accessorySuffixes.some(s => name.trim().endsWith(s))) return true;
    if (name.includes("맘네스트")) return true; // 맘네스트는 액세서리 전문 브랜드
    return false;
  }

  // 유모차 필수 키워드가 있으면 유지
  if (STROLLER_MUST_KEEP.some(k => name.includes(k))) return false;

  // 액세서리 키워드가 있으면 제외
  if (ACCESSORY_KEYWORDS.some(k => name.includes(k))) return true;

  return false;
}

// ── products-유모차.json 정리 ────────────────────────────────────────────
const productsPath = join(ROOT, "data", "products-유모차.json");
const products = JSON.parse(readFileSync(productsPath, "utf8"));

const beforeCount = products.length;
const filtered = products.filter(p => !isAccessory(p.name));
const removedProducts = products.filter(p => isAccessory(p.name));

writeFileSync(productsPath, JSON.stringify(filtered, null, 2), "utf8");

console.log(`\n📦 products-유모차.json`);
console.log(`  이전: ${beforeCount}개 → 이후: ${filtered.length}개 (${removedProducts.length}개 제거)`);
console.log(`\n제거된 제품:`);
removedProducts.forEach(p => console.log(`  - ${p.name.slice(0, 60)}`));

// ── reviews-유모차.json 정리 ────────────────────────────────────────────
const reviewsPath = join(ROOT, "data", "reviews-유모차.json");
const reviews = JSON.parse(readFileSync(reviewsPath, "utf8"));

const filteredIds = new Set(filtered.map(p => p.id));
const filteredReviews = Object.fromEntries(
  Object.entries(reviews).filter(([id]) => filteredIds.has(id))
);

writeFileSync(reviewsPath, JSON.stringify(filteredReviews, null, 2), "utf8");
console.log(`\n📝 reviews-유모차.json`);
console.log(`  이전: ${Object.keys(reviews).length}개 → 이후: ${Object.keys(filteredReviews).length}개`);
console.log(`\n✅ 완료`);
