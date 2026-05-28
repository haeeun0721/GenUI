import { tool } from "ai";
import { z } from "zod";
import { generateUISpec } from "../agents/ui_agent";
import { currentRequestId, pushSidePanelResult } from "./sidebar-store";

export const renderToSidebar = tool({
    description:
        "Render a UI component (like a Timeline) to the persistent left sidebar. Use this for the 'Decision Journey' (Timeline) when identifying criteria, comparing products, or interpreting specs. \n\n## sidePanel Tool Arguments\n- intent_summary: Brief summary of the current user goal in English.\n- ui_intent_category: 1 (Exploration), 2 (Comparison), or 3 (Interpretation).\n- turn_number: The current turn number. Increment this by 1 for each NEW tool call you make in this conversation. Look at the history to determine the next number.\n- ui_context: Detailed summary of the criteria, products, or specs discussed.",
    inputSchema: z.object({
        ui_context: z.string().describe("Detailed summary of the data and context to be visualized."),
        intent_summary: z.string().describe("Brief description of the user's intent."),
        ui_intent_category: z.number().nullable().describe("Category of intent: 1 (Exploration), 2 (Comparison), 3 (Interpretation)."),
        turn_number: z.number().describe("The current turn number (incrementing for each new UI step)."),
    }),
    execute: async ({ ui_context, intent_summary, ui_intent_category, turn_number }) => {
        // Capture the requestId at the start of execute() before any async calls.
        // This prevents a race condition where a concurrent request overwrites
        // the global currentRequestId before generateUISpec() finishes.
        const capturedRequestId = currentRequestId;
        console.log(`[Tool: sidePanel] Requesting spec for [Turn ${turn_number}] ${intent_summary} (requestId: ${capturedRequestId})`);
        try {
            const uiSpecString = await generateUISpec(ui_context, intent_summary, ui_intent_category, turn_number);
            console.log("[Tool: sidePanel] Raw Spec String:", uiSpecString); // DEBUG LOG
            if (uiSpecString && !uiSpecString.startsWith("ERROR:")) {
                // ROBUST PARSER: Find the first '{' and its matching '}'
                const firstBrace = uiSpecString.indexOf('{');
                if (firstBrace !== -1) {
                    let lastBrace = -1;
                    let stack = 0;
                    for (let i = firstBrace; i < uiSpecString.length; i++) {
                        if (uiSpecString[i] === '{') stack++;
                        if (uiSpecString[i] === '}') stack--;
                        if (stack === 0) {
                            lastBrace = i;
                            break;
                        }
                    }

                    if (lastBrace !== -1) {
                        const jsonPart = uiSpecString.substring(firstBrace, lastBrace + 1);
                        const uiSpec = JSON.parse(jsonPart);
                        // Push into request-scoped store so route.ts can emit data-spec chunks
                        if (capturedRequestId) pushSidePanelResult(capturedRequestId, uiSpec);
                        return uiSpec;
                    }
                }
                
                // Fallback for extreme cases
                const cleanStr = uiSpecString.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
                return JSON.parse(cleanStr);
            }
            
            return {
                type: "Timeline",
                props: {
                    turns: [{
                        turn: 1,
                        summary: uiSpecString.startsWith("ERROR:") ? uiSpecString : "의사결정 프로세스 시작",
                        items: [{ name: "기본 사양", priority: "high" }]
                    }]
                }
            };
        } catch (err) {
            console.error("[Tool: sidePanel] Parsing Error:", err);
            return {
                type: "Timeline",
                props: {
                    turns: [{
                        turn: 1,
                        summary: `JSON 파싱 오류: ${err instanceof Error ? err.message : String(err)}`,
                        items: [{ name: "데이터 형식 오류", priority: "low" }]
                    }]
                }
            };
        }
    },
});
