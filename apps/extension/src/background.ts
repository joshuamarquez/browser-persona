const DEFAULT_API_BASE = 'http://localhost:3001';
const INGEST_CHUNK_SIZE = 20;
const MAX_CHUNK_BYTES = 1_500_000;
const INGEST_MAX_RETRIES = 3;

interface FlushPayload {
  sessionId: string;
  events: unknown[];
  meta: { url: string; tabId?: number; title?: string };
}

const sessionByTab = new Map<number, string>();
const ingestTailBySession = new Map<string, Promise<void>>();

function uuid(): string {
  return crypto.randomUUID();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getApiBase(): Promise<string> {
  const { apiBase } = await chrome.storage.local.get(['apiBase']);
  const base = typeof apiBase === 'string' && apiBase.trim() ? apiBase.trim() : DEFAULT_API_BASE;
  return base.replace(/\/$/, '');
}

function isRetryableFetchError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message === 'Failed to fetch' ||
    message.includes('NetworkError') ||
    message.includes('ECONNREFUSED')
  );
}

function chunkEvents(events: unknown[]): unknown[][] {
  const chunks: unknown[][] = [];
  let current: unknown[] = [];
  let size = 0;

  for (const event of events) {
    const eventSize = JSON.stringify(event).length;
    const wouldOverflow =
      current.length > 0 &&
      (size + eventSize > MAX_CHUNK_BYTES || current.length >= INGEST_CHUNK_SIZE);

    if (wouldOverflow) {
      chunks.push(current);
      current = [];
      size = 0;
    }

    current.push(event);
    size += eventSize;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function postIngestChunk(apiBase: string, payload: FlushPayload, attempt = 1): Promise<void> {
  try {
    const res = await fetch(`${apiBase}/ingest/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(body || `HTTP ${res.status}`);
    }
  } catch (err) {
    if (attempt < INGEST_MAX_RETRIES && isRetryableFetchError(err)) {
      await delay(attempt * 400);
      return postIngestChunk(apiBase, payload, attempt + 1);
    }
    throw err;
  }
}

async function flush(payload: FlushPayload): Promise<void> {
  const apiBase = await getApiBase();
  const { sessionId, events, meta } = payload;

  for (const chunk of chunkEvents(events)) {
    await postIngestChunk(apiBase, {
      sessionId,
      events: chunk,
      meta,
    });
  }
}

/** One in-flight ingest chain per session — avoids duplicate seq races on the API. */
function enqueueFlush(payload: FlushPayload): Promise<void> {
  const { sessionId } = payload;
  const prev = ingestTailBySession.get(sessionId) ?? Promise.resolve();
  const job = prev
    .catch(() => {})
    .then(() => flush(payload));
  ingestTailBySession.set(sessionId, job);
  return job.finally(() => {
    if (ingestTailBySession.get(sessionId) === job) {
      ingestTailBySession.delete(sessionId);
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'RRWEB_BATCH') return;

  const tabId = sender.tab?.id;
  if (tabId == null) return;

  let sessionId = sessionByTab.get(tabId);
  if (!sessionId) {
    sessionId = uuid();
    sessionByTab.set(tabId, sessionId);
  }

  enqueueFlush({
    sessionId,
    events: message.events,
    meta: {
      url: message.url,
      tabId,
      title: message.title,
    },
  })
    .then(() => sendResponse({ ok: true }))
    .catch(async (err) => {
      const apiBase = await getApiBase();
      const messageText = err instanceof Error ? err.message : String(err);
      const hint =
        messageText === 'Failed to fetch'
          ? ` — is the API running at ${apiBase}? (docker compose up -d api, or npm run docker:exec)`
          : '';
      console.error('[browser-persona] ingest failed', `${messageText}${hint}`, {
        apiBase,
        eventCount: message.events?.length ?? 0,
      });
      sendResponse({ ok: false, error: messageText + hint });
    });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const sessionId = sessionByTab.get(tabId);
  if (!sessionId) return;

  sessionByTab.delete(tabId);

  const endSession = async () => {
    const apiBase = await getApiBase();
    await fetch(`${apiBase}/sessions/${sessionId}/end`, { method: 'POST' });
  };

  const pending = ingestTailBySession.get(sessionId);
  const finalize = () => {
    void endSession().catch((err) => {
      console.error('[browser-persona] session end failed', err);
    });
  };

  if (pending) {
    void pending.catch(() => {}).finally(finalize);
  } else {
    finalize();
  }
});
