/**
 * scripts/test-rank-threshold.ts
 * 사용자가 스크린샷으로 보여준 실제 케이스 재현:
 * 흡입력 "2,500pa 이상"을 Decision Criteria로 걸어놨는데, 18,500Pa(로보락 Qrevo Curv)가
 * 기준 미달로 잘못 평가되던 문제 + user_context가 이유 설명에 안 섞이던 문제를 검증한다.
 *
 * 실행: npx tsx --env-file=.env.local scripts/test-rank-threshold.ts
 */
import { computeRankingAndReasoning } from "../lib/backend/agents/generators/comp_table";
import { setCurrentUserContext, setCurrentLocale } from "../lib/backend/tools/sidebar-store";
import type { CompTableJson } from "../lib/backend/agents/data_agent";

setCurrentLocale("ko");
setCurrentUserContext("반려동물(강아지)이 있어서 털/먼지 흡입력이 중요하고, 매일 자동으로 돌아갔으면 좋겠어요.");

const tableJson: CompTableJson = {
  type: "Table",
  props: {
    columns: [
      { key: "criterion", label: "비교 항목" },
      { key: "prod_1", label: "로보락 S9 MaxV Ultra" },
      { key: "prod_2", label: "DJI ROMO S" },
      { key: "prod_3", label: "로보락 Qrevo Curv" },
    ],
    rows: [
      { criterion: "흡입력", prod_1: "22,000Pa", prod_2: "25,000Pa", prod_3: "18,500Pa" },
      { criterion: "배터리 수명", prod_1: "6,400mAh", prod_2: "약 2시간", prod_3: "6,400mAh" },
      { criterion: "소음 수준", prod_1: "52dB", prod_2: "46.7dB", prod_3: "55dB" },
      { criterion: "순위", prod_1: "-", prod_2: "-", prod_3: "-" },
    ],
  },
};

const decisionCriteria = ["흡입력 (기준: 2,500pa 이상)", "배터리 수명", "소음 수준"];

async function main() {
  const { reasoning } = await computeRankingAndReasoning(tableJson, decisionCriteria, "ko");
  const rankRow = (tableJson.props!.rows as any[]).find(r => r.criterion === "순위");
  console.log("\n=== 순위 ===");
  console.log(rankRow);
  console.log("\n=== 이유 ===");
  console.log(reasoning);
}

main().catch((err) => { console.error(err); process.exit(1); });
