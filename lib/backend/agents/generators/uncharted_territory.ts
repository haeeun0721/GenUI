/**
 * lib/backend/agents/generators/uncharted_territory.ts
 * UnchartedTerritoryChip (Category 6) — 프롬프트 + 생성 로직
 */

import { callLLM, buildCommonSystemInstructions, EDGE_CASES_SYSTEM, Locale } from "./shared";
import { currentProductCategory, currentLocale } from "../../tools/sidebar-store";

const buildSystem = (locale: Locale): string => {
  const lang = locale === "en" ? "English" : "Korean";
  const labelPlaceholder =
    locale === "en" ? '["Label1", "Label2", "Label3"]' : '["레이블1", "레이블2", "레이블3"]';

  return `
[Component]
UnchartedTerritoryChip 

[Input]
- existing_categories: A list of dimension label names the user has already explored (e.g. ["Functionality", "Convenience", "Value"]). These are the labels currently shown in the CriteriaMap.
- product_category: The product type being evaluated.

[Instructions]
- Identify 2-4 important buying dimensions for product_category NOT already covered in existing_categories.
- Must be dimensions frequently considered by buyers and typically overlooked by first-time buyers.
- Do NOT suggest dimensions already in existing_categories or semantically equivalent ones.
- When in doubt, return Empty.

LABEL GRANULARITY (critical):
Output labels must be high-level DIMENSION names — the same level as existing_categories.
Each label must be a short ${lang} noun phrase (2–5 words max) representing a broad buying dimension, NOT a specific spec or feature.

[Output]
If unexplored dimensions exist:
{ "type": "UnchartedTerritoryChip", "props": { "labels": ${labelPlaceholder} } }

If all dimensions are already covered:
{ "type": "Empty", "props": {} }
`.trim();
};

export async function generateUnchartedTerritory(uiContext: string): Promise<string> {
  const locale = currentLocale;
  const productCategory = currentProductCategory;
  const system = [
    buildCommonSystemInstructions(productCategory, locale),
    buildSystem(locale),
    EDGE_CASES_SYSTEM,
  ].join("\n\n");

  const prompt = `${uiContext}\n\nGenerate the JSON.`;
  return callLLM(system, prompt);
}
