import { tool } from "ai";
import { z } from "zod";
import { generateUISpec } from "../agents/ui_agent";
import { currentRequestId, pushChatUIResult } from "./sidebar-store";

export const renderInChat = tool({
    description:
        "Render a UI component inline inside the chat window. Use this for categories 2, 3, and 4:\n" +
        "- Category 2 (Comparative Evaluation): Table or BarChart comparing products side-by-side.\n" +
        "- Category 3 (Product Recommendation): ProductCard for each recommended product.\n" +
        "- Category 4 (Spec Interpretation): Callout or Metric explaining whether a spec value is adequate.\n\n" +
        "## renderInChat Tool Arguments\n" +
        "- intent_summary: Brief summary of the current user goal in English.\n" +
        "- ui_intent_category: 2 (Comparison), 3 (Recommendation), or 4 (Spec Interpretation).\n" +
        "- ui_context: Detailed summary of the products, specs, or data to visualize.",
    inputSchema: z.object({
        ui_context: z.string().describe("Detailed summary of the data and context to be visualized."),
        intent_summary: z.string().describe("Brief description of the user's intent."),
        ui_intent_category: z.number().nullable().describe("Category of intent: 2 (Comparison), 3 (Recommendation), 4 (Spec Interpretation)."),
    }),
    execute: async ({ ui_context, intent_summary, ui_intent_category }) => {
        console.log(`[Tool: renderInChat] Requesting inline spec for category ${ui_intent_category}: ${intent_summary}`);
        try {
            const uiSpecString = await generateUISpec(ui_context, intent_summary, ui_intent_category, 1);
            console.log("[Tool: renderInChat] Raw Spec String:", uiSpecString);

            if (uiSpecString && !uiSpecString.startsWith("ERROR:")) {
                // ROBUST PARSER: Find the first '{' and its matching '}'
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
                        if (currentRequestId) pushChatUIResult(currentRequestId, uiSpec);
                        return uiSpec;
                    }
                }

                // Fallback: strip markdown fences
                const cleanStr = uiSpecString
                    .replace(/^```(?:json)?\s*\n?/, "")
                    .replace(/\n?```\s*$/, "")
                    .trim();
                const uiSpec = JSON.parse(cleanStr);
                if (currentRequestId) pushChatUIResult(currentRequestId, uiSpec);
                return uiSpec;
            }

            return { error: uiSpecString };
        } catch (err) {
            console.error("[Tool: renderInChat] Parsing Error:", err);
            return { error: `JSON 파싱 오류: ${err instanceof Error ? err.message : String(err)}` };
        }
    },
});
