/**
 * POST /api/auto-enrich
 * Option List 패널용: 기준(criterion) 변경 시 전체 카드 스펙 일괄 보강
 * Body: { cards, criteria, category }
 * Response: { updates, unconfirmed, notFound }
 */

import { NextRequest, NextResponse } from "next/server";
import { lookupProductSpec, buildSpecPhrase } from "@/lib/backend/services/spec-lookup";
import { expandCriterionMeta, normalizeCriterionRowAcrossProducts } from "@/lib/backend/agents/data_agent";

export const maxDuration = 60;

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const { cards, criteria, category, locale = "ko" } = await req.json() as {
      cards:      { name: string; price?: string; specs: string[] }[];
      criteria:   string[];
      category:   string;
      locale?:    string;
    };

    if (!cards?.length || !criteria?.length || !category) {
      return NextResponse.json({ updates: [], unconfirmed: [], notFound: [] });
    }

    console.log(`\n[auto-enrich] [${criteria.join(", ")}] | ${cards.length}개 카드: ${cards.map(c => c.name).join(" / ")}`);

    // ── 0. 기준별 선호 지표/단위 힌트 (LLM 1번, 기준 전체 배치) ─────────────────
    // "배터리 수명"처럼 여러 측정 방식(정지 사진 매수 vs 재생시간 vs 영상시간)이 섞일 수
    // 있는 기준은, 카드마다 독립적으로 물어보면 서로 다른 지표를 뽑아와 비교가 안 된다.
    // 기준별로 "어떤 지표를 우선해야 하는지" 힌트를 미리 만들어 모든 카드의 1차 추출
    // 호출에 동일하게 흘려보내, 애초에 같은 지표를 우선 뽑도록 유도한다(추가 검색 없음).
    const criterionMeta = await expandCriterionMeta(criteria);

    // ── 1. (제품 × 기준) 전체 조합을 한 번에 병렬 조회 ──────────────────────────
    // 예전엔 기준 하나당 요청 하나(카드끼리만 병렬)라 여러 기준을 한 번에 추가하면
    // 요청이 순차적으로 쌓였다 — 이제 기준 여러 개를 한 요청에 flatMap으로 펼쳐서
    // 카드 × 기준 전체 조합을 한 Promise.all로 동시에 조회한다.
    const jobs = cards.flatMap(card => criteria.map(fieldKey => ({ card, fieldKey })));

    const results = await Promise.all(
      jobs.map(async ({ card, fieldKey }) => {
        const isPrice = ["가격", "price"].some(kw => fieldKey.toLowerCase().includes(kw));

        // 가격 기준: card.price 직접 사용
        if (isPrice && card.price) return { card, fieldKey, isPrice, specPhrase: card.price, uncertain: false, value: card.price };

        // 이미 보유 중이면 건너뜀
        const alreadyHas = card.specs?.some(s =>
          s.toLowerCase().includes(fieldKey.toLowerCase())
        );
        if (alreadyHas) return { card, fieldKey, isPrice, specPhrase: null, uncertain: false, value: null, skip: true };

        const meta = criterionMeta[fieldKey];
        const result = await lookupProductSpec(card.name, fieldKey, category, locale, meta?.formatHint, meta?.canonicalUnit);
        if (result.value === "-") return { card, fieldKey, isPrice, specPhrase: null, uncertain: false, value: null };

        const specPhrase = buildSpecPhrase(fieldKey, result.value);

        return { card, fieldKey, isPrice, specPhrase, uncertain: result.uncertain ?? false, value: result.value, skip: false };
      })
    );

    // ── 1.5 기준별 교차 정규화 (LLM 호출, 기준당 최대 1번) ──────────────────────
    // 그래도 카드마다 다른 지표로 뽑힌 경우가 남을 수 있어, 같은 기준으로 값이 2개
    // 이상 나온 카드들을 한데 묶어 한 번 더 맞춰본다. 재검색은 안 하고 이미 뽑아온
    // 값들끼리만 정리한다(단위 통일, 무관한 부분 제거, 다른 지표는 값 유지+라벨 보존).
    const normalizedOverrides = new Map<number, string>();
    const indicesByField = new Map<string, number[]>();
    results.forEach((r, i) => {
      if (!r.skip && !r.isPrice && typeof r.value === "string" && r.value !== "-") {
        if (!indicesByField.has(r.fieldKey)) indicesByField.set(r.fieldKey, []);
        indicesByField.get(r.fieldKey)!.push(i);
      }
    });
    await Promise.all(
      Array.from(indicesByField.entries()).map(async ([fieldKey, indices]) => {
        if (indices.length < 2) return;
        const entries = indices.map(i => ({ colKey: String(i), label: results[i].card.name, value: results[i].value as string }));
        const normalized = await normalizeCriterionRowAcrossProducts(fieldKey, entries, locale);
        for (const i of indices) {
          const newValue = normalized[String(i)];
          if (newValue && newValue !== results[i].value) {
            normalizedOverrides.set(i, newValue);
            console.log(`  🔧 [RowNormalize] "${results[i].card.name}" × "${fieldKey}" → "${newValue}"`);
          }
        }
      })
    );

    // ── 2. 결과 분류 ─────────────────────────────────────────────────────────
    // value: lookupProductSpec의 원본 값(마케팅 수식어 제거 전 buildSpecPhrase 가공 전 상태) —
    // 이 요청에서 이미 검색/판단을 마쳤다는 걸 Comparison Table 쪽에 알려서, 같은 제품×기준을
    // 또 검색하지 않고 이 값을 그대로 재사용하게 하기 위함(중복 검색 → 값 불일치 버그 방지).
    const updates:     { product_name: string; field_key: string; spec_phrase: string; value: string | null }[] = [];
    // uncertain: 값은 찾았지만 근거가 약함 → 칩에 "값 (추정)"으로 표시 (updates에도 포함됨)
    // 기준이 여러 개일 수 있어 product_name만으로는 어떤 기준에 대한 결과인지 구분이 안 되므로
    // field_key를 함께 남긴다.
    const unconfirmed: { product_name: string; field_key: string }[] = [];
    // notFound: 값을 아예 못 찾음 → 칩 없이 "기준 정보 없음" 배지만 표시
    const notFound:    { product_name: string; field_key: string }[] = [];

    for (const [i, entry] of results.entries()) {
      const { card, fieldKey, isPrice, uncertain, skip } = entry;
      if (skip) {
        console.log(`  ⏭  ${card.name} × "${fieldKey}" → 이미 보유`);
        continue;
      }
      // 정규화된 값이 있으면 그걸로 대체 (specPhrase도 다시 빌드)
      const override = normalizedOverrides.get(i);
      const value = override ?? entry.value;
      const specPhrase = override ? buildSpecPhrase(fieldKey, override) : entry.specPhrase;
      if (specPhrase === null) {
        const existing = card.specs?.find(s => s.toLowerCase().includes(fieldKey.toLowerCase()));
        if (!existing && !isPrice) {
          console.log(`  ❌ ${card.name} × "${fieldKey}" → 값 없음 배지`);
          notFound.push({ product_name: card.name, field_key: fieldKey });
        }
        continue;
      }

      const displayPhrase = uncertain ? `${specPhrase} (추정)` : specPhrase;
      if (uncertain) unconfirmed.push({ product_name: card.name, field_key: fieldKey });

      const isNativeField = ["가격", "price", "브랜드", "brand"].some(kw =>
        fieldKey.toLowerCase().includes(kw)
      );
      if (!isNativeField) {
        updates.push({ product_name: card.name, field_key: fieldKey, spec_phrase: displayPhrase, value: uncertain ? null : value });
        console.log(`  ${uncertain ? "⚠️ " : "✅"} ${card.name} × "${fieldKey}" → ${displayPhrase}`);
      }
    }

    console.log(`[auto-enrich] 완료: ✅${updates.length} ⚠️${unconfirmed.length} ❌${notFound.length}`);
    return NextResponse.json({ updates, unconfirmed, notFound });

  } catch (err) {
    console.error("[auto-enrich] 오류:", err);
    return NextResponse.json({ updates: [], unconfirmed: [], notFound: [] }, { status: 500 });
  }
}
