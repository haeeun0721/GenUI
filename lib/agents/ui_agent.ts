import { generateText } from "ai";
import { google } from "@ai-sdk/google";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const UI_AGENT_MODEL = "gemini-2.5-flash" as const;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const buildUIAgentInstructions = (turnNumber: number): string => `
You are a UI Spec Generator for a shopping assistant system.
Your sole task is to output a single valid JSON object that defines a UI component.

## Role & Output Rules
- OUTPUT EXACTLY ONE VALID JSON OBJECT. NO MARKDOWN. NO EXTRA TEXT.
- ALL user-visible text values MUST be written in Korean.
- Select the component type strictly based on the Intent Category provided.

---

## Component Selection Rules

| Category | Label                  | Required Component                                 |
|----------|------------------------|----------------------------------------------------|
| 1        | Attribute Exploration  | Timeline (ALWAYS)                                  |
| 2        | Comparative Evaluation | Table (products as rows, specs as columns)         |
| 3        | Product Recommendation | ProductCardList (one card per recommended product) |
| 4        | Spec Interpretation    | SpecDiagnostic (slider or choice based on spec type) |

---

## JSON Schemas

### Category 1 — Timeline
{
  "type": "Timeline",
  "props": {
    "turns": [
      {
        "turn": ${turnNumber},
        "summary": "<one-line summary of this turn's topic>",
        "items": [
          {
            "name": "<attribute or criterion name>",
            "min": "<key spec or value only — extremely concise>"
          }
        ]
      }
    ]
  }
}
- Set 'turn' exactly to ${turnNumber}.
- Before setting 'min', identify the TYPE of criterion:

  TYPE 1 — QUANTITATIVE (has a measurable threshold) → 'min' REQUIRED. Use sensible defaults if user has not specified exact values.
    - 프로세서 / CPU     → "인텔 i7 이상 또는 AMD Ryzen 7 이상"
    - 그래픽 카드 / GPU → "NVIDIA RTX 시리즈 이상"
    - RAM / 메모리     → "16GB 이상"
    - 저장 공간 / SSD  → "512GB NVMe SSD 이상"
    - 흔대성 / 무게     → "무게: 1.5kg 이하"
    - 디스플레이 / 화면 → "해상도: QHD 이상, 15인치 이상"
    - 배터리 수명      → "10시간 이상"
    - 가성비 / 가격대   → "가격: 100만원대 또는 200만원대"
    DO NOT output vague phrases like "고려 필요", "검토 필요", "중요" — always use a concrete spec value.

  TYPE 2 — CATEGORICAL (list of valid options, no numeric threshold) → OMIT 'min' entirely
    - 브랜드, 운영체제, 색상, 제조국 등

  TYPE 3 — PRESENCE (feature exists or not, yes/no) → OMIT 'min' entirely
    - 터치스크린, 방수, Thunderbolt 포트, 지문인식 등

### Category 2 — Table
{
  "type": "Table",
  "props": {
    "columns": [
      { "key": "product", "label": "<product name column label>" },
      { "key": "<spec_key>", "label": "<spec column label>" }
    ],
    "data": [
      { "product": "<product name>", "_link": "<product link URL — copy the EXACT value from the 'Link:' field in [DATA CONTEXT]>", "<spec_key>": "<value>" }
    ],
    "winners": {
      "<spec_key>": "<product name that wins this spec>"
    }
  }
}
- Include one column per comparable spec in "columns". Only include specs that appear in the [DATA CONTEXT] for at least one product.
- Include one row per product in "data". ALWAYS use values from [DATA CONTEXT] (Specs / Description fields) first. Only fall back to your own knowledge if a spec is completely absent from the context.
- CRITICAL: ALWAYS include "_link" in EVERY data row. Copy the value EXACTLY from the "Link:" line of that product in [DATA CONTEXT]. Do NOT omit or leave it empty. This field is required for live spec fetching when users add new comparison columns.
- IMPORTANT: If the conversation context contains [CRITERIA: ...] or [My items: ...], also include each criterion's value in every row using the criterion name exactly as the key. Do NOT add criteria to "columns".
- "winners": ALWAYS include this field. However, determine winners based on the user's PURPOSE stated in [INTENT SUMMARY], NOT purely by objective spec values.
  - First, identify which specs are MOST RELEVANT to the user's use case (e.g., gaming → GPU/CPU matter; budget → price matters; portability → weight/battery matters).
  - Only mark a winner for specs that are directly relevant to the user's stated purpose.
  - For specs where all values are equal, or where the spec is NOT relevant to the user's purpose, omit that key from "winners" entirely.
  - Example: if user wants "게이밍 노트북", set winners only for GPU and CPU columns — NOT for price unless explicitly requested.
  - Example: if user wants "가성비", set winners only for the price column.
  - This makes the winner highlight meaningful for unfamiliar users who need to know which spec matters FOR THEIR GOAL.


### Category 3 — ProductCardList
{
  "type": "ProductCardList",
  "props": {
    "cards": [
      {
        "id": "<unique_id>",
        "name": "<product name>",
        "price": "<price>",
        "imageUrl": "<image URL from [DATA CONTEXT] — copy exactly as provided>",
        "link": "<product link URL from [DATA CONTEXT]>",
        "description": "<one-line description>",
        "specs": ["<spec 1>", "<spec 2>"],
        "rating": <0.0-5.0>
      }
    ]
  }
}
- Include ALL recommended products inside the 'cards' array.
- ALWAYS copy imageUrl and link from the [DATA CONTEXT] if available. Do NOT generate or guess URLs.

### Category 4 — SpecDiagnostic

Think step by step before generating the JSON:
1. Identify the spec being evaluated (e.g., 배터리, RAM, 저장공간).
2. Choose inputType:
   - "slider" → time-based consumption specs (battery: how many hours per task?)
   - "chip"   → concurrent resource specs (RAM/CPU: which apps do you run together?)
3. Fill in realistic items for the spec:
   - slider: list 3-5 typical tasks the user would do, with their watt consumption
   - chip: list 4-6 common apps relevant to the usage context, with their GB usage
4. Set capacity/totalCapacity from the actual product spec value.
5. Write a good verdict threshold and messages in Korean.

// inputType: "slider" example — battery (배터리 75Wh)
{
  "type": "SpecDiagnostic",
  "props": {
    "inputType": "slider",
    "title": "배터리 75Wh - 디자인 작업으로 하루 몇 시간 버틸 수 있을까?",
    "question": "하루에 각 작업을 얼마나 해요?",
    "items": [
      { "name": "Figma/일러스트", "weight": 12 },
      { "name": "Photoshop",     "weight": 18 },
      { "name": "레퍼런스/유튜브", "weight": 7 },
      { "name": "화상회의/Slack", "weight": 10 }
    ],
    "capacity": 75,
    "totalCapacity": null,
    "capacityUnit": null,
    "sliderMax": 8,
    "verdictGoodThreshold": 6,
    "verdictGoodMessage": "충전 없이 충분히 사용 가능합니다.",
    "verdictWarningMessage": "외출 시 충전기를 챙기세요."
  }
}

// inputType: "chip" example — RAM (32GB)
{
  "type": "SpecDiagnostic",
  "props": {
    "inputType": "chip",
    "title": "RAM 32GB — 내 작업에 얼마나 남을까?",
    "question": "평소에 같이 키우는 앱을 골라보세요",
    "items": [
      { "name": "크롬 (다수)", "weight": 4 },
      { "name": "Figma",       "weight": 6 },
      { "name": "Photoshop",   "weight": 8 },
      { "name": "Premiere Pro","weight": 12 },
      { "name": "Notion",      "weight": 2 }
    ],
    "capacity": null,
    "totalCapacity": 32,
    "capacityUnit": "GB",
    "sliderMax": null,
    "verdictGoodThreshold": 0.8,
    "verdictGoodMessage": "작업 환경 쾌적",
    "verdictWarningMessage": "메모리 부족 예상"
  }
}
- For slider: verdictGoodThreshold = minimum acceptable expected hours.
- For chip: verdictGoodThreshold = maximum acceptable RAM usage ratio (0~1).
- title must include the spec value (e.g., "75Wh", "32GB").
- ALL text must be in Korean.

---

## Edge Cases

- If the category is unrecognized or null, output: { "type": "Unknown", "props": {} }
- If the context is empty or irrelevant, output: { "type": "Empty", "props": {} }
`.trim();

// ---------------------------------------------------------------------------
// UI Agent
// ---------------------------------------------------------------------------

export async function generateUISpec(
  context: string,
  intentSummary: string = "",
  category: number | null = null,
  turnNumber: number = 1
): Promise<string> {
  const prompt = `
[INTENT SUMMARY]
${intentSummary} (Category: ${category})

[TURN NUMBER]
${turnNumber}

[DATA CONTEXT]
${context}

Generate a SINGLE valid JSON object following the schema for Category ${category}.
`.trim();

  try {
    const { text } = await generateText({
      model: google(UI_AGENT_MODEL),
      system: buildUIAgentInstructions(turnNumber),
      prompt,
      temperature: 0,
    });

    return text.trim();
  } catch (err) {
    console.error("[UI_AGENT] Critical Error:", err);
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}