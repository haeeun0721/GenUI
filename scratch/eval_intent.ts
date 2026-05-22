import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import * as fs from "fs";
import * as path from "path";

// 1. Manually load .env.local
const envPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    const lines = envContent.split("\n");
    lines.forEach(line => {
        const [key, val] = line.split("=").map(s => s.trim());
        if (key && val) {
            // Remove quotes if present
            process.env[key] = val.replace(/^['"]|['"]$/g, '');
        }
    });
}

// 2. Load Agent Instructions
const agentFileContent = fs.readFileSync(path.join(process.cwd(), "lib/agents/conversation_agent.ts"), "utf-8");
const instructionMatch = agentFileContent.match(/const AGENT_INSTRUCTIONS = `([\s\S]+?)`;/);
const AGENT_INSTRUCTIONS = instructionMatch ? instructionMatch[1] : "";

const testQueries = [
    "영상 편집용 노트북 고를 때 중요하게 봐야 할 사양이 뭐야?",
    "요즘 대학생들이 가장 많이 쓰는 가성비 노트북 브랜드 추천해줘.",
    "보통 게이밍 노트북 살 때 가격대는 어느 정도로 잡는 게 좋아?",
    "디자인 작업용 노트북은 일반 사무용이랑 어떤 점이 달라?",
    "애플 맥북 시리즈 종류가 많은데, 각각 어떤 용도로 나와 있어?",
    "노트북 패널 종류 중에 IPS랑 OLED가 뭐가 더 좋은 거야?",
    "가벼운 노트북 브랜드는 보통 어떤 게 유명해?",
    "노트북 살 때 AS가 잘 되는 브랜드가 어디야?",
    "노트북 살 때 인텔이랑 AMD 중에 요새 뭐가 대세야?",
    "맥북 살 때 에어랑 프로 중에 고민되는데 차이점이 뭐야?",
    "맥북 에어 M3랑 갤럭시북4 프로 중에 뭐가 더 가벼워?",
    "LG 그램 16인치랑 삼성 갤럭시북 16인치 성능 차이 좀 알려줘.",
    "델 XPS 13이랑 HP 스펙터 x360 중에 어떤 게 더 오래 쓸 수 있어?",
    "RTX 4060이랑 4070 성능 차이가 체감이 클까?",
    "M2 칩이랑 M3 칩 중에서 가성비로 따지면 뭐가 나아?",
    "삼성 갤럭시북4 울트라랑 레이저 블레이드 16 비교해줘.",
    "ASUS 젠북이랑 레노버 요가 시리즈 중에 디자인 작업하기에 뭐가 더 좋아?",
    "서피스 랩탑이랑 서피스 프로 중에 휴대성은 뭐가 압승이야?",
    "에이서 스위프트랑 에이수스 비보북 중에 가성비 모델 비교해줘.",
    "M3 맥북 프로 14인치랑 16인치 중에 배터리 누가 더 오래가?",
    "150만 원 이하로 살 수 있는 제일 좋은 코딩용 노트북 추천해줘.",
    "초등학생 자녀가 인강 듣고 숙제하기에 적당한 모델 있을까?",
    "무게 1.2kg 미만이면서 성능도 괜찮은 노트북 알려줘.",
    "현재 쿠팡에서 제일 잘 팔리는 게이밍 노트북 모델 뭐야?",
    "배터리 수명이 15시간 이상 가는 노트북들 리스트업 해줘.",
    "맥북 사고 싶은데 학생 할인받으면 얼마까지 가능해?",
    "고사양 게임이랑 영상 편집 둘 다 할 수 있는 노트북 추천 부탁해.",
    "PD 충전되는 가벼운 노트북 중에 추천할 만한 거 있어?",
    "윈도우 설치된 노트북 중에 100만원대로 추천해줘.",
    "개발자용 리눅스 잘 돌아가는 노트북 추천 좀.",
    "RAM 16GB면 프리미어 프로 돌리기에 충분해?",
    "밝기가 300니트라는데 이거 야외에서 쓰기엔 너무 어둡나?",
    "NTSC 72%랑 sRGB 100%가 같은 말이야?",
    "내장 그래픽으로 롤 최고 사양 가능해?",
    "노트북 무게 1.5kg이면 매일 들고 다니기에 무거울까?",
    "PD 충전 지원한다는 게 정확히 무슨 뜻이야?",
    "저장공간 256GB면 대학교 4학년 내내 쓰기에 부족할까?",
    "CPU 이름 뒤에 H랑 U가 붙는데 이게 성능 차이가 많이 나?",
    "썬더볼트 4 포트가 있으면 뭐가 좋은 거야?",
    "해상도 QHD랑 FHD 차이가 눈으로 확 느껴져?"
];

async function runEval() {
    console.log("Starting Benchmark...");
    let report = "# Intent Inference Benchmark (40 Queries)\n\n";
    report += "| # | Query | Intent Summary | Data | UI | Cat | Reason |\n";
    report += "|---|-------|----------------|------|----|-----|--------|\n";

    for (let i = 0; i < testQueries.length; i++) {
        const query = testQueries[i];
        console.log(`Processing [${i+1}/40]: ${query}`);
        try {
            const { text } = await generateText({
                model: openai("gpt-4o"),
                system: AGENT_INSTRUCTIONS,
                prompt: `<Current Query>:\n${query}\n\nBased on the <Current Query> above, infer the user's intent and output the [Conversation Agent Decision] block first, then respond.`,
                temperature: 0,
            });

            const decisionBlock = text.match(/\[Conversation Agent Decision\]([\s\S]+?)(?=\n\n|$)/);
            if (decisionBlock) {
                const lines = decisionBlock[1].trim().split("\n");
                const result: any = {};
                lines.forEach(line => {
                    const parts = line.split(":");
                    const key = parts[0]?.trim();
                    const val = parts.slice(1).join(":").trim();
                    if (key) result[key] = val;
                });

                report += `| ${i+1} | ${query} | ${result.intent_summary || "-"} | ${result.needs_data || "-"} | ${result.needs_ui || "-"} | ${result.ui_intent_category || "-"} | ${result.ui_intent_reason || "-"} |\n`;
            } else {
                report += `| ${i+1} | ${query} | ERROR: Block missing | - | - | - | - |\n`;
            }
        } catch (err) {
            report += `| ${i+1} | ${query} | ERROR: ${err instanceof Error ? err.message : String(err)} | - | - | - | - |\n`;
        }
    }

    fs.writeFileSync(path.join(process.cwd(), "scratch/eval_results_final.md"), report, "utf-8");
    console.log("Benchmark Done! Saved to scratch/eval_results_final.md");
}

runEval();
