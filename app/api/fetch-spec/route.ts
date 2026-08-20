/**
 * POST /api/fetch-spec
 * Comparison Table 패널용: 칼럼(기준) 추가 시 제품별 스펙 조회
 * Body: { products: { name, link? }[], criteria: string, category?: string }
 * Response: Record<productName, specValue>
 */

import { NextRequest, NextResponse } from "next/server";
import { lookupProductSpec } from "@/lib/backend/services/spec-lookup";
import { expandCriterionMeta } from "@/lib/backend/agents/data_agent";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { products, criteria, category = "unknown", locale = "ko" } = (await req.json()) as {
      products: { name: string; link?: string }[];
      criteria: string;
      category?: string;
      locale?: string;
    };

    if (!products?.length || !criteria) {
      return NextResponse.json({ error: "Missing products or criteria" }, { status: 400 });
    }

    console.log(`\n====== [fetch-spec] 기준: "${criteria}" (${products.length}개 제품) ======`);

    // 소음/흡입력처럼 청소 모드에 따라 값이 갈리는 기준은, 힌트 없이 제품마다 독립
    // 검색하면 서로 다른 조건의 값을 주워와 비교가 불공정해진다 — auto-enrich/
    // mutate-comptable과 동일하게 미리 힌트를 구해 흘려보낸다.
    const meta = (await expandCriterionMeta([criteria]))[criteria];

    const entries = await Promise.all(
      products.map(async p => {
        console.log(`  [fetch-spec] "${p.name}" → "${criteria}" 검색 중...`);
        const result = await lookupProductSpec(p.name, criteria, category, locale, meta?.formatHint, meta?.canonicalUnit, meta?.preferredCondition, meta?.type);
        const value = result.value === "-" ? "-" : (result.uncertain ? `${result.value} (추정)` : result.value);
        if (result.uncertain) {
          console.log(`  [fetch-spec] ⚠️ "${p.name}" × "${criteria}" = "${result.value}" (불확실 → 추정 표시)`);
        } else {
          console.log(`  [fetch-spec] "${p.name}" → "${criteria}" = "${value}"`);
        }
        return [p.name, value] as const;
      })
    );

    const result = Object.fromEntries(entries);
    console.log(`[fetch-spec] Results:`, result);
    console.log(`======================================================\n`);

    return NextResponse.json(result);
  } catch (err) {
    console.error("[fetch-spec] Error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}
