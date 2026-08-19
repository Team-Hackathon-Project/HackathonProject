# Project: Autonomous Self-Healing Market Scraper & Advisory Engine

## Project Architecture & Core Philosophy
This project is an intelligent financial tracking tool built as a hybrid **Chrome Extension (Manifest V3)** and **Agent Engine**. It operates directly within the user's browser, allowing them to scrape active financial tabs, track portfolio metrics, repair broken DOM selectors automatically, and receive AI-generated Buy/Hold/Sell suggestions with explicit rationale. The user always retains final decision-making authority (Human-in-the-Loop).

---

## Technical Architecture & Chrome Extension Specs

### 1. Hybrid Architecture (Extension + Agent Service)
- **Extension Content Script (`content.js`):** Injected directly into trading/financial websites. Extracts active DOM elements (price, percentage change, volume, news block) and passes them to the background worker.
- **Service Worker (`background.js`):** Coordinates DOM extraction events, manages extension storage (`chrome.storage.local`), handles communication with the LLM backend, and maintains the selector registry.
- **Offscreen Document (`offscreen.html` / `offscreen.js`):** Used to handle heavy parsing tasks or background HTML fetching without stalling the active browser tab.
- **Popup UI (`popup.html` / `popup.jsx`):** Displays clean stock metrics, live advisory cards (BUY/SELL/HOLD + Rationale), and action buttons where the user explicitly approves or rejects trading moves.

### 2. Self-Healing Mechanism (Extension Context)
1. Content script attempts parsing using the active selector from `chrome.storage.local`.
2. On lookup failure or DOM structure mutation:
   - Content script captures the surrounding parent HTML container.
   - Message sent to background service worker: `EVENT: SELECTOR_FAILED`.
   - Service worker queries LLM (via backend or direct API call) with the broken DOM snippet: *"Find the updated element containing the live stock value and return a valid CSS/XPath selector."*
   - Extension auto-updates `chrome.storage.local` with the new selector and re-runs extraction seamlessly.

---

## Technical Guidelines & Coding Standards

- **Manifest V3 Standards:** Strict adherence to Manifest V3 service worker lifecycles (no persistent background pages).
- **Permissions Scope:** Keep permissions strictly bounded (`activeTab`, `storage`, `scripting`, `offscreen`).
- **No Direct Autotrading:** The extension ONLY provides recommendations and reasonings. The UI must present a confirmation modal before taking any final action.
- **Data Normalization:** All scraped data must be stripped of extraneous page bloat (ads, navigation header, footer) and stored as structured JSON.

---

## Data Schemas

### Scraping Payload (`chrome.storage.local`)
```json
{
  "ticker": "AAPL",
  "current_price": 224.50,
  "currency": "USD",
  "change_percentage": "+1.8%",
  "extracted_at": "2026-08-19T20:55:00Z",
  "source_url": "[https://finance.example.com/quote/AAPL](https://finance.example.com/quote/AAPL)",
  "selectors_used": {
    "price_selector": "#quote-header-info span[data-reactid]"
  }
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