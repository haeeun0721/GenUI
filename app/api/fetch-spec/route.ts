import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import FirecrawlApp from "firecrawl";

const MODEL = "gemini-2.5-flash";

// ---------------------------------------------------------------------------
// Resolve the best URL to scrape for a product.
// ---------------------------------------------------------------------------

function resolveProductUrl(link: string): string {
  if (!link) return "";
  if (link.includes("prod.danawa.com/info")) return link;
  const pcodeMatch = link.match(/pcode=(\d+)/);
  if (pcodeMatch) return `https://prod.danawa.com/info/?pcode=${pcodeMatch[1]}`;
  return link;
}

// ---------------------------------------------------------------------------
// Strip HTML tags
// ---------------------------------------------------------------------------
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Parse Danawa detail page HTML → spec key/value map.
// Sources:
//   1. spec_tbl  — structured spec table (th.tit / td.dsc pairs)
//   2. spec_list — quick-spec chips in summary_info
//      Format: "흡입력: 3,000Pa / 센서: 초음파 / 사용시간: 25분(최대)"
// ---------------------------------------------------------------------------
function parseDanawaSpecHtml(html: string): Record<string, string> {
  const specs: Record<string, string> = {};

  // ── 1. spec_tbl ─────────────────────────────────────────────────────────
  const tblIdx = html.indexOf('class="spec_tbl"');
  if (tblIdx >= 0) {
    const tbodyStart = html.indexOf("<tbody", tblIdx);
    const tableEnd = html.indexOf("</table>", tblIdx);
    const tableHtml =
      tbodyStart >= 0 && tableEnd > tbodyStart
        ? html.slice(tbodyStart, tableEnd)
        : "";

    if (tableHtml) {
      let currentSection = "";
      const trRe = /<tr>([\s\S]*?)<\/tr>/gi;
      let trMatch;
      while ((trMatch = trRe.exec(tableHtml)) !== null) {
        const rowHtml = trMatch[1];

        // Section header: <th colspan="4">품목</th>
        const secMatch = rowHtml.match(
          /<th[^>]*colspan="4"[^>]*>([\s\S]*?)<\/th>/i
        );
        if (secMatch) {
          const raw = stripHtml(secMatch[1]).trim();
          currentSection = raw.includes("KC")
            ? "KC인증"
            : raw.replace(/인증/g, "").trim();
          continue;
        }

        const thMatches = [
          ...rowHtml.matchAll(
            /<th[^>]*class="[^"]*tit[^"]*"[^>]*>([\s\S]*?)<\/th>/gi
          ),
        ];
        const tdMatches = [
          ...rowHtml.matchAll(
            /<td[^>]*class="[^"]*dsc[^"]*"[^>]*>([\s\S]*?)<\/td>/gi
          ),
        ];
        for (let i = 0; i < thMatches.length; i++) {
          const key = stripHtml(thMatches[i][1]).trim();
          const rawVal = tdMatches[i]
            ? stripHtml(tdMatches[i][1]).trim()
            : "";
          if (!key) continue;
          const value = rawVal === "○" ? "가능" : rawVal;
          if (!value) continue;
          specs[key] = value;
          if (currentSection && currentSection !== key)
            specs[currentSection] = value;
        }
      }
    }
  }

  // ── 2. spec_list from summary_info: quick-spec chips ──────────────────
  // Format: 흡입력: 3,000Pa / 센서: 초음파 / 사용시간: 25분(최대)
  const itemsIdx = html.indexOf('class="items"');
  if (itemsIdx >= 0) {
    const itemsEnd = html.indexOf("</div>", itemsIdx);
    if (itemsEnd > itemsIdx) {
      const itemsHtml = html.slice(itemsIdx, itemsEnd);
      const rawText = stripHtml(itemsHtml).replace(/\s+/g, " ").trim();
      for (const pair of rawText.split(/\s*\/\s*/)) {
        const colonIdx = pair.indexOf(":");
        if (colonIdx < 1) continue;
        const key = pair.slice(0, colonIdx).trim();
        const value = pair.slice(colonIdx + 1).trim();
        // Only add if not already captured by spec_tbl
        if (key && value && key.length <= 20 && !specs[key]) {
          specs[key] = value;
        }
      }
    }
  }

  console.log(
    `  └─ [HTML 파싱] ${Object.keys(specs).length}개 스펙: ${Object.keys(specs).slice(0, 10).join(", ")}...`
  );
  return specs;
}

// ---------------------------------------------------------------------------
// Parse markdown spec table rows: | key | value |
// Fallback for non-Danawa pages.
// ---------------------------------------------------------------------------
function parseMarkdownSpecTable(markdown: string): Record<string, string> {
  const specs: Record<string, string> = {};
  const rowRe = /^\|(.+)\|$/gm;
  let match;
  while ((match = rowRe.exec(markdown)) !== null) {
    const cells = match[1].split("|").map((c) => c.trim());
    if (cells.length < 2) continue;
    if (cells.every((c) => /^[-:\s]+$/.test(c))) continue;
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const key = cells[i].replace(/\*\*/g, "").trim();
      const value = cells[i + 1].replace(/\*\*/g, "").trim();
      if (!key || !value || key.length > 40) continue;
      if (key === value) continue;
      if (
        ["항목", "내용", "구분", "상세", "제품명", "사진", "이미지"].includes(
          key
        )
      )
        continue;
      specs[key] = value;
    }
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Find a spec value using fuzzy key matching.
// ---------------------------------------------------------------------------
function findInParsedSpecs(
  specs: Record<string, string>,
  criteria: string
): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[\s\-\/\(\)]/g, "");
  const cNorm = norm(criteria);
  for (const [k, v] of Object.entries(specs)) {
    if (norm(k) === cNorm) return v;
  }
  for (const [k, v] of Object.entries(specs)) {
    const kNorm = norm(k);
    if (kNorm.includes(cNorm) || cNorm.includes(kNorm)) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scrape a product page — HTML only, no markdown conversion.
// ---------------------------------------------------------------------------
async function scrapeUrl(
  url: string
): Promise<{ html: string; isDanawa: boolean }> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey || !url) return { html: "", isDanawa: false };

  const isDanawa = url.includes("prod.danawa.com/info");

  try {
    const app = new FirecrawlApp({ apiKey });
    // HTML only — no markdown needed; we parse HTML directly
    const result = await app.scrape(url, {
      formats: ["html"],
      waitFor: 5000,
      onlyMainContent: false,
    });
    const html = (result as any).html ?? "";
    console.log(
      `[fetch-spec] Scraped ${url.slice(0, 70)}...: HTML ${html.length}자`
    );
    return { html, isDanawa };
  } catch (err) {
    console.warn(`[fetch-spec] Firecrawl failed for ${url}:`, err);
    return { html: "", isDanawa: false };
  }
}

// ---------------------------------------------------------------------------
// Extract spec value for one product.
// Flow:
//   1. Parse HTML (spec_tbl + spec_list) → direct match → done
//   2. LLM receives the parsed spec map as context
//   3. If page unavailable → LLM training knowledge → (추정) marker
// ---------------------------------------------------------------------------
async function extractSpecValue(
  productName: string,
  page: { html: string; isDanawa: boolean },
  criteria: string
): Promise<string> {
  // Step 1: HTML parsing
  let parsed: Record<string, string> = {};
  if (page.html.length > 200) {
    parsed = parseDanawaSpecHtml(page.html);
  }

  const parsedKeys = Object.keys(parsed);
  if (parsedKeys.length > 0) {
    console.log(
      `  └─ [스펙 검색] "${criteria}" (${parsedKeys.length}개 키)`
    );
    const found = findInParsedSpecs(parsed, criteria);
    if (found) {
      const norm = (s: string) =>
        s.toLowerCase().replace(/[\s\-\/\(\)]/g, "");
      const cNorm = norm(criteria);
      const matchedKey =
        parsedKeys.find((k) => {
          const kn = norm(k);
          return (
            kn === cNorm || kn.includes(cNorm) || cNorm.includes(kn)
          );
        }) ?? "unknown";
      console.log(
        `  └─ ✅ [직접 매칭] 키: "${matchedKey}" → 값: "${found}"`
      );
      return found;
    }
    console.log(`  └─ ⚠️ [매칭 실패] "${criteria}" 키 없음 → LLM 추출 시도`);
  }

  // Step 2: LLM extraction
  const hasPage = page.html.length > 200;
  console.log(
    `  └─ [LLM 추출] ${hasPage ? "📄 HTML 기반" : "🧠 학습 지식만 사용"}`
  );

  // Provide parsed spec map to LLM (compact, no raw HTML)
  const context = hasPage
    ? `[다나와 페이지 스펙 목록]\n${
        Object.entries(parsed)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n") || "(스펙 테이블 비어있음)"
      }`
    : `[다나와 스크래핑 실패 — AI 학습 지식 사용]`;

  const { text } = await generateText({
    model: google(MODEL),
    system: `You are a Korean product spec expert.
Your task: extract ONE specific spec value for a product.

RULES:
1. Return ONLY the spec value — no explanation, no label.
2. Keep it concise (e.g. "5.8kg", "가능", "없음", "4바퀴 독립 서스펜션", "최대 20시간").
3. If [다나와 페이지 스펙 목록] is provided, check it first.
4. If not found there, use your training knowledge of this exact product model.
5. Return "-" ONLY if you have absolutely no knowledge of this spec for this model.
6. NEVER return "정보 없음" or "—".`,
    prompt: `Product: "${productName}"
Spec/Criteria: "${criteria}"

${context}

Answer with ONLY the spec value for "${criteria}". No explanation.`,
    temperature: 0,
  });

  const raw = text.trim().replace(/^["']|["']$/g, "");
  const EMPTY_PATTERNS = [
    /^정보\s*없음$/,
    /^알\s*수\s*없음$/,
    /^해당\s*없음$/,
    /^확인\s*불가$/,
    /^정보\s*미제공$/,
    /^N\/A$/i,
    /^—+$/,
    /^없음$/,
  ];
  const value = EMPTY_PATTERNS.some((p) => p.test(raw)) ? "-" : raw;
  if (!value || value === "-") return "-";

  // (추정) only when page was not available
  if (!hasPage) {
    return value.includes("(추정)") ? value : `${value} (추정)`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// POST /api/fetch-spec
// Body: { products: { name: string; link: string }[], criteria: string }
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

    const resolvedUrls = products.map((p) => resolveProductUrl(p.link));

    products.forEach((p, i) => {
      const raw = p.link || "(없음)";
      const resolved = resolvedUrls[i] || "(없음)";
      const isDanawa = resolved.includes("prod.danawa.com/info");
      console.log(`  [${i + 1}] "${p.name}"`);
      console.log(`       원본 링크: ${raw.slice(0, 80)}`);
      console.log(`       사용 URL : ${resolved.slice(0, 80)}`);
      console.log(
        `       URL 타입 : ${isDanawa ? "✅ Danawa 상세페이지" : "❓ 기타"}`
      );
    });

    const pageContents = await Promise.all(resolvedUrls.map(scrapeUrl));

    pageContents.forEach((page, i) => {
      console.log(
        `  [${i + 1}] 스크래핑: ${
          page.html.length > 0 ? `HTML ${page.html.length}자` : "❌ 실패"
        }`
      );
    });

    const values = await Promise.all(
      products.map((p, i) => extractSpecValue(p.name, pageContents[i], criteria))
    );

    values.forEach((v, i) => {
      const source = v.includes("(추정)")
        ? "🤖 LLM 추정"
        : v === "-"
        ? "❌ 없음"
        : "✅ Danawa";
      console.log(`  [${i + 1}] "${criteria}" = "${v}" (${source})`);
    });
    console.log(`======================================================\n`);

    const result: Record<string, string> = {};
    products.forEach((p, i) => {
      result[p.name] = values[i];
    });

    console.log(`[fetch-spec] Results for "${criteria}":`, result);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[fetch-spec] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
