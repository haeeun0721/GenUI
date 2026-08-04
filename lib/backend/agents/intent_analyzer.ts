import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

export const INTENT_MODEL = "gpt-4o" as const;

export const IntentAnalysisSchema = z.object({
  user_goal: z.string().describe("A detailed 1-2 sentence description of what the user is trying to accomplish. e.g. 'The user wants to find a robot vacuum under 800,000 KRW that is quiet and suitable for a household with pets.'"),
});

export type IntentAnalysis = z.infer<typeof IntentAnalysisSchema>;

const buildAnalyzerPrompt = () => `
[Role]
You are an intent analyzer for a shopping assistant.
Analyze the user's input message and identify their intent.

[Input]
- user_message: The latest message from the user.

[Task]
Write a concise description of the user's core goal (user_goal) in 1-2 sentences.
- Describe only what the user explicitly asked for. Do NOT infer or assume unstated motivations or context.
- Include constraints and preferences only if the user explicitly mentioned them.

[Output]
{
  "user_goal": "<detailed 1-2 sentence description of the user's goal>"
}
`.trim();

export async function analyzeIntent(userMessage: string): Promise<IntentAnalysis> {
  const latestText = userMessage.trim().length > 0 ? userMessage : "None";

  console.log(`\n\x1b[36m========== [1] Intent Analyzer ==========\x1b[0m`);
  console.log(`\x1b[90m[Input] User Message:\x1b[0m ${latestText}`);

  const { object } = await generateObject({
    model: openai(INTENT_MODEL),
    schema: IntentAnalysisSchema,
    system: buildAnalyzerPrompt(),
    prompt: latestText,   // only the latest user message
    temperature: 0,
  });

  console.log(`\x1b[32m[Output] Analysis Result:\x1b[0m\n${JSON.stringify(object, null, 2)}`);
  console.log(`\x1b[36m=========================================\x1b[0m\n`);

  return object;
}
