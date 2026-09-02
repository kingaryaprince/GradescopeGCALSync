# gradescope_to_calendar.py
import os
import re
import time
from datetime import datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
from dateutil import parser as dateparser
from dateutil import tz

from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException

# ========================= CONFIG =========================
# --- load .env ---
load_dotenv()

COURSE_NAME = os.getenv("COURSE_NAME", "CS70")
CHROMEDRIVER_PATH = os.getenv("CHROMEDRIVER_PATH", "chromedriver")
DEFAULT_TZ = os.getenv("DEFAULT_TZ", "America/Los_Angeles")
EVENT_DURATION_HOURS = int(os.getenv("EVENT_DURATION_HOURS", "1"))
SCOPES = [s.strip() for s in os.getenv("SCOPES", "https://www.googleapis.com/auth/calendar").split(",")]
# Write to your separate Gradescope calendar (primary if seperate Calendar not given)
CALENDAR_ID = os.getenv("CALENDAR_ID", "primary")

EMAIL = (os.getenv("GRADESCOPE_EMAIL") or "").strip()
PASSWORD = (os.getenv("GRADESCOPE_PASSWORD") or "").strip()
if not EMAIL or not PASSWORD:
    raise SystemExit("Missing GRADESCOPE_EMAIL or GRADESCOPE_PASSWORD in .env")

# --- Google Calendar auth ---
def get_calendar_service():
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build

    token_path = Path("token.json")
    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not Path("credentials.json").exists():
                raise SystemExit("Place your Google OAuth client file as credentials.json next to this script.")
            flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES)
            creds = flow.run_local_server(port=0)
        token_path.write_text(creds.to_json())
    return build("calendar", "v3", credentials=creds)

def show_calendar_info(service, calendar_id):
    info = service.calendars().get(calendarId=calendar_id).execute()
    print(f"🗓  Target calendar: {info.get('summary')}  (id: {info.get('id')})")

# --- Helpers (de-dupe) ---
def slugify(s): return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
def make_gsync_id(course_name, title, due_dt):
    return f"gradescope:{slugify(course_name)}:{slugify(title)}:{int(due_dt.timestamp())}"

def event_exists_by_id(service, calendar_id, gsync_id):
    resp = service.events().list(
        calendarId=calendar_id,
        privateExtendedProperty=f"gsyncId={gsync_id}",
        singleEvents=True,
        maxResults=1,
    ).execute()
    return bool(resp.get("items", []))

def create_event(service, calendar_id, title, start_dt, end_dt, description=None, url=None, gsync_id=None):
    body = {
        "summary": title,
        "description": (description or "") + (f"\n{url}" if url else ""),
        "start": {"dateTime": start_dt.isoformat()},
        "end":   {"dateTime": end_dt.isoformat()},
    }
    if gsync_id:
        body["extendedProperties"] = {"private": {"gsyncId": gsync_id}}
    return service.events().insert(calendarId=calendar_id, body=body).execute()

# --- Selenium login & nav ---
def login_and_land(driver):
    wait = WebDriverWait(driver, 25)
    driver.get("https://www.gradescope.com/")
    # open login modal
    button = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, "a[href*='/log_in'], .tiiBtn.tiiBtn-secondarySplash.js-logInButton")))
    button.click()
    # fill modal
    email_input = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, "input#session_email")))
    pwd_input   = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, "input#session_password")))
    email_input.clear(); email_input.send_keys(EMAIL); time.sleep(0.1)
    pwd_input.clear();   pwd_input.send_keys(PASSWORD); time.sleep(0.1)
    try:
        wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, "button[type='submit'], input[type='submit'], [name='commit']"))).click()
    except TimeoutException:
        pwd_input.send_keys("\n")
    wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "main")))
    return wait

def open_course(driver, wait, course_name):
    locator = (By.XPATH, f"//a[(contains(@class,'courseBox') or contains(@class,'courseBox--short')) and contains(., '{course_name}')]")
    tile = wait.until(EC.element_to_be_clickable(locator))
    url = tile.get_attribute("href")
    tile.click()
    wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "table")))
    return url

# --- Scraper (grab ALL assignment types) ---
ALLOW_FILTER = None   # e.g. ["homework", "project"]  → only keep these; None = allow all
DENY_FILTER  = []     # e.g. ["attendance", "mini-vitamin"]

MONTHS = ("Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec")

def looks_like_date(s: str) -> bool:
    s = s.strip()
    return (" at " in s and any(s.startswith(m) for m in MONTHS))

def scrape_assignments(driver, include_attendance=True):
    """
    Scrapes ALL visible rows (HW, Projects, Mini-Vitamins, etc).
    - ALLOW_FILTER: if set, keeps only titles containing any keyword.
    - DENY_FILTER: removes titles containing any keyword.
    - include_attendance: if False, 'attendance' is auto-added to deny list.
    Picks the last date-like line in the row as the Due.
    Returns: [{"title": str, "due_text": str, "href": str}]
    """
    # build effective deny list based on flag
    effective_deny = list(DENY_FILTER)
    if not include_attendance:
        effective_deny.append("attendance")

    results = []
    rows = driver.find_elements(By.CSS_SELECTOR, "table tbody tr")
    print(f"Found {len(rows)} table rows")

    for idx, r in enumerate(rows, start=1):
        try:
            tds = r.find_elements(By.CSS_SELECTOR, "td")
            if not tds:
                continue

            # Title + href (first-cell link → any row link → first-cell text)
            title, href = "", None
            try:
                a0 = tds[0].find_element(By.CSS_SELECTOR, "a")
                if a0.text.strip():
                    title = a0.text.strip()
                    href = a0.get_attribute("href") or None
            except Exception:
                pass

            if not title:
                for L in r.find_elements(By.CSS_SELECTOR, "a"):
                    txt = (L.text or "").strip()
                    if not txt:
                        continue
                    href_candidate = L.get_attribute("href") or ""
                    if "/assignments/" in href_candidate:
                        title = txt
                        href = href_candidate
                        break

            if not title:
                title = (tds[0].text or "").strip()
            if not title:
                continue

            # Apply deny/allow filters
            if effective_deny and any(block.lower() in title.lower() for block in effective_deny):
                print(f"[Row {idx}] ❌ Deny-filtered: {title}")
                continue
            if ALLOW_FILTER and not any(allow.lower() in title.lower() for allow in ALLOW_FILTER):
                print(f"[Row {idx}] ❌ Not in allow list: {title}")
                continue

            # Gather candidate lines from all cells, filter noise
            candidate_lines = []
            for td in tds:
                txt = (td.text or "").strip()
                if not txt:
                    continue
                for ln in txt.splitlines():
                    ln = ln.strip()
                    if not ln:
                        continue
                    if "left" in ln.lower() or "late due" in ln.lower():
                        continue
                    candidate_lines.append(ln)

            # Pick the last date-like line as the real due
            date_lines = [ln for ln in candidate_lines if looks_like_date(ln)]
            if date_lines:
                due_text = date_lines[-1]
            else:
                monthy = [ln for ln in candidate_lines if any(m in ln for m in MONTHS)]
                due_text = monthy[-1] if monthy else ""

            if not due_text:
                print(f"[Row {idx}] skip: no due for {title!r}")
                continue

            results.append({"title": title, "due_text": due_text, "href": href})
            print(f"[Row {idx}] ✅ {title} | {due_text}")

        except Exception as e:
            print(f"[Row {idx}] error: {e}")

    if not results:
        for i, r in enumerate(rows[:3], start=1):
            tds = r.find_elements(By.CSS_SELECTOR, "td")
            print(f"DEBUG row {i}: {[td.text for td in tds]}")
    return results

# --- Parse 'Oct 04 at 4:00PM' into TZ-aware datetime ---
def parse_due(due_text, tz_name=DEFAULT_TZ):
    zone = tz.gettz(tz_name)
    now = datetime.now(zone)
    dt = dateparser.parse(f"{due_text} {now.year}")
    if not dt:
        raise ValueError(f"Could not parse date: {due_text}")
    if not dt.tzinfo:
        dt = dt.replace(tzinfo=zone)
    return dt

# ========================= MAIN =========================
def main():
    service = Service(executable_path=CHROMEDRIVER_PATH)
    driver = webdriver.Chrome(service=service)
    wait = WebDriverWait(driver, 25)

    created = skipped = failed = 0

    try:
        wait = login_and_land(driver)
        open_course(driver, wait, COURSE_NAME)

        # 🚀 scrape EVERYTHING (HW, projects, mini-vitamins, etc.)
        assignments = scrape_assignments(driver, include_attendance=True)
        if not assignments:
            print("No assignments found.")
            return

        cal = get_calendar_service()
        show_calendar_info(cal, CALENDAR_ID)

        for a in assignments:
            try:
                due_dt = parse_due(a["due_text"])
                end_dt = due_dt + timedelta(hours=EVENT_DURATION_HOURS)

                title = f"{COURSE_NAME}: {a['title']} (Due)"
                gid = make_gsync_id(COURSE_NAME, a["title"], due_dt)

                if event_exists_by_id(cal, CALENDAR_ID, gid):
                    print(f"↩️  Skip exists: {title} @ {due_dt}")
                    skipped += 1
                    continue

                evt = create_event(
                    cal, CALENDAR_ID, title, due_dt, end_dt,
                    description=f"Gradescope due: {a['due_text']}",
                    url=a.get("href"),
                    gsync_id=gid,
                )
                print(f"✅ Created: {title} @ {due_dt} → {evt.get('htmlLink')}")
                created += 1

            except Exception as e:
                print(f"⚠️  Failed on {a['title']} ({a.get('due_text')}): {e}")
                failed += 1

        print(f"Done. Created {created}, skipped {skipped}, failed {failed}.")

    finally:
        driver.quit()

if __name__ == "__main__":
    main()
