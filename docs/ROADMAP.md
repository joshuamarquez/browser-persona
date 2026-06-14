# Roadmap

Status as of the current codebase. Checked = shipped; unchecked = not yet wired up.

## Phase 0 — Foundations

- [x] PostgreSQL schema applied (`db/schema.sql`)
- [x] Shared TypeScript types (`packages/shared`)
- [x] API health check + ingest endpoint
- [x] Extension records rrweb on allowed hosts (all `https://*/*` + localhost — no allowlist enforcement yet)

## Phase 1 — Capture pipeline

### Extension behavior

1. On tab load, inject rrweb `record()` (no domain allowlist check yet)
2. Buffer events locally (10 events or 3s in content script; background chunks for ingest)
3. Flush batch to `POST /ingest/events`
4. Mask password inputs before emit
5. Pause/resume via extension popup

### Ingest API contract (current)

```http
POST /ingest/events
Content-Type: application/json

{
  "sessionId": "uuid",
  "events": [ /* rrweb events */ ],
  "meta": { "url": "...", "tabId": 1 }
}
```

> Planned: `Authorization: Bearer <user_token>` — not implemented; API uses `DEV_USER_ID`.

### Success criteria

- [x] Full session stored in `rrweb_events`
- [x] Replay works in review UI for workflow examples

---

## Phase 2 — Normalization

Convert rrweb incremental events into `workflow_steps`:

| rrweb source | Semantic step |
|---|---|
| Meta + full snapshot | `navigate` |
| MouseInteraction click | `click` |
| Input value change | `fill` |
| Selection change | `select` |
| significant scroll | `scroll` |
| form submit / navigation | boundary for segmentation |

### Segmentation rules

- Start workflow on `navigate` or idle gap > 90s
- End on: idle gap > 90s, tab close, or cross-origin navigation (same-site page changes stay in one journey)
- Ignore: mousemove-only noise, scroll-only micro adjustments, unlabeled icon clicks (`svg`, empty `div`)

### Fingerprint

```text
navigate:crm.example.com/reports|click:text=Weekly Sales|fill:Start Date|fill:End Date|click:text=Export CSV
```

- [x] Implemented in `@browser-persona/event-normalizer`
- [x] Stored in `workflows.fingerprint`

---

## Phase 3 — Pattern mining

Auto pipeline (default every 60s + debounced after session end), or `POST /pipeline/run` / `POST /pipeline/reprocess`:

1. Group workflows by fingerprint (exact + fuzzy clustering)
2. Find near-miss pairs (same domain, subsequence-aligned steps, different length/noise)
3. LLM adjudicates borderline pairs → merge clusters when confidence ≥ 0.7
4. Count occurrences per user
5. If count >= `PATTERN_MIN_OCCURRENCES` (default 3), upsert `workflow_patterns`
6. Mark member workflows as `candidate`

- [x] Exact + fuzzy match (`@browser-persona/pattern-miner`)
- [x] LLM merge for near-miss pairs (`apps/api/src/llm-merge.ts`, opt-out via `LLM_PATTERN_MERGE=false`)

---

## Phase 4 — LLM labeling

```http
POST /llm/label-workflow
{ "patternId": "uuid" }
```

Returns proposal stored in `labeling_proposals`. Human reviews in UI.

- [x] Labeling API + proposal storage
- [ ] Auto-approve (confidence >= 0.85, sensitive-domain guard, user opt-in)

---

## Phase 5 — Review UI

- [x] **Inbox:** unreviewed proposals
- [x] **Patterns:** frequency, replay, manual label, run pipeline, reprocess all
- [x] **Library:** approved capabilities grouped by `category_path`
- [x] Approve / Edit name+category / Reject
- [ ] Merge (LLM returns `merge_with_pattern_ids`; no UI/API yet)

---

## Phase 6 — Execution

- [x] Export approved capability to Playwright script (`GET …/playwright`)
- [x] Run headful with per-step validation checkpoints (`POST …/run`)
- [x] On failure, DOM snapshot + LLM repair suggestion

---

## Privacy & policy (partial)

| Item | Status |
|---|---|
| Password masking at capture | Done |
| Pause/resume toggle | Done |
| `recording_policies` domain allowlist | Schema + seed only |
| 30-day raw event retention | Schema only — no purge job |

---

## Non-goals for MVP

- Cross-browser support (Chrome only)
- Full autonomous agent at runtime
- rrweb replay as production executor
- Multi-user org admin / RBAC
