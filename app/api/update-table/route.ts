import { NextRequest, NextResponse } from "next/server";
import { findProductInLocalDB, enrichContextWithTavily } from "@/lib/backend/agents/data_agent";
import { generateUISpec } from "@/lib/backend/agents/ui_agent";
import { writeCompTableLog } from "@/lib/backend/logger";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { savedItems, criteria, currentCards = [], category, locale = "ko" } = await req.json() as {
      savedItems: string[];
      criteria: string[];
      currentCards?: any[];
      category: string;
      locale?: string;
    };

    if (!savedItems?.length) {
      return NextResponse.json({ error: "No saved items provided" }, { status: 400 });
    }

    console.log(`[update-table] Reactively updating table for ${savedItems.length} products with ${criteria.length} criteria`);

    // 1. Build local DB context & Append current UI Display Data
    // ⚠️  savedItems는 비교표 col.label (최대 12자 단축명)일 수 있음.
    //     currentCards에서 전체 이름을 먼저 복원한 뒤 DB 조회.
    const summaries: string[] = [];
    for (const shortName of savedItems) {
      // currentCards에서 단축명과 가장 잘 맞는 카드 찾기
      const matchCard = currentCards?.find((c: any) =>
        c.name?.includes(shortName) || shortName.includes(c.name)
      );
      const fullName = matchCard?.name ?? shortName;

      // DB 조회는 전체 이름으로 시도
      const dbSummary = findProductInLocalDB(category, fullName)
        ?? findProductInLocalDB(category, shortName);

      let summary: string;
      if (dbSummary) {
        summary = dbSummary;
      } else if (matchCard) {
        // DB 미스 시 카드 데이터로 직접 컨텍스트 구성
        const specs = matchCard.specs?.join(" / ") || "정보 없음";
        summary = [
          `[Product 1]`,
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
    console.log(`[update-table] 컨텍스트 구성 완료 (${summaries.length}개 제품, ${rawContext.length}자)`);

    if (!rawContext.trim()) {
      return NextResponse.json({ error: "No products found in DB" }, { status: 404 });
    }

    // 2. Enrich missing specs with Tavily if criteria changed
    const { enriched: enrichedContext, productLogs } = await enrichContextWithTavily(
      rawContext,
      criteria
    );
    
    // MD 로그 저장
    writeCompTableLog(productLogs, criteria);

    // 3. Generate new Comparison Table JSON using UI Agent
    const intent_summary = "사용자의 Decision Criteria 변경에 따른 실시간 테이블 순위 재평가 및 컴포넌트 갱신";
    
    const uiSpecString = await generateUISpec(
      enrichedContext,
      intent_summary,
      "2",
      1,
      "",
      savedItems,
      criteria
    );

    let uiSpec = null;
    if (uiSpecString && !uiSpecString.startsWith("ERROR:")) {
      try {
        const firstBrace = uiSpecString.indexOf("{");
        const lastBrace = uiSpecString.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          const jsonPart = uiSpecString
            .substring(firstBrace, lastBrace + 1)
            .replace(/,\s*([\}\]])/g, "$1");
          uiSpec = JSON.parse(jsonPart);
        }
      } catch (err) {
        console.warn("[update-table] 1차 JSON 파싱 실패 (마크다운 탈출 시도):", err);
      }

      if (!uiSpec) {
        try {
          const cleanStr = uiSpecString
            .replace(/^```(?:json)?\s*\n?/, "")
            .replace(/\n?```\s*$/, "")
            .replace(/,\s*([\}\]])/g, "$1")
            .trim();
          uiSpec = JSON.parse(cleanStr);
        } catch (err) {
          console.error("[update-table] 2차 JSON 파싱 실패:", err);
        }
      }
    }

    if (!uiSpec) {
      console.error("[update-table] Parsing failed. uiSpecString was:", uiSpecString);
      return NextResponse.json({ error: "Failed to parse UI Agent output" }, { status: 500 });
    }

    // --- POST-PROCESSING: 동기화(Sync) ---
    // Option List(currentCards)에 있는 기존 스펙(또는 가격) 정보와 Comparison Table이 완벽하게 일치하도록 덮어씌웁니다.
    if (uiSpec.props?.rows && uiSpec.props?.columns && currentCards.length > 0) {
      const cols = uiSpec.props.columns;
      const rows = uiSpec.props.rows;
      
      // 이미지 URL 강제 동기화
      for (const col of cols) {
        if (col.key.startsWith("prod_")) {
          const prodName = col.label;
          const matchCard = currentCards.find(c => c.name.includes(prodName) || prodName.includes(c.name));
          if (matchCard && (matchCard.imageUrl || matchCard.image)) {
            col.imageUrl = matchCard.imageUrl || matchCard.image;
          }
        }
      }
      
      // 가격 관련 row 강제 동기화
      const priceRow = rows.find((r: any) => ["가격", "가격대", "price"].some(kw => r.criterion.toLowerCase().includes(kw)));
      if (priceRow) {
        for (const col of cols) {
          if (col.key.startsWith("prod_")) {
            const prodName = col.label;
            const matchCard = currentCards.find(c => c.name.includes(prodName) || prodName.includes(c.name));
            if (matchCard && matchCard.price) {
              priceRow[col.key] = matchCard.price;
            }
          }
        }
      }

      // 일반 스펙 관련 row 강제 동기화 (기존 알약 UI에 적힌 문구 그대로 복사)
      for (const row of rows) {
        if (row.criterion === "순위" || row === priceRow) continue;
        
        for (const col of cols) {
          if (col.key.startsWith("prod_")) {
            const prodName = col.label;
            const matchCard = currentCards.find(c => c.name.includes(prodName) || prodName.includes(c.name));
            if (matchCard && Array.isArray(matchCard.specs)) {
              // 단순 부분 일치 검색
              const exactSpec = matchCard.specs.find((s: string) => s.toLowerCase().includes(row.criterion.toLowerCase()) || row.criterion.toLowerCase().includes(s.toLowerCase()));
              if (exactSpec) {
                let valToSet = exactSpec;
                if (valToSet.includes(row.criterion)) {
                  valToSet = valToSet.replace(new RegExp(`^${row.criterion}\\s*[:]?\\s*`, 'i'), '').trim();
                }
                row[col.key] = valToSet;
              }
            }
          }
        }
      }
    }
    // ------------------------------------

    return NextResponse.json(uiSpec);

  } catch (err) {
    console.error("[update-table] 오류:", err);
    return NextResponse.json({ error: `Internal Server Error: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
}
