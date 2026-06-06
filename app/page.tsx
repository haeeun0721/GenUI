"use client";

import { useState, useCallback, useMemo, memo, useRef, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  SPEC_DATA_PART,
  SPEC_DATA_PART_TYPE,
  type SpecDataPart,
} from "@json-render/core";
import { useJsonRenderMessage } from "@json-render/react";
import { ExplorerRenderer } from "@/lib/render/renderer";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Loader2,
  Sparkles,
  Plus,
  AudioLines,
  Search,
  AlertTriangle,
  Pencil,
  X,
  ChevronDown,
  Heart,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

// =============================================================================
// Types
// =============================================================================

type AppDataParts = {
  [SPEC_DATA_PART]: SpecDataPart;
  "data-chat-ui-spec": { data: any };
};
type AppMessage = UIMessage<unknown, AppDataParts>;

// =============================================================================
// Transport
// =============================================================================

const transport = new DefaultChatTransport({ api: "/api/generate" });

// =============================================================================
// Tool Call Display
// =============================================================================

const TOOL_LABELS: Record<string, [string, string]> = {
  getWeather: ["Getting weather data", "Got weather data"],
  getGitHubRepo: ["Fetching GitHub repo", "Fetched GitHub repo"],
  getGitHubPullRequests: ["Fetching pull requests", "Fetched pull requests"],
  getCryptoPrice: ["Looking up crypto price", "Looked up crypto price"],
  getCryptoPriceHistory: ["Fetching price history", "Fetched price history"],
  getHackerNewsTop: ["Loading Hacker News", "Loaded Hacker News"],
  webSearch: ["Searching the web", "Searched the web"],
};

function ToolCallDisplay({
  toolName,
  state,
  result,
}: {
  toolName: string;
  state: string;
  result: unknown;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLoading =
    state !== "output-available" &&
    state !== "output-error" &&
    state !== "output-denied";
  const labels = TOOL_LABELS[toolName];
  const label = labels ? (isLoading ? labels[0] : labels[1]) : toolName;

  return (
    <div className="text-sm group">
      <button
        type="button"
        className="flex items-center gap-1.5"
        onClick={() => setExpanded((e) => !e)}
      >
        <span
          className={`text-muted-foreground ${isLoading ? "animate-shimmer" : ""}`}
        >
          {label}
        </span>
        {!isLoading && (
          <ChevronRight
            className={`h-3 w-3 text-muted-foreground/0 group-hover:text-muted-foreground transition-all ${expanded ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {expanded && !isLoading && result != null && (
        <div className="mt-1 max-h-64 overflow-auto">
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-all">
            {typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Helper: Extract UI Specs from Text
// =============================================================================

function extractSpecsFromText(text: string): Array<{ kind: 'text' | 'spec', content: any }> {
  const result: Array<{ kind: 'text' | 'spec', content: any }> = [];
  let lastIdx = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      let depth = 0;
      let inString = false;
      let escaped = false;
      let foundEnd = -1;

      for (let j = i; j < text.length; j++) {
        const char = text[j];
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (!inString) {
          if (char === '{') depth++;
          else if (char === '}') {
            depth--;
            if (depth === 0) {
              foundEnd = j;
              break;
            }
          }
        }
      }

      if (foundEnd !== -1) {
        const potentialJson = text.substring(i, foundEnd + 1);
        try {
          const parsed = JSON.parse(potentialJson);
          if (parsed && (parsed.type || parsed.root || parsed.spec)) {
            const textBefore = text.substring(0, i);
            const backtickStartMatch = textBefore.match(/```(?:json)?\s*$/i);
            const actualStart = backtickStartMatch ? i - backtickStartMatch[0].length : i;

            const textAfter = text.substring(foundEnd + 1);
            const backtickEndMatch = textAfter.match(/^\s*```/);
            const actualEnd = backtickEndMatch ? foundEnd + 1 + backtickEndMatch[0].length : foundEnd + 1;

            const preamble = text.substring(lastIdx, actualStart);
            if (preamble) result.push({ kind: 'text', content: preamble });

            result.push({ kind: 'spec', content: parsed.spec || parsed });

            i = actualEnd - 1;
            lastIdx = actualEnd;
          }
        } catch (e) { }
      }
    }
  }

  const remaining = text.substring(lastIdx);
  if (remaining) result.push({ kind: 'text', content: remaining });

  return result;
}

// =============================================================================
// Message Bubble
// =============================================================================

const MessageBubble = memo(({
  message,
  isLast,
  isStreaming,
  bindings,
  highlightTerm,
  highlightTurn,
  isFollowUp,
  turns,
}: {
  message: AppMessage;
  isLast: boolean;
  isStreaming: boolean;
  bindings: {
    onItemAdd?: (name: string, image?: string, price?: string, description?: string, specs?: string[], link?: string) => void;
    onCompareRequested?: (products: string[]) => void;
    savedItems?: any[];
    droppedCriteria?: any[];
    onRequestCriteriaData?: (criteriaName: string, products: string[]) => void;
    onAddMyItemsToTable?: (currentProducts: string[], newItems: string[]) => void;
    isLatestMessage?: boolean;
    userContext?: string;
    onItemRemove?: (name: string) => void;
  };
  highlightTerm?: string | null;
  highlightTurn?: number | null;
  isFollowUp?: boolean;
  turns?: number[];
}) => {
  const { onItemAdd, onCompareRequested, savedItems, droppedCriteria, onRequestCriteriaData, onAddMyItemsToTable, userContext } = bindings;
  const isUser = message.role === "user";
  const bubbleRef = useRef<HTMLDivElement>(null);

  const segments = useMemo(() => {
    const toolInvocations = (message as any).toolInvocations ?? [];
    const sidePanelSpecs: any[] = [];
    toolInvocations.forEach((ti: any) => {
      if ((ti.toolName === "renderToSidebar" || ti.toolName === "sidePanel") && ti.state === "result") {
        const spec = ti.result;
        if (spec) {
          let parsedSpec = spec;
          if (typeof spec === "string") {
            try { parsedSpec = JSON.parse(spec); } catch { return; }
          }
          if (parsedSpec && typeof parsedSpec === "object") {
            let effectiveSpec = parsedSpec;
            if (parsedSpec.root && parsedSpec.elements && parsedSpec.elements[parsedSpec.root]) {
              effectiveSpec = parsedSpec.elements[parsedSpec.root];
            }
            const isKnowledgeMap = effectiveSpec.type === "KnowledgeMap" || effectiveSpec.type === "Timeline";
            if (!isKnowledgeMap) {
              sidePanelSpecs.push(parsedSpec);
            }
          }
        }
      }
    });
    const result: Array<
      | { kind: "text"; content: string }
      | { kind: "spec"; content: any }
      | {
        kind: "tools";
        tools: Array<{
          toolCallId: string;
          toolName: string;
          state: string;
          output?: unknown;
        }>;
      }
    > = [];

    message.parts.forEach((part: any) => {
      if (part.type === "text") {
        const subSegments = extractSpecsFromText(part.text);
        subSegments.forEach(seg => {
          if (seg.kind === 'spec') {
            const spec = seg.content;
            const isKnowledgeMap = spec?.type === "KnowledgeMap" || spec?.type === "Timeline" || (spec?.root && spec?.elements?.[spec.root]?.type === "KnowledgeMap") || (spec?.root && spec?.elements?.[spec.root]?.type === "Timeline");
            if (!isKnowledgeMap) result.push({ kind: "spec", content: spec });
          } else {
            const last = result[result.length - 1];
            if (last?.kind === "text") last.content += seg.content;
            else result.push({ kind: "text", content: seg.content });
          }
        });
      } else if (part.type.startsWith("tool-")) {
        const toolName = (part as any).toolName || (part as any).toolInvocation?.toolName || (!["tool-call", "tool-result", "tool-invocation"].includes(part.type) ? part.type.replace(/^tool-/, "") : "");
        if (toolName === "renderToSidebar" || toolName === "sidePanel" || toolName === "imageSearch" || toolName === "renderInChat") return;

        const toolInfo = {
          toolCallId: (part as any).toolCallId || (part as any).toolInvocation?.toolCallId,
          toolName,
          state: part.type === "tool-result" ? "result" : part.type === "tool-call" ? "call" : (part as any).state,
          output: (part as any).result || (part as any).output || (part as any).toolInvocation?.result,
        };

        const last = result[result.length - 1];
        if (last?.kind === "tools") {
          last.tools.push(toolInfo);
        } else {
          result.push({ kind: "tools", tools: [toolInfo] });
        }
      }
    });
    sidePanelSpecs.forEach(spec => {
      result.push({ kind: "spec", content: spec });
    });

    // Collect chat-ui-spec data parts (renderInChat results)
    message.parts.forEach((part: any) => {
      if (part.type === "data-chat-ui-spec" && part.data) {
        result.push({ kind: "spec", content: part.data });
      }
    });

    return result;
  }, [message.parts, (message as any).toolInvocations]);

  const hasAnything = segments.length > 0;
  const showLoader = isLast && isStreaming && message.role === "assistant" && !hasAnything;

  // ???�벨?�서 ?�스???�드�?직접 찾아 ?�이?�이?�하??가???�실??방식
  // [?�시 비활?�화] 충돌 �?무한 루프 방�?�??�해 ?�이?�이??기능 ?�시 ?�거
  useEffect(() => {
    /*
    if (!highlightTerm || !bubbleRef.current) return;

    if (highlightTurn !== undefined && highlightTurn !== null) {
      if (!turns || !turns.includes(highlightTurn)) {
        bubbleRef.current.querySelectorAll('.highlight-active-line').forEach(el => {
          el.classList.remove('highlight-active-line');
        });
        return;
      }
    }

    const term = highlightTerm.toLowerCase();

    const applyHighlight = () => {
      if (!bubbleRef.current) return;

      observer?.disconnect();

      bubbleRef.current.querySelectorAll('.highlight-active-line').forEach(el => {
        el.classList.remove('highlight-active-line');
      });

      const walker = document.createTreeWalker(
        bubbleRef.current,
        NodeFilter.SHOW_TEXT,
        null
      );

      let node;
      while (node = walker.nextNode()) {
        if (node.textContent?.toLowerCase().includes(term)) {
          const parent = node.parentElement;
          if (parent) {
            const target = parent.closest('p, li') || parent;
            if (target === bubbleRef.current) continue;
            target.classList.add('highlight-active-line');
          }
        }
      }

      if (bubbleRef.current && observer) {
        observer.observe(bubbleRef.current, { childList: true, subtree: true, characterData: true });
      }
    };

    const observer = new MutationObserver(() => applyHighlight());

    applyHighlight();
    observer.observe(bubbleRef.current, { childList: true, subtree: true, characterData: true });

    return () => {
      observer.disconnect();
      if (bubbleRef.current) {
        bubbleRef.current.querySelectorAll('.highlight-active-line').forEach(el => {
          el.classList.remove('highlight-active-line');
        });
      }
    };
    */
  }, [highlightTerm, highlightTurn, message.parts, turns]);

  if (isUser) {
    const rawText = message.parts
      .filter(p => p.type === 'text')
      .map(p => (p as any).text)
      .join("");

    const userText = rawText
      .split(/\n{1,2}\[CONTEXT:/)[0]
      .replace(/\n{1,2}\[DECISION CRITERIA:[\s\S]*?\]/g, "")
      .replace(/\n{1,2}\[USER CONTEXT:.*?\]/gs, "")
      .replace(/\n{1,2}\[ASSIGNED ITEM:.*?\]/gs, "")
      .trim();

    return (
      <div className="flex justify-end w-full">
        <div className="max-w-[85%] flex flex-col items-end gap-2">
          {userText && (
            <div className="rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap bg-slate-900 text-white rounded-tr-md shadow-sm">
              {userText}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={bubbleRef}
      className="w-full flex flex-col gap-3 relative group/message transition-all duration-700"
      data-turns={turns?.join(',')}
      id={turns && turns.length > 0 ? `v-turn-${turns[0]}` : undefined}
    >
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          const isLastSegment = i === segments.length - 1;
          const content = seg.content;
          if (!content.trim()) return null;

          return (
            <div
              key={`text-${i}-${highlightTerm || 'none'}`}
              className="relative z-10 text-sm leading-relaxed [&_p+p]:mt-3 [&_ul]:mt-2 [&_ol]:mt-2 [&_pre]:mt-2 select-none"
            >
              <Streamdown
                plugins={{ code }}
                animated={false}
              >
                {content}
              </Streamdown>
            </div>
          );
        }

        if (seg.kind === "spec") {
          return (
            <div key={`spec-${i}`} className="w-full">
              <ExplorerRenderer
                spec={seg.content}
                loading={isLast && isStreaming}
                bindings={{ onItemAdd, onCompareRequested, savedItems, isFollowUp, droppedCriteria, onRequestCriteriaData, onAddMyItemsToTable, isLatestMessage: isLast, userContext }}
              />
            </div>
          );
        }

        if (seg.kind === "tools") {
          return (
            <div key={`tools-${i}`} className="flex flex-col gap-1">
              {seg.tools.map((t) => (
                <ToolCallDisplay
                  key={t.toolCallId}
                  toolName={t.toolName}
                  state={t.state}
                  result={t.output}
                />
              ))}
            </div>
          );
        }
        return null;
      })}

      {showLoader && (
        <div className="flex items-center gap-2 text-muted-foreground animate-pulse">
          <Sparkles className="h-4 w-4" />
          <span className="text-sm italic">Thinking...</span>
        </div>
      )}
    </div>
  );
});

// =============================================================================
// Page
// =============================================================================

export default function ChatPage() {

  const [input, setInput] = useState("");
  const [hasStarted, setHasStarted] = useState(false);
  const [participantId, setParticipantId] = useState("");
  const [userContext, setUserContext] = useState("");
  const [assignedItem, setAssignedItem] = useState<"A" | "B" | "">("");
  const [droppedCriteria, setDroppedCriteria] = useState<{ name: string; min?: string; priority: string }[]>([]);
  const [searchCriteria, setSearchCriteria] = useState<{ name: string; min?: string; priority: string }[]>([]);
  const [droppedItems, setDroppedItems] = useState<{ name: string; image?: string; price?: string; description?: string; specs?: string[]; link?: string }[]>([]);
  const [mentionChips, setMentionChips] = useState<{ name: string; link?: string }[]>([]);
  const [editingCriteriaIdx, setEditingCriteriaIdx] = useState<number | null>(null);
  const [editingMinText, setEditingMinText] = useState("");
  const [openPriorityIdx, setOpenPriorityIdx] = useState<number | null>(null);
  const [highlightTerm, setHighlightTerm] = useState<string | null>(null);
  const [highlightTurn, setHighlightTurn] = useState<number | null>(null);
  const [journeyTab, setJourneyTab] = useState<"criteria" | "information">("criteria");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const isStickToBottom = useRef(true);
  const isAutoScrolling = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { messages, sendMessage, setMessages, status, error } =
    useChat<AppMessage>({ transport });

  const resetSession = useCallback(() => {
    setMessages([]);
    setDroppedItems([]);
    setDroppedCriteria([]);
    setSearchCriteria([]);
    setMentionChips([]);
    setHighlightTerm(null);
    setHighlightTurn(null);
    setInput("");
    setHasStarted(false);
  }, [setMessages]);

  useEffect(() => {
    const latestMessage = messages[messages.length - 1];
    if (latestMessage && latestMessage.role === "assistant") {
      console.group("AI Decision Debug");
      // @ts-ignore
      console.log("Found Assistant Message:", (latestMessage as any).content?.slice(0, 50) + "...");
      // @ts-ignore
      console.log("Tool Invocations:", latestMessage.toolInvocations);
      // @ts-ignore
      const hasUI = latestMessage.parts?.some((p: any) => p.type === "ui-spec");
      console.log("Is UI Generated?:", hasUI ? "??YES" : "??NO");
      console.groupEnd();
    }
  }, [messages]);

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const THRESHOLD = 80;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const atBottom = scrollTop + clientHeight >= scrollHeight - THRESHOLD;

      if (isAutoScrolling.current) {
        if (atBottom) {
          isAutoScrolling.current = false;
        }
        return;
      }

      isStickToBottom.current = atBottom;
      setShowScrollButton(!atBottom);
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const handleClickOutside = () => setOpenPriorityIdx(null);
    if (openPriorityIdx !== null) {
      document.addEventListener("click", handleClickOutside);
    }
    return () => document.removeEventListener("click", handleClickOutside);
  }, [openPriorityIdx]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !isStickToBottom.current) return;
    const timeoutId = setTimeout(() => {
      container.scrollTop = container.scrollHeight;
    }, 10);
    return () => clearTimeout(timeoutId);
  }, [messages, isStreaming]);

  // Auto-resize input textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = `${inputRef.current.scrollHeight}px`;
    }
  }, [input]);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    isStickToBottom.current = true;
    setShowScrollButton(false);
    isAutoScrolling.current = true;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, []);

  const handleSubmit = useCallback(
    async (text?: string) => {
      const message = text || input;
      if (!message.trim() && searchCriteria.length === 0 && mentionChips.length === 0 || isStreaming) return;
      setInput("");
      isStickToBottom.current = true;

      const criteriaContext = searchCriteria.length > 0
        ? `\n\n[CONTEXT: User is specifically interested in these criteria: ${searchCriteria.map(c => `${c.name}${c.min ? ` (${c.min})` : ""}`).join(", ")}]`
        : "";

      const visibleCriteria = searchCriteria.length > 0
        ? `[CRITERIA: ${searchCriteria.map(c => `${c.name}${c.min ? ` (${c.min})` : ""}`).join(", ")}] `
        : "";

      const mentionPrefix = mentionChips.length > 0
        ? `[My items : ${mentionChips.map(c => c.link ? `${c.name}|${c.link}` : c.name).join(", ")}] `
        : "";

      const cartContext = droppedItems.length > 0
        ? `\n\n[CONTEXT: User has these items in 'MY ITEMS' cart: ${droppedItems.map(i => i.name).join(", ")}]`
        : "";

      const savedCriteriaContext = droppedCriteria.length > 0
        ? `\n\n[DECISION CRITERIA: The user has saved these as personal decision criteria: ${droppedCriteria.map((c: any) => `${c.name}${c.min ? ` (${c.min})` : ''}`).join(', ')}. When generating a Table, include a value for each of these criteria in every data row (use the criterion name as the key). Do NOT replace or skip the normal Danawa-based spec columns — these criteria are supplemental row data, not the primary column source.]`
        : '';

      const userContextTag = userContext.trim()
        ? `\n\n[USER CONTEXT: ${userContext.trim()}]`
        : "";

      const assignedItemTag = assignedItem
        ? `\n\n[ASSIGNED ITEM: ${assignedItem}]`
        : "";

      setSearchCriteria([]);
      setMentionChips([]);
      await sendMessage({ text: visibleCriteria + mentionPrefix + message.trim() + criteriaContext + savedCriteriaContext + cartContext + userContextTag + assignedItemTag });
    },
    [input, isStreaming, sendMessage, droppedItems, droppedCriteria, searchCriteria, mentionChips, userContext],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleAddItem = useCallback((name: string, image?: string, price?: string, description?: string, specs?: string[], link?: string) => {
    if (name && !droppedItems.some(item => item.name === name)) {
      setDroppedItems((prev) => [...prev, { name, image, price, description, specs, link }]);
    }
  }, [droppedItems]);

  const handleRemoveItem = useCallback((name: string) => {
    setDroppedItems((prev) => prev.filter(item => item.name !== name));
  }, []);

  const insertMention = useCallback((name: string) => {
    // Look up the link from droppedItems so the agent can scrape directly
    const savedItem = droppedItems.find(item => item.name === name);
    const link = savedItem?.link;
    setMentionChips(prev => prev.some(c => c.name === name) ? prev : [...prev, { name, link }]);
    inputRef.current?.focus();
  }, [droppedItems]);

  const handleCompare = useCallback(
    (products: string[]) => {
      console.log("[handleCompare] products:", products);
      if (products.length === 0 || isStreaming) return;

      const updatePrompt = `[SYSTEM: CUMULATIVE COMPARISON] ${products.join(", ")} ?�품?�을 ??Table) 컴포?�트�??�용?�서 ?�세??비교?�줘. ?�전???�급???�용???�다�??�께 ?�함?�서 ?�시 ?��? 그려�? (IMPORTANT: Use your existing knowledge for products already mentioned. Do not perform a web search for them again. Just generate the updated table immediately.)`;

      // Find the anchor: the user message that prompted the comparison
      let anchorIdx = messages.findIndex(m => {
        const text = m.parts.filter(p => p.type === 'text').map(p => (p as any).text).join('');
        return m.role === "user" && text.includes("[SYSTEM: CUMULATIVE COMPARISON]");
      });

      if (anchorIdx === -1) {
        const firstTableIdx = messages.findIndex(m => {
          const text = m.parts.filter(p => p.type === 'text').map(p => (p as any).text).join('');
          return m.role === "assistant" && text.includes('"type": "Table"');
        });
        anchorIdx = firstTableIdx > 0 ? firstTableIdx - 1 : -1;
      }

      if (anchorIdx !== -1) {
        // 1. Create a copy of messages up to the anchor
        const newMessages = [...messages.slice(0, anchorIdx + 1)];
        // 2. Update the anchor message's content to the new cumulative prompt
        newMessages[anchorIdx] = {
          ...newMessages[anchorIdx],
          parts: [{ type: 'text', text: updatePrompt }]
        };
        // 3. Update the state
        setMessages(newMessages);
        // 4. Trigger new response
        setTimeout(() => sendMessage({ text: updatePrompt }), 50);
      } else {
        sendMessage({ text: updatePrompt });
      }
    },
    [isStreaming, sendMessage, messages, setMessages],
  );

  const isEmpty = messages.length === 0;

  const allSpecs = useMemo(() => {
    const specs: any[] = [];
    messages.forEach((m) => {
      // Path 1a: toolInvocations — populated after stream completes
      ((m as any).toolInvocations ?? []).forEach((ti: any) => {
        if (ti.toolName === "renderToSidebar" || ti.toolName === "sidePanel") {
          const res = ti.result || (ti as any).args?.spec;
          if (res) specs.push(res);
        }
      });

      // Path 1b: parts-based tool-result — reliable fallback for turn 1
      // (toolInvocations may not be populated yet on the first turn)
      (m.parts ?? []).forEach((p: any) => {
        const isToolResult =
          p.type === "tool-result" ||
          (p.type === "tool-invocation" && p.toolInvocation?.state === "result");
        if (isToolResult) {
          const toolName =
            p.toolName ||
            p.toolInvocation?.toolName ||
            "";
          if (toolName === "renderToSidebar" || toolName === "sidePanel") {
            const res = p.result ?? p.output ?? p.toolInvocation?.result;
            if (res) specs.push(typeof res === "string" ? (() => { try { return JSON.parse(res); } catch { return null; } })() : res);
          }
        }
      });

      // Path 2: data-spec parts — injected by route.ts after stream ends (authoritative)
      (m.parts ?? []).forEach((p: any) => {
        if (p.type === "ui-spec" && p.spec) specs.push(p.spec);
        if (p.type === "data-spec" && p.data) {
          if (p.data.type === "patch" && p.data.patch?.value) {
            specs.push(p.data.patch.value);
          } else if (p.data.type && p.data.type !== "patch") {
            specs.push(p.data);
          }
        }
      });
    });

    // Deduplicate: multiple paths may carry the same spec
    const seen = new Set<string>();
    return specs.filter((spec) => {
      if (!spec) return false;
      try {
        const key = JSON.stringify(spec);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      } catch {
        return true;
      }
    });
  }, [messages]);

  const sidebarSpec = useMemo(() => {
    let latestKnowledgeMapSpec: any = null;
    let latestOtherSpec: any = null;
    const conceptCards: any[] = [];
    const seenTerms = new Set<string>();

    allSpecs.forEach((raw) => {
      let spec = raw;
      if (typeof raw === "string") {
        try { spec = JSON.parse(raw); } catch { return; }
      }
      if (!spec || typeof spec !== "object") return;

      let effectiveSpec = spec;
      if (spec.root && spec.elements && spec.elements[spec.root]) {
        effectiveSpec = spec.elements[spec.root];
      }

      if (effectiveSpec.type === "ConceptCard") {
        const term = effectiveSpec.props?.term;
        if (term && !seenTerms.has(term)) {
          seenTerms.add(term);
          conceptCards.push(effectiveSpec.props);
        }
      } else if (effectiveSpec.type === "KnowledgeMap" || effectiveSpec.type === "Timeline") {
        const props = effectiveSpec.props || effectiveSpec;

        // KnowledgeMap: merge categories by label
        if (effectiveSpec.type === "KnowledgeMap") {
          const newCategories: any[] = Array.isArray(props.categories) ? props.categories : [];
          const merged: any[] = latestKnowledgeMapSpec?.props?.categories ?? [];

          newCategories.forEach((cat: any) => {
            const existingIdx = merged.findIndex((c: any) => c.label === cat.label);
            if (existingIdx > -1) {
              // Merge items by name
              const existingItems: any[] = merged[existingIdx].items ?? [];
              const newItems: any[] = cat.items ?? [];
              newItems.forEach((item: any) => {
                if (!existingItems.some((i: any) => i.name === item.name)) {
                  existingItems.push(item);
                } else {
                  // Update existing item
                  const idx = existingItems.findIndex((i: any) => i.name === item.name);
                  existingItems[idx] = { ...existingItems[idx], ...item };
                }
              });
              merged[existingIdx] = { ...merged[existingIdx], items: existingItems };
            } else {
              merged.push({ ...cat });
            }
          });

          latestKnowledgeMapSpec = {
            type: "KnowledgeMap",
            props: { categories: merged }
          };

          // Legacy Timeline support: convert to KnowledgeMap format
        } else if (effectiveSpec.type === "Timeline") {
          const turns = Array.isArray(props.turns) ? props.turns : [];
          const merged: any[] = latestKnowledgeMapSpec?.props?.categories ?? [];

          turns.forEach((turn: any) => {
            const label = turn.summary || `대화 ${turn.turn}`;
            const items = Array.isArray(turn.items) ? turn.items : [];
            const existingIdx = merged.findIndex((c: any) => c.label === label);
            if (existingIdx > -1) {
              items.forEach((item: any) => {
                if (!merged[existingIdx].items.some((i: any) => i.name === item.name)) {
                  merged[existingIdx].items.push(item);
                }
              });
            } else {
              merged.push({ label, items });
            }
          });

          latestKnowledgeMapSpec = {
            type: "KnowledgeMap",
            props: { categories: merged }
          };
        }
      } else {
        latestOtherSpec = spec;
      }
    });

    return { knowledgeMap: latestKnowledgeMapSpec, conceptCards };
  }, [allSpecs]);

  const scrollToTurn = useCallback((turnNumber: number, textToHighlight?: string) => {
    let targetElement: HTMLElement | null = null;
    const messageWithTurn = document.querySelector(`[data-turns*="${turnNumber}"]`) as HTMLElement;
    if (messageWithTurn) {
      const turns = (messageWithTurn.getAttribute('data-turns') ?? '').split(',');
      if (turns.includes(String(turnNumber))) {
        targetElement = messageWithTurn;
      }
    }
    if (!targetElement) {
      targetElement = document.getElementById(`v-turn-${turnNumber}`);
    }
    const coreTerm = textToHighlight ? textToHighlight.split(/[:(]/)[0].trim() : null;

    if (!targetElement && coreTerm) {
      const term = coreTerm.toLowerCase();
      const allMessages = document.querySelectorAll('.group\\/message');
      for (let i = allMessages.length - 1; i >= 0; i--) {
        const container = allMessages[i] as HTMLElement;
        if (container.textContent?.toLowerCase().includes(term)) {
          targetElement = container;
          break;
        }
      }
    }
    if (!targetElement) {
      const messageWithTurn = document.querySelector(`[data-turns*="${turnNumber}"]`) as HTMLElement;
      if (messageWithTurn) {
        const turns = (messageWithTurn.getAttribute('data-turns') ?? '').split(',');
        if (turns.includes(String(turnNumber))) targetElement = messageWithTurn;
      }
    }
    if (!targetElement) targetElement = document.getElementById(`v-turn-${turnNumber}`);
    if (!targetElement) return;

    targetElement.scrollIntoView({ behavior: "smooth", block: "center" });

    if (coreTerm) {
      // [?�시 비활?�화] ?�이?�이??기능 충돌�??�한 ?�거
      /*
      setHighlightTerm(coreTerm);
      setHighlightTurn(turnNumber);

      setTimeout(() => {
        const term = coreTerm.toLowerCase();
        const bubble = targetElement as HTMLElement;
        if (!bubble) return;

        const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) {
          if (node.textContent?.toLowerCase().includes(term)) {
            const parent = node.parentElement;
            if (parent) {
              const target = parent.closest('p, li') || parent;
              if (target === bubble) continue;
              target.classList.add('highlight-active-line');
            }
          }
        }
      }, 100);

      setTimeout(() => {
        setHighlightTerm((prev) => (prev === coreTerm ? null : prev));
        setHighlightTurn((prev) => (prev === turnNumber ? null : prev));
        if (targetElement) {
          targetElement.querySelectorAll('.highlight-active-line').forEach(el => {
            el.classList.remove('highlight-active-line');
          });
        }
      }, 3000);
      */
      targetElement.classList.add("bg-amber-50/50");
      setTimeout(() => { targetElement?.classList.remove("bg-amber-50/50"); }, 2000);
    } else {
      targetElement.classList.add("bg-amber-50/50");
      setTimeout(() => { targetElement?.classList.remove("bg-amber-50/50"); }, 2000);
    }
  }, [setHighlightTerm, setHighlightTurn]);
  const sidebarBindings = useMemo(() => ({
    onTurnClick: scrollToTurn
  }), [scrollToTurn]);

  const bubbleBindings = useMemo(() => ({
    onItemAdd: handleAddItem,
    onItemRemove: handleRemoveItem,
    onCompareRequested: handleCompare,
    savedItems: droppedItems,
    droppedCriteria: droppedCriteria,
    userContext,
    onRequestCriteriaData: (criteriaName: string, products: string[]) => {
      handleSubmit(`지금 비교 중인 ${products.join(', ')} 제품의 "${criteriaName}" 관련 값을 포함해서 비교표를 다시 만들어줘.`);
    },
    onAddMyItemsToTable: (currentProducts: string[], newItems: string[]) => {
      handleSubmit(`${[...currentProducts, ...newItems].join(', ')} 제품을 비교해줘. 이전 비교 기준을 모두 유지하면서 추가 제품을 포함해서 비교표를 만들어줘.`);
    },
  }), [handleAddItem, handleRemoveItem, handleCompare, droppedItems, droppedCriteria, userContext, handleSubmit]);

  if (!hasStarted) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-white">
        <div className="w-full max-w-lg flex flex-col gap-10 px-8 animate-in fade-in zoom-in-95 duration-700">
          {/* Branding */}
          <div className="flex flex-col gap-1">
            <h1 className="text-[48px] font-bold text-slate-900 tracking-tight leading-none">GenSpace</h1>
          </div>

          {/* Participant ID */}
          <div className="flex flex-col gap-3">
            <label className="text-[13px] font-semibold text-slate-900 uppercase tracking-widest">참가자ID</label>
            <input
              type="text"
              value={participantId}
              onChange={(e) => setParticipantId(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && participantId.trim()) setHasStarted(true); }}
              placeholder="P1"
              className="w-full border border-slate-200 rounded-[8px] px-5 py-4 text-[18px] font-medium text-slate-800 placeholder:text-slate-300 outline-none focus:border-slate-400 transition-colors bg-[#FAFAFA]"
              autoFocus
            />
          </div>

          {/* Assigned item */}
          <div className="flex flex-col gap-3">
            <label className="text-[13px] font-semibold text-slate-900 uppercase tracking-widest">배정받은 아이템</label>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setAssignedItem("A")}
                className={`flex-1 py-4 rounded-[8px] text-[15px] font-semibold border transition-all duration-200 ${assignedItem === "A"
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-[#FAFAFA] text-slate-400 border-slate-200 hover:border-slate-400 hover:text-slate-600"
                  }`}
              >
                유모차
              </button>
              <button
                type="button"
                onClick={() => setAssignedItem("B")}
                className={`flex-1 py-4 rounded-[8px] text-[15px] font-semibold border transition-all duration-200 ${assignedItem === "B"
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-[#FAFAFA] text-slate-400 border-slate-200 hover:border-slate-400 hover:text-slate-600"
                  }`}
              >
                로봇 청소기
              </button>
            </div>
          </div>

          {/* User context */}
          <div className="flex flex-col gap-3">
            <label className="text-[13px] font-semibold text-slate-900 uppercase tracking-widest">구매 목적 및 상황</label>
            <textarea
              value={userContext}
              onChange={(e) => setUserContext(e.target.value)}
              placeholder="예: 외출이 잦고 혼자 다녀요. 가볍고 휴대하기 편한 게 중요해요."
              rows={3}
              className="w-full border border-slate-200 rounded-[8px] px-5 py-4 text-[15px] font-medium text-slate-800 placeholder:text-slate-300 outline-none focus:border-slate-400 transition-colors bg-[#FAFAFA] resize-none leading-relaxed"
            />
          </div>

          {/* Start button */}
          <button
            onClick={() => { if (participantId.trim()) setHasStarted(true); }}
            disabled={!participantId.trim()}
            className="w-full py-4 rounded-[8px] bg-slate-900 text-white text-[16px] font-semibold tracking-tight hover:bg-black active:scale-[0.98] transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            시작하기
          </button>
        </div>
      </div>
    );
  }


  return (
    <div className="h-screen flex flex-col w-full overflow-hidden bg-white">
      {/* Full-width white header */}
      <div className="shrink-0 bg-white border-b border-[#E5DED7] px-8 py-4 flex items-center justify-between">
        <button
          type="button"
          onClick={() => resetSession()}
          className="text-[22px] font-bold text-slate-900 tracking-tight leading-tight hover:text-slate-600 transition-colors cursor-pointer"
        >
          GenSpace
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm("세션을 종료하고 처음 화면으로 돌아가시겠습니까?")) {
              resetSession();
            }
          }}
          className="px-4 py-2 rounded-[8px] text-[13px] font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-all duration-200"
        >
          끝내기
        </button>
      </div>

      <div className="flex-1 flex justify-center w-full overflow-hidden bg-white">
        <div className="flex w-full max-w-[1800px] h-full overflow-hidden gap-16">
          <aside className="w-[470px] self-start max-h-[calc(100vh-6rem)] p-4 pt-6 pb-6 flex-shrink-0 bg-transparent z-10 flex flex-col">
            <div className="flex flex-col min-h-0 bg-white border border-[#E5E5E5] rounded-[8px] p-6">
              {/* Panel header */}
              <div className="flex items-center justify-between mb-4 flex-shrink-0 border-b border-slate-100 pb-3">
                <p className="text-[11px] font-black text-slate-600 tracking-widest uppercase whitespace-nowrap">📚 Exploration Journey</p>

                {/* Criteria / Information segment control */}
                <div className="flex items-center bg-[#F0F0F0] rounded-[8px] p-[3px] gap-[2px]">
                  <button
                    type="button"
                    onClick={() => setJourneyTab("criteria")}
                    className={`px-3 py-1.5 rounded-[6px] text-[11px] font-semibold transition-all duration-200 ${journeyTab === "criteria"
                      ? "bg-white text-slate-800 shadow-sm"
                      : "text-slate-400 hover:text-slate-600"
                      }`}
                  >
                    Criteria
                  </button>
                  <button
                    type="button"
                    onClick={() => setJourneyTab("information")}
                    className={`px-3 py-1.5 rounded-[6px] text-[11px] font-semibold transition-all duration-200 ${journeyTab === "information"
                      ? "bg-white text-slate-800 shadow-sm"
                      : "text-slate-400 hover:text-slate-600"
                      }`}
                  >
                    Information
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto styled-scrollbar pr-1">
                {/* Criteria tab — always mounted to preserve collapsed state */}
                <div className={journeyTab === "criteria" ? "" : "hidden"}>
                  {sidebarSpec.knowledgeMap ? (
                    <ExplorerRenderer
                      spec={sidebarSpec.knowledgeMap}
                      bindings={sidebarBindings}
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full gap-2 py-12">
                      <p className="text-[12px] text-slate-300 font-medium text-center leading-relaxed">
                        대화를 시작하면<br />여기에 탐색 기록이 쌓여요
                      </p>
                    </div>
                  )}
                </div>
                {/* Information tab — always mounted to preserve scroll */}
                <div className={journeyTab === "information" ? "" : "hidden"}>
                  {sidebarSpec.conceptCards.length > 0 ? (
                    <div className="flex flex-col gap-3 py-1">
                      {sidebarSpec.conceptCards.map((card: any, i: number) => (
                        <div
                          key={`${card.term}-${i}`}
                          className="border border-slate-200 rounded-[8px] p-4 bg-white animate-chip-in"
                          style={{ animationDelay: `${i * 0.08}s` }}
                        >
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <span className="text-[13px] font-bold text-slate-900">{card.term}</span>
                          </div>
                          <p className="text-[12px] text-slate-500 mb-3 leading-relaxed">{card.summary}</p>
                          {Array.isArray(card.points) && card.points.length > 0 && (
                            <ul className="flex flex-col gap-1.5">
                              {card.points.map((pt: string, j: number) => (
                                <li
                                  key={j}
                                  className="flex items-start gap-2 text-[12px] text-slate-700"
                                >
                                  <span className="mt-[5px] w-1 h-1 rounded-full bg-slate-400 flex-shrink-0" />
                                  {pt}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full gap-2 py-12">
                      <p className="text-[12px] text-slate-300 font-medium text-center leading-relaxed">
                        개념 질문을 하면<br />여기에 설명이 쌓여요
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </aside>

          <div className="flex-1 flex flex-col h-full overflow-hidden relative bg-white shadow-[0_0_12px_rgba(0,0,0,0.04)]">

            <main
              ref={scrollContainerRef}
              className="flex-1 overflow-y-auto px-8 pb-6 no-scrollbar scroll-smooth"
            >
              <div className="max-w-6xl mx-auto space-y-12 pb-32 pt-8">
                {messages.map((m, idx) => {
                  // Hide internal system prompt turns from the user
                  const isSystemPrompt = m.role === "user" && m.parts.some(p => p.type === "text" && p.text.includes("[SYSTEM: CUMULATIVE COMPARISON]"));
                  if (isSystemPrompt) return null;

                  const hasPreviousComparison = messages.slice(0, idx).some(prev =>
                    prev.parts.some(p => p.type === "text" && /"type"\s*:\s*"(Table|ComparisonSelector)"/i.test(p.text))
                  );
                  const msgTurns: number[] = [];
                  ((m as any).toolInvocations ?? []).forEach((ti: any) => {
                    if (ti.toolName === "renderToSidebar" || ti.toolName === "sidePanel") {
                      const spec = ti.result || (ti as any).args?.spec;
                      if (spec?.turns) spec.turns.forEach((t: any) => { if (t.turn) msgTurns.push(t.turn); });
                    }
                  });
                  (m.parts ?? []).forEach((p: any) => {
                    if (p.type === "text" && p.text) {
                      const matches = p.text.match(/"turn":\s*(\d+)/g);
                      if (matches) matches.forEach((match: string) => {
                        const num = parseInt(match.split(":")[1].trim());
                        if (!isNaN(num) && !msgTurns.includes(num)) msgTurns.push(num);
                      });
                    }
                  });

                  return (
                    <MessageBubble
                      key={m.id}
                      message={m}
                      isLast={idx === messages.length - 1}
                      isStreaming={isStreaming && idx === messages.length - 1}
                      bindings={bubbleBindings}
                      highlightTerm={highlightTerm}
                      highlightTurn={highlightTurn}
                      isFollowUp={hasPreviousComparison}
                      turns={msgTurns}
                    />
                  );
                })}
                {error && (
                  <div className="p-4 rounded-2xl bg-red-50 border border-red-100 text-red-600 text-sm font-medium animate-in slide-in-from-bottom-4">
                    {error.message}
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </main>

            <div className="px-6 pb-6 flex-shrink-0 bg-white/80 backdrop-blur-md border-t border-slate-50 relative">
              {showScrollButton && (
                <button
                  onClick={scrollToBottom}
                  className="absolute left-1/2 -translate-x-1/2 -top-12 z-10 h-10 w-10 rounded-full border border-slate-200 bg-white text-slate-400 shadow-xl flex items-center justify-center hover:text-slate-900 hover:border-slate-900 transition-all"
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
              )}
              <div className="max-w-2xl mx-auto relative pt-2">
                <div
                  onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("bg-slate-50", "border-slate-300"); }}
                  onDragLeave={(e) => { e.currentTarget.classList.remove("bg-slate-50", "border-slate-300"); }}
                  onDrop={(e: React.DragEvent<HTMLDivElement>) => {
                    e.preventDefault();
                    e.currentTarget.classList.remove("bg-slate-50", "border-slate-300");
                    const jsonData = e.dataTransfer.getData("application/json");
                    const label = e.dataTransfer.getData("text/plain");

                    if (jsonData) {
                      try {
                        const item = JSON.parse(jsonData);
                        if (item.name && !searchCriteria.some(c => c.name === item.name)) {
                          setSearchCriteria((prev) => [...prev, {
                            name: item.name,
                            min: item.min,
                            priority: item.priority || "medium"
                          }]);
                        }
                      } catch (e) {
                        if (label && !searchCriteria.some(c => c.name === label)) {
                          setSearchCriteria((prev) => [...prev, { name: label, priority: "medium" }]);
                        }
                      }
                    } else if (label && !searchCriteria.some(c => c.name === label)) {
                      setSearchCriteria((prev) => [...prev, { name: label, priority: "medium" }]);
                    }
                  }}
                  className="flex flex-col gap-1.5 bg-white border border-slate-100 rounded-[28px] p-1.5 pl-3 shadow-xl shadow-slate-100/50 hover:shadow-slate-200/50 transition-all focus-within:border-slate-300"
                >
                  {/* Chips row — wraps freely above the textarea */}
                  {(mentionChips.length > 0 || searchCriteria.length > 0) && (
                    <div className="flex flex-wrap gap-1.5 pt-1 px-0.5">
                      {mentionChips.map((chip, i) => (
                        <div key={i} className="flex items-center gap-1.5 bg-slate-50 border border-slate-100 rounded-full px-2 py-0.5 animate-in zoom-in-95 duration-200">
                          <span className="text-[12px] font-bold text-slate-800">{chip.name}</span>
                          <button
                            onClick={() => setMentionChips(prev => prev.filter((_, idx) => idx !== i))}
                            className="ml-1 p-0.5 text-slate-300 hover:text-slate-900 transition-colors"
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      ))}
                      {searchCriteria.map((c, i) => (
                        <div key={i} className="flex items-center gap-1.5 bg-slate-50 border border-slate-100 rounded-full px-2 py-0.5 animate-in zoom-in-95 duration-200">
                          <span className="text-[12px] font-bold text-slate-800">{c.name}</span>
                          {c.min && <span className="text-[10px] text-slate-500 font-medium">{c.min}</span>}
                          <button
                            onClick={() => setSearchCriteria(prev => prev.filter((_, idx) => idx !== i))}
                            className="ml-1 p-0.5 text-slate-300 hover:text-slate-900 transition-colors"
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Textarea + send button always on their own row */}
                  <div className="flex items-center gap-1">
                    <textarea
                      ref={inputRef}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={(searchCriteria.length > 0 || mentionChips.length > 0) ? "" : "무엇이든 물어보세요"}
                      rows={1}
                      className="flex-1 bg-transparent border-none focus:ring-0 focus:outline-none focus-visible:ring-0 resize-none text-slate-800 placeholder:text-slate-400 py-2.5 text-[15px] font-medium min-w-0 max-h-[160px]"
                    />
                    <button
                      onClick={() => handleSubmit()}
                      disabled={(!input.trim() && searchCriteria.length === 0 && mentionChips.length === 0) || isStreaming}
                      className="w-9 h-9 rounded-full bg-slate-900 flex items-center justify-center text-white hover:bg-black active:scale-95 transition-all shadow-md shrink-0 ml-1"
                    >
                      {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4 stroke-[2.5px]" />}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <aside className="w-[360px] p-4 pt-6 pb-6 flex-shrink-0 bg-transparent overflow-auto no-scrollbar z-10">
            <div className="flex flex-col gap-6">
              <div
                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("bg-primary/5", "border-primary/30"); }}
                onDragLeave={(e) => { e.currentTarget.classList.remove("bg-primary/5", "border-primary/30"); }}
                onDrop={(e: React.DragEvent<HTMLDivElement>) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove("bg-primary/5", "border-primary/30");
                  const jsonData = e.dataTransfer.getData("application/json");
                  const label = e.dataTransfer.getData("text/plain");

                  if (jsonData) {
                    try {
                      const item = JSON.parse(jsonData);
                      if (item.name && !droppedCriteria.some(c => c.name === item.name)) {
                        setDroppedCriteria((prev) => [...prev, {
                          name: item.name,
                          min: item.min,
                          priority: item.priority || "medium"
                        }]);
                      }
                    } catch (e) {
                      if (label && !droppedCriteria.some(c => c.name === label)) {
                        setDroppedCriteria((prev) => [...prev, { name: label, priority: "medium" }]);
                      }
                    }
                  } else if (label && !droppedCriteria.some(c => c.name === label)) {
                    setDroppedCriteria((prev) => [...prev, { name: label, priority: "medium" }]);
                  }
                }}
                className="flex flex-col gap-4 p-6 bg-white border border-[#E5E5E5] rounded-[8px] min-h-[250px] h-full"
              >
                <div className="flex items-center justify-between">
                  <p className="text-[12px] font-black text-slate-600 tracking-widest uppercase"> 🎯 DECISION CRITERIA</p>
                  {droppedCriteria.length > 0 && (
                    <span className="text-[12px] font-normal text-slate-300">({droppedCriteria.length})</span>
                  )}
                </div>
                <div className="flex flex-col gap-3 flex-1">
                  {droppedCriteria.length > 0 ? (
                    <div className="flex flex-col gap-3 w-full items-start">
                      {droppedCriteria.map((criterion, i) => (
                        <div
                          key={i}
                          onClick={() => {
                            if (!searchCriteria.some(c => c.name === criterion.name)) {
                              setSearchCriteria(prev => [...prev, { name: criterion.name, min: criterion.min, priority: criterion.priority }]);
                            }
                            inputRef.current?.focus();
                          }}
                          className="flex items-center gap-2 bg-white border border-slate-200 rounded-2xl px-2.5 h-[30px] w-fit max-w-full group animate-in zoom-in-95 duration-200 cursor-pointer hover:bg-slate-50 hover:border-slate-300 transition-colors"
                        >
                          <div className="flex items-baseline gap-1.5 overflow-hidden min-w-0">
                            <span className="text-[12px] font-bold text-slate-800 select-none whitespace-nowrap shrink-0">
                              {criterion.name}
                            </span>
                            {editingCriteriaIdx === i ? (
                              <input
                                autoFocus
                                className="text-[10px] text-slate-500 border-b border-slate-300 outline-none w-[60px] bg-transparent py-0 shrink-0"
                                value={editingMinText}
                                onChange={(e) => setEditingMinText(e.target.value)}
                                onBlur={() => {
                                  setDroppedCriteria(prev => {
                                    const next = [...prev];
                                    next[i] = { ...next[i], min: editingMinText };
                                    return next;
                                  });
                                  setEditingCriteriaIdx(null);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") e.currentTarget.blur();
                                }}
                              />
                            ) : (
                              <span
                                className="text-[10px] text-slate-500 font-medium select-none truncate"
                                title={criterion.min || "입력"}
                              >
                                {criterion.min || "입력"}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-0.5 ml-1 pl-1 border-l border-slate-100">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingCriteriaIdx(i);
                                setEditingMinText(criterion.min || "");
                              }}
                              className="p-0.5 text-slate-300 hover:text-slate-600 transition-colors"
                            >
                              <Pencil className="w-2.5 h-2.5" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setDroppedCriteria(prev => prev.filter((_, idx) => idx !== i)); }}
                              className="p-0.5 text-slate-300 hover:text-slate-900 transition-colors"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex-1 flex items-center justify-center">
                      <p className="text-[12px] text-slate-300 font-medium text-center leading-relaxed">
                        기준 칩을 드래그해<br />여기에 고정해두세요
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-4 p-6 bg-white border border-[#E5E5E5] rounded-[8px] min-h-[250px] h-full">
                <div className="flex items-center justify-between">
                  <p className="text-[12px] font-black text-slate-600 tracking-widest uppercase"> 📦 MY ITEMS</p>
                  {droppedItems.length > 0 && (
                    <span className="text-[12px] font-normal text-slate-300">({droppedItems.length})</span>
                  )}
                </div>
                <div className="flex flex-col gap-2 flex-1">
                  {droppedItems.length > 0 ? (
                    droppedItems.map((item, i) => (
                      <div key={i} onClick={() => insertMention(item.name)} className="group relative rounded-[8px] bg-white border border-slate-200 p-3 flex items-center gap-3 animate-in zoom-in-95 duration-200 hover:border-slate-300 transition-all cursor-pointer">
                        <button
                          onClick={(e) => { e.stopPropagation(); setDroppedItems((prev) => prev.filter((c) => c.name !== item.name)); }}
                          className="absolute top-2 right-2 text-slate-300 hover:text-slate-700 transition-colors z-10"
                        >
                          <X className="w-3 h-3" />
                        </button>

                        {/* Thumbnail */}
                        <div className="w-12 h-12 rounded-[4px] bg-slate-50 border border-slate-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
                          {item.image ? (
                            <img src={item.image} alt={item.name} className="w-full h-full object-cover" />
                          ) : (
                            <span className="text-[18px] font-black text-slate-300 uppercase">{item.name[0]}</span>
                          )}
                        </div>

                        {/* Info */}
                        <div className="flex flex-col min-w-0 flex-1 pr-4 gap-0.5">
                          <p className="text-[11px] font-semibold text-slate-900 leading-tight break-keep">{item.name}</p>
                          {item.price && (
                            <span className="text-[11px] font-medium text-slate-500">{item.price}</span>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="flex-1 flex items-center justify-center">
                      <p className="text-[12px] text-slate-300 font-medium text-center leading-relaxed flex flex-col items-center gap-1">
                        <span className="flex items-center gap-1.5">
                          관심 제품의
                          <span className="inline-flex items-center justify-center w-[20px] h-[20px] rounded-full bg-slate-300/60">
                            <Heart className="w-[10px] h-[10px] text-white" fill="white" strokeWidth={0} />
                          </span>
                          를 눌러
                        </span>
                        <span>여기에 담아보세요</span>
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div >
    </div >
  );
}



