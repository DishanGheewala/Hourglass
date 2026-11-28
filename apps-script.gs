/**
 * Hourglass research endpoint + reminder timer.
 * Paste this into Extensions -> Apps Script inside a Google Sheet in YOUR Drive (see SETUP.md, step 2),
 * then Deploy -> Manage deployments -> edit (pencil) -> Version: New version -> Deploy.
 *
 * 1. Receives logs from consenting students and writes them to the "Logs" tab, using a random
 *    study code (never a User ID, name or email). Rows are never deleted: if a student deletes a
 *    log in the app, the row is only marked "Deleted in app", so collected data is kept.
 * 2. Records each consenting participant on the "Participants" tab.
 * 3. Optional: every 5 minutes, asks the Vercel app to send any reminder alerts that are due
 *    (run setupReminderTimer once; see SETUP.md, step 5).
 */
const STUDY_KEY = '9837rjc9urnc834rny987c49c08n30c98038ch7f'; // must match STUDY_KEY in app/config.js exactly

// For the reminder timer (SETUP.md, step 5). Leave as is if you don't use push alerts.
const APP_URL = 'https://YOUR-SITE.vercel.app'; // your Vercel address, no trailing slash
const CRON_SECRET = 'PASTE-THE-SAME-CRON_SECRET-YOU-SET-IN-VERCEL';

const SHEET_NAME = 'Logs';
const HEADERS = ['Participant code', 'Category', 'Date', 'Hours', 'Rating (sleepiness or productivity)', 'Last updated', 'Status'];
const PARTICIPANTS = 'Participants';
const P_HEADERS = ['Participant code', 'Consented at', 'Last seen'];
const LABELS = { sleep: 'Sleep', work: 'Study/Work', free: 'Free time' };

function doGet() {
  return out_({ ok: true, message: 'Hourglass research endpoint is running.' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const d = JSON.parse(e.postData.contents);
    if (d.key !== STUDY_KEY) return out_({ ok: false, error: 'bad key' });
    if (!/^P-[A-Z0-9]{8}$/.test(String(d.code || ''))) return out_({ ok: false, error: 'bad code' });

    if (d.action === 'consent') {
      touchParticipant_(d.code, true);
      return out_({ ok: true });
    }

    if (!LABELS[d.category] || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || ''))) return out_({ ok: false, error: 'bad entry' });
    const sh = getSheet_(SHEET_NAME, HEADERS);
    const label = LABELS[d.category];
    const match = r => r[0] === d.code && r[1] === label && String(r[2]) === d.date;
    const values = sh.getDataRange().getValues();
    let rowIndex = -1;
    for (let i = 1; i < values.length; i++) if (match(values[i])) { rowIndex = i + 1; break; }

    if (d.action === 'delete') {
      // Keep the data; just mark it.
      if (rowIndex > 0) sh.getRange(rowIndex, 7).setValue('Deleted in app ' + new Date().toISOString());
      return out_({ ok: true });
    }

    if (d.action === 'upsert') {
      const hours = Number(d.hours);
      const rating = d.rating === null || d.rating === undefined || d.rating === '' ? '' : Number(d.rating);
      if (!(hours >= 0 && hours <= 24)) return out_({ ok: false, error: 'bad hours' });
      if (rating !== '' && !(rating >= 1 && rating <= 10)) return out_({ ok: false, error: 'bad rating' });
      const row = [d.code, label, d.date, hours, rating, new Date().toISOString(), 'Active'];
      if (rowIndex > 0) sh.getRange(rowIndex, 1, 1, row.length).setValues([row]);
      else sh.appendRow(row);
      touchParticipant_(d.code, false);
      return out_({ ok: true, updated: rowIndex > 0 });
    }

    return out_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function touchParticipant_(code, consented) {
  const sh = getSheet_(PARTICIPANTS, P_HEADERS);
  const values = sh.getDataRange().getValues();
  const now = new Date().toISOString();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === code) { sh.getRange(i + 1, 3).setValue(now); return; }
  }
  sh.appendRow([code, consented ? now : '', now]);
}

function getSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < headers.length) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold'); // adds new columns to an older sheet
  }
  if (name === SHEET_NAME) sh.getRange('C:C').setNumberFormat('@'); // keep dates as plain text (YYYY-MM-DD)
  return sh;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- Reminder timer (SETUP.md, step 5) ----------
// Run this function once from the Apps Script editor (select it, press Run, approve).
function setupReminderTimer() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'sendDueReminders').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendDueReminders').timeBased().everyMinutes(5).create();
  sendDueReminders();
}

function sendDueReminders() {
  const base = APP_URL.replace(/\/app\/?$/, '').replace(/\/$/, ''); // works with or without a trailing /app/
  const r = UrlFetchApp.fetch(base + '/api/reminders?key=' + encodeURIComponent(CRON_SECRET), { muteHttpExceptions: true });
  console.log(r.getResponseCode() + ' ' + r.getContentText());
}

// Run this from the editor to check that the sheet works (it adds a TEST row you can delete).
function testWrite() {
  const res = doPost({ postData: { contents: JSON.stringify({ key: STUDY_KEY, code: 'P-TEST0000', action: 'upsert', category: 'sleep', date: '2000-01-01', hours: 8, rating: 5 }) } });
  console.log(res.getContent());
}
