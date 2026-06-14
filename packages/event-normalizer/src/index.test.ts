import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprintSteps, normalizeEvents, segmentWorkflows, filterNoiseSteps, collapseRedundantNavigates } from './index.ts';

const TS = 1_700_000_000_000;
const IDLE_GAP_MS = 90_000;

function meta(href: string) {
  return { type: 4, timestamp: TS, data: { href, width: 1280, height: 800 } };
}

function fullSnapshot() {
  return {
    type: 2,
    timestamp: TS + 1,
    data: {
      node: {
        id: 1,
        type: 0,
        childNodes: [
          {
            id: 2,
            type: 2,
            tagName: 'html',
            attributes: {},
            childNodes: [
              {
                id: 3,
                type: 2,
                tagName: 'body',
                attributes: {},
                childNodes: [
                  {
                    id: 10,
                    type: 2,
                    tagName: 'select',
                    attributes: { name: 'country', id: 'country-select' },
                    childNodes: [],
                  },
                  {
                    id: 11,
                    type: 2,
                    tagName: 'input',
                    attributes: { name: 'email', type: 'text' },
                    childNodes: [],
                  },
                  {
                    id: 12,
                    type: 2,
                    tagName: 'input',
                    attributes: { name: 'subscribe', type: 'checkbox' },
                    childNodes: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  };
}

test('normalizeEvents emits select for dropdown and checkbox', () => {
  const events = [
    meta('https://app.example.com/form'),
    fullSnapshot(),
    {
      type: 3,
      timestamp: TS + 2,
      data: { source: 5, id: 10, text: 'US', isChecked: false },
    },
    {
      type: 3,
      timestamp: TS + 3,
      data: { source: 5, id: 11, text: 'user@example.com', isChecked: false },
    },
    {
      type: 3,
      timestamp: TS + 4,
      data: { source: 5, id: 12, text: 'on', isChecked: true },
    },
  ];

  const steps = normalizeEvents(events);
  assert.equal(steps.length, 4);
  assert.equal(steps[0].action, 'navigate');
  assert.equal(steps[1].action, 'select');
  assert.equal(steps[1].target?.name, 'country');
  assert.equal(steps[1].value, 'US');
  assert.equal(steps[2].action, 'fill');
  assert.equal(steps[2].target?.name, 'email');
  assert.equal(steps[3].action, 'select');
  assert.equal(steps[3].value, true);
});

test('normalizeEvents ignores small scroll deltas', () => {
  const events = [
    meta('https://app.example.com/page'),
    fullSnapshot(),
    { type: 3, timestamp: TS + 2, data: { source: 3, id: 3, x: 0, y: 0 } },
    { type: 3, timestamp: TS + 3, data: { source: 3, id: 3, x: 0, y: 40 } },
    { type: 3, timestamp: TS + 4, data: { source: 3, id: 3, x: 0, y: 250 } },
  ];

  const steps = normalizeEvents(events);
  const scrolls = steps.filter((s) => s.action === 'scroll');
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0].target?.tag, 'body');
  assert.equal(scrolls[0].value, 250);
});

test('fingerprintSteps includes scroll and select targets', () => {
  const fp = fingerprintSteps([
    { action: 'navigate', url: 'https://app.example.com/reports', occurredAt: '' },
    { action: 'scroll', target: { tag: 'body' }, occurredAt: '' },
    { action: 'select', target: { name: 'period' }, occurredAt: '' },
    { action: 'click', target: { text: 'Export' }, occurredAt: '' },
  ]);
  assert.match(fp, /scroll:body/);
  assert.match(fp, /select:period/);
});

function loginSnapshot() {
  return {
    type: 2,
    timestamp: TS + 1,
    data: {
      node: {
        id: 1,
        type: 0,
        childNodes: [
          {
            id: 2,
            type: 2,
            tagName: 'html',
            attributes: {},
            childNodes: [
              {
                id: 3,
                type: 2,
                tagName: 'body',
                attributes: {},
                childNodes: [
                  {
                    id: 11,
                    type: 2,
                    tagName: 'input',
                    attributes: { name: 'email', type: 'text' },
                    childNodes: [],
                  },
                  {
                    id: 12,
                    type: 2,
                    tagName: 'button',
                    attributes: { type: 'submit', name: 'login' },
                    childNodes: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  };
}

function click(id: number, offset: number) {
  return { type: 3, timestamp: TS + offset, data: { source: 2, type: 2, id } };
}

function fill(id: number, text: string, offset: number) {
  return { type: 3, timestamp: TS + offset, data: { source: 5, id, text, isChecked: false } };
}

test('segmentWorkflows splits on cross-origin navigation', () => {
  const events = [
    meta('https://app.example.com/reports'),
    fullSnapshot(),
    fill(11, 'weekly', 2),
    click(10, 3),
    meta('https://other.example.com/settings'),
    click(10, 4),
  ];

  const segments = segmentWorkflows(events);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].steps[0].action, 'navigate');
  assert.match(segments[0].steps[0].url ?? '', /reports/);
  assert.equal(segments[1].steps[0].action, 'navigate');
  assert.match(segments[1].steps[0].url ?? '', /other\.example\.com/);
});

test('segmentWorkflows keeps same-origin navigation in one workflow', () => {
  const events = [
    meta('https://www.google.com/'),
    fullSnapshot(),
    fill(11, 'fifa world cup 2026', 2),
    meta('https://www.google.com/search?q=fifa+world+cup+2026'),
    click(10, 3),
    click(10, 4),
  ];

  const segments = segmentWorkflows(events);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].steps[0].action, 'navigate');
  assert.equal(segments[0].steps.filter((s) => s.action === 'fill').length, 1);
  assert.equal(segments[0].steps.filter((s) => s.action === 'click').length, 2);
  assert.equal(segments[0].steps.filter((s) => s.action === 'navigate').length, 2);
});

test('segmentWorkflows ends login workflow on submit plus same-origin navigation', () => {
  const events = [
    meta('https://app.example.com/login'),
    loginSnapshot(),
    fill(11, 'user@example.com', 2),
    click(12, 3),
    meta('https://app.example.com/dashboard'),
    fullSnapshot(),
    click(11, 4),
  ];

  const segments = segmentWorkflows(events);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].steps.some((s) => s.action === 'submit'), true);
  assert.equal(segments[0].steps.filter((s) => s.action === 'navigate').length, 2);
  assert.equal(segments[0].steps.at(-1)?.action, 'click');
});

test('normalizeEvents captures click text from child text nodes', () => {
  const events = [
    meta('https://www.google.com/search?q=fifa'),
    {
      type: 2,
      timestamp: TS + 1,
      data: {
        node: {
          id: 1,
          type: 0,
          childNodes: [
            {
              id: 2,
              type: 2,
              tagName: 'html',
              attributes: {},
              childNodes: [
                {
                  id: 3,
                  type: 2,
                  tagName: 'body',
                  attributes: {},
                  childNodes: [
                    {
                      id: 20,
                      type: 2,
                      tagName: 'a',
                      attributes: { role: 'tab' },
                      childNodes: [
                        { id: 21, type: 3, textContent: 'Estadísticas' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
    { type: 3, timestamp: TS + 2, data: { source: 2, type: 2, id: 20 } },
  ];

  const steps = normalizeEvents(events);
  const click = steps.find((s) => s.action === 'click');
  assert.equal(click?.target?.text, 'Estadísticas');
});

test('filterNoiseSteps removes icon clicks and keeps labeled clicks', () => {
  const steps = [
    { action: 'click' as const, target: { tag: 'svg' }, occurredAt: '' },
    { action: 'click' as const, target: { tag: 'span', text: 'Estadísticas' }, occurredAt: '' },
    { action: 'click' as const, target: { tag: 'div' }, occurredAt: '' },
    {
      action: 'click' as const,
      target: { tag: 'input', ariaLabel: 'Compartir vínculo' },
      occurredAt: '',
    },
  ];

  const filtered = filterNoiseSteps(steps);
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].target?.text, 'Estadísticas');
  assert.equal(filtered[1].target?.ariaLabel, 'Compartir vínculo');
});

test('collapseRedundantNavigates merges same-path navigations', () => {
  const steps = [
    { action: 'navigate' as const, url: 'https://www.google.com/search?q=a', occurredAt: '' },
    { action: 'click' as const, target: { text: 'Estadísticas' }, occurredAt: '' },
    {
      action: 'navigate' as const,
      url: 'https://www.google.com/search?q=estadisticas&si=abc',
      occurredAt: '',
    },
    { action: 'click' as const, target: { ariaLabel: 'Compartir vínculo' }, occurredAt: '' },
  ];

  const collapsed = collapseRedundantNavigates(steps);
  assert.equal(collapsed.length, 3);
  assert.equal(collapsed[0].action, 'navigate');
  assert.match(collapsed[0].url ?? '', /estadisticas/);
});

test('google journey normalizes to a stable fingerprint', () => {
  const googleHomeSnapshot = () => ({
    type: 2,
    timestamp: TS + 1,
    data: {
      node: {
        id: 1,
        type: 0,
        childNodes: [
          {
            id: 2,
            type: 2,
            tagName: 'html',
            attributes: {},
            childNodes: [
              {
                id: 3,
                type: 2,
                tagName: 'body',
                attributes: {},
                childNodes: [
                  {
                    id: 11,
                    type: 2,
                    tagName: 'textarea',
                    attributes: { name: 'q', 'aria-label': 'Buscar' },
                    childNodes: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  });

  const events = [
    meta('https://www.google.com/'),
    googleHomeSnapshot(),
    fill(11, 'fifa world cup 2026', 2),
    meta('https://www.google.com/search?q=fifa+world+cup+2026'),
    {
      type: 3,
      timestamp: TS + 3,
      data: {
        source: 0,
        adds: [
          {
            node: {
              id: 20,
              type: 2,
              tagName: 'span',
              attributes: {},
              childNodes: [{ id: 21, type: 3, textContent: 'Estadísticas' }],
            },
          },
        ],
      },
    },
    { type: 3, timestamp: TS + 4, data: { source: 2, type: 2, id: 20 } },
    meta('https://www.google.com/search?q=estadisticas&si=abc'),
    {
      type: 3,
      timestamp: TS + 5,
      data: {
        source: 0,
        adds: [
          {
            node: {
              id: 30,
              type: 2,
              tagName: 'span',
              attributes: { 'aria-label': 'Más opciones para Copa Mundial de Fútbol de 2026' },
              childNodes: [],
            },
          },
        ],
      },
    },
    { type: 3, timestamp: TS + 6, data: { source: 2, type: 2, id: 30 } },
    {
      type: 3,
      timestamp: TS + 7,
      data: {
        source: 0,
        adds: [
          {
            node: {
              id: 40,
              type: 2,
              tagName: 'input',
              attributes: { 'aria-label': 'Compartir vínculo' },
              childNodes: [],
            },
          },
        ],
      },
    },
    { type: 3, timestamp: TS + 8, data: { source: 2, type: 2, id: 40 } },
    {
      type: 3,
      timestamp: TS + 9,
      data: {
        source: 0,
        adds: [{ node: { id: 50, type: 2, tagName: 'svg', attributes: {}, childNodes: [] } }],
      },
    },
    { type: 3, timestamp: TS + 10, data: { source: 2, type: 2, id: 50 } },
  ];

  const steps = normalizeEvents(events);
  const fp = fingerprintSteps(steps);
  assert.match(fp, /fill:buscar/);
  assert.match(fp, /estadísticas/);
  assert.match(fp, /compartir vínculo/);
  assert.doesNotMatch(fp, /click:svg/);
  assert.equal(steps.filter((s) => s.action === 'navigate').length, 2);
});

test('segmentWorkflows still splits on idle gap', () => {
  const events = [
    meta('https://app.example.com/a'),
    fullSnapshot(),
    click(10, 2),
    { type: 3, timestamp: TS + 2 + IDLE_GAP_MS + 1, data: { source: 2, type: 2, id: 10 } },
  ];

  const segments = segmentWorkflows(events);
  assert.equal(segments.length, 2);
});
