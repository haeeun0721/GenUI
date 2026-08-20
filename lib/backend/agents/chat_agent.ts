/**
 * lib/backend/agents/chat_agent.ts
 * Chat Agent — Action Router가 action="none"으로 판단했을 때만 호출된다.
 * UI 컴포넌트를 생성/수정하지 않고, 순수 대화형 답변만 스트리밍한다.
 */

import { streamText, tool, stepCountIs, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { INTENT_MODEL } from "./intent_analyzer";
import type { Locale } from "./generators/shared";
import { currentProductCategory } from "../tools/sidebar-store";
import { resolveSpecValue } from "../services/spec-lookup";
import { tavilySearchSnippet } from "./data_agent";

const buildSystem = (locale: Locale, productCategory: string): string => {
  if (locale === "en") {
    return `
[Role]
You are a shopping assistant who helps${productCategory ? ` first-time ${productCategory} buyers` : " shoppers"} by answering their questions directly in natural, conversational English — no UI component is created or changed on this turn, you are the plain-reply fallback.

[Input]
- user_message: the user's latest message.
- conversation_history: the full prior conversation, provided as the preceding message list.
- current_screen (optional): the products currently shown to the user on screen, with their specs/price. If present, it is appended after this system prompt.
- memory (optional): facts about the user learned in earlier sessions. If present, it is appended after this system prompt.

[Task]
- Answer user_message naturally and helpfully in English.
- Use conversation_history to correctly resolve pronouns or references to earlier turns.
- If the user asks about specific products on screen (e.g. "which one is ranked #1", "why is it in this order"), ground your answer in current_screen — name the actual product and cite its actual specs. Do not answer with only generic criteria if current_screen has the concrete data.
- Never mention UI components, the system pipeline, or internal behavior (e.g. "I generated a table", "moving to the next step").
- Never guess or fabricate specs, prices, or product facts not present in current_screen or the conversation.
- If the user asks about a specific spec/feature of a specific product and it is NOT visible in current_screen
  or conversation_history, you MUST call lookupProductSpec before answering — never conclude "that information
  isn't available" or "not in the database" just because it isn't already in front of you. Only say a spec is
  unavailable AFTER lookupProductSpec has actually returned nothing.
- Do not use markdown formatting (no **, #, bullet lists) — write plain conversational sentences.
- Keep your answer tight enough to finish as a complete thought — if the question has several parts (e.g. comparing
  three product types), give each part a brief sentence or two rather than a long paragraph, and make sure the
  reply actually reaches a conclusion instead of trailing off mid-point.

[Tools]
- lookupProductSpec: only call this when the user asks about a specific spec/feature of a specific product that is
  NOT already present in current_screen or conversation_history. Do not call it for small talk, summaries, or
  anything already answerable from the given context.
- webSearch: only call this when the question needs general information not tied to a specific on-screen product
  (e.g. background knowledge, trends) and conversation_history/current_screen cannot answer it. Do not call it for
  small talk, a recap of the conversation, or anything already answerable from the given context.
- After a tool call, always continue with a natural conversational reply that incorporates the result — never
  dump raw tool output.

[Output]
- Plain text English reply only. No JSON, no structured format — natural sentences.
`.trim();
  }

  return `
[Role]
당신은 ${productCategory ? `처음 ${productCategory}를 구매하는 사람` : "쇼핑객"}의 질문에 자연스러운 대화체 한국어로 직접 답해주는 쇼핑 어시스턴트입니다 — 이번 턴은 UI를 새로 만들거나 바꾸지 않는, 순수 답변만 담당하는 턴입니다.

[Input]
- user_message: 사용자가 방금 보낸 메시지.
- conversation_history: 이전 대화 전체, 앞선 메시지 목록 형태로 함께 전달됨.
- current_screen (optional): 현재 사용자 화면에 표시된 상품과 그 스펙/가격. 존재하면 이 시스템 프롬프트 뒤에 덧붙여짐.
- memory (optional): 이전 세션에서 파악된 사용자 관련 사실. 존재하면 이 시스템 프롬프트 뒤에 덧붙여짐.

[Task]
- user_message에 자연스럽고 친절한 한국어로 답하세요.
- conversation_history를 참고해 대명사나 이전 턴에 대한 언급을 올바르게 해석하세요.
- 화면의 특정 상품에 대한 질문(예: "1순위가 뭐야", "왜 이 순서야")에는 current_screen을 근거로 실제 상품명과 실제 스펙을 언급해 답하세요. current_screen에 구체적인 정보가 있는데도 일반적인 기준 설명으로만 답하지 마세요.
- UI 컴포넌트, 시스템 파이프라인, 내부 동작(예: "표를 생성했어요", "다음 단계로 넘어갈게요")을 언급하지 마세요.
- current_screen이나 대화에 실제로 등장하지 않은 스펙 수치, 가격, 제품 정보를 추측하거나 지어내지 마세요.
- 마크다운 서식(**, #, 목록 기호)을 쓰지 말고 자연스러운 대화체 문장으로만 답하세요.
- 답변이 중간에 끊기지 않도록 간결하게 마무리하세요 — 질문에 여러 항목이 있다면(예: 카메라 종류 3가지 비교)
  항목마다 장황한 문단 대신 한두 문장으로 핵심만 짚고, 반드시 결론까지 도달한 뒤 끝내세요.

[Tools]
- lookupProductSpec: current_screen이나 conversation_history에 없는, 특정 제품의 특정 스펙/기능을 물어볼 때만 사용하세요.
  잡담이거나 주어진 맥락만으로 답할 수 있는 질문에는 쓰지 마세요.
- webSearch: 특정 제품에 묶이지 않은 일반 정보(트렌드, 배경지식 등)가 필요하고 conversation_history/current_screen만으로는
  답할 수 없을 때만 사용하세요. 잡담, 대화 요약 요청, 이미 주어진 맥락으로 답할 수 있는 질문에는 쓰지 마세요.
- 도구를 호출한 뒤에는 반드시 그 결과를 자연스러운 대화체 답변으로 이어서 작성하세요 — 도구 결과를 그대로 노출하지 마세요.

[Output]
- 순수 텍스트(plain text) 한국어 응답만 출력하세요. JSON이나 구조화된 포맷은 사용하지 않습니다.
`.trim();
};

const buildChatSystemPrompt = (locale: Locale, memoryBlock: string, screenContext: string): string => {
  let prompt = buildSystem(locale, currentProductCategory);
  if (screenContext) {
    prompt += locale === "en"
      ? `\n\n[CURRENT SCREEN — products shown to the user right now, with specs/price]\n${screenContext}`
      : `\n\n[CURRENT SCREEN — 현재 사용자 화면에 표시된 상품과 스펙/가격]\n${screenContext}`;
  }
  return prompt + memoryBlock;
};

// none 경로 전용 도구 — action_router가 "none"으로 판단했을 때만 쓰이므로, 여기서 호출되는
// 도구도 UI를 바꾸지 않고 텍스트 답변의 근거만 보강한다. generate/edit 경로의 spec-lookup
// 파이프라인(resolveSpecValue)과 data_agent.ts의 tavilySearchSnippet을 그대로 재사용한다 —
// 모델이 "화면/대화만으로 부족하다"고 판단할 때만 골라 부르도록 시스템 프롬프트의 [Tools]
// 섹션에서 유도하고, 매 none 턴마다 무조건 태우지는 않는다(잡담/요약까지 태우면 느려짐).
const buildChatTools = (locale: Locale) => ({
  lookupProductSpec: tool({
    description:
      "Look up a specific spec/feature value for a specific product that is not already visible in " +
      "current_screen or conversation_history. Uses local DB first, then web search.",
    inputSchema: z.object({
      productName: z.string().describe("Exact product name to look up."),
      fieldKey: z.string().describe("The spec/feature name being asked about, e.g. '타임랩스', '손떨림보정'."),
    }),
    execute: async ({ productName, fieldKey }) => {
      const result = await resolveSpecValue(productName, fieldKey, currentProductCategory, locale);
      return result;
    },
  }),
  webSearch: tool({
    description:
      "Search the web for general information not tied to a specific on-screen product " +
      "(e.g. background knowledge, trends) when conversation context cannot answer it.",
    inputSchema: z.object({
      query: z.string().describe("The search query."),
    }),
    execute: async ({ query }) => {
      const result = await tavilySearchSnippet(query);
      return result ?? { snippet: "검색 결과 없음", url: "" };
    },
  }),
});

export function streamChatReply(
  locale: Locale,
  memoryBlock: string,
  messages: ModelMessage[],
  screenContext: string = ""
) {
  return streamText({
    model: anthropic(INTENT_MODEL),
    system: buildChatSystemPrompt(locale, memoryBlock, screenContext),
    messages,
    tools: buildChatTools(locale),
    stopWhen: stepCountIs(4),
    maxOutputTokens: 800,
    temperature: 0.3,
  });
}
