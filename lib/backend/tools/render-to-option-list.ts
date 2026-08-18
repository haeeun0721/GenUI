import { tool, generateText } from "ai";
import { z } from "zod";
import { anthropic } from "@ai-sdk/anthropic";
import { generateUISpec } from "../agents/ui_agent";
import { type ProductData, reRankByAI, RAG_NOT_FOUND, type RankedProduct } from "../agents/data_agent";
import { ragSearch, checkDbCoverage } from "../rag/search";
import { enrichContextWithTavily } from "../services/spec-lookup";
import { time } from "../timing";
import {
  currentRequestId,
  pushOptionListResult,
  currentUserContext,
  currentSavedItems,
  currentDecisionCriteria,
  currentProductCategory,
  currentLocale,
  currentComparisonTableCells,
} from "./sidebar-store";

// ---------------------------------------------------------------------------
// Helper: parse + push UI spec JSON
// ---------------------------------------------------------------------------

// 카드에 안정적인 id를 부여한다 — LLM이 "<unique_id>"로 자체 생성한 값은 매 호출마다
// 새로 지어내는 것이라 턴을 넘나드는 재식별에 못 쓴다(ComparisonTable의 crit_N/prod_N,
// CriteriaMap의 cat_N/item_N과 동일한 이유). 여기서 항상 실제 고유값으로 덮어쓴다.
function stampCardIds(uiSpec: any): any {
  if (Array.isArray(uiSpec?.props?.cards)) {
    const stamp = Date.now();
    uiSpec.props.cards.forEach((card: any, i: number) => {
      card.id = `card-${stamp}-${i}`;
    });
  }
  return uiSpec;
}

function parseAndPush(uiSpecString: string): any {
  const firstBrace = uiSpecString.indexOf("{");
  if (firstBrace !== -1) {
    let lastBrace = -1;
    let stack = 0;
    for (let i = firstBrace; i < uiSpecString.length; i++) {
      if (uiSpecString[i] === "{") stack++;
      if (uiSpecString[i] === "}") stack--;
      if (stack === 0) { lastBrace = i; break; }
    }
    if (lastBrace !== -1) {
      const uiSpec = stampCardIds(JSON.parse(uiSpecString.substring(firstBrace, lastBrace + 1)));
      if (currentRequestId) pushOptionListResult(currentRequestId, uiSpec);
      return uiSpec;
    }
  }
  const cleanStr = uiSpecString.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  const uiSpec = stampCardIds(JSON.parse(cleanStr));
  if (currentRequestId) pushOptionListResult(currentRequestId, uiSpec);
  return uiSpec;
}

// ---------------------------------------------------------------------------
// Step 1: Build enriched search keyword from criteria + category
// ---------------------------------------------------------------------------

// 다나와 검색은 카테고리 키워드만 사용.
// "한손폴딩", "가벼운" 같은 feature 키워드는 다나와 검색엔진이 처리 못함.
// feature 필터링은 AI Reranker가 스펙 데이터를 보고 처리.
const NOISE_WORDS = /추천해줘|추천|알려줘|찾아줘|보여줘|검색해줘|검색|구매|제품|상품|골라줘|뭐가 좋아|뭐가좋아/g;
const DANAWA_CATEGORY_MAP: [RegExp, string][] = [
  [/유모차|stroller|베이비카|pram/i, "유모차"],
  [/로봇\s*청소기|robot\s*vacuum|룸바/i, "로봇 청소기"],
  [/카메라|미러리스|dslr|camera|카메/i, "카메라"],
  [/에어프라이어|air\s*fryer/i, "에어프라이어"],
  [/노트북|laptop|맥북/i, "노트북"],
  [/청소기|vacuum/i, "청소기"],
  [/세탁기|washing\s*machine/i, "세탁기"],
  [/냉장고|refrigerator/i, "냉장고"],
  [/공기청정기|air\s*purifier/i, "공기청정기"],
];

function buildSearchKeyword(searchQuery: string, productCategory: string): string {
  // 1순위: 쿼리에서 카테고리 키워드 추출
  for (const [pattern, keyword] of DANAWA_CATEGORY_MAP) {
    if (pattern.test(searchQuery)) {
      console.log(`[buildSearchKeyword] "${searchQuery}" → "${keyword}" (카테고리 추출)`);
      return keyword;
    }
  }
  // 2순위: productCategory (온보딩에서 설정된 카테고리)
  if (productCategory) {
    console.log(`[buildSearchKeyword] "${searchQuery}" → "${productCategory}" (productCategory 사용)`);
    return productCategory;
  }
  // 3순위: 노이즈 제거 후 2단어
  const cleaned = searchQuery.replace(NOISE_WORDS, "").replace(/\s+/g, " ").trim();
  const fallback = cleaned.split(/\s+/).slice(0, 2).join(" ");
  console.log(`[buildSearchKeyword] "${searchQuery}" → "${fallback}" (fallback)`);
  return fallback;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const renderToOptionList = tool({
  description: "Render a ProductCardList UI component to the Option List panel. Use for Category 3 (Product Recommendation).",
  inputSchema: z.object({
    search_query: z
      .string()
      .describe("The user's search request (from [Decision Criteria :] tag if present)."),
    intent_summary: z
      .string()
      .describe("Brief description of the user's intent."),
    ui_intent_category: z
      .string()
      .nullable()
      .describe("Always 'ProductCardList' for Product Recommendation."),
  }),
  execute: async ({ search_query, intent_summary, ui_intent_category }) => {
    console.log(
      [
        "[Tool: renderToOptionList] CALLED",
        `  category     : ${ui_intent_category}`,
        `  intent       : ${intent_summary}`,
        `  search_query : ${search_query.slice(0, 100)}`,
        `  criteria     : [${currentDecisionCriteria.join(", ")}]`,
      ].join("\n")
    );

    const alreadyShownNames = currentSavedItems.map((item) => {
      const pipeIdx = item.indexOf("|");
      return pipeIdx !== -1 ? item.slice(0, pipeIdx).trim() : item.trim();
    });

    try {
      // ── Step 0: 기준 추출 + DB 커버리지 체크 ────────────────────────────
      // 검색바에 입력된 내용(search_query)만을 기준으로 사용.
      // search_query는 쉼표(,)로 기준이 구분되므로 괄호를 존중하며 분리.
      // e.g. "물걸레 기능, 흡입력 4500pa 이상" → ["물걸레 기능", "흡입력 4500pa 이상"]

      function splitSearchQuery(q: string): string[] {
        const cleaned = q.replace(/추천해줘|추천|알려줘|찾아줘|검색해줘/g, "").trim();
        // 괄호 안 쉼표는 무시하고 분리
        // 단, 숫자 사이의 쉼표(천 단위 구분자, e.g. 500,000)는 기준 구분자로 보지 않음
        const parts: string[] = [];
        let depth = 0, cur = "";
        for (let i = 0; i < cleaned.length; i++) {
          const ch = cleaned[i];
          if (ch === "(") { depth++; cur += ch; }
          else if (ch === ")") { depth--; cur += ch; }
          else if (ch === "," && depth === 0) {
            const prevChar = cur.slice(-1);
            const nextChar = cleaned[i + 1] ?? "";
            // 앞뒤 모두 숫자면 천 단위 구분자 → 그냥 이어붙임
            if (/\d/.test(prevChar) && /\d/.test(nextChar)) {
              cur += ch;
            } else {
              const t = cur.trim(); if (t) parts.push(t); cur = "";
            }
          }
          else { cur += ch; }
        }
        const t = cur.trim(); if (t) parts.push(t);
        // 쉼표 구분이 없는 경우 전체를 하나의 기준으로
        return parts.length > 0 ? parts : (cleaned ? [cleaned] : []);
      }

      const queryParts = splitSearchQuery(search_query);

      // 가격/예산 기준은 ragSearch의 하드 필터(parseConstraints)가 처리하므로
      // Coverage Check 대상에서 제외. 스펙 키에는 "예산"이 없어 항상 미커버로 오인됨.
      const PRICE_CRITERION_PATTERN = /예산|가격|만원|budget|price|\d+(?:,\d+)?원/i;

      // 브랜드명 기준도 Coverage Check 제외 — 스펙 키가 아니라 RAG가 brand 필드로 처리함
      const BRAND_CRITERION_PATTERN = /삼성|lg|로보락|샤오미|다이슨|드리미|에코백스|아이로봇|르판트|모바|eufy|bosch|irobot|neato|shark|roborock|dreame|ecovacs/i;

      // 정형 스펙 표현 판별 — 수치 단위 또는 알려진 스펙 키워드 포함 여부
      // 정성적 표현("신혼부부용", "디자인 예쁜")은 Coverage Check 없이 RAG+Reranker에 위임
      const NUMERIC_SPEC_PATTERN = /\d+\s*(pa|db|mah|rpm|cm|mm|kg|g|w|l|시간|분|초|℃)/i;
      const KNOWN_SPEC_FEATURE_PATTERN = /흡입력|소음|배터리|용량|무게|중량|물걸레|헤파|hepa|uv살균|자외선|장애물|lds|라이다|카펫|브러시|브러쉬|사용시간|충전시간|손떨림|4k|8k|iso|연사|셔터|블루투스|wi-?fi|gps|방진|방적|raw|log촬영|펫케어|엉킴방지|먼지엉킴|머리카락컷팅|직배수/i;
      function isStructuredSpecCriterion(text: string): boolean {
        return NUMERIC_SPEC_PATTERN.test(text) || KNOWN_SPEC_FEATURE_PATTERN.test(text);
      }

      const parsedCriteria = queryParts.map(part => {
        const words = part.trim().split(/\s+/);
        const nameOnly = words.slice(0, 2).join(" ");
        const isPriceCriterion = PRICE_CRITERION_PATTERN.test(part);
        const isBrandCriterion = BRAND_CRITERION_PATTERN.test(part);
        const isStructuredSpec = isStructuredSpecCriterion(part);
        console.log(`[DEBUG PriceRegex] part: "${part}", matches: ${isPriceCriterion}`);
        return { nameOnly, annotated: part.trim(), isPriceCriterion, isBrandCriterion, isStructuredSpec };
      });

      // 한국어 지배 텍스트인지 판단 (Coverage Check는 한국어 스펙 키워드만 대상)
      // 영어로 전달된 intent_summary 문장이 search_query로 들어오는 경우를 차단
      function isKoreanDominant(text: string): boolean {
        const koreanChars = (text.match(/[\uAC00-\uD7AF]/g) || []).length;
        const totalChars = text.replace(/\s/g, '').length;
        // 한국어 문자 비율이 15% 미만이면 영어로 받아들여 스킵
        return totalChars === 0 || koreanChars / totalChars >= 0.15;
      }

      // 정형 스펙 표현만 Coverage Check 대상 + 한국어 지배 텍스트만
      const specCriteria = parsedCriteria.filter(
        p => !p.isPriceCriterion && !p.isBrandCriterion && p.isStructuredSpec && isKoreanDominant(p.annotated)
      );
      const priceCriteria = parsedCriteria.filter(p => p.isPriceCriterion);
      const brandCriteria = parsedCriteria.filter(p => p.isBrandCriterion);
      const qualitativeCriteria = parsedCriteria.filter(
        p => !p.isPriceCriterion && !p.isBrandCriterion && !p.isStructuredSpec
      );

      if (priceCriteria.length > 0) {
        console.log(`[Coverage] 가격 기준은 하드 필터로 처리 (Coverage Check 제외): ${priceCriteria.map(p => p.annotated).join(", ")}`);
      }
      if (brandCriteria.length > 0) {
        console.log(`[Coverage] 브랜드 기준은 RAG가 처리 (Coverage Check 제외): ${brandCriteria.map(p => p.annotated).join(", ")}`);
      }
      if (qualitativeCriteria.length > 0) {
        console.log(`[Coverage] 정성적 표현은 RAG가 처리 (Coverage Check 제외): ${qualitativeCriteria.map(p => p.annotated).join(", ")}`);
      }

      const nameOnlyCriteria = specCriteria.map(p => p.nameOnly);
      const coverageResults = nameOnlyCriteria.length > 0
        ? checkDbCoverage(nameOnlyCriteria, currentProductCategory || "유모차")
        : [];

      // 커버된 기준의 annotated 버전(값 포함) → Reranker에 전달
      const coveredAnnotated = coverageResults
        .filter(r => r.covered)
        .map(r => specCriteria.find(p => p.nameOnly === r.criterion)?.annotated ?? r.criterion);

      const skippedCriteria = coverageResults
        .filter(r => !r.covered)
        .map(r => specCriteria.find(p => p.nameOnly === r.criterion)?.annotated ?? r.criterion);

      if (coverageResults.length > 0) {
        console.log(`\n\x1b[36m[Coverage Check] 반영: [${coveredAnnotated.join(", ")}] | 미반영: [${skippedCriteria.join(", ")}]\x1b[0m`);
      }

      // Coverage 결과와 무관하게 RAG는 항상 실행.
      // NOT_FOUND는 검색 이후 단계(RAG 결과 0개 또는 Reranker [-1])에서만 발생.
      // coveredAnnotated가 빈 배열이면 reRankByAI가 userQuery 원문으로 fallback.

      // ── Step 1: RAG 벡터 검색 ────────────────────────────────────────────
      console.log(`[renderToOptionList] RAG 검색: "${search_query}"`);
      const candidates: ProductData[] = await time("option_list.rag_search", currentRequestId ?? "", () =>
        ragSearch(
          `${search_query} ${intent_summary}`.trim(),
          currentProductCategory || "유모차",
          20,
          alreadyShownNames
        )
      );
      console.log(`[renderToOptionList] RAG 결과: ${candidates.length}개 후보`);

      let resolvedContext = "";

      if (candidates.length > 0) {
        // ── Step 2: AI Reranker — 정성적 기준만 전달 (가격/브랜드는 하드필터에서 이미 처리됨) ───────────
        const ranked = await time("option_list.rerank", currentRequestId ?? "", () =>
          reRankByAI(
            candidates,
            `${search_query} ${intent_summary}`.trim(),
            currentProductCategory,
            6,
            coveredAnnotated  // DB 커버 스펙 기준만 전달 (수치/가격/브랜드 조건은 하드필터에서 완료)
          )
        );

        // 커버 가능한 기준조차 0개인 경우 → 진짜 NOT_FOUND
        if (ranked === RAG_NOT_FOUND) {
          const notFoundDetail = skippedCriteria.length > 0
            ? `요청하신 기준 중 [${skippedCriteria.join(", ")}]에 해당하는 스펙 데이터가 로컬 DB에 없습니다.`
            : `요청하신 기능을 스펙에 명시한 제품 데이터가 로컬 DB에 없습니다.`;
          console.warn("[renderToOptionList] Feature not found in DB → returning NOT_FOUND response");
          return {
            type: "Empty",
            props: {},
            _ragNotFound: true,
            _ragNotFoundMessage: notFoundDetail,
            _skippedCriteria: skippedCriteria,
          };
        }

        if (ranked.length > 0) {
          const selectedProducts = ranked.map((r) => candidates[r.index]);

          // Coverage 매칭 키 + 정성 기준 키워드 → UI Agent에 보낼 관련 스펙만 추출
          const relevantSpecKeys = coverageResults.flatMap(r => r.matchedKeys);
          const MAX_SPECS = 10;

          function filterSpecsForUI(specs: string[]): string[] {
            // 1순위: Coverage 매칭 스펙 (사용자가 명시한 조건)
            const matched = specs.filter(spec => {
              const key = spec.split(":")[0].trim();
              return relevantSpecKeys.some(rk =>
                key.includes(rk) || rk.includes(key)
              );
            });
            // 2순위: 나머지 상위 스펙으로 빈 슬롯 채우기
            const others = specs.filter(s => !matched.includes(s));
            return [...matched, ...others.slice(0, Math.max(0, MAX_SPECS - matched.length))];
          }

          const contexts = selectedProducts.map((p, i) => {
            const filteredSpecs = filterSpecsForUI(p.specs);
            return [
              `[Product ${i + 1}]`,
              `Name: ${p.name}`,
              `Price: ${p.price}`,
              `Brand: ${p.brand}`,
              `Image: ${p.image}`,
              `Link: ${p.link}`,
              `Specs: ${filteredSpecs.length > 0 ? filteredSpecs.join(" / ") : "정보 없음"}`,
              `Description: ${p.description || "정보 없음"}`,
            ].join("\n");
          });
          resolvedContext = contexts.join("\n\n");
        }

      }

      // ── Step 3: DB 미커버 기준 → Tavily 웹 검색으로 보강 ─────────────────
      // ComparisonTable(render-to-comp-table.ts)과 동일한 파이프라인: DB에서 먼저
      // 찾고, 없는 기준만 Tavily로 검색해 검증된 값을 WebSpecs로 덧붙인다. 이렇게
      // 하지 않으면 카드 생성 LLM이 부족한 스펙을 자기 사전지식으로 메꿔서, 같은
      // 제품의 같은 필드가 비교표와 카드에서 다르게 표시되는 문제가 생긴다.
      if (resolvedContext.trim() && currentDecisionCriteria.length > 0) {
        console.log(`[renderToOptionList] DB→Tavily 보강 시작 (기준: ${currentDecisionCriteria.join(", ")})`);
        const { enriched } = await time("option_list.tavily_enrich", currentRequestId ?? "", () =>
          enrichContextWithTavily(
            resolvedContext,
            currentDecisionCriteria,
            currentProductCategory || "유모차",
            currentLocale,
            currentComparisonTableCells
          )
        );
        resolvedContext = enriched;
      }

      // ── RAG 결과 없음 (카테고리 DB 자체가 없는 경우) ─────────────────────
      if (!resolvedContext.trim()) {
        console.warn("[renderToOptionList] RAG 결과 없음. 카테고리 데이터를 먼저 크롤링하세요.");
        return {
          type: "Empty",
          props: {},
          _ragNotFound: true,
          _ragNotFoundMessage:
            `"${currentProductCategory || search_query}" 카테고리 데이터가 로컬 DB에 없습니다. ` +
            `카테고리 크롤링 후 다시 시도해 주세요.`,
        };
      }

      // ── Step 4: UI Agent → ProductCardList ─────────────────────────────────
      const uiSpecString = await time("option_list.ui_agent", currentRequestId ?? "", () =>
        generateUISpec(
          resolvedContext,
          intent_summary,
          ui_intent_category,
          1,
          currentUserContext,
          currentSavedItems,
          currentDecisionCriteria
        )
      );

      console.log(`[renderToOptionList] UI Agent 응답 (앞 200자): ${uiSpecString?.slice(0, 200)}`);

      if (uiSpecString && !uiSpecString.startsWith("ERROR:")) {
        // Case 2: 일부 기준 미반영 → CoverageNotice를 제품 카드 앞에 push
        // 조건: 적어도 하나는 반영되고(coveredAnnotated.length > 0) 하나는 미반영(skippedCriteria.length > 0)
        // 전체 미반영 또는 전체 반영이면 표시 안 함
        if (skippedCriteria.length > 0 && coveredAnnotated.length > 0) {
          const coverageNoticeSpec = {
            type: "CoverageNotice",
            props: {
              appliedCriteria: coveredAnnotated,
              skippedCriteria: skippedCriteria,
            },
          };
          if (currentRequestId) pushOptionListResult(currentRequestId, coverageNoticeSpec);
          console.log(`\x1b[33m[renderToOptionList] CoverageNotice push: 미반영 [${skippedCriteria.join(", ")}]\x1b[0m`);
        }

        const parsed = parseAndPush(uiSpecString);
        // 이 리스트를 만들 때 쓴 검색 제약(예: "흡입력 4,500pa 이상")을 리스트 자체에 붙여
        // 화면 상태의 일부로 계속 들고 다닌다 — 나중에 "다른 브랜드도 보여줘" 같은 후속
        // add 요청이 왔을 때, Edit Agent가 대화 히스토리 없이도(원래 못 봄) 이 필드를 그대로
        // 읽어서 하드필터를 유지할 수 있다. 안 그러면 이 제약은 이 턴이 지나면 화면 어디에도
        // 안 남아서 다음 턴부터는 사라진다.
        parsed._searchQuery = search_query;
        if (skippedCriteria.length > 0) {
          parsed._skippedCriteria = skippedCriteria;
          parsed._appliedCriteria = coveredAnnotated;
          parsed._coverageSummary =
            `${coveredAnnotated.join(", ")} 기준은 반영해서 추천했지만, ` +
            `${skippedCriteria.join(", ")}은(는) 현재 DB에 스펙 데이터가 없어서 이번 추천에 반영하지 못했어요.`;
        }
        return parsed;
      }

      console.error("[renderToOptionList] UI Agent ERROR 응답:", uiSpecString);
      return { error: uiSpecString };
    } catch (err) {
      console.error("[Tool: renderToOptionList] Error:", err);
      return { error: `오류: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
