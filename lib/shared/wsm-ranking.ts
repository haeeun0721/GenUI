/**
 * lib/shared/wsm-ranking.ts
 * ComparisonTable의 WSM(가중합) 순위 계산 — 프론트(app/page.tsx의 즉시 재계산)와
 * 백엔드(lib/backend/agents/data_agent.ts의 computeRankingAndReasoning)가 각자 따로
 * 구현해 두고 있던 것을 하나로 합친 것.
 *
 * 서버 전용 모듈(ai SDK, fs 등)에 의존하지 않는 순수 함수만 담는다 — 클라이언트
 * 컴포넌트(app/page.tsx)에서도 그대로 import해서 쓸 수 있어야 하기 때문이다.
 *
 * 기준별 가중치를 어디서 구할지(문자열 "[중요]" 태그 파싱 vs 구조화된 criteria 배열
 * 조회)는 호출자마다 데이터 형태가 달라서 getWeight 콜백으로 남겨뒀지만, 그 외
 * 핵심 채점/순위 로직은 이 파일 하나만 고치면 양쪽 모두에 반영된다.
 */

export type ImportanceLevel = "high" | "medium" | "low";

export const IMPORTANCE_WEIGHTS: Record<ImportanceLevel, number> = {
  high: 0.5,
  medium: 0.3,
  low: 0.2,
};

/** "high"/"중요" 등 다양한 표기를 가중치 숫자로 변환. 알 수 없는 값은 medium(0.3) 취급. */
export function importanceLevelToWeight(level: string | null | undefined): number {
  if (level === "high" || level === "중요") return IMPORTANCE_WEIGHTS.high;
  if (level === "low" || level === "낮음") return IMPORTANCE_WEIGHTS.low;
  return IMPORTANCE_WEIGHTS.medium;
}

/** 값이 낮을수록 좋은 기준인지 판별 (예: 소음, 무게, 가격). */
export function isLowerBetterCriterion(criterion: string): boolean {
  return /소음|무게|중량|가격|충전\s*시간|두께|price|noise|weight|db/i.test(criterion);
}

export function extractNumericValue(val: string): number | null {
  const m = String(val ?? "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/** 수치가 아닌 정성적 셀 값(예: "○"/"X"/"지원")을 0~1 점수로 변환. */
export function scoreCellValue(val: string): number {
  const v = String(val ?? "").trim();
  if (!v || v === "-") return 0.5;
  const lower = v.toLowerCase();
  if (v === "○" || ["있음", "지원", "yes"].some((k) => lower.includes(k))) return 1.0;
  if (v === "X" || ["없음", "미지원", "no"].some((k) => lower.includes(k))) return 0.0;
  return 0.6;
}

export interface RankableRow {
  criterion?: string;
  [productColKey: string]: unknown;
}

export interface RankableColumn {
  key: string;
  [extra: string]: unknown;
}

/**
 * 기준(행) × 제품(열) 셀 값들로부터 WSM 가중합 점수를 계산하고, "순위"/"Rank" 행에
 * "N위"/"공동 N위" 라벨을 채운 새 rows 배열을 반환한다. 입력 rows/row 객체는 변경하지 않는다.
 * 순위 행이 없거나 제품 컬럼이 없으면 원본을 그대로 반환한다.
 */
export function computeWsmRanking<Row extends RankableRow>(
  rows: Row[],
  columns: RankableColumn[],
  getWeight: (criterion: string) => number
): Row[] {
  const productCols = columns.filter((c) => c.key !== "criterion");
  const hasRankRow = rows.some((r) => r.criterion === "순위" || r.criterion === "Rank");
  if (productCols.length === 0 || !hasRankRow) return rows;

  const scores: Record<string, number> = {};
  const weightSums: Record<string, number> = {};
  for (const col of productCols) { scores[col.key] = 0; weightSums[col.key] = 0; }

  for (const row of rows) {
    const criterion = row.criterion ?? "";
    if (!criterion || criterion === "순위" || criterion === "Rank") continue;
    const w = getWeight(criterion);

    const nums: Record<string, number> = {};
    for (const col of productCols) {
      const n = extractNumericValue(String(row[col.key] ?? "-"));
      if (n !== null) nums[col.key] = n;
    }
    const numVals = Object.values(nums);
    const numMin = numVals.length ? Math.min(...numVals) : 0;
    const numMax = numVals.length ? Math.max(...numVals) : 0;
    const hasVariance = Object.keys(nums).length >= 2 && numMin !== numMax;
    const lower = isLowerBetterCriterion(criterion);

    for (const col of productCols) {
      const cellVal = String(row[col.key] ?? "-");
      let s: number;
      if (hasVariance && col.key in nums) {
        const norm = (nums[col.key] - numMin) / (numMax - numMin);
        s = 0.2 + (lower ? 1 - norm : norm) * 0.8;
      } else {
        s = scoreCellValue(cellVal);
      }
      scores[col.key] += s * w;
      weightSums[col.key] += w;
    }
  }

  for (const col of productCols) {
    scores[col.key] = weightSums[col.key] > 0 ? scores[col.key] / weightSums[col.key] : 0;
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  return rows.map((row) => {
    if (row.criterion !== "순위" && row.criterion !== "Rank") return row;
    const updated = { ...row } as Row;
    let rank = 1, i = 0;
    while (i < sorted.length) {
      const score = sorted[i][1];
      let j = i;
      while (j < sorted.length && sorted[j][1] === score) j++;
      const tiedCount = j - i;
      const label = tiedCount > 1 ? `공동 ${rank}위` : `${rank}위`;
      for (let k = i; k < j; k++) (updated as Record<string, unknown>)[sorted[k][0]] = label;
      rank += tiedCount;
      i = j;
    }
    return updated;
  });
}
