/**
 * scripts/crawl-products.mjs
 * 다나와에서 유모차 상품을 크롤링하여 data/products-유모차.json 으로 저장.
 * - 목록 페이지: fetch (빠름)
 * - 상세 페이지: Puppeteer (JS 렌더링 후 스펙 테이블 완전 수집)
 * 실행: node scripts/crawl-products.mjs
 */

import * as cheerio from "cheerio";
import puppeteer from "puppeteer";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── 설정 ──────────────────────────────────────────────────────────────────
const CATEGORY = process.argv[2] || "유모차";
const TOTAL_PAGES = 8;        // 페이지당 ~30개 × 8 = ~240개
const DETAIL_CONCURRENCY = 3; // Puppeteer 탭 동시 수 (메모리 감안)
const DELAY_MS = 400;

console.log(`\n🔍 크롤링 카테고리: ${CATEGORY}\n`);

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  Referer: "https://www.danawa.com/",
};

// 카테고리별 브랜드 목록
const BRANDS_BY_CATEGORY = {
  "유모차": [
    "부가부", "줄즈", "베이비젠", "스토케", "마클라렌", "사이벡스", "싸이벡스",
    "누나", "조이", "치코", "페도라", "디트로네", "콤비", "리안", "에그", "오이스터",
    "오르빗", "오브맘", "잉글레시나", "쉬크", "제스파", "UPPAbaby",
  ],
  "로봇 청소기": [
    "다이슨", "로보락", "아이로봇", "에코백스", "삼성", "LG", "샤오미",
    "마미로봇", "아이클레보", "유진로봇", "나르왈", "드리미", "룸바", "Roomba",
    "Roborock", "Ecovacs", "Dyson", "Dreame", "Narwal",
  ],
};
const KNOWN_BRANDS = BRANDS_BY_CATEGORY[CATEGORY] ?? [];

// 카테고리별 필터링 키워드 (제목에 포함 시 제외)
const EXCLUDE_KEYWORDS_BY_CATEGORY = {
  "유모차": ["강아지", "개모차", "반려", "펫", "pet", "dog", "고양이", "애견", "냥이", "멍"],
  "로봇 청소기": ["부품", "필터", "걸레", "소모품", "먼지통", "배터리팩", "브러시"],
};
const EXCLUDE_KEYWORDS = EXCLUDE_KEYWORDS_BY_CATEGORY[CATEGORY] ?? [];

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

function extractBrand(name) {
  for (const b of KNOWN_BRANDS) {
    if (name.toLowerCase().includes(b.toLowerCase())) return b;
  }
  return name.split(/\s+/)[0] ?? "";
}

// ── Step 1: 목록 페이지 크롤링 (fetch 기반) ──────────────────────────────
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

    // slice 제거: 목록에서 보이는 스펙 전부 수집
    const specText = $(el).find(".spec_list").text().trim();
    const basicSpecs = specText
      ? specText.split("/").map((s) => s.trim()).filter(Boolean)
      : [];

    items.push({ name, price, image, link, brand: extractBrand(name), basicSpecs });
  });

  console.log(`  [LIST] Page ${page}: ${items.length} products`);
  return items;
}

// ── Step 2: 상세 페이지 크롤링 (Puppeteer 기반) ──────────────────────────
async function scrapeDetailWithPuppeteer(browserPage, link) {
  try {
    await browserPage.goto(link, { waitUntil: "domcontentloaded", timeout: 15000 });

    // 스펙 테이블이 JS 렌더링으로 나타날 때까지 최대 5초 대기
    await browserPage
      .waitForSelector(
        ".spec_tbl tr, .prod_spec_table tr, .spec_list_wrap tr, .detail_spec table tr",
        { timeout: 5000 }
      )
      .catch(() => {}); // 없으면 그냥 진행

    const result = await browserPage.evaluate(() => {
      const specs = [];
      const seen = new Set();

      const add = (label, value) => {
        const l = label.trim();
        const v = value.trim().replace(/\s+/g, " ");
        const key = `${l}: ${v}`;
        if (l && v && v !== "-" && v !== "" && !seen.has(key)) {
          seen.add(key);
          specs.push(key);
        }
      };

      // ① 스펙 테이블 (th/td 구조)
      document
        .querySelectorAll(
          ".spec_tbl tr, .prod_spec_table tr, .spec_list_wrap .spec_tbl tr, " +
          ".detail_spec table tr, .spec_info_area table tr, " +
          ".detail_info_wrap table tr, .tbl_wrap table tr, table.spec tr"
        )
        .forEach((row) => {
          const th = row.querySelector("th");
          const td = row.querySelector("td");
          if (th && td) add(th.textContent, td.textContent);
        });

      // ② dl/dt/dd 구조
      document
        .querySelectorAll(".spec_list dl, .spec_list_wrap dl, .prod_spec dl")
        .forEach((dl) => {
          const dt = dl.querySelector("dt");
          const dd = dl.querySelector("dd");
          if (dt && dd) add(dt.textContent, dd.textContent);
        });

      // ③ 주요 특징 뱃지
      document
        .querySelectorAll(".prod_point_list li, .prod_sticker span, .point_list li")
        .forEach((el) => {
          const text = el.textContent.trim().replace(/\s+/g, " ");
          if (text && text.length > 2 && text.length < 60 && !seen.has(text)) {
            seen.add(text);
            specs.push(`특징: ${text}`);
          }
        });

      // ④ li 항목 (스펙 테이블 없을 경우 fallback)
      if (specs.length < 5) {
        document.querySelectorAll(".spec_list > li").forEach((el) => {
          const text = el.textContent.trim().replace(/\s+/g, " ");
          if (text && text.length > 2 && !seen.has(text)) {
            seen.add(text);
            specs.push(text);
          }
        });
      }

      // ⑤ 상품 설명
      const descEl = document.querySelector(
        ".item_intro_content, .prod_description, .prod_intro_area, .prod_summary_area"
      );
      const description = descEl
        ? descEl.textContent.trim().replace(/\s+/g, " ").slice(0, 500)
        : "";

      return { specs: specs.slice(0, 40), description };
    });

    return result;
  } catch (err) {
    console.warn(`  [DETAIL] Failed: ${link.slice(0, 60)}: ${err.message}`);
    return { specs: [], description: "" };
  }
}

// ── 배치 처리 (Puppeteer 탭 풀 기반) ─────────────────────────────────────
async function batchDetailProcess(browser, items, concurrency) {
  const results = new Array(items.length);

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);

    await Promise.all(
      batch.map(async (item, j) => {
        const page = await browser.newPage();
        await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR,ko;q=0.9" });
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        );
        // 이미지/폰트 요청 차단 (속도 향상)
        await page.setRequestInterception(true);
        page.on("request", (req) => {
          const type = req.resourceType();
          if (["image", "font", "media", "stylesheet"].includes(type)) req.abort();
          else req.continue();
        });

        try {
          results[i + j] = await scrapeDetailWithPuppeteer(page, item.link);
        } finally {
          await page.close();
        }
      })
    );

    const done = Math.min(i + concurrency, items.length);
    process.stdout.write(`  [DETAIL] ${done}/${items.length} done\r`);

    if (i + concurrency < items.length) await sleep(DELAY_MS);
  }

  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 다나와 크롤링 시작: "${CATEGORY}" (${TOTAL_PAGES} 페이지)\n`);

  // 1. 목록 페이지 순차 크롤링 (fetch)
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

  // 2. Puppeteer 브라우저 실행 후 상세 페이지 병렬 크롤링
  console.log(`🔍 Puppeteer로 상세 스펙 크롤링 중... (동시 ${DETAIL_CONCURRENCY}탭)\n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=ko-KR"],
  });

  let details;
  try {
    details = await batchDetailProcess(browser, allBasic, DETAIL_CONCURRENCY);
  } finally {
    await browser.close();
  }

  // 3. 데이터 통합 + 카테고리별 필터링
  const allProducts = allBasic.map((item, i) => ({
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

  const products = EXCLUDE_KEYWORDS.length > 0
    ? allProducts.filter(p => !EXCLUDE_KEYWORDS.some(k => p.name.toLowerCase().includes(k.toLowerCase())))
    : allProducts;

  if (allProducts.length !== products.length) {
    console.log(`\n개/반려동물 등 필터 제거: ${allProducts.length - products.length}개 제외`);
  }

  // 4. 저장
  const dataDir = join(ROOT, "data");
  mkdirSync(dataDir, { recursive: true });
  const outPath = join(dataDir, `products-${CATEGORY}.json`);
  writeFileSync(outPath, JSON.stringify(products, null, 2), "utf8");

  console.log(`\n\n🎉 저장 완료: ${outPath}`);
  console.log(`   총 ${products.length}개 상품`);
  console.log(`   스펙 있는 상품: ${products.filter((p) => p.specs.length > 0).length}개`);
  const avg = products.reduce((a, p) => a + p.specs.length, 0) / products.length;
  console.log(`   평균 스펙 수: ${avg.toFixed(1)}개`);
  console.log(`   스펙 많은 상위 3개:`);
  [...products].sort((a, b) => b.specs.length - a.specs.length).slice(0, 3).forEach((p) => {
    console.log(`     ${p.specs.length}개 | ${p.name.slice(0, 40)}`);
  });
}

main().catch(console.error);
