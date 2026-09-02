# Privacy Policy — Gradescope → Calendar Sync

_Last updated: 2026-09-01_

## The short version

This extension runs entirely in your browser. It has no server, no analytics, and no account.
Your data goes from Gradescope to your Google Calendar and nowhere else.

## What it accesses

**Gradescope.** It reads your dashboard and course pages using the session you are already
signed in to, to get course names, assignment names, and due dates. It never sees, asks for, or
stores your Gradescope password.

**Google Calendar.** With your permission, it creates, updates, and deletes calendar events for
your Gradescope deadlines. It only ever touches events it created itself; those are tagged
internally, and everything else in your calendar is ignored.

## What it stores, and where

| Data | Where | Why |
|---|---|---|
| Your settings | `chrome.storage.sync` | So they follow your Chrome profile |
| Course list, last sync result | `chrome.storage.local` | So the popup opens instantly |
| Google access token | Chrome's own token store | Managed by Chrome, not by this extension |

All of it stays on your device or in your own Google account. Uninstalling the extension
removes it.

## What is never collected

No analytics. No telemetry. No crash reporting. No advertising identifiers. No passwords.
Nothing is transmitted to the developer, because there is nowhere to transmit it to.

## Who your data is shared with

Nobody. There is no third party, no server, and no data sale. The only network requests the
extension makes are to `gradescope.com` and Google's Calendar API, both on your behalf.

## Google API Limited Use

This extension's use of information from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements. Calendar data is used solely to provide the
user-facing sync feature described above, and is never transferred elsewhere, used for
advertising, or read by humans.

## Revoking access

Remove Calendar access in Settings → **Disconnect**, at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions), or by
uninstalling the extension.

## Contact

Open an issue at https://github.com/kingaryaprince/GradescopeGCALSync/issues.
