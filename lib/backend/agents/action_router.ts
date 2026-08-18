/**
 * lib/backend/agents/action_router.ts
 * Action Router — "generate(새 UI 생성) vs edit(기존 UI 수정) vs none(대화만)"만 판단하는 최상위 라우터.
 *
 * template_selector.ts(어떤 템플릿을 생성할지)와 edit_agent.ts(무엇을 어떻게 고칠지)는
 * 이 라우터의 판단 결과에 따라 둘 중 하나만 호출되며, 서로의 존재를 알 필요가 없다.
 */

import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import type { IntentAnalysis } from "./intent_analyzer";

export const ROUTER_MODEL = "gpt-4o-mini" as const;

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
- intent_analysis: the user's interpreted goal (from the Intent Analyzer).
- screen_state: which UI surfaces currently exist on screen (hasOptionList / hasComparisonTable / hasCriteriaMap).
- screen_summary: what those surfaces actually CONTAIN right now (product names, table criteria/products,
  criteria map categories) — ground your decision in this, not just the booleans above. A request that
  references or depends on specific items only makes sense if you can see they're actually there.

[Task]
Choose exactly one action:

- "generate": The user wants a structurally NEW UI surface that is not simply a change to what is already shown —
  e.g. asking for a product list when none exists, asking to compare products when no table exists yet,
  asking what criteria to consider when no criteria map exists yet, or asking to understand a concept/spec
  that is unrelated to anything already on screen.

- "edit": The user wants to modify, filter, sort, narrow, expand, or add to a UI surface that is ALREADY on screen.
  Signals: "이 중에서", "빼줘", "정렬해줘", "더 보여줘", "추가해줘", "다른 것도 비교해줘" referring to an existing list/table/map.
  This also covers asking for the SUB-ITEMS/detail breakdown of a criterion that is already a category (or close
  match) in the criteria map on screen — e.g. "'브랜드 신뢰도' 기준의 세부 항목을 알려줘" when hasCriteriaMap is
  true and the map already has a related category. Even though the user only said "알려줘"/"tell me", answering
  this well means those concrete sub-items should actually be added into that category on screen, not just
  spoken in chat — treat it as "add items to an existing category", not as a pure explanation request.
  Only valid when the relevant screen_state flag is true — you cannot "edit" a surface that does not exist yet
  (in that case, prefer "generate" instead).

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
  screenSummary: string = ""
): Promise<ActionRoute> {
  console.log(`\n\x1b[36m========== [2] Action Router ==========\x1b[0m`);
  console.log(`\x1b[90m[Input] IntentAnalysis:\x1b[0m ${JSON.stringify(intentAnalysis)}`);
  console.log(`\x1b[90m[Input] ScreenState:\x1b[0m ${JSON.stringify(screenState)}`);
  console.log(`\x1b[90m[Input] ScreenSummary:\x1b[0m ${screenSummary || "(none)"}`);

  const promptText = [
    `intent_analysis: "${intentAnalysis.user_goal}"`,
    `screen_state: ${JSON.stringify(screenState)}`,
    `screen_summary:\n${screenSummary || "(nothing on screen yet)"}`,
    "Choose the action.",
  ].join("\n");

  const { object } = await generateObject({
    model: openai(ROUTER_MODEL),
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
