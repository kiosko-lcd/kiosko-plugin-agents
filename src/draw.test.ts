import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBaseContext, DEFAULT_THEME, validate, type Graphics, type RenderContext, type StateContext } from '@kiosko/sdk';
import { scenario } from './demo.ts';
import { sessionsWidget, summaryWidget } from './index.ts';
import { filterSessions, SESSIONS_SOURCE, type SessionView } from './types.ts';

const NOW = new Date(2026, 10, 5, 21, 5).getTime();

/** A context whose canvas and kit only record the text drawn. */
function recorder(widget: typeof sessionsWidget | typeof summaryWidget, options: Record<string, unknown>, o: { sessions?: SessionView[]; locale?: string; timeFormat?: '24h' | '12h'; box?: { x: number; y: number; w: number; h: number } } = {}) {
  const texts: string[] = [];
  const g = new Proxy({} as Record<string, unknown>, {
    get: (target, k) => (k in target ? target[k as string] : () => undefined),
    set: (target, k, v) => ((target[k as string] = v), true),
  }) as unknown as Graphics;
  const record = (_g: unknown, s: string) => (texts.push(s), 10);
  const kit = {
    truncate: (_g: unknown, s: string) => s,
    wrapLines: (_g: unknown, s: string) => [s],
    fitSize: (_g: unknown, _s: string, _w: number, f: { size: number }) => f.size,
    measureTracked: () => 10,
    drawTracked: record,
    drawClipped: record,
    css: () => '#000000',
    hex: () => [0, 0, 0],
  };
  const sessions = o.sessions ?? scenario('threeClaim', NOW);
  const ctx = {
    ...createBaseContext({ now: NOW, locale: o.locale ?? 'en', timeFormat: o.timeFormat ?? '24h' }),
    box: o.box ?? { x: 0, y: 0, w: 1500, h: 390 },
    options: validate(widget.options!, options).value,
    theme: DEFAULT_THEME,
    fonts: DEFAULT_THEME.fonts,
    kit,
    sources: { [SESSIONS_SOURCE]: { sessions }, 'system/vitals': { mem: { used: 44 * 1024 ** 3, total: 62 * 1024 ** 3 } } },
    working: true,
    preview: false,
  } as unknown as RenderContext<never, never>;
  return { g, ctx, texts };
}

const state = (widget: typeof sessionsWidget, options: Record<string, unknown>, sessions: SessionView[]) =>
  ({ options: validate(widget.options!, options).value, data: undefined, sources: { [SESSIONS_SOURCE]: { sessions } }, now: NOW, working: true }) as unknown as StateContext<never, never>;

test('filterSessions: projects by name, repo or folder; states left out; meetings have no project', () => {
  const all = scenario('meeting', NOW);
  const names = (f: Parameters<typeof filterSessions>[1]) => filterSessions(all, f).map((s) => s.project);
  assert.deepEqual(names({}), ['Architecture review', 'web-app', 'api-gateway']);
  assert.deepEqual(names({ projects: ['web-*'] }), ['Architecture review', 'web-app']);
  assert.deepEqual(names({ projects: ['!web-app'] }), ['Architecture review', 'api-gateway']);
  assert.deepEqual(names({ projects: ['/home/user/dev/api-*'] }), ['Architecture review', 'api-gateway'], 'by its folder');
  assert.deepEqual(names({ hideStates: ['active', 'waiting'] }), ['web-app']);
});

test('sessions: the filter decides what is drawn, urgent, idle and empty', () => {
  const r = recorder(sessionsWidget, { projects: ['web-app', 'docs-*'] });
  sessionsWidget.render(r.g, r.ctx);
  assert.ok(r.texts.includes('web-app') && r.texts.includes('docs-site'));
  assert.ok(!r.texts.includes('infra') && !r.texts.includes('api-gateway'));
  const all = scenario('threeClaim', NOW);
  assert.equal(sessionsWidget.urgent!(state(sessionsWidget, {}, all)), true, 'infra waits for a permission');
  assert.equal(sessionsWidget.urgent!(state(sessionsWidget, { projects: ['!infra'] }, all)), false, 'not this widget\'s business');
  assert.equal(sessionsWidget.empty!(state(sessionsWidget, { hideStates: ['permission', 'waiting', 'ready', 'active'] }, all)), true);
  assert.equal(sessionsWidget.idle!(state(sessionsWidget, { projects: ['nothing-like-this'] }, all)), true);
  const none = recorder(sessionsWidget, { projects: ['nothing-like-this'] }, { locale: 'es' });
  sessionsWidget.render(none.g, none.ctx);
  assert.deepEqual(none.texts, ['Sin sesiones de agentes']);
});

test('sessions: maxTiles sends the rest to the summary column; ids and detail can go', () => {
  const r = recorder(sessionsWidget, { maxTiles: 2 });
  sessionsWidget.render(r.g, r.ctx);
  assert.ok(r.texts.includes('+2 more'), r.texts.join('|'));
  const full = recorder(sessionsWidget, {});
  sessionsWidget.render(full.g, full.ctx);
  assert.ok(full.texts.includes('CLAUDE · A1B2C3'));
  assert.ok(full.texts.includes('Waiting for your input'));
  const bare = recorder(sessionsWidget, { showId: false, detailLines: 0 });
  sessionsWidget.render(bare.g, bare.ctx);
  assert.ok(!bare.texts.some((s) => s.includes('A1B2C3')));
  assert.ok(!bare.texts.includes('Waiting for your input'));
  assert.ok(bare.texts.includes('web-app'));
});

test('sessions: times through ctx.fmt, a meeting\'s start in the configured clock', () => {
  const r = recorder(sessionsWidget, {}, { sessions: scenario('meeting', NOW), timeFormat: '12h' });
  sessionsWidget.render(r.g, r.ctx);
  assert.ok(r.texts.includes('9:09 PM'), r.texts.join('|'));
  assert.ok(r.texts.includes('4 min'), 'a countdown rounds up');
  assert.ok(r.texts.includes('2 min'));
});

test('summary: parts can go, the clock follows the time format, projects filter the counts', () => {
  const all = recorder(summaryWidget, {}, { timeFormat: '12h' });
  summaryWidget.render(all.g, all.ctx);
  assert.equal(all.texts[0], '9:05 PM');
  assert.ok(all.texts.includes('RAM: 44GB/62GB'));
  assert.ok(all.texts.includes('4 consoles'));
  assert.ok(all.texts.includes('3 waiting for you'));
  const lean = recorder(summaryWidget, { showRam: false, showConsoles: false, showClock: false, projects: ['infra'] }, { locale: 'es' });
  summaryWidget.render(lean.g, lean.ctx);
  assert.deepEqual(lean.texts, ['1 te espera']);
});
