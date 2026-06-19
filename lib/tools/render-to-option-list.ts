import { tool } from "ai";
import { z } from "zod";
import { generateUISpec } from "../agents/ui_agent";
import {
  currentRequestId,
  pushOptionListResult,
  currentUserContext,
  currentSavedItems,
  currentDecisionCriteria,
  currentMyItemsContextSummary,
} from "./sidebar-store";

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
        "[Tool: renderToOptionList] OUTPUT FORMAT",
        `  category     : ${ui_intent_category}`,
        `  intent       : ${intent_summary}`,
        `  ui_context   : ${ui_context}`,
      ].join("\n")
    );

    const resolvedContext =
      ui_context.trim() === "[MY ITEMS REQUESTED]"
        ? currentMyItemsContextSummary
        : ui_context;

    try {
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
        // ROBUST PARSER: Find the first '{' and its matching '}'
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

      return { error: uiSpecString };
    } catch (err) {
      console.error("[Tool: renderToOptionList] Parsing Error:", err);
      return {
        error: `JSON 파싱 오류: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
