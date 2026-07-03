/**
 * 다나와 상품의견 탭 콘텐츠 덤프
 */
import puppeteer from "puppeteer";
import { readFileSync } from "fs";

const data = JSON.parse(readFileSync("data/products-유모차.json", "utf8"));

// 리뷰가 있을법한 유명 제품들 순서대로 시도
const candidates = [
  data.find(p => p.name.includes("싸이벡스") || p.name.includes("사이벡스")),
  data.find(p => p.name.includes("스토케")),
  data.find(p => p.name.includes("누나") || p.name.includes("nuna")),
  data.find(p => p.name.includes("조이")),
  data[0],
].filter(Boolean);

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--lang=ko-KR"] });
const page = await browser.newPage();
await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR,ko;q=0.9" });

for (const product of candidates.slice(0, 2)) {
  console.log("\n===", product.name, "===");
  const url = product.link.split("#")[0] + "#bookmark_cm_opinion";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await new Promise(r => setTimeout(r, 4000));

  const result = await page.evaluate(() => {
    // 다나와 상품의견 탭 클릭
    const tab = document.querySelector("#danawa-prodBlog-companyReview-button-tab-productOpinion");
    if (tab) tab.click();

    return {
      // 상품의견 리스트
      opinionItems: [...document.querySelectorAll(
        ".danawa-prodBlog-opinion-list .item, " +
        "#danawa-prodBlog-productOpinion-list-self li, " +
        ".opinion_list li, .prod_opinion li, " +
        ".item_list li"
      )].slice(0, 5).map(el => el.textContent.trim().replace(/\s+/g, " ").slice(0, 200)),
      
      // 모든 의미있는 텍스트 블록
      allDsc: [...document.querySelectorAll(".dsc, .content_text, .review_text, .user_text")].slice(0, 5)
        .map(el => el.textContent.trim().replace(/\s+/g, " ").slice(0, 200)),
      
      // opinion container innerHTML
      opinionHTML: document.querySelector("#danawa-prodBlog-productOpinion-list-self")
        ?.innerHTML.slice(500, 1500) || "NOT FOUND",
    };
  });

  await new Promise(r => setTimeout(r, 2000));
  
  // 탭 클릭 후 재수집
  const result2 = await page.evaluate(() => {
    return [...document.querySelectorAll(
      ".dsc, .desc_v2, .content, .text, p.dsc"
    )].filter(el => {
      const t = el.textContent.trim();
      return t.length > 30 && t.length < 500;
    }).slice(0, 10).map(el => ({
      cls: el.className.slice(0, 30),
      text: el.textContent.trim().replace(/\s+/g, " ").slice(0, 150),
    }));
  });

  console.log("opinionItems:", result.opinionItems);
  console.log("allDsc:", result.allDsc);
  console.log("탭 클릭 후 텍스트들:", result2);
}

await browser.close();
