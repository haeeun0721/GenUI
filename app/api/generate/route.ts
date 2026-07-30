import { createAgent } from "@/lib/backend/agents/conversation_agent";
import { minuteRateLimit, dailyRateLimit } from "@/lib/backend/rate-limit";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { SPEC_DATA_PART_TYPE } from "@json-render/core";
import { headers } from "next/headers";
import { initSidePanelStore, popSidePanelResults, setCurrentRequestId, initOptionListStore, popOptionListResults, initCompTableStore, popCompTableResults, initMutateSurfaceStore, popMutateSurfaceResults, setCurrentUserContext, setCurrentMessages, setCurrentSavedItems, setCurrentDecisionCriteria, setCurrentMyItemsContextSummary, setCurrentMyItemsRaw, setCurrentProductCategory, setCurrentLocale } from "@/lib/backend/tools/sidebar-store";
import { findProductInLocalDB } from "@/lib/backend/agents/data_agent";



export const maxDuration = 60;

export async function POST(req: Request) {
  const headersList = await headers();
  const ip = headersList.get("x-forwarded-for")?.split(",")[0] ?? "anonymous";

  const [minuteResult, dailyResult] = await Promise.all([
    minuteRateLimit.limit(ip),
    dailyRateLimit.limit(ip),
  ]);

  if (!minuteResult.success || !dailyResult.success) {
    const isMinuteLimit = !minuteResult.success;
    return new Response(
      JSON.stringify({
        error: "Rate limit exceeded",
        message: isMinuteLimit
          ? "Too many requests. Please wait a moment before trying again."
          : "Daily limit reached. Please try again tomorrow.",
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const body = await req.json();
  const uiMessages: UIMessage[] = body.messages;

  if (!uiMessages || !Array.isArray(uiMessages) || uiMessages.length === 0) {
    return new Response(
      JSON.stringify({ error: "messages array is required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Set up per-request store for sidePanel and renderInChat results
  const requestId = `${Date.now()}-${Math.random()}`;
  setCurrentRequestId(requestId);
  initSidePanelStore(requestId);
  initOptionListStore(requestId);
  initCompTableStore(requestId);
  initMutateSurfaceStore(requestId);
  setCurrentMessages(uiMessages);

  // Read locale from cookie (set by frontend toggle)
  const cookieHeader = headersList.get("cookie") ?? "";
  const localeCookie = cookieHeader.split(";").find(c => c.trim().startsWith("gs_locale="));
  const locale = (localeCookie?.split("=")[1]?.trim() ?? "ko") as "ko" | "en";
  setCurrentLocale(locale);

  // Extract USER CONTEXT directly from the latest user message (bypasses LLM)
  const latestUserMsg = [...uiMessages].reverse().find(m => m.role === "user");
  const latestText = latestUserMsg?.parts
    ?.filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("") ?? "";
  const userContextMatch = latestText.match(/\[USER CONTEXT:\s*([^\]]+)\]/);
  setCurrentUserContext(userContextMatch ? userContextMatch[1].trim() : "");

  // Extract MY ITEMS with specs from message text
  // Format: "제품A | spec1, spec2 / 제품B | spec3, spec4"
  const myItemsMatch = latestText.match(/\[CONTEXT: User has these items in 'MY ITEMS' cart: ([^\]]+)\]/);
  const myItemsList = myItemsMatch
    ? myItemsMatch[1].split(" / ").map((s: string) => s.trim()).filter(Boolean)
    : [];
  setCurrentSavedItems(myItemsList);

  // Extract DECISION CRITERIA from message and store for UI Agent use
  const decisionCriteriaMatch = latestText.match(/\[DECISION CRITERIA:\s*(.*?)\](?=\n|$)/i);
  // 괄호 안의 쉼표(예: "4,500Pa")를 무시하고 분리하기 위해 depth 추적 방식 사용
  function splitCriteriaRespectingParens(str: string): string[] {
    const result: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of str) {
      if (ch === "(") { depth++; current += ch; }
      else if (ch === ")") { depth--; current += ch; }
      else if (ch === "," && depth === 0) { const t = current.trim(); if (t) result.push(t); current = ""; }
      else { current += ch; }
    }
    const t = current.trim(); if (t) result.push(t);
    return result;
  }
  const decisionCriteriaList = decisionCriteriaMatch
    ? splitCriteriaRespectingParens(decisionCriteriaMatch[1])
    : [];
  setCurrentDecisionCriteria(decisionCriteriaList);

  // Extract ASSIGNED ITEM and map to product category for agent persona
  const assignedItemMatch = latestText.match(/\[ASSIGNED ITEM:\s*([^\]]+)\]/);
  const assignedItem = assignedItemMatch ? assignedItemMatch[1].trim() : "";
  const productCategory = assignedItem === "A" ? "유모차" : assignedItem === "B" ? "로봇 청소기" : assignedItem === "C" ? "카메라" : "";
  setCurrentProductCategory(productCategory);
  const agent = createAgent(productCategory);

  // Pre-fetch My Items product data BEFORE the Conversation Agent runs.
  // This keeps the Conversation Agent as a pure classifier+router.
  const myItemsTagMatch = latestText.match(/\[My items\s*:\s*([^\]]+)\]/i);
  const myItemsRaw = myItemsTagMatch
    ? myItemsTagMatch[1].split(",").map((s: string) => s.trim()).filter(Boolean)
    : [];
  setCurrentMyItemsRaw(myItemsRaw);

  if (myItemsRaw.length > 0) {
    console.log(`[Route] Looking up ${myItemsRaw.length} My Items from local DB...`);
    const summaries: string[] = [];
    for (const entry of myItemsRaw) {
      const pipeIdx = entry.indexOf("|");
      const name = pipeIdx !== -1 ? entry.slice(0, pipeIdx).trim() : entry.trim();
      const summary = findProductInLocalDB(productCategory, name);
      if (summary) {
        summaries.push(summary);
        console.log(`[LocalDB] Found: "${name}"`);
      } else {
        console.warn(`[LocalDB] Not found: "${name}" — skipping`);
      }
    }
    setCurrentMyItemsContextSummary(summaries.join("\n\n"));
    console.log(`[Route] Local DB lookup complete. ${summaries.length}/${myItemsRaw.length} products found.`);
  } else {
    setCurrentMyItemsContextSummary("");
  }

  // Strip [USER CONTEXT: ...] and [My items: ...] from all user messages before passing to the agent.
  // Both are pre-processed in route.ts — the agent doesn't need to see them.
  const STRIP_PATTERNS = [
    /\n{0,2}\[USER CONTEXT:[^\]]+\]/g,
    /\n{0,2}\[My items\s*:[^\]]+\]/gi,
    /\n{0,2}\[DECISION CRITERIA:[^\]]+\]/gi,
  ];
  const sanitizedMessages: typeof uiMessages = uiMessages.map(msg => {
    if (msg.role !== "user") return msg;
    return {
      ...msg,
      parts: msg.parts.map((p: any) => {
        if (p.type !== "text") return p;
        let text = p.text;
        for (const pattern of STRIP_PATTERNS) text = text.replace(pattern, "");
        return { ...p, text };
      }),
    };
  });

  const modelMessages = await convertToModelMessages(sanitizedMessages);
  const hasOptionList = latestText.includes('[CURRENT_OPTION_LIST');
  console.log(`[Route] Turn ${uiMessages.length} | requestId: ${requestId.slice(0, 10)} | messages: ${uiMessages.length} | CURRENT_OPTION_LIST: ${hasOptionList ? '✅ 있음' : '❌ 없음'}`);

  // ─── Criteria-Only Pre-filter ──────────────────────────────────────────────
  // [Decision Criteria:...] 태그만 있고 실제 대화 텍스트가 없는 메시지는
  // Conversation Agent를 거치지 않고 즉시 빈 응답을 반환한다.
  // (클라이언트 autoEnrich + clearStaleDimming이 이미 처리함)
  const strippedLatest = latestText
    .replace(/\[CURRENT_OPTION_LIST[\s\S]*?\]/g, '')
    .replace(/\[DECISION CRITERIA:[^\]]*\]/gi, '')
    .replace(/\[USER CONTEXT:[^\]]*\]/gi, '')
    .replace(/\[My items\s*:[^\]]*\]/gi, '')
    .replace(/\[ASSIGNED ITEM:[^\]]*\]/gi, '')
    .replace(/\[CONTEXT:[^\]]*\]/gi, '')
    .trim();

  const isCriteriaOnlyMessage = strippedLatest.length === 0 && decisionCriteriaList.length > 0;

  if (isCriteriaOnlyMessage && hasOptionList) {
    console.log('[Route] ⚡ Criteria-Only 메시지 + Option List 있음 → Agent 호출 생략, 즉시 빈 응답 반환');
    return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  // ───────────────────────────────────────────────────────────────────────────

  const result = await agent.stream({ messages: modelMessages });
  console.log(`[Route] agent.stream() resolved for requestId: ${requestId.slice(0, 10)}`);

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const reader = result.toUIMessageStream().getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        writer.write(value);
      }

      // After stream is fully consumed, the sidebar tool's execute() has already
      // run and pushed results into the store.
      const sidePanelResults = popSidePanelResults(requestId);
      console.log(`[Route] sidePanelResults count: ${sidePanelResults.length} | types: ${sidePanelResults.map((s: any) => s?.type).join(', ')}`);

      for (const spec of sidePanelResults) {
        // page.tsx allSpecs picks up: p.type === "data-spec" && p.data && p.data.type !== "patch"
        console.log(`[Route] Writing data-spec: ${JSON.stringify(spec).slice(0, 100)}`);
        writer.write({ type: SPEC_DATA_PART_TYPE, data: spec } as any);
      }


      const optionListResults = popOptionListResults(requestId);
      console.log("[Route] Injecting", optionListResults.length, "renderToOptionList spec(s) as data-option-list-spec chunks");
      for (const spec of optionListResults) {
        writer.write({ type: "data-option-list-spec", data: spec } as any);
      }

      // Inject renderInChat category 2 results as data-comp-table-spec chunks
      const compTableResults = popCompTableResults(requestId);
      console.log("[Route] Injecting", compTableResults.length, "compTable spec(s) as data-comp-table-spec chunks");
      for (const spec of compTableResults) {
        writer.write({ type: "data-comp-table-spec", data: spec } as any);
      }

      // Inject mutateSurface results as data-mutate-surface-spec chunks
      const mutateSurfaceResults = popMutateSurfaceResults(requestId);
      if (mutateSurfaceResults.length > 0) {
        console.log("[Route] Injecting", mutateSurfaceResults.length, "mutateSurface spec(s) as data-mutate-surface-spec chunks");
        for (const spec of mutateSurfaceResults) {
          writer.write({ type: "data-mutate-surface-spec", data: spec } as any);
        }
      }

      // ── Intent Summary ──────────────────────────────────────────────────────
      const totalTools = sidePanelResults.length + optionListResults.length + compTableResults.length + mutateSurfaceResults.length;
      if (totalTools === 0) {
        console.log(`[Route] ⚠️  툴 호출 없음 → Cat 0/1 (텍스트 응답만 반환). ${hasOptionList ? 'OPTION_LIST 있었으나 Cat4로 분류 안 됨 — 오분류 가능성' : 'OPTION_LIST 없음 — Cat3/4 호출 불가'}`);
      } else {
        const toolSummary = [
          sidePanelResults.length > 0 ? `renderToSidebar(${sidePanelResults.length})` : null,
          optionListResults.length > 0 ? `renderToOptionList(${optionListResults.length})` : null,
          compTableResults.length > 0 ? `renderToCompTable(${compTableResults.length})` : null,
          mutateSurfaceResults.length > 0 ? `mutateSurface(op=${mutateSurfaceResults.map((r: any) => r.op).join(',')})` : null,
        ].filter(Boolean).join(' + ');
        console.log(`[Route] ✅ 툴 호출: ${toolSummary}`);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}

