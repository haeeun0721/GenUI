/**
 * spec-lookup.ts — 공통 스펙 조회 서비스
 *
 * auto-enrich (Option List) 와 fetch-spec (Comp Table) 양쪽에서 호출.
 * DB 조회 → Tavily 검색(실패 시 스펙표 도메인으로 좁혀 재시도) → extractCellValueLight로
 * 값 추출을 하나의 파이프라인으로 제공.
 */

import * as fs from "fs";
import * as path from "path";
import {
  tavilySearch,
  extractCellValueLight,
  getSiblingExcludeTokens,
  expandFieldKeySynonyms,
  findSpecValueInList,
  lookupKnownSpecValue,
  findExactMatchingProduct,
  detectCriterionType,
  expandCriterionMeta,
  type KnownProductSpecs,
} from "@/lib/backend/agents/data_agent";
import {
  currentOptionListCards,
  currentComparisonTableCells,
  currentParticipantId,
} from "@/lib/backend/tools/sidebar-store";
import { getCachedSpec, setCachedSpec } from "./spec-cache";

// lookupKnownSpecValue/KnownProductSpecs는 data_agent.ts로 옮겨졌다(enrichCompTableCells도
// 필요해져서) — 이 파일을 그대로 import하던 다른 파일들이 깨지지 않도록 여기서 re-export.
export { lookupKnownSpecValue, type KnownProductSpecs };

// ---------------------------------------------------------------------------
// 0. 로컬 DB 직접 조회 — 이름 매칭으로 products-*.json에서 제품 스펙 찾기
// (mutate-surface.ts에 있던 걸 여기로 옮김 — mutate-surface.ts가 이 파일의
// lookupProductSpec을 쓰게 되면서 순환 참조가 생겨서 옮겼다)
// ---------------------------------------------------------------------------

// enrichContextWithTavily/enrichCompTableCells는 제품×기준 조합마다 이 함수를 (병렬로)
// 호출한다 — 캐싱 없이 매번 동기 readFileSync+JSON.parse를 하면 그 시간만큼 Node 이벤트
// 루프가 블로킹되어, 같은 프로세스가 동시에 처리 중인 다른 요청까지 지연시킨다.
// 프로세스 수명 동안 카테고리별로 한 번만 읽어 캐싱한다(rag/search.ts의 loadData와 동일한 패턴).
const dbLookupCache: Record<string, { name: string; specs: string[] }[]> = {};

function loadDbLookupProducts(category: string): { name: string; specs: string[] }[] | null {
  if (dbLookupCache[category]) return dbLookupCache[category];
  const filePath = path.join(process.cwd(), "data", `products-${category}.json`);
  if (!fs.existsSync(filePath)) {
    console.warn(`[DB lookup] 파일 없음: products-${category}.json`);
    return null;
  }
  const products = JSON.parse(fs.readFileSync(filePath, "utf8")) as { name: string; specs: string[] }[];
  dbLookupCache[category] = products;
  return products;
}

export function findProductSpecInDB(
  productName: string,
  fieldKey: string,
  category: string,
  criterionType?: "value" | "boolean"
): string | null {
  try {
    const products = loadDbLookupProducts(category);
    if (!products) return null;
    const matched = findExactMatchingProduct(productName, products);
    if (!matched) {
      console.log(`[DB lookup] ❌ "${productName}" — DB에 제품 없음 (또는 이름이 겹치는 동명이인 후보가 여럿이라 확신 불가)`);
      return null;
    }
    // 매핑된 DB 제품명이 검색어와 다르면 명시
    const nameMatched = matched.name === productName ? "" : ` (DB명: "${matched.name}")`;
    const displayValue = findSpecValueInList(matched.specs, fieldKey, criterionType);
    if (displayValue != null) {
      console.log(`[DB lookup] ✅ "${productName}"${nameMatched} (key="${fieldKey}") → "${displayValue}"`);
      return displayValue;
    }
    // 스펙 없음 — DB에 있는 스펙 키 목록 일부 출력
    const specKeys = matched.specs.slice(0, 8).map(s => s.split(/[:\s]/)[0]).join(", ");
    const synonyms = expandFieldKeySynonyms(fieldKey);
    console.log(`[DB lookup] ⚠️  "${productName}"${nameMatched} — [${synonyms.join(", ")}] 스펙 없음 | DB 보유 스펙(최대8): ${specKeys}`);
    return null;
  } catch (err) {
    console.warn(`[DB lookup] 오류:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpecLookupResult {
  value: string;            // 찾은 값 (없으면 "-")
  source: "db" | "tavily" | "none" | "screen";
  sourceUrl?: string;
  usedSnippet?: string;
  uncertain?: boolean;      // 시도 간 값 충돌 → 수동 검수 권장
  validationWarnings?: string[];
}

// ---------------------------------------------------------------------------
// 1. (통합됨) 유의어·단위 정규화·수치 범위 검증은 judgeCell(LLM) 프롬프트로 통합.
// 별도 STATIC_SYNONYMS / SPEC_RANGES / normalizeUnitValue 함수 불필요.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3. 제품명 단순화 (마케팅 수식어만 제거, 모델 구분자 보존)
// ---------------------------------------------------------------------------

const MARKETING_SUFFIXES = /\s*(플러스|에디션|리미티드|스페셜)\s*/gi;

export function simplifyProductName(name: string): string {
  return name.replace(MARKETING_SUFFIXES, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 3-1. 스펙 문구 생성 — lookupProductSpec의 bare value(예: "36,000Pa", "○")를
// Option List 카드 칩에 바로 붙일 수 있는 완성된 문구(예: "흡입력: 36,000Pa")로 변환.
// auto-enrich(카드 일괄 보강)와 mutate-surface(개별 필드 조회) 양쪽이 공유한다.
// ---------------------------------------------------------------------------

/** Tavily/LLM이 반환하는 마케팅 수식어를 앞뒤에서 제거하고 핵심 값만 남긴다. */
const MARKETING_PREFIX = /^(?:최고\s*성능\s*|최고\s*사양\s*|최강\s*|업계\s*(?:최고|최강|최대)\s*|강력한\s*|탁월한\s*|우수한\s*|놀라운\s*|압도적인\s*|혁신적인\s*|뛰어난\s*)/;
const MARKETING_SUFFIX = /\s*(?:급\s*)?(?:강력한\s*)?(?:흡입력|성능|기능|처리\s*속도|의\s*힘)$/;

function cleanSpecValue(raw: string): string {
  // 레이블 있는 값("배터리용량: 6400mAh")은 건드리지 않음
  if (raw.includes(":")) return raw;
  const cleaned = raw.replace(MARKETING_PREFIX, "").replace(MARKETING_SUFFIX, "").trim();
  return cleaned || raw; // 모두 지워진 경우 원본 반환
}

/**
 * extractCellValueLight는 CompTable의 넓은 셀 기준으로 최대 5개 항목까지 허용하는데,
 * Option List 카드는 칩 하나에 들어가는 좁은 공간이라 그 정도로도 카드 전체를 뒤덮는다.
 * 카드에 붙일 문구를 만들 때만 한 번 더 짧게 줄인다 — CompTable로 넘어가는 원본 value는
 * 그대로 두고 이 함수의 리턴값(카드 칩 문구)에만 적용된다.
 */
function capForCard(value: string, maxItems = 2): string {
  const parts = value.split(/\s*[,/]\s*/).filter(Boolean);
  if (parts.length <= maxItems) return value;
  return parts.slice(0, maxItems).join(", ") + " 등";
}

export function buildSpecPhrase(fieldKey: string, value: string): string {
  const v = cleanSpecValue(value); // 마케팅 수식어 제거
  // 이미 "[기준]: 값" 형태면 기준명 중복 방지를 위해 그대로 둔다
  if (v.includes(":")) return v;
  if (v === "○") {
    if (/연동|호환|연결/.test(fieldKey)) return `${fieldKey}: 가능`;
    if (/방식|타입|type/.test(fieldKey)) return `${fieldKey}: 적용`;
    return `${fieldKey}: 지원`;
  }
  if (v === "X") {
    if (/연동|호환|연결/.test(fieldKey)) return `${fieldKey}: 불가`;
    return `${fieldKey}: 지원 안함`;
  }
  // value 타입 — 숫자든 텍스트/목록이든 항상 "[기준]: 값" 형식으로 통일
  return `${fieldKey}: ${capForCard(v)}`;
}

// ---------------------------------------------------------------------------
// 4. 핵심 공개 함수: lookupProductSpec
// ---------------------------------------------------------------------------

/**
 * 제품 × 스펙 필드에 대한 값을 조회한다.
 * 우선순위: 로컬 DB → Tavily 검색(advanced, answer 합성 포함) → extractCellValueLight LLM 호출.
 * 1차 시도가 비어있으면(검색 결과 0건, 또는 답변에 그 필드 언급이 없음) 필드키를 동의어로
 * 바꾼 쿼리로 딱 1번만 재시도한다 — test-tavily-lightweight.ts 실험과 동일하게 셀 하나당
 * 네트워크 호출을 최대 Tavily 2번 + LLM 2번으로 고정한다(성공 시엔 그보다 적게 끝난다).
 *
 * extractCellValueLight는 judgeCell(Extractive QA + Evidence Verification +
 * SiblingGuard + Sanity Check의 다단계 검증)을 대체한 경량 버전으로, Tavily가 합성한
 * answer 텍스트 하나를 보고 LLM에게 한 번만 값을 물어본다 — siblingTokens는 프롬프트
 * 경고 문구로만 전달되고, judgeCell처럼 거리 기반으로 코드가 재검증하지는 않는다.
 */

type TavilyJudge = { value: string; sourceUrl?: string; usedSnippet?: string; uncertain?: boolean };

/** Tavily 검색 1번 + extractCellValueLight 1번을 한 세트로 묶은 단일 시도. 값을 못 찾으면 null. */
async function attemptTavilyLookup(
  productName: string,
  fieldKey: string,
  query: string,
  locale: string,
  siblingTokens: string[],
  formatHint?: string,
  canonicalUnit?: string | null,
  preferredCondition?: string | null,
  criterionType?: "value" | "boolean"
): Promise<TavilyJudge | null> {
  const res = await tavilySearch(query, "advanced", {
    maxResults: 20, chunksPerSource: 5, includeAnswer: "advanced",
  });
  const tavilyAnswer = res.answer;

  if (tavilyAnswer) console.log(`💡 [Tavily Answer] "${productName} × ${fieldKey}" (query="${query}")\n   ${tavilyAnswer.slice(0, 200)}`);

  const answerSegment = tavilyAnswer
    ? [{ url: res.results[0]?.url ?? "https://tavily.com", content: tavilyAnswer, score: 999, title: "Tavily Answer" }]
    : [];
  const resultsWithAnswer = [...answerSegment, ...res.results];
  if (resultsWithAnswer.length === 0) return null;

  const c = await extractCellValueLight(productName, fieldKey, resultsWithAnswer, locale, siblingTokens, formatHint, canonicalUnit, preferredCondition, criterionType ?? detectCriterionType(fieldKey));
  return c.value !== "-" ? c : null;
}

/**
 * 재시도용 쿼리 재구성. q1("제품명 + 필드키" 단순 concat)이 실제 웹 페이지 표기와
 * 문구가 달라서 놓쳤을 가능성을 노리고, (1) 필드키를 동의어로 바꾸고 (2) "스펙" 키워드를
 * 덧붙여 스펙 정보 페이지 쪽으로 검색을 살짝 민다.
 */
function buildRetryQuery(productName: string, fieldKey: string): string {
  const altField = expandFieldKeySynonyms(fieldKey).find(s => s !== fieldKey) ?? fieldKey;
  return `${productName} ${altField} 스펙`;
}

export async function lookupProductSpec(
  productName: string,
  fieldKey: string,
  category: string,
  locale: string = "ko",
  formatHint?: string,
  canonicalUnit?: string | null,
  preferredCondition?: string | null,
  criterionType?: "value" | "boolean"
): Promise<SpecLookupResult> {

  // Step 1: 로컬 DB
  const dbSpec = findProductSpecInDB(productName, fieldKey, category, criterionType);
  if (dbSpec && dbSpec !== "-") {
    return { value: dbSpec, source: "db" };
  }

  // Step 2: Tavily 검색 → extractCellValueLight (1차)
  // preferredCondition이 있으면(제품마다 다른 조건/모드로 보고되는 기준) 쿼리 자체에
  // 그 조건을 덧붙여, 애초에 그 조건을 다루는 페이지가 검색 결과 상위에 오도록 유도한다 —
  // 그래야 제품마다 서로 다른 조건의 값을 랜덤하게 주워오는 대신 같은 조건으로 맞춰진다.
  const siblingTokens = getSiblingExcludeTokens(productName, category);
  const q1 = preferredCondition ? `${productName} ${fieldKey} ${preferredCondition}` : `${productName} ${fieldKey}`;
  let judge = await attemptTavilyLookup(productName, fieldKey, q1, locale, siblingTokens, formatHint, canonicalUnit, preferredCondition, criterionType);

  // Step 3: 1차가 비어있으면(검색 0건 또는 답변에 필드 언급 없음) 재구성 쿼리로 1회만 재시도
  if (!judge) {
    const q2base = buildRetryQuery(productName, fieldKey);
    const q2 = preferredCondition ? `${q2base} ${preferredCondition}` : q2base;
    console.log(`🔁 [Tavily Retry] "${productName} × ${fieldKey}" → 1차 실패, 재구성 쿼리로 재시도: "${q2}"`);
    judge = await attemptTavilyLookup(productName, fieldKey, q2, locale, siblingTokens, formatHint, canonicalUnit, preferredCondition, criterionType);
  }

  if (!judge) {
    console.log(`❌ [extractCellValueLight] "${productName} × ${fieldKey}" → 값 없음(재시도 포함)`);
    return { value: "-", source: "none" };
  }
  console.log(`${judge.uncertain ? "⚠️ " : "✅"} [extractCellValueLight] "${productName} × ${fieldKey}" → ${judge.value}${judge.uncertain ? " (추정)" : ""}`);

  const finalResult: SpecLookupResult = {
    value: judge.value,
    source: "tavily",
    sourceUrl: judge.sourceUrl,
    usedSnippet: judge.usedSnippet,
    uncertain: judge.uncertain === true,
  };
  return finalResult;
}

/**
 * lookupProductSpec의 앞단에 "화면에 이미 떠 있는 값" 확인을 끼워넣은 래퍼 — 같은
 * 제품×기준을 Option List와 Comparison Table이 각자 독립적으로 실시간 검색해 값이
 * 갈리는 문제(예: Canon EOS 5D Mark III 초점거리가 한쪽엔 "-", 다른 쪽엔 "0.3m")를
 * 막는다. currentOptionListCards/currentComparisonTableCells는 매 요청 시작 시
 * 프론트가 보낸 이번 요청의 화면 상태로 덮어써지는 request-scoped 값(영속 캐시 아님) —
 * app/api/generate/route.ts가 모든 채팅 턴마다 새로 세팅한다. mutate-surface.ts/
 * mutate-comptable.ts처럼 채팅 도구 실행 중(=/api/generate 요청 안)에 개별 셀을
 * 조회하는 모든 경로는 lookupProductSpec을 직접 부르지 말고 이 함수를 써야 한다.
 */
export async function resolveSpecValue(
  productName: string,
  fieldKey: string,
  category: string,
  locale: string = "ko",
  formatHint?: string,
  canonicalUnit?: string | null,
  preferredCondition?: string | null,
  criterionType?: "value" | "boolean"
): Promise<SpecLookupResult> {
  const known =
    lookupKnownSpecValue(productName, fieldKey, currentOptionListCards, criterionType) ??
    lookupKnownSpecValue(productName, fieldKey, currentComparisonTableCells, criterionType);
  if (known) {
    console.log(`🔗 [resolveSpecValue] "${productName}" × "${fieldKey}" → "${known}" (source=screen, 재검색 생략)`);
    return { value: known, source: "screen" };
  }

  // 화면에 없어도, 이 참가자가 이전 턴/다른 패널에서 이미 같은 제품×기준을 조회해
  // 캐시에 남아있으면 그 값을 재사용한다 — Option List/Comparison Table이 서로 다른
  // 시점에 독립적으로 검색해 값이 갈리는 걸 화면 상태와 무관하게 막는다.
  const cached = await getCachedSpec(currentParticipantId, productName, fieldKey);
  if (cached) return { value: cached, source: "screen" };

  const result = await lookupProductSpec(productName, fieldKey, category, locale, formatHint, canonicalUnit, preferredCondition, criterionType);
  if (result.value !== "-" && !result.uncertain) {
    await setCachedSpec(currentParticipantId, productName, fieldKey, result.value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 5. 컨텍스트 사전 보강 (ComparisonTable 최초 생성용)
//
// data_agent.ts에 있던 enrichContextWithTavily를 여기로 옮기고, 검증 없이 스니펫을
// 그대로 꽂아넣던 tavilySearchSnippet 대신 lookupProductSpec(DB→Tavily 검색+
// judgeCell 검증+SiblingGuard)을 쓰도록 다시 짰다 — 표 최초 생성 경로가 다른 모든
// 경로와 다르게 검증을 거치지 않는 가장 약한 고리였기 때문. data_agent.ts에 그대로
// 두면 spec-lookup.ts(이 파일, data_agent.ts를 import함)와 순환 참조가 생겨서 옮겼다.
//
// 출력 텍스트 포맷("WebSpecs (from web search): 기준: 값 | ...")은 그대로 유지한다 —
// data_agent.ts의 buildAndAssembleTable()이 이 정확한 포맷을 다시 파싱해서
// Pre-enrich 캐시로 쓰기 때문. 달라지는 건 그 "값" 자체가 이제 검증된 값이라는 것뿐이다.
// ---------------------------------------------------------------------------

export interface WebResultForContext {
  criterion: string;
  url: string;
  snippet: string;
}

export interface ProductLogForContext {
  name: string;
  localSpecs: string[];
  coveredCriteria: string[];
  missingCriteria: string[];
  webResults: WebResultForContext[];
}

interface CoverageBlock {
  header: string;
  body: string;
  productName: string | null;
  localSpecs: string[];
  coveredCriteria: string[];
  missingCriteria: string[];
}

// 기준명에서 [중요/보통/낮음]과 괄호 설명 제거 후 키워드 추출
function cleanCriterion(c: string): string {
  return c.replace(/\s*\[.*?\]/g, "").replace(/\s*\(.*?\)/g, "").trim().toLowerCase();
}

/**
 * 컨텍스트를 [Product N] 블록으로 쪼개 제품별 로컬 DB 커버리지(coveredCriteria/
 * missingCriteria)를 계산한다. 네트워크 호출 없음 — enrichContextWithTavily(Tavily까지
 * 도는 버전)와 computeSpecCoverage(coverage만 필요한 소비자용, 아래 참고) 양쪽이 공유한다.
 */
function computeCoverageBlocks(contextSummary: string, decisionCriteria: string[]): CoverageBlock[] {
  const parts = contextSummary.split(/(\[Product \d+\])/);
  const rawBlocks: Array<{ header: string; body: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    if (/^\[Product \d+\]$/.test(parts[i].trim())) {
      rawBlocks.push({ header: parts[i], body: parts[i + 1] ?? "" });
      i++;
    }
  }

  return rawBlocks.map(({ header, body }) => {
    const nameMatch = body.match(/Name:\s*(.+)/);
    if (!nameMatch) {
      return { header, body, productName: null, localSpecs: [], coveredCriteria: [], missingCriteria: [] };
    }
    const productName = nameMatch[1].trim();

    const specsMatch = body.match(/Specs:\s*(.+)/);
    const localSpecs = specsMatch?.[1]?.split(" / ").map(s => s.trim()).filter(Boolean) ?? [];

    // 스펙 키만 추출 ("손떨림보정: 5축광학식" → "손떨림보정")
    const specKeys = localSpecs.map(s => s.split(":")[0].trim().toLowerCase());

    // 스펙 키 기반 커버리지 판단:
    // 기준의 키워드 "전부"가 같은 스펙 키 안에 있어야 covered.
    // (예: "센서 크기" → ["센서","크기"] 중 "센서"만 매칭돼도 통과시키면, "풀프레임 센서"처럼
    // 관련은 있지만 실제로 "크기" 정보는 없는 스펙도 커버된 걸로 오판해 웹 검색 기회를 놓친다.
    // 단어 하나라도 안 맞으면 미확정으로 보고 Tavily로 한 번 더 확인하는 게 안전하다.)
    function isCoveredBySpecKey(criterion: string): boolean {
      const clean = cleanCriterion(criterion);
      const keywords = clean.split(/\s+/).filter(w => w.length >= 2);
      return specKeys.some(key =>
        keywords.every(kw => key.includes(kw) || kw.includes(key))
      );
    }

    const coveredCriteria: string[] = [];
    const missingCriteria: string[] = [];

    decisionCriteria.forEach((criterion) => {
      if (isCoveredBySpecKey(criterion)) coveredCriteria.push(criterion);
      else missingCriteria.push(criterion);
    });

    console.log(`\n\x1b[36m[Spec Coverage] "${productName}"\x1b[0m`);
    console.log(`  Danawa 스펙 (${localSpecs.length}개): ${localSpecs.slice(0, 5).join(" / ")}${localSpecs.length > 5 ? " ..." : ""}`);
    coveredCriteria.forEach(c => console.log(`  ✅ "${c}" → DB에서 커버`));
    missingCriteria.forEach(c => console.log(`  ❌ "${c}" → DB 미커버 (웹 검색 필요)`));

    return { header, body, productName, localSpecs, coveredCriteria, missingCriteria };
  });
}

/**
 * computeCoverageBlocks 결과만 필요한 소비자(ComparisonTable 경로의 research 로그)를 위한
 * coverage-only 버전 — Tavily 호출을 하지 않는다. ComparisonTable은 이 정보 없이도
 * buildAndAssembleTable(STEP0, DB 값만 즉시 채움) → enrichCompTableCells(STEP2, 미확인
 * 셀 전부를 한 번의 병렬 배치로 검색)만으로 셀을 다 채울 수 있어서, 여기서 미리 Tavily를
 * 돌려두면 그 결과를 기다리는 순차 barrier가 하나 더 생길 뿐이다 — enrichCompTableCells의
 * 병렬 배치 하나로 합치기 위해 이 경로는 검색을 하지 않고 coverage 로그만 만든다.
 */
export function computeSpecCoverage(
  contextSummary: string,
  decisionCriteria: string[]
): ProductLogForContext[] {
  if (!contextSummary.trim() || decisionCriteria.length === 0) return [];
  return computeCoverageBlocks(contextSummary, decisionCriteria)
    .filter((b): b is CoverageBlock & { productName: string } => b.productName !== null)
    .map(b => ({
      name: b.productName,
      localSpecs: b.localSpecs,
      coveredCriteria: b.coveredCriteria,
      missingCriteria: b.missingCriteria,
      webResults: [],
    }));
}

export async function enrichContextWithTavily(
  contextSummary: string,
  decisionCriteria: string[],
  category: string,
  locale: string = "ko",
  knownProducts?: KnownProductSpecs[]
): Promise<{ enriched: string; productLogs: ProductLogForContext[] }> {
  const productLogs: ProductLogForContext[] = [];

  if (!contextSummary.trim() || decisionCriteria.length === 0) {
    return { enriched: contextSummary, productLogs };
  }

  const coverageBlocks = computeCoverageBlocks(contextSummary, decisionCriteria);
  if (coverageBlocks.length === 0) return { enriched: contextSummary, productLogs };

  // 청소 모드 등에 따라 값이 갈리는 기준(소음/흡입력 등)은 제품마다 독립 검색하면 서로
  // 다른 조건의 값을 주워와 비교가 불공정해진다 — data_agent.ts의 enrichCompTableCells/
  // auto-enrich와 동일하게 여기서도 미리 힌트를 구해 lookupProductSpec에 흘려보낸다.
  const criterionMeta = await expandCriterionMeta(decisionCriteria.map(cleanCriterion));

  const enrichedBlocks = await Promise.all(
    coverageBlocks.map(async ({ header, body, productName, localSpecs, coveredCriteria, missingCriteria }) => {
      if (productName === null) return header + body;

      if (missingCriteria.length === 0) {
        productLogs.push({ name: productName, localSpecs, coveredCriteria, missingCriteria, webResults: [] });
        return header + body;
      }

      const webResultRaw = await Promise.all(
        missingCriteria.slice(0, 5).map(async (criterion) => {
          // cleanCriterion으로 [중요]/[낮음] 브라켓과 괄호 설명을 제거하고 조회
          const cleanedCriterion = cleanCriterion(criterion);

          // Tavily를 부르기 전에 이번 요청과 함께 도착한 "화면에 이미 떠 있는 값"부터
          // 확인한다 — Option List/Comparison Table이 각자 독립적으로 실시간 검색을 돌려
          // 같은 제품×기준인데 값이 갈리는 걸 막는다(update-table STRATEGY A의
          // prefetchedValues와 같은 취지).
          const meta = criterionMeta[cleanedCriterion];
          const knownValue = lookupKnownSpecValue(productName, cleanedCriterion, knownProducts, meta?.type);
          if (knownValue) {
            console.log(`   🔗 "${productName}" × "${cleanedCriterion}" → "${knownValue}" (source=screen, 재검색 생략)`);
            return { criterion, url: "", snippet: knownValue };
          }

          // 화면에 없어도, 이 참가자가 예전 턴/다른 패널에서 이미 조회해둔 값이 있으면
          // 재사용한다(spec-cache.ts, 참가자별로 격리됨).
          const cachedValue = await getCachedSpec(currentParticipantId, productName, cleanedCriterion);
          if (cachedValue) {
            console.log(`   🗄️  "${productName}" × "${cleanedCriterion}" → "${cachedValue}" (source=participant-cache, 재검색 생략)`);
            return { criterion, url: "", snippet: cachedValue };
          }

          const result = await lookupProductSpec(productName, cleanedCriterion, category, locale, meta?.formatHint, meta?.canonicalUnit, meta?.preferredCondition, meta?.type);
          if (result.value !== "-" && !result.uncertain) {
            console.log(`   🔍 "${productName}" × "${cleanedCriterion}" → "${result.value}" (source=${result.source})`);
            void setCachedSpec(currentParticipantId, productName, cleanedCriterion, result.value);
            return { criterion, url: result.sourceUrl ?? "", snippet: result.value };
          }
          console.log(`   🔍 "${productName}" × "${cleanedCriterion}" → 결과 없음${result.uncertain ? " (불확실)" : ""}`);
          return null;
        })
      );

      const webResults = webResultRaw.filter(Boolean) as WebResultForContext[];
      productLogs.push({ name: productName, localSpecs, coveredCriteria, missingCriteria, webResults });

      if (webResults.length === 0) return header + body;

      const webSpecText = webResults.map(w => `${w.criterion}: ${w.snippet}`).join(" | ");
      return header + body + `\nWebSpecs (from web search): ${webSpecText}`;
    })
  );

  return { enriched: enrichedBlocks.join(""), productLogs };
}
