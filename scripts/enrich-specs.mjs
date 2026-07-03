/**
 * scripts/enrich-specs.mjs
 * 기존 products-*.json에서 specs가 적은 제품을 골라
 * 다나와 상세 페이지를 다시 방문하여 스펙 + 설명을 보강한다.
 *
 * 실행: node scripts/enrich-specs.mjs 유모차
 *       node scripts/enrich-specs.mjs 로봇\ 청소기
 */

import puppeteer from "puppeteer";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CATEGORY    = process.argv[2] || "유모차";
const CONCURRENCY = 3;
const DELAY_MS    = 500;
// 이 스펙 수 이하인 제품만 재크롤링 (이미 충분한 제품은 건너뜀)
const ENRICH_THRESHOLD = 8;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 상세 페이지 크롤링 ────────────────────────────────────────────────────
async function scrapeDetail(browserPage, link) {
  try {
    await browserPage.goto(link, { waitUntil: "domcontentloaded", timeout: 20000 });

    // 스펙 테이블 로드 대기 (최대 6초)
    await browserPage
      .waitForSelector(".spec_tbl tr, .prod_spec_table tr, .spec_list_wrap tr", { timeout: 6000 })
      .catch(() => {});

    const result = await browserPage.evaluate(() => {
      const specs = [];
      const seen  = new Set();

      const add = (label, value) => {
        const l = (label || "").trim();
        const v = (value || "").trim().replace(/\s+/g, " ");
        const key = `${l}: ${v}`;
        if (l && v && v !== "-" && v.length < 200 && !seen.has(key)) {
          seen.add(key);
          specs.push(key);
        }
      };

      // ① 스펙 테이블 (th/td)
      document.querySelectorAll(
        ".spec_tbl tr, .prod_spec_table tr, .spec_list_wrap .spec_tbl tr, " +
        ".detail_spec table tr, .spec_info_area table tr, " +
        ".detail_info_wrap table tr, .tbl_wrap table tr, table.spec tr, " +
        ".prod_spec tr, .spec_detail_area tr"
      ).forEach(row => {
        const th = row.querySelector("th");
        const td = row.querySelector("td");
        if (th && td) add(th.textContent, td.textContent);
      });

      // ② dl/dt/dd 구조
      document.querySelectorAll(".spec_list dl, .spec_list_wrap dl, .prod_spec dl").forEach(dl => {
        const dt = dl.querySelector("dt");
        const dd = dl.querySelector("dd");
        if (dt && dd) add(dt.textContent, dd.textContent);
      });

      // ③ 주요 특징 뱃지
      document.querySelectorAll(
        ".prod_point_list li, .prod_sticker span, .point_list li, " +
        ".product_point li, .feature_list li, .prod_feature li"
      ).forEach(el => {
        const text = el.textContent.trim().replace(/\s+/g, " ");
        if (text && text.length > 2 && text.length < 80 && !seen.has(text)) {
          seen.add(text);
          specs.push(`특징: ${text}`);
        }
      });

      // ④ 제품 설명 텍스트 (자연어 — RAG 품질에 가장 중요)
      const descSelectors = [
        ".item_intro_content",
        ".prod_description",
        ".prod_intro_area",
        ".prod_summary_area",
        ".prod_comment_area",
        ".product_introduce",
        ".goods_description",
        ".detail_content",
        "#productDescriptionArea",
      ];
      let description = "";
      for (const sel of descSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          description = el.textContent.trim().replace(/\s+/g, " ").slice(0, 800);
          if (description.length > 30) break;
        }
      }

      return { specs: specs.slice(0, 50), description };
    });

    return result;
  } catch (err) {
    console.warn(`  [DETAIL] 실패: ${link.slice(0, 60)} — ${err.message}`);
    return { specs: [], description: "" };
  }
}

// ── 배치 처리 ─────────────────────────────────────────────────────────────
async function batchEnrich(browser, targets) {
  const results = new Array(targets.length);

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async ({ link }, j) => {
      const page = await browser.newPage();
      await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR,ko;q=0.9" });
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
      );
      await page.setRequestInterception(true);
      page.on("request", req => {
        if (["image","font","media","stylesheet"].includes(req.resourceType())) req.abort();
        else req.continue();
      });

      try {
        results[i + j] = await scrapeDetail(page, link);
      } finally {
        await page.close();
      }
    }));

    const done = Math.min(i + CONCURRENCY, targets.length);
    process.stdout.write(`  [진행] ${done}/${targets.length} 완료\r`);
    if (i + CONCURRENCY < targets.length) await sleep(DELAY_MS);
  }

  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const dataPath = join(ROOT, "data", `products-${CATEGORY}.json`);
  let products;
  try {
    products = JSON.parse(readFileSync(dataPath, "utf8"));
  } catch {
    console.error(`❌ 파일을 찾을 수 없음: ${dataPath}`);
    process.exit(1);
  }

  console.log(`\n📂 로드: ${dataPath} (총 ${products.length}개)\n`);

  // 보강이 필요한 제품만 추출
  const targets = products
    .map((p, i) => ({ idx: i, link: p.link, name: p.name, currentSpecCount: p.specs?.length ?? 0 }))
    .filter(p => p.currentSpecCount < ENRICH_THRESHOLD && p.link);

  console.log(`🔍 보강 대상: ${targets.length}개 (스펙 ${ENRICH_THRESHOLD}개 미만)\n`);

  if (targets.length === 0) {
    console.log("✅ 모든 제품이 이미 충분한 스펙을 가지고 있습니다.");
    return;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=ko-KR"],
  });

  let details;
  try {
    details = await batchEnrich(browser, targets);
  } finally {
    await browser.close();
  }

  console.log("\n");

  // ── 결과 통합 및 보고 ────────────────────────────────────────────────────
  let totalAdded = 0;
  let descriptionAdded = 0;
  const report = [];

  targets.forEach(({ idx, name, currentSpecCount }, i) => {
    const { specs: newSpecs, description: newDesc } = details[i] ?? { specs: [], description: "" };
    const existing = new Set(products[idx].specs ?? []);

    // 기존에 없는 스펙만 추가
    const added = newSpecs.filter(s => !existing.has(s));
    products[idx].specs = [...(products[idx].specs ?? []), ...added];

    // 설명이 비어있던 경우에만 업데이트
    if (newDesc && (!products[idx].description || products[idx].description === name)) {
      products[idx].description = newDesc;
      descriptionAdded++;
    }

    if (added.length > 0) {
      totalAdded += added.length;
      report.push({ name, before: currentSpecCount, after: products[idx].specs.length, added });
    }
  });

  writeFileSync(dataPath, JSON.stringify(products, null, 2), "utf8");

  // ── 보고 ──────────────────────────────────────────────────────────────────
  console.log("══════════════════════════════════════════════════════");
  console.log(`📊 보강 결과 보고 — ${CATEGORY}`);
  console.log("══════════════════════════════════════════════════════\n");
  console.log(`보강 시도: ${targets.length}개 제품`);
  console.log(`스펙 추가: 총 ${totalAdded}개`);
  console.log(`설명 추가: ${descriptionAdded}개 제품\n`);

  if (report.length > 0) {
    console.log("【스펙이 추가된 제품 목록】");
    report.forEach(({ name, before, after, added }) => {
      console.log(`  ✅ ${name.slice(0, 40)}`);
      console.log(`     스펙 수: ${before} → ${after} (+${added.length})`);
      console.log(`     추가된 항목:`);
      added.slice(0, 5).forEach(s => console.log(`       - ${s}`));
      if (added.length > 5) console.log(`       ... 외 ${added.length - 5}개`);
      console.log();
    });
  } else {
    console.log("새로 추가된 스펙이 없습니다 (상세 페이지에서 새 정보를 찾지 못함).");
  }

  console.log(`\n💾 저장 완료: ${dataPath}`);
  
  const avg = products.reduce((a, p) => a + (p.specs?.length ?? 0), 0) / products.length;
  console.log(`📈 전체 평균 스펙 수: ${avg.toFixed(1)}개`);
  console.log(`📈 스펙 있는 제품: ${products.filter(p => p.specs?.length > 0).length}/${products.length}개`);
}

main().catch(console.error);
