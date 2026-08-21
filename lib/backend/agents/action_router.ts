/**
 * lib/backend/agents/action_router.ts
 * Action Router — "generate(새 UI 생성) vs edit(기존 UI 수정) vs none(대화만)"만 판단하는 최상위 라우터.
 *
 * template_selector.ts(어떤 템플릿을 생성할지)와 edit_agent.ts(무엇을 어떻게 고칠지)는
 * 이 라우터의 판단 결과에 따라 둘 중 하나만 호출되며, 서로의 존재를 알 필요가 없다.
 */

import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type { IntentAnalysis } from "./intent_analyzer";

export const ROUTER_MODEL = "claude-haiku-4-5" as const;

export const ActionRouteSchema = z.object({
  action: z
    .enum(["generate", "edit", "none"])
    .describe(
      "'generate' = create a brand-new UI component | 'edit' = modify a UI surface already on screen | 'none' = conversational reply only, no UI change"
    ),
});

export type ActionRoute = z.infer<typeof ActionRouteSchema>;

export interface ScreenState {
  hasOptionList: boolean;
  hasComparisonTable: boolean;
  hasCriteriaMap: boolean;
}

const buildRouterPrompt = () => `
[Role]
You are the top-level action router for a shopping assistant. You do NOT pick a template and you do NOT decide how to edit anything —
your only job is to decide which of three downstream processes should run next this turn.

[Input]
- intent_analysis: the user's interpreted goal (from the Intent Analyzer) — a paraphrase, not the user's exact words.
- user_message: the user's LATEST message verbatim. The paraphrase above can lose small but decisive words
  (Korean particles like "도"/"추가로", English "also"/"too"/"as well") that signal "add this ON TOP of what's
  already shown" rather than "replace what's shown with this." When the paraphrase reads as a plain request
  ("~을 보여달라는 요청") but the verbatim message contains such an additive cue AND a relevant surface is
  already on screen (per screen_state/screen_summary), trust the verbatim cue and choose "edit", not "generate".
- screen_state: which UI surfaces currently exist on screen (hasOptionList / hasComparisonTable / hasCriteriaMap).
- screen_summary: what those surfaces actually CONTAIN right now (product names, table criteria/products,
  criteria map categories) — ground your decision in this, not just the booleans above. A request that
  references or depends on specific items only makes sense if you can see they're actually there.

[Task]
Choose exactly one action:

- "generate": The user wants a structurally NEW UI surface that is not simply a change to what is already shown —
  e.g. asking for a product list when none exists, asking to compare products when no table exists yet,
  asking what criteria to consider when no criteria map exists yet, or asking to understand a concept/spec
  that is unrelated to anything already on screen. This applies even when the products to compare are named or
  pointed at ("이 두 가지", "이것들") via the CURRENT_OPTION_LIST — hasComparisonTable being false means the
  side-by-side table itself doesn't exist yet, so this is still "generate", not "edit" of the option list.

- "edit": The user wants to modify, filter, sort, narrow, expand, or add to a UI surface that is ALREADY on screen.
  Signals: "이 중에서", "빼줘", "정렬해줘", "더 보여줘", "추가해줘", "다른 것도 비교해줘" referring to an existing list/table/map.
  IMPORTANT — the "다른 것도 비교해줘"-style comparison signal only applies when hasComparisonTable is true (adding to
  or changing an EXISTING table). A request to compare specific products — even ones named or pointed at via "이
  두 가지"/"these"/"이것들" from the CURRENT_OPTION_LIST — is NOT "edit" when hasComparisonTable is false; referencing
  the option list only to identify WHICH products, while the actual output (a side-by-side table) does not exist
  yet, is a "generate" case per the rule below. Do not let "the products are already on screen" alone pull this
  into "edit" — check what surface the request's OUTPUT needs, not just what surface it references.
  This also covers asking for the SUB-ITEMS/detail breakdown of a criterion that is already a category (or close
  match) in the criteria map on screen — e.g. "'브랜드 신뢰도' 기준의 세부 항목을 알려줘" when hasCriteriaMap is
  true and the map already has a related category. Even though the user only said "알려줘"/"tell me", answering
  this well means those concrete sub-items should actually be added into that category on screen, not just
  spoken in chat — treat it as "add items to an existing category", not as a pure explanation request.
  Only valid when the relevant screen_state flag is true — you cannot "edit" a surface that does not exist yet
  (in that case, prefer "generate" instead).
  EXCEPTION — do NOT apply the sub-items/detail-breakdown reading above when the message is actually asking to
  see or recommend PRODUCTS ("제품을 추천해줘", "추천해줄 수 있어?", "제품 찾아줘", "show me products", "recommend
  something"), even if it names a criterion/value that happens to already exist in the criteria map (e.g. the
  message quotes "가격대 (50만원 이하)" and the map already has a "가격대"/"예산" item). A criterion name or value
  appearing in a product-recommendation request is being used as a SEARCH FILTER on the product list, not as an
  instruction to edit the criteria map — the criteria map staying on screen unchanged is irrelevant to whether
  this is generate/edit. Route by hasOptionList exactly as the plain "generate" rule above says: no option list
  on screen → "generate", not "edit" of criteriaMap. Only read it as editing the criteria map when the message is
  ABOUT the criterion itself (asking to know more about it, add it, remove it) rather than asking for products.

- "none": The message needs only a conversational reply — no UI surface should be created or changed.
  e.g. small talk, a yes/no clarification, or a question whose answer is already fully visible in what's
  currently on screen (nothing new needs to be added anywhere to answer it).
  This also covers asking WHY an already-shown recommendation/list/table looks the way it does
  ("왜 이 제품을 추천한거야?", "why did you suggest these?", "이 순서인 이유가 뭐야?") — the answer is a
  prose explanation grounded in the specific items already on screen, not a request to understand a
  general concept. Do not route this to "generate" just because the intent mentions "understand"/"why" —
  check FIRST whether it's asking about something general (→ generate) vs. about the specific
  already-displayed set (→ none). And do not route a request for MORE detail/sub-items on an existing
  category to "none" just because it's phrased as a question — check first whether answering it means new
  items should appear on screen (→ edit) rather than just being explained in words (→ none).
  This also covers meta-requests ABOUT THE CONVERSATION ITSELF — e.g. "내가 명령한 것들을 요약해줘",
  "summarize what I've asked so far", "지금까지 뭘 요청했는지 정리해줘", "recap this conversation". These
  ask for a prose recap of the chat history, not a change to any surface — route to "none" even though
  screen_state shows surfaces already on screen, and even if the paraphrase says "wants to see a summary"
  (that phrasing can misleadingly resemble a "generate/edit" request when it really just wants a spoken
  answer). If nothing on the existing surfaces (optionList/comparisonTable/criteriaMap) is a plausible target
  for "the things I asked/commanded", that itself is a strong signal this is "none", not "edit".
  This also covers asking for a specific spec/fact VALUE belonging to ONE specifically-named product
  (by model name/number) — e.g. "이 제품의 흡입력이 얼마야?", "what's the battery life of the XYZ model?".
  This is a grounded factual lookup, not a request to understand what a spec/term means in general — route
  it to "none" (which can look the value up) rather than "generate", even when no matching surface is on
  screen yet. Do NOT confuse this with a genuine concept question that names no specific product ("흡입력이
  뭐야?", "what does suction power mean?") — that case still belongs to "generate" as before. The
  distinguishing signal is whether a specific product name/model is the subject of the value being asked
  about, not just whether a spec/term is mentioned.

Decision rule when ambiguous: ask "does this request make sense as a full re-generation, or does it only make sense
as a change applied ON TOP of something already visible?" — the latter is always "edit". If it doesn't need any
UI change at all — including "explain why you showed me this" — that's "none", not "generate".

[Output]
Respond with ONLY a JSON object:
{ "action": "generate" | "edit" | "none" }
`.trim();

export async function routeAction(
  intentAnalysis: IntentAnalysis,
  screenState: ScreenState,
  screenSummary: string = "",
  rawUserMessage: string = ""
): Promise<ActionRoute> {
  console.log(`\n\x1b[36m========== [2] Action Router ==========\x1b[0m`);
  console.log(`\x1b[90m[Input] IntentAnalysis:\x1b[0m ${JSON.stringify(intentAnalysis)}`);
  console.log(`\x1b[90m[Input] ScreenState:\x1b[0m ${JSON.stringify(screenState)}`);
  console.log(`\x1b[90m[Input] ScreenSummary:\x1b[0m ${screenSummary || "(none)"}`);
  console.log(`\x1b[90m[Input] RawUserMessage:\x1b[0m ${rawUserMessage || "(none)"}`);

  const promptText = [
    `intent_analysis: "${intentAnalysis.user_goal}"`,
    `user_message (verbatim): "${rawUserMessage || intentAnalysis.user_goal}"`,
    `screen_state: ${JSON.stringify(screenState)}`,
    `screen_summary:\n${screenSummary || "(nothing on screen yet)"}`,
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
