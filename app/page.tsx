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
import { ExplorerRenderer } from "@/lib/frontend/render/renderer";
import { manualRegistry } from "@/lib/frontend/render/registry";
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
  GripVertical,
  PanelRight,
  PanelLeft,
  User,
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

// 한국어 조사 은/는 자동 계산 (마지막 글자 받침 유무 기준)
function getEunNeun(word: string): string {
  const lastChar = word[word.length - 1];
  if (!lastChar) return "은";
  const code = lastChar.charCodeAt(0);
  if (code >= 0xAC00 && code <= 0xD7A3) {
    return (code - 0xAC00) % 28 === 0 ? "는" : "은";
  }
  return "은";
}

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
  const { onItemAdd, onItemRemove, onCompareRequested, savedItems, droppedCriteria, onRequestCriteriaData, onAddMyItemsToTable, userContext } = bindings;
  const isUser = message.role === "user";
  const bubbleRef = useRef<HTMLDivElement>(null);

  const segments = useMemo(() => {
    const toolInvocations = (message as any).toolInvocations ?? [];
    const sidePanelSpecs: any[] = [];
    toolInvocations.forEach((ti: any) => {
      if ((ti.toolName === "renderToSidebar" || ti.toolName === "sidePanel" || ti.toolName === "renderToExplorationJourney") && ti.state === "result") {
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
            const isCriteriaMap = effectiveSpec.type === "CriteriaMap" || effectiveSpec.type === "Timeline";
            if (!isCriteriaMap) {
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
            const isCriteriaMap = spec?.type === "CriteriaMap" || spec?.type === "Timeline" || (spec?.root && spec?.elements?.[spec.root]?.type === "CriteriaMap") || (spec?.root && spec?.elements?.[spec.root]?.type === "Timeline");
            if (!isCriteriaMap) result.push({ kind: "spec", content: spec });
          } else {
            const last = result[result.length - 1];
            if (last?.kind === "text") last.content += seg.content;
            else result.push({ kind: "text", content: seg.content });
          }
        });
      } else if (part.type.startsWith("tool-")) {
        const toolName = (part as any).toolName || (part as any).toolInvocation?.toolName || (!["tool-call", "tool-result", "tool-invocation"].includes(part.type) ? part.type.replace(/^tool-/, "") : "");
        if (toolName === "renderToSidebar" || toolName === "sidePanel" || toolName === "renderToExplorationJourney" || toolName === "imageSearch" || toolName === "searchProducts") return;

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

    let userText = rawText;
    const cumulativeMatch = userText.match(/^\[SYSTEM: CUMULATIVE COMPARISON\] (.*?) 제품들을 Table/i);
    
    if (cumulativeMatch) {
      userText = `"${cumulativeMatch[1].trim()}" 제품을 비교해줘.`;
    } else {
      const isPureCriteria = /^\[Decision Criteria\s*:[^\]]*\]\s*(?:\n|$|\[)/i.test(rawText);
      const isPureMyItems = /^\[My items\s*:[^\]]*\]\s*(?:\n|$|\[)/i.test(rawText);

      userText = userText.replace(/\|https?:\/\/[^\s,\]]+/g, "");
      userText = userText.replace(/^\[Decision Criteria\s*:([^\]]*)\]\s*/i, '"$1" ');
      userText = userText.replace(/^\[My items\s*:([^\]]*)\]\s*/i, '"$1" ');
      userText = userText.split(/\n{1,2}\[CONTEXT:/i)[0];
      userText = userText.split(/\n{1,2}\[DECISION CRITERIA:/i)[0];
      userText = userText.split(/\n{1,2}\[USER CONTEXT:/i)[0];
      userText = userText.split(/\n{1,2}\[ASSIGNED ITEM:/i)[0];
      userText = userText.trim();

      if (isPureCriteria && userText && !userText.includes("조건으로 추천해줘")) userText += " 조건으로 추천해줘.";
      if (isPureMyItems && userText && !userText.includes("비교해줘")) userText += " 제품을 비교해줘.";
    }

    return (
      <div className="flex justify-end w-full">
        <div className="max-w-[85%] flex flex-col items-end gap-2">
          {userText && (
            <div
              className="rounded-2xl px-4 py-2.5 leading-relaxed whitespace-pre-wrap bg-slate-900 text-white rounded-tr-md break-words"
              style={{
                fontSize: userText.length > 120 ? '11px' : userText.length > 60 ? '12px' : '14px',
              }}
            >
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
                {content.replace(/\*\*(.+?)\*\*/g, '$1')}
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
                bindings={{ onItemAdd, onItemRemove, onCompareRequested, savedItems, isFollowUp, droppedCriteria, onRequestCriteriaData, onAddMyItemsToTable, isLatestMessage: isLast, userContext }}
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

const globalSeenTerms = new Set<string>();

const InformationCardItem = memo(({ card, index }: { card: any, index: number }) => {
  const [isInitialRender, setIsInitialRender] = useState(true);

  useEffect(() => {
    setIsInitialRender(false);
    globalSeenTerms.add(card.term);
  }, [card.term]);

  const isNew = isInitialRender && !globalSeenTerms.has(card.term);

  return (
    <div
      className={`border border-slate-200 rounded-[8px] p-4 bg-white${isNew ? " animate-chip-in" : ""}`}
      style={isNew ? { animationDelay: `${index * 0.08}s` } : undefined}
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
  );
});

// =============================================================================
// Page
// =============================================================================

export default function ChatPage() {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const [input, setInput] = useState("");
  const [hasStarted, setHasStarted] = useState(() =>
    typeof window !== 'undefined' && localStorage.getItem('gs_hasStarted') === 'true'
  );
  const [participantId, setParticipantId] = useState(() =>
    typeof window !== 'undefined' ? (localStorage.getItem('gs_participantId') ?? '') : ''
  );
  const [locale, setLocale] = useState<'ko' | 'en'>(() =>
    typeof window !== 'undefined' ? ((localStorage.getItem('gs_locale') as 'ko' | 'en') ?? 'ko') : 'ko'
  );

  // ---------------------------------------------------------------------------
  // Translation dictionary
  // ---------------------------------------------------------------------------
  const T = {
    greeting:          locale === 'en' ? 'Hello, '                                          : '안녕하세요, ',
    greetingSuffix:    locale === 'en' ? ''                                                 : '님',
    proceedToPayment:  locale === 'en' ? 'Proceed to Payment'                              : '결제 진행하기',
    askAnything:       locale === 'en' ? 'Ask me anything'                                 : '무엇이든 물어보세요',
    participantId:     locale === 'en' ? 'PARTICIPANT ID'                                  : '참가자ID',
    assignedItem:      locale === 'en' ? 'ASSIGNED ITEM'                                   : '배정받은 아이템',
    purchaseContext:   locale === 'en' ? 'PURCHASE CONTEXT'                                : '구매 목적 및 상황',
    contextPlaceholder: locale === 'en'
      ? 'e.g. I go out often alone. Lightweight and portable is important.'
      : '예: 외출이 잦고 혼자 다녀요. 가볍고 휴대하기 편한 게 중요해요.',
    getStarted:        locale === 'en' ? 'Get Started'                                     : '시작하기',
    criteriaEmpty:     locale === 'en' ? 'Click criteria chips\nto pin them here'          : '기준 칩을 클릭해\n여기에 고정해두세요',
    optionsEmpty:      locale === 'en' ? 'Press ♥ on products\nto save them here'         : '관심 제품의 ♥를 눌러\n여기에 담아보세요',
    optionListEmpty:   locale === 'en' ? 'Get product recommendations\nto see options here': '제품 추천을 받으면\n여기에 옵션이 표시됩니다',
    impHigh:           locale === 'en' ? 'High'                                            : '중요',
    impMedium:         locale === 'en' ? 'Med'                                             : '보통',
    impLow:            locale === 'en' ? 'Low'                                             : '낮음',
    stroller:          locale === 'en' ? 'Stroller'                                        : '유모차',
    robotVacuum:       locale === 'en' ? 'Robot Vacuum'                                    : '로봇 청소기',
    pinHint:           locale === 'en' ? 'Enter'                                           : '입력',
    // Receipt modal
    finalProduct:      locale === 'en' ? 'FINAL SELECTION'                                 : '최종 선택 제품',
    price:             locale === 'en' ? 'PRICE'                                            : '가격',
    decisionCriteria:  locale === 'en' ? 'DECISION CRITERIA'                               : '결정 기준',
    importance:        locale === 'en' ? 'IMPORTANCE'                                       : '중요도',
    noCriteria:        locale === 'en' ? 'No saved criteria'                                : '저장된 기준 없음',
    totalCriteria:     locale === 'en' ? 'Total Criteria'                                   : '얘 결정 기준',
    productsConsidered:locale === 'en' ? 'PRODUCTS CONSIDERED'                              : '{T.productsConsidered}',
    exploredCategories:locale === 'en' ? 'EXPLORED CATEGORIES'                              : '{T.exploredCategories}',
    impKey:            locale === 'en' ? 'Key'                                              : '핵심',
    impRef:            locale === 'en' ? 'Ref'                                              : '참고',
    countSuffix:       locale === 'en' ? ''                                                 : '개',
  };
  const [userContext, setUserContext] = useState(() =>
    typeof window !== 'undefined' ? (localStorage.getItem('gs_userContext') ?? '') : ''
  );
  const [assignedItem, setAssignedItem] = useState<"A" | "B" | "">(() =>
    typeof window !== 'undefined' ? ((localStorage.getItem('gs_assignedItem') as "A" | "B" | "") ?? '') : ''
  );
  const [droppedCriteria, setDroppedCriteria] = useState<{ name: string; min?: string; priority: string; important?: boolean }[]>([]);
  const [searchCriteria, setSearchCriteria] = useState<{ name: string; min?: string; priority: string }[]>([]);
  const [droppedItems, setDroppedItems] = useState<{ name: string; image?: string; price?: string; description?: string; specs?: string[]; link?: string }[]>([]);
  const [mentionChips, setMentionChips] = useState<{ name: string; link?: string }[]>([]);
  const [editingCriteriaIdx, setEditingCriteriaIdx] = useState<number | null>(null);
  const [editingMinText, setEditingMinText] = useState("");
  const [openPriorityIdx, setOpenPriorityIdx] = useState<number | null>(null);
  const [highlightTerm, setHighlightTerm] = useState<string | null>(null);
  const [highlightTurn, setHighlightTurn] = useState<number | null>(null);
  const [journeyTab, setJourneyTab] = useState<"criteria" | "information">("criteria");
  // tradeoffSpecs: maps criterion name → UI Agent spec (TradeoffHint or Empty)
  const [tradeoffSpecs, setTradeoffSpecs] = useState<Record<string, { type: string; props: any }>>({});
  const [tradeoffLoading, setTradeoffLoading] = useState<Set<string>>(new Set());
  const [dismissedTradeoffs, setDismissedTradeoffs] = useState<Set<string>>(new Set());
  const [openImportanceIdx, setOpenImportanceIdx] = useState<number | null>(null);
  // UnchartedTerritoryChip spec — set when Cat 2 fires with criteria + items
  const [unchartedSpec, setUnchartedSpec] = useState<{ labels: string[] } | null>(null);
  const [dismissedUncharted, setDismissedUncharted] = useState<Set<string>>(new Set());
  const prevTableTurnRef = useRef<number>(-1);
  // UnchartedTerritoryChip: 조건 전환(false→true) 감지용 refs
  const prevConditionsRef = useRef<boolean>(false);   // 이전 allConditionsMet
  const pendingFetchRef = useRef<boolean>(false);      // 스트리밍 해제 후 실행 대기 중 여부
  const unchartedHasShownRef = useRef<boolean>(false); // 첫 표시 여부 (이후 애니메이션 스킵)
  // Panel resize state
  const [isResizing, setIsResizing] = useState(false);
  const [panelWidths, setPanelWidths] = useState<Record<string, number>>({
    exploration: 600,
    chat: 320,
    compTable: 600,
    optionList: 600,
    criteria: 300,
    options: 300,
  });
  const [rightWidth, setRightWidth] = useState(320);
  const [rightTopHeight, setRightTopHeight] = useState(300);
  const [compTableCollapsed, setCompTableCollapsed] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(true);
  const [productCardListSpec, setProductCardListSpec] = useState<any>(null);
  const [compTableSpec, setCompTableSpec] = useState<any>(null);
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  // Panel visibility — hidden initially, slide in when AI produces relevant content
  const [showExplorationPanel, setShowExplorationPanel] = useState(false);
  const [showCompTablePanel, setShowCompTablePanel] = useState(false);
  const [showOptionListPanel, setShowOptionListPanel] = useState(false);
  const pointerDragRef = useRef<{ type: 'col-l' | 'col-r' | 'col-ct' | 'col-ol' | 'col-or' | 'col-fr' | 'row'; startX: number; startY: number; startVal: number; containerH: number } | null>(null);
  const rightColumnRef = useRef<HTMLDivElement>(null);

  // Panel slot state
  type PanelId = 'exploration' | 'chat' | 'criteria' | 'options' | 'optionList' | 'compTable';
  type SlotId = 'left' | 'center' | 'rightTop' | 'rightBottom' | 'farRight' | 'compTableSlot';
  const [panelSlots, setPanelSlots] = useState<Record<SlotId, PanelId>>({
    left: 'exploration', center: 'chat', rightTop: 'criteria', rightBottom: 'options', farRight: 'optionList', compTableSlot: 'compTable',
  });
  const [panelDragging, setPanelDragging] = useState<PanelId | null>(null);
  const [panelDropTarget, setPanelDropTarget] = useState<SlotId | null>(null);

  const getSlotOf = (panelId: PanelId): SlotId =>
    (Object.entries(panelSlots).find(([, p]) => p === panelId)?.[0] as SlotId) ?? 'left';

  const swapPanels = (draggedPanel: PanelId, targetSlot: SlotId) => {
    setPanelSlots(prev => {
      const fromSlot = (Object.entries(prev).find(([, p]) => p === draggedPanel)?.[0] as SlotId);
      const displaced = prev[targetSlot];
      return { ...prev, [fromSlot]: displaced, [targetSlot]: draggedPanel };
    });
  };

  const visibilityRef = useRef({ exploration: false, compTable: false, optionList: false });
  visibilityRef.current = { exploration: showExplorationPanel, compTable: showCompTablePanel, optionList: showOptionListPanel };

  const assignToNextSlot = (panelId: PanelId) => {
    setPanelSlots(prev => {
      const isVisible = (pid: PanelId) => {
        if (pid === panelId) return true;
        if (pid === 'exploration') return visibilityRef.current.exploration;
        if (pid === 'compTable') return visibilityRef.current.compTable;
        if (pid === 'optionList') return visibilityRef.current.optionList;
        if (pid === 'chat') return false;
        return true;
      };

      const dynamicSlots: SlotId[] = ['left', 'compTableSlot', 'farRight'];
      for (const slot of dynamicSlots) {
        if (!isVisible(prev[slot]) || prev[slot] === panelId) {
          if (prev[slot] !== panelId) {
             const oldPanel = prev[slot];
             const currentSlot = (Object.entries(prev).find(([, p]) => p === panelId)?.[0] as SlotId) ?? 'left';
             return { ...prev, [slot]: panelId, [currentSlot]: oldPanel };
          }
          return prev;
        }
      }
      return prev;
    });
  };

  const isPanelShown = (pid: PanelId) => {
    if (pid === 'exploration') return showExplorationPanel;
    if (pid === 'compTable') return showCompTablePanel;
    if (pid === 'optionList') return showOptionListPanel;
    if (pid === 'chat') return false; // chat is removed
    return true; // criteria, options are always shown
  };

  const gripHandle = (panelId: PanelId) => (
    <div
      draggable
      onDragStart={(e) => { e.stopPropagation(); setPanelDragging(panelId); e.dataTransfer.setData('application/x-panel', panelId); e.dataTransfer.effectAllowed = 'move'; }}
      onDragEnd={() => { setPanelDragging(null); setPanelDropTarget(null); }}
      className="cursor-grab active:cursor-grabbing p-1 rounded hover:bg-slate-100 transition-colors flex-shrink-0"
      title="드래그하여 패널 이동"
    >
      <GripVertical className="w-3.5 h-3.5 text-slate-300 hover:text-slate-500" />
    </div>
  );

  const slotDropProps = (slotId: SlotId) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('application/x-panel')) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setPanelDropTarget(slotId);
    },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPanelDropTarget(null); },
    onDrop: (e: React.DragEvent) => {
      const pid = e.dataTransfer.getData('application/x-panel') as PanelId;
      if (pid && pid !== panelSlots[slotId]) { e.preventDefault(); e.stopPropagation(); swapPanels(pid, slotId); }
      setPanelDragging(null); setPanelDropTarget(null);
    },
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const isStickToBottom = useRef(true);
  const isAutoScrolling = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { messages, sendMessage, setMessages, status, error } =
    useChat<AppMessage>({ transport });

  const resetSession = useCallback(() => {
    localStorage.removeItem('gs_hasStarted');
    localStorage.removeItem('gs_participantId');
    localStorage.removeItem('gs_userContext');
    localStorage.removeItem('gs_assignedItem');
    setMessages([]);
    setDroppedItems([]);
    setDroppedCriteria([]);
    setSearchCriteria([]);
    setMentionChips([]);
    setHighlightTerm(null);
    setHighlightTurn(null);
    setInput("");
    setHasStarted(false);
    setShowExplorationPanel(false);
    setShowCompTablePanel(false);
    setShowOptionListPanel(false);
    setUnchartedSpec(null);
    setDismissedUncharted(new Set());
    prevConditionsRef.current = false;
    pendingFetchRef.current = false;
  }, [setMessages]);

  // locale 변경 → localStorage + 쿠키에 동기화 (API 요청 시 자동 전송됨)
  useEffect(() => {
    localStorage.setItem('gs_locale', locale);
    document.cookie = `gs_locale=${locale};path=/;max-age=86400`;
  }, [locale]);

  // 세션 상태 localStorage 자동 저장
  useEffect(() => {
    localStorage.setItem('gs_hasStarted', String(hasStarted));
    if (hasStarted) {
      localStorage.setItem('gs_participantId', participantId);
      localStorage.setItem('gs_userContext', userContext);
      localStorage.setItem('gs_assignedItem', assignedItem);
    }
  }, [hasStarted, participantId, userContext, assignedItem]);

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
        ? `[Decision Criteria : ${searchCriteria.map(c => `${c.name}${c.min ? ` (${c.min})` : ""}`).join(", ")}] `
        : "";

      const mentionPrefix = mentionChips.length > 0
        ? `[My items : ${mentionChips.map(c => c.link ? `${c.name}|${c.link}` : c.name).join(", ")}] `
        : "";

      const cartContext = droppedItems.length > 0
        ? `\n\n[CONTEXT: User has these items in 'MY ITEMS' cart: ${droppedItems.map(i => {
          const specsStr = i.specs && i.specs.length > 0 ? ` | ${i.specs.slice(0, 8).join(", ")}` : "";
          return `${i.name}${specsStr}`;
        }).join(" / ")}]`
        : "";

      const savedCriteriaContext = droppedCriteria.length > 0
        ? `\n\n[DECISION CRITERIA: ${droppedCriteria.map((c: any) => {
          const levelMap: Record<string, string> = { high: "중요", medium: "보통", low: "낮음" };
          const priorityLabel = levelMap[c.importanceLevel] || "보통";
          return `${c.name}${c.min ? ` (입력: ${c.min})` : ''} [${priorityLabel}]`;
        }).join(', ')}]`
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
      setRightPanelCollapsed(false);
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
        if (ti.toolName === "renderToSidebar" || ti.toolName === "sidePanel" || ti.toolName === "renderToExplorationJourney") {
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
          if (toolName === "renderToSidebar" || toolName === "sidePanel" || toolName === "renderToExplorationJourney") {
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
    let latestCriteriaMapSpec: any = null;
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

      if (effectiveSpec.type === "InformationCard") {
        const term = effectiveSpec.props?.term;
        if (term && !seenTerms.has(term)) {
          seenTerms.add(term);
          conceptCards.push(effectiveSpec.props);
        }
      } else if (effectiveSpec.type === "CriteriaMap" || effectiveSpec.type === "Timeline") {
        const props = effectiveSpec.props || effectiveSpec;

        // CriteriaMap: merge categories by label
        if (effectiveSpec.type === "CriteriaMap") {
          const newCategories: any[] = Array.isArray(props.categories) ? props.categories : [];
          const merged: any[] = latestCriteriaMapSpec?.props?.categories ?? [];

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

          latestCriteriaMapSpec = {
            type: "CriteriaMap",
            props: { categories: merged }
          };

          // Legacy Timeline support: convert to KnowledgeMap format
        } else if (effectiveSpec.type === "Timeline") {
          const turns = Array.isArray(props.turns) ? props.turns : [];
          const merged: any[] = latestCriteriaMapSpec?.props?.categories ?? [];

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

          latestCriteriaMapSpec = {
            type: "CriteriaMap",
            props: { categories: merged }
          };
        }
      } else {
        latestOtherSpec = spec;
      }
    });

    return { CriteriaMap: latestCriteriaMapSpec, conceptCards };
  }, [allSpecs]);

  useEffect(() => {
    if (sidebarSpec.conceptCards.length === 0) {
      globalSeenTerms.clear();
    }
  }, [sidebarSpec.conceptCards]);

  // Auto-switch tab when new content arrives
  const prevConceptCardCount = useRef(0);
  const prevCriteriaMapKey = useRef<string | null>(null);
  useEffect(() => {
    const newCardCount = sidebarSpec.conceptCards.length;
    const newCriteriaKey = sidebarSpec.CriteriaMap ? JSON.stringify(sidebarSpec.CriteriaMap) : null;

    if (newCardCount > prevConceptCardCount.current) {
      // New InformationCard added → switch to information
      setJourneyTab("information");
    } else if (newCriteriaKey && newCriteriaKey !== prevCriteriaMapKey.current) {
      // CriteriaMap updated → switch to criteria
      setJourneyTab("criteria");
    }

    prevConceptCardCount.current = newCardCount;
    prevCriteriaMapKey.current = newCriteriaKey;
  }, [sidebarSpec]);

  const hasComparison = useMemo(() => messages.some(m => {
    // 1. Check raw text JSON blocks
    if (m.parts?.some(p => p.type === "text" && /"type"\s*:\s*"(Table|ComparisonSelector)"/i.test((p as any).text))) return true;

    // 2. Check injected UI specs
    if (m.parts?.some((p: any) => 
      (p.type === "data-chat-ui-spec" && (p.data?.type === "Table" || p.data?.type === "ComparisonSelector")) ||
      p.type === "data-comp-table-spec"
    )) return true;

    // 3. Check tool invocations directly
    if ((m as any).toolInvocations?.some((ti: any) =>
      (ti.toolName === "renderInChat" || ti.toolName === "renderToCompTable") && ti.args?.ui_intent_category === "2"
    )) return true;

    return false;
  }), [messages]);

  // UnchartedTerritoryChip: 세 조건이 false→true로 전환될 때만 API 호출
  // 조건이 이미 모두 참인 상태에서의 변화(My Items 추가 등)는 무시
  useEffect(() => {
    const allConditionsMet =
      hasComparison && droppedItems.length > 0 && droppedCriteria.length > 0;

    const wasAllMet = prevConditionsRef.current;
    prevConditionsRef.current = allConditionsMet;

    // false → true 전환 시 fetch 대기 등록
    if (allConditionsMet && !wasAllMet) {
      pendingFetchRef.current = true;
    }

    // 조건 불충족 → pending 취소 (칩은 유지)
    if (!allConditionsMet) {
      pendingFetchRef.current = false;
      return;
    }

    // 스트리밍 중이면 대기 (pending은 유지)
    if (isStreaming) return;

    // pending이 없으면 실행 안 함
    if (!pendingFetchRef.current) return;
    pendingFetchRef.current = false;

    let isMounted = true;

    const fetchUncharted = async () => {
      try {
        const productCategory = assignedItem === "A" ? "유모차" : assignedItem === "B" ? "로봇 청소기" : "소비재";
        const categories: any[] = sidebarSpec.CriteriaMap?.props?.categories ?? [];
        const existingLabels = categories.map((c: any) => c.label as string).filter(Boolean);
        const criteriaNames = droppedCriteria.map(c => c.name);

        const res = await fetch("/api/unexplored-areas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            existingCategories: existingLabels,
            productCategory,
            droppedCriteria: criteriaNames,
          }),
        });

        if (!isMounted) return;

        if (res.ok) {
          const data = await res.json();
          if (data.labels && data.labels.length > 0) {
            setUnchartedSpec({ labels: data.labels });
          }
        }
      } catch (err) {
        console.error("[fetchUncharted] Error:", err);
      }
    };

    fetchUncharted();
    return () => { isMounted = false; };
  }, [hasComparison, droppedItems.length, droppedCriteria.length, isStreaming, assignedItem]);


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

  // 조율 도움받기 — 트레이드오프 충돌 기준에 대해 AI에게 대안 요청
  const handleResolveTradeoff = useCallback(async (newCriterion: string, conflictsWith: string) => {
    const prompt = `"${newCriterion}"와 "${conflictsWith}" 사이의 균형 잡을 수 있는 방법을 알려주세요.`;
    const userContextTag = userContext.trim() ? `\n\n[USER CONTEXT: ${userContext.trim()}]` : '';
    await sendMessage({ text: prompt + userContextTag });
  }, [sendMessage, userContext]);
  // Called whenever a new criterion is added — asks UI Agent (cat.5) for TradeoffHint spec
  const checkTradeoff = async (
    newCriterion: { name: string; important?: boolean },
    existingCriteria: { name: string; important?: boolean }[]
  ) => {
    if (existingCriteria.length === 0) return;
    setTradeoffLoading(prev => new Set([...prev, newCriterion.name]));
    try {
      const productCategory = assignedItem === "A" ? "유모차" : assignedItem === "B" ? "로봇 청소기" : "소비재";
      const res = await fetch("/api/check-tradeoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ existingCriteria, newCriterion, productCategory, userContext }),
      });
      const spec = await res.json();
      setTradeoffSpecs(prev => ({ ...prev, [newCriterion.name]: spec }));
      if (spec?.type === "TradeoffHint") {
        setRightPanelCollapsed(false);
      }
    } catch (err) {
      console.error("[checkTradeoff] failed:", err);
    } finally {
      setTradeoffLoading(prev => { const next = new Set(prev); next.delete(newCriterion.name); return next; });
    }
  };

  const sidebarBindings = useMemo(() => ({
    onTurnClick: scrollToTurn,
    onSubmitChat: handleSubmit,
    droppedCriteria,
    onToggleCriteria: (item: { name: string; min?: string; priority?: string; important?: boolean }) => {
      const exists = droppedCriteria.some((c) => c.name === item.name);
      if (exists) {
        setDroppedCriteria((prev) => prev.filter((c) => c.name !== item.name));
        setTradeoffSpecs((prev) => { const next = { ...prev }; delete next[item.name]; return next; });
      } else {
        const existingCriteria = droppedCriteria.map((c) => ({ name: c.name, important: !!c.important }));
        const importanceLevel = item.important ? "high" : "low";
        setDroppedCriteria((prev) => [...prev, {
          name: item.name,
          min: item.min,
          priority: item.priority || "medium",
          important: !!item.important,
          importanceLevel,
        } as any]);
        checkTradeoff({ name: item.name, important: !!item.important }, existingCriteria);
        setRightPanelCollapsed(false);
      }
    },
    onDragStartCriteria: () => {
      setRightPanelCollapsed(false);
    }
  }), [scrollToTurn, handleSubmit, droppedCriteria]);

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

  // Comparison Table 패널: data-comp-table-spec 스트림 파트에서 최신 spec 추출
  useEffect(() => {
    let latestSpec: any = null;
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      for (const part of (msg.parts ?? []) as any[]) {
        if ((part as any).type === 'data-comp-table-spec' && (part as any).data) {
          latestSpec = (part as any).data;
        }
      }
    }
    setCompTableSpec(latestSpec);
  }, [messages]);

  // Option List 패널: data-option-list-spec 파트 또는 tool invocation result에서 카드 누적
  useEffect(() => {
    let accumulatedCards: any[] = [];
    let latestSpecBase: any = null;

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;

      // 1순위: data-option-list-spec 스트림 파트
      for (const part of (msg.parts ?? []) as any[]) {
        if ((part as any).type === 'data-option-list-spec' && (part as any).data) {
          console.log('[OptionList] data-option-list-spec part found:', (part as any).data?.type);
          const spec = (part as any).data;
          latestSpecBase = spec;
          if (spec?.props?.cards && Array.isArray(spec.props.cards)) {
            for (const newCard of spec.props.cards) {
              const existingIdx = accumulatedCards.findIndex((c: any) => c.name === newCard.name);
              if (existingIdx !== -1) accumulatedCards[existingIdx] = newCard;
              else accumulatedCards.unshift(newCard);
            }
          }
        }
      }

      // 2순위 fallback: tool invocation result에서 직접 추출
      for (const ti of (msg as any).toolInvocations ?? []) {
        if (ti.toolName === 'renderToOptionList') {
          console.log('[OptionList] toolInvocation found — state:', ti.state, '| result type:', ti.result?.type, '| error:', ti.result?.error, '| cards:', ti.result?.props?.cards?.length);
          if (ti.state === 'result' && ti.result) {
            const raw = ti.result;
            const spec = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
            if (spec?.type === 'ProductCardList' && Array.isArray(spec?.props?.cards)) {
              if (!latestSpecBase) latestSpecBase = spec;
              for (const newCard of spec.props.cards) {
                const existingIdx = accumulatedCards.findIndex((c: any) => c.name === newCard.name);
                if (existingIdx !== -1) accumulatedCards[existingIdx] = newCard;
                else accumulatedCards.unshift(newCard);
              }
            }
          }
        }
      }
    }

    console.log('[OptionList] final — latestSpecBase:', !!latestSpecBase, '| cards count:', accumulatedCards.length);
    if (latestSpecBase) {
      setProductCardListSpec({
        ...latestSpecBase,
        props: { ...latestSpecBase.props, cards: accumulatedCards }
      });
    } else {
      setProductCardListSpec(null);
    }
  }, [messages]);

  // 패널 등장 트리거 — 콘텐츠가 생기면 해당 패널을 슬라이드인
  useEffect(() => {
    if ((sidebarSpec.CriteriaMap || sidebarSpec.conceptCards.length > 0) && !showExplorationPanel) {
      assignToNextSlot('exploration');
      setShowExplorationPanel(true);
    }
  }, [sidebarSpec, showExplorationPanel]);

  const isCompTableActive = useMemo(() => messages.some(m =>
    (m.parts || []).some((p: any) =>
      p.type === 'data-comp-table-spec' ||
      (p.toolName === 'renderToCompTable')
    )
  ), [messages]);

  useEffect(() => {
    if (isCompTableActive && !showCompTablePanel) {
      assignToNextSlot('compTable');
      setShowCompTablePanel(true);
    }
  }, [isCompTableActive, showCompTablePanel]);

  const isOptionListActive = useMemo(() => messages.some(m =>
    (m.parts || []).some((p: any) =>
      p.type === 'data-option-list-spec' ||
      (p.toolName === 'renderToOptionList')
    )
  ), [messages]);

  useEffect(() => {
    if (isOptionListActive && !showOptionListPanel) {
      assignToNextSlot('optionList');
      setShowOptionListPanel(true);
    }
  }, [isOptionListActive, showOptionListPanel]);

  if (!isMounted) return null;

  if (!hasStarted) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-[#FAFAFA]">
        <div className="w-full max-w-lg flex flex-col gap-10 px-8 animate-in fade-in zoom-in-95 duration-700">
          {/* Branding */}
          <div className="flex flex-col gap-1">
            <h1 className="text-[48px] font-bold text-slate-900 tracking-tight leading-none">GenSpace</h1>
          </div>

          {/* Participant ID */}
          <div className="flex flex-col gap-3">
            <label className="text-[13px] font-semibold text-slate-900 uppercase tracking-widest">{T.participantId}</label>
            <input
              type="text"
              value={participantId}
              onChange={(e) => setParticipantId(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && participantId.trim() && assignedItem && userContext.trim()) setHasStarted(true); }}
              placeholder="P1"
              className="w-full border border-slate-200 rounded-[8px] px-5 py-4 text-[18px] font-medium text-slate-800 placeholder:text-slate-300 outline-none focus:border-slate-400 transition-colors bg-[#FAFAFA]"
              autoFocus
            />
          </div>

          {/* Assigned item */}
          <div className="flex flex-col gap-3">
            <label className="text-[13px] font-semibold text-slate-900 uppercase tracking-widest">{T.assignedItem}</label>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setAssignedItem("A")}
                className={`flex-1 py-4 rounded-[8px] text-[15px] font-semibold border transition-all duration-200 ${assignedItem === "A"
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-[#FAFAFA] text-slate-400 border-slate-200 hover:border-slate-400 hover:text-slate-600"
                  }`}
              >
                {T.stroller}
              </button>
              <button
                type="button"
                onClick={() => setAssignedItem("B")}
                className={`flex-1 py-4 rounded-[8px] text-[15px] font-semibold border transition-all duration-200 ${assignedItem === "B"
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-[#FAFAFA] text-slate-400 border-slate-200 hover:border-slate-400 hover:text-slate-600"
                  }`}
              >
                {T.robotVacuum}
              </button>
            </div>
          </div>

          {/* User context */}
          <div className="flex flex-col gap-3">
            <label className="text-[13px] font-semibold text-slate-900 uppercase tracking-widest">{T.purchaseContext}</label>
            <textarea
              value={userContext}
              onChange={(e) => setUserContext(e.target.value)}
              placeholder={T.contextPlaceholder}
              rows={3}
              className="w-full border border-slate-200 rounded-[8px] px-5 py-4 text-[15px] font-medium text-slate-800 placeholder:text-slate-300 outline-none focus:border-slate-400 transition-colors bg-[#FAFAFA] resize-none leading-relaxed"
            />
          </div>

          {/* Start button */}
          <button
            onClick={() => { if (participantId.trim() && assignedItem && userContext.trim()) setHasStarted(true); }}
            disabled={!participantId.trim() || !assignedItem || !userContext.trim()}
            className="w-full py-4 rounded-[8px] bg-slate-900 text-white text-[16px] font-semibold tracking-tight hover:bg-black active:scale-[0.98] transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {T.getStarted}
          </button>
        </div>
      </div>
    );
  }


  // ── Panel render functions ────────────────────────────────────────────
  const renderExploration = () => (
    <div className="flex flex-col h-full py-6 px-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between mb-4 flex-shrink-0 border-b border-slate-100 pb-3 gap-y-3 gap-x-2">
        <div className="flex items-center gap-2">
          {gripHandle('exploration')}
          <p className="text-[12.5px] font-black text-slate-600 tracking-widest uppercase whitespace-nowrap">🧭 Exploration Journey</p>
        </div>
        <div className="flex items-center bg-[#F1F3F5] rounded-full p-[3px] border border-black/[0.02] shadow-inner shadow-slate-200/50 flex-shrink-0">
          <button type="button" onClick={() => setJourneyTab("criteria")} className={`px-4 py-1.5 rounded-full text-[12px] font-medium transition-all duration-200 ${journeyTab === "criteria" ? "bg-white text-slate-800 shadow-[0_1px_4px_rgba(0,0,0,0.08)] border border-black/[0.04]" : "text-slate-400 hover:text-slate-600"}`}>Criteria</button>
          <button type="button" onClick={() => setJourneyTab("information")} className={`px-4 py-1.5 rounded-full text-[12px] font-medium transition-all duration-200 ${journeyTab === "information" ? "bg-white text-slate-800 shadow-[0_1px_4px_rgba(0,0,0,0.08)] border border-black/[0.04]" : "text-slate-400 hover:text-slate-600"}`}>Information</button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto styled-scrollbar pr-1">
        <div className={journeyTab === "criteria" ? "" : "hidden"}>
          {unchartedSpec && unchartedSpec.labels.length > 0 && (<div className="mb-3">{manualRegistry.UnchartedTerritoryChip({ props: { labels: unchartedSpec.labels, skipAnimation: unchartedHasShownRef.current, onExplore: (label: string) => { unchartedHasShownRef.current = true; const cat = assignedItem === "A" ? "유모차" : assignedItem === "B" ? "로봇 청소기" : "제품"; handleSubmit(`${cat} ${label}${getEunNeun(label)} 어떻게 봐야 해?`); setDismissedUncharted(prev => { const next = new Set(prev); next.add(label); return next; }); setUnchartedSpec(prev => prev ? { labels: prev.labels.filter(l => l !== label) } : null); } } })}</div>)}
          {sidebarSpec.CriteriaMap ? (<ExplorerRenderer spec={sidebarSpec.CriteriaMap} bindings={sidebarBindings} />) : (<div className="flex flex-col items-center justify-center h-full gap-2 py-12"><p className="text-[12px] text-slate-300 font-medium text-center leading-relaxed">{locale === 'en' ? 'Start a conversation' : '대화를 시작하면'}<br />{locale === 'en' ? 'to build your criteria map' : '여기에 탐색 기록이 쌓여요'}</p></div>)}
        </div>
        <div className={journeyTab === "information" ? "" : "hidden"}>
          {sidebarSpec.conceptCards.length > 0 ? (<div className="flex flex-col gap-3 py-1">{sidebarSpec.conceptCards.map((card: any, i: number) => (<InformationCardItem key={`${card.term}-${i}`} card={card} index={i} />))}</div>) : (<div className="flex flex-col items-center justify-center h-full gap-2 py-12"><p className="text-[12px] text-slate-300 font-medium text-center leading-relaxed">{locale === 'en' ? 'Ask a concept question' : '개념 질문을 하면'}<br />{locale === 'en' ? 'to build your knowledge base' : '여기에 설명이 쌓여요'}</p></div>)}
        </div>
      </div>
    </div>
  );

  const renderChat = () => (
    <div className="flex flex-col flex-1 overflow-hidden relative">
      <div className="flex-shrink-0 flex items-center px-3 py-1 border-b border-slate-50">{gripHandle('chat')}</div>
      <main ref={scrollContainerRef} className="flex-1 overflow-y-auto px-8 pb-6 no-scrollbar scroll-smooth">
        <div className="max-w-2xl mx-auto space-y-12 pb-8 pt-8">
          {messages.map((m, idx) => {
            const isSystemPrompt = m.role === "user" && m.parts.some(p => p.type === "text" && (p as any).text?.includes("[SYSTEM: CUMULATIVE COMPARISON]"));
            if (isSystemPrompt) return null;
            const hasPreviousComparison = messages.slice(0, idx).some(prev => prev.parts.some(p => p.type === "text" && /\"type\"\s*:\s*\"(Table|ComparisonSelector)\"/i.test((p as any).text ?? "")));
            const msgTurns: number[] = [];
            ((m as any).toolInvocations ?? []).forEach((ti: any) => { if (ti.toolName === "renderToSidebar" || ti.toolName === "sidePanel" || ti.toolName === "renderToExplorationJourney") { const spec = ti.result || ti.args?.spec; if (spec?.turns) spec.turns.forEach((t: any) => { if (t.turn) msgTurns.push(t.turn); }); } });
            (m.parts ?? []).forEach((p: any) => { if (p.type === "text" && p.text) { const matches = p.text.match(/"turn":\s*(\d+)/g); if (matches) matches.forEach((match: string) => { const num = parseInt(match.split(":")[1].trim()); if (!isNaN(num) && !msgTurns.includes(num)) msgTurns.push(num); }); } });
            return (<MessageBubble key={m.id} message={m} isLast={idx === messages.length - 1} isStreaming={isStreaming && idx === messages.length - 1} bindings={bubbleBindings} highlightTerm={highlightTerm} highlightTurn={highlightTurn} isFollowUp={hasPreviousComparison} turns={msgTurns} />);
          })}
          {error && (<div className="p-4 rounded-2xl bg-red-50 border border-red-100 text-red-600 text-sm font-medium animate-in slide-in-from-bottom-4">{error.message}</div>)}
          <div ref={messagesEndRef} />
        </div>
      </main>
    </div>
  );


  const renderCriteriaContent = () => {
    const impStyles: Record<string, { label: string; bg: string; color: string }> = {
      high:   { label: T.impHigh,   bg: "#fff0f3", color: "#fb7185" },
      medium: { label: T.impMedium, bg: "#fffbeb", color: "#f59e0b" },
      low:    { label: T.impLow,    bg: "#f8fafc", color: "#94a3b8" },
    };
    return (
      <div
        onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-panel')) return; e.preventDefault(); e.currentTarget.classList.add("bg-primary/5", "border-primary/30"); }}
        onDragLeave={(e) => { e.currentTarget.classList.remove("bg-primary/5", "border-primary/30"); }}
        onDrop={(e: React.DragEvent<HTMLDivElement>) => {
          if (e.dataTransfer.types.includes('application/x-panel')) return;
          e.preventDefault(); e.currentTarget.classList.remove("bg-primary/5", "border-primary/30");
          const jsonData = e.dataTransfer.getData("application/json");
          const label = e.dataTransfer.getData("text/plain");
          if (jsonData) { try { const item = JSON.parse(jsonData); if (item.name && !droppedCriteria.some(c => c.name === item.name)) { const existingCriteria = droppedCriteria.map(c => ({ name: c.name, important: !!c.important })); const importanceLevel = item.important ? "high" : "low"; setDroppedCriteria((prev) => [...prev, { name: item.name, min: item.min, priority: item.priority || "medium", important: !!item.important, importanceLevel } as any]); checkTradeoff({ name: item.name, important: !!item.important }, existingCriteria); } } catch { if (label && !droppedCriteria.some(c => c.name === label)) setDroppedCriteria((prev) => [...prev, { name: label, priority: "medium" }]); } } else if (label && !droppedCriteria.some(c => c.name === label)) { setDroppedCriteria((prev) => [...prev, { name: label, priority: "medium" }]); }
        }}
        className="flex flex-col flex-1 overflow-hidden"
      >
        {/* 고정 헤더 */}
        <div className="flex items-center shrink-0 px-6 pt-8 pb-4">
          <div className="flex items-center gap-2"><p className="text-[12.5px] font-black text-slate-600 tracking-widest uppercase">🎯 DECISION CRITERIA</p>{droppedCriteria.length > 0 && <span className="text-[12px] font-normal text-slate-300">({droppedCriteria.length})</span>}</div>
        </div>
        {/* 스크롤 콘텐츠 */}
        <div className="flex flex-col gap-3 flex-1 overflow-y-auto px-6 pt-2 pb-6 no-scrollbar">
          {droppedCriteria.length > 0 ? (
            <div className="flex flex-wrap gap-2.5 w-full content-start">
              {droppedCriteria.map((criterion, i) => {
                const level = (criterion as any).importanceLevel as "high" | "medium" | "low" | undefined;
                const s = level ? impStyles[level] : null;
                return (
                  <div key={i} onClick={() => { setOpenImportanceIdx(null); if (!searchCriteria.some(c => c.name === criterion.name)) setSearchCriteria(prev => [...prev, { name: criterion.name, min: criterion.min, priority: criterion.priority }]); inputRef.current?.focus(); }} className="flex items-center gap-2 bg-white border border-slate-200 rounded-2xl px-2.5 h-[32px] w-fit max-w-full group animate-in zoom-in-95 duration-200 cursor-pointer hover:bg-slate-50 hover:border-slate-300 transition-colors">
                    <div className="relative shrink-0 flex items-center">
                      <button onClick={(e) => { e.stopPropagation(); setOpenImportanceIdx(openImportanceIdx === i ? null : i); }} className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold transition-all duration-150 leading-none" style={s ? { background: s.bg, color: s.color } : { background: "transparent", color: "#cbd5e1" }}>{s ? s.label : "·"}<ChevronDown className="w-2 h-2 opacity-60" /></button>
                      {openImportanceIdx === i && (<div className="absolute top-full left-0 mt-1 z-50 bg-white border border-slate-200 rounded-[8px] shadow-lg py-1 min-w-[64px]" onClick={(e) => e.stopPropagation()}>{(["high", "medium", "low"] as const).map(opt => { const os = impStyles[opt]; return (<button key={opt} onClick={(e) => { e.stopPropagation(); setDroppedCriteria(prev => { const next = [...prev]; next[i] = { ...next[i], importanceLevel: opt, important: opt === "high" } as any; return next; }); setOpenImportanceIdx(null); }} className="w-full text-left px-3 py-1 text-[10.5px] font-medium hover:bg-slate-50 transition-colors" style={{ color: os.color }}>{os.label}</button>); })}</div>)}
                    </div>
                    <div className="flex items-center gap-1.5 overflow-hidden min-w-0">
                      <span className="text-[12.5px] font-bold text-slate-800 select-none whitespace-nowrap shrink-0">{criterion.name}</span>
                      {editingCriteriaIdx === i ? (<input autoFocus className="text-[10.5px] text-slate-500 border-b border-slate-300 outline-none w-[60px] bg-transparent py-0 shrink-0" value={editingMinText} onChange={(e) => setEditingMinText(e.target.value)} onBlur={() => { setDroppedCriteria(prev => { const next = [...prev]; next[i] = { ...next[i], min: editingMinText }; return next; }); setEditingCriteriaIdx(null); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />) : (<span className="text-[10.5px] text-slate-500 font-medium select-none truncate" title={criterion.min || T.pinHint}>{criterion.min || T.pinHint}</span>)}
                    </div>
                    <div className="flex items-center gap-0.5 ml-1 pl-1 border-l border-slate-100">
                      <button onClick={(e) => { e.stopPropagation(); setEditingCriteriaIdx(i); setEditingMinText(criterion.min || ""); }} className="p-0.5 text-slate-300 hover:text-slate-600 transition-colors"><Pencil className="w-2.5 h-2.5" /></button>
                      <button onClick={(e) => { e.stopPropagation(); setDroppedCriteria(prev => prev.filter((_, idx) => idx !== i)); setTradeoffSpecs(prev => { const next = { ...prev }; delete next[criterion.name]; return next; }); }} className="p-0.5 text-slate-300 hover:text-slate-900 transition-colors"><X className="w-3 h-3" /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (<div className="flex-1 flex items-center justify-center"><p className="text-[12.5px] text-slate-300 font-medium text-center leading-relaxed">{T.criteriaEmpty.split('\n').map((line, i) => <span key={i}>{line}{i === 0 && <br />}</span>)}</p></div>)}
        </div>
        {/* TradeoffHints — 스크롤 영역 밖 (하단 고정) */}
        {(() => { const activeHints = droppedCriteria.filter(c => { const spec = tradeoffSpecs[c.name]; return spec?.type === "TradeoffHint" && !dismissedTradeoffs.has(c.name) && !tradeoffLoading.has(c.name); }); if (activeHints.length === 0) return null; const TradeoffHintComp = manualRegistry.TradeoffHint; return (<div className="flex flex-col gap-2 px-6 pb-4 pt-3 border-t border-slate-100 w-full shrink-0">{activeHints.map(criterion => (<TradeoffHintComp key={criterion.name} props={{ ...tradeoffSpecs[criterion.name].props, onDismiss: () => setDismissedTradeoffs(prev => new Set([...prev, criterion.name])), onResolve: () => { setDismissedTradeoffs(prev => new Set([...prev, criterion.name])); const spec = tradeoffSpecs[criterion.name].props; handleResolveTradeoff(spec.newCriterion, spec.conflictsWith); } }} />))}</div>); })()}
      </div>
    );
  };

  const renderOptionsContent = () => (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* 고정 헤더 */}
      <div className="flex items-center shrink-0 px-6 pt-8 pb-4">
        <div className="flex items-center gap-2"><p className="text-[12.5px] font-black text-slate-600 tracking-widest uppercase">🛒 MY OPTIONS</p>{droppedItems.length > 0 && <span className="text-[12px] font-normal text-slate-300">({droppedItems.length})</span>}</div>
      </div>
      {/* 스크롤 콘텐츠 */}
      <div className="flex flex-col gap-2 flex-1 overflow-y-auto px-6 pt-2 pb-6 no-scrollbar">
        {droppedItems.length > 0 ? droppedItems.map((item, i) => (
          <div key={i} onClick={() => insertMention(item.name)} className="group relative rounded-[8px] bg-white border border-slate-200 p-3 flex items-center gap-3 animate-in zoom-in-95 duration-200 hover:border-slate-300 transition-all cursor-pointer">
            <button onClick={(e) => { e.stopPropagation(); setDroppedItems((prev) => prev.filter((c) => c.name !== item.name)); }} className="absolute top-2 right-2 text-slate-300 hover:text-slate-700 transition-colors z-10"><X className="w-3 h-3" /></button>
            <div className="w-12 h-12 rounded-[4px] bg-slate-50 border border-slate-100 flex items-center justify-center flex-shrink-0 overflow-hidden">{item.image ? (<img src={item.image} alt={item.name} className="w-full h-full object-cover" />) : (<span className="text-[18px] font-black text-slate-300 uppercase">{item.name[0]}</span>)}</div>
            <div className="flex flex-col min-w-0 flex-1 pr-4 gap-1"><p className="text-[12px] font-semibold text-slate-900 leading-tight break-keep">{item.name}</p>{item.price && <span className="text-[11.5px] font-medium text-slate-500">{item.price}</span>}</div>
          </div>
        )) : (<div className="flex-1 flex items-center justify-center"><p className="text-[12.5px] text-slate-300 font-medium text-center leading-relaxed flex flex-col items-center gap-1"><span className="flex items-center gap-1.5">{locale === 'en' ? 'Press' : '관심 제품의'}<span className="inline-flex items-center justify-center w-[20px] h-[20px] rounded-full bg-slate-300/60"><Heart className="w-[10px] h-[10px] text-white" fill="white" strokeWidth={0} /></span>{locale === 'en' ? 'on products' : '를 눌러'}</span><span>{locale === 'en' ? 'to save them here' : '여기에 담아보세요'}</span></p></div>)}
      </div>
    </div>
  );

  const renderOptionList = () => (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-shrink-0 flex items-center gap-2 px-6 pt-5 pb-3 border-b border-slate-50">
        {gripHandle('optionList')}
        <p className="text-[12.5px] font-black text-slate-600 tracking-widest uppercase">📝 OPTION LIST</p>
      </div>
      <div className="flex-1 overflow-y-auto overflow-x-hidden no-scrollbar p-4">
        {productCardListSpec ? (
          <ExplorerRenderer
            spec={productCardListSpec}
            bindings={bubbleBindings}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <p className="text-[12px] text-slate-300 font-medium text-center leading-relaxed">
              {T.optionListEmpty.split('\n').map((line, i) => <span key={i}>{line}{i === 0 && <br />}</span>)}
            </p>
          </div>
        )}
      </div>
    </div>
  );

  const renderCompTable = () => (
    <div className="flex flex-col gap-4 p-6 flex-1 overflow-auto no-scrollbar">
      <div className="flex items-center gap-2">
        {gripHandle('compTable')}
        <p className="text-[12.5px] font-black text-slate-600 tracking-widest uppercase">⚖️ COMPARISON TABLE</p>
      </div>
      {compTableSpec ? (
        <div className="flex-1 overflow-auto no-scrollbar">
          <ExplorerRenderer
            spec={compTableSpec}
            bindings={bubbleBindings}
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[12px] text-slate-300 font-medium text-center leading-relaxed">
            제품 비교를 요청하면<br />여기에 비교표가 표시됩니다
          </p>
        </div>
      )}
    </div>
  );

  const renderPanel = (pid: PanelId): React.ReactNode => {
    if (pid === 'exploration') return renderExploration();
    if (pid === 'chat') return renderChat();
    if (pid === 'criteria') return renderCriteriaContent();
    if (pid === 'optionList') return renderOptionList();
    if (pid === 'compTable') return renderCompTable();
    return renderOptionsContent();
  };

  // 결정 요약 모달 데이터 계산
  const summaryTopProduct = (() => {
    // 1순위: compTable rank 1 제품
    if (compTableSpec?.props?.rows?.length > 0) {
      const rank1 = compTableSpec.props.rows.find((r: any) => String(r.rank) === "1");
      if (rank1?.product) return { name: rank1.product, source: 'table' as const };
    }
    // 2순위: My Items 첫 번째
    if (droppedItems.length > 0) return { name: droppedItems[0].name, price: droppedItems[0].price, image: droppedItems[0].image, source: 'items' as const };
    return null;
  })();

  const summaryExploredCategories = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'assistant') continue;
      for (const p of (m.parts ?? [])) {
        const ti = p as any;
        if ((ti.toolName === 'renderToSidebar' || ti.toolName === 'renderToExplorationJourney') && ti.state === 'result') {
          const spec = typeof ti.result === 'string' ? (() => { try { return JSON.parse(ti.result); } catch { return null; } })() : ti.result;
          if (spec?.type === 'CriteriaMap' && spec.props?.categories) return spec.props.categories as { label: string; items: { name: string }[] }[];
        }
      }
    }
    return [];
  })();

  return (
    <div className="h-screen flex flex-col w-full overflow-hidden bg-[#FAFAFA]">

      {/* ── 결정 요약 모달 ── */}
      {showSummaryModal && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto"
          style={{ backgroundColor: '#FAFAFA' }}
        >
          <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: '40px' }}>

            {/* ── 영수증 카드 ── */}
            <div style={{
              width: '100%',
              maxWidth: '624px',
              position: 'relative',
              borderRadius: '20px',
              boxShadow: '0 4px 24px rgba(0,0,0,0.08)'
            }}>

              {/* ── 위쪽 절반 (날짜 헤더 ~ 총계) ── */}
              <div style={{ backgroundColor: 'white', border: '1px solid #e2e8f0', borderTopLeftRadius: '20px', borderTopRightRadius: '20px', borderBottom: 'none' }}>

                {/* 헤더: 날짜(좌) + 시간(우) */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '29px 44px 24px' }}>
                  <span style={{ fontSize: '13px', color: '#94a3b8' }}>
                    {new Date().toLocaleDateString(locale === 'en' ? 'en-US' : 'ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })}
                  </span>
                  <span style={{ fontSize: '13px', color: '#94a3b8' }}>
                    {new Date().toLocaleTimeString(locale === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>

                {/* 최종 선택 제품 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 44px 12px', borderBottom: '1px solid #f1f5f9' }}>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{T.finalProduct}</span>
                  {(summaryTopProduct as any)?.price && (
                    <span style={{ fontSize: '11px', fontWeight: '600', color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{T.price}</span>
                  )}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '17px 44px 19px', borderBottom: '1px solid #f1f5f9' }}>
                  <span style={{ fontSize: '15px', color: '#1e293b', flex: 1, lineHeight: 1.4, fontWeight: '500' }}>
                    {summaryTopProduct ? summaryTopProduct.name : '—'}
                  </span>
                  {(summaryTopProduct as any)?.price && (
                    <span style={{ fontSize: '15px', color: '#1e293b', marginLeft: '16px', whiteSpace: 'nowrap' }}>
                      {(summaryTopProduct as any).price}
                    </span>
                  )}
                </div>

                {/* 결정 기준 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '17px 44px 12px', borderBottom: '1px solid #f1f5f9' }}>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{T.decisionCriteria}</span>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{T.importance}</span>
                </div>
                <div style={{ padding: '5px 44px 0' }}>
                  {droppedCriteria.length > 0 ? droppedCriteria.map((c, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #f8fafc' }}>
                      <span style={{ fontSize: '14px', color: '#334155', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {c.important && <span style={{ color: '#f59e0b', fontSize: '11px' }}>★</span>}
                        {c.name}
                      </span>
                      <span style={{ fontSize: '13px', color: '#94a3b8' }}>{c.important ? T.impKey : T.impRef}</span>
                    </div>
                  )) : (
                    <p style={{ fontSize: '14px', color: '#94a3b8', padding: '12px 0' }}>{T.noCriteria}</p>
                  )}
                </div>

                {/* 총계 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '19px 44px', borderTop: '1px solid #f1f5f9', marginTop: '4px' }}>
                  <span style={{ fontSize: '14px', color: '#334155' }}>{T.totalCriteria}</span>
                  <span style={{ fontSize: '14px', color: '#334155', fontWeight: '600' }}>{droppedCriteria.length}{T.countSuffix}</span>
                </div>

              </div>

              {/* 구분선 */}
              <div style={{ position: 'relative', height: '32px', display: 'flex', alignItems: 'center', backgroundColor: '#FAFAFA', zIndex: 3, borderLeft: '1px solid #e2e8f0', borderRight: '1px solid #e2e8f0' }}>
                <div style={{ flex: 1, borderTop: '1px dashed #e2e8f0', margin: '0 24px', position: 'relative', zIndex: 1 }} />
              </div>

              {/* ── 아래쪽 절반 (탐색 현황 + 바코드) ── */}
              <div style={{ backgroundColor: 'white', border: '1px solid #e2e8f0', borderBottomLeftRadius: '20px', borderBottomRightRadius: '20px', borderTop: 'none' }}>

                {/* 탐색 현황 */}
                <div style={{ padding: '19px 44px 24px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: '600' }}>{T.productsConsidered}</span>
                    <span style={{ fontSize: '13px', color: '#475569', fontWeight: '600' }}>{droppedItems.length}{T.countSuffix}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <span style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: '600', flexShrink: 0 }}>{T.exploredCategories}</span>
                    <span style={{ fontSize: '13px', color: '#475569', textAlign: 'right', maxWidth: '240px', lineHeight: 1.5, marginLeft: '16px' }}>
                      {summaryExploredCategories.length > 0
                        ? summaryExploredCategories.map((c: any) => c.label).join(', ')
                        : '—'}
                    </span>
                  </div>
                </div>

                {/* 바코드 */}
                <div style={{ padding: '5px 44px 34px', textAlign: 'center' }}>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: '1.5px', alignItems: 'stretch', height: '60px', marginBottom: '0' }}>
                    {[2,1,3,1,2,1,1,3,2,1,2,3,1,1,2,1,3,1,2,1,1,2,3,1,2,1,1,3,1,2,1,3,2,1,1,2,1,2,3,1,2,1,2,1,3,2,1,1,2,3,1,2,1,3,1,2,1,2,1,3].map((w, i) => (
                      <div key={i} style={{ width: `${w * 2}px`, backgroundColor: i % 11 === 0 ? 'transparent' : '#1e293b' }} />
                    ))}
                  </div>
                </div>

              </div>


            </div>
          </div>
        </div>
      )}




      {/* Full-width white header */}

      <div className="shrink-0 bg-[#FAFAFA] px-8 py-4 flex items-center justify-between border-b border-slate-200">
        <button
          type="button"
          onClick={() => resetSession()}
          className="text-[22px] font-bold text-slate-900 tracking-tight leading-tight hover:text-slate-600 transition-colors cursor-pointer"
        >
          GenSpace
        </button>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <User className="w-4 h-4 text-slate-500" strokeWidth={2.5} />
            <span className="text-[14.5px] font-medium text-slate-600">
              {T.greeting}<strong className="font-bold text-slate-900">{participantId}</strong>{T.greetingSuffix}
            </span>
          </div>
          {/* 언어 토글 */}
          <div className="flex items-center gap-1 text-[15px] font-medium select-none">
            <button
              onClick={() => setLocale('en')}
              className="transition-colors duration-150"
              style={{ color: locale === 'en' ? '#0f172a' : '#94a3b8', fontWeight: locale === 'en' ? 700 : 400 }}
            >EN</button>
            <span className="text-slate-300">/</span>
            <button
              onClick={() => setLocale('ko')}
              className="transition-colors duration-150"
              style={{ color: locale === 'ko' ? '#0f172a' : '#94a3b8', fontWeight: locale === 'ko' ? 700 : 400 }}
            >KO</button>
          </div>
          <button
            type="button"
            onClick={() => setShowSummaryModal(true)}
            className="px-4 py-2 rounded-[8px] text-[13px] font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-all duration-200"
          >
            {T.proceedToPayment}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col w-full overflow-hidden">
        <div className="flex w-full flex-1 min-h-0 p-3 pb-0 relative">

          {/* LEFT AREA FOR DYNAMIC PANELS */}
          <div className="flex-1 flex min-w-0 h-full relative overflow-hidden pr-[48px]">
            {/* SLOT 1 (LEFT) RESIZE HANDLE */}
          {isPanelShown(panelSlots.left) && (
            <div
              className="w-3 flex-shrink-0 flex items-center justify-center cursor-col-resize group"
              onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); pointerDragRef.current = { type: 'col-ol', startX: e.clientX, startY: e.clientY, startVal: panelWidths[panelSlots.left], containerH: 0 }; setIsResizing(true); }}
              onPointerMove={(e) => { const d = pointerDragRef.current; if (!d || d.type !== 'col-ol') return; setPanelWidths(prev => ({ ...prev, [panelSlots.left]: Math.max(160, Math.min(800, d.startVal - (e.clientX - d.startX))) })); }}
              onPointerUp={() => { pointerDragRef.current = null; setIsResizing(false); }}
            >
              <div className="w-[2px] h-8 rounded-full bg-slate-400/0 group-hover:bg-slate-400/60 transition-colors" />
            </div>
          )}

          {/* SLOT 1 (LEFT) */}
          <aside {...slotDropProps('left')} className={`bg-white z-10 flex flex-col overflow-hidden rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] ${isPanelShown(panelSlots.left) ? 'border border-slate-200' : 'border-0'} ${panelDropTarget === 'left' ? 'ring-2 ring-blue-400/40 ring-inset' : ''}`} style={{ width: isPanelShown(panelSlots.left) ? panelWidths[panelSlots.left] : 0, flexShrink: 1, transition: isResizing ? 'none' : 'width 0.45s cubic-bezier(0.4,0,0.2,1)' }}>
            {isPanelShown(panelSlots.left) && renderPanel(panelSlots.left)}
          </aside>

          {/* SLOT 1 <-> SLOT 2 RESIZE HANDLE */}
          {isPanelShown(panelSlots.left) && isPanelShown(panelSlots.compTableSlot) && (
            <div
              className="w-3 flex-shrink-0 flex items-center justify-center cursor-col-resize group"
              onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); pointerDragRef.current = { type: 'col-l', startX: e.clientX, startY: e.clientY, startVal: panelWidths[panelSlots.left], containerH: 0 }; setIsResizing(true); }}
              onPointerMove={(e) => { const d = pointerDragRef.current; if (!d || d.type !== 'col-l') return; setPanelWidths(prev => ({ ...prev, [panelSlots.left]: Math.max(160, Math.min(800, d.startVal + (e.clientX - d.startX))) })); }}
              onPointerUp={() => { pointerDragRef.current = null; setIsResizing(false); }}
            >
              <div className="w-[2px] h-8 rounded-full bg-slate-400/0 group-hover:bg-slate-400/60 transition-colors" />
            </div>
          )}


          {/* SLOT 2 (COMP TABLE SLOT) */}
          <aside
            {...slotDropProps('compTableSlot')}
            className={`bg-white overflow-hidden flex flex-col rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] h-full ${isPanelShown(panelSlots.compTableSlot) ? 'border border-slate-200' : 'border-0'} ${panelDropTarget === 'compTableSlot' ? 'ring-2 ring-blue-400/40 ring-inset' : ''}`}
            style={{ width: isPanelShown(panelSlots.compTableSlot) ? panelWidths[panelSlots.compTableSlot] : 0, flexShrink: 1, transition: isResizing ? 'none' : 'width 0.45s cubic-bezier(0.4,0,0.2,1)' }}
          >
            {isPanelShown(panelSlots.compTableSlot) && renderPanel(panelSlots.compTableSlot)}
          </aside>

          {/* SLOT 2 <-> SLOT 3 RESIZE HANDLE */}
          {isPanelShown(panelSlots.compTableSlot) && isPanelShown(panelSlots.farRight) && (
            <div
              className="w-3 flex-shrink-0 flex items-center justify-center cursor-col-resize group"
              onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); pointerDragRef.current = { type: 'col-ct', startX: e.clientX, startY: e.clientY, startVal: panelWidths[panelSlots.compTableSlot], containerH: 0 }; setIsResizing(true); }}
              onPointerMove={(e) => { const d = pointerDragRef.current; if (!d || d.type !== 'col-ct') return; setPanelWidths(prev => ({ ...prev, [panelSlots.compTableSlot]: Math.max(160, Math.min(800, d.startVal + (e.clientX - d.startX))) })); }}
              onPointerUp={() => { pointerDragRef.current = null; setIsResizing(false); }}
            >
              <div className="w-[2px] h-8 rounded-full bg-slate-400/0 group-hover:bg-slate-400/60 transition-colors" />
            </div>
          )}

          {/* SLOT 3 (FAR RIGHT SLOT) */}
          <aside
            {...slotDropProps('farRight')}
            className={`bg-white overflow-hidden flex flex-col rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] h-full ${isPanelShown(panelSlots.farRight) ? 'border border-slate-200' : 'border-0'} ${panelDropTarget === 'farRight' ? 'ring-2 ring-blue-400/40 ring-inset' : ''}`}
            style={{ width: isPanelShown(panelSlots.farRight) ? panelWidths[panelSlots.farRight] : 0, flexShrink: 1, transition: isResizing ? 'none' : 'width 0.45s cubic-bezier(0.4,0,0.2,1)' }}
          >
            {isPanelShown(panelSlots.farRight) && renderPanel(panelSlots.farRight)}
          </aside>

            {/* FLEX SPACER - Pushes dynamic slots to the left */}
            <div className="flex-1" />
          </div>

          {/* RIGHT COLUMN OVERLAY — DC+My Options (항상 맨 우측 고정) */}
          <div 
            className="absolute top-3 bottom-0 right-3 flex z-40 transition-all duration-300"
            style={{ pointerEvents: rightPanelCollapsed ? 'none' : 'auto', height: 'calc(100% - 12px)' }}
          >
            {/* 핸들: Option List <-> DC+My Options */}
            {!rightPanelCollapsed && (
              <div
                className="w-3 flex-shrink-0 flex items-center justify-center cursor-col-resize group"
                style={{ pointerEvents: 'auto' }}
                onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); pointerDragRef.current = { type: 'col-or', startX: e.clientX, startY: e.clientY, startVal: rightWidth, containerH: 0 }; setIsResizing(true); }}
                onPointerMove={(e) => { const d = pointerDragRef.current; if (!d || d.type !== 'col-or') return; setRightWidth(Math.max(160, Math.min(540, d.startVal - (e.clientX - d.startX)))); }}
                onPointerUp={() => { pointerDragRef.current = null; setIsResizing(false); }}
              >
                <div className="w-[2px] h-8 rounded-full bg-slate-400/0 group-hover:bg-slate-400/60 transition-colors" />
              </div>
            )}

            <aside
              className={`relative overflow-hidden flex flex-col rounded-2xl h-full transition-all duration-300 ${rightPanelCollapsed ? 'bg-white border border-transparent shadow-[0_2px_8px_rgba(0,0,0,0.04)]' : 'bg-white/95 backdrop-blur-sm border border-slate-200 shadow-2xl'}`}
              style={{ width: rightPanelCollapsed ? 36 : rightWidth, flexShrink: 0, transition: isResizing ? 'none' : 'width 0.3s cubic-bezier(0.4,0,0.2,1)', pointerEvents: 'auto' }}
            >
              {rightPanelCollapsed ? (
                /* 접힌 상태: 36px 스트립 상단 중앙 */
                <button
                  onClick={() => setRightPanelCollapsed(false)}
                  className="absolute top-3 left-1/2 -translate-x-1/2 p-1.5 rounded-md text-slate-600 hover:bg-slate-100 transition-colors"
                  title="패널 펼치기"
                >
                  <PanelLeft className="w-4 h-4" />
                </button>
              ) : (
                <>
                  {/* 접기 버튼 */}
                  <div className="absolute top-3 right-3 z-10">
                    <button
                      onClick={() => setRightPanelCollapsed(true)}
                      className="p-1.5 rounded-md text-slate-600 hover:bg-slate-100 transition-colors"
                      title="패널 접기"
                    >
                      <PanelRight className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    {renderPanel(panelSlots.rightTop)}
                  </div>
                  <div className="h-px bg-slate-100 flex-shrink-0 mx-4" />
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    {renderPanel(panelSlots.rightBottom)}
                  </div>
                </>
              )}
            </aside>
          </div>
        </div>

        {/* INPUT BAR — 패널 행 밖, 다른 패널에 영향받지 않는 독립 영역 */}
        <div className="flex-shrink-0 px-3 pb-3 pt-3 relative">
          {showScrollButton && (
            <button
              onClick={scrollToBottom}
              className="absolute left-1/2 -translate-x-1/2 top-0 z-10 h-8 w-8 rounded-full border border-slate-200 bg-white text-slate-400 shadow-xl flex items-center justify-center hover:text-slate-900 hover:border-slate-900 transition-all"
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
          )}
          <div className="max-w-2xl w-full mx-auto flex flex-col">
            {/* 최근 질문 표시 */}
            {(() => {
              const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
              if (!lastUserMsg) return null;
              const rawText = (lastUserMsg as any).content || ((lastUserMsg as any).parts?.find((p: any) => p.type === 'text')?.text || "");
              let displayMsg = rawText;
              const cumulativeMatch = displayMsg.match(/^\[SYSTEM: CUMULATIVE COMPARISON\] (.*?) 제품들을 Table/i);
              
              if (cumulativeMatch) {
                displayMsg = `"${cumulativeMatch[1].trim()}" 제품을 비교해줘.`;
              } else {
                const isPureCriteria = /^\[Decision Criteria\s*:[^\]]*\]\s*(?:\n|$|\[)/i.test(rawText);
                const isPureMyItems = /^\[My items\s*:[^\]]*\]\s*(?:\n|$|\[)/i.test(rawText);

                displayMsg = displayMsg.replace(/\|https?:\/\/[^\s,\]]+/g, "");
                displayMsg = displayMsg.replace(/^\[Decision Criteria\s*:([^\]]*)\]\s*/i, '"$1" ');
                displayMsg = displayMsg.replace(/^\[My items\s*:([^\]]*)\]\s*/i, '"$1" ');
                displayMsg = displayMsg.split(/\n{1,2}\[CONTEXT:/i)[0];
                displayMsg = displayMsg.split(/\n{1,2}\[DECISION CRITERIA:/i)[0];
                displayMsg = displayMsg.split(/\n{1,2}\[USER CONTEXT:/i)[0];
                displayMsg = displayMsg.split(/\n{1,2}\[ASSIGNED ITEM:/i)[0];
                displayMsg = displayMsg.trim();

                if (isPureCriteria && displayMsg && !displayMsg.includes("조건으로 추천해줘")) displayMsg += " 조건으로 추천해줘.";
                if (isPureMyItems && displayMsg && !displayMsg.includes("비교해줘")) displayMsg += " 제품을 비교해줘.";
              }
              
              if (displayMsg) {
                return (
                  <div className="flex animate-in fade-in slide-in-from-bottom-1 duration-300 min-w-0">
                    <div
                      className="px-3 py-1.5 ml-5 flex items-center gap-2 bg-white border border-slate-200 border-b-0 rounded-t-[12px] relative z-10 translate-y-[1px] overflow-hidden"
                      style={{ maxWidth: 'calc(100% - 60px)' }}
                    >
                      <span className="shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-slate-100 text-slate-400 text-[11px] font-bold">Q</span>
                      <span
                        className="min-w-0 leading-relaxed font-medium text-slate-500 whitespace-normal break-words"
                        title={displayMsg}
                        style={{ fontSize: displayMsg.length > 120 ? '10px' : displayMsg.length > 80 ? '11px' : displayMsg.length > 40 ? '12px' : '13px' }}
                      >{displayMsg}</span>
                    </div>
                  </div>
                );
              }
              return null;
            })()}

            <div
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("bg-slate-50", "border-slate-300"); }}
              onDragLeave={(e) => { e.currentTarget.classList.remove("bg-slate-50", "border-slate-300"); }}
              onDrop={(e: React.DragEvent<HTMLDivElement>) => {
                e.preventDefault();
                e.currentTarget.classList.remove("bg-slate-50", "border-slate-300");
                const jsonData = e.dataTransfer.getData("application/json");
                const label = e.dataTransfer.getData("text/plain");
                if (jsonData) { try { const item = JSON.parse(jsonData); if (item.name && !searchCriteria.some(c => c.name === item.name)) setSearchCriteria(prev => [...prev, { name: item.name, min: item.min, priority: item.priority || "medium" }]); } catch { if (label && !searchCriteria.some(c => c.name === label)) setSearchCriteria(prev => [...prev, { name: label, priority: "medium" }]); } } else if (label && !searchCriteria.some(c => c.name === label)) setSearchCriteria(prev => [...prev, { name: label, priority: "medium" }]);
              }}
              className="relative z-0 flex items-end gap-2 bg-white border border-slate-200 rounded-[24px] p-2 pl-4 pr-2 shadow-lg shadow-slate-200/50 hover:shadow-xl hover:border-slate-300 transition-all focus-within:border-slate-400 focus-within:ring-4 focus-within:ring-slate-100 min-h-[48px]"
            >
              <div className="flex-1 flex flex-wrap items-center gap-1.5 min-w-0 max-h-[120px] overflow-y-auto py-1">
                {mentionChips.map((chip, i) => (<div key={`mention-${i}`} className="flex items-center gap-1.5 bg-slate-50 border border-slate-100 rounded-full px-2 py-0.5 h-[28px] shrink-0 animate-in zoom-in-95 duration-200"><span className="text-[12px] font-bold text-slate-800">{chip.name}</span><button onClick={() => setMentionChips(prev => prev.filter((_, idx) => idx !== i))} className="ml-1 p-0.5 text-slate-300 hover:text-slate-900 transition-colors"><X className="w-2.5 h-2.5" /></button></div>))}
                {searchCriteria.map((c, i) => (<div key={`criteria-${i}`} className="flex items-center gap-1.5 bg-slate-50 border border-slate-100 rounded-full px-2 py-0.5 h-[28px] shrink-0 animate-in zoom-in-95 duration-200"><span className="text-[12px] font-bold text-slate-800">{c.name}</span>{c.min && <span className="text-[10px] text-slate-500 font-medium">{c.min}</span>}<button onClick={() => setSearchCriteria(prev => prev.filter((_, idx) => idx !== i))} className="ml-1 p-0.5 text-slate-300 hover:text-slate-900 transition-colors"><X className="w-2.5 h-2.5" /></button></div>))}
                <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} placeholder={(searchCriteria.length > 0 || mentionChips.length > 0) ? "" : T.askAnything} rows={1} className="flex-1 min-w-[120px] bg-transparent border-none focus:ring-0 focus:outline-none focus-visible:ring-0 resize-none text-slate-800 placeholder:text-slate-400 py-1 text-[15px] font-medium" />
              </div>
              {(() => {
                const isInputEmpty = !input.trim() && searchCriteria.length === 0 && mentionChips.length === 0;
                const isSubmitDisabled = isInputEmpty || isStreaming;
                return (
                  <button onClick={() => handleSubmit()} disabled={isSubmitDisabled} className="w-9 h-9 rounded-full flex items-center justify-center transition-all shadow-md shrink-0 self-end mb-0.5 bg-slate-900 text-white hover:bg-black active:scale-95 disabled:bg-slate-50 disabled:text-slate-300 disabled:hover:bg-slate-50 disabled:active:scale-100 disabled:shadow-none disabled:cursor-default border border-transparent disabled:border-slate-100">
                    {isStreaming ? (
                      <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
                    ) : (
                      <ArrowUp className={`h-4 w-4 ${isSubmitDisabled ? "stroke-[1.5px]" : "stroke-[2.5px]"}`} />
                    )}
                  </button>
                );
              })()}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

