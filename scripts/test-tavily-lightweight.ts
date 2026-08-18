/**
 * scripts/test-tavily-lightweight.ts
 * judgeCell(data_agent.ts)의 다단계 파이프라인(세그먼트 분할 → 임베딩 재랭킹 →
 * 인용 구절 기반 추출)을 대체할 수 있을지 실험하는 경량 파이프라인.
 *
 * 구조: Tavily 검색 1번(advanced, 더 긴 answer) → LLM 호출 1번(구조화 출력으로
 * 원본 answer + 추출값을 동시에 받음). 총 네트워크 호출 2번.
 *
 * 실행: npx tsx --env-file=.env.local scripts/test-tavily-lightweight.ts
 */
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

// 실제 파이프라인(lib/backend/services/spec-lookup.ts)이 쓰는 것과 같은 쿼리 형태.
const PRODUCT_NAME = "샤오미 미지아 5C";
const FIELD_KEY = "스마트 기능";
const QUERY = `${PRODUCT_NAME} ${FIELD_KEY}`;

const extractionSchema = z.object({
  originalAnswer: z.string().describe("The given answer text, copied verbatim, unmodified."),
  extractedValue: z
    .string()
    .describe(
      `The specific "${FIELD_KEY}" value for "${PRODUCT_NAME}" as stated in the answer. ` +
      `If the answer does not clearly state it, return "-".`
    ),
  koreanSummary: z.string().describe("A natural Korean translation of the answer."),
});

async function main() {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.error("TAVILY_API_KEY가 없습니다. .env.local을 확인하세요.");
    process.exit(1);
  }

  // ── STEP 1: Tavily 검색 (judgeCell이 쓰던 것과 동일한 쿼리 패턴) ──────────
  const body = {
    query: QUERY,
    search_depth: "advanced",
    max_results: 5,
    include_answer: "advanced", // 더 길고 상세한 answer
    include_images: false,
  };

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

  if (!data.answer) {
    console.log("answer 없음");
    return;
  }

  const { object } = await generateObject({
    model: openai("gpt-4o"),
    schema: extractionSchema,
    system: `You are given a short answer text about "${PRODUCT_NAME}". Answer the follow-up question using ONLY what's stated in that text — do not use outside knowledge.`,
    prompt: `Answer text:\n${data.answer}\n\nFollow-up question: What is the "${FIELD_KEY}" for "${PRODUCT_NAME}" mentioned in this text?`,
    temperature: 0,
  });

  console.log("answer:", data.answer);
  console.log("extractedValue:", object.extractedValue);
}

main().catch((err) => { console.error(err); process.exit(1); });
