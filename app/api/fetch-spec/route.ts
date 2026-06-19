import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// POST /api/fetch-spec
// Body: { products: { name: string; link: string }[], criteria: string }
// Returns: Record<productName, specValue>
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const { products, criteria } = (await req.json()) as {
      products: { name: string; link: string }[];
      criteria: string;
    };

    if (!products?.length || !criteria) {
      return NextResponse.json(
        { error: "Missing products or criteria" },
        { status: 400 }
      );
    }

    console.log(
      `\n====== [fetch-spec] 기준: "${criteria}" (${products.length}개 제품) ======`
    );

    // Fetch spec for each product in parallel using Claude web search
    const values = await Promise.all(
      products.map(async (p) => {
        console.log(`  [fetch-spec] "${p.name}" → "${criteria}" 검색 중...`);

        const result = await generateText({
          model: anthropic(MODEL),
          tools: {
            webSearch: anthropic.tools.webSearch_20250305({ maxUses: 3 }),
            webFetch: anthropic.tools.webFetch_20250910({ maxUses: 2 }),
          },
          maxSteps: 6,
          system: `You are a Korean product spec extractor.
RULES:
- Return ONLY the spec value. No label, no explanation, no markdown.
- Keep it concise (e.g. "가능", "없음", "4바퀴 독립 서스펜션", "5.8kg", "최대 22kg까지").
- If the product page link is provided, use webFetch on it first.
- If not found on the page, use webSearch to find the spec elsewhere.
- If genuinely unknown after searching, return "-".
- NEVER return "정보 없음", "확인 불가", "N/A", or any explanation.`,
          prompt: `제품: "${p.name}"
${p.link ? `제품 페이지: ${p.link}` : ""}
찾을 스펙: "${criteria}"

위 제품의 "${criteria}" 값만 반환해줘. 값만, 설명 없이.`,
          temperature: 0,
        });

        const raw = result.text.trim().replace(/^["'\s]+|["'\s]+$/g, "");

        const EMPTY_PATTERNS = [
          /^정보\s*없음$/,
          /^알\s*수\s*없음$/,
          /^해당\s*없음$/,
          /^확인\s*불가$/,
          /^N\/A$/i,
          /^—+$/,
          /^없음$/,
        ];
        const value = EMPTY_PATTERNS.some((p) => p.test(raw)) ? "-" : (raw || "-");

        console.log(`  [fetch-spec] "${p.name}" → "${criteria}" = "${value}"`);
        return value;
      })
    );

    const result: Record<string, string> = {};
    products.forEach((p, i) => {
      result[p.name] = values[i];
    });

    console.log(`[fetch-spec] Results:`, result);
    console.log(`======================================================\n`);

    return NextResponse.json(result);
  } catch (err) {
    console.error("[fetch-spec] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
