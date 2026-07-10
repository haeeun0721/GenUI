import { tool, generateText } from "ai";
import { z } from "zod";
import { anthropic } from "@ai-sdk/anthropic";
import { generateUISpec } from "../agents/ui_agent";
import { type ProductData, reRankByAI, RAG_NOT_FOUND, type RankedProduct } from "../agents/data_agent";
import { ragSearch, checkDbCoverage } from "../rag/search";
import {
  currentRequestId,
  pushOptionListResult,
  currentUserContext,
  currentSavedItems,
  currentDecisionCriteria,
  currentProductCategory,
} from "./sidebar-store";

// ---------------------------------------------------------------------------
// Helper: parse + push UI spec JSON
// ---------------------------------------------------------------------------

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
      const uiSpec = JSON.parse(uiSpecString.substring(firstBrace, lastBrace + 1));
      if (currentRequestId) pushOptionListResult(currentRequestId, uiSpec);
      return uiSpec;
    }
  }
  const cleanStr = uiSpecString.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  const uiSpec = JSON.parse(cleanStr);
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
  [/유모차|stroller|베이비카|pram/i,          "유모차"],
  [/로봇\s*청소기|robot\s*vacuum|룸바/i,      "로봇 청소기"],
  [/카메라|미러리스|dslr|camera|카메/i,       "카메라"],
  [/에어프라이어|air\s*fryer/i,               "에어프라이어"],
  [/노트북|laptop|맥북/i,                     "노트북"],
  [/청소기|vacuum/i,                          "청소기"],
  [/세탁기|washing\s*machine/i,               "세탁기"],
  [/냉장고|refrigerator/i,                    "냉장고"],
  [/공기청정기|air\s*purifier/i,              "공기청정기"],
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
      .describe("Always '3' for Product Recommendation."),
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
      const PRICE_CRITERION_PATTERN = /예산|가격|만원|원\s*(이하|이상|미만|초과)|budget|price/i;

      const parsedCriteria = queryParts.map(part => {
        // 첫 번째 단어(또는 2단어)를 nameOnly로, 전체를 annotated로
        const words = part.trim().split(/\s+/);
        const nameOnly = words.slice(0, 2).join(" ");  // 최대 2단어를 키로
        const isPriceCriterion = PRICE_CRITERION_PATTERN.test(part);
        return { nameOnly, annotated: part.trim(), isPriceCriterion };
      });

      // 가격 기준은 Coverage Check에서 제외 (RAG 하드 필터가 담당)
      const specCriteria = parsedCriteria.filter(p => !p.isPriceCriterion);
      const priceCriteria = parsedCriteria.filter(p => p.isPriceCriterion);

      if (priceCriteria.length > 0) {
        console.log(`[Coverage] 가격 기준은 하드 필터로 처리 (Coverage Check 제외): ${priceCriteria.map(p => p.annotated).join(", ")}`);
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

      // ── Case 1: 검색 기준이 전부 DB에 없을 때 → 즉시 NOT_FOUND 반환 ────
      // Reranker를 실행하면 userQuery fallback으로 관련 없는 제품이 뜰 수 있어서 차단
      if (coverageResults.length > 0 && coveredAnnotated.length === 0) {
        console.warn("[renderToOptionList] 커버된 기준 0개 → 즉시 NOT_FOUND 반환");
        const notFoundMessage =
          `검색하신 기준 [${skippedCriteria.join(", ")}]에 해당하는 스펙 데이터가 현재 로컬 DB에 없습니다. ` +
          `더 일반적인 조건으로 다시 검색해보시거나, 해당 기능에 대해 질문해 주세요.`;

        // 패널에 RagNotFound 컴포넌트 push → Option List에 실제로 렌더링됨
        const ragNotFoundSpec = {
          type: "RagNotFound",
          props: {
            message: notFoundMessage,
            skippedCriteria: skippedCriteria,
          },
        };
        if (currentRequestId) pushOptionListResult(currentRequestId, ragNotFoundSpec);

        return {
          type: "RagNotFound",
          props: ragNotFoundSpec.props,
          _ragNotFound: true,
          _skippedCriteria: skippedCriteria,
          _ragNotFoundMessage: notFoundMessage,
        };
      }


      // ── Step 1: RAG 벡터 검색 ────────────────────────────────────────────
      console.log(`[renderToOptionList] RAG 검색: "${search_query}"`);
      const candidates: ProductData[] = await ragSearch(
        `${search_query} ${intent_summary}`.trim(),
        currentProductCategory || "유모차",
        20,
        alreadyShownNames
      );
      console.log(`[renderToOptionList] RAG 결과: ${candidates.length}개 후보`);

      let resolvedContext = "";

      if (candidates.length > 0) {
        // ── Step 2: AI Reranker (부분 매칭 점수제) ──────────────────────────
        const ranked = await reRankByAI(
          candidates,
          `${search_query} ${intent_summary}`.trim(),
          currentProductCategory,
          6,
          coveredAnnotated  // 세부값 포함된 annotated 기준을 Reranker에 전달
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
          const contexts = selectedProducts.map((p, i) => {
            const r = (ranked as RankedProduct[])[i];
            return [
              r.reason ? `[선택 이유: ${r.reason}]` : "",
              r.appliedCriteria.length > 0 ? `[반영된 기준: ${r.appliedCriteria.join(", ")}]` : "",
              `Name: ${p.name}`,
              `Price: ${p.price}`,
              `Brand: ${p.brand}`,
              `Image: ${p.image}`,
              `Link: ${p.link}`,
              `Specs: ${p.specs.length > 0 ? p.specs.join(" / ") : "정보 없음"}`,
              `Description: ${p.description || "정보 없음"}`,
            ].filter(Boolean).join("\n");
          });
          resolvedContext = contexts.join("\n\n");
        }
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
      const uiSpecString = await generateUISpec(
        resolvedContext,
        intent_summary,
        ui_intent_category,
        1,
        currentUserContext,
        currentSavedItems,
        currentDecisionCriteria
      );

      console.log(`[renderToOptionList] UI Agent 응답 (앞 200자): ${uiSpecString?.slice(0, 200)}`);

      if (uiSpecString && !uiSpecString.startsWith("ERROR:")) {
        // Case 2: 일부 기준 미반영 → CoverageNotice를 제품 카드 앞에 push
        if (skippedCriteria.length > 0) {
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
