import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { currentProductCategory, currentLocale } from "../tools/sidebar-store";

// ---------------------------------------------------------------------------
// Tavily 웹 검색 헬퍼 (비교표 미확인 셀 보완용)
// ---------------------------------------------------------------------------

type TavilyResult = { title: string; url: string; content: string; score: number };

async function tavilySearch(query: string): Promise<TavilyResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) { console.warn("[Tavily] API 키 없음"); return []; }

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: 5,
      include_answer: false,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) { console.warn(`[Tavily] ${res.status}`); return []; }
  const data = await res.json() as { results?: TavilyResult[] };
  return data.results ?? [];
}

/** JSON 문자열에서 "-" 값인 셀 목록 추출 */
function findMissingCells(
  tableJson: { props?: { columns?: Array<{ key: string; label: string }>; rows?: Array<Record<string, string>> } },
): Array<{ rowCriterion: string; colKey: string; productLabel: string }> {
  const columns = tableJson.props?.columns ?? [];
  const rows = tableJson.props?.rows ?? [];
  const productCols = columns.filter(c => c.key !== "criterion");
  const missing: Array<{ rowCriterion: string; colKey: string; productLabel: string }> = [];

  for (const row of rows) {
    const criterion = row["criterion"] ?? "";
    if (!criterion || criterion === "순위" || criterion === "Rank") continue;
    for (const col of productCols) {
      const val = row[col.key];
      if (!val || val === "-") {
        missing.push({ rowCriterion: criterion, colKey: col.key, productLabel: col.label });
      }
    }
  }
  return missing;
}

/** uiContext 문자열에서 제품명 → 스펙+설명 텍스트 매핑 추출 */
function parseProductSpecsFromContext(uiContext: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const blocks = uiContext.split(/\[Product \d+\]/);
  for (const block of blocks) {
    const nameMatch = block.match(/Name:\s*(.+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    const specsMatch = block.match(/Specs:\s*(.+)/);
    const descMatch = block.match(/Description:\s*(.+)/);
    const specsRaw = specsMatch ? specsMatch[1].trim() : "";
    const desc = descMatch ? descMatch[1].trim() : "";
    const specs = specsRaw.split("/").map(s => s.trim()).filter(Boolean);
    if (desc) specs.push(desc);
    map.set(name, specs);
  }
  return map;
}

/** 짧은 테이블 열 레이블에 가장 잘 매칭되는 제품의 스펙 반환 */
function findSpecsForLabel(shortLabel: string, specMap: Map<string, string[]>): string[] {
  const lower = shortLabel.toLowerCase().trim();
  for (const [name, specs] of specMap) {
    const nameLower = name.toLowerCase();
    if (nameLower.includes(lower) || lower.includes(nameLower.slice(0, 8))) return specs;
  }
  const firstWord = lower.split(/\s+/)[0] ?? "";
  if (firstWord.length >= 2) {
    for (const [name, specs] of specMap) {
      if (name.toLowerCase().includes(firstWord)) return specs;
    }
  }
  return [];
}

/** 기준 키워드가 스펙 텍스트에 직접 근거하는지 확인 */
function isCriterionGrounded(criterion: string, specs: string[]): boolean {
  if (specs.length === 0) return false;
  const specText = specs.join(" ").toLowerCase();
  const keywords = criterion.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  if (keywords.length === 0) return false;
  return keywords.some(kw => specText.includes(kw));
}

/** ○/X로 채워졌으나 Danawa 스펙에 근거 없는 셀 탐지 (할루시네이션 후보) */
function findUngroundedCells(
  tableJson: { props?: { columns?: Array<{ key: string; label: string }>; rows?: Array<Record<string, string>> } },
  uiContext: string,
): Array<{ rowCriterion: string; colKey: string; productLabel: string; originalValue: string }> {
  const specMap = parseProductSpecsFromContext(uiContext);
  const columns = tableJson.props?.columns ?? [];
  const rows = tableJson.props?.rows ?? [];
  const productCols = columns.filter(c => c.key !== "criterion");
  const ungrounded: Array<{ rowCriterion: string; colKey: string; productLabel: string; originalValue: string }> = [];
  for (const row of rows) {
    const criterion = row["criterion"] ?? "";
    if (!criterion || criterion === "순위" || criterion === "Rank") continue;
    for (const col of productCols) {
      const val = row[col.key];
      if (val !== "○" && val !== "X") continue;
      const specs = findSpecsForLabel(col.label, specMap);
      if (!isCriterionGrounded(criterion, specs)) {
        ungrounded.push({ rowCriterion: criterion, colKey: col.key, productLabel: col.label, originalValue: val });
      }
    }
  }
  return ungrounded;
}

/** Claude로 기준의 한국어 유의어 생성 */
async function expandCriterionSynonyms(criteria: string[]): Promise<Record<string, string[]>> {
  if (criteria.length === 0) return {};
  const { text } = await generateText({
    model: anthropic("claude-haiku-4-5"),
    system: "You are a Korean product spec synonym generator. Given a list of product criteria in Korean, return a JSON object where each key is the criterion and the value is an array of 2-3 Korean synonyms or related search terms. Output only valid JSON.",
    prompt: `Generate synonyms for these criteria: ${JSON.stringify(criteria)}`,
    temperature: 0,
  });
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  } catch { return {}; }
}

/** 검색 스니펫을 기반으로 셀 값 판단 */
async function judgeCell(
  productName: string,
  criterion: string,
  snippets: TavilyResult[],
  locale: string
): Promise<{ value: string; sourceUrl?: string; usedSnippet?: string }> {
  if (snippets.length === 0) return { value: "-" };

  const snippetText = snippets
    .slice(0, 3)
    .map((r, i) => `[${i + 1}] (${r.url})\n${r.content.slice(0, 300)}`)
    .join("\n\n");

  const { text } = await generateText({
    model: anthropic("claude-haiku-4-5"),
    system: `You are a product spec verifier. Given search snippets, determine if the product has the specified feature.
Respond with ONLY a JSON object: { "value": "○" | "X" | "-", "sourceIndex": <1-based index of snippet used, or null> }
"○" = feature confirmed present, "X" = feature confirmed absent, "-" = cannot determine from snippets.`,
    prompt: `Product: ${productName}\nFeature/Criterion: ${criterion}\n\nSearch Snippets:\n${snippetText}`,
    temperature: 0,
  });

  try {
    const match = text.match(/\{[\s\S]*?\}/);
    const result = match ? JSON.parse(match[0]) : { value: "-" };
    const srcIdx: number | null = result.sourceIndex ?? null;
    const usedSnippetObj = srcIdx != null ? snippets[srcIdx - 1] : null;
    const sourceUrl   = usedSnippetObj?.url;
    // 판단에 쓰인 실제 문장 (앞 120자)
    const usedSnippet = usedSnippetObj?.content.slice(0, 120).replace(/\s+/g, " ").trim();
    return { value: result.value ?? "-", sourceUrl, usedSnippet };
  } catch { return { value: "-" }; }
}

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

STEP 7 — CONFIDENCE ESTIMATION:
For every item, estimate the user's certainty about this criterion from the conversation context.
Output "confidence": "high" | "medium" | "low".

  "high"  → user stated a specific value or threshold (e.g., "5kg 이하", "원터치"), repeated multiple times, or used strong language ("꼭", "반드시", "무조건").
  "medium" → mentioned as a general preference, once, without specifics or strong emphasis.
  "low"   → surfaced from Uncharted Territory, or user used hedging language ("가능하면", "있으면 좋겠어", "잘 모르겠어"), or it was inferred rather than explicitly stated.

## OUTPUT

{
  "type": "CriteriaMap",
  "props": {
    "categories": [
      {
        "label": "${labelPlaceholder}",
        "items": [
          { "name": "<criterion>", "confidence": "medium" },
          {
            "name": "<criterion>",
            "important": true,
            "reason": "${reasonPlaceholder}",
            "confidence": "high"
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

## TABLE LAYOUT — TRANSPOSED (Criteria = Rows, Products = Columns)
The table grows vertically (more rows) as criteria increase — NOT horizontally.
- columns[0]: always { "key": "criterion", "label": "${locale === 'en' ? 'Criteria' : '비교 항목'}" }
- columns[1..N]: one column per product, key = "prod_0", "prod_1", ... label = shortened product name (max 12 chars), imageUrl = the URL found on the 'Image:' line in product_data for that product (MANDATORY — never omit)
- rows[0]: always the RANK row — { "criterion": "${locale === 'en' ? 'Rank' : '순위'}", "prod_0": "1위", "prod_1": "2위", ... }
- rows[1..M]: one row per decision criterion

## RULES

CRITERION ROWS (MANDATORY):
- CRITICAL: You MUST create EXACTLY one row per item in decision_criteria — no skipping, no merging, no adding extras.
- CRITICAL: Do NOT add any rows that are not in decision_criteria. Do NOT auto-select specs from product_data.
- Row label = the criterion name from decision_criteria (strip parenthetical notes and importance brackets).
  e.g., "접이식 여부 (입력: 접을 수 있어야 함) [중요]" → row label: "접이식 여부"
- If a criterion describes a product type (e.g., "디럭스 유모차"), check product_data for matching spec and use "○" or "-".

FILLING CELL VALUES — STRICT EVIDENCE-ONLY POLICY:
  1. Check product_data and saved_items for a DIRECT textual match of the criterion (or its synonym).
  2. ALWAYS prefer a short concrete value over a symbol:
     - If product_data contains a specific value for the criterion (number, range, short phrase ≤ 15 chars), copy it verbatim as the cell value.
       Examples: "15~165°", "6.2kg", "최대 22kg", "원터치폴딩", "양방향"
     - If the criterion is purely boolean (feature present/absent) and NO concrete value exists:
       Use "○" if a synonym is LITERALLY present in the product_data text.
       Use "X" ONLY if the product_data text explicitly states the feature is absent.
     - If a value exists but is too long (> 15 chars), extract only the most informative short fragment (≤ 15 chars).
  3. CRITICAL — NO GUESSING: If the value is NOT directly found in product_data text, output "-".
     Do NOT use your training-data knowledge about the product.
     Do NOT infer from brand reputation, product line, or general category knowledge.
     Do NOT assume a feature exists because it is common for this product type.
     The downstream pipeline will automatically run a web search to fill all "-" cells.
  4. Concrete numeric values (weight, price, dimensions): only copy verbatim from product_data. If absent → "-".
  CRITICAL: Never append "(추정)" or "(estimated)". If uncertain → "-".

[RANKING]
Do NOT compute or assign rank values. Leave all rank row cells as "-".
The ranking will be computed externally after all cells are verified.
Only write '_rankReasoning' as an empty string: "".

## OUTPUT

{
  "type": "Table",
  "props": {
    "_rankReasoning": "<plain-language explanation in ${lang}>",
    "columns": [
      { "key": "criterion", "label": "${locale === 'en' ? 'Criteria' : '비교 항목'}" },
      { "key": "prod_0", "label": "<short product name ≤12 chars>", "imageUrl": "<find the line starting with 'Image:' in product_data for this product, copy the URL after 'Image: ' exactly>" },
      { "key": "prod_1", "label": "<short product name ≤12 chars>", "imageUrl": "<find the line starting with 'Image:' in product_data for this product, copy the URL after 'Image: ' exactly>" }
    ],
    "rows": [
      { "criterion": "${locale === 'en' ? 'Rank' : '순위'}", "prod_0": "1위", "prod_1": "2위" },
      { "criterion": "<criterion label>", "prod_0": "<value or - >", "prod_1": "<value or - >" }
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
    ? "<specific physical or cost mechanism, max 55 chars, in English>"
    : "<specific physical or cost mechanism, max 55 chars, ending in '요'>";

  return `
## Required JSON Component: TradeoffHint (Category 5)

## INPUT
- new_criterion: The criterion just added by the user, with its importance level.
- existing_criteria: List of criteria already saved, each with importance level.
- product_category: The product type being evaluated.

## RULES

DEFINITION — Trade-off is STRICTLY an INVERSE relationship caused by a physical, mechanical, or cost constraint:
- When new_criterion is maximized, an existing criterion necessarily degrades as a direct consequence, or vice versa.

NOT a trade-off:
- Complementary relationships (A↑ → B↑)
- Threshold/prerequisite relationships (A must reach level X for B to be possible)
- Conditional relationships (A↑ → B↓ only in specific configurations)
- Correlation without a clear causal mechanism
- Manufacturer or brand decisions that could be avoided with better engineering
- Vague or speculative relationships ("might affect", "could influence")

STEP 1 — Direction check (repeat for each existing criterion):
  Assume new_criterion is pushed to its MAXIMUM possible value.
  → Does [existing criterion] move toward its WORST value as a direct consequence?
  → YES → proceed to STEP 2
  → NO, UNCERTAIN, or "it depends" → NOT a trade-off, skip

STEP 2 — Causal inverse confirmation:
  "If a manufacturer maximizes new_criterion,
   does [existing criterion] necessarily degrade
   due to a physical, mechanical, or cost constraint?"
  → Is there a specific, identifiable mechanism (e.g., added material increases weight, larger motor raises noise)?
  → YES, mechanism is clear and direct → trade-off confirmed
  → "It depends" or "not necessarily" → NOT a trade-off, skip

Only output TradeoffHint if BOTH steps confirm inverse direction with a clear causal mechanism.

- conflictsWith MUST be copied exactly from existing_criteria — do not paraphrase.
- why: one sentence describing the specific physical or cost mechanism causing the conflict. Everyday language, no jargon. ${whyEnding}
  BAD: vague consequence ("사용이 불편할 수 있어요", "may affect comfort")
  GOOD: specific mechanism ("모터가 강할수록 소음이 커져요", "larger motor directly raises noise")
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
    // ── Category 2: 4단계 파이프라인 ──────────────────────────────────────────
    // STEP 1: RAG 데이터(Danawa)로 1차 표 생성
    // STEP 2: "-" 셀 탐지
    // STEP 3: Tavily 웹 검색 (유의어 확장)
    // STEP 4: 검색 스니펫 기반 셀 값 판단
    if (category === "2") {
      const t0 = Date.now();
      console.log("\n\x1b[35m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");
      console.log("\x1b[35m [비교표 파이프라인 시작]\x1b[0m");
      console.log("\x1b[35m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n");

      // ── STEP 1: 1차 표 생성 (Danawa RAG 데이터 기반) ──────────────────────
      console.log("\x1b[33m[STEP 1] Claude로 1차 표 생성 (Danawa 스펙만 사용)...\x1b[0m");
      const s1 = Date.now();
      const { text: firstPassText } = await generateText({
        model: anthropic(UI_AGENT_MODEL),
        system,
        prompt,
        temperature: 0,
      });
      console.log(`\x1b[33m[STEP 1] 완료 (${Date.now() - s1}ms)\x1b[0m`);

      // JSON 파싱
      let tableJson: { props?: { columns?: Array<{ key: string; label: string }>; rows?: Array<Record<string, string>> }; [k: string]: unknown };
      try {
        const match = firstPassText.match(/\{[\s\S]*\}/);
        tableJson = match ? JSON.parse(match[0]) : null;
      } catch { tableJson = null as unknown as typeof tableJson; }

      if (!tableJson) {
        console.log("\x1b[31m[STEP 1] JSON 파싱 실패 → 원본 텍스트 반환\x1b[0m");
        return firstPassText.trim();
      }

      // ── STEP 1 후처리: product_data에서 imageUrl 직접 주입 ─────────────────
      // Claude가 imageUrl을 생략하거나 잘못 복사하는 경우를 서버사이드에서 보정
      {
        // uiContext에서 제품명 → 이미지 URL 매핑 파싱
        const imageMap = new Map<string, string>();
        const blocks = uiContext.split(/\[Product \d+\]/);
        for (const block of blocks) {
          const nameMatch  = block.match(/Name:\s*(.+)/);
          const imageMatch = block.match(/Image:\s*(\S+)/);
          if (nameMatch && imageMatch) {
            imageMap.set(nameMatch[1].trim().toLowerCase(), imageMatch[1].trim());
          }
        }

        const cols = tableJson.props?.columns ?? [];
        for (const col of cols) {
          if (col.key === "criterion") continue;
          const colLower = col.label.toLowerCase();

          // 이미 유효한 imageUrl이 있으면 스킵
          if ((col as any).imageUrl) continue;

          // 제품 이름 부분 매칭으로 이미지 URL 찾기
          let found: string | undefined;
          for (const [name, url] of imageMap) {
            if (name.includes(colLower) || colLower.includes(name) ||
                name.split(/\s+/).some(w => w.length >= 3 && colLower.includes(w))) {
              found = url;
              break;
            }
          }
          if (found) {
            (col as any).imageUrl = found;
            console.log(`\x1b[32m[STEP 1 후처리] "${col.label}" imageUrl 주입: ${found.slice(0, 60)}\x1b[0m`);
          } else {
            console.log(`\x1b[90m[STEP 1 후처리] "${col.label}" 이미지 없음 (product_data 매칭 실패)\x1b[0m`);
          }
        }
      }


      // ── STEP 2: 셀 신뢰도 분석 ("-" 미확인 + 근거 없는 ○/X 할루시네이션 탐지) ──
      console.log("\n\x1b[33m[STEP 2] 1차 표 결과 분석:\x1b[0m");
      const columns = tableJson.props?.columns ?? [];
      const productCols = columns.filter(c => c.key !== "criterion");
      const allRows = tableJson.props?.rows ?? [];

      // 신뢰도 검사 먼저 실행
      const missingCells = findMissingCells(tableJson);
      const ungroundedCells = findUngroundedCells(tableJson, uiContext);
      const ungroundedKeys = new Set(
        ungroundedCells.map(c => `${c.colKey}__${c.rowCriterion}`)
      );

      // 표 전체 상태 출력: ✓=확인됨(초록), ⚠=근거없음(노랑), ?=누락(빨강)
      for (const row of allRows) {
        const criterion = row["criterion"] ?? "";
        if (!criterion) continue;
        const cells = productCols.map(col => {
          const val = row[col.key];
          const missing = !val || val === "-";
          const isUngrounded = ungroundedKeys.has(`${col.key}__${criterion}`);
          const symbol = missing
            ? "\x1b[31m?\x1b[0m"
            : isUngrounded
            ? `\x1b[33m⚠${val}\x1b[0m`
            : `\x1b[32m${val}\x1b[0m`;
          return `${col.label.slice(0, 8)}: ${symbol}`;
        }).join("  |  ");
        console.log(`         ${criterion.padEnd(15)} │ ${cells}`);
      }

      // 두 목록 통합 (중복 없이)
      const allCellsToVerify = [
        ...missingCells,
        ...ungroundedCells.map(c => ({
          rowCriterion: c.rowCriterion,
          colKey: c.colKey,
          productLabel: c.productLabel,
        })),
      ];

      if (allCellsToVerify.length === 0) {
        console.log("\x1b[32m\n[STEP 2] 모든 셀 Danawa 스펙으로 확인됨 → 웹 검색 생략, WSM 순위 계산으로 이동\x1b[0m\n");
        // 웹 검색 없이 바로 STEP 5로 이동
      } else {
      if (missingCells.length > 0) {
        console.log(`\n\x1b[33m[STEP 2] 미확인 셀 ${missingCells.length}개 (값 없음 "-"):\x1b[0m`);
        missingCells.forEach(c =>
          console.log(`         • ${c.productLabel} × "${c.rowCriterion}" (값 없음)`)
        );
      }
      if (ungroundedCells.length > 0) {
        console.log(`\n\x1b[33m[STEP 2] 근거 불명 셀 ${ungroundedCells.length}개 (할루시네이션 의심):\x1b[0m`);
        ungroundedCells.forEach(c =>
          console.log(`         • ${c.productLabel} × "${c.rowCriterion}" (Claude "${c.originalValue}" 입력 → 스펙 근거 없음)`)
        );
      }
      console.log(`\n\x1b[33m[STEP 2] 총 ${allCellsToVerify.length}개 셀 웹 검색 대상\x1b[0m`);


      // ── STEP 3: 유의어 생성 + Tavily 검색 ────────────────────────────────
      const uniqueCriteria = [...new Set(allCellsToVerify.map(c => c.rowCriterion))];
      console.log(`\n\x1b[33m[STEP 3-A] 유의어 생성 (Claude Haiku): ${JSON.stringify(uniqueCriteria)}\x1b[0m`);
      const s3a = Date.now();
      const synonymMap = await expandCriterionSynonyms(uniqueCriteria);
      console.log(`\x1b[33m[STEP 3-A] 유의어 결과 (${Date.now() - s3a}ms):\x1b[0m`);
      for (const [crit, syns] of Object.entries(synonymMap)) {
        console.log(`         "${crit}" → [${(syns as string[]).join(", ")}]`);
      }

      console.log(`\n\x1b[33m[STEP 3-B] Tavily 병렬 검색 시작 (${allCellsToVerify.length}개 쿼리)...\x1b[0m`);
      const s3b = Date.now();
      const searchResultMap = new Map<string, TavilyResult[]>();
      await Promise.all(
        allCellsToVerify.map(async ({ rowCriterion, productLabel }) => {
          const key = `${productLabel}__${rowCriterion}`;
          if (searchResultMap.has(key)) return;
          const synonyms = synonymMap[rowCriterion] ?? [];
          const terms = [rowCriterion, ...synonyms].slice(0, 3).join(" OR ");
          const query = `${productLabel} (${terms})`;
          const results = await tavilySearch(query);
          searchResultMap.set(key, results);
          console.log(`         🔍 "${query}" → ${results.length}개 결과`);
          results.slice(0, 2).forEach(r =>
            console.log(`            - ${r.title.slice(0, 50)} (${r.url.slice(0, 60)})`)
          );
        })
      );
      console.log(`\x1b[33m[STEP 3-B] 검색 완료 (${Date.now() - s3b}ms)\x1b[0m`);

      // ── STEP 4: 셀 값 판단 + 표 업데이트 ────────────────────────────────
      console.log(`\n\x1b[33m[STEP 4] Claude Haiku로 셀 값 판단 중...\x1b[0m`);
      const s4 = Date.now();
      const sourceLog: string[] = [];
      const rows = tableJson.props?.rows ?? [];

      await Promise.all(
        allCellsToVerify.map(async ({ rowCriterion, colKey, productLabel }) => {
          const key = `${productLabel}__${rowCriterion}`;
          const snippets = searchResultMap.get(key) ?? [];
          const { value, sourceUrl, usedSnippet } = await judgeCell(productLabel, rowCriterion, snippets, currentLocale);

          const targetRow = rows.find(r => r["criterion"] === rowCriterion);
          if (targetRow) targetRow[colKey] = value;

          const symbol = value === "○" ? "\x1b[32m○\x1b[0m" : value === "X" ? "\x1b[31mX\x1b[0m" : "\x1b[90m-\x1b[0m";
          const src = sourceUrl ? `\x1b[90m← ${sourceUrl.slice(0, 70)}\x1b[0m` : "\x1b[90m(증거 없음)\x1b[0m";
          console.log(`         ${symbol} ${productLabel} × "${rowCriterion}" ${src}`);
          if (usedSnippet) {
            console.log(`            \x1b[90m📄 "${usedSnippet}"\x1b[0m`);
          }
          sourceLog.push(`  ${value} ${productLabel} × ${rowCriterion}${sourceUrl ? ` (${sourceUrl})` : ""}`);
        })
      );
      console.log(`\x1b[33m[STEP 4] 완료 (${Date.now() - s4}ms)\x1b[0m`);
      } // end STEP 3-4 block

      // ── STEP 5: WSM (Weighted Sum Model) 기반 최종 순위 결정 ───────────────
      // 표가 완전히 채워진 후, 사용자 기준 중요도를 가중치로 삼아 순위 결정
      {
        // 기준명 → 가중치 파싱 (decisionCriteria: "접이식 여부 (입력: ...) [중요]" 형태)
        function parseCriterionWeight(str: string): { name: string; weight: number } {
          const bracket = str.match(/\[(중요|보통|낮음|high|medium|low)\]/i);
          const raw = bracket?.[1]?.toLowerCase() ?? "보통";
          const weight = raw === "중요" || raw === "high" ? 0.5
            : raw === "낮음" || raw === "low" ? 0.2
            : 0.3;
          const name = str.replace(/\s*\([^)]*\)/g, "").replace(/\s*\[.*?\]/g, "").trim();
          return { name, weight };
        }

        function findWeight(rowLabel: string, criteriaList: string[]): number {
          const rowLower = rowLabel.toLowerCase();
          for (const c of criteriaList) {
            const { name, weight } = parseCriterionWeight(c);
            const nameLower = name.toLowerCase();
            if (nameLower.includes(rowLower) || rowLower.includes(nameLower)) return weight;
            // 단어 단위 부분 매칭
            const words = nameLower.split(/\s+/).filter(w => w.length >= 2);
            if (words.some(w => rowLower.includes(w))) return weight;
          }
          return 0.3; // 매칭 안 되면 기본 [보통]
        }

        function scoreCellValue(val: string): number {
          if (!val || val === "-") return 0.5;  // 미확인 → 중립
          if (val === "○") return 1.0;           // 기능 있음
          if (val === "X") return 0.0;           // 기능 없음
          return 0.7;                            // 수치/텍스트값 → 중립 이상
        }

        const finalRows = tableJson.props?.rows ?? [];
        const rankRow = finalRows.find(r => r["criterion"] === "순위" || r["criterion"] === "Rank");
        const productCols2 = (tableJson.props?.columns ?? []).filter(c => c.key !== "criterion");

        if (rankRow && productCols2.length > 0) {
          const wsmScores: Record<string, number> = {};

          for (const col of productCols2) {
            let wsmSum = 0;
            let totalWeight = 0;
            for (const row of finalRows) {
              const criterion = row["criterion"] ?? "";
              if (!criterion || criterion === "순위" || criterion === "Rank") continue;
              const w = findWeight(criterion, decisionCriteria);
              const s = scoreCellValue(String(row[col.key] ?? "-"));
              wsmSum += s * w;
              totalWeight += w;
            }
            wsmScores[col.key] = totalWeight > 0 ? wsmSum / totalWeight : 0;
          }

          const sorted = Object.entries(wsmScores).sort((a, b) => b[1] - a[1]);
          sorted.forEach(([key], idx) => { rankRow[key] = `${idx + 1}위`; });

          console.log(`\x1b[32m\n[STEP 5] WSM 순위 결정 (중요도 가중합):`);
          sorted.forEach(([key], idx) => {
            const col = productCols2.find(c => c.key === key);
            const cLabel = col?.label ?? key;
            console.log(`         ${idx + 1}위: ${cLabel} (WSM: ${wsmScores[key].toFixed(3)})`);
          });
          // 각 기준의 가중치 출력
          const dataRows2 = finalRows.filter(r => r["criterion"] && r["criterion"] !== "순위" && r["criterion"] !== "Rank");
          console.log(`         [가중치 상세]`);
          dataRows2.forEach(row => {
            const criterion = row["criterion"] ?? "";
            const w = findWeight(criterion, decisionCriteria);
            const wLabel = w === 0.5 ? "중요" : w === 0.2 ? "낮음" : "보통";
            console.log(`           "${criterion}" → w=${w} [${wLabel}]`);
          });
          console.log(`\x1b[0m`);

          // _rankReasoning: 1위 제품 기준으로 Claude Haiku가 생성
          const winner = productCols2[sorted.findIndex(([k]) => k === sorted[0][0])];
          const winnerLabel = productCols2.find(c => c.key === sorted[0][0])?.label ?? "";
          const criteriaStr = decisionCriteria.map(c => parseCriterionWeight(c).name).join(", ");
          const lang = currentLocale === "en" ? "English" : "Korean";
          try {
            const { text: reasoning } = await generateText({
              model: anthropic("claude-haiku-4-5"),
              system: `You are a friendly shopping advisor. Explain in 2-3 sentences why the winning product is recommended, referencing only the user's criteria. Never mention scores, weights, or formulas. Write in ${lang}.`,
              prompt: `Winning product: ${winnerLabel}\nUser criteria (in priority order): ${criteriaStr}\nWrite a warm, conversational explanation for a first-time buyer.`,
              temperature: 0.3,
            });
            // _rankReasoning 업데이트
            if (tableJson.props) (tableJson.props as any)._rankReasoning = reasoning.trim();
          } catch { /* reasoning 생성 실패 시 기존 값 유지 */ }
        }
      }

      console.log(`\n\x1b[32m━━ 파이프라인 완료 (총 ${Date.now() - t0}ms) ━━\x1b[0m\n`);
      return JSON.stringify(tableJson);
    }







    // 나머지 카테고리: Claude 유지
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