/**
 * The `agents/sessions` source: reads the session files the hook writes,
 * drops (and optionally deletes) dead ones and enriches the rest with git.
 * Next to them, agents that keep their own session logs (Codex CLI, Qwen
 * Code, Kimi CLI) are read from those, and any other agent or script can
 * drop tiny status files in a folder (see readers/).
 *
 * Push-based: an `fs.watch` on the directory, debounced, repaints as soon as
 * a session changes state. A slow poll runs underneath because inotify is not
 * the whole story: the directory may not exist yet, the watcher can die, and
 * a commit changes the uncommitted-files count without touching any session
 * file.
 */
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultSessionsDir, pruneZombies, readSessions, reap } from '@loksly/agent-sessions';
import { createGitEnricher } from '@loksly/agent-sessions/git';
import { PASSIVE, type PassiveName } from './providers.ts';
import type { PassiveReader } from './readers/common.ts';
import { expandHome } from './readers/files.ts';
import { createStatusReader } from './readers/status.ts';
import type { SessionsData, SessionView } from './types.ts';

/** `~` and `~/…` → the home directory. Empty → the protocol's default location. */
export function resolveDir(dir: string, home = homedir()): string {
  const d = dir.trim();
  if (!d) return defaultSessionsDir();
  if (d === '~') return home;
  if (d.startsWith('~/')) return join(home, d.slice(2));
  return d;
}

/** Where a passive reader looks: empty → the agent's own variable, then its default. */
const ENV: Record<PassiveName | 'status', string> = { codex: 'CODEX_HOME', qwen: 'QWEN_RUNTIME_DIR', kimi: 'KIMI_SHARE_DIR', status: 'KIOSKO_AGENTS_STATUS_DIR' };
export const STATUS_DIR = '~/.config/kiosko/agents';

export function passiveRoot(name: PassiveName | 'status', dir: string, env: NodeJS.ProcessEnv = process.env, home?: string): string {
  const d = dir.trim() || env[ENV[name]]?.trim() || (name === 'status' ? STATUS_DIR : PASSIVE[name].dir);
  return expandHome(d, home);
}

/** One passive reader, set up. */
export interface PassiveSource {
  name: PassiveName | 'status';
  root: string;
  read: PassiveReader;
}

/** The passive readers the options turn on, each on its folder. */
export function passiveSources(o: { readers: Partial<Record<PassiveName | 'status', { enabled: boolean; dir: string }>> }): PassiveSource[] {
  const out: PassiveSource[] = [];
  for (const name of [...(Object.keys(PASSIVE) as PassiveName[]), 'status'] as const) {
    const r = o.readers[name];
    if (!r?.enabled) continue;
    out.push({ name, root: passiveRoot(name, r.dir), read: name === 'status' ? createStatusReader() : PASSIVE[name].create() });
  }
  return out;
}

/** Sessions of every passive reader; a folder that doesn't exist is no sessions. */
export function readPassive(sources: PassiveSource[], now: number, maxAgeMs: number): SessionView[] {
  const out: SessionView[] = [];
  for (const s of sources) {
    if (!existsSync(s.root)) continue;
    try {
      out.push(...s.read({ root: s.root, now, maxAgeMs }));
    } catch {
      // A reader never takes the others down.
    }
  }
  return out;
}

/**
 * The hook's state machine predates `PermissionRequest`, the one event by
 * which Codex CLI (which has no Notification hook) and Qwen Code say an
 * approval dialog is up: it writes such a record as `active`. That is the
 * moment the session needs you most.
 */
export function fixHookState(r: SessionView): SessionView {
  return r.event === 'PermissionRequest' && r.state === 'active' ? { ...r, state: 'permission', since: r.updated } : r;
}

export interface LoadOptions {
  dir: string;
  zombieMs: number;
  staleMs: number;
  /** Delete the files of dead sessions (see `reap`). */
  reap: boolean;
  /** Passive sessions (read from the agents' own logs): silent this long, gone. */
  fileStaleMs?: number;
}

type Enricher = (rec: SessionView) => Promise<SessionView>;

/**
 * Live sessions of `o.dir` plus `extra` (from passive readers), enriched with
 * `enrich` if given. A session the hook reports wins over the same one read
 * from its log: the hook knows about permission prompts. Dead ones are
 * dropped before enriching: each costs a `git status`, and a corpse would pay
 * it on every reload forever.
 */
export async function loadSessions(o: LoadOptions, enrich?: Enricher, now = Date.now(), onReap?: (r: SessionView) => void, extra: SessionView[] = []): Promise<SessionView[]> {
  const records: SessionView[] = readSessions(o.dir);
  const hooked = (o.reap ? reap(records, now, o, o.dir, onReap) : pruneZombies(records, now, o.zombieMs, o.staleMs)).map(fixHookState);
  const known = new Set(hooked.map((r) => r.session_id));
  const passive = pruneZombies(
    extra.filter((r) => !known.has(r.session_id)),
    now,
    o.zombieMs,
    o.fileStaleMs ?? o.staleMs,
  );
  const alive = [...hooked, ...passive];
  if (!enrich) return alive;
  return Promise.all(alive.map((r) => enrich(r).catch(() => r)));
}

export interface WatchOptions extends LoadOptions {
  git: boolean;
  debounceMs: number;
  pollMs: number;
  /** Passive readers; none by default. */
  passive?: PassiveSource[];
  /** How often the passive readers' logs are looked at (a `stat` each, a read only if one grew). */
  filePollMs?: number;
}

export interface WatchHooks {
  emit: (data: SessionsData) => void;
  log: (msg: string) => void;
  signal?: AbortSignal;
  /** Injectable for tests. */
  now?: () => number;
}

/** Starts watching; returns the function that stops it. */
export function watchSessions(o: WatchOptions, h: WatchHooks): () => void {
  const enrich: Enricher | undefined = o.git ? createGitEnricher() : undefined;
  const now = h.now ?? Date.now;
  let stopped = false;
  let running = false;
  let again = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  const passive = o.passive ?? [];
  let lastSig = '';

  const reload = async (): Promise<void> => {
    if (stopped) return;
    // One reload at a time; a burst of events during one queues a single rerun.
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const t = now();
      const extra = passive.length ? readPassive(passive, t, o.fileStaleMs ?? o.staleMs) : [];
      lastSig = signature(extra);
      const sessions = await loadSessions(o, enrich, t, (r) => h.log(`dropped dead session ${r.project} (${r.state}, silent for ${Math.round((t - r.updated) / 60_000)} min)`), extra);
      if (!stopped) h.emit({ sessions, zombieMs: o.zombieMs });
    } catch (err) {
      h.log(`reading ${o.dir} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
      if (again && !stopped) {
        again = false;
        void reload();
      }
    }
  };

  const schedule = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void reload(), o.debounceMs);
  };

  // The directory may not exist until the hook writes its first session: the
  // poll keeps trying to arm the watcher instead of creating it here.
  const arm = () => {
    if (watcher || stopped || !existsSync(o.dir)) return;
    try {
      const w = watch(o.dir, (_event, name) => {
        if (!name || String(name).endsWith('.json')) schedule();
      });
      w.on('error', () => {
        w.close();
        if (watcher === w) watcher = undefined;
      });
      watcher = w;
    } catch (err) {
      h.log(`cannot watch ${o.dir}: ${err instanceof Error ? err.message : String(err)}; polling only`);
    }
  };

  arm();
  void reload();
  const poll = setInterval(() => {
    arm();
    void reload();
  }, Math.max(1000, o.pollMs));
  poll.unref?.();

  // The agents' own logs: no watcher on someone else's (possibly deep)
  // folders, a cheap look every few seconds that reloads only on a change.
  const filePoll = passive.length
    ? setInterval(() => {
        if (stopped || running) return;
        const sig = signature(readPassive(passive, now(), o.fileStaleMs ?? o.staleMs));
        if (sig !== lastSig) schedule();
      }, Math.max(1000, o.filePollMs ?? 3000))
    : undefined;
  filePoll?.unref?.();

  const stop = () => {
    stopped = true;
    if (debounce) clearTimeout(debounce);
    clearInterval(poll);
    if (filePoll) clearInterval(filePoll);
    watcher?.close();
    watcher = undefined;
  };
  h.signal?.addEventListener('abort', stop, { once: true });
  return stop;
}

/** What a repaint depends on, of the passive sessions. */
function signature(sessions: SessionView[]): string {
  return sessions.map((r) => `${r.provider}/${r.session_id}:${r.state}:${r.updated}:${r.detail}`).sort().join('|');
}
