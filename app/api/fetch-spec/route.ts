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
    const result = await app.scrape(url, { formats: ["markdown"] });
    const markdown = (result as any).markdown ?? "";
    return markdown.slice(0, 3000);
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
  const context = pageContent
    ? `Product page content:\n${pageContent}`
    : `(No page content available. Use your training knowledge about this product.)`;

  const { text } = await generateText({
    model: google(MODEL),
    system: `You are a product spec extraction assistant. Extract a specific spec value for a product. Return ONLY the value as a short Korean phrase (2-15 characters). If truly unknown, return "—".`,
    prompt: `Product: ${productName}
Spec to find: "${criteria}"

${context}

Return ONLY the spec value for "${criteria}". Examples for 휴대성: "1.25kg, 접이식", "경량 설계", "무게 4.5kg". Examples for 배터리: "최대 12시간". If unknown, return "—". Return the value only, no explanation.`,
    temperature: 0,
  });

  return text.trim().replace(/^["']|["']$/g, "") || "—";
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
