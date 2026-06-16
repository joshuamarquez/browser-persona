const DEFAULT_API_BASE = 'http://localhost:3001';

const toggle = document.getElementById('toggle');
const status = document.getElementById('status');
const apiStatus = document.getElementById('apiStatus');
const apiBaseInput = document.getElementById('apiBase');
const captureModeSelect = document.getElementById('captureMode');
const capabilitiesEl = document.getElementById('capabilities');

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
    return true;
  } catch {
    apiStatus.textContent = `API unreachable at ${base} — run docker compose up -d api or npm run docker:exec`;
    apiStatus.className = 'api err';
    return false;
  }
}

async function loadCapabilities(base) {
  try {
    const res = await fetch(`${base}/capabilities`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const approved = (data.capabilities ?? []).filter((c) => c.status === 'approved');
    if (approved.length === 0) {
      capabilitiesEl.innerHTML = '<p class="muted">No approved workflows yet.</p>';
      return;
    }
    capabilitiesEl.innerHTML = '';
    for (const cap of approved.slice(0, 8)) {
      const item = document.createElement('div');
      item.className = 'cap-item';
      item.innerHTML = `<strong>${cap.name}</strong>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Run';
      btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = 'Running…';
        chrome.runtime.sendMessage(
          { type: 'RUN_CAPABILITY', capabilityId: cap.id },
          (response) => {
            if (response?.ok) {
              btn.textContent = response.result?.success ? 'Done' : 'Failed';
            } else {
              btn.textContent = 'Error';
              btn.title = response?.error ?? 'Run failed';
            }
            setTimeout(() => {
              btn.disabled = false;
              btn.textContent = 'Run';
            }, 3000);
          },
        );
      });
      item.appendChild(btn);
      capabilitiesEl.appendChild(item);
    }
  } catch {
    capabilitiesEl.innerHTML = '<p class="muted">Could not load capabilities.</p>';
  }
}

chrome.storage.local.get(['recordingPaused', 'apiBase', 'captureMode'], ({ recordingPaused, apiBase, captureMode }) => {
  const paused = Boolean(recordingPaused);
  toggle.textContent = paused ? 'Resume' : 'Pause';
  status.textContent = paused ? 'Paused' : 'Active';

  const base = normalizeApiBase(typeof apiBase === 'string' ? apiBase : DEFAULT_API_BASE);
  apiBaseInput.value = base;
  captureModeSelect.value = captureMode === 'semantic' ? 'semantic' : 'full';
  void checkApi(base).then((ok) => {
    if (ok) void loadCapabilities(base);
  });
});

toggle.addEventListener('click', async () => {
  const { recordingPaused } = await chrome.storage.local.get(['recordingPaused']);
  const next = !recordingPaused;
  await chrome.storage.local.set({ recordingPaused: next });
  toggle.textContent = next ? 'Resume' : 'Pause';
  status.textContent = next ? 'Paused' : 'Active';
});

captureModeSelect.addEventListener('change', async () => {
  await chrome.storage.local.set({ captureMode: captureModeSelect.value });
});

apiBaseInput.addEventListener('change', async () => {
  const base = normalizeApiBase(apiBaseInput.value);
  apiBaseInput.value = base;
  await chrome.storage.local.set({ apiBase: base });
  const ok = await checkApi(base);
  if (ok) void loadCapabilities(base);
});
