import { tool } from "ai";
import { z } from "zod";
import { currentRequestId, currentProductCategory, currentLocale, pushMutateSurfaceResult, setCurrentProductCategory, setCurrentLocale } from "./sidebar-store";
import { ragSearch, findExactProduct } from "../rag/search";
import { generateUISpec } from "../agents/ui_agent";
import { resolveSpecValue, buildSpecPhrase } from "../services/spec-lookup";
import { reRankByAI, RAG_NOT_FOUND, expandCriterionMeta } from "../agents/data_agent";
import { time } from "../timing";

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
      // edit_agent.ts가 실제로 채워 보내는 값은 카드의 `name`이 아니라 `id`다(모호한 이름
      // 매칭 대신 정확한 매칭을 위해). 그래서 이 필드에 사람이 읽는 제품명이 아니라 카드
      // ID가 들어올 수 있다는 전제로 아래 execute에서 current_cards로 실제 이름을 되찾는다.
      product_name: z.string().describe("The card's id or name to update (must match a card in [CURRENT_OPTION_LIST])"),
      field_key: z.string().describe(
        "Short Korean keyword identifying the spec type to look up. e.g. '소음', '배터리', '흡입력', '무게', '충전시간'. " +
        "DO NOT guess or provide spec values — the system will look up real data from DB/web."
      ),
    })).optional().describe(
      "Used by add. Provide product_name + field_key only. The system resolves actual spec values from DB/web."
    ),

    // field_updates.product_name(카드 id일 수 있음)을 실제 제품명으로 되찾기 위한 현재 카드 목록.
    current_cards: z.array(z.object({ id: z.string(), name: z.string() })).optional().describe(
      "Current CURRENT_OPTION_LIST cards (id + name), used to resolve field_updates.product_name to a real product name."
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
    // ⚠️ currentRequestId/currentProductCategory/currentLocale은 전역 변수 — execute
    // 시작 시점에 캡처해야 아래의 여러 await(RAG 검색/Tavily/UI 생성) 도중 다른 요청이
    // 시작돼 전역을 덮어써도 이 요청은 계속 자기 값을 쓴다.
    const capturedRequestId = currentRequestId;
    const capturedProductCategory = currentProductCategory;
    const capturedLocale = currentLocale;
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
      // 이미 화면에 떠 있는 카드 이름 — ragSearch에 안 넘기면 "더 보여줘" 요청이 지금
      // 보여준 카드를 그대로 다시 찾아올 수 있다. 그러면 아래 appendNew()가 이름 중복으로
      // 조용히 걸러내 실제로는 아무것도 안 추가되는데, op_summary는 "더 추천해드릴게요"처럼
      // 성공한 것처럼 나가서 사용자만 헷갈리게 된다 — renderToOptionList(최초 검색)는 이미
      // alreadyShownNames를 넘기고 있었는데 이 add 경로만 빠뜨리고 있었다.
      const alreadyShownNames = (args.current_cards ?? []).map((c) => c.name).filter(Boolean);

      // 카테고리명 자체("로봇", "청소기", "카메라" 등)는 다나와 제품명에 거의 안 실린다
      // (예: "삼성전자 비스포크 AI 스팀 직배수 VR70F00SGG"엔 "로봇"/"청소기"가 없음) — edit_agent가
      // "삼성 로봇 청소기"처럼 브랜드에 카테고리 단어를 붙여 보내면, 아래 every() 매칭이 그
      // 카테고리 단어에서 항상 실패해 filtered가 통째로 비고 top-1 fallback으로 떨어진다.
      // RAG는 이미 브랜드/스펙 하드필터를 거친 topK를 주므로, 카테고리 단어를 지우고 나면
      // 브랜드만으로도 매칭되는 후보 전부(최대 topK)를 살릴 수 있다.
      const categoryTokens = new Set(capturedProductCategory.toLowerCase().split(/\s+/).filter(Boolean));

      const searchResults = toAdd.length > 0 ? await time("mutate_surface.rag_search", capturedRequestId, () =>
        Promise.all(
          toAdd.map(async (productName: string) => {
            try {
              // 사용자가 이미 정확한 제품명("로보락 S10 MaxV Slim 직배수" 등)을 말한 경우,
              // 임베딩 유사도 순위에 기대지 않고 로컬 DB에서 결정론적으로 먼저 찾는다 —
              // "직배수"/"Ultra"/"Slim"처럼 이름이 거의 같은 변형이 여러 개 있으면 임베딩
              // 순위가 top-K 밖으로 밀어낼 수 있어서(아래 filtered()가 걸러낼 기회조차 없이
              // found[0](엉뚱한 변형)로 폴백) — 정확 매칭이 있으면 원래 검색 제약(baseQuery)에
              // 상관없이 그 제품 자체를 확정한다(이름을 콕 집었다는 건 그 제품을 원한다는 뜻).
              const exactMatch = findExactProduct(productName, capturedProductCategory);
              if (exactMatch) return [exactMatch];

              const searchQuery = baseQuery ? `${productName} ${baseQuery}` : productName;
              const found = await ragSearch(searchQuery, capturedProductCategory, 20, alreadyShownNames);
              const nameQuery = productName.toLowerCase();
              const nameQueryWords = nameQuery.split(/\s+/).filter((w) => w && !categoryTokens.has(w));
              const filtered = found.filter(p =>
                p.name?.toLowerCase().includes(nameQuery) ||
                p.brand?.toLowerCase().includes(nameQuery) ||
                nameQueryWords.every((word: string) =>
                  p.name?.toLowerCase().includes(word) ||
                  p.brand?.toLowerCase().includes(word)
                )
              );
              // 카테고리 단어를 뺐는데도 특정 모델명을 지목한 검색이라 여전히 매칭이 없으면
              // (오탈자 등) 예전처럼 top-1만 조심스럽게 추가한다 — 반대로 매칭된 게 있으면
              // (브랜드 전체처럼 넓은 요청) RAG가 이미 찾아준 후보 전부를 살린다.
              const candidates = filtered.length > 0 ? filtered : found.slice(0, 1);
              return candidates;
            } catch (err) {
              console.error(`[mutateSurface/add] Search error for "${productName}":`, err);
              return [];
            }
          })
        )
      ) : [];

      // toAdd가 비어있는 경우("다른 제품을 더 보여줄 수 있어?"처럼 특정 제품명 없이 "더
      // 보여달라"는 요청) — edit_agent는 이럴 때 products_to_add=null, original_query만
      // 채워 보낸다. 그런데 위 루프는 toAdd를 순회하는 구조라 products_to_add가 비면 아예
      // 아무 검색도 하지 않고 조용히 빈 결과로 끝나버렸다(로그의 rag_search ms=0이 그 증거).
      // original_query 하나로 renderToOptionList(최초 검색)와 동일하게 폭넓게 검색한 뒤
      // reRankByAI로 몇 개만 추려 "더 보여주기"를 실제로 수행한다.
      let generalMoreProducts: typeof searchResults[number] = [];
      if (toAdd.length === 0 && baseQuery) {
        generalMoreProducts = await time("mutate_surface.rag_search_more", capturedRequestId, async () => {
          const candidates = await ragSearch(baseQuery, capturedProductCategory, 20, alreadyShownNames);
          if (candidates.length === 0) return [];
          const ranked = await reRankByAI(candidates, baseQuery, capturedProductCategory, 4, []);
          if (ranked === RAG_NOT_FOUND) return [];
          return ranked.map((r) => candidates[r.index]);
        });
        console.log(`[mutateSurface/add] products_to_add 없음 → original_query("${baseQuery}")로 일반 검색: ${generalMoreProducts.length}개 발견`);
      }

      // Step 2: 모든 제품을 하나의 productContext로 합쳐 generateUISpec 1번만 호출
      const allProducts = toAdd.length > 0 ? searchResults.flat() : generalMoreProducts;
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
          // generateProductCardList는 locale/productCategory를 전역에서 직접 읽는다 —
          // 위에서 캡처해둔 값으로 호출 직전에 다시 써서 다른 요청의 값을 읽지 않게 한다.
          setCurrentProductCategory(capturedProductCategory);
          setCurrentLocale(capturedLocale);
          const uiSpecString = await time("mutate_surface.ui_agent", capturedRequestId, () =>
            generateUISpec(productContext, "", "3", 1, "", [], [])
          );
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
        await time("mutate_surface.tavily_fallback", capturedRequestId, () =>
          Promise.all(notFoundNames.map(async (name: string) => {
            const category = capturedProductCategory ?? '제품';
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
          }))
        );
      }

      // products_to_add의 서로 다른 검색어(예: "모바", "M1")가 RAG에서 같은 실제 제품으로
      // 매칭되면 newCards에 동일 name이 두 번 들어갈 수 있다 — 프론트에서 그 name을 그대로
      // React key로 쓰므로(ProductCardList) "두 children이 같은 key" 경고/카드 중복 렌더로 이어진다.
      const seenNewCardNames = new Set<string>();
      result.new_cards = newCards.filter((c) => {
        if (!c.name || seenNewCardNames.has(c.name)) return false;
        seenNewCardNames.add(c.name);
        return true;
      });

      // ── field_updates 처리 (add op에 통합) ───────────────────────────────
      // resolveSpecValue(화면에 이미 떠 있는 값 확인 → lookupProductSpec: 로컬 DB→Tavily
      // 검색+judgeCell 검증+SiblingGuard)을 제품마다 개별 호출한다. 예전엔 DB에 없는
      // 제품들을 모아 스니펫 하나씩만 가져온 뒤 Claude 배치 호출 1번으로 값을 뽑았는데
      // (검증 없음), 이제는 auto-enrich/fetch-spec/ComparisonTable과 동일한 검증된
      // 파이프라인을 쓴다 — 그만큼 제품 수만큼 호출이 늘어나지만(병렬 처리), 형제 SKU
      // 오염 방지 등 다른 경로와 동일한 안전장치를 받는다. Comparison Table이 이미 이
      // 제품×기준을 화면에 표시 중이면(currentComparisonTableCells) resolveSpecValue가
      // 그 값을 그대로 재사용하므로, 이 경로와 Comparison Table 쪽이 독립적으로 재검색해
      // 값이 갈리는 문제(예: 초점거리가 한쪽엔 "-", 다른 쪽엔 "0.3m")가 방지된다.
      const fieldUpdatesRaw = args.field_updates ?? [];
      if (fieldUpdatesRaw.length > 0) {
        // edit_agent.ts는 product_name에 카드 id를 넣어 보낸다(모호한 이름 대신 정확한
        // 매칭을 위해) — 그 id를 그대로 lookupProductSpec(=Tavily 검색어)에 넘기면 "card-
        // 1786437325669-2" 같은 문자열을 검색하게 되어 항상 실패한다. current_cards로
        // 실제 제품명을 되찾아서 검색에는 그 이름을, 클라이언트 매칭용 product_name은
        // 원래 값(id) 그대로 반환한다.
        const idToName = new Map((args.current_cards ?? []).map(c => [c.id, c.name]));
        // 소음/흡입력처럼 모드에 따라 값이 갈리는 필드는 힌트 없이 카드마다 독립 검색하면
        // 서로 다른 조건의 값을 주워온다 — 이 요청에 등장하는 field_key 전체에 대해 미리
        // 힌트를 구해 resolveSpecValue에 흘려보낸다(auto-enrich/mutate-comptable과 동일).
        const uniqueFieldKeys = [...new Set(fieldUpdatesRaw.map((u) => u.field_key))];
        const criterionMeta = await expandCriterionMeta(uniqueFieldKeys);
        const results = await time("mutate_surface.field_updates_lookup", capturedRequestId, () =>
          Promise.all(
            fieldUpdatesRaw.map(async (u) => {
              const resolvedName = idToName.get(u.product_name) ?? u.product_name;
              const meta = criterionMeta[u.field_key];
              const lookup = await resolveSpecValue(resolvedName, u.field_key, capturedProductCategory, capturedLocale, meta?.formatHint, meta?.canonicalUnit, meta?.preferredCondition, meta?.type);
              return { ...u, resolvedName, lookup };
            })
          )
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

        for (const { resolvedName, field_key, lookup } of results) {
          if (lookup.value === "-") {
            console.warn(`[mutateSurface/add] ❌ "${resolvedName}" × "${field_key}" 해결 실패`);
          } else if (lookup.uncertain) {
            console.log(`[mutateSurface/add] ⚠️  "${resolvedName}" × "${field_key}" → "${lookup.value}" (추정)`);
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
