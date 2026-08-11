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
  parseSpecEntry,
  toDisplayValue,
  hasUnitDimensionMismatch,
} from "@/lib/backend/agents/data_agent";

// ---------------------------------------------------------------------------
// 0. 로컬 DB 직접 조회 — 이름 매칭으로 products-*.json에서 제품 스펙 찾기
// (mutate-surface.ts에 있던 걸 여기로 옮김 — mutate-surface.ts가 이 파일의
// lookupProductSpec을 쓰게 되면서 순환 참조가 생겨서 옮겼다)
// ---------------------------------------------------------------------------

// 필드키 동의어 확장 — "무게" 검색 시 "중량"도 함께 찾기
const FIELD_SYNONYMS: [RegExp, string[]][] = [
  [/무게|weight/i,                    ["무게", "중량"]],
  // 배터리 "수명/사용시간"(지속시간)과 배터리 "용량"(mAh)은 서로 다른 물리량이다.
  // 이 패턴을 아래 배터리 패턴보다 먼저 검사해야 "배터리 수명" 같은 필드키가
  // "배터리"/"배터리용량"(mAh) 스펙에 먼저 매칭돼 잘못된 단위로 반환되지 않는다.
  [/수명|사용\s*시간|런타임|run.*time/i, ["사용시간", "배터리 수명", "런타임"]],
  [/배터리|battery/i,                 ["배터리용량", "배터리"]],
  [/충전\s*시간|charge/i,            ["충전시간", "충전"]],
  [/소음|noise/i,                     ["소음", "소음수준"]],
  [/흡입\s*력|suction/i,             ["흡입력", "흡입"]],
  [/담한\s*면적|area/i,              ["담한면적", "사용고도지 면적"]],
  [/먼지통|집진통|dust.*bin|bin/i,  ["먼지통", "집진통", "먼지통용량"]],
  [/물통|water.*tank|tank/i,         ["물통", "물탱크", "물탱크용량"]],
  [/먼지\s*비움|empty/i,             ["먼지비움", "자동먼지비움", "비움"]],
  [/걸레\s*세척|wash/i,              ["걸레세척", "자동걸레세척", "세척"]],
  [/걸레\s*건조|dry/i,               ["걸레건조", "온풍건조", "건조"]],
];

function expandFieldKeySynonyms(fieldKey: string): string[] {
  for (const [pattern, synonyms] of FIELD_SYNONYMS) {
    if (pattern.test(fieldKey)) return synonyms;
  }
  return [fieldKey];
}

export function findProductSpecInDB(productName: string, fieldKey: string, category: string): string | null {
  try {
    const filePath = path.join(process.cwd(), "data", `products-${category}.json`);
    if (!fs.existsSync(filePath)) {
      console.warn(`[DB lookup] 파일 없음: products-${category}.json`);
      return null;
    }
    const products = JSON.parse(fs.readFileSync(filePath, "utf8")) as { name: string; specs: string[] }[];
    const qLower = productName.toLowerCase();
    const matched = products.find(p => {
      const pLower = p.name.toLowerCase();
      return pLower === qLower || pLower.includes(qLower) || qLower.includes(pLower);
    });
    if (!matched) {
      console.log(`[DB lookup] ❌ "${productName}" — DB에 제품 없음`);
      return null;
    }
    // 매핑된 DB 제품명이 검색어와 다르면 명시
    const nameMatched = matched.name === productName ? "" : ` (DB명: "${matched.name}")`;
    // 동의어 확장 후 모든 키로 검색 (띄어쓰기 무시)
    const synonyms = expandFieldKeySynonyms(fieldKey);
    for (const key of synonyms) {
      const keyNormalized = key.toLowerCase().replace(/\s+/g, "");
      const candidates = matched.specs.filter(s => s.toLowerCase().replace(/\s+/g, "").includes(keyNormalized));
      for (const matchedSpec of candidates) {
        // "배터리: NP-FW50(1020mAh)" 형태를 그대로 반환하면 행 라벨("배터리 수명")과
        // 값 안의 라벨("배터리:")이 중복돼 보인다 — lookupCellValue(comp_table.ts)가 이미
        // 하고 있는 것과 동일하게 라벨을 떼고 값만 반환한다.
        const { rawValue } = parseSpecEntry(matchedSpec);
        // fieldKey가 기대하는 단위군과 값의 실제 단위군이 다르면(예: "배터리 수명"(분) vs
        // "배터리: 6400mAh"(용량)) 서로 다른 물리량이므로 건너뛰고 다음 후보를 본다.
        if (hasUnitDimensionMismatch(fieldKey, rawValue)) continue;
        const displayValue = toDisplayValue(rawValue, fieldKey);
        console.log(`[DB lookup] ✅ "${productName}"${nameMatched} (key="${key}") → "${displayValue}" (원본: "${matchedSpec}")`);
        return displayValue;
      }
    }
    // 스펙 없음 — DB에 있는 스펙 키 목록 일부 출력
    const specKeys = matched.specs.slice(0, 8).map(s => s.split(/[:\s]/)[0]).join(", ");
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
  source: "db" | "tavily" | "none";
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
 * 우선순위: 로컬 DB → Tavily 검색 1번(advanced, answer 합성 포함) → extractCellValueLight
 * LLM 호출 1번. 재시도 없음 — test-tavily-lightweight.ts 실험과 동일하게 셀 하나당
 * 네트워크 호출을 Tavily 1번 + LLM 1번으로 고정한다.
 *
 * extractCellValueLight는 judgeCell(Extractive QA + Evidence Verification +
 * SiblingGuard + Sanity Check의 다단계 검증)을 대체한 경량 버전으로, Tavily가 합성한
 * answer 텍스트 하나를 보고 LLM에게 한 번만 값을 물어본다 — siblingTokens는 프롬프트
 * 경고 문구로만 전달되고, judgeCell처럼 거리 기반으로 코드가 재검증하지는 않는다.
 */
export async function lookupProductSpec(
  productName: string,
  fieldKey: string,
  category: string,
  locale: string = "ko",
  formatHint?: string,
  canonicalUnit?: string | null
): Promise<SpecLookupResult> {

  // Step 1: 로컬 DB
  const dbSpec = findProductSpecInDB(productName, fieldKey, category);
  if (dbSpec && dbSpec !== "-") {
    return { value: dbSpec, source: "db" };
  }

  // Step 2: Tavily 검색 → extractCellValueLight
  const siblingTokens = getSiblingExcludeTokens(productName, category);
  const q1 = `${productName} ${fieldKey}`;

  const res1 = await tavilySearch(q1, "advanced", {
    maxResults: 20, chunksPerSource: 5, includeAnswer: "advanced",
  });
  const tavilyAnswer = res1.answer;

  if (tavilyAnswer) console.log(`💡 [Tavily Answer] "${productName} × ${fieldKey}"\n   ${tavilyAnswer.slice(0, 200)}`);

  const answerSegment = tavilyAnswer
    ? [{ url: res1.results[0]?.url ?? "https://tavily.com", content: tavilyAnswer, score: 999, title: "Tavily Answer" }]
    : [];
  const resultsWithAnswer = [...answerSegment, ...res1.results];

  let judge: { value: string; sourceUrl?: string; usedSnippet?: string; uncertain?: boolean } | null = null;
  if (resultsWithAnswer.length > 0) {
    const c1 = await extractCellValueLight(productName, fieldKey, resultsWithAnswer, locale, siblingTokens, formatHint, canonicalUnit);
    if (c1.value !== "-") judge = c1;
  }

  if (!judge) {
    console.log(`❌ [extractCellValueLight] "${productName} × ${fieldKey}" → 값 없음`);
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

export async function enrichContextWithTavily(
  contextSummary: string,
  decisionCriteria: string[],
  category: string,
  locale: string = "ko"
): Promise<{ enriched: string; productLogs: ProductLogForContext[] }> {
  const productLogs: ProductLogForContext[] = [];

  if (!contextSummary.trim() || decisionCriteria.length === 0) {
    return { enriched: contextSummary, productLogs };
  }

  const parts = contextSummary.split(/(\[Product \d+\])/);
  const blocks: Array<{ header: string; body: string }> = [];

  for (let i = 0; i < parts.length; i++) {
    if (/^\[Product \d+\]$/.test(parts[i].trim())) {
      blocks.push({ header: parts[i], body: parts[i + 1] ?? "" });
      i++;
    }
  }

  if (blocks.length === 0) return { enriched: contextSummary, productLogs };

  const enrichedBlocks = await Promise.all(
    blocks.map(async ({ header, body }) => {
      const nameMatch = body.match(/Name:\s*(.+)/);
      if (!nameMatch) return header + body;
      const productName = nameMatch[1].trim();

      const specsMatch = body.match(/Specs:\s*(.+)/);
      const localSpecs = specsMatch?.[1]?.split(" / ").map(s => s.trim()).filter(Boolean) ?? [];

      // 스펙 키만 추출 ("손떨림보정: 5축광학식" → "손떨림보정")
      const specKeys = localSpecs.map(s => s.split(":")[0].trim().toLowerCase());

      // 기준명에서 [중요/보통/낮음]과 괄호 설명 제거 후 키워드 추출
      function cleanCriterion(c: string): string {
        return c.replace(/\s*\[.*?\]/g, "").replace(/\s*\(.*?\)/g, "").trim().toLowerCase();
      }

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

      if (missingCriteria.length === 0) {
        productLogs.push({ name: productName, localSpecs, coveredCriteria, missingCriteria, webResults: [] });
        return header + body;
      }

      const webResultRaw = await Promise.all(
        missingCriteria.slice(0, 5).map(async (criterion) => {
          // cleanCriterion으로 [중요]/[낮음] 브라켓과 괄호 설명을 제거하고 조회
          const cleanedCriterion = cleanCriterion(criterion);
          const result = await lookupProductSpec(productName, cleanedCriterion, category, locale);
          if (result.value !== "-" && !result.uncertain) {
            console.log(`   🔍 "${productName}" × "${cleanedCriterion}" → "${result.value}" (source=${result.source})`);
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
