import { tool } from "ai";
import { z } from "zod";
import {
  currentRequestId,
  pushCompTableResult,
  currentDecisionCriteria,
  currentProductCategory,
  currentLocale,
} from "./sidebar-store";
import { findProductInLocalDB, expandCriterionMeta, normalizeCriterionRowAcrossProducts, NOT_APPLICABLE_TEXT } from "../agents/data_agent";
import { computeRankingAndReasoning } from "../agents/generators/comp_table";
import { ragSearch, findExactProduct } from "../rag/search";
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

/**
 * data_agent.ts의 enrichCompTableCells(STEP 5)와 동일한 기준별 교차 정규화 — 단위를
 * 하나로 통일하고(mm/cm, mAh/Ah 등), "8.0스톱" vs "5축광학식"처럼 애초에 다른 개념/형식으로
 * 보고된 값들도 서로 비교 가능한 형태로 맞춘다. 이 파일(mutate 경로)은 셀을 제품×기준별로
 * 하나씩 독립 조회하기 때문에, 다른 제품과 나란히 놓고 봐야만 드러나는 이 불일치를 원래는
 * 스스로 걸러내지 못했다 — 새 파이프라인(enrichCompTableCells)에만 있던 이 단계를 여기서도
 * 재사용한다.
 */
async function normalizeRows(rowsToNormalize: any[], allProductCols: any[], locale: string): Promise<void> {
  const criteria = [...new Set(
    rowsToNormalize.map((r) => String(r.criterion ?? "")).filter((c) => c && c !== "순위" && c !== "Rank")
  )];
  await Promise.all(
    criteria.map(async (criterion) => {
      const row = rowsToNormalize.find((r) => r.criterion === criterion);
      if (!row) return;
      const entries = allProductCols
        .map((col: any) => ({ colKey: col.key, label: col.label, value: String(row[col.key] ?? "-") }))
        .filter((e) => e.value && e.value !== "-" && e.value !== "○" && e.value !== "X" && !Object.values(NOT_APPLICABLE_TEXT).includes(e.value));
      if (entries.length < 2) return;

      const updates = await normalizeCriterionRowAcrossProducts(criterion, entries, locale);
      for (const e of entries) {
        const updated = updates[e.colKey]?.trim();
        if (updated && updated !== e.value) {
          row[e.colKey] = updated;
          console.log(`[mutateComparisonTable] 🔁 정규화 "${criterion}" × "${e.label}": "${e.value}" → "${updated}"`);
        }
      }
    })
  );
}

export const mutateComparisonTable = tool({
  description: `
Add or remove criterion ROWS, or add/remove product COLUMNS, on the CURRENTLY DISPLAYED ComparisonTable.
Only use when [CURRENT_COMPARISON_TABLE] is present. Cannot re-check a single cell.
`.trim(),
  inputSchema: z.object({
    surface: z.literal("comparisonTable"),
    op: z.enum(["add_criteria", "remove_criteria", "add_product", "remove_product", "replace_products"]),
    current_table: z.any().describe("The current Table spec JSON ({ props: { columns, rows } }) to patch in place."),
    criteria_to_add: z.array(z.string()).optional(),
    criteria_to_remove: z.array(z.string()).optional().describe("remove_criteria: row `id`s (e.g. 'crit_1') copied from CURRENT_COMPARISON_TABLE — falls back to label matching if an id isn't recognized."),
    products_to_add: z.array(z.string()).optional().describe("add_product: product names/brands/queries to search for (RAG) and add as new columns. replace_products: same field, but the full replacement set — existing columns not listed are dropped."),
    products_to_remove: z.array(z.string()).optional().describe("remove_product: column `key`s (e.g. 'prod_1') copied from CURRENT_COMPARISON_TABLE — falls back to label matching if a key isn't recognized."),
    op_summary: z.string().describe("Brief user-facing description of the action, in the response locale."),
  }),
  execute: async (args) => {
    // ⚠️ 아래 여러 await(RAG 검색/스펙 조회/순위 재계산) 도중 다른 요청이 시작돼
    // 전역을 덮어써도 이 요청은 계속 자기 값을 쓰도록 시작 시점에 캡처한다.
    const capturedRequestId = currentRequestId;
    const capturedProductCategory = currentProductCategory;
    const capturedLocale = currentLocale;
    const capturedDecisionCriteria = currentDecisionCriteria;
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
        const dbEntry = findProductInLocalDB(capturedProductCategory, col.label);
        const nameMatch = dbEntry?.match(/Name:\s*(.+)/);
        fullNameMap.set(col.label, nameMatch ? nameMatch[1].trim() : col.label);
      }

      const newRows = toAdd.map((criterion) => {
        const newRow: Record<string, string> = { id: genRowId(), criterion };
        for (const col of productCols) newRow[col.key] = "-";
        return newRow;
      });

      // "소음 수준"/"흡입력"처럼 청소 모드(조용/일반/강력)에 따라 다르게 보고되는 기준은,
      // 힌트 없이 각 제품을 독립적으로 검색하면 제품마다 다른 모드의 값을 주워와 비교가
      // 불공정해진다(예: A는 최저소음 모드 63dB, B는 일반 모드 65dB). renderToCompTable
      // 최초 생성 경로(data_agent.ts enrichCompTableCells)는 이미 expandCriterionMeta로
      // preferredCondition을 구해 검색·추출에 반영하는데, 이 add_criteria 경로는 그 계산을
      // 아예 안 하고 있었다 — 여기서도 같은 힌트를 구해 resolveSpecValue에 그대로 흘려보낸다.
      const criterionMeta = await expandCriterionMeta(toAdd);

      // (신규기준×제품) 전체 조합을 하나의 Promise.all로 동시에 조회한다 — comp-table-incremental.ts와
      // 동일한 패턴. 예전엔 기준마다 순서대로 기다렸어서(기준 안에서만 제품 병렬), 기준을
      // 여러 개 한 번에 추가하면 그 개수만큼 순차 barrier가 쌓였다.
      await time("mutate_comp_table.add_criteria_lookup", capturedRequestId, () =>
        Promise.all(
          newRows.flatMap((newRow) =>
            productCols.map(async (col: any) => {
              const criterion = newRow.criterion;
              const fullName = fullNameMap.get(col.label) ?? col.label;
              const meta = criterionMeta[criterion];
              const result = await resolveSpecValue(fullName, criterion, capturedProductCategory, capturedLocale, meta?.formatHint, meta?.canonicalUnit, meta?.preferredCondition, meta?.type);
              newRow[col.key] = result.uncertain && result.value !== "-" ? `${result.value} (추정)` : result.value;
              console.log(`[mutateComparisonTable] "${fullName}" × "${criterion}" → "${newRow[col.key]}" (source=${result.source}${result.uncertain ? ", 불확실" : ""})`);
            })
          )
        )
      );

      // 새로 채운 각 행을 제품끼리 교차 비교해 단위/형식을 통일한다 (위 helper 설명 참고).
      await time("mutate_comp_table.add_criteria_normalize", capturedRequestId, () =>
        normalizeRows(newRows, productCols, capturedLocale)
      );

      for (const newRow of newRows) {
        const rankIdx = rows.findIndex((r: any) => r.criterion === "순위" || r.criterion === "Rank");
        if (rankIdx === -1) rows.push(newRow);
        else rows.splice(rankIdx + 1, 0, newRow);
        console.log(`[mutateComparisonTable] 새 행 추가: "${newRow.criterion}"`);
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
    } else if (args.op === "add_product" || args.op === "replace_products") {
      if (args.op === "replace_products") {
        // "add_product"처럼 기존 제품 위에 얹지 않고, 닫힌 집합으로 교체한다 — 기존 제품
        // 컬럼과 그 셀 값을 전부 지운 뒤 요청받은 제품들로만 다시 채운다. edit_agent는
        // 사용자가 가산 표현("~도"/"추가로") 없이 특정 제품들을 닫힌 목록으로 지목했을
        // 때만 이 op을 고른다 — 예: "A, B, C 비교해줘"(닫힌 목록 → 여기) vs
        // "A도 비교해줘"(가산 → add_product, 위 분기와 공유하지 않고 그대로 유지).
        const criterionCol = cols.find((c: any) => c.key === "criterion");
        const removedKeys = new Set(cols.filter((c: any) => c.key !== "criterion").map((c: any) => c.key));
        cols.length = 0;
        if (criterionCol) cols.push(criterionCol);
        rows = rows.map((r: any) => {
          const next = { ...r };
          removedKeys.forEach((k) => { delete next[k]; });
          return next;
        });
        console.log(`[mutateComparisonTable/replace_products] 기존 제품 컬럼 ${removedKeys.size}개 제거`);
      }

      const requested = (args.products_to_add ?? []).map((s) => s.trim()).filter(Boolean);
      // add_product는 기존 컬럼을 유지하므로 위쪽의 productCols(요청 시작 시점 스냅샷)를 그대로
      // 쓰면 되지만, replace_products는 방금 cols를 비웠으므로 반드시 지금 시점의 cols에서
      // 다시 읽어야 한다 — 두 op이 이 지점부터 로직을 공유하기 위해 항상 다시 계산한다.
      const currentProductCols = cols.filter((c: any) => c.key !== "criterion");
      const existingLabelsLower = new Set(currentProductCols.map((c: any) => c.label.toLowerCase()));

      const searchResults = await time("mutate_comp_table.rag_search", capturedRequestId, () =>
        Promise.all(
          requested.map(async (q) => {
            try {
              // 사용자가 이미 정확한 제품명("로보락 S10 MaxV Slim 직배수" 등)을 말한 경우,
              // 임베딩 유사도 순위에 기대지 않고 로컬 DB에서 결정론적으로 먼저 찾는다 —
              // "직배수"/"Ultra"/"Slim"처럼 이름이 거의 같은 변형이 여러 개 있으면 임베딩
              // 순위가 top-K 밖으로 밀어낼 수 있어서(아래 filtered()가 걸러낼 기회조차
              // 없이 found[0](엉뚱한 변형)로 폴백), 정확 매칭이 있으면 그걸로 확정한다.
              const exact = findExactProduct(q, capturedProductCategory);
              if (exact) return exact;

              const found = await ragSearch(q, capturedProductCategory, 20, currentProductCols.map((c: any) => c.label));
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

      // 새 컬럼 key를 먼저 전부 확정한다 — 반복문 안에서 cols.push 직후 다음 idx를
      // 다시 찾던 방식은 순차 진행에 의존해서 병렬화할 수 없었다.
      const usedKeys = new Set(cols.map((c: any) => c.key));
      const newCols = newProducts.map((prod) => {
        let idx = 0;
        while (usedKeys.has(`prod_${idx}`)) idx++;
        const key = `prod_${idx}`;
        usedKeys.add(key);
        return { key, label: prod.name, imageUrl: (prod as any).image ?? "", prod };
      });
      cols.push(...newCols.map(({ key, label, imageUrl }) => ({ key, label, imageUrl })));

      // add_criteria와 동일한 이유 — 새로 들어오는 제품이 기존 기준(예: 소음 수준)에서
      // 다른 제품들과 다른 모드로 조회되지 않도록, 기존 행들에 대해서도 preferredCondition
      // 힌트를 구해 넘긴다.
      const criterionMeta = await expandCriterionMeta(criterionRows.map((r: any) => String(r.criterion ?? "")));

      // (신규제품×기준) 전체 조합을 하나의 Promise.all로 동시에 조회한다 — comp-table-incremental.ts와
      // 동일한 패턴. 예전엔 제품마다 순서대로 기다렸어서(제품 안에서만 기준 병렬), 제품을
      // 여러 개 한 번에 추가하면 그 개수만큼 순차 barrier가 쌓였다.
      await time("mutate_comp_table.add_product_lookup", capturedRequestId, () =>
        Promise.all(
          newCols.flatMap(({ key: newKey, prod }) =>
            criterionRows.map(async (row: any) => {
              const criterion = String(row.criterion ?? "");
              const meta = criterionMeta[criterion];
              const result = await resolveSpecValue(prod.name, criterion, capturedProductCategory, capturedLocale, meta?.formatHint, meta?.canonicalUnit, meta?.preferredCondition, meta?.type);
              row[newKey] = result.uncertain && result.value !== "-" ? `${result.value} (추정)` : result.value;
              console.log(`[mutateComparisonTable/add_product] "${prod.name}" × "${criterion}" → "${row[newKey]}" (source=${result.source}${result.uncertain ? ", 불확실" : ""})`);
            })
          )
        )
      );

      // 새로 채워진 값(추가 제품 컬럼)까지 포함해 각 행을 제품끼리 교차 비교해 단위/형식을
      // 통일한다. replace_products는 컬럼을 통째로 비웠다가 다시 채웠으므로, 여기서 cols를
      // 다시 읽어야 실제로 화면에 남는 전체 제품 컬럼 기준으로 정규화된다.
      const allProductColsNow = cols.filter((c: any) => c.key !== "criterion");
      await time("mutate_comp_table.add_product_normalize", capturedRequestId, () =>
        normalizeRows(criterionRows, allProductColsNow, capturedLocale)
      );

      for (const { label } of newCols) console.log(`[mutateComparisonTable/add_product] 새 제품 컬럼 추가: "${label}"`);
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
        computeRankingAndReasoning(tableJson, capturedDecisionCriteria, capturedLocale)
      );
      if (reasoning) tableJson.props._rankReasoning = reasoning;
    } catch (err) {
      console.warn("[mutateComparisonTable] 순위 재계산 실패, 기존 값 유지:", err);
    }

    if (capturedRequestId) pushCompTableResult(capturedRequestId, tableJson);
    return tableJson;
  },
});
