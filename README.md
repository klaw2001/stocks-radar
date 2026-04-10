# Results Radar v1

Equity earnings monitor — lightweight, cost-efficient, team-shareable.

---

## Quick Start

```bash
# 1. Install
npm install

# 2. Set environment variables (or leave blank for mock mode)
cp .env.example .env

# 3. Run development server
npm run dev

# 4. Open http://localhost:5000
```

---

## Environment Variables

Create a `.env` file in the project root:

```
# Admin key — anyone with this key can toggle read/unread
ADMIN_KEY=your-secret-admin-key

# Twitter/X API — leave blank to run in mock mode (random sentiment)
X_BEARER_TOKEN=YOUR_KEY_HERE

# Tijori Finance / Concall Monitor API — leave blank to run in mock mode
TIJORI_CONCALL_MONITOR_API_KEY=YOUR_KEY_HERE

# Optional: Port (default 5000)
PORT=5000
```

**If API keys are missing, the app runs in mock/demo mode with no errors.**

---

## Architecture

```
results-radar/
├── client/src/
│   ├── pages/Dashboard.tsx   # Main UI — KPI cards, filters, table
│   ├── index.css             # Finance dark/light palette
│   └── App.tsx
├── server/
│   ├── routes.ts             # Express API endpoints
│   ├── storage.ts            # SQLite via Drizzle ORM
│   ├── screener.ts           # Screener + X + Tijori pollers
│   └── seed.ts               # Mock data seed (runs once on empty DB)
└── shared/
    └── schema.ts             # Drizzle schema + Zod types
```

**Database:** SQLite (`results_radar.db` — auto-created on first run). Zero setup.

---

## Polling Schedule

| Source   | Interval   | Trigger                          |
|----------|------------|----------------------------------|
| Screener | Every 10m  | Market hours only (09:00–16:00 IST) |
| X/Twitter| Once       | On new result detection only      |
| Tijori   | Every 30m  | Only for `transcript_status = pending` rows |

---

## Admin Access

Mark results read/unread via the Admin key:

1. Click "Admin" in the top-right header
2. Enter your `ADMIN_KEY`
3. Press Enter or click Apply
4. Read/unread toggles activate globally for all viewers

Alternatively, pass the key via URL: `/?admin_key=your-key`

Or via API header: `X-Admin-Key: your-key`

---

## API Endpoints

| Method | Path                        | Description               |
|--------|-----------------------------|---------------------------|
| GET    | `/api/events`               | All events (filterable)   |
| GET    | `/api/events?search=HDFC`   | Company search            |
| GET    | `/api/events?sentiment=good`| Filter by chatter         |
| GET    | `/api/events?transcript_status=pending` | Filter pending |
| GET    | `/api/events?is_read=false` | Filter unread             |
| GET    | `/api/kpis`                 | Dashboard KPI counts      |
| GET    | `/api/logs`                 | Recent polling logs       |
| PATCH  | `/api/events/:id/read`      | Toggle read (admin only)  |
| POST   | `/api/poll/screener`        | Manual poll trigger       |
| POST   | `/api/poll/tijori`          | Manual Tijori trigger     |

---

## Deployment (Production)

```bash
npm run build
NODE_ENV=production ADMIN_KEY=your-key node dist/index.cjs
```

Or deploy to Railway / Render / Fly.io with:
- Build command: `npm run build`
- Start command: `node dist/index.cjs`
- Environment variables set in dashboard

---

## Version 2 Roadmap

- PDF table data extraction (Screener / BSE PDF)
- Concall transcript summarization (LLM, triggered manually)
- Sector / industry tagging
- Price reaction column (vs result date close)
- Email/Slack notifications on new results
- Per-user read state (optional)
