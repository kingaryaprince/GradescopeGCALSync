# Docket

**Your Gradescope deadlines on Google Calendar.**

A Chrome extension that reads your Gradescope assignments and keeps them on your calendar,
using the session you are **already signed in to** — so there is no password to type, store,
or leak, and nothing to install beyond the extension itself.

```
Install → click the icon → pick your courses → Sync
```

---

## What it does

**Sync**
- Reads every course, grouped by term, and you pick which ones to sync
- Puts due dates on Google Calendar with reminders (24h and 1h by default)
- Re-syncs in the background every few hours, no tab required
- **Updates instead of duplicating** — move a deadline and the existing event moves with it
- Or export a `.ics` file that works anywhere, with no account and no setup

**See what's next**
- The popup opens on a deadline list: overdue first, then Today, Tomorrow, by weekday
- A toolbar badge counts overdue work in red, or work due within 48h in amber
- Submitted work is struck through; past-due submitted work drops off automatically

**Stay tidy**
- Overdue work you can no longer submit ages out after a week
- Hide the overdue group with one click, or dismiss a single assignment (with undo)
- Keyword filters to skip the noise (`attendance`, `vitamin`, …)
- Optional desktop notifications when a grade posts or changes, or a new assignment appears

**Look right**
- Light, dark, or follow-the-system
- Per-course colour chips

---

## Install

```bash
cd extension
npm install
npm run build
```

Then in Chrome: **chrome://extensions** → enable **Developer mode** → **Load unpacked** →
select `extension/dist`.

The `.ics` export works immediately. Live Google Calendar sync needs an OAuth client — see
below.

> **When you change the code:** popup and options pages are re-read from disk every time you
> open them, but the service worker and manifest are **not**. After `npm run build`, click
> **reload (⟳)** on the extension card. Reopening the popup is not enough, and skipping this
> shows up as a stale name, a stale icon, or an "this build does not handle X" error.

### Google OAuth client (one-time, developer only)

Users never do this. It exists so the extension can talk to Calendar.

1. Copy the extension **ID** from `chrome://extensions`. It is pinned by `manifest.key`, so it
   survives reloads and folder moves.
2. [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → enable the
   **Google Calendar API**.
3. **OAuth consent screen** → **External** → add your own Google address under **Test users**.
   Skipping this gets you refused even with a valid client ID.
4. **Credentials** → **Create credentials** → **OAuth client ID** → type **Chrome Extension**,
   and paste the extension ID.
5. Put the client ID in `extension/src/manifest.json` under `oauth2.client_id`, rebuild, reload.

The build warns while the client ID is still a placeholder, and the UI disables the Calendar
controls rather than letting you hit an opaque Google error.

#### Scopes, and why each one

| Scope | Why |
|---|---|
| `calendar.app.created` | Create and manage a dedicated calendar. Grants **no** access to your other calendars. |
| `calendar.events` | Write events, only if you point Docket at a calendar you already own. |
| `calendar.calendarlist.readonly` | Populate the calendar picker in Settings. |

The recommended setup is **"Create a separate calendar"** in Settings: deadlines stay out of
your main calendar, and you can hide or delete all of them at once.

---

## Privacy

No server, no analytics, no account. Your data goes from Gradescope to your own Google Calendar
and nowhere else. Docket only ever touches calendar events it created.

Full policy: **<https://kingaryaprince.github.io/GradescopeGCALSync/privacy>**

---

## Development

```bash
cd extension
npm test          # 126 tests, no network or browser needed
npm run dev       # rebuild on change
npm run typecheck
npm run build     # typecheck + build + verify manifest references
npm run zip       # release.zip for the Web Store
```

[`CLAUDE.md`](CLAUDE.md) documents the invariants and the reasoning behind them. Read it before
changing sync, parsing, or styling.

### Layout

```
extension/src/
  background.ts              orchestration, scheduling, messaging, badge
  offscreen.ts               fetches + parses Gradescope (service workers have no DOM)
  lib/gradescope/parse.ts    HTML → courses + assignments, layered strategies
  lib/gradescope/dates.ts    due-date text → Date, with year inference
  lib/calendar/gcal.ts       Google Calendar API
  lib/calendar/ics.ts        RFC 5545 writer
  lib/sync.ts                reconciler (create / update / delete)
  lib/upcoming.ts            deadline list + badge view model
  lib/notify.ts              grade / new-assignment diffing
  lib/terms.ts               term grouping
  lib/colors.ts              per-course colours
  styles/tokens.css          the entire visual language
  popup/  options/           UI
```

### How the tricky parts work

**No password.** Gradescope sets `_gradescope_session` with `SameSite=None; Secure`, so the
cookie rides along on a cross-site request from the extension's origin. Docket reads pages as
you, without ever seeing your credentials.

**Why an offscreen document.** MV3 service workers have no `DOMParser`. Fetching and parsing
happen in an offscreen document, which also keeps your Gradescope cookie in play. No visible
tab is opened.

**Parsing is layered.** Gradescope has no public API, no ICS feed (verified: `calendar.ics`
404s), and no stable markup contract. So `parse.ts` tries semantic class names first, then falls
back to reading the assignment table by its column headers. Each result reports which strategy
fired, and a fallback surfaces as a warning in Settings — so layout drift is visible before it
becomes silently missing assignments.

**Year inference.** Gradescope renders due dates without a year ("Oct 04 at 4:00PM"). Assuming
the current year broke every December: a spring assignment due "Jan 15" resolved eleven months
into the past. The course's term window decides when known, otherwise the nearest candidate
year to today wins.

**Stable keys.** Each event carries `gsync:v1:c<course>:a<assignment>`, deliberately excluding
the due date. Keying on the due timestamp meant a rescheduled deadline looked like a new
assignment and produced a duplicate. Reconciliation only ever reads or modifies events tagged
as ours.

**Deleting is conservative.** Stale events are removed only for courses read successfully this
run, or courses you deselected. If a course fails to load, its events are left alone rather
than deleted — a network blip must not wipe a semester.

**One visibility filter.** `filterVisible()` decides what is worth showing, and both the
deadline list and the badge go through it. Otherwise dismissing an assignment could clear the
list but leave the badge lit, which would defeat the point.

---

## Status

**Verified end to end against a live account.** Dashboard parsing, term grouping, due-date
inference, reconciliation, and calendar writes all work: a course showing 3 assignments produced
exactly 3 events.

**Tested by unit tests** (126, no network or browser): date inference, parsing against HTML
fixtures, the ICS writer, the reconciler, term grouping, notification diffing, and the deadline
list and badge.

**Not yet verified:**
- Which parse strategy fires on real pages. If the structural fallback is carrying it, the
  semantic selectors are wrong and late-due disambiguation is weaker. Settings → Last sync says
  so when it happens.
- The submission-status cell (`readSubmission`) is only fixture-tested. The struck-through
  "done" rows, `skipSubmitted`, and grade notifications all depend on it.
- `.ics` re-import de-duplication. UIDs are stable so it *should* update in place, but Google's
  behaviour here is untested — treat the export as a snapshot.

Not planned: always-on server-side sync. It would require storing users' Gradescope passwords,
since the session cookie dies with the browser. Reasoning is in [`CLAUDE.md`](CLAUDE.md).

---

## Publishing

See [PUBLISHING.md](PUBLISHING.md) for the Web Store and OAuth-verification workflow, with
ready-to-paste listing copy, data-use disclosures, scope justifications, and a demo-video
script.

## History

This started as a Python script: it needed Python, a version-matched ChromeDriver, a Google
Cloud project, and your Gradescope password in a plaintext `.env` — and synced exactly one
course, named in an environment variable. Fine for one person, a wall for everyone else. It is
preserved in [`legacy/`](legacy/).

## License

MIT — see [LICENSE](LICENSE).
