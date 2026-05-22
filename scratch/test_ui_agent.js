import { generateUISpec } from "../lib/agents/ui_agent.ts";

async function test() {
  const context = "The user wants to buy a laptop for design work. Important factors are CPU performance, GPU, RAM capacity, storage, display quality, and battery life.";
  console.log("Testing UI Agent with context:", context);
  try {
    const result = await generateUISpec(context);
    console.log("RESULT:\n", result);
  } catch (err) {
    console.error("ERROR:", err);
  }
}

test();
