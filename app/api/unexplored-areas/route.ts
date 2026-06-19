import { generateUISpec } from "@/lib/agents/ui_agent";

export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const existingCategories: string[] = body.existingCategories ?? [];
    const productCategory: string = body.productCategory ?? "";
    const droppedCriteria: string[] = body.droppedCriteria ?? [];

    const uiContext = [
      `PRODUCT_CATEGORY: ${productCategory}`,
      `EXISTING_CATEGORIES: ${existingCategories.join(", ") || "없음"}`,
      `SAVED_CRITERIA: ${droppedCriteria.join(", ") || "없음"}`,
    ].join("\n");

    console.log("[UnchartedTerritoryChip] Calling UI Agent (category=6)...");
    const specText = await generateUISpec(uiContext, "", "6", 1, "", [], droppedCriteria);

    // Robust JSON extraction (same brace-matching pattern as check-tradeoff)
    const firstBrace = specText.indexOf("{");
    if (firstBrace === -1) return Response.json({ labels: [] });

    let depth = 0, lastBrace = -1;
    for (let i = firstBrace; i < specText.length; i++) {
      if (specText[i] === "{") depth++;
      if (specText[i] === "}") depth--;
      if (depth === 0) { lastBrace = i; break; }
    }

    const spec = JSON.parse(specText.substring(firstBrace, lastBrace + 1));
    console.log("[UnchartedTerritoryChip Output]", JSON.stringify(spec, null, 2));

    if (spec.type === "UnchartedTerritoryChip" && Array.isArray(spec.props?.labels)) {
      return Response.json({ labels: spec.props.labels.filter((l: any) => typeof l === "string") });
    }

    return Response.json({ labels: [] });
  } catch (err) {
    console.error("[unexplored-areas] Error:", err);
    return Response.json({ labels: [] }, { status: 500 });
  }
}
