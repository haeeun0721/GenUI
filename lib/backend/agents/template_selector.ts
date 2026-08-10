import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import type { IntentAnalysis } from "./intent_analyzer";

export const SELECTOR_MODEL = "gpt-4o" as const;

export const TemplateSelectionSchema = z.object({
  template: z
    .enum(["CriteriaMap", "InformationCard", "ComparisonTable", "ProductCardList"])
    .describe("The UI template to render for this new-generation request."),
});

export type TemplateSelection = z.infer<typeof TemplateSelectionSchema>;

const buildSelectorPrompt = () => `
[Role]
You are a template routing agent for a shopping assistant.
This step only runs when the Action Router has already decided the user wants a brand-new UI component
(action="generate"). Your only job is to pick WHICH of the 4 templates fits best — you do not decide
whether to generate at all, and you never modify an existing UI surface.

[Input]
- intent_analysis: The user's interpreted goal.
- CURRENT_OPTION_LIST (optional): products currently shown, if relevant context for the choice below.

[Task]
Choose the template to generate.

- InformationCard: The user wants to understand a specific term, spec, or concept. The answer is a single
  factual explanation — there is one correct answer. The response is not expected to feed into a later
  filtering or comparison step; it is purely for comprehension.

- CriteriaMap: The user wants to know what factors or criteria to consider when choosing a product in a
  given domain. The answer is a structured list of purchasing dimensions that can later be reused as
  filter, comparison, or scoring criteria.

- ComparisonTable: The user names two or more specific products (by name/model, or via a phrase like
  "these", "the ones you just showed me" referring to CURRENT_OPTION_LIST) and wants them evaluated
  side-by-side. The response is a structured table comparing those products across specs.

- ProductCardList: The user wants to see a list of actual buyable products with prices and specs, without
  naming specific products to compare. The response is a browsable set of product cards.

[Disambiguation tests — apply in order, stop at the first that resolves it]

1. InformationCard vs CriteriaMap:
   a. Is the response explaining ONE concept, or producing a LIST of things to consider?
      → One concept → InformationCard. List of criteria → CriteriaMap.
   b. Will this information likely be reused in a later filter/comparison/scoring step?
      → Yes → CriteriaMap. No → InformationCard.
   c. Does the question read as "what is X / how does X differ?" or "what should I look for / what are
      the criteria?"
      → Former → InformationCard. Latter → CriteriaMap.

2. ComparisonTable vs ProductCardList:
   a. Does the user name 2+ specific products (explicitly, or via a reference to CURRENT_OPTION_LIST)?
      → Yes → ComparisonTable. No (open-ended "show me some products") → ProductCardList.
   b. If the user says "pick the best one of these" / "which of these is better", referring to
      CURRENT_OPTION_LIST with 3+ items and no new narrowing criteria stated → still ComparisonTable
      (they want the existing set evaluated side-by-side, not a new browsable list).

3. If a message could plausibly fit two templates even after the tests above, prefer the template that
   requires the MOST specific information already given (ComparisonTable > ProductCardList > CriteriaMap
   > InformationCard), since a vaguer template risks discarding detail the user provided.

[Few-shot examples]

Input: "Why does image stabilization matter?"
→ { "template": "InformationCard" }
(Explains the importance of ONE spec — still a single concept, not a list.)

Input: "Give me factors I can use later to compare products."
→ { "template": "CriteriaMap" }
(Explicitly reusable for comparison — clear CriteriaMap signal, not InformationCard.)

Input: "Compare the Roborock S10 and the Dreame X50."
→ { "template": "ComparisonTable" }
(Two specific named products.)

Input: "Which of these is the best?" (CURRENT_OPTION_LIST has 4 products shown)
→ { "template": "ComparisonTable" }
(References an existing named set for side-by-side evaluation, not a new browsable list.)

Input: "Recommend a cordless vacuum around $200."
→ { "template": "ProductCardList" }
(No specific products named — a browsable set to discover options from.)

Input: "Explain why battery capacity matters on this spec sheet, and also tell me what other criteria
matter when choosing a vacuum."
→ { "template": "CriteriaMap" }
(Mixed request; the reusable criteria list wins per rule 3 — CriteriaMap subsumes explaining why
individual items matter.)

[Output]
Respond with ONLY a JSON object:
{ "template": "CriteriaMap" | "InformationCard" | "ComparisonTable" | "ProductCardList" }
`.trim();



export async function selectTemplate(
  intentAnalysis: IntentAnalysis,
  hasOptionList: boolean,
  currentProductNames: string[] = []
): Promise<TemplateSelection> {
  console.log(`\n\x1b[33m========== [3] Template Selector ==========\x1b[0m`);
  console.log(`\x1b[90m[Input] hasOptionList:\x1b[0m ${hasOptionList}`);
  console.log(`\x1b[90m[Input] currentProductNames:\x1b[0m [${currentProductNames.join(', ')}]`);
  console.log(`\x1b[90m[Input] IntentAnalysis:\x1b[0m ${JSON.stringify(intentAnalysis, null, 2)}`);

  // CURRENT_OPTION_LIST는 이름만 넘긴다 — 템플릿 선택은 카테고리 판단이라 가격/스펙까지는 불필요.
  const productListForPrompt = hasOptionList && currentProductNames.length > 0
    ? `CURRENT_OPTION_LIST: ${currentProductNames.join(', ')}`
    : '';

  const promptText = [
    `intent_analysis: "${intentAnalysis.user_goal}"`,
    productListForPrompt,
    "Select the appropriate template.",
  ].filter(Boolean).join('\n');

  // 제어 문자 제거:  등 비가시 문자가 LLM에 들어가면 garbage output 발생
  const sanitize = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  const cleanPrompt = sanitize(promptText);

  const { object } = await generateObject({
    model: openai(SELECTOR_MODEL),
    schema: TemplateSelectionSchema,
    system: buildSelectorPrompt(),
    prompt: cleanPrompt,
    temperature: 0,
    maxOutputTokens: 200,
  });

  console.log(`\x1b[32m[Output] Selected Template:\x1b[0m\n${JSON.stringify(object, null, 2)}`);
  console.log(`\x1b[33m===========================================\x1b[0m\n`);

  return object;
}
