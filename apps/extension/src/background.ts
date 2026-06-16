const DEFAULT_API_BASE = 'http://localhost:3001';
const INGEST_CHUNK_SIZE = 20;
const MAX_CHUNK_BYTES = 1_500_000;
const INGEST_MAX_RETRIES = 3;
const OFFER_POLL_ATTEMPTS = 12;
const OFFER_POLL_INTERVAL_MS = 5_000;

interface FlushPayload {
  sessionId: string;
  events: unknown[];
  meta: { url: string; tabId?: number; title?: string };
}

interface SemanticFlushPayload {
  sessionId: string;
  steps: unknown[];
  meta: { url: string; tabId?: number; title?: string; captureMode: 'semantic' };
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

async function postSemanticChunk(
  apiBase: string,
  payload: SemanticFlushPayload,
  attempt = 1,
): Promise<void> {
  try {
    const res = await fetch(`${apiBase}/ingest/semantic-steps`, {
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
      return postSemanticChunk(apiBase, payload, attempt + 1);
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

async function flushSemantic(payload: SemanticFlushPayload): Promise<void> {
  const apiBase = await getApiBase();
  await postSemanticChunk(apiBase, payload);
}

function enqueueFlush(job: () => Promise<void>, sessionId: string): Promise<void> {
  const prev = ingestTailBySession.get(sessionId) ?? Promise.resolve();
  const chained = prev
    .catch(() => {})
    .then(job);
  ingestTailBySession.set(sessionId, chained);
  return chained.finally(() => {
    if (ingestTailBySession.get(sessionId) === chained) {
      ingestTailBySession.delete(sessionId);
    }
  });
}

interface AutomationOffer {
  type: 'proposal' | 'capability';
  name: string;
  description: string;
  capabilityId?: string;
  taskCount: number;
}

async function pollAutomationOffers(sessionId: string): Promise<void> {
  const apiBase = await getApiBase();

  for (let attempt = 0; attempt < OFFER_POLL_ATTEMPTS; attempt++) {
    await delay(OFFER_POLL_INTERVAL_MS);
    try {
      const res = await fetch(`${apiBase}/sessions/${sessionId}/automation-offers`);
      if (!res.ok) continue;
      const data = (await res.json()) as { offers: AutomationOffer[] };
      if (!data.offers?.length) continue;

      const offer = data.offers[0];
      const message =
        offer.type === 'capability'
          ? `"${offer.name}" is ready to run (${offer.taskCount} tasks).`
          : `Automate "${offer.name}"? Review ${offer.taskCount} tasks in Browser Persona.`;

      chrome.notifications.create(
        `offer-${sessionId}`,
        {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon128.png'),
          title: 'Automate this journey?',
          message,
          priority: 1,
        },
        () => {
          const err = chrome.runtime.lastError;
          if (err) console.warn('[browser-persona] notification failed', err.message);
        },
      );
      return;
    } catch {
      // keep polling
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RUN_CAPABILITY') {
    void (async () => {
      try {
        const apiBase = await getApiBase();
        const res = await fetch(`${apiBase}/capabilities/${message.capabilityId}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parameters: message.parameters ?? {} }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        sendResponse({ ok: true, result: body });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (message.type === 'SEMANTIC_BATCH') {
    const tabId = sender.tab?.id;
    if (tabId == null) return;

    let sessionId = sessionByTab.get(tabId);
    if (!sessionId) {
      sessionId = uuid();
      sessionByTab.set(tabId, sessionId);
    }

    enqueueFlush(
      () =>
        flushSemantic({
          sessionId,
          steps: message.steps,
          meta: {
            url: message.url,
            tabId,
            title: message.title,
            captureMode: 'semantic',
          },
        }),
      sessionId,
    )
      .then(() => sendResponse({ ok: true }))
      .catch(async (err) => {
        const apiBase = await getApiBase();
        const messageText = err instanceof Error ? err.message : String(err);
        sendResponse({ ok: false, error: messageText, apiBase });
      });

    return true;
  }

  if (message.type !== 'RRWEB_BATCH') return;

  const tabId = sender.tab?.id;
  if (tabId == null) return;

  let sessionId = sessionByTab.get(tabId);
  if (!sessionId) {
    sessionId = uuid();
    sessionByTab.set(tabId, sessionId);
  }

  enqueueFlush(
    () =>
      flush({
        sessionId,
        events: message.events,
        meta: {
          url: message.url,
          tabId,
          title: message.title,
        },
      }),
    sessionId,
  )
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
    void pollAutomationOffers(sessionId);
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
