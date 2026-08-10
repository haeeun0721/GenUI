import { generateUISpec } from "@/lib/backend/agents/ui_agent";
import { setCurrentLocale } from "@/lib/backend/tools/sidebar-store";

export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    // generateUnchartedTerritory reads the shared currentLocale global — this route never
    // set it before, so it silently rode on whatever locale a previous, unrelated
    // /api/generate request happened to leave behind.
    const cookieHeader = req.headers.get("cookie") ?? "";
    const localeCookie = cookieHeader.split(";").find(c => c.trim().startsWith("gs_locale="));
    const locale = (localeCookie?.split("=")[1]?.trim() === "en" ? "en" : "ko") as "ko" | "en";
    setCurrentLocale(locale);

    const body = await req.json();
    const existingCategories: string[] = body.existingCategories ?? [];
    const existingItems: string[] = body.existingItems ?? [];
    const productCategory: string = body.productCategory ?? "";
    const alreadySuggested: string[] = body.alreadySuggested ?? [];

    const uiContext = [
      `PRODUCT_CATEGORY: ${productCategory}`,
      `EXISTING_CATEGORIES: ${existingCategories.join(", ") || (locale === "en" ? "none" : "없음")}`,
      existingItems.length > 0
        ? `EXISTING_ITEMS: ${existingItems.join(", ")}  ← already exist as items under a label above — never re-suggest these as a new label`
        : "",
      alreadySuggested.length > 0
        ? `ALREADY_SUGGESTED: ${alreadySuggested.join(", ")}  ← already suggested, exclude these and propose only new areas`
        : "",
    ].filter(Boolean).join("\n");

    console.log(`\n\x1b[35m========== UnchartedTerritoryChip ==========\x1b[0m`);
    console.log(`\x1b[90m[Input] product_category:\x1b[0m ${productCategory}`);
    console.log(`\x1b[90m[Input] existing_categories:\x1b[0m ${existingCategories.join(", ") || "(없음)"}`);
    console.log(`\x1b[90m[Input] existing_items:\x1b[0m ${existingItems.join(", ") || "(없음)"}`);
    console.log(`\x1b[90m[Input] already_suggested:\x1b[0m ${alreadySuggested.join(", ") || "(없음)"}`);
    const specText = await generateUISpec(uiContext, "", "6", 1, "", [], []);

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
