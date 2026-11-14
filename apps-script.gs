/**
 * Hourglass research endpoint.
 * Paste this into Extensions -> Apps Script inside a Google Sheet in YOUR Drive (see SETUP.md, step 2).
 * It receives logs from consenting students and writes them to the "Logs" sheet, using a random
 * study code (never a User ID, name or email).
 */
const STUDY_KEY = 'CHANGE_ME_TO_A_RANDOM_STRING'; // must match STUDY_KEY in app/config.js

const SHEET_NAME = 'Logs';
const HEADERS = ['Participant code', 'Category', 'Date', 'Hours', 'Rating (sleepiness or productivity)', 'Last updated'];
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
    const sh = getSheet_();

    if (d.action === 'withdraw') {
      deleteRows_(sh, r => r[0] === d.code);
      return out_({ ok: true });
    }

    if (!LABELS[d.category] || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || ''))) return out_({ ok: false, error: 'bad entry' });
    const label = LABELS[d.category];
    const match = r => r[0] === d.code && r[1] === label && String(r[2]) === d.date;

    if (d.action === 'delete') {
      deleteRows_(sh, match);
      return out_({ ok: true });
    }

    if (d.action === 'upsert') {
      const hours = Number(d.hours);
      const rating = d.rating === null || d.rating === undefined || d.rating === '' ? '' : Number(d.rating);
      if (!(hours >= 0 && hours <= 24)) return out_({ ok: false, error: 'bad hours' });
      if (rating !== '' && !(rating >= 1 && rating <= 10)) return out_({ ok: false, error: 'bad rating' });
      const row = [d.code, label, d.date, hours, rating, new Date().toISOString()];
      const values = sh.getDataRange().getValues();
      for (let i = 1; i < values.length; i++) {
        if (match(values[i])) {
          sh.getRange(i + 1, 1, 1, row.length).setValues([row]);
          return out_({ ok: true, updated: true });
        }
      }
      sh.appendRow(row);
      return out_({ ok: true, updated: false });
    }

    return out_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  sh.getRange('C:C').setNumberFormat('@'); // keep dates as plain text (YYYY-MM-DD)
  return sh;
}

function deleteRows_(sh, predicate) {
  const values = sh.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (predicate(values[i])) sh.deleteRow(i + 1);
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
