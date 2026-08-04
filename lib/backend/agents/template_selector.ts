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

- InformationCard: The user wants to understand a specific term, spec, or concept. The answer is a single factual explanation — there is one correct answer. The response is not expected to feed into a later filtering or comparison step; it is purely for comprehension. Examples: "OIS가 뭐야?", "광각·망원·초광각은 서로 어떻게 달라?", "이 스펙이 제품에서 왜 중요해?"

- CriteriaMap: The user wants to know what factors or criteria to consider when choosing a product in a given domain. The answer is a structured list of purchasing dimensions that can later be reused as filter, comparison, or scoring criteria. Examples: "카메라 살 때 어떤 항목들을 확인해야 해?", "로봇청소기 고를 때 중요한 기준이 뭐야?", "나중에 제품 비교할 때 기준으로 삼을 만한 요소들은?"

To classify ambiguous cases, apply these three tests in order:
1. Is the response explaining a concept, or producing a list of things to consider when buying?
   → Concept explanation → InformationCard. List of purchasing criteria → CriteriaMap.
2. Will this information likely be reused in a later filter, comparison, or scoring step?
   → Yes → CriteriaMap. No → InformationCard.
3. Does the question read as "what is X / how does X differ?" or "what should I look at when buying / what are the criteria?"
   → Former → InformationCard. Latter → CriteriaMap.

- ComparisonTable: The user names two or more specific products and wants them evaluated side-by-side. The response is a structured table comparing those products across specs.

- ProductCardList: The user wants to see a list of actual buyable products with prices and specs. The response is a browsable set of product cards.

[Output]
Respond with ONLY a JSON object:
{ "template": "CriteriaMap" | "InformationCard" | "ComparisonTable" | "ProductCardList" }
`.trim();



export async function selectTemplate(
  intentAnalysis: IntentAnalysis,
  hasOptionList: boolean,
  currentProductNames: string[] = [],
  currentProducts?: Array<{ name: string; priceNum: number | null; priceStr: string; specs: string[] }>
): Promise<TemplateSelection> {
  console.log(`\n\x1b[33m========== [3] Template Selector ==========\x1b[0m`);
  console.log(`\x1b[90m[Input] hasOptionList:\x1b[0m ${hasOptionList}`);
  console.log(`\x1b[90m[Input] currentProductNames:\x1b[0m [${currentProductNames.join(', ')}]`);
  console.log(`\x1b[90m[Input] IntentAnalysis:\x1b[0m ${JSON.stringify(intentAnalysis, null, 2)}`);

  // Build product context for LLM - helps disambiguate ComparisonTable vs ProductCardList
  const productListForPrompt = hasOptionList
    ? (() => {
      const products = currentProducts ?? currentProductNames.map(n => ({ name: n, priceNum: null, priceStr: '', specs: [] }));
      return `CURRENT_OPTION_LIST (name | 가격(원) | 주요 스펙):
${products.map(p =>
        `- ${p.name}${p.priceNum != null ? ` | ${p.priceNum.toLocaleString()}원` : ''}${p.specs.length > 0 ? ` | ${p.specs.join(', ')}` : ''}`
      ).join('\n')}`;
    })()
    : '';

  const promptText = [
    `intent_analysis: "${intentAnalysis.user_goal}"`,
    productListForPrompt,
    "Select the appropriate template.",
  ].filter(Boolean).join('\n');

  // 제어 문자 제거:  등 비가시 문자가 LLM에 들어가면 garbage output 발생
  const sanitize = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  const cleanPrompt = sanitize(promptText);

  const { object } = await generateObject({
    model: openai(SELECTOR_MODEL),
    schema: TemplateSelectionSchema,
    mode: "json",           // structured output 대신 JSON 모드 사용 ( 버그 방지)
    system: buildSelectorPrompt(),
    prompt: cleanPrompt,
    temperature: 0,
    maxOutputTokens: 200,
  });

  console.log(`\x1b[32m[Output] Selected Template:\x1b[0m\n${JSON.stringify(object, null, 2)}`);
  console.log(`\x1b[33m===========================================\x1b[0m\n`);

  return object;
}
