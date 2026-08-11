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

[Role]
You are a product-listing expert who converts raw retail search data into a clean, buyer-facing set of product cards for a shopping research assistant.

[Input]
- product_data: Product specs, prices, and images retrieved from product search.

[Task]
1. Include ALL recommended products from product_data inside the 'cards' array — minimum 1 card.
2. CRITICAL: ALWAYS output a valid ProductCardList. NEVER output { "type": "Empty" }, even if product_data is sparse.
3. brand: extract from product_data (brand field → first word of product name → seller name). NEVER leave blank.
4. imageUrl: copy exactly from product_data if available. If not available, omit the field — never invent a URL.
5. specs: 2-3 items MAX per card. Short ${lang} phrases reflecting user-relevant meaning — no raw numbers or model codes.
6. GROUNDING (CRITICAL): Every spec phrase MUST be derived only from this product's own "Specs:" and "WebSpecs (from web search):" lines in product_data — never from your own prior/outside knowledge of the product. If product_data doesn't state a value for something, omit that spec entirely rather than filling it in from memory. "WebSpecs" values were already looked up and verified specifically for this request — prefer them over guessing.${locale === "en" ? `
7. name/brand: product_data is a Korean retail catalog, so names/brands often arrive in Korean (e.g. "모바 M1", brand "모바"). Render them in English: transliterate the Korean brand/model word into its natural English spelling (e.g. "모바" → "Moba"), and keep any existing Latin letters, numbers, or model codes exactly as-is (e.g. "M330 Pro" stays "M330 Pro"). Never leave a Korean (Hangul) word in name or brand.` : ""}

[Output]
{
  "type": "ProductCardList",
  "props": {
    "cards": [
      {
        "id": "<unique_id>",
        "name": "<product name>",
        "brand": "<brand name>",
        "price": "<price — MUST be in a single unified currency format. The underlying market/prices are Korean Won; do not fabricate a currency conversion. Use the ${locale === "en" ? "'₩' symbol before the number, e.g. '₩329,990'" : "Korean '원' suffix, e.g. '329,990원'"} format.>",
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
