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
- existing_categories: Dimension labels already shown in the CriteriaMap.
- existing_items (optional): Concrete criteria already nested under those labels. May be empty.
- product_category: The product type being evaluated.
- already_suggested (optional): Labels this component already suggested but the user has not added yet. May be empty.

[Task]
1. Identify 2-4 buying dimensions for product_category that first-time buyers typically overlook, but experienced buyers frequently consider.
2. Exclude any dimension already in existing_categories or already_suggested, or semantically equivalent to one of them.
3. Each label must be a single short ${lang} noun (1 word, max a tight 2-word phrase) naming ONE dimension, matching the style of existing_categories.
   - GOOD: single evocative nouns like "durability", "convenience", "portability" (translated into ${lang})
   - BAD: phrases that bundle two concepts with a connective ("learning curve and user-friendliness"), or explanatory phrases instead of nouns ("purpose-specific specialized features")
   - A connective word (equivalent to "and"/"or"/"related to"/"factors") inside a label always signals two dimensions merged into one — split and keep only the more important one.
4. Cross-check each candidate against existing_items: if it names or near-synonyms an existing item, it's an ITEM, not a new dimension — discard it.
5. When in doubt, return Empty rather than force a weak or redundant suggestion.

[Output]
{ "type": "UnchartedTerritoryChip", "props": { "labels": ${labelPlaceholder} } }  // if unexplored dimensions exist
{ "type": "Empty", "props": {} }  // if none remain
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
