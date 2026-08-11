import {
  convertToModelMessages,
  type UIMessage,
} from "ai";
import { headers } from "next/headers";
import {
  setCurrentRequestId,
  setCurrentUserContext,
  setCurrentProductCategory,
  setCurrentLocale,
} from "@/lib/backend/tools/sidebar-store";
import { streamChatReply } from "@/lib/backend/agents/chat_agent";
import { loadMemory, appendMemoryTurn } from "@/lib/backend/services/session-memory";
import { logChatTurn, type ChatTurnToolCall } from "@/lib/backend/services/research-log";
import { minuteRateLimit, dailyRateLimit } from "@/lib/backend/rate-limit";

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
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }

  const body = await req.json();
  const uiMessages: UIMessage[] = body.messages;

  if (!uiMessages || !Array.isArray(uiMessages) || uiMessages.length === 0) {
    return new Response(
      JSON.stringify({ error: "messages array is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const requestId = `${Date.now()}-${Math.random()}`;
  setCurrentRequestId(requestId);

  // Read locale from cookie (set by frontend toggle)
  const cookieHeader = headersList.get("cookie") ?? "";
  const localeCookie = cookieHeader.split(";").find(c => c.trim().startsWith("gs_locale="));
  const locale = (localeCookie?.split("=")[1]?.trim() ?? "ko") as "ko" | "en";
  setCurrentLocale(locale);

  const latestUserMsg = [...uiMessages].reverse().find(m => m.role === "user");
  const latestText = latestUserMsg?.parts
    ?.filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("") ?? "";

  const userContextMatch = latestText.match(/\[USER CONTEXT:\s*([^\]]+)\]/);
  setCurrentUserContext(userContextMatch ? userContextMatch[1].trim() : "");

  const assignedItemMatch = latestText.match(/\[ASSIGNED ITEM:\s*([^\]]+)\]/);
  const assignedItem = assignedItemMatch ? assignedItemMatch[1].trim() : "";
  const productCategory = assignedItem === "A" ? "유모차" : assignedItem === "B" ? "로봇 청소기" : assignedItem === "C" ? "카메라" : "";
  setCurrentProductCategory(productCategory);

  const participantIdMatch = latestText.match(/\[PARTICIPANT ID:\s*([^\]]+)\]/);
  const participantId = participantIdMatch ? participantIdMatch[1].trim() : "";

  // Strip study-protocol tags from every user message before handing history to the model —
  // otherwise these tags (re-sent on every turn) accumulate verbatim in the context window.
  const STRIP_PATTERNS = [
    /\n{0,2}\[USER CONTEXT:[^\]]+\]/g,
    /\n{0,2}\[ASSIGNED ITEM:[^\]]+\]/g,
    /\n{0,2}\[PARTICIPANT ID:[^\]]+\]/g,
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

  const strippedLatest = latestText
    .replace(/\[USER CONTEXT:[^\]]*\]/gi, "")
    .replace(/\[ASSIGNED ITEM:[^\]]*\]/gi, "")
    .replace(/\[PARTICIPANT ID:[^\]]*\]/gi, "")
    .trim();

  const modelMessages = await convertToModelMessages(sanitizedMessages);

  const memoryText = await loadMemory(participantId).catch((err) => {
    console.error("[SessionMemory] load 실패:", err);
    return "";
  });
  const memoryBlock = memoryText
    ? `\n\n[PAST INTERACTION MEMORY — 이전 턴 요약(참고용)]\n${memoryText}`
    : "";

  const turnIndex = uiMessages.length;
  const result = streamChatReply(locale, memoryBlock, modelMessages as any, {
    onFinish: ({ text, steps }) => {
      if (!participantId) return;
      appendMemoryTurn(participantId, {
        turn: turnIndex,
        userText: strippedLatest,
        action: "none",
        template: null,
        note: text.trim(),
      }).catch((err) => console.error("[SessionMemory] append 실패:", err));

      const toolCalls: ChatTurnToolCall[] = steps.flatMap((step) =>
        step.toolCalls.map((call) => {
          const result = step.toolResults.find((r) => r.toolCallId === call.toolCallId);
          return { tool: call.toolName, input: call.input, output: result?.output ?? null };
        })
      );

      logChatTurn({
        participantId,
        turnIndex,
        userText: strippedLatest,
        assistantText: text.trim(),
        toolCalls,
      }).catch((err) => console.error("[ResearchLog] logChatTurn 실패:", err));
    },
  });

  return result.toUIMessageStreamResponse();
}
