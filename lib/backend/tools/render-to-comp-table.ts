import { tool } from "ai";
import { z } from "zod";
import { generateUISpec } from "../agents/ui_agent";
import { computeSpecCoverage } from "../services/spec-lookup";
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
      .describe("Always 'ComparisonTable' for Comparative Evaluation."),
  }),
  execute: async ({ intent_summary, ui_intent_category }) => {
    // ⚠️ currentRequestId는 전역 변수 — execute 시작 시점에 캡처해야
    // 다른 요청이 동시에 시작해 전역을 덮어쓰더라도 올바른 requestId를 사용
    const capturedRequestId = currentRequestId;

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

    // 로컬 DB 커버리지만 계산(네트워크 호출 없음) — 미커버 기준의 실제 검색/판단은
    // buildAndAssembleTable(STEP0) → enrichCompTableCells(STEP2)가 한 번의 병렬 배치로
    // 처리한다. 예전엔 여기서 Tavily까지 미리 돌려(enrichContextWithTavily) 그 결과를
    // 기다린 뒤에야 STEP2가 시작됐는데, STEP2가 어차피 남은 기준을 전부 커버하므로
    // 그 대기는 순수한 순차 barrier였다 — 제거하면 두 단계가 합쳐져 지연이 줄어든다.
    console.log("\n[Coverage] Local DB 스펙 vs. Decision Criteria 커버리지 점검 시작...");
    const productLogs = computeSpecCoverage(rawContext, currentDecisionCriteria);
    console.log("[Coverage] ✅ 커버리지 점검 완료 — 미커버 기준은 enrichCompTableCells(STEP2)에서 병렬 검색");

    // MD 로그 저장
    writeCompTableLog(productLogs, currentDecisionCriteria);

    try {
      const uiSpecString = await generateUISpec(
        rawContext,
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
            if (capturedRequestId) pushCompTableResult(capturedRequestId, uiSpec);
            return uiSpec;
          }
        }

        const cleanStr = uiSpecString
          .replace(/^```(?:json)?\s*\n?/, "")
          .replace(/\n?```\s*$/, "")
          .trim();
        const uiSpec = JSON.parse(cleanStr);
        if (capturedRequestId) pushCompTableResult(capturedRequestId, uiSpec);
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
