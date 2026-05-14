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
} from "lucide-react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

// =============================================================================
// Types
// =============================================================================

type AppDataParts = { [SPEC_DATA_PART]: SpecDataPart };
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
  isFollowUp,
  turns,
}: {
  message: AppMessage;
  isLast: boolean;
  isStreaming: boolean;
  bindings: {
    onItemAdd?: (name: string, image?: string) => void;
    onCompareRequested?: (products: string[]) => void;
    savedItems?: any[];
  };
  highlightTerm?: string | null;
  isFollowUp?: boolean;
  turns?: number[];
}) => {
  const { onItemAdd, onCompareRequested, savedItems } = bindings;
  const isUser = message.role === "user";
  const bubbleRef = useRef<HTMLDivElement>(null);

  const segments = useMemo(() => {
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
            const isTimeline = spec?.type === "Timeline" || (spec?.root && spec?.elements?.[spec.root]?.type === "Timeline");
            if (!isTimeline) result.push({ kind: "spec", content: spec });
          } else {
            const last = result[result.length - 1];
            if (last?.kind === "text") last.content += seg.content;
            else result.push({ kind: "text", content: seg.content });
          }
        });
      } else if (part.type.startsWith("tool-")) {
        const toolName = part.type.replace(/^tool-/, "");
        if (toolName === "renderToSidebar" || toolName === "imageSearch") return;

        const toolInfo = {
          toolCallId: part.toolCallId,
          toolName,
          state: part.state,
          output: part.output,
        };

        const last = result[result.length - 1];
        if (last?.kind === "tools") {
          last.tools.push(toolInfo);
        } else {
          result.push({ kind: "tools", tools: [toolInfo] });
        }
      }
    });
    return result;
  }, [message.parts]);

  const hasAnything = segments.length > 0;
  const showLoader = isLast && isStreaming && message.role === "assistant" && !hasAnything;

  // 돔 레벨에서 텍스트 노드를 직접 찾아 하이라이트하는 가장 확실한 방식
  useEffect(() => {
    if (!highlightTerm || !bubbleRef.current) return;

    const term = highlightTerm.toLowerCase();

    const applyHighlight = () => {
      if (!bubbleRef.current) return;

      // 옵저버 잠시 중단 (무한 루프 방지)
      observer?.disconnect();

      // 이전에 적용된 하이라이트 제거 (Unwrap 방식)
      bubbleRef.current.querySelectorAll('.highlight-active-line').forEach(span => {
        const parent = span.parentNode;
        if (parent) {
          while (span.firstChild) parent.insertBefore(span.firstChild, span);
          parent.removeChild(span);
        }
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
            // 가장 가까운 단락(p) 또는 리스트 항목(li)을 찾아 전체 하이라이트
            const target = parent.closest('p, li') || parent;
            // 최상위 컨테이너 자체는 하이라이트하지 않음 (전체 노란색 방지)
            if (target === bubbleRef.current) continue;
            
            target.classList.add('highlight-active-line');
          }
        }
      }

      // 옵저버 재시작
      if (bubbleRef.current && observer) {
        observer.observe(bubbleRef.current, { childList: true, subtree: true, characterData: true });
      }
    };

    const observer = new MutationObserver(() => applyHighlight());
    
    // 초기 실행 및 옵저버 설정
    applyHighlight();
    observer.observe(bubbleRef.current, { childList: true, subtree: true, characterData: true });

    return () => {
      observer.disconnect();
      if (bubbleRef.current) {
        bubbleRef.current.querySelectorAll('.highlight-active-line').forEach(span => {
          const parent = span.parentNode;
          if (parent) {
            while (span.firstChild) parent.insertBefore(span.firstChild, span);
            parent.removeChild(span);
          }
        });
      }
    };
  }, [highlightTerm, message.parts]);

  if (isUser) {
    const rawText = message.parts
      .filter(p => p.type === 'text')
      .map(p => (p as any).text)
      .join("");

    const userText = rawText
      .replace(/\[CONTEXT:.*?\]/gs, "")
      .replace(/\[CRITERIA:(.*?)\]/gs, (_, criteria) => `[Decision Criteria : ${criteria.trim()}] `)
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
                animated={isLast && isStreaming && isLastSegment}
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
                bindings={{ onItemAdd, onCompareRequested, savedItems, isFollowUp }}
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
  const [droppedCriteria, setDroppedCriteria] = useState<{ name: string; min?: string; priority: string }[]>([]);
  const [searchCriteria, setSearchCriteria] = useState<{ name: string; min?: string; priority: string }[]>([]);
  const [droppedItems, setDroppedItems] = useState<{ name: string; image?: string }[]>([]);
  const [editingCriteriaIdx, setEditingCriteriaIdx] = useState<number | null>(null);
  const [editingMinText, setEditingMinText] = useState("");
  const [openPriorityIdx, setOpenPriorityIdx] = useState<number | null>(null);
  const [highlightTerm, setHighlightTerm] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const isStickToBottom = useRef(true);
  const isAutoScrolling = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { messages, sendMessage, setMessages, status, error } =
    useChat<AppMessage>({ transport });

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
      console.log("Is UI Generated?:", hasUI ? "✅ YES" : "❌ NO");
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
      if (!message.trim() && searchCriteria.length === 0 || isStreaming) return;
      setInput("");
      isStickToBottom.current = true;

      const criteriaContext = searchCriteria.length > 0
        ? `\n\n[CONTEXT: User is specifically interested in these criteria: ${searchCriteria.map(c => `${c.name}${c.min ? ` (${c.min})` : ""}`).join(", ")}]`
        : "";

      const visibleCriteria = searchCriteria.length > 0
        ? `[CRITERIA: ${searchCriteria.map(c => `${c.name}${c.min ? ` (${c.min})` : ""}`).join(", ")}] `
        : "";

      const cartContext = droppedItems.length > 0
        ? `\n\n[CONTEXT: User has these items in 'MY ITEMS' cart: ${droppedItems.map(i => i.name).join(", ")}]`
        : "";

      await sendMessage({ text: visibleCriteria + message.trim() + criteriaContext + cartContext });
      setSearchCriteria([]); // Clear after search
    },
    [input, isStreaming, sendMessage, droppedItems, searchCriteria],
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

  const handleAddItem = useCallback((name: string, image?: string) => {
    if (name && !droppedItems.some(item => item.name === name)) {
      setDroppedItems((prev) => [...prev, { name, image }]);
    }
  }, [droppedItems]);

  const handleCompare = useCallback(
    (products: string[]) => {
      console.log("[handleCompare] products:", products);
      if (products.length === 0 || isStreaming) return;

      const updatePrompt = `[SYSTEM: CUMULATIVE COMPARISON] ${products.join(", ")} 제품들을 표(Table) 컴포넌트를 사용해서 상세히 비교해줘. 이전에 언급된 내용이 있다면 함께 포함해서 다시 표를 그려줘. (IMPORTANT: Use your existing knowledge for products already mentioned. Do not perform a web search for them again. Just generate the updated table immediately.)`;

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
    messages.forEach((m, idx) => {
      // AI 응답이 스트리밍 중일 때는 해당 메시지의 Spec을 추출하지 않음
      // 사용자가 "AI 응답이 나오고 그 다음에 Chip이 생성되게" 하길 원하므로,
      // 마지막 메시지가 assistant이고 스트리밍 중인 경우 건너뜁니다.
      const isLast = idx === messages.length - 1;
      if (isLast && isStreaming && m.role === "assistant") {
        return;
      }

      ((m as any).toolInvocations ?? []).forEach((ti: any) => {
        if (ti.toolName === "renderToSidebar") {
          const res = ti.result || (ti as any).args?.spec;
          if (res) specs.push(res);
        }
      });

      (m.parts ?? []).forEach((p: any) => {
        if (p.type === "ui-spec" && p.spec) specs.push(p.spec);
        if (p.type === "data-spec" && p.data) {
          if (p.data.type === "patch" && p.data.patch?.value) {
            specs.push(p.data.patch.value);
          } else if (p.data.type && p.data.type !== "patch") {
            specs.push(p.data);
          }
        }
        if (p.type.startsWith("tool-") && p.type.replace(/^tool-/, "") === "renderToSidebar") {
          const res = p.output || p.result || p.args?.spec;
          if (res) specs.push(res);
        }

        if (p.type === "text" && p.text) {
          let depth = 0, start = -1;
          const text = p.text;
          for (let i = 0; i < text.length; i++) {
            if (text[i] === '{') { if (depth === 0) start = i; depth++; }
            else if (text[i] === '}') {
              if (depth > 0) {
                depth--;
                if (depth === 0 && start !== -1) {
                  const jsonStr = text.substring(start, i + 1);
                  try {
                    const parsed = JSON.parse(jsonStr);
                    if (parsed?.type === "Timeline" || parsed?.spec?.type === "Timeline") {
                      specs.push(parsed.spec || parsed);
                    }
                  } catch (e) { }
                  start = -1;
                }
              }
            }
          }
        }
      });

      const content = m.parts?.filter(p => p.type === 'text').map(p => (p as any).text).join('') || "";
      if (content) {
        let depth = 0, start = -1;
        for (let i = 0; i < content.length; i++) {
          if (content[i] === '{') { if (depth === 0) start = i; depth++; }
          else if (content[i] === '}') {
            if (depth > 0) {
              depth--;
              if (depth === 0 && start !== -1) {
                const jsonStr = content.substring(start, i + 1);
                try {
                  const parsed = JSON.parse(jsonStr);
                  if (parsed?.type === "Timeline" || parsed?.spec?.type === "Timeline") {
                    specs.push(parsed.spec || parsed);
                  }
                } catch (e) { }
                start = -1;
              }
            }
          }
        }
      }
    });
    return specs;
  }, [messages, isStreaming]);

  const sidebarSpec = useMemo(() => {
    let combinedTurns: any[] = [];
    let combinedItems: any[] = [];
    let latestTimelineSpec: any = null;
    let latestOtherSpec: any = null;

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

      if (effectiveSpec.type === "Timeline") {
        const props = effectiveSpec.props || effectiveSpec;
        const turns = Array.isArray(props.turns) ? props.turns : [];
        turns.forEach((turn: any) => {
          if (!turn) return;
          const turnNum = typeof turn.turn === "number" ? turn.turn : parseInt(String(turn.turn), 10);
          if (isNaN(turnNum)) return;
          const existingIdx = combinedTurns.findIndex((t) => t.turn === turnNum);
          if (existingIdx > -1) combinedTurns[existingIdx] = { ...combinedTurns[existingIdx], ...turn, turn: turnNum };
          else combinedTurns.push({ ...turn, turn: turnNum });
        });

        const items = Array.isArray(props.items) ? props.items : [];
        items.forEach((item: any) => {
          if (!item || !item.name) return;
          const existingIdx = combinedItems.findIndex((i) => i.name === item.name);
          if (existingIdx > -1) combinedItems[existingIdx] = { ...combinedItems[existingIdx], ...item };
          else combinedItems.push(item);
        });

        latestTimelineSpec = {
          ...effectiveSpec,
          type: "Timeline",
          props: {
            ...(effectiveSpec.props || effectiveSpec),
            turns: combinedTurns.length > 0 ? [...combinedTurns].sort((a, b) => a.turn - b.turn) : undefined,
            items: combinedItems.length > 0 ? [...combinedItems] : undefined
          }
        };
      } else {
        latestOtherSpec = spec;
      }
    });

    const lastRawSpec = allSpecs[allSpecs.length - 1];
    let lastSpecType = "";
    if (lastRawSpec) {
      try {
        const parsed = typeof lastRawSpec === "string" ? JSON.parse(lastRawSpec) : lastRawSpec;
        lastSpecType = parsed?.type || "";
      } catch { }
    }
    return (lastSpecType && lastSpecType !== "Timeline") ? latestOtherSpec : latestTimelineSpec;
  }, [allSpecs]);

  const scrollToTurn = useCallback((turnNumber: number, textToHighlight?: string) => {
    let targetElement: HTMLElement | null = null;
    const coreTerm = textToHighlight ? textToHighlight.split(/[:(]/)[0].trim() : null;

    if (coreTerm) {
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
      setHighlightTerm(coreTerm);
      
      // 즉각적인 하이라이트 적용 (3초 유지)
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
              // 가장 가까운 단락(p) 또는 리스트 항목(li)을 찾아 전체 하이라이트
              const target = parent.closest('p, li') || parent;
              if (target === bubble) continue; // 버블 전체는 제외
              
              target.classList.add('highlight-active-line');
            }
          }
        }
      }, 100);

      setTimeout(() => { 
        setHighlightTerm((prev) => (prev === coreTerm ? null : prev));
        if (targetElement) {
          targetElement.querySelectorAll('.highlight-active-line').forEach(el => {
            el.classList.remove('highlight-active-line');
          });
        }
      }, 3000);
    } else {
      targetElement.classList.add("bg-amber-50/50");
      setTimeout(() => { targetElement?.classList.remove("bg-amber-50/50"); }, 2000);
    }
  }, [setHighlightTerm]);
  const sidebarBindings = useMemo(() => ({
    onTurnClick: scrollToTurn
  }), [scrollToTurn]);

  const bubbleBindings = useMemo(() => ({
    onItemAdd: handleAddItem,
    onCompareRequested: handleCompare,
    savedItems: droppedItems
  }), [handleAddItem, handleCompare, droppedItems]);

  return (
    <div className="h-screen flex flex-col w-full overflow-hidden bg-background">
      <div className="flex-1 flex justify-center w-full overflow-hidden bg-background">
        <div className="flex w-full max-w-[1800px] h-full overflow-hidden gap-16">
          {!isEmpty && (
            <aside className="w-[440px] p-6 pb-20 flex-shrink-0 bg-muted/5 overflow-auto no-scrollbar border-r border-slate-50 z-10">
              <div className="flex flex-col gap-8">
                <div className="flex flex-col gap-4 p-6 bg-white border border-slate-100 rounded-3xl shadow-none min-h-[250px]">
                  <div className="flex flex-col gap-1 mb-2">
                    <p className="text-[10px] font-black text-slate-400 tracking-widest uppercase"> 🛣️ DECISION JOURNEY</p>
                    <p className="text-[11px] text-muted-foreground">대화의 흐름에 따른 분석 과정입니다.</p>
                  </div>
                  {sidebarSpec && (
                    <ExplorerRenderer
                      spec={sidebarSpec}
                      bindings={sidebarBindings}
                    />
                  )}
                </div>
              </div>
            </aside>
          )}

          <div className="flex-1 flex flex-col h-full overflow-hidden relative bg-white">
            <main
              ref={scrollContainerRef}
              className="flex-1 overflow-y-auto px-8 py-6 no-scrollbar scroll-smooth"
            >
              {isEmpty ? (
                <div className="h-full flex flex-col items-center justify-center max-w-4xl mx-auto text-center space-y-10 animate-in fade-in zoom-in-95 duration-1000">
                  <div className="space-y-4 max-w-2xl">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-50 text-[10px] font-black text-slate-400 tracking-widest uppercase">
                      Welcome to GenUI
                    </div>
                    <h2 className="text-4xl font-bold text-slate-900">
                      무엇을 도와드릴까요?
                    </h2>
                  </div>
                  <div className="w-full max-w-2xl px-4 animate-in slide-in-from-bottom-8 duration-1000 delay-300">
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
                      className="flex items-center flex-wrap gap-2 bg-white border border-slate-200 rounded-[32px] p-2 pl-4 shadow-2xl shadow-slate-200/50 hover:shadow-slate-300/50 transition-all focus-within:border-slate-300"
                    >
                      {searchCriteria.map((c, i) => (
                        <div key={i} className="flex items-center gap-1.5 bg-slate-100 border border-slate-200 rounded-full px-2.5 py-1 animate-in zoom-in-95 duration-200">
                          <span className="text-[13px] font-bold text-slate-800">{c.name}</span>
                          {c.min && <span className="text-[11px] text-slate-500 font-medium">{c.min}</span>}
                          <button
                            onClick={() => setSearchCriteria(prev => prev.filter((_, idx) => idx !== i))}
                            className="ml-1 p-0.5 text-slate-400 hover:text-slate-900 transition-colors"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                      <textarea
                        ref={inputRef}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={searchCriteria.length > 0 ? "" : "무엇이든 물어보세요"}
                        rows={1}
                        className="flex-1 bg-transparent border-none focus:ring-0 focus:outline-none focus-visible:ring-0 resize-none text-slate-800 placeholder:text-slate-300 py-3 text-[17px] font-medium min-w-[120px] max-h-[200px]"
                        autoFocus
                      />
                      <button
                        onClick={() => handleSubmit()}
                        disabled={(!input.trim() && searchCriteria.length === 0) || isStreaming}
                        className="w-12 h-12 rounded-full bg-slate-900 flex items-center justify-center text-white hover:bg-black active:scale-95 transition-all shadow-lg shrink-0 ml-1"
                      >
                        {isStreaming ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowUp className="h-6 w-6 stroke-[2.5px]" />}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="max-w-4xl mx-auto space-y-12 pb-32">
                  {messages.map((m, idx) => {
                    // Hide internal system prompt turns from the user
                    const isSystemPrompt = m.role === "user" && m.parts.some(p => p.type === "text" && p.text.includes("[SYSTEM: CUMULATIVE COMPARISON]"));
                    if (isSystemPrompt) return null;

                    const hasPreviousComparison = messages.slice(0, idx).some(prev =>
                      prev.parts.some(p => p.type === "text" && /"type"\s*:\s*"(Table|ComparisonSelector)"/i.test(p.text))
                    );
                    const msgTurns: number[] = [];
                    ((m as any).toolInvocations ?? []).forEach((ti: any) => {
                      if (ti.toolName === "renderToSidebar") {
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
              )}
            </main>

            {!isEmpty && (
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
                    className="flex items-center flex-wrap gap-2 bg-white border border-slate-100 rounded-[28px] p-1.5 pl-3 shadow-xl shadow-slate-100/50 hover:shadow-slate-200/50 transition-all focus-within:border-slate-300"
                  >
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
                    <textarea
                      ref={inputRef}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={searchCriteria.length > 0 ? "" : "무엇이든 물어보세요"}
                      rows={1}
                      className="flex-1 bg-transparent border-none focus:ring-0 focus:outline-none focus-visible:ring-0 resize-none text-slate-800 placeholder:text-slate-300 py-2.5 text-[15px] font-medium min-w-[80px] max-h-[160px]"
                      autoFocus
                    />
                    <button
                      onClick={() => handleSubmit()}
                      disabled={(!input.trim() && searchCriteria.length === 0) || isStreaming}
                      className="w-9 h-9 rounded-full bg-slate-900 flex items-center justify-center text-white hover:bg-black active:scale-95 transition-all shadow-md shrink-0 ml-1"
                    >
                      {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4 stroke-[2.5px]" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          {!isEmpty && (
            <aside className="w-[360px] p-6 pb-20 flex-shrink-0 bg-muted/5 overflow-auto no-scrollbar border-l border-slate-50 z-10">
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
                  className="flex flex-col gap-4 p-6 bg-white border border-slate-100 rounded-3xl shadow-none min-h-[250px]"
                >
                  <div className="flex flex-col gap-1">
                    <p className="text-[10px] font-black text-slate-400 tracking-widest uppercase"> 💡 DECISION CRITERIA</p>
                    <p className="text-[11px] text-muted-foreground leading-tight">타임라인의 항목을 이곳으로 끌어서 저장하세요.</p>
                  </div>
                  <div className="flex flex-col gap-3">
                    {droppedCriteria.length > 0 ? (
                      <div className="flex flex-col gap-3 w-full items-start">
                        {droppedCriteria.map((criterion, i) => (
                          <div
                            key={i}
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData("application/json", JSON.stringify(criterion));
                              e.dataTransfer.setData("text/plain", criterion.name);
                              e.dataTransfer.effectAllowed = "copy";
                            }}
                            className="flex items-center gap-2 bg-slate-50 border border-slate-100 rounded-2xl px-2.5 h-[30px] w-fit max-w-full shadow-[0_1px_2px_rgba(0,0,0,0.02)] group animate-in zoom-in-95 duration-200 cursor-grab active:cursor-grabbing hover:bg-slate-100 hover:border-slate-200 transition-colors"
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
                                  className="text-[10px] text-slate-500 font-medium select-none truncate hover:text-slate-700 transition-colors"
                                  onClick={() => {
                                    setEditingCriteriaIdx(i);
                                    setEditingMinText(criterion.min || "");
                                  }}
                                  title={criterion.min || "입력"}
                                >
                                  {criterion.min || "입력"}
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-0.5 ml-1 pl-1 border-l border-slate-100">
                              <button
                                onClick={() => {
                                  setEditingCriteriaIdx(i);
                                  setEditingMinText(criterion.min || "");
                                }}
                                className="p-0.5 text-slate-300 hover:text-slate-600 transition-colors"
                              >
                                <Pencil className="w-2.5 h-2.5" />
                              </button>
                              <button
                                onClick={() => setDroppedCriteria(prev => prev.filter((_, idx) => idx !== i))}
                                className="p-0.5 text-slate-300 hover:text-slate-900 transition-colors"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex-1 flex items-center justify-center py-6 border border-slate-50 rounded-2xl bg-slate-50/30">
                        <p className="text-[11px] text-slate-200 font-medium whitespace-nowrap">여기에 드롭하세요</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-4 p-6 bg-white border border-slate-100 rounded-3xl shadow-none min-h-[250px]">
                  <div className="flex flex-col gap-1">
                    <p className="text-[10px] font-black text-slate-400 tracking-widest uppercase"> 🛒 MY ITEMS</p>
                    <p className="text-[11px] text-muted-foreground leading-tight">마음에 드는 제품의 '+' 버튼을 눌러서 저장하세요.</p>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    {droppedItems.length > 0 ? (
                      droppedItems.map((item, i) => (
                        <div key={i} className="group relative h-auto rounded-[20px] bg-white border border-slate-200 p-3.5 flex flex-col items-center gap-2.5 animate-in zoom-in-95 duration-200 shadow-none hover:border-slate-300 transition-all">
                          <button
                            onClick={() => setDroppedItems((prev) => prev.filter((c) => c.name !== item.name))}
                            className="absolute top-2 right-2 text-slate-300 hover:text-slate-900 transition-colors z-10"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>

                          <div className="w-full aspect-square rounded-[14px] bg-slate-50 overflow-hidden border border-slate-50 flex items-center justify-center mt-3.5">
                            {item.image ? (
                              <img src={item.image} alt={item.name} className="w-full h-full object-cover" />
                            ) : (
                              <span className="text-[28px] font-black text-slate-300 uppercase">{item.name[0]}</span>
                            )}
                          </div>

                          <p className="text-[10px] font-black text-slate-800 text-center leading-snug w-full px-1 break-keep">
                            {item.name}
                          </p>
                        </div>
                      ))
                    ) : (
                      <div className="col-span-4 flex-1 flex items-center justify-center py-6 border border-slate-50 rounded-2xl bg-slate-50/30">
                        <p className="text-[11px] text-slate-200 font-medium whitespace-nowrap">여기에 드롭하세요</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </aside>
          )}
        </div>
      </div >
    </div >
  );
}
