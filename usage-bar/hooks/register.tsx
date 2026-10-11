import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { Activity, GitDiff, Head, Layout, PaneSettings, Session, Window } from '../types'

const windows = atom({ plugin: 'usage-bar', key: 'windows' } as const, null)
const head = atom({ plugin: 'usage-bar', key: 'head' } as const, null)
const git = atom({ plugin: 'usage-bar', key: 'git' } as const, null)
const session = atom({ plugin: 'usage-bar', key: 'session' } as const, null)
const hidden = atom({ plugin: 'usage-bar', key: 'hidden' } as const, null)
const activity = atom({ plugin: 'usage-bar', key: 'activity' } as const, null)
const settings = atom({ plugin: 'usage-bar', key: 'settings' } as const, null)
const commands = atom({ plugin: 'usage-bar', key: 'commands' } as const, null)

// Claude account (Anthropic subscription): percentage windows, session, week
// and Fable, from the OAuth usage endpoint.
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_USAGE_HEADERS = { accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20' }
// The endpoint is asked once every 30 seconds, for every session together,
// with a longer wait after a refusal (429, rejected key).
const REFRESH_MS = 30000
const BACKOFF_MS = 120000
// A session's own store entry older than this is dropped.
const SESSION_ENTRY_TTL_MS = 14 * 86400000
// The week window's length, and the gap to its even pace, in points, from
// which the band says it.
const WEEK_MS = 7 * 86400000
const PACE_MIN_GAP = 5
// The highest delay the projection alert takes, in minutes.
const PROJECTION_ALERT_MAX = 600
const TICK_MS = 30000
// A request with no answer after this is given up, as a refused one is.
const HTTP_TIMEOUT_MS = 10000
// Untracked files whose lines are counted; past it they count as files only.
const UNTRACKED_READS = 50
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const GREY = '#8a8f98'
// Added and removed lines: dark, yet readable on the band's background.
const DARK_GREEN = '#2e9e44'
const DARK_RED = '#c0392b'
// The branch: a grey-blue that stays readable on the band's dark background.
const BRANCH_BLUE = '#7f9fc4'
// The Claude account's windows, in the order the band shows them.
const CLAUDE_ENTRIES = [
  { kind: 'five_hour', icon: '⌛' },
  { kind: 'seven_day', icon: '📅' },
  { kind: 'fable', icon: 'F' },
] as const
const CONTEXT_ENTRY = { kind: 'context', icon: '🧠' } as const
// How the band is drawn: two lines, one, or not at all.
const LAYOUTS: readonly Layout[] = ['full', 'compact', 'hidden']

// The manifest's `userConfig` fields, checked: what the person set in /config.
type Config = {
  resetStyle: 'delay' | 'time'
  warnPercent: number
  dangerPercent: number
  /** Quota percentages that raise an alert, ascending. */
  quotaAlerts: number[]
  /** Context percentages that raise an alert, ascending. */
  contextAlerts: number[]
  /** Minutes before a full session quota from which an alert is raised; 0: none. */
  projectionAlertMinutes: number
  colorOk: string
  colorWarn: string
  colorDanger: string
  background: string
  layout: Layout
  showFable: boolean
  showContext: boolean
  showGit: boolean
  showCost: boolean
  showActivity: boolean
  showProjection: boolean
  showPace: boolean
}

// The band as it was before it had any setting.
const DEFAULTS: Config = {
  resetStyle: 'delay',
  warnPercent: 50,
  dangerPercent: 90,
  quotaAlerts: [50, 80, 90],
  contextAlerts: [80],
  projectionAlertMinutes: 30,
  colorOk: 'green',
  colorWarn: '#ff8c00',
  colorDanger: 'red',
  background: '#0d0f14',
  layout: 'full',
  showFable: true,
  showContext: true,
  showGit: true,
  showCost: true,
  showActivity: true,
  showProjection: true,
  showPace: true,
}

// "50,80,90" as numbers; undefined when a part is not a positive number. An
// empty text is no threshold at all: the alerts are off.
const parseThresholds = (text: string): number[] | undefined => {
  const parts = text.split(',').map(p => p.trim()).filter(Boolean).map(Number)

  return parts.every(n => Number.isFinite(n) && n > 0) ? parts : undefined
}

// The options as a whole Config: a field that is missing or does not fit takes
// its default, so a hand-edited settings file never breaks the band.
const readOptions = (options: PluginOptions | undefined): Config => {
  const value = (name: keyof Config) => options?.[name]
  const text = (name: keyof Config, fallback: string) => {
    const v = value(name)

    return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback
  }
  const percent = (name: keyof Config, fallback: number) => {
    const v = value(name)

    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : fallback
  }
  const minutes = (name: keyof Config, fallback: number) => {
    const v = value(name)

    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= PROJECTION_ALERT_MAX ? v : fallback
  }
  const flag = (name: keyof Config, fallback: boolean) => {
    const v = value(name)

    return typeof v === 'boolean' ? v : fallback
  }
  const thresholds = (name: keyof Config, fallback: number[]) => {
    const v = value(name)

    return (typeof v === 'string' ? parseThresholds(v) : undefined) ?? fallback
  }

  const warnPercent = percent('warnPercent', DEFAULTS.warnPercent)
  const dangerPercent = percent('dangerPercent', DEFAULTS.dangerPercent)
  // The warning threshold stays under the danger one: a crossed pair takes
  // both defaults.
  const isCrossed = warnPercent >= dangerPercent

  return {
    resetStyle: value('resetStyle') === 'time' ? 'time' : 'delay',
    warnPercent: isCrossed ? DEFAULTS.warnPercent : warnPercent,
    dangerPercent: isCrossed ? DEFAULTS.dangerPercent : dangerPercent,
    quotaAlerts: thresholds('quotaAlerts', DEFAULTS.quotaAlerts).sort((x, y) => x - y),
    contextAlerts: thresholds('contextAlerts', DEFAULTS.contextAlerts).sort((x, y) => x - y),
    projectionAlertMinutes: minutes('projectionAlertMinutes', DEFAULTS.projectionAlertMinutes),
    colorOk: text('colorOk', DEFAULTS.colorOk),
    colorWarn: text('colorWarn', DEFAULTS.colorWarn),
    colorDanger: text('colorDanger', DEFAULTS.colorDanger),
    background: text('background', DEFAULTS.background),
    layout: LAYOUTS.find(l => l === value('layout')) ?? DEFAULTS.layout,
    showFable: flag('showFable', DEFAULTS.showFable),
    showContext: flag('showContext', DEFAULTS.showContext),
    showGit: flag('showGit', DEFAULTS.showGit),
    showCost: flag('showCost', DEFAULTS.showCost),
    showActivity: flag('showActivity', DEFAULTS.showActivity),
    showProjection: flag('showProjection', DEFAULTS.showProjection),
    showPace: flag('showPace', DEFAULTS.showPace),
  }
}

// Set by `register`, which runs again whenever /config changes an option.
let config: Config = DEFAULTS

const colorOf = (percent: number) =>
  percent >= config.dangerPercent
    ? config.colorDanger
    : percent >= config.warnPercent
      ? config.colorWarn
      : config.colorOk

const formatReset = (minutes: number) => {
  const m = Math.max(0, Math.round(minutes))
  const hours = Math.floor(m / 60)

  // Past a day: "2d5h", or "2d" on a whole number of days.
  if (hours >= 24) {
    return `${Math.floor(hours / 24)}d${hours % 24 > 0 ? `${hours % 24}h` : ''}`
  }

  return hours > 0 ? `${hours}h${String(m % 60).padStart(2, '0')}` : `${m}m`
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// "17:00" for a reset within 24 hours, "Thu 17:00" past that, in local time.
const formatResetTime = (resetsAt: number, now: number) => {
  const at = new Date(resetsAt)
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`

  return resetsAt - now < 86400000 ? time : `${DAY_NAMES[at.getDay()]} ${time}`
}

// The window with its reset as the band prints it, in the style /config asks
// for; the render only prints and compares that text.
const withResetText = (w: Window, now: number): Window => {
  const resetText =
    config.resetStyle === 'time'
      ? w.resetsAt === undefined
        ? undefined
        : formatResetTime(w.resetsAt, now)
      : w.resetsInMinutes === undefined
        ? undefined
        : formatReset(w.resetsInMinutes)

  return resetText === undefined ? w : { ...w, resetText }
}

// The week's window with how far its usage runs ahead of an even pace, in
// points: the share used minus the share of the week gone by. Said only from
// PACE_MIN_GAP points; any other window, or one with no reset, goes on as it is.
const withPace = (w: Window, now: number): Window => {
  if (w.kind !== 'seven_day' || w.resetsAt === undefined) {
    return w
  }

  const elapsed = Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / WEEK_MS))
  const pace = Math.round(w.percentUsed - elapsed * 100)

  if (!Number.isFinite(pace)) {
    return w
  }

  return Math.abs(pace) >= PACE_MIN_GAP
    ? { ...w, pace, paceText: pace > 0 ? `▲+${pace}` : `▼${pace}` }
    : { ...w, pace }
}

// An ISO instant as epoch milliseconds; undefined when absent or unreadable.
const parseInstant = (text: string | undefined) => {
  const at = text ? Date.parse(text) : Number.NaN

  return Number.isFinite(at) ? at : undefined
}

// "claude-opus-5-5" reads "Opus-5.5", as the statusline prints it.
const formatModel = (model: string) => {
  const match = /^(?:claude-)?([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:\b|$)/i.exec(model)

  if (!match || !match[1]) {
    return model
  }

  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1)

  return `${family}-${match[2]}${match[3] ? `.${match[3]}` : ''}`
}

// `work`'s answer, or undefined once `ms` have passed: `$.http.fetch` has no
// time limit of its own, and one that never answers must not freeze the band.
const withTimeout = async <T,>($: EngineInterface, ms: number, work: Promise<T>): Promise<T | undefined> => {
  let timer: Timer | undefined
  const late = new Promise<undefined>(resolve => {
    timer = $.clock.after(ms, () => resolve(undefined))
  })

  try {
    return await Promise.race([work, late])
  } finally {
    timer?.cancel()
  }
}

// ---------------------------------------------------------------------------
// Claude account
// ---------------------------------------------------------------------------

type UsageLimit = {
  kind?: string
  percent?: number
  resets_at?: string
  scope?: { model?: { display_name?: string } }
}

// The Claude endpoint's entries as the band's windows; one whose reset has
// passed is an answer from before it and is left out.
const parseClaudeLimits = (limits: readonly UsageLimit[] | undefined, now: number): Window[] =>
  (limits ?? []).flatMap(l => {
    const kind =
      l.kind === 'session'
        ? 'five_hour'
        : l.kind === 'weekly_all'
          ? 'seven_day'
          : l.kind === 'weekly_scoped' && /fable/i.test(l.scope?.model?.display_name ?? '')
            ? 'fable'
            : undefined
    const resetsInMinutes = l.resets_at ? (Date.parse(l.resets_at) - now) / 60000 : undefined

    return kind === undefined || (resetsInMinutes !== undefined && resetsInMinutes <= 0)
      ? []
      : [{ kind, percentUsed: l.percent ?? 0, resetsInMinutes, resetsAt: parseInstant(l.resets_at) }]
  })

// What `$.store` keeps for every session of the machine: the last answer and
// when the next request may go, so sessions and reloads share one budget.
// `issue`: the last request was refused and `limits` is an older answer.
// `fetchedAt`: when `limits` was answered by the endpoint.
// `reason`: why the last request was refused, as /usage-bar status says it.
type Kept = { nextAt: number; limits?: UsageLimit[]; fetchedAt?: number; issue?: true; reason?: string }

// Until when the endpoint is left alone after it refused a request, as the
// last refresh read it from the store; 0 when it did not refuse. Kept here so
// /usage-bar can say it without reading the store in its hook.
const refusedUntil = { claude: 0 }

// The store's budget is shared, and a session that cannot reach the endpoint
// (an agent behind a gateway, a blocked network) would take the slot at every
// turn from the sessions that can. Each session therefore also waits on its
// own after a request of its own failed: the shared wait the first time, then
// twice as long at each failure in a row.
const OWN_WAIT_MAX_MS = 32 * 60000
type OwnWait = { failures: number; until: number }
const ownWait: { claude: OwnWait } = { claude: { failures: 0, until: 0 } }
const noteOwnRequest = (wait: OwnWait, isAnswered: boolean, now: number) => {
  wait.failures = isAnswered ? 0 : wait.failures + 1
  wait.until = isAnswered ? 0 : now + Math.min(BACKOFF_MS * 2 ** (wait.failures - 1), OWN_WAIT_MAX_MS)
}
// Whether this session holds a Claude credential to ask the usage endpoint
// with, as the last refresh saw it; without one it asks nothing and shows
// what the other sessions read.
let hasClaudeCredential = true

// Why the endpoint gave no usable answer: no answer within the time limit, a
// status that is not a success, or a body that is not what was asked for.
const refusalOf = (answer: { ok: boolean; status: number } | undefined) =>
  answer === undefined ? 'timed out' : answer.ok ? 'unreadable answer' : `HTTP ${answer.status}`

// The endpoint's entries, or why there are none.
const fetchClaudeLimits = async ($: EngineInterface, auth: string): Promise<UsageLimit[] | string> => {
  try {
    const answer = await withTimeout(
      $,
      HTTP_TIMEOUT_MS,
      $.http.fetch(CLAUDE_USAGE_URL, { auth, headers: CLAUDE_USAGE_HEADERS }),
    )
    const limits: unknown = answer?.ok ? JSON.parse(answer.text).limits : undefined

    return Array.isArray(limits) ? limits : refusalOf(answer)
  } catch {
    return 'request failed'
  }
}

// The Claude account's usage endpoint, asked with the session's own
// credential: the only source of Fable's window, and the figures the Claude
// apps show.
const readClaudeLimits = async ($: EngineInterface, now: number): Promise<Window[]> => {
  let kept = (await $.store.get('claude-usage')) as Kept | undefined
  let auth: string | undefined

  if ((kept === undefined || now >= kept.nextAt) && now >= ownWait.claude.until) {
    try {
      auth = (await $.session.authorize())?.handle
    } catch {
      // No credential to be had: as when there is none.
    }

    hasClaudeCredential = auth !== undefined
  }

  if (auth !== undefined) {
    // Claim the slot before asking, so two sessions do not ask together.
    await $.store.set('claude-usage', { ...kept, nextAt: now + BACKOFF_MS })
    const limits = await fetchClaudeLimits($, auth)
    noteOwnRequest(ownWait.claude, typeof limits !== 'string', now)
    // A refused request keeps the last answer, marked as such.
    kept =
      typeof limits === 'string'
        ? { nextAt: now + BACKOFF_MS, limits: kept?.limits, fetchedAt: kept?.fetchedAt, issue: true, reason: limits }
        : { nextAt: now + REFRESH_MS, limits, fetchedAt: now }
    await $.store.set('claude-usage', kept)
  }

  refusedUntil.claude = kept?.issue ? kept.nextAt : 0
  const parsed = parseClaudeLimits(kept?.limits, now)

  return kept?.issue ? parsed.map(w => ({ ...w, isStale: true })) : parsed
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

// The effort the settings hold: what /effort and the config menu write.
const readEffort = async ($: EngineInterface): Promise<string | undefined> => {
  const settings: {
    effortLevel?: unknown
    modelSettings?: Record<string, { effortLevel?: unknown } | undefined>
  } = await $.settings.read()
  const model = (await $.session.model()).toLowerCase()
  // A model's own level wins over the global one, as the engine applies them.
  // The longest id the model's name holds: "claude-opus-5-5", not "claude-opus-5".
  const own = Object.entries(settings.modelSettings ?? {})
    .filter(([id]) => model.includes(id.toLowerCase()))
    .sort(([x], [y]) => y.length - x.length)[0]?.[1]?.effortLevel
  const level = own ?? settings.effortLevel

  return level === undefined ? undefined : String(level)
}

// A file's lines as a diff would add them; 0 for a binary or unreadable one.
const countLines = async ($: EngineInterface, path: string) => {
  try {
    const text = await $.fs.read(path)

    if (text === '' || text.includes('\0')) {
      return 0
    }

    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  } catch {
    return 0
  }
}

// Uncommitted changes of the session's directory, untracked files included;
// null outside a repository.
const refreshGit = async ($: EngineInterface) => {
  let diff: GitDiff | null = null

  try {
    // `--no-optional-locks` on every background git: none takes the index
    // lock, so a `git add` or `git commit` run meanwhile never fails on it.
    let { exitCode, stdout } = await $.process.run(
      ['git', '--no-optional-locks', 'diff', '--shortstat', 'HEAD'],
      { timeoutMs: 5000 },
    )

    // A repository with no commit yet has no HEAD: count what is staged.
    if (exitCode !== 0) {
      ;({ exitCode, stdout } = await $.process.run(
        ['git', '--no-optional-locks', 'diff', '--shortstat', '--cached'],
        { timeoutMs: 5000 },
      ))
    }

    const count = (pattern: RegExp) => Number(pattern.exec(stdout)?.[1] ?? 0)

    if (exitCode === 0) {
      const listed = await $.process.run(
        ['git', '--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z'],
        { timeoutMs: 5000 },
      )
      const untracked = listed.exitCode === 0 ? listed.stdout.split('\0').filter(Boolean) : []
      let untrackedLines = 0

      for (const path of untracked.slice(0, UNTRACKED_READS)) {
        untrackedLines += await countLines($, path)
      }

      diff = {
        files: count(/(\d+) files? changed/) + untracked.length,
        added: count(/(\d+) insertions?\(\+\)/) + untrackedLines,
        removed: count(/(\d+) deletions?\(-\)/),
      }
    }
  } catch {
    diff = null
  }

  const prev = await read($, git)

  if (JSON.stringify(prev) !== JSON.stringify(diff)) {
    await update($, git, () => diff)
  }
}

// The branch and how many commits it is ahead of and behind its upstream,
// whatever `showGit` says. Nothing outside a repository, on a detached HEAD, or on an
// answer that is not `git status`'s own: the patterns are strict on purpose.
const readBranch = async ($: EngineInterface): Promise<Pick<Head, 'branch' | 'ahead' | 'behind'>> => {
  try {
    const { exitCode, stdout } = await $.process.run(
      ['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=no'],
      { timeoutMs: 5000 },
    )
    const branch = exitCode === 0 ? /^# branch\.head (\S+)$/m.exec(stdout)?.[1] : undefined

    if (branch === undefined || branch === '(detached)') {
      return {}
    }

    const counts = /^# branch\.ab \+(\d+) -(\d+)$/m.exec(stdout)
    const ahead = Number(counts?.[1] ?? 0)
    const behind = Number(counts?.[2] ?? 0)

    return { branch, ...(ahead > 0 ? { ahead } : {}), ...(behind > 0 ? { behind } : {}) }
  } catch {
    return {}
  }
}

// The head line: project, branch, model and effort. `effort`, when given,
// replaces the one kept.
const refreshHead = async ($: EngineInterface, effort?: string) => {
  const project = (await $.session.cwd()).split(/[\\/]/).filter(Boolean).pop() ?? '/'
  const model = formatModel(await $.session.model())
  const fallback = effort ?? (await readEffort($))
  // First what needs no process, with the branch last seen: the head line
  // never waits for git.
  await update($, head, (prev: Head | null) => ({
    ...prev,
    project,
    model,
    effort: effort ?? prev?.effort ?? fallback,
  }))
  // Never throws: a failed git leaves project, model and effort to show.
  const { branch, ahead, behind } = await readBranch($)
  const shown = await read($, head)

  if (shown !== null && (shown.branch !== branch || shown.ahead !== ahead || shown.behind !== behind)) {
    await update($, head, (prev: Head | null) =>
      prev === null
        ? prev
        : {
            project: prev.project,
            model: prev.model,
            effort: prev.effort,
            ...(branch === undefined ? {} : { branch }),
            ...(ahead === undefined ? {} : { ahead }),
            ...(behind === undefined ? {} : { behind }),
          },
    )
  }
}

// What `$.store` keeps of the session window's recent climb, for every
// session of the machine: one cycle's samples, oldest first.
type Burn = { resetsAt: number; samples: { at: number; percent: number }[] }

const BURN_WINDOW_MS = 15 * 60000
const BURN_MIN_SPAN_MS = 5 * 60000
const BURN_MIN_RISE = 1
const BURN_SAMPLES = 31

// The windows, with on the session's one when it will be full at the pace of
// the last 15 minutes, if that comes before its reset. Never throws: without
// a usable history the windows go on as they are.
const withProjection = async ($: EngineInterface, seen: Window[], now: number): Promise<Window[]> => {
  try {
    const w = seen.find(x => x.kind === 'five_hour')
    const resetsAt = w?.resetsAt

    if (w === undefined || resetsAt === undefined) {
      return seen
    }

    const kept = (await $.store.get('claude-burn')) as Burn | undefined
    // A reset instant a few seconds off is the same cycle; another one starts
    // the history over.
    const isSame = kept !== undefined && Math.abs(kept.resetsAt - resetsAt) < 60000
    const recent = (isSame ? kept.samples : []).filter(s => now - s.at <= BURN_WINDOW_MS)
    const last = recent[recent.length - 1]
    // One sample per refresh period, so 31 of them span the 15 minutes
    // however often the hooks ask for a refresh.
    const samples =
      last === undefined || now - last.at >= REFRESH_MS
        ? [...recent, { at: now, percent: w.percentUsed }].slice(-BURN_SAMPLES)
        : recent

    if (!isSame || samples !== recent || recent.length !== kept.samples.length) {
      await $.store.set('claude-burn', { resetsAt: isSame ? kept.resetsAt : resetsAt, samples })
    }

    const first = samples[0]
    const span = first === undefined ? 0 : now - first.at
    const rise = first === undefined ? 0 : w.percentUsed - first.percent

    if (span < BURN_MIN_SPAN_MS || rise < BURN_MIN_RISE || w.percentUsed >= 100) {
      return seen
    }

    const exhaustsInMinutes = ((100 - w.percentUsed) / rise) * (span / 60000)

    return now + exhaustsInMinutes * 60000 < resetsAt
      ? seen.map(x =>
          x === w ? { ...x, exhaustsInMinutes, exhaustText: `full in ${formatReset(exhaustsInMinutes)}` } : x,
        )
      : seen
  } catch {
    return seen
  }
}

// The Claude windows and the context window.
const refreshFigures = async ($: EngineInterface) => {
  const { rateLimits, context: usedContext, cost } = await $.session.usage()
  const contextPercent = usedContext.percent
  const now = await $.clock.now()
  // No ledger on this host, or no usable amount: no cost at all, never "$NaN".
  const costUsd = cost?.usd
  const spent: Session =
    typeof costUsd === 'number' && Number.isFinite(costUsd) ? { costUsd } : {}

  if (JSON.stringify(await read($, session)) !== JSON.stringify(spent)) {
    await update($, session, () => spent)
  }

  const fromEndpoint = await readClaudeLimits($, now)

  const context: Window[] =
    contextPercent === undefined ? [] : [{ kind: 'context', percentUsed: contextPercent }]
  // The engine keeps a window's last figure until the next API response: one
  // whose reset has passed is from before it and is left out, as the
  // endpoint's are.
  const fromEngine: Window[] = rateLimits
    .map(w => ({
      kind: w.kind,
      percentUsed: w.percentUsed,
      resetsInMinutes: w.resetsAt ? (Date.parse(w.resetsAt) - now) / 60000 : undefined,
      resetsAt: parseInstant(w.resetsAt),
    }))
    .filter(w => w.resetsInMinutes === undefined || w.resetsInMinutes > 0)
  // The engine's figures come from response headers and run behind the
  // endpoint's; within one window usage only grows, so the higher one is newer.
  // A figure kept through a refusal may be from an earlier window: there the
  // engine's own is the newer one, whatever it says.
  const merged = [
    ...context,
    ...fromEndpoint.map(w => {
      const engine = fromEngine.find(x => x.kind === w.kind)

      return engine !== undefined && (w.isStale || engine.percentUsed > w.percentUsed) ? engine : w
    }),
    ...fromEngine.filter(w => !fromEndpoint.some(x => x.kind === w.kind)),
  ].map(w => withPace(withResetText(w, now), now))
  // The projection alert needs the projection even when the band hides it.
  const projected =
    config.showProjection || config.projectionAlertMinutes > 0 ? await withProjection($, merged, now) : merged
  await update($, windows, () => projected)
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

// What `$.store` keeps for every session of the machine, so a threshold is
// said once: per Claude window the highest threshold reached in its cycle,
// and under `projection` the cycle whose projected exhaustion was said.
type KeptAlert = { resetsAt?: number; level: number }
type KeptAlerts = Record<string, KeptAlert | undefined>

const QUOTA_NAMES: Record<string, string> = {
  five_hour: 'Session',
  seven_day: 'Week',
  fable: 'Fable',
}
const ALERT_TOAST_MS = 8000
// The endpoint's reset instants vary by a few seconds within one cycle.
const SAME_CYCLE_MS = 60000

const isSameCycle = (x: number, y: number) => Math.abs(x - y) < SAME_CYCLE_MS

// The context is each session's own: one store entry per session keeps the
// highest context threshold it said, and when.
type KeptContextAlert = { level: number; at: number }

const CONTEXT_ALERT_PREFIX = 'context-alert:'

// The toast to raise when this session's context climbed past a threshold,
// if any. A context back under a threshold (after /compact) lowers the kept
// level: the alert is armed again. The level goes to the store before the
// toast is said. Never throws: without a session id or a store, no alert.
const contextAlert = async ($: EngineInterface, seen: readonly Window[]): Promise<string | undefined> => {
  try {
    const w = seen.find(x => x.kind === 'context')

    // No alert for a gauge the band does not show.
    if (w === undefined || !config.showContext || config.contextAlerts.length === 0) {
      return undefined
    }

    const now = await $.clock.now()
    const key = `${CONTEXT_ALERT_PREFIX}${await $.session.id()}`
    const kept = (await $.store.get(key)) as KeptContextAlert | undefined
    const reached = kept?.level ?? 0
    // The highest threshold passed alone: one toast, not one per threshold.
    const level = Math.max(0, ...config.contextAlerts.filter(t => w.percentUsed >= t))

    if (level === reached) {
      return undefined
    }

    await $.store.set(key, { level, at: now })

    // Entries of sessions long gone.
    for (const other of await $.store.keys()) {
      const old = other.startsWith(CONTEXT_ALERT_PREFIX)
        ? ((await $.store.get(other)) as KeptContextAlert | undefined)
        : undefined

      if (old !== undefined && now - old.at >= SESSION_ENTRY_TTL_MS) {
        await $.store.delete(other)
      }
    }

    return level > reached ? `Context: ${level}% reached` : undefined
  } catch {
    return undefined
  }
}

// Toasts when a Claude window climbs past a threshold, the session quota is
// projected full within the set delay or the context climbs past one, from
// the figures the band shows. The levels go to the store before any toast: a
// failed toast is not said again.
const refreshAlerts = async ($: EngineInterface) => {
  const seen = (await read($, windows)) ?? []
  const kept = ((await $.store.get('alerts')) as KeptAlerts | undefined) ?? {}
  const next: KeptAlerts = { ...kept }
  const toasts: string[] = []

  for (const [kind, name] of Object.entries(QUOTA_NAMES)) {
    const w = seen.find(x => x.kind === kind)
    // No alert for a window the band does not show.
    const isShown = kind !== 'fable' || config.showFable

    if (w === undefined || !isShown || config.quotaAlerts.length === 0) {
      continue
    }

    const before = kept[kind]
    // A reset instant that is unknown on either side is no new cycle.
    const isNewCycle =
      before?.resetsAt !== undefined &&
      w.resetsAt !== undefined &&
      !isSameCycle(before.resetsAt, w.resetsAt)
    const reached = isNewCycle ? 0 : (before?.level ?? 0)
    // The highest threshold passed alone: one toast, not one per threshold.
    const level = Math.max(reached, ...config.quotaAlerts.filter(t => w.percentUsed >= t))

    const learnsReset = before?.resetsAt === undefined && w.resetsAt !== undefined

    if (before === undefined || isNewCycle || learnsReset || level > reached) {
      next[kind] = { resetsAt: isNewCycle ? w.resetsAt : (before?.resetsAt ?? w.resetsAt), level }
    }

    if (level > reached) {
      const reset = w.resetsInMinutes === undefined ? '' : ` (resets in ${formatReset(w.resetsInMinutes)})`
      toasts.push(`${name} quota: ${level}% reached${reset}`)
    }
  }

  // The session quota full within the set delay, at its recent pace: said once
  // in a cycle, and again in the next one.
  const fiveHour = seen.find(x => x.kind === 'five_hour')
  const left = fiveHour?.exhaustsInMinutes

  if (
    config.projectionAlertMinutes > 0 &&
    fiveHour?.resetsAt !== undefined &&
    left !== undefined &&
    left <= config.projectionAlertMinutes
  ) {
    const before = kept['projection']

    if (before?.resetsAt === undefined || !isSameCycle(before.resetsAt, fiveHour.resetsAt)) {
      next['projection'] = { resetsAt: fiveHour.resetsAt, level: 1 }
      toasts.push(`Session quota: full in ${formatReset(left)} at the current pace`)
    }
  }

  if (JSON.stringify(next) !== JSON.stringify(kept)) {
    await $.store.set('alerts', next)
  }

  const contextToast = await contextAlert($, seen)

  if (contextToast !== undefined) {
    toasts.push(contextToast)
  }

  for (const text of toasts) {
    try {
      $.ui.toast(text, { timeoutMs: ALERT_TOAST_MS })
    } catch {
      // A surface that refuses a toast leaves the others to show.
    }
  }
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

// The list does not say when the work began: the band counts from the moment
// it first saw a subagent's id. That moment is kept in the atom, not in the
// module: a change in /config reloads the module.

const minutesSince = (since: number, now: number) => Math.max(0, Math.floor((now - since) / 60000))

// The session's running subagents; none when the list gives nothing usable.
// `prev`: what the band showed, for the moment each was first seen.
const readAgents = async (
  $: EngineInterface,
  now: number,
  prev: readonly Activity[],
): Promise<Activity[]> => {
  let running: { id: string; type: string }[] = []

  try {
    const listed: unknown = await $.agent.list()

    running = Array.isArray(listed)
      ? listed.filter(
          a => a?.status === 'running' && typeof a.id === 'string' && typeof a.type === 'string',
        )
      : []
  } catch {
    running = []
  }

  // Ids that left the list are forgotten with their entry.
  return running.map(a => {
    const since = prev.find(p => p.id === a.id)?.since ?? now

    return { id: a.id, label: a.type, since, minutes: minutesSince(since, now) }
  })
}

// The running subagents the band names, each with the minutes it has run.
const refreshActivity = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const prev = (await read($, activity)) ?? []
  const shown = await readAgents($, now, prev)

  if (JSON.stringify(prev) !== JSON.stringify(shown)) {
    await update($, activity, () => shown)
  }
}

// The slash commands a segment of the band opens when pressed.
const LINKED_COMMANDS = ['usage', 'cost']

// Which of those commands the session lists: a segment is a button only for
// a listed one. Never throws: without a usable list the band keeps the one it
// had, and none at all leaves every such segment a plain text.
const refreshCommands = async ($: EngineInterface) => {
  try {
    const listed: unknown = await $.command.list()

    if (!Array.isArray(listed)) {
      return
    }

    const names = LINKED_COMMANDS.filter(name => listed.some(c => c?.name === name))

    if (JSON.stringify(await read($, commands)) !== JSON.stringify(names)) {
      await update($, commands, () => names)
    }
  } catch {
    // No list here: the segments stay as they were.
  }
}

// What a hook asks for: the whole band or the working tree alone; the effort
// to show, given or read again from the settings.
// `forces`: the endpoint is asked now, whatever its wait.
type Job = { isFull: boolean; effort?: string; rereadsEffort?: boolean; forces?: boolean }

let queued: Job | undefined
let isDraining = false

// Ends the wait of the endpoint's store entry, keeping its last value. Not
// the wait set after a refusal: the command must not hammer a server that
// just said no.
const endWait = async ($: EngineInterface) => {
  const kept = (await $.store.get('claude-usage')) as Kept | undefined

  if (kept !== undefined && !kept.issue) {
    await $.store.set('claude-usage', { ...kept, nextAt: 0 })
  }
}

// Runs the queued jobs one at a time. Each part stands alone: one that fails
// leaves the others, and the next job, to run.
const drain = async ($: EngineInterface) => {
  isDraining = true

  try {
    while (queued !== undefined) {
      const job = queued
      queued = undefined

      if (job.forces) {
        try {
          await endWait($)
        } catch {
          // The endpoint is asked when its wait ends.
        }
      }

      if (job.isFull) {
        try {
          await refreshHead($, job.effort ?? (job.rereadsEffort ? await readEffort($) : undefined))
        } catch {
          // The head keeps what it showed.
        }

        try {
          await refreshFigures($)
        } catch {
          // The figures keep what they showed.
        }

        try {
          await refreshAlerts($)
        } catch {
          // No alert this time; the figures are drawn all the same.
        }

        // Swallows its own failure.
        await refreshCommands($)
      }

      // No git process for a segment the band does not draw.
      if (config.showGit) {
        try {
          await refreshGit($)
        } catch {
          // The diff keeps what it showed.
        }
      }

      // No list for a segment the band does not draw.
      if (config.showActivity) {
        try {
          await refreshActivity($)
        } catch {
          // The activity keeps what it showed.
        }
      }
    }
  } finally {
    isDraining = false
  }
}

// Asks for a refresh without waiting for it: no hook, hence no session start,
// slash command or tool call, is held up by the network or by git. Requests
// made while one runs fold into a single next one.
const schedule = ($: EngineInterface, job: Job) => {
  queued = {
    isFull: job.isFull || queued?.isFull === true,
    effort: job.effort ?? queued?.effort,
    rereadsEffort: job.rereadsEffort || queued?.rereadsEffort,
    forces: job.forces || queued?.forces,
  }

  if (!isDraining) {
    void drain($)
  }
}

// ---------------------------------------------------------------------------
// Width
// ---------------------------------------------------------------------------

// Code point ranges a terminal draws two cells wide: East Asian wide forms and
// the emoji that are pictures by default.
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x3fffd],
]
// Combining marks, joiners and variation selectors: no cell of their own.
const ZERO_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x200b, 0x200d],
  [0xfe00, 0xfe0f],
]

const isWithin = (ranges: readonly (readonly [number, number])[], code: number) =>
  ranges.some(([from, to]) => code >= from && code <= to)

// How many terminal cells `text` takes: 2 for an emoji or a wide character,
// 1 for any other.
export const cellWidth = (text: string): number => {
  let cells = 0

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    cells += isWithin(ZERO_RANGES, code) ? 0 : isWithin(WIDE_RANGES, code) ? 2 : 1
  }

  return cells
}

// One piece of a line: a text, or a button when it names a command to open.
// `dropAt`: the narrowness level from which the piece is left out.
type Part = {
  text: string
  color?: string
  bold?: boolean
  command?: string
  key?: string
  dropAt?: number
}
type Segment = { key: string; parts: Part[]; dropAt?: number }

// The band's own horizontal padding, and the ' | ' between two segments.
const PADDING_CELLS = 2
const SEPARATOR = ' | '
const NARROWEST = 3

const isKept = (level: number) => (x: { dropAt?: number }) => x.dropAt === undefined || level < x.dropAt

// The line at the first level, from the whole one down, that fits `columns`
// cells; the narrowest when none does. A plain button draws its label alone.
const fitLine = (segments: readonly Segment[], columns: number): Segment[] => {
  let fitted: Segment[] = []

  for (let level = 0; level <= NARROWEST; level += 1) {
    fitted = segments
      .filter(isKept(level))
      .map(s => ({ ...s, parts: s.parts.filter(isKept(level)) }))
      .filter(s => s.parts.length > 0)
    const cells =
      PADDING_CELLS +
      Math.max(0, fitted.length - 1) * cellWidth(SEPARATOR) +
      fitted.reduce((sum, s) => sum + s.parts.reduce((n, p) => n + cellWidth(p.text), 0), 0)

    if (cells <= columns) {
      break
    }
  }

  return fitted
}

// Opens a slash command as if the person had typed it, from a button of the
// band. Never throws: a refused command leaves the band as it is.
const openCommand = async ($: EngineInterface, name: string) => {
  try {
    await $.command.run({ command: name })
    // What it changed (the model, the context) shows without waiting a tick.
    schedule($, { isFull: true, rereadsEffort: true })
  } catch {
    // Unknown here, or refused while a turn waits: nothing opens.
  }
}

// ---------------------------------------------------------------------------
// Settings pane
// ---------------------------------------------------------------------------

const PANE = 'usage-bar-config'
// A `userConfig` field's row in /config is keyed `<plugin>.<field>`.
const KEY_PREFIX = 'usage-bar.'
// Titles, the eighteen fields, the last refusal and the two buttons.
const PANE_ROWS = 25
const ON = 'on'
const OFF = 'off'
const FLAG_OPTIONS = [{ value: ON }, { value: OFF }] as const

// One field of the pane. `flag` and `choice` are picked; the others are typed
// and checked when sent.
type Field = {
  name: keyof Config
  label: string
  kind: 'flag' | 'choice' | 'percent' | 'minutes' | 'thresholds' | 'color'
  options?: readonly string[]
}

// The manifest's fields as the pane groups them. The rows are hidden from
// /config, and `$.config.list()` leaves a hidden row out: the pane takes its
// fields from this table and their values from the options `register` was given.
const SETTING_GROUPS: readonly { title: string; fields: readonly Field[] }[] = [
  {
    title: 'Thresholds and colors',
    fields: [
      { name: 'warnPercent', label: 'Warning threshold', kind: 'percent' },
      { name: 'dangerPercent', label: 'Danger threshold', kind: 'percent' },
      { name: 'colorOk', label: 'Color: ok', kind: 'color' },
      { name: 'colorWarn', label: 'Color: warning', kind: 'color' },
      { name: 'colorDanger', label: 'Color: danger', kind: 'color' },
      { name: 'background', label: 'Background', kind: 'color' },
    ],
  },
  {
    title: 'Alerts',
    fields: [
      { name: 'quotaAlerts', label: 'Quota alerts', kind: 'thresholds' },
      { name: 'contextAlerts', label: 'Context alerts', kind: 'thresholds' },
      { name: 'projectionAlertMinutes', label: 'Projection alert (minutes)', kind: 'minutes' },
    ],
  },
  {
    title: 'Segments',
    fields: [
      { name: 'showFable', label: 'Show Fable', kind: 'flag' },
      { name: 'showContext', label: 'Show context', kind: 'flag' },
      { name: 'showGit', label: 'Show working tree', kind: 'flag' },
      { name: 'showCost', label: 'Show cost', kind: 'flag' },
      { name: 'showActivity', label: 'Show activity', kind: 'flag' },
      { name: 'showProjection', label: 'Show projection', kind: 'flag' },
      { name: 'showPace', label: 'Show weekly pace', kind: 'flag' },
      { name: 'resetStyle', label: 'Reset style', kind: 'choice', options: ['delay', 'time'] },
      { name: 'layout', label: 'Layout', kind: 'choice', options: LAYOUTS },
    ],
  },
]

// The settings as the pane shows them: the thresholds as the text /config holds.
const settingsOf = (c: Config): PaneSettings['values'] => ({
  ...c,
  quotaAlerts: c.quotaAlerts.join(','),
  contextAlerts: c.contextAlerts.join(','),
})

// A color as the band's `Text` takes one: a name, or a raw color.
const COLOR =
  /^([a-z][a-z0-9]*|#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|ansi256\(\s*\d{1,3}\s*\))$/i

// A list of plain decimals, or nothing.
const THRESHOLDS = /^(\d+(\.\d+)?\s*(,\s*\d+(\.\d+)?\s*)*)?$/

// What a field is set to from what was picked or typed, as its /config row
// takes it; undefined when it does not fit, said in a word by `expects`.
const parseSetting = ({ kind, options }: Field, typed: string): string | number | boolean | undefined => {
  const text = typed.trim()

  switch (kind) {
    case 'flag':
      return text === ON ? true : text === OFF ? false : undefined
    case 'choice':
      return options?.includes(text) ? text : undefined
    case 'percent': {
      // Plain decimals only: `Number` alone would take 0x1A or 1e1.
      const n = /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN

      return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined
    }
    case 'minutes': {
      // Whole minutes; 0 turns the alert off.
      const n = /^\d+$/.test(text) ? Number(text) : Number.NaN

      return n >= 0 && n <= PROJECTION_ALERT_MAX ? n : undefined
    }
    case 'thresholds':
      // Plain decimals only, as for a percentage.
      return THRESHOLDS.test(text) && parseThresholds(text) !== undefined ? text : undefined
    case 'color':
      // A channel or a palette index above 255 is no color.
      return COLOR.test(text) && (text.match(/\d+/g) ?? []).every(n => text.startsWith('#') || Number(n) <= 255)
        ? text
        : undefined
  }
}

const EXPECTS: Record<Field['kind'], string> = {
  flag: 'on or off',
  choice: 'one of the listed values',
  percent: 'a number from 0 to 100',
  minutes: `a whole number from 0 to ${PROJECTION_ALERT_MAX} (0: off)`,
  thresholds: 'positive numbers separated by commas',
  color: 'a color name, #rgb, #rrggbb, rgb(r,g,b) or ansi256(n)',
}

// Fills the pane's values from the options this module was loaded with.
const fillSettings = ($: EngineInterface) => update($, settings, () => ({ values: settingsOf(config) }))

// Opens the pane and says, in one line, whether it is drawn. Never throws.
const openPane = async ($: EngineInterface): Promise<string> => {
  try {
    await fillSettings($)
    const opened = await $.ui.open({
      id: PANE,
      title: 'usage-bar',
      focus: true,
      closeOnEscape: true,
      holdToasts: true,
      rows: PANE_ROWS,
    })

    return opened.isPlaced
      ? 'usage-bar: settings opened'
      : `usage-bar: settings pane opened but not shown here (${opened.reason})`
  } catch {
    return 'usage-bar: the settings pane could not be opened'
  }
}

// Never throws: a refused close leaves the pane up.
const closePane = async ($: EngineInterface) => {
  try {
    await $.ui.close({ id: PANE })
  } catch {
    // Still open; Escape closes it too.
  }
}

// A change in /config reloads the module while the pane stays up: its values
// are read again from the options the new module was given. Never throws.
const resumePane = async ($: EngineInterface) => {
  try {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      // The notice stays: a reload follows the very change that raised it.
      await update($, settings, (s: PaneSettings | null) => ({
        values: settingsOf(config),
        ...(s?.notice === undefined ? {} : { notice: s.notice }),
      }))
    }
  } catch {
    // No pane list here: the pane keeps what it showed.
  }
}

// A setting changed outside the pane (/config key=value) shows in it at once.
// Never throws.
const noteSetting = async ($: EngineInterface, key: string, value: unknown) => {
  if (!key.startsWith(KEY_PREFIX) || !['string', 'number', 'boolean'].includes(typeof value)) {
    return
  }

  try {
    if ((await read($, settings)) !== null) {
      await update($, settings, (s: PaneSettings | null) => ({
        values: { ...s?.values, [key.slice(KEY_PREFIX.length)]: value as string | number | boolean },
      }))
    }
  } catch {
    // The pane keeps what it showed.
  }
}

// Why a threshold cannot take `value`: the warning one stays strictly under
// the danger one, as the pane shows them. Undefined when it can, or on any
// other field. Never throws.
const crossedRefusal = async ($: EngineInterface, field: Field, value: string | number | boolean) => {
  if (typeof value !== 'number' || (field.name !== 'warnPercent' && field.name !== 'dangerPercent')) {
    return undefined
  }

  let values: PaneSettings['values'] = settingsOf(config)

  try {
    values = (await read($, settings))?.values ?? values
  } catch {
    // No pane values here: the loaded options are the current ones.
  }

  const warn = Number(values.warnPercent)
  const danger = Number(values.dangerPercent)

  if (field.name === 'warnPercent') {
    return value >= danger ? `must stay under the danger threshold (${danger})` : undefined
  }

  return value <= warn ? `must be above the warning threshold (${warn})` : undefined
}

// One change asked from the pane, written as /config would write it. Never
// throws: a value that does not fit, a `{ deny }` or a rejection leaves the
// pane drawn with the value it had, and says why in the pane (a toast would
// wait behind the pane until it closes).
const changeSetting = async ($: EngineInterface, field: Field, typed: string) => {
  const value = parseSetting(field, typed)
  let refusal: string | undefined
  let written: unknown

  if (value === undefined) {
    refusal = `expects ${EXPECTS[field.kind]}`
  } else if ((refusal = await crossedRefusal($, field, value)) === undefined) {
    try {
      const result = await $.config.set({ key: `${KEY_PREFIX}${field.name}`, value })
      // A hook above may have clamped it: what was written is what is shown.
      written = result.value
      refusal = result.deny
    } catch {
      refusal = 'change refused'
    }
  }

  const notice = refusal === undefined ? undefined : `${field.label}: ${refusal}`
  const shown = typeof written === 'object' || written === undefined ? value : (written as string | number | boolean)

  try {
    // Written even on a refusal: the redraw puts the kept value back in the field.
    await update($, settings, (s: PaneSettings | null) => ({
      values: {
        ...(s?.values ?? settingsOf(config)),
        ...(notice === undefined && shown !== undefined ? { [field.name]: shown } : {}),
      },
      ...(notice === undefined ? {} : { notice }),
    }))
  } catch {
    // The pane keeps what it showed.
  }
}

// The pane's "Defaults" button: every setting that differs from its default
// is written back to it, as /config would write it. Never throws: a refused
// row keeps its value, and the pane says how many were refused.
const resetSettings = async ($: EngineInterface) => {
  const defaults = settingsOf(DEFAULTS)
  let shown: PaneSettings['values'] = settingsOf(config)

  try {
    shown = (await read($, settings))?.values ?? shown
  } catch {
    // No pane values here: the loaded options are the current ones.
  }

  const written: PaneSettings['values'] = {}
  const refused: string[] = []

  for (const field of SETTING_GROUPS.flatMap(group => group.fields)) {
    const value = defaults[field.name]

    if (value === undefined || shown[field.name] === value) {
      continue
    }

    try {
      const result = await $.config.set({ key: `${KEY_PREFIX}${field.name}`, value })

      if (result.deny === undefined) {
        written[field.name] = value
      } else {
        refused.push(`${field.label}: ${result.deny}`)
      }
    } catch {
      refused.push(`${field.label}: change refused`)
    }
  }

  try {
    await update($, settings, (s: PaneSettings | null) => ({
      values: { ...(s?.values ?? shown), ...written },
      ...(refused.length === 0
        ? {}
        : { notice: `Defaults: ${refused.length} refused (${refused[0]})` }),
    }))
  } catch {
    // The pane keeps what it showed.
  }
}

// ---------------------------------------------------------------------------
// /usage-bar
// ---------------------------------------------------------------------------

const COMMAND = 'usage-bar'
const COMMAND_ARGS = '[hide|show|full|compact|refresh|status|config]'
const COMMAND_USAGE = `Usage: /usage-bar ${COMMAND_ARGS} - without an argument, hides or shows the band; full and compact pick the layout; status reports the state of the Claude account; config opens the settings`
// Where `$.store` keeps the last layout the band was drawn with.
const LAYOUT_BEFORE_HIDE = 'layout-before-hide'

// Keeps the layout in place for /usage-bar show, unless hidden. Never throws.
const keepLayout = async ($: EngineInterface) => {
  if (config.layout === 'hidden') {
    return
  }

  try {
    await $.store.set(LAYOUT_BEFORE_HIDE, config.layout)
  } catch {
    // Not kept: /usage-bar show brings the full band back.
  }
}

// Declares /usage-bar. Never throws: a refused registration leaves the band
// as it is, without its command.
const registerCommand = async ($: EngineInterface) => {
  try {
    await $.command.register({
      name: COMMAND,
      description:
        'Hides, shows or refreshes the usage-bar band, picks its layout; status reports its state, config opens its settings',
      argumentHint: COMMAND_ARGS,
      immediate: true,
    })
  } catch {
    // No command this session.
  }
}

// Writes the `layout` setting as /config would, so it lasts past the session.
// Why it was not written, or undefined once it is. Never throws.
const writeLayout = async ($: EngineInterface, layout: Layout): Promise<string | undefined> => {
  try {
    const result = await $.config.set({ key: `${KEY_PREFIX}layout`, value: layout })

    if (result.deny !== undefined) {
      return result.deny
    }
  } catch {
    return 'change refused'
  }

  // What the reload that follows the change reads from the options: the band
  // takes it without waiting for it.
  config = { ...config, layout }
  await keepLayout($)

  try {
    if ((await read($, settings)) !== null) {
      await update($, settings, (s: PaneSettings | null) => ({ values: { ...s?.values, layout } }))
    }
  } catch {
    // The pane keeps what it showed.
  }

  return undefined
}

// hide, show, full, compact, or no argument, which toggles. Hiding stops the
// drawing alone: quotas, alerts and projections go on being refreshed. When
// the setting cannot be written, the `hidden` atom hides the band for the
// session, and the answer says so. Never throws.
const answerLayout = async (
  $: EngineInterface,
  arg: '' | 'hide' | 'show' | 'full' | 'compact',
): Promise<string> => {
  let isSessionHidden = false

  try {
    isSessionHidden = (await read($, hidden)) === true
  } catch {
    // No atom here: the setting alone says it.
  }

  const hideForSession = async (flag: boolean) => {
    try {
      await update($, hidden, () => flag)
    } catch {
      // The setting alone says it.
    }
  }

  if (arg === 'hide' || (arg === '' && config.layout !== 'hidden' && !isSessionHidden)) {
    const shown = 'usage-bar: band hidden (/usage-bar show to bring it back)'

    if (config.layout === 'hidden') {
      return shown
    }

    const refusal = await writeLayout($, 'hidden')
    await hideForSession(refusal !== undefined)

    return refusal === undefined
      ? shown
      : `usage-bar: band hidden for this session only, setting not saved (${refusal}); /usage-bar show to bring it back`
  }

  let target: Layout = config.layout

  if (arg === 'full' || arg === 'compact') {
    target = arg
  } else if (config.layout === 'hidden') {
    target = 'full'

    try {
      const before = await $.store.get(LAYOUT_BEFORE_HIDE)

      if (before === 'compact') {
        target = before
      }
    } catch {
      // Unknown: the full band.
    }
  }

  const refusal = target === config.layout ? undefined : await writeLayout($, target)
  await hideForSession(false)

  if (refusal !== undefined) {
    return config.layout === 'hidden'
      ? `usage-bar: the band stays hidden, setting refused (${refusal})`
      : `usage-bar: layout unchanged (${config.layout}), setting refused (${refusal})`
  }

  return arg === 'full' || arg === 'compact' ? `usage-bar: layout ${target}` : 'usage-bar: band shown'
}

// "17:00:05", in local time.
const formatClock = (at: number) => {
  const d = new Date(at)

  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

const NO_CREDENTIAL = 'this session has no Claude credential: it shows what the other sessions read'

// What /usage-bar status answers: the layout, then the Claude account's line.
// It reads the atoms and the store and asks no endpoint. Never throws: a part
// that cannot be read is said "unknown".
const answerStatus = async ($: EngineInterface): Promise<string> => {
  let now: number | undefined

  try {
    now = await $.clock.now()
  } catch {
    // No clock: the delays are unknown.
  }

  const nextTry = (nextAt: unknown) =>
    now === undefined || typeof nextAt !== 'number'
      ? 'next try unknown'
      : `next try in ${Math.max(0, Math.ceil((nextAt - now) / 1000))} s`
  const at = (instant: unknown) => (typeof instant === 'number' ? formatClock(instant) : undefined)
  // Entries kept by an earlier version carry no reason.
  const reasonOf = (reason: unknown) => (typeof reason === 'string' ? ` (${reason})` : '')
  let isSessionHidden = false

  try {
    isSessionHidden = (await read($, hidden)) === true
  } catch {
    // No atom here: the setting alone says it.
  }

  const layout =
    isSessionHidden && config.layout !== 'hidden' ? `${config.layout} (hidden for this session)` : config.layout
  const lines = [`usage-bar: layout ${layout}`]
  let claude = 'unknown'

  try {
    const kept = (await $.store.get('claude-usage')) as Kept | undefined
    const answered = at(kept?.fetchedAt)

    claude =
      kept === undefined
        ? 'not asked yet'
        : [
            answered === undefined ? 'no valid answer received' : `last valid answer at ${answered}`,
            ...(kept.issue
              ? [`${kept.limits ? 'figure kept after a refusal' : 'last request refused'}${reasonOf(kept.reason)}`]
              : []),
            ...(hasClaudeCredential ? [nextTry(Math.max(kept.nextAt, ownWait.claude.until))] : [NO_CREDENTIAL]),
          ].join(', ')
  } catch {
    // Unreadable store.
  }

  lines.push(`Claude: ${claude}`)

  return lines.join('\n')
}

// What /usage-bar answers: one line, but for status.
const answerCommand = async ($: EngineInterface, args: string): Promise<string> => {
  const arg = args.trim().toLowerCase()

  if (arg === 'refresh') {
    schedule($, { isFull: true, forces: true })
    // The wait a refusal left, as the last refresh saw it.
    const seconds = Math.ceil((refusedUntil.claude - (await $.clock.now())) / 1000)

    return seconds > 0
      ? `usage-bar: refresh requested; the server refused the last request, next try in ${seconds} s`
      : 'usage-bar: refresh requested'
  }

  if (arg === 'config') {
    return openPane($)
  }

  if (arg === 'status') {
    return answerStatus($)
  }

  if (arg === '' || arg === 'hide' || arg === 'show' || arg === 'full' || arg === 'compact') {
    return answerLayout($, arg)
  }

  return COMMAND_USAGE
}

export const register: Register = (on, options) => {
  config = readOptions(options)
  let tick: Timer | undefined

  on('session.start', ($, e, next) => {
    // The timer first: whatever the first refresh does, the band keeps
    // refreshing. Reset delays, the model and the project move between turns.
    tick?.cancel()
    tick = $.clock.every(TICK_MS, () => schedule($, { isFull: true }))
    schedule($, { isFull: true })
    // Not waited for, and it swallows its own failure.
    void registerCommand($)
    // Not waited for either: a pane left up by a reload shows the new options.
    void resumePane($)
    // Nor this: however the band gets hidden later, show knows what to restore.
    void keepLayout($)

    return next(e)
  })

  // The eighteen rows live in the pane of /usage-bar config, not in /config;
  // a hidden row still answers `$.config.set`.
  on('config.describe', (_, e, next) => next(e.key.startsWith(KEY_PREFIX) ? { ...e, isHidden: true } : e))

  // The band's own command: answered here, no command runs beneath.
  on('command.run', { command: COMMAND }, async ($, e) => ({
    text: await answerCommand($, e.args ?? ''),
  }))

  on('session.measure', ($, e, next) => {
    schedule($, { isFull: true })

    return next(e)
  })

  // /effort, /model and the like change what the head shows: redraw at once.
  on('command.run', async ($, e, next) => {
    // The band's own command schedules what it needs itself.
    if (e.command === COMMAND) {
      return next(e)
    }

    const result = await next(e)
    const typed = e.args.trim().toLowerCase()
    schedule(
      $,
      e.command === 'effort' && LEVELS.includes(typed)
        ? { isFull: true, effort: typed }
        : { isFull: true, rereadsEffort: true },
    )

    return result
  })

  // A tool may have edited files: recount the diff once it is done.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    schedule($, { isFull: false })

    return result
  })

  // A subagent just started: name it without waiting for the next tick.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    schedule($, { isFull: false })

    return result
  })

  on('config.set', async ($, e, next) => {
    const result = await next(e)
    schedule($, { isFull: true, rereadsEffort: true })
    await noteSetting($, e.key, (result as { value?: unknown } | undefined)?.value)

    return result
  })

  // The settings pane. Pure: it draws what the `settings` atom holds.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // Not every surface has a field or a picker.
    const Input = 'Input' in elements ? elements.Input : undefined
    const Select = 'Select' in elements ? elements.Select : undefined
    const kept = await read($, settings)
    const row = (field: Field) => {
      const { name, label, kind, options } = field
      const value = kept?.values[name]
      const isPicked = kind === 'flag' || kind === 'choice'

      if (isPicked && Select) {
        return (
          <Select
            key={name}
            label={label}
            options={kind === 'flag' ? FLAG_OPTIONS : (options ?? []).map(option => ({ value: option }))}
            value={kind === 'flag' ? (value === false ? OFF : ON) : String(value ?? '')}
            onSelect={picked => {
              void changeSetting($, field, picked)
            }}
          />
        )
      }

      // A surface without a picker: a flag is a button that toggles.
      if (kind === 'flag' && Button) {
        return (
          <Button
            key={name}
            label={`${label} ${value === false ? OFF : ON}`}
            onPress={() => {
              void changeSetting($, field, value === false ? ON : OFF)
            }}
          />
        )
      }

      const typedField = Input ? (
        <Input
          key={name}
          label={label}
          value={String(value ?? '')}
          submitLabel="ok"
          onSubmit={typed => {
            void changeSetting($, field, typed)
          }}
        />
      ) : (
        <Text key={name}>{`${label} ${String(value ?? '')}`}</Text>
      )
      // A color the band can draw is shown beside its field: a sample in that
      // color, or a short text on it for the background.
      const color = kind === 'color' ? parseSetting(field, String(value ?? '')) : undefined

      return typeof color === 'string' ? (
        <Box key={`row-${name}`}>
          {typedField}
          {name === 'background' ? (
            <Text key={`swatch-${name}`} backgroundColor={color}>
              {' sample '}
            </Text>
          ) : (
            <Text key={`swatch-${name}`} color={color}>
              {' ███'}
            </Text>
          )}
        </Box>
      ) : (
        typedField
      )
    }

    return (
      <Box flexDirection="column">
        {kept === null ? (
          <Text dimColor>/usage-bar config</Text>
        ) : (
          SETTING_GROUPS.map(({ title, fields }) => (
            <Box key={`group-${title}`} flexDirection="column">
              <Text bold>{title}</Text>
              {fields.map(row)}
            </Box>
          ))
        )}
        {kept?.notice === undefined ? null : (
          <Text key="notice" color={config.colorDanger}>
            {kept.notice}
          </Text>
        )}
        {kept !== null && Button ? (
          <Button
            key="defaults"
            label="Defaults"
            onPress={() => {
              void resetSettings($)
            }}
          />
        ) : null}
        {Button ? (
          <Button
            key="close"
            label="Close"
            onPress={() => {
              void closePane($)
            }}
          />
        ) : null}
      </Box>
    )
  })

  // The effort is only on a model request: keep the main thread's last one.
  on('turn.step', async function* ($, e, next) {
    const prev = await read($, head)

    if (e.agentId === undefined && e.effort !== undefined && prev?.effort !== String(e.effort)) {
      const effort = String(e.effort)
      await update($, head, (h: Head | null) => ({
        ...h,
        project: h?.project ?? '',
        model: h?.model ?? formatModel(e.model),
        effort,
      }))
    }

    return yield* next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const seen = await read($, windows)

    // Hidden by the `layout` setting, or for the session when it could not be written.
    if (e.props.hasSurvey || seen === null || config.layout === 'hidden' || (await read($, hidden)) === true) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    // Cells across the band; a surface that gives none has room for everything.
    const given: unknown = e.props.bodyColumns
    const columns = typeof given === 'number' && given > 0 ? given : Number.POSITIVE_INFINITY
    const info = await read($, head)
    const diff = await read($, git)
    const costUsd = (await read($, session))?.costUsd
    const running = config.showActivity ? ((await read($, activity)) ?? []) : []
    // Up to two subagents are named one by one; more are counted in a single
    // segment, with the minutes of the oldest.
    const activities =
      running.length > 2
        ? [{ label: `${running.length} agents`, minutes: Math.max(...running.map(a => a.minutes)) }]
        : running
    // A segment is a button only for a command the session lists.
    const listed = (await read($, commands)) ?? []
    const linkOf = (command: string, key: string) => (listed.includes(command) ? { command, key } : {})
    const separator = <Text dimColor>{SEPARATOR}</Text>
    type Entry = (typeof CLAUDE_ENTRIES)[number] | typeof CONTEXT_ENTRY
    // One quota window's segment: its icon, its consumed share and its reset.
    const windowOf = (entry: Entry): Segment => {
      const { kind, icon } = entry
      const w = seen.find(x => x.kind === kind)
      const reset = w?.resetText
      // Fable's window usually resets with the week's: the same reset is said
      // once, on the week, and Fable's only when it differs.
      const week = kind === 'fable' ? seen.find(x => x.kind === 'seven_day') : undefined
      const isRepeated = week?.resetText !== undefined && week.resetText === reset

      const parts: Part[] = [
        // The context's icon is a button: it opens /context.
        ...(kind === 'context'
          ? [{ text: icon, command: 'context', key: 'context' }, { text: ' ' }]
          : // A quota's icon opens /usage, when the session has that command.
            listed.includes('usage')
            ? [{ text: icon, command: 'usage', key: `usage-${kind}` }, { text: ' ' }]
            : [{ text: `${icon} ` }]),
        // Its own piece: the percentage stays a figure alone.
        ...(w?.isStale ? [{ text: '~', color: GREY }] : []),
        { text: `${Math.round(w?.percentUsed ?? 0)}%`, color: w ? colorOf(w.percentUsed) : GREY },
        // Ahead of an even week in the warning color, behind it in the ok one.
        ...(config.showPace && w?.paceText !== undefined
          ? [{ text: ` ${w.paceText}`, color: (w.pace ?? 0) > 0 ? config.colorWarn : config.colorOk, dropAt: 2 }]
          : []),
        ...(reset !== undefined && !isRepeated ? [{ text: ` ↻ ${reset}`, dropAt: 1 }] : []),
        ...(config.showProjection && w?.exhaustText !== undefined
          ? [{ text: ` ${w.exhaustText}`, color: config.colorWarn, dropAt: 3 }]
          : []),
      ]

      return { key: kind, parts }
    }
    // First line: project, branch, model and effort. Narrow, it loses the
    // unpushed and unpulled commits, then the branch.
    const headLine: Segment[] = info
      ? [
          { key: 'project', parts: [{ text: info.project, color: 'blue', bold: true }] },
          ...(info.branch
            ? [
                {
                  key: 'branch',
                  dropAt: 3,
                  parts: [
                    { text: info.branch, color: BRANCH_BLUE },
                    ...(info.ahead ? [{ text: ` ↑${info.ahead}`, color: BRANCH_BLUE, dropAt: 2 }] : []),
                    ...(info.behind ? [{ text: ` ↓${info.behind}`, color: BRANCH_BLUE, dropAt: 2 }] : []),
                  ],
                },
              ]
            : []),
          {
            key: 'model',
            parts: [
              { text: info.model, color: 'cyan' },
              ...(info.effort ? [{ text: ` (${info.effort})`, color: GREY }] : []),
              { text: ' ' },
              // The gear opens /model; the name itself stays a text.
              { text: '⚙', command: 'model', key: 'model' },
            ],
          },
        ]
      : []
    // Second line: the quota windows, the context, then the working tree. Narrow,
    // it loses the resets, then the working tree, then the projection, the
    // cost and the activity; the figures themselves always stay.
    const figuresLine: Segment[] = [
      ...CLAUDE_ENTRIES.filter(entry => config.showFable || entry.kind !== 'fable').map(windowOf),
      ...(config.showContext ? [windowOf(CONTEXT_ENTRY)] : []),
      ...(config.showCost && costUsd !== undefined
        ? [{ key: 'cost', dropAt: 3, parts: [{ text: `Σ $${costUsd.toFixed(2)}`, color: GREY, ...linkOf('cost', 'cost') }] }]
        : []),
      ...(config.showGit && diff && diff.files > 0
        ? [
            {
              key: 'git',
              dropAt: 2,
              parts: [
                { text: `${diff.files} ${diff.files > 1 ? 'files' : 'file'}`, color: GREY },
                { text: ` +${diff.added}`, color: DARK_GREEN },
                { text: ` -${diff.removed}`, color: DARK_RED },
              ],
            },
          ]
        : []),
      ...activities.map(({ label, minutes }, index) => ({
        key: `activity-${index}`,
        dropAt: 3,
        parts: [{ text: `▶ ${label} ${minutes}m`, color: GREY }],
      })),
    ]
    // One line of the band, as wide as the surface allows.
    const line = (key: string, segments: readonly Segment[]) => (
      <Box key={key}>
        {fitLine(segments, columns).map((segment, index) => (
          <Box key={`${key}-${segment.key}`}>
            {index > 0 ? separator : null}
            {segment.parts.map((part, at) => {
              const { command } = part

              // Plain and without a hotkey: a digit typed in an empty prompt
              // presses nothing.
              return command !== undefined && Button ? (
                <Button
                  plain
                  key={part.key ?? command}
                  label={part.text}
                  {...(part.color === GREY ? { dimColor: true } : {})}
                  onPress={() => {
                    void openCommand($, command)
                  }}
                />
              ) : (
                <Text
                  key={`${key}-${segment.key}-${at}`}
                  {...(part.color === undefined ? {} : { color: part.color })}
                  {...(part.bold ? { bold: true } : {})}
                >
                  {part.text}
                </Text>
              )
            })}
          </Box>
        ))}
      </Box>
    )

    return (
      <Box width="100%" flexDirection="column" backgroundColor={config.background} paddingX={1} marginTop={1}>
        {config.layout === 'compact'
          ? // One line: project and model, then the figures; no branch.
            line('compact', [...headLine.filter(s => s.key === 'project' || s.key === 'model'), ...figuresLine])
          : [info ? line('head', headLine) : null, line('figures', figuresLine)]}
      </Box>
    )
  })
}
