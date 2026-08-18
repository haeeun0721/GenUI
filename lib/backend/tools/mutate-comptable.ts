import { tool } from "ai";
import { z } from "zod";
import {
  currentRequestId,
  pushCompTableResult,
  currentDecisionCriteria,
  currentProductCategory,
  currentLocale,
} from "./sidebar-store";
import { findProductInLocalDB } from "../agents/data_agent";
import { computeRankingAndReasoning } from "../agents/generators/comp_table";
import { ragSearch } from "../rag/search";
import { resolveSpecValue } from "../services/spec-lookup";
import { time } from "../timing";

/**
 * mutateComparisonTable — 이미 화면에 표시된 ComparisonTable에 기준(행)/제품(열)을 추가/삭제
 *
 * row(기준) add/remove 로직은 app/api/update-table/route.ts의 STRATEGY A(증분 업데이트)와
 * 동일한 building block(lookupProductSpec)을 재사용하되, update-table/route.ts 자체는
 * 건드리지 않는다 — 그 경로는 Decision Criteria 패널 변경 시에도 여전히 그대로 동작해야 하기 때문.
 *
 * 셀 값 조회는 전부 resolveSpecValue(화면에 이미 떠 있는 값 확인 → lookupProductSpec: 로컬
 * DB → Tavily 검색 + judgeCell 검증 + SiblingGuard)로 통일했다. 예전엔 이 파일이
 * findProductSpecInDB/tavilySearch/judgeCell을 직접 조합해서 auto-enrich/fetch-spec이
 * 쓰는 더 정교한 파이프라인과 따로 놀았는데, 그러다보니 개선(SiblingGuard 등)이 한쪽에만
 * 적용되는 문제가 있었다.
 *
 * resolveSpecValue는 lookupProductSpec을 부르기 전에 currentOptionListCards(Option List가
 * 이번 요청에 실어보낸, 이미 화면에 떠 있는 스펙)를 먼저 확인한다 — 그래서 이 경로(채팅으로
 * Table을 직접 mutate)와 Option List 경로가 같은 제품×기준을 각자 독립적으로 재검색해 값이
 * 갈리는 문제(예: 초점거리가 한쪽엔 "-", 다른 쪽엔 "0.3m")가 방지된다. 이 값은 영속 캐시가
 * 아니라 매 요청 시작 시 덮어써지는 request-scoped 상태다(app/api/generate/route.ts 참고).
 *
 * product(열) add는 mutateSurface(Option List add)와 동일하게 RAG(ragSearch)로 제품을 찾는다.
 * 단일 셀 재조회(특정 제품 × 특정 기준 하나만 갱신)는 여전히 범위 밖이다.
 */

function cleanCriterionLabel(c: string): string {
  return c.replace(/\s*\[.*?\]\s*/g, "").replace(/\s*\(.*?\)\s*/g, "").trim();
}

/** 기존 행 id("crit_N") 중 가장 큰 N 다음부터 이어지는 새 id를 발급한다. */
function makeCriterionIdGenerator(rows: any[]): () => string {
  let maxIdx = -1;
  for (const r of rows) {
    const m = /^crit_(\d+)$/.exec(String(r?.id ?? ""));
    if (m) maxIdx = Math.max(maxIdx, parseInt(m[1], 10));
  }
  let next = maxIdx;
  return () => `crit_${++next}`;
}

export const mutateComparisonTable = tool({
  description: `
Add or remove criterion ROWS, or add/remove product COLUMNS, on the CURRENTLY DISPLAYED ComparisonTable.
Only use when [CURRENT_COMPARISON_TABLE] is present. Cannot re-check a single cell.
`.trim(),
  inputSchema: z.object({
    surface: z.literal("comparisonTable"),
    op: z.enum(["add_criteria", "remove_criteria", "add_product", "remove_product"]),
    current_table: z.any().describe("The current Table spec JSON ({ props: { columns, rows } }) to patch in place."),
    criteria_to_add: z.array(z.string()).optional(),
    criteria_to_remove: z.array(z.string()).optional().describe("remove_criteria: row `id`s (e.g. 'crit_1') copied from CURRENT_COMPARISON_TABLE — falls back to label matching if an id isn't recognized."),
    products_to_add: z.array(z.string()).optional().describe("add_product: product names/brands/queries to search for (RAG) and add as new columns."),
    products_to_remove: z.array(z.string()).optional().describe("remove_product: column `key`s (e.g. 'prod_1') copied from CURRENT_COMPARISON_TABLE — falls back to label matching if a key isn't recognized."),
    op_summary: z.string().describe("Brief user-facing description of the action, in the response locale."),
  }),
  execute: async (args) => {
    const capturedRequestId = currentRequestId;
    console.log(`[mutateComparisonTable] op=${args.op} | ${args.op_summary}`);

    const tableJson = JSON.parse(JSON.stringify(args.current_table ?? { props: { columns: [], rows: [] } }));
    // current_table은 [CURRENT_COMPARISON_TABLE] 태그(props만 담김)에서 온 것이라 type이 없을 수 있다 —
    // 프론트엔드 렌더러가 컴포넌트를 식별하려면 반드시 필요하므로 여기서 항상 보장한다.
    tableJson.type = "Table";
    tableJson.props ??= { columns: [], rows: [] };
    const cols: any[] = tableJson.props.columns ?? [];
    let rows: any[] = tableJson.props.rows ?? [];
    const productCols = cols.filter((c: any) => c.key !== "criterion");

    if (args.op === "remove_criteria") {
      const raw = (args.criteria_to_remove ?? []).map((c) => String(c).trim()).filter(Boolean);
      const toRemoveIds = new Set(raw);
      const toRemoveLabels = raw.map((c) => cleanCriterionLabel(c).toLowerCase());
      rows = rows.filter((r: any) => {
        if (r.criterion === "순위" || r.criterion === "Rank") return true;
        // 1순위: id 정확히 매칭 (예: "crit_1")
        if (r.id && toRemoveIds.has(String(r.id))) return false;
        // fallback: LLM이 id 대신 라벨을 보냈을 경우 대비한 문자열 매칭
        const rn = cleanCriterionLabel(String(r.criterion ?? "")).toLowerCase();
        if (!rn) return true;
        return !toRemoveLabels.some((tr) => rn === tr || rn.includes(tr) || tr.includes(rn));
      });
      console.log(`[mutateComparisonTable] 삭제 후 ${rows.length}개 행 남음`);
    } else if (args.op === "add_criteria") {
      const requested = (args.criteria_to_add ?? []).map(cleanCriterionLabel).filter(Boolean);
      const existing = new Set(rows.map((r: any) => cleanCriterionLabel(String(r.criterion ?? "")).toLowerCase()));
      const toAdd = requested.filter((c) => !existing.has(c.toLowerCase()));
      const genRowId = makeCriterionIdGenerator(rows);

      // 제품 컬럼 라벨 → 전체 제품명 매핑 (update-table/route.ts STRATEGY A와 동일한 패턴)
      const fullNameMap = new Map<string, string>();
      for (const col of productCols) {
        const dbEntry = findProductInLocalDB(currentProductCategory, col.label);
        const nameMatch = dbEntry?.match(/Name:\s*(.+)/);
        fullNameMap.set(col.label, nameMatch ? nameMatch[1].trim() : col.label);
      }

      for (const criterion of toAdd) {
        const newRow: Record<string, string> = { id: genRowId(), criterion };
        for (const col of productCols) newRow[col.key] = "-";

        await time("mutate_comp_table.add_criteria_lookup", capturedRequestId, () =>
          Promise.all(
            productCols.map(async (col: any) => {
              const fullName = fullNameMap.get(col.label) ?? col.label;
              const result = await resolveSpecValue(fullName, criterion, currentProductCategory, currentLocale);
              newRow[col.key] = result.uncertain && result.value !== "-" ? `${result.value} (추정)` : result.value;
              console.log(`[mutateComparisonTable] "${fullName}" × "${criterion}" → "${newRow[col.key]}" (source=${result.source}${result.uncertain ? ", 불확실" : ""})`);
            })
          )
        );

        const rankIdx = rows.findIndex((r: any) => r.criterion === "순위" || r.criterion === "Rank");
        if (rankIdx === -1) rows.push(newRow);
        else rows.splice(rankIdx + 1, 0, newRow);
        console.log(`[mutateComparisonTable] 새 행 추가: "${criterion}"`);
      }
    } else if (args.op === "remove_product") {
      const raw = (args.products_to_remove ?? []).map((p) => String(p).trim()).filter(Boolean);
      const toRemoveKeys = new Set(raw);
      const toRemoveLabels = raw.map((p) => p.toLowerCase());
      const removedCols = productCols.filter((c: any) => {
        // 1순위: key 정확히 매칭 (예: "prod_1")
        if (toRemoveKeys.has(c.key)) return true;
        // fallback: LLM이 key 대신 라벨을 보냈을 경우 대비한 문자열 매칭
        const cl = c.label.toLowerCase();
        return toRemoveLabels.some((tr) => cl === tr || cl.includes(tr) || tr.includes(cl));
      });
      if (removedCols.length === 0) {
        console.warn("[mutateComparisonTable] remove_product: 매칭되는 제품 컬럼 없음");
      } else {
        const removedKeys = new Set(removedCols.map((c: any) => c.key));
        tableJson.props.columns = cols.filter((c: any) => !removedKeys.has(c.key));
        rows = rows.map((r: any) => {
          const next = { ...r };
          removedKeys.forEach((k) => { delete next[k]; });
          return next;
        });
        console.log(`[mutateComparisonTable] 제품 컬럼 삭제: ${removedCols.map((c: any) => c.label).join(", ")}`);
      }
    } else if (args.op === "add_product") {
      const requested = (args.products_to_add ?? []).map((s) => s.trim()).filter(Boolean);
      const existingLabelsLower = new Set(productCols.map((c: any) => c.label.toLowerCase()));

      const searchResults = await time("mutate_comp_table.rag_search", capturedRequestId, () =>
        Promise.all(
          requested.map(async (q) => {
            try {
              const found = await ragSearch(q, currentProductCategory, 5, productCols.map((c: any) => c.label));
              const qLower = q.toLowerCase();
              const filtered = found.filter((p) =>
                p.name?.toLowerCase().includes(qLower) ||
                p.brand?.toLowerCase().includes(qLower) ||
                qLower.split(/\s+/).every((w: string) => p.name?.toLowerCase().includes(w) || p.brand?.toLowerCase().includes(w))
              );
              return (filtered.length > 0 ? filtered : found)[0] ?? null;
            } catch (err) {
              console.error(`[mutateComparisonTable/add_product] 검색 실패 "${q}":`, err);
              return null;
            }
          })
        )
      );

      const seenLower = new Set<string>();
      const newProducts = searchResults.filter((p): p is NonNullable<typeof p> => {
        if (!p) return false;
        const nameLower = p.name.toLowerCase();
        if (existingLabelsLower.has(nameLower) || seenLower.has(nameLower)) return false;
        seenLower.add(nameLower);
        return true;
      });

      const criterionRows = rows.filter((r: any) => r.criterion && r.criterion !== "순위" && r.criterion !== "Rank");

      for (const prod of newProducts) {
        let idx = 0;
        while (cols.some((c: any) => c.key === `prod_${idx}`)) idx++;
        const newKey = `prod_${idx}`;
        cols.push({ key: newKey, label: prod.name, imageUrl: (prod as any).image ?? "" });

        await time("mutate_comp_table.add_product_lookup", capturedRequestId, () =>
          Promise.all(
            criterionRows.map(async (row: any) => {
              const criterion = String(row.criterion ?? "");
              const result = await resolveSpecValue(prod.name, criterion, currentProductCategory, currentLocale);
              row[newKey] = result.uncertain && result.value !== "-" ? `${result.value} (추정)` : result.value;
              console.log(`[mutateComparisonTable/add_product] "${prod.name}" × "${criterion}" → "${row[newKey]}" (source=${result.source}${result.uncertain ? ", 불확실" : ""})`);
            })
          )
        );
        console.log(`[mutateComparisonTable/add_product] 새 제품 컬럼 추가: "${prod.name}"`);
      }
    }

    tableJson.props.rows = rows;
    // 프론트엔드(app/page.tsx)에는 "renderToCompTable의 재생성이 활성 기준 행을 실수로
    // 누락시켰을 때 복구"하는 안전장치가 있는데, 이 mutate 결과도 같은 채널로 나가기 때문에
    // remove_criteria로 의도적으로 지운 행까지 그 안전장치가 되살릴 수 있다. 이 결과는
    // "이미 정확히 패치된 최종 상태"임을 표시해 그 복구 로직을 건너뛰게 한다.
    tableJson.props._isMutateResult = true;
    // 프론트엔드가 Comparison Table 이력 배너(꼬리 질문 목록)를 구성할 때 쓰는 메타데이터.
    tableJson.props._lastMutateOp = args.op;
    tableJson.props._lastMutateOpSummary = args.op_summary;

    try {
      const { reasoning } = await time("mutate_comp_table.ranking_llm", capturedRequestId, () =>
        computeRankingAndReasoning(tableJson, currentDecisionCriteria, currentLocale)
      );
      if (reasoning) tableJson.props._rankReasoning = reasoning;
    } catch (err) {
      console.warn("[mutateComparisonTable] 순위 재계산 실패, 기존 값 유지:", err);
    }

    if (capturedRequestId) pushCompTableResult(capturedRequestId, tableJson);
    return tableJson;
  },
});
