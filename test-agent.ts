import { agent } from "./lib/agents/conversation_agent.js";
import fs from "fs";
import path from "path";

// Load .env.local manually
try {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, "utf-8");
    envConfig.split("\n").forEach((line) => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || "";
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.substring(1, value.length - 1);
        } else if (value.startsWith("'") && value.endsWith("'")) {
          value = value.substring(1, value.length - 1);
        }
        process.env[key] = value.trim();
      }
    });
  }
} catch (e) {
  console.error("Failed to load .env.local", e);
}

async function run() {
  const result = await agent.stream({
    messages: [
      { role: 'user', content: '디자인 작업용 노트북을 사려고 하는데 어떤걸 기준으로 삼고 쇼핑을 해야돼?' },
      { role: 'assistant', content: '[Conversation Agent Decision] intent_summary: ... needs_ui: true ui_intent_category: 1\n\n왼쪽 사이드바에 기준을 정리해 드렸습니다!' },
      { role: 'user', content: '디자인 작업용 노트북 유명한 브랜드는 어디어디가 있을까?' }
    ],
    onStepFinish: (step) => {
      console.log('\n--- Step finished ---');
      console.log('Tool Calls:', step.toolCalls.map(t => t.toolName));
      console.log('Text Output:', step.text.slice(0, 100) + '...');
    }
  });

  for await (const chunk of result.fullStream) {}
}

run().catch(console.error);
