import { generateText } from "ai";
import { google } from "@ai-sdk/google";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const COMPARISON_MODEL = "gemini-2.5-flash" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriggerType = "initial" | "row_added" | "column_added";

export interface ComparisonResult {
  /** spec_key → winning product name (must match validProductNames exactly) */
  winners: Record<string, string>;
  /** spec_key → one-sentence Korean rationale for the winner decision */
  rationale: Record<string, string>;
  /** spec_keys that passed Step 1 (important to user) — highlighted in green even without a winner */
  relevantColumns: string[];
}

// ---------------------------------------------------------------------------
// Shared output format rules (injected into every system prompt)
// ---------------------------------------------------------------------------

const OUTPUT_FORMAT = `
## Output Format
Return exactly one valid JSON object. No markdown. No extra text.

{
  "relevantColumns": ["<spec_key>"],
  "winners":  { "<spec_key>": "<exact_product_name>" },
  "rationale": { "<spec_key>": "<one sentence in Korean explaining why this product wins for this user>" },
  "reason":   "<Korean: why no winner was assigned — only when winners is empty>"
}

Constraints:
- "relevantColumns": list every spec_key that passed Step 1 (important to this user). Include keys even if Step 2 failed (no winner). Empty array [] if none pass.
- Product names in "winners" must be copied exactly from [VALID PRODUCT NAMES].
- Every key in "winners" must have a corresponding key in "rationale".
- "reason" is required only when "winners" is empty; omit it otherwise.
`.trim();

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

/**
 * "initial" — Full evaluation on table creation.
 */
const SYSTEM_PROMPT_INITIAL = `
## Role
You are the Comparison Agent, a specialized evaluator in a product research assistant system.
Your job is to award a trophy (winner) to the best product for each spec column — but ONLY when the award is genuinely meaningful to this specific user.

## Task
A new comparison table has just been created.
For each spec column, apply the three-step evaluation below.

${OUTPUT_FORMAT}

## Three-Step Evaluation (apply in order for every spec column)

Step 1 — User Relevance
Ask: "Is this criterion genuinely important to this specific user given their stated situation?"
- If NO → skip this column entirely. No winner, no rationale.
- Generic specs that matter equally to all buyers do NOT pass this step.

Step 2 — Meaningful Difference
Ask: "Do the product values create a real, practical difference for this user's specific context?"
- If all values are identical, missing, or "-" → skip. No winner.
- Marginal numerical differences that don't affect real-world use → skip.
- Only proceed if the difference is large enough to actually influence this user's decision.

Step 3 — Winner Selection (only if Steps 1 and 2 both pass)
- Select the product that best serves this user's specific need on this spec.
- Write a one-sentence Korean rationale explaining WHY this product wins FOR THIS USER specifically.
`.trim();

/**
 * "row_added" — Incremental update when a new product is added.
 */
const SYSTEM_PROMPT_ROW_ADDED = `
## Role
You are the Comparison Agent, a specialized evaluator in a product research assistant system.

## Task
A new product has been added to the comparison table (see [NEW PRODUCT]).
Determine whether this new product should replace the current winner for any existing spec column.

${OUTPUT_FORMAT}

## Three-Step Evaluation (apply for each existing spec column)

Step 1 — User Relevance: Is this criterion genuinely important to this user?
- If NO → do not update this column.

Step 2 — Meaningful Difference: Does the new product create a real, practical difference for this user compared to the current winner?
- Marginal numerical superiority is NOT enough.
- The difference must matter in the user's actual use scenario.
- If the gap is negligible → keep the existing winner.

Step 3 — Winner Update (only if Steps 1 and 2 both pass)
- Replace the winner only when the new product is clearly more suitable.
- A cell value of "-" or missing is not evidence of superiority.
- If no column needs updating, return { "winners": {}, "rationale": {} }.
`.trim();

/**
 * "column_added" — Evaluation when a new spec column is added.
 */
const SYSTEM_PROMPT_COLUMN_ADDED = `
## Role
You are the Comparison Agent, a specialized evaluator in a product research assistant system.

## Task
A new spec column has been added (see [NEW COLUMN]).
Apply the three-step evaluation below.

${OUTPUT_FORMAT}

## Three-Step Evaluation

Step 1 — User Relevance
Ask: "Is this criterion genuinely important to this specific user given their stated situation?"
- If NO or UNCERTAIN → return { "winners": {}, "rationale": {} } immediately.
- Generic specs that matter equally to all buyers do NOT pass this step.

Step 2 — Meaningful Difference
Ask: "Do the product values create a real, practical difference for this user's specific context?"
- If all values are identical, missing, or "-" → return { "winners": {}, "rationale": {} }.
- Marginal differences that don't affect real-world use → return { "winners": {}, "rationale": {} }.

Step 3 — Winner Selection (only if Steps 1 and 2 both pass)
- Select the product that best serves this user's specific need on this spec.
- Only return the new column in "winners". Do not re-evaluate other columns.
`.trim();

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(triggerType: TriggerType): string {
  switch (triggerType) {
    case "initial": return SYSTEM_PROMPT_INITIAL;
    case "row_added": return SYSTEM_PROMPT_ROW_ADDED;
    case "column_added": return SYSTEM_PROMPT_COLUMN_ADDED;
  }
}

// ---------------------------------------------------------------------------
// Comparison Agent
//
// Three trigger modes keep each LLM call targeted and minimal:
//   "initial"      — full column evaluation on table creation
//   "row_added"    — checks only whether the new product beats existing winners
//   "column_added" — relevance check → winner selection for the new column only
// ---------------------------------------------------------------------------

export async function evaluateWinners(params: {
  columns: { key: string; label: string }[];
  tableData: Record<string, string>[];
  userContext?: string;
  validProductNames?: string[];
  previousWinners?: Record<string, string>;
  previousRationale?: Record<string, string>;
  triggerType?: TriggerType;
  newItem?: string; // row_added: new product name | column_added: new column key
}): Promise<ComparisonResult> {
  const {
    columns,
    tableData,
    userContext,
    validProductNames,
    previousWinners = {},
    previousRationale = {},
    triggerType = "initial",
    newItem,
  } = params;

  if (!columns?.length || !tableData?.length) {
    return { winners: {}, rationale: {} };
  }

  // Build table text
  const firstKey = Object.keys(tableData[0])[0];
  const tableText = tableData
    .map(
      (row) =>
        `[${row[firstKey]}] ${columns
          .map((col) => `${col.label}: ${row[col.key] ?? "-"}`)
          .join(" | ")}`
    )
    .join("\n");

  // Build user prompt sections
  const sections: string[] = [];

  if (userContext) {
    sections.push(`[USER PURCHASE CONTEXT]\n${userContext}`);
  }

  if (validProductNames?.length) {
    sections.push(
      `[VALID PRODUCT NAMES — copy exactly]\n${validProductNames.map((n) => `- "${n}"`).join("\n")}`
    );
  }

  if (Object.keys(previousWinners).length > 0) {
    const lines = Object.entries(previousWinners)
      .map(([col, prod]) => `- "${col}": "${prod}" — ${previousRationale[col] ?? "근거 없음"}`)
      .join("\n");
    sections.push(`[PREVIOUS WINNER JUDGMENTS]\n${lines}`);
  }

  if (triggerType === "row_added" && newItem) {
    sections.push(`[NEW PRODUCT]\n"${newItem}"`);
  } else if (triggerType === "column_added" && newItem) {
    const label = columns.find((c) => c.key === newItem)?.label ?? newItem;
    sections.push(`[NEW COLUMN]\nkey: "${newItem}", label: "${label}"`);
  }

  sections.push(`[CURRENT TABLE DATA]\n${tableText}`);
  sections.push(`[SPEC COLUMN KEYS]\n${JSON.stringify(columns)}`);
  sections.push("Return JSON only.");

  const prompt = sections.join("\n\n");

  // ── Input log ──────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  console.log(`[COMPARISON_AGENT] ▶ trigger=${triggerType}`);
  if (newItem) console.log(`  newItem   : ${newItem}`);
  console.log(`  columns   : [${columns.map((c) => c.key).join(", ")}]`);
  console.log(`  products  : [${tableData.map((r) => r[firstKey]).join(", ")}]`);
  if (userContext)
    console.log(`  userCtx   : ${userContext.slice(0, 80)}${userContext.length > 80 ? "…" : ""}`);
  if (Object.keys(previousWinners).length > 0) {
    console.log(`  prevWinners:`);
    Object.entries(previousWinners).forEach(([col, prod]) =>
      console.log(`    "${col}" → "${prod}"`)
    );
  }
  console.log(`  tableData :`);
  tableData.forEach((row) => {
    const name = row[firstKey];
    const vals = columns.map((c) => `${c.key}=${row[c.key] ?? "-"}`).join(" | ");
    console.log(`    [${name}] ${vals}`);
  });
  // ────────────────────────────────────────────────────────────────────────────

  try {
    const { text } = await generateText({
      model: google(COMPARISON_MODEL),
      system: buildSystemPrompt(triggerType),
      prompt,
      temperature: 0,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const result: ComparisonResult = {
        winners: parsed.winners ?? {},
        rationale: parsed.rationale ?? {},
        relevantColumns: Array.isArray(parsed.relevantColumns) ? parsed.relevantColumns : [],
      };
      const noWinnerReason: string = parsed.reason ?? "";

      // ── Result log ───────────────────────────────────────────────────────
      const winnerCount = Object.keys(result.winners).length;
      console.log(`[COMPARISON_AGENT] ◀ Result: ${winnerCount} winner${winnerCount !== 1 ? "s" : ""}`);
      if (winnerCount === 0) {
        console.log(`  판단 근거: ${noWinnerReason || "(이유 없음)"}`);
      } else {
        Object.entries(result.winners).forEach(([col, prod]) => {
          console.log(`  "${col}" → "${prod}"`);
          const note = result.rationale[col];
          if (note) console.log(`    근거: ${note}`);
        });
      }
      console.log(`${"─".repeat(60)}\n`);
      // ────────────────────────────────────────────────────────────────────

      return result;
    }
  } catch (err) {
    console.error("[COMPARISON_AGENT] Error:", err);
  }

  return { winners: {}, rationale: {}, relevantColumns: [] };
}
