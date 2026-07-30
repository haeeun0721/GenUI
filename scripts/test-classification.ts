/**
 * Conversation Agent 분류 테스트
 * 실행: npx tsx scripts/test-classification.ts
 * 출력: scripts/classification-results.md
 */

import { generateText, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// 테스트할 질문 목록 (예상 카테고리 포함)
// ---------------------------------------------------------------------------

const TEST_CASES: { question: string; expected: string; note?: string }[] = [
  // 1a — Decision Criteria (답이 결정 기준 칩이 될 수 있는 질문)
  { question: "유모차 종류가 뭐 있어?", expected: "1a" },
  { question: "유모차 고를 때 뭘 봐야 해?", expected: "1a" },
  { question: "무게 기준으로 뭘 고려해야 해?", expected: "1a" },
  { question: "어떤 브랜드 유모차를 고려해볼 수 있어?", expected: "1a" },
  { question: "접이 방식 종류는 뭐가 있어?", expected: "1a" },
  { question: "가격대는 어떻게 나뉘어?", expected: "1a" },
  { question: "바퀴 종류는 어떤 게 있어?", expected: "1a" },

  // 1b — Background Info (개념/스펙 이해 질문)
  { question: "서스펜션이 뭐야?", expected: "1b" },
  { question: "ISO-FIX가 뭐야?", expected: "1b" },
  { question: "퍼스트 에어 바퀴가 뭔지 설명해줘", expected: "1b" },
  { question: "유모차 보통 무게가 얼마야?", expected: "1b" },
  { question: "KC 인증이 뭐야?", expected: "1b" },
  { question: "리클라이닝이 뭐야?", expected: "1b" },

  // 경계 케이스 (어느 쪽으로 분류되는지 확인)
  { question: "한손폴딩이 뭐야?", expected: "1b", note: "경계: 개념 설명이지만 결정 기준이 될 수도 있음" },
  { question: "무게가 중요한 이유가 뭐야?", expected: "1b", note: "경계: 배경 정보 vs 기준 형성" },
  { question: "유모차에서 서스펜션이 왜 중요해?", expected: "1a", note: "경계: 중요도 판단 → 1a?" },

  // 2 — Comparative Evaluation
  { question: "맥시코시 타이탄이랑 조이 라이더 비교해줘", expected: "2" },
  { question: "사이벡스 리베랑 부가부 비 비교해줘", expected: "2" },

  // 3 — Product Recommendation
  { question: "5kg 이하 접이식 유모차 추천해줘", expected: "3" },
  { question: "신생아부터 쓸 수 있는 유모차 뭐 있어?", expected: "3" },
  { question: "30만원대 유모차 추천해줘", expected: "3" },
];

// ---------------------------------------------------------------------------
// Conversation Agent 시스템 프롬프트 (테스트용 — tool 이름 기반 분기)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `
You are a decision-support expert agent helping first-time 유모차 buyers.
Your task is to classify the user's query and call the appropriate tool.
All text replies MUST be written in Korean.

## INTENT CLASSIFICATION

| Category | Label              | Trigger condition |
|----------|--------------------|-------------------|
| 1a       | Decision Criteria  | The answer helps the user form a DECISION CRITERION. Key test: can the answer become chips on a criteria map? Examples: "어떤 종류가 있어?", "무게 기준으로 뭘 봐야 해?" |
| 1b       | Background Info    | The user wants to UNDERSTAND a concept or spec. Key test: the answer is factual background knowledge. Examples: "서스펜션이 뭐야?", "ISO-FIX가 뭐야?" |
| 2        | Comparative Eval   | User wants to compare two or more specific named products. |
| 3        | Recommendation     | User wants specific product suggestions. |

## OUTPUT

Category 1a → Write a Korean reply, then call renderCriteriaMap.
Category 1b → Write a Korean reply, then call renderConceptCard.
Category 2  → Call renderCompTable.
Category 3  → Call renderOptionList.

After calling any tool, stop. Do not generate additional text.
`.trim();

// ---------------------------------------------------------------------------
// Mock tools (tool 이름으로만 카테고리 판단)
// ---------------------------------------------------------------------------

function makeMockTools() {
  const simpleSchema = z.object({
    agent_reply: z.string().describe("Your full Korean text reply"),
    intent_summary: z.string().describe("Brief English summary of intent"),
  });

  return {
    renderCriteriaMap: tool({
      description: "Call this for Category 1a — Decision Criteria questions. The answer helps the user decide what to look for.",
      inputSchema: simpleSchema,
      execute: async () => ({ category: "1a" }),
    }),
    renderConceptCard: tool({
      description: "Call this for Category 1b — Background Info questions. The answer explains a concept or spec.",
      inputSchema: simpleSchema,
      execute: async () => ({ category: "1b" }),
    }),
    renderCompTable: tool({
      description: "Call this for Category 2 — Comparative Evaluation of specific named products.",
      inputSchema: z.object({ intent_summary: z.string() }),
      execute: async () => ({ category: "2" }),
    }),
    renderOptionList: tool({
      description: "Call this for Category 3 — Product Recommendation.",
      inputSchema: z.object({ search_query: z.string(), intent_summary: z.string() }),
      execute: async () => ({ category: "3" }),
    }),
  };
}

// ---------------------------------------------------------------------------
// 단일 질문 분류 실행
// ---------------------------------------------------------------------------

async function classifyQuestion(question: string): Promise<{ category: string; tool: string }> {
  try {
    const result = await generateText({
      model: anthropic("claude-sonnet-4-6"),
      system: SYSTEM_PROMPT,
      prompt: question,
      tools: makeMockTools(),
      maxSteps: 3,
    });

    // step.toolCalls에서 어떤 tool이 호출됐는지만 확인
    for (const step of result.steps ?? []) {
      for (const tc of step.toolCalls ?? []) {
        const cat = {
          renderCriteriaMap: "1a",
          renderConceptCard: "1b",
          renderCompTable: "2",
          renderOptionList: "3",
        }[tc.toolName];
        if (cat) return { category: cat, tool: tc.toolName };
      }
    }

    return { category: "no-tool-called", tool: "none" };
  } catch (err: any) {
    console.error(`  [ERROR] ${err?.message ?? err}`);
    return { category: "error", tool: String(err?.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// 전체 테스트 실행 + MD 출력
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n🧪 Conversation Agent 분류 테스트 시작 (${TEST_CASES.length}개 질문)\n`);

  const results: Array<{
    question: string;
    expected: string;
    actual: string;
    tool: string;
    pass: boolean;
    note?: string;
  }> = [];

  for (const tc of TEST_CASES) {
    process.stdout.write(`  테스트: "${tc.question.slice(0, 40)}"... `);
    const { category, tool: calledTool } = await classifyQuestion(tc.question);
    const pass = category === tc.expected;
    results.push({ ...tc, actual: category, tool: calledTool, pass });
    console.log(pass ? `✅ ${category}` : `❌ expected=${tc.expected} actual=${category}`);
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const score = `${passed}/${total} (${Math.round((passed / total) * 100)}%)`;

  // MD 생성
  const md = `# Conversation Agent 분류 테스트 결과

**실행일시**: ${new Date().toLocaleString("ko-KR")}
**정확도**: ${score}

## 결과 요약

| 질문 | 예상 | 실제 | 결과 | 비고 |
|------|------|------|------|------|
${results
  .map(
    (r) =>
      `| ${r.question} | ${r.expected} | ${r.actual} | ${r.pass ? "✅" : "❌"} | ${r.note ?? ""} |`
  )
  .join("\n")}

## 카테고리별 정확도

| 카테고리 | 정답 수 / 전체 |
|----------|--------------|
${["1a", "1b", "2", "3"].map((cat) => {
  const group = results.filter((r) => r.expected === cat);
  const correct = group.filter((r) => r.pass).length;
  return `| ${cat} | ${correct}/${group.length} |`;
}).join("\n")}

## 오분류된 질문

${results
  .filter((r) => !r.pass)
  .map((r) => `- **"${r.question}"** — 예상: \`${r.expected}\`, 실제: \`${r.actual}\`${r.note ? ` (${r.note})` : ""}`)
  .join("\n") || "없음 — 모든 질문이 올바르게 분류됨 🎉"}
`;

  const outPath = path.join(process.cwd(), "scripts", "classification-results.md");
  fs.writeFileSync(outPath, md, "utf-8");
  console.log(`\n📄 결과 저장: ${outPath}`);
  console.log(`🏆 최종 정확도: ${score}\n`);
}

main().catch(console.error);
