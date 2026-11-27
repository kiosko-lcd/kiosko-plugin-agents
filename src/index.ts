/**
 * AI coding agents on the panel, ported from aimonitor: the sessions source
 * (fed by the @loksly/agent-sessions hook), the tile dashboard, its summary
 * strip and the 8-bit runner that plays every quarter hour.
 *
 * The art direction is the original's: the normal state is darkness, and
 * colour is spent only on the session that claims you.
 */
import { defineInterlude, definePlugin, defineSource, defineWidget, t } from '@kiosko/sdk';
import { DEMO_VITALS, demoScenario, scenario } from './demo.ts';
import { drawSessions, drawSummaryStrip } from './draw.ts';
import { STATE_LABEL } from './texts.ts';
import { DEFAULT_TEXTS, levelFor, runnerPlayer } from './platformer.ts';
import { passiveSources, resolveDir, watchSessions } from './source.ts';
import { filterSessions, needsPermission, sessionsOf, SESSIONS_SOURCE, type SessionsData, type SessionState } from './types.ts';

export type { SessionView, SessionsData, Weight } from './types.ts';
export { assignWeights, plan, spareWidth } from './select.ts';

export const sessionsSource = defineSource({
  id: 'sessions',
  name: { en: 'AI agent sessions', es: 'Sesiones de agentes IA', 'zh-Hant': 'AI 代理工作階段', 'zh-Hans': 'AI 智能体会话', de: 'KI-Agenten-Sitzungen' },
  description: {
    en: 'Sessions of Claude Code, Gemini CLI, Qwen Code, Codex CLI, Kimi CLI… from the agent-sessions hook, from the agents’ own logs and from status files, with git status.',
    es: 'Las sesiones de Claude Code, Gemini CLI, Qwen Code, Codex CLI, Kimi CLI… del hook de agent-sessions, de los propios registros de cada agente y de ficheros de estado, con el estado de git.',
    'zh-Hant': 'Claude Code、Gemini CLI、Qwen Code、Codex CLI、Kimi CLI… 的工作階段，來自 agent-sessions hook、各代理自己的紀錄檔與狀態檔，附 git 狀態。',
    'zh-Hans': 'Claude Code、Gemini CLI、Qwen Code、Codex CLI、Kimi CLI… 的会话，来自 agent-sessions hook、各智能体自己的日志和状态文件，附带 git 状态。',
    de: 'Sitzungen von Claude Code, Gemini CLI, Qwen Code, Codex CLI, Kimi CLI… aus dem agent-sessions-Hook, aus den eigenen Protokollen der Agenten und aus Statusdateien, mit Git-Status.',
  },
  options: t.object({
    dir: t.string({
      default: '~/.aimonitor/sessions',
      format: 'path',
      risk: 'path',
      label: { en: 'Sessions folder', es: 'Carpeta de sesiones', 'zh-Hant': '工作階段資料夾', 'zh-Hans': '会话文件夹', de: 'Sitzungsordner' },
      help: { en: 'Where the hook writes one JSON file per session. Empty: $AGENT_SESSIONS_DIR or ~/.aimonitor/sessions.', es: 'Donde el hook escribe un JSON por sesión. Vacío: $AGENT_SESSIONS_DIR o ~/.aimonitor/sessions.', 'zh-Hant': 'hook 為每個工作階段寫入一個 JSON 檔案的位置。留空：$AGENT_SESSIONS_DIR 或 ~/.aimonitor/sessions。', 'zh-Hans': 'hook 为每个会话写入一个 JSON 文件的位置。留空：$AGENT_SESSIONS_DIR 或 ~/.aimonitor/sessions。', de: 'Wohin der Hook eine JSON-Datei pro Sitzung schreibt. Leer: $AGENT_SESSIONS_DIR oder ~/.aimonitor/sessions.' },
    }),
    git: t.boolean({
      default: true,
      label: { en: 'Read git status', es: 'Leer el estado de git', 'zh-Hant': '讀取 git 狀態', 'zh-Hans': '读取 git 状态', de: 'Git-Status lesen' },
      help: { en: 'Repository name and uncommitted files of each session (runs git).', es: 'Nombre del repositorio y ficheros sin commit de cada sesión (ejecuta git).', 'zh-Hant': '每個工作階段的儲存庫名稱與未提交的檔案（會執行 git）。', 'zh-Hans': '每个会话的仓库名称和未提交的文件（会运行 git）。', de: 'Repository-Name und nicht committete Dateien jeder Sitzung (führt git aus).' },
    }),
    zombieMs: t.duration({
      default: 15 * 60_000,
      min: 60_000,
      label: { en: 'Drop silent working sessions after', es: 'Descartar sesiones activas calladas tras', 'zh-Hant': '捨棄無動靜的執行中工作階段，時間', 'zh-Hans': '丢弃无动静的运行中会话，时长', de: 'Stille arbeitende Sitzungen verwerfen nach' },
      help: {
        en: 'A session that says it is working and writes nothing for this long is dead. The cats room turns it into Schrödinger\'s box at half of this.',
        es: 'Una sesión que dice estar trabajando y no escribe nada en este tiempo está muerta. La habitación de gatos la convierte en la caja de Schrödinger a la mitad.',
        'zh-Hant': '聲稱正在執行、卻這麼久都沒寫入任何內容的工作階段，視為已失效。貓咪房間會在一半時間時把它變成薛丁格的盒子。',
        'zh-Hans': '声称正在运行、却这么久都没写入任何内容的会话，视为已失效。猫咪房间会在一半时间时把它变成薛定谔的盒子。',
        de: 'Eine Sitzung, die angeblich arbeitet und so lange nichts schreibt, ist tot. Das Katzenzimmer macht nach der Hälfte dieser Zeit Schrödingers Kiste daraus.',
      },
    }),
    staleMs: t.duration({
      default: 2 * 3_600_000,
      min: 60_000,
      label: { en: 'Drop any silent session after', es: 'Descartar cualquier sesión callada tras', 'zh-Hant': '捨棄任何無動靜的工作階段，時間', 'zh-Hans': '丢弃任何无动静的会话，时长', de: 'Jede stille Sitzung verwerfen nach' },
      help: { en: 'The net under SessionEnd, which never arrives if the terminal is killed. Raise it if you leave permission prompts waiting for hours.', es: 'La red bajo SessionEnd, que no llega si se mata el terminal. Súbelo si dejas permisos esperando horas.', 'zh-Hant': 'SessionEnd 之外的保險：終端機被強制關閉時不會送出 SessionEnd。如果你常讓權限提示一等就是好幾個小時，請調高此值。', 'zh-Hans': 'SessionEnd 之外的兜底：终端被强制关闭时不会发出 SessionEnd。如果你常让权限提示一等就是好几个小时，请调大此值。', de: 'Das Netz unter SessionEnd, das nie ankommt, wenn das Terminal abgeschossen wird. Erhöhe den Wert, wenn du Berechtigungsabfragen stundenlang warten lässt.' },
    }),
    reap: t.boolean({
      default: true,
      advanced: true,
      label: { en: 'Delete files of dead sessions', es: 'Borrar los ficheros de sesiones muertas', 'zh-Hant': '刪除已失效工作階段的檔案', 'zh-Hans': '删除已失效会话的文件', de: 'Dateien toter Sitzungen löschen' },
      help: { en: 'Safe: a live session writes its file again on its next event.', es: 'Es seguro: una sesión viva vuelve a escribir su fichero en el siguiente evento.', 'zh-Hant': '這是安全的：仍在運作的工作階段會在下一個事件時重新寫入它的檔案。', 'zh-Hans': '这是安全的：仍在运行的会话会在下一个事件时重新写入它的文件。', de: 'Sicher: Eine lebende Sitzung schreibt ihre Datei beim nächsten Ereignis neu.' },
    }),
    debounceMs: t.integer({ default: 200, min: 0, max: 5000, unit: 'ms', advanced: true, label: { en: 'Wait for a burst of events', es: 'Esperar a que acabe una ráfaga de eventos', 'zh-Hant': '等待一連串事件結束', 'zh-Hans': '等待一连串事件结束', de: 'Auf das Ende einer Ereignisserie warten' } }),
    pollMs: t.duration({ default: 30_000, min: 5_000, advanced: true, label: { en: 'Re-read every', es: 'Releer cada', 'zh-Hant': '重新讀取間隔', 'zh-Hans': '重新读取间隔', de: 'Neu lesen alle' }, help: { en: 'Fallback to file watching; also refreshes the git counts.', es: 'Respaldo de la vigilancia de ficheros; también refresca los contadores de git.', 'zh-Hant': '檔案監看的備援機制；也會重新整理 git 計數。', 'zh-Hans': '文件监听的兜底机制；也会刷新 git 计数。', de: 'Ersatz für die Dateiüberwachung; aktualisiert auch die Git-Zähler.' } }),
    codex: t.boolean({
      default: true,
      label: { en: 'Read Codex CLI sessions', es: 'Leer las sesiones de Codex CLI', 'zh-Hant': '讀取 Codex CLI 工作階段', 'zh-Hans': '读取 Codex CLI 会话', de: 'Codex-CLI-Sitzungen lesen' },
      help: {
        en: 'From its own logs in ~/.codex/sessions, if that folder exists; no hook needed. Working and done only: for permission prompts, add the hook (see the README).',
        es: 'De sus propios registros en ~/.codex/sessions, si existe esa carpeta; no hace falta hook. Sólo trabajando y terminada: para las peticiones de permiso, añade el hook (mira el README).',
        'zh-Hant': '從它自己在 ~/.codex/sessions 的紀錄讀取（若該資料夾存在），不需要 hook。只能分辨執行中與已完成；若要看到權限請求，請加上 hook（見 README）。',
        'zh-Hans': '从它自己在 ~/.codex/sessions 的日志读取（如果该文件夹存在），不需要 hook。只能区分运行中和已完成；如需看到权限请求，请加上 hook（见 README）。',
        de: 'Aus den eigenen Protokollen in ~/.codex/sessions, falls der Ordner existiert; kein Hook nötig. Nur arbeitet und fertig: für Berechtigungsabfragen den Hook einrichten (siehe README).',
      },
    }),
    codexDir: t.string({ default: '', format: 'path', risk: 'path', advanced: true, label: { en: 'Codex folder', es: 'Carpeta de Codex', 'zh-Hant': 'Codex 資料夾', 'zh-Hans': 'Codex 文件夹', de: 'Codex-Ordner' }, help: { en: 'Empty: $CODEX_HOME or ~/.codex.', es: 'Vacío: $CODEX_HOME o ~/.codex.', 'zh-Hant': '留空：$CODEX_HOME 或 ~/.codex。', 'zh-Hans': '留空：$CODEX_HOME 或 ~/.codex。', de: 'Leer: $CODEX_HOME oder ~/.codex.' } }),
    qwen: t.boolean({
      default: true,
      label: { en: 'Read Qwen Code sessions', es: 'Leer las sesiones de Qwen Code', 'zh-Hant': '讀取 Qwen Code 工作階段', 'zh-Hans': '读取 Qwen Code 会话', de: 'Qwen-Code-Sitzungen lesen' },
      help: {
        en: 'From its own chat logs in ~/.qwen/projects, if that folder exists; no hook needed. Working and done only: for permission prompts, add the hook (see the README).',
        es: 'De sus propios registros de chat en ~/.qwen/projects, si existe esa carpeta; no hace falta hook. Sólo trabajando y terminada: para las peticiones de permiso, añade el hook (mira el README).',
        'zh-Hant': '從它自己在 ~/.qwen/projects 的對話紀錄讀取（若該資料夾存在），不需要 hook。只能分辨執行中與已完成；若要看到權限請求，請加上 hook（見 README）。',
        'zh-Hans': '从它自己在 ~/.qwen/projects 的对话日志读取（如果该文件夹存在），不需要 hook。只能区分运行中和已完成；如需看到权限请求，请加上 hook（见 README）。',
        de: 'Aus den eigenen Chatprotokollen in ~/.qwen/projects, falls der Ordner existiert; kein Hook nötig. Nur arbeitet und fertig: für Berechtigungsabfragen den Hook einrichten (siehe README).',
      },
    }),
    qwenDir: t.string({ default: '', format: 'path', risk: 'path', advanced: true, label: { en: 'Qwen Code folder', es: 'Carpeta de Qwen Code', 'zh-Hant': 'Qwen Code 資料夾', 'zh-Hans': 'Qwen Code 文件夹', de: 'Qwen-Code-Ordner' }, help: { en: 'Empty: $QWEN_RUNTIME_DIR or ~/.qwen.', es: 'Vacío: $QWEN_RUNTIME_DIR o ~/.qwen.', 'zh-Hant': '留空：$QWEN_RUNTIME_DIR 或 ~/.qwen。', 'zh-Hans': '留空：$QWEN_RUNTIME_DIR 或 ~/.qwen。', de: 'Leer: $QWEN_RUNTIME_DIR oder ~/.qwen.' } }),
    kimi: t.boolean({
      default: true,
      label: { en: 'Read Kimi CLI sessions', es: 'Leer las sesiones de Kimi CLI', 'zh-Hant': '讀取 Kimi CLI 工作階段', 'zh-Hans': '读取 Kimi CLI 会话', de: 'Kimi-CLI-Sitzungen lesen' },
      help: {
        en: 'From its own logs in ~/.kimi/sessions, if that folder exists; no hook needed. In the interactive shell permission prompts are not logged: add the hook for those (see the README).',
        es: 'De sus propios registros en ~/.kimi/sessions, si existe esa carpeta; no hace falta hook. En la consola interactiva las peticiones de permiso no se registran: para ésas, añade el hook (mira el README).',
        'zh-Hant': '從它自己在 ~/.kimi/sessions 的紀錄讀取（若該資料夾存在），不需要 hook。互動式終端機不會記錄權限請求；若要看到，請加上 hook（見 README）。',
        'zh-Hans': '从它自己在 ~/.kimi/sessions 的日志读取（如果该文件夹存在），不需要 hook。交互式终端不会记录权限请求；如需看到，请加上 hook（见 README）。',
        de: 'Aus den eigenen Protokollen in ~/.kimi/sessions, falls der Ordner existiert; kein Hook nötig. In der interaktiven Shell werden Berechtigungsabfragen nicht protokolliert: dafür den Hook einrichten (siehe README).',
      },
    }),
    kimiDir: t.string({ default: '', format: 'path', risk: 'path', advanced: true, label: { en: 'Kimi folder', es: 'Carpeta de Kimi', 'zh-Hant': 'Kimi 資料夾', 'zh-Hans': 'Kimi 文件夹', de: 'Kimi-Ordner' }, help: { en: 'Empty: $KIMI_SHARE_DIR or ~/.kimi.', es: 'Vacío: $KIMI_SHARE_DIR o ~/.kimi.', 'zh-Hant': '留空：$KIMI_SHARE_DIR 或 ~/.kimi。', 'zh-Hans': '留空：$KIMI_SHARE_DIR 或 ~/.kimi。', de: 'Leer: $KIMI_SHARE_DIR oder ~/.kimi.' } }),
    statusFiles: t.boolean({
      default: true,
      label: { en: 'Read status files', es: 'Leer ficheros de estado', 'zh-Hant': '讀取狀態檔', 'zh-Hans': '读取状态文件', de: 'Statusdateien lesen' },
      help: {
        en: 'Tiny JSON files that any agent’s hooks or your own scripts write, one per session, in ~/.config/kiosko/agents (OpenCode’s plugin, for one). See the README for the format.',
        es: 'Ficheros JSON diminutos que escriben los hooks de cualquier agente o tus propios scripts, uno por sesión, en ~/.config/kiosko/agents (el plugin de OpenCode, por ejemplo). El formato está en el README.',
        'zh-Hant': '任何代理的 hook 或你自己的腳本寫入的小型 JSON 檔，每個工作階段一個，放在 ~/.config/kiosko/agents（例如 OpenCode 的外掛）。格式見 README。',
        'zh-Hans': '任何智能体的 hook 或你自己的脚本写入的小型 JSON 文件，每个会话一个，放在 ~/.config/kiosko/agents（例如 OpenCode 的插件）。格式见 README。',
        de: 'Winzige JSON-Dateien, die die Hooks eines beliebigen Agenten oder deine eigenen Skripte schreiben, eine pro Sitzung, in ~/.config/kiosko/agents (zum Beispiel das OpenCode-Plugin). Das Format steht im README.',
      },
    }),
    statusDir: t.string({ default: '', format: 'path', risk: 'path', advanced: true, label: { en: 'Status files folder', es: 'Carpeta de ficheros de estado', 'zh-Hant': '狀態檔資料夾', 'zh-Hans': '状态文件文件夹', de: 'Ordner der Statusdateien' }, help: { en: 'Empty: $KIOSKO_AGENTS_STATUS_DIR or ~/.config/kiosko/agents.', es: 'Vacío: $KIOSKO_AGENTS_STATUS_DIR o ~/.config/kiosko/agents.', 'zh-Hant': '留空：$KIOSKO_AGENTS_STATUS_DIR 或 ~/.config/kiosko/agents。', 'zh-Hans': '留空：$KIOSKO_AGENTS_STATUS_DIR 或 ~/.config/kiosko/agents。', de: 'Leer: $KIOSKO_AGENTS_STATUS_DIR oder ~/.config/kiosko/agents.' } }),
    fileStaleMs: t.duration({
      default: 15 * 60_000,
      min: 60_000,
      advanced: true,
      label: { en: 'Forget a quiet log after', es: 'Olvidar un registro callado tras', 'zh-Hant': '紀錄無動靜多久後忽略', 'zh-Hans': '日志无动静多久后忽略', de: 'Stilles Protokoll vergessen nach' },
      help: { en: 'An agent read from its own log can’t say you closed it: a finished session stays this long.', es: 'Un agente leído de su registro no puede decir que lo has cerrado: una sesión terminada se queda este tiempo.', 'zh-Hant': '從紀錄讀取的代理無法得知你已關閉它：已完成的工作階段會保留這麼久。', 'zh-Hans': '从日志读取的智能体无法得知你已关闭它：已完成的会话会保留这么久。', de: 'Ein aus seinem Protokoll gelesener Agent kann nicht sagen, dass du ihn geschlossen hast: Eine fertige Sitzung bleibt so lange.' },
    }),
    filePollMs: t.integer({ default: 3000, min: 1000, max: 60_000, unit: 'ms', advanced: true, label: { en: 'Look at the agents’ logs every', es: 'Mirar los registros de los agentes cada', 'zh-Hant': '查看代理紀錄的間隔', 'zh-Hans': '查看智能体日志的间隔', de: 'Protokolle der Agenten prüfen alle' } }),
  }),
  watch(ctx, emit: (data: SessionsData) => void) {
    const o = ctx.options;
    const passive = passiveSources({
      readers: {
        codex: { enabled: o.codex, dir: o.codexDir },
        qwen: { enabled: o.qwen, dir: o.qwenDir },
        kimi: { enabled: o.kimi, dir: o.kimiDir },
        status: { enabled: o.statusFiles, dir: o.statusDir },
      },
    });
    return watchSessions({ ...o, dir: resolveDir(o.dir), passive }, { emit, log: ctx.log, signal: ctx.signal });
  },
  demo: ({ now, locale }) => ({ sessions: scenario(demoScenario(locale), now), zombieMs: 15 * 60_000 }),
});

/** States a widget can leave out; the first is what "Add" offers, the one most often hidden. */
const STATES = ['active', 'idle', 'ready', 'waiting', 'permission'] as const satisfies readonly SessionState[];

/** The `projects` filter every sessions widget offers. */
const projectsField = () =>
  t.filter({
    label: { en: 'Projects', es: 'Proyectos', 'zh-Hant': '專案', 'zh-Hans': '项目', de: 'Projekte' },
    help: {
      en: 'Empty: all. Project, repository or folder names or patterns, comma-separated: * matches anything, a leading ! leaves out (web-app, acme-*, !scratch).',
      es: 'Vacío: todos. Nombres o patrones de proyecto, repositorio o carpeta, separados por comas: * vale por cualquier cosa y un ! delante excluye (web-app, acme-*, !pruebas).',
      'zh-Hant': '留空：全部。專案、儲存庫或資料夾的名稱或模式，以逗號分隔：* 比對任何內容，開頭加 ! 表示排除（web-app, acme-*, !scratch）。',
      'zh-Hans': '留空：全部。项目、仓库或文件夹的名称或模式，用逗号分隔：* 匹配任意内容，开头加 ! 表示排除（web-app, acme-*, !scratch）。',
      de: 'Leer: alle. Namen oder Muster von Projekten, Repositorys oder Ordnern, durch Kommas getrennt: * passt auf alles, ein ! am Anfang schließt aus (web-app, acme-*, !scratch).',
    },
  });

const sessionsOptions = t.object({
  projects: projectsField(),
  hideStates: t.list(t.enum(STATES, { labels: STATE_LABEL }), {
    label: { en: 'Hide sessions that are', es: 'Ocultar las sesiones en estado', 'zh-Hant': '隱藏下列狀態的工作階段', 'zh-Hans': '隐藏以下状态的会话', de: 'Sitzungen ausblenden, die' },
    help: { en: 'E.g. Active and Idle, to see only the ones that claim you.', es: 'Por ejemplo, Activa e Inactiva, para ver sólo las que te reclaman.', 'zh-Hant': '例如「執行中」和「閒置」，只看需要你處理的。', 'zh-Hans': '例如“运行中”和“空闲”，只看需要你处理的。', de: 'Z. B. Aktiv und Inaktiv, um nur die zu sehen, die dich brauchen.' },
  }),
  maxTiles: t.integer({
    default: 0,
    min: 0,
    max: 12,
    label: { en: 'Most tiles', es: 'Casillas como mucho', 'zh-Hant': '方格上限', 'zh-Hans': '格子上限', de: 'Kacheln (höchstens)' },
    help: { en: '0 = as many as fit. The rest go to the summary column, so the tiles get wider.', es: '0 = las que quepan. El resto va a la columna de resumen, así que las casillas se ensanchan.', 'zh-Hant': '0 = 放得下多少就顯示多少。其餘的歸入摘要欄，方格因此變寬。', 'zh-Hans': '0 = 能放多少就显示多少。其余的归入摘要栏，格子因此变宽。', de: '0 = so viele wie passen. Der Rest kommt in die Übersichtsspalte, damit die Kacheln breiter werden.' },
  }),
  tileMin: t.integer({ default: 320, min: 120, max: 1000, unit: 'px', label: { en: 'Narrowest tile', es: 'Casilla más estrecha', 'zh-Hant': '方格最小寬度', 'zh-Hans': '格子最小宽度', de: 'Schmalste Kachel' }, help: { en: 'At a 374 px tall widget; scales with the height. Sessions that would need narrower tiles go to the summary column.', es: 'Para un widget de 374 px de alto; escala con la altura. Las sesiones que no quepan van a la columna de resumen.', 'zh-Hant': '以 374 px 高的小工具為準，隨高度縮放。需要更窄方格的工作階段會歸入摘要欄。', 'zh-Hans': '以 374 px 高的小组件为准，随高度缩放。需要更窄格子的会话会归入摘要栏。', de: 'Bei einem 374 px hohen Widget; skaliert mit der Höhe. Sitzungen, die schmalere Kacheln bräuchten, kommen in die Übersichtsspalte.' } }),
  tileMax: t.integer({ default: 430, min: 0, max: 2000, unit: 'px', label: { en: 'Widest tile', es: 'Casilla más ancha', 'zh-Hant': '方格最大寬度', 'zh-Hans': '格子最大宽度', de: 'Breiteste Kachel' }, help: { en: 'So a single session doesn’t stretch across the panel. 0 = no limit: the tiles fill the width.', es: 'Para que una sola sesión no se estire a todo el panel. 0 = sin límite: las casillas llenan el ancho.', 'zh-Hant': '避免單一工作階段橫跨整個面板。0 = 不限制：方格填滿寬度。', 'zh-Hans': '避免单个会话横跨整个副屏。0 = 不限制：格子占满宽度。', de: 'Damit sich eine einzelne Sitzung nicht über das ganze Panel zieht. 0 = keine Grenze: Die Kacheln füllen die Breite.' } }),
  gap: t.integer({ default: 12, min: 0, max: 60, unit: 'px', label: { en: 'Gap between tiles', es: 'Separación entre casillas', 'zh-Hant': '方格間距', 'zh-Hans': '格子间距', de: 'Abstand zwischen Kacheln' } }),
  detailLines: t.integer({ default: 3, min: 0, max: 6, slider: true, label: { en: 'Detail lines', es: 'Líneas de detalle', 'zh-Hant': '詳細資訊行數', 'zh-Hans': '详情行数', de: 'Detailzeilen' }, help: { en: 'Lines of the last tool call or message before cutting with an ellipsis. 0 hides it.', es: 'Líneas de la última herramienta o mensaje antes de cortar con puntos suspensivos. 0 lo oculta.', 'zh-Hant': '最後一次工具呼叫或訊息顯示的行數，超出以刪節號截斷。0 表示隱藏。', 'zh-Hans': '最后一次工具调用或消息显示的行数，超出部分以省略号截断。0 表示隐藏。', de: 'Zeilen des letzten Tool-Aufrufs oder der letzten Nachricht, bevor mit Auslassungspunkten gekürzt wird. 0 blendet ihn aus.' } }),
  spineWidth: t.integer({ default: 7, min: 2, max: 30, unit: 'px', advanced: true, label: { en: 'Colour spine width', es: 'Ancho de la espina de color', 'zh-Hant': '色條寬度', 'zh-Hans': '色条宽度', de: 'Breite des Farbstreifens' } }),
  summaryWidth: t.integer({ default: 150, min: 80, max: 400, unit: 'px', advanced: true, label: { en: 'Summary column width', es: 'Ancho de la columna de resumen', 'zh-Hant': '摘要欄寬度', 'zh-Hans': '摘要栏宽度', de: 'Breite der Übersichtsspalte' } }),
  align: t.enum(['left', 'center', 'right'] as const, { label: { en: 'Alignment', es: 'Alineación', 'zh-Hant': '對齊', 'zh-Hans': '对齐', de: 'Ausrichtung' }, labels: { left: { en: 'Left', es: 'Izquierda', 'zh-Hant': '靠左', 'zh-Hans': '左对齐', de: 'Links' }, center: { en: 'Centre', es: 'Centro', 'zh-Hant': '置中', 'zh-Hans': '居中', de: 'Mitte' }, right: { en: 'Right', es: 'Derecha', 'zh-Hant': '靠右', 'zh-Hans': '右对齐', de: 'Rechts' } } }),
  showGit: t.boolean({ default: true, label: { en: 'Show uncommitted files', es: 'Mostrar ficheros sin commit', 'zh-Hant': '顯示未提交的檔案', 'zh-Hans': '显示未提交的文件', de: 'Nicht committete Dateien zeigen' } }),
  showId: t.boolean({ default: true, label: { en: 'Show the console id', es: 'Mostrar el id de la consola', 'zh-Hant': '顯示終端機 ID', 'zh-Hans': '显示终端 ID', de: 'Konsolen-ID zeigen' }, help: { en: 'PROVIDER · ABC123 in the corner, to tell two consoles of one project apart.', es: 'PROVEEDOR · ABC123 en la esquina, para distinguir dos consolas del mismo proyecto.', 'zh-Hant': '角落顯示 PROVIDER · ABC123，用來區分同一專案的兩個終端機。', 'zh-Hans': '在角落显示 PROVIDER · ABC123，用于区分同一项目的两个终端。', de: 'ANBIETER · ABC123 in der Ecke, um zwei Konsolen desselben Projekts auseinanderzuhalten.' } }),
});

export const sessionsWidget = defineWidget({
  id: 'sessions',
  name: { en: 'Agent sessions', es: 'Sesiones de agentes', 'zh-Hant': '代理工作階段', 'zh-Hans': '智能体会话', de: 'Agenten-Sitzungen' },
  description: {
    en: 'One tile per AI coding session. The one that needs you most turns solid, the others that wait get a colour spine, and working ones stay dark.',
    es: 'Una casilla por sesión de IA. La que más te necesita se enciende entera, las demás que esperan llevan una espina de color y las que trabajan quedan a oscuras.',
    'zh-Hant': '每個 AI 程式設計工作階段一個方格。最需要你的那個會整格亮起，其他等待中的帶有色條，執行中的則保持暗色。',
    'zh-Hans': '每个 AI 编程会话一个格子。最需要你的那个整格点亮，其他等待中的带色条，运行中的保持暗色。',
    de: 'Eine Kachel pro KI-Coding-Sitzung. Die, die dich am dringendsten braucht, wird vollfarbig, die anderen wartenden bekommen einen Farbstreifen, und arbeitende bleiben dunkel.',
  },
  icon: 'bot',
  category: 'agents',
  tags: ['claude', 'gemini', 'qwen', 'codex', 'opencode', 'kimi', 'ai', 'sessions', 'git'],
  chrome: 'bare',
  size: { min: { w: 400, h: 200 }, preferred: { w: 1500, h: 390 } },
  options: sessionsOptions,
  sources: [SESSIONS_SOURCE],
  redraw: 'minute',
  render(g, ctx) {
    drawSessions(g, ctx, ctx.options);
  },
  urgent: ({ sources, options }) => needsPermission(filterSessions(sessionsOf(sources), options)),
  idle: ({ sources, options }) => filterSessions(sessionsOf(sources), options).length === 0,
  empty: ({ sources, options }) => sources[SESSIONS_SOURCE] !== undefined && filterSessions(sessionsOf(sources), options).length === 0,
  demo: ({ now, locale }) => ({ sources: { [SESSIONS_SOURCE]: { sessions: scenario(demoScenario(locale), now) } } }),
});

export const summaryWidget = defineWidget({
  id: 'summary',
  name: { en: 'Agents summary strip', es: 'Franja de resumen de agentes', 'zh-Hant': '代理摘要列', 'zh-Hans': '智能体摘要条', de: 'Agenten-Übersichtsleiste' },
  description: {
    en: 'A thin header line: RAM, how many consoles are open, how many wait for you (tinted by the most urgent) and the clock.',
    es: 'Una línea fina de cabecera: RAM, cuántas consolas hay abiertas, cuántas te esperan (teñido por la más urgente) y la hora.',
    'zh-Hant': '一條細細的標題列：RAM、開了幾個終端機、有幾個在等你（以最緊急的顏色標示）以及時鐘。',
    'zh-Hans': '一条细细的标题栏：RAM、开了几个终端、有几个在等你（以最紧急的颜色标示）以及时钟。',
    de: 'Eine schmale Kopfzeile: RAM, wie viele Konsolen offen sind, wie viele auf dich warten (in der Farbe der dringendsten) und die Uhr.',
  },
  icon: 'activity',
  category: 'agents',
  tags: ['claude', 'gemini', 'qwen', 'codex', 'header'],
  chrome: 'bare',
  size: { min: { w: 400, h: 32 }, preferred: { w: 1900, h: 60 } },
  options: t.object({
    projects: projectsField(),
    showRam: t.boolean({ default: true, label: { en: 'Show RAM', es: 'Mostrar la RAM', 'zh-Hant': '顯示 RAM', 'zh-Hans': '显示 RAM', de: 'RAM zeigen' }, help: { en: 'Needs the system vitals source.', es: 'Necesita la fuente de vitales del sistema.', 'zh-Hant': '需要系統狀態資料來源。', 'zh-Hans': '需要系统状态数据源。', de: 'Braucht die Datenquelle der Systemwerte.' } }),
    showConsoles: t.boolean({ default: true, label: { en: 'Show how many consoles', es: 'Mostrar cuántas consolas', 'zh-Hant': '顯示終端機數量', 'zh-Hans': '显示终端数量', de: 'Anzahl der Konsolen zeigen' }, help: { en: 'Off: only how many wait for you, for short strips.', es: 'Apagado: sólo cuántas te esperan, para franjas cortas.', 'zh-Hant': '關閉：只顯示有幾個在等你，適合較短的列。', 'zh-Hans': '关闭：只显示有几个在等你，适合较短的条。', de: 'Aus: nur wie viele auf dich warten, für kurze Leisten.' } }),
    showClock: t.boolean({ default: true, label: { en: 'Show the clock', es: 'Mostrar la hora', 'zh-Hant': '顯示時鐘', 'zh-Hans': '显示时钟', de: 'Uhr zeigen' } }),
    showRule: t.boolean({ default: true, label: { en: 'Rule underneath', es: 'Raya debajo', 'zh-Hant': '底部分隔線', 'zh-Hans': '底部分隔线', de: 'Linie darunter' } }),
  }),
  sources: [SESSIONS_SOURCE, 'system/vitals'],
  redraw: 'minute',
  render(g, ctx) {
    drawSummaryStrip(g, ctx, ctx.options);
  },
  idle: ({ sources, options }) => filterSessions(sessionsOf(sources), options).length === 0,
  demo: ({ now, locale }) => ({ sources: { [SESSIONS_SOURCE]: { sessions: scenario(demoScenario(locale), now) }, 'system/vitals': DEMO_VITALS } }),
});

export const runner = defineInterlude({
  id: 'runner',
  name: { en: '8-bit runner', es: 'Corredor de 8 bits', 'zh-Hant': '8 位元跑者', 'zh-Hans': '8 比特跑者', de: '8-Bit-Läufer' },
  description: {
    en: 'A side-scrolling platformer run through a server room, in flat colours. Every slot plays a different ending; now and then the runner ships the release.',
    es: 'Una carrera de plataformas de scroll lateral por una sala de servidores, en colores planos. Cada franja acaba distinto; de vez en cuando el corredor saca la versión.',
    'zh-Hant': '穿越伺服器機房的橫向捲動平台遊戲，採用扁平配色。每段都有不同結局；偶爾跑者會成功發布版本。',
    'zh-Hans': '穿越服务器机房的横版卷轴平台游戏，采用扁平配色。每段都有不同结局；偶尔跑者会成功发布版本。',
    de: 'Ein seitlich scrollendes Jump’n’Run durch einen Serverraum, in flachen Farben. Jeder Durchlauf hat ein anderes Ende; ab und zu bringt der Läufer das Release raus.',
  },
  icon: 'gamepad',
  options: t.object({
    title: t.string({ default: DEFAULT_TEXTS.title, maxLength: 12, label: { en: 'Name in the score', es: 'Nombre en el marcador', 'zh-Hant': '記分板上的名稱', 'zh-Hans': '记分板上的名字', de: 'Name in der Anzeige' }, help: { en: 'Letters, digits and - . ! ?', es: 'Letras, cifras y - . ! ?', 'zh-Hant': '字母、數字與 - . ! ?', 'zh-Hans': '字母、数字和 - . ! ?', de: 'Buchstaben, Ziffern und - . ! ?' } }),
  }),
  sources: [SESSIONS_SOURCE],
  fps: 12,
  async prepare(ctx) {
    if (ctx.width < 8 || ctx.height < 8) return null;
    const texts = {
      title: ctx.options.title.trim() || DEFAULT_TEXTS.title,
      world: ctx.t({ en: 'RELEASE', es: 'VERSION', 'zh-Hant': 'RELEASE', 'zh-Hans': 'RELEASE', de: 'VERSION' }),
      level: levelFor(ctx.seed),
      time: ctx.t({ en: 'TIME', es: 'TIEMPO', 'zh-Hant': 'TIME', 'zh-Hans': 'TIME', de: 'ZEIT' }),
      retry: ctx.t({ en: 'TRY AGAIN', es: 'OTRA VEZ SERA', 'zh-Hant': 'TRY AGAIN', 'zh-Hans': 'TRY AGAIN', de: 'NOCHMAL' }),
    };
    const p = runnerPlayer(ctx.width, ctx.height, ctx.seed, texts);
    return { frames: p.frames, draw: p.draw };
  },
  // A session blocked on a permission prompt is no time to play.
  skip: ({ sources }) => needsPermission(sessionsOf(sources)),
});

export default definePlugin({
  id: 'agents',
  name: { en: 'AI agents', es: 'Agentes IA', 'zh-Hant': 'AI 代理', 'zh-Hans': 'AI 智能体', de: 'KI-Agenten' },
  version: '0.3.1',
  languages: ['en', 'es', 'zh-Hant', 'zh-Hans', 'de'],
  sdk: '^0.2.0',
  permissions: { files: ['~/.aimonitor/sessions', '~/.codex/sessions', '~/.qwen/projects', '~/.kimi/sessions', '~/.kimi/kimi.json', '~/.config/kiosko/agents'], exec: ['git'] },
  optional: ['system/vitals'],
  description: {
    en: 'Your AI coding agents at a glance (Claude Code, Gemini CLI, Qwen Code, Codex CLI, OpenCode, Kimi CLI, iFlow CLI…, also with local models): who waits for you, for how long, and git status. Ported from aimonitor.',
    es: 'Tus agentes de programación con IA de un vistazo (Claude Code, Gemini CLI, Qwen Code, Codex CLI, OpenCode, Kimi CLI, iFlow CLI…, también con modelos locales): quién te espera, desde cuándo y el estado de git. Portado de aimonitor.',
    'zh-Hant': '一眼看清你的 AI 程式設計代理（Claude Code、Gemini CLI、Qwen Code、Codex CLI、OpenCode、Kimi CLI、iFlow CLI…，也支援本機模型）：誰在等你、等了多久，以及 git 狀態。移植自 aimonitor。',
    'zh-Hans': '一眼看清你的 AI 编程智能体（Claude Code、Gemini CLI、Qwen Code、Codex CLI、OpenCode、Kimi CLI、iFlow CLI…，也支持本地模型）：谁在等你、等了多久，以及 git 状态。移植自 aimonitor。',
    de: 'Deine KI-Coding-Agenten auf einen Blick (Claude Code, Gemini CLI, Qwen Code, Codex CLI, OpenCode, Kimi CLI, iFlow CLI…, auch mit lokalen Modellen): wer auf dich wartet, wie lange, und der Git-Status. Portiert von aimonitor.',
  },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'bot',
  widgets: [sessionsWidget, summaryWidget],
  sources: [sessionsSource],
  interludes: [runner],
  templates: [
    {
      id: 'dashboard',
      name: { en: 'AI agents dashboard', es: 'Tablero de agentes IA', 'zh-Hant': 'AI 代理儀表板', 'zh-Hans': 'AI 智能体仪表盘', de: 'KI-Agenten-Dashboard' },
      icon: 'bot',
      wide: [
        { x: 0, y: 0, w: 1, h: 1 / 6, widgets: ['summary'], chrome: 'bare' },
        { x: 0, y: 1 / 6, w: 0.55, h: 5 / 6, widgets: ['sessions'], chrome: 'bare' },
        { x: 0.55, y: 1 / 6, w: 1 / 4, h: 5 / 6, widgets: ['vitals/vitals'], chrome: 'bare' },
        { x: 4 / 5, y: 1 / 6, w: 1 / 5, h: 5 / 6, widgets: ['usage/rail'], chrome: 'bare' },
      ],
      square: [
        { x: 0, y: 0, w: 1, h: 1 / 6, widgets: ['summary'], chrome: 'bare' },
        { x: 0, y: 1 / 6, w: 1, h: 1 / 2, widgets: ['sessions'], chrome: 'bare' },
        { x: 0, y: 2 / 3, w: 1, h: 1 / 3, widgets: ['usage/rail', 'vitals/vitals'], chrome: 'bare' },
      ],
      tall: [
        { x: 0, y: 0, w: 1, h: 1 / 24, widgets: ['summary'], chrome: 'bare' },
        { x: 0, y: 1 / 24, w: 1, h: 13 / 24, widgets: ['sessions'], chrome: 'bare' },
        { x: 0, y: 7 / 12, w: 1, h: 5 / 24, widgets: ['vitals/vitals'], chrome: 'bare' },
        { x: 0, y: 19 / 24, w: 1, h: 5 / 24, widgets: ['usage/rail'], chrome: 'bare' },
      ],
    },
  ],
});
