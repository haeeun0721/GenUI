/**
 * lib/backend/services/comp-table-incremental.ts
 *
 * Comparison Table 증분(patch) 업데이트 — 기존 테이블에 새 기준 행만 추가한다.
 * 원래 app/api/update-table/route.ts의 STRATEGY A로 인라인돼 있던 로직을, /api/auto-enrich
 * 에서도 같은 요청 한 번 안에서 재사용할 수 있도록 여기로 옮겼다(값 검색을 한 번만 하고
 * Option List 카드와 Comparison Table을 동시에 갱신하기 위함 — Tavily 재검색 없이 같은
 * 프로세스 안에서 이미 구한 값을 prefetchedValues로 넘겨 재사용하는 구조는 그대로 유지).
 */

import { findProductInLocalDB } from "../agents/data_agent";
import { computeRankingAndReasoning } from "../agents/generators/comp_table";
import { lookupProductSpec } from "./spec-lookup";
import { time } from "../timing";

export interface PrefetchedValue {
  product_name: string;
  field_key: string;
  value: string | null;
}

function cleanCriterionLabel(c: string): string {
  return c.replace(/\s*\[.*?\]\s*/g, "").replace(/\s*\(.*?\)\s*/g, "").trim();
}

// 사용자가 실제로 제거한 기준(removedCriteriaNames)에 대해서만, 느슨한 부분일치로 행을 제거한다.
// criteria 화이트리스트와의 엄격한 문자열 일치로 "존재하는 행"을 판단하지 않는다 — 표현 차이(공백/괄호/문구)로
// 멀쩡한 행이 오탐 삭제되는 것을 방지하기 위함. 행 삭제 트리거는 오직 "기준 칩 제거"뿐이어야 한다.
function dropRemovedCriteriaRows(rows: any[], removedCriteriaNames: string[]): any[] {
  if (!removedCriteriaNames?.length) return rows;
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const removedNorm = removedCriteriaNames.map((n) => norm(cleanCriterionLabel(n)));
  return rows.filter((r: any) => {
    if (r.criterion === "순위" || r.criterion === "Rank") return true;
    const rowNorm = norm(cleanCriterionLabel(String(r.criterion ?? "")));
    return !removedNorm.some((rn) => rn && (rowNorm === rn || rowNorm.includes(rn) || rn.includes(rowNorm)));
  });
}

/** currentTableData가 증분 업데이트의 시드로 쓸 수 있는 유효한 테이블인지 확인한다. */
export function isValidTableSeed(currentTableData: any): boolean {
  return !!(
    currentTableData?.props?.columns?.length > 1 &&
    Array.isArray(currentTableData?.props?.rows)
  );
}

/**
 * 기존 테이블(currentTableData, isValidTableSeed로 검증된 것)에 새 기준 행을 추가하고,
 * 제거된 기준 행을 지운 뒤 순위를 재계산한 tableJson을 반환한다.
 *
 * prefetchedValues에 (제품×기준) 값이 있으면 그걸 그대로 쓰고 lookupProductSpec을 다시
 * 부르지 않는다 — 같은 값을 두 번 독립적으로 검색해 값이 갈리는 걸 막기 위함. 호출자가
 * 같은 요청 안에서 이미 값을 구했다면(auto-enrich 병합 경로) 그 결과를, 별도 요청으로
 * prefetched된 값이 없다면(app/api/update-table STRATEGY A 단독 호출) 빈 배열을 넘기면 된다.
 */
export async function buildIncrementalTableUpdate(
  currentTableData: any,
  criteria: string[],
  currentCards: any[],
  category: string,
  locale: string,
  removedCriteriaNames: string[] = [],
  prefetchedValues: PrefetchedValue[] = [],
  requestId: string = ""
): Promise<any> {
  const normKey = (criterion: string, productName: string) =>
    `${cleanCriterionLabel(criterion).replace(/\s+/g, "").toLowerCase()}__${productName.replace(/\s+/g, "").toLowerCase()}`;
  const prefetchedMap = new Map<string, string>();
  for (const p of prefetchedValues) {
    if (p.value) prefetchedMap.set(normKey(p.field_key, p.product_name), p.value);
  }

  const tableJson = JSON.parse(JSON.stringify(currentTableData)); // deep copy
  const cols: any[] = tableJson.props.columns;
  const rows: any[] = tableJson.props.rows;
  const productCols = cols.filter((c: any) => c.key !== "criterion");

  const existingCriteriaClean = new Set(
    rows
      .filter((r: any) => r.criterion && r.criterion !== "순위" && r.criterion !== "Rank")
      .map((r: any) => cleanCriterionLabel(r.criterion).toLowerCase())
  );

  const newCriteria = criteria.filter(
    (c) => !existingCriteriaClean.has(cleanCriterionLabel(c).toLowerCase())
  );
  console.log(
    `[comp-table-incremental] 기존 기준 ${existingCriteriaClean.size}개, 신규 기준 ${newCriteria.length}개: [${newCriteria.join(", ")}]`
  );

  if (newCriteria.length === 0) {
    // 새로 추가할 기준은 없음 (중요도 변경 등) → removedCriteriaNames가 있을 때만 행 제거, 순위 재계산
    tableJson.props.rows = dropRemovedCriteriaRows(rows, removedCriteriaNames);
    const { reasoning } = await time("comp_table_incremental.ranking_llm", requestId, () =>
      computeRankingAndReasoning(tableJson, criteria, locale)
    );
    if (reasoning) tableJson.props._rankReasoning = reasoning;
    console.log("[comp-table-incremental] 순위 재계산 완료 (행 삭제: " + removedCriteriaNames.length + "개)");
    return tableJson;
  }

  // 제품 전체 이름 매핑: col.label → fullName
  // Option List(auto-enrich)는 card.name을 그대로 lookupProductSpec에 넘기므로,
  // 여기서도 반드시 동일한 문자열을 써야 prefetchedMap 키(normKey)가 같은 키로 맞아떨어져
  // 넘겨받은 prefetchedValues를 인식하고 재사용할 수 있다.
  const fullNameMap = new Map<string, string>();
  for (const col of productCols) {
    const shortLabel = col.label;
    const matchCard = currentCards?.find(
      (c: any) => c.name?.includes(shortLabel) || shortLabel.includes(c.name)
    );
    if (matchCard?.name) {
      fullNameMap.set(shortLabel, matchCard.name);
      continue;
    }
    const dbEntry = findProductInLocalDB(category, shortLabel);
    if (dbEntry) {
      const nameMatch = dbEntry.match(/Name:\s*(.+)/);
      fullNameMap.set(shortLabel, nameMatch ? nameMatch[1].trim() : shortLabel);
    } else {
      fullNameMap.set(shortLabel, shortLabel);
    }
  }

  // 새 기준 × 각 제품 → lookupProductSpec (캐시→DB→Tavily 3단계+검증, mutate-comptable.ts와 공유)
  // 예전엔 기준을 for-of로 하나씩 순회하며 그 안에서만 제품끼리 병렬 조회했다 — 기준이
  // 여러 개면(예: 배터리 수명 + 소음 수준 동시 추가) 기준 수만큼 Tavily 왕복이 직렬로
  // 쌓였다. auto-enrich/route.ts의 (카드×기준) 전체 조합 병렬화와 동일하게, 여기서도
  // (신규기준×제품) 전체 조합을 하나의 Promise.all로 동시에 조회한다.
  const newRows = await time("comp_table_incremental.new_rows_lookup", requestId, () =>
    Promise.all(
      newCriteria.map(async (criterion) => {
        const cleanLabel = cleanCriterionLabel(criterion);
        const newRow: Record<string, string> = { criterion: cleanLabel };

        await Promise.all(
          productCols.map(async (col) => {
            const productLabel = col.label;
            const fullName = fullNameMap.get(productLabel) ?? productLabel;

            const prefetched = prefetchedMap.get(normKey(cleanLabel, fullName));
            if (prefetched) {
              newRow[col.key] = prefetched;
              console.log(`[comp-table-incremental] "${fullName}" × "${cleanLabel}" → "${prefetched}" (source=prefetched)`);
              return;
            }

            const result = await lookupProductSpec(fullName, cleanLabel, category, locale);
            newRow[col.key] = result.uncertain && result.value !== "-" ? `${result.value} (추정)` : result.value;
            console.log(`[comp-table-incremental] "${fullName}" × "${cleanLabel}" → "${newRow[col.key]}" (source=${result.source}${result.uncertain ? ", 불확실" : ""})`);
          })
        );

        console.log(`[comp-table-incremental] 새 행 준비 완료: "${cleanLabel}"`);
        return newRow;
      })
    )
  );

  const rankIdx = rows.findIndex(
    (r: any) => r.criterion === "순위" || r.criterion === "Rank"
  );
  if (rankIdx === -1) rows.push(...newRows);
  else rows.splice(rankIdx + 1, 0, ...newRows);

  tableJson.props.rows = dropRemovedCriteriaRows(rows, removedCriteriaNames);

  const { reasoning } = await time("comp_table_incremental.ranking_llm", requestId, () =>
    computeRankingAndReasoning(tableJson, criteria, locale)
  );
  if (reasoning) tableJson.props._rankReasoning = reasoning;

  return tableJson;
}
