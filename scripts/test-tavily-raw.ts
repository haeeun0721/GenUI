/**
 * scripts/test-tavily-raw.ts
 * judgeCell(data_agent.ts)이 스니펫을 가공/재채점하기 이전, Tavily API가 실제로
 * 돌려주는 원본 응답(answer/results/images 등 전체 필드)을 그대로 확인하기 위한
 * 실험용 스크립트. data_agent.ts의 tavilySearch()는 { results, answer }만 골라
 * 반환하므로 일부러 거치지 않고 fetch를 직접 쳐서 응답 전체를 본다.
 *
 * Tavily API에는 answer 언어를 지정하는 공식 파라미터가 없고, 쿼리에 "한국어로
 * 답변해줘" 같은 문구를 붙이는 프롬프트 트릭도 매번 먹히지는 않는다(확인함) — 그래서
 * answer는 원문(영어) 그대로 받고, 우리 쪽 LLM으로 한글 번역만 별도로 붙인다.
 *
 * 실행: npx tsx --env-file=.env.local scripts/test-tavily-raw.ts
 */
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

// 실제 파이프라인(lib/backend/services/spec-lookup.ts)이 쓰는 것과 같은 쿼리 형태.
// 자유롭게 바꿔가며 실험해보면 됨.
const PRODUCT_NAME = "로보락 S9 MaxV Ultra";
const FIELD_KEY = "배터리 수명";
const QUERY = `${PRODUCT_NAME} ${FIELD_KEY}`;

async function translateToKorean(text: string): Promise<string> {
  const { text: translated } = await generateText({
    model: openai("gpt-4o-mini"),
    system: "Translate the given text into natural Korean. Output ONLY the translation, no extra commentary.",
    prompt: text,
    temperature: 0,
  });
  return translated.trim();
}

async function main() {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.error("TAVILY_API_KEY가 없습니다. .env.local을 확인하세요.");
    process.exit(1);
  }

  const body = {
    query: QUERY,
    search_depth: "basic",
    max_results: 5,
    include_answer: true,
    include_images: false,
  };

  console.log("=== Request ===");
  console.log(JSON.stringify(body, null, 2));

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    console.error(`Tavily 요청 실패: ${res.status} ${res.statusText}`);
    console.error(await res.text());
    process.exit(1);
  }

  const data = await res.json();
  console.log("\n=== Raw Tavily Response ===");
  console.log(JSON.stringify(data, null, 2));

  if (data.answer) {
    const koAnswer = await translateToKorean(data.answer);
    console.log("\n=== answer (한글 번역) ===");
    console.log(koAnswer);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
