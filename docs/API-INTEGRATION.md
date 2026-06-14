# API Integration Guide

How capture, pipeline, labeling, review, and execution fit together.

## End-to-end flow

```text
1. Extension captures rrweb events
2. POST /ingest/events
3. POST /sessions/:sessionId/end   (extension, on tab close)
4. Pipeline (automatic, default every 60s + debounced ~5s after session end):
     - close idle sessions → recording_sessions.ended_at
     - segment ended sessions → workflows + workflow_steps
     - mine patterns:
         a. code clusters by fingerprint (exact + fuzzy)
         b. LLM adjudicates near-miss pairs (extra/missing steps) when OPENAI_API_KEY is set
         c. promote if count >= PATTERN_MIN_OCCURRENCES (default 3)
   Or manually: POST /pipeline/run
   After normalizer changes: POST /pipeline/reprocess (re-segment all + re-mine)
5. POST /llm/label-workflow     (one API call per pattern)
6. Human reviews in UI (Inbox / Patterns / Library)
7. POST /capabilities/approve
8. GET /capabilities/:id/playwright  or  POST /capabilities/:id/run
```

## Example curl sequence

```bash
# Ingest + session end happen automatically from the extension.

# Run pipeline on demand (close idle → segment → mine)
curl -X POST http://localhost:3001/pipeline/run

# Re-segment all sessions and re-mine (after normalizer/miner changes)
curl -X POST http://localhost:3001/pipeline/reprocess

# Or run steps individually:
curl -X POST http://localhost:3001/workflows/segment/<session-uuid>
curl -X POST http://localhost:3001/patterns/mine

# Label one pattern (returns JSON proposal)
curl -X POST http://localhost:3001/llm/label-workflow \
  -H 'Content-Type: application/json' \
  -d '{"patternId":"<pattern-uuid>"}'

# Approve (optionally edit name/category)
curl -X POST http://localhost:3001/capabilities/approve \
  -H 'Content-Type: application/json' \
  -d '{"proposalId":"<proposal-uuid>","edits":{"name":"Export weekly sales report"}}'

# List approved capabilities
curl http://localhost:3001/capabilities

# Replay (workflow-scoped; used by Patterns tab)
curl http://localhost:3001/workflows/<workflow-uuid>/replay-events

# Export Playwright script
curl -O http://localhost:3001/capabilities/<capability-uuid>/playwright

# Run headful with checkpoints (+ optional LLM repair on failure)
curl -X POST http://localhost:3001/capabilities/<capability-uuid>/run \
  -H 'Content-Type: application/json' \
  -d '{"parameters":{"start_date":"2026-06-01"},"headless":false,"suggestRepair":true}'

# Review UI also uses:
curl http://localhost:3001/proposals
curl http://localhost:3001/patterns
curl -X POST http://localhost:3001/proposals/<proposal-uuid>/reject
```

## LLM request shape (internal)

The API sends the pattern miner output to OpenAI:

```json
{
  "pattern_id": "uuid",
  "fingerprint": "navigate:...|click:...",
  "occurrence_count": 12,
  "domains": ["crm.example.com"],
  "step_template": [
    {"action": "navigate", "url": "https://crm.example.com/reports"},
    {"action": "click", "target": {"text": "Weekly Sales"}},
    {"action": "fill", "target": {"name": "start_date"}, "value": "2026-06-01"}
  ]
}
```

## LLM response shape (stored + shown in review UI)

```json
{
  "capability_name": "Export weekly sales report",
  "category_path": ["Reporting", "Sales"],
  "description": "Opens the weekly sales report and exports CSV for a date range.",
  "parameters": [
    {"name": "start_date", "type": "date", "example": "2026-06-01"},
    {"name": "end_date", "type": "date", "example": "2026-06-07"}
  ],
  "merge_with_pattern_ids": [],
  "confidence": 0.91,
  "reasoning": "Repeated report navigation and export with varying dates."
}
```

`merge_with_pattern_ids` is stored but not acted on yet (no merge UI/API). Workflow-level near-miss merging during mining is handled separately by `LLM_PATTERN_MERGE` (see Cost control).

## LLM pattern merge (internal)

During `POST /patterns/mine`, `POST /pipeline/run`, or `POST /pipeline/reprocess`, the API may call OpenAI for **near-miss workflow pairs** — same domain, similar intent, but different step counts or noise clicks that code clustering missed.

Input (compact step lists per workflow):

```json
{
  "workflow_a": {
    "id": "uuid",
    "domain": "www.google.com",
    "steps": [
      {"action": "navigate", "url": "www.google.com/"},
      {"action": "fill", "target": "Buscar", "value": "fifa world cup 2026"},
      {"action": "click", "target": "Estadísticas"},
      {"action": "click", "target": "Compartir vínculo"}
    ]
  },
  "workflow_b": { "...": "..." }
}
```

Response:

```json
{
  "same_pattern": true,
  "confidence": 0.92,
  "reasoning": "Both workflows search FIFA stats and copy a share link; B has one extra menu click."
}
```

Clusters merge when `same_pattern` is true and `confidence >= 0.7`. Pipeline responses include `llmMergePairsJudged` and `llmMergePairsMerged` when merge ran.

## Cost control

- Label **patterns**, not every session (1 call per unique workflow type)
- Default model: `gpt-4.1-mini` (~$0.001–0.01 per pattern)
- **Pattern merge:** LLM judges only *near-miss* workflow pairs that code clustering missed (capped by `LLM_PATTERN_MERGE_MAX_PAIRS`, default 30 per mining run). Disabled when `LLM_PATTERN_MERGE=false` or no API key.
- Repair suggestions use a separate LLM call only when a Playwright run fails

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

Tabs: **Inbox** · **Patterns** · **Library**

- **Inbox** — approve / edit & approve / reject labeling proposals
- **Patterns** — mined repeats, workflow replay, run pipeline / reprocess all, manual label
- **Library** — approved capabilities; export Playwright or run headful

`VITE_API_BASE` defaults to `http://localhost:3001` (browser → host-mapped API port).

## Docker Compose

```bash
cp .env.example .env   # set OPENAI_API_KEY
npm run docker:up
curl http://localhost:3001/health
```

Database is initialized automatically from `db/schema.sql` and `db/seed-dev.sql` on first run.

**Existing database volumes** created before `segmented_at` was added to `schema.sql`: apply once:

```bash
docker compose exec -T db psql -U persona -d browser_persona < db/migrations/002_pipeline.sql
```

Fresh installs (`docker compose up` on a new volume) already include this column — skip the migration.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | Required for labeling, pattern merge, and repair suggestions |
| `OPENAI_MODEL` | `gpt-4.1-mini` | LLM model |
| `DEV_USER_ID` | `00000000-…0001` | Single dev user (no real auth yet) |
| `PIPELINE_IDLE_MS` | `90000` | Mark session ended after this many ms with no new events |
| `PIPELINE_INTERVAL_MS` | `60000` | Auto-run interval (ms) |
| `PIPELINE_AUTO_RUN` | `true` | Set `false` to disable background pipeline |
| `LLM_PATTERN_MERGE` | `true` | Set `false` to skip LLM adjudication during pattern mining |
| `LLM_PATTERN_MERGE_MAX_PAIRS` | `30` | Max near-miss workflow pairs sent to LLM per mining run |
| `PATTERN_MIN_OCCURRENCES` | `3` | Minimum repeats before a cluster becomes a pattern |
| `INGEST_BODY_LIMIT_MB` | `25` | Max POST body size for `/ingest/events` |
| `PLAYWRIGHT_HEADLESS` | `false` (host) / `true` (Docker) | Headless browser for `/capabilities/:id/run` |
| `PLAYWRIGHT_SLOW_MO` | `50` | Slow motion ms between Playwright actions |
| `PLAYWRIGHT_TIMEOUT_MS` | `30000` | Per-step timeout |
| `VITE_API_BASE` | `http://localhost:3001` | Review UI → API URL (build-time for production image) |

**Headful runs in Docker:** use `npm run docker:exec` so the API runs on your host; the containerized API only supports headless Chromium.
