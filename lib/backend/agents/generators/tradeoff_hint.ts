/**
 * lib/backend/agents/generators/tradeoff_hint.ts
 * TradeoffHint (Category 5) — 프롬프트 + 생성 로직
 */

import { callLLM, buildCommonSystemInstructions, EDGE_CASES_SYSTEM, Locale } from "./shared";
import { currentProductCategory, currentLocale } from "../../tools/sidebar-store";

const buildSystem = (locale: Locale): string => {
  const whyEnding = locale === "en" ? "Max 60 chars. Plain English." : "Max 60자. '요'로 종결.";
  const whyPlaceholder =
    locale === "en"
      ? "<one sentence: what the buyer must give up — max 60 chars>"
      : "<구매자가 실제로 포기해야 하는 것 — max 60자, '요'로 종결>";

  return `
[Component]
TradeoffHint 

[Role]
You identify well-known, real trade-offs that buyers commonly face when
purchasing in a specific product category. Only surface trade-offs that
real buyers actually discuss in reviews/forums/guides.

[Input]
- new_criterion: The criterion just added by the user.
- existing_criteria: Criteria the user has already saved.
- product_category: The product category being evaluated.

[Pass Criteria — ALL must be true]
For a pair (new_criterion, one item from existing_criteria) to qualify:
  1. It's a trade-off buyers of THIS category repeatedly discuss.
  2. A first-time buyer of this category would genuinely feel this tension.
  3. You can name the specific thing the buyer gives up — not just "hard
     to combine."
  4. The conflict is not purely about price ("more features cost more").
  5. You are confident this is real, not a guess.

If ANY criterion fails → treat as no match. When unsure, default to no match.

[Process]
1. Compare new_criterion against each item in existing_criteria using the
   Pass Criteria above.
2. Collect all pairs that pass.
3. If multiple pass, output only the single most impactful one.
4. If none pass, output Empty.

[Output]
- newCriterion: exact name of new_criterion
- conflictsWith: verbatim copy from existing_criteria (no paraphrasing)
- why: one sentence naming the specific sacrifice the buyer faces.
  ${whyEnding}
  Must be immediately relatable to a real buyer of this category.
  No markdown, no **, no *.

If a genuine, well-known trade-off exists:
{
  "type": "TradeoffHint",
  "props": {
    "newCriterion": "<exact name of new_criterion>",
    "conflictsWith": "<verbatim copy from existing_criteria>",
    "why": "${whyPlaceholder}"
  }
}

If not:
{ "type": "Empty", "props": {} }
`.trim();
};

export async function generateTradeoffHint(uiContext: string): Promise<string> {
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
