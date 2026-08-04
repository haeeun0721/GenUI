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
