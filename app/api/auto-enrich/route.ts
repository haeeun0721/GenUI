/**
 * POST /api/auto-enrich
 * Option List 패널용: 기준(criterion) 변경 시 전체 카드 스펙 일괄 보강
 * Body: { cards, criterion, criterionMin?, category }
 * Response: { updates, dimmed, unconfirmed }
 */

import { NextRequest, NextResponse } from "next/server";
import { lookupProductSpec } from "@/lib/backend/services/spec-lookup";

// ---------------------------------------------------------------------------
// 스펙 문구 생성 — 기준 유형에 맞는 자연스러운 한국어 표현
// ---------------------------------------------------------------------------

/** Tavily/LLM이 반환하는 마케팅 수식어를 앞뒤에서 제거하고 핵심 값만 남긴다. */
const MARKETING_PREFIX = /^(?:최고\s*성능\s*|최고\s*사양\s*|최강\s*|업계\s*(?:최고|최강|최대)\s*|강력한\s*|탁월한\s*|우수한\s*|놀라운\s*|압도적인\s*|혁신적인\s*|뛰어난\s*)/;
const MARKETING_SUFFIX = /\s*(?:급\s*)?(?:강력한\s*)?(?:흡입력|성능|기능|처리\s*속도|의\s*힘)$/;

function cleanValue(raw: string): string {
  // 레이블 있는 값("배터리용량: 6400mAh")은 건드리지 않음
  if (raw.includes(":")) return raw;
  const cleaned = raw.replace(MARKETING_PREFIX, "").replace(MARKETING_SUFFIX, "").trim();
  return cleaned || raw; // 모두 지워진 경우 원본 반환
}

function buildSpecPhrase(fieldKey: string, value: string): string {
  const v = cleanValue(value); // 마케팅 수식어 제거
  if (v === "○") {
    if (/연동|호환|연결/.test(fieldKey)) return `${fieldKey} 가능`;
    if (/기능/.test(fieldKey)) return `${fieldKey} 지원`;
    if (/방식|타입|type/.test(fieldKey)) return `${fieldKey} 적용`;
    return `${fieldKey} 지원`;
  }
  if (v === "X") {
    if (/연동|호환|연결/.test(fieldKey)) return `${fieldKey} 불가`;
    return `${fieldKey} 없음`;
  }
  // value 타입 — 콜론 있으면 기준명 반복 방지
  if (v.includes(":")) return v;
  if (/\d/.test(v)) return `${fieldKey}: ${v}`;
  return `${fieldKey} ${v}`;
}

// ---------------------------------------------------------------------------
// 임계값 비교
// ---------------------------------------------------------------------------

function extractNumber(str: string): number | null {
  const isMan = str.includes("만");
  const cleaned = str.replace(/,/g, "").replace(/[^\d.]/g, " ").trim();
  const match = cleaned.match(/[\d.]+/);
  if (!match) return null;
  let num = parseFloat(match[0]);
  if (isMan && num < 10000) num *= 10000;
  return num;
}

function meetsThreshold(specPhrase: string, criterionMin: string): boolean | null {
  const specNum = extractNumber(specPhrase);
  const minNum  = extractNumber(criterionMin);
  if (specNum === null || minNum === null) return null;
  const isAbove = /이상|초과|above|over|≥|more/i.test(criterionMin);
  const isBelow = /이하|미만|below|under|≤|less/i.test(criterionMin);
  if (isAbove) return specNum >= minNum;
  if (isBelow) return specNum <= minNum;
  return null;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const { cards, criterion, criterionMin, category } = await req.json() as {
      cards:       { name: string; price?: string; specs: string[] }[];
      criterion:   string;
      criterionMin?: string;
      category:    string;
    };

    if (!cards?.length || !criterion || !category) {
      return NextResponse.json({ updates: [], dimmed: [], unconfirmed: [] });
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

        const result = await lookupProductSpec(card.name, fieldKey, category);
        if (result.value === "-") return { card, specPhrase: null, uncertain: false };

        const specPhrase = buildSpecPhrase(fieldKey, result.value);

        return { card, specPhrase, uncertain: result.uncertain ?? false };
      })
    );

    // ── 2. 결과 분류 ─────────────────────────────────────────────────────────
    const updates:     { product_name: string; field_key: string; spec_phrase: string }[] = [];
    const dimmed:      { name: string; reason: string }[] = [];
    const unconfirmed: string[] = [];

    for (const { card, specPhrase, uncertain } of results) {
      if (specPhrase === null) {
        // 못 찾은 경우 — 이미 보유했다면 기존 값으로 임계값 판정
        const existing = card.specs?.find(s => s.toLowerCase().includes(fieldKey.toLowerCase()));
        if (existing && criterionMin) {
          if (meetsThreshold(existing, criterionMin) === false) {
            dimmed.push({ name: card.name, reason: criterion });
          }
        } else if (!isPrice) {
          unconfirmed.push(card.name);
        }
        continue;
      }

      // 불확실 값 → 업데이트는 하되 unconfirmed에 기록
      if (uncertain) {
        console.log(`[auto-enrich] ⚠️  "${card.name}" — 불확실 값 (${specPhrase}), 수동 검수 권장`);
        unconfirmed.push(card.name);
        continue;
      }

      // 스펙 추가 (가격/브랜드 중복 방지)
      const isNativeField = ["가격", "price", "브랜드", "brand"].some(kw =>
        fieldKey.toLowerCase().includes(kw)
      );
      if (!isNativeField) {
        updates.push({ product_name: card.name, field_key: fieldKey, spec_phrase: specPhrase });
        console.log(`[auto-enrich] 스펙 추가: "${card.name}" — ${specPhrase}`);
      }

      // 임계값 판정
      if (criterionMin) {
        if (meetsThreshold(specPhrase, criterionMin) === false) {
          dimmed.push({ name: card.name, reason: criterion });
          console.log(`[auto-enrich] ⚠️  "${card.name}" — 기준 미충족 (${specPhrase} vs ${criterionMin})`);
        }
      } else {
        const lower = specPhrase.toLowerCase();
        if (lower.includes("없음") || lower.endsWith(" x")) {
          dimmed.push({ name: card.name, reason: criterion });
        }
      }
    }

    console.log(`[auto-enrich] 완료: ${updates.length}개 업데이트 | ${dimmed.length}개 미충족 | ${unconfirmed.length}개 미확인`);
    return NextResponse.json({ updates, dimmed, unconfirmed });

  } catch (err) {
    console.error("[auto-enrich] 오류:", err);
    return NextResponse.json({ updates: [], dimmed: [], unconfirmed: [] }, { status: 500 });
  }
}
