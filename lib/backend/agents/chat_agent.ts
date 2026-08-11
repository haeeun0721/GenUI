/**
 * lib/backend/agents/chat_agent.ts
 * Baseline Chat Agent — a plain, linear, GPT-style shopping assistant.
 * No structured UI is generated; it answers directly in natural language
 * (standard markdown allowed: lists, headers, bold, simple tables) and can
 * search the product database as a tool when it needs real product data.
 */

import { streamText, stepCountIs, tool, type ModelMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { currentProductCategory } from "../tools/sidebar-store";
import { ragSearch } from "../rag/search";
import { reRankByAI, RAG_NOT_FOUND, tavilySearchSnippet, type ProductData } from "./data_agent";

export type Locale = "ko" | "en";

const CHAT_MODEL = "gpt-4o";

function formatProduct(p: ProductData): string {
  const specs = p.specs.slice(0, 12).join(", ") || "스펙 정보 없음";
  return `- ${p.name} (${p.price})\n  ${specs}`;
}

// 로컬 DB(ragSearch+reRankByAI)에서만 찾는다 — treatment도 여기서 아예 못 찾으면(RAG_NOT_FOUND)
// Tavily로 넘어가지 않고 "DB에 없음"으로 끝난다. Tavily는 이미 찾은 제품의 빠진 스펙 값을
// 보강하는 용도로만 쓰였지, DB 미스를 웹 검색으로 대신 채워주는 용도가 아니었다.
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
    const category = currentProductCategory;
    if (!category) return "제품 카테고리 정보가 없어 검색할 수 없습니다.";
    const candidates = await ragSearch(query, category, 20);
    if (candidates.length === 0) return "데이터베이스에서 조건에 맞는 제품을 찾지 못했습니다.";
    const ranked = await reRankByAI(candidates, query, category, count ?? 6);
    if (ranked === RAG_NOT_FOUND) return "데이터베이스에서 조건에 맞는 제품을 찾지 못했습니다.";
    return ranked.map((r) => formatProduct(candidates[r.index])).join("\n");
  },
});

// search_products가 찾은 제품에 없는 스펙 값을 웹에서 보강하거나(treatment의 enrichContextWithTavily와
// 같은 역할), 애초에 DB 제품 검색이 아닌 질문(리뷰, 구매 조언 등)에 답할 때 쓴다.
// DB가 제품 자체를 못 찾은 경우의 대체 검색 용도가 아니다.
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
    if (!result) return "웹 검색에서 관련 정보를 찾지 못했습니다.";
    return `${result.snippet}\n(출처: ${result.url})`;
  },
});

const buildSystem = (locale: Locale, productCategory: string): string => {
  if (locale === "en") {
    return `
[Role]
You are a helpful shopping assistant${productCategory ? ` for someone buying their first ${productCategory}` : ""} — the kind of general-purpose AI chat assistant people already use today. You have two tools: "search_products" looks up real products in a database, and "web_search" fills in a missing spec for a product you already found, or answers things the database was never meant to cover.

[Task]
- Answer the user's message naturally and helpfully in English, in a single flowing chat reply.
- Use conversation_history to correctly resolve pronouns or references to earlier turns.
- Call search_products whenever the user wants to see, find, compare, or get recommendations for real products. Ground your answer in the tool's actual results — cite real product names, prices, and specs from it. Never invent products, prices, or specs. If it finds nothing, tell the user the database has no match — do NOT call web_search to find a substitute product.
- Call web_search only to fill in a specific spec/detail search_products didn't return for a product you already found, or to answer something that isn't a product search at all (reviews, general buying advice).
- You may use standard markdown formatting when it helps clarity — bullet points, numbered lists, bold text, short headers, and simple tables — just like any modern AI chat assistant. Don't force structure where a short sentence would do.
- Never mention tools, databases, or internal system behavior explicitly (e.g. don't say "I called a tool" or "the database returned"). Just answer as yourself.

[Output]
Natural chat reply. Markdown is fine. No raw JSON.
`.trim();
  }

  return `
[Role]
당신은 ${productCategory ? `처음 ${productCategory}를 구매하는 사람` : "쇼핑객"}을 돕는 친절한 쇼핑 어시스턴트입니다 — 지금 사람들이 실제로 쓰는 범용 AI 챗봇과 같은 성격입니다. 두 가지 도구를 쓸 수 있습니다 — "search_products"는 실제 제품 데이터베이스를 검색하고, "web_search"는 이미 찾은 제품에서 빠진 스펙을 보강하거나 애초에 DB가 다루지 않는 질문에 답할 때 씁니다.

[Task]
- user_message에 자연스럽고 친절한 한국어로, 하나의 흐르는 채팅 답변으로 답하세요.
- conversation_history를 참고해 대명사나 이전 턴에 대한 언급을 올바르게 해석하세요.
- 사용자가 제품을 보거나, 찾거나, 비교하거나, 추천받고 싶어할 때는 반드시 search_products를 호출하세요. 답변은 도구가 실제로 반환한 결과에 근거해야 하며, 실제 제품명·가격·스펙을 인용하세요. 제품, 가격, 스펙을 절대 지어내지 마세요. 아무것도 못 찾으면 DB에 맞는 게 없다고 솔직히 말하고, 대체 제품을 찾으려고 web_search를 호출하지 마세요.
- web_search는 이미 찾은 제품의 특정 스펙/디테일이 빠졌을 때 그것만 보강하거나, 애초에 제품 검색이 아닌 질문(리뷰, 일반적인 구매 조언 등)에 답할 때만 쓰세요.
- 목록, 소제목, 굵은 글씨, 간단한 표 같은 일반적인 markdown 서식은 가독성에 도움이 될 때 자유롭게 사용하세요 — 요즘 웬만한 AI 챗봇이 다 그렇게 답합니다. 짧은 문장이면 충분한 경우에는 굳이 구조화하지 마세요.
- 도구, 데이터베이스, 내부 동작을 직접 언급하지 마세요(예: "도구를 호출했어요", "데이터베이스에서 나온 결과예요" 같은 말은 하지 마세요). 그냥 본인 답변처럼 자연스럽게 말하세요.

[Output]
자연스러운 채팅 답변. Markdown 사용 가능. JSON 원문은 출력하지 않습니다.
`.trim();
};

const buildChatSystemPrompt = (locale: Locale, memoryBlock: string): string => {
  return buildSystem(locale, currentProductCategory) + memoryBlock;
};

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

export function streamChatReply(
  locale: Locale,
  memoryBlock: string,
  messages: ModelMessage[],
  options?: { onFinish?: (event: { text: string; steps: ChatFinishStep[] }) => void },
) {
  return streamText({
    model: openai(CHAT_MODEL),
    system: buildChatSystemPrompt(locale, memoryBlock),
    messages,
    tools: { search_products: searchProductsTool, web_search: webSearchTool },
    stopWhen: stepCountIs(5),
    maxOutputTokens: 800,
    temperature: 0.5,
    onFinish: options?.onFinish,
  });
}
