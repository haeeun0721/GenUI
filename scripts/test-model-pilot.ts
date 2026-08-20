/**
 * scripts/test-model-pilot.ts
 * baseline 통일 모델 후보 비교: Claude Haiku 4.5 vs GPT-4o를
 * 실제 프로덕션 프롬프트(도메인 지식형: CriteriaMap, TradeoffHint / 데이터 그라운딩형: ComparisonTable 순위)로
 * 나란히 돌려서 품질/속도를 눈으로 비교한다.
 *
 * 실행: npx tsx --env-file=.env.local scripts/test-model-pilot.ts
 */
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { buildCriteriaMapSystem, buildCriteriaMapPrompt } from "../lib/backend/agents/generators/criteria_map";

const MODELS = {
  claude: anthropic("claude-haiku-4-5"),
  gpt4o: openai("gpt-4o"),
} as const;

const timings: { test: string; model: string; ms: number; ok: boolean }[] = [];

async function runBoth(label: string, system: string, prompt: string) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`TEST: ${label}`);
  console.log("=".repeat(70));

  for (const [name, model] of Object.entries(MODELS)) {
    const t0 = Date.now();
    try {
      const { text } = await generateText({ model, system, prompt, temperature: 0 });
      const ms = Date.now() - t0;
      timings.push({ test: label, model: name, ms, ok: true });
      console.log(`\n--- [${name}] (${ms}ms) ---`);
      console.log(text.trim());
    } catch (err) {
      const ms = Date.now() - t0;
      timings.push({ test: label, model: name, ms, ok: false });
      console.log(`\n--- [${name}] FAILED (${ms}ms) ---`);
      console.log(err);
    }
  }
}

// ---------------------------------------------------------------------------
// TEST 1 — CriteriaMap (도메인 지식형: 답변 + chip 추출 + 스키마 구조화를 한번에)
// ---------------------------------------------------------------------------
async function test1() {
  const system = buildCriteriaMapSystem("ko");
  const prompt = buildCriteriaMapPrompt(
    "로봇청소기 살 때 뭘 봐야 해?",
    "반려동물(강아지)을 키우고 있고 카펫이 깔린 집이라 털 청소가 제일 걱정돼요.",
    ""
  );
  await runBoth("CriteriaMap (도메인 지식형)", system, prompt);
}

// ---------------------------------------------------------------------------
// TEST 2 — TradeoffHint (도메인 지식형: 실제 구매자들이 겪는 trade-off 추론)
// buildSystem이 tradeoff_hint.ts에서 export 안 되어 있어서, 프로덕션 프롬프트를
// 그대로 인라인 복사 (2026-08-20 기준 lib/backend/agents/generators/tradeoff_hint.ts와 동일해야 함)
// ---------------------------------------------------------------------------
async function test2() {
  const system = `
[Component]
TradeoffHint

[Role]
You are a product-category expert who identifies well-known, real trade-offs that buyers commonly face when purchasing in a specific product category. You only surface trade-offs that real buyers actually discuss in reviews/forums/guides — never a guessed or invented tension.

[Input]
- new_criterion: The criterion just added by the user.
- existing_criteria: Criteria the user has already saved.
- product_category: The product category being evaluated.

[Task]
1. Compare new_criterion against each item in existing_criteria, one pair at a time.
2. A pair (new_criterion, one item from existing_criteria) qualifies as a match ONLY if ALL of the following are true:
   - It's a trade-off buyers of THIS category repeatedly discuss.
   - A first-time buyer of this category would genuinely feel this tension.
   - You can name the specific thing the buyer gives up — not just "hard to combine."
   - The conflict is not purely about price ("more features cost more").
   - You are confident this is real, not a guess.
   If ANY of these fails, treat the pair as no match. When unsure, default to no match.
3. Collect all pairs that pass.
4. If multiple pairs pass, keep only the single most impactful one.
5. If no pairs pass, output Empty — do not force a weak or speculative match.

[Output]
- newCriterion: exact name of new_criterion, WITHOUT the "(중요)"/"(important)" importance marker
  even if new_criterion carries one in the input — that marker is for your own reference only
  (a plain user-facing card is not the place to repeat it), never part of the displayed name.
- conflictsWith: verbatim copy from existing_criteria (no paraphrasing), same rule — strip any
  trailing "(중요)"/"(important)" marker before outputting the name.
- why: one sentence naming the specific sacrifice the buyer faces. 실제로 이 트레이드오프를 겪어본 사람이 친구에게 말하듯, 자연스러운 한국어 문장 하나로 쓰세요. 기계적으로 항목을 나열하지 말고, [existing_criteria]에서 구체적으로 잃는 것과 그로 인한 체감 결과가 매끄럽게 한 문장에 녹아들게 하세요. 참고할 어투 예시: "먼지통 용량이 커질수록 흡입력은 세지지만 배터리 소모도 그만큼 늘어나요." "불편할 수 있음", "어려울 수 있음" 같은 추상적 표현 대신 실제로 벌어지는 구체적 결과를 명시하세요. Max 60자. '요'로 종결. 자연스러운 구어체로. Must be immediately relatable to a real buyer of this category. No markdown, no **, no *.

If a genuine, well-known trade-off exists:
{
  "type": "TradeoffHint",
  "props": {
    "newCriterion": "<exact name of new_criterion>",
    "conflictsWith": "<verbatim copy from existing_criteria>",
    "why": "<one natural, conversational sentence covering what's lost and the concrete consequence, max 60 chars, '요'로 종결>"
  }
}

If not:
{ "type": "Empty", "props": {} }
`.trim();

  const prompt = `NEW_CRITERION: 먼지통 용량 (기준: 400ml 이상)
EXISTING_CRITERIA:
- 배터리 지속시간 (기준: 180분 이상)
- 저소음 (기준: 60dB 이하)
PRODUCT_CATEGORY: 로봇청소기

Generate the JSON.`;

  await runBoth("TradeoffHint (도메인 지식형)", system, prompt);
}

// ---------------------------------------------------------------------------
// TEST 3 — ComparisonTable 순위 (데이터 그라운딩형: 실제 스펙 테이블 기반 판단)
// comp_table.ts의 computeRankingAndReasoning 시스템 프롬프트를 그대로 인라인 복사,
// mock 테이블로 테스트 (원본은 gpt-4o 고정 — gpt-4o-mini는 _rankReasoning을 조용히
// 누락시킨 전례가 있다는 주석이 있음, 그 자리에 Claude가 들어가도 괜찮을지 확인)
// ---------------------------------------------------------------------------
async function test3() {
  const system = `
[Component]
ComparisonTable — Ranking

[Role]
You are a shopping advisor who ranks products for THIS SPECIFIC USER's purchase situation and outputs the complete, updated comparison table — using exclusively the data already resolved in the input table, never external knowledge or invented specs.

[Input]
- user_context: the user's stated purchase situation and purpose.
- decision_criteria: the criteria the user cares about.
- reference_table: a human-readable version of the table, annotated with any user-specified minimum requirements — for judgment only.
  Where a numeric requirement could be checked, each value is ALSO tagged "[기준 충족]"/"[기준 미달]" —
  this tag is a pre-computed, authoritative verdict. NEVER recompute or second-guess it by comparing the raw
  numbers yourself (numbers that look similar, e.g. "2,500" vs "25,000", are easy to misread) — always defer
  to the tag when present.
- comparison_table: the full Table JSON ({ type, props: { columns, rows } }) already resolved and verified. The "순위"/"Rank" row's cells are placeholders ("-") for you to fill in.

[Task]
1. Copy \`columns\` and every row EXCEPT the "순위"/"Rank" row EXACTLY as given in comparison_table — do not
   alter, reformat, add, or remove any key or value.
2. For the "순위"/"Rank" row only: decide each product's rank label using ONLY the criterion values shown
   in the other rows. Never invent, guess, or add information not explicitly shown in the table; ignore
   any cell marked "미확인" or "-" rather than inferring what it might mean.
3. Sufficiency-based evaluation — for EVERY criterion, judge whether each value is "enough" for the
   user's context and purpose, not which value is numerically higher.
4. If products are genuinely too close to call overall, give them the same tied label.
5. Every product column key in the "순위"/"Rank" row must receive a label — none left as "-".
6. Do NOT use markdown formatting (no **, *, #, _) in _rankReasoning — plain text only.
7. _rankReasoning must connect the recommendation to THIS user's stated user_context — name the concrete
   situation/purpose and explain why the winning spec(s) matter for it.

[Output]
{
  "type": "Table",
  "props": {
    "columns": <copied EXACTLY from comparison_table.props.columns>,
    "rows": <copied EXACTLY from comparison_table.props.rows, with the "순위"/"Rank" row's product values filled in>,
    "_rankReasoning": "<2-3 plain-text Korean sentences explaining why the top-ranked product(s) fit best>"
  }
}`.trim();

  const prompt = `user_context: 반려동물(강아지)이 있어서 털/먼지 흡입력이 중요하고, 매일 자동으로 돌아갔으면 좋겠어요.

decision_criteria: 흡입력 (기준: 2500pa 이상), 배터리 지속시간 (기준: 180분 이상)

products: 로보락 Qrevo Curv, 삼성 비스포크 제트봇 AI

reference_table (for judgment):
  - 흡입력 (사용자가 명시한 기준: 2500pa 이상): 로보락 Qrevo Curv: 18,500Pa [기준 충족] | 삼성 비스포크 제트봇 AI: 280W (환산 불가)
  - 배터리 지속시간 (사용자가 명시한 기준: 180분 이상): 로보락 Qrevo Curv: 180분 [기준 충족] | 삼성 비스포크 제트봇 AI: 90분 [기준 미달]
  - 자동 먼지비움: 로보락 Qrevo Curv: 지원 | 삼성 비스포크 제트봇 AI: 지원
  - 소음: 로보락 Qrevo Curv: 67dB | 삼성 비스포크 제트봇 AI: 62dB

comparison_table:
${JSON.stringify({
  type: "Table",
  props: {
    columns: [
      { key: "criterion", label: "비교 항목" },
      { key: "p1", label: "로보락 Qrevo Curv" },
      { key: "p2", label: "삼성 비스포크 제트봇 AI" },
    ],
    rows: [
      { criterion: "흡입력", p1: "18,500Pa", p2: "280W" },
      { criterion: "배터리 지속시간", p1: "180분", p2: "90분" },
      { criterion: "자동 먼지비움", p1: "지원", p2: "지원" },
      { criterion: "소음", p1: "67dB", p2: "62dB" },
      { criterion: "순위", p1: "-", p2: "-" },
    ],
  },
}, null, 2)}

Output the complete updated table JSON as specified in [Output].`;

  await runBoth("ComparisonTable 순위 (데이터 그라운딩형)", system, prompt);
}

function printTimingSummary() {
  console.log(`\n${"=".repeat(70)}`);
  console.log("SPEED SUMMARY");
  console.log("=".repeat(70));

  const byTest = new Map<string, typeof timings>();
  for (const t of timings) {
    if (!byTest.has(t.test)) byTest.set(t.test, []);
    byTest.get(t.test)!.push(t);
  }

  for (const [test, rows] of byTest) {
    const cells = rows
      .map(r => `${r.model}: ${r.ok ? `${r.ms}ms` : `FAILED(${r.ms}ms)`}`)
      .join("  |  ");
    console.log(`${test.padEnd(40)} ${cells}`);
  }

  const totalsByModel = new Map<string, { sum: number; count: number }>();
  for (const t of timings) {
    if (!t.ok) continue;
    const cur = totalsByModel.get(t.model) ?? { sum: 0, count: 0 };
    cur.sum += t.ms;
    cur.count += 1;
    totalsByModel.set(t.model, cur);
  }
  console.log("-".repeat(70));
  for (const [model, { sum, count }] of totalsByModel) {
    console.log(`${model.padEnd(10)} avg: ${(sum / count).toFixed(0)}ms  (n=${count})`);
  }
}

async function main() {
  await test1();
  await test2();
  await test3();
  printTimingSummary();
  console.log(`\n${"=".repeat(70)}\nDONE\n${"=".repeat(70)}`);
}

main();
