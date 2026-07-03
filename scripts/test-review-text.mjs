/**
 * 리뷰 텍스트 정확한 셀렉터 확인 (부가부 버터플라이 — 54개 리뷰 있음)
 */
import puppeteer from "puppeteer";
import { readFileSync } from "fs";

const data = JSON.parse(readFileSync("data/products-유모차.json", "utf8"));
const product = data.find(p => p.name.includes("버터플라이")) || data[0];
console.log("테스트:", product.name);

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--lang=ko-KR"] });
const page = await browser.newPage();
await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR,ko;q=0.9" });

const url = product.link.split("#")[0] + "#bookmark_cm_opinion";
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
await new Promise(r => setTimeout(r, 2000));

// 쇼핑몰 리뷰 탭 클릭
await page.evaluate(() => {
  document.querySelector("#danawa-prodBlog-companyReview-button-tab-companyReview")?.click();
});
await new Promise(r => setTimeout(r, 4000));

const result = await page.evaluate(() => {
  const mall = document.querySelector(".mall_review");
  if (!mall) return { error: "mall_review not found" };

  // 리스트 아이템 찾기
  const candidates = [
    ".companyReview_list li",
    ".review_list li",
    ".list_review li",
    "li.review_item",
    "li.item",
    ".mall_review li",
  ];

  const counts = {};
  const samples = {};
  for (const sel of candidates) {
    const items = mall.querySelectorAll(sel);
    counts[sel] = items.length;
    if (items.length > 0) {
      const text = items[0].textContent.trim().replace(/\s+/g, " ");
      samples[sel] = text.slice(0, 200);
    }
  }

  // 텍스트가 50자 이상인 모든 요소
  const textElements = [];
  mall.querySelectorAll("*").forEach(el => {
    if (el.children.length === 0) { // leaf nodes only
      const t = el.textContent.trim().replace(/\s+/g, " ");
      if (t.length > 50 && t.length < 600) {
        textElements.push({ tag: el.tagName, cls: el.className.slice(0,40), text: t.slice(0, 150) });
      }
    }
  });

  return { counts, samples, textElements: textElements.slice(0, 10) };
});

console.log("\n셀렉터별 아이템 수:", result.counts);
console.log("\n텍스트 노드들:");
result.textElements?.forEach(e => console.log(`  [${e.cls}] ${e.text}`));

await browser.close();
