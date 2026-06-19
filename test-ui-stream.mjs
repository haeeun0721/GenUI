import { agent } from "./lib/agents/conversation_agent.js";
import { createUIMessageStream } from "ai";
import fs from "fs";
import path from "path";

try {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, "utf-8");
    envConfig.split("\n").forEach((line) => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
      }
    });
  }
} catch (e) {}

async function run() {
  const result = await agent.stream({
    messages: [{ role: 'user', content: '디자인 노트북 추천' }]
  });

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.merge(result.toUIMessageStream());
    },
  });

  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    console.log("CHUNK:", JSON.stringify(value, null, 2));
  }
}

run().catch(console.error);
