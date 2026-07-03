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
import { initSidePanelStore, popSidePanelResults, setCurrentRequestId, initOptionListStore, popOptionListResults, initCompTableStore, popCompTableResults, setCurrentUserContext, setCurrentMessages, setCurrentSavedItems, setCurrentDecisionCriteria, setCurrentMyItemsContextSummary, setCurrentMyItemsRaw, setCurrentProductCategory, setCurrentLocale } from "@/lib/backend/tools/sidebar-store";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Local DB lookup — replaces live Danawa scraping for My Items pre-fetch
// ---------------------------------------------------------------------------

const CATEGORY_FILE_MAP: Record<string, string> = {
  "유모차": "products-유모차.json",
  "로봇 청소기": "products-로봇 청소기.json",
};

function proxyImage(url: string): string {
  if (!url) return "";
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

function findProductInLocalDB(productCategory: string, name: string): string | null {
  const fileName = CATEGORY_FILE_MAP[productCategory];
  if (!fileName) return null;

  try {
    const filePath = path.join(process.cwd(), "data", fileName);
    const raw = fs.readFileSync(filePath, "utf-8");
    const products: any[] = JSON.parse(raw);

    // 정확히 일치하는 제품 먼저 탐색
    let found = products.find((p) => p.name === name);

    // 없으면 부분 일치 (RAG가 이름을 약간 다르게 저장한 경우 대비)
    if (!found) {
      found = products.find(
        (p) =>
          p.name?.includes(name) ||
          name.includes(p.name ?? "")
      );
    }

    if (!found) return null;

    const specs = Array.isArray(found.specs)
      ? found.specs.join(" / ")
      : typeof found.specs === "string"
      ? found.specs
      : "정보 없음";

    return (
      `[Product 1]\n` +
      `Name: ${found.name}\n` +
      `Price: ${found.price}\n` +
      `Brand: ${found.brand ?? ""}\n` +
      `Mall: ${found.mallName ?? ""}\n` +
      `Image: ${proxyImage(found.image ?? found.imageUrl ?? "")}\n` +
      `Link: ${found.link ?? ""}\n` +
      `Specs: ${specs}\n` +
      `Description: ${found.description || "정보 없음"}`
    );
  } catch (e) {
    console.warn(`[LocalDB] Failed to read ${fileName}:`, e);
    return null;
  }
}


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
    },
  });

  return createUIMessageStreamResponse({ stream });
}
