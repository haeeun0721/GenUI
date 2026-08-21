/**
 * lib/backend/agents/generators/product_card_list.ts
 * ProductCardList (Category 3) — 프롬프트 + 생성 로직
 */

import { callLLM, buildCommonSystemInstructions, buildCommonSystemInstructionsText, Locale } from "./shared";
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

// ---------------------------------------------------------------------------
// Baseline (linear chat) 전용 — grounding 규칙(제품당 2-3개 스펙, product_data에 있는
// 값만 사용, 없는 값은 지어내지 않음)은 그대로 유지하되 카드 JSON 대신 소개 문단/목록
// 문장으로 출력한다. main과 달리 "WebSpecs(from web search)"로 이중 소스가 구분되지
// 않으므로 그 언급은 뺐다 — baseline의 product_data는 "Specs:" 한 줄뿐이다.
// ---------------------------------------------------------------------------
const buildSystemText = (locale: Locale): string => {
  const lang = locale === "en" ? "English" : "Korean";
  return `
[Component]
ProductCardList (baseline text-only)

[Role]
You are a product-listing expert who introduces real retail search results to a first-time buyer in a natural chat reply.

[Input]
- product_data: Product specs and prices retrieved from product search.

[Task]
1. Introduce every product from product_data — minimum 1.
2. specs: mention 2-3 per product MAX. Short ${lang} phrases reflecting user-relevant meaning — no raw numbers or model codes dumped verbatim.
3. GROUNDING (CRITICAL): Every spec you mention MUST be derived only from this product's own "Specs:" line in product_data — never from your own prior/outside knowledge of the product. If product_data doesn't state a value for something, omit it entirely rather than filling it in from memory.
4. price: state it in the underlying Korean Won format exactly as given — do not fabricate a currency conversion.
5. Never invent a product, brand, price, or spec that isn't present in product_data.
6. images: this is a plain-text chat with no image rendering. Never include an image URL or link in your reply, even if asked — say a photo can't be shown here instead.
7. If you group products under a price-range heading (e.g. "40만원대 모델들"), double-check the digit count — Korean prices use "만" (10,000) units, so 400,000~500,000원 is "40만~50만원대", NOT "400~500원대". Dropping "만" silently shrinks the price by four digits.

[Output]
A single natural ${lang} chat reply introducing the products. Use a short markdown bullet list per product
(bold the name/price, then its specs) if that's clearer than paragraphs — otherwise short paragraphs are
fine. No JSON — plain text only, no card layout.
`.trim();
};

export const buildProductCardListSystemText = (locale: Locale): string => buildSystemText(locale);

export const buildProductCardListPromptText = (uiContext: string): string =>
  [`product_data:\n${uiContext}`, "Generate the chat reply introducing these products."].join("\n\n");

const buildPromptText = buildProductCardListPromptText;

export async function generateProductCardListText(uiContext: string): Promise<string> {
  const locale = currentLocale;
  const productCategory = currentProductCategory;
  const system = [
    buildCommonSystemInstructionsText(productCategory, locale),
    buildSystemText(locale),
  ].join("\n\n");

  return callLLM(system, buildPromptText(uiContext));
}

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
