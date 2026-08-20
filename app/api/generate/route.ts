import { analyzeIntent } from "@/lib/backend/agents/intent_analyzer";
import { routeAction } from "@/lib/backend/agents/action_router";
import { selectTemplate } from "@/lib/backend/agents/template_selector";
import { planEdit } from "@/lib/backend/agents/edit_agent";
import { buildCriteriaMapSystem, buildCriteriaMapPrompt } from "@/lib/backend/agents/generators/criteria_map";
import { buildInformationCardSystem, buildInformationCardPrompt } from "@/lib/backend/agents/generators/information_card";
import { buildCommonSystemInstructions, EDGE_CASES_SYSTEM, UI_AGENT_MODEL } from "@/lib/backend/agents/generators/shared";
import { renderToOptionList } from "@/lib/backend/tools/render-to-option-list";
import { renderToCompTable } from "@/lib/backend/tools/render-to-comp-table";
import { mutateSurface } from "@/lib/backend/tools/mutate-surface";
import { mutateComparisonTable } from "@/lib/backend/tools/mutate-comptable";
import { mutateCriteriaMap } from "@/lib/backend/tools/mutate-criteria-map";
import { minuteRateLimit, dailyRateLimit } from "@/lib/backend/rate-limit";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type UIMessage,
  type ModelMessage,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { SPEC_DATA_PART_TYPE } from "@json-render/core";
import { headers } from "next/headers";
import {
  initSidePanelStore,
  popSidePanelResults,
  setCurrentRequestId,
  initOptionListStore,
  popOptionListResults,
  initCompTableStore,
  popCompTableResults,
  initMutateSurfaceStore,
  popMutateSurfaceResults,
  setCurrentUserContext,
  currentUserContext,
  setCurrentMessages,
  setCurrentSavedItems,
  setCurrentDecisionCriteria,
  setCurrentMyItemsContextSummary,
  setCurrentMyItemsRaw,
  setCurrentProductCategory,
  setCurrentLocale,
  setCurrentOptionListCards,
  setCurrentComparisonTableCells,
  setCurrentParticipantId,
} from "@/lib/backend/tools/sidebar-store";
import { findProductInLocalDB } from "@/lib/backend/agents/data_agent";
import { streamChatReply } from "@/lib/backend/agents/chat_agent";
import { loadMemory, appendMemoryTurn } from "@/lib/backend/services/session-memory";
import { logChatTurn } from "@/lib/backend/services/research-log";
import { time, logElapsed } from "@/lib/backend/timing";

export const maxDuration = 60;

/**
 * intent_analyzer / CriteriaMap·InformationCard 생성 / "none" 잡담 응답처럼 "지금까지 무슨
 * 대화가 오갔는지"만 필요한 소비자를 위해, tool 호출/결과(카드·표 JSON 등 무거운 구조화
 * 데이터)를 걷어낸 history를 만든다. 그 데이터 자체가 필요한 소비자(edit_agent 등)는 이
 * 함수를 쓰지 않고 ctx의 큐레이션된 스냅샷(currentProducts/currentComparisonTable 등)을 쓴다.
 *
 * 예전엔 이 세 곳 모두 원본 modelMessages를 그대로 받아서, 이전 턴에 생성된 상품 카드/표
 * JSON이 반복적으로 등장하는 걸 모델이 "지금 이 턴의 주제"로 착각해 최신 메시지와 무관한
 * 응답을 내는 문제가 있었다(예: 옛 검색 조건이 최신 질문의 user_goal로 잘못 나옴).
 *
 * renderToOptionList/renderToCompTable처럼 텍스트 없이 tool-call만 있는 턴은(=화면 결과만
 * 만들고 말로 답하지 않은 턴) 아래에서 통째로 걸러지는데, 그러면 그 직전 사용자 메시지가
 * "답변을 하나도 못 받은 질문"처럼 히스토리에 붕 뜬 채로 남는다. 이런 턴이 여러 번 쌓이면
 * (예: 흡입력 조건 검색을 반복) 다음 "none" 잡담 응답이 최신 질문에 답하기 전에 그 옛
 * "안 끝난 것처럼 보이는" 질문부터 다시 짚고 넘어가려다 최신 질문과 무관한 내용이 답변
 * 앞부분에 섞여 나오는 원인이 됐다 — 완전히 지우는 대신 최소한의 자리표시자를 남긴다.
 */
function buildCompactHistory(messages: ModelMessage[]): ModelMessage[] {
  const compact: ModelMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "tool") continue; // 순수 tool-result 캐리어 — 텍스트 대화 흐름에 불필요
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        compact.push(msg.content.trim() ? msg : { ...msg, content: "(화면을 갱신했습니다)" });
        continue;
      }
      const textParts = (msg.content as any[]).filter((p) => p?.type === "text" && p.text?.trim());
      if (textParts.length > 0) {
        compact.push({ ...msg, content: textParts } as ModelMessage);
      } else if ((msg.content as any[]).some((p) => p?.type === "tool-call")) {
        compact.push({ ...msg, content: "(화면을 갱신했습니다)" } as ModelMessage);
      }
      continue;
    }
    compact.push(msg); // user/system 메시지는 이미 STRIP_PATTERNS로 정제됨 — 그대로 유지
  }
  return compact;
}

export async function POST(req: Request) {
  const requestStartedAt = Date.now();
  const headersList = await headers();
  const ip = headersList.get("x-forwarded-for")?.split(",")[0] ?? "anonymous";

  const [minuteResult, dailyResult] = await time("rate_limit", ip, () => Promise.all([
    minuteRateLimit.limit(ip),
    dailyRateLimit.limit(ip),
  ]));

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
  initMutateSurfaceStore(requestId);
  setCurrentMessages(uiMessages);

  // Read locale from cookie (set by frontend toggle)
  const cookieHeader = headersList.get("cookie") ?? "";
  const localeCookie = cookieHeader.split(";").find(c => c.trim().startsWith("gs_locale="));
  const locale = (localeCookie?.split("=")[1]?.trim() ?? "ko") as "ko" | "en";
  setCurrentLocale(locale);

  // "[Decision Criteria : ...]" (검색창에 기준 칩을 끌어놓았을 때 붙는 표시용 prefix — app/page.tsx
  // handleSubmit의 visibleCriteria)를 자연어로 정규화한다. 대소문자·콜론 앞 공백이 아래 전역
  // "[DECISION CRITERIA: ...]" (사이드패널 저장 기준 목록) 태그와 달라 STRIP_PATTERNS 어디에도
  // 안 걸려 그대로 새어나갔었다 — Intent Analyzer/Action Router/Edit Agent가 이 대괄호 태그
  // 원문을 사용자 발화로 그대로 받아 criteriaMap 항목("가격대")에 대한 edit 요청으로 오분류하는
  // 원인이 됐다. app/page.tsx의 extractUserDisplayText(표시 전용 정규화)와 동일한 치환을
  // 백엔드로 넘어가는 텍스트에도 적용해 LLM에는 항상 자연어만 보이게 한다. ^ 앵커로 문자열
  // 맨 앞에서만 매칭하므로, 항상 "\n\n"이 앞에 붙는 전역 "[DECISION CRITERIA: ...]" 태그와는
  // 섞이지 않는다.
  const normalizeDecisionCriteriaPrefix = (text: string) =>
    text.replace(/^\[Decision Criteria\s*:([^\]]*)\]\s*/i, '"$1" ');

  // Extract USER CONTEXT directly from the latest user message (bypasses LLM)
  const latestUserMsg = [...uiMessages].reverse().find(m => m.role === "user");
  const latestText = normalizeDecisionCriteriaPrefix(
    latestUserMsg?.parts
      ?.filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("") ?? ""
  );
  const userContextMatch = latestText.match(/\[USER CONTEXT:\s*([^\]]+)\]/);
  const userContext = userContextMatch ? userContextMatch[1].trim() : "";
  setCurrentUserContext(userContext);

  // Extract MY ITEMS with specs from message text
  const myItemsMatch = latestText.match(/\[CONTEXT: User has these items in 'MY ITEMS' cart: ([^\]]+)\]/);
  const myItemsList = myItemsMatch
    ? myItemsMatch[1].split(" / ").map((s: string) => s.trim()).filter(Boolean)
    : [];
  setCurrentSavedItems(myItemsList);

  // Extract DECISION CRITERIA from message and store for UI Agent use
  const decisionCriteriaMatch = latestText.match(/\[DECISION CRITERIA:\s*(.*?)\](?=\n|$)/i);
  function splitCriteriaRespectingParens(str: string): string[] {
    const result: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of str) {
      if (ch === "(") { depth++; current += ch; }
      else if (ch === ")") { depth--; current += ch; }
      else if (ch === "," && depth === 0) { const t = current.trim(); if (t) result.push(t); current = ""; }
      else { current += ch; }
    }
    const t = current.trim(); if (t) result.push(t);
    return result;
  }
  const decisionCriteriaList = decisionCriteriaMatch
    ? splitCriteriaRespectingParens(decisionCriteriaMatch[1])
    : [];
  setCurrentDecisionCriteria(decisionCriteriaList);

  // Extract ASSIGNED ITEM and map to product category for agent persona
  const assignedItemMatch = latestText.match(/\[ASSIGNED ITEM:\s*([^\]]+)\]/);
  const assignedItem = assignedItemMatch ? assignedItemMatch[1].trim() : "";
  const productCategory = assignedItem === "A" ? "유모차" : assignedItem === "B" ? "로봇 청소기" : assignedItem === "C" ? "카메라" : "";
  setCurrentProductCategory(productCategory);

  // Extract PARTICIPANT ID — 참가자별 공유 메모리(session-memory.ts)의 키.
  const participantIdMatch = latestText.match(/\[PARTICIPANT ID:\s*([^\]]+)\]/);
  const participantId = participantIdMatch ? participantIdMatch[1].trim() : "";
  setCurrentParticipantId(participantId);

  // Pre-fetch My Items product data BEFORE the Conversation Agent runs.
  const myItemsTagMatch = latestText.match(/\[My items\s*:\s*([^\]]+)\]/i);
  const myItemsRaw = myItemsTagMatch
    ? myItemsTagMatch[1].split(",").map((s: string) => s.trim()).filter(Boolean)
    : [];
  setCurrentMyItemsRaw(myItemsRaw);

  let myItemsContextSummary = "";
  if (myItemsRaw.length > 0) {
    console.log(`[Route] Looking up ${myItemsRaw.length} My Items from local DB...`);
    const summaries: string[] = [];
    for (const entry of myItemsRaw) {
      const pipeIdx = entry.indexOf("|");
      const name = pipeIdx !== -1 ? entry.slice(0, pipeIdx).trim() : entry.trim();
      const summary = findProductInLocalDB(productCategory, name);
      if (summary) {
        // "My items" 태그의 name은 이미 Option List 카드가 쓰는 정식 이름이므로,
        // 부분일치로 찾았을 때 findProductInLocalDB가 DB 자체의 Name:으로 바꿔치기하는 걸
        // 되돌린다 — 안 그러면 Option List와 ComparisonTable이 같은 제품을 다른 이름(다른
        // 캐시 키)으로 취급해 스펙 조회가 따로 놀게 된다.
        const fixedSummary = summary.replace(/^Name:.*$/m, `Name: ${name}`);
        summaries.push(fixedSummary);
        console.log(`[LocalDB] Found: "${name}"`);
      } else {
        console.warn(`[LocalDB] Not found: "${name}" — skipping`);
      }
    }
    myItemsContextSummary = summaries.join("\n\n");
    setCurrentMyItemsContextSummary(myItemsContextSummary);
    console.log(`[Route] Local DB lookup complete. ${summaries.length}/${myItemsRaw.length} products found.`);
  } else {
    setCurrentMyItemsContextSummary("");
  }

  // Strip context tags from user messages before passing to the agent. 이 정제된
  // modelMessages는 대화 히스토리 전체(과거 모든 턴)에 적용되므로, CURRENT_OPTION_LIST/
  // CURRENT_COMPARISON_TABLE/CURRENT_CRITERIA_MAP처럼 턴마다 새로 통째로 붙는 큰 태그도
  // 반드시 걷어내야 한다 — 안 그러면 대화가 길어질수록 과거 턴들의 상품목록/표/기준맵
  // JSON이 전부 누적되어 매 LLM 호출(예: CriteriaMap/InformationCard 생성, 잡담 응답)에
  // 그대로 실려나간다. 순서 중요: CRITERIA_MAP은 항상 문자열 끝까지 캡처하는 태그라
  // COMPARISON_TABLE/OPTION_LIST보다 먼저 지워야 그 둘의 "다음 태그까지" 경계가 맞다.
  const STRIP_PATTERNS = [
    /\n{0,2}\[CURRENT_CRITERIA_MAP\][\s\S]*$/g,
    /\n{0,2}\[CURRENT_COMPARISON_TABLE\]\n[\s\S]*?(?=\n\[|$)/g,
    /\n{0,2}\[CURRENT_OPTION_LIST\]\n[\s\S]*?(?=\n\[|$)/g,
    /\n{0,2}\[USER CONTEXT:[^\]]+\]/g,
    /\n{0,2}\[DECISION CRITERIA:(?:[^\[\]]|\[[^\]]*\])*\]/gi,
    /\n{0,2}\[CONTEXT:[^\]]+\]/gi,
    /\n{0,2}\[ASSIGNED ITEM:[^\]]+\]/gi,
    /\n{0,2}\[PARTICIPANT ID:[^\]]+\]/gi,
  ];
  // [My items: ...] 태그는 다른 태그와 달리 그냥 지우지 않고 사람이 읽을 수 있는 이름
  // 목록으로 치환한다 — 그냥 지우면 제품 칩을 클릭해 "이 세 가지 제품을 비교해줘"처럼
  // 지시대명사로 말한 과거 턴이 히스토리에서 어떤 제품이었는지 통째로 사라져, 이후 턴에서
  // intent_analyzer/edit_agent 등이 그 맥락을 다시 못 찾는다.
  const MY_ITEMS_PATTERN = /\n{0,2}\[My items\s*:([^\]]+)\]/gi;
  const sanitizedMessages: typeof uiMessages = uiMessages.map(msg => {
    if (msg.role !== "user") return msg;
    return {
      ...msg,
      parts: msg.parts.map((p: any) => {
        if (p.type !== "text") return p;
        let text = normalizeDecisionCriteriaPrefix(p.text);
        text = text.replace(MY_ITEMS_PATTERN, (_m: string, list: string) => {
          const names = list.split(',').map((s: string) => s.split('|')[0].trim()).filter(Boolean);
          return names.length > 0 ? ` "${names.join(', ')}"` : '';
        });
        for (const pattern of STRIP_PATTERNS) text = text.replace(pattern, "");
        return { ...p, text };
      }),
    };
  });

  const modelMessages = await convertToModelMessages(sanitizedMessages);
  const compactModelMessages = buildCompactHistory(modelMessages);
  const hasOptionList = latestText.includes('[CURRENT_OPTION_LIST');
  // Extract full product data (id + name + numeric price + specs) from CURRENT_OPTION_LIST.
  // JSON 왕복(app/page.tsx가 JSON.stringify로 씀) — ComparisonTable/CriteriaMap과 동일한 프로토콜.
  const optionListMatch = latestText.match(/\[CURRENT_OPTION_LIST[^\]]*\]\n([\s\S]*?)(?=\n\[|$)/);
  interface CurrentProduct { id: string; name: string; priceNum: number | null; priceStr: string; specs: string[]; }
  let currentProducts: CurrentProduct[] = [];
  // 이 Option List를 만들 때 썼던 원래 검색 제약(예: "흡입력 4,500pa 이상") — page.tsx가
  // {cards, searchQuery} 형태로 같이 보낸다. Edit Agent가 대화 히스토리를 못 보므로, 후속
  // "add" 요청에서 이 제약을 유지하려면 이 값을 그대로 전달해줘야 한다.
  let currentOptionListSearchQuery = "";
  if (hasOptionList && optionListMatch) {
    try {
      const parsed = JSON.parse(optionListMatch[1].trim());
      // 구형 프로토콜(카드 배열을 그대로 보냄) 호환 — 둘 다 지원.
      const cardsArr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.cards) ? parsed.cards : []);
      if (!Array.isArray(parsed)) currentOptionListSearchQuery = String(parsed?.searchQuery ?? "").trim();
      currentProducts = cardsArr.map((c: any, i: number) => {
        const priceStr = String(c.price ?? '');
        const priceMatch = priceStr.match(/(\d[\d,]*)/);
        const priceNum = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : null;
        return {
          id: c.id || `card_${i}`,
          name: String(c.name ?? '').trim(),
          priceNum,
          priceStr,
          specs: Array.isArray(c.specs) ? c.specs : [],
        };
      }).filter((p: CurrentProduct) => p.name);
    } catch { /* ignore */ }
  }
  const currentProductNames = currentProducts.map(p => p.name);
  console.log(`[Route] Turn ${uiMessages.length} | requestId: ${requestId.slice(0, 10)} | CURRENT_OPTION_LIST: ${hasOptionList ? '✅ 있음' : '❌ 없음'} | products: [${currentProductNames.join(', ')}]`);

  // Option List 카드는 가격을 specs 배열이 아니라 별도 price 필드로 들고 있다 — 그걸 그대로
  // 빼고 넘기면(specs만) lookupKnownSpecValue가 "가격" 기준을 찾을 때 카드에 가격이 뻔히
  // 보이는데도 화면에 없는 것처럼 판단해 불필요한 Tavily 재검색을 돌리고, 그마저 실패하면
  // "-"(증거 없음)로 표시된다 — 가격을 스펙 문구로 접어 넣어 화면-known 값으로 인식되게 한다.
  const optionListCardsWithPrice = currentProducts.map(p => ({
    name: p.name,
    specs: p.priceStr ? [`가격: ${p.priceStr}`, ...p.specs] : p.specs,
  }));

  // Option List 카드가 이미 화면에 보여준 스펙 칩을 renderToCompTable/render-to-option-list가
  // 재검색 없이 재사용할 수 있게 sidebar-store에 실어둔다(요청마다 덮어씀 — 영속 캐시 아님).
  setCurrentOptionListCards(optionListCardsWithPrice);

  // Parse existing CriteriaMap categories from CURRENT_CRITERIA_MAP tag.
  // This tag is always appended last (see app/page.tsx handleSubmit), and its content
  // is a JSON array (which itself contains "[" characters), so capture to end-of-string
  // rather than stopping at the next "[" like the other tag parsers do.
  const criteriaMapMatch = latestText.match(/\[CURRENT_CRITERIA_MAP\]([\s\S]*)$/);
  const existingCriteriaCategories = criteriaMapMatch ? criteriaMapMatch[1].trim() : "";
  let parsedCriteriaMap: Array<{ id?: string; label: string; items: Array<{ id?: string; name: string }> }> = [];
  if (existingCriteriaCategories) {
    try { parsedCriteriaMap = JSON.parse(existingCriteriaCategories); } catch { /* ignore */ }
  }

  // Parse existing ComparisonTable spec from CURRENT_COMPARISON_TABLE tag (appended by app/page.tsx,
  // BEFORE the CURRENT_CRITERIA_MAP tag — that tag captures to end-of-string, so anything after it
  // would otherwise be swallowed). Content is compact (no-newline) JSON, so it safely terminates at
  // the next "\n[" tag or end-of-string, same convention as CURRENT_OPTION_LIST.
  const comparisonTableMatch = latestText.match(/\[CURRENT_COMPARISON_TABLE\]\n([\s\S]*?)(?=\n\[|$)/);
  let currentComparisonTable: { props: { columns: any[]; rows: any[] } } | null = null;
  if (comparisonTableMatch) {
    try { currentComparisonTable = JSON.parse(comparisonTableMatch[1]); } catch { /* ignore */ }
  }
  // key/id는 Edit Agent가 정확히 지목해서 되돌려줄 안정적인 참조값, label은 사람이 읽는 표시용.
  // r.id가 없는 구형 테이블(이번 id 도입 전에 생성된 행)은 라벨 자체를 id 자리에 넣는다 —
  // "crit_0" 같은 가짜 id를 지어내면 mutate-comptable.ts의 id 매칭도, 그다음 라벨 fallback
  // 매칭도(가짜 id가 실제 라벨과 전혀 안 닮았으므로) 둘 다 실패해 삭제가 조용히 무시된다.
  const comparisonTableProducts = (currentComparisonTable?.props?.columns ?? [])
    .filter((c: any) => c.key !== "criterion")
    .map((c: any) => ({ key: c.key, label: c.label }));
  const comparisonTableCriteria = (currentComparisonTable?.props?.rows ?? [])
    .filter((r: any) => r.criterion && r.criterion !== "순위" && r.criterion !== "Rank")
    .map((r: any) => ({ id: r.id ?? r.criterion, label: r.criterion }));
  const hasComparisonTable = comparisonTableProducts.length > 0 || comparisonTableCriteria.length > 0;
  const hasCriteriaMap = parsedCriteriaMap.length > 0;

  // Comparison Table이 이미 확정한 셀 값을 render-to-option-list.ts가 카드 생성 시 재검색
  // 없이 재사용할 수 있게, 제품(열)별로 "기준: 값" 목록을 만들어 sidebar-store에 실어둔다.
  const tableDataRows = (currentComparisonTable?.props?.rows ?? []).filter(
    (r: any) => r.criterion && r.criterion !== "순위" && r.criterion !== "Rank"
  );
  setCurrentComparisonTableCells(
    comparisonTableProducts.map((col) => ({
      name: col.label,
      specs: tableDataRows
        .map((r: any) => {
          const val = r[col.key];
          return val && val !== "-" ? `${r.criterion}: ${val}` : null;
        })
        .filter((s: string | null): s is string => s !== null),
    }))
  );

  // Action Router/Template Selector는 screen_state(boolean) 또는 제품명 목록 정도만 보고
  // 판단해왔는데, 그 정도로는 "이미 화면에 있는 구체적인 내용"이 필요한 요청(예: "왜 이
  // 제품을 추천한거야?")을 제대로 분류하지 못했다 — 화면에 뭐가 있는지 실제로는 모르는
  // 채로 판단했기 때문. 여기서 한 번만 만들어서 두 에이전트에 공통으로 넘긴다.
  const screenSummaryParts: string[] = [];
  if (currentProducts.length > 0) {
    screenSummaryParts.push(`Option List: ${currentProducts.length} products currently shown — ${currentProductNames.join(', ')}`);
  }
  if (hasComparisonTable) {
    screenSummaryParts.push(
      `Comparison Table: ${comparisonTableProducts.length} products (${comparisonTableProducts.map(p => p.label).join(', ') || 'none'}) ` +
      `× ${comparisonTableCriteria.length} criteria (${comparisonTableCriteria.map(c => c.label).join(', ') || 'none'})`
    );
  }
  if (hasCriteriaMap) {
    screenSummaryParts.push(
      `Criteria Map: ${parsedCriteriaMap.map(cat => `${cat.label} (${(cat.items ?? []).map(i => i.name).join(', ')})`).join(' | ')}`
    );
  }
  const screenSummary = screenSummaryParts.length > 0
    ? screenSummaryParts.join('\n')
    : '(nothing on screen yet)';

  // ─── Criteria-Only Pre-filter ──────────────────────────────────────────────
  // [My items: ...] 태그는 "이름|링크" 원문을 담고 있는데, 그냥 지워버리면(예전 코드) 사용자가
  // 제품 칩을 클릭해 "이 세 가지 제품을 비교해줘"처럼 지시대명사로 말한 문장에서 실제로 어떤
  // 제품인지가 통째로 사라진다 — 그 결과를 쓰는 intent_analyzer/edit_agent/action_router/
  // template_selector 등 strippedLatest를 참조하는 모든 곳이 엉뚱한(또는 화면의 다른) 제품을
  // 비교 대상으로 오인했다. 프론트(app/page.tsx)가 채팅에 표시할 때 하는 것과 동일하게, 지우는
  // 대신 사람이 읽을 수 있는 따옴표 붙은 이름 목록으로 치환한다.
  const myItemsNamesForText = myItemsRaw.map((e) => e.split('|')[0].trim()).filter(Boolean);
  const strippedLatest = latestText
    .replace(/\[CURRENT_CRITERIA_MAP\][\s\S]*$/, '') // always the trailing tag; strip to end-of-string first
    .replace(/\[CURRENT_COMPARISON_TABLE\]\n[\s\S]*?(?=\n\[|$)/, '')
    .replace(/\[CURRENT_OPTION_LIST\]\n[\s\S]*?(?=\n\[|$)/, '')
    .replace(/\n{0,2}\[DECISION CRITERIA:(?:[^\[\]]|\[[^\]]*\])*\]/gi, '')
    .replace(/\[USER CONTEXT:[^\]]*\]/gi, '')
    .replace(/\[My items\s*:[^\]]*\]/gi, myItemsNamesForText.length > 0 ? `"${myItemsNamesForText.join(', ')}"` : '')
    .replace(/\[ASSIGNED ITEM:[^\]]*\]/gi, '')
    .replace(/\[PARTICIPANT ID:[^\]]*\]/gi, '')
    .replace(/\[CONTEXT:[^\]]*\]/gi, '')
    .trim();

  const isCriteriaOnlyMessage = strippedLatest.length === 0 && decisionCriteriaList.length > 0;

  if (isCriteriaOnlyMessage && hasOptionList) {
    console.log('[Route] ⚡ Criteria-Only 메시지 + Option List 있음 → Agent 호출 생략, 즉시 빈 응답 반환');
    return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  // ─── 요청 컨텍스트 통합 ─────────────────────────────────────────────────────
  // 각 에이전트 호출부가 위에서 파싱된 변수들 중 필요한 걸 그때그때 골라 넘기다 보니,
  // 새 호출부를 추가하거나 기존 걸 고칠 때 특정 필드(예: screenSummary) 하나를 빠뜨려도
  // 타입 에러 없이 조용히 통과한다 — Chat Agent가 화면 상태를 못 받던 버그가 그 경우였다.
  // 이번 요청에서 파생된 "현재 상태"를 한 객체로 모아두고, 아래 에이전트 호출은 전부 여기서 꺼내 쓴다.
  interface RequestContext {
    locale: "ko" | "en";
    productCategory: string;
    participantId: string;
    hasOptionList: boolean;
    hasComparisonTable: boolean;
    hasCriteriaMap: boolean;
    currentProducts: CurrentProduct[];
    currentProductNames: string[];
    currentOptionListSearchQuery: string;
    currentComparisonTable: { props: { columns: any[]; rows: any[] } } | null;
    comparisonTableProducts: { key: string; label: string }[];
    comparisonTableCriteria: { id: string; label: string }[];
    parsedCriteriaMap: Array<{ id?: string; label: string; items: Array<{ id?: string; name: string }> }>;
    screenSummary: string;
    screenDetail: string;
    strippedLatest: string;
    modelMessages: typeof modelMessages;
    compactModelMessages: typeof compactModelMessages;
  }

  // screenSummary는 라우팅 판단용 요약이라 상품명만 담고 스펙/가격은 뺐다. "왜 이 순서야?" 같은
  // 질문에 구체적으로 답하려면 Chat Agent에게는 스펙까지 필요해서 별도로 만든다.
  const screenDetail = currentProducts.length > 0
    ? currentProducts
        .map(p => `- ${p.name}${p.priceStr ? ` (${p.priceStr})` : ""}: ${p.specs.length > 0 ? p.specs.join(", ") : "스펙 정보 없음"}`)
        .join("\n")
    : "";

  const ctx: RequestContext = {
    locale,
    productCategory,
    participantId,
    hasOptionList,
    hasComparisonTable,
    hasCriteriaMap,
    currentProducts,
    currentProductNames,
    currentOptionListSearchQuery,
    currentComparisonTable,
    comparisonTableProducts,
    comparisonTableCriteria,
    parsedCriteriaMap,
    screenSummary,
    screenDetail,
    strippedLatest,
    modelMessages,
    compactModelMessages,
  };

  // ⚠️ sidebar-store.ts의 current*는 요청 시작 시 한 번만 설정되는 프로세스 전역 변수라,
  // 이 요청이 이후 여러 LLM await(intent_analyzer → action_router/template_selector/
  // edit_agent 경합, 그리고 각 도구의 내부 await)를 거치는 동안 다른 요청이 끼어들어
  // setCurrent*()로 값을 덮어쓸 수 있다. 그러면 이 요청이 나중에 도구를 실행할 때
  // 엉뚱한(다른 요청의) 값을 읽게 된다 — render-to-option-list.ts에서 실제로 이 문제로
  // ProductCardList 결과가 다른 턴의 질문에 잘못 라벨링되는 버그가 있었다. 위에서 이미
  // 안전하게 계산해둔 로컬 값들로 전역을 다시 써서, 그 직후 이어지는 동기 구간(다음
  // await 전까지)에서는 항상 이 요청의 값을 보장한다. LLM 경합 시작 직전과 각 도구
  // 실행 직전, 두 지점에서 호출한다.
  const reapplyRequestGlobals = () => {
    setCurrentRequestId(requestId);
    setCurrentParticipantId(participantId);
    setCurrentLocale(locale);
    setCurrentUserContext(userContext);
    setCurrentSavedItems(myItemsList);
    setCurrentDecisionCriteria(decisionCriteriaList);
    setCurrentProductCategory(productCategory);
    setCurrentMyItemsRaw(myItemsRaw);
    setCurrentMyItemsContextSummary(myItemsContextSummary);
    setCurrentOptionListCards(optionListCardsWithPrice);
    setCurrentComparisonTableCells(
      comparisonTableProducts.map((col) => ({
        name: col.label,
        specs: tableDataRows
          .map((r: any) => {
            const val = r[col.key];
            return val && val !== "-" ? `${r.criterion}: ${val}` : null;
          })
          .filter((s: string | null): s is string => s !== null),
      }))
    );
  };

  // ─── [1] Intent Agent Fast: 의도 분류 (text_reply 없음, ~0.5–1s) ────────────
  // stream은 분류 중 즉시 열려 TTFB 개선. Cat 1a/1b는 text reply를 generator와 병렬 생성.
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: "start" } as any);
      writer.write({ type: "start-step" } as any);

      // 참가자 공유 메모리 로드 — 이전 턴들의 요약(마크다운). participantId 없거나 Redis 미설정이면 빈 문자열.
      // analyzeIntent/routeAction과 동시에 진행하고, 실제로 쓰이는 시점(CriteriaMap/InformationCard 생성,
      // none 잡담 응답)에만 await한다 — 그 시점이면 이미 두 LLM 호출이 끝난 뒤라 대개 즉시 resolve된다.
      const memoryPromptBlock = loadMemory(ctx.participantId)
        .catch((err) => {
          console.error('[SessionMemory] load 실패:', err);
          return '';
        })
        .then((memoryText) =>
          memoryText
            ? `\n\n[PAST INTERACTION MEMORY — 이전 턴 요약(참고용). 실제 현재 화면 상태는 최신 메시지의 CURRENT_* 태그가 우선한다]\n${memoryText}`
            : ''
        );

      // ── [1] Intent Analyzer ─────────────────────────────────────────────────────────────
      let intentAnalysis;
      try {
        // modelMessages already ends with this turn's (sanitized) user message, so pass everything
        // before it as history and let analyzeIntent append strippedLatest itself.
        intentAnalysis = await time("intent_analyzer", requestId, () =>
          analyzeIntent(ctx.strippedLatest, ctx.compactModelMessages.slice(0, -1))
        );
      } catch (err) {
        console.error('[Intent Analyzer] 실패:', err);
        writer.write({ type: "finish-step" } as any);
        writer.write({ type: "finish", finishReason: "stop" } as any);
        return;
      }

      // intent_analyzer의 await 도중 다른 요청이 전역을 덮어썼을 수 있으니, edit_agent(planEdit)가
      // 곧바로 전역을 읽기 전에(아래 editPlanPromise) 다시 이 요청의 값으로 되돌려놓는다.
      reapplyRequestGlobals();

      // ── [2] Action Router + [속도 최적화] Template Selector/Edit Planner 추측 실행 ─────────
      // template_selector와 edit_agent는 실제로는 actionRoute의 "값"에 의존하지 않는다 —
      // 둘 다 intentAnalysis + ctx만 있으면 되고, 그동안은 actionRoute.action==='generate'/
      // 'edit'라는 분기 조건에 걸려서 순차로 실행됐을 뿐이다. 그래서 router와 동시에 미리
      // 실행해두고 실제로 필요한 쪽의 결과만 골라 쓴다 — 순차 3콜(intent→router→template/
      // edit)이던 라우팅 체인이 실질적으로 2단계(intent→max(router, template, edit))로
      // 줄어든다(실측: 라우팅 체인이 턴당 40~56%를 차지했음).
      // 트레이드오프: 실제 action이 그쪽이 아니면(예: "none") 계산해둔 결과를 그냥 버리므로,
      // 매 턴 최대 2개의 "버려지는" LLM 호출이 추가로 발생해 OpenAI 비용이 늘어난다.
      // routeAction의 두 번째 인자는 ScreenState({hasOptionList/hasComparisonTable/hasCriteriaMap}
      // 불리언 3개)여야 한다 — ctx를 통째로 넘기면 구조적 타이핑상 컴파일은 통과하지만, 함수
      // 내부에서 JSON.stringify(screenState)를 그대로 프롬프트에 꽂기 때문에 ctx.modelMessages
      // (원시 대화 히스토리+tool 결과)까지 "screen_state"라는 이름으로 라우터에 새어 들어가
      // 판단을 흐렸다. 여기서 명시적으로 3개 필드만 골라 전달한다.
      const actionRoutePromise = time("action_router", requestId, () =>
        routeAction(
          intentAnalysis,
          { hasOptionList: ctx.hasOptionList, hasComparisonTable: ctx.hasComparisonTable, hasCriteriaMap: ctx.hasCriteriaMap },
          ctx.screenSummary,
          ctx.strippedLatest
        )
      );
      const templateSelectionPromise = time("template_selector", requestId, () =>
        selectTemplate(intentAnalysis, ctx.hasOptionList, ctx.currentProductNames, ctx.screenSummary)
      );
      const editPlanPromise = time("edit_agent", requestId, () =>
        planEdit(ctx.strippedLatest || intentAnalysis.user_goal, intentAnalysis, {
          optionList: ctx.hasOptionList ? ctx.currentProducts : undefined,
          optionListSearchQuery: ctx.hasOptionList ? ctx.currentOptionListSearchQuery : undefined,
          comparisonTable: ctx.hasComparisonTable
            ? { products: ctx.comparisonTableProducts, criteria: ctx.comparisonTableCriteria }
            : undefined,
          criteriaMap: ctx.hasCriteriaMap ? ctx.parsedCriteriaMap : undefined,
        }, ctx.locale)
      );
      // 실제로 안 쓰일 수도 있는 두 추측 호출이 실패해도 unhandled rejection으로 번지지 않게
      // 여기서 한 번 조용히 삼킨다 — 아래에서 실제로 필요해 다시 await할 때는 그 시점에
      // 원래 그대로 reject되므로, 각 분기의 기존 catch/에러 처리는 그대로 작동한다.
      templateSelectionPromise.catch(() => {});
      editPlanPromise.catch(() => {});

      let actionRoute;
      try {
        actionRoute = await actionRoutePromise;
      } catch (err) {
        console.error('[Action Router] 실패:', err);
        writer.write({ type: "finish-step" } as any);
        writer.write({ type: "finish", finishReason: "stop" } as any);
        return;
      }

      const textId = `text-${Date.now()}`;
      let generatedTemplate: string | null = null;
      let editTargetSurface: string | null = null;
      let editOpValue: string | null = null;
      // 이번 턴에 실제로 뭘 만들었는지 한 줄 요약 — 각 분기 끝에서 채워 넣고, 턴이 끝나면
      // session-memory.ts에 append한다 (참가자별 공유 메모리).
      let turnMemoryNote = "";

      // ── [3a] Generate: create a new UI component ────────────────────────────────────────
      if (actionRoute.action === 'generate') {
        let templateSelection;
        try {
          // action_router와 동시에 이미 시작해둔 추측 실행 결과를 그대로 사용(위 [2] 참고).
          templateSelection = await templateSelectionPromise;
        } catch (err) {
          console.error('[Template Selector] 실패:', err);
          writer.write({ type: "finish-step" } as any);
          writer.write({ type: "finish", finishReason: "stop" } as any);
          return;
        }
        const template = templateSelection.template;
        generatedTemplate = template;
        writer.write({ type: "data-action-type", data: { action: "generate", template } } as any);

        // ── Generate: CriteriaMap | InformationCard (Text + JSON Stream) ──────────────────
        if (template === 'CriteriaMap' || template === 'InformationCard') {
          writer.write({ type: "text-start", id: textId } as any);

          let systemStr = "";
          let userPrompt = "";

          const userContextStr = Array.isArray(currentUserContext) ? currentUserContext.join(" ") : String(currentUserContext || "");

          if (template === 'CriteriaMap') {
            systemStr = [
              buildCommonSystemInstructions(ctx.productCategory, ctx.locale),
              buildCriteriaMapSystem(ctx.locale),
              EDGE_CASES_SYSTEM,
            ].join("\n\n") + (await memoryPromptBlock);
            userPrompt = buildCriteriaMapPrompt(ctx.strippedLatest, userContextStr, existingCriteriaCategories);
          } else {
            systemStr = [
              buildCommonSystemInstructions(ctx.productCategory, ctx.locale),
              buildInformationCardSystem(ctx.locale),
              EDGE_CASES_SYSTEM,
            ].join("\n\n") + (await memoryPromptBlock);
            userPrompt = buildInformationCardPrompt(ctx.strippedLatest);
          }

          console.log(`\n\x1b[35m========== [3] UI Generator: ${template} ==========\x1b[0m`);
          if (template === 'CriteriaMap') {
            console.log(`\x1b[90m[Input] user_query:\x1b[0m ${ctx.strippedLatest}`);
            console.log(`\x1b[90m[Input] user_context:\x1b[0m ${userContextStr || '(없음)'}`);
          } else {
            console.log(`\x1b[90m[Input] user_query:\x1b[0m ${ctx.strippedLatest}`);
          }

          const extendedMessages = [...ctx.compactModelMessages, { role: 'user', content: userPrompt }];

          const uiStreamStartedAt = Date.now();
          const { textStream } = streamText({
            model: anthropic(UI_AGENT_MODEL),
            system: systemStr,
            messages: extendedMessages as any,
            maxOutputTokens: 2500,
            temperature: 0.3,
          });

          let fullOutput = "";
          let inJsonBlock = false;

          for await (const delta of textStream) {
            fullOutput += delta;

            if (fullOutput.includes("\`\`\`json")) {
              if (!inJsonBlock) {
                inJsonBlock = true;
                writer.write({ type: "text-end", id: textId } as any);
              }
            } else if (!inJsonBlock) {
              writer.write({ type: "text-delta", id: textId, delta } as any);
            }
          }

          if (!inJsonBlock) {
            writer.write({ type: "text-end", id: textId } as any);
          }
          logElapsed(`ui_agent_stream_${template}`, requestId, uiStreamStartedAt);

          // Log the text reply portion (before ```json block)
          const textReply = fullOutput.split("```json")[0].trim();
          if (textReply) {
            console.log(`\x1b[90m[Text Reply]\x1b[0m\n${textReply}`);
          }
          turnMemoryNote = textReply || `${template} 생성`;
          const firstBrace = fullOutput.indexOf('{');
          if (firstBrace !== -1) {
            let lastBrace = -1;
            let stack = 0;
            for (let i = firstBrace; i < fullOutput.length; i++) {
              if (fullOutput[i] === '{') stack++;
              if (fullOutput[i] === '}') stack--;
              if (stack === 0) { lastBrace = i; break; }
            }
            if (lastBrace !== -1) {
              const jsonPart = fullOutput.substring(firstBrace, lastBrace + 1);
              try {
                const uiSpec = JSON.parse(jsonPart);
                // CriteriaMap 카테고리/항목에 안정적인 id를 부여 — LLM은 라벨/이름만 자유 생성하고
                // 재식별 가능한 참조값은 코드가 보장한다(ComparisonTable의 crit_N/prod_N과 동일한 목적).
                if (template === 'CriteriaMap' && Array.isArray(uiSpec?.props?.categories)) {
                  const stamp = Date.now();
                  uiSpec.props.categories.forEach((cat: any, ci: number) => {
                    cat.id = cat.id || `cat-${stamp}-${ci}`;
                    (cat.items ?? []).forEach((item: any, ii: number) => {
                      item.id = item.id || `item-${stamp}-${ci}-${ii}`;
                    });
                  });
                }
                console.log(`\n\x1b[35m========== [3] UI Generator: ${template} ==========\x1b[0m`);
                console.log(`\x1b[32m[Output] Generated JSON:\x1b[0m\n${JSON.stringify(uiSpec, null, 2)}`);
                console.log(`\x1b[35m========================================================\x1b[0m\n`);
                writer.write({ type: "data-spec", data: uiSpec } as any);
              } catch (e) {
                console.error("[Route] JSON parsing error", e);
              }
            }
          }

          // ── Generate: ComparisonTable ──────────────────────────────────────────────────────
        } else if (template === 'ComparisonTable') {
          const renderCompTableStartedAt = Date.now();
          reapplyRequestGlobals();
          const compTableSpec = await (renderToCompTable as any).execute({
            intent_summary: intentAnalysis.user_goal,
            ui_intent_category: 'ComparisonTable',
          });
          logElapsed("render_comp_table", requestId, renderCompTableStartedAt);
          const colLabels = (compTableSpec?.props?.columns ?? [])
            .filter((c: any) => c.key !== 'criterion')
            .map((c: any) => c.label)
            .join(', ');
          const rowLabels = (compTableSpec?.props?.rows ?? [])
            .filter((r: any) => r.criterion)
            .map((r: any) => r.criterion)
            .join(', ');
          turnMemoryNote = colLabels
            ? `비교표 생성: ${colLabels}${rowLabels ? ` × 기준(${rowLabels})` : ''}`
            : 'ComparisonTable 생성';

          // ── Generate: ProductCardList ──────────────────────────────────────────────────────
        } else if (template === 'ProductCardList') {
          const renderOptionListStartedAt = Date.now();
          reapplyRequestGlobals();
          // search_query는 반드시 사용자 원문(ctx.strippedLatest)이어야 한다 — ragSearch의
          // parseConstraints()가 하드 필터(가격/무게/흡입력 등)를 "50만원 이하" 같은 한국어
          // 수치 패턴으로만 정규식 매칭한다. intentAnalysis.user_goal(LLM이 쓴 영어 요약)을
          // 넘기면 이 패턴이 전혀 매칭되지 않아 가격 상한이 조용히 무시되고, 게다가 Haiku가
          // "50만원"(50×10,000원)을 "50 million won"으로 잘못 환산해 리랭커에게도 잘못된
          // 예산 인식을 심어준다 — 그 결과 50만원 이하를 요청했는데 수백만원짜리 카메라가
          // 추천되는 사고로 이어졌다. intent_summary는 부가 설명용이라 기존처럼 유지한다.
          const optionListSpec = await (renderToOptionList as any).execute({
            search_query: ctx.strippedLatest || intentAnalysis.user_goal,
            intent_summary: intentAnalysis.user_goal,
            ui_intent_category: 'ProductCardList',
          });
          logElapsed("render_option_list", requestId, renderOptionListStartedAt);
          const cardNames = (optionListSpec?.props?.cards ?? []).map((c: any) => c.name).join(', ');
          turnMemoryNote = cardNames ? `상품 목록 생성: ${cardNames}` : 'ProductCardList 생성';
        }

        // ── Edit: modify a UI surface already on screen ─────────────────────────────────────
      } else if (actionRoute.action === 'edit') {
        let editPlan;
        try {
          // action_router와 동시에 이미 시작해둔 추측 실행 결과를 그대로 사용(위 [2] 참고).
          editPlan = await editPlanPromise;
        } catch (err) {
          console.error('[Edit Agent] 실패:', err);
          writer.write({ type: "finish-step" } as any);
          writer.write({ type: "finish", finishReason: "stop" } as any);
          return;
        }

        writer.write({ type: "data-action-type", data: { action: "edit", target_surface: editPlan.target_surface } } as any);
        turnMemoryNote = editPlan.op_summary || `${editPlan.target_surface} 수정`;
        editTargetSurface = editPlan.target_surface;
        editOpValue = editPlan.op;

        if (editPlan.op_summary) {
          writer.write({ type: "text-start", id: textId } as any);
          writer.write({ type: "text-delta", id: textId, delta: editPlan.op_summary } as any);
          writer.write({ type: "text-end", id: textId } as any);
        }

        if (editPlan.target_surface === 'optionList') {
          if ((editPlan.op === 'filter' || editPlan.op === 'add') && !ctx.hasOptionList) {
            // filter/add로 판단됐지만 화면에 리스트가 없는 방어적 케이스 → fresh 검색으로 전환.
            // mutateSurface(add)는 "기존 리스트에 카드를 이어붙이는" diff(new_cards)만 반환하고,
            // 프론트의 mutate 핸들러(app/page.tsx applyToSpec)도 기존 productCardListSpec이
            // 있을 때만 patch를 적용한다 — prev가 null이면 그대로 버린다. 그 결과 화면에
            // 리스트가 없는 상태에서 add로 라우팅되면 백엔드는 RAG 검색까지 성공해도 프론트가
            // 적용할 대상이 없어 카드가 통째로 유실되고 아무것도 렌더되지 않았다.
            console.log(`[Route] ${editPlan.op} op + no existing list → renderToOptionList로 전환`);
            const filterQuery = editPlan.original_query ?? intentAnalysis.user_goal;
            reapplyRequestGlobals();
            await time("render_option_list_fallback", requestId, () =>
              (renderToOptionList as any).execute({
                search_query: filterQuery,
                intent_summary: filterQuery,
                ui_intent_category: 'ProductCardList',
              })
            );
          } else {
            reapplyRequestGlobals();
            await time("mutate_option_list", requestId, () =>
              (mutateSurface as any).execute({
                surface: 'optionList',
                op: editPlan.op,
                op_summary: editPlan.op_summary,
                result_card_names: editPlan.result_card_names,
                products_to_add: editPlan.products_to_add,
                field_updates: editPlan.field_updates,
                current_cards: ctx.currentProducts.map(p => ({ id: p.id, name: p.name })),
                original_query: editPlan.original_query,
                sort_by: editPlan.sort_by,
                sort_order: editPlan.sort_order,
              })
            );
          }

        } else if (editPlan.target_surface === 'comparisonTable') {
          if (!ctx.currentComparisonTable) {
            // comparisonTable로 판단됐지만 화면에 테이블이 없는 방어적 케이스 → fresh 생성으로 전환.
            // optionList의 filter/add + 리스트 없음 폴백(위)과 동일한 이유: action_router가 edit으로
            // 오분류해도(예: "이 두 가지 제품을 비교해줘" — hasComparisonTable=false인데 edit으로 옴)
            // 사용자에게 빈 응답 대신 실제 비교표를 보여준다.
            console.log('[Route] target_surface=comparisonTable이지만 화면에 테이블 없음 → renderToCompTable로 전환');
            generatedTemplate = 'ComparisonTable';
            reapplyRequestGlobals();
            await time("render_comp_table_fallback", requestId, () =>
              (renderToCompTable as any).execute({
                intent_summary: intentAnalysis.user_goal,
                ui_intent_category: 'ComparisonTable',
              })
            );
          } else {
            reapplyRequestGlobals();
            await time("mutate_comparison_table", requestId, () =>
              (mutateComparisonTable as any).execute({
                surface: 'comparisonTable',
                op: editPlan.op,
                current_table: ctx.currentComparisonTable,
                criteria_to_add: editPlan.criteria_to_add ?? undefined,
                criteria_to_remove: editPlan.criteria_to_remove ?? undefined,
                products_to_add: editPlan.products_to_add ?? undefined,
                products_to_remove: editPlan.products_to_remove ?? undefined,
                op_summary: editPlan.op_summary,
              })
            );
          }

        } else if (editPlan.target_surface === 'criteriaMap') {
          const itemNames = (editPlan.item_names ?? []).map(n => n.trim()).filter(Boolean);
          if (!editPlan.category_label || itemNames.length === 0) {
            console.warn('[Route] target_surface=criteriaMap이지만 category/items가 없음(빈 문자열 포함) — edit 스킵');
          } else {
            await time("mutate_criteria_map", requestId, () =>
              (mutateCriteriaMap as any).execute({
                surface: 'criteriaMap',
                op: editPlan.op,
                category_label: editPlan.category_label,
                item_names: itemNames,
                op_summary: editPlan.op_summary,
              })
            );
          }
        }

        // ── None: conversational reply only ──────────────────────────────────────────────────
      } else {
        writer.write({ type: "data-action-type", data: { action: "none" } } as any);
        writer.write({ type: "text-start", id: textId } as any);
        const noneStreamStartedAt = Date.now();
        const memoryPrompt = await memoryPromptBlock;
        reapplyRequestGlobals();
        const { textStream: noneStream } = streamChatReply(ctx.locale, memoryPrompt, ctx.compactModelMessages as any, ctx.screenDetail);
        let noneReplyText = "";
        for await (const delta of noneStream) {
          noneReplyText += delta;
          writer.write({ type: "text-delta", id: textId, delta } as any);
        }
        writer.write({ type: "text-end", id: textId } as any);
        logElapsed("chat_reply_stream_none", requestId, noneStreamStartedAt);
        turnMemoryNote = noneReplyText.trim();
        console.log('[Route] action_type=none → 텍스트 응답만 반환');
      }

      // ── Spec 청크 주입 (store → writer) ──────────────────────────────────────
      const sidePanelResults = popSidePanelResults(requestId);
      console.log(`[Route] sidePanelResults: ${sidePanelResults.length}개`);
      for (const spec of sidePanelResults) {
        writer.write({ type: SPEC_DATA_PART_TYPE, data: spec } as any);
      }

      const optionListResults = popOptionListResults(requestId);
      console.log(`[Route] optionListResults: ${optionListResults.length}개`);
      for (const spec of optionListResults) {
        writer.write({ type: "data-option-list-spec", data: spec } as any);
      }

      const compTableResults = popCompTableResults(requestId);
      console.log(`[Route] compTableResults: ${compTableResults.length}개`);
      for (const spec of compTableResults) {
        writer.write({ type: "data-comp-table-spec", data: spec } as any);
      }

      const mutateSurfaceResults = popMutateSurfaceResults(requestId);
      if (mutateSurfaceResults.length > 0) {
        console.log(`[Route] mutateSurfaceResults: ${mutateSurfaceResults.length}개`);
        for (const spec of mutateSurfaceResults) {
          writer.write({ type: "data-mutate-surface-spec", data: spec } as any);
        }
      }

      // ── 메시지 종료 ───────────────────────────────────────────────────────────
      writer.write({ type: "finish-step" } as any);
      writer.write({ type: "finish", finishReason: "stop" } as any);

      // 사용자가 입력한 시점부터 화면에 보이는 답변이 전부 끝나는 시점까지의 체감 지연.
      // 이 아래(공유 메모리/리서치 로그 반영)는 클라이언트가 이미 다 받은 뒤에 일어나는
      // best-effort 뒷정리라 체감 속도에는 포함되지 않는다 — 그래서 TOTAL은 여기서 찍는다.
      logElapsed(`TOTAL(action=${actionRoute.action}${generatedTemplate ? `,template=${generatedTemplate}` : ''})`, requestId, requestStartedAt);

      // ── 로그 요약 ──────────────────────────────────────────────────────────────
      const totalTools = sidePanelResults.length + optionListResults.length + compTableResults.length + mutateSurfaceResults.length;
      if (totalTools === 0) {
        console.log(`[Route] ⚠️  spec 없음 (action=${actionRoute.action}${generatedTemplate ? `, template=${generatedTemplate}` : ''})`);
      } else {
        console.log(`[Route] ✅ spec 전송: sidebar=${sidePanelResults.length} optionList=${optionListResults.length} compTable=${compTableResults.length} mutate=${mutateSurfaceResults.length}`);
      }

      // ── 공유 메모리 반영 ──────────────────────────────────────────────────────
      // 실패해도 이번 턴 응답 자체에는 영향을 주지 않는다 (best-effort).
      // Redis(세션 메모리)와 Supabase(리서치 로그)는 서로 무관한 목적지라 순차로 기다릴
      // 이유가 없다 — 스트림이 실제로 닫히기 전 마지막 관문이라 순차 대기는 그대로
      // 사용자 체감 지연(스트림 종료까지의 시간)에 더해진다.
      if (ctx.participantId) {
        await Promise.all([
          appendMemoryTurn(ctx.participantId, {
            turn: uiMessages.length,
            userText: ctx.strippedLatest,
            action: actionRoute.action,
            template: generatedTemplate,
            note: turnMemoryNote,
          }).catch((err) => console.error('[SessionMemory] append 실패:', err)),

          logChatTurn({
            participantId: ctx.participantId,
            turnIndex: uiMessages.length,
            userText: ctx.strippedLatest,
            action: actionRoute.action,
            template: generatedTemplate,
            editTarget: editTargetSurface,
            editOp: editOpValue,
          }).catch((err) => console.error('[ResearchLog] logChatTurn 실패:', err)),
        ]);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
