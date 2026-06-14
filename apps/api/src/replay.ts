import { query } from './db.js';

const REPLAY_BUFFER_MS = 5_000;

/** rrweb EventType.Meta */
const RRWEB_META = 4;
/** rrweb EventType.FullSnapshot */
const RRWEB_FULL_SNAPSHOT = 2;

export interface RrwebEventPayload {
  type: number;
  timestamp: number;
  data?: unknown;
}

export interface ReplayEventsResult {
  sessionId: string;
  workflowId?: string;
  eventCount: number;
  events: RrwebEventPayload[];
}

function eventTime(event: RrwebEventPayload, fallbackMs?: number): number {
  if (Number.isFinite(event.timestamp)) return event.timestamp;
  return fallbackMs ?? 0;
}

function mapEventRows(
  rows: Array<{ payload: RrwebEventPayload; timestamp_ms: number }>,
): RrwebEventPayload[] {
  return rows.map((row) => {
    const payload = row.payload;
    return {
      type: payload.type,
      timestamp: eventTime(payload, row.timestamp_ms),
      data: payload.data,
    };
  });
}

/**
 * rrweb-player requires Meta + FullSnapshot first, then incrementals.
 * Drop orphan incrementals that appear before the snapshot in the slice.
 */
export function normalizeForReplayer(events: RrwebEventPayload[]): RrwebEventPayload[] {
  if (events.length === 0) return events;

  const snapshotIdx = events.findIndex((e) => e.type === RRWEB_FULL_SNAPSHOT);
  if (snapshotIdx === -1) {
    throw new Error('No DOM snapshot in recording — reload the page and record again');
  }

  const meta = events.find((e) => e.type === RRWEB_META);
  const snapshot = events[snapshotIdx];
  const tail = events
    .slice(snapshotIdx + 1)
    .filter((e) => e.type !== RRWEB_FULL_SNAPSHOT && e.type !== RRWEB_META);

  const ordered: RrwebEventPayload[] = [];
  if (meta) ordered.push(meta);
  ordered.push(snapshot);
  ordered.push(...tail);

  return ordered;
}

/** Slice session events to a workflow time window and include a usable DOM snapshot. */
export function sliceReplayEvents(
  allEvents: RrwebEventPayload[],
  startMs: number,
  endMs: number,
): RrwebEventPayload[] {
  if (allEvents.length === 0) {
    throw new Error('No replay events found for this workflow');
  }

  let windowStartIdx = allEvents.findIndex((e) => eventTime(e) >= startMs);
  if (windowStartIdx === -1) windowStartIdx = allEvents.length - 1;

  let windowEndIdx = -1;
  for (let i = allEvents.length - 1; i >= 0; i--) {
    if (eventTime(allEvents[i]) <= endMs) {
      windowEndIdx = i;
      break;
    }
  }
  if (windowEndIdx === -1) windowEndIdx = allEvents.length - 1;
  if (windowStartIdx > windowEndIdx) {
    throw new Error('No replay events found for this workflow');
  }

  let snapshotIdx = -1;
  for (let i = windowStartIdx; i >= 0; i--) {
    if (allEvents[i].type === RRWEB_FULL_SNAPSHOT) {
      snapshotIdx = i;
      break;
    }
  }
  if (snapshotIdx === -1) {
    for (let i = windowStartIdx; i <= windowEndIdx; i++) {
      if (allEvents[i].type === RRWEB_FULL_SNAPSHOT) {
        snapshotIdx = i;
        break;
      }
    }
  }

  let sliceFrom = snapshotIdx >= 0 ? snapshotIdx : windowStartIdx;

  let metaIdx = -1;
  for (let i = sliceFrom; i >= 0; i--) {
    if (allEvents[i].type === RRWEB_META) {
      metaIdx = i;
      break;
    }
  }
  if (metaIdx >= 0) sliceFrom = metaIdx;

  const slice = allEvents.slice(sliceFrom, windowEndIdx + 1);
  return normalizeForReplayer(slice);
}

/** rrweb events for one workflow segment (pattern example replay). */
export async function getWorkflowReplayEvents(
  workflowId: string,
  userId: string,
): Promise<ReplayEventsResult> {
  const workflows = await query<{
    session_id: string;
    started_at: string;
    ended_at: string;
  }>(
    `SELECT session_id, started_at, ended_at FROM workflows WHERE id = $1 AND user_id = $2`,
    [workflowId, userId],
  );
  if (workflows.length === 0) {
    throw new Error('Workflow not found');
  }

  const { session_id, started_at, ended_at } = workflows[0];
  const startMs = new Date(started_at).getTime() - REPLAY_BUFFER_MS;
  const endMs = new Date(ended_at).getTime() + REPLAY_BUFFER_MS;

  const rows = await query<{ payload: RrwebEventPayload; timestamp_ms: number }>(
    `SELECT payload, timestamp_ms FROM rrweb_events
     WHERE session_id = $1
     ORDER BY seq ASC`,
    [session_id],
  );

  const allEvents = mapEventRows(rows);
  const events = sliceReplayEvents(allEvents, startMs, endMs);

  return {
    sessionId: session_id,
    workflowId,
    eventCount: events.length,
    events,
  };
}
