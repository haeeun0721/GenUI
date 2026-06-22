import { tool } from "ai";
import { z } from "zod";
import { generateUISpec } from "../agents/ui_agent";
import {
  currentRequestId,
  pushCompTableResult,
  currentUserContext,
  currentSavedItems,
  currentDecisionCriteria,
  currentMyItemsContextSummary,
} from "./sidebar-store";

export const renderToCompTable = tool({
  description:
    "Render a comparison Table UI component to the Comparison Table panel. " +
    "Use this ONLY for Category 2 (Comparative Evaluation).\n\n" +
    "## renderToCompTable Tool Arguments\n" +
    "- intent_summary: Brief summary of the current user goal in English.\n" +
    "- ui_intent_category: Always '2' for Comparative Evaluation.\n" +
    "- ui_context: Use '[MY ITEMS REQUESTED]' to trigger pre-fetched My Items data for comparison.",
  inputSchema: z.object({
    ui_context: z
      .string()
      .describe("Use '[MY ITEMS REQUESTED]' to compare user's saved items."),
    intent_summary: z
      .string()
      .describe("Brief description of the user's intent."),
    ui_intent_category: z
      .string()
      .nullable()
      .describe("Always '2' for Comparative Evaluation."),
  }),
  execute: async ({ ui_context, intent_summary, ui_intent_category }) => {
    console.log(
      [
        "[Tool: renderToCompTable] OUTPUT FORMAT",
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
            if (currentRequestId) pushCompTableResult(currentRequestId, uiSpec);
            return uiSpec;
          }
        }

        // Fallback: strip markdown fences
        const cleanStr = uiSpecString
          .replace(/^```(?:json)?\s*\n?/, "")
          .replace(/\n?```\s*$/, "")
          .trim();
        const uiSpec = JSON.parse(cleanStr);
        if (currentRequestId) pushCompTableResult(currentRequestId, uiSpec);
        return uiSpec;
      }

      return { error: uiSpecString };
    } catch (err) {
      console.error("[Tool: renderToCompTable] Parsing Error:", err);
      return {
        error: `JSON 파싱 오류: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
