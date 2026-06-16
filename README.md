# Browser Persona

Learn how a person uses the web, capture journeys, extract intent with an LLM, and store reproducible capabilities.

## Architecture

```text
[Chrome Extension] --rrweb or semantic steps--> [Ingest API]
                                           |
                                    [PostgreSQL]
                                           |
                              [Pipeline: segment + extractIntent + dedup]
                                           |
                              [Review UI] --> [Capability Library]
                                           |
                              [Intent Executor + run history]
```

## Stack

| Layer | Tech |
|---|---|
| Capture | Chrome extension (full rrweb or semantic-only mode) |
| Backend | Node.js + Fastify |
| Database | PostgreSQL |
| LLM | OpenAI structured JSON (swap-friendly) |
| Replay preview | @rrweb/replay (review UI) |
| Execution | Playwright (export script + headful run) |

## Monorepo layout

```text
browser-persona/
├── apps/
│   ├── extension/          # Chrome MV3 recorder
│   ├── api/                # Ingest + pipeline + intent + review + run API
│   └── web/                # Review dashboard
├── packages/
│   ├── shared/             # Shared TypeScript types
│   ├── event-normalizer/   # rrweb or semantic steps -> workflows
│   ├── intent-executor/    # Task loop + verification + LLM replan
│   └── playwright-executor/ # Export + run approved capabilities
├── db/
│   ├── schema.sql
│   └── seed-dev.sql
└── docs/
    └── API-INTEGRATION.md
```

## Quick start (Docker Compose — recommended)

```bash
git clone <repo-url>
cd browser-persona
cp .env.example .env          # set OPENAI_API_KEY
npm run docker:up             # PostgreSQL + API + Review UI

# Dev mode with hot reload (API + web):
npm run docker:dev

# Dev mode detached (background):
npm run docker:dev:detached

# Stop / reset database volume:
npm run docker:down
npm run docker:reset
```

Services:

| Service | URL |
|---|---|
| API | http://localhost:3001 |
| Review UI | http://localhost:3000 |
| PostgreSQL | localhost:5432 (`persona` / `persona`, db: `browser_persona`) |

Health check: `curl http://localhost:3001/health`

The Chrome extension runs on your host — build it locally and load `apps/extension/dist` in Chrome.

```bash
npm install
npm run build:extension
# chrome://extensions → Developer mode → Load unpacked → apps/extension/dist
```

Use the extension popup to confirm the API URL (`http://localhost:3001`) and pause/resume recording.

**Headful Playwright runs:** the API container cannot open a visible browser on macOS. Use:

```bash
npm run docker:exec   # db + web in Docker, API on your host
npm run playwright:install
```

See `docs/API-INTEGRATION.md` for the full flow and API reference.

## Quick start (local, without Docker)

```bash
# 1. Database
createdb browser_persona
psql browser_persona < db/schema.sql
psql browser_persona < db/seed-dev.sql

# 2. Dependencies + API
npm install
cd apps/api
cp .env.example .env   # OPENAI_API_KEY, DATABASE_URL, etc.
npm run dev            # from apps/api, or: npm run dev:api from root

# 3. Extension
npm run build:extension
# Load apps/extension/dist in chrome://extensions (Developer mode)

# 4. Review UI (separate terminal)
npm run dev:web
# Open http://localhost:3000
```

For headful capability runs locally: `npm run playwright:install` once, then use **Run headful** in the Library tab.

## Developer scripts

| Command | Purpose |
|---|---|
| `npm run typecheck` | TypeScript across all workspaces |
| `npm run test` | Unit tests (normalizer, intent-executor, replay, API) |
| `npm run build:extension` | Build Chrome extension to `apps/extension/dist` |
| `npm run docker:exec` | DB + web in Docker, API on host (for visible browser) |

## Typical workflow

1. Record a workflow in Chrome (full rrweb or semantic-only capture).
2. Pipeline runs automatically (~60s interval, or ~5s after tab close) to segment sessions and extract intent.
3. Review proposals in **Inbox** (or wait for auto-approve on high-confidence intents). Use **Reprocess all** after normalizer or intent extraction changes.
4. **Approve** to add to **Library** → **Export Playwright** or **Run headful**.

## Privacy

| Feature | Status |
|---|---|
| Password fields masked at capture | Implemented |
| Pause/resume recording (extension popup) | Implemented |
| Domain allowlist | Schema only — not enforced yet |
| rrweb payload retention | Implemented (`RRWEB_RETENTION_DAYS`, default 14 days) |

## Demo

https://github.com/user-attachments/assets/b7c4dad5-6a93-4ed9-b9b8-05cdabf63fd5

