import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { NextRequest } from "next/server";

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
- Do NOT translate: keys, type fields, URLs, IDs, numeric values, "○", "X", "-", "순위", "Rank", "criterion", product keys like "prod_0"
- Preserve the EXACT JSON structure and all keys. Output ONLY the translated JSON object, no explanation.
- For CriteriaMap: translate category labels and item names.
- For InformationCard: translate term, summary, and points array.
- For Table: translate column labels (not criterion key column), row criterion values, _rankReasoning.
- For ProductCardList: translate card specs arrays.
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

    try {
      const { text } = await generateText({
        model: anthropic("claude-haiku-4-5"),
        system: systemPrompt,
        prompt: `Translate all specs in this object to ${lang}:\n\n${JSON.stringify(batchInput, null, 2)}`,
        temperature: 0,
        maxTokens: 8192,
      });

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
      console.error("[translate-spec] Batch error:", err);
      return Response.json(specsMap); // fallback: return originals
    }
  }

  // ── Single mode (legacy fallback) ───────────────────────────────────────────
  const { spec } = body;
  if (!spec) return Response.json({ error: "Missing spec" }, { status: 400 });

  try {
    const { text } = await generateText({
      model: anthropic("claude-haiku-4-5"),
      system: systemPrompt,
      prompt: `Translate this UI spec to ${lang}:\n\n${JSON.stringify(spec, null, 2)}`,
      temperature: 0,
    });

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
    console.error("[translate-spec] Single error:", err);
    return Response.json(spec);
  }
}
