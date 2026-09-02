# Gradescope → Calendar Sync

A Chrome extension that puts your Gradescope due dates on Google Calendar.

It uses the Gradescope session you're **already signed in to**, so there is no password to
type, store, or leak — and nothing to install beyond the extension itself.

```
Install → click the icon → pick your courses → Sync
```

## Why this exists

The original version of this project was a Python script. It worked, but using it meant
installing Python, downloading a ChromeDriver binary matching your exact Chrome version,
creating a Google Cloud project, and putting your Gradescope password in a plaintext `.env`.
It also synced exactly one course, named in an environment variable.

That's fine for one person. It's a wall for everyone else. The old script is preserved in
[`legacy/`](legacy/).

## What it does

- **No password, ever.** Reads Gradescope with your existing browser session.
- **All your courses.** Pick them from a list; no editing config files.
- **Two ways out.** Live Google Calendar sync, or a `.ics` download that needs no setup at all.
- **Updates instead of duplicating.** Move a deadline and the existing event moves with it.
- **Reminders.** Configurable, defaulting to 24 hours and 1 hour before.
- **Background sync.** Every few hours, no tab required.
- **Filters.** Skip the noise (`attendance`, `vitamin`, …).

## Install

### From source

```bash
cd extension
npm install
npm run build
```

Then in Chrome: **chrome://extensions** → enable **Developer mode** → **Load unpacked** →
select `extension/dist`.

The `.ics` export works immediately. Live Google Calendar sync needs an OAuth client, below.

### Google OAuth client (one-time, for the developer)

Users never do this. You do it once so the extension can talk to Calendar.

1. Load the unpacked extension and copy its **ID** from `chrome://extensions`.
2. [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services**
   → enable the **Google Calendar API**.
3. **Credentials** → **Create credentials** → **OAuth client ID** → type **Chrome Extension**,
   and paste the extension ID.
4. Put the client ID in `extension/src/manifest.json` under `oauth2.client_id`, then rebuild.

To keep the extension ID stable across reloads, add your `key` to the manifest — otherwise the
ID changes and OAuth stops matching.

#### Scopes, and why each one

| Scope | Why |
|---|---|
| `calendar.app.created` | Create and manage a dedicated "Gradescope" calendar. Grants no access to your other calendars. |
| `calendar.events` | Write events, if you point the extension at a calendar you already have. |
| `calendar.calendarlist.readonly` | Populate the calendar picker in Settings. |

The recommended setup is **"Create a separate calendar"** in Settings: deadlines stay out of
your main calendar, and you can hide or delete all of them at once.

## Privacy

Your Gradescope data goes from your browser to your Google Calendar. There is no server in the
middle, because there is no server. See [docs/privacy.md](docs/privacy.md).

## Development

```bash
cd extension
npm test          # 60 tests, no network or browser needed
npm run dev       # rebuild on change
npm run typecheck
npm run zip       # release.zip for the Web Store
```

### Layout

```
extension/src/
  background.ts              orchestration, scheduling, messaging
  offscreen.ts               fetches + parses Gradescope (service workers have no DOM)
  lib/gradescope/parse.ts    HTML → assignments, layered strategies
  lib/gradescope/dates.ts    due-date text → Date, with year inference
  lib/calendar/gcal.ts       Google Calendar API
  lib/calendar/ics.ts        RFC 5545 writer
  lib/sync.ts                reconciler (create / update / delete)
  popup/  options/           UI
```

### How the tricky parts work

**No password.** Gradescope sets `_gradescope_session` with `SameSite=None; Secure`, so the
cookie is sent on a cross-site request from the extension's origin. The extension reads pages
as you, without ever seeing your credentials.

**Why an offscreen document.** MV3 service workers have no `DOMParser`. Fetching and parsing
happen in an offscreen document, which also keeps the user's Gradescope cookie in play. No
visible tab is opened.

**Parsing is layered.** Gradescope has no public API and no stable markup contract, so
`parse.ts` tries semantic class names first, then falls back to reading the assignment table by
its column headers. Each result reports which strategy fired; a fallback shows up as a warning
in Settings, so layout changes are visible before they become missing assignments.

**Year inference.** Gradescope renders due dates without a year ("Oct 04 at 4:00PM"). The old
script assumed the current calendar year, which broke every December: a spring assignment due
"Jan 15" resolved eleven months into the past. Now the term window decides when known, and
otherwise the nearest candidate year to today wins.

**Stable keys.** Each event carries a key of `gsync:v1:c<course>:a<assignment>`, deliberately
excluding the due date. The old script's key included the due timestamp, so moving a deadline
looked like a new assignment and produced a duplicate. Reconciliation only ever reads or
modifies events tagged as ours.

**Deleting is conservative.** Stale events are removed only for courses that were read
successfully this run, or that you deselected. If a course fails to load, its events are left
alone rather than deleted.

## Status

Working and tested: date inference, parsing (against fixtures), the ICS writer, and the
reconciler — 60 unit tests.

Needs verification against a live account: the exact Gradescope selectors. Gradescope's real
logged-in HTML isn't public, so the semantic selectors are best-effort with a structural
fallback behind them. If your courses or assignments come up empty, that's the place to look —
the fallback warning in Settings will say so.

## Publishing checklist

- [ ] Set a real `oauth2.client_id` and a fixed `key` in the manifest
- [ ] Verify selectors against a live Gradescope account
- [ ] Publish `docs/privacy.md` via GitHub Pages (required for OAuth verification)
- [ ] Submit the OAuth consent screen for verification (sensitive scopes; unverified apps are capped at 100 users)
- [ ] `npm run zip` → upload to the Chrome Web Store

## License

MIT — see [LICENSE](LICENSE).
