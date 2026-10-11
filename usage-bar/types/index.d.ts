export type Window = {
  kind: string
  percentUsed: number
  /** Minutes until the window resets, when known. */
  resetsInMinutes?: number
  /** When the window resets, in epoch milliseconds, when known. */
  resetsAt?: number
  /** The reset as the band prints it, a delay or a time of day by `resetStyle`. */
  resetText?: string
  /** True on a figure of the usage endpoint kept through a refused request. */
  isStale?: boolean
  /** Minutes until the session window is full at its recent pace, when that comes before its reset. */
  exhaustsInMinutes?: number
  /** That projection as the band prints it. */
  exhaustText?: string
  /** Points the week's usage runs ahead of an even pace over the week; negative when behind. */
  pace?: number
  /** That gap as the band prints it, from five points either way. */
  paceText?: string
}

/** What the session cost so far, when the host keeps a ledger. */
export type Session = { costUsd?: number }

/** Work in flight: a running subagent. */
export type Activity = {
  /** The subagent's id, as the session lists it. */
  id: string
  label: string
  /** When the band first saw it, in epoch milliseconds. */
  since: number
  /** Whole minutes since the band first saw it. */
  minutes: number
}

export type Head = {
  project: string
  model: string
  /** The main thread's effort, known once a model request went out. */
  effort?: string
  /** The checked-out branch; absent outside a repository or on a detached HEAD. */
  branch?: string
  /** Commits the branch holds that its upstream does not. */
  ahead?: number
  /** Commits its upstream holds that the branch does not. */
  behind?: number
}

/** The working tree against HEAD, as `git diff --shortstat` counts it. */
export type GitDiff = { files: number; added: number; removed: number }

/** How the band is drawn: two lines, a single one, or not at all. */
export type Layout = 'full' | 'compact' | 'hidden'

/** What the settings pane shows: each `userConfig` field by name, and the last refusal. */
export type PaneSettings = {
  values: Record<string, string | number | boolean>
  /** Why the last change was not made; absent once one is. */
  notice?: string
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': {
      windows: Window[] | null
      head: Head | null
      git: GitDiff | null
      session: Session | null
      activity: Activity[] | null
      /** True once `/usage-bar hide` could not write the `layout` setting: hides the band for the session. */
      hidden: boolean | null
      /** Null until `/usage-bar config` opened the pane once. */
      settings: PaneSettings | null
      /** The slash commands a segment opens that the session lists; null until read once. */
      commands: string[] | null
    }
  }
}
