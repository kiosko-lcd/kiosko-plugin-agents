/**
 * User-facing words of the agents widgets. Kept together so a new language
 * is one file.
 */
import type { Localized, PluralForms } from '@kiosko/sdk';
import type { SessionState } from './types.ts';

/**
 * Small-caps label of each state. No emoji on purpose: the panel fonts are
 * DejaVu, without emoji glyphs; colour and weight already say the state.
 */
export const STATE_LABEL: Record<SessionState, Localized> = {
  permission: { en: 'Permission', es: 'Permiso', 'zh-Hant': '權限', 'zh-Hans': '权限', de: 'Freigabe' },
  waiting: { en: 'Waiting', es: 'Espera', 'zh-Hant': '等待中', 'zh-Hans': '等待中', de: 'Wartet' },
  ready: { en: 'Ready', es: 'Listo', 'zh-Hant': '就緒', 'zh-Hans': '就绪', de: 'Fertig' },
  active: { en: 'Active', es: 'Activa', 'zh-Hant': '執行中', 'zh-Hans': '运行中', de: 'Aktiv' },
  idle: { en: 'Idle', es: 'Inactiva', 'zh-Hant': '閒置', 'zh-Hans': '空闲', de: 'Inaktiv' },
};

export const TEXT = {
  now: { en: 'now', es: 'ahora', 'zh-Hant': '現在', 'zh-Hans': '现在', de: 'jetzt' },
  meeting: { en: 'Meeting', es: 'Reunión', 'zh-Hant': '會議', 'zh-Hans': '会议', de: 'Meeting' },
  gitClean: { en: 'git clean', es: 'git limpio', 'zh-Hant': 'git 無變更', 'zh-Hans': 'git 无改动', de: 'git sauber' },
  gitDirty: { en: 'git {n} uncommitted', es: 'git {n} sin commit', 'zh-Hant': 'git：{n} 個未提交變更', 'zh-Hans': 'git：{n} 个未提交更改', de: 'git {n} offen' },
  more: { en: '+{n} more', es: '+{n} más', 'zh-Hant': '還有 {n} 個', 'zh-Hans': '还有 {n} 个', de: '+{n} weitere' },
  nobody: { en: 'nobody waiting', es: 'nadie espera', 'zh-Hant': '沒有人在等', 'zh-Hans': '无人等待', de: 'niemand wartet' },
  noSessions: { en: 'No agent sessions', es: 'Sin sesiones de agentes', 'zh-Hant': '沒有代理工作階段', 'zh-Hans': '没有智能体会话', de: 'Keine Agenten-Sitzungen' },
} satisfies Record<string, Localized>;

/** Texts with a count, for `ctx.plural`. */
export const COUNT = {
  consoles: { en: { one: '{n} console', other: '{n} consoles' }, es: { one: '{n} consola', other: '{n} consolas' }, 'zh-Hant': { other: '{n} 個終端機' }, 'zh-Hans': { other: '{n} 个终端' }, de: { one: '{n} Konsole', other: '{n} Konsolen' } },
  waiting: { en: { other: '{n} waiting for you' }, es: { one: '{n} te espera', other: '{n} te esperan' }, 'zh-Hant': { other: '{n} 個在等你' }, 'zh-Hans': { other: '{n} 个在等你' }, de: { one: '{n} wartet auf dich', other: '{n} warten auf dich' } },
} satisfies Record<string, Record<string, PluralForms>>;

/** Replaces `{name}` placeholders. */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}
