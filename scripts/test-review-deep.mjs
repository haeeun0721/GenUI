/**
 * 실제 리뷰 텍스트 위치 찾기
 */
import puppeteer from "puppeteer";
import { readFileSync, writeFileSync } from "fs";

const data = JSON.parse(readFileSync("data/products-유모차.json", "utf8"));
const bugaboo = data.find(p => p.name.includes("부가부") && p.name.includes("폭스")) || data[0];
console.log("테스트 제품:", bugaboo.name);

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--lang=ko-KR"] });
const page = await browser.newPage();
await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR,ko;q=0.9" });

const url = bugaboo.link.split("#")[0] + "#bookmark_cm_opinion";
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

// 컴퍼니 리뷰 탭 클릭 시도 (쇼핑몰 구매 리뷰)
await page.evaluate(() => {
  const tabs = document.querySelectorAll(".sub_tab .tab_item a");
  tabs.forEach(t => console.log("TAB:", t.id, t.textContent.trim()));
  // 쇼핑몰 구매후기 탭 클릭
  const compReviewTab = document.querySelector("#danawa-prodBlog-companyReview-button-tab-companyReview");
  if (compReviewTab) compReviewTab.click();
});

await new Promise(r => setTimeout(r, 5000));

const result = await page.evaluate(() => {
  // #danawa-prodBlog-productOpinion-list-self 내부 전체 HTML 덤프
  const container = document.querySelector("#danawa-prodBlog-productOpinion-list-self");
  
  // 모든 li 텍스트 (200자 이상인 것만)
  const longTexts = [];
  document.querySelectorAll("li, p, .dsc, .desc, .content, .txt, .body, .cont").forEach(el => {
    const t = el.textContent.trim().replace(/\s+/g, " ");
    if (t.length > 50 && t.length < 500 && 
        !t.includes("알림") && !t.includes("copyright") && !t.includes("리뷰수")) {
      longTexts.push({ tag: el.tagName, cls: el.className.slice(0,30), text: t.slice(0, 100) });
    }
  });
  
  // 탭 목록
  const tabs = [...document.querySelectorAll(".sub_tab .tab_item a")].map(t => ({
    id: t.id, text: t.textContent.trim()
  }));
  
  return {
    tabs,
    containerInnerHTML: container ? container.innerHTML.slice(800, 2000) : "NOT FOUND",
    longTexts: longTexts.slice(0, 20),
  };
});

writeFileSync("scripts/review-deep-dump.txt", JSON.stringify(result, null, 2));
console.log("탭 목록:", result.tabs);
console.log("긴 텍스트 샘플:", result.longTexts.slice(0, 5));
console.log("→ scripts/review-deep-dump.txt 저장");

await browser.close();
