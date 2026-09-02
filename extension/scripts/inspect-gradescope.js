/**
 * Paste into the Chrome DevTools console on gradescope.com (dashboard OR a
 * course page) to dump the markup this extension parses. Copy the output back
 * so the selectors in src/lib/gradescope/parse.ts can be pinned to reality.
 *
 * Reads only structure and class names. Assignment titles are truncated and no
 * scores, emails, or personal data are printed.
 */
(() => {
  const out = [];
  const log = (...a) => out.push(a.join(' '));
  const cls = (el) => (el && el.className ? `.${String(el.className).trim().split(/\s+/).join('.')}` : '');

  log(`URL: ${location.pathname}`);

  // ---- dashboard ----
  const boxes = document.querySelectorAll('a[href*="/courses/"]');
  const roots = [...boxes].filter((a) => /\/courses\/\d+$/.test(a.getAttribute('href') || ''));
  if (roots.length) {
    log(`\n=== DASHBOARD: ${roots.length} course links ===`);
    log(`a.courseBox present: ${document.querySelectorAll('a.courseBox').length > 0}`);
    const a = roots[0];
    log(`first link classes: ${cls(a)}`);
    log(`  children: ${[...a.children].map((c) => `${c.tagName}${cls(c)}`).join(' | ') || '(none)'}`);
    log(`  shortname el: ${a.querySelector('.courseBox--shortname') ? 'FOUND' : 'MISSING'}`);
    log(`  name el:      ${a.querySelector('.courseBox--name') ? 'FOUND' : 'MISSING'}`);
    const terms = [...document.querySelectorAll('*')].filter(
      (e) => e.children.length === 0 &&
        /\b(spring|summer|fall|autumn|winter)\s*'?\d{2,4}\b/i.test((e.textContent || '').trim()) &&
        (e.textContent || '').trim().length <= 40,
    );
    log(`  term headings found: ${terms.length}${terms[0] ? ` -> ${terms[0].tagName}${cls(terms[0])} "${terms[0].textContent.trim()}"` : ''}`);
  }

  // ---- course page ----
  const tables = document.querySelectorAll('table');
  if (tables.length) {
    log(`\n=== COURSE PAGE: ${tables.length} table(s) ===`);
    tables.forEach((t, ti) => {
      const heads = [...t.querySelectorAll('thead th, thead td')].map((h) => h.textContent.trim());
      const rows = t.querySelectorAll('tbody tr');
      log(`\n[table ${ti}] id=${t.id || '(none)'} ${cls(t)}`);
      log(`  headers: ${heads.length ? JSON.stringify(heads) : '(no thead)'}`);
      log(`  body rows: ${rows.length}`);

      [...rows].slice(0, 2).forEach((r, ri) => {
        const cells = [...r.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
        log(`  row ${ri}: ${cells.map((c) => `${c.tagName}${cls(c)}`).join(' | ')}`);
        const link = r.querySelector('a[href]');
        log(`    link: ${link ? link.getAttribute('href') : '(none)'}`);
        log(`    title: ${JSON.stringify((r.children[0]?.textContent || '').trim().slice(0, 40))}`);
        log(`    .submissionTimeChart: ${r.querySelector('.submissionTimeChart') ? 'FOUND' : 'MISSING'}`);
        const dues = r.querySelectorAll('.submissionTimeChart--dueDate');
        log(`    .submissionTimeChart--dueDate count: ${dues.length}`);
        dues.forEach((d, i) =>
          log(`      [${i}] aria-label=${JSON.stringify(d.getAttribute('aria-label'))} text=${JSON.stringify(d.textContent.trim())} datetime=${JSON.stringify(d.getAttribute('datetime'))}`),
        );
        // Any machine-readable timestamp anywhere in the row is a big win:
        // it removes the need to infer the year at all.
        const iso = [...r.querySelectorAll('*')]
          .flatMap((e) => ['datetime', 'title', 'data-timestamp', 'aria-label'].map((k) => e.getAttribute(k)))
          .filter((v) => v && /\d{4}-\d{2}-\d{2}/.test(v));
        log(`    ISO timestamps in row: ${iso.length ? JSON.stringify(iso.slice(0, 3)) : 'NONE (year must be inferred)'}`);
        cells.forEach((c, ci) => log(`    cell ${ci} text: ${JSON.stringify(c.textContent.trim().replace(/\s+/g, ' ').slice(0, 70))}`));
      });
    });
  }

  if (!roots.length && !tables.length) log('\nNo course links or tables found — are you signed in?');

  const text = out.join('\n');
  console.log(text);
  try { copy(text); console.log('\n(copied to clipboard)'); } catch {}
  return text;
})();
