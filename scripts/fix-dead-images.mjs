/**
 * scripts/fix-dead-images.mjs
 * 기존 products-*.json에서 image URL이 죽어있는(다나와 CDN 404 등) 제품만 골라
 * 다나와에서 제품명으로 재검색해 최신 썸네일 URL로 교체한다.
 *
 * crawl-products.mjs(전체 재크롤링, ~5-10분 + 임베딩 재생성 필요)와 달리, image
 * 필드만 패치하고 나머지(specs/id/description 등)는 건드리지 않는다 — Puppeteer도
 * 필요 없다(썸네일은 검색 결과 목록 페이지에 이미 있음, crawl-products.mjs의
 * scrapeListPage와 동일한 방식).
 *
 * 실행: node scripts/fix-dead-images.mjs 로봇\ 청소기
 *       node scripts/fix-dead-images.mjs 카메라
 */

import * as cheerio from "cheerio";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CATEGORY = process.argv[2] || "유모차";
const CONCURRENCY = 5;
const DELAY_MS = 400;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9",
  Referer: "https://www.danawa.com/",
};

const PLACEHOLDER = ["noImg_160.gif", "noData", "no_image", "blank.gif", "loading."];
const isPlaceholder = (url) => !url || url.startsWith("data:") || PLACEHOLDER.some((p) => url.includes(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeImg(url, productLink) {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) {
    try { return `${new URL(productLink).origin}${url}`; } catch {}
  }
  return url;
}

async function isImageAlive(url) {
  if (isPlaceholder(url)) return false;
  try {
    const res = await fetch(url, { method: "HEAD", headers: HEADERS, signal: AbortSignal.timeout(10000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 제품명으로 다나와를 검색해 첫 결과의 썸네일 URL을 가져온다. 못 찾으면 "". */
async function findFreshImage(productName, fallbackLink) {
  try {
    const url = `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(productName)}&tab=goods`;
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return "";

    const html = await res.text();
    const $ = cheerio.load(html);
    const items = $("ul.product_list > li.prod_item").toArray();

    for (const el of items) {
      const elId = $(el).attr("id") ?? "";
      if (elId.startsWith("ad") || elId.startsWith("Ad")) continue;

      const name = $(el).find(".prod_name a").first().text().trim();
      if (!name) continue;

      const imgEl = $(el).find(".thumb_link img, .thumb_image img").first();
      const rawImg = [
        imgEl.attr("data-src"), imgEl.attr("data-original"),
        imgEl.attr("data-lazy"), imgEl.attr("src"),
      ].find((c) => c && !isPlaceholder(c)) ?? "";
      if (!rawImg) continue;

      return normalizeImg(rawImg, fallbackLink);
    }
    return "";
  } catch (err) {
    console.warn(`  [검색 실패] "${productName}": ${err.message}`);
    return "";
  }
}

async function pMapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
      if (idx < items.length) await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

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
  console.log("🔍 이미지 URL 생존 여부 확인 중...");

  const aliveFlags = await pMapLimit(products, 12, (p) => isImageAlive(p.image));
  const deadIdx = products.map((_, i) => i).filter((i) => !aliveFlags[i]);

  console.log(`💀 죽은 이미지: ${deadIdx.length} / ${products.length}개\n`);
  if (deadIdx.length === 0) {
    console.log("✅ 모든 이미지가 정상입니다.");
    return;
  }

  console.log("🔄 다나와 재검색으로 이미지 교체 시도...\n");

  const fixResults = await pMapLimit(deadIdx, CONCURRENCY, async (i) => {
    const p = products[i];
    const fresh = await findFreshImage(p.name, p.link);
    if (!fresh) return { i, status: "not_found" };
    if (fresh === p.image) return { i, status: "same_url_still_dead" };
    const alive = await isImageAlive(fresh);
    return { i, status: alive ? "fixed" : "new_url_also_dead", fresh };
  });

  let fixedCount = 0;
  const report = { fixed: [], not_found: [], still_dead: [] };

  for (const r of fixResults) {
    const p = products[r.i];
    if (r.status === "fixed") {
      report.fixed.push({ name: p.name, before: p.image, after: r.fresh });
      p.image = r.fresh;
      fixedCount++;
    } else if (r.status === "not_found") {
      report.not_found.push(p.name);
    } else {
      report.still_dead.push(p.name);
    }
  }

  writeFileSync(dataPath, JSON.stringify(products, null, 2), "utf8");

  console.log("══════════════════════════════════════════════════════");
  console.log(`📊 이미지 복구 결과 — ${CATEGORY}`);
  console.log("══════════════════════════════════════════════════════\n");
  console.log(`죽은 이미지: ${deadIdx.length}개 중 ${fixedCount}개 복구\n`);

  if (report.fixed.length > 0) {
    console.log("【복구됨】");
    report.fixed.forEach(({ name, before, after }) => {
      console.log(`  ✅ ${name}`);
      console.log(`     ${before}`);
      console.log(`     → ${after}`);
    });
    console.log();
  }
  if (report.not_found.length > 0) {
    console.log("【검색 결과 없음 — 수동 확인 필요】");
    report.not_found.forEach((n) => console.log(`  ❓ ${n}`));
    console.log();
  }
  if (report.still_dead.length > 0) {
    console.log("【재검색해도 여전히 죽음 — 수동 확인 필요】");
    report.still_dead.forEach((n) => console.log(`  ⚠️  ${n}`));
    console.log();
  }

  console.log(`💾 저장 완료: ${dataPath}`);
}

main().catch(console.error);
