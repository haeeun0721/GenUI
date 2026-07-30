/**
 * spec-lookup.ts — 공통 스펙 조회 서비스
 *
 * auto-enrich (Option List) 와 fetch-spec (Comp Table) 양쪽에서 호출.
 * DB 조회 → Tavily 3단계 검색 → 4가지 결과 검증을 하나의 파이프라인으로 제공.
 */

import { findProductSpecInDB } from "@/lib/backend/tools/mutate-surface";
import {
  tavilySearch,
  judgeCell,
  detectCriterionType,
} from "@/lib/backend/agents/data_agent";
import { getSpec, setSpec } from "./spec-cache";

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

type TavilyResult = { title: string; url: string; content: string; score: number };

// ---------------------------------------------------------------------------
// 1. 정적 유의어 사전 (LLM 호출 불필요)
// ---------------------------------------------------------------------------

const STATIC_SYNONYMS: Record<string, string[]> = {
  "물탱크":       ["물탱크 크기", "탱크 용량", "water tank"],
  "물탱크 용량":  ["물탱크 크기", "탱크 용량", "물통"],
  "먼지통":       ["집진통", "더스트빈", "dustbin"],
  "먼지통 용량":  ["집진통", "집진 용량", "먼지 통"],
  "흡입력":       ["흡입 파워", "파스칼", "suction power"],
  "소음":         ["소음 수준", "데시벨", "noise level"],
  "소음 수준":    ["소음 dB", "noise", "작동음"],
  "배터리":       ["배터리 용량", "battery", "mAh"],
  "무게":         ["중량", "weight", "본체 무게"],
  "충전시간":     ["충전 소요", "charge time", "완충"],
  "사용시간":     ["배터리 지속", "runtime", "최대 사용"],
  "화소":         ["해상도", "megapixel", "MP"],
  "손떨림보정":   ["OIS", "이미지 안정화", "image stabilization"],
  "방수":         ["생활방수", "IPX", "방진"],
};

export function getStaticSynonyms(fieldKey: string): string[] {
  const lower = fieldKey.toLowerCase();
  for (const [key, syns] of Object.entries(STATIC_SYNONYMS)) {
    if (lower.includes(key.toLowerCase())) return syns;
  }
  return [];
}

// ---------------------------------------------------------------------------
// 2. AI Answer 수치 fast-path (regex → judgeCell LLM 우회)
// ---------------------------------------------------------------------------

const FIELD_EXTRACT_PATTERNS: [RegExp, RegExp, string][] = [
  [/물탱크|물통|water.tank/i,    /(\d+(?:\.\d+)?)\s*(?:L|liter|리터)/i,    "L"],
  [/물탱크|물통|water.tank/i,    /(\d+(?:\.\d+)?)\s*(?:mL|ml|milliliter)/i, "ml"],
  [/먼지통|집진통|dustbin/i,     /(\d+(?:\.\d+)?)\s*(?:L|liter|리터)/i,    "L"],
  [/먼지통|집진통|dustbin/i,     /(\d+(?:\.\d+)?)\s*(?:mL|ml)/i,           "ml"],
  [/흡입|suction/i,              /(\d+(?:,\d+)?)\s*(?:Pa|파스칼)/i,         "Pa"],
  [/소음|noise/i,                /(\d+(?:\.\d+)?)\s*(?:dB|데시벨)/i,        "dB"],
  [/배터리|battery/i,            /(\d+(?:,\d+)?)\s*(?:mAh)/i,              "mAh"],
  [/무게|중량|weight/i,          /(\d+(?:\.\d+)?)\s*(?:kg)/i,              "kg"],
  [/무게|중량|weight/i,          /(\d+(?:\.\d+)?)\s*(?:g)\b/i,             "g"],
];

/**
 * AI Answer 스니펫에서 수치를 직접 추출한다 (LLM 우회 fast-path).
 * productName이 수치 주변 160자 이내에 없으면 다른 제품의 값으로 간주하고 건너뜀.
 */
function tryExtractFromAIAnswer(
  results: TavilyResult[],
  fieldKey: string,
  productName: string
): { value: string; sourceUrl: string; usedSnippet: string } | null {
  const aiResult = results.find(r => r.title === "Tavily AI Answer Overview");
  if (!aiResult) return null;
  const text = aiResult.content;
  const nameWords = productName.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  const WINDOW = 160; // 수치 앞뒤 160자 내 제품명 등장 여부 확인

  for (const [fieldPat, valuePat, unit] of FIELD_EXTRACT_PATTERNS) {
    if (!fieldPat.test(fieldKey)) continue;
    // 전역 검색으로 모든 수치 후보 순회 — 첫 번째 매칭이 아닌 제품명 근접 매칭 선택
    const globalPat = new RegExp(valuePat.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = globalPat.exec(text)) !== null) {
      const lo = Math.max(0, m.index - WINDOW);
      const hi = Math.min(text.length, m.index + m[0].length + WINDOW);
      const vicinity = text.slice(lo, hi).toLowerCase();
      // 제품명 단어가 주변에 50% 이상 등장해야 해당 제품의 값으로 인정
      const nameHits = nameWords.length === 0
        ? 1
        : nameWords.filter(w => vicinity.includes(w)).length;
      // 모델 번호(영숫자 혼합)는 필수 매칭
      const modelNums = nameWords.filter(w => /[a-zA-Z]\d|\d[a-zA-Z]/i.test(w));
      const modelOk = modelNums.length === 0 || modelNums.some(m => vicinity.includes(m));
      if (modelOk && nameHits / Math.max(nameWords.length, 1) >= 0.65) {
        const num = m[1].replace(/,/g, "");
        return { value: `${num}${unit}`, sourceUrl: aiResult.url, usedSnippet: text.slice(lo, lo + 120) };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2-1. 수치 범위 합리성 검증 (Sanity Check)
// 물리적으로 불가능한 값(150dB 소음, 0.1Pa 흡입력 등)을 즉시 차단.
// ---------------------------------------------------------------------------

interface SpecRange { min: number; max: number }

/** 카테고리별 허용 수치 범위 — [fieldKey 매칭 패턴, { min, max }] */
const SPEC_RANGES: [RegExp, SpecRange][] = [
  [/소음/,               { min: 40,   max: 90    }],  // dB
  [/흡입|suction/i,      { min: 500,  max: 50000 }],  // Pa — 최신 제품 최대 ~45,000Pa
  [/무게|중량|weight/i,  { min: 0.3,  max: 25    }],  // kg
  [/배터리|battery/i,    { min: 300,  max: 12000 }],  // mAh
  [/물탱크|water.tank/i, { min: 0.05, max: 5     }],  // L
  [/먼지통|집진통/,      { min: 0.05, max: 5     }],  // L
  [/사용시간|runtime/i,  { min: 10,   max: 400   }],  // 분
  [/충전시간/,           { min: 30,   max: 720   }],  // 분
];

/**
 * 추출된 수치 스펙이 물리적으로 타당한 범위 내인지 검증.
 * 범위 정의 없거나 수치 파싱 불가면 통과(true). 범위 이탈 시 false 반환.
 */
function sanityCheckValue(value: string, fieldKey: string): boolean {
  for (const [pattern, range] of SPEC_RANGES) {
    if (!pattern.test(fieldKey)) continue;
    const cleaned = value.replace(/,/g, "");
    const numMatch = cleaned.match(/[\d.]+/);
    if (!numMatch) return true; // 수치 없는 값(boolean 등)은 통과
    let num = parseFloat(numMatch[0]);
    // mL 단위로 온 물탱크/먼지통 값을 L로 변환 후 비교
    if (/ml/i.test(value) && /탱크|통/.test(fieldKey)) num /= 1000;
    if (num < range.min || num > range.max) {
      console.log(`[SanityCheck] ❌ 범위 이탈: "${value}" (${fieldKey}) 허용범위: ${range.min}–${range.max}`);
      return false;
    }
    return true;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 3. 결과 신뢰도 검증 (4가지)
// ---------------------------------------------------------------------------

const LOW_TRUST_DOMAINS = [
  "tistory.com", "blog.naver.com", "m.blog.naver.com",
  "youtube.com", "youtu.be", "tiktok.com", "instagram.com",
  "namu.wiki", "reddit.com", "fujifilm-dsc.com/manual",
];

function isDomainLowTrust(url: string): boolean {
  const u = url.toLowerCase();
  return LOW_TRUST_DOMAINS.some(d => u.includes(d));
}

/** 에코 환각: AI Answer가 제품명을 그대로 되받아쓰면서 저신뢰 도메인 출처 */
function isEchoHallucination(
  aiAnswerContent: string,
  productName: string,
  sourceUrl: string
): boolean {
  if (!isDomainLowTrust(sourceUrl)) return false;
  const words = productName.split(/\s+/).filter(w => w.length >= 2);
  const lower = aiAnswerContent.toLowerCase();
  const matched = words.filter(w => lower.includes(w.toLowerCase())).length;
  return matched / Math.max(words.length, 1) >= 0.8;
}

/**
 * 스니펫에 제품명이 충분히 등장하는지 확인.
 * - 일반 단어: 65% 이상 매칭
 * - 모델 번호(영숫자 조합, 예: S10, X50s, L50s): 존재하면 필수 매칭
 */
function hasProductNameInSnippet(snippet: string, productName: string): boolean {
  const lower = snippet.toLowerCase();
  const words = productName.split(/\s+/).filter(w => w.length >= 2);
  if (words.length === 0) return true;

  // 모델 번호 추출 (영문+숫자 혼합, 예: S10, X50s, L50s, T90)
  const modelNumbers = words.filter(w => /[a-zA-Z]\d|\d[a-zA-Z]/i.test(w));
  // 모델 번호가 있으면 스니펫에 반드시 포함되어야 함
  if (modelNumbers.length > 0) {
    const modelPresent = modelNumbers.some(m => lower.includes(m.toLowerCase()));
    if (!modelPresent) return false;
  }

  // 일반 단어 65% 이상 매칭
  const matched = words.filter(w => lower.includes(w.toLowerCase())).length;
  return matched / words.length >= 0.65;
}

interface ValidationResult {
  ok: boolean;
  warnings: string[];
}

function validateSpec(
  judge: { value: string; sourceUrl?: string; usedSnippet?: string },
  productName: string,
  aiAnswerContent?: string
): ValidationResult {
  const warnings: string[] = [];

  // ① 에코 환각 감지 (저신뢰 도메인 + 제품명 되받아쓰기)
  if (judge.sourceUrl && aiAnswerContent) {
    if (isEchoHallucination(aiAnswerContent, productName, judge.sourceUrl)) {
      warnings.push(`에코 환각 의심: 저신뢰 출처(${judge.sourceUrl})에서 제품명 되받아쓰기`);
    }
  }

  // ② 스니펫 내 제품명 미등장
  if (judge.usedSnippet && !hasProductNameInSnippet(judge.usedSnippet, productName)) {
    warnings.push(`스니펫에 제품명 미등장 (관련 없는 결과 가능성)`);
  }

  // ③ 저신뢰 도메인 단독 경고 (배제는 아님, 로그용)
  if (judge.sourceUrl && isDomainLowTrust(judge.sourceUrl)) {
    warnings.push(`저신뢰 출처: ${judge.sourceUrl}`);
  }

  return { ok: warnings.length === 0 || !warnings.some(w => w.startsWith("에코")), warnings };
}

// ---------------------------------------------------------------------------
// 4. 제품명 단순화 (마케팅 수식어만 제거, 모델 구분자 보존)
// ---------------------------------------------------------------------------

const MARKETING_SUFFIXES = /\s*(플러스|에디션|리미티드|스페셜)\s*/gi;

export function simplifyProductName(name: string): string {
  return name.replace(MARKETING_SUFFIXES, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 5. 핵심 공개 함수: lookupProductSpec
// ---------------------------------------------------------------------------

/**
 * 제품 × 스펙 필드에 대한 값을 조회한다.
 * 우선순위: 로컬 DB → Tavily 1차(basic) → 2차(basic) → 3차(advanced)
 * 각 단계에서 AI Answer fast-path → judgeCell(LLM) 순으로 시도.
 * 모든 단계에서 신뢰도 검증을 적용한다.
 */
export async function lookupProductSpec(
  productName: string,
  fieldKey: string,
  category: string
): Promise<SpecLookupResult> {

  // Step 0: 공유 스펙 캐시 (in-memory) — Comp Table이 이미 찾은 값 즉시 재사용
  const cached = getSpec(productName, fieldKey);
  if (cached) {
    console.log(`[SpecCache HIT] "${productName}" × "${fieldKey}" → "${cached.value}" (${cached.source})`);
    return { value: cached.value, source: cached.source as "db" | "tavily" };
  }

  // Step 1: 로컬 DB
  const dbSpec = findProductSpecInDB(productName, fieldKey, category);
  if (dbSpec) {
    setSpec(productName, fieldKey, dbSpec, "db");
    return { value: dbSpec, source: "db" };
  }

  // Step 2: Tavily 3단계 검색
  const synonyms = getStaticSynonyms(fieldKey);
  const searchName = simplifyProductName(productName);
  const expectedType = detectCriterionType(fieldKey);
  const terms = [fieldKey, ...synonyms.slice(0, 2)].join(" ");

  const attempts: Array<{ query: string; depth: "basic" | "advanced" }> = [
    { query: `${searchName} ${terms}`,                          depth: "basic" },
    { query: `${searchName} ${[...synonyms.slice(0, 2), fieldKey].join(" ")} 스펙`, depth: "basic" },
    { query: `${searchName} ${fieldKey} 제원 사양표`,            depth: "advanced" },
  ];

  const attemptLabels = ["1차", "2차", "3차"];
  const foundValues: string[] = [];   // 값 일관성 검증용
  let lastValidationWarnings: string[] = [];

  for (let i = 0; i < attempts.length; i++) {
    const { query, depth } = attempts[i];
    const label = attemptLabels[i];
    const results = await tavilySearch(query, depth);

    console.log(`   🔍 [${label}] "${searchName} × ${fieldKey}" → ${results.length}개 결과`);
    results.slice(0, 2).forEach(r => console.log(`      📎 ${r.url}`));

    // AI Answer fast-path
    const fastResult = tryExtractFromAIAnswer(results, fieldKey, searchName);
    let judge: { value: string; sourceUrl?: string; usedSnippet?: string };

    if (fastResult) {
      judge = fastResult;
      console.log(`   ⚡ [AI Answer 직접 추출] "${searchName}" → ${fastResult.value}`);
    } else {
      judge = await judgeCell(searchName, fieldKey, results, "ko", expectedType, synonyms);
    }

    if (judge.value === "-") continue;

    // 수치 범위 합리성 검증 (Sanity Check) — 물리적으로 불가능한 값 즉시 차단
    if (!sanityCheckValue(judge.value, fieldKey)) {
      console.log(`   ❌ [${label} Sanity Check 실패] "${judge.value}" → 다음 시도로 넘어감`);
      continue;
    }

    // 신뢰도 검증
    const aiAnswerContent = results.find(r => r.title === "Tavily AI Answer Overview")?.content;
    const validation = validateSpec(judge, productName, aiAnswerContent);

    console.log(`   ✅ [${label} 성공] "${searchName}" → ${judge.value}`);
    if (judge.sourceUrl)   console.log(`      📎 출처: ${judge.sourceUrl}`);
    if (judge.usedSnippet) console.log(`      💬 스니펫: "${judge.usedSnippet.slice(0, 120)}"`);
    if (!validation.ok) {
      validation.warnings.forEach(w => console.log(`      ⚠️  검증 경고: ${w}`));
      lastValidationWarnings = validation.warnings;
      // 에코 환각이면 이 시도 건너뜀
      if (validation.warnings.some(w => w.startsWith("에코"))) continue;
    }

    // ④ 값 일관성: 이전 시도와 다른 값이면 불확실 처리
    if (foundValues.length > 0 && !foundValues.includes(judge.value)) {
      console.log(`   ⚠️  [값 불일치] ${[...foundValues, judge.value].join(" vs ")} → 불확실`);
      return {
        value: judge.value,
        source: "tavily",
        sourceUrl: judge.sourceUrl,
        usedSnippet: judge.usedSnippet,
        uncertain: true,
        validationWarnings: [...lastValidationWarnings, `값 불일치: ${[...foundValues, judge.value].join(" vs ")}`],
      };
    }

    foundValues.push(judge.value);
    const finalResult: SpecLookupResult = {
      value: judge.value,
      source: "tavily",
      sourceUrl: judge.sourceUrl,
      usedSnippet: judge.usedSnippet,
      uncertain: false,
      validationWarnings: validation.warnings.length ? validation.warnings : undefined,
    };
    // 공유 캐시에 저장 → Option List와 Comp Table이 동일한 값 공유
    setSpec(productName, fieldKey, judge.value, "tavily", judge.sourceUrl, judge.usedSnippet);
    return finalResult;
  }

  return { value: "-", source: "none" };
}
