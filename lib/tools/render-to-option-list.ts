import { tool } from "ai";
import { z } from "zod";
import { generateUISpec } from "../agents/ui_agent";
import { searchProducts } from "../agents/data_agent";
import {
  currentRequestId,
  pushOptionListResult,
  currentUserContext,
  currentSavedItems,
  currentDecisionCriteria,
  currentMyItemsContextSummary,
} from "./sidebar-store";

// ---------------------------------------------------------------------------
// Helper: parse + push UI spec JSON
// ---------------------------------------------------------------------------

function parseAndPush(uiSpecString: string): any {
  // Robust parser: find the first '{' and its matching '}'
  const firstBrace = uiSpecString.indexOf("{");
  if (firstBrace !== -1) {
    let lastBrace = -1;
    let stack = 0;
    for (let i = firstBrace; i < uiSpecString.length; i++) {
      if (uiSpecString[i] === "{") stack++;
      if (uiSpecString[i] === "}") stack--;
      if (stack === 0) {
        lastBrace = i;
        break;
      }
    }
    if (lastBrace !== -1) {
      const jsonPart = uiSpecString.substring(firstBrace, lastBrace + 1);
      const uiSpec = JSON.parse(jsonPart);
      if (currentRequestId) pushOptionListResult(currentRequestId, uiSpec);
      return uiSpec;
    }
  }

  // Fallback: strip markdown fences
  const cleanStr = uiSpecString
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
  const uiSpec = JSON.parse(cleanStr);
  if (currentRequestId) pushOptionListResult(currentRequestId, uiSpec);
  return uiSpec;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const renderToOptionList = tool({
  description:
    "Render a ProductCardList UI component to the Option List panel. " +
    "Use this ONLY for Category 3 (Product Recommendation).\n\n" +
    "## renderToOptionList Tool Arguments\n" +
    "- intent_summary: Brief summary of the current user goal in English.\n" +
    "- ui_intent_category: Always '3' for Product Recommendation.\n" +
    "- ui_context: Detailed summary of the products to recommend (user's request in Korean).",
  inputSchema: z.object({
    ui_context: z
      .string()
      .describe("Detailed summary of the data and context to be visualized."),
    intent_summary: z
      .string()
      .describe("Brief description of the user's intent."),
    ui_intent_category: z
      .string()
      .nullable()
      .describe("Always '3' for Product Recommendation."),
  }),
  execute: async ({ ui_context, intent_summary, ui_intent_category }) => {
    console.log(
      [
        "[Tool: renderToOptionList] CALLED",
        `  category     : ${ui_intent_category}`,
        `  intent       : ${intent_summary}`,
        `  ui_context   : ${ui_context.slice(0, 100)}`,
      ].join("\n")
    );

    try {
      let resolvedContext: string;

      if (ui_context.trim() === "[MY ITEMS REQUESTED]") {
        // --- My Items 요청: 사전 로드된 컨텍스트 사용 ---
        resolvedContext = currentMyItemsContextSummary;
        console.log("[renderToOptionList] Using pre-fetched My Items context.");
      } else {
        // --- 일반 추천 (Intent 3): 다나와 검색 → Claude fallback ---
        console.log(`[renderToOptionList] Fetching Danawa products for: "${ui_context.slice(0, 80)}"`);
        const alreadyShownNames = currentSavedItems.map((item) => {
          const pipeIdx = item.indexOf("|");
          return pipeIdx !== -1 ? item.slice(0, pipeIdx).trim() : item.trim();
        });

        const searchResult = await (searchProducts.execute as any)({
          query: ui_context,
          count: 4,
          excludeNames: alreadyShownNames,
        });

        if (searchResult?.contextSummary) {
          resolvedContext = searchResult.contextSummary;
          console.log(`[renderToOptionList] Got ${searchResult.products?.length ?? 0} products from data agent.`);
        } else {
          // 완전 실패 시 원본 텍스트 그대로 넘김 (Claude 지식으로 처리)
          resolvedContext = ui_context;
          console.warn("[renderToOptionList] searchProducts returned no context. Using raw ui_context.");
        }
      }

      const uiSpecString = await generateUISpec(
        resolvedContext,
        intent_summary,
        ui_intent_category,
        1,
        currentUserContext,
        currentSavedItems,
        currentDecisionCriteria
      );

      if (uiSpecString && !uiSpecString.startsWith("ERROR:")) {
        return parseAndPush(uiSpecString);
      }

      return { error: uiSpecString };
    } catch (err) {
      console.error("[Tool: renderToOptionList] Error:", err);
      return {
        error: `오류: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
