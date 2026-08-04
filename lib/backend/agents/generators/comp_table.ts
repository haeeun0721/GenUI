/**
 * lib/backend/agents/generators/comp_table.ts
 * ComparisonTable (Category 2) — LLM JSON skeleton generation only.
 *
 * Responsibility: Generate a JSON skeleton with all cells set to "-".
 * Data preparation, enrichment, and ranking are handled by data_agent.ts.
 */

import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { UI_AGENT_MODEL, buildCommonSystemInstructions, EDGE_CASES_SYSTEM, Locale } from "./shared";
import { currentProductCategory, currentLocale } from "../../tools/sidebar-store";

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

const buildSystem = (locale: Locale): string => {
  return `
[Component]
Table 

[Input]
- product_data: Product specs, prices, and details retrieved for comparison.
- decision_criteria: Criteria from the user's Decision Criteria panel.
- FIXED_ROWS (optional): Exact row order override — use these criteria labels as rows, in this order.

[Instructions]

TABLE LAYOUT — TRANSPOSED (Criteria = Rows, Products = Columns):
- columns[0]: { "key": "criterion", "label": "${locale === "en" ? "Criteria" : "비교 항목"}" }
- columns[1..N]: one column per product — key = "prod_0", "prod_1", ...; label = shortened product name (≤12 chars); imageUrl = URL from 'Image:' line in product_data (never omit)
- rows[0]: Rank row — all cells "-"
- rows[1..M]: one row per decision_criteria item — all cells "-"

CRITERION ROWS:
- CRITICAL: one row per item in decision_criteria — no skipping, no merging, no adding extras.
- Row label = criterion name, strip parenthetical notes and importance brackets.
  e.g., "Foldability (input: must be foldable) [High]" → "Foldability"
- If a criterion describes a product type, output "-" for that row.

CELLS:
- Output "-" for every data cell — no exceptions.
- _rankReasoning: ""

[Output]
{
  "type": "Table",
  "props": {
    "_rankReasoning": "",
    "columns": [
      { "key": "criterion", "label": "${locale === "en" ? "Criteria" : "비교 항목"}" },
      { "key": "prod_0", "label": "<short name ≤12 chars>", "imageUrl": "<URL from 'Image:' line>" },
      { "key": "prod_1", "label": "<short name ≤12 chars>", "imageUrl": "<URL from 'Image:' line>" }
    ],
    "rows": [
      { "criterion": "${locale === "en" ? "Rank" : "순위"}", "prod_0": "-", "prod_1": "-" },
      { "criterion": "<criterion label>", "prod_0": "-", "prod_1": "-" }
    ]
  }
}
`.trim();
};

// ---------------------------------------------------------------------------
// User Prompt
// ---------------------------------------------------------------------------

const buildPrompt = (
  uiContext: string,
  decisionCriteria: string[],
  currentRows: string[]
): string => {
  const fixedRows =
    currentRows && currentRows.length > 0
      ? `\nFIXED_ROWS (must use exactly these criteria as rows, in this order — do NOT add or remove any):\n${currentRows.join(", ")}`
      : "";

  return [
    decisionCriteria.length > 0 ? `decision_criteria: ${decisionCriteria.join(", ")}` : "",
    fixedRows,
    `product_data:\n${uiContext}`,
    "Generate the Table JSON.",
  ]
    .filter(Boolean)
    .join("\n\n");
};

// ---------------------------------------------------------------------------
// JSON 파싱 헬퍼 (exported for use by orchestrator in data_agent)
// ---------------------------------------------------------------------------

export function parseTableJson(text: string): Record<string, unknown> | null {
  // 1차: {…} 추출
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const jsonStr = match ? match[0].replace(/,\s*([\}\]])/g, "$1") : null;
    if (jsonStr) return JSON.parse(jsonStr);
  } catch { }

  // 2차: 마크다운 코드블록 제거 후 재시도
  try {
    const cleaned = text
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .replace(/,\s*([\}\]])/g, "$1")
      .trim();
    return JSON.parse(cleaned);
  } catch { }

  return null;
}

// ---------------------------------------------------------------------------
// Main export — LLM JSON skeleton generation only
// @deprecated orchestrateCompTablePipeline가 buildAndAssembleTable()(코드)로 대체하여
//             이 함수는 더 이상 파이프라인에서 호출되지 않습니다.
//             하위 호환성을 위해 파일은 유지됩니다.
// ---------------------------------------------------------------------------

/** @deprecated Use buildAndAssembleTable() in data_agent.ts instead */
export async function generateCompTable(
  uiContext: string,
  decisionCriteria: string[],
  currentRows: string[] = []
): Promise<Record<string, unknown> | null> {
  const locale = currentLocale;
  const productCategory = currentProductCategory;

  const system = [
    buildCommonSystemInstructions(productCategory, locale),
    buildSystem(locale),
    EDGE_CASES_SYSTEM,
  ].join("\n\n");

  const prompt = buildPrompt(uiContext, decisionCriteria, currentRows);

  console.log("\n\x1b[35m========== [3] UI Generator: Table ==========\x1b[0m");
  const s1 = Date.now();

  const { text } = await generateText({
    model: openai(UI_AGENT_MODEL),
    system,
    prompt,
    temperature: 0,
  });

  console.log(`\x1b[33m[Table Generator] LLM 완료 (${Date.now() - s1}ms)\x1b[0m`);

  const tableJson = parseTableJson(text);
  if (!tableJson) {
    console.error("\x1b[31m[Table Generator] JSON 파싱 실패. LLM 원문:\x1b[0m", text.slice(0, 300));
  }
  return tableJson;
}
