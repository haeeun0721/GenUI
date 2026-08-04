import { analyzeIntent, INTENT_MODEL } from "@/lib/backend/agents/intent_analyzer";
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
} from "ai";
import { openai } from "@ai-sdk/openai";
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
} from "@/lib/backend/tools/sidebar-store";
import { findProductInLocalDB } from "@/lib/backend/agents/data_agent";

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
  initMutateSurfaceStore(requestId);
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

  // Pre-fetch My Items product data BEFORE the Conversation Agent runs.
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
    setCurrentMyItemsContextSummary(summaries.join("\n\n"));
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
    /\n{0,2}\[CURRENT_OPTION_LIST\][\s\S]*?(?=\n\[|$)/g,
    /\n{0,2}\[USER CONTEXT:[^\]]+\]/g,
    /\n{0,2}\[My items\s*:[^\]]+\]/gi,
    /\n{0,2}\[DECISION CRITERIA:[^\]]+\]/gi,
    /\n{0,2}\[CONTEXT:[^\]]+\]/gi,
    /\n{0,2}\[ASSIGNED ITEM:[^\]]+\]/gi,
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
  const hasOptionList = latestText.includes('[CURRENT_OPTION_LIST');
  // Extract full product data (name + numeric price + specs) from CURRENT_OPTION_LIST
  const optionListMatch = latestText.match(/\[CURRENT_OPTION_LIST[^\]]*\]([\s\S]*?)(?=\n\[|$)/);
  interface CurrentProduct { name: string; priceNum: number | null; priceStr: string; specs: string[]; }
  let currentProducts: CurrentProduct[] = [];
  if (hasOptionList && optionListMatch) {
    const listText = optionListMatch[1];
    const lines = listText.match(/^[-•]\s*.+$/gm) ?? [];
    currentProducts = lines.map(line => {
      // "- 샤오미 미지아 5C 직배수 [가격 572,390원] (스펙: 흡입력 15,000Pa, 낙하방지)"
      // [가격 이 깨진 경우(인코딩 오류)도 처리: 첫 번째 '[' 앞까지만 이름으로 추출
      const nameMatch = line.match(/^[-•]\s*([^[\n]+?)(?=\s*\[|\s*$)/);
      const name = nameMatch?.[1]?.trim() ?? '';
      const priceMatch = line.match(/\[가격[^\]]*(\d[\d,]*)원?\]/);
      const priceNum = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : null;
      const priceStr = priceMatch ? priceMatch[0].replace(/^\[가격\s*/, '').replace(/\]$/, '').trim() : '';
      const specsMatch = line.match(/\(스펙:\s*([^)]+)\)/);
      const specs = specsMatch ? specsMatch[1].split(',').map((s: string) => s.trim()).filter(Boolean) : [];
      return { name, priceNum, priceStr, specs };
    }).filter(p => p.name);
  }
  const currentProductNames = currentProducts.map(p => p.name);
  console.log(`[Route] Turn ${uiMessages.length} | requestId: ${requestId.slice(0, 10)} | CURRENT_OPTION_LIST: ${hasOptionList ? '✅ 있음' : '❌ 없음'} | products: [${currentProductNames.join(', ')}]`);

  // Parse existing CriteriaMap categories from CURRENT_CRITERIA_MAP tag.
  // This tag is always appended last (see app/page.tsx handleSubmit), and its content
  // is a JSON array (which itself contains "[" characters), so capture to end-of-string
  // rather than stopping at the next "[" like the other tag parsers do.
  const criteriaMapMatch = latestText.match(/\[CURRENT_CRITERIA_MAP\]([\s\S]*)$/);
  const existingCriteriaCategories = criteriaMapMatch ? criteriaMapMatch[1].trim() : "";
  let parsedCriteriaMap: Array<{ label: string; items: Array<{ name: string }> }> = [];
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
  const comparisonTableProductLabels = (currentComparisonTable?.props?.columns ?? [])
    .filter((c: any) => c.key !== "criterion")
    .map((c: any) => c.label);
  const comparisonTableCriteriaLabels = (currentComparisonTable?.props?.rows ?? [])
    .filter((r: any) => r.criterion && r.criterion !== "순위" && r.criterion !== "Rank")
    .map((r: any) => r.criterion);
  const hasComparisonTable = comparisonTableProductLabels.length > 0 || comparisonTableCriteriaLabels.length > 0;
  const hasCriteriaMap = parsedCriteriaMap.length > 0;

  // ─── Criteria-Only Pre-filter ──────────────────────────────────────────────
  const strippedLatest = latestText
    .replace(/\[CURRENT_CRITERIA_MAP\][\s\S]*$/, '') // always the trailing tag; strip to end-of-string first
    .replace(/\[CURRENT_COMPARISON_TABLE\]\n[\s\S]*?(?=\n\[|$)/, '')
    .replace(/\[CURRENT_OPTION_LIST\][\s\S]*?(?=\n\[|$)/, '')
    .replace(/\[DECISION CRITERIA:[^\]]*\]/gi, '')
    .replace(/\[USER CONTEXT:[^\]]*\]/gi, '')
    .replace(/\[My items\s*:[^\]]*\]/gi, '')
    .replace(/\[ASSIGNED ITEM:[^\]]*\]/gi, '')
    .replace(/\[CONTEXT:[^\]]*\]/gi, '')
    .trim();

  const isCriteriaOnlyMessage = strippedLatest.length === 0 && decisionCriteriaList.length > 0;

  if (isCriteriaOnlyMessage && hasOptionList) {
    console.log('[Route] ⚡ Criteria-Only 메시지 + Option List 있음 → Agent 호출 생략, 즉시 빈 응답 반환');
    return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  // ─── [1] Intent Agent Fast: 의도 분류 (text_reply 없음, ~0.5–1s) ────────────
  // stream은 분류 중 즉시 열려 TTFB 개선. Cat 1a/1b는 text reply를 generator와 병렬 생성.
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: "start" } as any);
      writer.write({ type: "start-step" } as any);

      // ── [1] Intent Analyzer ─────────────────────────────────────────────────────────────
      let intentAnalysis;
      try {
        intentAnalysis = await analyzeIntent(strippedLatest);
      } catch (err) {
        console.error('[Intent Analyzer] 실패:', err);
        writer.write({ type: "finish-step" } as any);
        writer.write({ type: "finish", finishReason: "stop" } as any);
        return;
      }

      // ── [2] Action Router ───────────────────────────────────────────────────────────────
      let actionRoute;
      try {
        actionRoute = await routeAction(intentAnalysis, { hasOptionList, hasComparisonTable, hasCriteriaMap });
      } catch (err) {
        console.error('[Action Router] 실패:', err);
        writer.write({ type: "finish-step" } as any);
        writer.write({ type: "finish", finishReason: "stop" } as any);
        return;
      }

      const textId = `text-${Date.now()}`;
      let generatedTemplate: string | null = null;

      // ── [3a] Generate: create a new UI component ────────────────────────────────────────
      if (actionRoute.action === 'generate') {
        let templateSelection;
        try {
          templateSelection = await selectTemplate(intentAnalysis, hasOptionList, currentProductNames, currentProducts);
        } catch (err) {
          console.error('[Template Selector] 실패:', err);
          writer.write({ type: "finish-step" } as any);
          writer.write({ type: "finish", finishReason: "stop" } as any);
          return;
        }
        const template = templateSelection.template;
        generatedTemplate = template;

        // ── Generate: CriteriaMap | InformationCard (Text + JSON Stream) ──────────────────
        if (template === 'CriteriaMap' || template === 'InformationCard') {
          writer.write({ type: "text-start", id: textId } as any);

          let systemStr = "";
          let userPrompt = "";

          const userContextStr = Array.isArray(currentUserContext) ? currentUserContext.join(" ") : String(currentUserContext || "");

          if (template === 'CriteriaMap') {
            systemStr = [
              buildCommonSystemInstructions(productCategory, locale),
              buildCriteriaMapSystem(locale),
              EDGE_CASES_SYSTEM,
            ].join("\n\n");
            userPrompt = buildCriteriaMapPrompt(strippedLatest, userContextStr, existingCriteriaCategories);
          } else {
            systemStr = [
              buildCommonSystemInstructions(productCategory, locale),
              buildInformationCardSystem(locale),
              EDGE_CASES_SYSTEM,
            ].join("\n\n");
            userPrompt = buildInformationCardPrompt(strippedLatest);
          }

          console.log(`\n\x1b[35m========== [3] UI Generator: ${template} ==========\x1b[0m`);
          if (template === 'CriteriaMap') {
            console.log(`\x1b[90m[Input] user_query:\x1b[0m ${strippedLatest}`);
            console.log(`\x1b[90m[Input] user_context:\x1b[0m ${userContextStr || '(없음)'}`);
          } else {
            console.log(`\x1b[90m[Input] user_query:\x1b[0m ${strippedLatest}`);
          }

          const extendedMessages = [...modelMessages, { role: 'user', content: userPrompt }];

          const { textStream } = streamText({
            model: openai(UI_AGENT_MODEL),
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

          // Log the text reply portion (before ```json block)
          const textReply = fullOutput.split("```json")[0].trim();
          if (textReply) {
            console.log(`\x1b[90m[Text Reply]\x1b[0m\n${textReply}`);
          }
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
          await (renderToCompTable as any).execute({
            intent_summary: intentAnalysis.user_goal,
            ui_intent_category: 'ComparisonTable',
          });

          // ── Generate: ProductCardList ──────────────────────────────────────────────────────
        } else if (template === 'ProductCardList') {
          await (renderToOptionList as any).execute({
            search_query: intentAnalysis.user_goal,
            intent_summary: intentAnalysis.user_goal,
            ui_intent_category: 'ProductCardList',
          });
        }

        // ── Edit: modify a UI surface already on screen ─────────────────────────────────────
      } else if (actionRoute.action === 'edit') {
        let editPlan;
        try {
          editPlan = await planEdit(strippedLatest || intentAnalysis.user_goal, intentAnalysis, {
            optionList: hasOptionList ? currentProducts : undefined,
            comparisonTable: hasComparisonTable
              ? { products: comparisonTableProductLabels, criteria: comparisonTableCriteriaLabels }
              : undefined,
            criteriaMap: hasCriteriaMap ? parsedCriteriaMap : undefined,
          });
        } catch (err) {
          console.error('[Edit Agent] 실패:', err);
          writer.write({ type: "finish-step" } as any);
          writer.write({ type: "finish", finishReason: "stop" } as any);
          return;
        }

        if (editPlan.op_summary) {
          writer.write({ type: "text-start", id: textId } as any);
          writer.write({ type: "text-delta", id: textId, delta: editPlan.op_summary } as any);
          writer.write({ type: "text-end", id: textId } as any);
        }

        if (editPlan.target_surface === 'optionList') {
          if (editPlan.op === 'filter' && !hasOptionList) {
            // filter로 판단됐지만 화면에 리스트가 없는 방어적 케이스 → fresh 검색으로 전환
            console.log('[Route] filter op + no existing list → renderToOptionList로 전환');
            const filterQuery = editPlan.original_query ?? intentAnalysis.user_goal;
            await (renderToOptionList as any).execute({
              search_query: filterQuery,
              intent_summary: filterQuery,
              ui_intent_category: 'ProductCardList',
            });
          } else {
            await (mutateSurface as any).execute({
              surface: 'optionList',
              op: editPlan.op,
              op_summary: editPlan.op_summary,
              result_card_names: editPlan.result_card_names,
              products_to_add: editPlan.products_to_add,
              field_updates: editPlan.field_updates,
              original_query: editPlan.original_query,
              sort_by: editPlan.sort_by,
              sort_order: editPlan.sort_order,
            });
          }

        } else if (editPlan.target_surface === 'comparisonTable') {
          if (!currentComparisonTable) {
            console.warn('[Route] target_surface=comparisonTable이지만 지원 범위를 벗어남(현재 테이블 없음) — edit 스킵');
          } else {
            await (mutateComparisonTable as any).execute({
              surface: 'comparisonTable',
              op: editPlan.op,
              current_table: currentComparisonTable,
              criteria_to_add: editPlan.criteria_to_add ?? undefined,
              criteria_to_remove: editPlan.criteria_to_remove ?? undefined,
              products_to_add: editPlan.products_to_add ?? undefined,
              products_to_remove: editPlan.products_to_remove ?? undefined,
              op_summary: editPlan.op_summary,
            });
          }

        } else if (editPlan.target_surface === 'criteriaMap') {
          const itemNames = (editPlan.item_names ?? []).map(n => n.trim()).filter(Boolean);
          if (!editPlan.category_label || itemNames.length === 0) {
            console.warn('[Route] target_surface=criteriaMap이지만 category/items가 없음(빈 문자열 포함) — edit 스킵');
          } else {
            await (mutateCriteriaMap as any).execute({
              surface: 'criteriaMap',
              op: editPlan.op,
              category_label: editPlan.category_label,
              item_names: itemNames,
              op_summary: editPlan.op_summary,
            });
          }
        }

        // ── None: conversational reply only ──────────────────────────────────────────────────
      } else {
        writer.write({ type: "text-start", id: textId } as any);
        const { textStream: noneStream } = streamText({
          model: openai(INTENT_MODEL),
          system: locale === "ko"
            ? "당신은 쇼핑 어시스턴트입니다. 사용자의 질문에 자연스럽고 친절하게 한국어로 답변하세요. UI 컴포넌트나 시스템 동작에 대해 언급하지 마세요."
            : "You are a shopping assistant. Answer the user's question naturally and helpfully in English. Do not mention UI components or system behavior.",
          messages: modelMessages as any,
          maxOutputTokens: 150,
          temperature: 0.3,
        });
        for await (const delta of noneStream) {
          writer.write({ type: "text-delta", id: textId, delta } as any);
        }
        writer.write({ type: "text-end", id: textId } as any);
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

      // ── 로그 요약 ──────────────────────────────────────────────────────────────
      const totalTools = sidePanelResults.length + optionListResults.length + compTableResults.length + mutateSurfaceResults.length;
      if (totalTools === 0) {
        console.log(`[Route] ⚠️  spec 없음 (action=${actionRoute.action}${generatedTemplate ? `, template=${generatedTemplate}` : ''})`);
      } else {
        console.log(`[Route] ✅ spec 전송: sidebar=${sidePanelResults.length} optionList=${optionListResults.length} compTable=${compTableResults.length} mutate=${mutateSurfaceResults.length}`);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
