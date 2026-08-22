/**
 * lib/backend/agents/action_router.ts
 * Action Router — "generate(새 구조화 답변 생성) vs none(대화만)"만 판단하는 최상위 라우터.
 *
 * main은 여기에 "edit(기존 UI 수정)"이 하나 더 있지만, baseline엔 수정할 대상이 되는
 * 영속 패널(Option List/Comparison Table/Criteria Map)이 아예 없어서 그 축을 제거했다 —
 * screen_state는 항상 비어있어 edit 조건이 이론상으로도 참이 될 수 없었고, 설령 라우터가
 * 실수로 edit를 골라도 하위 코드(chat_agent.ts)가 generate와 완전히 동일하게 처리하고
 * 있었다. template_selector.ts(어떤 템플릿을 생성할지)는 이 라우터가 "generate"를 고른
 * 경우에만 호출된다.
 */

import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type { IntentAnalysis } from "./intent_analyzer";

export const ROUTER_MODEL = "claude-haiku-4-5" as const;

export const ActionRouteSchema = z.object({
  action: z
    .enum(["generate", "none"])
    .describe(
      "'generate' = produce a fresh structured answer (new product data gathered into one of the four templates) | 'none' = conversational reply only, grounded in this conversation's own history and/or a quick lookup"
    ),
});

export type ActionRoute = z.infer<typeof ActionRouteSchema>;

const buildRouterPrompt = () => `
[Role]
You are the top-level action router for a shopping assistant. You do NOT pick a template —
your only job is to decide whether this turn needs a freshly generated structured answer or just a
conversational reply.

[Input]
- intent_analysis: the user's interpreted goal (from the Intent Analyzer) — a paraphrase, not the user's exact words.
- user_message: the user's LATEST message verbatim. Prefer this over the paraphrase when they disagree — the
  paraphrase can lose small but decisive words.

[Task]
Choose exactly one action:

- "generate": The user wants a structurally NEW piece of shopping content that requires freshly gathered
  product data — e.g. wants to see buyable products, wants specific named products compared side-by-side,
  wants to know what criteria/factors to consider when choosing a product in this category, or wants to
  understand a general concept/spec that isn't about one specific named product.

- "none": The message needs only a conversational reply — answerable in prose from this conversation's own
  history and/or a quick grounded lookup, with no need to assemble a fresh structured list/table/criteria-set.
  e.g. small talk, a yes/no clarification.
  This also covers asking WHY something already recommended earlier in this conversation was recommended
  ("왜 이 제품을 추천한거야?", "why did you suggest these?", "이 순서인 이유가 뭐야?") — the answer is a prose
  explanation grounded in what was already said, not a request to understand a general concept. Do not route
  this to "generate" just because the intent mentions "understand"/"why" — check FIRST whether it's asking
  about something general (→ generate) vs. about a specific thing already discussed (→ none).
  This also covers meta-requests ABOUT THE CONVERSATION ITSELF — e.g. "내가 명령한 것들을 요약해줘",
  "summarize what I've asked so far", "지금까지 뭘 요청했는지 정리해줘", "recap this conversation". These ask
  for a prose recap of the chat history, not new structured content — route to "none" even if the paraphrase
  says "wants to see a summary" (that phrasing can misleadingly resemble a "generate" request when it really
  just wants a spoken answer).
  This also covers asking for a specific spec/fact VALUE belonging to ONE specifically-named product
  (by model name/number) — e.g. "이 제품의 흡입력이 얼마야?", "what's the battery life of the XYZ model?".
  This is a grounded factual lookup, not a request to understand what a spec/term means in general — route
  it to "none" (which can look the value up) rather than "generate". Do NOT confuse this with a genuine
  concept question that names no specific product ("흡입력이 뭐야?", "what does suction power mean?") — that
  case still belongs to "generate". The distinguishing signal is whether a specific product name/model is the
  subject of the value being asked about, not just whether a spec/term is mentioned.

Decision rule when ambiguous: ask "does answering this well require assembling a fresh structured
list/table/criteria-set from product data, or can it be answered in prose from what's already been said plus
maybe one lookup?" — the former is "generate", the latter is "none".

[Output]
Respond with ONLY a JSON object:
{ "action": "generate" | "none" }
`.trim();

export async function routeAction(
  intentAnalysis: IntentAnalysis,
  rawUserMessage: string = ""
): Promise<ActionRoute> {
  console.log(`\n\x1b[36m========== [2] Action Router ==========\x1b[0m`);
  console.log(`\x1b[90m[Input] IntentAnalysis:\x1b[0m ${JSON.stringify(intentAnalysis)}`);
  console.log(`\x1b[90m[Input] RawUserMessage:\x1b[0m ${rawUserMessage || "(none)"}`);

  const promptText = [
    `intent_analysis: "${intentAnalysis.user_goal}"`,
    `user_message (verbatim): "${rawUserMessage || intentAnalysis.user_goal}"`,
    "Choose the action.",
  ].join("\n");

  const { object } = await generateObject({
    model: anthropic(ROUTER_MODEL),
    schema: ActionRouteSchema,
    system: buildRouterPrompt(),
    prompt: promptText,
    temperature: 0,
    maxOutputTokens: 100,
  });

  console.log(`\x1b[32m[Output] Action:\x1b[0m ${JSON.stringify(object)}`);
  console.log(`\x1b[36m========================================\x1b[0m\n`);

  return object;
}
