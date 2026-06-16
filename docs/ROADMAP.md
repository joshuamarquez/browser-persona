# Roadmap

Status as of the current codebase. Checked = shipped; unchecked = not yet wired up.

## Phase 0 — Foundations

- [x] PostgreSQL schema applied (`db/schema.sql`)
- [x] Shared TypeScript types (`packages/shared`)
- [x] API health check + ingest endpoints (`/ingest/events`, `/ingest/semantic-steps`)
- [x] Chrome extension (full rrweb or semantic-only capture)

## Phase 1 — Capture pipeline

### Extension

1. Record in **full** mode (rrweb) or **semantic** mode (compact steps only)
2. Flush to API; mask password inputs
3. Pause/resume and capture mode in popup
4. On tab close: end session, poll automation offers, show notification

### Pipeline

1. Close idle sessions → segment → `workflows` + `workflow_steps`
2. `extractIntent()` per workflow when `INTENT_EXTRACT_AUTO=true`
3. Intent dedup + optional auto-approve
4. Purge stale rrweb payloads (`RRWEB_RETENTION_DAYS`)

- [x] `@browser-persona/event-normalizer` — rrweb or semantic steps → segments
- [x] Fingerprints stored on `workflows` (for display/debug; not used for promotion)

## Phase 2 — Intent executor

- [x] `packages/intent-executor` — task loop, verification, LLM replan
- [x] `POST /capabilities/:id/run` uses intent path when `tasks.length > 0`
- [x] Plan cache learning on successful replans
- [x] Legacy `step_template` replay + repair suggestion when no tasks

## Phase 3 — Review UI

- [x] **Inbox** — intent proposals (tasks, risk, verifications)
- [x] **Workflows** — captured journeys, pipeline controls, replay (full capture only)
- [x] **Library** — approved capabilities, run history, manual run
- [x] Approve / edit & approve / reject

## Phase 4 — Product (extension + data)

- [x] Semantic capture mode (smaller ingest)
- [x] Extension “Automate this journey?” notification
- [x] Extension “Run saved workflow” from popup
- [x] `capability_runs` history table + UI
- [x] Removed pattern mining (`workflow_patterns`, `@browser-persona/pattern-miner`)

## Privacy & policy (partial)

| Item | Status |
|---|---|
| Password masking at capture | Done |
| Pause/resume + capture mode | Done |
| `recording_policies` domain allowlist | Schema + seed only — not enforced in extension |
| rrweb retention purge | Done (`RRWEB_RETENTION_DAYS`) |

## Not yet implemented

- [ ] Auth / multi-user (`DEV_USER_ID` only today)
- [ ] `recording_policies` enforcement in extension
- [ ] `custom_assert` verification kind in executor
- [ ] Editable task verifications in Inbox before approve
- [ ] Replay for semantic-only sessions (no rrweb stored)

## Non-goals for MVP

- Cross-browser support (Chrome only)
- Full autonomous agent without checkpoints
- rrweb replay as production executor
- Multi-user org admin / RBAC
- Cron / scheduled capability runs (use external scheduler + `POST /capabilities/:id/run` if needed)

## Removed (legacy)

- Fingerprint pattern mining (`workflow_patterns`, `PATTERN_MIN_OCCURRENCES`, `LLM_PATTERN_MERGE`)
- `labelPattern()` / `POST /llm/label-workflow`
