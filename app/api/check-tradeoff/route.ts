import { generateUISpec } from "@/lib/backend/agents/ui_agent";
import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const {
    existingCriteria,
    newCriterion,
    productCategory,
    userContext,
  }: {
    existingCriteria: { name: string; important?: boolean }[];
    newCriterion: { name: string; important?: boolean };
    productCategory?: string;
    userContext?: string;
  } = await req.json();

  if (!newCriterion?.name) {
    return Response.json({ type: "Empty", props: {} });
  }

  if (!existingCriteria?.length) {
    return Response.json({ type: "Empty", props: {} });
  }

  // Format criteria with importance labels for the UI Agent
  const importanceLabel = (important?: boolean) => important ? " (중요)" : "";

  const criteriaLines = existingCriteria
    .map(c => `- ${c.name}${importanceLabel(c.important)}`)
    .join("\n");

  const uiContext = [
    `NEW_CRITERION: ${newCriterion.name}${importanceLabel(newCriterion.important)}`,
    `EXISTING_CRITERIA:\n${criteriaLines}`,
    `PRODUCT_CATEGORY: ${productCategory || "소비재"}`,
  ].join("\n");

  const intentSummary = `Checking trade-off for newly added criterion "${newCriterion.name}" against existing criteria`;

  try {
    const specText = await generateUISpec(
      uiContext,
      intentSummary,
      "5",
      1,
      userContext || "",
    );

    const firstBrace = specText.indexOf("{");
    if (firstBrace === -1) return Response.json({ type: "Empty", props: {} });

    let depth = 0;
    let lastBrace = -1;
    for (let i = firstBrace; i < specText.length; i++) {
      if (specText[i] === "{") depth++;
      else if (specText[i] === "}") { depth--; if (depth === 0) { lastBrace = i; break; } }
    }
    if (lastBrace === -1) return Response.json({ type: "Empty", props: {} });

    const spec = JSON.parse(specText.substring(firstBrace, lastBrace + 1));
    console.log("[TradeoffHint Output]", JSON.stringify(spec, null, 2));
    return Response.json(spec);
  } catch (err) {
    console.error("[check-tradeoff] Error:", err);
    return Response.json({ type: "Empty", props: {} });
  }
}
