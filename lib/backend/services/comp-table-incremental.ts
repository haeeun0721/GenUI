/**
 * lib/backend/services/comp-table-incremental.ts
 *
 * Comparison Table 증분(patch) 업데이트 — 기존 테이블에 새 기준 행만 추가한다.
 * 원래 app/api/update-table/route.ts의 STRATEGY A로 인라인돼 있던 로직을, /api/auto-enrich
 * 에서도 같은 요청 한 번 안에서 재사용할 수 있도록 여기로 옮겼다(값 검색을 한 번만 하고
 * Option List 카드와 Comparison Table을 동시에 갱신하기 위함 — Tavily 재검색 없이 같은
 * 프로세스 안에서 이미 구한 값을 prefetchedValues로 넘겨 재사용하는 구조는 그대로 유지).
 */

import { findProductInLocalDB, expandCriterionMeta, findExactMatchingProduct } from "../agents/data_agent";
import { computeRankingAndReasoning } from "../agents/generators/comp_table";
import { lookupProductSpec } from "./spec-lookup";
import { getCachedSpec, setCachedSpec } from "./spec-cache";
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
  requestId: string = "",
  participantId: string = ""
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
    // 후보가 여럿이면(예: "로보락 S10 MaxV Slim"과 "...Slim 직배수"처럼 실제로 다른 두
    // 제품이 서로를 포함하는 경우) 확신할 수 없으므로 매칭하지 않는다 — 잘못 매칭해서
    // 다른 제품의 스펙 값을 이 컬럼에 붙이는 것보다, 아래 로컬 DB/원래 라벨 폴백으로
    // 넘어가는 게 안전하다.
    const cardCandidates = (currentCards ?? []).filter((c: any) => c?.name);
    const matchCard = findExactMatchingProduct(shortLabel, cardCandidates);
    if (matchCard?.name) {
      fullNameMap.set(shortLabel, matchCard.name);
      continue;
    }
    // 카드 매칭이 실패했을 때, 그게 "후보가 아예 없어서"인지 "후보가 둘 이상이라 애매해서"인지
    // 구분해서 로그로 남긴다 — 후자만 findExactMatchingProduct 도입으로 새로 생긴 케이스다.
    const looseCandidateCount = cardCandidates.filter((c: any) => {
      const a = c.name.toLowerCase().replace(/\s+/g, "");
      const b = shortLabel.toLowerCase().replace(/\s+/g, "");
      return a.includes(b) || b.includes(a);
    }).length;
    if (looseCandidateCount >= 2) {
      console.warn(`[comp-table-incremental] fullNameMap: "${shortLabel}" → 카드 후보 ${looseCandidateCount}개가 애매하게 겹쳐 매칭 보류 (동명이인 방지)`);
    }

    const dbEntry = findProductInLocalDB(category, shortLabel);
    if (dbEntry) {
      const nameMatch = dbEntry.match(/Name:\s*(.+)/);
      fullNameMap.set(shortLabel, nameMatch ? nameMatch[1].trim() : shortLabel);
      console.log(`[comp-table-incremental] fullNameMap: "${shortLabel}" → DB 매칭 "${fullNameMap.get(shortLabel)}"`);
    } else {
      // 화면 카드/로컬 DB 어디에서도 확신할 수 있는 이름을 못 찾음 — 짧은 라벨 그대로
      // 검색어로 쓴다(정보가 부실할 수 있는 케이스). 얼마나 자주 여기로 떨어지는지
      // 추적하기 위한 로그 — findExactMatchingProduct 도입 후 "정보 없음" 비율이
      // 늘었는지 확인할 때 이 로그 빈도를 본다.
      fullNameMap.set(shortLabel, shortLabel);
      console.warn(`[comp-table-incremental] fullNameMap: "${shortLabel}" → 매칭 실패, 라벨 그대로 검색 (카드/DB 모두 확신 가능한 후보 없음)`);
    }
  }

  // "소음 수준"/"흡입력"처럼 청소 모드에 따라 다르게 보고되는 기준은 힌트 없이 제품마다
  // 독립 검색하면 서로 다른 모드의 값을 주워와 비교가 불공정해진다 — prefetchedValues로
  // 못 채운 셀(아래 lookupProductSpec 폴백)에 대비해 여기서도 미리 구해둔다.
  const criterionMeta = await expandCriterionMeta(newCriteria.map(cleanCriterionLabel));

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
        const meta = criterionMeta[cleanLabel];

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

            // 이 요청 안에 없어도, 같은 참가자가 예전 턴/다른 패널에서 이미 조회해둔
            // 값이 있으면 재사용한다(spec-cache.ts, 참가자별로 격리됨).
            const cached = await getCachedSpec(participantId, fullName, cleanLabel);
            if (cached) {
              newRow[col.key] = cached;
              console.log(`[comp-table-incremental] "${fullName}" × "${cleanLabel}" → "${cached}" (source=participant-cache)`);
              return;
            }

            const result = await lookupProductSpec(fullName, cleanLabel, category, locale, meta?.formatHint, meta?.canonicalUnit, meta?.preferredCondition, meta?.type);
            newRow[col.key] = result.uncertain && result.value !== "-" ? `${result.value} (추정)` : result.value;
            console.log(`[comp-table-incremental] "${fullName}" × "${cleanLabel}" → "${newRow[col.key]}" (source=${result.source}${result.uncertain ? ", 불확실" : ""})`);
            if (!result.uncertain && result.value !== "-") void setCachedSpec(participantId, fullName, cleanLabel, result.value);
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
