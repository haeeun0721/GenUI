/**
 * 한 제품 페이지의 리뷰 DOM 구조를 덤프해서 올바른 셀렉터를 찾는 테스트 스크립트
 * 실행: node scripts/test-review-dom.mjs
 */
import puppeteer from "puppeteer";
import { writeFileSync } from "fs";

const TEST_URL = "https://prod.danawa.com/info/?pcode=20834387&keyword=%EC%9C%A0%EB%AA%A8%EC%B0%A8&cate=16349195#bookmark_cm_opinion";

async function main() {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--lang=ko-KR"] });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR,ko;q=0.9" });

  console.log("페이지 로딩 중...");
  await page.goto(TEST_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000)); // 추가 대기

  const result = await page.evaluate(() => {
    // bookmark_cm_opinion 주변 HTML 확인
    const anchor = document.getElementById("bookmark_cm_opinion");
    const anchorHTML = anchor ? anchor.parentElement?.innerHTML?.slice(0, 2000) : "NOT FOUND";

    // 리뷰 관련 모든 class 찾기
    const allClasses = new Set();
    document.querySelectorAll("*").forEach(el => {
      if (el.className && typeof el.className === "string") {
        el.className.split(" ").forEach(c => {
          if (c && (c.includes("review") || c.includes("opinion") || c.includes("comment") || c.includes("cm_") || c.includes("리뷰"))) {
            allClasses.add(c);
          }
        });
      }
      if (el.id && (el.id.includes("review") || el.id.includes("opinion") || el.id.includes("comment") || el.id.includes("cm_"))) {
        allClasses.add("#" + el.id);
      }
    });

    return {
      anchorFound: !!anchor,
      anchorParentClass: anchor?.parentElement?.className,
      anchorHTML,
      relevantClasses: [...allClasses].slice(0, 50),
    };
  });

  console.log("\n=== DOM 분석 결과 ===");
  console.log("anchor 발견:", result.anchorFound);
  console.log("anchor 부모 class:", result.anchorParentClass);
  console.log("\n관련 class/id 목록:", result.relevantClasses.join(", "));
  console.log("\nanchor 주변 HTML (첫 2000자):");
  console.log(result.anchorHTML);

  writeFileSync("scripts/review-dom-dump.txt", JSON.stringify(result, null, 2), "utf8");
  console.log("\n→ scripts/review-dom-dump.txt 저장 완료");

  await browser.close();
}

main().catch(console.error);
