import { tool } from "ai";
import { z } from "zod";
import { currentRequestId, currentProductCategory, currentLocale, pushMutateSurfaceResult } from "./sidebar-store";
import { ragSearch } from "../rag/search";
import { generateUISpec } from "../agents/ui_agent";
import { lookupProductSpec, buildSpecPhrase } from "../services/spec-lookup";

/**
 * mutateSurface — 이미 화면에 표시된 Option List를 자연어 명령으로 수정
 *
 * 지원 operations:
 *  - filter  : 조건에 맞는 카드만 남기기
 *  - sort    : 카드 순서 변경
 *  - delete  : 특정 카드 제거
 *  - add     : 새 제품을 현재 목록에 추가 (로컬 DB 검색)
 *  - update_field : 기존 카드의 특정 스펙 필드 값 추가/수정
 *                   (RAG DB 우선 조회 → 없으면 Tavily 웹 검색 → 둘 다 없으면 skip)
 */

// ---------------------------------------------------------------------------
// Tavily inline search (data_agent.ts의 tavilySearch를 재사용 가능하게 로컬 구현)
// ---------------------------------------------------------------------------

type TavilyResult = { title: string; url: string; content: string; score: number };

async function tavilySearchInline(query: string): Promise<TavilyResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) { console.warn("[mutateSurface/Tavily] API 키 없음 — 건너뜀"); return []; }
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ query, search_depth: "basic", max_results: 5, include_answer: false }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { console.warn(`[mutateSurface/Tavily] HTTP ${res.status}`); return []; }
    const data = await res.json() as { results?: TavilyResult[] };
    return data.results ?? [];
  } catch (err) {
    console.warn("[mutateSurface/Tavily] 요청 실패:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tool Export
// ---------------------------------------------------------------------------

export const mutateSurface = tool({
  description: `
Mutate the CURRENTLY DISPLAYED Option List. Use when the user wants to modify visible cards — NOT for new searches.

Operations:
- filter : "삼성 제품만 남겨줘" / "로보락 빼줘" — keep only matching cards (also handles removal requests)
- sort   : "가격 낮은 순으로 정렬해줘" — reorder cards
- add    : "드리미도 추가해줘" / "각 제품 배터리 수명도 보여줘" — add new product cards OR look up a spec field for existing cards (or both)

Only use when [CURRENT_OPTION_LIST] is present. For new product searches, use renderToOptionList instead.
`.trim(),
  inputSchema: z.object({
    surface: z.literal("optionList"),
    op: z.enum(["filter", "sort", "add"]),

    // filter / sort: 결과로 남아야 할 카드 이름 목록 (순서 포함)
    result_card_names: z.array(z.string()).optional().describe(
      "Used by filter/sort. Names of cards to keep, in final order."
    ),

    // add: 추가할 제품 이름 목록 (선택적)
    products_to_add: z.array(z.string()).optional().describe(
      "Used by add. Names of products to search and add to the current list."
    ),

    // add: 원래 검색 조건 (하드필터 적용을 위해 필수)
    original_query: z.string().optional().describe(
      "Used by add. The original user search constraints (e.g. '흡입력 4500pa 이상 로봇청소기'). " +
      "ALWAYS pass this when the user had previous search criteria. Used to enforce hard filters (price/spec) on added products."
    ),

    // add: 스펙 필드 조회 목록 (선택적, 값은 시스템이 DB/웹에서 직접 조회)
    field_updates: z.array(z.object({
      product_name: z.string().describe("Card name to update (must exactly match a card in [CURRENT_OPTION_LIST])"),
      field_key: z.string().describe(
        "Short Korean keyword identifying the spec type to look up. e.g. '소음', '배터리', '흡입력', '무게', '충전시간'. " +
        "DO NOT guess or provide spec values — the system will look up real data from DB/web."
      ),
    })).optional().describe(
      "Used by add. Provide product_name + field_key only. The system resolves actual spec values from DB/web."
    ),

    op_summary: z.string().describe(
      "Brief user-facing description of the action, in the response locale (e.g. '가격 낮은 순으로 정렬했어요' / 'Sorted by lowest price')"
    ),

    // sort: 정렬 기준 (프론트엔드 클라이언트 사이드 정렬에 사용)
    sort_by: z.string().optional().nullable().describe(
      "For sort op: field to sort by in Korean, e.g. '가격', '무게', '소음', '흡입력'"
    ),
    sort_order: z.enum(["asc", "desc"]).optional().nullable().describe(
      "For sort op: 'asc' = 낮은순, 'desc' = 높은순"
    ),
  }),
  execute: async (args) => {
    const capturedRequestId = currentRequestId; // capture before any async work
    console.log(`[mutateSurface] op=${args.op} | ${args.op_summary}`);

    let result: any = {
      surface: args.surface,
      op: args.op,
      op_summary: args.op_summary,
    };

    if (args.op === "filter" || args.op === "sort") {
      result.result_card_names = (args as any).result_card_names ?? [];
      // sort op: sort_by/sort_order는 프론트엔드가 클라이언트 사이드 정렬에 사용
      if (args.op === "sort") {
        result.sort_by   = (args as any).sort_by   ?? null;
        result.sort_order = (args as any).sort_order ?? "asc";
      }

    } else if (args.op === "add") {
      // 로컬 RAG DB에서 제품 검색
      const toAdd = args.products_to_add ?? [];
      const newCards: any[] = [];

      // Step 1: 모든 제품을 먼저 DB에서 검색 (병렬)
      // original_query가 있으면 제품명 + 조건을 결합해 하드필터(Pa/가격 등) 적용
      const baseQuery = args.original_query?.trim() ?? "";

      const searchResults = await Promise.all(
        toAdd.map(async (productName: string) => {
          try {
            const searchQuery = baseQuery ? `${productName} ${baseQuery}` : productName;
            const found = await ragSearch(searchQuery, currentProductCategory, 5);
            const nameQuery = productName.toLowerCase();
            const filtered = found.filter(p =>
              p.name?.toLowerCase().includes(nameQuery) ||
              p.brand?.toLowerCase().includes(nameQuery) ||
              nameQuery.split(/\s+/).every((word: string) =>
                p.name?.toLowerCase().includes(word) ||
                p.brand?.toLowerCase().includes(word)
              )
            );
            const candidates = filtered.length > 0 ? filtered : found.slice(0, 1);
            return candidates;
          } catch (err) {
            console.error(`[mutateSurface/add] Search error for "${productName}":`, err);
            return [];
          }
        })
      );

      // Step 2: 모든 제품을 하나의 productContext로 합쳐 generateUISpec 1번만 호출
      const allProducts = searchResults.flat();
      if (allProducts.length > 0) {
        const productContext = allProducts.map(p => [
          `Name: ${p.name}`,
          `Price: ${p.price}`,
          `Brand: ${p.brand}`,
          `Image: ${(p as any).image ?? ""}`,
          `Link: ${p.link}`,
          `Specs: ${(p.specs ?? []).slice(0, 10).join(" / ") || "정보 없음"}`,
        ].join("\n")).join("\n\n");

        let cardMap: Record<string, any> = {};
        try {
          const uiSpecString = await generateUISpec(productContext, "", "3", 1, "", [], []);
          const firstBrace = uiSpecString?.indexOf("{") ?? -1;
          if (firstBrace !== -1) {
            let depth = 0, lastBrace = -1;
            for (let i = firstBrace; i < uiSpecString.length; i++) {
              if (uiSpecString[i] === "{") depth++;
              else if (uiSpecString[i] === "}") { depth--; if (depth === 0) { lastBrace = i; break; } }
            }
            if (lastBrace !== -1) {
              const parsed = JSON.parse(uiSpecString.substring(firstBrace, lastBrace + 1));
              const cards: any[] = parsed?.props?.cards ?? [];
              // 제품명 기준으로 카드 매핑
              cards.forEach((c: any) => { if (c.name) cardMap[c.name] = c; });
            }
          }
        } catch (e) {
          console.warn("[mutateSurface/add] 배치 UI Agent 실패, fallback 사용", e);
        }

        for (const p of allProducts) {
          const matched = cardMap[p.name];
          const selectedSpecs = matched?.specs?.length > 0
            ? matched.specs
            : (p.specs ?? []).slice(0, 4);
          newCards.push({
            id: `card-${Date.now()}-${newCards.length}`,
            name: p.name,
            price: p.price,
            imageUrl: (p as any).image ?? (p as any).imageUrl ?? "",
            link: p.link,
            brand: p.brand,
            specs: selectedSpecs,
            description: p.description ?? "",
          });
          console.log(`[mutateSurface/add] Added: "${p.name}" (specs: ${selectedSpecs.length}개)`);
        }
      }

      // Tavily fallback: RAG에 없는 제품은 웹 검색으로 최소 카드 생성
      const notFoundNames = toAdd.filter((_: string, i: number) => searchResults[i].length === 0);
      if (notFoundNames.length > 0) {
        console.log(`[mutateSurface/add] RAG 미발견 ${notFoundNames.length}개 → Tavily 웹검색 시도`);
        await Promise.all(notFoundNames.map(async (name: string) => {
          const category = currentProductCategory ?? '제품';
          const query = `${name} ${category} 가격 스펙`;
          const results = await tavilySearchInline(query);
          if (results.length === 0) {
            console.warn(`[mutateSurface/add] Tavily도 미발견: "${name}"`);
            return;
          }
          const combined = results.slice(0, 3).map(r => r.content).join(' ');
          // 가격 추출: "572,390원" 또는 "572390원"
          const priceMatch = combined.match(/(\d{3,3},?\d{3})\s*원/);
          const price = priceMatch ? `${priceMatch[1]}원` : '';
          // 스펙 후보 추출: "흡입력 15,000Pa", "소음 65dB" 등
          const specPatterns = [
            /흡입\s*력\s*[\d,]+\s*Pa/gi,
            /소음\s*[\d]+\s*dB/gi,
            /배터리\s*[\d,]+\s*(?:mAh|분|시간)/gi,
            /무게\s*[\d.]+\s*kg/gi,
          ];
          const specs: string[] = [];
          for (const pat of specPatterns) {
            const m = combined.match(pat);
            if (m) specs.push(m[0].trim());
          }
          newCards.push({
            // 병렬로 실행되는 Promise.all 안이라 newCards.length를 인덱스로 못 쓴다(경쟁 상태) —
            // 랜덤 접미사로 유일성 보장.
            id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            price,
            imageUrl: '',
            link: results[0]?.url ?? '',
            brand: name.split(/\s+/)[0],
            specs: specs.slice(0, 4),
            description: `웹 검색 결과로 추가됨 (DB 미수록 제품)`,
          });
          console.log(`[mutateSurface/add] Tavily 카드 생성: "${name}" (가격: ${price}, 스펙: ${specs.length}개)`);
        }));
      }

      result.new_cards = newCards;

      // ── field_updates 처리 (add op에 통합) ───────────────────────────────
      // lookupProductSpec(로컬 DB→Tavily 검색+judgeCell 검증+SiblingGuard)을 제품마다
      // 개별 호출한다. 예전엔 DB에 없는 제품들을 모아 스니펫 하나씩만 가져온 뒤 Claude
      // 배치 호출 1번으로 값을 뽑았는데(검증 없음), 이제는 auto-enrich/fetch-spec/
      // ComparisonTable과 동일한 검증된 파이프라인을 쓴다 — 그만큼 제품 수만큼 호출이
      // 늘어나지만(병렬 처리), 형제 SKU 오염 방지 등 다른 경로와 동일한 안전장치를 받는다.
      // 캐시는 없다 — 이 경로(채팅으로 Option List를 직접 mutate)와 update-table/route.ts의
      // STRATEGY A가 동시에 같은 제품×기준을 건드리면 독립적인 실시간 검색이 되어 값이
      // 갈릴 수 있다(이유는 update-table/route.ts 상단 주석 참고).
      const fieldUpdatesRaw = args.field_updates ?? [];
      if (fieldUpdatesRaw.length > 0) {
        const results = await Promise.all(
          fieldUpdatesRaw.map(async (u) => {
            const lookup = await lookupProductSpec(u.product_name, u.field_key, currentProductCategory, currentLocale);
            return { ...u, lookup };
          })
        );

        const resolvedUpdates = results
          .filter(({ lookup }) => lookup.value !== "-")
          .map(({ product_name, field_key, lookup }) => ({
            product_name,
            field_key,
            spec_phrase: lookup.uncertain
              ? `${buildSpecPhrase(field_key, lookup.value)} (추정)`
              : buildSpecPhrase(field_key, lookup.value),
          }));

        for (const { product_name, field_key, lookup } of results) {
          if (lookup.value === "-") {
            console.warn(`[mutateSurface/add] ❌ "${product_name}" × "${field_key}" 해결 실패`);
          } else if (lookup.uncertain) {
            console.log(`[mutateSurface/add] ⚠️  "${product_name}" × "${field_key}" → "${lookup.value}" (추정)`);
          }
        }

        result.field_updates = resolvedUpdates;
        console.log(`[mutateSurface/add] field_updates 완료: ${resolvedUpdates.length}/${fieldUpdatesRaw.length}개 해결`);
      }

    } // end else if add

    if (capturedRequestId) pushMutateSurfaceResult(capturedRequestId, result);
    return result;
  },
});
