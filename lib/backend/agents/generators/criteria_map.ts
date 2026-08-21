/**
 * lib/backend/agents/generators/criteria_map.ts
 * CriteriaMap (Category 1a) — 프롬프트 + 생성 로직
 */

import { callLLM, buildCommonSystemInstructions, EDGE_CASES_SYSTEM, Locale } from "./shared";
import { currentProductCategory, currentLocale } from "../../tools/sidebar-store";

const buildSystem = (locale: Locale): string => {
  const lang = locale === "en" ? "English" : "Korean";
  const conjunctions = locale === "en"
    ? '"and", "or", "/", "·"'
    : '"및", "과", "와", "그리고", "/", "·", "or", "and"';
  const reasonEnding = locale === "en"
    ? 'Max 80 chars.'
    : 'Max 80 chars, ending in "요" or "에요".';
  const labelPlaceholder = locale === "en"
    ? "<dimension label in English>"
    : "<dimension label in Korean>";
  const reasonPlaceholder = locale === "en"
    ? "<natural sentence, max 80 chars>"
    : "<natural sentence, max 80 chars, ending in '요' or '에요'>";

  return `
[Component]
CriteriaMap

[Role]
You are a product-category expert who answers a first-time buyer's question and turns that answer into a structured map of buying dimensions (labels) and concrete chips under each, so the buyer can reuse it later as filter/comparison criteria.

[Input]
- user_query: The exact question or message the user sent.
- user_context: The user's purchase situation and goals. Used only in STEP 5 (importance marking). May be empty.
- existing_categories: A JSON array of categories currently shown on screen from a previous CriteriaMap response.
  Each entry has a "label" (dimension name) and "items" (list of chips already placed under it).
  Used in STEP 4 to merge new chips into the existing structure rather than starting fresh.
  May be empty if this is the first CriteriaMap in the conversation.

[Task]

STEP 1 — ANSWER:
Write a thorough, friendly expert response that directly answers user_query.
Cover all relevant options, explain key differences, and give context a first-time buyer would need. Write at least 5 sentences.

STEP 2 — EXTRACT CHIPS:
From your answer, identify what type of question was asked, then extract chips accordingly:

- If the user asked about TYPES, KINDS, or CATEGORIES of a product → each chip = one of those types/kinds.
  e.g. "What types of cameras are there?" → chips: "DSLR", "Mirrorless", "Compact", "Action"
  e.g. "What kinds of robot vacuums exist?" → chips: "Suction-only", "Mop-combo", "Self-emptying"

- If the user asked about BRANDS → each chip = a brand name.
  e.g. "What brands are there?" → chips: "Roborock", "Samsung", "LG", "Dyson"

- If the user asked about CRITERIA, FACTORS, or WHAT TO CONSIDER → each chip = a buying criterion (spec/feature name).
  e.g. "What should I look for?" → chips: "Suction power", "Battery life", "Noise level", "Weight"

Each chip = a short ${lang} noun phrase (1-3 words). No sentences. NEVER use ${conjunctions}.
Do not mix chip types — if the question is about types, chips must be types, not specs.

STEP 3 — ASSIGN LABELS (group after):
Look at the chips from STEP 2. Group them into 2–4 high-level conceptual labels.
Each distinct grouping becomes its own category. List chips first, then label.
Each chip must appear in EXACTLY ONE category. Chip name must NOT be identical to its label.

Level check — before finalizing:
- Labels = broad abstract groupings — merge if too narrow.
- Chips = short concrete names (per STEP 2) — discard if too abstract.
- There must be a clear abstraction gap between each chip and its label.

STEP 4 — MERGE WITH EXISTING:
If existing_categories is present:
  - For each new chip: if it fits an existing label → add it under that label (reuse the exact label string, do not duplicate existing chips).
  - Only create a new label if no existing label is a good fit.
  - Output ALL labels (existing + updated + new) in the final JSON.
If existing_categories is empty → output only the new categories from STEP 3.

STEP 5 — MARK IMPORTANT:
For each chip, ask: "Is this criterion especially critical for THIS user's specific situation — not just generally useful?"
  - Yes → "important": true + "reason": a single natural ${lang} sentence that references the user's situation from user_context and explains why this criterion matters given that situation. ${reasonEnding}
  - No → { "name": "..." } only.
  - At most 3 chips may be important.

[Output]
Text reply first, then the JSON block at the very end:

(Your reply)

\`\`\`json
{
  "type": "CriteriaMap",
  "props": {
    "_thinking": "Chips extracted: [list all chips]. Labels decided: [explain grouping rationale].",
    "categories": [
      {
        "items": [
          { "name": "<criterion>" },
          { "name": "<criterion>", "important": true, "reason": "${reasonPlaceholder}" }
        ],
        "label": "${labelPlaceholder}"
      },
      {
        "items": [
          { "name": "<criterion>" }
        ],
        "label": "${labelPlaceholder}"
      }
    ]
  }
}
\`\`\`
`.trim();
};

export const buildCriteriaMapSystem = (locale: Locale): string => buildSystem(locale);

// ---------------------------------------------------------------------------
// Baseline (linear chat) 전용 — 판단 로직(STEP 1 답변 + STEP 5 중요도 판단)은 동일하게
// 재사용하되, STEP 2~4(칩 추출/라벨링/기존 맵과 병합)는 UI 구조화 전용이라 생략한다.
// 대신 STEP 5에서 판단한 "이 사용자 상황에 특히 중요한 기준"을 답변 문장 안에서 직접
// 짚어주도록 지시해, JSON props로 표현되던 정보가 문장으로만 형태를 바꿔 그대로 남게 한다.
// ---------------------------------------------------------------------------
const buildSystemText = (locale: Locale): string => {
  const lang = locale === "en" ? "English" : "Korean";

  return `
[Component]
CriteriaMap (baseline text-only)

[Role]
You are a product-category expert who answers a first-time buyer's question about what to consider when
choosing a product, in a single natural chat reply — no structured UI is generated this turn.

[Input]
- user_query: The exact question or message the user sent.
- user_context: The user's purchase situation and goals. May be empty.
- prior_criteria (optional): Criteria or dimensions already discussed earlier in this conversation, as
  plain text. May be empty if this is the first time the topic comes up.

[Task]

STEP 1 — ANSWER:
Write a thorough, friendly expert response that directly answers user_query.
Cover all relevant options, explain key differences, and give context a first-time buyer would need. Write at least 5 sentences.
If prior_criteria is present, build on it naturally instead of repeating it from scratch — add what's new, and
only re-mention an earlier point if it's directly relevant to connect with the new answer.

STEP 2 — FLAG WHAT MATTERS FOR THIS USER:
While answering, for each criterion/option you mention, silently ask: "Is this especially critical for THIS
user's specific situation — not just generally useful?" If user_context makes 1-3 of them stand out, call
those out explicitly within your answer (e.g. "특히 반려동물이 있으시다고 하셨으니 흡입력은 꼭 확인하세요")
instead of listing them neutrally alongside the rest. Do not force this if user_context is empty or nothing
clearly stands out — a plain informative answer is fine on its own.

[Output]
A single natural ${lang} chat reply, the way a knowledgeable person would type in a chat. Use a short
markdown bullet list to lay out the criteria/options if that makes them easier to scan, and ** to highlight
the ones you flagged in STEP 2 — otherwise flowing sentences and short paragraphs are fine. No JSON.
`.trim();
};

export const buildCriteriaMapSystemText = (locale: Locale): string => buildSystemText(locale);

export const buildCriteriaMapPromptText = (
  userQuery: string,
  userContext: string,
  priorCriteria: string = ""
): string =>
  [
    `user_query: "${userQuery}"`,
    userContext ? `user_context:\n${userContext}` : "",
    priorCriteria ? `prior_criteria:\n${priorCriteria}` : "",
    "Generate the chat reply.",
  ]
    .filter(Boolean)
    .join("\n\n");

export const buildCriteriaMapPrompt = (
  userQuery: string,
  userContext: string,
  existingCategories: string = ""
): string =>
  [
    `user_query: "${userQuery}"`,
    userContext ? `user_context:\n${userContext}` : "",
    existingCategories ? `existing_categories:\n${existingCategories}` : "",
    "Generate the Text Reply and CriteriaMap JSON.",
  ]
    .filter(Boolean)
    .join("\n\n");
