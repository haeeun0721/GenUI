"use client";

import { useState, useCallback, useMemo, memo, useRef, useEffect, startTransition } from "react";
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
import PanelTour from "@/components/PanelTour";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
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
  Heart,
  GripVertical,
  PanelRight,
  PanelLeft,
  User,
  History,
  Compass,
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

// 입력창 위 Q 탭과 히스토리 드로어가 공유하는, 사용자 메시지 원문 → 표시용 텍스트 정리 로직.
function extractUserDisplayText(rawText: string): string {
  let displayMsg = rawText;
  const cumulativeMatch = displayMsg.match(/^\[SYSTEM: CUMULATIVE COMPARISON\] (.*?) ??품??을 Table/i);

  if (cumulativeMatch) {
    return `"${cumulativeMatch[1].trim()}" ??품??비교??줘.`;
  }

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

  if (isPureCriteria && displayMsg && !displayMsg.includes("조건??로 추천??줘")) displayMsg += " 조건??로 추천??줘.";
  if (isPureMyItems && displayMsg && !displayMsg.includes("비교??줘")) displayMsg += " ??품??비교??줘.";
  return displayMsg;
}

function formatTurnTime(ts: number | undefined, locale: 'ko' | 'en'): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString(locale === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
}

function getMessageText(m: any): string {
  return ((m?.parts ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join("")).trim();
}

type HistoryTurn = { user: any; assistant: any | null };

// user/assistant 메시지를 턴 단위로 짝짓는다 — 히스토리 드로어와 카운트가 공유하는 기본 단위.
function buildHistoryTurns(messages: any[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  messages.forEach((m) => {
    if (m.role === 'user') {
      const isSystemPrompt = (m.parts ?? []).some((p: any) => p.type === 'text' && p.text?.includes('[SYSTEM: CUMULATIVE COMPARISON]'));
      if (isSystemPrompt) return;
      turns.push({ user: m, assistant: null });
    } else if (m.role === 'assistant' && turns.length > 0 && turns[turns.length - 1].assistant === null) {
      turns[turns.length - 1].assistant = m;
    }
  });
  return turns;
}

function getActionData(assistant: any): any {
  return assistant ? ((assistant.parts ?? []).find((p: any) => p.type === 'data-action-type') as any)?.data ?? null : null;
}

// generate/edit 턴은 캔버스(패널)에 이미 결과가 남아있어서 전체 응답을 다시 보여줄 필요는 없지만,
// "이 턴에서 뭘 했는지"는 히스토리에서도 한눈에 알 수 있도록 짧은 요약으로 남긴다.
function actionSummaryLabel(data: any, locale: 'ko' | 'en'): string | null {
  if (!data) return null;
  const isEn = locale === 'en';
  if (data.action === 'generate') {
    const labels: Record<string, [string, string]> = {
      CriteriaMap: ['기준 맵 생성됨', 'Criteria map generated'],
      InformationCard: ['정보 카드 생성됨', 'Information card generated'],
      ComparisonTable: ['비교 테이블 생성됨', 'Comparison table generated'],
      ProductCardList: ['옵션 리스트 생성됨', 'Option list generated'],
    };
    const pair = labels[data.template];
    return pair ? (isEn ? pair[1] : pair[0]) : null;
  }
  if (data.action === 'edit') {
    const labels: Record<string, [string, string]> = {
      optionList: ['옵션 리스트 수정됨', 'Option list updated'],
      comparisonTable: ['비교 테이블 수정됨', 'Comparison table updated'],
      criteriaMap: ['기준 맵 수정됨', 'Criteria map updated'],
    };
    const pair = labels[data.target_surface];
    return pair ? (isEn ? pair[1] : pair[0]) : null;
  }
  return null;
}

// 입력창 위 미리보기 한 턴 — 현재 턴(들어오는 애니메이션)과 이전 턴(나가는 애니메이션)이
// 같은 모양을 쓰도록 공유하는 프레젠테이션 컴포넌트.
function DockTurnRow({ turn, userLabel, streaming, className }: {
  turn: { displayMsg: string; assistantText: string; summaryLabel: string | null };
  userLabel: string;
  streaming?: boolean;
  className: string;
}) {
  return (
    <div className={`flex flex-col min-w-0 ml-5 mb-1 ${className}`} style={{ maxWidth: 'calc(100% - 60px)' }}>
      <div className="flex items-center gap-2.5">
        <span className="shrink-0 px-2 py-1 rounded-md bg-slate-100 text-slate-500 font-bold text-[10px]">{userLabel}</span>
        <span className="flex-1 min-w-0 text-[13px] leading-relaxed text-slate-700 whitespace-pre-wrap break-words">{turn.displayMsg}</span>
      </div>
      {/* AI 응답 줄은 답변 길이만큼만 차지하되, 너무 길어지면 max-h에서 스크롤되도록 캡을 둔다
          (입력창과의 간격이 답변이 짧을 때도 벌어지지 않게). */}
      <div className="ml-1.5 pl-4 border-l border-slate-200 mt-1 pb-0.5 flex items-start gap-2">
        {turn.assistantText ? (
          <>
            <span className="shrink-0 px-2 py-1 rounded-md bg-indigo-50 text-indigo-500 font-bold text-[10px] mt-0.5">AI</span>
            <div className="min-w-0 flex-1 max-h-14 overflow-y-auto styled-scrollbar pr-2">
              <span className="text-[13px] leading-relaxed text-slate-700 whitespace-pre-wrap break-words">
                {turn.assistantText}
                {streaming && <span className="inline-block w-[2px] h-[11px] bg-indigo-500 ml-0.5 -mb-0.5 animate-pulse" />}
              </span>
            </div>
          </>
        ) : turn.summaryLabel ? (
          <span className="text-[11px] text-slate-400 font-medium flex items-center gap-1">
            <Sparkles className="w-2.5 h-2.5" />
            {turn.summaryLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}

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
  return "는";
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
    locale?: 'ko' | 'en';
  };
  highlightTerm?: string | null;
  highlightTurn?: number | null;
  isFollowUp?: boolean;
  turns?: number[];
}) => {
  const { onItemAdd, onItemRemove, onCompareRequested, savedItems, droppedCriteria, onRequestCriteriaData, onAddMyItemsToTable, userContext, locale: bubbleLocale } = bindings;
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

  // ????벨??서 ??스????드??직접 찾아 ??이??이??하??가????실??방식
  // [??시 비활??화] 충돌 ??무한 루프 방??????해 ??이??이??기능 ??시 ??거
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
                fontSize: userText.length > 120 ? '10px' : userText.length > 60 ? '11px' : '13px',
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
              className="relative z-10 text-sm leading-relaxed text-slate-800 [&_p+p]:mt-3 [&_ul]:mt-2 [&_ol]:mt-2 [&_pre]:mt-2 select-none"
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
                bindings={{ onItemAdd, onItemRemove, onCompareRequested, savedItems, isFollowUp, droppedCriteria, onRequestCriteriaData, onAddMyItemsToTable, isLatestMessage: isLast, userContext, locale: bubbleLocale }}
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
  // isNew는 마운트 시점 한 번만 판정(지연 초기화)하고, 애니메이션이 실제로 끝날 때(onAnimationEnd)
  // 까지 true로 유지한다 — effect의 setState로 바로 꺼버리면 브라우저가 다시 그리기 전에 클래스가
  // 빠져서 2초짜리 highlight-wrap 글로우가 시작하자마자 잘려버린다(CriteriaMap과 동일한 패턴).
  const [isNew, setIsNew] = useState(() => !globalSeenTerms.has(card.term));

  useEffect(() => {
    globalSeenTerms.add(card.term);
  }, [card.term]);

  return (
    <div
      className={`border border-slate-200 rounded-[8px] p-4 bg-white${isNew ? " animate-highlight-wrap" : ""}`}
      style={isNew ? { animationDelay: `${index * 0.08}s` } : undefined}
      onAnimationEnd={(e) => {
        if (isNew && e.animationName === 'highlight-wrap') setIsNew(false);
      }}
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
  const [userContext, setUserContext] = useState(() =>
    typeof window !== 'undefined' ? (localStorage.getItem('gs_userContext') ?? '') : ''
  );
  const [assignedItem, setAssignedItem] = useState<"A" | "B" | "C" | "">('');

  const T = {
    greeting: locale === 'en' ? 'Hello, ' : '안녕하세요, ',
    greetingSuffix: locale === 'en' ? '' : '님',
    proceedToPayment: locale === 'en' ? 'Proceed to Payment' : '결제 진행하기',
    askAnything: locale === 'en' ? 'Ask me anything' : '무엇이든 물어보세요',
    participantId: locale === 'en' ? 'PARTICIPANT ID' : '참여자 ID',
    assignedItem: locale === 'en' ? 'ASSIGNED ITEM' : '배정받은 아이템',
    purchaseContext: locale === 'en' ? 'PURCHASE CONTEXT' : '구매 목적 및 상황',
    contextPlaceholder: locale === 'en'
      ? (assignedItem === 'B'
        ? 'e.g. I have a cat and need strong suction and mopping.'
        : assignedItem === 'C'
          ? 'e.g. I want to take beautiful landscape and portrait photos while traveling. I will also shoot vlogs.'
          : 'e.g. I go out often alone. Lightweight and portable is important.')
      : (assignedItem === 'B'
        ? '저 고양이를 키우고 있어서 흡입력이 강하고 물걸레 기능도 있는 제품이 필요해요.'
        : assignedItem === 'C'
          ? '여행 다니면서 풍경이나 인물 사진을 예쁘게 찍고 싶어요. 브이로그 촬영도 할 거예요.'
          : '외출이 잦아서 혼자 쓰기에 가볍고 휴대성이 좋은 게 중요해요.'),
    getStarted: locale === 'en' ? 'Get Started' : '시작하기',
    criteriaEmpty: locale === 'en' ? 'Click criteria chips\nto pin them here' : '기준 칩을 클릭해\n여기에 고정해두세요',
    optionsEmpty: locale === 'en' ? 'Press ♡ on products\nto save them here' : '관심 제품의 ♡를 눌러\n여기에 저장해보세요',
    optionListEmpty: locale === 'en' ? 'Get product recommendations\nto see options here' : '제품 추천을 받으면\n여기에 옵션이 표시됩니다',
    stroller: locale === 'en' ? 'Stroller' : '유모차',
    robotVacuum: locale === 'en' ? 'Robot Vacuum' : '로봇 청소기',
    camera: locale === 'en' ? 'Camera' : '카메라',
    pinHint: locale === 'en' ? 'Enter' : '입력',
    // Receipt modal
    finalProduct: locale === 'en' ? 'FINAL SELECTION' : '최종 선택 제품',
    price: locale === 'en' ? 'PRICE' : '가격',
    decisionCriteria: locale === 'en' ? 'DECISION CRITERIA' : '결정 기준',
    importance: locale === 'en' ? 'IMPORTANCE' : '중요도',
    noCriteria: locale === 'en' ? 'No saved criteria' : '저장된 기준 없음',
    totalCriteria: locale === 'en' ? 'Total Criteria' : '총 결정 기준',
    productsConsidered: locale === 'en' ? 'PRODUCTS CONSIDERED' : '검토한 제품',
    exploredCategories: locale === 'en' ? 'EXPLORED CATEGORIES' : '탐색한 카테고리',
    impKey: locale === 'en' ? 'Key' : '핵심',
    impRef: locale === 'en' ? 'Ref' : '참고',
    countSuffix: locale === 'en' ? '' : '개',
  };

  const [droppedCriteria, setDroppedCriteria] = useState<{ name: string; min?: string; priority: string; important?: boolean }[]>([]);
  // 최신 droppedCriteria를 effect 의존성 없이 읽기 위한 ref — messages 전용 useEffect(아래)가
  // droppedCriteria 변경만으로 재실행되어 updateComparisonTable()의 직접 setCompTableSpec() 결과를
  // messages에서 재추출한 낡은 스펙으로 덮어써버리는 걸 막는다.
  const latestDroppedCriteriaRef = useRef(droppedCriteria);
  latestDroppedCriteriaRef.current = droppedCriteria;
  const [searchCriteria, setSearchCriteria] = useState<{ name: string; min?: string; priority: string }[]>([]);
  const [droppedItems, setDroppedItems] = useState<{ name: string; image?: string; price?: string; description?: string; specs?: string[]; link?: string }[]>([]);
  const [mentionChips, setMentionChips] = useState<{ name: string; link?: string }[]>([]);
  const [editingCriteriaIdx, setEditingCriteriaIdx] = useState<number | null>(null);
  const [editingMinText, setEditingMinText] = useState("");
  const [openPriorityIdx, setOpenPriorityIdx] = useState<number | null>(null);
  const [highlightTerm, setHighlightTerm] = useState<string | null>(null);
  const [highlightTurn, setHighlightTurn] = useState<number | null>(null);
  const [journeyTab, setJourneyTab] = useState<"criteria" | "information">("criteria");
  // tradeoffSpecs: maps criterion name ??UI Agent spec (TradeoffHint or Empty)
  const [tradeoffSpecs, setTradeoffSpecs] = useState<Record<string, { type: string; props: any }>>({});
  const [tradeoffLoading, setTradeoffLoading] = useState<Set<string>>(new Set());
  const [dismissedTradeoffs, setDismissedTradeoffs] = useState<Set<string>>(new Set());
  // UnchartedTerritoryChip spec ??set when Cat 2 fires with criteria + items
  const [unchartedSpec, setUnchartedSpec] = useState<{ labels: string[] } | null>(null);
  const [dismissedUncharted, setDismissedUncharted] = useState<Set<string>>(new Set());
  // locale ??환 ??번????태
  const [isTranslating, setIsTranslating] = useState(false);
  // locale ??환 override ??펙 (??본 messages??건드리?? ??고 ??적 ??이 교체)
  const [localizedCriteriaMap, setLocalizedCriteriaMap] = useState<any>(null);
  const [localizedConceptCards, setLocalizedConceptCards] = useState<any[] | null>(null);
  // ??전 번역 컠테??너 (??트리밍 ??료 ??반?? locale??미리 번역??둠)
  const [preTranslated, setPreTranslated] = useState<{
    locale: 'ko' | 'en';
    criteriaMap?: any;
    conceptCards?: any[];
    compTable?: any;
    productCardList?: any;
    uncharted?: { labels: string[] };
    tradeoffs?: Record<string, any>;
    droppedItems?: any[];
    queryHistory?: any[];
  } | null>(null);
  const isPreTranslatingRef = useRef(false); // 중복 ??행 방??
  const prevTableTurnRef = useRef<number>(-1);
  // UnchartedTerritoryChip: 조건 ??환 감????refs
  const prevConditionsRef = useRef<boolean>(false);      // ??전 allConditionsMet
  const pendingFetchRef = useRef<boolean>(false);         // ??트리밍 ??제 ????행 ??????????
  const prevCompTableCountRef = useRef<number>(0);        // ??전 비교????성 ??수 (비교 반복 감??)
  const unchartedHasShownRef = useRef<boolean>(false);    // ????시 ???? (??후 ??니메이????킵)
  // Reactive Option List ??droppedCriteria 변??감????
  const prevDroppedCriteriaRef = useRef<{ name: string; min?: string }[]>([]);
  const productCardListSpecRef = useRef<any>(null); // ??테????로?? 방????최신 spec ref
  const criteriaMapRef = useRef<any>(null); // sidebarSpec.CriteriaMap??최신 값 ??조??(??일????선 밖)
  const [criteriaResetConfirm, setCriteriaResetConfirm] = useState(false);
  // Panel resize state
  const [isResizing, setIsResizing] = useState(false);
  const [panelWidths, setPanelWidths] = useState<Record<string, number>>({
    exploration: 420,
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
  const [coverageNoticeSpec, setCoverageNoticeSpec] = useState<any>(null);
  const [compTableSpec, setCompTableSpec] = useState<any>(null);
  const compTableSpecRef = useRef<any>(null);
  // updateComparisonTable()은 채팅 메시지를 거치지 않고 compTableSpec을 직접 갱신한다(기준 추가 시
  // auto-enrich 결과 반영 등). 이 갱신이 messages에는 전혀 기록되지 않으므로, 그 다음 아무 채팅이나
  // 한 번만 쳐도(비교표와 무관한 질문이어도) messages를 다시 스캔하는 "Comparison Table 패널" effect가
  // 이 최신 상태를 옛 스펙으로 덮어써버린다 — true인 동안 그 effect가 덮어쓰기를 건너뛴다.
  const directTableUpdateAheadRef = useRef(false);
  // 위 "Comparison Table 패널" effect가 매 턴마다 messages를 다시 스캔할 때, 실제로 새로
  // 비교표 관련 턴이 있었는지(occurrence 수 증가) 판단하기 위한 이전 개수 기록.
  const prevCompTableOccurrenceCountRef = useRef(0);
  const [isUpdatingTable, setIsUpdatingTable] = useState(false);
  // auto-enrich 실행 중 현재 처리 중인 criterion 이름 (null이면 실행 안 함)
  const [enrichingCriterion, setEnrichingCriterion] = useState<string | null>(null);
  // updateComparisonTable 요청의 순번. 응답이 도착했을 때 더 최신 요청이 이미 나갔다면
  // (겹치는 기준 변경 등으로) 낡은 응답이 최신 테이블 상태를 덮어써 행이 사라지는 것을 방지.
  const updateTableSeqRef = useRef(0);
  // Query history ??검????스??리 (??비게이??용)
  // mutateLog: ??페이지??대??mutate(filter/sort/add) ??력??"꼬리 질문"??형태로 ??여주기 ??한 기록
  type MutateLogEntry = { summary: string; op: string; timestamp: Date; userQuery?: string };
  type QHEntry = { id: string; query: string; criteria: string[]; timestamp: Date; spec: any; mutateLog?: MutateLogEntry[]; };
  const [queryHistory, setQueryHistory] = useState<QHEntry[]>([]);
  const [activeHistoryIndex, setActiveHistoryIndex] = useState<number>(-1);
  // Comparison Table 이력 배너 — Option List의 queryHistory/mutateLog와 같은 목적이지만,
  // ComparisonTable은 "페이지"가 아니라 하나의 표가 계속 갱신되는 구조라 별도 페이지 배열 없이
  // "현재 표를 만든 질문" + "그 뒤로 이어진 mutate 꼬리 질문" 두 가지만 추적한다.
  type CompTableMutateLogEntry = { id: string; summary: string; op: string; userQuery?: string };
  const [compTableQuery, setCompTableQuery] = useState<string>('');
  const [compTableMutateLog, setCompTableMutateLog] = useState<CompTableMutateLogEntry[]>([]);
  // productCardListSpec은 "Option List 패널: turn별로 분리된 카드 추적" effect가 매 메시지마다
  // data-option-list-spec 파트만으로 무조건 다시 계산해서 덮어쓰기 때문에, mutateSurface(add/filter/
  // sort)로 반영된 변경사항이 다음 턴이 오면 사라질 수 있다(그 effect는 mutateSurface 결과를 모름).
  // 반면 queryHistory[activeHistoryIndex].spec은 같은 effect 안에서 "카드가 겹치면 기존 값 보존"
  // 로직으로 mutateSurface 변경분을 지킨다. 그래서 백엔드로 보낼 "현재 목록"은 productCardListSpec이
  // 아니라 이 보호된 값을 우선 사용해야 한다 — 화면에 보이는 것(specToShow도 동일 우선순위)과 백엔드로
  // 보내는 것을 일치시킨다.
  const activeOptionListCardsRef = useRef<any[] | null>(null);
  // 이 리스트를 만들 때 쓴 원래 검색 제약(예: "흡입력 4,500pa 이상") — renderToOptionList가
  // spec._searchQuery로 붙여준 걸 카드와 같은 방식으로 보호해서, 후속 mutate(add/filter/sort)를
  // 거쳐도 안 사라지게 한다. Edit Agent가 대화 히스토리를 못 보므로 이게 유일한 통로다.
  const activeOptionListSearchQueryRef = useRef<string | null>(null);
  useEffect(() => {
    const active = queryHistory[activeHistoryIndex];
    activeOptionListCardsRef.current = active?.spec?.props?.cards ?? productCardListSpec?.props?.cards ?? null;
    activeOptionListSearchQueryRef.current = active?.spec?._searchQuery ?? productCardListSpec?._searchQuery ?? null;
  }, [queryHistory, activeHistoryIndex, productCardListSpec]);
  // 스트리밍 중 messages 참조가 계속 바뀌면서 mutateSurface effect가 반복 실행되는 것을 막기 위한
  // "이미 처리한 메시지 id" 기록 (중복 mutateLog 방지)
  const processedMutateMsgIdRef = useRef<string | null>(null);
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [selectedItemName, setSelectedItemName] = useState<string | null>(null);
  const [showTour, setShowTour] = useState(false);
  // Panel visibility ??hidden initially, slide in when AI produces relevant content
  const [showExplorationPanel, setShowExplorationPanel] = useState(false);
  const [showCompTablePanel, setShowCompTablePanel] = useState(false);
  const [showOptionListPanel, setShowOptionListPanel] = useState(false);
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
  const historyDrawerBodyRef = useRef<HTMLDivElement>(null);
  const [msgTimestamps, setMsgTimestamps] = useState<Record<string, number>>({});
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
  // ??라??ref ??기????????더마다 최신?????? (useEffect보다 ??전, dependency 불필??
  productCardListSpecRef.current = productCardListSpec;

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
      title={locale === 'en' ? 'Drag to move panel' : '드래그하여 패널 이동'}
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

  const lastMessage = messages[messages.length - 1];

  // 입력창 위 미리보기(dock) — 턴 단위로 묶은 뒤, 마지막 턴을 "현재"로 보여주고 그 직전
  // 턴은 새 턴이 시작되는 순간 잠깐 "나가는" 애니메이션으로 보여줬다가 정리한다.
  // (스트리밍 중엔 messages가 토큰마다 바뀌지만 "턴 개수"는 안 바뀌므로, 이 값에만 걸어두면
  // 스트리밍 도중 타이머가 매번 취소되는 일 없이 정확히 턴이 바뀔 때만 애니메이션이 걸린다.)
  type DockTurn = { id: string; displayMsg: string; assistantText: string; summaryLabel: string | null };
  const dockTurns = useMemo(() => buildHistoryTurns(messages), [messages]);
  const toDockTurn = (t: HistoryTurn | null): DockTurn | null => {
    if (!t) return null;
    const rawText = (t.user as any).content || getMessageText(t.user);
    const displayMsg = extractUserDisplayText(rawText);
    if (!displayMsg) return null;
    const actionData = getActionData(t.assistant);
    const isNoneReply = actionData?.action === 'none';
    const assistantText = isNoneReply ? getMessageText(t.assistant) : "";
    const summaryLabel = t.assistant && !isNoneReply ? actionSummaryLabel(actionData, locale) : null;
    return { id: t.user.id, displayMsg, assistantText, summaryLabel };
  };
  const currentDockTurn = toDockTurn(dockTurns[dockTurns.length - 1] ?? null);
  const previousDockTurn = toDockTurn(dockTurns.length >= 2 ? dockTurns[dockTurns.length - 2] : null);

  const [showExitingDockTurn, setShowExitingDockTurn] = useState(false);
  const prevTurnCountRef = useRef(dockTurns.length);
  useEffect(() => {
    if (dockTurns.length > prevTurnCountRef.current) {
      setShowExitingDockTurn(true);
      const timeoutId = setTimeout(() => setShowExitingDockTurn(false), 450);
      prevTurnCountRef.current = dockTurns.length;
      return () => clearTimeout(timeoutId);
    }
    prevTurnCountRef.current = dockTurns.length;
  }, [dockTurns.length]);
  const exitingDockTurn = showExitingDockTurn ? previousDockTurn : null;

  // 메시지 자체엔 타임스탬프가 없어서(UIMessage에 createdAt 없음), 히스토리에 처음 나타나는
  // 시점을 그 메시지의 시각으로 기록해둔다 — 새로고침 전까지는 실제 전송 시각과 사실상 같다.
  useEffect(() => {
    setMsgTimestamps(prev => {
      let changed = false;
      const next = { ...prev };
      messages.forEach(m => {
        if (!(m.id in next)) { next[m.id] = Date.now(); changed = true; }
      });
      return changed ? next : prev;
    });
  }, [messages]);
  const isAgentGenerating = status === 'submitted' || status === 'streaming';
  const activeToolName = isAgentGenerating && lastMessage?.role === 'assistant'
    ? (lastMessage as any).toolInvocations?.slice(-1)[0]?.toolName
    : null;

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
    setQueryHistory([]);
    setActiveHistoryIndex(-1);
    setCompTableQuery('');
    setCompTableMutateLog([]);
    prevConditionsRef.current = false;
    pendingFetchRef.current = false;
    // 새 세션 시작 직전에 기준 추가 등으로 direct-update가 앞서있던 상태였다면, 그 플래그가 남아
    // 있으면 messages=[] 리셋을 "Comparison Table 패널" effect가 반영하지 못하고 옛 표가 남는다.
    directTableUpdateAheadRef.current = false;
  }, [setMessages]);

  // locale 변????localStorage + 쿠키????기??(API ??청 ????동 ??송??
  useEffect(() => {
    localStorage.setItem('gs_locale', locale);
    document.cookie = `gs_locale=${locale};path=/;max-age=86400`;
    document.documentElement.lang = locale;
  }, [locale]);

  // Reactive Option List ??Decision Criteria 변??감?? ????동 ??펙 보강
  // ---------------------------------------------------------------------------

  // Option List가 찾은 원본 값을 Comparison Table에도 그대로 넘겨서 같은 제품×기준을
  // 두 번 독립적으로 검색하지 않게 한다 (반환값은 이 요청의 생명주기 안에서만 쓰이고
  // 어디에도 저장되지 않음 — 세션 간에 공유되는 캐시가 아니다).
  const autoEnrichForCriteria = async (
    newCriteria: { name: string; min?: string }[],
    cards: any[]
  ): Promise<{ product_name: string; field_key: string; value: string | null }[]> => {
    if (cards.length === 0) return [];
    const productCategory = assignedItem === "A" ? "유모차" : assignedItem === "B" ? "로봇 청소기" : "카메라";
    const prefetched: { product_name: string; field_key: string; value: string | null }[] = [];
    try {
      // 기준이 여러 개여도 한 번의 요청으로 (제품 × 기준) 전체 조합을 조회한다 — 예전엔
      // 기준마다 순차적으로 요청을 보내서, 기준을 여러 개 한 번에 추가하면 Option List
      // 갱신 자체가 N번 직렬로 걸리고 Comparison Table은 그게 다 끝날 때까지 시작도
      // 못 했다. 요청을 하나로 합치면 이 N번 직렬 대기가 사라진다.
      setEnrichingCriterion(newCriteria.map((c) => c.name).join(", "));
      const res = await fetch("/api/auto-enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cards: cards.map((c: any) => ({ name: c.name, price: c.price, specs: c.specs ?? [] })),
          criteria: newCriteria.map((c) => c.name),
          category: productCategory,
          locale,
        }),
      });
      if (!res.ok) return prefetched;
      const { updates, unconfirmed, notFound } = await res.json() as {
        updates: { product_name: string; field_key: string; spec_phrase: string; value: string | null }[];
        unconfirmed: { product_name: string; field_key: string }[];
        notFound: { product_name: string; field_key: string }[];
      };

      updates?.forEach((u) => {
        if (u.value) prefetched.push({ product_name: u.product_name, field_key: u.field_key, value: u.value });
      });

      // 제품명 → 그 제품에 대해 unconfirmed/notFound인 기준명 집합. 응답 하나에 여러
      // 기준의 결과가 섞여 있으므로, 예전처럼 제품명만으로는 어떤 기준 얘기인지 구분이
      // 안 된다 — field_key까지 같이 묶어야 한다.
      const groupByProduct = (pairs: { product_name: string; field_key: string }[]) => {
        const map = new Map<string, Set<string>>();
        for (const { product_name, field_key } of pairs ?? []) {
          if (!map.has(product_name)) map.set(product_name, new Set());
          map.get(product_name)!.add(field_key);
        }
        return map;
      };
      const unconfirmedByProduct = groupByProduct(unconfirmed);
      const notFoundByProduct = groupByProduct(notFound);

      // 화면에 표시되는 카드 업데이트 함수 — 한 번의 배치 응답에 여러 기준의 결과가
      // 섞여 있을 수 있으므로, 카드 하나당 해당하는 업데이트를 전부 반영한다.
      const applyCardUpdates = (cardList: any[]) =>
        cardList.map((card: any) => {
          const cardUpdates = updates?.filter((u) => u.product_name === card.name) ?? [];
          const unconfirmedCrit = [...(unconfirmedByProduct.get(card.name) ?? [])];
          const notFoundCrit = [...(notFoundByProduct.get(card.name) ?? [])];

          if (cardUpdates.length > 0) {
            const specsCopy = [...(card.specs ?? [])];
            for (const update of cardUpdates) {
              const key = update.field_key.toLowerCase();
              const existingIdx = specsCopy.findIndex((s: string) => s.toLowerCase().includes(key));
              if (existingIdx !== -1) specsCopy[existingIdx] = update.spec_phrase;
              else specsCopy.unshift(update.spec_phrase);
            }
            return {
              ...card,
              specs: specsCopy,
              _unconfirmedCriteria: unconfirmedCrit.length > 0
                ? [...new Set([...(card._unconfirmedCriteria ?? []), ...unconfirmedCrit])]
                : (card._unconfirmedCriteria ?? []),
              _justUpdated: true,
            };
          }

          // 스펙 업데이트 없이 값 자체를 못 찾은 카드 — "정보 없음" 배지만 붙인다
          if (notFoundCrit.length > 0) {
            return {
              ...card,
              _notFoundCriteria: [...new Set([...(card._notFoundCriteria ?? []), ...notFoundCrit])],
              _justUpdated: false,
            };
          }

          if (card._justUpdated) {
            return { ...card, _justUpdated: false };
          }
          return card;
        });

      setProductCardListSpec((prev: any) => {
        if (!prev?.props?.cards) return prev;
        const updatedCards = applyCardUpdates(prev.props.cards);
        const next = { ...prev, props: { ...prev.props, cards: updatedCards } };
        productCardListSpecRef.current = next;
        return next;
      });

      setQueryHistory((prevHistory: any[]) =>
        prevHistory.map((entry: any) => {
          if (!entry?.spec?.props?.cards) return entry;
          const updatedCards = applyCardUpdates(entry.spec.props.cards);
          return { ...entry, spec: { ...entry.spec, props: { ...entry.spec.props, cards: updatedCards } } };
        })
      );
    } catch (err) {
      console.error("[autoEnrich] 오류:", err);
    } finally {
      setEnrichingCriterion(null);
    }
    return prefetched;
  };

  const updateComparisonTable = async (
    criteria: { name: string; min?: string }[],
    removedCriteriaNames: string[] = [],
    prefetchedValues: { product_name: string; field_key: string; value: string | null }[] = []
  ) => {
    const compTable = compTableSpecRef.current;
    if (!compTable?.props?.columns || compTable.props.columns.length <= 1) return;

    // columns[1]부터 제품명(label)
    const savedItems = compTable.props.columns.slice(1).map((col: any) => col.label);
    // 순위는 더 이상 중요도 가중치가 아니라 서버가 userContext를 보고 판단하므로,
    // 여기서는 기준명 + min(사용자가 명시한 기준)만 전달한다.
    const criteriaStrings = criteria.map(c => `${c.name}${c.min ? ` (기준: ${c.min})` : ''}`);

    console.log(`[update-table] 기준 변경 감지. 테이블 갱신 시작: ${savedItems.length}개 제품, ${criteriaStrings.length}개 기준 | ${criteriaStrings.join(', ')}`);

    const mySeq = ++updateTableSeqRef.current;
    setIsUpdatingTable(true);

    try {
      const res = await fetch("/api/update-table", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          savedItems,
          criteria: criteriaStrings,
          currentCards: productCardListSpecRef.current?.props?.cards ?? [],
          currentTableData: compTable,           // ← 기존 테이블 JSON 전송 (증분 업데이트용)
          currentRows: [], // do not lock to old rows; let LLM generate rows based on new criteria
          // 행 삭제는 오직 이 목록에 있는 기준에 대해서만 수행 (사용자가 실제로 제거한 기준).
          // criteria 문자열 재구성으로 유추하지 않음 — 서버 측 오탐 삭제 방지.
          removedCriteriaNames,
          category: assignedItem === "A" ? "유모차" : assignedItem === "B" ? "로봇 청소기" : "카메라",
          locale: locale,
          userContext, // 서버가 순위를 이 사용자의 구매 상황/목적 기준으로 판단하는 데 필요
          prefetchedValues, // Option List(auto-enrich)가 이번 기준 변경 사이클에서 이미 찾아둔 값 — 재검색 방지
        }),
      });

      if (!res.ok) {
        console.error("[update-table] API ??러:", await res.text());
        return;
      }

      const newSpec = await res.json();
      if (mySeq !== updateTableSeqRef.current) {
        console.log("[update-table] 낡은 응답 무시 (더 최신 요청이 이미 진행 중)");
        return;
      }
      if (newSpec && newSpec.props) {
        // 기존 ??이블의 ????지 URL 보존 (??션 리스??에????라????품????진 증발 방??)
        if (newSpec.props.columns && compTable?.props?.columns) {
          newSpec.props.columns.forEach((newCol: any) => {
            if (newCol.key.startsWith("prod_")) {
              const oldCol = compTable.props.columns.find((c: any) => c.label === newCol.label);
              if (oldCol && oldCol.imageUrl && !newCol.imageUrl) {
                newCol.imageUrl = oldCol.imageUrl;
              }
            }
          });
        }

        setCompTableSpec(newSpec);
        compTableSpecRef.current = newSpec;
        directTableUpdateAheadRef.current = true;
        console.log("[update-table] 갱신 ??료");
      }
    } catch (err) {
      console.error("[update-table] ??트??크/??싱 ??러:", err);
    } finally {
      setIsUpdatingTable(false);
    }
  };

  // \uc21c\uc704\ub294 \ub354 \uc774\uc0c1 \ud074\ub77c\uc774\uc5b8\ud2b8\uc5d0\uc11c \uc989\uc2dc \uc7ac\uacc4\uc0b0\ud558\uc9c0 \uc54a\ub294\ub2e4 \u2014 \uc2a4\ud399 \uc6b0\uc704\uac00 \uc544\ub2c8\ub77c \uc0ac\uc6a9\uc790\uc758
  // \uad6c\ub9e4 \uc0c1\ud669/\ubaa9\uc801\uc5d0 \uc5bc\ub9c8\ub098 \ubd80\ud569\ud558\ub294\uc9c0\ub97c \uc11c\ubc84(computeRankingAndReasoning)\uac00 LLM\uc73c\ub85c \ud310\ub2e8\ud558\uae30
  // \ub54c\ubb38\uc5d0, \uae30\uc900\uc774 \ubc14\ub00c\uba74 \ud56d\uc0c1 updateComparisonTable()\ub85c \uc11c\ubc84\ub97c \ub2e4\uc2dc \ud638\ucd9c\ud574\uc11c \ubc18\uc601\ud55c\ub2e4.
  useEffect(() => {
    const prev = prevDroppedCriteriaRef.current;
    const curr = droppedCriteria;

    // [1] 새로 추가된 기준 or min 값 변경
    const newCriteria = curr.filter(c => {
      const p = prev.find(prevC => prevC.name === c.name);
      if (!p) return true;
      if (p.min !== (c as any).min) return true;
      return false;
    });

    // 기?? ref ??데??트 (먼??)
    prevDroppedCriteriaRef.current = curr;

    // 기???????? ????????모든 카드????정 ??래??리셋
    if (curr.length === 0) {
      setProductCardListSpec((prev: any) => {
        if (!prev?.props?.cards) return prev;
        const resetCards = prev.props.cards.map((c: any) => ({ ...c, _unconfirmedCriteria: [], _notFoundCriteria: [] }));
        const next = { ...prev, props: { ...prev.props, cards: resetCards } };
        productCardListSpecRef.current = next;
        return next;
      });
      return;
    }

    // ??규모 기?? 교체 감?? (??사??30% 미만 + ??쪽 모두 2????상)
    const overlap = prev.filter((p) => curr.some((c) => c.name === p.name)).length;
    const similarity =
      prev.length > 0 && curr.length > 0
        ? overlap / Math.max(prev.length, curr.length)
        : 1;

    if (similarity < 0.3 && curr.length >= 2 && prev.length >= 2) {
      setCriteriaResetConfirm(true);
      return;
    }

    // [2] 새 기준 → Option List auto-enrich 먼저 끝내고, 그 결과를 Table 갱신에 그대로 넘긴다.
    // 예전엔 auto-enrich와 update-table이 서로를 모른 채 각자 독립적으로 Tavily 검색+judgeCell
    // 판단을 돌려서, 같은 제품×기준인데 두 패널의 값이 갈리는 문제가 있었다(검색 결과 변동성 때문).
    // 검색을 auto-enrich 쪽에서 한 번만 하고 그 결과를 update-table 요청에 실어 보내는 걸로 고쳤다
    // — 전역 캐시가 아니라 이 기준-변경 이벤트 하나의 흐름 안에서만 값을 공유하므로, 다른
    // 세션/참가자로 새어나가지 않는다.
    if (newCriteria.length > 0) {
      const currentCards = (productCardListSpecRef.current as any)?.props?.cards ?? [];
      console.log(`[auto-enrich] 신기준 감지: [${newCriteria.map(c => c.name).join(', ')}] | 카드 수 ${currentCards.length}`);
      if (currentCards.length > 0) {
        autoEnrichForCriteria(newCriteria, currentCards).then((prefetchedValues) => {
          updateComparisonTable(curr, [], prefetchedValues);
        });
      } else {
        console.log(`[auto-enrich] 카드 없음 — Option List가 아직 없음`);
        updateComparisonTable(curr);
      }
      return;
    }

    // 기준 추가가 아닌 제거뿐이면 Table은 건드리지 않는다 — Table 행은 기준과 1:1로
    // 대응하지 않으므로(청소기 높이/배터리 수명처럼 기준에 없는 스펙도 행으로 존재),
    // 기준 삭제만으로 서버를 다시 불러 테이블을 재생성하면 잠깐 행이 사라졌다가
    // 거의 동일한 내용으로 되돌아오는 깜빡임만 생긴다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedCriteria]);


  // locale 변??????전 번역??준비되????으??즉시 ??시, ??으??on-demand 번역
  const prevLocaleRef = useRef<'ko' | 'en'>(locale);
  useEffect(() => {
    if (prevLocaleRef.current === locale) return;
    prevLocaleRef.current = locale;

    // ??Cache hit: ??전 번역??결과가 ??으??즉시 ??시
    if (preTranslated?.locale === locale) {
      if (preTranslated.criteriaMap) setLocalizedCriteriaMap(preTranslated.criteriaMap);
      if (preTranslated.conceptCards) setLocalizedConceptCards(preTranslated.conceptCards);
      if (preTranslated.compTable) { setCompTableSpec(preTranslated.compTable); compTableSpecRef.current = preTranslated.compTable; }
      if (preTranslated.productCardList) setProductCardListSpec(preTranslated.productCardList);
      if (preTranslated.uncharted) setUnchartedSpec(preTranslated.uncharted);
      if (preTranslated.tradeoffs) setTradeoffSpecs(prev => ({ ...prev, ...preTranslated.tradeoffs }));
      if (preTranslated.droppedItems) setDroppedItems(preTranslated.droppedItems);
      if (preTranslated.queryHistory) setQueryHistory(preTranslated.queryHistory);
      // The cache snapshot was taken when streaming last ended — anything added afterward
      // (e.g. an item saved to My Options after the search finished) isn't in it. Only skip
      // the on-demand fallback below when the cache actually covers everything currently on screen.
      const cacheMissedDroppedItems = droppedItems.length > 0 && !preTranslated.droppedItems;
      const cacheMissedQueryHistory = queryHistory.some((entry) => entry?.spec) && !preTranslated.queryHistory;
      setPreTranslated(null); // ??용 ????리
      if (!cacheMissedDroppedItems && !cacheMissedQueryHistory) return;
    }

    // ??Cache miss: on-demand 번역 (fallback)
    const runTranslation = async () => {
      setIsTranslating(true);
      try {
        const specsToTranslate: Record<string, any> = {};
        if (sidebarSpec.CriteriaMap) specsToTranslate['criteriaMap'] = sidebarSpec.CriteriaMap;
        sidebarSpec.conceptCards.forEach((card: any, i: number) => {
          specsToTranslate[`card_${i}`] = { type: 'InformationCard', props: card };
        });
        if (compTableSpec) specsToTranslate['compTable'] = compTableSpec;
        if (productCardListSpec) specsToTranslate['productCardList'] = productCardListSpec;
        if (unchartedSpec) specsToTranslate['uncharted'] = { type: 'UnchartedTerritoryChip', props: unchartedSpec };
        Object.entries(tradeoffSpecs).forEach(([key, spec]) => {
          specsToTranslate[`tradeoff_${key}`] = spec;
        });
        if (droppedItems.length > 0) specsToTranslate['droppedItems'] = { type: 'ProductCardList', props: { cards: droppedItems } };
        // renderOptionList() prefers queryHistory[activeHistoryIndex].spec over productCardListSpec,
        // so the per-turn history snapshots need their own translation pass too — otherwise the
        // panel keeps showing the untranslated turn snapshot even after productCardListSpec updates.
        queryHistory.forEach((entry, i) => {
          if (entry?.spec) specsToTranslate[`qh_${i}`] = entry.spec;
        });

        if (Object.keys(specsToTranslate).length === 0) return;

        const res = await fetch('/api/translate-spec', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ specs: specsToTranslate, targetLocale: locale }),
        });
        if (!res.ok) return;
        const result: Record<string, any> = await res.json();

        if (result.criteriaMap) setLocalizedCriteriaMap(result.criteriaMap);
        const translatedCards = sidebarSpec.conceptCards
          .map((_: any, i: number) => result[`card_${i}`]?.props)
          .filter(Boolean);
        if (translatedCards.length > 0) setLocalizedConceptCards(translatedCards);
        if (result.compTable) { setCompTableSpec(result.compTable); compTableSpecRef.current = result.compTable; }
        if (result.productCardList) setProductCardListSpec(result.productCardList);
        if (result.uncharted?.props?.labels) setUnchartedSpec({ labels: result.uncharted.props.labels });
        const translatedTradeoffs: Record<string, any> = {};
        Object.keys(tradeoffSpecs).forEach(key => {
          if (result[`tradeoff_${key}`]) translatedTradeoffs[key] = result[`tradeoff_${key}`];
        });
        if (Object.keys(translatedTradeoffs).length > 0) setTradeoffSpecs(prev => ({ ...prev, ...translatedTradeoffs }));
        if (result.droppedItems?.props?.cards) setDroppedItems(result.droppedItems.props.cards);
        if (queryHistory.some((entry) => entry?.spec)) {
          setQueryHistory((prev) => prev.map((entry, i) => (result[`qh_${i}`] ? { ...entry, spec: result[`qh_${i}`] } : entry)));
        }
      } finally {
        setIsTranslating(false);
      }
    };

    void runTranslation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  // ??AI ??답????면 localized override??초기??(최신 AI ??성 spec????선??
  const prevMessagesLengthRef = useRef(0);
  useEffect(() => {
    if (messages.length > prevMessagesLengthRef.current) {
      setLocalizedCriteriaMap(null);
      setLocalizedConceptCards(null);
    }
    prevMessagesLengthRef.current = messages.length;
  }, [messages.length]);

  // ??션 ??태 localStorage ??동 ????
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

  // ??트리밍 ??료 ??반?? locale??백그??운????전 번역 (locale ??환 ??즉시 ??시????해)
  const prevIsStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;

    // ??트리밍????난 직후(true ??false)??만 ??행
    if (!wasStreaming || isStreaming) return;

    const oppositeLocale = locale === 'ko' ? 'en' : 'ko';
    const specsToTranslate: Record<string, any> = {};

    if (sidebarSpec.CriteriaMap) specsToTranslate['criteriaMap'] = sidebarSpec.CriteriaMap;
    sidebarSpec.conceptCards.forEach((card: any, i: number) => {
      specsToTranslate[`card_${i}`] = { type: 'InformationCard', props: card };
    });
    if (compTableSpec) specsToTranslate['compTable'] = compTableSpec;
    if (productCardListSpec) specsToTranslate['productCardList'] = productCardListSpec;
    if (unchartedSpec) specsToTranslate['uncharted'] = { type: 'UnchartedTerritoryChip', props: unchartedSpec };
    Object.entries(tradeoffSpecs).forEach(([key, spec]) => {
      specsToTranslate[`tradeoff_${key}`] = spec;
    });
    if (droppedItems.length > 0) specsToTranslate['droppedItems'] = { type: 'ProductCardList', props: { cards: droppedItems } };
    queryHistory.forEach((entry, i) => {
      if (entry?.spec) specsToTranslate[`qh_${i}`] = entry.spec;
    });

    if (Object.keys(specsToTranslate).length === 0) return;
    if (isPreTranslatingRef.current) return;

    isPreTranslatingRef.current = true;
    fetch('/api/translate-spec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specs: specsToTranslate, targetLocale: oppositeLocale }),
    })
      .then(r => r.ok ? r.json() : null)
      .then((result: Record<string, any> | null) => {
        if (!result) return;
        const translatedCards = sidebarSpec.conceptCards
          .map((_: any, i: number) => result[`card_${i}`]?.props)
          .filter(Boolean);
        const translatedTradeoffs: Record<string, any> = {};
        Object.keys(tradeoffSpecs).forEach(key => {
          if (result[`tradeoff_${key}`]) translatedTradeoffs[key] = result[`tradeoff_${key}`];
        });
        const translatedQueryHistory = queryHistory.some((entry) => entry?.spec)
          ? queryHistory.map((entry, i) => (result[`qh_${i}`] ? { ...entry, spec: result[`qh_${i}`] } : entry))
          : undefined;
        setPreTranslated({
          locale: oppositeLocale,
          criteriaMap: result.criteriaMap,
          conceptCards: translatedCards.length > 0 ? translatedCards : undefined,
          compTable: result.compTable,
          productCardList: result.productCardList,
          uncharted: result.uncharted?.props?.labels ? { labels: result.uncharted.props.labels } : undefined,
          tradeoffs: Object.keys(translatedTradeoffs).length > 0 ? translatedTradeoffs : undefined,
          droppedItems: result.droppedItems?.props?.cards,
          queryHistory: translatedQueryHistory,
        });
        console.log(`[Pre-translation] ${oppositeLocale} 번역 완료 -> locale 전환 후 즉시 사용 가능`);
      })
      .catch(() => { })
      .finally(() => { isPreTranslatingRef.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

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
    if (!showHistoryDrawer) return;
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setShowHistoryDrawer(false); };
    document.addEventListener("keydown", handleKeyDown);
    const body = historyDrawerBodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showHistoryDrawer]);

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

      // ???? Criteria-only ??출 + 카드 존재 ????이??트 불필?? auto-enrich가 처리
      // (기?? ????릭 ????메시지????출??는 경우)
      const isPureCriteriaSubmit = !message.trim() && searchCriteria.length > 0 && mentionChips.length === 0;
      const hasOptionListCards = Array.isArray((productCardListSpec as any)?.props?.cards)
        && (productCardListSpec as any).props.cards.length > 0;
      if (isPureCriteriaSubmit && hasOptionListCards) {
        setSearchCriteria([]); // ??력 ??초기??
        return; // ??이??트 ??출 ??이 종료 ??useEffect auto-enrich가 ???? 처리 ??
      }

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
        ? `\n\n[DECISION CRITERIA: ${droppedCriteria.map((c: any) =>
          `${c.name}${c.min ? ` (기준: ${c.min})` : ''}`
        ).join(', ')}]`
        : '';

      const userContextTag = userContext.trim()
        ? `\n\n[USER CONTEXT: ${userContext.trim()}]`
        : "";

      const assignedItemTag = assignedItem
        ? `\n\n[ASSIGNED ITEM: ${assignedItem}]`
        : "";

      // 참가자별 공유 메모리(session-memory.ts) 키로 서버가 사용 — 대화가 휘발되지 않고
      // 참가자 단위로 이어지게 하려면 매 요청에 실어 보내야 한다.
      const participantIdTag = participantId.trim()
        ? `\n\n[PARTICIPANT ID: ${participantId.trim()}]`
        : "";

      // 현재 Option List 카드 목록 주입 — mutateSurface 판단에 필요 (가격/스펙 파싱은 route.ts 정규식과 일치해야 함)
      // productCardListSpec을 직접 쓰면 mutateSurface(add/filter/sort) 변경분이 다음 턴에서 사라질 수
      // 있어서(위 activeOptionListCardsRef 주석 참고), 보호된 ref를 우선 사용한다.
      const currentCards = activeOptionListCardsRef.current ?? productCardListSpec?.props?.cards;
      const currentOptionListSearchQuery = activeOptionListSearchQueryRef.current ?? productCardListSpec?._searchQuery ?? '';
      // ComparisonTable/CriteriaMap과 동일하게 JSON으로 왕복 — id를 실어 보내야 Edit Agent가
      // 이름 대신 id로 카드를 정확히 지목할 수 있다(route.ts의 JSON.parse와 형태를 맞출 것).
      // cards 배열이 아니라 {cards, searchQuery} 객체로 감싸서, 원래 검색 제약도 같이 왕복시킨다.
      const currentOptionListTag = Array.isArray(currentCards) && currentCards.length > 0
        ? `\n\n[CURRENT_OPTION_LIST]\n${JSON.stringify({
          cards: currentCards.map((c: any) => ({
            id: c.id,
            name: c.name,
            price: c.price ?? '',
            specs: c.specs ?? [],
          })),
          searchQuery: currentOptionListSearchQuery,
        })}`
        : "";

      // ??재 ComparisonTable??전체 spec(columns+rows) 주입 ??Edit Agent가 어떤 기준??있는지 판단?????
      // executor(mutateComparisonTable)가 기존 셀 값을 보존??채 행을 추가/삭제??????있게 ??체 spec????송??다.
      // CURRENT_CRITERIA_MAP??항상 마지막에 붙는 태그이므로(끝까지 캡처하는 정규식), 그보다 먼저 삽입한다.
      const currentTable = compTableSpecRef.current;
      const currentComparisonTableTag = currentTable?.props?.rows?.length > 0
        ? `\n\n[CURRENT_COMPARISON_TABLE]\n${JSON.stringify({ type: currentTable.type ?? "Table", props: currentTable.props })}`
        : "";

      // ??재 CriteriaMap??라벨/칩 ??입 ??Agent가 ??전 Turn??서 만????벨/칩????억??서 중복 ??성????피??도??
      const existingCategories = criteriaMapRef.current?.props?.categories;
      const currentCriteriaMapTag = Array.isArray(existingCategories) && existingCategories.length > 0
        ? `\n\n[CURRENT_CRITERIA_MAP]\n${JSON.stringify(existingCategories.map((c: any) => ({
          id: c.id,
          label: c.label,
          items: (c.items ?? []).map((i: any) => ({ id: i.id, name: i.name })),
        })))}`
        : "";

      setSearchCriteria([]);
      setMentionChips([]);
      await sendMessage({ text: visibleCriteria + mentionPrefix + message.trim() + criteriaContext + savedCriteriaContext + cartContext + userContextTag + assignedItemTag + participantIdTag + currentOptionListTag + currentComparisonTableTag + currentCriteriaMapTag });
    },
    [input, isStreaming, sendMessage, droppedItems, droppedCriteria, searchCriteria, mentionChips, userContext, productCardListSpec, participantId],
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

  // 연구 로그 — participantId 없으면(온보딩 전) 조용히 스킵, 실패해도 UI 흐름에 영향 없음(fire-and-forget).
  const logEvent = useCallback((payload: Record<string, any>) => {
    if (!participantId.trim()) return;
    fetch('/api/log-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId: participantId.trim(), ...payload }),
    }).catch((err) => console.error('[logEvent] failed:', err));
  }, [participantId]);

  const handleAddItem = useCallback((name: string, image?: string, price?: string, description?: string, specs?: string[], link?: string) => {
    if (name && !droppedItems.some(item => item.name === name)) {
      setDroppedItems((prev) => [...prev, { name, image, price, description, specs, link }]);
      setRightPanelCollapsed(false);
      logEvent({ type: 'option_event', op: 'add', optionName: name, turnIndex: messages.length });
    }
  }, [droppedItems, logEvent, messages.length]);

  const handleRemoveItem = useCallback((name: string) => {
    setDroppedItems((prev) => prev.filter(item => item.name !== name));
    logEvent({ type: 'option_event', op: 'remove', optionName: name, turnIndex: messages.length });
  }, [logEvent, messages.length]);

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

      const updatePrompt = `[SYSTEM: CUMULATIVE COMPARISON] ${products.join(", ")} ??품??을 ??Table) 컴포??트????용??서 ??세??비교??줘. ??전????급????용????다????께 ??함??서 ??시 ???? 그려?? (IMPORTANT: Use your existing knowledge for products already mentioned. Do not perform a web search for them again. Just generate the updated table immediately.)`;

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
      // Path 1a: toolInvocations ??populated after stream completes
      ((m as any).toolInvocations ?? []).forEach((ti: any) => {
        if (ti.toolName === "renderToSidebar" || ti.toolName === "sidePanel" || ti.toolName === "renderToExplorationJourney") {
          const res = ti.result || (ti as any).args?.spec;
          if (res) specs.push(res);
        }
      });

      // Path 1b: parts-based tool-result ??reliable fallback for turn 1
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

      // Path 2: data-spec parts ??injected by route.ts after stream ends (authoritative)
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
                const idx = existingItems.findIndex((i: any) => i.name === item.name);
                if (idx === -1) {
                  existingItems.push(item);
                } else {
                  // Update existing item — id는 최초 배정된 값을 유지(재생성마다 새로 스탬핑된
                  // item.id로 덮어쓰면 Edit Agent가 이전 턴에 기억한 id가 다음 턴에 어긋난다).
                  existingItems[idx] = { ...existingItems[idx], ...item, id: existingItems[idx].id };
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
            const label = turn.summary || `????${turn.turn}`;
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

        // CriteriaMapRemoval: mutateCriteriaMap(remove_item)이 내보내는 삭제 지시.
        // 위 CriteriaMap 병합 분기와 달리 누적된 categories에서 항목을 걸러낸다.
        // 항목이 하나도 안 남으면 카테고리 자체를 제거한다(빈 카테고리가 "미탐색" 칩으로 오인되는 것 방지).
      } else if (effectiveSpec.type === "CriteriaMapRemoval") {
        // category_label/item_names는 id를 담아 오는 게 기본이지만(Edit Agent가 current_criteriaMap의
        // id를 복사해 돌려줌), id가 없던 구형 상태 등 대비로 라벨/이름 매칭도 계속 지원한다.
        const categoryRef: string = effectiveSpec.props?.category_label ?? "";
        const itemRefsToRemove: string[] = Array.isArray(effectiveSpec.props?.item_names) ? effectiveSpec.props.item_names : [];
        const merged: any[] = latestCriteriaMapSpec?.props?.categories ?? [];
        const catIdx = merged.findIndex((c: any) => c.id === categoryRef || c.label === categoryRef);
        if (catIdx > -1 && itemRefsToRemove.length > 0) {
          const toRemove = new Set(itemRefsToRemove);
          const remaining = (merged[catIdx].items ?? []).filter((i: any) => !toRemove.has(i.id) && !toRemove.has(i.name));
          if (remaining.length > 0) {
            merged[catIdx] = { ...merged[catIdx], items: remaining };
          } else {
            merged.splice(catIdx, 1);
          }
          latestCriteriaMapSpec = { type: "CriteriaMap", props: { categories: merged } };
        }
      } else {
        latestOtherSpec = spec;
      }
    });

    return { CriteriaMap: latestCriteriaMapSpec, conceptCards };
  }, [allSpecs]);
  // ??다??ref ??기??매 렌더마다 최신값 ??지 (useEffect보다 ??전, dependency 불필??
  criteriaMapRef.current = sidebarSpec.CriteriaMap;

  // ??시????신????기??(Decision Criteria ??널)
  useEffect(() => {
    if (!sidebarSpec.CriteriaMap || !sidebarSpec.CriteriaMap.props?.categories) return;

    // AI 최신 CriteriaMap??서 { 기???? ??신??} ??구축
    const latestConfidenceMap = new Map<string, string>();
    sidebarSpec.CriteriaMap.props.categories.forEach((cat: any) => {
      cat.items?.forEach((item: any) => {
        if (item.name && item.confidence) {
          latestConfidenceMap.set(item.name, item.confidence);
        }
      });
    });

    // droppedCriteria?????? ??어??는 ????????다?? 최신 ??신??로 ??데??트
    setDroppedCriteria((prev) => {
      let changed = false;
      const next = prev.map((crit) => {
        const latestConf = latestConfidenceMap.get(crit.name);
        if (latestConf && (crit as any).confidence !== latestConf) {
          changed = true;
          return { ...crit, confidence: latestConf };
        }
        return crit;
      });
      return changed ? next : prev;
    });
  }, [sidebarSpec.CriteriaMap]);

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
      // New InformationCard added ??switch to information
      setJourneyTab("information");
    } else if (newCriteriaKey && newCriteriaKey !== prevCriteriaMapKey.current) {
      // CriteriaMap updated ??switch to criteria
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

  // 비교????성 ??수 (비교가 반복????마??UnchartedTerritory ??실??감????
  const compTableCount = useMemo(() => messages.reduce((count, m) => {
    const hasPart = (m.parts ?? []).some((p: any) => p.type === 'data-comp-table-spec');
    const hasTool = ((m as any).toolInvocations ?? []).some((ti: any) =>
      (ti.toolName === 'renderInChat' || ti.toolName === 'renderToCompTable') && ti.args?.ui_intent_category === '2'
    );
    return count + (hasPart || hasTool ? 1 : 0);
  }, 0), [messages]);

  // UnchartedTerritoryChip: ??조건??맞물????마??trigger (비교가 반복????마????실?? Empty 반환 ????연 종료)
  useEffect(() => {
    const allConditionsMet =
      hasComparison && droppedItems.length > 0 && droppedCriteria.length > 0;

    const wasAllMet = prevConditionsRef.current;
    prevConditionsRef.current = allConditionsMet;

    const compTableIncreased = compTableCount > prevCompTableCountRef.current;
    prevCompTableCountRef.current = compTableCount;

    // 조건??최초 충족??거?? ???? 충족????태??서 비교가 ??로 ??행??경우 fetch ??약
    if (allConditionsMet && (!wasAllMet || compTableIncreased)) {
      pendingFetchRef.current = true;
    }

    // 조건 불충????pending 취소 (칩?? ????)
    if (!allConditionsMet) {
      pendingFetchRef.current = false;
      return;
    }

    // ??트리밍 중이??????(pending?? ????)
    if (isStreaming) return;

    // pending????으????행 ????
    if (!pendingFetchRef.current) return;
    pendingFetchRef.current = false;

    let isMounted = true;

    const fetchUncharted = async () => {
      try {
        const productCategory = assignedItem === "A" ? "유모차" : assignedItem === "B" ? "로봇 청소기" : "카메라";
        const categories: any[] = sidebarSpec.CriteriaMap?.props?.categories ?? [];
        const existingLabels = categories.map((c: any) => c.label as string).filter(Boolean);
        // label만 보내면 그 밑에 이미 있는 item("배터리 수명" 등)을 모델이 몰라서
        // item을 새로운 label로 잘못 승격시켜 다시 제안해버린다 — item 이름도 함께 보낸다.
        const existingItems = categories.flatMap((c: any) =>
          (c.items ?? []).map((i: any) => i.name as string)
        ).filter(Boolean);
        const criteriaNames = droppedCriteria.map(c => c.name);

        // ???? 칩으????안??labels??Claude??게 ??려????로????역????안??게 ??
        const alreadySuggested: string[] = [];
        setUnchartedSpec(prev => { if (prev) alreadySuggested.push(...prev.labels); return prev; });

        const res = await fetch("/api/unexplored-areas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            existingCategories: existingLabels,
            existingItems,
            productCategory,
            droppedCriteria: criteriaNames,
            alreadySuggested,
          }),
        });

        if (!isMounted) return;

        if (res.ok) {
          const data = await res.json();
          if (data.labels && data.labels.length > 0) {
            startTransition(() => {
              setUnchartedSpec(prev => {
                if (!prev) return { labels: data.labels };
                // 기존 labels에 새 labels 병합 (중복 제거)
                const existingSet = new Set(prev.labels);
                const merged = [...prev.labels, ...data.labels.filter((l: string) => !existingSet.has(l))];
                return { labels: merged };
              });
            });
            logEvent({
              type: 'feature_event',
              feature: 'uncharted_territory',
              event: 'shown',
              payload: { labels: data.labels },
              turnIndex: messages.length,
            });
          }
          // Empty 반환 ??????칩을 만들지 ??음. 기존 칩?? 그????????.
        }
      } catch (err) {
        console.error("[fetchUncharted] Error:", err);
      }
    };

    fetchUncharted();
    return () => { isMounted = false; };
  }, [hasComparison, droppedItems.length, droppedCriteria.length, compTableCount, isStreaming, assignedItem]);


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
      // [??시 비활??화] ??이??이??기능 충돌????한 ??거
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

  // 조율 ????받기 ????레??드??프 충돌 기????????AI??게 ??????청
  const handleResolveTradeoff = useCallback(async (newCriterion: string, conflictsWith: string) => {
    const prompt = `"${newCriterion}"?? "${conflictsWith}" ??이??균형 ??을 ????는 방법????려주세??`;
    const userContextTag = userContext.trim() ? `\n\n[USER CONTEXT: ${userContext.trim()}]` : '';
    await sendMessage({ text: prompt + userContextTag });
  }, [sendMessage, userContext]);
  // Called whenever a new criterion is added ??asks UI Agent (cat.5) for TradeoffHint spec
  const checkTradeoff = async (
    newCriterion: { name: string; important?: boolean },
    existingCriteria: { name: string; important?: boolean }[]
  ) => {
    if (existingCriteria.length === 0) return;
    setTradeoffLoading(prev => new Set([...prev, newCriterion.name]));
    try {
      const productCategory = assignedItem === "A" ? "유모차" : assignedItem === "B" ? "로봇 청소기" : assignedItem === "C" ? "카메라" : "카메라";
      const res = await fetch("/api/check-tradeoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ existingCriteria, newCriterion, productCategory, userContext }),
      });
      const spec = await res.json();
      setTradeoffSpecs(prev => ({ ...prev, [newCriterion.name]: spec }));
      if (spec?.type === "TradeoffHint") {
        setRightPanelCollapsed(false);
        logEvent({
          type: 'feature_event',
          feature: 'tradeoff_hint',
          event: 'shown',
          payload: { newCriterion: newCriterion.name, conflictsWith: spec?.props?.conflictsWith ?? null },
          turnIndex: messages.length,
        });
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
        logEvent({ type: 'criteria_event', op: 'remove', criterionName: item.name, turnIndex: messages.length });
      } else {
        const existingCriteria = droppedCriteria.map((c) => ({ name: c.name, important: !!c.important }));
        setDroppedCriteria((prev) => [...prev, {
          name: item.name,
          min: item.min,
          priority: item.priority || "medium",
          important: !!item.important,
          confidence: (item as any).confidence,
        } as any]);
        checkTradeoff({ name: item.name, important: !!item.important }, existingCriteria);
        setRightPanelCollapsed(false);
        logEvent({ type: 'criteria_event', op: 'add', criterionName: item.name, turnIndex: messages.length });
        if (unchartedSpec?.labels.includes(item.name)) {
          logEvent({ type: 'feature_event', feature: 'uncharted_territory', event: 'adopted', payload: { label: item.name }, turnIndex: messages.length });
        }
      }
    },
    onDragStartCriteria: () => {
      setRightPanelCollapsed(false);
    },
    locale,
  }), [scrollToTurn, handleSubmit, droppedCriteria, locale, logEvent, messages.length, unchartedSpec]);

  const bubbleBindings = useMemo(() => ({
    onItemAdd: handleAddItem,
    onItemRemove: handleRemoveItem,
    onCompareRequested: handleCompare,
    savedItems: droppedItems,
    droppedCriteria: droppedCriteria,
    userContext,
    locale,
    onRequestCriteriaData: (criteriaName: string, products: string[]) => {
      handleSubmit(locale === 'en'
        ? `Please redo the comparison table for ${products.join(', ')}, including the "${criteriaName}" value.`
        : `지금 비교 중인 ${products.join(', ')} 제품의 "${criteriaName}" 관련 값을 포함해서 비교표를 다시 만들어줘.`);
    },
    onAddMyItemsToTable: (currentProducts: string[], newItems: string[]) => {
      const all = [...currentProducts, ...newItems].join(', ');
      handleSubmit(locale === 'en'
        ? `Please compare ${all} — keep all previous comparison criteria and include the newly added products.`
        : `${all} 제품을 비교해줘. 이전 비교 기준은 모두 유지하면서 새로 추가된 제품도 포함해서 비교표를 다시 만들어줘.`);
    },
  }), [handleAddItem, handleRemoveItem, handleCompare, droppedItems, droppedCriteria, userContext, handleSubmit, locale]);

  // Comparison Table ??널: data-comp-table-spec ??트????트??서 최신 spec 추출
  useEffect(() => {
    let latestSpec: any = null;
    // 이력 배너(질문 + mutate 꼬리 질문)를 구성하기 위해 등장 순서대로도 함께 모아둔다.
    const compTableOccurrences: { msgId: string; data: any }[] = [];
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      for (const part of (msg.parts ?? []) as any[]) {
        if ((part as any).type === 'data-comp-table-spec' && (part as any).data) {
          latestSpec = (part as any).data;
          compTableOccurrences.push({ msgId: msg.id, data: latestSpec });
        }
      }
    }

    // renderToCompTable(채팅 도구)는 매번 처음부터 테이블을 새로 빌드하기 때문에,
    // 그 턴에 백엔드가 파싱한 기준 목록이 (분류 오류 등으로) 불완전하면 여전히
    // 활성 상태인 기준의 행이 통째로 사라질 수 있다. 여기서 되돌아오는 스펙을
    // 무조건 덮어쓰지 않고, "현재도 Decision Criteria 칩에 남아있는데 새 스펙에는
    // 없는 행"을 이전 테이블에서 복구해 병합한다 — 행 삭제는 칩을 실제로 뺐을 때만 일어나야 함.
    // mutateComparisonTable 결과는 이미 정확히 패치된 최종 상태이므로(예: remove_criteria로
    // 의도적으로 지운 행), 아래 "활성 기준 행 복구" 안전장치를 적용하면 안 된다 — 그건
    // renderToCompTable의 재생성이 실수로 행을 누락시켰을 때만을 위한 것이다.
    const prevSpec = compTableSpecRef.current;
    if (!latestSpec?.props?._isMutateResult && latestSpec?.props?.rows && prevSpec?.props?.rows) {
      const norm = (s: string) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
      const activeCriteriaNorm = latestDroppedCriteriaRef.current.map(c => norm(c.name)).filter(Boolean);
      const newRows: any[] = latestSpec.props.rows;
      const newRowCriteriaNorm = new Set(newRows.map(r => norm(r.criterion)));

      const missingActiveRows = (prevSpec.props.rows as any[]).filter((r) => {
        if (r.criterion === '순위' || r.criterion === 'Rank') return false;
        const rn = norm(r.criterion);
        if (!rn || newRowCriteriaNorm.has(rn)) return false; // 새 스펙에 이미 있음
        return activeCriteriaNorm.some((cn) => rn === cn || rn.includes(cn) || cn.includes(rn));
      });

      if (missingActiveRows.length > 0) {
        console.warn('[comp-table] 새 스펙에서 누락된 활성 기준 행 복구:', missingActiveRows.map((r: any) => r.criterion));
        const rankIdx = newRows.findIndex((r) => r.criterion === '순위' || r.criterion === 'Rank');
        const mergedRows = [...newRows];
        mergedRows.splice(rankIdx === -1 ? mergedRows.length : rankIdx + 1, 0, ...missingActiveRows);
        latestSpec = { ...latestSpec, props: { ...latestSpec.props, rows: mergedRows } };
      }
    }

    // 이번 턴에 채팅이 실제로 비교표를 새로 만들거나 수정했는지(occurrence 수 증가)를 봐서,
    // 그런 이벤트가 없었는데 화면이 updateComparisonTable()의 직접 갱신으로 이미 앞서있는 상태라면
    // (예: 기준 추가 직후 곧바로 반영된 표) messages에서 재추출한 옛 스펙으로 덮어쓰지 않는다 —
    // 안 그러면 비교표와 무관한 채팅 한 번에도 "이렇게 추천드린 이유에요" 등이 예전 내용으로 되돌아간다.
    const isNewChatDrivenTableEvent = compTableOccurrences.length > prevCompTableOccurrenceCountRef.current;
    prevCompTableOccurrenceCountRef.current = compTableOccurrences.length;

    if (isNewChatDrivenTableEvent) {
      directTableUpdateAheadRef.current = false;
      setCompTableSpec(latestSpec);
      compTableSpecRef.current = latestSpec;
    } else if (!directTableUpdateAheadRef.current) {
      setCompTableSpec(latestSpec);
      compTableSpecRef.current = latestSpec;
    }

    // 이력 배너: 가장 최근 "새 생성"(renderToCompTable, non-mutate) 지점을 찾아 그 직전 사용자
    // 질문을 표 제목으로 쓰고, 그 뒤로 이어진 mutateComparisonTable 호출들을 꼬리 질문으로 기록한다.
    const extractUserQueryBefore = (msgId: string): string => {
      const idx = messages.findIndex(m => m.id === msgId);
      if (idx === -1) return '';
      for (let i = idx - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'user') continue;
        const rawText = ((m.parts ?? []) as any[])
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text as string)
          .join('');
        return rawText
          .replace(/\|https?:\/\/[^\s,\]]+/g, '')
          .replace(/^\[Decision Criteria\s*:([^\]]*)\]\s*/i, '"$1" ')
          .replace(/^\[My items\s*:([^\]]*)\]\s*/i, '"$1" ')
          .split(/\n{1,2}\[CONTEXT:/i)[0]
          .split(/\n{1,2}\[DECISION CRITERIA:/i)[0]
          .split(/\n{1,2}\[USER CONTEXT:/i)[0]
          .split(/\n{1,2}\[ASSIGNED ITEM:/i)[0]
          .trim();
      }
      return '';
    };

    if (compTableOccurrences.length === 0) {
      setCompTableQuery('');
      setCompTableMutateLog([]);
    } else {
      let lastFreshIdx = -1;
      for (let i = compTableOccurrences.length - 1; i >= 0; i--) {
        if (!compTableOccurrences[i].data?.props?._isMutateResult) { lastFreshIdx = i; break; }
      }
      if (lastFreshIdx !== -1) {
        setCompTableQuery(extractUserQueryBefore(compTableOccurrences[lastFreshIdx].msgId));
        setCompTableMutateLog(
          compTableOccurrences
            .slice(lastFreshIdx + 1)
            .filter(o => o.data?.props?._isMutateResult && o.data?.props?._lastMutateOpSummary)
            .map(o => ({
              id: o.msgId,
              summary: o.data.props._lastMutateOpSummary,
              op: o.data.props._lastMutateOp ?? '',
              userQuery: extractUserQueryBefore(o.msgId) || undefined,
            }))
        );
      }
    }
    // droppedCriteria는 latestDroppedCriteriaRef로 읽는다 — 의존성에 넣으면 기준 추가/삭제만으로
    // 이 effect가 재실행되어 messages에서 재추출한 스펙으로 compTableSpec을 덮어써버린다
    // (updateComparisonTable의 직접 setCompTableSpec 결과가 유실되는 원인이었다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Option List ??널: turn별로 분리??카드 추적 (??스??리 ??비게이??용)
  useEffect(() => {
    let accumulatedCards: any[] = [];
    let latestSpecBase: any = null;
    let latestCoverageNotice: any = null;
    // 이름이 같은 카드가 재생성돼도 최초 배정된 id를 유지한다 — renderToOptionList는 매 턴
    // LLM이 새 id를 스탬핑하므로(백엔드에서 항상 덮어씀), 그대로 넣으면 같은 제품이 턴마다
    // 다른 id를 갖게 돼 Edit Agent가 이전 턴에 기억한 id가 어긋난다.
    const mergeCardPreservingId = (list: any[], newCard: any) => {
      const idx = list.findIndex((c: any) => c.name === newCard.name);
      if (idx === -1) list.unshift(newCard);
      else list[idx] = { ...newCard, id: list[idx].id ?? newCard.id };
    };
    let latestRagNotFound: any = null;

    type TurnData = { userQuery: string; specBase: any; cards: any[]; };
    const turns: TurnData[] = [];
    let pendingUserQuery = '';
    // [Decision Criteria : ...] 태그는 검색창에 기준 칩을 직접 끌어다 놓았을 때만 붙는다
    // (사이드패널에 저장된 기준 목록 태그 [DECISION CRITERIA: ...]와는 별개) — 이 명시적
    // 제스처일 때만 새 페이지를 만들고, 그 외(예: mutate로 이어진 요청)는 현재 페이지를 갱신한다.
    let pendingIsExplicitSearch = false;

    for (const msg of messages) {
      if (msg.role === 'user') {
        const rawText = ((msg.parts ?? []) as any[])
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text as string)
          .join('');
        let q = rawText
          .replace(/\|https?:\/\/[^\s,\]]+/g, '')
          .replace(/^\[Decision Criteria\s*:([^\]]*)\]\s*/i, '"$1" ')
          .replace(/^\[My items\s*:([^\]]*)\]\s*/i, '"$1" ')
          .split(/\n{1,2}\[CONTEXT:/i)[0]
          .split(/\n{1,2}\[DECISION CRITERIA:/i)[0]
          .split(/\n{1,2}\[USER CONTEXT:/i)[0]
          .split(/\n{1,2}\[ASSIGNED ITEM:/i)[0]
          .trim();
        pendingUserQuery = q || '검색';
        pendingIsExplicitSearch = /^\[Decision Criteria\s*:/i.test(rawText);
        continue;
      }
      if (msg.role !== 'assistant') continue;

      let turnSpecBase: any = null;
      const turnCards: any[] = [];

      // 1??위: data-option-list-spec ??트????트
      for (const part of (msg.parts ?? []) as any[]) {
        if ((part as any).type === 'data-option-list-spec' && (part as any).data) {
          const spec = (part as any).data;
          console.log('[OptionList] data-option-list-spec part found:', spec?.type);
          if (spec?.type === 'CoverageNotice') {
            latestCoverageNotice = spec;
          } else if (spec?.type === 'RagNotFound') {
            latestRagNotFound = spec;
            latestCoverageNotice = null;
            latestSpecBase = null;
            accumulatedCards = [];
            turnSpecBase = null;
          } else {
            latestSpecBase = spec;
            turnSpecBase = spec;
            latestRagNotFound = null;
            if (spec?.props?.cards && Array.isArray(spec.props.cards)) {
              for (const newCard of spec.props.cards) {
                mergeCardPreservingId(turnCards, newCard);
                mergeCardPreservingId(accumulatedCards, newCard);
              }
            }
          }
        }
      }

      // 2순위 fallback A: msg.toolInvocations (SDK v4/v5 호환)
      for (const ti of (msg as any).toolInvocations ?? []) {
        if (ti.toolName === 'renderToOptionList' && ti.state === 'result' && ti.result) {
          console.log('[OptionList] toolInvocation found ??state:', ti.state, '| result type:', ti.result?.type);
          const raw = ti.result;
          const spec = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
          if (spec?.type === 'ProductCardList' && Array.isArray(spec?.props?.cards)) {
            if (!turnSpecBase) { turnSpecBase = spec; latestSpecBase = spec; }
            for (const newCard of spec.props.cards) {
              mergeCardPreservingId(turnCards, newCard);
              mergeCardPreservingId(accumulatedCards, newCard);
            }
          }
        }
      }

      // 2순위 fallback B: AI SDK v6 tool-invocation parts 형식
      // { type: 'tool-invocation', toolInvocation: { toolName, state, result } }
      for (const part of (msg.parts ?? []) as any[]) {
        if (
          part.type === 'tool-invocation' &&
          part.toolInvocation?.toolName === 'renderToOptionList' &&
          part.toolInvocation?.state === 'result' &&
          part.toolInvocation?.result
        ) {
          const raw = part.toolInvocation.result;
          const spec = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
          if (spec?.type === 'ProductCardList' && Array.isArray(spec?.props?.cards)) {
            if (!turnSpecBase) { turnSpecBase = spec; latestSpecBase = spec; }
            for (const newCard of spec.props.cards) {
              mergeCardPreservingId(turnCards, newCard);
              mergeCardPreservingId(accumulatedCards, newCard);
            }
          }
        }
      }

      if (turnSpecBase && turnCards.length > 0) {
        // 기준 칩을 검색창에 직접 끌어왔을 때(명시적 새 검색)만 새 페이지를 만든다.
        // 첫 페이지는 예외적으로 항상 새로 만든다(끌어올 칩이 없어도 최초 결과는 보여줘야 함).
        if (pendingIsExplicitSearch || turns.length === 0) {
          turns.push({ userQuery: pendingUserQuery, specBase: turnSpecBase, cards: [...turnCards] });
        } else {
          // 명시적 검색이 아닌 결과(예: mutate로 이어진 요청)는 새 페이지 대신 마지막 페이지를 갱신
          const last = turns[turns.length - 1];
          last.specBase = turnSpecBase;
          last.cards = [...turnCards];
        }
      }
    }

    setCoverageNoticeSpec(latestCoverageNotice);

    if (latestRagNotFound) {
      setProductCardListSpec(latestRagNotFound);
    } else if (latestSpecBase) {
      // productCardListSpec 갱신 — 이 effect는 [messages] 전체에 keyed되어 mutate 전용 턴에도 재실행되지만,
      // accumulatedCards는 오직 renderToOptionList(data-option-list-spec)만 반영해 mutateSurface(add/filter/sort)
      // 변경분을 모른다. 그대로 덮어쓰면 이전 mutate 결과가 매 턴마다 원본 목록으로 리셋된다.
      // queryHistory에 이미 있는 "isSameBaseTurn" 보존 로직과 동일하게, 현재 카드 목록이 이번에 다시
      // 계산한 원본 카드와 이름이 겹치면(=같은 검색을 이어가는 mutate) 기존(=mutate 반영된) 상태를 유지한다.
      setProductCardListSpec((prevSpec: any) => {
        const prevCards: any[] = prevSpec?.props?.cards ?? [];
        const freshCardNames = new Set(accumulatedCards.map((c: any) => c.name));
        const isSameBaseList = prevCards.length > 0 && prevCards.some((c: any) => freshCardNames.has(c.name));
        if (isSameBaseList) return prevSpec;
        return { ...latestSpecBase, props: { ...latestSpecBase.props, cards: accumulatedCards } };
      });

      // queryHistory: turn????냅??으????구??
      if (turns.length > 0) {
        const lastUserRaw = ((([...messages].reverse().find(m => m.role === 'user')?.parts ?? []) as any[])
          .filter((p: any) => p.type === 'text').map((p: any) => p.text as string).join(''));
        const criteriaMatch = lastUserRaw.match(/\[DECISION CRITERIA:\s*([^\]]+)\]/i);
        const latestCriteria: string[] = criteriaMatch
          ? criteriaMatch[1].split(',').map((s: string) => s.split('(')[0].replace(/\[.*?\]/g, '').trim()).filter(Boolean)
          : [];

        setQueryHistory(prev => {
          const next: QHEntry[] = turns.map((turn, i) => {
            const existing = prev[i];

            // 기존 ??트리?? ??을 ??????본 카드?? 같?? 검????인지 ??인
            if (existing?.spec) {
              const existingCardNames = new Set(
                (existing.spec?.props?.cards ?? []).map((c: any) => c.name)
              );
              const turnCardNames: string[] = turn.cards.map((c: any) => c.name);
              // ??본 카드 ????나??도 existing????으??같?? 검????(mutations 보존)
              const isSameBaseTurn = turnCardNames.some(name => existingCardNames.has(name));
              if (isSameBaseTurn) {
                return {
                  ...existing,
                  criteria: i === turns.length - 1 ? latestCriteria : existing.criteria,
                };
              }
            }

            // ??검????????로 ??성
            return {
              id: existing?.id ?? `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 5)}`,
              query: turn.userQuery,
              criteria: i === turns.length - 1 ? latestCriteria : (existing?.criteria ?? []),
              timestamp: existing?.timestamp ?? new Date(),
              spec: { ...turn.specBase, props: { ...turn.specBase.props, cards: turn.cards } },
            };
          });
          setActiveHistoryIndex(next.length - 1);
          return next;
        });

      }
    } else {
      setProductCardListSpec(null);
    }
  }, [messages]);

  // mutateSurface tool 결과 처리 — data-mutate-surface-spec 파트 감지 (route.ts에서 주입)
  useEffect(() => {
    let mutationResult: any = null;
    let mutationMsgId: string | null = null;

    // data-mutate-surface-spec 파트를 가장 최근 assistant 메시지에서 찾기
    for (const msg of [...messages].reverse()) {
      if (msg.role !== 'assistant') continue;
      const partTypes = (msg.parts ?? []).map((p: any) => p.type);
      console.log('[mutateSurface DEBUG] latest assistant msg part types:', partTypes);
      for (const part of (msg.parts ?? []) as any[]) {
        if ((part as any).type === 'data-mutate-surface-spec' && (part as any).data) {
          mutationResult = (part as any).data;
          mutationMsgId = msg.id;
          break;
        }
      }
      if (mutationResult) break;
    }
    if (!mutationResult) return;
    if (mutationResult.surface !== 'optionList') return;
    // 스트리밍 중 messages 배열이 델타마다 새 참조로 갱신되면서 이 effect가 반복 실행되는데,
    // 같은 메시지의 mutate 결과를 이미 처리했다면 다시 적용/기록하지 않는다
    // (그렇지 않으면 mutateLog에 같은 요약이 여러 번 쌓이는 등 중복 처리가 발생한다).
    if (mutationMsgId && processedMutateMsgIdRef.current === mutationMsgId) return;
    if (mutationMsgId) processedMutateMsgIdRef.current = mutationMsgId;
    // mutate를 유발한 사용자의 실제 질문 텍스트 — 태그를 걷어내고 꼬리 로그에 함께 남긴다
    const userQueryForLog = (() => {
      const idx = mutationMsgId ? messages.findIndex(m => m.id === mutationMsgId) : -1;
      if (idx === -1) return '';
      for (let i = idx - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'user') continue;
        const rawText = ((m.parts ?? []) as any[])
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text as string)
          .join('');
        return rawText
          .replace(/\|https?:\/\/[^\s,\]]+/g, '')
          .replace(/^\[Decision Criteria\s*:([^\]]*)\]\s*/i, '"$1" ')
          .replace(/^\[My items\s*:([^\]]*)\]\s*/i, '"$1" ')
          .split(/\n{1,2}\[CONTEXT:/i)[0]
          .split(/\n{1,2}\[DECISION CRITERIA:/i)[0]
          .split(/\n{1,2}\[USER CONTEXT:/i)[0]
          .split(/\n{1,2}\[ASSIGNED ITEM:/i)[0]
          .trim();
      }
      return '';
    })();
    const { op } = mutationResult;
    console.log('[mutateSurface] op:', op, JSON.stringify(mutationResult, null, 2));
    const currentCardNames = productCardListSpec?.props?.cards?.map((c: any) => c.name) ?? [];
    console.log('[mutateSurface] current card names:', currentCardNames);
    // Edit Agent는 id를 우선으로 돌려주지만(current_optionList에서 복사), id가 없던 구형
    // 상태 등 대비로 이름 부분일치 fallback도 유지한다(ComparisonTable/CriteriaMap과 동일 패턴).
    const findCard = (cards: any[], idOrName: string) =>
      cards.find((c: any) => c.id && c.id === idOrName) ??
      cards.find((c: any) =>
        c.name === idOrName ||
        c.name?.toLowerCase().includes(idOrName.toLowerCase()) ||
        idOrName.toLowerCase().includes(c.name?.toLowerCase() ?? '')
      );
    const applyToSpec = (prev: any, updater: (cards: any[]) => any[]) => {
      if (!prev?.props?.cards) return prev;
      const next = updater([...prev.props.cards]);
      return { ...prev, props: { ...prev.props, cards: next } };
    };
    const applyToHistory = (updater: (cards: any[]) => any[]) => {
      setQueryHistory(prev => {
        if (prev.length === 0) return prev;
        const lastIdx = prev.length - 1;
        const last = prev[lastIdx];
        const next = updater([...(last.spec?.props?.cards ?? [])]);
        const updated = [...prev];
        updated[lastIdx] = { ...last, spec: { ...last.spec, props: { ...last.spec.props, cards: next } } };
        return updated;
      });
    };

    // mutate 이력을 현재(마지막) 페이지에 "꼬리 질문"으로 기록 — 페이지는 그대로, 무슨 변경이 있었는지만 남긴다
    if (mutationResult.op_summary) {
      setQueryHistory(prev => {
        if (prev.length === 0) return prev;
        const lastIdx = prev.length - 1;
        const last = prev[lastIdx];
        const updated = [...prev];
        updated[lastIdx] = {
          ...last,
          mutateLog: [...(last.mutateLog ?? []), { summary: mutationResult.op_summary, op: mutationResult.op, timestamp: new Date(), userQuery: userQueryForLog || undefined }],
        };
        return updated;
      });
    }

    // ── filter: result_card_names 순서대로 카드 재구성 ────────────────────────
    if (op === 'filter') {
      const resultNames: string[] = mutationResult.result_card_names ?? [];
      if (resultNames.length === 0) return;

      const reorder = (cards: any[]) =>
        resultNames.map((name: string) => findCard(cards, name)).filter(Boolean);

      setProductCardListSpec((prev: any) => applyToSpec(prev, reorder));
      applyToHistory(reorder);

      // ── sort: sort_by 기준으로 클라이언트 사이드 정렬 ─────────────────────────
    } else if (op === 'sort') {
      const resultNames: string[] = mutationResult.result_card_names ?? [];
      const sortBy: string = (mutationResult.sort_by ?? '').toLowerCase();
      const sortOrder: string = mutationResult.sort_order ?? 'asc';
      console.log('[mutateSurface/sort] sort_by:', sortBy, '| sort_order:', sortOrder, '| result_card_names:', resultNames);

      if (resultNames.length > 0) {
        // LLM이 카드 순서를 알고 있는 경우 (드문 경우)
        const reorder = (cards: any[]) =>
          resultNames.map((name: string) => findCard(cards, name)).filter(Boolean);
        setProductCardListSpec((prev: any) => applyToSpec(prev, reorder));
        applyToHistory(reorder);

      } else if (sortBy) {
        // 클라이언트 사이드 정렬 — 카드의 price 또는 specs에서 수치 추출
        const extractSortValue = (card: any): number => {
          // 가격 기준 정렬
          if (/가격|price/.test(sortBy)) {
            const priceStr = (card.price ?? '').replace(/[^0-9]/g, '');
            return priceStr ? parseInt(priceStr) : Infinity;
          }
          // specs 배열 + description에서 sortBy 키워드 포함 항목 찾아 수치 추출
          // 부분 일치도 허용: "흡입" → "흡입력 15,000Pa" 매칭
          const searchTexts: string[] = [
            ...(card.specs ?? []),
            ...(card.description ? [card.description] : []),
          ];
          for (const text of searchTexts) {
            const lower = text.toLowerCase();
            if (lower.includes(sortBy) || sortBy.split('').every((ch: string) => lower.includes(ch))) {
              // 숫자 추출 (콤마 포함): "15,000Pa" → 15000, "4.2kg" → 4.2
              const numMatch = text.match(/[\d,]+(?:\.\d+)?/);
              if (numMatch) return parseFloat(numMatch[0].replace(/,/g, ''));
            }
          }
          return Infinity;  // 값 없으면 뒤로 보냄
        };


        const sortCards = (cards: any[]) =>
          [...cards].sort((a, b) => {
            const av = extractSortValue(a);
            const bv = extractSortValue(b);
            return sortOrder === 'asc' ? av - bv : bv - av;
          });

        setProductCardListSpec((prev: any) => applyToSpec(prev, sortCards));
        applyToHistory(sortCards);
        console.log(`[mutateSurface] 클라이언트 정렬: "${sortBy}" ${sortOrder}`);
      } else {
        console.warn('[mutateSurface] sort op이지만 result_card_names도 sort_by도 없음');
      }

    } else if (op === 'add') {


      const newCards: any[] = mutationResult.new_cards ?? [];

      if (newCards.length > 0) {
        const appendNew = (cards: any[]) => {
          const existingNames = new Set(cards.map((c: any) => c.name));
          const toAppend = newCards
            .filter((c: any) => !existingNames.has(c.name))
            .map((c: any) => ({
              ...c,
              imageUrl: c.imageUrl ?? c.image ?? "",
            }));
          return [...toAppend, ...cards];
        };
        setProductCardListSpec((prev: any) => applyToSpec(prev, appendNew));
        applyToHistory(appendNew);
      }

      // field_updates????께 캘다 (add op????합)
      const fieldUpdates: any[] = mutationResult.field_updates ?? [];
      if (fieldUpdates.length > 0) {
        const applyFields = (cards: any[]) => {
          return cards.map((card: any) => {
            const updates = fieldUpdates.filter((u: any) => u?.product_name && findCard([card], u.product_name));
            if (updates.length === 0) return card;
            const specsCopy: string[] = [...(card.specs ?? [])];
            for (const u of updates) {
              const key = (u.field_key ?? u.field_name ?? '').toLowerCase();
              const phrase = u.spec_phrase ?? (u.field_name && u.value ? `${u.field_name}: ${u.value}` : null);
              if (!phrase) continue;
              if (key) {
                const idx = specsCopy.findIndex(s => s.toLowerCase().includes(key));
                if (idx !== -1) { specsCopy[idx] = phrase; }
                else { specsCopy.unshift(phrase); }
              } else {
                specsCopy.unshift(phrase);
              }
            }
            return { ...card, specs: specsCopy };
          });
        };
        setProductCardListSpec((prev: any) => applyToSpec(prev, applyFields));
        applyToHistory(applyFields);
      }
    } else if (op === 'remove_field') {
      // add의 field_updates와 반대 방향 — 조회 없이 이미 있는 스펙 줄만 지운다.
      const fieldRemovals: any[] = mutationResult.field_removals ?? [];
      if (fieldRemovals.length > 0) {
        const removeFields = (cards: any[]) => {
          return cards.map((card: any) => {
            const removals = fieldRemovals.filter((r: any) => r?.product_name && findCard([card], r.product_name));
            if (removals.length === 0) return card;
            let specsCopy: string[] = [...(card.specs ?? [])];
            for (const r of removals) {
              const key = (r.field_key ?? '').toLowerCase();
              if (!key) continue;
              specsCopy = specsCopy.filter(s => !s.toLowerCase().includes(key));
            }
            return { ...card, specs: specsCopy };
          });
        };
        setProductCardListSpec((prev: any) => applyToSpec(prev, removeFields));
        applyToHistory(removeFields);
      }
    }


  }, [messages]);



  // ??널 ??장 ??리????콘텐츠?? ??기????당 ??널????라??드??

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
      (p.toolName === 'renderToOptionList') ||
      // AI SDK v6: tool-invocation parts 형식
      (p.type === 'tool-invocation' && p.toolInvocation?.toolName === 'renderToOptionList')
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
        <div className="w-full max-w-lg flex flex-col gap-10 px-8">
          {/* Branding + locale toggle */}
          <div className="flex items-center justify-between">
            <h1 className="text-[48px] font-extrabold text-slate-900 tracking-tight leading-none">GenUIdance</h1>
            <div className="flex items-center gap-1.5 text-[15px] font-medium select-none">
              <button
                onClick={() => setLocale('en')}
                disabled={locale === 'en'}
                className="transition-colors duration-150 disabled:cursor-default"
                style={{ color: locale === 'en' ? '#0f172a' : '#94a3b8', fontWeight: locale === 'en' ? 700 : 400 }}
              >EN</button>
              <span className="text-slate-300">|</span>
              <button
                onClick={() => setLocale('ko')}
                disabled={locale === 'ko'}
                className="transition-colors duration-150 disabled:cursor-default"
                style={{ color: locale === 'ko' ? '#0f172a' : '#94a3b8', fontWeight: locale === 'ko' ? 700 : 400 }}
              >KO</button>
            </div>
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
                onClick={() => setAssignedItem("B")}
                className={`flex-1 py-4 rounded-[8px] text-[15px] font-semibold border transition-all duration-200 ${assignedItem === "B"
                  ? "text-white"
                  : "bg-[#FAFAFA] text-slate-400 border-slate-200 hover:border-slate-400 hover:text-slate-600"
                  }`}
                style={assignedItem === "B" ? { backgroundColor: "#000000", borderColor: "#000000" } : {}}
              >
                {T.robotVacuum}
              </button>
              <button
                type="button"
                onClick={() => setAssignedItem("C")}
                className={`flex-1 py-4 rounded-[8px] text-[15px] font-semibold border transition-all duration-200 ${assignedItem === "C"
                  ? "text-white"
                  : "bg-[#FAFAFA] text-slate-400 border-slate-200 hover:border-slate-400 hover:text-slate-600"
                  }`}
                style={assignedItem === "C" ? { backgroundColor: "#000000", borderColor: "#000000" } : {}}
              >
                {T.camera}
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
            onClick={() => {
              if (participantId.trim() && assignedItem && userContext.trim()) {
                const assignedItemLabel = assignedItem === "B" ? "로봇 청소기" : assignedItem === "C" ? "카메라" : assignedItem;
                fetch('/api/log-event', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    type: 'session_start',
                    participantId: participantId.trim(),
                    assignedItem: assignedItemLabel,
                    purchaseContext: userContext.trim(),
                  }),
                }).catch((err) => console.error('[logEvent] session_start failed:', err));
                setHasStarted(true);
              }
            }}
            disabled={!participantId.trim() || !assignedItem || !userContext.trim()}
            className="w-full py-4 rounded-[8px] text-white text-[16px] font-semibold tracking-tight active:scale-[0.98] transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ backgroundColor: "#000000" }}
          >
            {T.getStarted}
          </button>
        </div>
      </div>
    );
  }


  // ???? Panel render functions ????????????????????????????????????????????????????????????????????????????????????????
  const renderExploration = () => (
    <div data-tour="exploration" className="flex flex-col h-full py-6 px-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between mb-4 flex-shrink-0 border-b border-slate-100 pb-3 gap-y-3 gap-x-2">
        <div className="flex items-center gap-2 flex-1">
          {gripHandle('exploration')}
          <p className="text-[12.5px] font-black text-slate-600 tracking-widest uppercase whitespace-nowrap">🧭 Exploration Journey</p>
          {activeToolName === "renderToExplorationJourney" && (
            <span className="ml-auto text-[10px] text-slate-400 animate-pulse flex items-center gap-1 bg-slate-50 px-2 py-1 rounded-md border border-slate-100 whitespace-nowrap">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce inline-block" />
              {locale === 'en' ? 'AI is analyzing...' : 'AI 분석 중...'}
            </span>
          )}
        </div>
        <div className="flex items-center bg-[#F1F3F5] rounded-full p-[2px] border border-black/[0.02] shadow-inner shadow-slate-200/50 flex-shrink-0">
          <button type="button" onClick={() => setJourneyTab("criteria")} className={`px-3 py-1 rounded-full text-[11px] font-medium transition-all duration-200 ${journeyTab === "criteria" ? "bg-white text-slate-800 shadow-[0_1px_4px_rgba(0,0,0,0.08)] border border-black/[0.04]" : "text-slate-400 hover:text-slate-600"}`}>Criteria</button>
          <button type="button" onClick={() => setJourneyTab("information")} className={`px-3 py-1 rounded-full text-[11px] font-medium transition-all duration-200 ${journeyTab === "information" ? "bg-white text-slate-800 shadow-[0_1px_4px_rgba(0,0,0,0.08)] border border-black/[0.04]" : "text-slate-400 hover:text-slate-600"}`}>Information</button>
        </div>
      </div>
      {journeyTab === "criteria" && unchartedSpec && unchartedSpec.labels.length > 0 && (
        <div className="flex-shrink-0 mb-3">{manualRegistry.UnchartedTerritoryChip({ props: { labels: unchartedSpec.labels, skipAnimation: unchartedHasShownRef.current, onExplore: (label: string) => { unchartedHasShownRef.current = true; const cat = locale === 'en' ? (assignedItem === "A" ? "stroller" : assignedItem === "B" ? "robot vacuum" : assignedItem === "C" ? "camera" : "product") : (assignedItem === "A" ? "유모차" : assignedItem === "B" ? "로봇 청소기" : assignedItem === "C" ? "카메라" : "제품"); handleSubmit(locale === 'en' ? `Tell me more about the "${label}" criterion for buying a ${cat}` : `${cat} 구매에서 '${label}' 기준의 세부 항목을 알려줘`); startTransition(() => { setDismissedUncharted(prev => { const next = new Set(prev); next.add(label); return next; }); setUnchartedSpec(prev => prev ? { labels: prev.labels.filter(l => l !== label) } : null); }); }, locale } })}</div>
      )}
      <div className="flex-1 overflow-y-auto styled-scrollbar pr-1">
        <div className={journeyTab === "criteria" ? "" : "hidden"}>
          {(localizedCriteriaMap ?? sidebarSpec.CriteriaMap) ? (<ExplorerRenderer spec={localizedCriteriaMap ?? sidebarSpec.CriteriaMap} bindings={sidebarBindings} />) : (<div className="flex flex-col items-center justify-center h-full gap-2 py-12"><p className="text-[12px] text-slate-300 font-medium text-center leading-relaxed">{locale === 'en' ? 'Start a conversation' : '대화를 시작하면'}<br />{locale === 'en' ? 'to build your criteria map' : '여기에 탐색 기록이 쌓여요'}</p></div>)}
        </div>
        <div className={journeyTab === "information" ? "" : "hidden"}>
          {(localizedConceptCards ?? sidebarSpec.conceptCards).length > 0 ? (<div className="flex flex-col gap-3 py-1">{(localizedConceptCards ?? sidebarSpec.conceptCards).map((card: any, i: number) => (<InformationCardItem key={`${card.term}-${i}`} card={card} index={i} />))}</div>) : (<div className="flex flex-col items-center justify-center h-full gap-2 py-12"><p className="text-[12px] text-slate-300 font-medium text-center leading-relaxed">{locale === 'en' ? 'Ask a concept question' : '개념 질문을 해보면'}<br />{locale === 'en' ? 'to build your knowledge base' : '여기에 정보가 쌓여요'}</p></div>)}
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
    return (
      <div
        onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-panel')) return; e.preventDefault(); e.currentTarget.classList.add("bg-primary/5", "border-primary/30"); }}
        onDragLeave={(e) => { e.currentTarget.classList.remove("bg-primary/5", "border-primary/30"); }}
        onDrop={(e: React.DragEvent<HTMLDivElement>) => {
          if (e.dataTransfer.types.includes('application/x-panel')) return;
          e.preventDefault(); e.currentTarget.classList.remove("bg-primary/5", "border-primary/30");
          const jsonData = e.dataTransfer.getData("application/json");
          const label = e.dataTransfer.getData("text/plain");
          if (jsonData) { try { const item = JSON.parse(jsonData); if (item.name && !droppedCriteria.some(c => c.name === item.name)) { const existingCriteria = droppedCriteria.map(c => ({ name: c.name, important: !!c.important })); setDroppedCriteria((prev) => [...prev, { name: item.name, min: item.min, priority: item.priority || "medium", important: !!item.important } as any]); checkTradeoff({ name: item.name, important: !!item.important }, existingCriteria); } } catch { if (label && !droppedCriteria.some(c => c.name === label)) setDroppedCriteria((prev) => [...prev, { name: label, priority: "medium" }]); } } else if (label && !droppedCriteria.some(c => c.name === label)) { setDroppedCriteria((prev) => [...prev, { name: label, priority: "medium" }]); }
        }}
        className="flex flex-col flex-1 overflow-hidden"
      >
        {/* 고정 ??더 */}
        <div className="flex items-center shrink-0 px-6 pt-8 pb-4">
          <div className="flex items-center gap-2"><p className="text-[12.5px] font-black text-slate-600 tracking-widest uppercase">🎯 DECISION CRITERIA</p>{droppedCriteria.length > 0 && <span className="text-[12px] font-normal text-slate-300">({droppedCriteria.length})</span>}</div>
        </div>
        {/* ??크??콘텐??*/}
        <div className="flex flex-col gap-3 flex-1 overflow-y-auto px-6 pt-2 pb-6 no-scrollbar">
          {droppedCriteria.length > 0 ? (
            <div className="flex flex-wrap gap-2.5 w-full content-start">
              {droppedCriteria.map((criterion, i) => {
                return (
                  <div key={i} onClick={() => { if (!searchCriteria.some(c => c.name === criterion.name)) setSearchCriteria(prev => [...prev, { name: criterion.name, min: criterion.min, priority: criterion.priority }]); inputRef.current?.focus(); }}
                    className="flex items-center gap-2 rounded-2xl px-2.5 h-[32px] w-fit max-w-full group animate-in zoom-in-95 duration-200 cursor-pointer transition-colors"
                    style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', color: '#1e293b' }}>
                    <div className="flex items-center gap-1.5 overflow-hidden min-w-0">
                      <span className="text-[12.5px] font-bold select-none whitespace-nowrap shrink-0 text-slate-800">{criterion.name}</span>
                      {editingCriteriaIdx === i ? (<input autoFocus className={`text-[10.5px] border-b outline-none w-[60px] bg-transparent py-0 shrink-0 text-slate-500 border-slate-300`} value={editingMinText} onChange={(e) => setEditingMinText(e.target.value)} onBlur={() => { setDroppedCriteria(prev => { const next = [...prev]; next[i] = { ...next[i], min: editingMinText }; return next; }); setEditingCriteriaIdx(null); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />) : (<span className="text-[10.5px] font-medium select-none truncate text-slate-500" title={criterion.min || T.pinHint}>{criterion.min || T.pinHint}</span>)}
                    </div>
                    <div className="flex items-center gap-0.5 ml-1 pl-1 border-l border-slate-200">
                      <button onClick={(e) => { e.stopPropagation(); setEditingCriteriaIdx(i); setEditingMinText(criterion.min || ""); }} className={`p-0.5 transition-colors text-slate-300 hover:text-slate-600`}><Pencil className="w-2.5 h-2.5" /></button>
                      <button onClick={(e) => {
                        e.stopPropagation();
                        const removedName = criterion.name;
                        setDroppedCriteria(prev => prev.filter((_, idx) => idx !== i));
                        setTradeoffSpecs(prev => { const next = { ...prev }; delete next[removedName]; return next; });
                        logEvent({ type: 'criteria_event', op: 'remove', criterionName: removedName, turnIndex: messages.length });
                      }} className={`p-0.5 transition-colors text-slate-300 hover:text-slate-900`}><X className="w-3 h-3" /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (<div className="flex-1 flex items-center justify-center"><p className="text-[12.5px] text-slate-300 font-medium text-center leading-relaxed">{T.criteriaEmpty.split('\n').map((line, i) => <span key={i}>{line}{i === 0 && <br />}</span>)}</p></div>)}
          {/* TradeoffHints — criteria 칩 바로 아래, 스크롤 영역 내부 */}
          {(() => { const activeHints = droppedCriteria.filter(c => { const spec = tradeoffSpecs[c.name]; return spec?.type === "TradeoffHint" && !dismissedTradeoffs.has(c.name) && !tradeoffLoading.has(c.name); }); if (activeHints.length === 0) return null; const TradeoffHintComp = manualRegistry.TradeoffHint; return (<div className="flex flex-col gap-2 pt-3 mt-1 border-t border-slate-100 w-full shrink-0">{activeHints.map(criterion => (<TradeoffHintComp key={criterion.name} props={{ ...tradeoffSpecs[criterion.name].props, onDismiss: () => setDismissedTradeoffs(prev => new Set([...prev, criterion.name])), onResolve: () => { setDismissedTradeoffs(prev => new Set([...prev, criterion.name])); const spec = tradeoffSpecs[criterion.name].props; handleResolveTradeoff(spec.newCriterion, spec.conflictsWith); } }} />))}</div>); })()}
        </div>
      </div>
    );
  };

  const renderOptionsContent = () => (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* 고정 ??더 */}
      <div className="flex items-center shrink-0 px-6 pt-8 pb-4">
        <div className="flex items-center gap-2"><p className="text-[12.5px] font-black text-slate-600 tracking-widest uppercase">🛒 MY OPTIONS</p>{droppedItems.length > 0 && <span className="text-[12px] font-normal text-slate-300">({droppedItems.length})</span>}</div>
      </div>
      {/* ??크??콘텐??*/}
      <div className="flex flex-col gap-2 flex-1 overflow-y-auto px-6 pt-2 pb-4 no-scrollbar">
        {droppedItems.length > 0 ? droppedItems.map((item, i) => {
          const isSelected = selectedItemName === item.name;
          return (
            <div
              key={i}
              onClick={() => { insertMention(item.name); }}
              className={`group relative rounded-[8px] border p-3 flex items-center gap-3 animate-in zoom-in-95 duration-200 transition-all cursor-pointer ${isSelected
                ? 'bg-white border-slate-300 shadow-sm'
                : 'bg-white border-slate-200 hover:border-slate-300'
                }`}
            >
              <button
                onClick={(e) => { e.stopPropagation(); handleRemoveItem(item.name); if (selectedItemName === item.name) setSelectedItemName(null); }}
                className="absolute top-2 right-2 text-slate-300 hover:text-slate-700 transition-colors z-10"
              >
                <X className="w-3 h-3" />
              </button>
              {/* 체크박스 - ??릭 ??구매 ??택 ???? */}
              <div
                onClick={(e) => { e.stopPropagation(); setSelectedItemName(isSelected ? null : item.name); }}
                className={`w-4 h-4 rounded-[3px] border-2 flex items-center justify-center flex-shrink-0 transition-all cursor-pointer ${isSelected ? 'border-black bg-black' : 'border-slate-300 bg-white hover:border-slate-500'
                  }`}>
                {isSelected && (
                  <svg width="9" height="7" viewBox="0 0 9 7" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 3.5L3.5 6L8 1" />
                  </svg>
                )}
              </div>
              <div className="w-12 h-12 rounded-[4px] bg-slate-50 border border-slate-100 flex items-center justify-center flex-shrink-0 overflow-hidden">{item.image ? (<img src={item.image} alt={item.name} className="w-full h-full object-cover" />) : (<span className="text-[18px] font-black text-slate-300 uppercase">{item.name[0]}</span>)}</div>
              <div className="flex flex-col min-w-0 flex-1 pr-4 gap-1"><p className={`text-[12px] font-semibold leading-tight break-keep ${isSelected ? 'text-black' : 'text-slate-700'}`}>{item.name}</p>{item.price && <span className="text-[11.5px] font-medium text-slate-500">{item.price}</span>}</div>
            </div>
          );
        }) : (<div className="flex-1 flex items-center justify-center"><p className="text-[12.5px] text-slate-300 font-medium text-center leading-relaxed flex flex-col items-center gap-1"><span className="flex items-center gap-1.5">{locale === 'en' ? 'Press' : '관심 제품의'}<span className="inline-flex items-center justify-center w-[20px] h-[20px] rounded-full bg-slate-300/60"><Heart className="w-[10px] h-[10px] text-white" fill="white" strokeWidth={0} /></span>{locale === 'en' ? 'on products' : '눌러'}</span><span>{locale === 'en' ? 'to save them here' : '여기에 저장해보세요'}</span></p></div>)}
      </div>
      {/* 구매??기 버튼 - ??단 고정 */}
      <div className="flex-shrink-0 px-5 pb-5 pt-2">
        <button
          type="button"
          onClick={() => { logEvent({ type: 'purchase_clicked' }); setShowConfirmModal(true); }}
          disabled={!selectedItemName}
          className={`w-full py-2.5 rounded-[10px] text-[13px] font-semibold transition-all duration-200 ${selectedItemName
            ? 'bg-black text-white border border-black hover:bg-neutral-800'
            : 'bg-white text-slate-400 border border-slate-200 opacity-40 cursor-not-allowed'
            }`}
        >
          {locale === 'en' ? 'Purchase' : '구매하기'}
        </button>
      </div>
    </div>
  );


  const renderOptionList = () => {
    const activeEntry = queryHistory[activeHistoryIndex] ?? null;
    // activeEntry.spec = ??당 ??의 카드??(??택 ??음)
    // mutationRenderKey가 update_field ??강제 리렌???? 보장
    const specToShow = activeEntry?.spec ?? productCardListSpec;
    const total = queryHistory.length;

    const getRelativeTime = (date: Date): string => {
      const diffMin = Math.floor((Date.now() - date.getTime()) / 60000);
      if (diffMin < 1) return '방금 전';
      if (diffMin < 60) return `${diffMin}분 전`;
      const diffHour = Math.floor(diffMin / 60);
      if (diffHour < 24) return `${diffHour}시간 전`;
      return `${Math.floor(diffHour / 24)}일 전`;
    };

    return (
      <div data-tour="optionList" className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex-shrink-0 flex items-center gap-2 px-6 pt-6 pb-3 border-b border-slate-50">
          {gripHandle('optionList')}
          <p className="text-[12.5px] font-black text-slate-600 tracking-widest uppercase">📦 OPTION LIST</p>
          {(activeToolName === "renderToOptionList" || activeToolName === "mutateSurface") && (
            <span className="ml-auto text-[10px] text-slate-400 animate-pulse flex items-center gap-1 bg-slate-50 px-2 py-1 rounded-md border border-slate-100">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce inline-block" />
              {locale === 'en' ? 'AI is analyzing...' : 'AI 분석 중...'}
            </span>
          )}
          {enrichingCriterion && !(activeToolName === "renderToOptionList" || activeToolName === "mutateSurface") && (
            <span className="ml-auto text-[10px] text-slate-400 animate-pulse flex items-center gap-1 bg-slate-50 px-2 py-1 rounded-md border border-slate-100">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce inline-block" />
              <span className="font-semibold text-slate-400">[{enrichingCriterion}]</span>
              {locale === 'en' ? ' adding info...' : ' 정보를 추가하고 있습니다...'}
            </span>
          )}
        </div>

        {/* 기?? ??규모 교체 감?? 배너 */}
        {criteriaResetConfirm && (
          <div className="flex-shrink-0 mx-4 mt-3 rounded-[8px] border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
            <span className="text-amber-500 text-[16px] flex-shrink-0">⚠</span>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-semibold text-amber-800">{locale === 'en' ? 'Criteria changed significantly' : '기준이 크게 바뀌어요'}</p>
              <p className="text-[11px] text-amber-700 mt-0.5">{locale === 'en' ? 'The current list may not match the new criteria. Search again?' : '현재 리스트가 새 기준에 맞지 않을 수 있습니다. 새로 검색할까요?'}</p>
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => {
                    setCriteriaResetConfirm(false);
                    // 채팅창에 ??검????리??메시지 ??송
                    const msg = locale === 'en'
                      ? `[Decision Criteria : ${droppedCriteria.map(c => c.name).join(', ')}]\\nFind new products that match the criteria`
                      : `[Decision Criteria : ${droppedCriteria.map(c => c.name).join(', ')}]\\n기준에 맞는 제품을 새로 찾아줘`;
                    setInput(msg);
                  }}
                  className="text-[11px] font-semibold text-white bg-amber-500 hover:bg-amber-600 rounded-[5px] px-3 py-1.5 transition-colors"
                >
                  {locale === 'en' ? 'Search again' : '새로 검색'}
                </button>
                <button
                  type="button"
                  onClick={() => setCriteriaResetConfirm(false)}
                  className="text-[11px] font-medium text-amber-700 hover:text-amber-900 rounded-[5px] px-2 py-1.5 transition-colors"
                >
                  {locale === 'en' ? 'Keep current' : '유지하기'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* History Banner ????크????역 ?? 고정 */}
        {activeEntry && (
          <div className="flex-shrink-0 px-4 pb-3">
            <div className="mx-6 rounded-[8px] border border-slate-200 bg-white px-3 py-2 flex flex-col gap-1.5">
              {/* Row 1: ??이??+ 질문(1?? + ????스??프 + ??N/N ??*/}
              <div className="flex items-center gap-1.5">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400 flex-shrink-0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                <p className="text-[11.5px] font-semibold text-slate-700 leading-snug truncate flex-1 min-w-0">
                  {activeEntry.query}
                </p>

                {total > 1 && (
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => { const p = activeHistoryIndex - 1; if (p >= 0) setActiveHistoryIndex(p); }}
                      disabled={activeHistoryIndex <= 0}
                      className="w-5 h-5 flex items-center justify-center rounded transition-all duration-150 disabled:opacity-25 hover:bg-slate-200 text-slate-500"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                    </button>
                    <span className="text-[10px] font-semibold text-slate-400 tabular-nums px-0.5">{activeHistoryIndex + 1}/{total}</span>
                    <button
                      type="button"
                      onClick={() => { const n = activeHistoryIndex + 1; if (n < total) setActiveHistoryIndex(n); }}
                      disabled={activeHistoryIndex >= total - 1}
                      className="w-5 h-5 flex items-center justify-center rounded transition-all duration-150 disabled:opacity-25 hover:bg-slate-200 text-slate-500"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Product cards area ??카드????크??*/}
        <div className="flex-1 overflow-y-auto overflow-x-hidden styled-scrollbar p-4 pt-0 flex flex-col gap-3 relative">
          {coverageNoticeSpec && manualRegistry.CoverageNotice && (
            manualRegistry.CoverageNotice({ props: coverageNoticeSpec.props, bindings: { locale } })
          )}

          {specToShow ? (
            <ExplorerRenderer
              spec={specToShow}
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
  };



  const renderCompTable = () => (
    <div data-tour="compTable" className="flex flex-col gap-4 p-6 flex-1 overflow-auto no-scrollbar">
      <div className="flex items-center gap-2">
        {gripHandle('compTable')}
        <p className="text-[12.5px] font-black text-slate-600 tracking-widest uppercase">⚖️ COMPARISON TABLE</p>
        {activeToolName === "renderToCompTable" && !isUpdatingTable && (
          <span className="ml-auto text-[10px] text-slate-400 animate-pulse flex items-center gap-1 bg-slate-50 px-2 py-1 rounded-md border border-slate-100 whitespace-nowrap">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce inline-block" />
            {locale === 'en' ? 'AI is analyzing...' : 'AI 분석 중...'}
          </span>
        )}
        {isUpdatingTable && (
          <span className="ml-auto text-[10px] text-slate-400 font-medium animate-pulse flex items-center gap-1 bg-slate-50 px-2 py-1 rounded-md border border-slate-100 whitespace-nowrap transition-all duration-300">
            <svg className="animate-spin -ml-0.5 mr-0.5 h-3 w-3 text-slate-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {locale === 'en' ? 'Updating ranks & table...' : '기준에 맞춰 순위 재평가 중..'}
          </span>
        )}
      </div>

      {/* History Banner — 표를 만든 질문 + 그 뒤로 이어진 mutate(기준/제품 추가·삭제) 꼬리 질문 */}
      {compTableSpec && compTableQuery && (
        <div className="flex-shrink-0 rounded-[8px] border border-slate-200 bg-white px-3 py-2 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400 flex-shrink-0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
            <p className="text-[11.5px] font-semibold text-slate-700 leading-snug truncate flex-1 min-w-0">
              {compTableQuery}
            </p>
          </div>
        </div>
      )}

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

  // 결정 ??약 모달 ??이??계산
  const summaryTopProduct = (() => {
    // 0??위: ??용???? 체크박스????택????이??
    if (selectedItemName) {
      const selected = droppedItems.find(it => it.name === selectedItemName);
      if (selected) return { name: selected.name, price: selected.price, imageUrl: selected.image, source: 'selected' as const };
    }
    if (compTableSpec?.props?.rows?.length > 0) {
      const rankRow = compTableSpec.props.rows.find((r: any) => String(r['??위'] ?? r['Rank'] ?? r.criterion) === '??위' || String(r.criterion) === '??위' || String(r.criterion) === 'Rank');
      // rank row??서 1??컬럼 찾기
      const columns = compTableSpec.props.columns ?? [];
      const rankRowActual = compTableSpec.props.rows.find((r: any) => r.criterion === '??위' || r.criterion === '순위');
      if (rankRowActual) {
        const firstProdCol = columns.find((c: any) => c.key !== 'criterion' && (rankRowActual[c.key] === '1위' || rankRowActual[c.key] === '1st'));
        if (firstProdCol) {
          return { name: firstProdCol.label, imageUrl: firstProdCol.imageUrl, source: 'table' as const };
        }
      }
    }
    // 2??위: My Items ??번째
    if (droppedItems.length > 0) return { name: droppedItems[0].name, price: droppedItems[0].price, imageUrl: droppedItems[0].image, source: 'items' as const };
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
    <div className="h-screen flex flex-col w-full overflow-hidden bg-[#F4F6FB]">

      {/* ???? 결정 ??약 모달 ???? */}
      {/* ???? 결제 ??인 모달 ???? */}
      {showConfirmModal && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl flex flex-col items-center gap-6 px-10 py-9"
            style={{ minWidth: '320px' }}
          >
            <p className="text-[16px] font-semibold text-slate-800 text-center leading-snug">
              {locale === 'en' ? 'Proceed with purchase?' : '구매를 진행하시겠습니까?'}
            </p>
            <div className="flex gap-3 w-full">
              <button
                onClick={() => {
                  setShowConfirmModal(false);
                  setShowSummaryModal(true);
                  logEvent({
                    type: 'purchase_confirmed',
                    finalCriteria: droppedCriteria,
                    finalOptions: droppedItems,
                  });
                }}
                className="flex-1 py-2.5 rounded-xl bg-black text-[13px] font-semibold text-white hover:bg-neutral-800 transition-colors"
              >
                {locale === 'en' ? 'Yes' : '네'}
              </button>
              <button
                onClick={() => { setShowConfirmModal(false); }}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 text-[13px] font-semibold text-slate-500 hover:bg-slate-50 transition-colors"
              >
                {locale === 'en' ? 'No' : '아니요'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ???? ??체 ??화 ??록 ??로??????? */}
      {showHistoryDrawer && (
        <div
          className="fixed inset-0 z-[9999] flex justify-start"
          style={{ backgroundColor: 'rgba(15,23,42,0.28)' }}
          onClick={() => setShowHistoryDrawer(false)}
        >
          <div
            className="h-full w-[420px] max-w-[90vw] bg-white border-r border-slate-200 shadow-2xl flex flex-col animate-in slide-in-from-left duration-300"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-slate-400" />
                <span className="text-[13px] font-bold text-slate-800">{locale === 'en' ? 'Conversation history' : '대화 기록'}</span>
                <span className="text-[11px] font-semibold text-slate-400">{buildHistoryTurns(messages).length}{locale === 'en' ? ' turns' : '턴'}</span>
              </div>
              <button
                onClick={() => setShowHistoryDrawer(false)}
                className="p-1.5 rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div ref={historyDrawerBodyRef} className="flex-1 overflow-y-auto px-6 py-6 space-y-8 styled-scrollbar">
              {(() => {
                const turns = buildHistoryTurns(messages);

                if (turns.length === 0) {
                  return <p className="text-[12px] text-slate-400 text-center pt-10">{locale === 'en' ? 'No conversation yet.' : '아직 대화 기록이 없어요.'}</p>;
                }

                return turns.map((turn, i) => {
                  const qText = extractUserDisplayText((turn.user as any).content || getMessageText(turn.user));
                  const actionData = getActionData(turn.assistant);
                  const isNone = actionData?.action === 'none';
                  const aText = isNone ? getMessageText(turn.assistant) : "";
                  const summaryLabel = !isNone ? actionSummaryLabel(actionData, locale) : null;
                  const isLastTurn = i === turns.length - 1;
                  const userLabel = "User";
                  return (
                    <div key={turn.user.id} className="flex flex-col">
                      {/* 사용자 발화 — AI 배지와 같은 네모 칩 모양 + 텍스트 + 시각 */}
                      <div className="flex items-center gap-2.5">
                        <span className="shrink-0 px-2 py-1 rounded-md bg-slate-100 text-slate-500 font-bold text-[10px]">
                          {userLabel}
                        </span>
                        <span className="flex-1 min-w-0 text-[12px] leading-relaxed text-slate-800 whitespace-pre-wrap break-words">{qText || "..."}</span>
                        <span className="shrink-0 text-[10px] text-slate-300 font-medium">{formatTurnTime(msgTimestamps[turn.user.id], locale)}</span>
                      </div>

                      {/* AI 응답(none) — 사용자 배지 왼쪽에서 이어지는 세로선으로 연결 */}
                      {aText && (
                        <div className="ml-1.5 pl-4 border-l border-slate-200 mt-2 pb-1 flex items-center gap-2">
                          <span className="shrink-0 px-2 py-1 rounded-md bg-indigo-50 text-indigo-500 font-bold text-[10px]">AI</span>
                          <span className="min-w-0 text-[13px] leading-relaxed text-slate-800 whitespace-pre-wrap break-words">
                            {aText}
                            {isLastTurn && isStreaming && <span className="inline-block w-[2px] h-[11px] bg-indigo-500 ml-0.5 -mb-0.5 animate-pulse" />}
                          </span>
                        </div>
                      )}

                      {/* generate/edit 요약 — 전체 응답 대신 한 줄 요약만 */}
                      {summaryLabel && (
                        <div className="ml-1.5 pl-4 border-l border-slate-200 mt-1.5 pb-0.5">
                          <span className="text-[11px] text-slate-400 font-medium flex items-center gap-1">
                            <Sparkles className="w-2.5 h-2.5" />
                            {summaryLabel}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ???? ???? ??이드 레일: ??토리??+ ??화 ??록 ??? */}
      <div className="fixed left-4 top-1/2 -translate-y-1/2 z-40 flex flex-col items-center gap-1 bg-white border border-slate-200 rounded-full shadow-lg p-1.5">
        <HoverTooltip label={locale === 'en' ? 'Interface guide' : '인터페이스 안내'} side="right">
          <button
            onClick={() => setShowTour(true)}
            className="w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors"
          >
            <Compass className="w-4 h-4" />
          </button>
        </HoverTooltip>
        <div className="w-5 h-px bg-slate-100" />
        <HoverTooltip label={locale === 'en' ? 'Conversation history' : '대화 기록'} side="right">
          <button
            onClick={() => setShowHistoryDrawer(true)}
            className="relative w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors"
          >
            <History className="w-4 h-4" />
            {buildHistoryTurns(messages).length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-[3px] rounded-full bg-indigo-500 text-white text-[9px] font-bold flex items-center justify-center leading-none">
                {buildHistoryTurns(messages).length}
              </span>
            )}
          </button>
        </HoverTooltip>
      </div>

      <PanelTour open={showTour} onClose={() => setShowTour(false)} locale={locale} />

      {showSummaryModal && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto"
          style={{ backgroundColor: '#FAFAFA' }}
        >
          <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: '40px' }}>

            {/* ???? ??수??카드 ???? */}
            <div style={{
              width: '100%',
              maxWidth: '624px',
              position: 'relative',
              borderRadius: '20px',
              boxShadow: '0 4px 24px rgba(0,0,0,0.08)'
            }}>

              {/* ???? ??료 문구 (카드 10px ?? ???? */}
              <div style={{ position: 'absolute', bottom: 'calc(100% + 25px)', left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>
                <span style={{ fontSize: '22px', fontWeight: '700', color: '#0f172a' }}>
                  {locale === 'en' ? 'Purchase Complete.' : '결제가 완료되었습니다'}
                </span>
              </div>

              {/* ???? ??쪽 ??반 (??짜 ??더 ~ 총계) ???? */}
              <div style={{ backgroundColor: 'white', border: '1px solid #e2e8f0', borderTopLeftRadius: '20px', borderTopRightRadius: '20px', borderBottom: 'none' }}>

                {/* ??더: ??짜(?? + ??간(?? */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '29px 44px 24px' }}>
                  <span style={{ fontSize: '13px', color: '#94a3b8' }}>
                    {new Date().toLocaleDateString(locale === 'en' ? 'en-US' : 'ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })}
                  </span>
                  <span style={{ fontSize: '13px', color: '#94a3b8' }}>
                    {new Date().toLocaleTimeString(locale === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>

                {/* 최종 ??택 ??품 */}
                <div style={{ padding: '0 44px 12px', borderBottom: '1px solid #f1f5f9' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '14px' }}>
                    <span style={{ fontSize: '11px', fontWeight: '600', color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{T.finalProduct}</span>
                    {(summaryTopProduct as any)?.price && (
                      <span style={{ fontSize: '11px', fontWeight: '600', color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{T.price}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', paddingBottom: '4px' }}>
                    {/* ??품 ????지 */}
                    {(summaryTopProduct as any)?.imageUrl ? (
                      <div style={{ width: '72px', height: '72px', borderRadius: '10px', backgroundColor: '#f8fafc', border: '1px solid #f1f5f9', overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <img
                          src={(summaryTopProduct as any).imageUrl}
                          alt={summaryTopProduct?.name}
                          style={{ width: '100%', height: '100%', objectFit: 'contain', mixBlendMode: 'multiply' }}
                        />
                      </div>
                    ) : (
                      <div style={{ width: '72px', height: '72px', borderRadius: '10px', backgroundColor: '#f8fafc', border: '1px solid #f1f5f9', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <svg width="24" height="24" fill="none" stroke="#cbd5e1" strokeWidth="1.5" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </div>
                    )}
                    <div style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <span style={{ fontSize: '15px', color: '#1e293b', lineHeight: 1.4, fontWeight: '500', flex: 1 }}>
                        {summaryTopProduct ? summaryTopProduct.name : '없음'}
                      </span>
                      {(summaryTopProduct as any)?.price && (
                        <span style={{ fontSize: '15px', color: '#1e293b', marginLeft: '16px', whiteSpace: 'nowrap' }}>
                          {(summaryTopProduct as any).price}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* 결정 기?? ??정 */}
                <div style={{ padding: '17px 44px 8px', borderBottom: '1px solid #f1f5f9' }}>
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: '14px' }}>
                    <span style={{ fontSize: '11px', fontWeight: '600', color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                      {locale === 'en' ? 'Decision Criteria' : '결정 기준'}
                    </span>
                  </div>
                  {droppedCriteria.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', paddingBottom: '6px' }}>
                      {droppedCriteria.map((c, i) => {
                        return (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '9px 0', borderBottom: '1px solid #f8fafc' }}>
                            {/* ??서 번호 */}
                            <span style={{ fontSize: '10px', fontWeight: '700', color: '#cbd5e1', width: '18px', flexShrink: 0, textAlign: 'center' }}>
                              {i + 1}
                            </span>
                            {/* 기????*/}
                            <span style={{ fontSize: '14px', color: '#334155', flex: 1 }}>{c.name}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p style={{ fontSize: '14px', color: '#94a3b8', padding: '8px 0 14px' }}>{T.noCriteria}</p>
                  )}
                </div>

              </div>

              {/* 구분??*/}
              <div style={{ position: 'relative', height: '32px', display: 'flex', alignItems: 'center', backgroundColor: '#FAFAFA', zIndex: 3, borderLeft: '1px solid #e2e8f0', borderRight: '1px solid #e2e8f0' }}>
                <div style={{ flex: 1, borderTop: '1px dashed #e2e8f0', margin: '0 24px', position: 'relative', zIndex: 1 }} />
              </div>

              {/* ???? ??래????반 (바코?? ???? */}
              <div style={{ backgroundColor: 'white', border: '1px solid #e2e8f0', borderBottomLeftRadius: '20px', borderBottomRightRadius: '20px', borderTop: 'none' }}>
                {/* 바코??*/}
                <div style={{ padding: '28px 44px 32px', textAlign: 'center' }}>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: '1px', alignItems: 'stretch', height: '40px' }}>
                    {[2, 1, 3, 1, 2, 1, 1, 3, 2, 1, 2, 3, 1, 1, 2, 1, 3, 1, 2, 1, 1, 2, 3, 1, 2, 1, 1, 3, 1, 2, 1, 3, 2, 1, 1, 2, 1, 2, 3, 1, 2, 1, 2, 1, 3, 2, 1, 1, 2, 3, 1, 2, 1, 3, 1, 2, 1, 2, 1, 3].map((w, i) => (<div key={i} style={{ width: (w * 1.4) + 'px', backgroundColor: i % 11 === 0 ? 'transparent' : '#1e293b' }} />))}


                  </div>
                </div>
              </div>



            </div>
          </div>
        </div>
      )}




      {/* Full-width white header */}

      <div className="shrink-0 bg-[#F4F6FB] px-8 py-4 flex items-center justify-between border-b border-indigo-100">
        <button
          type="button"
          onClick={() => resetSession()}
          className="text-[22px] font-extrabold text-slate-900 tracking-tight leading-tight hover:text-slate-600 transition-colors cursor-pointer"
        >
          GenUIdance
        </button>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <User className="w-4 h-4 text-slate-500" strokeWidth={2.5} />
            <span className="text-[14.5px] font-medium text-slate-600">
              {T.greeting}<strong className="font-bold text-slate-900">{participantId}</strong>{T.greetingSuffix}
            </span>
          </div>
          {/* ??어 ???? */}
          <div className="flex items-center gap-1.5 text-[15px] font-medium select-none">
            {isTranslating && (
              <span className="inline-block w-3 h-3 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
            )}
            <button
              onClick={() => setLocale('en')}
              disabled={isTranslating || locale === 'en'}
              className="transition-colors duration-150 disabled:cursor-not-allowed"
              style={{ color: locale === 'en' ? '#0f172a' : '#94a3b8', fontWeight: locale === 'en' ? 700 : 400, opacity: isTranslating ? 0.5 : 1 }}
            >EN</button>
            <span className="text-slate-300">|</span>
            <button
              onClick={() => setLocale('ko')}
              disabled={isTranslating || locale === 'ko'}
              className="transition-colors duration-150 disabled:cursor-not-allowed"
              style={{ color: locale === 'ko' ? '#0f172a' : '#94a3b8', fontWeight: locale === 'ko' ? 700 : 400, opacity: isTranslating ? 0.5 : 1 }}
            >KO</button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col w-full overflow-hidden">
        <div className="flex w-full flex-1 min-h-0 pt-3 pr-3 pb-0 pl-20 relative">

          {/* LEFT AREA FOR DYNAMIC PANELS */}
          <div className="flex-1 flex min-w-0 h-full relative overflow-hidden pr-[48px] justify-center">
            {/* SLOT 1 (LEFT) RESIZE HANDLE */}
            {isPanelShown(panelSlots.left) && (
              <div
                className="w-3 h-full flex-shrink-0 flex items-center justify-center cursor-col-resize group"
                onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); pointerDragRef.current = { type: 'col-ol', startX: e.clientX, startY: e.clientY, startVal: panelWidths[panelSlots.left], containerH: 0 }; setIsResizing(true); }}
                onPointerMove={(e) => { const d = pointerDragRef.current; if (!d || d.type !== 'col-ol') return; setPanelWidths(prev => ({ ...prev, [panelSlots.left]: Math.max(160, Math.min(800, d.startVal - (e.clientX - d.startX))) })); }}
                onPointerUp={() => { pointerDragRef.current = null; setIsResizing(false); }}
              >
                <div className="w-[2px] h-8 rounded-full bg-slate-400/0 group-hover:bg-slate-400/60 transition-colors" />
              </div>
            )}

            {/* SLOT 1 (LEFT) */}
            <aside {...slotDropProps('left')} className={`bg-white z-10 flex flex-col overflow-hidden rounded-2xl shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_16px_-8px_rgba(15,23,42,0.12)] ${isPanelShown(panelSlots.left) ? 'border border-slate-200' : 'border-0'} ${panelDropTarget === 'left' ? 'ring-2 ring-blue-400/40 ring-inset' : ''}`} style={{ width: isPanelShown(panelSlots.left) ? panelWidths[panelSlots.left] : 0, flexShrink: 1, transition: isResizing ? 'none' : 'width 0.45s cubic-bezier(0.4,0,0.2,1)' }}>
              {isPanelShown(panelSlots.left) && renderPanel(panelSlots.left)}
            </aside>

            {/* SLOT 1 <-> SLOT 2 RESIZE HANDLE */}
            {isPanelShown(panelSlots.left) && isPanelShown(panelSlots.compTableSlot) && (
              <div
                className="w-3 h-full flex-shrink-0 flex items-center justify-center cursor-col-resize group"
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
              className={`bg-white overflow-hidden flex flex-col rounded-2xl shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_16px_-8px_rgba(15,23,42,0.12)] h-full ${isPanelShown(panelSlots.compTableSlot) ? 'border border-slate-200' : 'border-0'} ${panelDropTarget === 'compTableSlot' ? 'ring-2 ring-blue-400/40 ring-inset' : ''}`}
              style={{ width: isPanelShown(panelSlots.compTableSlot) ? panelWidths[panelSlots.compTableSlot] : 0, flexShrink: isPanelShown(panelSlots.compTableSlot) ? 0 : 1, transition: isResizing ? 'none' : 'width 0.45s cubic-bezier(0.4,0,0.2,1)' }}
            >
              {isPanelShown(panelSlots.compTableSlot) && renderPanel(panelSlots.compTableSlot)}
            </aside>

            {/* SLOT 2 <-> SLOT 3 RESIZE HANDLE */}
            {isPanelShown(panelSlots.compTableSlot) && (
              <div
                className="w-3 h-full flex-shrink-0 flex items-center justify-center cursor-col-resize group"
                onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); pointerDragRef.current = { type: 'col-ct', startX: e.clientX, startY: e.clientY, startVal: panelWidths[panelSlots.compTableSlot], containerH: 0 }; setIsResizing(true); }}
                onPointerMove={(e) => { const d = pointerDragRef.current; if (!d || d.type !== 'col-ct') return; setPanelWidths(prev => ({ ...prev, [panelSlots.compTableSlot]: Math.max(160, Math.min(1200, d.startVal + (e.clientX - d.startX))) })); }}
                onPointerUp={() => { pointerDragRef.current = null; setIsResizing(false); }}
              >
                <div className="w-[2px] h-8 rounded-full bg-slate-400/0 group-hover:bg-slate-400/60 transition-colors" />
              </div>
            )}

            {/* SLOT 3 (FAR RIGHT SLOT) */}
            <aside
              {...slotDropProps('farRight')}
              className={`bg-white overflow-hidden flex flex-col rounded-2xl shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_16px_-8px_rgba(15,23,42,0.12)] h-full ${isPanelShown(panelSlots.farRight) ? 'border border-slate-200' : 'border-0'} ${panelDropTarget === 'farRight' ? 'ring-2 ring-blue-400/40 ring-inset' : ''}`}
              style={{ width: isPanelShown(panelSlots.farRight) ? panelWidths[panelSlots.farRight] : 0, flexShrink: 1, transition: isResizing ? 'none' : 'width 0.45s cubic-bezier(0.4,0,0.2,1)' }}
            >
              {isPanelShown(panelSlots.farRight) && renderPanel(panelSlots.farRight)}
            </aside>

            {/* SLOT 3 RIGHT RESIZE HANDLE */}
            {isPanelShown(panelSlots.farRight) && (
              <div
                className="w-3 h-full flex-shrink-0 flex items-center justify-center cursor-col-resize group"
                onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); pointerDragRef.current = { type: 'col-fr', startX: e.clientX, startY: e.clientY, startVal: panelWidths[panelSlots.farRight], containerH: 0 }; setIsResizing(true); }}
                onPointerMove={(e) => { const d = pointerDragRef.current; if (!d || d.type !== 'col-fr') return; setPanelWidths(prev => ({ ...prev, [panelSlots.farRight]: Math.max(160, Math.min(1200, d.startVal + (e.clientX - d.startX))) })); }}
                onPointerUp={() => { pointerDragRef.current = null; setIsResizing(false); }}
              >
                <div className="w-[2px] h-8 rounded-full bg-slate-400/0 group-hover:bg-slate-400/60 transition-colors" />
              </div>
            )}


          </div>

          {/* RIGHT COLUMN OVERLAY ??DC+My Options (???? ????측 고정) */}
          <div
            className="absolute top-3 bottom-0 right-3 flex z-40 transition-all duration-300"
            style={{ pointerEvents: rightPanelCollapsed ? 'none' : 'auto', height: 'calc(100% - 12px)' }}
          >
            {/* ??들: Option List <-> DC+My Options */}
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
                /* ??힌 ??태: 36px ??트????단 중앙 */
                <HoverTooltip label={locale === 'en' ? 'Expand panel' : '패널 펼치기'} side="left" className="absolute top-3 left-1/2 -translate-x-1/2">
                  <button
                    onClick={() => setRightPanelCollapsed(false)}
                    className="p-1.5 rounded-md text-slate-600 hover:bg-slate-100 transition-colors"
                  >
                    <PanelLeft className="w-4 h-4" />
                  </button>
                </HoverTooltip>
              ) : (
                <>
                  {/* ??기 버튼 */}
                  <div className="absolute top-3 right-3 z-10">
                    <HoverTooltip label={locale === 'en' ? 'Collapse panel' : '패널 접기'} side="left">
                      <button
                        onClick={() => setRightPanelCollapsed(true)}
                        className="p-1.5 rounded-md text-slate-600 hover:bg-slate-100 transition-colors"
                      >
                        <PanelRight className="w-4 h-4" />
                      </button>
                    </HoverTooltip>
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

        {/* INPUT BAR ????널 ???? ??른 ??널????향받?? ??는 ??립 ??역 */}
        <div className="flex-shrink-0 px-3 pb-3 pt-2 relative">
          {showScrollButton && (
            <button
              onClick={scrollToBottom}
              className="absolute left-1/2 -translate-x-1/2 top-0 z-10 h-8 w-8 rounded-full border border-slate-200 bg-white text-slate-400 shadow-xl flex items-center justify-center hover:text-slate-900 hover:border-slate-900 transition-all"
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
          )}
          <div className="max-w-2xl w-full mx-auto flex flex-col">
            {/* 최근 질문/응답 표시 — 이전 턴은 위로 밀려 사라지고 새 턴이 아래에서 올라온다.
                두 턴을 grid로 같은 셀에 겹쳐서(각각 flow에 쌓이지 않도록) 전환 중 두 턴의 높이가
                합산되어 위쪽 패널 경계가 순간적으로 튀는 것을 막는다. */}
            {(exitingDockTurn || currentDockTurn) && (
              <div className="grid">
                {exitingDockTurn && (
                  <DockTurnRow
                    key={`exit-${exitingDockTurn.id}`}
                    turn={exitingDockTurn}
                    userLabel="User"
                    className="[grid-area:1/1] animate-out fade-out slide-out-to-top-3 duration-[450ms] ease-in"
                  />
                )}
                {currentDockTurn && (
                  <DockTurnRow
                    key={currentDockTurn.id}
                    turn={currentDockTurn}
                    userLabel="User"
                    streaming={isStreaming && lastMessage?.role === 'assistant'}
                    className="[grid-area:1/1] animate-in fade-in slide-in-from-bottom-3 duration-500 ease-out"
                  />
                )}
              </div>
            )}

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
              className="relative z-0 flex items-end gap-2 bg-white/80 border border-indigo-300 rounded-[24px] p-1.5 pl-4 pr-2 shadow-lg shadow-indigo-200/40 hover:shadow-xl hover:border-indigo-400 transition-all focus-within:border-indigo-400 focus-within:ring-4 focus-within:ring-indigo-200/50 min-h-[40px]"
            >
              <div className="flex-1 flex flex-wrap items-center gap-1.5 min-w-0 max-h-[120px] overflow-y-auto py-1">
                {mentionChips.map((chip, i) => (<div key={`mention-${i}`} className="flex items-center gap-1.5 bg-slate-50 border border-slate-100 rounded-full px-2 py-0.5 h-[28px] shrink-0 animate-in zoom-in-95 duration-200"><span className="text-[12px] font-bold text-slate-800">{chip.name}</span><button onClick={() => setMentionChips(prev => prev.filter((_, idx) => idx !== i))} className="ml-1 p-0.5 text-slate-300 hover:text-slate-900 transition-colors"><X className="w-2.5 h-2.5" /></button></div>))}
                {searchCriteria.map((c, i) => (<div key={`criteria-${i}`} className="flex items-center gap-1.5 bg-slate-50 border border-slate-100 rounded-full px-2 py-0.5 h-[28px] shrink-0 animate-in zoom-in-95 duration-200"><span className="text-[12px] font-bold text-slate-800">{c.name}</span>{c.min && <span className="text-[10px] text-slate-500 font-medium">{c.min}</span>}<button onClick={() => setSearchCriteria(prev => prev.filter((_, idx) => idx !== i))} className="ml-1 p-0.5 text-slate-300 hover:text-slate-900 transition-colors"><X className="w-2.5 h-2.5" /></button></div>))}
                <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} placeholder={(searchCriteria.length > 0 || mentionChips.length > 0) ? "" : T.askAnything} rows={1} className="flex-1 min-w-[120px] bg-transparent border-none focus:ring-0 focus:outline-none focus-visible:ring-0 resize-none text-slate-800 placeholder:text-slate-400 py-0.5 text-[14px] font-medium" />
              </div>
              {(() => {
                const isInputEmpty = !input.trim() && searchCriteria.length === 0 && mentionChips.length === 0;
                const isSubmitDisabled = isInputEmpty || isStreaming;
                return (
                  <button onClick={() => handleSubmit()} disabled={isSubmitDisabled} className="w-9 h-9 rounded-full flex items-center justify-center transition-all shadow-sm shrink-0 self-end mb-0.5 bg-indigo-300 text-white hover:bg-indigo-400 active:scale-95 disabled:bg-indigo-100 disabled:text-white disabled:hover:bg-indigo-100 disabled:active:scale-100 disabled:shadow-none disabled:cursor-default border-0">
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

