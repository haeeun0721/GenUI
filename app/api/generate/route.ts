import { createAgent } from "@/lib/agents/conversation_agent";
import { minuteRateLimit, dailyRateLimit } from "@/lib/rate-limit";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { SPEC_DATA_PART_TYPE } from "@json-render/core";
import { headers } from "next/headers";
import { initSidePanelStore, popSidePanelResults, setCurrentRequestId, initChatUIStore, popChatUIResults, setCurrentUserContext, setCurrentMessages, setCurrentSavedItems, setCurrentDecisionCriteria, setCurrentMyItemsContextSummary, setCurrentMyItemsRaw, setCurrentProductCategory } from "@/lib/tools/sidebar-store";
import { searchProducts } from "@/lib/agents/data_agent";

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
  initChatUIStore(requestId);
  setCurrentMessages(uiMessages);

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
  const decisionCriteriaList = decisionCriteriaMatch
    ? decisionCriteriaMatch[1].split(",").map((s: string) => s.trim()).filter(Boolean)
    : [];
  setCurrentDecisionCriteria(decisionCriteriaList);

  // Extract ASSIGNED ITEM and map to product category for agent persona
  const assignedItemMatch = latestText.match(/\[ASSIGNED ITEM:\s*([^\]]+)\]/);
  const assignedItem = assignedItemMatch ? assignedItemMatch[1].trim() : "";
  const productCategory = assignedItem === "A" ? "유모차" : assignedItem === "B" ? "로봇 청소기" : "";
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
    console.log(`[Route] Pre-fetching ${myItemsRaw.length} My Items before agent...`);
    const summaries: string[] = [];
    for (const entry of myItemsRaw) {
      const pipeIdx = entry.indexOf("|");
      const name = pipeIdx !== -1 ? entry.slice(0, pipeIdx).trim() : entry.trim();
      const link = pipeIdx !== -1 ? entry.slice(pipeIdx + 1).trim() : undefined;
      try {
        const result = await (searchProducts.execute as any)({ query: name, count: 1, excludeNames: [], link });
        if (result?.contextSummary) summaries.push(result.contextSummary);
      } catch (e) {
        console.warn(`[Route] Pre-fetch failed for "${name}":`, e);
      }
    }
    setCurrentMyItemsContextSummary(summaries.join("\n\n"));
    console.log(`[Route] Pre-fetch complete. Summary length: ${summaries.join("\n\n").length}`);
  } else {
    setCurrentMyItemsContextSummary("");
  }

  // Strip [USER CONTEXT: ...] and [My items: ...] from all user messages before passing to the agent.
  // Both are pre-processed in route.ts — the agent doesn't need to see them.
  const STRIP_PATTERNS = [
    /\n{0,2}\[USER CONTEXT:[^\]]+\]/g,
    /\n{0,2}\[My items\s*:[^\]]+\]/gi,
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
  console.log(`[Route] Turn ${uiMessages.length} | requestId: ${requestId.slice(0, 10)} | messages: ${uiMessages.length}`);

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

      // Inject renderInChat results as data-chat-ui-spec chunks
      const chatUIResults = popChatUIResults(requestId);
      console.log("[Route] Injecting", chatUIResults.length, "renderInChat spec(s) as data-chat-ui-spec chunks");

      for (const spec of chatUIResults) {
        writer.write({ type: "data-chat-ui-spec", data: spec } as any);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
