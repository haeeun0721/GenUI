/**
 * scripts/test-search-grounding.ts
 * lookupProductSpec (로컬DB→Tavily 1회+judgeCell 검증+SiblingGuard)이
 * "제품을 안 헷갈리는지"를 검증하는 진단 스크립트. 여러 번 반복 실행해서
 * (Tavily 검색 결과 자체의 변동성 때문에) 결과가 안정적인지도 같이 본다.
 *
 * 방식: 이름이 거의 똑같은 제품 쌍(예: "로보락 S10 MaxV Slim" vs "...Slim 직배수")을 골라서,
 * 한쪽 제품에만 있고 다른 쪽엔 없는 기준(criterion)을 실제 다나와 페이지에서 미리 확인해둔 뒤,
 * lookupProductSpec을 그대로 돌려서 "있어야 할 곳엔 있고, 없어야 할 곳엔 없는지"를 본다.
 * 만약 없어야 할 곳에서 "있음"이 나오면, 그건 옆 제품의 정보를 잘못 끌어온 교차오염 신호다.
 *
 * mutate-comptable.ts / update-table/route.ts / mutate-surface.ts / auto-enrich / fetch-spec이
 * 전부 이 함수 하나로 통합됐으므로, 여기서 검증하면 그 다섯 곳 전부를 검증하는 셈이다.
 *
 * 실행: npx tsx --env-file=.env.local scripts/test-search-grounding.ts [반복횟수=4]
 */

import { lookupProductSpec } from "../lib/backend/services/spec-lookup";

interface TestCase {
  product: string;
  criterion: string;
  expected: "present" | "absent"; // 로컬 DB 기준 정답
  groundTruthNote: string; // DB에서 실제로 확인한 근거
}

// 아래 ground truth는 로컬 DB 캐시가 아니라, 실제 다나와 상품 페이지의
// meta description(요약 스펙)을 직접 열어 확인한 것이다 — 로컬 DB 캐시가
// 크롤링 시점 이후로 어긋나 있을 수 있다는 걸 확인했기 때문.
const TEST_CASES: TestCase[] = [
  {
    product: "로보락 S10 MaxV Slim",
    criterion: "직배수",
    expected: "absent",
    groundTruthNote: '다나와 pcode=122638233 meta description에 "직배수" 언급 없음 (직배수는 형제 SKU pcode=122638245 전용) — 여기서 "있음"이 나오면 형제 SKU 오염',
  },
  {
    product: "로보락 S10 MaxV Slim 직배수",
    criterion: "직배수",
    expected: "present",
    groundTruthNote: '다나와 pcode=122638245 meta description: "... / 직배수 / 스테이션청소 / ..."',
  },
  {
    product: "로보락 S10 MaxV Slim",
    criterion: "자동급수",
    expected: "present",
    groundTruthNote: '다나와 pcode=122638233 meta description: "... / 자동급수 / 자동충전"',
  },
  {
    product: "LG전자 코드제로 R9 R965IB",
    criterion: "먼지비움",
    expected: "present",
    groundTruthNote: '다나와 pcode=18543452 meta description: "... 먼지봉투살균 / 먼지비움 / ..."',
  },
  {
    product: "LG전자 오브제컬렉션 코드제로 R9 RO971GA",
    criterion: "먼지비움",
    expected: "absent",
    groundTruthNote: '다나와 pcode=14531099 meta description에 먼지비움 언급 없음(흡입전용, 물걸레:없음) — 여기서 "있음"이 나오면 R965IB 오염 (실제로 재현된 버그)',
  },
  {
    product: "LG전자 오브제컬렉션 코드제로 R9 RO971GA",
    criterion: "먼지통",
    expected: "absent",
    groundTruthNote: '다나와 pcode=14531099 meta description에 먼지통 용량 언급 없음 — 여기서 수치가 나오면 R965IB(먼지통 0.6L) 오염',
  },
];

function judgeOutcome(tc: TestCase, value: string, uncertain?: boolean): string {
  if (value === "-" || uncertain) return tc.expected === "absent" ? "PASS(안전기권)" : "미확인(커버리지부족)";
  const isPresent = value === "○" || (value !== "X" && value.length > 0);
  const isAbsent = value === "X";
  if (tc.expected === "present" && isPresent) return "PASS";
  if (tc.expected === "absent" && isAbsent) return "PASS";
  return "FAIL(교차오염 의심)";
}

interface RunResult { tc: TestCase; value: string; source: string; sourceUrl?: string; outcome: string }

async function runOnce(runIdx: number, totalRuns: number): Promise<RunResult[]> {
  console.log(`\n\n\x1b[1m########## RUN ${runIdx}/${totalRuns} ##########\x1b[0m`);
  const results: RunResult[] = [];

  for (const tc of TEST_CASES) {
    console.log(`\n\x1b[36m[TEST] "${tc.product}" × "${tc.criterion}"\x1b[0m (기대값: ${tc.expected})`);
    const lookup = await lookupProductSpec(tc.product, tc.criterion, "로봇 청소기");
    const outcome = judgeOutcome(tc, lookup.value, lookup.uncertain);
    const color = outcome.startsWith("PASS") ? "\x1b[32m" : outcome.startsWith("FAIL") ? "\x1b[31m" : "\x1b[33m";
    console.log(`  ${color}→ "${lookup.value}" (source=${lookup.source}${lookup.uncertain ? ", 불확실" : ""}) | ${outcome}\x1b[0m`);

    results.push({ tc, value: lookup.value, source: lookup.source, sourceUrl: lookup.sourceUrl, outcome });
  }

  const pass = results.filter((r) => r.outcome.startsWith("PASS")).length;
  const fail = results.filter((r) => r.outcome.startsWith("FAIL")).length;
  const unc = results.filter((r) => r.outcome.startsWith("미확인")).length;
  console.log(`\n  이번 회차: PASS ${pass} / FAIL ${fail} / 미확인 ${unc}`);
  return results;
}

async function main() {
  const repeats = parseInt(process.argv[2] ?? "4", 10);
  console.log(`총 ${TEST_CASES.length}개 케이스 × ${repeats}회 반복 (실제 운영 경로: lookupProductSpec)`);

  const allRuns: RunResult[][] = [];
  for (let i = 1; i <= repeats; i++) {
    allRuns.push(await runOnce(i, repeats));
  }

  console.log(`\n\n\x1b[1m========== ${repeats}회 반복 집계 (케이스별) ==========\x1b[0m`);
  TEST_CASES.forEach((tc, idx) => {
    const outcomes = allRuns.map((run) => run[idx].outcome);
    const passN = outcomes.filter((o) => o.startsWith("PASS")).length;
    const failN = outcomes.filter((o) => o.startsWith("FAIL")).length;
    const uncN = outcomes.filter((o) => o.startsWith("미확인")).length;
    const flag = failN > 0 ? "\x1b[31m" : uncN > 0 ? "\x1b[33m" : "\x1b[32m";
    console.log(`${flag}"${tc.product}" × "${tc.criterion}"\x1b[0m → PASS ${passN}/${repeats}, FAIL ${failN}/${repeats}, 미확인 ${uncN}/${repeats}  [${outcomes.join(" | ")}]`);
  });

  const flat = allRuns.flat();
  const totalPass = flat.filter((r) => r.outcome.startsWith("PASS")).length;
  const totalFail = flat.filter((r) => r.outcome.startsWith("FAIL")).length;
  const totalUnc = flat.filter((r) => r.outcome.startsWith("미확인")).length;
  const total = flat.length;
  console.log(`\n\x1b[1m========== 전체 (${total}회 시행) ==========\x1b[0m`);
  console.log(`PASS: ${totalPass}/${total} (${((totalPass / total) * 100).toFixed(0)}%)`);
  console.log(`FAIL(교차오염 의심): ${totalFail}/${total} (${((totalFail / total) * 100).toFixed(0)}%)`);
  console.log(`미확인(커버리지부족): ${totalUnc}/${total} (${((totalUnc / total) * 100).toFixed(0)}%)`);
}

main().catch((err) => {
  console.error("스크립트 실행 오류:", err);
  process.exit(1);
});
