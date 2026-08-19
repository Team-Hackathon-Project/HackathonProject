# Project: Autonomous Self-Healing Market Scraper & Advisory Engine

## Project Architecture & Core Philosophy
This project is an intelligent financial tracking assistant that combines continuous web scraping with LLM reasoning. It monitors portfolio assets, extracts targeted financial metrics, resilience-tests scraping logic, and generates actionable "Buy/Hold/Sell" suggestions with explicit rationale. The user always retains final decision-making authority (Human-in-the-Loop).

### Core Architectural Components
1. **Self-Healing Scraper Engine**
   - Headless browser/DOM observer (Playwright or Puppeteer + Cheerio).
   - Dynamic selector recovery: If CSS selectors fail, fallback to LLM/vision-based element extraction to identify stock price, percentage change, and news blocks, then auto-update the selector registry.
   - Strict content filtering: Strips out header navigation, footers, ads, and irrelevant scripts—returning only normalized financial payload data.

2. **Data Pipeline & Analysis Engine**
   - Real-time normalization of ticker symbols, live stock values, target indicators, and raw sentiment scores.
   - Structured JSON output format for all extracted data.

3. **Recommendation & Reasoning Agent**
   - Rules + LLM hybrid engine evaluating live stock performance against portfolio context.
   - Generates advisory signals (`BUY`, `SELL`, `HOLD`) accompanied by concise, evidence-based reasoning ("Valid Reason").

4. **Human-in-the-Loop UI / Control Plane**
   - Clean dashboard showing clean stock cards and actionable alerts.
   - Decision interface where users approve, reject, or execute proposed actions.

---

## Technical Guidelines & Coding Standards

### Python / Node.js Standards
- **Strict Typing:** Always enforce Type Hints (Python `mypy` / TypeScript).
- **Error Handling:** Every scraping task must catch element lookup failures explicitly and pass the broken DOM context to the `SelfHealingResolver`.
- **Selector Ledger:** Store selectors in a central registry (JSON/YAML/Database). Never hardcode CSS/XPath strings inside execution scripts.

### Self-Healing Flow
1. Attempt data extraction using standard CSS selectors.
2. On DOM mutation / failure:
   - Capture DOM snippet containing target values.
   - Send DOM snippet to LLM with instructions: *"Extract target value and identify the updated CSS/XPath selector."*
   - Update the selector registry automatically and retry extraction.
3. Log auto-repair events to an audit trail.

---

## Target Output Specs

### Scraping Payload (Normalized JSON)
```json
{
  "ticker": "AAPL",
  "current_price": 224.50,
  "currency": "USD",
  "change_percentage": "+1.8%",
  "extracted_at": "2026-08-19T20:55:00Z",
  "market_signals": [
    "Q3 earnings beat expectations",
    "RSI indicator approaching oversold boundary"
  ]
}
```

### output json
```json
{
  "ticker": "AAPL",
  "action": "BUY | SELL | HOLD",
  "confidence_score": 0.85,
  "rationale": "Clear, concise paragraph explaining market context and technical drivers.",
  "user_action_required": true
}
```

## Furhter Instructions.
- Use /caveman Ultra compressed mode of conversation.
- make sure everythign works as intented. 
- You are the Quality Assurance Team. go through everything before flagging it as done and check if everything works and no exceptions are raised