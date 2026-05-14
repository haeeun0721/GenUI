# GenUI Shopping Assistant

A **multi-agent AI shopping assistant** prototype built for research purposes.  
Users receive personalized product guidance through an intelligent conversational interface paired with dynamically generated UI components.

---

## Overview

This system explores how a multi-agent architecture can enhance the **product decision-making experience** by combining conversational AI with context-aware visual interfaces.

The core research question is:
> *Can a structured intent-routing system — one that detects when to generate visual UI — produce a more effective and natural shopping experience than a purely text-based assistant?*

---

## Architecture

```
User Query
    │
    ▼
┌─────────────────────────┐
│   Conversation Agent    │  ← Detects intent & routes
│  (Intent Classifier)    │    based on 3 categories
└────────┬────────────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
sidePanel  mainPanel
(Timeline) (Table / Grid / SpecEvaluator)
    │         │
    ▼         ▼
┌─────────────────────────┐
│       UI Agent          │  ← Generates JSON spec
│  (JSON Spec Generator)  │    for rendering components
└─────────────────────────┘
```

### Agents

| Agent | Role |
|---|---|
| **Conversation Agent** | Analyzes user query, classifies intent, routes to appropriate tool |
| **UI Agent** | Generates structured JSON specs for visual components |

### Intent Categories (Routing Logic)

| Category | Description | Output |
|---|---|---|
| **1. Attribute/Criteria Exploration** | User explores what specs or factors matter | `sidePanel` — persistent Timeline |
| **2. Comparative Evaluation** | User compares two or more products | `mainPanel` — comparison Table/Grid |
| **3. Spec Interpretation** | User asks if a spec is sufficient for their use case | `mainPanel` — SpecEvaluator |

---

## Tech Stack

- **Framework**: Next.js (App Router)
- **AI SDK**: Vercel AI SDK (`ai` package)
- **LLM**: GPT-4o (via OpenAI)
- **UI Rendering**: `json-render` (component rendering engine)
- **Component Library**: shadcn/ui

---

## Getting Started

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env.local
# Add your OPENAI_API_KEY to .env.local

# Run the development server
npm run dev
```

---

## Project Structure

```
app/
  api/generate/route.ts    # API endpoint — streams agent response
  page.tsx                 # Main chat UI
lib/
  agents/
    conversation.ts        # Conversation Agent (intent routing)
    ui.ts                  # UI Agent (JSON spec generation)
  tools/
    search.ts              # Web search tool
    sidebar.ts             # Side panel rendering tool
    image-search.ts        # Product image search tool
  render/
    catalog.ts             # Component catalog definition
```

---

## Research Notes

This prototype is built on top of the [`json-render`](https://github.com/haeeun0721/GenUI) open-source framework, which enables AI-generated interfaces constrained to predefined component schemas.

The multi-agent structure separates **conversational reasoning** from **visual specification**, allowing each layer to be studied and optimized independently.
