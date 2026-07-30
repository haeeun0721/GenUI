/**
 * 다나와 리뷰 탭 클릭 → 페이지네이션 → 텍스트 추출 테스트
 * 10개 제품 순서대로 시도해서 실제로 리뷰가 있는 제품을 찾는다.
 */
import puppeteer from "puppeteer";
import { readFileSync } from "fs";

const data = JSON.parse(readFileSync("data/products-유모차.json", "utf8"));

const browser = await puppeteer.launch({
  headless: false, // 실제 브라우저로 확인
  args: ["--no-sandbox", "--lang=ko-KR"],
  defaultViewport: { width: 1280, height: 900 },
});

const page = await browser.newPage();
await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR,ko;q=0.9" });

// 유명 브랜드 제품 10개 추출
const targets = data
  .filter(p => ["부가부", "싸이벡스", "스토케", "베이비젠", "줄즈", "마클라렌", "조이", "치코", "누나", "에그"].some(b => p.name.includes(b)))
  .slice(0, 10);

console.log(`테스트 대상: ${targets.length}개 제품\n`);

for (const product of targets) {
  console.log(`\n테스트: ${product.name}`);
  const url = product.link.split("#")[0] + "#bookmark_cm_opinion";
  
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await new Promise(r => setTimeout(r, 2000));

  // ① 쇼핑몰 상품리뷰 탭 클릭
  await page.evaluate(() => {
    const tab = document.querySelector("#danawa-prodBlog-companyReview-button-tab-companyReview");
    if (tab) tab.click();
  });
  await new Promise(r => setTimeout(r, 3000));

  const mallReview = await page.evaluate(() => {
    const container = document.querySelector(".mall_review, #danawa-prodBlog-companyReview-list-companyReview");
    return {
      html: container?.innerHTML?.slice(0, 500) || "NOT FOUND",
      noData: !!document.querySelector(".mall_review .no_data"),
      itemCount: document.querySelectorAll(".mall_review li, .companyReview_list li, .review_list li").length,
    };
  });

  // ② 다나와 상품의견 탭 클릭
  await page.evaluate(() => {
    const tab = document.querySelector("#danawa-prodBlog-companyReview-button-tab-productOpinion");
    if (tab) tab.click();
  });
  await new Promise(r => setTimeout(r, 3000));

  const opinionResult = await page.evaluate(() => {
    // 의견 아이템 찾기
    const items = document.querySelectorAll(
      ".danawa-prodBlog-opinion-item, " +
      "[id^='danawa-prodBlog-productOpinion-item'], " +
      ".opinion_item, " +
      ".prod_opinion .item"
    );
    return {
      itemCount: items.length,
      items: [...items].slice(0, 3).map(el => el.textContent.trim().replace(/\s+/g, " ").slice(0, 150)),
      // 전체 opinion container innerHTML
      containerHTML: document.querySelector("#danawa-prodBlog-productOpinion-list-self")
        ?.innerHTML?.slice(300, 1500) || "NOT FOUND",
    };
  });

  console.log(`  쇼핑몰 리뷰: ${mallReview.noData ? "없음" : `${mallReview.itemCount}개`}`);
  console.log(`  다나와 상품의견: ${opinionResult.itemCount}개`);
  if (opinionResult.items.length > 0) {
    console.log(`  의견 샘플:`, opinionResult.items[0]);
  }
  
  // 리뷰가 있으면 더 자세히 보기
  if (!mallReview.noData && mallReview.itemCount > 0) {
    console.log("  ✅ 쇼핑몰 리뷰 있음! HTML:", mallReview.html.slice(0, 200));
  }
}

console.log("\n테스트 완료. 브라우저를 수동으로 닫아주세요.");
// await browser.close(); // 수동으로 확인하도록 열어둠
