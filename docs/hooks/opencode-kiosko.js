// OpenCode → Kiosko: writes one status file per OpenCode session to
// ~/.config/kiosko/agents/, which the Kiosko `agents` plugin reads (the
// status-file format is in its README). Copy this file to
// ~/.config/opencode/plugins/ (global) or .opencode/plugins/ (one project).
//
// Events, as documented in https://opencode.ai/docs/plugins/ (Events) and
// typed in @opencode-ai/sdk: session.status {sessionID, status: {type:
// busy|idle|retry}}, session.idle, permission.asked (permission.updated in
// older releases), permission.replied, question.asked, question.replied,
// session.deleted {info: {id}}.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = process.env.KIOSKO_AGENTS_STATUS_DIR || join(homedir(), '.config', 'kiosko', 'agents');
const safe = (id) => String(id).replace(/[^\w.:@-]/g, '_').slice(0, 128);

export const KioskoAgents = async ({ directory }) => {
  const write = (sessionID, state, detail = '') => {
    try {
      mkdirSync(DIR, { recursive: true });
      const id = safe(sessionID);
      const file = join(DIR, `opencode-${id}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ agent: 'opencode', id, state, cwd: directory, detail: String(detail).slice(0, 240), updated: Date.now() }));
      renameSync(tmp, file);
    } catch {
      // Never get in the way of the session.
    }
  };
  return {
    event: async ({ event }) => {
      const p = event.properties ?? {};
      switch (event.type) {
        case 'session.status':
          if (p.status?.type === 'busy' || p.status?.type === 'retry') write(p.sessionID, 'working');
          else if (p.status?.type === 'idle') write(p.sessionID, 'done');
          break;
        case 'session.idle':
          write(p.sessionID, 'done');
          break;
        case 'permission.asked':
        case 'permission.updated':
          write(p.sessionID, 'permission', p.title ?? p.permission ?? (Array.isArray(p.patterns) ? p.patterns.join(' ') : ''));
          break;
        case 'question.asked':
          write(p.sessionID, 'input', p.questions?.[0]?.question ?? '');
          break;
        case 'permission.replied':
        case 'question.replied':
          write(p.sessionID, 'working');
          break;
        case 'session.deleted':
          if (p.info?.id) rmSync(join(DIR, `opencode-${safe(p.info.id)}.json`), { force: true });
          break;
      }
    },
  };
};
