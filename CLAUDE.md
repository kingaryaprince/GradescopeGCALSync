# CLAUDE.md — Docket

Chrome MV3 extension that syncs Gradescope due dates to Google Calendar. Read this before
changing anything; several decisions here look arbitrary but are load-bearing.

## Commands

```bash
cd extension
npm install
npm test          # 60 unit tests, no network or browser
npm run build     # typecheck + vite build + verify-dist
npm run typecheck
npm run zip       # release.zip for the Web Store
```

Load unpacked from `extension/dist` (never `extension/` — no manifest there).

## Dev loop — changes do not apply until you rebuild

Chrome loads `extension/dist`, never `src/`. Editing source has no effect on the running
extension until a build regenerates `dist`.

```bash
cd extension && npm run build     # then reload on chrome://extensions
npm run dev                       # rebuild on every save (still reload for the parts below)
```

**Popup and options pages are re-read from disk on every open. The service worker and the
manifest are not.** So editing and rebuilding gives you new UI code talking to a stale
background worker, which shows up as "this build does not handle X" for any message added
since the worker started -- and as a stale name and icon in the toolbar. Click **reload** on
the extension card; reopening the popup is not enough.

What each change needs after a rebuild:

| Changed | To see it |
|---|---|
| `popup/**`, `options/**` | just reopen the popup / settings page |
| `background.ts`, `offscreen.*`, `lib/**` | click **reload** on `chrome://extensions` |
| `manifest.json` | click **reload** |
| `manifest.key` | **remove** and re-**Load unpacked** (the extension ID changes) |

When in doubt: `npm run build` then reload. For a published extension, users only get changes
when you bump `version` in the manifest and upload a new package.

## Verified external facts

Do not re-investigate these; each was confirmed by probe, not assumption.

- **Gradescope has no public API and no ICS endpoint.** `www.gradescope.com/calendar.ics`
  returns 404, identical to a nonexistent path, while `/account` returns 401. HTML parsing is
  the only option. (`legacy/`-adjacent sibling repo `gradescopeConnect` is built on that
  nonexistent URL and cannot ever have worked.)
- **`_gradescope_session` is `SameSite=None; Secure`.** This is why an extension-origin
  `fetch(..., {credentials:'include'})` carries the user's session, so the extension never
  handles a password. This single fact is the basis of the whole architecture.
- **That cookie has no `Expires`/`Max-Age`** — it is a session cookie and dies with the
  browser. A server therefore cannot hold it, which is why always-on server sync would require
  storing the user's actual password. See Roadmap.
- **MV3 service workers have no `DOMParser`.** Fetch + parse run in an offscreen document
  (`chrome.offscreen`, reason `DOM_PARSER`), which also keeps the cookie in play. No visible
  tab is opened.
- **happy-dom does not implement `:scope` in `querySelectorAll`** (returns 0 matches). Use
  `Array.from(row.children).filter(...)` for direct-child selection instead.

## Architecture

```
src/background.ts            orchestration, chrome.alarms scheduling, message router
src/offscreen.ts             fetches + parses Gradescope (the only place with a DOM)
src/lib/gradescope/client.ts fetch + login detection
src/lib/gradescope/parse.ts  HTML -> Course[] / Assignment[], layered strategies
src/lib/gradescope/dates.ts  due-date text -> Date, year inference
src/lib/calendar/gcal.ts     Google Calendar API
src/lib/calendar/ics.ts      RFC 5545 writer
src/lib/calendar/backend.ts  CalendarBackend interface (makes sync testable)
src/lib/sync.ts              reconciler: create / update / delete
src/popup/  src/options/     UI
```

Messages cross context boundaries as JSON, so `Date` does not survive. Anything sent between
contexts uses the `*Wire` types in `lib/messages.ts` (`toWire` / `fromWire`).

## Invariants — do not break these

**Event keys must never include the due date.** Keys are
`gsync:v1:c<courseId>:a<assignmentId>` (or `:t-<slug>` with no id). The original Python script
keyed on the due timestamp, so moving a deadline read as a new assignment and produced a
duplicate while orphaning the original. Tested in `tests/sync.test.ts`.

**Only ever touch events tagged as ours.** Every written event carries private extended
property `gsyncApp=gradescope-sync`; `listManaged()` filters on it. The reconciler assumes
anything it sees is ours and is free to delete. Never widen that query.

**Deletion is conservative.** Stale events are removed only for courses in
`deletableCourseIds` — those scraped successfully this run, plus those the user deselected. A
course whose fetch *failed* must be excluded, or a transient network error would wipe a
semester of events. Tested.

**Never assume the current year for a due date.** Gradescope renders "Oct 04 at 4:00PM" with no
year. Use the term window when known, else the candidate year nearest today. Assuming
`now.year` broke every December (a spring "Jan 15" landed eleven months in the past).

**Parsing is layered and must report which strategy fired.** `semantic` selectors first, then a
`structural` fallback that reads the assignment table by its column headers. A `structural`
result surfaces as a user-visible warning so layout drift is caught before it becomes silently
missing assignments. Never collapse this to a single selector set.

**Read the "Due" column by header, not position.** A "Late Due" column can precede "Due", and
the semantic layout renders both as `.submissionTimeChart--dueDate` siblings. When two
unlabeled deadlines exist, the earlier one is the real due date.

**Watch JS escaping in the ICS writer.** `'\;'` is just `';'` in JavaScript; RFC 5545 needs
`'\;'`. This bug shipped once and the test was written to match it. Assert with `String.raw`.

**`offscreen.html` must be a Vite input.** It is created at runtime by `background.ts`, so
nothing imports it and Vite will not emit it otherwise — sync then fails silently.
`scripts/verify-dist.mjs` guards this and runs as part of `npm run build`.

## OAuth

`oauth2.client_id` in the manifest must be a **Chrome Extension**-type client bound to the
extension ID. `manifest.key` pins that ID (currently `jnbfdaclcmebhbobmmbjhiakpgkalkif`) so it
survives folder moves; the matching `extension-key.pem` is gitignored and must never be
committed. A placeholder client_id is detected by `lib/oauth.ts`, which disables the Calendar
UI instead of letting the user hit Google's opaque `bad client id: {0}`.

Scopes: `calendar.app.created` (dedicated calendar, no access to others), `calendar.events`
(user-chosen existing calendar), `calendar.calendarlist.readonly` (picker).

## Styling

`src/styles/tokens.css` holds the whole visual language and is linked by both the popup and the
options page. Change design there, not in the per-surface stylesheets.

The language is **"technical editorial"**: hairline rules, square corners, uppercase
letterspaced micro-labels, monospace numerals, and hard offset shadows instead of soft blur.
Hierarchy comes from type and rules rather than elevation, and controls **invert on hover**
(a fill wipes in from the left) rather than lifting or scaling.

This replaced an earlier soft/rounded language with gradients, blurred shadows and springy
scale feedback. If reintroducing softness, change the tokens rather than adding local
overrides -- the radius, shadow and motion scales all exist as tokens precisely so the language
can be swapped in one file.

Rules that survive any restyle:

- **Red and amber mean urgency, never decoration.** Row colour comes from `urgencyOf()`, and
  `lib/colors.ts` excludes hues 0-20 from course chips so a chip can never impersonate one.
- **The deadline list is not a card.** Sections are separated by rules; boxing the list flattens
  the hierarchy and it stops reading as the primary content.
- **Numerals are monospaced** (`--mono`) so times align down the column.
- **Inter is self-hosted** (`src/styles/inter-latin.woff2`, weight-axis latin subset, 48KB).
  Never swap it for a CDN link: the privacy policy promises no external requests.
- `prefers-reduced-motion` collapses all animation; keep it that way.

Course chips come from `lib/colors.ts`: a curated hue ring indexed by a hash of the course id,
not the raw hash (which drifts into muddy yellows and can collide with urgency red).
`courseCalendarColorId()` maps the same hue onto one of Google Calendar's 11 event colours, so
per-course colouring can match in both places.

Icons are generated by a script in the commit history rather than a design tool. The current
mark is a Mondrian-style four-panel grid: an ink cross, a blue top-right panel, a solid ink
bottom-left panel, and a single orange accent square.

The **16px variant drops the solid ink panel**, keeping only the cross, the blue panel and the
accent. With the panel included the icon reads as a dark blob in the toolbar. This is the
general rule for this icon: at 16px, remove mass rather than shrinking detail.

## Known gaps

**Verified against a live account (2026-09-01).** The full pipeline works end to end:
dashboard course names, short names and term headings all parse correctly, and a course page
with 3 assignments produced exactly 3 calendar events. Term grouping reproduces Gradescope's
own Fall/Summer-visible, older-collapsed split.

Still unverified, in rough priority order:

- **Which parse strategy fires on the real page** (`semantic` vs `structural`). If the
  structural fallback is carrying it, the semantic selectors in `parse.ts` are wrong and the
  late-due disambiguation is weaker (it falls back to "earlier of two dates wins"). Check
  Settings → Last sync for a "read using the fallback parser" warning.
- **The `.submissionStatus` cell shape.** `readSubmission()` now parses it (score, "Submitted",
  "No Submission") with a header-mapped fallback, but only against fixtures. Grade
  notifications and `skipSubmitted` both depend on it, so confirm before trusting them.
- **Late-due rows**, and rows with no due date, on real HTML.
- Whether rows expose ISO timestamps in attributes. If they do, the whole year-inference path
  in `dates.ts` can be deleted.

`extension/scripts/inspect-gradescope.js` dumps the real structure from the DevTools console;
use its output to pin selectors and add a real-HTML fixture.

**`.ics` re-import dedupe is unverified.** UIDs are stable so a re-import *should* update in
place, but Google's behavior here has not been tested. Do not promise it.

## Roadmap / future extensions

- [ ] **Always-on server-side sync (deferred, deliberately).** The current design needs Chrome
      running to *discover* changes; reminders fire from Google Calendar regardless. True
      always-on requires a backend that authenticates to Gradescope on a schedule — and since
      the session cookie is non-persistent, that means storing users' Gradescope **passwords**.
      That is password custody for thousands of students, a breach liability, and likely
      against Gradescope's ToS. Revisit only if Gradescope ships an API or OAuth. A session-
      cookie relay is not a workaround: the cookie dies with the browser.
- [ ] Verify selectors against a live account and add a real-HTML fixture.
- [ ] Firefox / Edge port: replace `chrome.identity.getAuthToken` (Chrome-only) with
      `launchWebAuthFlow` + PKCE. `gcal.ts` already isolates token acquisition.
- [ ] Google OAuth verification for public release (sensitive scopes; unverified apps cap at
      100 users). Needs a hosted privacy policy (`docs/privacy.md`) and a demo video.
- [x] **Popup deadline dashboard** (`lib/upcoming.ts`). Renders from `assignmentCache` in
      `chrome.storage.local`, so the popup opens instantly. The `REFRESH_DEADLINES` message
      scrapes and fills that cache **without touching Google Calendar**, so the dashboard is
      useful before an account is connected. Past-due submitted work is dropped; upcoming
      submitted work is struck through.
- [ ] Surface parse warnings more visibly than the Settings report (badge already goes amber).
- [ ] Badge count of unsubmitted work due within 48h (`buildUpcoming` already returns
      `overdueCount`; wire it to `chrome.action.setBadgeText`).
- [ ] Optional: sync late deadlines as separate events (`Assignment.lateDue` is already parsed).
- [ ] Optional: per-course calendar or color mapping (`colorId` per course).

### Highest-value unexploited data

Each assignment row already contains **submission status** and **score** (the
`.submissionStatus` cell — "Submitted", "No Submission", "18.0 / 20.0"). `parse.ts` reads the
row but discards both. Two features fall straight out of capturing them:

- [x] **Submission-aware reminders** (`skipSubmitted`). Keeps reminders off work already
      turned in. Off by default because it also removes the event on submit.
- [x] **Grade / new-assignment notifications** (`lib/notify.ts`). Diffs a stored fingerprint
      snapshot between syncs. **Both default off: Gradescope already emails on grade release
      and assignment publish**, so the value is desktop delivery for people who mute those,
      plus catching score *changes* (regrades), which Gradescope's email does not distinguish.
      First sync is deliberately silent, or it would fire once per assignment.

### Product framing

Today this is a calendar sync tool. With submission status and grade diffs it becomes a
**Gradescope companion** with daily engagement, where calendar sync is one output rather than
the whole product. Worth weighing before adding breadth (more LMSes, more calendar targets)
instead of depth.
