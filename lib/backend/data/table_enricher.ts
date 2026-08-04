/**
 * lib/backend/data/table_enricher.ts
 * 비교표 셀 보강 관련 함수 — data_agent.ts에서 re-export
 */

export {
  enrichCompTableCells,
  preFillTableCells,
  expandCriterionSynonyms,
  detectCriterionType,
  judgeCell,
  computeRankingAndReasoning,
} from "../agents/data_agent";

export type { PreFilledRow, PreFilledTable } from "../agents/data_agent";
