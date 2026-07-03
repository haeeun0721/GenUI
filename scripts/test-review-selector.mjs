/**
 * 실제 리뷰가 있는 인기 제품으로 셀렉터 테스트
 */
import puppeteer from "puppeteer";
import { readFileSync } from "fs";

const data = JSON.parse(readFileSync("data/products-유모차.json", "utf8"));
const bugaboo = data.find(p => p.name.includes("부가부") && p.name.includes("폭스")) || data[0];
console.log("테스트 제품:", bugaboo.name);

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--lang=ko-KR"] });
const page = await browser.newPage();
await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR,ko;q=0.9" });

const url = bugaboo.link.split("#")[0] + "#bookmark_cm_opinion";
console.log("URL:", url);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

// AJAX 리뷰 로딩 대기
await page.waitForFunction(
  () => document.querySelectorAll(".text__review").length > 0,
  { timeout: 10000 }
).catch(() => console.log("waitForFunction timeout"));

const result = await page.evaluate(() => {
  const items = [...document.querySelectorAll(".text__review")];
  return {
    count: items.length,
    samples: items.slice(0, 5).map(el => el.textContent.trim().replace(/\s+/g, " ").slice(0, 150)),
  };
});

console.log("text__review 개수:", result.count);
result.samples.forEach((s, i) => console.log(`${i+1}. ${s}`));

await browser.close();
