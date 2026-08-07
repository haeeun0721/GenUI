/**
 * lib/backend/agents/generators/comp_table.ts
 * ComparisonTable (Category 2) — 표 구조 생성 + 순위/이유 생성.
 *
 * Responsibility: 주어진 제품 데이터(DB 값은 즉시, 웹 검색이 필요한 값은
 * data_agent.ts가 판단해 넘겨준 결과)로 Table JSON 구조를 만들고, 완성된 표를
 * 바탕으로 사용자의 구매 상황/목적에 얼마나 부합하는지 순위와 이유를 생성한다.
 *
 * 순위는 스펙 수치의 절대적 우위가 아니라, 사용자가 첫 화면에 적은 구매 상황/목적
 * (currentUserContext) + Decision Criteria 목록을 근거로 LLM이 종합 판단한다.
 *
 * "Tavily에서 받아온 데이터 중 어떤 값을 쓸지 판단"하는 역할(judgeCell, Sanity
 * Check 등)은 data_agent.ts 담당 — 이 파일은 data_agent.ts가 내려준 값을 받아서
 * 표 구조를 만들고 채우고, 순위를 매기는 역할까지만 한다.
 */

import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { currentLocale as _currentLocale, currentUserContext as _currentUserContext } from "../../tools/sidebar-store";
import {
  tavilySearch,
  judgeCell,
  detectCriterionType,
  extractKeywordWindow,
  parseSpecEntry,
  toDisplayValue,
} from "../data_agent";
import type { TavilyResult } from "../data_agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CompTableJson = {
  type?: string;
  props?: {
    columns?: Array<{ key: string; label: string; imageUrl?: string }>;
    rows?: Array<Record<string, string>>;
    _rankReasoning?: string;
  };
  [k: string]: unknown;
};

// ---------------------------------------------------------------------------
// STEP 0: DB 스펙 키 기반 셀 값 사전 결정 (LLM 호출 없음)
// 각 (기준 × 제품) 셀에 대해 다나와 스펙 키를 검색하고 값을 프로그래밍적으로 결정.
// - 스펙 키 매칭 시: 해당 값 복사 (○, 구체적 값, 또는 없음이면 "X")
// - 미매칭 시: "-" → data_agent.ts의 Tavily 판단이 이후 보강
// ---------------------------------------------------------------------------

/** [중요], [보통], [낮음] 및 괄호 주석 제거 */
function cleanLabel(c: string): string {
  return c.replace(/\s*\[.*?\]/g, "").replace(/\s*\(.*?\)/g, "").trim();
}

/** 기준 레이블에 맞는 스펙 항목을 찾아 셀 값 반환. 없으면 "-". */
function lookupCellValue(label: string, specs: string[]): string {
  const labelLower = label.toLowerCase().replace(/\s+/g, "");
  const keywords   = label.toLowerCase().split(/\s+/).filter(w => w.length >= 2);

  // 1순위: 스펙 키 정규화 후 완전 포함 매칭
  for (const spec of specs) {
    const { key, rawValue } = parseSpecEntry(spec);
    const keyLower = key.toLowerCase().replace(/\s+/g, "");
    if (keyLower === labelLower || keyLower.includes(labelLower) || labelLower.includes(keyLower)) {
      return toDisplayValue(rawValue, label);
    }
  }

  // 2순위: 키워드 하나라도 스펙 키에 포함
  for (const spec of specs) {
    const { key, rawValue } = parseSpecEntry(spec);
    const keyLower = key.toLowerCase().replace(/\s+/g, "");
    if (keywords.some(kw => keyLower.includes(kw) || kw.includes(keyLower))) {
      return toDisplayValue(rawValue, label);
    }
  }

  // 3순위: 스펙 값(value)에 기준명이 정확히 포함
  // e.g., 기준 "DSLR" → 스펙 "디카 분류: DSLR" → value "DSLR" 매칭 → "○" 반환
  for (const spec of specs) {
    const { rawValue } = parseSpecEntry(spec);
    const valueLower = rawValue.toLowerCase().replace(/\s+/g, "");
    if (valueLower === labelLower ||
        (labelLower.length >= 3 && valueLower === labelLower)) {
      return "○"; // 해당 스펙 값이 기준명과 일치 → 제품이 해당 카테고리임을 확인
    }
  }

  return "-";
}

// ---------------------------------------------------------------------------
// 표 분석 헬퍼 — 미확인 셀 / 근거 없는 셀 탐지 (enrichCompTableCells 전용)
// ---------------------------------------------------------------------------

function findMissingCells(tableJson: CompTableJson) {
  const columns = tableJson.props?.columns ?? [];
  const rows = tableJson.props?.rows ?? [];
  const productCols = columns.filter(c => c.key !== "criterion");
  const missing: Array<{ rowCriterion: string; colKey: string; productLabel: string }> = [];
  for (const row of rows) {
    const criterion = row["criterion"] ?? "";
    if (!criterion || criterion === "순위" || criterion === "Rank") continue;
    for (const col of productCols) {
      if (!row[col.key] || row[col.key] === "-")
        missing.push({ rowCriterion: criterion, colKey: col.key, productLabel: col.label });
    }
  }
  return missing;
}

function parseProductSpecsFromContext(uiContext: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const blocks = uiContext.split(/\[Product \d+\]/);
  for (const block of blocks) {
    const nameMatch = block.match(/Name:\s*(.+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    const specsMatch = block.match(/Specs:\s*(.+)/);
    const descMatch = block.match(/Description:\s*(.+)/);
    const specs = (specsMatch?.[1] ?? "").split("/").map(s => s.trim()).filter(Boolean);
    if (descMatch?.[1]) specs.push(descMatch[1].trim());
    map.set(name, specs);
  }
  return map;
}

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

function isCriterionGrounded(criterion: string, specs: string[]): boolean {
  if (specs.length === 0) return false;
  const specText = specs.join(" ").toLowerCase();
  const keywords = criterion.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  return keywords.some(kw => specText.includes(kw));
}

function findUngroundedCells(tableJson: CompTableJson, uiContext: string) {
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
      if (!isCriterionGrounded(criterion, specs))
        ungrounded.push({ rowCriterion: criterion, colKey: col.key, productLabel: col.label, originalValue: val });
    }
  }
  return ungrounded;
}

// ---------------------------------------------------------------------------
// 비교표 스펙 보강 (표에 뚫린 구멍을 data_agent.ts의 판단으로 채움)
// ---------------------------------------------------------------------------

/**
 * 비교표 셀을 채운다. 값 판단(Tavily 검색 + judgeCell 검증)은 data_agent.ts가
 * 하고, 이 함수는 어떤 셀이 비어있는지 찾아 그 판단 결과를 표에 반영하는 역할만 한다.
 */
export async function enrichCompTableCells(
  tableJson: CompTableJson,
  uiContext: string,
  locale: string,
  prebuiltFullNameMap?: Map<string, string>
): Promise<void> {
  const columns = tableJson.props?.columns ?? [];
  const productCols = columns.filter(c => c.key !== "criterion");
  const allRows = tableJson.props?.rows ?? [];

  // shortLabel → 전체 제품명 매핑
  // prebuiltFullNameMap이 있으면 buildAndAssembleTable()에서 이미 정확히 만들었으므로 그대로 사용.
  // 없으면 uiContext 파싱으로 복원 (하위 호환성 유지).
  const fullNameMap = prebuiltFullNameMap ?? (() => {
    const map = new Map<string, string>();
    const nameMatches = [...uiContext.matchAll(/Name:\s*(.+)/g)].map(m => m[1].trim());
    for (const col of productCols) {
      const labelWords = col.label.split(/\s+/).filter(w => w.length >= 2);
      if (labelWords.length === 0) continue;
      const candidates = nameMatches.filter(name => {
        const nameLower = name.toLowerCase();
        return labelWords.every(w => nameLower.includes(w.toLowerCase()));
      });
      if (candidates.length === 0) continue;
      const matched = candidates.reduce((best, curr) => curr.length < best.length ? curr : best);
      map.set(col.label, matched);
      const note = candidates.length > 1 ? ` (후보 ${candidates.length}개 중 최단 선택)` : "";
      console.log(`\x1b[90m[CompTable] 제품명 매핑: "${col.label}" → "${matched}"${note}\x1b[0m`);
    }
    return map;
  })();

  // ── Pre-enrich 스니펫 캐시 ─────────────────────────────────────────────
  // enrichContextWithTavily가 uiContext에 주입한 WebSpecs를 파싱해
  // 동일 스펙을 Tavily에서 재검색하는 낭비를 방지한다.
  // Format: "WebSpecs (from web search): criterion: snippet | criterion2: snippet2"
  type PreEnrichedCell = { rowCriterion: string; colKey: string; productLabel: string; snippets: TavilyResult[] };
  const preEnrichedCells: PreEnrichedCell[] = [];

  const preEnrichCache = new Map<string, string>();  // `productLabel||criterion` → snippet
  {
    const blockRe = /Name:\s*(.+?)[\s\S]*?WebSpecs \(from web search\):\s*([^\n]+)/g;
    let bm;
    while ((bm = blockRe.exec(uiContext)) !== null) {
      const productName = bm[1].trim();
      const webLine = bm[2].trim();
      // label 역조회
      let label = productName;
      for (const [l, n] of fullNameMap) { if (n === productName) { label = l; break; } }
      for (const item of webLine.split(" | ")) {
        const idx = item.indexOf(": ");
        if (idx === -1) continue;
        preEnrichCache.set(`${label}||${item.slice(0, idx).trim()}`, item.slice(idx + 2).trim());
      }
    }
    if (preEnrichCache.size > 0)
      console.log(`\x1b[36m[CompTable] Pre-enrich 캐시: ${preEnrichCache.size}개 항목 로드\x1b[0m`);
  }

  function getPreEnrichedSnippets(label: string, rowCriterion: string): TavilyResult[] | null {
    const cleanRow = rowCriterion.replace(/\s*[\[\(].*?[\]\)]/g, "").trim().toLowerCase();
    for (const [key, snippet] of preEnrichCache) {
      const [cachedLabel, cachedCrit] = key.split("||");
      if (cachedLabel !== label) continue;
      const cleanCrit = cachedCrit.replace(/\s*[\[\(].*?[\]\)]/g, "").trim().toLowerCase();
      if (cleanRow.includes(cleanCrit) || cleanCrit.includes(cleanRow))
        return [{ title: "Pre-enriched", url: "pre-enrich", content: snippet, score: 1.0 }];
    }
    return null;
  }

  // STEP 1.5: 행 단위 타입 결정
  const rowTypeMap = new Map<string, "boolean" | "value">();
  for (const row of allRows) {
    const criterion = row["criterion"] ?? "";
    if (!criterion || criterion === "순위" || criterion === "Rank") continue;
    let rowType = detectCriterionType(criterion);
    for (const col of productCols) {
      const val = String((row as Record<string, string>)[col.key] ?? "");
      if (val && val !== "-" && val !== "○" && val !== "X") { rowType = "value"; break; }
    }
    rowTypeMap.set(criterion, rowType);
  }
  console.log("\x1b[33m[CompTable STEP 1.5] 행 유형 결정:\x1b[0m");
  for (const [crit, type] of rowTypeMap)
    console.log(`         "${crit}" → ${type}`);

  // STEP 2: 미확인 셀 + 근거 없는 셀 탐지
  console.log("\n\x1b[33m[CompTable STEP 2] 1차 표 분석:\x1b[0m");
  const missingCells = findMissingCells(tableJson);
  const ungroundedCells = findUngroundedCells(tableJson, uiContext);
  const ungroundedKeys = new Set(ungroundedCells.map(c => `${c.colKey}__${c.rowCriterion}`));

  for (const row of allRows) {
    const criterion = row["criterion"] ?? "";
    if (!criterion) continue;
    const cells = productCols.map(col => {
      const val = row[col.key];
      const missing = !val || val === "-";
      const isUngrounded = ungroundedKeys.has(`${col.key}__${criterion}`);
      const symbol = missing ? "\x1b[31m?\x1b[0m" : isUngrounded ? `\x1b[33m⚠${val}\x1b[0m` : `\x1b[32m${val}\x1b[0m`;
      return `${col.label.slice(0, 8)}: ${symbol}`;
    }).join("  |  ");
    console.log(`         ${criterion.padEnd(15)} │ ${cells}`);
  }

  const verifyKeySet = new Set<string>();
  const allCellsToVerify: Array<{ rowCriterion: string; colKey: string; productLabel: string }> = [];
  const addToVerify = (cell: { rowCriterion: string; colKey: string; productLabel: string }) => {
    const k = `${cell.colKey}__${cell.rowCriterion}`;
    if (!verifyKeySet.has(k)) { verifyKeySet.add(k); allCellsToVerify.push(cell); }
  };
  missingCells.forEach(addToVerify);
  ungroundedCells.map(c => ({ rowCriterion: c.rowCriterion, colKey: c.colKey, productLabel: c.productLabel })).forEach(addToVerify);

  // "value" 유형 행에서 ○만 있는 셀도 구체값으로 교체 시도
  for (const row of allRows) {
    const criterion = row["criterion"] ?? "";
    if (!criterion || criterion === "순위" || criterion === "Rank") continue;
    if (rowTypeMap.get(criterion) !== "value") continue;
    for (const col of productCols) {
      if (String((row as Record<string, string>)[col.key] ?? "") === "○")
        addToVerify({ rowCriterion: criterion, colKey: col.key, productLabel: col.label });
    }
  }

  if (allCellsToVerify.length === 0) {
    console.log("\x1b[32m[CompTable STEP 2] 모든 셀 확인됨 → 웹 검색 생략\x1b[0m\n");
    return;
  }

  if (missingCells.length > 0) {
    console.log(`\n\x1b[33m[CompTable STEP 2] 미확인 셀 ${missingCells.length}개:\x1b[0m`);
    missingCells.forEach(c => console.log(`         • ${c.productLabel} × "${c.rowCriterion}"`));
  }
  if (ungroundedCells.length > 0) {
    console.log(`\n\x1b[33m[CompTable STEP 2] 근거 불명 셀 ${ungroundedCells.length}개:\x1b[0m`);
    ungroundedCells.forEach(c => console.log(`         • ${c.productLabel} × "${c.rowCriterion}" ("${c.originalValue}" → 스펙 근거 없음)`));
  }
  console.log(`\n\x1b[33m[CompTable STEP 2] 총 ${allCellsToVerify.length}개 셀 웹 검색 대상\x1b[0m`);

  // STEP 3: 정적 유의어 사전으로 synonymMap 구성 (LLM 호출 없음)
  // spec-lookup.ts의 STATIC_SYNONYMS와 동일한 패턴을 인라인 적용
  const STATIC_SYNONYMS_LOCAL: Record<string, string[]> = {
    "소음":       ["소음 수준", "noise level", "작동음", "데시벨"],
    "소음 수준":  ["소음 dB", "noise", "작동음", "데시벨"],
    "흡입력":     ["흡입 파워", "파스칼", "suction power", "Pa"],
    "배터리":     ["배터리 용량", "battery", "mAh", "충전 용량"],
    "배터리 수명":["사용 시간", "작동 시간", "연속 사용", "최대 사용시간"],
    "배터리용량": ["mAh", "배터리 크기", "battery capacity"],
    "무게":       ["중량", "weight", "본체 무게"],
    "충전시간":   ["충전 소요", "charge time", "완충"],
    "사용시간":   ["배터리 지속", "runtime", "최대 사용"],
    "물탱크":     ["물탱크 용량", "water tank", "탱크 용량"],
    "먼지통":     ["집진통", "더스트빈", "dustbin", "집진 용량"],
    "화소":       ["해상도", "megapixel", "MP"],
    "손떨림보정": ["OIS", "이미지 안정화", "image stabilization"],
    "방수":       ["생활방수", "IPX", "방진"],
  };

  function getStaticSynonymsLocal(criterion: string): string[] {
    const clean = criterion.replace(/\s*\[[^\]]*\]/g, "").replace(/\s*\([^)]*\)/g, "").trim().toLowerCase();
    for (const [key, syns] of Object.entries(STATIC_SYNONYMS_LOCAL)) {
      if (clean.includes(key.toLowerCase()) || key.toLowerCase().includes(clean)) return syns;
    }
    return [];
  }

  const uniqueCriteria = [...new Set(allCellsToVerify.map(c => c.rowCriterion))];
  const synonymMap: Record<string, string[]> = {};
  for (const c of uniqueCriteria) {
    synonymMap[c] = getStaticSynonymsLocal(c);
  }
  console.log(`\x1b[33m[CompTable STEP 3-A] 정적 유의어 사전 적용 (LLM 없음):${uniqueCriteria.map(c => `\n         "${c}" → [${synonymMap[c].join(", ")}]`).join("")}\x1b[0m`);

  // Tavily 검색 전 Pre-enrich 존재 여부 확인
  const rows = tableJson.props?.rows ?? [];
  const needsTavily = allCellsToVerify.filter(({ rowCriterion, colKey, productLabel }) => {
    // Pre-enrich 히트 (enrichContextWithTavily에서 이미 가져온 스니펫)
    const preSnippets = getPreEnrichedSnippets(productLabel, rowCriterion);
    if (preSnippets) {
      preEnrichedCells.push({ rowCriterion, colKey, productLabel, snippets: preSnippets });
      console.log(`\x1b[36m[Pre-enrich HIT] "${productLabel}" × "${rowCriterion}" → Tavily 생략\x1b[0m`);
      return false;
    }

    return true;
  });

  if (needsTavily.length === 0) {
    console.log("\x1b[32m[CompTable STEP 3-B] 모든 셀 Pre-enrich로 확인 → Tavily 생략\x1b[0m");
  } else {
    console.log(`\n\x1b[33m[CompTable STEP 3-B] Tavily 병렬 검색 (${needsTavily.length}개)...\x1b[0m`);
    const s3b = Date.now();
    const searchResultMap = new Map<string, TavilyResult[]>();
    await Promise.all(
      needsTavily.map(async ({ rowCriterion, productLabel }) => {
        const key = `${productLabel}__${rowCriterion}`;
        if (searchResultMap.has(key)) return;
        // 1차부터 유의어 + 사양표 키워드를 포함한 스마트 쿼리로 advanced 검색
        // (STEP 4.5/4.7 재검색이 불필요해질 만큼 충분히 강한 쿼리를 처음부터 사용)
        const cleanedCriterion = rowCriterion.replace(/\s*\[[^\]]*\]/g, "").replace(/\s*\([^)]*\)/g, "").trim();
        const synonyms = synonymMap[rowCriterion] ?? [];
        const terms = [cleanedCriterion, ...synonyms.slice(0, 2), "제원 사양표"].join(" ");
        const fullName = fullNameMap.get(productLabel) ?? productLabel;
        const results = await tavilySearch(`${fullName} ${terms}`, "advanced");
        searchResultMap.set(key, results);
        // ── Tavily 원본 결과 상세 로그 ──────────────────────────────────
        console.log(`         🔍 "${fullName} × ${cleanedCriterion}" → ${results.length}개 결과`);
        results.forEach((r, idx) => {
          console.log(`            [${idx + 1}] score=${r.score?.toFixed(2) ?? '?'} | ${r.url}`);
          console.log(`                 ${r.content.replace(/\s+/g, ' ').slice(0, 150)}...`);
        });
      })
    );
    console.log(`\x1b[33m[CompTable STEP 3-B] 완료 (${Date.now() - s3b}ms)\x1b[0m`);

    // STEP 3.5: Pre-enrich 캐시 셀 직접 판단 (Tavily 재검색 없음)
    if (preEnrichedCells.length > 0) {
      console.log(`\n\x1b[36m[CompTable STEP 3.5] Pre-enrich 셀 ${preEnrichedCells.length}개 직접 판단 (Tavily 생략)...\x1b[0m`);
      await Promise.all(
        preEnrichedCells.map(async ({ rowCriterion, colKey, productLabel, snippets }) => {
          const { value } = await judgeCell(
            productLabel, rowCriterion, snippets, locale,
            rowTypeMap.get(rowCriterion) ?? detectCriterionType(rowCriterion),
            synonymMap[rowCriterion] ?? []
          );
          const targetRow = rows.find(r => r["criterion"] === rowCriterion);
          if (targetRow && value !== "-") {
            (targetRow as Record<string, string>)[colKey] = value;
            console.log(`   \x1b[36m✅ Pre-enrich "${productLabel}" × "${rowCriterion}" → "${value}"\x1b[0m`);
          }
        })
      );
    }

    // STEP 4: 셀 값 판단 + 업데이트
    console.log(`\n\x1b[33m[CompTable STEP 4] judgeCell로 셀 값 판단...\x1b[0m`);
    const s4 = Date.now();
    await Promise.all(
      needsTavily.map(async ({ rowCriterion, colKey, productLabel }) => {
        const snippets = searchResultMap.get(`${productLabel}__${rowCriterion}`) ?? [];
        // judgeCell에 실제로 넘어가는 키워드 창(300자)을 미리 표시
        if (snippets.length > 0) {
          const kws = [rowCriterion, ...(synonymMap[rowCriterion] ?? []), productLabel];
          console.log(`\n         \x1b[90m[judgeCell 입력] "${productLabel}" × "${rowCriterion}"\x1b[0m`);
          snippets.slice(0, 3).forEach((r, idx) => {
            const window = extractKeywordWindow(r.content, kws, 300);
            console.log(`            [${idx + 1}] ${r.url}`);
            console.log(`                 ${window.replace(/\s+/g, ' ').slice(0, 200)}`);
          });
        }
        const { value, sourceUrl, usedSnippet } = await judgeCell(
          productLabel, rowCriterion, snippets, locale,
          rowTypeMap.get(rowCriterion) ?? detectCriterionType(rowCriterion),
          synonymMap[rowCriterion] ?? []
        );
        const targetRow = rows.find(r => r["criterion"] === rowCriterion);
        if (targetRow) targetRow[colKey] = value;
        const symbol = value === "○" ? "\x1b[32m○\x1b[0m" : value === "X" ? "\x1b[31mX\x1b[0m" : "\x1b[90m-\x1b[0m";
        console.log(`         ${symbol} ${productLabel} × "${rowCriterion}"${sourceUrl ? ` ← ${sourceUrl.slice(0, 60)}` : " (증거 없음)"}`);
        if (usedSnippet) console.log(`            \x1b[90m📄 "${usedSnippet}"\x1b[0m`);
      })
    );
    console.log(`\x1b[33m[CompTable STEP 4] 완료 (${Date.now() - s4}ms)\x1b[0m`);
  }
}

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

const rankingSchema = z.object({
  ranking: z
    .array(z.array(z.string()))
    .describe(
      "Products ordered from best fit (index 0) to worst fit for the user's situation. " +
      "Each inner array is a tie group — put 2+ product names together only when they're genuinely " +
      "too close to call. Every product name passed in `products` must appear exactly once, total."
    ),
  reasoning: z.string().describe("2-3 plain-text sentences explaining why the top product(s) fit best."),
});

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
    const vals = productCols.map(col => {
      const val = String((row as Record<string, string>)[col.key] ?? "-");
      return `${col.label}: ${val}`;
    }).join(" | ");
    return `  - ${criterion}${minNote}: ${vals}`;
  }).join("\n");

  const productNames = productCols.map(c => c.label);
  const userContext = _currentUserContext?.trim() || "(not specified)";
  const criteriaNames = decisionCriteria.map(c => parseCriterionMin(c).name).filter(Boolean).join(", ") || "(none specified)";

  console.log(`\x1b[32m\n[STEP 5] 순위 판단 (구매 상황/목적 기반):`);
  console.log(`         user_context: ${userContext}`);

  try {
    const { object } = await generateObject({
      model: openai("gpt-4o"),
      schema: rankingSchema,
      system: `You are a shopping advisor. Rank the given products for THIS SPECIFIC USER's purchase situation, then explain why, using EXCLUSIVELY the data in the comparison table.

ABSOLUTE RULES:
1. Base the ranking ONLY on the criterion values shown in the table. Do NOT invent, guess, or add ANY information not explicitly shown in the table cells.
2. A criterion being numerically higher (or lower) is NOT automatically "better" — judge whether each value is actually good enough / relevant for the user's stated situation and purpose. A modest spec that comfortably covers the user's need should not be penalized just for being smaller than an excessive spec the user doesn't need.
3. If a criterion row has a user-specified requirement noted next to it (e.g. "사용자가 명시한 기준: ..."), treat a product that fails to meet it as a serious drawback — near-disqualifying — unless every product fails it.
4. If a cell says "미확인" or "-", ignore that criterion for that product — do NOT infer what it might mean.
5. If products are genuinely too close to call on the overall picture, group them as tied in the same inner array — do NOT force an artificial ordering.
6. Do NOT use markdown formatting (no **, *, #, _) in the reasoning. Plain text only.
7. Write the reasoning as 2-3 sentences in ${lang}.
8. Every product in "products" must appear exactly once across the ranking groups.`,
      prompt: `User's purchase situation and purpose: ${userContext}

Decision criteria the user cares about: ${criteriaNames}

Products to rank: ${productNames.join(", ")}

Comparison table (use ONLY these values):
${fullTableLines}

Rank the products from best to worst fit for this user's situation, and explain why the top-ranked product(s) fit best.`,
      temperature: 0.3,
    });

    // LLM이 정한 순서(및 동점 그룹)를 "순위" 행 라벨("N위"/"공동 N위")로 바꿔 써넣는다.
    // 이름 매칭은 정확히 일치하지 않을 수 있어 label 포함관계로 한 번 더 시도한다.
    const labelToKey = new Map(productCols.map(c => [c.label, c.key]));
    const rankUpdates: Record<string, string> = {};
    let rank = 1;
    for (const group of object.ranking) {
      const rankLabel = locale === "en"
        ? (group.length > 1 ? `Tied #${rank}` : `#${rank}`)
        : (group.length > 1 ? `공동 ${rank}위` : `${rank}위`);
      for (const productName of group) {
        const key = labelToKey.get(productName)
          ?? productCols.find(c => c.label.includes(productName) || productName.includes(c.label))?.key;
        if (key) rankUpdates[key] = rankLabel;
      }
      rank += group.length;
    }
    // LLM이 빠뜨린 제품이 있으면 맨 뒤로 밀어 넣는다 (표시 누락 방지 안전장치).
    for (const col of productCols) {
      if (!(col.key in rankUpdates)) {
        rankUpdates[col.key] = locale === "en" ? `#${rank}` : `${rank}위`;
        rank += 1;
      }
    }

    tableJson.props!.rows = finalRows.map(row => {
      if (row["criterion"] !== "순위" && row["criterion"] !== "Rank") return row;
      return { ...row, ...rankUpdates };
    });

    const cleanReasoning = object.reasoning.trim()
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
// STEP 1: buildAndAssembleTable()   — 코드로 구조 생성 + DB 값 즉시 주입 (LLM 없음, ~0ms)
// STEP 2: enrichCompTableCells()    — DB 미커버 셀 → data_agent.ts(Tavily+judgeCell) 판단
// STEP 3: computeRankingAndReasoning() — WSM 순위 + 이유 (~1s)
// ---------------------------------------------------------------------------

/**
 * 제품명을 열 헤더 표시용으로 정리한다 (접미사 제거만, 잘라내지 않음).
 * 검색(Tavily)에는 사용하지 않음 — 검색은 항상 uiContext의 전체 이름을 사용.
 */
function shortenProductName(name: string): string {
  const SUFFIX_STRIP = /\s*(직배수|직충전|업그레이드|에디션|한정판|특별판|리미티드|스페셜)\s*$/g;
  return name.replace(SUFFIX_STRIP, "").trim();
}

/**
 * uiContext를 파싱해서 CompTable JSON을 코드로 생성하고
 * DB에서 확인 가능한 셀 값을 즉시 주입한다.
 *
 * @returns { tableJson, fullNameMap }
 *   tableJson  — 완성된 구조 + DB 채워진 셀 (미확인 셀은 "-")
 *   fullNameMap — short label → full name 매핑 (enrichCompTableCells에서 재사용)
 */
function buildAndAssembleTable(
  uiContext: string,
  decisionCriteria: string[],
  locale: string
): { tableJson: CompTableJson; fullNameMap: Map<string, string> } {
  // 1. [Product N] 블록 파싱 —————————————————————————————————————————————
  const blocks = uiContext.split(/\[Product \d+\]/).filter(b => b.trim());
  const products = blocks.map((block, idx) => {
    const name     = block.match(/Name:\s*(.+)/)?.[1].trim() ?? `Product ${idx + 1}`;
    const imageUrl = block.match(/Image:\s*(\S+)/)?.[1]?.trim() ?? "";
    const specs    = block.match(/Specs:\s*(.+)/)?.[1]?.split(" / ").map(s => s.trim()).filter(Boolean) ?? [];
    return { key: `prod_${idx}`, name, imageUrl, specs };
  });

  // 2. short label → full name 매핑 (검색용) ——————————————————————————————
  const fullNameMap = new Map<string, string>();
  products.forEach(p => {
    const label = shortenProductName(p.name);
    fullNameMap.set(label, p.name);
    console.log(`\x1b[90m[Build] 제품명 매핑: "${label}" → "${p.name}"\x1b[0m`);
  });

  // 3. columns 구성 ————————————————————————————————————————————————————————
  const columns = [
    { key: "criterion", label: locale === "ko" ? "비교 항목" : "Criteria" },
    ...products.map(p => ({
      key:      p.key,
      label:    shortenProductName(p.name),
      imageUrl: p.imageUrl,
    })),
  ];

  // 4. rows 구성 — 순위 행 + criteria 행 (DB 값 즉시 주입) ——————————————————
  const prodKeys = products.map(p => p.key);
  const emptyRow = Object.fromEntries(prodKeys.map(k => [k, "-"]));

  // 행 id — 컬럼의 "prod_N" key와 같은 목적: 편집(remove_criteria 등)이 라벨 문자열
  // 대신 이 id로 행을 정확히 지목할 수 있게 한다. 라벨은 사람이 읽는 표시용, id는 참조용.
  const rows: Array<Record<string, string>> = [
    // 순위 행 (항상 "-", WSM 계산 후 STEP 3에서 채워짐)
    { id: "rank", criterion: locale === "ko" ? "순위" : "Rank", ...emptyRow },
    // criteria 행
    ...decisionCriteria.map((criterion, i) => {
      const label = cleanLabel(criterion);   // 브라켓/괄호 제거
      const cells = Object.fromEntries(
        products.map(p => [p.key, lookupCellValue(label, p.specs)])
      );
      return { id: `crit_${i}`, criterion: label, ...cells };
    }),
  ];

  // 5. DB 주입 결과 로깅 ——————————————————————————————————————————————————
  console.log(`\x1b[33m[STEP 1] 구조 생성 + DB 값 주입 완료 (${decisionCriteria.length}개 기준 × ${products.length}개 제품):\x1b[0m`);
  rows.filter(r => r.criterion !== "순위" && r.criterion !== "Rank").forEach(r => {
    const vals = prodKeys.map(k => `${k}:${r[k]}`).join(" | ");
    console.log(`         "${r.criterion}" → ${vals}`);
  });

  const tableJson: CompTableJson = {
    type: "Table",
    props: { _rankReasoning: "", columns, rows },
  };

  return { tableJson, fullNameMap };
}

export async function orchestrateCompTablePipeline(
  uiContext: string,
  decisionCriteria: string[],
  savedItems: string[],
  currentRows: string[] = []
): Promise<string> {
  const locale = _currentLocale;

  const t0 = Date.now();
  console.log("\n\x1b[35m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");
  console.log("\x1b[35m [CompTable Pipeline Start] (코드 구조 생성 + Tavily + WSM)\x1b[0m");
  console.log("\x1b[35m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n");

  // ── STEP 1: 코드로 구조 생성 + DB 값 즉시 주입 (LLM 없음) ───────────────
  console.log("\x1b[33m[STEP 1] 코드로 테이블 구조 생성 + DB 값 즉시 주입...\x1b[0m");
  const { tableJson, fullNameMap } = buildAndAssembleTable(uiContext, decisionCriteria, locale);

  // ── STEP 2: DB 미커버 셀 → data_agent.ts(Tavily+judgeCell) 판단 ─────────
  await enrichCompTableCells(tableJson, uiContext, locale, fullNameMap);

  // ── STEP 3: WSM 순위 결정 + 이유 생성 ────────────────────────────────────
  {
    const { reasoning } = await computeRankingAndReasoning(tableJson, decisionCriteria, locale);
    if (tableJson.props && reasoning) {
      (tableJson.props as any)._rankReasoning = reasoning;
    }
  }

  console.log(`\n\x1b[32m━━ Pipeline complete (${Date.now() - t0}ms) ━━\x1b[0m\n`);
  return JSON.stringify(tableJson);
}
