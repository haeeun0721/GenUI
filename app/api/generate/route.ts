import { agent } from "@/lib/agents/conversation_agent";
import { minuteRateLimit, dailyRateLimit } from "@/lib/rate-limit";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { SPEC_DATA_PART_TYPE } from "@json-render/core";
import { headers } from "next/headers";
import { initSidePanelStore, popSidePanelResults, setCurrentRequestId, initChatUIStore, popChatUIResults } from "@/lib/tools/sidebar-store";

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

  const modelMessages = await convertToModelMessages(uiMessages);
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
