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

export const EDIT_AGENT_MODEL = "gpt-4o-mini" as const;

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
      op: z.enum(["filter", "sort", "add", "remove_field"]),
      result_card_names: z.array(z.string()).nullable()
        .describe("filter/sort: the matching cards' `id`s (not names) copied from CURRENT_OPTION_LIST, in final order to keep/show."),
      products_to_add: z.array(z.string()).nullable()
        .describe("add: product names to search for and add as new cards."),
      sort_by: z.string().nullable()
        .describe(`sort: ${lang} field name to sort by, e.g. ${locale === "en" ? "'price', 'weight', 'noise'" : "'가격', '무게', '소음'"}.`),
      sort_order: z.enum(["asc", "desc"]).nullable(),
      field_updates: z.array(z.object({
        product_name: z.string().describe("The matching card's `id` (not name) copied from CURRENT_OPTION_LIST."),
        field_key: z.string().describe(`Short ${lang} spec keyword, e.g. ${locale === "en" ? "'weight', 'battery'" : "'무게', '배터리'"}. For "add" this is looked up; for "remove_field" it identifies which existing spec line to delete — never a value either way.`),
      })).nullable().describe("add: spec fields to look up for existing cards. remove_field: spec fields to delete from existing cards (no lookup — just removes the matching spec line)."),
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
        .describe(`add_item: a human-readable LABEL — reuse an existing category's 'label' text from ` +
          `current_criteriaMap if it fits, otherwise write a new short ${lang} label. NEVER put an 'id' ` +
          `value (e.g. "cat-1234567890-0") here for add_item — ids are for remove_item only, and putting ` +
          `one here for add_item creates a garbage-named category on screen. ` +
          "remove_item: the OPPOSITE — the existing category's `id` field (not its label text), copied " +
          "exactly from current_criteriaMap."),
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
  // 지금 Option List를 만들 때 썼던 원래 검색 제약(예: "흡입력 4,500pa 이상") — 이 값을
  // 히스토리 없이도 그대로 복사해서 "add"의 original_query에 넣을 수 있게 한다. 안 그러면
  // 한 턴만 지나도 이 제약을 기억할 방법이 없다(Edit Agent는 대화 히스토리를 안 받음).
  optionListSearchQuery?: string;
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
[optionList ops]/[comparisonTable ops]/[criteriaMap ops] illustrate intent only; recognize the same
underlying intent when the user writes in Korean or any other language.

[Input]
- user_message: the user's latest raw request.
- intent_analysis: the user's interpreted goal.
- product_category: the product type being shopped for (e.g. robot vacuum, camera, stroller).
- user_context (optional): the user's stated situation/needs (e.g. "has pets, newlywed couple").
- decision_criteria (optional): buying criteria the user has flagged as important, in priority order.
- current_optionList (optional): [{id, name, priceNum, priceStr, specs}...] products currently shown as
  cards, if any. id is the stable identifier — name is just human-readable text.
- option_list_search_query (optional): the original search constraints used to build the CURRENT option
  list (e.g. "흡입력 4,500pa 이상"). You have no memory of earlier turns, so this is your only way to know
  what constraint the currently-shown cards were already filtered by.
- current_comparisonTable (optional): { products: [{key, label}...], criteria: [{id, label}...] } currently shown, if any.
  key/id are stable identifiers — label is just the human-readable text for you to understand intent.
- current_criteriaMap (optional): [{ id, label, items: [{id, name}...] }...] currently shown, if any.
  id fields (category and item) are stable identifiers — label/name are just human-readable text.

Only surfaces that are actually present in the input may be targeted. Never target a surface that wasn't provided.

[Task]
1. Decide target_surface — ground your choice in which surface the user's language actually refers to
   (e.g. "remove it from the table" → comparisonTable, "remove it from the list" / no table exists → optionList).
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
- "filter": narrow down to a subset already shown. Signals explicitly restrict to the CURRENT set: "among these",
  "the cheapest one", "sort by lowest noise", "only ones suitable for a home with pets", "just pick the ones that fit me".
  → result_card_names = the matching cards' 'id's to keep, in final order. For an OBJECTIVE criterion
  stated in a card's own price/specs (price, noise, suction power, ...), pick by reading those values directly.
  For a SUBJECTIVE/holistic criterion ("the one that fits me", "good for a pet-owning household") with no single matching
  spec field, REASON over each card's price/specs against user_context and decision_criteria yourself and
  decide which ones qualify — do not leave this empty just because no spec literally names the criterion.
  Never use "filter" just because the user wants MORE items matching a criterion (e.g. "recommend several more",
  "show me a lot") — that is "add", not "filter", even without the word "more". Only use "filter" when the
  request is clearly about the EXISTING cards specifically (referencing "among these", "among the ones currently shown",
  or an action like "pick"/"remove"/"sort" on what's already shown). A card's spec text being vague
  (e.g. "powerful suction" instead of a number) is NOT grounds to silently drop that card via filter — if you
  can't verify a numeric criterion from the shown text, leave the card in rather than excluding it.
- "sort": reorder the existing list. Signals: "by price", "sort by lowest noise", "sort by what fits me best",
  "sort by recommendation".
  → For an OBJECTIVE field that exists in the cards' own price/specs (price, weight, noise, suction power, ...):
    sort_by = that ${locale === "en" ? "English" : "Korean"} field name, sort_order = 'asc'|'desc' (default 'asc'). Leave result_card_names null.
  → For a SUBJECTIVE/holistic request ("best fit order", "recommended order", "overall best order") with no single matching
    spec field: do NOT invent a sort_by field name (it won't match anything and the sort will silently do
    nothing). Instead REASON over every card's price/specs against user_context and decision_criteria
    yourself, and set result_card_names = ALL current card ids, best-fit-first. Leave sort_by null.
- "add": expand with new products not currently shown, OR look up a spec field for existing cards.
  Signals: "recommend more", "a different brand", "show battery life for each product too", "recommend several more",
  "a few more", "show me a lot", or any plain recommendation request ("recommend"/"show me") that doesn't explicitly
  restrict to the cards already on screen.
  → products_to_add and/or field_updates. If option_list_search_query is given, copy it into original_query
  VERBATIM (don't paraphrase or drop it) so newly added products still respect it — the current cards were
  already filtered by it and the user has no reason to expect that constraint to silently disappear just
  because this request doesn't repeat it. Only omit it if the current request explicitly changes/removes
  that constraint (e.g. "이제 가격 상관없이 보여줘").
- "remove_field": delete an existing spec field/line from the cards. Signals: "remove the release-year info",
  "get rid of the battery life line", "이 정보 지워줘", "삭제해줘" targeting a specific spec that is already
  shown on the cards (not the cards themselves — that's a different request, out of scope for this op set).
  → field_updates = one entry per card that currently shows that field, with product_name = that card's id and
  field_key = the same short keyword used to identify it. No lookup happens for this op — do not confuse with "add".

[comparisonTable ops] (single-cell re-verification is out of scope — see schema note)
- "add_criteria": add one or more new criterion rows to compare. Signals: "compare this criterion too", "also check the direct-drain feature".
  → criteria_to_add.
- "remove_criteria": remove one or more existing criterion rows. Signals: "remove this criterion".
  → criteria_to_remove = the matching row's 'id' (e.g. "crit_1") from current_comparisonTable.criteria — NOT its label.
- "add_product": add one or more new products as columns to compare. Signals: "add Xiaomi products to the comparison too", "also look at the Roborock S9".
  → products_to_add = product names/brands to search for (a downstream system resolves the actual product via search — do not invent specs).
- "remove_product": remove one or more existing product columns. Signals: "remove this product from the table".
  → products_to_remove = the matching column's 'key' (e.g. "prod_1") from current_comparisonTable.products — NOT its label.

[criteriaMap ops]
- "add_item": three request shapes all map here:
  (a) Adding a NAMED item the user already specified. Signals: "add ~ under this category too".
      → item_names = that item, verbatim.
  (b) Asking YOU to suggest what else is worth considering — this is the common "add" case.
      Signals: "what else should I consider in terms of performance?", "tell me criteria like this too", "tell me more".
      → You must actively GENERATE 2-4 concrete, real criterion names from your own product knowledge
      of product_category — the same way you would when writing a buying guide. Do NOT leave this as an
      empty string and do NOT return a placeholder; if you cannot think of a genuinely new, non-duplicate
      item, set item_names to null instead (and briefly say why in op_summary).
      Each name must be a short concrete noun phrase for a SPECIFIC dimension (e.g. for robot vacuum performance:
      "dustbin capacity", "runtime", "mapping accuracy" — NOT vague restatements like "other performance" or "additional item").
      Never repeat an item name that already exists under category_label in current_criteriaMap.
  → category_label here = the category's 'label' TEXT (e.g. "Camera Performance"), reused verbatim if merging
    into an existing category, or a new short label if creating one. Do NOT write an 'id' field value
    (a string like "cat-1234567890-0") here — that is only for remove_item below, and doing it here creates
    a category literally named after that id string on screen.
- "remove_item": the user wants existing items, or an entire category, gone.
  Signals: "remove ~", "delete ~ info", "delete the ~ category".
  → category_label = the matching category's 'id' from current_criteriaMap — NOT its label. (This is the
    OPPOSITE of add_item above: add_item takes a label, remove_item takes an id — do not mix them up.)
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
      `current_optionList (id | name | price | specs):\n${screen.optionList
        .map(p => `- ${p.id} | ${p.name}${p.priceNum != null ? ` | ${p.priceNum.toLocaleString()}원` : ''}${p.specs.length > 0 ? ` | ${p.specs.join(', ')}` : ''}`)
        .join('\n')}`
    );
    if (screen.optionListSearchQuery?.trim()) {
      promptParts.push(`option_list_search_query: "${screen.optionListSearchQuery.trim()}"`);
    }
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

  const plan = object.plan;

  // 안전망: add_item인데 category_label이 (프롬프트 지시를 무시하고) remove_item용
  // 내부 id 패턴("cat-<숫자>...")으로 온 경우 — 그대로 쓰면 mutateCriteriaMap이 그
  // id 문자열을 라벨로 착각해 화면에 "cat-1712345678-0" 같은 카테고리를 새로 만들어
  // 버린다. current_criteriaMap에서 같은 id를 가진 카테고리를 찾아 실제 라벨로
  // 되돌려준다 — 못 찾으면 강제로 지어내지 않고 경고만 남긴다(잘못된 병합보다 낫다).
  if (plan.target_surface === "criteriaMap" && plan.op === "add_item" && /^cat-\d/.test(plan.category_label)) {
    const matched = screen.criteriaMap?.find((c) => c.id === plan.category_label);
    if (matched) {
      console.warn(
        `\x1b[33m[EditAgent] add_item인데 category_label이 id("${plan.category_label}")로 옴 — ` +
        `실제 라벨("${matched.label}")로 교정\x1b[0m`
      );
      plan.category_label = matched.label;
    } else {
      console.warn(
        `\x1b[33m[EditAgent] add_item인데 category_label이 id처럼 생긴 값("${plan.category_label}")으로 ` +
        `왔고 current_criteriaMap에서도 일치하는 카테고리를 못 찾음 — 그대로 진행하면 잘못된 이름의 ` +
        `카테고리가 생길 수 있음\x1b[0m`
      );
    }
  }

  console.log(`\x1b[32m[Output] Edit Plan:\x1b[0m\n${JSON.stringify(plan, null, 2)}`);
  console.log(`\x1b[34m=====================================\x1b[0m\n`);

  return plan;
}
