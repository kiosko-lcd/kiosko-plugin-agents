import { join as pathJoin } from 'node:path';
/**
 * The passive readers against fixtures built from each agent's documented
 * format (see the comment at the top of each reader for the sources).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCodexReader } from './readers/codex.ts';
import { createKimiReader } from './readers/kimi.ts';
import { createQwenReader, sidecarSaysEnded } from './readers/qwen.ts';
import { createStatusReader, parseStatus, STATUS_MAX_BYTES } from './readers/status.ts';
import { fixHookState, loadSessions, passiveRoot } from './source.ts';
import type { SessionView } from './types.ts';

const iso = (ms: number) => new Date(ms).toISOString();
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'agents-readers-'));
}

function write(path: string, text: string, mtime?: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  if (mtime !== undefined) utimesSync(path, mtime / 1000, mtime / 1000);
}

/** codex-rs/rollout/src/recorder.rs: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<uuid>.jsonl`. */
function rolloutPath(root: string, at: number, id: string): string {
  const d = new Date(at);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  return join(root, 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()), `rollout-${stamp}-${id}.jsonl`);
}

const meta = (id: string, cwd: string, at: number, source: unknown = 'cli') => ({
  timestamp: iso(at),
  type: 'session_meta',
  payload: { session_id: id, id, timestamp: iso(at), cwd, originator: 'codex_cli_rs', cli_version: '0.80.0', source, model_provider: 'ollama' },
});
const ev = (at: number, payload: object) => ({ timestamp: iso(at), type: 'event_msg', payload });
const item = (at: number, payload: object) => ({ timestamp: iso(at), type: 'response_item', payload });

test('codex: a turn in progress, a finished one and an interrupted one; sub-agents and old logs left out', () => {
  const root = tmp();
  const now = Date.now();
  try {
    const A = '0199a1b2-0000-7000-8000-00000000000a';
    const B = '0199a1b2-0000-7000-8000-00000000000b';
    const C = '0199a1b2-0000-7000-8000-00000000000c';
    const D = '0199a1b2-0000-7000-8000-00000000000d';
    const E = '0199a1b2-0000-7000-8000-00000000000e';
    write(rolloutPath(root, now - 60_000, A), jsonl([
      meta(A, '/home/u/api', now - 60_000),
      { timestamp: iso(now - 50_000), type: 'turn_context', payload: { cwd: '/home/u/api', model: 'gpt-oss:20b' } },
      ev(now - 50_000, { type: 'task_started', turn_id: 't1' }),
      ev(now - 50_000, { type: 'user_message', message: 'run the tests' }),
      item(now - 40_000, { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }), call_id: 'c1' }),
    ]));
    write(rolloutPath(root, now - 120_000, B), jsonl([
      meta(B, '/home/u/web', now - 120_000),
      ev(now - 110_000, { type: 'task_started', turn_id: 't1' }),
      ev(now - 30_000, { type: 'task_complete', turn_id: 't1', last_agent_message: 'All green. token=abc123' }),
    ]));
    write(rolloutPath(root, now - 90_000, C), jsonl([
      meta(C, '/home/u/notes', now - 90_000),
      ev(now - 80_000, { type: 'task_started', turn_id: 't1' }),
      ev(now - 20_000, { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' }),
    ]));
    write(rolloutPath(root, now - 90_000, D), jsonl([meta(D, '/home/u/api', now - 90_000, { subagent: 'review' }), ev(now - 80_000, { type: 'task_started', turn_id: 't1' })]));
    write(rolloutPath(root, now - 5 * 3_600_000, E), jsonl([meta(E, '/home/u/old', now - 5 * 3_600_000), ev(now - 5 * 3_600_000, { type: 'task_complete', turn_id: 't', last_agent_message: 'x' })]), now - 5 * 3_600_000);
    const got = createCodexReader()({ root, now, maxAgeMs: 30 * 60_000 });
    const by = Object.fromEntries(got.map((s) => [s.session_id, s]));
    assert.deepEqual(Object.keys(by).sort(), [A, B, C]);
    assert.equal(by[A]!.state, 'active');
    assert.equal(by[A]!.provider, 'codex');
    assert.equal(by[A]!.project, 'api');
    assert.equal(by[A]!.detail, 'exec_command: npm test');
    assert.ok(Math.abs(by[A]!.since - (now - 50_000)) < 1000, 'working since the turn started');
    assert.equal(by[B]!.state, 'ready');
    assert.equal(by[B]!.detail, 'All green. token=<hidden>', 'secrets redacted, as the hook does');
    assert.ok(Math.abs(by[B]!.since - (now - 30_000)) < 1000);
    assert.equal(by[C]!.state, 'waiting');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('codex: a log that is still being written is read up to its last complete line', () => {
  const root = tmp();
  const now = Date.now();
  try {
    const A = '0199a1b2-0000-7000-8000-0000000000aa';
    write(rolloutPath(root, now, A), jsonl([meta(A, '/home/u/api', now - 10_000), ev(now - 5_000, { type: 'task_started', turn_id: 't' })]) + '{"timestamp":"' + iso(now) + '","type":"event_msg","payload":{"type":"task_comp');
    const [s] = createCodexReader()({ root, now, maxAgeMs: 60_000 });
    assert.equal(s?.state, 'active');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** packages/core/src/utils/paths.ts `sanitizeCwd` + config/storage.ts `getProjectDir`. */
const qwenChats = (root: string, cwd: string) => join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'chats');
const qrec = (id: string, cwd: string, at: number, type: string, extra: object = {}) => ({ uuid: `${type}-${at}`, parentUuid: null, sessionId: id, timestamp: iso(at), type, cwd, version: '0.28.3', ...extra });

test('qwen: working while a tool runs, ready after the answer; ended sessions and sub-agent records left out', () => {
  const root = tmp();
  const now = Date.now();
  try {
    const cwd = '/home/u/web-app';
    const chats = qwenChats(root, cwd);
    write(join(chats, 'aaa.jsonl'), jsonl([
      qrec('aaa', cwd, now - 60_000, 'user', { message: { role: 'user', parts: [{ text: 'fix the build' }] } }),
      qrec('aaa', cwd, now - 50_000, 'assistant', { message: { role: 'model', parts: [{ text: 'thinking', thought: true }, { functionCall: { name: 'run_shell_command', args: { command: 'npm run build' } } }] } }),
    ]));
    write(join(chats, 'bbb.jsonl'), jsonl([
      qrec('bbb', cwd, now - 60_000, 'user', { message: { role: 'user', parts: [{ text: 'hi' }] } }),
      qrec('bbb', cwd, now - 40_000, 'tool_result', { message: { role: 'user', parts: [{ functionResponse: { name: 'read_file' } }] } }),
      qrec('bbb', cwd, now - 30_000, 'assistant', { message: { role: 'model', parts: [{ text: 'Done: the build is green.' }] } }),
      qrec('bbb', cwd, now - 20_000, 'assistant', { isSidechain: true, agentId: 'x', message: { role: 'model', parts: [{ functionCall: { name: 'grep' } }] } }),
    ]));
    write(join(chats, 'ccc.jsonl'), jsonl([qrec('ccc', cwd, now - 10_000, 'user', { message: { role: 'user', parts: [{ text: 'bye' }] } })]));
    // utils/runtimeStatus.ts: snake_case sidecar; this PID can't exist.
    write(join(chats, 'ccc.runtime.json'), JSON.stringify({ schema_version: 1, pid: 2 ** 22 + 12345, proc_start: null, pid_ns: null, session_id: 'ccc', work_dir: cwd, hostname: hostname(), started_at: now / 1000, qwen_version: '0.28.3' }));
    const got = createQwenReader()({ root, now, maxAgeMs: 30 * 60_000 });
    const by = Object.fromEntries(got.map((s) => [s.session_id, s]));
    assert.deepEqual(Object.keys(by).sort(), ['aaa', 'bbb']);
    assert.equal(by.aaa!.state, 'active');
    assert.equal(by.aaa!.detail, 'run_shell_command: npm run build');
    assert.equal(by.aaa!.project, 'web-app');
    assert.equal(by.bbb!.state, 'ready');
    assert.equal(by.bbb!.detail, 'Done: the build is green.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('qwen: a sidecar from another machine or with a live PID does not end the session', () => {
  const dir = tmp();
  try {
    const p = join(dir, 'x.runtime.json');
    writeFileSync(p, JSON.stringify({ pid: process.pid, hostname: hostname() }));
    assert.equal(sidecarSaysEnded(p), false);
    writeFileSync(p, JSON.stringify({ pid: 2 ** 22 + 1, hostname: 'elsewhere' }));
    assert.equal(sidecarSaysEnded(p), false);
    assert.equal(sidecarSaysEnded(p, 'elsewhere', () => false), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** src/kimi_cli/metadata.py: sessions/<md5(path)>/<id>/; wire/file.py: metadata line, then `{timestamp, message}`. */
const wire = (rows: [number, string, object][]) => jsonl([{ type: 'metadata', protocol_version: '1.4' }, ...rows.map(([at, type, payload]) => ({ timestamp: at / 1000, message: { type, payload } }))]);

test('kimi: permission pending, done, and a question; names from kimi.json', () => {
  const root = tmp();
  const now = Date.now();
  try {
    const cwd = '/home/u/infra';
    const hash = createHash('md5').update(cwd).digest('hex');
    write(join(root, 'kimi.json'), JSON.stringify({ work_dirs: [{ path: cwd, kaos: 'local', last_session_id: 's1' }] }));
    write(join(root, 'sessions', hash, 's1', 'wire.jsonl'), wire([
      [now - 60_000, 'TurnBegin', { user_input: 'restart nginx' }],
      [now - 55_000, 'StepBegin', { n: 1 }],
      [now - 50_000, 'ToolCall', { type: 'function', id: 'tc1', function: { name: 'Shell', arguments: '{"command":"sudo systemctl restart nginx"}' } }],
      [now - 49_000, 'ApprovalRequest', { id: 'ap1', tool_call_id: 'tc1', sender: 'Shell', action: 'run shell command', description: 'Run command `sudo systemctl restart nginx`', display: [] }],
    ]));
    write(join(root, 'sessions', hash, 's2', 'wire.jsonl'), wire([
      [now - 60_000, 'TurnBegin', { user_input: [{ type: 'text', text: 'tidy up' }] }],
      [now - 55_000, 'ApprovalRequest', { id: 'ap1', tool_call_id: 'tc1', sender: 'Shell', action: 'x', description: 'rm build/' }],
      [now - 54_000, 'ApprovalResponse', { request_id: 'ap1', response: 'approve' }],
      [now - 40_000, 'TurnEnd', {}],
    ]));
    write(join(root, 'sessions', 'ffffffffffffffffffffffffffffffff', 's3', 'wire.jsonl'), wire([
      [now - 30_000, 'TurnBegin', { user_input: 'plan it' }],
      [now - 20_000, 'QuestionRequest', { id: 'q1', tool_call_id: 'tc9', questions: [{ question: 'Keep the old API?', options: [] }] }],
    ]));
    const got = createKimiReader()({ root, now, maxAgeMs: 30 * 60_000 });
    const by = Object.fromEntries(got.map((s) => [s.session_id, s]));
    assert.equal(by.s1!.state, 'permission');
    assert.equal(by.s1!.project, 'infra');
    assert.equal(by.s1!.cwd, cwd);
    assert.equal(by.s1!.detail, 'Shell: Run command `sudo systemctl restart nginx`');
    assert.ok(Math.abs(by.s1!.since - (now - 49_000)) < 1000);
    assert.equal(by.s2!.state, 'ready');
    assert.equal(by.s3!.state, 'waiting');
    assert.equal(by.s3!.detail, 'Keep the old API?');
    assert.equal(by.s3!.cwd, undefined, 'a folder kimi.json does not name has no project path');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status files: friendly states, defaults, and everything suspicious ignored', () => {
  const root = tmp();
  const now = Date.now();
  try {
    write(join(root, 'opencode-ses_1.json'), JSON.stringify({ agent: 'opencode', id: 'ses_1', state: 'permission', cwd: '/home/u/web', detail: 'bash: npm publish', updated: now - 1000 }));
    write(join(root, 'mine.json'), JSON.stringify({ agent: 'My-Script', state: 'working' }));
    write(join(root, 'bad-state.json'), JSON.stringify({ agent: 'x', state: 'exploding' }));
    write(join(root, 'bad-agent.json'), JSON.stringify({ agent: '../etc', state: 'done' }));
    write(join(root, 'huge.json'), JSON.stringify({ agent: 'x', state: 'done', detail: 'a'.repeat(STATUS_MAX_BYTES) }));
    write(join(root, 'array.json'), '[1,2]');
    write(join(root, 'future.json'), JSON.stringify({ agent: 'clock', state: 'done', updated: now + 10 * 3_600_000 }));
    symlinkSync(join(root, 'mine.json'), join(root, 'link.json'));
    const read = createStatusReader();
    const got = read({ root, now, maxAgeMs: 30 * 60_000 });
    const by = Object.fromEntries(got.map((s) => [s.session_id, s]));
    assert.deepEqual(Object.keys(by).sort(), ['future', 'mine', 'ses_1']);
    assert.equal(by.ses_1!.state, 'permission');
    assert.equal(by.ses_1!.provider, 'opencode');
    assert.equal(by.ses_1!.project, 'web');
    assert.equal(by.mine!.state, 'active');
    assert.equal(by.mine!.provider, 'my-script');
    assert.ok(by.future!.updated <= now, 'a clock in the future is clamped');
    // `since` survives re-reads while the state holds.
    const first = by.mine!.since;
    const again = read({ root, now: now + 5000, maxAgeMs: 30 * 60_000 }).find((s) => s.session_id === 'mine');
    assert.equal(again?.since, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status files: parseStatus accepts the protocol names and ISO times', () => {
  const r = parseStatus({ agent: 'iflow', state: 'waiting', updated: '2026-11-21T10:00:00Z', since: '2026-11-21T09:58:00Z', cwd: 'relative/path' }, 'f', 0, Date.parse('2026-11-21T11:00:00Z'));
  assert.equal(r?.state, 'waiting');
  assert.equal(r?.updated, Date.parse('2026-11-21T10:00:00Z'));
  assert.equal(r?.since, Date.parse('2026-11-21T09:58:00Z'));
  assert.equal(r?.cwd, undefined, 'only absolute folders');
});

const hookRecord = (id: string, over: Partial<SessionView>, now: number): SessionView => ({ schemaVersion: 1, session_id: id, provider: 'codex', state: 'active', detail: 'Bash: rm -rf build', project: 'api', since: now - 60_000, updated: now - 1000, event: 'PreToolUse', ...over });

test('a PermissionRequest hook record (Codex, Qwen) is a permission prompt', () => {
  const now = Date.now();
  const r = fixHookState(hookRecord('x', { event: 'PermissionRequest' }, now));
  assert.equal(r.state, 'permission');
  assert.equal(r.since, now - 1000);
  assert.equal(fixHookState(hookRecord('y', {}, now)).state, 'active');
});

test('loadSessions: a session the hook reports wins over the same one read from its log', async () => {
  const dir = tmp();
  const now = Date.now();
  try {
    writeFileSync(join(dir, 'same.json'), JSON.stringify(hookRecord('same', { state: 'permission', event: 'Notification' }, now)));
    const passive = [hookRecord('same', { state: 'active', event: 'task_started' }, now), hookRecord('other', { state: 'ready', updated: now - 40 * 60_000 }, now), hookRecord('fresh', { state: 'ready' }, now)];
    const got = await loadSessions({ dir, zombieMs: 15 * 60_000, staleMs: 2 * 3_600_000, fileStaleMs: 30 * 60_000, reap: false }, undefined, now, undefined, passive);
    assert.deepEqual(got.map((s) => `${s.session_id}:${s.state}`).sort(), ['fresh:ready', 'same:permission']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('passiveRoot: option, then the agent’s own variable, then its default', () => {
  // Paths with this system's separator (Windows: \h\.codex).
  const p = (...parts: string[]) => pathJoin('/h', ...parts);
  assert.equal(passiveRoot('codex', '', {}, '/h'), p('.codex'));
  assert.equal(passiveRoot('codex', '', { CODEX_HOME: '/srv/codex' }, '/h'), '/srv/codex');
  assert.equal(passiveRoot('qwen', '~/q', { QWEN_RUNTIME_DIR: '/x' }, '/h'), p('q'));
  assert.equal(passiveRoot('kimi', '', { KIMI_SHARE_DIR: '/k' }, '/h'), '/k');
  assert.equal(passiveRoot('status', '', {}, '/h'), p('.config', 'kiosko', 'agents'));
});

test('the OpenCode plugin in docs/hooks writes status files the reader understands', async () => {
  const dir = tmp();
  const before = process.env.KIOSKO_AGENTS_STATUS_DIR;
  process.env.KIOSKO_AGENTS_STATUS_DIR = dir;
  try {
    const { KioskoAgents } = await import(`../docs/hooks/opencode-kiosko.js?${Date.now()}`);
    const hooks = await KioskoAgents({ directory: '/home/u/web-app' });
    const read = createStatusReader();
    const state = () => read({ root: dir, now: Date.now(), maxAgeMs: 60_000 }).map((s) => `${s.provider}/${s.session_id}:${s.state}:${s.project}`);
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } } });
    assert.deepEqual(state(), ['opencode/ses_1:active:web-app']);
    await hooks.event({ event: { type: 'permission.asked', properties: { id: 'p', sessionID: 'ses_1', permission: 'bash', patterns: ['npm publish'] } } });
    assert.deepEqual(state(), ['opencode/ses_1:permission:web-app']);
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
    assert.deepEqual(state(), ['opencode/ses_1:ready:web-app']);
    await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'ses_1' } } } });
    assert.deepEqual(state(), []);
  } finally {
    if (before === undefined) delete process.env.KIOSKO_AGENTS_STATUS_DIR;
    else process.env.KIOSKO_AGENTS_STATUS_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watchSessions: a passive log that changes repaints without waiting for the slow poll', async () => {
  const { watchSessions } = await import('./source.ts');
  const hookDir = tmp();
  const root = tmp();
  const seen: string[][] = [];
  const read = createStatusReader();
  write(join(root, 'a.json'), JSON.stringify({ agent: 'kimi', id: 'a', state: 'working' }));
  const stop = watchSessions(
    { dir: hookDir, git: false, zombieMs: 15 * 60_000, staleMs: 3_600_000, fileStaleMs: 30 * 60_000, reap: false, debounceMs: 10, pollMs: 60_000, filePollMs: 1000, passive: [{ name: 'status', root, read }] },
    { emit: (d) => seen.push(d.sessions.map((s) => `${s.session_id}:${s.state}`)), log: () => {} },
  );
  try {
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 150 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(pred(), JSON.stringify(seen));
    };
    await until(() => seen.some((s) => s.includes('a:active')));
    write(join(root, 'a.json'), JSON.stringify({ agent: 'kimi', id: 'a', state: 'permission' }));
    await until(() => seen.some((s) => s.includes('a:permission')));
  } finally {
    stop();
    rmSync(hookDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook route: documented payloads of Qwen Code, Codex CLI and Kimi CLI land in the right state', async () => {
  const { handleEvent } = await import('@loksly/agent-sessions');
  const now = Date.now();
  const stateOf = (provider: string, data: Record<string, unknown>) => {
    const r = handleEvent(provider, data, null, now, '/tmp');
    assert.ok('record' in r);
    return fixHookState(r.record as SessionView).state;
  };
  const base = { session_id: 's', cwd: '/home/u/api', transcript_path: null };
  // Qwen Code, docs/users/features/hooks.md: Notification `notification_type`; PermissionRequest.
  assert.equal(stateOf('qwen', { ...base, hook_event_name: 'Notification', message: 'Qwen Code needs your permission', notification_type: 'permission_prompt' }), 'permission');
  assert.equal(stateOf('qwen', { ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt' }), 'waiting');
  assert.equal(stateOf('qwen', { ...base, hook_event_name: 'PermissionRequest', tool_name: 'run_shell_command', tool_input: { command: 'rm -rf build' } }), 'permission');
  assert.equal(stateOf('qwen', { ...base, hook_event_name: 'Stop' }), 'ready');
  // Codex CLI, codex-rs/hooks/schema/generated/permission-request.command.input.schema.json.
  assert.equal(stateOf('codex', { ...base, hook_event_name: 'PermissionRequest', model: 'gpt-oss:20b', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'npm publish' }, turn_id: 't' }), 'permission');
  assert.equal(stateOf('codex', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }), 'active');
  assert.equal(stateOf('codex', { ...base, hook_event_name: 'Stop', last_assistant_message: 'done' }), 'ready');
  // Kimi CLI, docs/en/customization/hooks.md: Notification with `notification_type`.
  assert.equal(stateOf('kimi', { ...base, hook_event_name: 'Notification', sink: 'shell', notification_type: 'permission_prompt', title: 'Approval', body: 'Shell', severity: 'info' }), 'permission');
});

test('the iFlow script in docs/hooks writes a status file from iFlow’s environment', { skip: process.platform === 'win32' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = tmp();
  try {
    const env = { ...process.env, KIOSKO_AGENTS_STATUS_DIR: dir, IFLOW_SESSION_ID: 'ses/1', IFLOW_CWD: '/home/u/my "app"', IFLOW_NOTIFICATION_MESSAGE: 'iFlow needs your permission' };
    const script = join(import.meta.dirname, '..', 'docs', 'hooks', 'iflow-kiosko.sh');
    execFileSync('sh', [script, 'permission'], { env });
    const [s] = createStatusReader()({ root: dir, now: Date.now(), maxAgeMs: 60_000 });
    assert.equal(s?.provider, 'iflow');
    assert.equal(s?.session_id, 'ses_1');
    assert.equal(s?.state, 'permission');
    assert.equal(s?.cwd, '/home/u/my "app"');
    execFileSync('sh', [script, 'end'], { env });
    assert.deepEqual(createStatusReader()({ root: dir, now: Date.now(), maxAgeMs: 60_000 }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
