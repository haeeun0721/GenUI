"use client";

import { useState, useCallback, useMemo, memo, useRef, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  Sparkles,
  User,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

// =============================================================================
// Types
// =============================================================================

type AppMessage = UIMessage;

// =============================================================================
// Transport
// =============================================================================

const transport = new DefaultChatTransport({ api: "/api/generate" });

// 참여자가 "구매 목적 및 상황"에 최소한의 구체성을 담도록 강제하는 하한선 —
// 한두 단어짜리 성의 없는 답만 걸러내는 낮은 문턱이라 값을 크게 올리지 않는다.
const MIN_CONTEXT_LENGTH = 20;

// =============================================================================
// Tool Call Display
// =============================================================================

const TOOL_LABELS: Record<string, [string, string]> = {
  search_products: ["Searching products", "Searched products"],
  web_search: ["Searching the web", "Searched the web"],
};

// 사용자 메시지 원문에서 서버 전용 태그([USER CONTEXT:...] 등)를 걷어낸 표시용 텍스트.
function extractUserDisplayText(rawText: string): string {
  return rawText
    .split(/\n{1,2}\[USER CONTEXT:/i)[0]
    .split(/\n{1,2}\[ASSIGNED ITEM:/i)[0]
    .split(/\n{1,2}\[PARTICIPANT ID:/i)[0]
    .trim();
}

function ToolCallDisplay({
  toolName,
  state,
}: {
  toolName: string;
  state: string;
}) {
  const isLoading =
    state !== "output-available" &&
    state !== "output-error" &&
    state !== "output-denied";
  const labels = TOOL_LABELS[toolName];
  const label = labels ? (isLoading ? labels[0] : labels[1]) : toolName;

  return (
    <div className="text-sm">
      <span
        className={`text-muted-foreground ${isLoading ? "animate-shimmer" : ""}`}
      >
        {label}
      </span>
    </div>
  );
}

// =============================================================================
// Message Bubble
// =============================================================================

const MessageBubble = memo(({
  message,
  isLast,
  isStreaming,
}: {
  message: AppMessage;
  isLast: boolean;
  isStreaming: boolean;
}) => {
  const isUser = message.role === "user";

  const segments = useMemo(() => {
    const result: Array<
      | { kind: "text"; content: string }
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
        const last = result[result.length - 1];
        if (last?.kind === "text") last.content += part.text;
        else result.push({ kind: "text", content: part.text });
      } else if (part.type.startsWith("tool-")) {
        const toolName = (part as any).toolName || part.type.replace(/^tool-/, "");
        const toolInfo = {
          toolCallId: (part as any).toolCallId,
          toolName,
          state: part.type === "tool-result" ? "result" : part.type === "tool-call" ? "call" : (part as any).state,
          output: (part as any).result ?? (part as any).output,
        };
        const last = result[result.length - 1];
        if (last?.kind === "tools") last.tools.push(toolInfo);
        else result.push({ kind: "tools", tools: [toolInfo] });
      }
    });

    return result;
  }, [message.parts]);

  const hasAnything = segments.length > 0;
  const showLoader = isLast && isStreaming && message.role === "assistant" && !hasAnything;

  if (isUser) {
    const rawText = message.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as any).text)
      .join("");
    const userText = extractUserDisplayText(rawText);

    if (!userText) return null;

    return (
      <div className="flex justify-end w-full">
        <div className="max-w-[85%] flex flex-col items-end gap-2">
          <div
            className="rounded-2xl px-4 py-2.5 leading-relaxed whitespace-pre-wrap bg-slate-900 text-white rounded-tr-md break-words"
            style={{
              fontSize: userText.length > 120 ? '13px' : userText.length > 60 ? '14px' : '15px',
            }}
          >
            {userText}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col gap-3 relative group/message">
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          if (!seg.content.trim()) return null;
          return (
            <div
              key={`text-${i}`}
              className="relative z-10 text-[15px] leading-relaxed text-slate-800 [&_p+p]:mt-3 [&_ul]:mt-2 [&_ol]:mt-2 [&_pre]:mt-2 [&_table]:mt-2! [&_table]:w-full! [&_table]:border-collapse! [&_table]:overflow-hidden! [&_table]:rounded-xl! [&_table]:border! [&_table]:border-indigo-100! [&_thead]:bg-indigo-100! [&_th]:text-indigo-900! [&_th]:font-bold! [&_th]:border-b! [&_th]:border-indigo-200! [&_td]:border-b! [&_td]:border-indigo-50! [&_tbody_tr:hover]:bg-indigo-50! [&_tbody_tr:last-child_td]:border-b-0! [&_table_a]:text-indigo-600! [&_table_a]:no-underline! [&_table_a:hover]:underline!"
            >
              <Streamdown plugins={{ code }} animated={false} linkSafety={{ enabled: false }} controls={{ table: false }}>
                {seg.content}
              </Streamdown>
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
// Chat Page
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
  const [userContext, setUserContext] = useState(() =>
    typeof window !== 'undefined' ? (localStorage.getItem('gs_userContext') ?? '') : ''
  );
  const [assignedItem, setAssignedItem] = useState<"A" | "B" | "C" | "">('');

  const T = {
    greeting: locale === 'en' ? 'Hello, ' : '안녕하세요, ',
    greetingSuffix: locale === 'en' ? '' : '님',
    askAnything: locale === 'en' ? 'Ask me anything' : '무엇이든 물어보세요',
    participantId: locale === 'en' ? 'PARTICIPANT ID' : '참여자 ID',
    assignedItem: locale === 'en' ? 'ASSIGNED ITEM' : '배정받은 아이템',
    purchaseContext: locale === 'en' ? 'PURCHASE CONTEXT' : '구매 목적 및 상황',
    contextPlaceholder: locale === 'en'
      ? (assignedItem === 'B'
        ? 'e.g. I have a cat and want to keep my home clean without much effort every day. I don\'t have much time to spend on cleaning.'
        : assignedItem === 'C'
          ? 'e.g. I want to take beautiful landscape and portrait photos while traveling. I will also shoot vlogs.'
          : 'e.g. I go out often alone. Lightweight and portable is important.')
      : (assignedItem === 'B'
        ? '고양이를 키우고 있어서 매일 편하게 집을 청소하고 싶어요. 청소에 시간을 많이 쓰기는 어려운 편이에요.'
        : assignedItem === 'C'
          ? '여행 다니면서 풍경이나 인물 사진을 예쁘게 찍고 싶어요. 브이로그 촬영도 할 거예요.'
          : '외출이 잦아서 혼자 쓰기에 가볍고 휴대성이 좋은 게 중요해요.'),
    contextMinHint: locale === 'en'
      ? (n: number) => `At least ${MIN_CONTEXT_LENGTH} characters (${n}/${MIN_CONTEXT_LENGTH})`
      : (n: number) => `최소 ${MIN_CONTEXT_LENGTH}자 이상 (${n}/${MIN_CONTEXT_LENGTH})`,
    getStarted: locale === 'en' ? 'Get Started' : '시작하기',
    robotVacuum: locale === 'en' ? 'Robot Vacuum' : '로봇 청소기',
    camera: locale === 'en' ? 'Camera' : '카메라',
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isStickToBottom = useRef(true);
  const isAutoScrolling = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const { messages, sendMessage, setMessages, status, error } =
    useChat<AppMessage>({ transport });

  const isStreaming = status === "streaming" || status === "submitted";

  const resetSession = useCallback(() => {
    localStorage.removeItem('gs_hasStarted');
    localStorage.removeItem('gs_participantId');
    localStorage.removeItem('gs_userContext');
    localStorage.removeItem('gs_assignedItem');
    setMessages([]);
    setInput("");
    setHasStarted(false);
  }, [setMessages]);

  // locale 변경 시 localStorage + 쿠키에 기록 (API 요청에 자동 전송됨)
  useEffect(() => {
    localStorage.setItem('gs_locale', locale);
    document.cookie = `gs_locale=${locale};path=/;max-age=86400`;
    document.documentElement.lang = locale;
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
    const container = scrollContainerRef.current;
    if (!container) return;
    const THRESHOLD = 80;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const atBottom = scrollTop + clientHeight >= scrollHeight - THRESHOLD;
      if (isAutoScrolling.current) {
        if (atBottom) isAutoScrolling.current = false;
        return;
      }
      isStickToBottom.current = atBottom;
      setShowScrollButton(!atBottom);
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

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
      if (!message.trim() || isStreaming) return;
      setInput("");
      isStickToBottom.current = true;

      const userContextTag = userContext.trim() ? `\n\n[USER CONTEXT: ${userContext.trim()}]` : "";
      const assignedItemTag = assignedItem ? `\n\n[ASSIGNED ITEM: ${assignedItem}]` : "";
      // 참가자별 공유 메모리(session-memory.ts) 키로 서버가 사용 — 대화가 참가자 단위로 이어지게
      // 하려면 매 요청에 실어 보내야 한다.
      const participantIdTag = participantId.trim() ? `\n\n[PARTICIPANT ID: ${participantId.trim()}]` : "";

      await sendMessage({ text: message.trim() + userContextTag + assignedItemTag + participantIdTag });
    },
    [input, isStreaming, sendMessage, userContext, assignedItem, participantId],
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

  // ---------------------------------------------------------------------------
  // Purchase (study completion action) — baseline has no structured cart/criteria
  // state to pull a final selection from, so we just ask for the product name directly.
  // ---------------------------------------------------------------------------
  const [showPurchaseModal, setShowPurchaseModal] = useState(false);
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [purchaseProductName, setPurchaseProductName] = useState("");
  const [confirmedProductName, setConfirmedProductName] = useState("");
  const [confirmedAt, setConfirmedAt] = useState<Date | null>(null);
  const [purchaseConfirmed, setPurchaseConfirmed] = useState(false);

  const handlePurchaseClick = useCallback(() => {
    if (participantId.trim()) {
      fetch('/api/log-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'purchase_clicked', participantId: participantId.trim() }),
      }).catch((err) => console.error('[logEvent] purchase_clicked failed:', err));
    }
    setShowPurchaseModal(true);
  }, [participantId]);

  const handlePurchaseConfirm = useCallback(() => {
    if (!purchaseProductName.trim()) return;
    if (participantId.trim()) {
      fetch('/api/log-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'purchase_confirmed',
          participantId: participantId.trim(),
          finalProductName: purchaseProductName.trim(),
        }),
      }).catch((err) => console.error('[logEvent] purchase_confirmed failed:', err));
    }
    setConfirmedProductName(purchaseProductName.trim());
    setConfirmedAt(new Date());
    setShowPurchaseModal(false);
    setPurchaseConfirmed(true);
    setShowReceiptModal(true);
  }, [participantId, purchaseProductName]);

  // Purely decorative barcode — bar widths derived from the entered product name
  // so it looks different per receipt without meaning anything.
  const barcodeBars = useMemo(() => {
    const seed = confirmedProductName || 'genuidance';
    return Array.from({ length: 34 }, (_, i) => (seed.charCodeAt(i % seed.length) % 3) + 1);
  }, [confirmedProductName]);

  if (!isMounted) return null;

  if (!hasStarted) {
    const isContextLongEnough = userContext.trim().length >= MIN_CONTEXT_LENGTH;
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
              onKeyDown={(e) => { if (e.key === "Enter" && participantId.trim() && assignedItem && isContextLongEnough) setHasStarted(true); }}
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
            <span className={`text-[12px] font-medium ${isContextLongEnough ? 'text-emerald-500' : 'text-slate-400'}`}>
              {T.contextMinHint(userContext.trim().length)}
            </span>
          </div>

          {/* Start button */}
          <button
            onClick={() => {
              if (participantId.trim() && assignedItem && isContextLongEnough) {
                const assignedItemLabel = assignedItem === "B" ? "로봇 청소기" : assignedItem === "C" ? "카메라" : assignedItem;
                fetch('/api/log-event', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    type: 'session_start',
                    participantId: participantId.trim(),
                    assignedItem: assignedItemLabel,
                    purchaseContext: userContext.trim(),
                    locale,
                  }),
                }).catch((err) => console.error('[logEvent] session_start failed:', err));
                setHasStarted(true);
              }
            }}
            disabled={!participantId.trim() || !assignedItem || !isContextLongEnough}
            className="w-full py-4 rounded-[8px] text-white text-[16px] font-semibold tracking-tight active:scale-[0.98] transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ backgroundColor: "#000000" }}
          >
            {T.getStarted}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-full flex flex-col bg-[#F4F6FB] overflow-hidden">
      {/* Full-width header */}
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
          <div className="flex items-center gap-1.5 text-[15px] font-medium select-none">
            <button
              onClick={() => setLocale('en')}
              disabled={locale === 'en'}
              className="transition-colors duration-150 disabled:cursor-not-allowed"
              style={{ color: locale === 'en' ? '#0f172a' : '#94a3b8', fontWeight: locale === 'en' ? 700 : 400 }}
            >EN</button>
            <span className="text-slate-300">|</span>
            <button
              onClick={() => setLocale('ko')}
              disabled={locale === 'ko'}
              className="transition-colors duration-150 disabled:cursor-not-allowed"
              style={{ color: locale === 'ko' ? '#0f172a' : '#94a3b8', fontWeight: locale === 'ko' ? 700 : 400 }}
            >KO</button>
          </div>
        </div>
      </div>

      {/* Chat thread */}
      <div className="flex-1 min-h-0 flex flex-col relative">
        <main ref={scrollContainerRef} className="flex-1 overflow-y-auto px-8 pb-6 no-scrollbar scroll-smooth">
          <div className="max-w-2xl mx-auto space-y-12 pb-8 pt-8">
            {messages.map((m, idx) => (
              <MessageBubble
                key={m.id}
                message={m}
                isLast={idx === messages.length - 1}
                isStreaming={isStreaming && idx === messages.length - 1}
              />
            ))}
            {isStreaming && messages[messages.length - 1]?.role === "user" && (
              <div className="flex items-center gap-1 h-4" aria-label={locale === "en" ? "Thinking" : "생각 중"}>
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: "0ms" }} />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: "0.2s" }} />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: "0.4s" }} />
              </div>
            )}
            {error && (
              <div className="p-4 rounded-2xl bg-red-50 border border-red-100 text-red-600 text-sm font-medium">
                {error.message}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </main>
      </div>

      {/* Input bar */}
      <div className="flex-shrink-0 px-3 pb-3 pt-2 relative">
        {showScrollButton && (
          <button
            onClick={scrollToBottom}
            className="absolute left-1/2 -translate-x-1/2 top-0 z-10 h-8 w-8 rounded-full border border-slate-200 bg-white text-slate-400 shadow-xl flex items-center justify-center hover:text-slate-900 hover:border-slate-900 transition-all"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        )}
        <div className="max-w-3xl w-full mx-auto flex items-end gap-3">
          <div className="relative z-0 flex-1 flex items-end gap-2 bg-white/80 border border-indigo-300 rounded-[24px] p-1.5 pl-4 pr-2 shadow-lg shadow-indigo-200/40 hover:shadow-xl hover:border-indigo-400 transition-all focus-within:border-indigo-400 focus-within:ring-4 focus-within:ring-indigo-200/50 min-h-[40px]">
            <div className="flex-1 flex flex-wrap items-center gap-1.5 min-w-0 max-h-[120px] overflow-y-auto py-1">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={T.askAnything}
                rows={1}
                className="flex-1 min-w-[120px] bg-transparent border-none focus:ring-0 focus:outline-none focus-visible:ring-0 resize-none text-slate-800 placeholder:text-slate-400 py-0.5 text-[15px] font-medium"
              />
            </div>
            <button
              onClick={() => handleSubmit()}
              disabled={!input.trim() || isStreaming}
              className="w-9 h-9 rounded-full flex items-center justify-center transition-all shadow-sm shrink-0 self-end mb-0.5 bg-indigo-300 text-white hover:bg-indigo-400 active:scale-95 disabled:bg-indigo-100 disabled:text-white disabled:hover:bg-indigo-100 disabled:active:scale-100 disabled:shadow-none disabled:cursor-default border-0"
            >
              {isStreaming ? (
                <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
              ) : (
                <ArrowUp className={`h-4 w-4 ${!input.trim() ? "stroke-[1.5px]" : "stroke-[2.5px]"}`} />
              )}
            </button>
          </div>
          <button
            type="button"
            onClick={handlePurchaseClick}
            className="shrink-0 h-[46px] px-5 rounded-[24px] text-white text-[14px] font-semibold shadow-sm hover:opacity-90 active:scale-95 transition-all flex items-center gap-1.5"
            style={{ backgroundColor: "#000000" }}
          >
            {purchaseConfirmed && <span>✓</span>}
            {locale === 'en' ? 'Purchase' : '구매하기'}
          </button>
        </div>
      </div>

      {/* Purchase confirmation modal */}
      {showPurchaseModal && (
        <div
          className="fixed inset-0 z-30 bg-black/30 flex items-center justify-center px-6"
          onClick={() => setShowPurchaseModal(false)}
        >
          <div
            className="bg-white rounded-2xl p-6 w-full max-w-sm flex flex-col gap-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[16px] font-bold text-slate-900">
              {locale === 'en' ? 'Which product did you finally choose?' : '최종적으로 어떤 제품을 선택하셨나요?'}
            </h3>
            <input
              type="text"
              value={purchaseProductName}
              onChange={(e) => setPurchaseProductName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handlePurchaseConfirm(); }}
              placeholder={locale === 'en' ? 'Product name' : '제품명을 입력해주세요'}
              autoFocus
              className="w-full border border-slate-200 rounded-[8px] px-4 py-3 text-[14px] font-medium text-slate-800 placeholder:text-slate-300 outline-none focus:border-slate-400 transition-colors"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowPurchaseModal(false)}
                className="px-4 py-2 rounded-[8px] text-[13px] font-semibold text-slate-500 hover:text-slate-700 transition-colors"
              >
                {locale === 'en' ? 'Cancel' : '취소'}
              </button>
              <button
                onClick={handlePurchaseConfirm}
                disabled={!purchaseProductName.trim()}
                className="px-4 py-2 rounded-[8px] text-[13px] font-semibold text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                style={{ backgroundColor: "#000000" }}
              >
                {locale === 'en' ? 'Confirm' : '확인'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Purchase receipt — full-screen takeover, styled after the treatment system's receipt */}
      {showReceiptModal && (
        <div
          className="fixed inset-0 z-30 bg-[#FAFAFA] flex flex-col items-center justify-center px-6 gap-8 overflow-y-auto py-12 cursor-pointer"
          onClick={() => setShowReceiptModal(false)}
        >
          <h2 className="text-[26px] font-extrabold text-slate-900 tracking-tight text-center">
            {locale === 'en' ? 'Payment Complete' : '결제가 완료되었습니다'}
          </h2>

          <div
            className="w-full max-w-md bg-white rounded-[20px] overflow-hidden cursor-default"
            style={{ boxShadow: "0 0 40px rgba(15, 23, 42, 0.10)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-7 py-4 border-b border-slate-100 text-[13px] text-slate-400 font-medium">
              <span>
                {confirmedAt
                  ? confirmedAt.toLocaleDateString(locale === 'en' ? 'en-US' : 'ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })
                  : ''}
              </span>
              <span>
                {confirmedAt
                  ? confirmedAt.toLocaleTimeString(locale === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit' })
                  : ''}
              </span>
            </div>

            <div className="px-7 pt-5 text-[12px] font-semibold text-slate-400">
              <span>{locale === 'en' ? 'Final Selection' : '최종 선택 제품'}</span>
            </div>
            <div className="px-7 py-4">
              <span className="text-[16px] font-bold text-slate-900 leading-snug">{confirmedProductName}</span>
            </div>

            <div className="border-t border-dashed border-slate-200 mx-7" />

            <div className="flex flex-col items-center py-6">
              <svg width={barcodeBars.reduce((sum, w) => sum + w * 2 + 2, 0)} height="44" className="text-slate-900">
                {(() => {
                  let x = 0;
                  return barcodeBars.map((w, i) => {
                    const bar = <rect key={i} x={x} y={0} width={w * 2} height={40} fill="currentColor" />;
                    x += w * 2 + 2;
                    return bar;
                  });
                })()}
              </svg>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
