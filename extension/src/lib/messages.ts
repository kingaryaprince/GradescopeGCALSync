import type { Assignment, Course, SyncReport } from './types'

/**
 * Dates do not survive chrome.runtime.sendMessage (it serializes as JSON), so
 * anything crossing a context boundary carries ISO strings instead.
 */
export interface AssignmentWire extends Omit<Assignment, 'due' | 'lateDue'> {
  dueIso: string | null
  lateDueIso?: string | null
}

export function toWire(a: Assignment): AssignmentWire {
  const { due, lateDue, ...rest } = a
  return {
    ...rest,
    dueIso: due ? due.toISOString() : null,
    ...(lateDue ? { lateDueIso: lateDue.toISOString() } : {}),
  }
}

export function fromWire(a: AssignmentWire): Assignment {
  const { dueIso, lateDueIso, ...rest } = a
  return {
    ...rest,
    due: dueIso ? new Date(dueIso) : null,
    ...(lateDueIso ? { lateDue: new Date(lateDueIso) } : {}),
  }
}

export type Request =
  | { type: 'SCRAPE_COURSES' }
  | { type: 'SCRAPE_ASSIGNMENTS'; course: Course }
  | { type: 'SYNC_NOW' }
  | { type: 'REFRESH_COURSES' }
  | { type: 'REFRESH_DEADLINES' }
  | { type: 'EXPORT_ICS' }
  | { type: 'CONNECT_GOOGLE' }
  | { type: 'DISCONNECT_GOOGLE' }
  | { type: 'LIST_CALENDARS' }
  | { type: 'CREATE_CALENDAR'; name: string }

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string; kind?: string }

export interface ScrapeCoursesData {
  courses: Course[]
  strategy: string
  warnings: string[]
}
export interface ScrapeAssignmentsData {
  assignments: AssignmentWire[]
  strategy: string
  warnings: string[]
}
export interface SyncNowData {
  report: SyncReport
}

export function ok<T>(data: T): Response<T> {
  return { ok: true, data }
}
export function fail(err: unknown): Response<never> {
  const e = err instanceof Error ? err : new Error(String(err))
  return { ok: false, error: e.message, kind: e.name }
}
