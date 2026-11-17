import type { Assignment, Course, ParseResult } from '../types'
import { parseAssignments, parseCourses } from './parse'

export const GRADESCOPE_ORIGIN = 'https://www.gradescope.com'
export const DASHBOARD_URL = `${GRADESCOPE_ORIGIN}/account`

/** Thrown when Gradescope bounces us to the login page. */
export class NotLoggedInError extends Error {
  constructor() {
    super('You are not signed in to Gradescope. Open gradescope.com, sign in, then sync again.')
    this.name = 'NotLoggedInError'
  }
}

export interface FetchedPage {
  doc: Document
  finalUrl: string
  status: number
}

export type HtmlFetcher = (url: string) => Promise<FetchedPage>

/**
 * Fetches and parses a Gradescope page using the browser's existing session.
 *
 * Gradescope sets `_gradescope_session` with `SameSite=None; Secure`, so the
 * cookie rides along on a cross-site request from the extension origin. That is
 * what lets this work without ever handling the user's password.
 *
 * Must run somewhere with a DOM (an offscreen document or an extension page);
 * MV3 service workers have no DOMParser.
 */
export const browserFetcher: HtmlFetcher = async (url) => {
  const res = await fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    headers: { Accept: 'text/html,application/xhtml+xml' },
  })
  const html = await res.text()
  return {
    doc: new DOMParser().parseFromString(html, 'text/html'),
    finalUrl: res.url || url,
    status: res.status,
  }
}

/** Gradescope answers an unauthenticated request with the login page. */
export function isSignedOut(page: FetchedPage): boolean {
  if (page.status === 401 || page.status === 403) return true
  if (/\/login(\?|$)/.test(page.finalUrl)) return true
  return page.doc.querySelector('input#session_password, form[action*="/login"]') !== null
}

function assertLoggedIn(page: FetchedPage): void {
  if (isSignedOut(page)) throw new NotLoggedInError()
}

/**
 * Fetches the dashboard, and when it answers "signed out", loads the Gradescope
 * home page once and tries again.
 *
 * Why: after signing in, Gradescope also sets a long-lived `remember_me` cookie
 * (seen 2026-11-16 with an expiry 13 months out, SameSite=None, so it rides
 * along on our requests too). The short-lived session cookie dies with the
 * browser; whether a plain request to "/" uses remember_me to start a fresh
 * session is NOT verified yet. `recovered` reports when it worked, so the sync
 * report shows whether this path ever fires.
 */
export async function fetchCourses(
  fetcher: HtmlFetcher = browserFetcher,
): Promise<ParseResult<Course> & { recovered?: boolean }> {
  let page = await fetcher(DASHBOARD_URL)
  let recovered = false
  if (isSignedOut(page)) {
    await fetcher(`${GRADESCOPE_ORIGIN}/`)
    page = await fetcher(DASHBOARD_URL)
    recovered = !isSignedOut(page)
  }
  assertLoggedIn(page)
  if (page.status >= 500) throw new Error(`Gradescope returned ${page.status}. Try again shortly.`)
  return { ...parseCourses(page.doc), ...(recovered ? { recovered } : {}) }
}

export async function fetchAssignments(
  course: Course,
  fetcher: HtmlFetcher = browserFetcher,
  now?: Date,
): Promise<ParseResult<Assignment>> {
  const page = await fetcher(course.url)
  assertLoggedIn(page)
  if (page.status >= 500) throw new Error(`Gradescope returned ${page.status} for ${course.shortName}.`)
  return parseAssignments(page.doc, course.id, {
    ...(course.term ? { term: course.term } : {}),
    ...(now ? { now } : {}),
  })
}
