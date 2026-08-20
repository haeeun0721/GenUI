/**
 * lib/backend/agents/generators/tradeoff_hint.ts
 * TradeoffHint (Category 5) — 프롬프트 + 생성 로직
 */

import { callLLM, buildCommonSystemInstructions, EDGE_CASES_SYSTEM, Locale } from "./shared";
import { currentProductCategory, currentLocale } from "../../tools/sidebar-store";

const buildSystem = (locale: Locale): string => {
  const whyStructure = locale === "en"
    ? `Write it as one natural sentence, the way a real buyer would say it out loud to a friend — not a mechanical list of clauses stitched together. It should still make clear what's given up from existing_criteria and the concrete consequence felt, but blend them smoothly into normal spoken phrasing. Write for a first-time buyer who has zero background in this product category: use a plain cause → effect shape ("X 하면 Y 해서 Z 돼요") instead of naming the mechanism as a technical fact. Skip engineering/spec jargon (materials, chip names, physics terms) unless a total beginner would already know the word; if the mechanism needs a technical term to be accurate, translate it into an everyday image instead (e.g. instead of "정전용량 방식이라", say "화면이 손끝을 감지하는 방식이라"). Example of the tone to aim for: "The bigger the dustbin, the stronger the suction, but battery life takes the hit." Avoid vague phrases like "may be inconvenient" or "could be difficult" — name the actual concrete outcome, in words a non-expert immediately pictures.`
    : `실제로 이 트레이드오프를 겪어본 사람이 친구에게 말하듯, 자연스러운 한국어 문장 하나로 쓰세요. 기계적으로 항목을 나열하지 말고, [existing_criteria]에서 구체적으로 잃는 것과 그로 인한 체감 결과가 매끄럽게 한 문장에 녹아들게 하세요. 이 제품 카테고리를 전혀 모르는 초보 구매자가 한 번에 이해할 수 있도록, "~하면 ~해서 ~해요"처럼 원인→결과가 바로 보이는 쉬운 문장으로 쓰세요. 소재명, 부품명, 전문 스펙 용어처럼 초보자가 모를 단어는 쓰지 말고, 꼭 필요하면 일상적인 비유나 감각적 표현으로 풀어서 설명하세요 (예: "정전용량 방식이라" 대신 "화면이 손끝을 감지하는 방식이라"). 참고할 어투 예시: "먼지통 용량이 커질수록 흡입력은 세지지만 배터리 소모도 그만큼 늘어나요." "불편할 수 있음", "어려울 수 있음" 같은 추상적 표현 대신, 비전문가도 바로 그림이 그려지는 구체적 결과를 명시하세요.`;
  const whyEnding = locale === "en" ? "Max 60 chars. Plain English, natural spoken tone." : "Max 60자. '요'로 종결. 자연스러운 구어체로.";
  const whyPlaceholder =
    locale === "en"
      ? "<One natural, conversational sentence covering what's lost and the concrete consequence, max 60 chars>"
      : "<잃는 것과 체감 결과가 자연스럽게 녹아든 구어체 문장, max 60자, '요'로 종결>";

  return `
[Component]
TradeoffHint

[Role]
You are a product-category expert who identifies well-known trade-offs
that meaningfully affect what buyers actually choose when purchasing in
a specific product category. You only surface trade-offs that would
change a real buyer's decision — never a technically-true-but-irrelevant
tension, and never a guessed or invented one.

[Input]
- new_criterion: The criterion just added by the user.
- existing_criteria: Criteria the user has already saved.
- product_category: The product category being evaluated.

[Task]
Compare new_criterion against each item in existing_criteria, one pair at a time.
For EACH pair, work through the checklist below IN ORDER, writing a short internal
verdict (pass/fail) for each line before moving to the next. Do not skip ahead.

Checklist (a pair qualifies ONLY if it passes every line):

1. Decision impact (primary filter): If a buyer of this category leaned
   toward new_criterion, would the actual set of products they'd realistically
   pick from meaningfully shift away from products that satisfy the existing
   criterion? Would they end up choosing, or ruling out, different real
   products because of this? If the difference is marginal, already solved
   in most current products, or wouldn't change what a buyer ends up buying,
   FAIL.
2. Named mechanism: Can you state the concrete physical/technical/manufacturing
   reason these two properties pull against each other in THIS category?
   (e.g. "더 큰 배터리는 부피를 차지해 무게가 늘어난다" — a real causal link,
   not just "둘 다 좋기 어렵다".) If you cannot name a mechanism, FAIL.
3. Category-specific, not universal: Would this same tension apply to almost
   any product category (price vs quality, features vs simplicity, cheap vs
   durable in general)? If yes, FAIL — it must be a tension specific to how
   THIS category is engineered or manufactured.
4. Named sacrifice: Can you state exactly what the buyer gives up in one
   concrete phrase (not "harder to balance" or "trade-off exists")? If not, FAIL.
5. Not a price restatement: Is the tension about something other than
   "more of X costs more money"? If it's fundamentally a price statement, FAIL.

If any line fails, the pair is no match. Condition 1 is the most important
filter — a trade-off can be mechanistically real and still fail if it no
longer changes what buyers actually pick. When in doubt, treat as FAIL —
a missed real trade-off is a much smaller problem than surfacing one that
sounds smart but doesn't matter to the buyer.

[Few-shot calibration]
Category: 무선 이어폰
- new: "노이즈캔슬링 강함" / existing: "착용감 가벼움"
  → PASS: NC를 강하게 원하면 실제로 고를 수 있는 제품군이 좁아지고,
    가벼운 착용감을 우선하는 모델들과는 다른 라인업을 보게 됨.
- new: "음질 좋음" / existing: "가격 저렴함"
  → FAIL (조건 5): 가격 대비 트레이드오프는 범용적이라 제외.
- new: "밝은 화면" / existing: "얇은 두께" (예: 태블릿)
  → FAIL (조건 1): 요즘 제품들은 이 차이가 거의 없어져서, 이걸
    우선한다고 실제로 고를 수 있는 제품 목록이 달라지지 않음.
- new: "배터리 오래감" / existing: "디자인 예쁨"
  → FAIL (조건 2): 메커니즘 자체를 댈 수 없음. 억지 연결.

Category: 러닝화
- new: "쿠셔닝 좋음" / existing: "가벼움"
  → PASS: 쿠셔닝을 우선하면 실제로 다른 모델 라인(맥스 쿠션 계열)을
    보게 되고, 경량화 모델군과는 선택지가 갈림.

[Output]
- newCriterion: exact name of new_criterion, WITHOUT the "(중요)"/"(important)" importance marker
  even if new_criterion carries one in the input — that marker is for your own reference only
  (a plain user-facing card is not the place to repeat it), never part of the displayed name.
- conflictsWith: verbatim copy from existing_criteria (no paraphrasing), same rule — strip any
  trailing "(중요)"/"(important)" marker before outputting the name.
- why: one sentence naming the specific sacrifice the buyer faces, grounded in the mechanism
  from checklist step 2 AND framed around the real choice the buyer is making (checklist step 1).
  ${whyStructure} ${whyEnding} Must be immediately relatable to a real buyer of this category.
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
