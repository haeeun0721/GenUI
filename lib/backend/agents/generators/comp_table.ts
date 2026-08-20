/**
 * lib/backend/agents/generators/comp_table.ts
 * ComparisonTable (Category 2) — 순위/이유 생성 (표 구조 생성 + 데이터 보강은 data_agent.ts 담당).
 *
 * Responsibility: data_agent.ts가 만들고 채운 완성된 Table JSON을 받아서,
 * 사용자의 구매 상황/목적에 얼마나 부합하는지 순위와 이유를 생성한다.
 *
 * 순위는 스펙 수치의 절대적 우위가 아니라, 사용자가 첫 화면에 적은 구매 상황/목적
 * (currentUserContext) + Decision Criteria 목록을 근거로 LLM이 종합 판단한다.
 *
 * LLM은 다른 generator들과 동일하게 최종 Table JSON({type, props: {columns, rows,
 * _rankReasoning}}) 형태로 응답한다 — 다만 columns/기존 행은 입력 그대로 "복사"만
 * 하도록 지시하고, 실제로 tableJson에 반영할 때도 "순위" 행과 _rankReasoning만
 * LLM 출력에서 가져온다. 나머지 셀은 LLM이 뭐라고 답했든 항상 원본(이미 Tavily로
 * 검증된) 값을 그대로 유지한다 — 검증된 데이터가 재생성 과정에서 틀어지는 걸 막기
 * 위한 안전장치.
 *
 * 표 구조 생성(buildAndAssembleTable)과 빈/근거없는 셀 보강(enrichCompTableCells,
 * Tavily+judgeCell)은 data_agent.ts 담당 — 이 파일은 그 결과(완성된 CompTableJson)를
 * 받아서 순위를 매기는 역할까지만 한다.
 */

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { currentLocale as _currentLocale, currentUserContext as _currentUserContext, currentRequestId } from "../../tools/sidebar-store";
import { buildAndAssembleTable, enrichCompTableCells } from "../data_agent";
import type { CompTableJson } from "../data_agent";
import { time, logElapsed } from "../../timing";

// ---------------------------------------------------------------------------
// 순위 + 분석 코멘트 생성
// 비교표 데이터 + 사용자의 구매 상황/목적을 입력받아, "스펙이 더 좋은가"가 아니라
// "이 사용자 상황에 얼마나 부합하는가"를 LLM이 종합 판단해 순위와 이유를 함께 만든다.
// ---------------------------------------------------------------------------

/** "흡입력 (기준: 5000pa 이상) [중요]" 같은 문자열에서 이름/min만 뽑아낸다. 남아있을 수 있는
 *  구 버전 중요도 브라켓([중요]/[낮음] 등)은 더 이상 쓰지 않으므로 이름에서 제거만 한다. */
function parseCriterionMin(str: string): { name: string; min: string | null } {
  const parenMatch = str.match(/\(기준:\s*([^)]+)\)/);
  const min = parenMatch ? parenMatch[1].trim() : null;
  const name = str.replace(/\s*\([^)]*\)/g, "").replace(/\s*\[.*?\]/g, "").trim();
  return { name, min };
}

function findCriterionMin(rowLabel: string, criteriaList: string[]): string | null {
  const rowLower = rowLabel.toLowerCase();
  for (const c of criteriaList) {
    const { name, min } = parseCriterionMin(c);
    const nameLower = name.toLowerCase();
    if (nameLower.includes(rowLower) || rowLower.includes(nameLower)) return min;
    const words = nameLower.split(/\s+/).filter(w => w.length >= 2);
    if (words.some(w => rowLower.includes(w))) return min;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 임계값 충족 여부 코드 레벨 사전 계산 — "2,500pa 이상" vs "18,500Pa"처럼 숫자
// 비교가 필요한 판단을 LLM에게 맡기면, 표에 함께 있는 다른 값(예: "25,000Pa")과
// 자릿수가 비슷한 숫자를 착각하거나 규칙(3번)을 놓치는 경우가 실제로 관찰됐다.
// 방향(이상/이하/초과/미만)과 단위가 명확히 파싱되는 행에 한해 [기준 충족]/[기준 미달]을
// 코드로 확정해 reference_table에 미리 박아두면, LLM은 그 판정을 "읽기"만 하면 된다 —
// 단위가 다르거나(예: mAh vs 시간) 숫자를 못 뽑으면 조용히 건너뛰어 안전하게 기권한다.
// ---------------------------------------------------------------------------

type ThresholdDir = "gte" | "lte" | "gt" | "lt";

function parseThreshold(min: string): { value: number; dir: ThresholdDir; unit: string } | null {
  const dirMatch = min.match(/(이상|이하|초과|미만)/);
  const numMatch = min.match(/([\d,]+(?:\.\d+)?)/);
  if (!dirMatch || !numMatch) return null;
  const dir: ThresholdDir =
    dirMatch[1] === "이상" ? "gte" : dirMatch[1] === "이하" ? "lte" : dirMatch[1] === "초과" ? "gt" : "lt";
  const value = parseFloat(numMatch[1].replace(/,/g, ""));
  if (isNaN(value)) return null;
  const afterNum = min.slice(min.indexOf(numMatch[1]) + numMatch[1].length);
  const unit = (afterNum.match(/^[a-zA-Z%]+/)?.[0] ?? "").toLowerCase();
  return { value, dir, unit };
}

/** expectedUnit이 있으면 셀 값의 단위와 일치할 때만 숫자를 반환 — 단위가 다르면(mAh vs 시간 등) null로 비교 자체를 포기. */
function parseValueForUnit(cellValue: string, expectedUnit: string): number | null {
  const numMatch = cellValue.match(/([\d,]+(?:\.\d+)?)/);
  if (!numMatch) return null;
  const value = parseFloat(numMatch[1].replace(/,/g, ""));
  if (isNaN(value)) return null;
  if (!expectedUnit) return value;
  const afterNum = cellValue.slice(cellValue.indexOf(numMatch[1]) + numMatch[1].length);
  const unit = (afterNum.match(/^[a-zA-Z%]+/)?.[0] ?? "").toLowerCase();
  return unit === expectedUnit ? value : null;
}

function meetsThreshold(value: number, dir: ThresholdDir, threshold: number): boolean {
  switch (dir) {
    case "gte": return value >= threshold;
    case "lte": return value <= threshold;
    case "gt": return value > threshold;
    case "lt": return value < threshold;
  }
}

/** 텍스트에서 첫 균형 잡힌 {...} 블록만 뽑아 JSON.parse. 실패 시 null. */
function extractJsonObject(text: string): any | null {
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return null;
  let stack = 0;
  for (let i = firstBrace; i < text.length; i++) {
    if (text[i] === "{") stack++;
    if (text[i] === "}") stack--;
    if (stack === 0) {
      try { return JSON.parse(text.slice(firstBrace, i + 1)); } catch { return null; }
    }
  }
  return null;
}

export async function computeRankingAndReasoning(
  tableJson: CompTableJson,
  decisionCriteria: string[],
  locale: string
): Promise<{ reasoning: string }> {
  const finalRows = tableJson.props?.rows ?? [];
  const hasRankRow = finalRows.some(r => r["criterion"] === "순위" || r["criterion"] === "Rank");
  const productCols = (tableJson.props?.columns ?? []).filter(c => c.key !== "criterion");

  if (!hasRankRow || productCols.length === 0) return { reasoning: "" };

  const lang = locale === "en" ? "English" : "Korean";
  const dataRows = finalRows.filter(r => r["criterion"] && r["criterion"] !== "순위" && r["criterion"] !== "Rank");

  // 제품이 하나뿐이면 판단할 게 없다 — LLM 호출 없이 바로 1위 처리.
  if (productCols.length === 1) {
    const label = locale === "en" ? "#1" : "1위";
    tableJson.props!.rows = finalRows.map(r =>
      (r["criterion"] === "순위" || r["criterion"] === "Rank") ? { ...r, [productCols[0].key]: label } : r
    );
    return { reasoning: "" };
  }

  const fullTableLines = dataRows.map(row => {
    const criterion = row["criterion"] ?? "";
    const min = findCriterionMin(criterion, decisionCriteria);
    const minNote = min ? ` (사용자가 명시한 기준: ${min})` : "";
    const threshold = min ? parseThreshold(min) : null;
    const vals = productCols.map(col => {
      const val = String((row as Record<string, string>)[col.key] ?? "-");
      let verdict = "";
      if (threshold && val !== "-" && val !== "미확인") {
        const v = parseValueForUnit(val, threshold.unit);
        if (v != null) verdict = meetsThreshold(v, threshold.dir, threshold.value) ? " [기준 충족]" : " [기준 미달]";
      }
      return `${col.label}: ${val}${verdict}`;
    }).join(" | ");
    return `  - ${criterion}${minNote}: ${vals}`;
  }).join("\n");

  const productNames = productCols.map(c => c.label);
  const userContext = _currentUserContext?.trim() || "(not specified)";
  const criteriaNames = decisionCriteria.map(c => parseCriterionMin(c).name).filter(Boolean).join(", ") || "(none specified)";

  console.log(`\x1b[32m\n[STEP 5] 순위 판단 (구매 상황/목적 기반):`);
  console.log(`         user_context: ${userContext}`);

  try {
    // 제품 열 키↔라벨 매핑 — LLM이 rank 오브젝트를 그 키로 채우도록.
    const productKeyLines = productCols.map(c => `- ${c.key}: ${c.label}`).join("\n");

    const { text } = await generateText({
      // gpt-4o-mini로 실측 테스트해봤더니 순위 라벨은 정상 반환했지만 _rankReasoning
      // 필드가 3/3 재현으로 빈 문자열이었다(스키마상 "필수"가 아니라 프롬프트 지시일
      // 뿐이라 mini가 조용히 누락시킴 — 별도 예외/에러 없이 통과되어 발견이 늦어짐).
      // 사용자에게 "왜 이 순위인지" 설명이 아예 안 보이게 되는 실질적 품질 저하라 되돌림.
      model: anthropic("claude-haiku-4-5"),
      system: `
[Component]
ComparisonTable — Ranking

[Role]
You are a shopping advisor who ranks products for THIS SPECIFIC USER's purchase situation — using exclusively
the data already resolved in reference_table, never external knowledge or invented specs.

[Input]
- user_context: the user's stated purchase situation and purpose.
- decision_criteria: the criteria the user cares about.
- product_keys: the stable key for each product column — use these exact keys in your output, never the labels.
- reference_table: a human-readable version of the table, annotated with any user-specified minimum requirements —
  for judgment only. Where a numeric requirement could be checked, each value is ALSO tagged "[기준 충족]"/
  "[기준 미달]" — this tag is a pre-computed, authoritative verdict. NEVER recompute or second-guess it by
  comparing the raw numbers yourself (numbers that look similar, e.g. "2,500" vs "25,000", are easy to misread) —
  always defer to the tag when present.

[Task]
1. Decide each product's rank label using ONLY the criterion values shown in reference_table. Never invent,
   guess, or add information not explicitly shown; ignore any cell marked "미확인" or "-" rather than
   inferring what it might mean. Do NOT output anything except the [Output] JSON below — no table copy needed.

2. Sufficiency-based evaluation — for EVERY criterion, judge whether each value is "enough" for the
   user's context and purpose, not which value is numerically higher:
   a. Infer what level would be "enough" given user_context and decision_criteria. If reference_table
      notes a user-specified minimum for this criterion, that minimum IS the "enough" level — and a
      product below it is a serious, near-disqualifying drawback (unless every product fails it). If the
      value is tagged "[기준 충족]"/"[기준 미달]", that tag already tells you which side of the line it's
      on — use it as-is instead of comparing the numbers yourself.
   b. Products meeting or exceeding the "enough" level are EQUALLY satisfying on that criterion — do not
      rank one higher just because its number is bigger once both are already sufficient.
   c. Only products falling below "enough" should be differentiated, and only by how much the shortfall
      matters to the user's situation — not by the raw number gap.

3. If products are genuinely too close to call overall, give them the same tied label (e.g. "공동 1위"/
   "Tied #1") — do not force an artificial ordering.

4. Incommensurable specs — if a criterion's values across products are expressed in different units,
   measurement bases, or attribute types (e.g. a number vs. a qualitative description, or two metrics
   that aren't measuring the same thing) such that they cannot be directly compared, do NOT judge one
   product as better than another on that criterion. Describe each product's characteristic on it
   independently and neutrally, and do NOT use that criterion as grounds for ranking one product over
   another in _rankReasoning.

5. Every key in product_keys must receive a label in "rank" — none left out or "-".

6. Do NOT use markdown formatting (no **, *, #, _) in _rankReasoning — plain text only.

7. _rankReasoning must connect the recommendation to THIS user's stated user_context — not just restate
   spec comparisons in the abstract. Name the concrete situation/purpose from user_context and explain why
   the winning spec(s) matter for it (e.g. instead of "흡입력이 충분합니다", say something like "반려동물
   털 청소가 우선이라고 하셨는데, 두 제품 모두 그 정도 흡입력이면 충분합니다"). If user_context is
   "(not specified)", fall back to referencing decision_criteria instead.

[Output]
Respond with ONLY this JSON object — no table, no extra fields:
{
  "rank": { "<product_key>": "<rank label, e.g. '1위' or '공동 1위'>", ... one entry per product_key ... },
  "_rankReasoning": "<2-3 plain-text ${lang} sentences explaining why the top-ranked product(s) fit best>"
}`,
      prompt: `user_context: ${userContext}

decision_criteria: ${criteriaNames}

product_keys:
${productKeyLines}

reference_table (for judgment):
${fullTableLines}

Output the rank + reasoning JSON as specified in [Output].`,
      temperature: 0.3,
    });

    const parsed = extractJsonObject(text);
    const rankObj = parsed?.rank && typeof parsed.rank === "object" ? parsed.rank as Record<string, unknown> : null;
    if (!parsed || !rankObj) throw new Error("LLM 응답에서 유효한 순위 결과를 찾지 못함");

    // 순위 라벨 추출 + 누락 제품 안전장치 (표시 누락 방지)
    const rankUpdates: Record<string, string> = {};
    for (const col of productCols) {
      const val = rankObj[col.key];
      const clean = (val != null && String(val).trim() && val !== "-") ? String(val).trim() : "";
      if (clean) rankUpdates[col.key] = clean;
    }
    const missingCols = productCols.filter(col => !rankUpdates[col.key]);
    if (missingCols.length > 0) {
      console.warn(`\x1b[33m[CompTable STEP 5] ⚠️ 순위 누락 제품 ${missingCols.length}개 → 맨 뒤로 배치\x1b[0m`);
      let fallbackRank = productCols.length - missingCols.length + 1;
      for (const col of missingCols) {
        rankUpdates[col.key] = locale === "en" ? `#${fallbackRank}` : `${fallbackRank}위`;
        fallbackRank += 1;
      }
    }

    // "순위" 행만 갱신 — 그 외 행/열은 원본(data_agent.ts가 검증한) 값을 그대로 유지.
    tableJson.props!.rows = finalRows.map(row => {
      if (row["criterion"] !== "순위" && row["criterion"] !== "Rank") return row;
      return { ...row, ...rankUpdates };
    });

    const rawReasoning = String(parsed._rankReasoning ?? "");
    const cleanReasoning = rawReasoning.trim()
      .replace(/\*\*/g, "").replace(/\*/g, "").replace(/^#+\s*/gm, "").replace(/_/g, "");
    return { reasoning: cleanReasoning };
  } catch (err) {
    console.error("[CompTable STEP 5] 순위 판단 실패:", err);
    return { reasoning: "" };
  }
}

// ---------------------------------------------------------------------------
// ComparisonTable Pipeline Orchestrator
//
// STEP 1: buildAndAssembleTable()   — 코드로 구조 생성 + DB 값 즉시 주입 (LLM 없음, ~0ms) — data_agent.ts
// STEP 2: enrichCompTableCells()    — DB 미커버 셀 → Tavily+judgeCell 판단 — data_agent.ts
// STEP 3: computeRankingAndReasoning() — 순위 + 이유 (~1s) — 이 파일
// ---------------------------------------------------------------------------

export async function orchestrateCompTablePipeline(
  uiContext: string,
  decisionCriteria: string[],
  savedItems: string[],
  currentRows: string[] = []
): Promise<string> {
  const locale = _currentLocale;

  const t0 = Date.now();
  console.log("\n\x1b[35m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");
  console.log("\x1b[35m [CompTable Pipeline Start] (코드 구조 생성 + Tavily + 순위)\x1b[0m");
  console.log("\x1b[35m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n");

  const reqId = currentRequestId ?? "";

  // ── STEP 1: 코드로 구조 생성 + DB 값 즉시 주입 (LLM 없음) ───────────────
  console.log("\x1b[33m[STEP 1] 코드로 테이블 구조 생성 + DB 값 즉시 주입...\x1b[0m");
  const step1Start = Date.now();
  const { tableJson, fullNameMap } = buildAndAssembleTable(uiContext, decisionCriteria, locale);
  logElapsed("comp_table.build_structure", reqId, step1Start);

  // ── STEP 2: DB 미커버 셀 → data_agent.ts(Tavily+judgeCell) 판단 ─────────
  await time("comp_table.enrich_cells", reqId, () =>
    enrichCompTableCells(tableJson, uiContext, locale, fullNameMap)
  );

  // ── STEP 3: 순위 결정 + 이유 생성 ────────────────────────────────────
  {
    const { reasoning } = await time("comp_table.ranking_llm", reqId, () =>
      computeRankingAndReasoning(tableJson, decisionCriteria, locale)
    );
    if (tableJson.props && reasoning) {
      (tableJson.props as any)._rankReasoning = reasoning;
    }
  }

  console.log(`\n\x1b[32m━━ Pipeline complete (${Date.now() - t0}ms) ━━\x1b[0m\n`);
  return JSON.stringify(tableJson);
}
