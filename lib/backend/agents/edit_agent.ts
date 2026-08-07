/**
 * lib/backend/agents/edit_agent.ts
 * Edit Agent — 이미 화면에 떠 있는 UI 서피스(ProductCardList / ComparisonTable / CriteriaMap)를
 * 자연어 요청으로 어떻게 고칠지 결정한다.
 *
 * 이 에이전트는 Action Router가 action="edit"으로 판단했을 때만 호출되며,
 * template_selector.ts가 다루는 "새 UI 생성" 개념(template 종류 등)을 전혀 알지 못한다.
 *
 * 값(구체적인 스펙 수치, 검색 결과 등)은 이 에이전트가 만들어내지 않는다 — 무엇을
 * 조회해야 하는지만 지시하고, 실제 조회/패치는 surface별 executor(mutate-*.ts)가 담당한다.
 */

import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import type { IntentAnalysis } from "./intent_analyzer";
import type { Locale } from "./generators/shared";
import { currentProductCategory, currentUserContext, currentDecisionCriteria } from "../tools/sidebar-store";

export const EDIT_AGENT_MODEL = "gpt-4o" as const;

// z.discriminatedUnion would compile to JSON Schema's `oneOf`, which OpenAI's
// Responses API structured-outputs mode rejects ("'oneOf' is not permitted").
// Plain z.union compiles to `anyOf`, which is supported, and TS can still
// narrow on target_surface since each branch has a literal type for it.
//
// Field descriptions are built per-locale (op_summary, sort_by, field_key, criteria_to_add,
// category_label are free text the model writes — they must match the response language the
// user selected, not be hardcoded to Korean).
function buildEditPlanSchema(locale: Locale) {
  const lang = locale === "en" ? "English" : "Korean";
  const opSummaryField = {
    op_summary: z.string().describe(`1-2 sentence ${lang}, user-facing confirmation of what will change.`),
  };

  return z.union([
    // ── optionList ────────────────────────────────────────────────────────────
    z.object({
      target_surface: z.literal("optionList"),
      ...opSummaryField,
      op: z.enum(["filter", "sort", "add"]),
      result_card_names: z.array(z.string()).nullable()
        .describe("filter/sort: the matching cards' `id`s (not names) copied from CURRENT_OPTION_LIST, in final order to keep/show."),
      products_to_add: z.array(z.string()).nullable()
        .describe("add: product names to search for and add as new cards."),
      sort_by: z.string().nullable()
        .describe(`sort: ${lang} field name to sort by, e.g. ${locale === "en" ? "'price', 'weight', 'noise'" : "'가격', '무게', '소음'"}.`),
      sort_order: z.enum(["asc", "desc"]).nullable(),
      field_updates: z.array(z.object({
        product_name: z.string().describe("The matching card's `id` (not name) copied from CURRENT_OPTION_LIST."),
        field_key: z.string().describe(`Short ${lang} spec keyword, e.g. ${locale === "en" ? "'weight', 'battery'" : "'무게', '배터리'"}. Never a value — system looks up the real value.`),
      })).nullable().describe("add: spec fields to look up for existing cards."),
      original_query: z.string().nullable()
        .describe(`add: original search constraints (e.g. ${locale === "en" ? "'suction power 4500pa or higher'" : "'흡입력 4500pa 이상'"}) to hard-filter newly added products.`),
    }),

    // ── comparisonTable ─────────────────────────────────────────────────────────
    // Supports criteria ROWS and product COLUMNS add/remove. Single-cell re-verification is not supported yet.
    z.object({
      target_surface: z.literal("comparisonTable"),
      ...opSummaryField,
      op: z.enum(["add_criteria", "remove_criteria", "add_product", "remove_product"])
        .describe("If the request needs something outside this scope (e.g. re-checking one specific cell), " +
          "target_surface must not be 'comparisonTable' — explain the limitation in op_summary via another surface " +
          "or a conversational reply instead."),
      criteria_to_add: z.array(z.string()).nullable()
        .describe(`add_criteria: new criterion row labels to add, in ${lang}.`),
      criteria_to_remove: z.array(z.string()).nullable()
        .describe("remove_criteria: exact row `id`s (e.g. 'crit_1') copied from CURRENT_COMPARISON_TABLE to remove — NOT the label."),
      products_to_add: z.array(z.string()).nullable()
        .describe(`add_product: product names/brands to search for and add as new columns (e.g. ${locale === "en" ? "'Xiaomi', 'Roborock S9'" : "'샤오미', '로보락 S9'"}).`),
      products_to_remove: z.array(z.string()).nullable()
        .describe("remove_product: exact column `key`s (e.g. 'prod_1') copied from CURRENT_COMPARISON_TABLE to remove — NOT the label."),
    }),

    // ── criteriaMap ─────────────────────────────────────────────────────────────
    z.object({
      target_surface: z.literal("criteriaMap"),
      ...opSummaryField,
      op: z.enum(["add_item", "remove_item"]),
      category_label: z.string()
        .describe(`add_item: reuse an existing label from current_criteriaMap if it fits, otherwise a new ` +
          `short ${lang} label. remove_item: the existing category's `+ "`id` (not the label) copied from " +
          "current_criteriaMap."),
      item_names: z.array(z.string()).nullable()
        .describe(`add_item: new item names to add, in ${lang} (see [criteriaMap ops] for how to generate these). ` +
          "remove_item: the exact item `id`s (not the names) copied from current_criteriaMap to remove — to " +
          "remove an entire category, list ALL of its current item ids here."),
    }),
  ]);
}

export type EditPlan = z.infer<ReturnType<typeof buildEditPlanSchema>>;

export interface EditAgentScreen {
  optionList?: Array<{ id: string; name: string; priceNum: number | null; priceStr: string; specs: string[] }>;
  // products/criteria carry both the stable id (key/id) the LLM must copy back for remove ops,
  // and the human-readable label used only to understand what the user is referring to.
  comparisonTable?: {
    products: Array<{ key: string; label: string }>;
    criteria: Array<{ id: string; label: string }>;
  };
  criteriaMap?: Array<{ id?: string; label: string; items: Array<{ id?: string; name: string }> }>;
}

const buildEditAgentPrompt = (locale: Locale) => `
[Role]
You are the edit agent for a shopping assistant. You run ONLY when the user wants to change something
that is already visible on screen — you never decide whether to generate a new UI component, and you
never know about "templates". Your only job is to decide WHICH surface to change and HOW.

[Language]
Write ALL free-text output (op_summary, sort_by, field_key, criteria_to_add, category_label, item_names,
and any other natural-language field in the schema) in ${locale === "en" ? "English" : "Korean"} — regardless
of what language the example phrases below happen to be written in. The example signal phrases under
[optionList ops]/[comparisonTable ops]/[criteriaMap ops] are shown in Korean for illustration only; recognize
the same underlying intent when the user writes in a different language.

[Input]
- user_message: the user's latest raw request.
- intent_analysis: the user's interpreted goal.
- product_category: the product type being shopped for (e.g. 로봇청소기, 카메라, 유모차).
- user_context (optional): the user's stated situation/needs (e.g. "반려동물 있음, 신혼부부").
- decision_criteria (optional): buying criteria the user has flagged as important, in priority order.
- current_optionList (optional): [{id, name, priceNum, priceStr, specs}...] products currently shown as
  cards, if any. id is the stable identifier — name is just human-readable text.
- current_comparisonTable (optional): { products: [{key, label}...], criteria: [{id, label}...] } currently shown, if any.
  key/id are stable identifiers — label is just the human-readable text for you to understand intent.
- current_criteriaMap (optional): [{ id, label, items: [{id, name}...] }...] currently shown, if any.
  id fields (category and item) are stable identifiers — label/name are just human-readable text.

Only surfaces that are actually present in the input may be targeted. Never target a surface that wasn't provided.

[Task]
1. Decide target_surface — ground your choice in which surface the user's language actually refers to
   (e.g. "표에서 빼줘" → comparisonTable, "목록에서 빼줘" / no table exists → optionList).
2. Decide op and that surface's own parameters only, using ONLY the schema for target_surface below.
3. For optionList/comparisonTable: NEVER invent product data (spec values, prices). Output only what
   needs to be looked up (field_key / criterion label / product name) — a downstream system resolves
   the real value afterward from a database or the web. This rule does NOT apply to criteriaMap —
   see [criteriaMap ops] below, where you must actively generate real suggestions yourself.
4. Whenever you reference something that ALREADY EXISTS on screen (to filter/sort/remove/update it —
   optionList's result_card_names/field_updates, comparisonTable's criteria_to_remove/products_to_remove,
   criteriaMap's remove_item), copy its 'id'/'key' field EXACTLY — never its 'label'/'name', and never
   paraphrase or guess an id that isn't present. Fields that describe something NEW that doesn't exist
   yet (products_to_add, criteria_to_add, add_item's item_names) are plain text, not ids.

[optionList ops]
- "filter": narrow down to a subset already shown. Signals explicitly restrict to the CURRENT set: "이 중에서",
  "가장 저렴한 거", "소음 낮은 순으로 골라줘", "반려동물 있는 집에 맞는 것만", "나한테 맞는 것만 골라줘".
  → result_card_names = the matching cards' 'id's to keep, in final order. For an OBJECTIVE criterion
  stated in a card's own price/specs (가격, 소음, 흡입력, ...), pick by reading those values directly.
  For a SUBJECTIVE/holistic criterion ("나한테 맞는 것", "반려동물 키우기 좋은 것") with no single matching
  spec field, REASON over each card's price/specs against user_context and decision_criteria yourself and
  decide which ones qualify — do not leave this empty just because no spec literally names the criterion.
  Never use "filter" just because the user wants MORE items matching a criterion (e.g. "여러 개 추천해줘",
  "많이 보여줘") — that is "add", not "filter", even without the word "더". Only use "filter" when the
  request is clearly about the EXISTING cards specifically (referencing "이 중에서", "지금 나온 것 중",
  or an action like "골라줘"/"빼줘"/"정렬" on what's already shown). A card's spec text being vague
  (e.g. "강력한 흡입력" instead of a number) is NOT grounds to silently drop that card via filter — if you
  can't verify a numeric criterion from the shown text, leave the card in rather than excluding it.
- "sort": reorder the existing list. Signals: "가격순", "소음 낮은 순으로 정렬", "나한테 제일 잘 맞는 순서로 정렬해줘",
  "추천 순으로 정렬".
  → For an OBJECTIVE field that exists in the cards' own price/specs (가격, 무게, 소음, 흡입력, ...):
    sort_by = that Korean field name, sort_order = 'asc'|'desc' (default 'asc'). Leave result_card_names null.
  → For a SUBJECTIVE/holistic request ("잘 맞는 순서", "추천 순", "종합적으로 좋은 순") with no single matching
    spec field: do NOT invent a sort_by field name (it won't match anything and the sort will silently do
    nothing). Instead REASON over every card's price/specs against user_context and decision_criteria
    yourself, and set result_card_names = ALL current card ids, best-fit-first. Leave sort_by null.
- "add": expand with new products not currently shown, OR look up a spec field for existing cards.
  Signals: "더 추천해줘", "다른 브랜드", "각 제품 배터리 수명도 보여줘", "여러 개 추천해줘", "몇 개 더", "많이 보여줘",
  or any plain recommendation request ("추천해줘"/"보여줘") that doesn't explicitly restrict to the cards
  already on screen.
  → products_to_add and/or field_updates. Always pass original_query if the user had prior search constraints.

[comparisonTable ops] (single-cell re-verification is out of scope — see schema note)
- "add_criteria": add one or more new criterion rows to compare. Signals: "이 기준도 비교해줘", "직배수 기능도 넣어서 봐줘".
  → criteria_to_add.
- "remove_criteria": remove one or more existing criterion rows. Signals: "이 기준은 빼줘".
  → criteria_to_remove = the matching row's 'id' (e.g. "crit_1") from current_comparisonTable.criteria — NOT its label.
- "add_product": add one or more new products as columns to compare. Signals: "샤오미 제품도 넣어서 비교해줘", "로보락 S9도 같이 봐줘".
  → products_to_add = product names/brands to search for (a downstream system resolves the actual product via search — do not invent specs).
- "remove_product": remove one or more existing product columns. Signals: "이 제품은 표에서 빼줘".
  → products_to_remove = the matching column's 'key' (e.g. "prod_1") from current_comparisonTable.products — NOT its label.

[criteriaMap ops]
- "add_item": three request shapes all map here:
  (a) Adding a NAMED item the user already specified. Signals: "이 항목 아래에 ~도 추가해줘".
      → item_names = that item, verbatim.
  (b) Asking YOU to suggest what else is worth considering — this is the common "add" case.
      Signals: "성능 측면에서 또 뭘 고려할 수 있을까?", "이런 기준도 알려줘", "더 알려줘".
      → You must actively GENERATE 2-4 concrete, real criterion names from your own product knowledge
      of product_category — the same way you would when writing a buying guide. Do NOT leave this as an
      empty string and do NOT return a placeholder; if you cannot think of a genuinely new, non-duplicate
      item, set item_names to null instead (and briefly say why in op_summary).
      Each name must be a short concrete noun phrase for a SPECIFIC dimension (e.g. for 로봇청소기 성능:
      "먼지통 용량", "주행 시간", "매핑 정확도" — NOT vague restatements like "기타 성능" or "추가 항목").
      Never repeat an item name that already exists under category_label in current_criteriaMap.
- "remove_item": the user wants existing items, or an entire category, gone.
  Signals: "~는 빼줘", "~ 정보 삭제해줘", "~ 카테고리 지워줘".
  → category_label = the matching category's 'id' from current_criteriaMap — NOT its label.
  → item_names = the matching items' 'id's from current_criteriaMap under that category — NOT their
    names. If the user means the whole category, list every current item id under it.

[Output]
Respond with ONLY a JSON object matching the schema for the chosen target_surface.
`.trim();

export async function planEdit(
  userMessage: string,
  intentAnalysis: IntentAnalysis,
  screen: EditAgentScreen,
  locale: Locale = "ko"
): Promise<EditPlan> {
  console.log(`\n\x1b[34m========== [3] Edit Agent ==========\x1b[0m`);
  console.log(`\x1b[90m[Input] user_message:\x1b[0m ${userMessage.slice(0, 200)}`);
  console.log(`\x1b[90m[Input] screen:\x1b[0m ${JSON.stringify(screen)}`);

  const userContextStr = Array.isArray(currentUserContext)
    ? (currentUserContext as string[]).join(' ')
    : String(currentUserContext || '');

  const promptParts: string[] = [
    `user_message: "${userMessage}"`,
    `intent_analysis: "${intentAnalysis.user_goal}"`,
    `product_category: "${currentProductCategory || '(미상)'}"`,
  ];
  if (userContextStr.trim()) promptParts.push(`user_context: "${userContextStr.trim()}"`);
  if (currentDecisionCriteria.length > 0) promptParts.push(`decision_criteria: ${currentDecisionCriteria.join(', ')}`);

  if (screen.optionList && screen.optionList.length > 0) {
    promptParts.push(
      `current_optionList (id | name | 가격 | 스펙):\n${screen.optionList
        .map(p => `- ${p.id} | ${p.name}${p.priceNum != null ? ` | ${p.priceNum.toLocaleString()}원` : ''}${p.specs.length > 0 ? ` | ${p.specs.join(', ')}` : ''}`)
        .join('\n')}`
    );
  }
  if (screen.comparisonTable && (screen.comparisonTable.products.length > 0 || screen.comparisonTable.criteria.length > 0)) {
    promptParts.push(`current_comparisonTable: ${JSON.stringify(screen.comparisonTable)}`);
  }
  if (screen.criteriaMap && screen.criteriaMap.length > 0) {
    promptParts.push(`current_criteriaMap: ${JSON.stringify(screen.criteriaMap)}`);
  }

  promptParts.push("Decide the edit plan.");

  const sanitize = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  const cleanPrompt = sanitize(promptParts.join('\n\n'));

  // OpenAI's Responses API structured-outputs mode also requires the ROOT schema to be
  // `type: "object"` — a union can't sit at the top level even as `anyOf` ("got 'type: None'").
  // anyOf IS allowed nested inside an object's property, so wrap the union in a single-field
  // object just for the API call and unwrap below; the public EditPlan type/shape is unaffected.
  const editPlanRequestSchema = z.object({ plan: buildEditPlanSchema(locale) });

  const { object } = await generateObject({
    model: openai(EDIT_AGENT_MODEL),
    schema: editPlanRequestSchema,
    system: buildEditAgentPrompt(locale),
    prompt: cleanPrompt,
    temperature: 0,
    maxOutputTokens: 600,
  });

  console.log(`\x1b[32m[Output] Edit Plan:\x1b[0m\n${JSON.stringify(object.plan, null, 2)}`);
  console.log(`\x1b[34m=====================================\x1b[0m\n`);

  return object.plan;
}
