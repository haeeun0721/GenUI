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
import { currentProductCategory } from "../tools/sidebar-store";

export const EDIT_AGENT_MODEL = "gpt-4o" as const;

const opSummaryField = {
  op_summary: z.string().describe("1-2 sentence Korean, user-facing confirmation of what will change."),
};

export const EditPlanSchema = z.discriminatedUnion("target_surface", [
  // ── optionList ────────────────────────────────────────────────────────────
  z.object({
    target_surface: z.literal("optionList"),
    ...opSummaryField,
    op: z.enum(["filter", "sort", "add"]),
    result_card_names: z.array(z.string()).nullable()
      .describe("filter/sort: exact names copied from CURRENT_OPTION_LIST, in final order to keep/show."),
    products_to_add: z.array(z.string()).nullable()
      .describe("add: product names to search for and add as new cards."),
    sort_by: z.string().nullable()
      .describe("sort: Korean field name to sort by, e.g. '가격', '무게', '소음'."),
    sort_order: z.enum(["asc", "desc"]).nullable(),
    field_updates: z.array(z.object({
      product_name: z.string().describe("Must exactly match a name in CURRENT_OPTION_LIST."),
      field_key: z.string().describe("Short Korean spec keyword, e.g. '무게', '배터리'. Never a value — system looks up the real value."),
    })).nullable().describe("add: spec fields to look up for existing cards."),
    original_query: z.string().nullable()
      .describe("add: original search constraints (e.g. '흡입력 4500pa 이상') to hard-filter newly added products."),
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
      .describe("add_criteria: new criterion row labels to add, in Korean."),
    criteria_to_remove: z.array(z.string()).nullable()
      .describe("remove_criteria: exact criterion labels copied from CURRENT_COMPARISON_TABLE to remove."),
    products_to_add: z.array(z.string()).nullable()
      .describe("add_product: product names/brands to search for and add as new columns (e.g. '샤오미', '로보락 S9')."),
    products_to_remove: z.array(z.string()).nullable()
      .describe("remove_product: exact product column labels copied from CURRENT_COMPARISON_TABLE to remove."),
  }),

  // ── criteriaMap ─────────────────────────────────────────────────────────────
  z.object({
    target_surface: z.literal("criteriaMap"),
    ...opSummaryField,
    op: z.enum(["add_item", "remove_item"]),
    category_label: z.string()
      .describe("The category label to act on. For add_item, reuse an existing label from current_criteriaMap " +
        "if it fits, otherwise a new short Korean label. For remove_item, MUST be an existing label copied " +
        "exactly from current_criteriaMap."),
    item_names: z.array(z.string()).nullable()
      .describe("add_item: new item names to add (see [criteriaMap ops] for how to generate these). " +
        "remove_item: EXACT existing item names copied from current_criteriaMap to remove — to remove an " +
        "entire category, list ALL of its current item names here."),
  }),
]);

export type EditPlan = z.infer<typeof EditPlanSchema>;

export interface EditAgentScreen {
  optionList?: Array<{ name: string; priceNum: number | null; priceStr: string; specs: string[] }>;
  comparisonTable?: { products: string[]; criteria: string[] };
  criteriaMap?: Array<{ label: string; items: Array<{ name: string }> }>;
}

const buildEditAgentPrompt = () => `
[Role]
You are the edit agent for a shopping assistant. You run ONLY when the user wants to change something
that is already visible on screen — you never decide whether to generate a new UI component, and you
never know about "templates". Your only job is to decide WHICH surface to change and HOW.

[Input]
- user_message: the user's latest raw request.
- intent_analysis: the user's interpreted goal.
- product_category: the product type being shopped for (e.g. 로봇청소기, 카메라, 유모차).
- current_optionList (optional): products currently shown as cards, if any.
- current_comparisonTable (optional): { products: [...], criteria: [...] } currently shown, if any.
- current_criteriaMap (optional): categories/items currently shown, if any.

Only surfaces that are actually present in the input may be targeted. Never target a surface that wasn't provided.

[Task]
1. Decide target_surface — ground your choice in which surface the user's language actually refers to
   (e.g. "표에서 빼줘" → comparisonTable, "목록에서 빼줘" / no table exists → optionList).
2. Decide op and that surface's own parameters only, using ONLY the schema for target_surface below.
3. For optionList/comparisonTable: NEVER invent product data (spec values, prices). Output only what
   needs to be looked up (field_key / criterion label / product name) — a downstream system resolves
   the real value afterward from a database or the web. This rule does NOT apply to criteriaMap —
   see [criteriaMap ops] below, where you must actively generate real suggestions yourself.
4. For filter/sort/remove operations, copy names/labels EXACTLY as they appear in the current_* input.
   Do not paraphrase or guess a name that isn't present.

[optionList ops]
- "filter": narrow down to a subset already shown. Signals: "이 중에서", "가장 저렴한 거", "소음 낮은 순으로 골라줘".
  → result_card_names = exact names to keep, in final order.
- "sort": reorder the existing list. Signals: "가격순", "소음 낮은 순으로 정렬".
  → sort_by = Korean field name, sort_order = 'asc'|'desc' (default 'asc').
- "add": expand with new products not currently shown, OR look up a spec field for existing cards.
  Signals: "더 추천해줘", "다른 브랜드", "각 제품 배터리 수명도 보여줘".
  → products_to_add and/or field_updates. Always pass original_query if the user had prior search constraints.

[comparisonTable ops] (single-cell re-verification is out of scope — see schema note)
- "add_criteria": add one or more new criterion rows to compare. Signals: "이 기준도 비교해줘", "직배수 기능도 넣어서 봐줘".
  → criteria_to_add.
- "remove_criteria": remove one or more existing criterion rows. Signals: "이 기준은 빼줘".
  → criteria_to_remove.
- "add_product": add one or more new products as columns to compare. Signals: "샤오미 제품도 넣어서 비교해줘", "로보락 S9도 같이 봐줘".
  → products_to_add = product names/brands to search for (a downstream system resolves the actual product via search — do not invent specs).
- "remove_product": remove one or more existing product columns. Signals: "이 제품은 표에서 빼줘".
  → products_to_remove = exact product column labels copied from CURRENT_COMPARISON_TABLE.

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
  → category_label = the exact existing label from current_criteriaMap.
  → item_names = the EXACT existing item names (copied verbatim from current_criteriaMap
    under that label) to remove. If the user means the whole category, list every current item name
    under it — never invent or paraphrase a name that isn't already there.

[Output]
Respond with ONLY a JSON object matching the schema for the chosen target_surface.
`.trim();

export async function planEdit(
  userMessage: string,
  intentAnalysis: IntentAnalysis,
  screen: EditAgentScreen
): Promise<EditPlan> {
  console.log(`\n\x1b[34m========== [3] Edit Agent ==========\x1b[0m`);
  console.log(`\x1b[90m[Input] user_message:\x1b[0m ${userMessage.slice(0, 200)}`);
  console.log(`\x1b[90m[Input] screen:\x1b[0m ${JSON.stringify(screen)}`);

  const promptParts: string[] = [
    `user_message: "${userMessage}"`,
    `intent_analysis: "${intentAnalysis.user_goal}"`,
    `product_category: "${currentProductCategory || '(미상)'}"`,
  ];

  if (screen.optionList && screen.optionList.length > 0) {
    promptParts.push(
      `current_optionList (name | 가격 | 스펙):\n${screen.optionList
        .map(p => `- ${p.name}${p.priceNum != null ? ` | ${p.priceNum.toLocaleString()}원` : ''}${p.specs.length > 0 ? ` | ${p.specs.join(', ')}` : ''}`)
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

  const { object } = await generateObject({
    model: openai(EDIT_AGENT_MODEL),
    schema: EditPlanSchema,
    system: buildEditAgentPrompt(),
    prompt: cleanPrompt,
    temperature: 0,
    maxOutputTokens: 600,
  });

  console.log(`\x1b[32m[Output] Edit Plan:\x1b[0m\n${JSON.stringify(object, null, 2)}`);
  console.log(`\x1b[34m=====================================\x1b[0m\n`);

  return object;
}
