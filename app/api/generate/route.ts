import { agent } from "@/lib/agents/conversation";
import { minuteRateLimit, dailyRateLimit } from "@/lib/rate-limit";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { pipeJsonRender } from "@json-render/core";
import { headers } from "next/headers";

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
      },
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
      },
    );
  }

  const modelMessages = await convertToModelMessages(uiMessages);

  // --- Conversation Agent Decision Logger ---
  const lastUserMessage = uiMessages.findLast((m) => m.role === "user");
  const userQuery = lastUserMessage?.parts
    ?.filter((p: { type: string }) => p.type === "text")
    .map((p: { type: string; text?: string }) => p.text)
    .join("") ?? "(unknown query)";

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║         CONVERSATION AGENT — NEW REQUEST         ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`[User Query] "${userQuery}"`);
  console.log("──────────────────────────────────────────────");

  const result = await agent.stream({
    messages: modelMessages,
    onStepFinish: (step) => {
      if (step.toolCalls && step.toolCalls.length > 0) {
        for (const call of step.toolCalls) {
          const toolName = call.toolName;
          const isUITool = toolName === "mainPanel" || toolName === "sidePanel";
          const label = isUITool
            ? `[ROUTING → ${toolName.toUpperCase()}]`
            : `[TOOL CALL → ${toolName}]`;

          console.log(`${label}`);
          if ("args" in call && call.args) {
            const args = call.args as Record<string, unknown>;
            const preview = JSON.stringify(args).slice(0, 200);
            console.log(`  Input: ${preview}${preview.length >= 200 ? "..." : ""}`);
          }
        }
      }
      if (step.text && step.text.trim()) {
        try {
          const parsed = JSON.parse(step.text);
          console.log("[Agent Decision Output]");
          console.log(`  intent_summary   : ${parsed.intent_summary ?? "-"}`);
          console.log(`  needs_data       : ${parsed.needs_data}`);
          console.log(`  needs_ui         : ${parsed.needs_ui}`);
          console.log(`  ui_intent_category: ${parsed.ui_intent_category ?? "null"}`);
          console.log(`  ui_intent_reason : ${parsed.ui_intent_reason ?? "-"}`);
        } catch {
          console.log(`[Agent Text] ${step.text.slice(0, 200)}`);
        }
      }
    },
  });

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      console.log("--- START OF SERVER STREAM ---");
      const jsonRenderStream = pipeJsonRender(result.toUIMessageStream());

      const debugStream = new TransformStream({
        transform(chunk, controller) {
          console.log("DEBUG [Server Stream Outgoing]:", JSON.stringify(chunk, null, 2));
          controller.enqueue(chunk);
        },
        flush() {
          console.log("--- END OF SERVER STREAM ---");
        }
      });

      writer.merge(jsonRenderStream.pipeThrough(debugStream));
    },
  });

  return createUIMessageStreamResponse({ stream });
}
