import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { currentProductCategory } from "../tools/sidebar-store";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const UI_AGENT_MODEL = "claude-sonnet-4-6" as const;

// ---------------------------------------------------------------------------
// Prompt Templates
// ---------------------------------------------------------------------------

const buildCommonSystemInstructions = (productCategory: string) =>
  `You are a decision-support expert UI Agent — a JSON component generator for a shopping research assistant system${productCategory ? `, specialized in helping first-time ${productCategory} buyers who are unfamiliar with the product category` : ""}.
Your task is to read the structured input provided and output exactly one valid JSON object that defines the appropriate UI component.
All output MUST be written in Korean.`.trim();


const CRITERIAMAP_PROMPT = `
## Required JSON Component: CriteriaMap (Category 1a)
Use when the user asks about DECISION CRITERIA: what to look for, what specs matter, what to consider when buying.

## INPUT
<ui_context>: The Conversation Agent's full Korean text reply — passed via [UI CONTEXT].
<intent_summary>: The user's exact question — passed via [INTENT SUMMARY].
<user_context>: The user's onboarding purchase intent — passed via [USER CONTEXT]. Use only to evaluate item importance.
<existing_categories>: Previously extracted categories — present as [EXISTING CATEGORIES: ...] inside [UI CONTEXT] if this is not the first turn.

## RULES

STEP 1 — INTENT CHECK (do this first):
Read [INTENT SUMMARY] and identify the single topic the user asked about.
Only create categories whose chips directly enumerate or list options for THAT topic.
Do NOT create categories for topics only tangentially mentioned in [UI CONTEXT].

STEP 2 — EXTRACT & GROUP:
- Extract ONLY items that directly answer the question from [INTENT SUMMARY].
- Item names MUST be grounded in [UI CONTEXT]. Do NOT invent or infer names not mentioned in [UI CONTEXT].
- Group items under a short, intuitive Korean noun label.
- Keep item names descriptive enough to preserve meaning without being verbose.
- Each chip = one item object.

STEP 3 — MERGE with existing (only if [EXISTING CATEGORIES: ...] is present):
- For each new item: check if it semantically belongs to an existing label → reuse that exact label string.
- If a new item is semantically similar or a substring variant of an existing item, do NOT output it. Reuse the existing name.
- Only create a new label if the item genuinely does not fit any existing label.
- Output ALL categories (existing + new/updated) in the final JSON.

STEP 4 — ATOMICITY:
Each chip must represent EXACTLY ONE criterion. NEVER use "및", "과", "와", "그리고", "/", "·", "or", "and" in a chip name.
An item's name must NEVER be identical or semi-identical to its parent category label.

STEP 5 — IMPORTANCE (default = NOT important):
Only add "important": true after ALL three gates pass.

  GATES:
  GATE 1 — Specificity: Can you quote an exact word/phrase from [USER CONTEXT] that explains why THIS criterion matters? If paraphrasing broadly → FAIL.
  GATE 2 — Differentiation: Would a buyer WITHOUT this user's context still need to consider this criterion? If yes → FAIL. Only pass if this user's situation creates a need that most buyers don't have.
  GATE 3 — Directness: Is the connection between the user's situation and this criterion immediate, with no chain of inference? If you need more than one logical step → FAIL.
  If ANY gate fails → output only { "name": "..." } with no other fields.

  REASON FORMAT (only when all gates pass):
  Part 1: quote/paraphrase the SPECIFIC phrase from [USER CONTEXT] that creates the need.
  Part 2: state the EXACT real-world consequence if this criterion is not met (concrete action, object, or outcome).
  Format: "[Part 1] + [Part 2]". Max 80 chars, ending in "요" or "에요".

  RARITY CAP:
  "important": true is capped at 3 across the entire output. If more than 3 pass all gates, keep only the top 3 with the strongest gate scores and remove "important": true from the rest.
  If no items pass all gates, output 0 "important" items. This is valid and expected.

## OUTPUT

{
  "type": "CriteriaMap",
  "props": {
    "categories": [
      {
        "label": "<reuse exact existing label, or new short Korean noun>",
        "items": [
          { "name": "<criterion>" },
          {
            "name": "<criterion>",
            "important": true,
            "reason": "<[Part 1] + [Part 2]. Korean, max 80 chars, ending in '요' or '에요'>"
          }
        ]
      }
    ]
  }
}
`.trim();


const INFORMATIONCARD_PROMPT = `
## Required JSON Component: InformationCard (Category 1b)
Use when the user asks WHAT something IS: definitions, how a feature works, why it exists.

## INPUT
<ui_context>: The Conversation Agent's full Korean text reply — passed via [UI CONTEXT].
<intent_summary>: The user's exact question — passed via [INTENT SUMMARY].

## RULES
- term: extract the core Korean noun being explained from [INTENT SUMMARY] or the first sentence of [UI CONTEXT].
- summary: distill a single-sentence definition in Korean from [UI CONTEXT]. Max 30 chars.
- points: extract 2–3 key points from [UI CONTEXT] — each a concise Korean bullet phrase.

## OUTPUT

{
  "type": "InformationCard",
  "props": {
    "term": "<core Korean noun being explained>",
    "summary": "<one-sentence definition, max 30 chars>",
    "points": [
      "<key point 1 — concise Korean phrase>",
      "<key point 2 — concise Korean phrase>",
      "<key point 3 if clearly present — optional>"
    ]
  }
}
`.trim();

const TABLE_PROMPT = `
## Required JSON Component: Table (Category 2)
Use when comparing products side-by-side.

## INPUT
<decision_criteria>: Criteria chips from the user's Decision Criteria panel. Format: "기준명 (입력: user-typed text) [중요/보통/낮음]"
  - 기준명: the criterion label (column header)
  - (입력: ...): optional user-typed context for that criterion
  - [중요/보통/낮음]: importance level assigned by the user
<products>: Products the user wants to compare — passed via [My items] or [MY ITEMS] in context
<user_context>: User's onboarding purchase intent and situation — passed via [USER CONTEXT]
<ui_context>: Conversation Agent's product research summary (specs, prices, images) — passed via [UI CONTEXT]

## RULES
- Set "rank" as a sequential number ("1", "2", "3"...) matching the row's position in the sorted data array.

COLUMN SELECTION:
- If <decision_criteria> is present: you MUST use ONLY those criteria as your dynamic table columns (do not add any other extra columns). If absent: auto-select the most user-relevant specs from [UI CONTEXT] based on [USER CONTEXT].
- Column format: snake_case spec_key (e.g. "무게" → "weight"), Korean label (original criterion name).
- If a criterion has (입력: ...) text, use it as additional evaluation context when filling that column's cells.

FILLING CELL VALUES — strict priority order:
  1. Specs in [UI CONTEXT] — product research data from Conversation Agent. Most accurate.
  2. LLM training knowledge — use your knowledge of the product model. Append "(추정)".
  3. "-" — only if you genuinely have zero knowledge.

[ROW ORDERING — WSM (Weighted Sum Model)]
Before outputting the JSON, compute a weighted score for each product using these steps:

Step 1 — Score each product per criterion column (0.0 to 1.0):
  - Higher score = better fit for the user's need on this criterion
  - Use [USER CONTEXT] and any (입력: ...) text on the criterion as evaluation standard
  - Score relative to the other products being compared

Step 2 — Map importance to weights:
  [중요] → 0.5 | [보통] → 0.3 | [낮음] → 0.2
  If the weights don't sum to 1.0 (e.g. multiple criteria with the same importance), normalize them.

Step 3 — Compute WSM for each product:
  WSM = Σ (criterion_score × criterion_weight)

Step 4 — Sort rows by WSM descending (highest = rank "1"). Assign rank "1", "2", "3"... in order.

Compute WSM internally for each product and sort rows by descending WSM before outputting JSON. Do NOT include scoring data in the JSON output, but you MUST write a short explanation of your calculation and why the #1 product won in the '_rankReasoning' field.

## OUTPUT

{
  "type": "Table",
  "props": {
    "_rankReasoning": "<Explain your WSM calculation and why the #1 product won in Korean>",
    "columns": [
      { "key": "rank", "label": "Rank" },
      { "key": "product", "label": "<product name column label in Korean>" },
      { "key": "<spec_key>", "label": "<spec column label in Korean>" }
    ],
    "rows": [
      { "product": "<product name>", "rank": "<sequential number>", "<spec_key>": "<value>" },
      // ... one row per product — include ALL products from [UI CONTEXT], sorted best to worst
    ]
  }
}
`.trim();

const PRODUCTCARDLIST_PROMPT = `
## Required JSON Component: ProductCardList (Category 3)
Use when recommending products.

[JSON SCHEMA]
{
  "type": "ProductCardList",
  "props": {
    "cards": [
      {
        "id": "<unique_id>",
        "name": "<product name>",
        "brand": "<brand name from [UI CONTEXT]>",
        "price": "<price>",
        "imageUrl": "<image URL from [UI CONTEXT] — copy exactly as provided>",
        "link": "<product link URL from [UI CONTEXT]>",
        "specs": ["<contextualized spec in Korean 1>", "<contextualized spec in Korean 2>"]
      }
    ]
  }
}

[RULES]
- Include ALL recommended products inside the 'cards' array.
- ALWAYS copy imageUrl and link from [UI CONTEXT] exactly. Do NOT generate or guess URLs.
- brand: Extract from [UI CONTEXT] in this priority order:
  1. Use the explicit brand/maker field if present.
  2. Extract the FIRST meaningful word(s) from the product name that identifies the brand.
  3. If completely unidentifiable, use the seller/store name.
  4. NEVER leave brand as an empty string "".
- specs: 2-3 items MAX. Translate into short Korean phrases reflecting meaning for the user's context. Raw numbers or model codes are NOT allowed.
`.trim();

const SPECDIAGNOSTIC_PROMPT = `
## Required JSON Component: SpecDiagnostic (Category 4)
Use when interpreting whether a spec value is adequate — specifically to compare My Items products on a spec scale.

Think step by step before generating the JSON:
1. Identify the spec being evaluated and its unit from [UI CONTEXT].
2. Look at [MY ITEMS] for the list of products to compare. Generate EXACTLY UP TO 4 items (use however many are in [MY ITEMS], max 4).
3. For each item in [MY ITEMS], extract the numeric value for this spec from the item's spec list (after the "|" separator). The format is "제품명 | spec1: value1, spec2: value2, ...". Match the spec name being evaluated (e.g. if evaluating "무게", look for "무게" in the spec list). If the spec is found, use its EXACT numeric value. If not found in the spec list, estimate from domain knowledge. Output raw number only.
4. Infer TWO threshold values based on real-world domain knowledge (NOT based on the products' values):
   - thresholdLow: minimum spec value that is "just enough" for typical use. Below this = insufficient.
   - thresholdHigh: spec value at which "more won't help much". Above this = excess.
5. For EACH of the three zones, write a DETAILED Korean tooltip (3-5 sentences) explaining real-world consequences.
6. Write contextSummary: a SHORT Korean noun phrase (max 12 chars) from [USER CONTEXT].

[JSON SCHEMA]
{
  "type": "SpecDiagnostic",
  "props": {
    "contextSummary": "<short Korean noun phrase from [USER CONTEXT]>",
    "specName": "<spec name in Korean>",
    "specUnit": "<unit string, e.g. kg / dB / mAh / L / cm>",
    "productValue": <the specific numeric value the user asked about — extracted from [INTENT SUMMARY] or [UI CONTEXT]. If no specific queried value exists, omit this field>,
    "productLabel": "검색한 수치",
    "items": [
      { "name": "<full product name from [MY ITEMS]>", "shortName": "<abbreviated Korean label, max 6 chars>", "value": <numeric spec value> }
    ],
    "thresholdLow": <numeric: minimum acceptable value>,
    "thresholdHigh": <numeric: value beyond which gains are marginal>,
    "zoneLow": {
      "label": "<Korean word for 'insufficient'>",
      "tooltip": "<Korean: why this range is insufficient FOR THIS USER>"
    },
    "zoneMid": {
      "label": "<Korean word for 'sufficient'>",
      "tooltip": "<Korean: why this range is adequate FOR THIS USER>"
    },
    "zoneHigh": {
      "label": "<Korean word for 'excessive'>",
      "tooltip": "<Korean: why this is more than needed FOR THIS USER>"
    }
  }
}

[RULES]
- items: generate one entry per product in [MY ITEMS], up to 4. PRIORITY: use the actual spec value from the "|" spec list if it contains the relevant spec. Only fall back to estimation if the spec is absent from the list. If [MY ITEMS] is entirely empty, use products mentioned in [UI CONTEXT] instead.
- productValue: ONLY include if the user's question contains a specific numeric value (e.g. "소음 58dB면 괜찮아?" → productValue: 58). Extract from [INTENT SUMMARY] or the first sentence of [UI CONTEXT]. If no specific value was queried, OMIT productValue entirely.
- shortName: abbreviate product name to max 6 Korean chars (e.g. "부가부 폭스 5" → "부가부", "웰본 로브스또" → "로브스또").
- contextSummary: extract from [USER CONTEXT]. If no context exists, use empty string "".
- Do NOT include a "title" field.
- ALL user-visible text MUST be in Korean.
- thresholdLow and thresholdHigh MUST be based on domain knowledge, NOT on the items' values.
- Tooltips must reference the user's specific situation from [USER CONTEXT].
`.trim();

const TRADEOFFHINT_PROMPT = `
## Required JSON Component: TradeoffHint (Category 5)
Use when a new criterion has been added to a Decision Criteria list and you must check if it forces a purchase trade-off — meaning the buyer cannot realistically optimize both criteria within the same product choice.

## INPUT
<new_criterion>: The criterion just added, with its importance level — passed via NEW_CRITERION.
<existing_criteria>: List of criteria already in the list, each with importance level — passed via EXISTING_CRITERIA.
<product_category>: The product type being evaluated — passed via PRODUCT_CATEGORY. 

## RULES

DEFINITION — Trade-off is STRICTLY an INVERSE relationship:
- When NEW_CRITERION improves (↑), the existing criterion gets WORSE (↓)
- OR when NEW_CRITERION worsens (↓), the existing criterion gets BETTER (↑)
NOT a trade-off: A↑ → B↑ (complementary), A↑ → B unclear, vague/speculative relationships, or manufacturer/brand decisions.

STEP 1 — Direction check (repeat for each existing criterion):
  "If NEW_CRITERION is optimized, what happens to [existing criterion]?"
  → Gets worse → potential trade-off, proceed to STEP 2
  → Gets better or unchanged → NOT a trade-off, skip

STEP 2 — Inverse confirmation:
  "Cannot improve both simultaneously due to a physical, structural, or direct cost constraint inherent to the product?"
  Exclude: manufacturer decisions, brand policy, or speculative market trends.
  → YES → trade-off confirmed
  → NO → NOT a trade-off, skip

Only output TradeoffHint if BOTH steps confirm inverse direction.

- conflictsWith MUST be copied exactly from EXISTING_CRITERIA — do not paraphrase or invent.
- why: explain the causal chain in one sentence — why optimizing NEW_CRITERION directly leads to the existing criterion getting worse. Use everyday language a first-time buyer understands. No jargon. Max 55 chars. End with '요'.
- When in doubt, return Empty.

## OUTPUT

If a real trade-off is found:
{
  "type": "TradeoffHint",
  "props": {
    "newCriterion": "<exact name of NEW_CRITERION>",
    "conflictsWith": "<exact name from EXISTING_CRITERIA — copy verbatim>",
    "why": "<causal chain in one sentence, everyday language, no jargon. Max 55 chars, ending in '요'>"
  }
}

If NO trade-off exists:
{ "type": "Empty", "props": {} }
`.trim();

const UNCHARTEDTERRITORYCHIP_PROMPT = `
## Required JSON Component: UnchartedTerritoryChip (Category 6)
Use when the user initiates a comparative evaluation (Cat 2) and you must identify buying dimensions they have NOT yet explored, so they can make a more informed decision.

## INPUT
<existing_categories>: Categories the user has already explored — passed via EXISTING_CATEGORIES.
<product_category>: The product type being evaluated — passed via PRODUCT_CATEGORY.
<saved_criteria>: The user's saved Decision Criteria — passed via SAVED_CRITERIA.

## RULES
- Identify 2-4 important buying dimensions for PRODUCT_CATEGORY that are NOT already covered in EXISTING_CATEGORIES.
- The identified dimensions must be the most relevant to the topic, frequently considered by users, and cover a broad range of perspectives.
- These must also be dimensions a first-time buyer typically overlooks or underestimates.
- Do NOT suggest dimensions already present in EXISTING_CATEGORIES or semantically equivalent ones.
- When in doubt, return Empty.

## LABEL GRANULARITY (critical)
Labels must be at the SAME level as CriteriaMap category labels — broad topic categories, NOT specific criteria or spec names.
- CORRECT (category level): "소음", "안전 인증", "접이 방식", "배터리", "무게"
- WRONG (criterion/spec level): "배터리 용량", "최대 흡입력 Pa", "접이 후 크기", "충전 시간"
Think of each label as a chapter heading, not a bullet point within that chapter.
Each label must be a short Korean noun phrase (2–5 syllables).

## OUTPUT

If unexplored dimensions exist:
{
  "type": "UnchartedTerritoryChip",
  "props": {
    "labels": ["레이블1", "레이블2", "레이블3"]
  }
}

If all important dimensions are already covered:
{ "type": "Empty", "props": {} }
`.trim();

const EDGE_CASES_PROMPT = `
## Edge Cases
- If the category is unrecognized or null, output: { "type": "Unknown", "props": {} }
- If the context is empty or irrelevant, output: { "type": "Empty", "props": {} }
`.trim();

const buildUIAgentInstructions = (category: string | null): string => {
  let categoryPrompt = "";
  if (category === "1a") categoryPrompt = CRITERIAMAP_PROMPT;
  else if (category === "1b") categoryPrompt = INFORMATIONCARD_PROMPT;
  else if (category === "2") categoryPrompt = TABLE_PROMPT;
  else if (category === "3") categoryPrompt = PRODUCTCARDLIST_PROMPT;
  else if (category === "4") categoryPrompt = SPECDIAGNOSTIC_PROMPT;
  else if (category === "5") categoryPrompt = TRADEOFFHINT_PROMPT;
  else if (category === "6") categoryPrompt = UNCHARTEDTERRITORYCHIP_PROMPT;

  return `
${buildCommonSystemInstructions(currentProductCategory)}

${categoryPrompt}

${EDGE_CASES_PROMPT}
`.trim();
};

// ---------------------------------------------------------------------------
// UI Agent
// ---------------------------------------------------------------------------

export async function generateUISpec(
  uiContext: string,
  intentSummary: string = "",
  category: string | null = null,
  turnNumber: number = 1,
  userContext: string = "",
  savedItems: string[] = [],
  decisionCriteria: string[] = []
): Promise<string> {
  // Inject user context for categories that benefit from personalization.
  const contextRelevantCategories = ["1a", "2", "4", "5"];
  const shouldInjectUserContext = userContext && category !== null && contextRelevantCategories.includes(category);

  // Inject Decision Criteria as mandatory columns for Category 2 (Table)
  // Format must match TABLE_PROMPT CASE A check: "[DECISION CRITERIA: ...]"
  const decisionCriteriaSection = category === "2" && decisionCriteria.length > 0
    ? `\n[DECISION CRITERIA: ${decisionCriteria.join(", ")}]\n`
    : "";

  const userContextSection = shouldInjectUserContext
    ? `\n[USER CONTEXT — Onboarding purchase intent & situation]\n${userContext}\nThis is the user's actual purchase context from onboarding. For Category 1a: use this ONLY to evaluate which extracted items are especially relevant to the user's specific situation, and mark them with "important": true and a short Korean "reason". For Category 2: use this as supplemental context for ranking/rationale. For Category 4: read this carefully to pre-select chip items that match the user's actual situation, or pre-fill slider starting values.\n`
    : "";

  // Inject My Items for Category 2 (Table) and Category 4 (SpecDiagnostic)
  const myItemsSection = (category === "2" || category === "4") && savedItems.length > 0
    ? `\n[MY ITEMS — Products the user has saved for consideration]\n${savedItems.join("\n")}\n`
    : "";

  const prompt = `
[INTENT SUMMARY]
${intentSummary} (Category: ${category})
${decisionCriteriaSection}${userContextSection}${myItemsSection}
[TURN NUMBER]
${turnNumber}

[UI CONTEXT]
${uiContext}

Generate a SINGLE valid JSON object following the schema for Category ${category}.
`.trim();

  // 프롬프트가 실제로 어떻게 조립되어 LLM에 날아가는지 터미널에 출력합니다.
  console.log(`\n\x1b[35m[UI Agent 최종 프롬프트 (Category ${category})]\x1b[0m\n${prompt}\n`);

  try {
    const { text } = await generateText({
      model: anthropic(UI_AGENT_MODEL),
      system: buildUIAgentInstructions(category),
      prompt,
      temperature: 0,
    });

    return text.trim();
  } catch (err) {
    console.error("[UI_AGENT] Critical Error:", err);
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}