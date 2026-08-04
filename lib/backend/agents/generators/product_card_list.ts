/**
 * lib/backend/agents/generators/product_card_list.ts
 * ProductCardList (Category 3) — 프롬프트 + 생성 로직
 */

import { callLLM, buildCommonSystemInstructions, Locale } from "./shared";
import { currentProductCategory, currentLocale } from "../../tools/sidebar-store";

const buildSystem = (locale: Locale, productCategory: string): string => {
  const lang = locale === "en" ? "English" : "Korean";
  return `
[Component]
ProductCardList

[Input]
- product_data: Product specs, prices, and images retrieved from product search.

[Instructions]
- CRITICAL: ALWAYS output a valid ProductCardList. NEVER output { "type": "Empty" }.
- Include ALL recommended products inside the 'cards' array. Minimum 1 card.
- Copy imageUrl from product_data exactly if available. If not available, omit the field.
- brand: Extract from product_data (brand field → first word of product name → seller name). NEVER leave blank.
- specs: 2-3 items MAX. Short ${lang} phrases reflecting user-relevant meaning. No raw numbers or model codes.

[Output]
{
  "type": "ProductCardList",
  "props": {
    "cards": [
      {
        "id": "<unique_id>",
        "name": "<product name>",
        "brand": "<brand name>",
        "price": "<price — MUST be in a single unified currency format (e.g. KRW '원'). Convert USD or other currencies to KRW if necessary.>",
        "imageUrl": "<image URL — copy exactly from product_data, or omit if unavailable>",
        "specs": ["<${lang} spec phrase 1>", "<${lang} spec phrase 2>", "<${lang} spec phrase 3>"]
      }
    ]
  }
}
`.trim();
};

const buildPrompt = (uiContext: string): string =>
  [`product_data:\n${uiContext}`, "Generate the ProductCardList JSON."].join("\n\n");

export async function generateProductCardList(uiContext: string): Promise<string> {
  const locale = currentLocale;
  const productCategory = currentProductCategory;
  // Category 3: EDGE_CASES_SYSTEM 제외 (항상 카드 출력해야 함)
  const system = [
    buildCommonSystemInstructions(productCategory, locale),
    buildSystem(locale, productCategory),
  ].join("\n\n");

  const prompt = buildPrompt(uiContext);
  return callLLM(system, prompt);
}
