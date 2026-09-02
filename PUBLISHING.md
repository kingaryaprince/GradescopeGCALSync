# Publishing checklist

Everything needed for the Chrome Web Store listing and Google OAuth verification.
Text below is written to be pasted directly into the forms.

Privacy policy URL (already live):
**https://kingaryaprince.github.io/GradescopeGCALSync/privacy**

---

## 1. Order of operations

Verification review is the long pole (typically weeks), and it needs a *published* app to
point at. Do these in order:

1. Pay the one-time $5 Chrome Web Store developer fee.
2. `cd extension && npm run zip` → upload `release.zip` as a **draft**.
3. Fill the store listing (§3) and the privacy disclosures (§4).
4. Publish, or submit for review. Note the **store-assigned extension ID**.
5. Repoint the OAuth client at that ID (§2), rebuild, upload again.
6. Submit the OAuth consent screen for verification with §5 and §6.

### The extension ID changes when you publish

Local builds use `manifest.key` to pin the ID (`jnbfdaclcmebhbobmmbjhiakpgkalkif`). A Web Store
upload gets a **store-assigned ID** instead, and the OAuth client is bound to a specific ID —
so Calendar sync will break on the published build until the client is repointed.

Verify the exact mechanics against Google's current docs at this step rather than trusting this
file; the guidance around shipping `key` in a published manifest has changed over time. The
safe sequence is: publish first, read the assigned ID, then update the OAuth client (or create
a second one) and re-upload.

---

## 2. OAuth client

Type must be **Chrome Extension**, not Web application. Item ID = the extension ID.

Keep the app in **Testing** mode while iterating; add each tester's Google address under
**Test users** (limit ~100). Testers see an "unverified app" warning and must click
**Advanced → Go to (unsafe)**. That is expected and disappears after verification.

---

## 3. Store listing copy

**Name**

```
Gradescope → Calendar Sync
```

**Short description** (132 char limit)

```
Put your Gradescope due dates on Google Calendar. Uses the session you're already signed in to, so no password is needed.
```

**Category:** Productivity  ·  **Language:** English

**Detailed description**

```
Gradescope tells you when your work is due. Your calendar is where you actually look. This
extension connects the two.

Click the icon, pick your courses, and your assignment deadlines appear on Google Calendar with
reminders. It keeps itself up to date in the background, so a new assignment or a moved
deadline shows up on its own.

NO PASSWORD REQUIRED
Most tools like this ask for your Gradescope login. This one never does. It reads Gradescope
using the session you are already signed in to, in your own browser. Your password is never
typed, stored, or sent anywhere.

WHAT YOU GET
• Every course, grouped by term — pick the ones you want
• Deadlines on Google Calendar, with reminders 24 hours and 1 hour ahead (configurable)
• A popup showing what is due next, with overdue work first
• Moved a deadline? The existing event moves too, instead of leaving a duplicate
• Optional: skip assignments you have already submitted
• Optional: desktop notifications when a grade posts or changes
• Background sync every few hours, no tab needed
• Or export a .ics file and import it anywhere — no account required

PRIVACY
No server, no analytics, no account. Your data goes from Gradescope to your own Google Calendar
and nowhere else. The extension only ever touches calendar events it created; everything else
in your calendar is left alone. You can point it at a dedicated "Gradescope" calendar so
deadlines stay out of your main one and can be hidden or deleted in one click.

Open source: https://github.com/kingaryaprince/GradescopeGCALSync
```

**Single purpose** (required field)

```
Reads assignment due dates from the signed-in user's Gradescope account and adds them to their
Google Calendar.
```

---

## 4. Data-use disclosures

Chrome Web Store asks you to declare data collection. Truthful answers:

| Category | Answer |
|---|---|
| Personally identifiable information | No |
| Health, financial, authentication, personal communications, location | No |
| Web history, user activity | No |
| **Website content** | **Yes** — assignment names and due dates from Gradescope |

Certify all three: not sold to third parties, not used outside the single purpose, not used for
creditworthiness or lending.

Nothing leaves the device except calls to Google Calendar on the user's behalf, so no
"data transferred to third parties" disclosure applies.

---

## 5. Scope justifications

Reviewers want to know **why each scope is the narrowest one that works**. Answer per scope:

**`calendar.app.created`**

```
The extension offers to create a dedicated "Gradescope" calendar and writes assignment
deadlines to it. This is the recommended setup and the narrowest scope that supports it: it
grants access only to the calendar the extension itself created, and no access to any of the
user's other calendars.
```

**`calendar.events`**

```
Needed only when the user chooses to write deadlines to a calendar they already own rather
than a dedicated one. The extension creates, updates, and deletes only the events it created,
identified by a private extended property. It never reads or modifies any other event.
```

**`calendar.calendarlist.readonly`**

```
Populates the calendar picker in the extension's settings, so the user can choose which of
their writable calendars to sync into. Read-only, and used for names and IDs only.
```

**Why not narrower:** there is no Calendar scope that permits writing events without also
permitting reads on that calendar. `calendar.app.created` is used by default precisely to keep
access limited to a calendar the extension owns.

---

## 6. Demo video script

Two to three minutes, unlisted YouTube is fine. Reviewers check that the consent screen matches
the described use.

1. **Setup (10s).** Show `chrome://extensions` with the extension installed.
2. **The problem (10s).** Gradescope course page with assignment due dates.
3. **Consent (30s).** Open the popup → *Connect Google Calendar* → let the **OAuth consent
   screen be fully readable on camera, with the scopes visible** → approve. Reviewers look for
   this specifically.
4. **Dedicated calendar (20s).** Settings → *Create a separate calendar* → point out this means
   the extension cannot touch the user's other calendars.
5. **Sync (30s).** Pick courses → *Sync now* → open Google Calendar and show the events with
   their reminders.
6. **Update, not duplicate (20s).** Sync again; show the count as unchanged rather than
   duplicated.
7. **Privacy (20s).** State on camera: no server, no analytics, and the Gradescope password is
   never requested. Show the popup with no password field anywhere.

Say the scope names out loud as they appear; it makes the reviewer's job trivial.

---

## 7. Assets to produce

- [ ] Icon 128×128 — done (`extension/src/icons/icon128.png`)
- [ ] At least one screenshot, 1280×800 or 640×400. Best three: the popup deadline list, the
      course picker grouped by term, and the resulting Google Calendar week view.
- [ ] Small promo tile 440×280
- [ ] Unlisted YouTube demo (§6)

Screenshots should show plausible course names. Avoid anything identifying if you would rather
not have your real schedule public.
