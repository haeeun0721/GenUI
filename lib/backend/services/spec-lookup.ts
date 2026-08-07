/**
 * spec-lookup.ts — 공통 스펙 조회 서비스
 *
 * auto-enrich (Option List) 와 fetch-spec (Comp Table) 양쪽에서 호출.
 * DB 조회 → Tavily 3단계 검색 → 4가지 결과 검증을 하나의 파이프라인으로 제공.
 */

import * as fs from "fs";
import * as path from "path";
import {
  tavilySearch,
  judgeCell,
  detectCriterionType,
  getSiblingExcludeTokens,
  parseSpecEntry,
  toDisplayValue,
} from "@/lib/backend/agents/data_agent";

// ---------------------------------------------------------------------------
// 0. 로컬 DB 직접 조회 — 이름 매칭으로 products-*.json에서 제품 스펙 찾기
// (mutate-surface.ts에 있던 걸 여기로 옮김 — mutate-surface.ts가 이 파일의
// lookupProductSpec을 쓰게 되면서 순환 참조가 생겨서 옮겼다)
// ---------------------------------------------------------------------------

// 필드키 동의어 확장 — "무게" 검색 시 "중량"도 함께 찾기
const FIELD_SYNONYMS: [RegExp, string[]][] = [
  [/무게|weight/i,                    ["무게", "중량"]],
  [/배터리|battery/i,                 ["배터리", "배터리용량", "사용시간"]],
  [/충전\s*시간|charge/i,            ["충전시간", "충전"]],
  [/소음|noise/i,                     ["소음", "소음수준"]],
  [/흡입\s*력|suction/i,             ["흡입력", "흡입"]],
  [/담한\s*면적|area/i,              ["담한면적", "사용고도지 면적"]],
  [/먼지통|집진통|dust.*bin|bin/i,  ["먼지통", "집진통", "먼지통용량"]],
  [/물통|water.*tank|tank/i,         ["물통", "물탱크", "물탱크용량"]],
  [/사용\s*시간|run.*time/i,         ["사용시간", "배터리"]],
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
      const matchedSpec = matched.specs.find(s => s.toLowerCase().replace(/\s+/g, "").includes(keyNormalized));
      if (matchedSpec) {
        // "배터리: NP-FW50(1020mAh)" 형태를 그대로 반환하면 행 라벨("배터리 수명")과
        // 값 안의 라벨("배터리:")이 중복돼 보인다 — lookupCellValue(comp_table.ts)가 이미
        // 하고 있는 것과 동일하게 라벨을 떼고 값만 반환한다.
        const { rawValue } = parseSpecEntry(matchedSpec);
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
// 2. (제거됨) AI Answer 수치 fast-path — 정규식 기반이라 지원 필드가 6개뿐이었고,
// tryExtractFromAIAnswer에는 siblingExcludeTokens가 전달되지 않아 SiblingGuard가
// 적용되지 않는 안전성 구멍이 있었다. 커버리지도 좁아서(사용자가 자유롭게 추가하는
// Decision Criteria 대부분은 이 6개 필드에 해당하지 않음) 속도 이득도 크지 않아 제거하고
// 항상 judgeCell(LLM 검증 경로)만 쓰도록 통일했다.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2-1. 수치 범위 합리성 검증 (Sanity Check)
// 물리적으로 불가능한 값(수백 dB 소음, 소수점 Pa 흡입력 등)만 걸러내는 최후의 안전망.
// 범위는 일부러 넉넉하게 잡는다 — 정상 제품을 오탈락시키는 게 아니라, 단위 착각/자릿수
// 오류처럼 "명백히 말이 안 되는" 값만 잡는 게 목적.
// ---------------------------------------------------------------------------

interface SpecRange { min: number; max: number }

/** 카테고리별 허용 수치 범위 — [fieldKey 매칭 패턴, { min, max }] */
const SPEC_RANGES: [RegExp, SpecRange][] = [
  [/소음/,               { min: 20,   max: 100   }],  // dB
  [/흡입|suction/i,      { min: 100,  max: 80000 }],  // Pa
  [/무게|중량|weight/i,  { min: 0.05, max: 30    }],  // kg
  [/배터리|battery/i,    { min: 100,  max: 20000 }],  // mAh
  [/물탱크|water.tank/i, { min: 0.02, max: 8     }],  // L
  [/먼지통|집진통/,      { min: 0.02, max: 8     }],  // L
  [/사용시간|runtime/i,  { min: 5,    max: 600   }],  // 분
  [/충전시간/,           { min: 5,    max: 900   }],  // 분
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
    // mL 단위로 온 물탱크/먼지통 값을 L로 변환 후 비교 (영문 키워드 포함)
    if (/ml/i.test(value) && /탱크|통|tank|bin|dust/i.test(fieldKey)) num /= 1000;
    if (num < range.min || num > range.max) {
      console.log(`[SanityCheck] ❌ 범위 이탈: "${value}" (${fieldKey}) 허용범위: ${range.min}–${range.max}`);
      return false;
    }
    return true;
  }
  return true;
}

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

export function buildSpecPhrase(fieldKey: string, value: string): string {
  const v = cleanSpecValue(value); // 마케팅 수식어 제거
  if (v === "○") {
    if (/연동|호환|연결/.test(fieldKey)) return `${fieldKey} 가능`;
    if (/기능/.test(fieldKey)) return `${fieldKey} 지원`;
    if (/방식|타입|type/.test(fieldKey)) return `${fieldKey} 적용`;
    return `${fieldKey} 지원`;
  }
  if (v === "X") {
    if (/연동|호환|연결/.test(fieldKey)) return `${fieldKey} 불가`;
    return `${fieldKey} 없음`;
  }
  // value 타입 — 콜론 있으면 기준명 반복 방지
  if (v.includes(":")) return v;
  if (/\d/.test(v)) return `${fieldKey}: ${v}`;
  return `${fieldKey} ${v}`;
}

// ---------------------------------------------------------------------------
// 4. 핵심 공개 함수: lookupProductSpec
// ---------------------------------------------------------------------------

/**
 * 제품 × 스펙 필드에 대한 값을 조회한다.
 * 우선순위: 로컬 DB → Tavily 1회(advanced, 전체 도메인, 결과 다다익선) → judgeCell 검증.
 *
 * 예전엔 Tavily를 문구만 바꿔가며 최대 3번 순차 재시도했는데, 재시도끼리 사실상 같은
 * 검색이었고(끝 문구만 다름) 값을 못 찾을 때는 매번 3번 다 왕복하느라 제일 느렸다.
 * 대신 처음부터 advanced 모드로 더 많은 결과(max_results)와 URL당 여러 스니펫
 * (chunks_per_source)을 한 번에 가져오는 것으로 바꿨다 — 순차 재시도(최대 3회 왕복)보다
 * 한 번의 깊은 검색이 평균적으로 더 빠르다.
 *
 * 안전장치는 judgeCell의 Extractive QA + Evidence Verification + SiblingGuard와
 * Sanity Check(수치 범위 검증)로 건다 — 도메인 자체를 배제하지 않고, 대신 근거가
 * 명확한 값만 통과시키는 쪽으로 신뢰도를 확보한다.
 */
export async function lookupProductSpec(
  productName: string,
  fieldKey: string,
  category: string,
  locale: string = "ko"
): Promise<SpecLookupResult> {

  // Step 1: 로컬 DB
  // toDisplayValue가 빈 값을 "-"로 정규화할 수 있는데, 문자열 "-"는 JS에서 truthy라
  // dbSpec 자체만 확인하면 "찾음"으로 오판한다 — DB에 실질적 값이 없던 경우이므로
  // Tavily로 넘어가야 한다.
  const dbSpec = findProductSpecInDB(productName, fieldKey, category);
  if (dbSpec && dbSpec !== "-") {
    return { value: dbSpec, source: "db" };
  }

  // Step 2: Tavily 검색 (전체 도메인, 단일 시도)
  const synonyms = getStaticSynonyms(fieldKey);
  const expectedType = detectCriterionType(fieldKey);
  const terms = [fieldKey, ...synonyms.slice(0, 2)].join(" ");
  // 형제 SKU(예: "...Slim" vs "...Slim 직배수") 오염 방지 — evidence_quote에 이 토큰이
  // 있으면 judgeCell이 코드 레벨에서 확정적으로 폐기한다.
  const siblingTokens = getSiblingExcludeTokens(productName, category);

  // 제품명은 큰따옴표(Exact Match)로 감싸서 다른 제품이 섞여 들어오는 걸 원천 차단.
  const query = `"${productName}" ${terms} 제원 사양표`;

  const results = await tavilySearch(query, "advanced", {
    maxResults: 20,
    chunksPerSource: 3,
    includeAnswer: true,
  });

  console.log(`   🔍 "${productName} × ${fieldKey}" → ${results.length}개 결과`);
  results.slice(0, 5).forEach(r => console.log(`      📎 ${r.url}`));

  let judge: { value: string; sourceUrl?: string; usedSnippet?: string } | null = null;
  if (results.length > 0) {
    const candidate = await judgeCell(productName, fieldKey, results, locale, expectedType, synonyms, siblingTokens);
    if (candidate.value !== "-") {
      // 수치 범위 합리성 검증 (Sanity Check) — 물리적으로 불가능한 값만 차단
      if (sanityCheckValue(candidate.value, fieldKey)) {
        judge = candidate;
      } else {
        console.log(`   ❌ [Sanity Check 실패] "${candidate.value}"`);
      }
    }
  }

  if (!judge) return { value: "-", source: "none" };

  console.log(`   ✅ "${productName}" → ${judge.value}`);
  if (judge.sourceUrl)   console.log(`      📎 출처: ${judge.sourceUrl}`);
  if (judge.usedSnippet) console.log(`      💬 스니펫: "${judge.usedSnippet.slice(0, 120)}"`);

  const finalResult: SpecLookupResult = {
    value: judge.value,
    source: "tavily",
    sourceUrl: judge.sourceUrl,
    usedSnippet: judge.usedSnippet,
    uncertain: false,
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
