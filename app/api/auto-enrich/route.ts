/**
 * POST /api/auto-enrich
 * Option List 패널용: 기준(criterion) 변경 시 전체 카드 스펙 일괄 보강
 * Body: { cards, criterion, criterionMin?, category }
 * Response: { updates, unconfirmed }
 */

import { NextRequest, NextResponse } from "next/server";
import { lookupProductSpec, buildSpecPhrase } from "@/lib/backend/services/spec-lookup";

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const { cards, criterion, criterionMin, category, locale = "ko" } = await req.json() as {
      cards:       { name: string; price?: string; specs: string[] }[];
      criterion:   string;
      criterionMin?: string;
      category:    string;
      locale?:     string;
    };

    if (!cards?.length || !criterion || !category) {
      return NextResponse.json({ updates: [], unconfirmed: [] });
    }

    const fieldKey = criterion;
    const isPrice  = ["가격", "price"].some(kw => fieldKey.toLowerCase().includes(kw));

    console.log(`[auto-enrich] criterion="${criterion}" (min="${criterionMin ?? "없음"}") | ${cards.length}개 카드`);

    // ── 1. 병렬 스펙 조회 ────────────────────────────────────────────────────
    const results = await Promise.all(
      cards.map(async card => {
        // 가격 기준: card.price 직접 사용
        if (isPrice && card.price) return { card, specPhrase: card.price, uncertain: false };

        // 이미 보유 중이면 건너뜀
        const alreadyHas = card.specs?.some(s =>
          s.toLowerCase().includes(fieldKey.toLowerCase())
        );
        if (alreadyHas) {
          console.log(`[auto-enrich] "${card.name}" — 이미 ${fieldKey} 보유, 건너뜀`);
          return { card, specPhrase: null, uncertain: false };
        }

        const result = await lookupProductSpec(card.name, fieldKey, category, locale);
        if (result.value === "-") return { card, specPhrase: null, uncertain: false };

        const specPhrase = buildSpecPhrase(fieldKey, result.value);

        return { card, specPhrase, uncertain: result.uncertain ?? false };
      })
    );

    // ── 2. 결과 분류 ─────────────────────────────────────────────────────────
    const updates:     { product_name: string; field_key: string; spec_phrase: string }[] = [];
    const unconfirmed: string[] = [];

    for (const { card, specPhrase, uncertain } of results) {
      if (specPhrase === null) {
        // 못 찾은 경우
        const existing = card.specs?.find(s => s.toLowerCase().includes(fieldKey.toLowerCase()));
        if (!(existing && criterionMin) && !isPrice) {
          const reason = existing
            ? `기존 스펙("${existing}")은 있지만 criterionMin이 없어 임계값 충족 여부를 판단할 수 없음`
            : `DB/웹 검색 모두에서 "${fieldKey}" 값을 찾지 못함 (findProductSpecInDB / lookupProductSpec 결과 "-")`;
          console.log(`[auto-enrich] 🔸 "${card.name}" → 미확인 처리 | 사유: ${reason}`);
          unconfirmed.push(card.name);
        }
        continue;
      }

      // 불확실 값 → "~" 접두사를 붙여 업데이트 (값을 버리지 않음)
      // unconfirmed에 기록해 UI가 스타일을 다르게 처리할 수 있게 함
      const displayPhrase = uncertain
        ? (specPhrase.startsWith("~") ? specPhrase : `~${specPhrase}`)
        : specPhrase;

      if (uncertain) {
        console.log(`[auto-enrich] ⚠️  "${card.name}" — 불확실 값 (${specPhrase}), "~" 표시 후 표시`);
        console.log(`[auto-enrich] 🔸 "${card.name}" → 미확인 처리 | 사유: Tavily 검색값이 검증 단계에서 uncertain으로 판정됨`);
        unconfirmed.push(card.name);
      }

      // 스펙 추가 (가격/브랜드 중복 방지)
      const isNativeField = ["가격", "price", "브랜드", "brand"].some(kw =>
        fieldKey.toLowerCase().includes(kw)
      );
      if (!isNativeField) {
        updates.push({ product_name: card.name, field_key: fieldKey, spec_phrase: displayPhrase });
        console.log(`[auto-enrich] 스펙 추가: "${card.name}" — ${displayPhrase}`);
      }
    }

    console.log(`[auto-enrich] 완료: ${updates.length}개 업데이트 | ${unconfirmed.length}개 미확인${unconfirmed.length > 0 ? ` (${unconfirmed.join(", ")})` : ""}`);
    return NextResponse.json({ updates, unconfirmed });

  } catch (err) {
    console.error("[auto-enrich] 오류:", err);
    return NextResponse.json({ updates: [], unconfirmed: [] }, { status: 500 });
  }
}
