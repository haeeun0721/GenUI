import { tool } from "ai";
import { z } from "zod";
import { generateUISpec } from "../agents/ui_agent";
import { enrichContextWithTavily } from "../agents/data_agent";
import { writeCompTableLog } from "../logger";
import {
  currentRequestId,
  pushCompTableResult,
  currentUserContext,
  currentSavedItems,
  currentDecisionCriteria,
  currentMyItemsContextSummary,
} from "./sidebar-store";



// ---------------------------------------------------------------------------
// Tool Export
// ---------------------------------------------------------------------------

export const renderToCompTable = tool({
  description: "Render a comparison Table UI component to the Comparison Table panel. Use for Category 2 (Comparative Evaluation).",
  inputSchema: z.object({
    intent_summary: z
      .string()
      .describe("Brief description of the user's intent."),
    ui_intent_category: z
      .string()
      .nullable()
      .describe("Always '2' for Comparative Evaluation."),
  }),
  execute: async ({ intent_summary, ui_intent_category }) => {
    console.log(
      [
        "[Tool: renderToCompTable] OUTPUT FORMAT",
        `  category     : ${ui_intent_category}`,
        `  intent       : ${intent_summary}`,
      ].join("\n")
    );

    const rawContext = currentMyItemsContextSummary;

    console.log("[renderToCompTable] decision_criteria:", currentDecisionCriteria);
    console.log("[renderToCompTable] saved_items:", currentSavedItems);
    console.log("[renderToCompTable] product_data length:", rawContext.length);

    console.log("\n[Pre-enrich] Local DB 스펙 vs. Decision Criteria 커버리지 점검 시작...");
    const { enriched: enrichedContext, productLogs } = await enrichContextWithTavily(
      rawContext,
      currentDecisionCriteria
    );
    const wasEnriched = enrichedContext !== rawContext;
    console.log(
      wasEnriched
        ? "[Pre-enrich] ✅ 웹 스펙 보강 완료 → 보강된 context로 Claude 호출"
        : "[Pre-enrich] ✅ Local DB 스펙만으로 충분 → 원본 context로 Claude 호출"
    );

    // MD 로그 저장
    writeCompTableLog(productLogs, currentDecisionCriteria);

    try {
      const uiSpecString = await generateUISpec(
        enrichedContext,
        intent_summary,
        ui_intent_category,
        1,
        currentUserContext,
        currentSavedItems,
        currentDecisionCriteria
      );

      if (uiSpecString && !uiSpecString.startsWith("ERROR:")) {
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
