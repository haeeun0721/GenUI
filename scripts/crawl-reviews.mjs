/**
 * scripts/crawl-reviews.mjs
 * products-*.json의 각 제품 다나와 상세페이지에서
 * 쇼핑몰 상품리뷰 탭을 클릭, 최대 2페이지를 수집하여
 * data/reviews-{category}.json 에 저장한다.
 *
 * 실행: node scripts/crawl-reviews.mjs 유모차
 */

import puppeteer from "puppeteer";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CATEGORY    = process.argv[2] || "유모차";
const CONCURRENCY = 3;
const DELAY_MS    = 600;
const MAX_PAGES   = 2;   // 제품당 최대 리뷰 페이지 수
const MAX_REVIEWS = 15;  // 제품당 최대 리뷰 수

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 리뷰 크롤링 ───────────────────────────────────────────────────────────
async function scrapeReviews(page, link) {
  try {
    const url = link.split("#")[0] + "#bookmark_cm_opinion";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await sleep(1500);

    // 쇼핑몰 상품리뷰 탭 클릭
    await page.evaluate(() => {
      document.querySelector("#danawa-prodBlog-companyReview-button-tab-companyReview")?.click();
    });
    await sleep(3000);

    const allReviews = [];

    for (let pg = 0; pg < MAX_PAGES; pg++) {
      // 리뷰 텍스트 수집 (.atc 클래스가 실제 리뷰 본문)
      const pageReviews = await page.evaluate(() => {
        const seen = new Set();
        const texts = [];
        document.querySelectorAll(".mall_review li .atc").forEach(el => {
          const t = el.textContent.trim().replace(/\s+/g, " ");
          if (t.length > 20 && t.length < 800 && !seen.has(t)) {
            seen.add(t);
            texts.push(t);
          }
        });
        return texts;
      });

      allReviews.push(...pageReviews);
      if (allReviews.length >= MAX_REVIEWS) break;

      // 다음 페이지 버튼 클릭 (있을 경우)
      if (pg < MAX_PAGES - 1) {
        const hasNext = await page.evaluate(() => {
          const nextBtn = document.querySelector(
            ".mall_review .btn_next:not(.disabled), " +
            ".mall_review .page_next:not(.disabled), " +
            ".mall_review [class*='next']:not([disabled])"
          );
          if (nextBtn) { nextBtn.click(); return true; }
          return false;
        });
        if (!hasNext) break;
        await sleep(2500);
      }
    }

    return allReviews.slice(0, MAX_REVIEWS);
  } catch (err) {
    return [];
  }
}

// ── 배치 처리 ─────────────────────────────────────────────────────────────
async function batchCrawl(browser, products) {
  const results = {};

  for (let i = 0; i < products.length; i += CONCURRENCY) {
    const batch = products.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async (product) => {
      const pg = await browser.newPage();
      await pg.setExtraHTTPHeaders({ "Accept-Language": "ko-KR,ko;q=0.9" });
      await pg.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
      );
      await pg.setRequestInterception(true);
      pg.on("request", req => {
        if (["image", "font", "media", "stylesheet"].includes(req.resourceType())) req.abort();
        else req.continue();
      });

      try {
        const reviews = await scrapeReviews(pg, product.link);
        results[product.id] = { name: product.name, reviews };
      } finally {
        await pg.close();
      }
    }));

    const done = Math.min(i + CONCURRENCY, products.length);
    const withReviews = Object.values(results).filter(r => r.reviews.length > 0).length;
    process.stdout.write(`  [진행] ${done}/${products.length} | 리뷰 있는 제품: ${withReviews}개\r`);

    if (i + CONCURRENCY < products.length) await sleep(DELAY_MS);
  }

  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const dataPath = join(ROOT, "data", `products-${CATEGORY}.json`);
  const outPath  = join(ROOT, "data", `reviews-${CATEGORY}.json`);

  let products;
  try {
    products = JSON.parse(readFileSync(dataPath, "utf8"));
  } catch {
    console.error(`❌ 파일을 찾을 수 없음: ${dataPath}`);
    process.exit(1);
  }

  // 기존 결과 로드 (이어서 실행 가능)
  let existing = {};
  if (existsSync(outPath)) {
    try {
      existing = JSON.parse(readFileSync(outPath, "utf8"));
      console.log(`📂 기존 데이터 로드: ${Object.keys(existing).length}개 제품`);
    } catch {}
  }

  const targets = products.filter(p => p.link && !existing[p.id]);
  console.log(`\n📦 전체: ${products.length}개 | 수집 대상: ${targets.length}개\n`);

  if (targets.length === 0) {
    console.log("✅ 이미 모든 제품 처리됨.");
    return;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=ko-KR"],
  });

  let newResults;
  try {
    newResults = await batchCrawl(browser, targets);
  } finally {
    await browser.close();
  }

  const merged = { ...existing, ...newResults };
  writeFileSync(outPath, JSON.stringify(merged, null, 2), "utf8");

  // ── 결과 보고 ────────────────────────────────────────────────────────────
  const all = Object.values(merged);
  const withReviews = all.filter(r => r.reviews.length > 0);
  const total = all.reduce((s, r) => s + r.reviews.length, 0);

  console.log(`\n\n${"═".repeat(54)}`);
  console.log(`📊 리뷰 크롤링 결과 — ${CATEGORY}`);
  console.log("═".repeat(54) + "\n");
  console.log(`전체 제품:        ${all.length}개`);
  console.log(`리뷰 있는 제품:   ${withReviews.length}개 (${Math.round(withReviews.length/all.length*100)}%)`);
  console.log(`수집 총 리뷰 수:  ${total}개`);
  console.log(`평균:             ${(total / Math.max(withReviews.length, 1)).toFixed(1)}개/제품`);

  if (withReviews.length > 0) {
    console.log("\n【리뷰 샘플 (상위 3개 제품)】");
    withReviews.slice(0, 3).forEach(({ name, reviews }) => {
      console.log(`\n  ✅ ${name.slice(0, 40)}`);
      reviews.slice(0, 2).forEach((r, i) => console.log(`     ${i+1}. "${r.slice(0, 80)}..."`));
    });
  }

  console.log(`\n💾 저장: ${outPath}`);
}

main().catch(console.error);
