import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { currentProductCategory, currentLocale } from "../tools/sidebar-store";
import { enrichCompTableCells, detectCriterionType, computeRankingAndReasoning, preFillTableCells } from "./data_agent";


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const UI_AGENT_MODEL = "claude-haiku-4-5" as const;

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
- If a criterion describes a product type (e.g., "디럭스 유모차"), output "-" for that row. Do NOT guess.

FILLING CELL VALUES — CRITICAL RULE:
- Output "-" for EVERY data cell, no exceptions.
- The Data Agent will programmatically inject values from the Danawa DB after this step.
- Cells still "-" after DB injection will be filled by Tavily web search.
- Do NOT use your own knowledge to fill any cell. A wrong value is worse than "-".


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
      { "criterion": "<criterion label>", "prod_0": "-", "prod_1": "-" }
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
  const lang = locale === "en" ? "English" : "Korean";
  const whyEnding = locale === "en"
    ? "Max 60 chars. Plain English."
    : "Max 60자. '요'로 종결.";
  const whyPlaceholder = locale === "en"
    ? "<one sentence: what the buyer must sacrifice and why — max 60 chars>"
    : "<구매자가 포기해야 하는 것과 이유 — max 60자, '요'로 종결>";

  return `
## Required JSON Component: TradeoffHint (Category 5)

## PURPOSE
Surface the real decision dilemma the buyer faces when combining two criteria.
Answer: "When trying to maximize both criteria simultaneously, what structural conflict arises?"

## INPUT
- new_criterion: The criterion just added by the user.
- existing_criteria: Criteria the user has already saved.
- product_category: The product category being evaluated.

## TRADE-OFF TAXONOMY — Only 3 valid types

TYPE 1 — PERFORMANCE
  Improving both criteria simultaneously causes one to degrade due to physics or engineering limits.
  Test: "Is there a physical or engineering reason why raising A forces B to decrease?"
  Examples:
    ✓ Suction power ↑ → Noise ↑ (same motor spins faster and louder)
    ✓ Lighter weight ↑ → Battery capacity ↓ (battery is the main weight contributor)
    ✓ Foldable frame ↑ → Total weight ↑ (hinges and locking parts add weight)
    ✓ Screen size ↑ → Portability ↓ (physical dimensions increase)

TYPE 2 — BUDGET
  Within the same price range, spending more on A forces lower quality on B.
  Test: "Within the same budget tier, does investing more in A actually reduce what's available for B?"
  Examples:
    ✓ Premium materials ↑ → Drive performance ↓ (material cost displaces component cost at same price point)
    ✓ Brand premium ↑ → Spec-to-price ratio ↓ (marketing costs are embedded in the unit price)
  Note: "It might get more expensive" does NOT qualify — must be a within-budget trade-off.

TYPE 3 — USE-CASE
  A product optimized for A is structurally disadvantaged in situations requiring B.
  Test: "Is the situation where A excels fundamentally different from the situation where B is needed?"
  Examples:
    ✓ Portability (compact size) ↑ → Large storage capacity ↓ (compact products have physically limited interior space)
    ✓ Outdoor durability ↑ → Indoor convenience ↓ (weatherproofing adds weight and thickness)
    ✓ Professional-grade performance ↑ → Beginner ease-of-use ↓ (more features means more complex controls)

## DISQUALIFIERS — Never output these patterns
  ✗ "Products like that are hard to find" → supply scarcity, not a trade-off
  ✗ "Brands don't usually do that" → market convention, not a causal mechanism
  ✗ "That combination might be expensive" → price prediction, not a structural conflict
  ✗ "Those are generally hard to combine" → correlation without a reason

## SELECTION RULES
1. Compare new_criterion against each item in existing_criteria.
2. For each pair: Can you describe a specific mechanism from TYPE 1, 2, or 3?
   - "Yes" → add to candidates
   - "No" → skip
3. If multiple candidates exist → output only the 1 most decisive trade-off for the buyer's situation.
4. If no candidates exist → output Empty.

## OUTPUT FIELDS
- newCriterion: exact name of new_criterion
- conflictsWith: verbatim copy from existing_criteria (no paraphrasing)
- tradeoffType: "performance" | "budget" | "usecase"
- why: one sentence explaining the real mechanism the buyer will encounter.
  ${whyEnding}
  Forbidden: **, *, markdown, jargon, marketing language.
  Allowed: "because the added hinge parts increase weight", "because internal space is physically reduced"
  Examples:
    ✓ "A higher-suction motor rotates faster, which directly increases operating noise." (performance)
    ✓ "A foldable frame adds hinge components, which raises the total weight." (performance)
    ✓ "Within the same budget, choosing premium materials leaves less for performance components." (budget)
    ✓ "Making the body more compact physically reduces the interior space available for storage." (usecase)

If a genuine trade-off exists:
{
  "type": "TradeoffHint",
  "props": {
    "newCriterion": "<exact name of new_criterion>",
    "conflictsWith": "<verbatim copy from existing_criteria>",
    "tradeoffType": "<performance | budget | usecase>",
    "why": "${whyPlaceholder}"
  }
}

If not:
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

      // ── STEP 0: Data Agent — DB 스펙 키 기반 셀 값 사전 결정 (LLM 호출 없음) ──
      // Claude가 데이터를 "추론"하는 문제를 원천 차단.
      // 이 결과를 프롬프트에 포함 → Claude는 JSON 구조 생성에만 집중.
      console.log("\x1b[33m[STEP 0] Data Agent: DB 스펙 키 기반 셀 값 사전 결정 중...\x1b[0m");
      const preFilledTable = preFillTableCells(decisionCriteria, uiContext);
      const preFilledJson = JSON.stringify(preFilledTable.rows, null, 2);

      // ── STEP 1: 1차 표 생성 (Claude는 구조만, 셀 값은 pre_filled_cells 사용) ──
      console.log("\x1b[33m[STEP 1] Claude로 JSON 구조 생성 (셀 값은 pre_filled_cells 기반)...\x1b[0m");
      const s1 = Date.now();
      const promptWithPreFill = prompt +
        `\n\npre_filled_cells (Data Agent DB 조회 결과 — 이 값을 그대로 사용할 것):` +
        `\n${preFilledJson}`;
      const { text: firstPassText } = await generateText({
        model: anthropic(UI_AGENT_MODEL),
        system,
        prompt: promptWithPreFill,
        temperature: 0,
      });
      console.log(`\x1b[33m[STEP 1] 완료 (${Date.now() - s1}ms)\x1b[0m`);

      // JSON 파싱
      let tableJson: { props?: { columns?: Array<{ key: string; label: string }>; rows?: Array<Record<string, string>> };[k: string]: unknown };
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
          const nameMatch = block.match(/Name:\s*(.+)/);
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


      // ── STEP 1.5: DB 값 주입 ────────────────────────────────────────────────
      // 파이프라인 원칙: ① DB 우선 → ② 웹 검색(Tavily) 순서.
      // Claude(STEP 1)는 구조만 생성, 셀 값은 모두 "-".
      // 이 단계에서 STEP 0이 DB에서 찾은 값을 테이블에 주입.
      // DB에서 못 찾은 셀("-")은 이후 Tavily(STEP 2~4)가 채움.
      console.log("\x1b[33m[STEP 1.5] DB 값 주입 (Danawa 스펙 키 매칭 결과)...\x1b[0m");
      {
        const preFilledMap = new Map<string, Record<string, string>>();
        preFilledTable.rows.forEach(row => preFilledMap.set(row.criterion, row.cells));

        const allRows = (tableJson as any).props?.rows ?? [];
        const productCols = ((tableJson as any).props?.columns ?? []).filter((c: any) => c.key !== "criterion");
        let injected = 0;

        for (const row of allRows) {
          const criterion = row["criterion"] as string;
          if (!criterion || criterion === "순위" || criterion === "Rank") continue;

          const dbCells = preFilledMap.get(criterion);

          for (const col of productCols) {
            if (dbCells && dbCells[col.key] && dbCells[col.key] !== "-") {
              // DB에서 값을 찾음 → 주입
              row[col.key] = dbCells[col.key];
              injected++;
            } else {
              // DB에 없음 → "-" 유지 (Tavily가 채울 예정)
              row[col.key] = "-";
            }
          }
        }
        console.log(`\x1b[33m[STEP 1.5] 완료 — DB 값 ${injected}개 주입, 나머지는 Tavily 대상\x1b[0m`);
      }

      // ── STEP 2 ~ 4.7: Data Agent가 스펙 보강 담당 ────────────────────────────
      // Tavily 검색, 유의어 생성, 셀 판단, 재검색 모두 Data Agent 책임.
      // UI Agent는 JSON 생성(STEP 1)과 순위 결정(STEP 5)에만 집중.
      await enrichCompTableCells(tableJson, uiContext, currentLocale);


      // ── STEP 5: WSM 기반 최종 순위 결정 + 분석 코멘트 생성 ─────────────────
      // Data Agent가 표 데이터를 받아 가중합 순위를 계산하고 _rankReasoning 반환.
      // UI Agent는 결과를 tableJson에 주입하는 역할만 수행.
      {
        const { reasoning } = await computeRankingAndReasoning(
          tableJson,
          decisionCriteria,
          currentLocale
        );
        if (tableJson.props && reasoning) {
          (tableJson.props as any)._rankReasoning = reasoning;
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