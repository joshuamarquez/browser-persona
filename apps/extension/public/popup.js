const DEFAULT_API_BASE = 'http://localhost:3001';

const toggle = document.getElementById('toggle');
const status = document.getElementById('status');
const apiStatus = document.getElementById('apiStatus');
const apiBaseInput = document.getElementById('apiBase');

function normalizeApiBase(value) {
  const trimmed = value.trim();
  return (trimmed || DEFAULT_API_BASE).replace(/\/$/, '');
}

async function checkApi(base) {
  try {
    const res = await fetch(`${base}/health`, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    apiStatus.textContent = `API reachable at ${base}`;
    apiStatus.className = 'api ok';
  } catch {
    apiStatus.textContent = `API unreachable at ${base} — run docker compose up -d api or npm run docker:exec`;
    apiStatus.className = 'api err';
  }
}

chrome.storage.local.get(['recordingPaused', 'apiBase'], ({ recordingPaused, apiBase }) => {
  const paused = Boolean(recordingPaused);
  toggle.textContent = paused ? 'Resume' : 'Pause';
  status.textContent = paused ? 'Paused' : 'Active';

  const base = normalizeApiBase(typeof apiBase === 'string' ? apiBase : DEFAULT_API_BASE);
  apiBaseInput.value = base;
  void checkApi(base);
});

toggle.addEventListener('click', async () => {
  const { recordingPaused } = await chrome.storage.local.get(['recordingPaused']);
  const next = !recordingPaused;
  await chrome.storage.local.set({ recordingPaused: next });
  toggle.textContent = next ? 'Resume' : 'Pause';
  status.textContent = next ? 'Paused' : 'Active';
});

apiBaseInput.addEventListener('change', async () => {
  const base = normalizeApiBase(apiBaseInput.value);
  apiBaseInput.value = base;
  await chrome.storage.local.set({ apiBase: base });
  void checkApi(base);
});
