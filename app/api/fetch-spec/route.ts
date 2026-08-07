/**
 * POST /api/fetch-spec
 * Comparison Table 패널용: 칼럼(기준) 추가 시 제품별 스펙 조회
 * Body: { products: { name, link? }[], criteria: string, category?: string }
 * Response: Record<productName, specValue>
 */

import { NextRequest, NextResponse } from "next/server";
import { lookupProductSpec } from "@/lib/backend/services/spec-lookup";

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

    const entries = await Promise.all(
      products.map(async p => {
        console.log(`  [fetch-spec] "${p.name}" → "${criteria}" 검색 중...`);
        const result = await lookupProductSpec(p.name, criteria, category, locale);
        // uncertain=true(시도 간 값 불일치)는 비교표에 표시하지 않음 → 오정보보다 공백이 낫다
        const value = (result.value === "-" || result.uncertain === true) ? "-" : result.value;
        if (result.uncertain) {
          console.log(`  [fetch-spec] ⚠️ "${p.name}" × "${criteria}" 불확실 값 차단 (원래 값: ${result.value})`);
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
