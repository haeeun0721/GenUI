import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { currentProductCategory, currentLocale } from "../tools/sidebar-store";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const UI_AGENT_MODEL = "claude-sonnet-4-6" as const;

type Locale = "ko" | "en";

// ---------------------------------------------------------------------------
// Common System Header
// ---------------------------------------------------------------------------

const buildCommonSystemInstructions = (productCategory: string, locale: Locale) =>
  `You are a decision-support expert UI Agent — a JSON component generator for a shopping research assistant system${productCategory ? `, specialized in helping first-time ${productCategory} buyers who are unfamiliar with the product category` : ""}.
Your task is to read the structured input provided and output exactly one valid JSON object that defines the appropriate UI component.
All text content in the JSON output MUST be written in ${locale === "en" ? "English" : "Korean"}.`.trim();

// ---------------------------------------------------------------------------
// System Prompts (locale-aware functions)
// ---------------------------------------------------------------------------

const buildCriteriaMapSystem = (locale: Locale) => {
  const lang = locale === "en" ? "English" : "Korean";
  const conjunctions = locale === "en"
    ? '"and", "or", "/", "·"'
    : '"및", "과", "와", "그리고", "/", "·", "or", "and"';
  const reasonEnding = locale === "en"
    ? 'Max 80 chars. Write in English.'
    : 'Max 80 chars, ending in "요" or "에요".';
  const labelPlaceholder = locale === "en"
    ? "<reuse exact existing label, or new short English noun>"
    : "<reuse exact existing label, or new short Korean noun>";
  const reasonPlaceholder = locale === "en"
    ? "<[Part 1] + [Part 2]. English, max 80 chars>"
    : "<[Part 1] + [Part 2]. Korean, max 80 chars, ending in '요' or '에요'>";

  return `
## Required JSON Component: CriteriaMap (Category 1a)

## INPUT
- agent_reply: The Conversation Agent's full text reply to the user's question.
- user_question: The user's exact question that triggered this response.
- user_context: The user's onboarding purchase intent and situation. Used ONLY to evaluate item importance.

## RULES

STEP 1 — INTENT CHECK (do this first):
Read user_question and identify the single topic the user asked about.
Only create categories whose chips directly enumerate or list options for THAT topic.
Do NOT create categories for any topic the user did not explicitly ask about, 
even if agent_reply mentions it. Treat any mention beyond the user's question as noise.

STEP 2 — EXTRACT & GROUP:
- Extract ONLY items that directly answer user_question.
- Item names MUST be grounded in agent_reply. Do NOT invent or infer names not mentioned there.
- Group items under a short, intuitive ${lang} noun label.
- Keep item names descriptive enough to preserve meaning without being verbose.
- Each chip = one item object.

STEP 3 — CHIP QUALITY CHECK:
Before creating a chip, ask:
  Q1. Would a typical buyer actually consider this when choosing a product? If not → EXCLUDE.
  Q2. Is this too niche or detailed for a general purchase decision? If yes → EXCLUDE.

STEP 4 — MERGE with existing (only if existing categories appear in agent_reply):
- For each new item: check if it semantically belongs to an existing label → reuse that exact label string.
- If a new item is semantically similar or a substring variant of an existing item, do NOT output it.
- Only create a new label if the item genuinely does not fit any existing label.
- Output ALL categories (existing + new/updated) in the final JSON.

STEP 5 — ATOMICITY:
Each chip must represent EXACTLY ONE criterion. NEVER use ${conjunctions} in a chip name.
An item's name must NEVER be identical or semi-identical to its parent category label.

STEP 6 — IMPORTANCE (default = NOT important):
Only add "important": true after ALL three gates pass using user_context.

  GATE 1 — Specificity: Can you quote an exact word/phrase from user_context that explains why THIS criterion matters? If paraphrasing broadly → FAIL.
  GATE 2 — Differentiation: Would a buyer WITHOUT this user's context still need this criterion? If yes → FAIL.
  GATE 3 — Directness: Is the connection immediate, with no chain of inference? If more than one logical step → FAIL.
  If ANY gate fails → output only { "name": "..." }.

  REASON FORMAT (only when all gates pass):
  Part 1: quote/paraphrase the SPECIFIC phrase from user_context that creates the need.
  Part 2: state the EXACT real-world consequence if this criterion is not met.
  Format: "[Part 1] + [Part 2]". ${reasonEnding}

  RARITY CAP: "important": true is capped at 3 across the entire output.

## OUTPUT

{
  "type": "CriteriaMap",
  "props": {
    "categories": [
      {
        "label": "${labelPlaceholder}",
        "items": [
          { "name": "<criterion>" },
          {
            "name": "<criterion>",
            "important": true,
            "reason": "${reasonPlaceholder}"
          }
        ]
      }
    ]
  }
}
`.trim();
};

const buildInformationCardSystem = (locale: Locale) => {
  const lang = locale === "en" ? "English" : "Korean";
  return `
## Required JSON Component: InformationCard (Category 1b)

## INPUT
- agent_reply: The Conversation Agent's full text reply explaining a concept.
- user_question: The user's exact question about the concept.

## RULES
- term: extract the core noun/term being explained from user_question or the first sentence of agent_reply. Write it in ${lang}.
- summary: distill a single-sentence definition in ${lang} from agent_reply. Max 30 chars.
- points: extract 2–3 key points from agent_reply — each a concise ${lang} bullet phrase.

## OUTPUT

{
  "type": "InformationCard",
  "props": {
    "term": "<core term being explained, in ${lang}>",
    "summary": "<one-sentence definition in ${lang}, max 30 chars>",
    "points": [
      "<key point 1 — concise ${lang} phrase>",
      "<key point 2 — concise ${lang} phrase>",
      "<key point 3 if clearly present — optional>"
    ]
  }
}
`.trim();
};

const buildTableSystem = (locale: Locale) => {
  const lang = locale === "en" ? "English" : "Korean";
  const importanceWeights = locale === "en"
    ? "[High] → 0.5 | [Med] → 0.3 | [Low] → 0.2"
    : "[중요] → 0.5 | [보통] → 0.3 | [낮음] → 0.2";

  return `
## Required JSON Component: Table (Category 2)

## INPUT
- product_data: Product specs, prices, and details retrieved for comparison.
- decision_criteria: Criteria from the user's Decision Criteria panel.
- saved_items: Products the user has saved for comparison.
- user_context: The user's onboarding purchase intent and situation.

## RULES
- Set "rank" as a sequential number ("1", "2", "3"...) matching the row's position.

COLUMN SELECTION:
- If decision_criteria is provided: use ONLY those as dynamic columns. If absent: auto-select most relevant specs from product_data based on user_context.
- Column format: snake_case spec_key, ${lang} label.
- If a criterion has additional text in parentheses, use it as additional evaluation context.

FILLING CELL VALUES:
  1. Use ONLY values explicitly present in product_data. This is the sole source of truth.
  2. Use "-" if the value is not found. Do NOT guess or infer.
  CRITICAL: Never append "(추정)" or "(estimated)". Either the value exists or the cell is "-".

[ROW ORDERING — WSM (Weighted Sum Model)]
Step 1 — Score each product per criterion (0.0 to 1.0). Use user_context as evaluation standard.
Step 2 — Map importance to weights: ${importanceWeights}. Normalize if needed.
Step 3 — WSM = Σ (criterion_score × criterion_weight).
Step 4 — Sort rows by WSM descending. Assign rank "1", "2", "3"...
Write a short explanation in '_rankReasoning' in ${lang}. Do NOT include scores in the JSON.

## OUTPUT

{
  "type": "Table",
  "props": {
    "_rankReasoning": "<WSM explanation and why #1 product won, in ${lang}>",
    "columns": [
      { "key": "rank", "label": "Rank" },
      { "key": "product", "label": "<product name column label in ${lang}>" },
      { "key": "<spec_key>", "label": "<spec column label in ${lang}>" }
    ],
    "rows": [
      { "product": "<product name>", "rank": "<number>", "<spec_key>": "<value>" }
    ]
  }
}
`.trim();
};

const buildProductCardListSystem = (locale: Locale, productCategory: string) => {
  const lang = locale === "en" ? "English" : "Korean";
  return `
## Required JSON Component: ProductCardList (Category 3)

## INPUT
- product_data: Product specs, prices, images, and links retrieved from product search.

## RULES
- CRITICAL: ALWAYS output a valid ProductCardList. NEVER output { "type": "Empty" } for Category 3.
- Include ALL recommended products inside the 'cards' array. Minimum 1 card.
- Copy imageUrl and link from product_data exactly if available. If not available, omit those fields.
- brand: Extract from product_data (brand field → first word of product name → seller name). NEVER leave blank.
- specs: 2-3 items MAX. Short ${lang} phrases reflecting user-relevant meaning. No raw numbers or model codes.
- If product_data is insufficient, generate cards from your knowledge of popular ${productCategory || "consumer"} products.

## OUTPUT

{
  "type": "ProductCardList",
  "props": {
    "cards": [
      {
        "id": "<unique_id>",
        "name": "<product name>",
        "brand": "<brand name>",
        "price": "<price>",
        "imageUrl": "<image URL — copy exactly from product_data, or omit if unavailable>",
        "link": "<product link URL — copy exactly from product_data, or omit if unavailable>",
        "specs": ["<${lang} spec phrase 1>", "<${lang} spec phrase 2>", "<${lang} spec phrase 3>"]
      }
    ]
  }
}
`.trim();
};

const buildTradeoffHintSystem = (locale: Locale) => {
  const whyEnding = locale === "en"
    ? "Max 55 chars. Write in English."
    : "Max 55 chars. End with '요'.";
  const whyPlaceholder = locale === "en"
    ? "<causal chain, max 55 chars, in English>"
    : "<causal chain, max 55 chars, ending in '요'>";

  return `
## Required JSON Component: TradeoffHint (Category 5)

## INPUT
- new_criterion: The criterion just added by the user, with its importance level.
- existing_criteria: List of criteria already saved, each with importance level.
- product_category: The product type being evaluated.

## RULES

DEFINITION — Trade-off is STRICTLY an INVERSE relationship:
- When new_criterion improves (↑), an existing criterion gets WORSE (↓), or vice versa.
NOT a trade-off: complementary relationships (A↑ → B↑), vague/speculative, or manufacturer/brand decisions.

STEP 1 — Direction check (repeat for each existing criterion):
  "If new_criterion is optimized, what happens to [existing criterion]?"
  → Gets worse → potential trade-off, proceed to STEP 2
  → Gets better or unchanged → NOT a trade-off, skip

STEP 2 — Inverse confirmation:
  "Would a typical first-time buyer encounter this trade-off naturally during their purchase decision?"
  → Is this a trade-off that comes up in everyday product comparisons, reviews, or word-of-mouth?
  → YES → trade-off confirmed

Only output TradeoffHint if BOTH steps confirm inverse direction.

- conflictsWith MUST be copied exactly from existing_criteria — do not paraphrase.
- why: one sentence, everyday language, no jargon. ${whyEnding}
- When in doubt, return Empty.

## OUTPUT

If a real trade-off is found:
{
  "type": "TradeoffHint",
  "props": {
    "newCriterion": "<exact name of new_criterion>",
    "conflictsWith": "<exact name from existing_criteria — copy verbatim>",
    "why": "${whyPlaceholder}"
  }
}

If NO trade-off exists:
{ "type": "Empty", "props": {} }
`.trim();
};

const buildUnchartedTerritoryChipSystem = (locale: Locale) => {
  const lang = locale === "en" ? "English" : "Korean";
  const examples = locale === "en"
    ? '- CORRECT: "Noise Level", "Safety Certifications", "Folding Mechanism", "Battery Life", "Weight"\n- WRONG: "Battery Capacity (mAh)", "Max Suction (Pa)", "Folded Dimensions"'
    : '- CORRECT: "소음", "안전 인증", "접이 방식", "배터리", "무게"\n- WRONG: "배터리 용량", "최대 흡입력 Pa", "접이 후 크기"';
  const labelPlaceholder = locale === "en"
    ? '["Label1", "Label2", "Label3"]'
    : '["레이블1", "레이블2", "레이블3"]';

  return `
## Required JSON Component: UnchartedTerritoryChip (Category 6)

## INPUT
- existing_categories: Categories the user has already explored in their research journey.
- product_category: The product type being evaluated.
- saved_criteria: The user's saved Decision Criteria.

## RULES
- Identify 2-4 important buying dimensions for product_category NOT already covered in existing_categories.
- Must be dimensions frequently considered by buyers and typically overlooked by first-time buyers.
- Do NOT suggest dimensions already in existing_categories or semantically equivalent ones.
- When in doubt, return Empty.

## LABEL GRANULARITY (critical)
Labels must be broad topic categories, NOT specific criteria or spec names.
${examples}
Each label must be a short ${lang} noun phrase (2–5 words max).

## OUTPUT

If unexplored dimensions exist:
{ "type": "UnchartedTerritoryChip", "props": { "labels": ${labelPlaceholder} } }

If all dimensions are already covered:
{ "type": "Empty", "props": {} }
`.trim();
};

const EDGE_CASES_SYSTEM = `
## Edge Cases
- If the category is unrecognized or null, output: { "type": "Unknown", "props": {} }
- If the context is empty or irrelevant, output: { "type": "Empty", "props": {} }
`.trim();

// ---------------------------------------------------------------------------
// System Prompt Builder
// ---------------------------------------------------------------------------

const buildUIAgentInstructions = (category: string | null): string => {
  const productCategory = currentProductCategory;
  const locale: Locale = currentLocale;

  let categorySystem = "";
  if (category === "1a") categorySystem = buildCriteriaMapSystem(locale);
  else if (category === "1b") categorySystem = buildInformationCardSystem(locale);
  else if (category === "2") categorySystem = buildTableSystem(locale);
  else if (category === "3") categorySystem = buildProductCardListSystem(locale, productCategory);
  else if (category === "5") categorySystem = buildTradeoffHintSystem(locale);
  else if (category === "6") categorySystem = buildUnchartedTerritoryChipSystem(locale);

  // Category 3 (ProductCardList) must ALWAYS output cards — exclude EDGE_CASES_SYSTEM
  const includeEdgeCases = category !== "3";

  return [
    buildCommonSystemInstructions(productCategory, locale),
    categorySystem,
    includeEdgeCases ? EDGE_CASES_SYSTEM : "",
  ].filter(Boolean).join("\n\n");
};

// ---------------------------------------------------------------------------
// User Message Builder (direct interpolation)
// ---------------------------------------------------------------------------

const buildUserMessage = (
  category: string | null,
  uiContext: string,
  intentSummary: string,
  userContext: string,
  savedItems: string[],
  decisionCriteria: string[]
): string => {
  if (category === "1a") {
    return [
      `user_question: "${intentSummary}"`,
      `agent_reply:\n${uiContext}`,
      userContext ? `user_context:\n${userContext}` : "",
      "Generate the CriteriaMap JSON.",
    ].filter(Boolean).join("\n\n");
  }

  if (category === "1b") {
    return [
      `user_question: "${intentSummary}"`,
      `agent_reply:\n${uiContext}`,
      "Generate the InformationCard JSON.",
    ].join("\n\n");
  }

  if (category === "2") {
    return [
      decisionCriteria.length > 0 ? `decision_criteria: ${decisionCriteria.join(", ")}` : "",
      savedItems.length > 0 ? `saved_items:\n${savedItems.join("\n")}` : "",
      userContext ? `user_context:\n${userContext}` : "",
      `product_data:\n${uiContext}`,
      "Generate the Table JSON.",
    ].filter(Boolean).join("\n\n");
  }

  if (category === "3") {
    return [
      `product_data:\n${uiContext}`,
      "Generate the ProductCardList JSON.",
    ].join("\n\n");
  }

  // Cat 5, 6: routes format their own input with field labels
  return `${uiContext}\n\nGenerate the JSON.`;
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
  const system = buildUIAgentInstructions(category);
  const prompt = buildUserMessage(category, uiContext, intentSummary, userContext, savedItems, decisionCriteria);

  console.log(`\n\x1b[35m[UI Agent 최종 프롬프트 (Category ${category})]\\x1b[0m\n${prompt}\n`);

  try {
    const { text } = await generateText({
      model: anthropic(UI_AGENT_MODEL),
      system,
      prompt,
      temperature: 0,
    });

    return text.trim();
  } catch (err) {
    console.error("[UI_AGENT] Critical Error:", err);
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}