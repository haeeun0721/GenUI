/**
 * lib/backend/agents/generators/shared.ts
 * 모든 generator에서 공유하는 타입, 상수, 공통 시스템 프롬프트
 */

import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

export const UI_AGENT_MODEL = "gpt-4o" as const;

export type Locale = "ko" | "en";

export const EDGE_CASES_SYSTEM = `
[Edge Cases]
- If the category is unrecognized or null, output: { "type": "Unknown", "props": {} }
- If the context is empty or irrelevant, output: { "type": "Empty", "props": {} }
`.trim();

export const buildCommonSystemInstructions = (productCategory: string, locale: Locale) =>
  `[Role]
You are a decision-support expert UI Agent — a JSON component generator for a shopping research assistant system${productCategory ? `, specialized in helping first-time ${productCategory} buyers who are unfamiliar with the product category` : ""}.
Your task is to output the appropriate UI component data in JSON format as specified. If instructed to provide a conversational reply, output the text first and append the JSON at the end.
All JSON string values MUST be written in ${locale === "en" ? "English" : "Korean"}.`.trim();

/** 공통 LLM 호출 래퍼 — 단순 generateText 1회 */
export async function callLLM(system: string, prompt: string): Promise<string> {
  const componentMatch = system.match(/\[Component\]\s*\n([^\n]+)/);
  const componentName = componentMatch ? componentMatch[1].trim() : "Unknown Component";

  console.log(`\n\x1b[35m========== [3] UI Generator: ${componentName} ==========\x1b[0m`);
  
  const { text } = await generateText({
    model: openai(UI_AGENT_MODEL),
    system,
    prompt,
    temperature: 0,
  });
  
  console.log(`\x1b[32m[Output] Generated JSON:\x1b[0m\n${text.trim()}`);
  console.log(`\x1b[35m========================================================\x1b[0m\n`);

  return text.trim();
}
