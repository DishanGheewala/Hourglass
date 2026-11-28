/**
 * Hourglass dashboard: charts for each participant and each category, built inside your research sheet.
 *
 * Setup (once): in the Apps Script editor click the + next to "Files" -> Script, name it "Dashboard",
 * paste this whole file, Save. Then choose "buildDashboard" in the function dropdown and press Run.
 * Reload the spreadsheet afterwards: a new "Hourglass" menu appears (Hourglass -> Build / refresh dashboard).
 *
 * It creates two tabs:
 *  - "Dashboard": pick a participant code in B2 and the five charts change (sleep hours, sleepiness,
 *    study/work hours, productivity, free-time hours), plus a small summary.
 *  - "Group averages": the average per day across all participants, for each category.
 * The charts update by themselves as new logs arrive. Rows marked "Deleted in app" are left out unless you
 * set B3 to Yes. This file does not change your data or your web app deployment.
 */
const DASH = 'Dashboard';
const GROUP = 'Group averages';
const COLOR = { sleep: '#6366f1', rating: '#db2777', work: '#d97706', free: '#059669' };
const MAXROW = 400;

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Hourglass').addItem('Build / refresh dashboard', 'buildDashboard').addToUi();
}

function buildDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName('Logs')) {
    SpreadsheetApp.getUi().alert('There is no "Logs" tab yet. Save a log in the app (with research sharing on) first, then run this again.');
    return;
  }
  buildParticipantDashboard_(ss);
  buildGroupSheet_(ss);
  ss.setActiveSheet(ss.getSheetByName(DASH));
}

function fresh_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (sh) {
    sh.getCharts().forEach(c => sh.removeChart(c));
    sh.clear();
    sh.clearConditionalFormatRules();
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearDataValidations();
  } else {
    sh = ss.insertSheet(name);
  }
  return sh;
}

// One block = a date column and a value column for the chosen participant and category.
// label: the Category text used in the Logs tab. valueCol: D (hours) or E (rating).
function block_(sh, col, header, label, valueCol, valueHeader) {
  sh.getRange(1, col).setValue(header);
  sh.getRange(1, col + 1).setValue(valueHeader);
  const f = '=IFERROR(SORT(FILTER({ARRAYFORMULA(IFERROR(DATEVALUE(Logs!$C$2:$C),Logs!$C$2:$C)),Logs!$' + valueCol + '$2:$' + valueCol + '},' +
    'Logs!$A$2:$A=$B$2,Logs!$B$2:$B="' + label + '",Logs!$' + valueCol + '$2:$' + valueCol + '<>"",' +
    '(($B$3="Yes")+(LEFT(Logs!$G$2:$G&"",6)="Active"))>0),1,TRUE),"")';
  sh.getRange(2, col).setFormula(f);
  sh.getRange(2, col, MAXROW, 1).setNumberFormat('yyyy-mm-dd');
}

function lineChart_(sh, title, col, color, row, anchorCol, vTitle, isRating) {
  const b = sh.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(sh.getRange(1, col, MAXROW, 2))
    .setNumHeaders(1)
    .setPosition(row, anchorCol, 0, 0)
    .setOption('title', title)
    .setOption('legend', { position: 'none' })
    .setOption('colors', [color])
    .setOption('pointSize', 5)
    .setOption('lineWidth', 2)
    .setOption('width', 560)
    .setOption('height', 280)
    .setOption('hAxis', { format: 'MMM d' })
    .setOption('vAxis', isRating ? { title: vTitle, viewWindow: { min: 0, max: 10 } } : { title: vTitle, viewWindow: { min: 0 } });
  sh.insertChart(b.build());
}

function buildParticipantDashboard_(ss) {
  const sh = fresh_(ss, DASH);
  const parts = ss.getSheetByName('Participants');
  const first = parts && parts.getLastRow() > 1 ? String(parts.getRange(2, 1).getValue()) : '';

  sh.getRange('A1').setValue('Hourglass: participant dashboard').setFontSize(16).setFontWeight('bold');
  sh.getRange('A2').setValue('Participant code').setFontWeight('bold');
  sh.getRange('A3').setValue('Include entries deleted in the app?').setFontWeight('bold');
  sh.getRange('B2').setValue(first).setBackground('#eef2ff').setFontWeight('bold');
  sh.getRange('B3').setValue('No').setBackground('#eef2ff');
  if (parts) {
    sh.getRange('B2').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(parts.getRange('A2:A1000'), true).setAllowInvalid(true).build());
  }
  sh.getRange('B3').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['No', 'Yes'], true).build());
  sh.getRange('C2').setValue('<- pick a participant from the list').setFontColor('#64748b');

  // helper tables (to the right; the charts read from them)
  block_(sh, 13, 'Sleep: date', 'Sleep', 'D', 'Sleep hours');       // M:N
  block_(sh, 16, 'Sleepiness: date', 'Sleep', 'E', 'Sleepiness 1-10'); // P:Q
  block_(sh, 19, 'Study: date', 'Study/Work', 'D', 'Study/work hours'); // S:T
  block_(sh, 22, 'Productivity: date', 'Study/Work', 'E', 'Productivity 1-10'); // V:W
  block_(sh, 25, 'Free: date', 'Free time', 'D', 'Free-time hours');  // Y:Z
  sh.getRange(1, 13, 1, 14).setFontWeight('bold').setFontColor('#94a3b8'); // helper columns M:Z, to the right of the charts

  // summary
  sh.getRange('A5:D5').setValues([['Category', 'Days logged', 'Average hours', 'Average rating']]).setFontWeight('bold').setBackground('#f1f5f9');
  const rows = [
    ['Sleep', '=COUNT(N2:N)', '=IFERROR(ROUND(AVERAGE(N2:N),2),"-")', '=IFERROR(ROUND(AVERAGE(Q2:Q),1),"-")'],
    ['Study / Work', '=COUNT(T2:T)', '=IFERROR(ROUND(AVERAGE(T2:T),2),"-")', '=IFERROR(ROUND(AVERAGE(W2:W),1),"-")'],
    ['Free time', '=COUNT(Z2:Z)', '=IFERROR(ROUND(AVERAGE(Z2:Z),2),"-")', '-']
  ];
  sh.getRange(6, 1, 3, 4).setFormulas(rows);

  sh.setColumnWidth(1, 230); sh.setColumnWidth(2, 130); sh.setColumnWidth(3, 130); sh.setColumnWidth(4, 130);
  for (let c = 5; c <= 12; c++) sh.setColumnWidth(c, 100);
  // charts, two per row
  lineChart_(sh, 'Sleep (hours per night)', 13, COLOR.sleep, 10, 1, 'Hours', false);
  lineChart_(sh, 'Sleepiness in the morning (1 = awake, 10 = very sleepy)', 16, COLOR.rating, 10, 7, 'Rating', true);
  lineChart_(sh, 'Study / work (hours per day)', 19, COLOR.work, 25, 1, 'Hours', false);
  lineChart_(sh, 'Productivity (1 = not at all, 10 = very)', 22, COLOR.rating, 25, 7, 'Rating', true);
  lineChart_(sh, 'Free time (hours per day)', 25, COLOR.free, 40, 1, 'Hours', false);
  sh.setFrozenRows(3);
}

// Average per day across everyone (QUERY works on the text dates in the Logs tab).
function groupBlock_(sh, col, label, title, color, row, anchorCol) {
  const q = '=IFERROR(QUERY(Logs!$A$1:$G,"select C, avg(D), count(D) where B=\'' + label + '\' and G starts with \'Active\' and D is not null group by C order by C label C \'Date\', avg(D) \'Average hours\', count(D) \'Entries\'",1),"")';
  sh.getRange(1, col).setFormula(q);
  const b = sh.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(sh.getRange(1, col, MAXROW, 2))
    .setNumHeaders(1)
    .setPosition(row, anchorCol, 0, 0)
    .setOption('title', title)
    .setOption('legend', { position: 'none' })
    .setOption('colors', [color])
    .setOption('pointSize', 5)
    .setOption('lineWidth', 2)
    .setOption('width', 560)
    .setOption('height', 280)
    .setOption('vAxis', { title: 'Average hours', viewWindow: { min: 0 } });
  sh.insertChart(b.build());
}

function buildGroupSheet_(ss) {
  const sh = fresh_(ss, GROUP);
  groupBlock_(sh, 20, 'Sleep', 'Average sleep per night, all participants', COLOR.sleep, 2, 1);        // T:V
  groupBlock_(sh, 24, 'Study/Work', 'Average study / work per day, all participants', COLOR.work, 2, 7);  // X:Z
  groupBlock_(sh, 28, 'Free time', 'Average free time per day, all participants', COLOR.free, 18, 1);    // AB:AD
  sh.getRange('A1').setValue('Hourglass: group averages (charts update by themselves; the tables they read are in columns T to AD)').setFontWeight('bold');
  for (let c = 1; c <= 12; c++) sh.setColumnWidth(c, 100);
}
