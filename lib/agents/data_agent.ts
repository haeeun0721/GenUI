import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATA_AGENT_MODEL = "claude-sonnet-4-6" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

function extractJson(text: string): any[] {
  // Try JSON array first
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(text.slice(firstBracket, lastBracket + 1));
    } catch { /* continue */ }
  }
  // Try single JSON object
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return [JSON.parse(text.slice(firstBrace, lastBrace + 1))];
    } catch { /* continue */ }
  }
  return [];
}

const KNOWN_BRANDS = [
  "삼성", "LG", "로보락", "다이슨", "에코백스", "드리미", "나르왈", "아이로봇",
  "샤오미", "치후360", "부가부", "줄즈", "베이비젠", "스토케", "마클라렌",
  "사이벡스", "누나", "조이", "치코", "페도라", "디트로네", "콤비", "UPPAbaby",
];

function extractBrand(name: string): string {
  for (const b of KNOWN_BRANDS) {
    if (name.toLowerCase().includes(b.toLowerCase())) return b;
  }
  return name.split(/\s+/)[0] ?? "";
}

// ---------------------------------------------------------------------------
// Data Agent Tool — Claude Web Search
// ---------------------------------------------------------------------------

export const searchProducts = tool({
  description:
    "Search for real products using Claude's web search capability. " +
    "Returns structured product data with names, prices, real image URLs, and specs. " +
    "ALWAYS call this BEFORE renderInChat when ui_intent_category is 3 or 2.",
  inputSchema: z.object({
    query: z.string().describe(
      "Product search query in Korean (e.g., '신생아 서스펜션 유모차'). Include user constraints."
    ),
    count: z.number().optional().default(4).describe(
      "Number of products to return (default: 4, max: 6)"
    ),
    excludeNames: z.array(z.string()).optional().default([]).describe(
      "List of product names already shown to the user. These will be excluded from results."
    ),
    link: z.string().optional().describe(
      "Direct product URL from My Items. When provided, fetch product info from this URL directly."
    ),
  }),
  execute: async ({ query, count = 4, excludeNames = [], link }) => {
    console.log(
      `[DATA_AGENT] Web search: "${query}" link=${link ? link.slice(0, 60) : "none"} count=${count}`
    );

    const excludeClause =
      excludeNames.length > 0
        ? `\n이미 보여준 제품이므로 제외: ${excludeNames.join(", ")}`
        : "";

    const systemPrompt = `You are a Korean product search assistant. Find real products and return their data as a JSON array.

CRITICAL RULES:
- Return ONLY a valid JSON array. No markdown fences, no explanation text whatsoever.
- image: MUST be a real, direct absolute image URL starting with http:// or https:// (.jpg / .png / .webp). Use webFetch on the product page. Note that many sites use lazy loading, so prioritize 'og:image' meta tags, 'data-src', or 'data-original' attributes over standard 'src' if the 'src' looks like a placeholder or 1x1 pixel.
- price: MUST be in Korean won (원). Search 네이버쇼핑, 쿠팡, or any Korean shopping mall to find the Korean price. Format: "450,000원" or "30~50만원대". Only use "가격 미정" as absolute last resort.
- specs: 3~5 key spec strings in Korean.
- link: the product detail page URL you fetched.

JSON structure (array of objects):
[{"name":"...","price":"...원","image":"https://...","link":"https://...","specs":["...","..."]}]`;

    try {
      let prompt: string;

      if (link) {
        prompt = `다음 제품 페이지에서 정보를 추출해줘.
URL: ${link}
제품명 참고: ${query}

webFetch로 위 페이지를 열어서 제품명, 가격, 이미지 URL, 스펙을 추출하고 JSON 배열로만 반환해줘.
이미지 URL 추출 시 일반 src가 비어있거나 더미 이미지일 수 있으니, 'og:image' 메타 태그나 'data-src', 'data-original' 속성을 최우선으로 탐색해줘.`;
      } else {
        prompt = `"${query}" 제품을 한국 쇼핑몰 또는 공식 사이트에서 ${count}개 검색해줘.${excludeClause}

각 제품마다:
1. webSearch로 제품명과 "네이버쇼핑" 또는 "쿠팡"에서 한국 판매 가격을 먼저 찾고
2. 제품 상세 페이지 URL을 확인한 후
3. webFetch로 해당 페이지를 열어서 실제 이미지 URL을 추출해줘 (일반 src가 더미일 수 있으니 'og:image' 메타 태그나 'data-src', 'data-original' 속성 우선 탐색)
4. 가격은 반드시 원화(원)로 표기해줘. 못 찾으면 네이버쇼핑에서 추가 검색해줘.

JSON 배열로만 반환해줘. 설명 없이 JSON만.`;
      }

      const result = await generateText({
        model: anthropic(DATA_AGENT_MODEL),
        tools: {
          webSearch: anthropic.tools.webSearch_20250305({ maxUses: count * 2 }),
          webFetch: anthropic.tools.webFetch_20250910({ maxUses: count * 2 }),
        } as any,
        maxSteps: 12,
        system: systemPrompt,
        prompt,
        temperature: 0,
      });

      const toolCalls = result.steps
        .flatMap((s) => s.toolCalls ?? [])
        .map((t) => t.toolName)
        .join(", ");
      console.log(
        `[DATA_AGENT] steps=${result.steps.length} tools=[${toolCalls}]`
      );

      const parsed = extractJson(result.text);
      if (parsed.length === 0) {
        console.warn(
          "[DATA_AGENT] Failed to parse JSON. Raw:",
          result.text.slice(0, 400)
        );
        return { products: [], contextSummary: "" };
      }

      // Filter already-shown products
      const filtered = parsed.filter((p: any) => {
        const name = String(p.name ?? "");
        return !excludeNames.some(
          (ex) => name.includes(ex) || ex.includes(name)
        );
      });

      const products: ProductData[] = filtered
        .slice(0, count)
        .map((p: any, i: number) => {
          const name = String(p.name ?? `제품 ${i + 1}`);
          let imageUrl = String(p.image ?? "");
          
          // Fix protocol-relative URLs commonly returned by Korean shopping sites (e.g., //img.danawa.com/...)
          if (imageUrl.startsWith("//")) {
            imageUrl = `https:${imageUrl}`;
          } else if (imageUrl.startsWith("/") && p.link) {
            try {
              const urlObj = new URL(p.link);
              imageUrl = `${urlObj.origin}${imageUrl}`;
            } catch (e) {
              // ignore
            }
          }

          return {
            id: `ws-${Date.now()}-${i}`,
            name,
            price: String(p.price ?? "가격 미정"),
            image: imageUrl,
            link: String(p.link ?? ""),
            brand: extractBrand(name),
            mallName: "웹 검색",
            description: name,
            specs: Array.isArray(p.specs) ? p.specs.map(String) : [],
          };
        });

      console.log(`[DATA_AGENT] Returning ${products.length} products.`);

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
            `Specs: ${p.specs.join(" / ")}\n` +
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
