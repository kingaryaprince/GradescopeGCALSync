/** A course as listed on the Gradescope dashboard. */
export interface Course {
  /** Numeric Gradescope course id, parsed from /courses/<id>. Stable across terms. */
  id: string
  /** Short code, e.g. "CS 70". Falls back to `name` when absent. */
  shortName: string
  /** Full title, e.g. "Discrete Mathematics and Probability Theory". */
  name: string
  /** Raw term string if the dashboard exposes one, e.g. "Fall 2025". */
  term?: string
  url: string
}

/** One assignment row scraped from a course page. */
export interface Assignment {
  /**
   * Stable identity for de-duplication. Deliberately excludes the due date so a
   * deadline change updates the existing event instead of creating a second one.
   */
  key: string
  courseId: string
  /** Numeric Gradescope assignment id when the row links to one. */
  assignmentId?: string
  title: string
  /** Resolved due date, or null when the row has no parseable due date. */
  due: Date | null
  /** The literal text we parsed the due date from, kept for diagnostics. */
  dueRaw: string
  /** Late-submission deadline when the row exposes one. */
  lateDue?: Date | null
  url?: string
  /** True when the due date came from a machine-readable attribute, not text. */
  dueIsExact: boolean
  /** Raw status text, e.g. "Submitted", "No Submission". */
  status?: string
  /** Parsed score when Gradescope shows one. */
  score?: { earned: number; total: number }
  /** True when Gradescope shows this as submitted or graded. */
  submitted: boolean
}

/** Which parsing strategy produced a result, surfaced in diagnostics. */
export type ParseStrategy = 'semantic' | 'structural' | 'none'

export interface ParseResult<T> {
  items: T[]
  strategy: ParseStrategy
  /** Non-fatal problems worth showing the user (skipped rows, unparseable dates). */
  warnings: string[]
}

export interface SyncSettings {
  /** Gradescope course ids the user opted into syncing. */
  selectedCourseIds: string[]
  /** Target Google calendar id, or 'primary'. */
  calendarId: string
  /** Event length in minutes, starting at the due time. */
  durationMinutes: number
  /** Minutes-before-start reminders to attach to each event. */
  reminderMinutes: number[]
  /** Prefix event titles with the course short name. */
  prefixCourse: boolean
  /** Remove events whose assignment vanished from Gradescope. */
  removeStale: boolean
  /** Titles containing any of these (case-insensitive) are skipped. */
  denyKeywords: string[]
  /** When non-empty, only titles containing one of these are synced. */
  allowKeywords: string[]
  /** Run a background sync on a timer. */
  autoSync: boolean
  autoSyncHours: number
  /**
   * Notify when a score appears or changes. Off by default: Gradescope already
   * emails on grade release, so this is opt-in for people who prefer desktop
   * notifications or have those emails muted.
   */
  notifyGrades: boolean
  /** Notify when a new assignment shows up. Gradescope also emails on publish. */
  notifyNewAssignments: boolean
  /**
   * Leave submitted work off the calendar. Reminding you about something you
   * turned in last week is the fastest way to train you to ignore reminders.
   */
  skipSubmitted: boolean
}

export const DEFAULT_SETTINGS: SyncSettings = {
  selectedCourseIds: [],
  calendarId: 'primary',
  durationMinutes: 30,
  reminderMinutes: [24 * 60, 60],
  prefixCourse: true,
  removeStale: true,
  denyKeywords: [],
  allowKeywords: [],
  autoSync: true,
  autoSyncHours: 6,
  notifyGrades: false,
  notifyNewAssignments: false,
  skipSubmitted: false,
}

export interface SyncStats {
  created: number
  updated: number
  deleted: number
  skipped: number
  failed: number
}

export interface SyncReport extends SyncStats {
  at: number
  ok: boolean
  error?: string
  warnings: string[]
}
