import type { Assignment, Course, ParseResult } from '../types'
import { parseAssignments, parseCourses } from './parse'

export const GRADESCOPE_ORIGIN = 'https://www.gradescope.com'
export const DASHBOARD_URL = `${GRADESCOPE_ORIGIN}/account`
export const LOGIN_URL = `${GRADESCOPE_ORIGIN}/login`

/** An email-and-password Gradescope login, saved on this computer by the user. */
export interface SavedLogin {
  email: string
  password: string
}

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
export type FormPoster = (url: string, body: URLSearchParams) => Promise<FetchedPage>

/** Same name as NotLoggedInError so every signed-out path treats it alike. */
export class SignInFailedError extends Error {
  constructor(detail: string) {
    super(`Docket could not sign you back in to Gradescope (${detail}). Check the saved login in Settings, or sign in on gradescope.com.`)
    this.name = 'NotLoggedInError'
  }
}

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

export const browserPoster: FormPoster = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    redirect: 'follow',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/xhtml+xml',
    },
    body,
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
 * Signs in with a saved email and password, the way the gradescope.com login
 * form does: load /login for its CSRF token, then post the form.
 *
 * Only for accounts with their own Gradescope password. School sign-in
 * (CalNet SAML with Duo) cannot be automated and is not attempted.
 *
 * NOT verified against the live site: whether Gradescope accepts this post
 * from the extension origin. A 422 means it rejected the request itself (CSRF
 * or origin check), not the password; the error says which.
 */
export async function signIn(
  login: SavedLogin,
  fetcher: HtmlFetcher = browserFetcher,
  poster: FormPoster = browserPoster,
): Promise<void> {
  const page = await fetcher(LOGIN_URL)
  if (!isSignedOut(page)) return
  const form = page.doc.querySelector('form[action*="/login"]')
  const token =
    form?.querySelector<HTMLInputElement>('input[name="authenticity_token"]')?.value ??
    page.doc.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content
  if (!token) throw new SignInFailedError('no sign-in form on gradescope.com/login')
  const body = new URLSearchParams({
    utf8: '\u2713',
    authenticity_token: token,
    'session[email]': login.email,
    'session[password]': login.password,
    'session[remember_me]': '1',
    commit: 'Log In',
  })
  const after = await poster(LOGIN_URL, body)
  if (after.status === 422) throw new SignInFailedError('Gradescope refused the request, HTTP 422')
  if (after.status >= 500) throw new SignInFailedError(`Gradescope returned ${after.status}`)
  if (isSignedOut(after)) throw new SignInFailedError('wrong email or password, or Gradescope asked for more')
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
  opts: { login?: SavedLogin; poster?: FormPoster } = {},
): Promise<ParseResult<Course> & { recovered?: boolean; signedInWithPassword?: boolean }> {
  let page = await fetcher(DASHBOARD_URL)
  let recovered = false
  let signedInWithPassword = false
  if (isSignedOut(page)) {
    await fetcher(`${GRADESCOPE_ORIGIN}/`)
    page = await fetcher(DASHBOARD_URL)
    recovered = !isSignedOut(page)
  }
  if (isSignedOut(page) && opts.login) {
    await signIn(opts.login, fetcher, opts.poster)
    page = await fetcher(DASHBOARD_URL)
    signedInWithPassword = !isSignedOut(page)
  }
  assertLoggedIn(page)
  if (page.status >= 500) throw new Error(`Gradescope returned ${page.status}. Try again shortly.`)
  return {
    ...parseCourses(page.doc),
    ...(recovered ? { recovered } : {}),
    ...(signedInWithPassword ? { signedInWithPassword } : {}),
  }
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
