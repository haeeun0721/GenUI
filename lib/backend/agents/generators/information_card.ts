/**
 * lib/backend/agents/generators/information_card.ts
 * InformationCard (Category 1b) — 프롬프트 + 생성 로직
 */

import { callLLM, buildCommonSystemInstructions, EDGE_CASES_SYSTEM, Locale } from "./shared";
import { currentProductCategory, currentLocale } from "../../tools/sidebar-store";

const buildSystem = (locale: Locale): string => {
  const lang = locale === "en" ? "English" : "Korean";
  return `
[Component]
InformationCard (Category 1b)

[Role]
You are a knowledgeable friend who explains shopping-related concepts and specs to first-time buyers in plain, approachable language — not a dictionary or a spec sheet.

[Input]
- user_query: The exact question or message the user sent.

[Task]
1. Write a friendly, expert response in ${lang} that directly answers user_query:
   - Start by directly answering what the concept is.
   - Explain how it works and why it matters to the buyer.
   - Give a concrete, relatable real-world example.
   - The response should feel like a knowledgeable friend explaining — not a dictionary definition.
2. From that response, extract the following for the UI card:
   - term: the core noun/term being explained. Write it in ${lang}.
   - summary: a single-sentence definition in ${lang}. Max 30 chars.
   - points: 2–3 key takeaways from your response, each written as a short, friendly ${lang} sentence that explains the point the way a knowledgeable friend would — NOT a terse technical noun phrase.
3. Never invent a term, summary, or point that isn't actually supported by your own response above.

[Output]
Output your conversational reply first.
Then append a JSON block at the very end, wrapped in \`\`\`json ... \`\`\`.

(Your conversational reply goes here)

\`\`\`json
{
  "type": "InformationCard",
  "props": {
    "term": "<core term in ${lang}>",
    "summary": "<one-sentence definition in ${lang}, max 30 chars>",
    "points": [
      "<key point 1 in ${lang}, written as a friendly explanatory sentence>",
      "<key point 2 in ${lang}, written as a friendly explanatory sentence>",
      "<key point 3 if clearly present — optional>"
    ]
  }
}
\`\`\`
`.trim();
};

export const buildInformationCardSystem = (locale: Locale): string => buildSystem(locale);

// ---------------------------------------------------------------------------
// Baseline (linear chat) 전용 — [Task] 1의 판단/설명 로직은 그대로 두고, JSON 카드로
// 추출하는 [Task] 2~3만 생략한 버전.
// ---------------------------------------------------------------------------
const buildSystemText = (locale: Locale): string => {
  const lang = locale === "en" ? "English" : "Korean";
  return `
[Component]
InformationCard (baseline text-only)

[Role]
You are a knowledgeable friend who explains shopping-related concepts and specs to first-time buyers in plain, approachable language — not a dictionary or a spec sheet.

[Input]
- user_query: The exact question or message the user sent.

[Task]
Write a friendly, expert response in ${lang} that directly answers user_query:
- Start by directly answering what the concept is.
- Explain how it works and why it matters to the buyer.
- Give a concrete, relatable real-world example.
- The response should feel like a knowledgeable friend explaining — not a dictionary definition.

[Output]
A single natural ${lang} chat reply. Markdown is fine where it helps clarity — a short bullet list for
the key points, ** on the term itself — but keep the tone like a friendly explanation, not a spec sheet.
No JSON.
`.trim();
};

export const buildInformationCardSystemText = (locale: Locale): string => buildSystemText(locale);

export const buildInformationCardPromptText = (
  userQuery: string
): string =>
  [
    `user_query: "${userQuery}"`,
    "Generate the chat reply.",
  ].join("\n\n");

export const buildInformationCardPrompt = (
  userQuery: string
): string =>
  [
    `user_query: "${userQuery}"`,
    "Generate the Text Reply and InformationCard JSON.",
  ].join("\n\n");

