import { tool } from "ai";
import { z } from "zod";
import { generateUISpec } from "../agents/ui_agent";
import { currentRequestId, pushSidePanelResult, currentMessages, currentUserContext } from "./sidebar-store";

export const renderToSidebar = tool({
    description:
        "Render a UI component to the persistent left sidebar. Use this for Category 1a (CriteriaMap) and Category 1b (InformationCard).\n\n## sidePanel Tool Arguments\n- intent_summary: Brief summary of the current user goal in English.\n- ui_intent_category: 1 for Category 1a (Criteria Exploration → CriteriaMap), or 1.5 for Category 1b (Concept Explanation → InformationCard). Use 1 for exploration questions and 1.5 for definition/explanation questions.\n- turn_number: The current turn number. Increment this by 1 for each NEW tool call you make in this conversation. Look at the history to determine the next number.\n- ui_context: Detailed summary of ALL criteria, products, or specs discussed so far (not just this turn).",
    inputSchema: z.object({
        ui_context: z.string().describe("Detailed summary of the data and context to be visualized."),
        intent_summary: z.string().describe("Brief description of the user's intent."),
        ui_intent_category: z.string().nullable().describe("Category of intent: '1a' (Criteria Exploration → CriteriaMap), or '1b' (Concept Explanation → InformationCard)."),
        turn_number: z.number().describe("The current turn number (incrementing for each new UI step)."),
    }),
    execute: async ({ ui_context, intent_summary, ui_intent_category, turn_number }) => {
        // Capture the requestId at the start of execute() before any async calls.
        // This prevents a race condition where a concurrent request overwrites
        // the global currentRequestId before generateUISpec() finishes.
        const capturedRequestId = currentRequestId;

        // Retrieve and format the latest KnowledgeMap categories and items from previous turns
        let existingCategoriesString = "";
        try {
            let latestCriteriaMap: any = null;

            for (let i = currentMessages.length - 1; i >= 0; i--) {
                const m = currentMessages[i];
                if (m.role !== "assistant") continue;

                for (const p of (m.parts ?? [])) {
                    // 1. Authoritative ui-spec or data-spec parts
                    if (p.type === "ui-spec" && p.spec?.type === "CriteriaMap") {
                        latestCriteriaMap = p.spec;
                        break;
                    }
                    if (p.type === "data-spec" && p.data?.type === "CriteriaMap") {
                        latestCriteriaMap = p.data;
                        break;
                    }
                    // 2. Fallback: Parse from tool results
                    if (p.type === "tool-result" && (p.toolName === "renderToSidebar" || p.toolName === "sidePanel")) {
                        const res = typeof p.result === "string" ? (() => { try { return JSON.parse(p.result); } catch { return null; } })() : p.result;
                        if (res?.type === "CriteriaMap") {
                            latestCriteriaMap = res;
                            break;
                        }
                    }
                    // 3. Fallback: Extract JSON strings in text parts
                    if (p.type === "text" && p.text && p.text.includes('"type": "CriteriaMap"')) {
                        const firstBrace = p.text.indexOf('{');
                        if (firstBrace !== -1) {
                            let lastBrace = -1;
                            let stack = 0;
                            for (let j = firstBrace; j < p.text.length; j++) {
                                if (p.text[j] === '{') stack++;
                                if (p.text[j] === '}') stack--;
                                if (stack === 0) {
                                    lastBrace = j;
                                    break;
                                }
                            }
                            if (lastBrace !== -1) {
                                try {
                                    const parsed = JSON.parse(p.text.substring(firstBrace, lastBrace + 1));
                                    if (parsed?.type === "CriteriaMap") {
                                        latestCriteriaMap = parsed;
                                        break;
                                    }
                                } catch (err) {}
                            }
                        }
                    }
                }
                if (latestCriteriaMap) break;
            }

            if (latestCriteriaMap?.props?.categories) {
                const cats = latestCriteriaMap.props.categories.map((c: any) => {
                    const items = (c.items ?? []).map((i: any) => i.name).join(", ");
                    return `${c.label} (${items})`;
                }).join(", ");
                existingCategoriesString = `[EXISTING CATEGORIES: ${cats}]`;
            }
        } catch (err) {
            console.error("[Tool: sidePanel] Error resolving history:", err);
        }

        let effectiveUIContext = ui_context;
        if (existingCategoriesString && ui_intent_category === "1a") {
            const hasExistingTag = effectiveUIContext.includes("[EXISTING CATEGORIES:");
            if (hasExistingTag) {
                effectiveUIContext = effectiveUIContext.replace(/\[EXISTING CATEGORIES:[^\]]+\]/, existingCategoriesString);
            } else {
                effectiveUIContext += `\n\n${existingCategoriesString}`;
            }
            console.log(`[Tool: sidePanel] Patched ui_context with full memory: ${existingCategoriesString}`);
        }

        console.log([
            "[Tool: sidePanel] OUTPUT FORMAT",
            `  category     : ${ui_intent_category}`,
            `  intent       : ${intent_summary}`,
            `  turn         : ${turn_number}`,
            `  ui_context   : ${effectiveUIContext}`,
        ].join("\n"));
        try {
            const uiSpecString = await generateUISpec(effectiveUIContext, intent_summary, ui_intent_category, turn_number, currentUserContext);
            console.log("[UI Agent Output]", uiSpecString);
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
                type: "CriteriaMap",
                props: {
                    categories: [{
                        label: "탐색 시작",
                        items: [{ name: "기본 사항" }]
                    }]
                }
            };
        } catch (err) {
            console.error("[Tool: sidePanel] Parsing Error:", err);
            return {
                type: "CriteriaMap",
                props: {
                    categories: [{
                        label: "오류",
                        items: [{ name: `파싱 오류: ${err instanceof Error ? err.message : String(err)}` }]
                    }]
                }
            };
        }
    },
});
