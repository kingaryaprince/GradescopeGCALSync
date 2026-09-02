# Gradescope → Google Calendar Sync

Automates pulling assignments from a Gradescope course and adds their **due dates** to a Google Calendar.

- Logs into Gradescope (email/password).
- Scrapes **all** assignment types (Homework, Projects, Mini-Vitamins, etc.).
- Creates calendar events with stable de-dupe so re-runs won’t duplicate.
- Can target your **primary calendar** or a dedicated one (e.g., “Gradescope Sync”).

> ⚠️ **Heads-up:** Web scraping is brittle. If Gradescope changes its HTML, you may need to tweak selectors.

---

## 1) Prerequisites

- Python 3.9+
- Google Chrome
- Matching ChromeDriver
  - Download from ChromeDriver releases
    - https://chromedriver.chromium.org/downloads
  - Put the binary wherever you like and reference it in your .env
---

## 2) One-time Google API setup

1. Go to Google Cloud Console → **APIs & Services** → **Credentials**  
   Create **OAuth client ID** (type: *Desktop app*).

2. Download the JSON and **save it next to the script** as: credentials.json
3. On first run, a browser window will ask you to authorize Calendar access.  
   This creates a local `token.json` for future runs.

> If you change the OAuth scopes later, delete `token.json` and run again.

---

## 3) Local setup

```bash
git clone <your-repo>
cd SeleniumPractice
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```
Edit `.env` with your config:

```ini
# Gradescope login

GRADESCOPE_EMAIL=you@example.com
GRADESCOPE_PASSWORD=supersecret

# Config
COURSE_NAME=CS70
CHROMEDRIVER_PATH=/absolute/path/to/chromedriver
DEFAULT_TZ=America/Los_Angeles
EVENT_DURATION_HOURS=1
SCOPES=https://www.googleapis.com/auth/calendar
CALENDAR_ID=c_...@group.calendar.google.com   # from Google Calendar settings
```
> Place `credentials.json` in the project root (same folder as the script).

## 4) Filters

> Accordingly edit filters to match preferences

```python
ALLOW_FILTER = None         # e.g. ["homework", "project"] (None = allow all)
DENY_FILTER  = []           # e.g. ["attendance", "mini-vitamin"]
```


## 5) Run

```bash
source .venv/bin/activate
python3 gradescope_to_calendar.py
```
Example Output:
```less
Found 16 table rows
[Row 2] → Homework 5 | Oct 04 at 4:00PM
[Row 3] → Homework 4 | Sep 27 at 4:00PM
🗓  Target calendar: Gradescope Sync (id: c_...@group.calendar.google.com)
✅ Created: CS70: Homework 5 (Due) @ 2025-10-04 16:00:00-07:00
↩️  Skip exists: CS70: Homework 4 (Due) @ 2025-09-27 16:00:00-07:00
Done. Created 1, skipped 1, failed 0.
```

## 6) Automation (Optional)
### MacOS/Linux (cron)
```bash
crontab -e
# run twice a day at 8:00 and 20:00
0 8,20 * * * /bin/bash -lc 'cd /path/to/project && source .venv/bin/activate && python3 gradescope_to_calendar.py >> sync.log 2>&1'
```
### Windows (Task Scheduler): create a task that runs:
```php-template
<path>\python.exe <project>\gradescope_to_calendar.py
```

## 7) Troubleshooting
```less
403 insufficientPermissions: you changed scopes. Delete token.json and run again.

No assignments matched: Gradescope layout shifted. Re-run and check console logs (rows print). Adjust selectors in scrape_assignments.

Wrong ChromeDriver: ensure driver version matches Chrome (chromedriver --version).

Events on wrong calendar: confirm CALENDAR_ID and your Google account on the OAuth consent screen.

Time zone off: set DEFAULT_TZ to your IANA timezone.
```

## 8) Security & Git Hygiene
```less
.env, credentials.json, and token.json are gitignored (don’t commit secrets).

Only commit .env.example as a template.

Use a limited Google project for testing if sharing repo.
```