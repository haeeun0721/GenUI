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
    };

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
      // 여기서도 반드시 동일한 문자열을 써야 공유 캐시(makeCacheKey)가 같은 키로 맞아떨어진다.
      // (과거엔 matchCard.name을 찾고도 DB의 Name: 필드로 덮어써서, 표기 차이(공백/접두어/모델 접미사)
      //  하나만 있어도 캐시 키가 어긋나 두 패널이 서로 다른 검색을 독립적으로 수행 → 값 불일치 버그로 이어졌음)
      const fullNameMap = new Map<string, string>();
      for (const col of productCols) {
        const shortLabel = col.label;
        const matchCard = currentCards?.find(
          (c: any) => c.name?.includes(shortLabel) || shortLabel.includes(c.name)
        );
        if (matchCard?.name) {
          // Option List 카드와 매칭됨 → Option List가 쓰는 이름을 그대로 재사용 (캐시 키 일치 보장)
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
            const result = await lookupProductSpec(fullName, cleanLabel, category, locale);
            newRow[col.key] = result.uncertain ? "-" : result.value;
            console.log(`[update-table] "${fullName}" × "${cleanLabel}" → "${newRow[col.key]}" (source=${result.source}${result.uncertain ? ", 불확실→폐기" : ""})`);
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
