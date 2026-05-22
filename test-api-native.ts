import { createUIMessageStream, createUIMessageStreamResponse } from "ai";

async function run() {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: 'text-delta', delta: "Hello" } as any);
      writer.write({ type: 'text-delta', delta: " World" } as any);
      
      // Let's try passing without id, and with an id
      writer.write({ type: 'text-delta', delta: " with id", id: "test-id" } as any);
    }
  });
  
  const response = createUIMessageStreamResponse({ stream });
  const reader = response.body?.getReader();
  if (reader) {
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      console.log("OUT:", dec.decode(value));
    }
  }
}
run().catch(console.error);
