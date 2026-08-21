/**
 * lib/backend/agents/chat_agent.ts
 * Baseline Chat Agent — Option B ablation.
 *
 * treatment(main)의 action_router → template_selector → generator 파이프라인을 그대로
 * 재사용한다 (같은 모델 claude-haiku-4-5, 같은 판단 로직, 같은 user_context 사용 범위).
 * 유일한 차이는 마지막 출력 형식뿐이다: JSON UI 스키마 대신 단일 선형 채팅 텍스트로
 * 스트리밍한다. 패널이 없으므로 screen_state는 항상 비어있고, action_router가 그래도
 * "edit"를 고르는 극단적인 경우엔 generate와 동일하게 처리한다(수정할 패널 자체가 없으므로
 * conversation_history를 참고한 새 답변으로 자연스럽게 대체됨).
 */

import { streamText, generateText, generateObject, stepCountIs, tool, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { currentProductCategory, currentUserContext } from "../tools/sidebar-store";
import { ragSearch, findExactProduct } from "../rag/search";
import { reRankByAI, RAG_NOT_FOUND, tavilySearchSnippet, type ProductData } from "./data_agent";
import { analyzeIntent, type IntentAnalysis } from "./intent_analyzer";
import { routeAction, type ScreenState } from "./action_router";
import { selectTemplate } from "./template_selector";
import { buildCriteriaMapSystemText, buildCriteriaMapPromptText } from "./generators/criteria_map";
import { buildInformationCardSystemText, buildInformationCardPromptText } from "./generators/information_card";
import { buildProductCardListSystemText, buildProductCardListPromptText } from "./generators/product_card_list";
import { buildComparisonTableSystemText, buildComparisonTablePromptText } from "./generators/comp_table_lite";
import { buildCommonSystemInstructionsText } from "./generators/shared";

export type Locale = "ko" | "en";

// main과 동일 모델 — task-type별로 나뉘지 않고 action_router/template_selector/generator가
// 전부 이 모델 하나다(main도 최근 전체를 claude-haiku-4-5로 통일했음).
const CHAT_MODEL = "claude-haiku-4-5";

const EMPTY_SCREEN_STATE: ScreenState = {
  hasOptionList: false,
  hasComparisonTable: false,
  hasCriteriaMap: false,
};

// ---------------------------------------------------------------------------
// 공용 제품 검색 — main의 findExactMatchingProduct 같은 정밀 매칭 대신 ragSearch+
// reRankByAI(로컬 DB 시맨틱 검색 + AI 재정렬)로 근사한다. ProductCardList/ComparisonTable
// 양쪽에서 재사용.
// ---------------------------------------------------------------------------
async function searchProducts(query: string, count = 6): Promise<ProductData[]> {
  const category = currentProductCategory;
  if (!category) return [];
  const candidates = await ragSearch(query, category, 20);
  if (candidates.length === 0) return [];
  const ranked = await reRankByAI(candidates, query, category, count);
  if (ranked === RAG_NOT_FOUND) return [];
  return ranked.map((r) => candidates[r.index]);
}

// ---------------------------------------------------------------------------
// ComparisonTable 전용 정밀 매칭 — main은 rag/search.ts의 findExactProduct로 사용자가
// 채팅에 직접 쓴 정확한 제품명을 결정론적으로 대조하는데, baseline은 이 기능이 없어서
// "DC-S5"와 "DC-S9" 두 제품을 정확히 지목해도 임베딩 검색+AI 재랭킹만 거치다가 이름이
// 비슷한 제3의 제품(예: "DC-S5 II")까지 같이 뽑혀 나오는 문제가 있었다. 사용자가 비교
// 대상으로 명명한 제품명을 먼저 추출해, 전부 정확히 매칭되면 임베딩 검색을 아예 생략하고
// 그 제품들만 정확히 반환한다 — main의 정밀도를 그대로 재현.
// ---------------------------------------------------------------------------
async function extractNamedProducts(userText: string): Promise<string[]> {
  const { text } = await generateText({
    model: anthropic(CHAT_MODEL),
    system:
      "Extract the exact product names/models the user explicitly named for comparison in their message. " +
      "Copy each name in FULL, exactly as the user wrote it — never shorten or abbreviate it to just a model " +
      "code. For example, if the user wrote '파나소닉 루믹스 DC-S5 바디', output that entire phrase, NOT just " +
      "'DC-S5' or 'S5' — a shortened code can accidentally match a different variant (e.g. 'DC-S5 II') that " +
      "the user did not name. Output a JSON array of the full name strings as written, one per product. If the " +
      "user did not name specific products (e.g. they just asked for a general recommendation), output []. " +
      "JSON array only, no explanation.",
    prompt: userText,
    temperature: 0,
    maxOutputTokens: 200,
  });
  const first = text.indexOf("[");
  const last = text.lastIndexOf("]");
  if (first === -1 || last === -1) return [];
  try {
    const parsed = JSON.parse(text.slice(first, last + 1));
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

async function searchProductsForComparison(searchQuery: string, count: number): Promise<ProductData[]> {
  const category = currentProductCategory;
  if (category) {
    // searchQuery는 이미 intentGoal(대화 맥락이 반영된 자기완결적 문장)을 우선 쓰므로,
    // "로보락도 같이 비교해줘" 같은 추가 요청이어도 이전 턴에서 언급된 제품명까지 여기서
    // 같이 추출된다.
    const namedProducts = await extractNamedProducts(searchQuery);
    if (namedProducts.length >= 2) {
      const exactMatches = namedProducts.map((name) => findExactProduct(name, category));
      if (exactMatches.every((m): m is ProductData => m !== null)) {
        return exactMatches;
      }
    }
  }
  return searchProducts(searchQuery, count);
}

// baseline은 이미지 렌더링 UI가 없는 순수 텍스트 채팅 파이프라인이라, 애초에 모델에게
// 이미지 URL을 노출하지 않는다 — 노출하면 채팅 답변 텍스트에 원본 URL을 그대로 인용해
// Streamdown이 이미지를 렌더링해버리는 문제가 있었다.
function formatProductLine(p: ProductData): string {
  const specs = p.specs.slice(0, 12).join(", ") || "스펙 정보 없음";
  return `- ${p.name} (${p.price})\n  Specs: ${specs}`;
}

// ---------------------------------------------------------------------------
// ComparisonTable 전용 grounding 보강 — main의 renderToCompTable은 CriteriaMap 칩으로
// "고정된" decision_criteria와, 로컬 DB가 못 커버하는 기준을 Tavily로 실시간 검증하는
// enrichCompTableCells를 거친다. baseline엔 칩을 고정하는 UI 자체가 없으므로 그 상호작용을
// 흉내내는 대신, 이번 턴 메시지에 사용자가 실제로 명시한 기준을 직접 추출해 같은 역할을
// 하게 한다 — main과 100% 같은 알고리즘은 아니지만, "사용자가 말한 기준을 무시한 채 로컬
// DB 스펙만으로 판단"하던 이전 상태의 grounding 격차는 해소한다.
// ---------------------------------------------------------------------------
async function extractDecisionCriteria(userText: string): Promise<string[]> {
  const { text } = await generateText({
    model: anthropic(CHAT_MODEL),
    system:
      "Extract explicit purchase decision criteria the user stated in their message — a minimum/maximum spec " +
      "value, a required feature, a brand preference, etc. Output a JSON array of short criteria phrases in the " +
      "same language as the message, e.g. [\"흡입력 4500pa 이상\", \"물걸레 기능\"]. If the user stated no specific " +
      "criteria (e.g. they just said \"추천해줘\" with no conditions), output []. JSON array only, no explanation.",
    prompt: userText,
    temperature: 0,
    maxOutputTokens: 200,
  });
  const first = text.indexOf("[");
  const last = text.lastIndexOf("]");
  if (first === -1 || last === -1) return [];
  try {
    const parsed = JSON.parse(text.slice(first, last + 1));
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

// 기준 문구의 앞쪽 키워드(괄호 조건 이전)만 로컬 스펙 텍스트에 대한 대략적인 커버리지
// 판정에 쓴다 — main의 computeSpecCoverage(동의어 사전 기반)만큼 정교하진 않지만, "이미
// 스펙에 있는 기준까지 불필요하게 웹 검색하지 않는다"는 목적엔 충분하다.
function decisionCriterionKeyword(criterion: string): string {
  return criterion.split(/[(（]/)[0].trim().split(/\s+/)[0] ?? "";
}

// main의 lookupProductSpec/extractCellValueLight는 Tavily 스니펫을 그대로 믿지 않고,
// "이 값이 정말 이 제품 얘기가 맞는지, 비교 중인 다른 제품과 헷갈린 건 아닌지"를 LLM으로
// 한 번 더 검증한다(SiblingGuard). baseline은 지금까지 Tavily 스니펫 전체를 검증 없이
// 그대로 스펙 줄에 꽂아넣었는데, 같은 웹페이지에 여러 모델이 같이 언급되면 다른 제품의
// 값을 이 제품 것으로 착각해 가져올 위험이 있다. main의 검증 파이프라인 전체(500줄+,
// classifyFieldApplicability/getSiblingExcludeTokens 등 main 고유 상태에 깊이 얽혀있음)를
// 그대로 포팅하기엔 범위가 너무 커서, 핵심 아이디어(다른 후보 제품명을 "헷갈리지 말 것"으로
// 명시하고 LLM이 스니펫에서 값을 추출하게 하는 것)만 축소해서 재현한다.
async function verifyWebSpecValue(
  productName: string,
  criterion: string,
  snippet: string,
  siblingNames: string[]
): Promise<string | null> {
  const siblingNote = siblingNames.length > 0
    ? ` 지금 비교 중인 다른 제품(${siblingNames.join(", ")})과 절대 혼동하지 마세요 — 이 텍스트가 명확히 "${productName}" 자체에 대한 내용일 때만 값을 반환하세요.`
    : "";
  try {
    const { object } = await generateObject({
      model: anthropic(CHAT_MODEL),
      schema: z.object({
        value: z.string().describe(`텍스트에 명시된 "${productName}"의 "${criterion}" 값. 텍스트가 이 제품 얘기가 아니거나 이 기준을 언급 안 하면 "-".`),
      }),
      system: `주어진 텍스트만 보고 답하세요. 다른 지식이나 추측을 쓰지 마세요.${siblingNote}`,
      prompt: `텍스트: ${snippet}\n\n질문: "${productName}"의 "${criterion}"는 무엇인가요?`,
      temperature: 0,
    });
    return object.value && object.value !== "-" ? object.value : null;
  } catch {
    return null;
  }
}

async function enrichProductsWithWebSpecs(
  products: ProductData[],
  decisionCriteria: string[]
): Promise<ProductData[]> {
  if (decisionCriteria.length === 0) return products;

  return Promise.all(
    products.map(async (p) => {
      const specsBlob = p.specs.join(" ");
      const uncovered = decisionCriteria.filter((c) => {
        const keyword = decisionCriterionKeyword(c);
        return keyword.length > 0 && !specsBlob.includes(keyword);
      });
      if (uncovered.length === 0) return p;

      // 지금 같이 비교 중인 다른 제품명 — SiblingGuard처럼 검증 단계에서 "이것들과
      // 헷갈리지 말라"는 경고로 전달한다.
      const siblingNames = products.filter((other) => other.id !== p.id).map((other) => other.name);

      const webSpecs = await Promise.all(
        uncovered.map(async (c) => {
          const result = await tavilySearchSnippet(`${p.name} ${c}`);
          if (!result) return null;
          const verifiedValue = await verifyWebSpecValue(p.name, c, result.snippet, siblingNames);
          if (!verifiedValue) return null;
          return `WebSpecs (from web search) — ${c}: ${verifiedValue}`;
        })
      );
      const found = webSpecs.filter((s): s is string => Boolean(s));
      return found.length > 0 ? { ...p, specs: [...p.specs, ...found] } : p;
    })
  );
}

function extractText(msg: ModelMessage | undefined): string {
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p.text)
      .join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// "none" 경로 — action_router가 순수 대화형 응답으로 판단했을 때. main의 chat_agent.ts
// (action=none 전용 fallback)와 같은 성격이지만, baseline엔 spec-lookup.ts 파이프라인이
// 없어 동일한 lookupProductSpec 툴 대신 기존에 있던 search_products/web_search 툴을
// 재사용한다.
// ---------------------------------------------------------------------------
const searchProductsTool = tool({
  description:
    "Search the product database for items matching the user's needs (budget, brand, use case, features, etc). " +
    "Always use this when the user asks to see, find, recommend, or compare products — never answer from memory or make up products. " +
    "Returns a shortlist of real, in-database products with their price and specs, or says nothing matched.",
  inputSchema: z.object({
    query: z
      .string()
      .describe("A natural-language description of what to search for, e.g. '20만원 이하 흡입력 좋은 로봇청소기'"),
    count: z.number().int().min(1).max(10).optional(),
  }),
  execute: async ({ query, count }) => {
    const products = await searchProducts(query, count ?? 6);
    if (products.length === 0) return "데이터베이스에서 조건에 맞는 제품을 찾지 못했습니다.";
    return products.map(formatProductLine).join("\n");
  },
});

const webSearchTool = tool({
  description:
    "Search the web to fill in a spec value that search_products didn't return for a product you already found, " +
    "or to answer something that isn't a product database search at all (reviews, usage tips, general buying advice). " +
    "Do NOT use this to find alternative products when search_products found nothing — in that case just tell the user the database has no match.",
  inputSchema: z.object({
    query: z.string().describe("A natural-language web search query."),
  }),
  execute: async ({ query }) => {
    const result = await tavilySearchSnippet(query);
    // main의 webSearch 툴(chat_agent.ts)과 동일하게, 사람이 읽기 좋은 "(출처: url)" 문장으로
    // 가공하지 않고 원본 스니펫만 반환한다 — main은 출처 URL을 사용자에게 그렇게까지 드러내지
    // 않으므로, baseline만 더 투명하게 보여주면 RQ3(인터페이스 신뢰도 등)에 인터페이스 구조와
    // 무관한 차이를 만들 수 있다.
    if (!result) return "검색 결과 없음";
    return result.snippet;
  },
});

const buildNoneSystem = (locale: Locale, productCategory: string): string => {
  if (locale === "en") {
    return `
[Role]
You are a shopping assistant who helps${productCategory ? ` first-time ${productCategory} buyers` : " shoppers"} by answering their questions directly in natural, conversational English — no UI component is created or changed on this turn, you are the plain-reply fallback.

[Task]
- Answer the user's message naturally and helpfully in English, in a single flowing chat reply.
- Use conversation_history to correctly resolve pronouns or references to earlier turns.
- Call search_products whenever the user wants to see, find, compare, or get recommendations for real products. Ground your answer in the tool's actual results — cite real product names, prices, and specs from it. Never invent products, prices, or specs. If it finds nothing, tell the user the database has no match — do NOT call web_search to find a substitute product.
- Call web_search only to fill in a specific spec/detail search_products didn't return for a product you already found, or to answer something that isn't a product search at all (reviews, general buying advice).
- Use markdown when it makes the answer easier to scan: bullet lists for multiple items, a table for side-by-side comparisons, ** for key terms. Don't force it on a short, simple answer — plain sentences are fine there.
- If you group products into price tiers or state a price range, write the full amount with every digit exactly as it appears in the tool's price field (e.g. a product priced 1,590,000 belongs in a tier labeled "1,500,000 and up", never a truncated "1,500 and up"). Never drop trailing zeros when abbreviating a price range.
- Never mention tools, databases, or internal system behavior explicitly.

[Output]
Plain text English reply only. No JSON, no structured format.
`.trim();
  }

  return `
[Role]
당신은 ${productCategory ? `처음 ${productCategory}를 구매하는 사람` : "쇼핑객"}을 돕는 친절한 쇼핑 어시스턴트입니다 — 이번 턴은 UI를 새로 만들거나 바꾸지 않는, 순수 답변만 담당하는 턴입니다.

[Task]
- user_message에 자연스럽고 친절한 한국어로, 하나의 흐르는 채팅 답변으로 답하세요.
- conversation_history를 참고해 대명사나 이전 턴에 대한 언급을 올바르게 해석하세요.
- 사용자가 제품을 보거나, 찾거나, 비교하거나, 추천받고 싶어할 때는 반드시 search_products를 호출하세요. 답변은 도구가 실제로 반환한 결과에 근거해야 하며, 실제 제품명·가격·스펙을 인용하세요. 제품, 가격, 스펙을 절대 지어내지 마세요. 아무것도 못 찾으면 DB에 맞는 게 없다고 솔직히 말하고, 대체 제품을 찾으려고 web_search를 호출하지 마세요.
- 사용자의 메시지가 "더 저렴한 거 있어?", "이미지도 보여줘", "다른 것도 있어?"처럼 이전 턴을 전제로 한 짧은 후속 요청이면, 그 문장 그대로를 검색어로 쓰지 말고 conversation_history에서 관련된 이전 조건(용도, 예산, 스펙 기준 등)을 찾아 이번 요청과 합쳐 하나의 완전한 검색어로 재구성한 뒤 search_products를 호출하세요 (예: "더 저렴한 거 있어?" + 이전에 언급된 "흡입력 3,000pa 이상" → "흡입력 3,000pa 이상, 저렴한 로봇청소기"). search_products가 그래도 아무것도 못 찾으면 그 조건에 맞는 게 DB에 없다고 솔직히 말하세요. 이전 턴에 언급된 제품들의 스펙을 의심하거나, 사용자에게 검색 결과·제품 데이터를 대신 달라고 요청하지 마세요 — 검색은 항상 당신이 도구로 직접 다시 수행해야 합니다.
- web_search는 이미 찾은 제품의 특정 스펙/디테일이 빠졌을 때 그것만 보강하거나, 애초에 제품 검색이 아닌 질문(리뷰, 일반적인 구매 조언 등)에 답할 때만 쓰세요.
- 여러 항목을 나열하거나 비교할 때는 마크다운(목록, 표, **강조**)을 활용해 보기 좋게 정리하세요. 짧고 단순한 답변은 이전처럼 자연스러운 대화체 문장만으로도 괜찮습니다.
- 제품을 가격대별로 묶거나 가격 범위를 언급할 때는 도구가 반환한 price 값의 자릿수를 그대로 살려 전체 금액을 쓰세요 (예: 1,590,000원짜리 제품이 속한 구간은 "1,500,000원대 이상"이라고 써야 하며, 뒤의 "000"을 빠뜨려 "1,500원대"처럼 줄여 쓰면 안 됩니다). 가격대를 요약해서 표현하더라도 자릿수(뒤에 붙는 0)를 절대 생략하지 마세요.
- 도구, 데이터베이스, 내부 동작을 직접 언급하지 마세요.

[Output]
순수 텍스트(plain text) 한국어 응답만 출력하세요. JSON이나 구조화된 포맷은 사용하지 않습니다.
`.trim();
};

// ---------------------------------------------------------------------------
// "generate" 경로 — template_selector가 고른 템플릿에 맞는 텍스트 전용 시스템/프롬프트를
// 구성한다. user_context는 main의 실제 사용 범위와 동일하게, CriteriaMap/ComparisonTable
// 에만 주입한다(InformationCard/ProductCardList는 main에서도 원래 user_context를 쓰지
// 않음).
// ---------------------------------------------------------------------------
// null 반환 = "이 템플릿으로는 답할 데이터가 없다" → 호출부가 none 경로로 대체 처리.
// ProductCardList/ComparisonTable은 매 턴 raw user text로 새로 검색하는데(패널 상태가 없어
// "아까 그 제품들" 같은 참조를 재사용 못함), 그 텍스트가 실제 검색어가 아닌 경우(예: "이미지도
// 보여줄 수 있어?" 같은 능력/후속 질문)는 검색이 0건으로 나온다. 이때 그대로 "검색 결과 없음,
// 조건 조정해보세요"라는 정형 답변을 강제하면 엉뚱한 되물음이 나가므로, 대화 맥락을 아는
// none 경로(search_products 툴 포함)로 넘겨 자연스럽게 답하게 한다.
// ProductCardList/ComparisonTable의 제품 검색어로 무엇을 쓸지 — 패널 상태가 없어 매 턴
// RAG를 새로 돌리는 baseline 특성상, "로보락도 같이 비교해줘"처럼 이전 턴에서 언급된
// 제품을 전제로 한 추가 요청은 이번 턴 원문만으로는 검색이 안 된다. intent_analyzer는
// conversation_history를 이미 반영해 "드리미 A, 드리미 B, 로보락 C 세 제품을 비교"처럼
// 자기완결적인 문장을 만들어주므로, 원문 대신 이 문장을 검색어로 써서 이전에 언급된
// 제품까지 함께 검색되게 한다.
function searchQueryFor(userText: string, intentGoal: string): string {
  return intentGoal.trim() || userText;
}

async function buildGenerateTurn(
  locale: Locale,
  template: "CriteriaMap" | "InformationCard" | "ComparisonTable" | "ProductCardList",
  userText: string,
  intentGoal: string
): Promise<{ system: string; prompt: string } | null> {
  const productCategory = currentProductCategory;
  const userContext = currentUserContext;
  const searchQuery = searchQueryFor(userText, intentGoal);

  switch (template) {
    case "CriteriaMap":
      return {
        system: buildCriteriaMapSystemText(locale),
        prompt: buildCriteriaMapPromptText(userText, userContext, ""),
      };

    case "InformationCard":
      return {
        system: buildInformationCardSystemText(locale),
        prompt: buildInformationCardPromptText(userText),
      };

    case "ProductCardList": {
      const products = await searchProducts(searchQuery, 6);
      if (products.length === 0) return null;
      return {
        system: [buildCommonSystemInstructionsText(productCategory, locale), buildProductCardListSystemText(locale)].join(
          "\n\n"
        ),
        prompt: buildProductCardListPromptText(products.map(formatProductLine).join("\n")),
      };
    }

    case "ComparisonTable": {
      const products = await searchProductsForComparison(searchQuery, 4);
      if (products.length === 0) return null;
      // decision_criteria는 CriteriaMap 칩을 고정하는 UI가 없으므로, 이번 턴 메시지에서
      // 직접 추출한다. 로컬 DB 스펙에 없는 기준은 Tavily로 보강해 main의 renderToCompTable
      // 이 하는 grounding(칩 고정 + enrichCompTableCells)과 같은 역할을 하게 한다.
      // searchQuery(intentGoal 우선)를 써서, "3000pa 이상 원해"(이전 턴) → "이 두 개 비교해줘"
      // (이번 턴, 기준 재언급 없음) 같은 경우에도 이전에 말한 기준이 Tavily 보강 대상에서
      // 빠지지 않게 한다 — searchProductsForComparison과 동일한 원칙.
      const decisionCriteria = await extractDecisionCriteria(searchQuery);
      const enrichedProducts = await enrichProductsWithWebSpecs(products, decisionCriteria);
      return {
        system: [
          buildCommonSystemInstructionsText(productCategory, locale),
          buildComparisonTableSystemText(locale),
        ].join("\n\n"),
        prompt: buildComparisonTablePromptText(enrichedProducts, userContext, decisionCriteria),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// 오케스트레이터 진입점 — app/api/generate/route.ts에서 호출.
// ---------------------------------------------------------------------------

export interface ChatFinishStepToolCall {
  toolName: string;
  toolCallId: string;
  input: unknown;
}

export interface ChatFinishStepToolResult {
  toolCallId: string;
  output: unknown;
}

export interface ChatFinishStep {
  toolCalls: ChatFinishStepToolCall[];
  toolResults: ChatFinishStepToolResult[];
}

export async function streamChatReply(
  locale: Locale,
  memoryBlock: string,
  messages: ModelMessage[],
  options?: { onFinish?: (event: { text: string; steps: ChatFinishStep[] }) => void }
) {
  const latestUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const userText = extractText(latestUserMsg);
  const history = messages.slice(0, Math.max(0, messages.length - 1));

  const intentAnalysis: IntentAnalysis = await analyzeIntent(userText, history);
  const actionRoute = await routeAction(intentAnalysis, EMPTY_SCREEN_STATE, "", userText);

  let system: string;
  const noneTools = { search_products: searchProductsTool, web_search: webSearchTool };
  let tools: typeof noneTools | undefined;

  let turn: { system: string; prompt: string } | null = null;
  if (actionRoute.action !== "none") {
    // "generate" 및 (패널이 없어 사실상 발생하지 않는) "edit" fallback — 둘 다 동일하게
    // template_selector로 어떤 종류의 답변인지 고른 뒤 텍스트 전용 판단 로직을 태운다.
    const selection = await selectTemplate(intentAnalysis, false, [], "");
    turn = await buildGenerateTurn(locale, selection.template, userText, intentAnalysis.user_goal);
  }

  if (turn) {
    system = turn.system + memoryBlock;
    // generate 경로는 이미 필요한 데이터를 다 모아서 프롬프트에 넣었으므로 별도 툴 불필요.
    messages = [...history, { role: "user", content: turn.prompt }];
  } else {
    // action=none이거나, generate였지만 검색 결과가 없어 대체된 경우 — 대화 맥락을 아는
    // none 경로(search_products/web_search 툴 포함)로 자연스럽게 답한다.
    system = buildNoneSystem(locale, currentProductCategory) + memoryBlock;
    tools = noneTools;
  }

  return streamText({
    model: anthropic(CHAT_MODEL),
    system,
    messages,
    tools,
    stopWhen: tools ? stepCountIs(4) : undefined,
    // "none"(도구 있음): main의 chat_agent.ts와 동일한 800 — 다만 search_products 툴이
    // 여러 제품(최대 10개)을 반환하면 그걸 전부 문장으로 풀어쓰다 800에 걸려 중간에
    // 끊기는 사례가 실제로 있어서 1500으로 올림. "generate"(도구 없음, ProductCardList/
    // ComparisonTable처럼 최대 6개 제품을 문장으로 풀어써야 함): 원래 1200이었는데,
    // 같은 정보를 main은 압축된 JSON(짧은 spec 문자열)으로 표현해서 토큰을 적게 쓰는
    // 반면 baseline은 자연어 문장으로 풀어써야 해서 오히려 더 많은 토큰이 필요하다 —
    // 제품 6개를 브랜드별로 묶어 설명하면 1200을 넘겨 문장 중간에 잘리는 게 실제로
    // 재현됐다. main의 구조화 생성 한도(2500)보다 더 여유 있게 2800으로 올림.
    maxOutputTokens: tools ? 1500 : 2800,
    // "none"(도구 있음): main의 chat_agent.ts와 동일한 0.3. "generate"(도구 없음, 판단/추천
    // 이유가 실제로 나오는 경로): main의 generator가 shared.ts callLLM으로 항상 0을 쓰므로
    // 동일하게 맞춘다 — 여기서 temperature가 달라지면 "판단 로직은 동일, 표현만 다르다"는
    // baseline 설계 전제가 깨진다.
    temperature: tools ? 0.3 : 0,
    onFinish: options?.onFinish,
  });
}
