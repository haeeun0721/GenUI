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

  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=${count}&sort=sim`;

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
  return data.items ?? [];
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
    const result = await app.scrape(url, {
      formats: ["markdown"],
      waitFor: 3000,  // Naver Shopping은 JS 렌더링 페이지 — 3초 대기
    });
    const markdown = (result as any).markdown ?? "";
    const trimmed = markdown.slice(0, 4000);
    console.log(`[DATA_AGENT] Scraped ${url.slice(0, 60)}...: ${trimmed.length} chars`);
    return trimmed;
  } catch (err) {
    console.warn(`[DATA_AGENT] Firecrawl failed for ${url}:`, err);
    return "";
  }
}

// ---------------------------------------------------------------------------
// LLM-based Spec Extraction (from scraped page content)
// ---------------------------------------------------------------------------

async function extractSpecsFromPage(
  productName: string,
  pageContent: string,
  userQuery: string
): Promise<{ description: string; specs: string[] }> {
  const contextNote = pageContent
    ? `Product page content:\n${pageContent}`
    : `(No page content available — infer from product name)`;

  const { text } = await generateText({
    model: google(DATA_AGENT_MODEL),
    system: `You are a product spec extraction assistant. Extract key specs from product page content and return ONLY valid JSON. No markdown, no extra text.`,
    prompt: `User is looking for: "${userQuery}"
Product: ${productName}

${contextNote}

Extract 3-4 key specs as short Korean phrases, and write a one-line Korean description.
Output format (JSON only):
{ "description": "한 줄 설명", "specs": ["스펙1", "스펙2", "스펙3"] }`,
    temperature: 0,
  });

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {
    // fallback
  }
  return { description: productName, specs: [] };
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

  // Step 2: Extract specs for each product via LLM (in parallel)
  const enriched = await Promise.all(
    items.map((item, i) =>
      extractSpecsFromPage(cleanTitle(item.title), pageContents[i], userQuery)
    )
  );

  return items.map((item, i) => ({
    id: item.productId || `product-${i}`,
    name: cleanTitle(item.title),
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
