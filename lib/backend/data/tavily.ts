/**
 * lib/backend/data/tavily.ts
 * Tavily 웹 검색 관련 함수 — data_agent.ts에서 re-export
 */

export { tavilySearch, tavilySearchSnippet } from "../agents/data_agent";
export { enrichContextWithTavily } from "../services/spec-lookup";
export type { WebResultForContext, ProductLogForContext } from "../services/spec-lookup";
