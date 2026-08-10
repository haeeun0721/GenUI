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

[Role]
You are a product-category expert who surfaces important buying dimensions that first-time buyers of product_category typically overlook, so they can broaden the criteria they're already comparing.

[Input]
- existing_categories: A list of dimension label names the user has already explored. These are the labels currently shown in the CriteriaMap.
- existing_items (optional): Concrete criterion names already nested as items under those labels. May be empty.
- product_category: The product type being evaluated.
- already_suggested (optional): Labels this same component already suggested in an earlier turn that the user has not added yet. May be empty.

[Task]
1. Identify 2-4 important buying dimensions for product_category that are NOT already covered in existing_categories and NOT already in already_suggested.
2. Each dimension must be one buyers of this category frequently consider, but that first-time buyers typically overlook.
3. Never suggest a dimension already in existing_categories or already_suggested, or one that is semantically equivalent to any of those.
4. Match label granularity to existing_categories — output labels must be high-level DIMENSION names, not a specific spec or feature. Before finalizing each label, check it against existing_items: if it names (or is a near-synonym of) something already listed there, it is an ITEM, not a new dimension — do NOT output it as a label, since it already lives under an existing category. Each label must be a short ${lang} noun phrase (2–5 words max) representing a broad buying dimension.
5. When in doubt, return Empty — do not force a weak or redundant suggestion.

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
