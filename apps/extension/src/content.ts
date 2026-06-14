import { record } from 'rrweb';

const FLUSH_EVENT_COUNT = 10;
const FLUSH_INTERVAL_MS = 3_000;

let buffer: unknown[] = [];
let stopFn: (() => void) | null = null;
let flushIntervalId: ReturnType<typeof setInterval> | null = null;
let tearingDown = false;
let flushing = false;
let recordingGeneration = 0;

function bumpRecordingGeneration(): void {
  recordingGeneration += 1;
}

function onPageHide(): void {
  flush();
}

function isExtensionContextValid(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function contextInvalidated(): boolean {
  const err = chrome.runtime.lastError;
  return Boolean(err?.message?.includes('Extension context invalidated'));
}

function teardownRecording(): void {
  if (tearingDown) return;
  tearingDown = true;

  window.removeEventListener('pagehide', onPageHide);
  if (flushIntervalId != null) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }
  const fn = stopFn;
  stopFn = null;
  fn?.();
  bumpRecordingGeneration();
}

function stopRecording(): void {
  if (tearingDown) return;
  flush();
  teardownRecording();
}

function flush(): void {
  if (tearingDown || flushing) return;
  if (!isExtensionContextValid()) {
    teardownRecording();
    return;
  }
  if (buffer.length === 0) return;

  flushing = true;
  try {
    const batch = buffer;
    buffer = [];
    const generation = recordingGeneration;

    chrome.runtime.sendMessage(
      {
        type: 'RRWEB_BATCH',
        events: batch,
        url: location.href,
        title: document.title,
      },
      () => {
        if (generation !== recordingGeneration) return;
        if (contextInvalidated()) teardownRecording();
      },
    );
  } catch {
    teardownRecording();
  } finally {
    flushing = false;
  }
}

function startRecording(): void {
  if (stopFn || !isExtensionContextValid()) return;
  tearingDown = false;
  bumpRecordingGeneration();

  stopFn = record({
    emit(event) {
      if (tearingDown) return;
      if (!isExtensionContextValid()) {
        stopRecording();
        return;
      }
      buffer.push(event);
      if (buffer.length >= FLUSH_EVENT_COUNT) flush();
    },
    maskInputOptions: {
      password: true,
    },
    recordCanvas: false,
  });

  flushIntervalId = setInterval(flush, FLUSH_INTERVAL_MS);
  window.addEventListener('pagehide', onPageHide);
}

async function init(): Promise<void> {
  if (!isExtensionContextValid()) return;

  const { recordingPaused } = await chrome.storage.local.get(['recordingPaused']);
  if (!recordingPaused) startRecording();

  chrome.storage.onChanged.addListener((changes) => {
    if (!isExtensionContextValid()) {
      stopRecording();
      return;
    }
    if (!changes.recordingPaused) return;
    const paused = Boolean(changes.recordingPaused.newValue);
    if (paused && stopFn) {
      stopRecording();
    } else if (!paused && !stopFn) {
      startRecording();
    }
  });
}

init();
