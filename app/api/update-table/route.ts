import { NextRequest, NextResponse } from "next/server";
import { findProductInLocalDB } from "@/lib/backend/agents/data_agent";
import { computeRankingAndReasoning } from "@/lib/backend/agents/generators/comp_table";
import { lookupProductSpec, enrichContextWithTavily } from "@/lib/backend/services/spec-lookup";
import { generateUISpec } from "@/lib/backend/agents/ui_agent";
import { writeCompTableLog } from "@/lib/backend/logger";
import { setCurrentLocale, setCurrentUserContext } from "@/lib/backend/tools/sidebar-store";

export const maxDuration = 60;

// ────────────────────────────────────────────────────────────────────────────
// Helper: criteria label 정규화 (브라켓/괄호 제거)
// ────────────────────────────────────────────────────────────────────────────
function cleanCriterionLabel(c: string): string {
  return c
    .replace(/\s*\[.*?\]\s*/g, "")
    .replace(/\s*\(.*?\)\s*/g, "")
    .trim();
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
    };

    // 정규화 키(기준명 소문자+공백제거 + 제품명 소문자+공백제거)로 prefetched 값 조회
    const normKey = (criterion: string, productName: string) =>
      `${cleanCriterionLabel(criterion).replace(/\s+/g, "").toLowerCase()}__${productName.replace(/\s+/g, "").toLowerCase()}`;
    const prefetchedMap = new Map<string, string>();
    for (const p of prefetchedValues) {
      if (p.value) prefetchedMap.set(normKey(p.field_key, p.product_name), p.value);
    }

    if (!savedItems?.length) {
      return NextResponse.json({ error: "No saved items provided" }, { status: 400 });
    }

    // orchestrateCompTablePipeline(STRATEGY B)와 computeRankingAndReasoning은 공유 전역
    // (currentLocale/currentUserContext)을 읽지 params로 받지 않는다 — 독립 엔드포인트인
    // 이 라우트는 매 요청마다 이 값을 최신으로 맞춰줘야 순위 판단이 이 사용자 상황을 반영한다.
    setCurrentLocale(locale === "en" ? "en" : "ko");
    setCurrentUserContext(userContext);

    console.log(`[update-table] ${savedItems.length}개 제품, ${criteria.length}개 기준`);

    // ── STRATEGY A: 증분(patch) 업데이트 ──────────────────────────────────────
    // currentTableData가 유효한 경우: 기존 셀 값을 보존하고 새로운 기준 행만 추가
    if (
      currentTableData?.props?.columns?.length > 1 &&
      Array.isArray(currentTableData?.props?.rows)
    ) {
      console.log("[update-table] ✅ 증분 업데이트 모드: 기존 테이블 데이터 보존");
      const tableJson = JSON.parse(JSON.stringify(currentTableData)); // deep copy
      const cols: any[] = tableJson.props.columns;
      const rows: any[] = tableJson.props.rows;
      const productCols = cols.filter((c: any) => c.key !== "criterion");

      // 기존 criteria 행 목록 (clean)
      const existingCriteriaClean = new Set(
        rows
          .filter((r: any) => r.criterion && r.criterion !== "순위" && r.criterion !== "Rank")
          .map((r: any) => cleanCriterionLabel(r.criterion).toLowerCase())
      );

      // 새로운 기준만 추출
      const newCriteria = criteria.filter(
        (c) => !existingCriteriaClean.has(cleanCriterionLabel(c).toLowerCase())
      );
      console.log(
        `[update-table] 기존 기준 ${existingCriteriaClean.size}개, 신규 기준 ${newCriteria.length}개: [${newCriteria.join(", ")}]`
      );

      if (newCriteria.length === 0) {
        // 새로 추가할 기준은 없음 (중요도 변경 등) → removedCriteriaNames가 있을 때만 행 제거, 순위 재계산
        tableJson.props.rows = dropRemovedCriteriaRows(rows, removedCriteriaNames);
        const { reasoning } = await computeRankingAndReasoning(tableJson, criteria, locale);
        if (reasoning) tableJson.props._rankReasoning = reasoning;
        console.log("[update-table] 순위 재계산 완료 (행 삭제: " + removedCriteriaNames.length + "개)");
        return NextResponse.json(tableJson);
      }

      // 제품 전체 이름 매핑: col.label → fullName
      // Option List(auto-enrich)는 card.name을 그대로 lookupProductSpec에 넘기므로,
      // 여기서도 반드시 동일한 문자열을 써야 prefetchedMap 키(normKey)가 같은 키로 맞아떨어져
      // 위에서 받은 prefetchedValues를 인식하고 재사용할 수 있다.
      // (과거엔 matchCard.name을 찾고도 DB의 Name: 필드로 덮어써서, 표기 차이(공백/접두어/모델 접미사)
      //  하나만 있어도 키가 어긋나 두 패널이 서로 다른 검색을 독립적으로 수행 → 값 불일치 버그로 이어졌음.
      //  지금은 애초에 auto-enrich가 검색을 먼저 끝내고 그 결과를 여기로 넘겨받는 구조라 재검색 자체가
      //  일어나지 않지만, 이름이 어긋나면 prefetched 매칭에 실패해 다시 독립 검색으로 빠지므로 여전히 중요)
      const fullNameMap = new Map<string, string>();
      for (const col of productCols) {
        const shortLabel = col.label;
        const matchCard = currentCards?.find(
          (c: any) => c.name?.includes(shortLabel) || shortLabel.includes(c.name)
        );
        if (matchCard?.name) {
          // Option List 카드와 매칭됨 → Option List가 쓰는 이름을 그대로 재사용 (prefetched 매칭 보장)
          fullNameMap.set(shortLabel, matchCard.name);
          continue;
        }
        // 매칭되는 카드가 없을 때만 DB 조회로 전체 이름 복원 시도
        const dbEntry = findProductInLocalDB(category, shortLabel);
        if (dbEntry) {
          const nameMatch = dbEntry.match(/Name:\s*(.+)/);
          fullNameMap.set(shortLabel, nameMatch ? nameMatch[1].trim() : shortLabel);
        } else {
          fullNameMap.set(shortLabel, shortLabel);
        }
      }

      // 새 기준 × 각 제품 → lookupProductSpec (캐시→DB→Tavily 3단계+검증, mutate-comptable.ts와 공유)
      for (const criterion of newCriteria) {
        const cleanLabel = cleanCriterionLabel(criterion);
        const newRow: Record<string, string> = { criterion: cleanLabel };
        // 기본값은 "-"
        for (const col of productCols) newRow[col.key] = "-";

        await Promise.all(
          productCols.map(async (col) => {
            const productLabel = col.label;
            const fullName = fullNameMap.get(productLabel) ?? productLabel;

            // Option List(auto-enrich)가 이번 사이클에서 이미 찾아둔 값이 있으면 재사용 —
            // 새로 Tavily/judgeCell을 돌리면 같은 제품×기준인데 두 패널이 서로 다른 값을
            // 받게 될 수 있다(검색 결과 변동성).
            const prefetched = prefetchedMap.get(normKey(cleanLabel, fullName));
            if (prefetched) {
              newRow[col.key] = prefetched;
              console.log(`[update-table] "${fullName}" × "${cleanLabel}" → "${prefetched}" (source=prefetched, Option List와 공유)`);
              return;
            }

            const result = await lookupProductSpec(fullName, cleanLabel, category, locale);
            newRow[col.key] = result.uncertain && result.value !== "-" ? `${result.value} (추정)` : result.value;
            console.log(`[update-table] "${fullName}" × "${cleanLabel}" → "${newRow[col.key]}" (source=${result.source}${result.uncertain ? ", 불확실" : ""})`);
          })
        );

        // 순위 행 바로 앞에 삽입
        const rankIdx = rows.findIndex(
          (r: any) => r.criterion === "순위" || r.criterion === "Rank"
        );
        if (rankIdx === -1) rows.push(newRow);
        else rows.splice(rankIdx + 1, 0, newRow);

        console.log(`[update-table] 새 행 추가: "${cleanLabel}"`);
      }

      // removedCriteriaNames가 있을 때만 행 제거 (사용자가 실제로 제거한 기준에 한함)
      tableJson.props.rows = dropRemovedCriteriaRows(rows, removedCriteriaNames);

      // 순위 재계산
      const { reasoning } = await computeRankingAndReasoning(tableJson, criteria, locale);
      if (reasoning) tableJson.props._rankReasoning = reasoning;

      console.log("[update-table] ✅ 증분 업데이트 완료");
      return NextResponse.json(tableJson);
    }

    // ── STRATEGY B: 전체 재건 (currentTableData 없는 경우 fallback) ───────────
    console.log("[update-table] ⚠️ currentTableData 없음 → 전체 재건 모드");

    // 1. Build local DB context
    const summaries: string[] = [];
    for (const shortName of savedItems) {
      const matchCard = currentCards?.find((c: any) =>
        c.name?.includes(shortName) || shortName.includes(c.name)
      );
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
    const { enriched: enrichedContext, productLogs } = await enrichContextWithTavily(
      rawContext,
      criteria,
      category,
      locale
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
          const matchCard = currentCards.find(
            (c: any) => c.name?.includes(col.label) || col.label?.includes(c.name)
          );
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
