import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { tool } from "ai";
import { z } from "zod";
import FirecrawlApp from "firecrawl";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATA_AGENT_MODEL = "gemini-2.5-flash" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NaverShoppingItem {
  title: string;
  link: string;
  image: string;
  lprice: string;
  hprice: string;
  mallName: string;
  productId: string;
  brand: string;
  category1: string;
  category2: string;
  category3: string;
}

export interface ProductData {
  id: string;
  name: string;
  price: string;
  image: string;
  link: string;
  brand: string;
  mallName: string;
  description: string;
  specs: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanTitle(title: string): string {
  return title.replace(/<[^>]+>/g, "").trim();
}

function formatPrice(lprice: string): string {
  if (!lprice) return "가격 미정";
  return `${parseInt(lprice).toLocaleString("ko-KR")}원~`;
}

/**
 * 한국어 비율이 너무 낮거나 해외 병행수입으로 판단되는 상품을 걸러냅니다.
 */
function isKoreanProduct(item: NaverShoppingItem): boolean {
  const title = cleanTitle(item.title);
  const koreanChars = (title.match(/[가-힣]/g) ?? []).length;
  const totalChars = title.replace(/\s/g, "").length;
  const koreanRatio = totalChars > 0 ? koreanChars / totalChars : 0;
  if (koreanRatio < 0.10) return false;

  const foreignPatterns = [
    /computadora/i, /portatil/i, /ordenador/i,
    /laptop\s+computer/i, /\bnotebook\s+pc\b/i, /\bist\s+computer/i,
  ];
  return !foreignPatterns.some((p) => p.test(title));
}

// ---------------------------------------------------------------------------
// Naver Shopping API
// ---------------------------------------------------------------------------

async function fetchNaverShopping(
  query: string,
  count: number
): Promise<NaverShoppingItem[]> {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Naver API 키가 설정되지 않았습니다. .env.local에 NAVER_CLIENT_ID와 NAVER_CLIENT_SECRET을 추가하세요."
    );
  }

  // 필터링 후에도 count개를 확보하기 위해 넉넉하게 요청 (최대 20개)
  const fetchCount = Math.min(count * 3, 20);
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=${fetchCount}&sort=sim`;

  const response = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": clientId,
      "X-Naver-Client-Secret": clientSecret,
    },
  });

  if (!response.ok) {
    throw new Error(`Naver API 오류: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const allItems: NaverShoppingItem[] = data.items ?? [];

  const filtered = allItems.filter(isKoreanProduct);
  console.log(`[DATA_AGENT] Naver raw: ${allItems.length}개 → 필터 후: ${filtered.length}개 (요청: ${count}개)`);

  return filtered.slice(0, count);
}

// ---------------------------------------------------------------------------
// Firecrawl: Scrape product page for specs
// ---------------------------------------------------------------------------

async function scrapeProductSpecs(
  url: string
): Promise<string> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return "";

  try {
    const app = new FirecrawlApp({ apiKey });
    const result = await app.scrape(url, { formats: ["markdown"] });
    const markdown = (result as any).markdown ?? "";
    return markdown.slice(0, 3000);
  } catch (err) {
    console.warn(`[DATA_AGENT] Firecrawl failed for ${url}:`, err);
    return "";
  }
}

// ---------------------------------------------------------------------------
// LLM-based Spec Extraction (from scraped page content)
// ---------------------------------------------------------------------------

async function extractSpecsFromPage(
  rawTitle: string,
  pageContent: string,
  userQuery: string
): Promise<{ shortName: string; description: string; specs: string[] }> {
  const contextNote = pageContent
    ? `Product page content:\n${pageContent}`
    : `(No page content available — infer from product name)`;

  const { text } = await generateText({
    model: google(DATA_AGENT_MODEL),
    system: `You are a product spec extraction assistant. Extract key specs from product page content and return ONLY valid JSON. No markdown, no extra text.`,
    prompt: `User is looking for: "${userQuery}"
Raw product title from Naver: ${rawTitle}

${contextNote}

1. Write a SHORT, clean product name (Korean, max 20 chars). Include only brand + model. Strip SEO keywords like "가벼운", "고사양", "추천", "인강용", "사무용", etc.
   Examples:
   - "LG 그램 프로 17 외장그래픽 RTX5050 노트북 가벼운 고사양 32GB" → "LG 그램 프로 17"
   - "삼성전자 갤럭시북4 NT750XGR-A71A 노트북 최신형 학생용" → "삼성 갤럭시북4"
   - "애플 맥북프로 M4 14인치 16GB 512GB 스페이스그레이" → "맥북프로 M4 14"
2. Extract 3-4 key specs as short Korean phrases.
3. Write a one-line Korean description.

Output format (JSON only):
{ "shortName": "짧은 상품명", "description": "한 줄 설명", "specs": ["스펙1", "스펙2", "스펙3"] }`,
    temperature: 0,
  });

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        shortName: parsed.shortName || rawTitle,
        description: parsed.description || rawTitle,
        specs: parsed.specs || [],
      };
    }
  } catch {
    // fallback
  }
  return { shortName: rawTitle, description: rawTitle, specs: [] };
}

// ---------------------------------------------------------------------------
// Enrich products: scrape pages in parallel, then extract specs via LLM
// ---------------------------------------------------------------------------

async function enrichProducts(
  items: NaverShoppingItem[],
  userQuery: string
): Promise<ProductData[]> {
  // Step 1: Scrape all product pages in parallel
  const pageContents = await Promise.all(
    items.map((item) => scrapeProductSpecs(item.link))
  );

  // Step 2: Extract specs + short name for each product via LLM (in parallel)
  const enriched = await Promise.all(
    items.map((item, i) =>
      extractSpecsFromPage(cleanTitle(item.title), pageContents[i], userQuery)
    )
  );

  return items.map((item, i) => ({
    id: item.productId || `product-${i}`,
    name: enriched[i].shortName,          // 정규화된 짧은 이름 사용
    price: formatPrice(item.lprice),
    image: item.image,
    link: item.link,
    brand: item.brand || "",
    mallName: item.mallName || "",
    description: enriched[i].description,
    specs: enriched[i].specs,
  }));
}


// ---------------------------------------------------------------------------
// Data Agent Tool (exposed to Conversation Agent)
// ---------------------------------------------------------------------------

export const searchProducts = tool({
  description:
    "Search for real products from Naver Shopping and scrape their pages for detailed specs. " +
    "Returns structured product data including images, prices, and real specs. " +
    "ALWAYS call this BEFORE renderInChat when ui_intent_category is 3 (Product Recommendation) or 2 (Comparative Evaluation).",
  inputSchema: z.object({
    query: z.string().describe(
      "Product search query in Korean (e.g., '디자인용 노트북 100만원 이하'). Include user constraints."
    ),
    count: z
      .number()
      .optional()
      .default(4)
      .describe("Number of products to return (default: 4, max: 6)"),
  }),
  execute: async ({ query, count = 4 }) => {
    console.log(`[DATA_AGENT] Searching: "${query}" (count: ${count})`);
    try {
      const items = await fetchNaverShopping(query, Math.min(count, 6));

      if (items.length === 0) {
        return { products: [], message: "검색 결과가 없습니다." };
      }

      const products = await enrichProducts(items, query);
      console.log(`[DATA_AGENT] Enriched ${products.length} products.`);

      // Build context summary for UI Agent
      const contextSummary = products
        .map(
          (p, i) =>
            `[Product ${i + 1}]\n` +
            `Name: ${p.name}\n` +
            `Price: ${p.price}\n` +
            `Brand: ${p.brand}\n` +
            `Mall: ${p.mallName}\n` +
            `Image: ${p.image}\n` +
            `Link: ${p.link}\n` +
            `Specs: ${p.specs.join(", ")}\n` +
            `Description: ${p.description}`
        )
        .join("\n\n");

      return { products, contextSummary };
    } catch (error) {
      console.error("[DATA_AGENT] Error:", error);
      return {
        products: [],
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});
