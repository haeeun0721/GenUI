import { tool } from "ai";
import { z } from "zod";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { generateUISpec } from "../agents/ui_agent";
import {
  currentRequestId,
  pushCompTableResult,
  currentUserContext,
  currentSavedItems,
  currentDecisionCriteria,
  currentMyItemsContextSummary,
} from "./sidebar-store";

// ---------------------------------------------------------------------------
// Tavily 단순 스니펫 검색 (컨텍스트 보강용)
// ---------------------------------------------------------------------------

async function tavilySearchSnippet(query: string): Promise<{ url: string; snippet: string } | null> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: 3,
        include_answer: false,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { results?: Array<{ content: string; url: string }> };
    const top = (data.results ?? [])[0];
    if (!top) return null;
    return { url: top.url, snippet: top.content.slice(0, 300) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// MD 로그 작성
// ---------------------------------------------------------------------------

interface WebResult {
  criterion: string;
  url: string;
  snippet: string;
}

interface ProductLog {
  name: string;
  localSpecs: string[];
  coveredCriteria: string[];
  missingCriteria: string[];
  webResults: WebResult[];
}

function writeCompTableLog(
  productLogs: ProductLog[],
  decisionCriteria: string[]
): void {
  try {
    const dataDir = join(process.cwd(), "data");
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const lines: string[] = [];

    lines.push(`# 📊 비교표 생성 로그`);
    lines.push(`\n> 생성 시각: ${now}`);
    lines.push(`\n---\n`);

    lines.push(`## ✅ Decision Criteria (${decisionCriteria.length}개)\n`);
    decisionCriteria.forEach((c) => lines.push(`- ${c}`));

    lines.push(`\n---\n`);
    lines.push(`## 📦 제품별 스펙 커버리지\n`);

    productLogs.forEach((p) => {
      lines.push(`### ${p.name}\n`);

      lines.push(`**Danawa DB 스펙 (${p.localSpecs.length}개)**\n`);
      if (p.localSpecs.length > 0) {
        p.localSpecs.forEach((s) => lines.push(`- \`${s}\``));
      } else {
        lines.push(`- *(스펙 없음)*`);
      }

      lines.push(`\n**기준별 커버리지**\n`);
      lines.push(`| 기준 | DB 스펙 커버 | 웹 보강 |`);
      lines.push(`|------|:-----------:|:------:|`);
      decisionCriteria.forEach((c) => {
        const dbCovered = p.coveredCriteria.includes(c);
        const webCovered = p.webResults.some((w) => w.criterion === c);
        lines.push(`| ${c} | ${dbCovered ? "✅" : "❌"} | ${webCovered ? "🔍" : "-"} |`);
      });

      if (p.webResults.length > 0) {
        lines.push(`\n**웹 검색 보강 내용**\n`);
        p.webResults.forEach((w) => {
          lines.push(`- **기준**: \`${w.criterion}\``);
          lines.push(`  - 🔗 출처: [${w.url}](${w.url})`);
          lines.push(`  - 📝 근거 문구: "${w.snippet.replace(/\n/g, ' ').slice(0, 200)}"`);
        });
      }

      lines.push("");
    });

    lines.push(`---\n`);
    lines.push(`## 📋 요약\n`);
    lines.push(`| 제품 | DB 커버 기준 | 미커버 기준 | 웹 보강 |`);
    lines.push(`|------|:-----------:|:-----------:|:------:|`);
    productLogs.forEach((p) => {
      lines.push(
        `| ${p.name.slice(0, 25)} | ${p.coveredCriteria.length}/${decisionCriteria.length} | ${p.missingCriteria.join(", ") || "없음"} | ${p.webResults.length > 0 ? `${p.webResults.length}개` : "-"} |`
      );
    });

    // 전체 출처 목록
    const allWebResults = productLogs.flatMap(p => p.webResults.map(w => ({ product: p.name, ...w })));
    if (allWebResults.length > 0) {
      lines.push(`\n---\n`);
      lines.push(`## 🔗 웹 검색 출처 전체 목록\n`);
      allWebResults.forEach((w) => {
        lines.push(`- **${w.product.slice(0, 20)}** / \`${w.criterion}\``);
        lines.push(`  - [${w.url}](${w.url})`);
        lines.push(`  - > ${w.snippet.replace(/\n/g, ' ').slice(0, 150)}`);
      });
    }

    writeFileSync(join(dataDir, "comp-table-log.md"), lines.join("\n"), "utf8");
    console.log(`\n[CompTable Log] 📄 MD 로그 저장: data/comp-table-log.md`);
  } catch (e) {
    console.warn("[CompTable Log] MD 저장 실패:", e);
  }
}

// ---------------------------------------------------------------------------
// 컨텍스트 사전 보강 — Claude 호출 전에 미확인 기준을 웹에서 채움
// ---------------------------------------------------------------------------

async function enrichContextBeforeClaude(
  contextSummary: string,
  decisionCriteria: string[]
): Promise<{ enriched: string; productLogs: ProductLog[] }> {
  const productLogs: ProductLog[] = [];

  if (!contextSummary.trim() || decisionCriteria.length === 0) {
    return { enriched: contextSummary, productLogs };
  }

  const parts = contextSummary.split(/(\[Product \d+\])/);
  const blocks: Array<{ header: string; body: string }> = [];

  for (let i = 0; i < parts.length; i++) {
    if (/^\[Product \d+\]$/.test(parts[i].trim())) {
      blocks.push({ header: parts[i], body: parts[i + 1] ?? "" });
      i++;
    }
  }

  if (blocks.length === 0) return { enriched: contextSummary, productLogs };

  const enrichedBlocks = await Promise.all(
    blocks.map(async ({ header, body }) => {
      const nameMatch = body.match(/Name:\s*(.+)/);
      if (!nameMatch) return header + body;
      const productName = nameMatch[1].trim();

      const specsMatch = body.match(/Specs:\s*(.+)/);
      const descMatch  = body.match(/Description:\s*(.+)/);
      const localSpecs = specsMatch?.[1]?.split(" / ").map(s => s.trim()).filter(Boolean) ?? [];
      const specsText  = [specsMatch?.[1] ?? "", descMatch?.[1] ?? ""].join(" ").toLowerCase();

      const coveredCriteria: string[] = [];
      const missingCriteria: string[] = [];

      decisionCriteria.forEach((criterion) => {
        const keywords = criterion.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
        const covered = keywords.some((kw) => specsText.includes(kw));
        if (covered) coveredCriteria.push(criterion);
        else missingCriteria.push(criterion);
      });

      // 터미널 상세 로그
      console.log(`\n\x1b[36m[Spec Coverage] "${productName}"\x1b[0m`);
      console.log(`  Danawa 스펙 (${localSpecs.length}개): ${localSpecs.slice(0, 5).join(" / ")}${localSpecs.length > 5 ? " ..." : ""}`);
      coveredCriteria.forEach(c => console.log(`  ✅ "${c}" → DB에서 커버`));
      missingCriteria.forEach(c => console.log(`  ❌ "${c}" → DB 미커버 (웹 검색 필요)`));

      if (missingCriteria.length === 0) {
        productLogs.push({ name: productName, localSpecs, coveredCriteria, missingCriteria, webResults: [] });
        return header + body;
      }

      const webResultRaw = await Promise.all(
        missingCriteria.slice(0, 5).map(async (criterion) => {
          const query = `${productName} ${criterion}`;
          const result = await tavilySearchSnippet(query);
          if (result) {
            console.log(`   🔍 "${query}" → ${result.snippet.slice(0, 60)}...`);
            console.log(`       출처: ${result.url}`);
            return { criterion, url: result.url, snippet: result.snippet };
          }
          console.log(`   🔍 "${query}" → 결과 없음`);
          return null;
        })
      );

      const webResults = webResultRaw.filter(Boolean) as WebResult[];
      productLogs.push({ name: productName, localSpecs, coveredCriteria, missingCriteria, webResults });

      if (webResults.length === 0) return header + body;

      const webSpecText = webResults.map(w => `${w.criterion}: ${w.snippet}`).join(" | ");
      return header + body + `\nWebSpecs (from web search): ${webSpecText}`;
    })
  );

  return { enriched: enrichedBlocks.join(""), productLogs };
}

// ---------------------------------------------------------------------------
// Tool Export
// ---------------------------------------------------------------------------

export const renderToCompTable = tool({
  description: "Render a comparison Table UI component to the Comparison Table panel. Use for Category 2 (Comparative Evaluation).",
  inputSchema: z.object({
    intent_summary: z
      .string()
      .describe("Brief description of the user's intent."),
    ui_intent_category: z
      .string()
      .nullable()
      .describe("Always '2' for Comparative Evaluation."),
  }),
  execute: async ({ intent_summary, ui_intent_category }) => {
    console.log(
      [
        "[Tool: renderToCompTable] OUTPUT FORMAT",
        `  category     : ${ui_intent_category}`,
        `  intent       : ${intent_summary}`,
      ].join("\n")
    );

    const rawContext = currentMyItemsContextSummary;

    console.log("[renderToCompTable] decision_criteria:", currentDecisionCriteria);
    console.log("[renderToCompTable] saved_items:", currentSavedItems);
    console.log("[renderToCompTable] product_data length:", rawContext.length);

    console.log("\n[Pre-enrich] Local DB 스펙 vs. Decision Criteria 커버리지 점검 시작...");
    const { enriched: enrichedContext, productLogs } = await enrichContextBeforeClaude(
      rawContext,
      currentDecisionCriteria
    );
    const wasEnriched = enrichedContext !== rawContext;
    console.log(
      wasEnriched
        ? "[Pre-enrich] ✅ 웹 스펙 보강 완료 → 보강된 context로 Claude 호출"
        : "[Pre-enrich] ✅ Local DB 스펙만으로 충분 → 원본 context로 Claude 호출"
    );

    // MD 로그 저장
    writeCompTableLog(productLogs, currentDecisionCriteria);

    try {
      const uiSpecString = await generateUISpec(
        enrichedContext,
        intent_summary,
        ui_intent_category,
        1,
        currentUserContext,
        currentSavedItems,
        currentDecisionCriteria
      );

      if (uiSpecString && !uiSpecString.startsWith("ERROR:")) {
        const firstBrace = uiSpecString.indexOf("{");
        if (firstBrace !== -1) {
          let lastBrace = -1;
          let stack = 0;
          for (let i = firstBrace; i < uiSpecString.length; i++) {
            if (uiSpecString[i] === "{") stack++;
            if (uiSpecString[i] === "}") stack--;
            if (stack === 0) {
              lastBrace = i;
              break;
            }
          }

          if (lastBrace !== -1) {
            const jsonPart = uiSpecString.substring(firstBrace, lastBrace + 1);
            const uiSpec = JSON.parse(jsonPart);
            if (currentRequestId) pushCompTableResult(currentRequestId, uiSpec);
            return uiSpec;
          }
        }

        const cleanStr = uiSpecString
          .replace(/^```(?:json)?\s*\n?/, "")
          .replace(/\n?```\s*$/, "")
          .trim();
        const uiSpec = JSON.parse(cleanStr);
        if (currentRequestId) pushCompTableResult(currentRequestId, uiSpec);
        return uiSpec;
      }

      return { error: uiSpecString };
    } catch (err) {
      console.error("[Tool: renderToCompTable] Parsing Error:", err);
      return {
        error: `JSON 파싱 오류: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
