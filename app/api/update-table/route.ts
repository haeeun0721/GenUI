import { NextRequest, NextResponse } from "next/server";
import { findProductInLocalDB, findExactMatchingProduct } from "@/lib/backend/agents/data_agent";
import { enrichContextWithTavily, type KnownProductSpecs } from "@/lib/backend/services/spec-lookup";
import { buildIncrementalTableUpdate, isValidTableSeed } from "@/lib/backend/services/comp-table-incremental";
import { generateUISpec } from "@/lib/backend/agents/ui_agent";
import { writeCompTableLog } from "@/lib/backend/logger";
import { setCurrentLocale, setCurrentUserContext, setCurrentParticipantId } from "@/lib/backend/tools/sidebar-store";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const {
      savedItems,
      criteria,
      currentCards = [],
      currentTableData,  // ← 기존 테이블 JSON (증분 업데이트의 시드)
      category,
      locale = "ko",
      removedCriteriaNames = [],  // ← 사용자가 실제로 제거한 기준만 (행 삭제는 이 목록에서만 발생)
      userContext = "",
      // Option List(auto-enrich)가 같은 사용자 조작(기준 하나 추가/변경) 사이클 안에서 이미
      // 검색/판단해둔 값. 있으면 이 값을 그대로 쓰고 lookupProductSpec을 다시 호출하지 않는다 —
      // 두 패널이 각자 독립적으로 실시간 검색을 돌려 같은 제품×기준인데 값이 갈리는 문제 방지.
      // 전역/영속 캐시(Map 등)는 일부러 안 쓴다 — 그런 캐시는 이 요청뿐 아니라 서버 프로세스에
      // 붙는 다른 모든 세션/참가자에도 공유돼서, 한 참가자의 검색 결과를 다른 참가자가 그대로
      // 받아버리는 문제가 생긴다. 대신 프론트(app/page.tsx)가 auto-enrich 응답을 기다렸다가
      // update-table 요청 body에 실어 보내는 방식 — 이 요청 하나의 생명주기 밖으로 절대
      // 새어나가지 않는다.
      prefetchedValues = [],
      participantId = "",
    } = await req.json() as {
      savedItems: string[];
      criteria: string[];
      currentCards?: any[];
      currentTableData?: any;   // CompTableJson | null
      currentRows?: string[];
      category: string;
      locale?: string;
      removedCriteriaNames?: string[];
      userContext?: string;
      prefetchedValues?: { product_name: string; field_key: string; value: string | null }[];
      participantId?: string;
    };

    if (!savedItems?.length) {
      return NextResponse.json({ error: "No saved items provided" }, { status: 400 });
    }

    // orchestrateCompTablePipeline(STRATEGY B)와 computeRankingAndReasoning은 공유 전역
    // (currentLocale/currentUserContext)을 읽지 params로 받지 않는다 — 독립 엔드포인트인
    // 이 라우트는 매 요청마다 이 값을 최신으로 맞춰줘야 순위 판단이 이 사용자 상황을 반영한다.
    setCurrentLocale(locale === "en" ? "en" : "ko");
    setCurrentUserContext(userContext);
    setCurrentParticipantId(participantId);

    const requestId = `updatetable-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[update-table] req=${requestId} ${savedItems.length}개 제품, ${criteria.length}개 기준`);

    // ── STRATEGY A: 증분(patch) 업데이트 ──────────────────────────────────────
    // currentTableData가 유효한 경우: 기존 셀 값을 보존하고 새로운 기준 행만 추가
    // (실제 로직은 comp-table-incremental.ts로 옮김 — /api/auto-enrich도 같은 요청 안에서
    // 이 함수를 호출해 Option List 카드와 표를 한 번의 검색으로 동시에 갱신한다)
    if (isValidTableSeed(currentTableData)) {
      console.log("[update-table] ✅ 증분 업데이트 모드: 기존 테이블 데이터 보존");
      const tableJson = await buildIncrementalTableUpdate(
        currentTableData,
        criteria,
        currentCards,
        category,
        locale,
        removedCriteriaNames,
        prefetchedValues,
        requestId,
        participantId
      );
      console.log("[update-table] ✅ 증분 업데이트 완료");
      return NextResponse.json(tableJson);
    }

    // ── STRATEGY B: 전체 재건 (currentTableData 없는 경우 fallback) ───────────
    console.log("[update-table] ⚠️ currentTableData 없음 → 전체 재건 모드");

    // 1. Build local DB context
    const summaries: string[] = [];
    for (const shortName of savedItems) {
      const cardCandidates = (currentCards ?? []).filter((c: any) => c?.name);
      const matchCard = findExactMatchingProduct(shortName, cardCandidates);
      if (!matchCard) {
        const looseCount = cardCandidates.filter((c: any) => {
          const a = c.name.toLowerCase().replace(/\s+/g, "");
          const b = shortName.toLowerCase().replace(/\s+/g, "");
          return a.includes(b) || b.includes(a);
        }).length;
        if (looseCount >= 2) console.warn(`[update-table] "${shortName}" — 카드 후보 ${looseCount}개가 애매하게 겹쳐 매칭 보류 (동명이인 방지)`);
      }
      const fullName = matchCard?.name ?? shortName;

      const dbSummary =
        findProductInLocalDB(category, fullName) ??
        findProductInLocalDB(category, shortName);

      let summary: string;
      if (dbSummary) {
        const productIdx = summaries.length + 1;
        summary = dbSummary.replace(/^\[Product \d+\]/, `[Product ${productIdx}]`);
      } else if (matchCard) {
        const productIdx = summaries.length + 1;
        const specs = matchCard.specs?.join(" / ") || "정보 없음";
        summary = [
          `[Product ${productIdx}]`,
          `Name: ${fullName}`,
          `Price: ${matchCard.price || "가격 미정"}`,
          `Brand: ${matchCard.brand || ""}`,
          `Image: ${matchCard.imageUrl || matchCard.image || ""}`,
          `Link: ${matchCard.link || ""}`,
          `Specs: ${specs}`,
          `Description: ${matchCard.description || fullName}`,
        ].join("\n");
        console.log(`[update-table] DB 미스 → 카드 데이터 사용: "${fullName}"`);
      } else {
        summary = `Product: ${fullName}`;
        console.warn(`[update-table] "${shortName}" — DB/카드 모두 미스, 컨텍스트 빈약`);
      }
      summaries.push(summary);
    }

    const rawContext = summaries.join("\n\n");
    if (!rawContext.trim()) {
      return NextResponse.json({ error: "No products found in DB" }, { status: 404 });
    }

    // 2. Enrich with Tavily
    // STRATEGY A의 prefetchedMap과 동일한 취지 — 이번 요청에 실려온 currentCards(Option List
    // 카드 스펙)와 prefetchedValues(auto-enrich 결과)를 먼저 보고, 없는 값만 Tavily로 새로 찾는다.
    // 두 패널이 같은 제품×기준을 각자 독립 검색해 값이 갈리는 걸 막기 위함(영속 캐시는 아님 —
    // 이 요청의 body에 실려온 값만 본다).
    const knownProductsMap = new Map<string, string[]>();
    for (const c of currentCards ?? []) {
      if (c?.name) knownProductsMap.set(c.name, Array.isArray(c.specs) ? [...c.specs] : []);
    }
    for (const p of prefetchedValues) {
      if (!p.value) continue;
      const arr = knownProductsMap.get(p.product_name) ?? [];
      arr.push(`${p.field_key}: ${p.value}`);
      knownProductsMap.set(p.product_name, arr);
    }
    const knownProducts: KnownProductSpecs[] = Array.from(knownProductsMap, ([name, specs]) => ({ name, specs }));

    const { enriched: enrichedContext, productLogs } = await enrichContextWithTavily(
      rawContext,
      criteria,
      category,
      locale,
      knownProducts
    );
    writeCompTableLog(productLogs, criteria);

    // 3. Full pipeline rebuild
    const uiSpecString = await generateUISpec(
      enrichedContext,
      "사용자의 Decision Criteria 변경에 따른 실시간 테이블 순위 재평가 및 컴포넌트 갱신",
      "2",
      1,
      "",
      savedItems,
      criteria,
      []
    );

    let uiSpec = null;
    if (uiSpecString && !uiSpecString.startsWith("ERROR:")) {
      try {
        const firstBrace = uiSpecString.indexOf("{");
        const lastBrace = uiSpecString.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          uiSpec = JSON.parse(
            uiSpecString.substring(firstBrace, lastBrace + 1).replace(/,\s*([\}\]])/g, "$1")
          );
        }
      } catch {
        try {
          uiSpec = JSON.parse(
            uiSpecString
              .replace(/^```(?:json)?\s*\n?/, "")
              .replace(/\n?```\s*$/, "")
              .replace(/,\s*([\}\]])/g, "$1")
              .trim()
          );
        } catch (err) {
          console.error("[update-table] JSON 파싱 실패:", err);
        }
      }
    }

    if (!uiSpec) {
      return NextResponse.json({ error: "Failed to parse UI Agent output" }, { status: 500 });
    }

    // 이미지 URL 보존 (currentCards에서)
    if (uiSpec.props?.columns && currentCards.length > 0) {
      for (const col of uiSpec.props.columns) {
        if (col.key.startsWith("prod_")) {
          const matchCard = findExactMatchingProduct(col.label ?? "", currentCards.filter((c: any) => c?.name));
          if (matchCard && (matchCard.imageUrl || matchCard.image) && !col.imageUrl) {
            col.imageUrl = matchCard.imageUrl || matchCard.image;
          }
        }
      }
    }

    return NextResponse.json(uiSpec);
  } catch (err) {
    console.error("[update-table] 오류:", err);
    return NextResponse.json(
      { error: `Internal Server Error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
// v2
