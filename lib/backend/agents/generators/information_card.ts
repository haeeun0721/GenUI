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

[Input]
- user_query: The exact question or message the user sent.

[Instructions]
Write a friendly, expert response in ${lang} that directly answers user_query.
- Start by directly answering what the concept is.
- Explain how it works and why it matters to the buyer.
- Give a concrete, relatable real-world example.
- The response should feel like a knowledgeable friend explaining — not a dictionary definition.

Then, from your response, extract the following for the UI card:
- term: the core noun/term being explained. Write it in ${lang}.
- summary: a single-sentence definition in ${lang}. Max 30 chars.
- points: 2–3 key takeaways from your response — each a concise ${lang} phrase.

[Output Format]
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
      "<key point 1 in ${lang}>",
      "<key point 2 in ${lang}>",
      "<key point 3 if clearly present — optional>"
    ]
  }
}
\`\`\`
`.trim();
};

export const buildInformationCardSystem = (locale: Locale): string => buildSystem(locale);

export const buildInformationCardPrompt = (
  userQuery: string
): string =>
  [
    `user_query: "${userQuery}"`,
    "Generate the Text Reply and InformationCard JSON.",
  ].join("\n\n");

