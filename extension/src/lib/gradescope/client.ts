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
function assertLoggedIn(page: FetchedPage): void {
  if (page.status === 401 || page.status === 403) throw new NotLoggedInError()
  if (/\/login(\?|$)/.test(page.finalUrl)) throw new NotLoggedInError()
  if (page.doc.querySelector('input#session_password, form[action*="/login"]')) {
    throw new NotLoggedInError()
  }
}

export async function fetchCourses(fetcher: HtmlFetcher = browserFetcher): Promise<ParseResult<Course>> {
  const page = await fetcher(DASHBOARD_URL)
  assertLoggedIn(page)
  if (page.status >= 500) throw new Error(`Gradescope returned ${page.status}. Try again shortly.`)
  return parseCourses(page.doc)
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
