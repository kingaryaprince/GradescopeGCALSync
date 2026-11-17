import { describe, expect, it } from 'vitest'
import { fetchCourses, signIn, type FetchedPage, type FormPoster, type HtmlFetcher } from '../src/lib/gradescope/client'

const LOGIN_HTML = `<html><head><meta name="csrf-token" content="meta-token"></head><body>
<form action="/login" method="post"><input name="authenticity_token" value="form-token">
<input id="session_email" name="session[email]"><input id="session_password" name="session[password]"></form></body></html>`
const DASH_HTML = '<html><body><div class="courseList"></div></body></html>'

function page(html: string, finalUrl: string, status = 200): FetchedPage {
  return { doc: new DOMParser().parseFromString(html, 'text/html'), finalUrl, status }
}

/** A fake Gradescope: signed out until a post with the right password. */
function fakeSite(password: string, opts: { status?: number } = {}) {
  let signedIn = false
  const posts: URLSearchParams[] = []
  const fetcher: HtmlFetcher = async (url) =>
    signedIn || !url.endsWith('/account')
      ? url.endsWith('/login') && !signedIn
        ? page(LOGIN_HTML, url)
        : page(DASH_HTML, url)
      : page(LOGIN_HTML, 'https://www.gradescope.com/login')
  const poster: FormPoster = async (url, body) => {
    posts.push(body)
    if (opts.status) return page('', url, opts.status)
    if (body.get('session[password]') === password) {
      signedIn = true
      return page(DASH_HTML, 'https://www.gradescope.com/account')
    }
    return page(LOGIN_HTML, url)
  }
  return { fetcher, poster, posts }
}

describe('signIn', () => {
  it('posts the form token, email, password and remember_me', async () => {
    const site = fakeSite('pw')
    await signIn({ email: 'a@b.edu', password: 'pw' }, site.fetcher, site.poster)
    const body = site.posts[0]!
    expect(body.get('authenticity_token')).toBe('form-token')
    expect(body.get('session[email]')).toBe('a@b.edu')
    expect(body.get('session[remember_me]')).toBe('1')
  })

  it('fails as signed out on a wrong password', async () => {
    const site = fakeSite('pw')
    await expect(signIn({ email: 'a@b.edu', password: 'nope' }, site.fetcher, site.poster))
      .rejects.toMatchObject({ name: 'NotLoggedInError', message: expect.stringContaining('wrong email or password') })
  })

  it('says when Gradescope refuses the request itself', async () => {
    const site = fakeSite('pw', { status: 422 })
    await expect(signIn({ email: 'a@b.edu', password: 'pw' }, site.fetcher, site.poster))
      .rejects.toThrow(/HTTP 422/)
  })
})

describe('fetchCourses with a saved login', () => {
  it('signs back in and reports it', async () => {
    const site = fakeSite('pw')
    const r = await fetchCourses(site.fetcher, { login: { email: 'a@b.edu', password: 'pw' }, poster: site.poster })
    expect(r.signedInWithPassword).toBe(true)
  })

  it('never posts a password when no login is saved', async () => {
    const site = fakeSite('pw')
    await expect(fetchCourses(site.fetcher, { poster: site.poster })).rejects.toMatchObject({ name: 'NotLoggedInError' })
    expect(site.posts).toHaveLength(0)
  })
})
