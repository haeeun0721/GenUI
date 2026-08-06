/**
 * lib/backend/agents/ui_agent.ts
 * UI Agent — 얇은 오케스트레이터 (category → generator 분기만 담당)
 *
 * 각 컴포넌트의 프롬프트 + 생성 로직은 generators/ 하위 파일에 위치합니다:
 *   generators/criteria_map.ts        — CriteriaMap (Cat 1a)
 *   generators/information_card.ts    — InformationCard (Cat 1b)
 *   generators/comp_table.ts          — ComparisonTable (Cat 2) — 표 구조 생성 + WSM 순위/이유
 *   generators/product_card_list.ts   — ProductCardList (Cat 3)
 *   generators/tradeoff_hint.ts       — TradeoffHint (Cat 5)
 *   generators/uncharted_territory.ts — UnchartedTerritoryChip (Cat 6)
 */


import { orchestrateCompTablePipeline } from "./generators/comp_table";
import { generateProductCardList }   from "./generators/product_card_list";
import { generateTradeoffHint }      from "./generators/tradeoff_hint";
import { generateUnchartedTerritory } from "./generators/uncharted_territory";

/**
 * 기존 호출부(update-table, check-tradeoff, unexplored-areas, tools/*)와의
 * 호환성을 유지하기 위해 동일한 시그니처를 보존합니다.
 */
export async function generateUISpec(
  uiContext: string,
  intentSummary: string = "",
  category: string | null = null,
  turnNumber: number = 1,
  userContext: string = "",
  savedItems: string[] = [],
  decisionCriteria: string[] = [],
  currentRows: string[] = []
): Promise<string> {
  console.log(`\n\x1b[35m[UI Agent] category=${category} | generator 분기 시작\x1b[0m`);

  try {
    // CriteriaMap (Cat 1a)
    if (category === "CriteriaMap" || category === "1a") {
      throw new Error("CriteriaMap is now handled directly via streamText in route.ts");
    }

    // InformationCard (Cat 1b)
    if (category === "InformationCard" || category === "1b") {
      throw new Error("InformationCard is now handled directly via streamText in route.ts");
    }

    // ComparisonTable (Cat 2)
    if (category === "ComparisonTable" || category === "2") {
      return await orchestrateCompTablePipeline(uiContext, decisionCriteria, savedItems, currentRows);
    }

    // ProductCardList (Cat 3)
    if (category === "ProductCardList" || category === "3") {
      return await generateProductCardList(uiContext);
    }

    // TradeoffHint (Cat 5) — check-tradeoff/route.ts 에서 호출
    if (category === "TradeoffHint" || category === "5") {
      return await generateTradeoffHint(uiContext);
    }

    // UnchartedTerritoryChip (Cat 6) — unexplored-areas/route.ts 에서 호출
    if (category === "UnchartedTerritoryChip" || category === "6") {
      return await generateUnchartedTerritory(uiContext);
    }

    // 알 수 없는 카테고리
    console.warn(`[UI Agent] 알 수 없는 category: "${category}" → Empty 반환`);
    return JSON.stringify({ type: "Unknown", props: {} });

  } catch (err) {
    console.error("[UI Agent] Critical Error:", err);
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}