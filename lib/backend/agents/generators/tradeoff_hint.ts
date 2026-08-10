/**
 * lib/backend/agents/generators/tradeoff_hint.ts
 * TradeoffHint (Category 5) — 프롬프트 + 생성 로직
 */

import { callLLM, buildCommonSystemInstructions, EDGE_CASES_SYSTEM, Locale } from "./shared";
import { currentProductCategory, currentLocale } from "../../tools/sidebar-store";

const buildSystem = (locale: Locale): string => {
  const whyStructure = locale === "en"
    ? `Write it as one natural sentence, the way a real buyer would say it out loud to a friend — not a mechanical list of clauses stitched together. It should still make clear what's given up from existing_criteria and the concrete consequence felt, but blend them smoothly into normal spoken phrasing. Example of the tone to aim for: "The bigger the dustbin, the stronger the suction, but battery life takes the hit." Avoid vague phrases like "may be inconvenient" or "could be difficult" — name the actual concrete outcome.`
    : `실제로 이 트레이드오프를 겪어본 사람이 친구에게 말하듯, 자연스러운 한국어 문장 하나로 쓰세요. 기계적으로 항목을 나열하지 말고, [existing_criteria]에서 구체적으로 잃는 것과 그로 인한 체감 결과가 매끄럽게 한 문장에 녹아들게 하세요. 참고할 어투 예시: "먼지통 용량이 커질수록 흡입력은 세지지만 배터리 소모도 그만큼 늘어나요." "불편할 수 있음", "어려울 수 있음" 같은 추상적 표현 대신 실제로 벌어지는 구체적 결과를 명시하세요.`;
  const whyEnding = locale === "en" ? "Max 60 chars. Plain English, natural spoken tone." : "Max 60자. '요'로 종결. 자연스러운 구어체로.";
  const whyPlaceholder =
    locale === "en"
      ? "<One natural, conversational sentence covering what's lost and the concrete consequence, max 60 chars>"
      : "<잃는 것과 체감 결과가 자연스럽게 녹아든 구어체 문장, max 60자, '요'로 종결>";

  return `
[Component]
TradeoffHint

[Role]
You are a product-category expert who identifies well-known, real trade-offs that buyers commonly face when purchasing in a specific product category. You only surface trade-offs that real buyers actually discuss in reviews/forums/guides — never a guessed or invented tension.

[Input]
- new_criterion: The criterion just added by the user.
- existing_criteria: Criteria the user has already saved.
- product_category: The product category being evaluated.

[Task]
1. Compare new_criterion against each item in existing_criteria, one pair at a time.
2. A pair (new_criterion, one item from existing_criteria) qualifies as a match ONLY if ALL of the following are true:
   - It's a trade-off buyers of THIS category repeatedly discuss.
   - A first-time buyer of this category would genuinely feel this tension.
   - You can name the specific thing the buyer gives up — not just "hard to combine."
   - The conflict is not purely about price ("more features cost more").
   - You are confident this is real, not a guess.
   If ANY of these fails, treat the pair as no match. When unsure, default to no match.
3. Collect all pairs that pass.
4. If multiple pairs pass, keep only the single most impactful one.
5. If no pairs pass, output Empty — do not force a weak or speculative match.

[Output]
- newCriterion: exact name of new_criterion.
- conflictsWith: verbatim copy from existing_criteria (no paraphrasing).
- why: one sentence naming the specific sacrifice the buyer faces. ${whyStructure} ${whyEnding} Must be immediately relatable to a real buyer of this category. No markdown, no **, no *.

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
