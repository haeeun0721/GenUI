import { tool, generateText } from "ai";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { anthropic } from "@ai-sdk/anthropic";
import { currentRequestId, currentProductCategory, pushMutateSurfaceResult } from "./sidebar-store";
import { ragSearch } from "../rag/search";
import { tavilySearchSnippet } from "../agents/data_agent";
import { generateUISpec } from "../agents/ui_agent";

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

/**
 * Tavily 검색 결과에서 field_key에 해당하는 스펙 문구를 추출한다.
 * 필드 타입별 허용 단위를 지정하여 오탐을 방지한다.
 * - 무게→kg/g, 소음→dB, 흡입력→Pa, 배터리→mAh/분/시간 etc.
 */

// 필드타입별 허용 단위 맵 (key 에 포함되는 패턴 일치 시 해당 단위만 허용)
const FIELD_TYPE_UNITS: [RegExp, string[]][] = [
  [/무게|중량|weight/i,           ["kg", "g"]],
  [/소음|noise|db/i,              ["dB"]],
  [/흡입\s*력|흡입|suction/i,      ["Pa", "kPa"]],
  [/배터리|battery/i,             ["mAh"]],
  [/충전\s*시간|충전|charge/i,     ["분", "시간", "h", "min"]],
  [/사용\s*시간|runtime/i,          ["분", "시간", "h", "min"]],
  [/먼지\s*통|집진\s*통|통\s*용량|dustbin|dust.bin/i, ["ml", "mL", "L", "l", "ℓ", "cc"]],
  [/물\s*탱|water/i,                ["ml", "mL", "L", "l", "ℓ"]],
  [/rpm/i,                        ["rpm"]],
];

function getFieldUnits(fieldKey: string): string[] {
  for (const [pattern, units] of FIELD_TYPE_UNITS) {
    if (pattern.test(fieldKey)) return units;
  }
  // fallback: 범용 단위기호 (field이 알려지지 않은 경우)
  return ["dB", "Pa", "mAh", "분", "시간", "kg", "g", "ml", "L", "W", "V", "rpm"];
}

function extractSpecFromTavily(results: TavilyResult[], fieldKey: string): string | null {
  if (results.length === 0) return null;
  const combined = results.map(r => r.content).join("\n");

  // 동의어 키 목록 구성: 원본 키 + FIELD_SYNONYMS 확장
  const synonymKeys: string[] = [fieldKey];
  for (const [pattern, syns] of FIELD_SYNONYMS) {
    if (pattern.test(fieldKey)) {
      for (const s of syns) { if (!synonymKeys.includes(s)) synonymKeys.push(s); }
      break;
    }
  }

  const units = getFieldUnits(fieldKey);
  const unitPattern = units.map(u => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  for (const key of synonymKeys) {
    const keyEsc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // P1: "key: 값단위" 직접 매칭
    const p1 = new RegExp(
      `${keyEsc}[^\\n:：]{0,20}[:\\s：]+([\\d.]+\\s*(?:${unitPattern})[/\\w]*)`,
      "i"
    );
    const m1 = combined.match(p1);
    if (m1) {
      console.log(`[Tavily extract] P1 match (key="${key}"): "${m1[0].slice(0, 60)}"`);
      return `${fieldKey} ${m1[1].trim()}`;
    }

    // P2: key 이후 비숫자 30자 이내에 값+단위
    const p2 = new RegExp(
      `${keyEsc}[^\\d]{0,30}([\\d.]+\\s*(?:${unitPattern}))`,
      "i"
    );
    const m2 = combined.match(p2);
    if (m2) {
      console.log(`[Tavily extract] P2 match (key="${key}"): "${m2[0].slice(0, 60)}"`);
      return `${fieldKey} ${m2[1].trim()}`;
    }

    // P3: 값+단위 이후 비숫자 30자 이내에 key (역방향)
    const p3 = new RegExp(
      `([\\d.]+\\s*(?:${unitPattern}))[^\\d]{0,30}${keyEsc}`,
      "i"
    );
    const m3 = combined.match(p3);
    if (m3) {
      console.log(`[Tavily extract] P3 match (key="${key}"): "${m3[0].slice(0, 60)}"`);
      return `${fieldKey} ${m3[1].trim()}`;
    }
  }

  // 실패 시 디버그: Tavily 스니펫 일부 출력 (원인 파악용)
  console.log(`[Tavily extract] ❌ 모든 패턴 실패 (keys=${synonymKeys.join(",")}). 스니펫 샘플:`);
  console.log(combined.slice(0, 300).replace(/\n/g, " | "));
  return null;
}

// ---------------------------------------------------------------------------
// 직접 DB 조회 — 이름 매칭으로 products-*.json에서 제품 스펙 찾기
// ragSearch(임베딩 API)를 쓰지 않고 파일을 직접 읽어 이름으로 비교
// ---------------------------------------------------------------------------

// 필드키 동의어 확장 — "무게" 검색 시 "중량"도 함께 찾기
const FIELD_SYNONYMS: [RegExp, string[]][] = [
  [/무게|weight/i,                    ["무게", "중량"]],
  [/배터리|battery/i,                 ["배터리", "배터리용량", "사용시간"]],
  [/충전\s*시간|charge/i,            ["충전시간", "충전"]],
  [/소음|noise/i,                     ["소음"]],
  [/흡입\s*력|suction/i,             ["흡입력", "흡입"]],
  [/담한\s*면적|area/i,              ["담한면적", "사용고도지 면적"]],
  [/먼지통|집진통|dust.*bin|bin/i,  ["먼지통", "집진통", "먼지통 용량"]],
  [/물통|water.*tank|tank/i,         ["물통", "물탱크"]],
  [/사용\s*시간|run.*time/i,         ["사용시간", "배터리"]],
];

function expandFieldKeySynonyms(fieldKey: string): string[] {
  for (const [pattern, synonyms] of FIELD_SYNONYMS) {
    if (pattern.test(fieldKey)) return synonyms;
  }
  return [fieldKey];
}

export function findProductSpecInDB(productName: string, fieldKey: string, category: string): string | null {
  try {
    const filePath = path.join(process.cwd(), "data", `products-${category}.json`);
    if (!fs.existsSync(filePath)) {
      console.warn(`[DB lookup] 파일 없음: products-${category}.json`);
      return null;
    }
    const products = JSON.parse(fs.readFileSync(filePath, "utf8")) as { name: string; specs: string[] }[];
    const qLower = productName.toLowerCase();
    const matched = products.find(p => {
      const pLower = p.name.toLowerCase();
      return pLower === qLower || pLower.includes(qLower) || qLower.includes(pLower);
    });
    if (!matched) {
      console.log(`[DB lookup] ❌ "${productName}" — DB에 제품 없음`);
      return null;
    }
    // 매핑된 DB 제품명이 검색어와 다르면 명시
    const nameMatched = matched.name === productName ? "" : ` (DB명: "${matched.name}")`;
    // 동의어 확장 후 모든 키로 검색
    const synonyms = expandFieldKeySynonyms(fieldKey);
    for (const key of synonyms) {
      const keyLower = key.toLowerCase();
      const matchedSpec = matched.specs.find(s => s.toLowerCase().includes(keyLower));
      if (matchedSpec) {
        console.log(`[DB lookup] ✅ "${productName}"${nameMatched} (key="${key}") → "${matchedSpec}"`);
        return matchedSpec;
      }
    }
    // 스펙 없음 — DB에 있는 스펙 키 목록 일부 출력
    const specKeys = matched.specs.slice(0, 8).map(s => s.split(/[:\s]/)[0]).join(", ");
    console.log(`[DB lookup] ⚠️  "${productName}"${nameMatched} — [${synonyms.join(", ")}] 스펙 없음 | DB 보유 스펙(최대8): ${specKeys}`);
    return null;
  } catch (err) {
    console.warn(`[DB lookup] 오류:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// CompTable식 스펙 추출 — Claude Haiku로 스니펫에서 배치 필드 추출
// enrichContextWithTavily (renderToCompTable)와 동일한 방식
// ---------------------------------------------------------------------------

export async function extractSpecsWithClaude(
  items: { product_name: string; snippet: string }[],
  field_key: string
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();

  const itemsText = items
    .map((it, i) => `[${i + 1}] ${it.product_name}\n${it.snippet}`)
    .join('\n\n');

  const prompt = `다음 각 제품의 검색 결과 스니펫에서 "${field_key}" 관련 수치를 추출해주세요.
각 줄에 정확히 "제품명 | 값(단위)" 형식으로만 답하세요.
- 정확한 수치가 있으면 그대로 사용
- 수치가 간접적으로 언급되면 (예: "0.3리터짜리 먼지통") 변환해서 사용
- 범위가 있으면 중간값 사용 (예: 0.3L~0.5L → 0.4L)
- 정말 정보가 전혀 없는 경우에만 생략
다른 텍스트는 절대 출력하지 마세요.
예시: 로보락 S10 MaxV | 4.5kg

${itemsText}`.trim();

  try {
    const { text } = await generateText({
      model: anthropic('claude-haiku-4-5'),
      prompt,
      temperature: 0,
    });

    console.log(`\n\x1b[35m[Claude extract] 🤖 원본 응답:\n${text}\x1b[0m\n`);

    const resultMap = new Map<string, string>();
    for (const line of text.split('\n')) {
      const match = line.match(/^(.+?)\s*\|\s*(.+)$/);
      if (!match) continue;
      const namePart = match[1].trim();
      const value = match[2].trim();
      if (!value || value === 'null' || value === '-' || value === 'N/A') continue;

      // 제품명 퍼지 매칭 (LLM이 일부만 사용할 수 있음)
      const matched = items.find(it =>
        it.product_name === namePart ||
        it.product_name.includes(namePart) ||
        namePart.includes(it.product_name)
      );
      if (matched) {
        resultMap.set(matched.product_name, `${field_key} ${value}`);
        console.log(`[Claude extract] ✅ "${matched.product_name}" → "${field_key} ${value}"`);
      }
    }
    return resultMap;
  } catch (err) {
    console.warn('[Claude extract] 오류:', err);
    return new Map();
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
      "Brief Korean description of the action, e.g. '가격 낮은 순으로 정렬했어요'"
    ),
  }),
  execute: async (args) => {
    console.log(`[mutateSurface] op=${args.op} | ${args.op_summary}`);

    let result: any = {
      surface: args.surface,
      op: args.op,
      op_summary: args.op_summary,
    };

    if (args.op === "filter" || args.op === "sort") {
      result.result_card_names = args.result_card_names ?? [];

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

      toAdd.filter((_: string, i: number) => searchResults[i].length === 0).forEach((name: string) => {
        console.warn(`[mutateSurface/add] Not found in DB: "${name}"`);
      });

      result.new_cards = newCards;

      // ── field_updates 처리 (add op에 통합) ───────────────────────────────
      const fieldUpdatesRaw = args.field_updates ?? [];
      if (fieldUpdatesRaw.length > 0) {
        // Step 1: DB 직접 조회
        const specMap = new Map<string, string>();
        const needsWeb: { product_name: string; field_key: string }[] = [];

        for (const u of fieldUpdatesRaw) {
          const dbSpec = findProductSpecInDB(u.product_name, u.field_key, currentProductCategory);
          if (dbSpec) {
            specMap.set(u.product_name, dbSpec);
          } else {
            needsWeb.push(u);
          }
        }

        // Step 2: DB에 없는 제품들 → Tavily 스니펫 병렬 수집
        if (needsWeb.length > 0) {
          const fieldKey = needsWeb[0].field_key;
          console.log(`[mutateSurface/add] Tavily 병렬 검색 시작 (${needsWeb.length}개 제품, 필드: ${fieldKey})`);

          const snippetResults = await Promise.all(
            needsWeb.map(async u => {
              const query = `${u.product_name} ${u.field_key}`;
              console.log(`[mutateSurface/add] Tavily 검색: "${query}"`);
              const res = await tavilySearchSnippet(query);
              return { product_name: u.product_name, snippet: res?.snippet ?? null };
            })
          );

          const withSnippet = snippetResults.filter(r => r.snippet !== null) as { product_name: string; snippet: string }[];
          if (withSnippet.length > 0) {
            console.log(`[mutateSurface/add] Claude Haiku 배치 추출 (${withSnippet.length}개 스니펫)...`);
            const extracted = await extractSpecsWithClaude(withSnippet, fieldKey);
            for (const [name, spec] of extracted) {
              specMap.set(name, spec);
            }
          }

          for (const r of snippetResults.filter(r => r.snippet === null)) {
            console.warn(`[mutateSurface/add] ❌ Tavily 스니펫 없음: "${r.product_name}"`);
          }
        }

        const resolvedUpdates = fieldUpdatesRaw
          .filter(u => specMap.has(u.product_name))
          .map(u => ({ product_name: u.product_name, field_key: u.field_key, spec_phrase: specMap.get(u.product_name)! }));

        result.field_updates = resolvedUpdates;
        console.log(`[mutateSurface/add] field_updates 완료: ${resolvedUpdates.length}/${fieldUpdatesRaw.length}개 해결`);
      }

    } // end else if add

    if (currentRequestId) pushMutateSurfaceResult(currentRequestId, result);
    return result;
  },
});
