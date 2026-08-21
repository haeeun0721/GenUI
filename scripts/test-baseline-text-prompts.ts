/**
 * scripts/test-baseline-text-prompts.ts
 * Phase 1 검증: baseline의 텍스트 전용 판단 로직(CriteriaMap/InformationCard/
 * ProductCardList/ComparisonTable) 4종을 대표 쿼리로 직접 호출해, JSON 없이 자연스러운
 * 문장이 나오는지 + user_context가 실제로 반영되는지 확인한다.
 *
 * 실행: npx tsx --env-file=.env.local scripts/test-baseline-text-prompts.ts
 */
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { buildCriteriaMapSystemText, buildCriteriaMapPromptText } from "../lib/backend/agents/generators/criteria_map";
import { buildInformationCardSystemText, buildInformationCardPromptText } from "../lib/backend/agents/generators/information_card";
import { buildProductCardListSystemText, buildProductCardListPromptText } from "../lib/backend/agents/generators/product_card_list";
import { buildComparisonTableSystemText, buildComparisonTablePromptText } from "../lib/backend/agents/generators/comp_table_lite";
import { buildCommonSystemInstructionsText } from "../lib/backend/agents/generators/shared";
import type { ProductData } from "../lib/backend/agents/data_agent";

const MODEL = anthropic("claude-haiku-4-5");

async function run(label: string, system: string, prompt: string) {
  console.log(`\n${"=".repeat(70)}\nTEST: ${label}\n${"=".repeat(70)}`);
  const t0 = Date.now();
  const { text } = await generateText({ model: MODEL, system, prompt, temperature: 0.3 });
  console.log(`(${Date.now() - t0}ms)\n`);
  console.log(text.trim());
  const hasJson = /```json|"type"\s*:\s*"/i.test(text);
  console.log(hasJson ? "\n⚠️  JSON 흔적 발견됨" : "\n✅ JSON 없음 (순수 텍스트)");
}

async function test1_criteriaMap() {
  await run(
    "CriteriaMap text (user_context 반영 확인)",
    buildCriteriaMapSystemText("ko"),
    buildCriteriaMapPromptText(
      "로봇청소기 살 때 뭘 봐야 해?",
      "반려동물(강아지)을 키우고 있고 카펫이 깔린 집이라 털 청소가 제일 걱정돼요.",
      ""
    )
  );
}

async function test2_informationCard() {
  await run(
    "InformationCard text",
    buildInformationCardSystemText("ko"),
    buildInformationCardPromptText("흡입력 단위 Pa가 뭔지 알려줘")
  );
}

async function test3_productCardList() {
  const uiContext = [
    "- 로보락 Qrevo Curv (899,000원)\n  Specs: 흡입력 18500Pa, 배터리 180분, 자동 먼지비움 지원, 라이다 네비게이션",
    "- 삼성 비스포크 제트봇 AI (690,000원)\n  Specs: 흡입력 280W, 배터리 90분, AI 장애물 회피",
  ].join("\n");
  await run(
    "ProductCardList text",
    [buildCommonSystemInstructionsText("로봇청소기", "ko"), buildProductCardListSystemText("ko")].join("\n\n"),
    buildProductCardListPromptText(uiContext)
  );
}

async function test4_comparisonTable() {
  const products: ProductData[] = [
    {
      id: "1", name: "로보락 Qrevo Curv", price: "899,000원", image: "", link: "", brand: "로보락", mallName: "",
      description: "",
      specs: ["흡입력 18500Pa", "배터리 180분", "자동 먼지비움 지원", "소음 67dB"],
    },
    {
      id: "2", name: "삼성 비스포크 제트봇 AI", price: "690,000원", image: "", link: "", brand: "삼성", mallName: "",
      description: "",
      specs: ["흡입력 280W", "배터리 90분", "AI 장애물 회피", "소음 62dB"],
    },
  ];
  await run(
    "ComparisonTable text (user_context 반영 확인)",
    [buildCommonSystemInstructionsText("로봇청소기", "ko"), buildComparisonTableSystemText("ko")].join("\n\n"),
    buildComparisonTablePromptText(
      products,
      "반려동물(강아지)이 있어서 털/먼지 흡입력이 중요하고, 매일 자동으로 돌아갔으면 좋겠어요.",
      ["흡입력", "배터리 지속시간"]
    )
  );
}

async function main() {
  await test1_criteriaMap();
  await test2_informationCard();
  await test3_productCardList();
  await test4_comparisonTable();
  console.log(`\n${"=".repeat(70)}\nDONE\n${"=".repeat(70)}`);
}

main();
