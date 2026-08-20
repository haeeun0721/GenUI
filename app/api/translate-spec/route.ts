import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { NextRequest } from "next/server";
import { logElapsed } from "@/lib/backend/timing";

/**
 * POST /api/translate-spec
 *
 * Batch mode (recommended):
 *   Body: { specs: Record<string, any>, targetLocale: "ko" | "en" }
 *   Returns: Record<string, any>  (same keys, translated values)
 *
 * Single mode (legacy):
 *   Body: { spec: any, targetLocale: "ko" | "en" }
 *   Returns: translated spec
 *
 * All specs are translated in ONE LLM call to minimize latency.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const targetLocale: "ko" | "en" = body.targetLocale;

  if (!targetLocale) {
    return Response.json({ error: "Missing targetLocale" }, { status: 400 });
  }

  const lang = targetLocale === "en" ? "English" : "Korean";

  const systemPrompt = `You are a UI translation assistant.
You will receive a JSON object where each key maps to a UI spec. Translate ALL human-readable text values into ${lang}.
Rules:
- Translate ONLY string values that are human-readable text (labels, names, reasons, summaries, points, why, etc.)
- Do NOT translate: keys, type fields, URLs, IDs, "○", "X", "-", "순위", "Rank", "criterion", product keys like "prod_0"
- Preserve the EXACT JSON structure and all keys. Output ONLY the translated JSON object, no explanation.
- For CriteriaMap: translate category labels and item names.
- For InformationCard: translate term, summary, and points array.
- For Table: translate column labels (not criterion key column), row criterion values, _rankReasoning. Column labels that are product names follow the same name/brand rule as ProductCardList below.
- For ProductCardList: translate card specs arrays, AND card name/brand — these often arrive in Korean from a Korean retail catalog (e.g. name "모바 M1", brand "모바"); when translating to English, transliterate the Korean word into its natural English spelling (e.g. "모바" → "Moba") and keep existing Latin letters/numbers/model codes unchanged (e.g. "M330 Pro" stays "M330 Pro") — never leave a Korean (Hangul) word in a translated name or brand. When translating to Korean, restore/keep the original Korean form if evident from context, otherwise leave as-is.
- For ProductCardList/Table price values: the underlying prices are Korean Won — do not fabricate a currency conversion, only reformat the currency marker itself (Korean "원" suffix ↔ "₩" prefix symbol for the same number), e.g. "329,990원" ↔ "₩329,990".
- For TradeoffHint: translate newCriterion, conflictsWith, why.
- For UnchartedTerritoryChip: translate labels array.`;

  // ── Batch mode ──────────────────────────────────────────────────────────────
  if (body.specs && typeof body.specs === "object") {
    const specsMap: Record<string, any> = body.specs;
    const keys = Object.keys(specsMap);

    // Filter out nulls/undefineds
    const validEntries = keys.filter((k) => specsMap[k] != null);
    if (validEntries.length === 0) {
      return Response.json({});
    }

    const batchInput: Record<string, any> = {};
    validEntries.forEach((k) => { batchInput[k] = specsMap[k]; });

    const t0 = Date.now();
    try {
      const { text } = await generateText({
        model: anthropic("claude-haiku-4-5"),
        system: systemPrompt,
        prompt: `Translate all specs in this object to ${lang}:\n\n${JSON.stringify(batchInput, null, 2)}`,
        temperature: 0,
        maxOutputTokens: 4096,  // 스펙 필드 축소로 입력/출력 모두 감소
        // 이 호출엔 원래 타임아웃이 없어서, 드물게 느린 응답 하나가 41초까지 걸린 사례가
        // 실측에서 확인됐다(정상 케이스는 5~6초). 정상 범위보다 넉넉한 상한을 걸어 최악의
        // 경우에도 이 값 이상 기다리지 않게 한다 — 타임아웃 나면 아래 catch가 번역 없이
        // 원본 스펙을 그대로 반환(fail-open)하므로 화면이 깨지지 않는다.
        abortSignal: AbortSignal.timeout(15000),
      });
      logElapsed("translate_spec.batch", "-", t0);

      // Extract the outermost JSON object
      const firstBrace = text.indexOf("{");
      if (firstBrace === -1) return Response.json(specsMap);

      let depth = 0, lastBrace = -1;
      for (let i = firstBrace; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") { depth--; if (depth === 0) { lastBrace = i; break; } }
      }
      if (lastBrace === -1) return Response.json(specsMap);

      const translated = JSON.parse(text.substring(firstBrace, lastBrace + 1));
      // Fill missing keys with originals as fallback
      validEntries.forEach((k) => {
        if (!(k in translated)) translated[k] = specsMap[k];
      });
      return Response.json(translated);
    } catch (err) {
      logElapsed("translate_spec.batch", "-", t0, "err");
      console.error("[translate-spec] Batch error:", err);
      return Response.json(specsMap); // fallback: return originals
    }
  }

  // ── Single mode (legacy fallback) ───────────────────────────────────────────
  const { spec } = body;
  if (!spec) return Response.json({ error: "Missing spec" }, { status: 400 });

  const t0Single = Date.now();
  try {
    const { text } = await generateText({
      model: anthropic("claude-haiku-4-5"),
      system: systemPrompt,
      prompt: `Translate this UI spec to ${lang}:\n\n${JSON.stringify(spec, null, 2)}`,
      temperature: 0,
      abortSignal: AbortSignal.timeout(15000),
    });
    logElapsed("translate_spec.single", "-", t0Single);

    const firstBrace = text.indexOf("{");
    if (firstBrace === -1) return Response.json(spec);

    let depth = 0, lastBrace = -1;
    for (let i = firstBrace; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") { depth--; if (depth === 0) { lastBrace = i; break; } }
    }
    if (lastBrace === -1) return Response.json(spec);

    const translated = JSON.parse(text.substring(firstBrace, lastBrace + 1));
    return Response.json(translated);
  } catch (err) {
    logElapsed("translate_spec.single", "-", t0Single, "err");
    console.error("[translate-spec] Single error:", err);
    return Response.json(spec);
  }
}
