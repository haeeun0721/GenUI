# GenFrame

**GenUI-based Decision Structuring System for Purchase Decisions**

> A multi-agent AI system that transforms conversational product queries into structured, interactive GenUI components — helping users make better purchase decisions through real-time product data and dynamic comparison.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Interface                           │
│         Chat Input  ←→  Decision Journey  ←→  Decision Criteria│
└─────────────────────────┬───────────────────────────────────────┘
                          │ Message + Criteria + Mentions
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Conversation Agent (Orchestrator)              │
│                                                                 │
│  1. Classify intent → Category 1/2/3/4                         │
│  2. Route to appropriate sub-agents                             │
│  3. Compose final response                                      │
└──────────┬──────────────────────────┬───────────────────────────┘
           │                          │
           ▼                          ▼
┌──────────────────┐      ┌───────────────────────────────────────┐
│   Data Agent     │      │           UI Agent                    │
│                  │      │                                       │
│ • Naver Shopping │      │  Intent Category → Component Type     │
│   API (search)   │      │                                       │
│ • Firecrawl      │      │  Cat 1 → Timeline (Decision Journey)  │
│   (page scrape)  │      │  Cat 2 → Table (Comparison)          │
│ • LLM spec       │      │  Cat 3 → ProductCardList             │
│   extraction     │      │  Cat 4 → SpecDiagnostic              │
└──────────────────┘      └───────────────────────────────────────┘
           │                          │
           └──────────┬───────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    GenUI Renderer (registry.tsx)                │
│                                                                 │
│  • Timeline      • ProductCardList    • SpecDiagnostic          │
│  • Table         • ComparisonSelector • BarChart / PieChart     │
│                                                                 │
│  Dynamic Column Spec Fetching:                                  │
│  User clicks "+ 기준" → /api/fetch-spec → Firecrawl + LLM      │
│                       → Cell auto-populated                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Pipeline

```
User Query
    │
    ▼
Conversation Agent
    │
    ├─ [Category 2/3] searchProducts tool
    │       │
    │       ├─ Naver Shopping API
    │       │   → product title, price, image, link
    │       │
    │       ├─ Firecrawl (parallel per product)
    │       │   → scrape product detail page → markdown
    │       │
    │       └─ LLM (gpt-4o-mini, parallel)
    │           → extract structured specs from page content
    │
    └─ renderInChat tool (with contextSummary)
            │
            ▼
        UI Agent (gpt-4o)
            → generate JSON spec for GenUI component
            │
            ▼
        GenUI Renderer
            → render interactive component in chat


Dynamic Column Spec Fetching (on-demand):
    User clicks "+ [criteria]" button on Table
        │
        ▼
    /api/fetch-spec
        │
        ├─ If product link available → Firecrawl scrape → LLM extract
        └─ If no link → LLM training knowledge fallback
        │
        ▼
    Table cells auto-updated (spinner → value)
```

---

## Intent Categories

| Category | Label | Trigger | Output Component |
|---|---|---|---|
| 1 | Attribute Exploration | "소파 살 때 뭘 봐야 해?" | Timeline (Decision Journey sidebar) |
| 2 | Comparative Evaluation | "A vs B 비교해줘" | Table (with real data from Naver + Firecrawl) |
| 3 | Product Recommendation | "소파 추천해줘" | ProductCardList (real images + prices) |
| 4 | Spec Interpretation | "16GB RAM이면 충분해?" | SpecDiagnostic (interactive slider/chip) |

---

## Key Features

### Multi-Agent Architecture
- **Conversation Agent** — Orchestrates intent classification and sub-agent delegation
- **Data Agent** — Real-time product data via Naver Shopping API + Firecrawl scraping
- **UI Agent** — Generates structured JSON specs for GenUI components

### Real-Time Product Data
- Searches Naver Shopping API for actual products with current prices and images
- Scrapes product detail pages via Firecrawl for detailed specifications
- LLM enriches raw data into structured, comparable spec formats

### Dynamic Comparison Table
- Users can add comparison criteria via drag-and-drop from Decision Journey sidebar
- Clicking `+ [criteria]` on a Table triggers on-demand spec fetching
- Cells show loading spinner → auto-populate with scraped or LLM-inferred values

### Decision Support UX
- **Decision Journey** (left sidebar): Timeline of explored criteria, draggable to input
- **Decision Criteria** (right sidebar): Active comparison criteria panel
- **Centered input on empty state**: Clean onboarding experience

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js (App Router) |
| AI SDK | Vercel AI SDK (`ai` package) |
| LLM | OpenAI GPT-4o / GPT-4o-mini |
| Product Search | Naver Shopping API |
| Web Scraping | Firecrawl |
| Styling | Tailwind CSS + shadcn/ui |
| Agent Pattern | `ToolLoopAgent` (multi-step tool calling) |

---

## Environment Variables

```env
# OpenAI
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o

# Naver Shopping API
# https://developers.naver.com → 검색 API 신청
NAVER_CLIENT_ID=...
NAVER_CLIENT_SECRET=...

# Firecrawl (product page scraping)
# https://firecrawl.dev
FIRECRAWL_API_KEY=...
```

---

## Project Structure

```
app/
├── page.tsx                    # Main UI (3-column layout)
├── api/
│   ├── generate/route.ts       # Main streaming API (Conversation Agent)
│   └── fetch-spec/route.ts     # Dynamic column spec fetching

lib/
├── agents/
│   ├── conversation_agent.ts   # Orchestrator (intent → tool routing)
│   ├── data_agent.ts           # Naver API + Firecrawl + LLM spec extraction
│   └── ui_agent.ts             # GenUI JSON spec generator
├── render/
│   ├── registry.tsx            # GenUI component library
│   └── catalog.ts              # Component catalog / demo data
└── tools/
    ├── render-in-chat.ts       # renderInChat tool (→ UI Agent)
    ├── sidebar.ts              # sidePanel tool (→ Decision Journey)
    ├── sidebar-store.ts        # Server-side UI state store
    └── image-search.ts         # Fallback image search
```

---

## Related Work

This system draws inspiration from **ChoiceMates** (CHI 2024), which pioneered multi-agent purchase decision support with real-time web scraping. GenFrame extends this with:

- **Structured GenUI rendering** — AI-generated interactive components instead of text
- **3-agent pipeline** — Separation of orchestration, data retrieval, and UI generation
- **On-demand spec fetching** — Dynamic table column population without full page reload
- **Decision Journey externalization** — Visual timeline of explored criteria in sidebar
