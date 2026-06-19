import { agent } from "./lib/agents/conversation_agent.js";
import { convertToModelMessages } from "ai";
import fs from "fs";
import path from "path";

try {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, "utf-8");
    envConfig.split("\n").forEach((line) => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        let value = match[2] || "";
        if (value.startsWith('"')) value = value.slice(1, -1);
        process.env[match[1]] = value.trim();
      }
    });
  }
} catch (e) {}

async function run() {
  const uiMessages = [
    { role: "user", content: "디자인 노트북", id: "1", parts: [{ type: "text", text: "디자인 노트북" }] },
  ];
  const modelMessages = await convertToModelMessages(uiMessages as any);
  
  const genResult = await (agent as any).generate({ messages: modelMessages });
  genResult.steps.forEach((step: any, i: number) => {
    console.log(`\n=== Step ${i} ===`);
    console.log("step keys:", Object.keys(step));
    console.log("step.toolResults:", JSON.stringify(step.toolResults));
    console.log("step.toolCalls:", JSON.stringify(step.toolCalls?.map((t: any) => ({ name: t.toolName, id: t.toolCallId }))));
  });
}
run().catch(console.error);
