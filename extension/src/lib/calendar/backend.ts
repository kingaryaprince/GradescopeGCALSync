/** The event we want to exist in the calendar. */
export interface DesiredEvent {
  /** Stable Gradescope-derived key; also the de-dupe handle in the calendar. */
  key: string
  courseId: string
  summary: string
  description: string
  start: Date
  end: Date
  url?: string
  reminderMinutes: number[]
}

/** An event we previously created, as read back from the calendar. */
export interface ManagedEvent {
  id: string
  key: string
  /** Event start as an ISO instant, used to detect a moved deadline. */
  startIso: string
  summary: string
}

/**
 * A calendar we can reconcile against.
 *
 * `listManaged` must return only events this extension created. Everything else
 * in the user's calendar is off-limits, and the reconciler relies on that.
 */
export interface CalendarBackend {
  listManaged(): Promise<ManagedEvent[]>
  insert(event: DesiredEvent): Promise<void>
  update(id: string, event: DesiredEvent): Promise<void>
  remove(id: string): Promise<void>
}

/** Recovers the Gradescope course id from a key produced by assignmentKey(). */
export function courseIdFromKey(key: string): string | null {
  return /^gsync:v1:c(\d+):/.exec(key)?.[1] ?? null
}
