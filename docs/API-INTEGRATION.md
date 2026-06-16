# API Integration Guide

How capture, pipeline, intent extraction, review, and execution fit together.

## End-to-end flow

```text
1. Extension captures rrweb events (full mode) or semantic steps (semantic mode)
2. POST /ingest/events  OR  POST /ingest/semantic-steps
3. POST /sessions/:sessionId/end   (extension, on tab close)
4. Pipeline (automatic, default every 60s + debounced ~5s after session end):
     - close idle sessions → recording_sessions.ended_at
     - segment ended sessions → workflows + workflow_steps
     - extract intent (when `INTENT_EXTRACT_AUTO=true` and OpenAI key set):
         one LLM call per new workflow → dedup vs existing capabilities → auto-approve or inbox proposal
     - purge stale rrweb payloads (`RRWEB_RETENTION_DAYS`) after workflows exist
   Or manually: POST /pipeline/run
   After normalizer changes: POST /pipeline/reprocess (re-segment all + re-extract)
5. Extension polls GET /sessions/:sessionId/automation-offers → notification
6. Intent proposals appear in Inbox automatically, or trigger manually:
     POST /workflows/:workflowId/extract-intent
     POST /llm/extract-intent  `{ "workflowId": "uuid" }`
7. Human reviews in UI (Inbox / Workflows / Library)
8. POST /capabilities/approve  (stores `tasks[]` for intent proposals)
9. GET /capabilities/:id/playwright  or  POST /capabilities/:id/run
10. GET /capabilities/runs — run history with per-task breakdown
```

## Example curl sequence

```bash
# Ingest + session end happen automatically from the extension.

# Run pipeline on demand (close idle → segment → extract intent)
curl -X POST http://localhost:3001/pipeline/run

# Re-segment all sessions (after normalizer changes)
curl -X POST http://localhost:3001/pipeline/reprocess

# Extract intent for one workflow (manual)
curl -X POST http://localhost:3001/workflows/<workflow-uuid>/extract-intent

curl -X POST http://localhost:3001/llm/extract-intent \
  -H 'Content-Type: application/json' \
  -d '{"workflowId":"<workflow-uuid>"}'

# Or run steps individually:
curl -X POST http://localhost:3001/workflows/segment/<session-uuid>

# Approve (optionally edit name/category)
curl -X POST http://localhost:3001/capabilities/approve \
  -H 'Content-Type: application/json' \
  -d '{"proposalId":"<proposal-uuid>","edits":{"name":"Export weekly sales report"}}'

# List approved capabilities
curl http://localhost:3001/capabilities

# Replay (workflow-scoped; full capture only)
curl http://localhost:3001/workflows/<workflow-uuid>/replay-events

# Export Playwright script
curl -O http://localhost:3001/capabilities/<capability-uuid>/playwright

# Run capability
curl -X POST http://localhost:3001/capabilities/<capability-uuid>/run \
  -H 'Content-Type: application/json' \
  -d '{"parameters":{"start_date":"2026-06-01","confirm_dangerous":true},"headless":false}'

# Review UI also uses:
curl http://localhost:3001/proposals
curl http://localhost:3001/workflows/intent
curl -X POST http://localhost:3001/proposals/<proposal-uuid>/reject
curl http://localhost:3001/capabilities/runs
```

## LLM request shape (intent extraction)

Compact semantic steps from `workflow_steps` are sent to OpenAI via `extractIntent` (see `apps/api/src/llm-intent.ts`). Steps are compacted with `compactWorkflowSteps()` from `apps/api/src/compact-steps.ts`.

### Intent workflow (preferred)

After segmentation, `extractIntent` stores an `IntentWorkflow` in `intent_proposals.proposal`:

```json
{
  "name": "Export weekly sales report",
  "description": "Opens the weekly sales report and exports CSV for a date range.",
  "category_path": ["Reporting", "Sales"],
  "domain": "crm.example.com",
  "parameters": [
    {"name": "start_date", "type": "date", "example": "2026-06-01"}
  ],
  "tasks": [
    {
      "id": "t1",
      "order": 1,
      "goal": "Open the Reports area",
      "verification": {"kind": "url_contains", "description": "URL includes /reports"},
      "risk": "low"
    }
  ],
  "is_automatable": true,
  "confidence": 0.91,
  "reasoning": "Clear navigation and export sequence."
}
```

Approve copies `tasks` and `source_workflow_id` into `capabilities`.

## Intent extraction (internal)

Called once per segmented workflow when `INTENT_EXTRACT_AUTO=true` (default). Compact semantic steps are sent to OpenAI; output is Zod-validated as `IntentWorkflow`. Workflows with `is_automatable: false` are skipped by default (`INTENT_EXTRACT_SKIP_NON_AUTOMATABLE=true`).

Pipeline responses include `intentsExtracted`, `intentsDeduped`, and `intentsAutoApproved` when intent extraction ran.

## Intent dedup and auto-approve (Phase 3)

After `extractIntent`, the pipeline compares the new intent to approved capabilities on the same domain using OpenAI embeddings (`name + task goals + domain`):

| Similarity | Behavior |
|---|---|
| ≥ `INTENT_DEDUP_SIMILARITY_HIGH` (0.92) | Link workflow to existing capability; skip inbox |
| `INTENT_DEDUP_SIMILARITY_LOW`–high (0.80–0.92) | Optional LLM confirm (`INTENT_DEDUP_LLM_CONFIRM`) |
| Below low | New proposal (or auto-approve if eligible) |

Auto-approve creates an approved capability when `confidence ≥ INTENT_AUTO_APPROVE_CONFIDENCE` (0.85), max task risk ≤ medium, and domain is not in `INTENT_AUTO_APPROVE_DOMAIN_BLOCKLIST`.

On successful LLM-planned runs, `POST /capabilities/:id/run` persists updated `reference_hint` and `metadata.plan_cache[taskId]` so later runs need fewer planner calls.

## Extension semantic capture (Phase 4)

Set **Capture mode → Semantic only** in the extension popup. The content script records clicks, fills, and navigations as compact steps via `POST /ingest/semantic-steps` instead of full rrweb payloads. Segmentation uses `segmentSemanticSteps()` when semantic steps exist for a session.

After tab close, the extension polls `GET /sessions/:sessionId/automation-offers` and shows a notification when a capability or inbox proposal is ready. The popup also lists approved capabilities with a **Run** button (`POST /capabilities/:id/run`).

## Intent execution (Phase 2)

When `capabilities.tasks` is non-empty, `POST /capabilities/:id/run` uses the intent executor:

1. For each task (in order): try `reference_hint` → verify
2. On failure: LLM `planTask` with interactive DOM snapshot → execute → verify (up to `INTENT_RUN_MAX_PLAN_CALLS_PER_TASK`, default 3)
3. High-risk tasks require `parameters.confirm_dangerous: true`

Response includes `taskResults` (per-task status, attempts, plannerUsed) and `plannerCalls`.

Manual QA fixture: `packages/intent-executor/fixtures/intent-demo.html` — run package tests with `npm run test -w @browser-persona/intent-executor`.

## Run history (Phase 4)

Each `POST /capabilities/:id/run` records a row in `capability_runs` (status, parameters, `task_results`, planner call count). List via `GET /capabilities/runs?capabilityId=uuid`.

Scheduled/cron runs are **not** built in — trigger runs manually (API, Library, or extension popup) or use an external scheduler calling `POST /capabilities/:id/run`.

## Cost control

- **Intent extract:** 1 LLM call per segmented workflow (not per event)
- **Intent dedup:** embedding comparison per workflow; LLM confirm only in uncertain band
- **Semantic capture:** no rrweb storage — smaller ingest payloads
- Default model: `gpt-4.1-mini` (~$0.001–0.01 per workflow)
- Planner calls are capped per task (`INTENT_RUN_MAX_PLAN_CALLS_PER_TASK`)

## Security

- `OPENAI_API_KEY` lives only in server env (`.env` at project root for Docker, or `apps/api/.env` locally)
- Extension never talks to OpenAI directly
- Password fields masked in rrweb before storage
- No auth on ingest yet — single dev user (`DEV_USER_ID`)

## Review UI

With Docker (included in Compose):

```bash
npm run docker:up          # UI at http://localhost:3000 (nginx)
npm run docker:dev         # UI at http://localhost:3000 (Vite hot reload)
```

Without Docker:

```bash
npm run dev:web            # http://localhost:3000 (API on :3001)
```

Tabs: **Inbox** · **Workflows** · **Library**

- **Inbox** — approve / edit & approve / reject intent proposals (tasks + verifications)
- **Workflows** — captured journeys, pipeline controls, replay
- **Library** — approved capabilities; run history, export Playwright, run headful

`VITE_API_BASE` defaults to `http://localhost:3001` (browser → host-mapped API port).

## Docker Compose

```bash
cp .env.example .env   # set OPENAI_API_KEY
npm run docker:up
curl http://localhost:3001/health
```

Database is initialized automatically from `db/schema.sql` and `db/seed-dev.sql` on first run.

To reset the database after schema changes:

```bash
npm run docker:reset
npm run docker:up
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | Required for intent extraction, dedup embeddings, planner, and repair |
| `OPENAI_MODEL` | `gpt-4.1-mini` | LLM model |
| `DEV_USER_ID` | `00000000-…0001` | Single dev user (no real auth yet) |
| `PIPELINE_IDLE_MS` | `90000` | Mark session ended after this many ms with no new events |
| `PIPELINE_INTERVAL_MS` | `60000` | Auto-run interval (ms) |
| `PIPELINE_AUTO_RUN` | `true` | Set `false` to disable background pipeline |
| `INTENT_EXTRACT_AUTO` | `true` | Extract intent after each segmented workflow |
| `INTENT_EXTRACT_SKIP_NON_AUTOMATABLE` | `true` | Skip inbox proposals when LLM sets `is_automatable: false` |
| `INTENT_PROMPT_VERSION` | `v1` | Audit tag for intent extraction prompts |
| `INTENT_RUN_MAX_PLAN_CALLS_PER_TASK` | `3` | Max LLM planner calls per task during run |
| `INTENT_DOM_SNAPSHOT_MAX_CHARS` | `10000` | Cap interactive DOM snapshot for planner |
| `INTENT_AUTO_APPROVE_CONFIDENCE` | `0.85` | Auto-approve when confidence ≥ threshold and max risk ≤ medium |
| `INTENT_DEDUP_SIMILARITY_HIGH` | `0.92` | Embedding similarity to link workflow to existing capability |
| `INTENT_DEDUP_SIMILARITY_LOW` | `0.80` | Below = always new intent; between low and high = optional LLM confirm |
| `INTENT_DEDUP_LLM_CONFIRM` | `true` | LLM confirm for uncertain dedup band |
| `INTENT_AUTO_APPROVE_DOMAIN_BLOCKLIST` | — | Comma-separated domains blocked from auto-approve |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model for intent dedup |
| `RRWEB_RETENTION_DAYS` | `14` | Purge rrweb payloads after this many days (workflows kept) |
| `INGEST_BODY_LIMIT_MB` | `25` | Max POST body size for `/ingest/events` |
| `PLAYWRIGHT_HEADLESS` | `false` (host) / `true` (Docker) | Headless browser for `/capabilities/:id/run` |
| `PLAYWRIGHT_SLOW_MO` | `50` | Slow motion ms between Playwright actions |
| `PLAYWRIGHT_TIMEOUT_MS` | `30000` | Per-step timeout |
| `VITE_API_BASE` | `http://localhost:3001` | Review UI → API URL (build-time for production image) |

**Headful runs in Docker:** use `npm run docker:exec` so the API runs on your host; the containerized API only supports headless Chromium.
