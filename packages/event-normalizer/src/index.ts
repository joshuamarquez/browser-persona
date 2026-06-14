import type { RrwebEvent, SemanticStep, StepTarget } from '@browser-persona/shared';

const IDLE_GAP_MS = 90_000;
const SCROLL_DELTA_THRESHOLD_PX = 100;

/** rrweb EventType.FullSnapshot */
const RRWEB_FULL_SNAPSHOT = 2;
/** rrweb EventType.IncrementalSnapshot */
const RRWEB_INCREMENTAL = 3;
/** rrweb EventType.Meta */
const RRWEB_META = 4;

/** rrweb IncrementalSource */
const SOURCE_MUTATION = 0;
const SOURCE_MOUSE_INTERACTION = 2;
const SOURCE_SCROLL = 3;
const SOURCE_INPUT = 5;

/** rrweb NodeType.Element */
const ELEMENT_NODE_TYPE = 2;
/** rrweb MouseInteractions.Click */
const MOUSE_CLICK = 2;

interface StoredEvent extends RrwebEvent {
  id?: number;
}

interface SerializedNode {
  id?: number;
  type?: number;
  tagName?: string;
  textContent?: string;
  attributes?: Record<string, string | number | true | null>;
  childNodes?: SerializedNode[];
}

/** rrweb NodeType.Text */
const TEXT_NODE_TYPE = 3;

interface NodeMeta {
  tagName?: string;
  inputType?: string;
  name?: string;
  ariaLabel?: string;
  text?: string;
}

const MAX_TARGET_TEXT_LEN = 120;
const MAX_CLICK_LABEL_LEN = 80;

/** Icon / layout tags that are not useful automation targets on their own. */
const NOISE_CLICK_TAGS = new Set(['svg', 'path', 'g', 'circle', 'rect', 'line', 'polygon']);

function clickLabel(step: SemanticStep): string {
  const t = step.target;
  if (!t) return '';
  return (t.text ?? t.ariaLabel ?? t.name ?? '').trim();
}

/** Drop icon-only and unlabeled container clicks that vary between runs. */
export function isNoiseClick(step: SemanticStep): boolean {
  if (step.action !== 'click' && step.action !== 'submit') return false;
  const label = clickLabel(step);
  if (label.length > MAX_CLICK_LABEL_LEN) return true;
  if (label) return false;

  const tag = step.target?.tag?.toLowerCase();
  if (tag && NOISE_CLICK_TAGS.has(tag)) return true;
  if (tag === 'div' || tag === 'span') return true;
  return false;
}

export function filterNoiseSteps(steps: SemanticStep[]): SemanticStep[] {
  return steps.filter((s) => !isNoiseClick(s));
}

function navigatePathKey(step: SemanticStep): string {
  if (!step.url) return '';
  try {
    const u = new URL(step.url);
    return `${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return step.url.toLowerCase();
  }
}

/** Repeated navigations to the same path collapse to the latest URL. */
export function collapseRedundantNavigates(steps: SemanticStep[]): SemanticStep[] {
  const out: SemanticStep[] = [];
  const navigateIndexByPath = new Map<string, number>();

  for (const step of steps) {
    if (step.action === 'navigate') {
      const key = navigatePathKey(step);
      const existingIdx = navigateIndexByPath.get(key);
      if (existingIdx != null) {
        out[existingIdx] = step;
        continue;
      }
      navigateIndexByPath.set(key, out.length);
    }
    out.push(step);
  }
  return out;
}

function collectVisibleText(node: SerializedNode): string {
  if (node.type === TEXT_NODE_TYPE) {
    return typeof node.textContent === 'string' ? node.textContent.trim() : '';
  }
  if (node.type !== ELEMENT_NODE_TYPE) return '';

  const parts: string[] = [];
  for (const child of node.childNodes ?? []) {
    const chunk = collectVisibleText(child);
    if (chunk) parts.push(chunk);
  }
  return parts.join(' ').trim().slice(0, MAX_TARGET_TEXT_LEN);
}

class NodeIndex {
  private readonly nodes = new Map<number, NodeMeta>();

  ingestNode(node: SerializedNode): void {
    if (node.id == null) return;

    if (node.type === ELEMENT_NODE_TYPE && node.tagName) {
      const attrs = node.attributes ?? {};
      const visibleText = collectVisibleText(node);
      this.nodes.set(node.id, {
        tagName: node.tagName.toLowerCase(),
        inputType: stringAttr(attrs.type),
        name: stringAttr(attrs.name) ?? stringAttr(attrs.id),
        ariaLabel: stringAttr(attrs['aria-label']),
        text: visibleText || undefined,
      });
    }

    for (const child of node.childNodes ?? []) {
      this.ingestNode(child);
    }
  }

  ingestMutation(data: {
    adds?: Array<{ node: SerializedNode }>;
    removes?: Array<{ id: number }>;
    attributes?: Array<{ id: number; attributes: Record<string, string | number | true | null> }>;
  }): void {
    for (const add of data.adds ?? []) {
      this.ingestNode(add.node);
    }
    for (const remove of data.removes ?? []) {
      this.nodes.delete(remove.id);
    }
    for (const attr of data.attributes ?? []) {
      const meta = this.nodes.get(attr.id);
      if (!meta) continue;
      const attrs = attr.attributes;
      const name = stringAttr(attrs.name);
      const inputType = stringAttr(attrs.type);
      const ariaLabel = stringAttr(attrs['aria-label']);
      if (name) meta.name = name;
      if (inputType) meta.inputType = inputType;
      if (ariaLabel) meta.ariaLabel = ariaLabel;
    }
  }

  targetForId(id: number): StepTarget {
    const meta = this.nodes.get(id);
    return {
      name: meta?.name,
      tag: meta?.tagName,
      ariaLabel: meta?.ariaLabel,
      text: meta?.text,
    };
  }

  isSelectLike(id: number): boolean {
    const meta = this.nodes.get(id);
    if (!meta) return false;
    if (meta.tagName === 'select') return true;
    if (meta.tagName === 'input') {
      const inputType = meta.inputType ?? 'text';
      return inputType === 'checkbox' || inputType === 'radio';
    }
    return false;
  }

  isCheckboxOrRadio(id: number): boolean {
    const meta = this.nodes.get(id);
    if (!meta || meta.tagName !== 'input') return false;
    const inputType = meta.inputType ?? 'text';
    return inputType === 'checkbox' || inputType === 'radio';
  }

  isSubmitLike(id: number): boolean {
    const meta = this.nodes.get(id);
    if (!meta) return false;
    if (meta.tagName === 'input') {
      const inputType = meta.inputType ?? 'text';
      return inputType === 'submit' || inputType === 'image';
    }
    if (meta.tagName === 'button') {
      const inputType = meta.inputType;
      return !inputType || inputType === 'submit';
    }
    return false;
  }
}

function stringAttr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Stable URL key for segmentation boundaries (origin + path + query). */
function urlSegmentKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Cross-origin navigation starts a new workflow; same-site page changes stay together. */
function isCrossOriginNavigation(from: string, to: string): boolean {
  return urlOrigin(from) !== urlOrigin(to);
}

function extractMetaHref(event: StoredEvent): string | undefined {
  if (event.type !== RRWEB_META || !event.data || typeof event.data !== 'object') return undefined;
  return (event.data as { href?: string }).href;
}

/** Extract hostname from URL */
function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Build stable fingerprint from semantic steps */
export function fingerprintSteps(steps: SemanticStep[]): string {
  return steps
    .map((s) => {
      const targetKey =
        s.target?.text ??
        s.target?.ariaLabel ??
        s.target?.selector ??
        s.target?.name ??
        s.target?.tag ??
        '';
      const urlKey = s.url ? domainFromUrl(s.url) + new URL(s.url).pathname : '';
      return `${s.action}:${targetKey || urlKey}`.toLowerCase();
    })
    .join('|');
}

/** Redact known sensitive field names */
export function redactValue(fieldName: string | undefined, value: string): string {
  if (!fieldName) return value;
  const lower = fieldName.toLowerCase();
  if (lower.includes('password') || lower.includes('ssn') || lower.includes('credit')) {
    return '[REDACTED]';
  }
  return value;
}

/**
 * Convert rrweb incremental events into semantic steps.
 * Uses full snapshots + mutation adds to map node ids to tags for select vs fill.
 */
export function normalizeEvents(events: StoredEvent[]): SemanticStep[] {
  const steps: SemanticStep[] = [];
  const nodeIndex = new NodeIndex();
  const lastScrollPos = new Map<number, { x: number; y: number }>();
  let currentUrl: string | undefined;

  for (const event of events) {
    const ts = new Date(event.timestamp).toISOString();

    if (event.type === RRWEB_FULL_SNAPSHOT && event.data && typeof event.data === 'object') {
      const node = (event.data as { node?: SerializedNode }).node;
      if (node) nodeIndex.ingestNode(node);
      continue;
    }

    if (event.type === RRWEB_META && event.data && typeof event.data === 'object') {
      const href = (event.data as { href?: string }).href;
      if (href) {
        currentUrl = href;
        steps.push({ action: 'navigate', url: href, occurredAt: ts });
      }
      continue;
    }

    if (event.type !== RRWEB_INCREMENTAL || !event.data || typeof event.data !== 'object') continue;
    const data = event.data as {
      source?: number;
      type?: number;
      id?: number;
      text?: string;
      isChecked?: boolean;
      x?: number;
      y?: number;
      adds?: Array<{ node: SerializedNode }>;
      removes?: Array<{ id: number }>;
      attributes?: Array<{ id: number; attributes: Record<string, string | number | true | null> }>;
    };

    if (data.source === SOURCE_MUTATION) {
      nodeIndex.ingestMutation(data);
      continue;
    }

    if (data.source === SOURCE_MOUSE_INTERACTION && data.type === MOUSE_CLICK) {
      const target: StepTarget = data.id != null ? nodeIndex.targetForId(data.id) : { text: data.text };
      if (data.text && !target.text) target.text = data.text;
      const action = data.id != null && nodeIndex.isSubmitLike(data.id) ? 'submit' : 'click';
      steps.push({
        action,
        target,
        url: currentUrl,
        occurredAt: ts,
      });
      continue;
    }

    if (data.source === SOURCE_SCROLL && data.id != null) {
      const x = data.x ?? 0;
      const y = data.y ?? 0;
      const prev = lastScrollPos.get(data.id);
      lastScrollPos.set(data.id, { x, y });

      if (prev) {
        const dx = Math.abs(x - prev.x);
        const dy = Math.abs(y - prev.y);
        if (dx >= SCROLL_DELTA_THRESHOLD_PX || dy >= SCROLL_DELTA_THRESHOLD_PX) {
          steps.push({
            action: 'scroll',
            target: nodeIndex.targetForId(data.id),
            value: y,
            url: currentUrl,
            occurredAt: ts,
          });
        }
      }
      continue;
    }

    if (data.source === SOURCE_INPUT && data.id != null) {
      const target = nodeIndex.targetForId(data.id);

      if (nodeIndex.isSelectLike(data.id)) {
        const fieldName = target.name ?? target.ariaLabel;
        const value = nodeIndex.isCheckboxOrRadio(data.id)
          ? Boolean(data.isChecked)
          : redactValue(fieldName, data.text ?? '');

        steps.push({
          action: 'select',
          target,
          value,
          url: currentUrl,
          occurredAt: ts,
        });
        continue;
      }

      if (typeof data.text === 'string') {
        const fieldName = target.name ?? target.ariaLabel;
        steps.push({
          action: 'fill',
          target,
          value: redactValue(fieldName, data.text),
          url: currentUrl,
          occurredAt: ts,
        });
      }
    }
  }

  return collapseRedundantNavigates(collapseDuplicateSteps(filterNoiseSteps(steps)));
}

function sameTarget(a: SemanticStep, b: SemanticStep): boolean {
  const key = (s: SemanticStep) =>
    s.target?.name ?? s.target?.tag ?? s.target?.text ?? s.target?.ariaLabel ?? '';
  return key(a) === key(b);
}

function collapseDuplicateSteps(steps: SemanticStep[]): SemanticStep[] {
  const out: SemanticStep[] = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    const collapsible = step.action === 'fill' || step.action === 'select' || step.action === 'scroll';
    if (prev && collapsible && prev.action === step.action && sameTarget(prev, step)) {
      out[out.length - 1] = step;
    } else {
      out.push(step);
    }
  }
  return out;
}

export interface WorkflowSegment {
  steps: SemanticStep[];
  startedAt: string;
  endedAt: string;
  primaryDomain: string;
  fingerprint: string;
}

/** Split event stream into workflows by idle gap, navigation, or submit + navigation. */
export function segmentWorkflows(events: StoredEvent[]): WorkflowSegment[] {
  if (events.length === 0) return [];

  const segments: WorkflowSegment[] = [];
  let buffer: StoredEvent[] = [];
  let segmentUrl: string | undefined;

  const flush = () => {
    if (buffer.length === 0) return;
    const steps = normalizeEvents(buffer);
    if (steps.length === 0) {
      buffer = [];
      segmentUrl = undefined;
      return;
    }
    const firstUrl = steps.find((s) => s.url)?.url ?? '';
    segments.push({
      steps,
      startedAt: steps[0].occurredAt,
      endedAt: steps[steps.length - 1].occurredAt,
      primaryDomain: firstUrl ? domainFromUrl(firstUrl) : '',
      fingerprint: fingerprintSteps(steps),
    });
    buffer = [];
    segmentUrl = undefined;
  };

  for (const event of events) {
    if (buffer.length > 0) {
      const gap = event.timestamp - buffer[buffer.length - 1].timestamp;
      if (gap > IDLE_GAP_MS) flush();
    }

    const href = extractMetaHref(event);
    if (
      href &&
      buffer.length > 0 &&
      segmentUrl &&
      urlSegmentKey(segmentUrl) !== urlSegmentKey(href) &&
      isCrossOriginNavigation(segmentUrl, href)
    ) {
      // Leaving the site ends the workflow; same-origin navigations stay in one journey.
      flush();
    }

    if (href) segmentUrl = href;
    buffer.push(event);
  }
  flush();

  return segments;
}
