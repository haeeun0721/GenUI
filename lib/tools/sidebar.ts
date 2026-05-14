import { tool } from "ai";
import { z } from "zod/v4";

export const renderToSidebar = tool({
    description:
        "IMPORTANT: Render a UI component (like a Timeline) to the persistent left sidebar. ONLY use this for the 'Decision Journey' (Timeline). DO NOT use this tool for product recommendations or Grid component lists; those must be rendered inline in the chat message parts.",
    inputSchema: z.object({
        spec: z.any().describe("The GenUI component specification to render. Must follow the registered component schemas."),
    }),
    execute: async ({ spec }) => {
        console.log("DEBUG [renderToSidebar] Called with spec:", JSON.stringify(spec, null, 2));
        return spec;
    },
});
