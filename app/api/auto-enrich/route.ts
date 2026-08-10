/**
 * POST /api/auto-enrich
 * Option List 패널용: 기준(criterion) 변경 시 전체 카드 스펙 일괄 보강
 * Body: { cards, criterion, category }
 * Response: { updates, unconfirmed }
 */

import { NextRequest, NextResponse } from "next/server";
import { lookupProductSpec, buildSpecPhrase } from "@/lib/backend/services/spec-lookup";

export const maxDuration = 60;

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const { cards, criterion, category, locale = "ko" } = await req.json() as {
      cards:       { name: string; price?: string; specs: string[] }[];
      criterion:   string;
      category:    string;
      locale?:     string;
    };

    if (!cards?.length || !criterion || !category) {
      return NextResponse.json({ updates: [], unconfirmed: [] });
    }

    const fieldKey = criterion;
    const isPrice  = ["가격", "price"].some(kw => fieldKey.toLowerCase().includes(kw));

    console.log(`\n[auto-enrich] "${criterion}" | ${cards.length}개 카드: ${cards.map(c => c.name).join(" / ")}`);

    // ── 1. 병렬 스펙 조회 ────────────────────────────────────────────────────
    const results = await Promise.all(
      cards.map(async card => {
        // 가격 기준: card.price 직접 사용
        if (isPrice && card.price) return { card, specPhrase: card.price, uncertain: false, value: card.price };

        // 이미 보유 중이면 건너뜀
        const alreadyHas = card.specs?.some(s =>
          s.toLowerCase().includes(fieldKey.toLowerCase())
        );
        if (alreadyHas) return { card, specPhrase: null, uncertain: false, value: null, skip: true };

        const result = await lookupProductSpec(card.name, fieldKey, category, locale);
        if (result.value === "-") return { card, specPhrase: null, uncertain: false, value: null };

        const specPhrase = buildSpecPhrase(fieldKey, result.value);

        return { card, specPhrase, uncertain: result.uncertain ?? false, value: result.value, skip: false };
      })
    );

    // ── 2. 결과 분류 ─────────────────────────────────────────────────────────
    // value: lookupProductSpec의 원본 값(마케팅 수식어 제거 전 buildSpecPhrase 가공 전 상태) —
    // 이 요청에서 이미 검색/판단을 마쳤다는 걸 Comparison Table 쪽에 알려서, 같은 제품×기준을
    // 또 검색하지 않고 이 값을 그대로 재사용하게 하기 위함(중복 검색 → 값 불일치 버그 방지).
    const updates:     { product_name: string; field_key: string; spec_phrase: string; value: string | null }[] = [];
    // uncertain: 값은 찾았지만 근거가 약함 → 칩에 "값 (추정)"으로 표시 (updates에도 포함됨)
    const unconfirmed: string[] = [];
    // notFound: 값을 아예 못 찾음 → 칩 없이 "기준 정보 없음" 배지만 표시
    const notFound:    string[] = [];

    for (const { card, specPhrase, uncertain, value, skip } of results) {
      if (skip) {
        console.log(`  ⏭  ${card.name} → 이미 보유`);
        continue;
      }
      if (specPhrase === null) {
        const existing = card.specs?.find(s => s.toLowerCase().includes(fieldKey.toLowerCase()));
        if (!existing && !isPrice) {
          console.log(`  ❌ ${card.name} → 값 없음 배지`);
          notFound.push(card.name);
        }
        continue;
      }

      const displayPhrase = uncertain ? `${specPhrase} (추정)` : specPhrase;
      if (uncertain) unconfirmed.push(card.name);

      const isNativeField = ["가격", "price", "브랜드", "brand"].some(kw =>
        fieldKey.toLowerCase().includes(kw)
      );
      if (!isNativeField) {
        updates.push({ product_name: card.name, field_key: fieldKey, spec_phrase: displayPhrase, value: uncertain ? null : value });
        console.log(`  ${uncertain ? "⚠️ " : "✅"} ${card.name} → ${displayPhrase}`);
      }
    }

    console.log(`[auto-enrich] 완료: ✅${updates.length} ⚠️${unconfirmed.length} ❌${notFound.length}`);
    return NextResponse.json({ updates, unconfirmed, notFound });

  } catch (err) {
    console.error("[auto-enrich] 오류:", err);
    return NextResponse.json({ updates: [], unconfirmed: [] }, { status: 500 });
  }
}
