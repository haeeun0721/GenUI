import { agent } from "./lib/agents/conversation_agent.js";
async function run() {
  const result = await agent.stream({
    messages: [{ role: 'user', content: '디자인 노트북 추천' }]
  });
  console.log("Keys in result:", Object.keys(result));
  process.exit(0);
}
run().catch(console.error);
