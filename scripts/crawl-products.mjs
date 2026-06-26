/**
 * scripts/crawl-products.mjs
 * 다나와에서 유모차 상품을 크롤링하여 data/products-유모차.json 으로 저장.
 * 실행: node scripts/crawl-products.mjs
 */

import * as cheerio from "cheerio";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── 설정 ──────────────────────────────────────────────────────────────────
const CATEGORY = "유모차";
const TOTAL_PAGES = 8;       // 페이지당 ~30개 × 8 = ~240개
const DETAIL_CONCURRENCY = 5; // 상세페이지 동시 요청 수 (너무 높으면 차단됨)
const DELAY_MS = 300;         // 요청 간 딜레이

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  Referer: "https://www.danawa.com/",
};

const PLACEHOLDER = ["noImg_160.gif", "noData", "no_image", "blank.gif", "loading."];
const isPlaceholder = (url) => !url || url.startsWith("data:") || PLACEHOLDER.some((p) => url.includes(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 유틸 ──────────────────────────────────────────────────────────────────
function normalizeImg(url, productLink) {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) {
    try { return `${new URL(productLink).origin}${url}`; } catch {}
  }
  return url;
}

const KNOWN_BRANDS = [
  "부가부", "줄즈", "베이비젠", "스토케", "마클라렌", "사이벡스", "싸이벡스",
  "누나", "조이", "치코", "페도라", "디트로네", "콤비", "리안", "에그", "오이스터",
  "오르빗", "오브맘", "잉글레시나", "쉬크", "제스파", "UPPAbaby",
];

function extractBrand(name) {
  for (const b of KNOWN_BRANDS) {
    if (name.toLowerCase().includes(b.toLowerCase())) return b;
  }
  return name.split(/\s+/)[0] ?? "";
}

// ── Step 1: 목록 페이지 크롤링 ────────────────────────────────────────────
async function scrapeListPage(page) {
  const url = `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(CATEGORY)}&tab=goods&page=${page}`;
  console.log(`  [LIST] Page ${page}: ${url}`);

  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) { console.warn(`  [LIST] HTTP ${res.status}`); return []; }

  const html = await res.text();
  const $ = cheerio.load(html);
  const items = [];

  $("ul.product_list > li.prod_item").each((i, el) => {
    const elId = $(el).attr("id") ?? "";
    if (elId.startsWith("ad") || elId.startsWith("Ad")) return;

    const nameEl = $(el).find(".prod_name a").first();
    const name = nameEl.text().trim();
    if (!name) return;

    const href = nameEl.attr("href") ?? "";
    const link = href.startsWith("http") ? href : `https://www.danawa.com${href}`;
    const priceText = $(el).find(".price_sect strong").first().text().replace(/[^\d,]/g, "").trim();
    const price = priceText ? `${priceText}원` : "가격 미정";
    const imgEl = $(el).find(".thumb_link img, .thumb_image img").first();
    const rawImg = [
      imgEl.attr("data-src"), imgEl.attr("data-original"),
      imgEl.attr("data-lazy"), imgEl.attr("src"),
    ].find((c) => c && !isPlaceholder(c)) ?? "";
    const image = normalizeImg(rawImg, link);
    const specText = $(el).find(".spec_list").text().trim();
    const basicSpecs = specText ? specText.split("/").map((s) => s.trim()).filter(Boolean).slice(0, 6) : [];

    items.push({ name, price, image, link, brand: extractBrand(name), basicSpecs });
  });

  console.log(`  [LIST] Page ${page}: ${items.length} products`);
  return items;
}

// ── Step 2: 상세 페이지 스크래핑 ──────────────────────────────────────────
async function scrapeDetail(link) {
  try {
    const res = await fetch(link, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { specs: [], description: "" };

    const html = await res.text();
    const $ = cheerio.load(html);
    const specs = [];
    const seen = new Set();

    const add = (label, value) => {
      const key = `${label.trim()}: ${value.trim()}`;
      if (label.trim() && value.trim() && value.trim() !== "-" && !seen.has(key)) {
        seen.add(key);
        specs.push(key);
      }
    };

    // 스펙 테이블 (모든 형태)
    $(`
      .spec_list_wrap .spec_tbl tr, .spec_tbl tr,
      .detail_spec table tr, .prod_spec_table tr,
      .spec_info_area table tr, .detail_info_wrap table tr,
      .tbl_wrap table tr, table.spec tr
    `).each((_, row) => {
      add($(row).find("th").text().trim(), $(row).find("td").text().trim().replace(/\s+/g, " "));
    });

    // dl/dt/dd
    $(".spec_list dl, .spec_list_wrap dl, .prod_spec dl").each((_, dl) => {
      add($(dl).find("dt").text().trim(), $(dl).find("dd").text().trim().replace(/\s+/g, " "));
    });

    // li 항목
    if (specs.length < 5) {
      $(".spec_list > li").each((_, el) => {
        const text = $(el).text().trim().replace(/\s+/g, " ");
        if (text && text.length > 2 && !seen.has(text)) { seen.add(text); specs.push(text); }
      });
    }

    // 주요 특징
    $(".prod_point_list li, .prod_sticker span, .point_list li").each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, " ");
      if (text && text.length > 2 && text.length < 60 && !seen.has(text)) {
        seen.add(text); specs.push(`특징: ${text}`);
      }
    });

    const description = $(".item_intro_content, .prod_description, .prod_intro_area, .prod_summary_area")
      .first().text().trim().replace(/\s+/g, " ").slice(0, 500) || "";

    return { specs: specs.slice(0, 30), description };
  } catch (err) {
    console.warn(`  [DETAIL] Failed: ${link.slice(0, 60)}: ${err.message}`);
    return { specs: [], description: "" };
  }
}

// ── 배치 처리 (동시성 제한) ───────────────────────────────────────────────
async function batchProcess(items, fn, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    process.stdout.write(`  [DETAIL] ${Math.min(i + concurrency, items.length)}/${items.length} done\r`);
    if (i + concurrency < items.length) await sleep(DELAY_MS);
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 다나와 크롤링 시작: "${CATEGORY}" (${TOTAL_PAGES} 페이지)\n`);

  // 1. 목록 페이지 순차 크롤링
  const allBasic = [];
  const seenNames = new Set();

  for (let page = 1; page <= TOTAL_PAGES; page++) {
    const items = await scrapeListPage(page);
    for (const item of items) {
      if (!seenNames.has(item.name)) {
        seenNames.add(item.name);
        allBasic.push(item);
      }
    }
    await sleep(DELAY_MS);
  }

  console.log(`\n✅ 목록 수집 완료: 총 ${allBasic.length}개 (중복 제거)\n`);

  // 2. 상세 페이지 병렬 크롤링
  console.log(`🔍 상세 스펙 크롤링 중... (동시 ${DETAIL_CONCURRENCY}개)\n`);
  const details = await batchProcess(allBasic, (item) => scrapeDetail(item.link), DETAIL_CONCURRENCY);

  // 3. 데이터 통합
  const products = allBasic.map((item, i) => ({
    id: `${CATEGORY}-${i}`,
    category: CATEGORY,
    name: item.name,
    price: item.price,
    image: item.image,
    link: item.link,
    brand: item.brand,
    specs: details[i].specs.length > 0 ? details[i].specs : item.basicSpecs,
    description: details[i].description || item.name,
    crawledAt: new Date().toISOString(),
  }));

  // 4. 저장
  const dataDir = join(ROOT, "data");
  mkdirSync(dataDir, { recursive: true });
  const outPath = join(dataDir, `products-${CATEGORY}.json`);
  writeFileSync(outPath, JSON.stringify(products, null, 2), "utf8");

  console.log(`\n\n🎉 저장 완료: ${outPath}`);
  console.log(`   총 ${products.length}개 상품`);
  console.log(`   스펙 있는 상품: ${products.filter((p) => p.specs.length > 0).length}개`);
  console.log(`   평균 스펙 수: ${(products.reduce((a, p) => a + p.specs.length, 0) / products.length).toFixed(1)}개`);
}

main().catch(console.error);
