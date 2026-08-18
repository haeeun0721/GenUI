import { generateObject, type ModelMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

export const INTENT_MODEL = "gpt-4o-mini" as const;

export const IntentAnalysisSchema = z.object({
  user_goal: z.string().describe("A detailed 1-2 sentence description of what the user is trying to accomplish. e.g. 'The user wants to find a robot vacuum under 800,000 KRW that is quiet and suitable for a household with pets.'"),
});

export type IntentAnalysis = z.infer<typeof IntentAnalysisSchema>;

const buildAnalyzerPrompt = () => `
[Role]
You are an intent analyzer for a shopping assistant.
Analyze the user's LATEST message and identify their intent.

[Input]
- conversation_history: Prior turns in this conversation, provided as message history. Reference material only.
- user_message: The latest message from the user — this is the one you must interpret.

[Task]
1. Write a concise description of the user's core goal (user_goal) in 1-2 sentences, describing the LATEST message only.
2. Use conversation_history only to resolve what the latest message refers to (e.g. a pronoun, "that one", or a fragment like "starts with X" that only makes sense given something named earlier). Do NOT summarize the conversation history itself, and do NOT restate goals from earlier turns unless the latest message actually refers back to them.
3. Describe only what the user explicitly asked for in the latest message (resolved with history if needed). Do NOT infer or assume unstated motivations or context beyond what history makes explicit.
4. Include constraints and preferences only if explicitly mentioned (in the latest message or a turn it refers to).
5. If the latest message is meaningless/unrelated filler with nothing to interpret, say so plainly instead of reaching for unrelated context (e.g. leftover criteria or specs) to manufacture a goal.

[Output]
{
  "user_goal": "<detailed 1-2 sentence description of the user's goal>"
}
`.trim();

export async function analyzeIntent(userMessage: string, history: ModelMessage[] = []): Promise<IntentAnalysis> {
  const latestText = userMessage.trim().length > 0 ? userMessage : "None";

  console.log(`\n\x1b[36m========== [1] Intent Analyzer ==========\x1b[0m`);
  console.log(`\x1b[90m[Input] History turns:\x1b[0m ${history.length}`);
  console.log(`\x1b[90m[Input] User Message:\x1b[0m ${latestText}`);

  const { object } = await generateObject({
    model: openai(INTENT_MODEL),
    schema: IntentAnalysisSchema,
    system: buildAnalyzerPrompt(),
    messages: [...history, { role: "user", content: latestText }],
    temperature: 0,
  });

  console.log(`\x1b[32m[Output] Analysis Result:\x1b[0m\n${JSON.stringify(object, null, 2)}`);
  console.log(`\x1b[36m=========================================\x1b[0m\n`);

  return object;
}
