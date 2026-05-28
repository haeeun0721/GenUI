import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import FirecrawlApp from "firecrawl";

const MODEL = "gemini-2.5-flash";

async function scrapeUrl(url: string): Promise<string> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey || !url) return "";
  try {
    const app = new FirecrawlApp({ apiKey });
    const result = await app.scrape(url, {
      formats: ["markdown"],
      waitFor: 3000, // Naver Shopping은 JS 렌더링 — 3초 대기 후 스펙 테이블 로드
    });
    const markdown = (result as any).markdown ?? "";
    const trimmed = markdown.slice(0, 4000);
    console.log(`[fetch-spec] Scraped ${url.slice(0, 60)}...: ${trimmed.length} chars`);
    return trimmed;
  } catch (err) {
    console.warn(`[fetch-spec] Firecrawl failed for ${url}:`, err);
    return "";
  }
}

async function extractSpecValue(
  productName: string,
  pageContent: string,
  criteria: string
): Promise<string> {
  // 500자 미만 스크래핑 결과는 JS 렌더링 실패로 간주 — 무시하고 training knowledge 사용
  const usablePage = pageContent.length >= 500 ? pageContent : "";
  const context = usablePage
    ? `[제품 페이지 내용]\n${usablePage}`
    : `[페이지 스크래핑 실패 — training knowledge 사용]`;

  const { text } = await generateText({
    model: google(MODEL),
    system: `You are a Korean product spec expert with deep knowledge of consumer electronics sold in Korea.
Your task: extract ONE specific spec value for a given product and criteria.

RULES:
1. Return ONLY the spec value — no explanation, no label, no units in parentheses.
2. Keep it concise: 2-20 characters or standard notation (e.g. "16GB", "1.35kg", "최대 20시간").
3. For well-known brands (Samsung 삼성, LG, Apple, Lenovo, ASUS, Dell, HP, etc.):
   - You MUST use your training knowledge if page content is unavailable.
   - NEVER return "—" for Samsung Galaxy Book(갤럭시북), LG Gram(그램), MacBook, ThinkPad, or similar iconic product lines — you know their specs.
4. For abstract criteria like "휴대성":
   - Return the weight if known (e.g. "1.17kg"), or a qualitative rating (e.g. "경량", "무거운 편").
5. Return "정보 없음" ONLY if you genuinely have NO knowledge of this product model at all.
6. NEVER return "—" as a response.`,
    prompt: `Product: "${productName}"
Spec/Criteria: "${criteria}"

${context}

Answer with ONLY the spec value for "${criteria}". No explanation.`,
    temperature: 0,
  });

  const value = text.trim().replace(/^["']|["']$/g, "");
  return value || "정보 없음";
}

export async function POST(req: NextRequest) {
  try {
    const { products, criteria } = await req.json() as {
      products: { name: string; link: string }[];
      criteria: string;
    };

    if (!products?.length || !criteria) {
      return NextResponse.json({ error: "Missing products or criteria" }, { status: 400 });
    }

    console.log(`[fetch-spec] Fetching "${criteria}" for ${products.length} products`);

    // Scrape all pages in parallel
    const pageContents = await Promise.all(
      products.map((p) => scrapeUrl(p.link))
    );

    // Extract spec values in parallel
    const values = await Promise.all(
      products.map((p, i) => extractSpecValue(p.name, pageContents[i], criteria))
    );

    // Build result map: { productName: specValue }
    const result: Record<string, string> = {};
    products.forEach((p, i) => {
      result[p.name] = values[i];
    });

    console.log(`[fetch-spec] Results for "${criteria}":`, result);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[fetch-spec] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
