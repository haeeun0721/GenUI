import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// CompTable 진단 로그 — 비교표 생성 시 DB 커버리지 및 웹 보강 내역 기록
// render-to-comp-table.ts에서 이동. 로깅은 독립 모듈 책임.
// ---------------------------------------------------------------------------

export interface WebResult {
  criterion: string;
  url: string;
  snippet: string;
}

export interface ProductLog {
  name: string;
  localSpecs: string[];
  coveredCriteria: string[];
  missingCriteria: string[];
  webResults: WebResult[];
}

export function writeCompTableLog(
  productLogs: ProductLog[],
  decisionCriteria: string[]
): void {
  // Vercel 등 서버리스 배포 환경은 /tmp 말고는 파일시스템이 읽기 전용이라 이 쓰기가 항상
  // 실패한다 — 매 요청마다 시도-실패를 반복하지 않도록 아예 건너뛴다. 로컬 개발 환경(진단용
  // 마크다운 로그가 실제로 쓸모 있는 유일한 곳)에서는 그대로 동작한다.
  if (process.env.VERCEL) {
    console.log("[CompTable Log] 서버리스 환경 — 파일 로그 생략");
    return;
  }
  try {
    const dataDir = join(process.cwd(), "data");
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const lines: string[] = [];

    lines.push(`# 📊 비교표 생성 로그`);
    lines.push(`\n> 생성 시각: ${now}`);
    lines.push(`\n---\n`);

    lines.push(`## ✅ Decision Criteria (${decisionCriteria.length}개)\n`);
    decisionCriteria.forEach((c) => lines.push(`- ${c}`));

    lines.push(`\n---\n`);
    lines.push(`## 📦 제품별 스펙 커버리지\n`);

    productLogs.forEach((p) => {
      lines.push(`### ${p.name}\n`);

      lines.push(`**Danawa DB 스펙 (${p.localSpecs.length}개)**\n`);
      if (p.localSpecs.length > 0) {
        p.localSpecs.forEach((s) => lines.push(`- \`${s}\``));
      } else {
        lines.push(`- *(스펙 없음)*`);
      }

      lines.push(`\n**기준별 커버리지**\n`);
      lines.push(`| 기준 | DB 스펙 커버 | 웹 보강 |`);
      lines.push(`|------|:-----------:|:------:|`);
      decisionCriteria.forEach((c) => {
        const dbCovered = p.coveredCriteria.includes(c);
        const webCovered = p.webResults.some((w) => w.criterion === c);
        lines.push(`| ${c} | ${dbCovered ? "✅" : "❌"} | ${webCovered ? "🔍" : "-"} |`);
      });

      if (p.webResults.length > 0) {
        lines.push(`\n**웹 검색 보강 내용**\n`);
        p.webResults.forEach((w) => {
          lines.push(`- **기준**: \`${w.criterion}\``);
          lines.push(`  - 🔗 출처: [${w.url}](${w.url})`);
          lines.push(`  - 📝 근거 문구: "${w.snippet.replace(/\n/g, ' ').slice(0, 200)}"`);
        });
      }

      lines.push("");
    });

    lines.push(`---\n`);
    lines.push(`## 📋 요약\n`);
    lines.push(`| 제품 | DB 커버 기준 | 미커버 기준 | 웹 보강 |`);
    lines.push(`|------|:-----------:|:-----------:|:------:|`);
    productLogs.forEach((p) => {
      lines.push(
        `| ${p.name.slice(0, 25)} | ${p.coveredCriteria.length}/${decisionCriteria.length} | ${p.missingCriteria.join(", ") || "없음"} | ${p.webResults.length > 0 ? `${p.webResults.length}개` : "-"} |`
      );
    });

    // 전체 출처 목록
    const allWebResults = productLogs.flatMap(p => p.webResults.map(w => ({ product: p.name, ...w })));
    if (allWebResults.length > 0) {
      lines.push(`\n---\n`);
      lines.push(`## 🔗 웹 검색 출처 전체 목록\n`);
      allWebResults.forEach((w) => {
        lines.push(`- **${w.product.slice(0, 20)}** / \`${w.criterion}\``);
        lines.push(`  - [${w.url}](${w.url})`);
        lines.push(`  - > ${w.snippet.replace(/\n/g, ' ').slice(0, 150)}`);
      });
    }

    writeFileSync(join(dataDir, "comp-table-log.md"), lines.join("\n"), "utf8");
    console.log(`\n[CompTable Log] 📄 MD 로그 저장: data/comp-table-log.md`);
  } catch (e) {
    console.warn("[CompTable Log] MD 저장 실패:", e);
  }
}
