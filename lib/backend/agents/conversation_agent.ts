import { ToolLoopAgent, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { renderToSidebar } from "../tools/sidebar";
import { renderToOptionList } from "../tools/render-to-option-list";
import { renderToCompTable } from "../tools/render-to-comp-table";
import { currentLocale } from "../tools/sidebar-store";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const buildInstructions = (productCategory: string, locale: "ko" | "en") => `
You are a decision-support expert agent helping first-time ${productCategory ? `${productCategory} ` : ""}buyers who are unfamiliar with the product category.
You serve as the Conversation Agent — the central orchestrator of a shopping research assistant system.
Your task is to classify the user's query intent and call the appropriate tool.
${
  locale === "en"
    ? "All conversational text responses MUST be written in English."
    : "All conversational text responses MUST be written in Korean."
}

## INTENT CLASSIFICATION

| Category | Label                  | Trigger condition |
|----------|------------------------|-------------------|
| 1a       | Decision Criteria      | The user's question helps them form a DECISION CRITERION — the answer tells them what to look for, what options exist, or what factors matter when buying. Key test: can the answer become chips on a decision criteria map? Examples: "어떤 종류가 있어?", "무게 기준으로 뭘 봐야 해?", "어떤 브랜드를 고려해야 해?" |
| 1b       | Background Info        | The user wants to UNDERSTAND a concept, spec, or technology — not to use it as a decision criterion. Key test: the answer is factual background knowledge that informs but doesn't directly shape what to buy. Examples: "서스펜션이 뭐야?", "퍼스트 에어 바퀴가 뭔지 설명해줘", "ISO-FIX가 뭐야?" |
| 2        | Comparative Evaluation | User wants to directly compare two or more specific named products or models. |
| 3        | Product Recommendation | User wants specific product suggestions based on needs, budget, or use case. |

## OUTPUT

Category 1a / 1b → Write a reply in ${locale === "en" ? "English" : "Korean"} (4-10 sentences), then call renderToExplorationJourney:
  - agent_reply: <your full reply>
  - intent_summary: <user's search intent, in English>
  - ui_intent_category: "1a" or "1b"
  - turn_number: <current turn number>

Category 2 → Call renderToCompTable:
  - intent_summary: <comparison intent, in English>
  - ui_intent_category: "2"

Category 3 → Call renderToOptionList:
  - search_query: <user's search request in Korean, extracted from [Decision Criteria :] tag if present>
  - intent_summary: <search intent, in English>
  - ui_intent_category: "3"

## RULES
- Do NOT use markdown tables in text replies. Use plain sentences only.
- Do NOT use emoji in any text reply.
- After calling any tool, stop. Do not generate additional text.
- Off-topic or unclassifiable: respond conversationally in ${locale === "en" ? "English" : "Korean"} without calling any tool.
`.trim();

// ---------------------------------------------------------------------------
// Agent Factory
// ---------------------------------------------------------------------------

export function createAgent(productCategory: string = "") {
  return new ToolLoopAgent({
    model: anthropic(process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL),
    instructions: buildInstructions(productCategory, currentLocale),
    tools: {
      renderToExplorationJourney: renderToSidebar,
      renderToOptionList,
      renderToCompTable,
    },
    stopWhen: stepCountIs(12),
    temperature: 0,
    maxTokens: 4096,
  });
}
