import { record } from 'rrweb';

type SemanticAction = 'navigate' | 'click' | 'fill' | 'select' | 'scroll' | 'submit' | 'wait';

interface StepTarget {
  selector?: string;
  text?: string;
  role?: string;
  ariaLabel?: string;
  name?: string;
  tag?: string;
}

interface SemanticStep {
  action: SemanticAction;
  target?: StepTarget;
  value?: string | number | boolean | null;
  url?: string;
  occurredAt: string;
}

const FLUSH_EVENT_COUNT = 10;
const FLUSH_INTERVAL_MS = 3_000;
const SEMANTIC_FLUSH_COUNT = 5;

type CaptureMode = 'full' | 'semantic';

let buffer: unknown[] = [];
let semanticBuffer: SemanticStep[] = [];
let stopFn: (() => void) | null = null;
let flushIntervalId: ReturnType<typeof setInterval> | null = null;
let tearingDown = false;
let flushing = false;
let recordingGeneration = 0;
let captureMode: CaptureMode = 'full';
let lastUrl = location.href;

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
  document.removeEventListener('click', onSemanticClick, true);
  document.removeEventListener('change', onSemanticChange, true);
  document.removeEventListener('submit', onSemanticSubmit, true);
  window.removeEventListener('popstate', onSemanticNavigate);
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

function targetFromElement(el: Element): StepTarget {
  const tag = el.tagName.toLowerCase();
  const input = el as HTMLInputElement;
  const text = (el.textContent ?? '').trim().slice(0, 120);
  const ariaLabel = el.getAttribute('aria-label') ?? undefined;
  const name = input.name || el.getAttribute('name') || undefined;
  const role = el.getAttribute('role') ?? undefined;
  return { tag, text: text || undefined, ariaLabel, name, role };
}

function pushSemanticStep(action: SemanticAction, target?: StepTarget, value?: SemanticStep['value']): void {
  if (tearingDown) return;
  const step: SemanticStep = {
    action,
    target,
    value,
    url: location.href,
    occurredAt: new Date().toISOString(),
  };
  semanticBuffer.push(step);
  if (semanticBuffer.length >= SEMANTIC_FLUSH_COUNT) flush();
}

function onSemanticNavigate(): void {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    pushSemanticStep('navigate');
  }
}

function onSemanticClick(event: MouseEvent): void {
  const el = event.target;
  if (!(el instanceof Element)) return;
  const clickable = el.closest('a,button,[role=button],[role=link],input[type=submit]');
  if (!clickable) return;
  pushSemanticStep('click', targetFromElement(clickable));
}

function onSemanticChange(event: Event): void {
  const el = event.target;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
    return;
  }
  const fieldName = el.name || el.getAttribute('aria-label') || undefined;
  const masked = fieldName?.toLowerCase().includes('password');
  const value = masked ? '***' : el.value;
  pushSemanticStep(el instanceof HTMLSelectElement ? 'select' : 'fill', targetFromElement(el), value);
}

function onSemanticSubmit(event: Event): void {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  pushSemanticStep('submit', { tag: 'form', name: form.getAttribute('name') ?? undefined });
}

function flush(): void {
  if (tearingDown || flushing) return;
  if (!isExtensionContextValid()) {
    teardownRecording();
    return;
  }

  flushing = true;
  try {
    const generation = recordingGeneration;

    if (captureMode === 'semantic') {
      if (semanticBuffer.length === 0) return;
      const batch = semanticBuffer;
      semanticBuffer = [];
      chrome.runtime.sendMessage(
        {
          type: 'SEMANTIC_BATCH',
          steps: batch,
          url: location.href,
          title: document.title,
        },
        () => {
          if (generation !== recordingGeneration) return;
          if (contextInvalidated()) teardownRecording();
        },
      );
      return;
    }

    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];

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

function startSemanticCapture(): void {
  lastUrl = location.href;
  pushSemanticStep('navigate');
  document.addEventListener('click', onSemanticClick, true);
  document.addEventListener('change', onSemanticChange, true);
  document.addEventListener('submit', onSemanticSubmit, true);
  window.addEventListener('popstate', onSemanticNavigate);
  flushIntervalId = setInterval(flush, FLUSH_INTERVAL_MS);
  window.addEventListener('pagehide', onPageHide);
}

function startFullCapture(): void {
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

function startRecording(mode: CaptureMode): void {
  if (!isExtensionContextValid()) return;

  if (flushIntervalId != null || stopFn || semanticBuffer.length > 0 || buffer.length > 0) {
    flush();
    teardownRecording();
    tearingDown = false;
    buffer = [];
    semanticBuffer = [];
  }

  captureMode = mode;
  bumpRecordingGeneration();

  if (mode === 'semantic') {
    startSemanticCapture();
  } else {
    startFullCapture();
  }
}

async function init(): Promise<void> {
  if (!isExtensionContextValid()) return;

  const { recordingPaused, captureMode: storedMode } = await chrome.storage.local.get([
    'recordingPaused',
    'captureMode',
  ]);
  const mode: CaptureMode = storedMode === 'semantic' ? 'semantic' : 'full';
  if (!recordingPaused) startRecording(mode);

  chrome.storage.onChanged.addListener((changes) => {
    if (!isExtensionContextValid()) {
      stopRecording();
      return;
    }

    if (changes.captureMode) {
      const nextMode: CaptureMode =
        changes.captureMode.newValue === 'semantic' ? 'semantic' : 'full';
      const { recordingPaused: paused } = changes;
      const isPaused = paused ? Boolean(paused.newValue) : undefined;
      if (isPaused === false || (isPaused === undefined && !recordingPaused)) {
        startRecording(nextMode);
      } else {
        captureMode = nextMode;
      }
      return;
    }

    if (!changes.recordingPaused) return;
    const paused = Boolean(changes.recordingPaused.newValue);
    if (paused) {
      stopRecording();
    } else {
      void chrome.storage.local.get(['captureMode']).then(({ captureMode: m }) => {
        startRecording(m === 'semantic' ? 'semantic' : 'full');
      });
    }
  });
}

init();
