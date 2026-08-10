/**
 * scripts/test-origin-criterion.ts
 * 사용자가 보고한 케이스 재현: "원산지" 기준을 물어봤더니 "원산지 지원"이라는
 * 이상한 값이 나오던 문제. detectCriterionType이 "원산지"를 boolean으로 잘못
 * 분류하던 것 + Echo Guard가 "기준명+지원" 패턴을 못 걸러내던 것, 두 가지를 고쳤다.
 *
 * 실행: npx tsx --env-file=.env.local scripts/test-origin-criterion.ts
 */
import { lookupProductSpec } from "../lib/backend/services/spec-lookup";
import { detectCriterionType } from "../lib/backend/agents/data_agent";

async function main() {
  console.log("detectCriterionType('원산지') =", detectCriterionType("원산지"));

  const cases: [string, string, string][] = [
    ["로보락 S9 MaxV Ultra", "원산지", "로봇 청소기"],
    ["SONY 알파 A7 V", "원산지", "카메라"],
  ];

  for (const [product, criterion, category] of cases) {
    console.log(`\n[TEST] "${product}" × "${criterion}"`);
    const result = await lookupProductSpec(product, criterion, category);
    console.log(`  → value="${result.value}" source=${result.source} uncertain=${result.uncertain ?? false}`);
    if (result.usedSnippet) console.log(`  💬 근거: "${result.usedSnippet.slice(0, 100)}"`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
