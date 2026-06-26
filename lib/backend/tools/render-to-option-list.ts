import { tool, generateText } from "ai";
import { z } from "zod";
import { anthropic } from "@ai-sdk/anthropic";
import { generateUISpec } from "../agents/ui_agent";
import type { ProductData } from "../agents/data_agent";
import { ragSearch } from "../rag/search";
import {
  currentRequestId,
  pushOptionListResult,
  currentUserContext,
  currentSavedItems,
  currentDecisionCriteria,
  currentProductCategory,
} from "./sidebar-store";

// ---------------------------------------------------------------------------
// Helper: parse + push UI spec JSON
// ---------------------------------------------------------------------------

function parseAndPush(uiSpecString: string): any {
  const firstBrace = uiSpecString.indexOf("{");
  if (firstBrace !== -1) {
    let lastBrace = -1;
    let stack = 0;
    for (let i = firstBrace; i < uiSpecString.length; i++) {
      if (uiSpecString[i] === "{") stack++;
      if (uiSpecString[i] === "}") stack--;
      if (stack === 0) { lastBrace = i; break; }
    }
    if (lastBrace !== -1) {
      const uiSpec = JSON.parse(uiSpecString.substring(firstBrace, lastBrace + 1));
      if (currentRequestId) pushOptionListResult(currentRequestId, uiSpec);
      return uiSpec;
    }
  }
  const cleanStr = uiSpecString.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  const uiSpec = JSON.parse(cleanStr);
  if (currentRequestId) pushOptionListResult(currentRequestId, uiSpec);
  return uiSpec;
}

// ---------------------------------------------------------------------------
// Step 1: Build enriched search keyword from criteria + category
// ---------------------------------------------------------------------------

// 다나와 검색은 카테고리 키워드만 사용.
// "한손폴딩", "가벼운" 같은 feature 키워드는 다나와 검색엔진이 처리 못함.
// feature 필터링은 AI Reranker가 스펙 데이터를 보고 처리.
const NOISE_WORDS = /추천해줘|추천|알려줘|찾아줘|보여줘|검색해줘|검색|구매|제품|상품|골라줘|뭐가 좋아|뭐가좋아/g;
const DANAWA_CATEGORY_MAP: [RegExp, string][] = [
  [/유모차|stroller|베이비카|pram/i,          "유모차"],
  [/로봇\s*청소기|robot\s*vacuum|룸바/i,      "로봇청소기"],
  [/에어프라이어|air\s*fryer/i,               "에어프라이어"],
  [/노트북|laptop|맥북/i,                     "노트북"],
  [/청소기|vacuum/i,                          "청소기"],
  [/세탁기|washing\s*machine/i,               "세탁기"],
  [/냉장고|refrigerator/i,                    "냉장고"],
  [/공기청정기|air\s*purifier/i,              "공기청정기"],
];

function buildSearchKeyword(searchQuery: string, productCategory: string): string {
  // 1순위: 쿼리에서 카테고리 키워드 추출
  for (const [pattern, keyword] of DANAWA_CATEGORY_MAP) {
    if (pattern.test(searchQuery)) {
      console.log(`[buildSearchKeyword] "${searchQuery}" → "${keyword}" (카테고리 추출)`);
      return keyword;
    }
  }
  // 2순위: productCategory (온보딩에서 설정된 카테고리)
  if (productCategory) {
    console.log(`[buildSearchKeyword] "${searchQuery}" → "${productCategory}" (productCategory 사용)`);
    return productCategory;
  }
  // 3순위: 노이즈 제거 후 2단어
  const cleaned = searchQuery.replace(NOISE_WORDS, "").replace(/\s+/g, " ").trim();
  const fallback = cleaned.split(/\s+/).slice(0, 2).join(" ");
  console.log(`[buildSearchKeyword] "${searchQuery}" → "${fallback}" (fallback)`);
  return fallback;
}

// ---------------------------------------------------------------------------
// Step 2: AI Reranker — operates ONLY on real Danawa products
// AI never invents names. It only picks indices from the provided list.
// ---------------------------------------------------------------------------

interface RankedProduct {
  index: number;   // 0-based index into the candidateList
  reason: string;  // why this product fits the criteria
}

async function reRankByAI(
  candidates: ProductData[],
  userQuery: string,       // 사용자가 채팅에 입력한 내용만 기준으로 평가
  productCategory: string,
  targetCount: number = 6
): Promise<RankedProduct[]> {
  if (candidates.length === 0) return [];

  // Build a numbered list of real products (no hallucination possible)
  const productList = candidates.map((p, i) =>
    `[${i}] ${p.name} | ${p.price} | ${p.specs.slice(0, 4).join(" / ")}`
  ).join("\n");

  const { text } = await generateText({
    model: anthropic("claude-haiku-4-5"),
    system: `You are a product selector. You receive a numbered list of REAL products scraped from a Korean price comparison site.
Your job: select the ${targetCount} best products that match the user's request.

STRICT RULES:
1. You may ONLY select products from the provided numbered list [0], [1], [2], ...
2. NEVER invent, modify, or add any product not in the list.
3. Output ONLY a valid JSON array of objects: [{"index": N, "reason": "..."}]
4. "index" must be an integer matching the [N] prefix in the list.
5. "reason" must be 1 short sentence (in Korean) explaining why this product fits the request.
6. Select at most ${targetCount} products. Fewer is fine if not enough match.`,
    prompt: `Product category: ${productCategory || "consumer product"}
User's request: "${userQuery}"

Available products (ONLY choose from this list):
${productList}

Select the ${targetCount} products that best match the user's request. Output JSON array only.`,
    temperature: 0,
    maxTokens: 1024,
  });

  // Parse response — extract JSON array
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1) {
    console.warn("[reRankByAI] No JSON array found in response");
    return [];
  }

  let parsed: any[];
  try {
    parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
  } catch {
    console.warn("[reRankByAI] JSON parse failed");
    return [];
  }

  // Validate: only accept indices that actually exist in candidates
  const validated: RankedProduct[] = parsed
    .filter((r) => typeof r.index === "number" && r.index >= 0 && r.index < candidates.length)
    .map((r) => ({ index: Number(r.index), reason: String(r.reason ?? "") }));

  console.log(
    `\n\x1b[36m[AI Reranker] ${validated.length}/${candidates.length} 선별:\x1b[0m\n` +
    validated.map((r) => `  [${r.index}] ${candidates[r.index].name} — ${r.reason}`).join("\n") + "\n"
  );

  return validated;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const renderToOptionList = tool({
  description: "Render a ProductCardList UI component to the Option List panel. Use for Category 3 (Product Recommendation).",
  inputSchema: z.object({
    search_query: z
      .string()
      .describe("The user's search request (from [Decision Criteria :] tag if present)."),
    intent_summary: z
      .string()
      .describe("Brief description of the user's intent."),
    ui_intent_category: z
      .string()
      .nullable()
      .describe("Always '3' for Product Recommendation."),
  }),
  execute: async ({ search_query, intent_summary, ui_intent_category }) => {
    console.log(
      [
        "[Tool: renderToOptionList] CALLED",
        `  category     : ${ui_intent_category}`,
        `  intent       : ${intent_summary}`,
        `  search_query : ${search_query.slice(0, 100)}`,
        `  criteria     : [${currentDecisionCriteria.join(", ")}]`,
      ].join("\n")
    );

    const alreadyShownNames = currentSavedItems.map((item) => {
      const pipeIdx = item.indexOf("|");
      return pipeIdx !== -1 ? item.slice(0, pipeIdx).trim() : item.trim();
    });

    try {
      // ── Step 1: RAG 벡터 검색 ────────────────────────────────────────────
      // 쿼리 전체를 그대로 임베딩 → 의미적 유사도로 후보 20개 추출
      console.log(`[renderToOptionList] RAG 검색: "${search_query}"`);
      const candidates: ProductData[] = await ragSearch(
        `${search_query} ${intent_summary}`.trim(),
        currentProductCategory || "유모차",
        20,
        alreadyShownNames
      );
      console.log(`[renderToOptionList] RAG 결과: ${candidates.length}개 후보`);

      let resolvedContext = "";

      if (candidates.length > 0) {
        // ── Step 2: AI reranks from RAG results (no hallucination) ───────────
        const ranked = await reRankByAI(
          candidates,
          `${search_query} ${intent_summary}`.trim(),
          currentProductCategory,
          6
        );

        if (ranked.length > 0) {
          const selectedProducts = ranked.map((r) => candidates[r.index]);
          const contexts = selectedProducts.map((p, i) => {
            const reason = ranked[i].reason;
            // RAG 모듈에서 이미지 프록시 처리됨
            return [
              reason ? `[선택 이유: ${reason}]` : "",
              `Name: ${p.name}`,
              `Price: ${p.price}`,
              `Brand: ${p.brand}`,
              `Image: ${p.image}`,
              `Link: ${p.link}`,
              `Specs: ${p.specs.length > 0 ? p.specs.join(" / ") : "정보 없음"}`,
              `Description: ${p.description || "정보 없음"}`,
            ].filter(Boolean).join("\n");
          });
          resolvedContext = contexts.join("\n\n");
        } else {
          // AI reranker 실패 → RAG 상위 결과 그대로 사용
          console.warn("[renderToOptionList] AI reranker 0개 → RAG 상위 결과 사용");
          resolvedContext = candidates.slice(0, 6).map((p) =>
            `Name: ${p.name}\nPrice: ${p.price}\nImage: ${p.image}\nLink: ${p.link}\nSpecs: ${p.specs.join(" / ")}`
          ).join("\n\n");
        }
      }

      // ── Fallback: RAG 결과 없으면 쿼리 텍스트만 전달 ─────────────────────
      if (!resolvedContext.trim()) {
        console.warn("[renderToOptionList] RAG 결과 없음. 카테고리 데이터를 먼저 크롤링하세요.");
        resolvedContext = search_query;
      }

      // ── Step 4: UI Agent → ProductCardList ─────────────────────────────────
      const uiSpecString = await generateUISpec(
        resolvedContext,
        intent_summary,
        ui_intent_category,
        1,
        currentUserContext,
        currentSavedItems,
        currentDecisionCriteria
      );

      console.log(`[renderToOptionList] UI Agent 응답 (앞 200자): ${uiSpecString?.slice(0, 200)}`);

      if (uiSpecString && !uiSpecString.startsWith("ERROR:")) {
        return parseAndPush(uiSpecString);
      }

      console.error("[renderToOptionList] UI Agent ERROR 응답:", uiSpecString);
      return { error: uiSpecString };
    } catch (err) {
      console.error("[Tool: renderToOptionList] Error:", err);
      return { error: `오류: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
