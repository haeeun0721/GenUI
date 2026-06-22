import { generateUISpec } from "./lib/agents/ui_agent.ts";
import "dotenv/config";

const uiContext = [
  "NEW_CRITERION: 자동 비움 (중요)",
  "EXISTING_CRITERIA:\n- 흡입력\n- 물걸레 성능 (중요)\n- 무게",
  "PRODUCT_CATEGORY: 로봇 청소기"
].join("\n");

async function main() {
  const specText = await generateUISpec(
    uiContext,
    "Checking trade-off for newly added criterion \"자동 비움\" against existing criteria",
    "5",
    1,
    ""
  );
  console.log("LLM OUTPUT:");
  console.log(specText);
}
main();
