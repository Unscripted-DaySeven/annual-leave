/**
 * ============================================================================
 *  Annual Leave Tracker — Google Apps Script backend
 * ============================================================================
 *  This script turns a Google Sheet into the database for the leave-booking
 *  web app, and keeps a shared Google Calendar in sync with approved leave.
 *
 *  Setup is in README.md. In short:
 *    1. Create a Google Sheet, Extensions ▸ Apps Script, paste this file in.
 *    2. Edit the CONFIG block below (token + PIN at minimum).
 *    3. Run `firstRunSetup` once and grant the permissions it asks for.
 *    4. Deploy ▸ New deployment ▸ Web app ▸ Execute as *me*,
 *       Who has access *Anyone*. Copy the /exec URL into config.js.
 * ============================================================================
 */

// ─── CONFIG ────────────────────────────────────────────────────────────────
var CONFIG = {
  // Any long random string. The web app sends this with every request.
  // Change it and re-deploy if you ever need to lock people out.
  API_TOKEN: 'CHANGE-ME-to-a-long-random-string',

  // Anyone who knows this PIN can approve/reject leave and edit the team list.
  MANAGER_PIN: '2468',

  // Shared Google Calendar that approved leave is written to.
  // 'primary' uses the account that owns this script; otherwise paste a
  // calendar ID (Calendar settings ▸ Integrate calendar ▸ Calendar ID).
  CALENDAR_ID: 'c_7bae8250a364b62d5ffe5ff9a7029f98473fec46c5ea427b0de852a785c97e1c@group.calendar.google.com',

  // Add the employee as a guest so the booking also lands on their own
  // calendar. Set to false if you only want the shared team calendar.
  INVITE_EMPLOYEE: true,

  // Email the employee when their request is approved or rejected.
  EMAIL_ON_DECISION: true,

  // england-and-wales | scotland | northern-ireland
  BANK_HOLIDAY_REGION: 'england-and-wales',

  // Half-day working hours (24h clock, local time).
  AM: { start: '09:00', end: '13:00' },
  PM: { start: '13:00', end: '17:30' },

  // Prefix on calendar event titles, e.g. "Annual leave — Jane Smith".
  EVENT_PREFIX: ''
};
// ───────────────────────────────────────────────────────────────────────────

var SHEETS = {
  employees: 'Employees',
  leave: 'Leave',
  settings: 'Settings'
};

var EMP_COLS = ['id', 'name', 'email', 'team', 'allowance', 'carryOver', 'startDate', 'active', 'manager'];
var LEAVE_COLS = ['id', 'employeeId', 'type', 'startDate', 'endDate', 'dayType', 'days',
                  'status', 'note', 'createdAt', 'decidedBy', 'decidedAt', 'calEventId', 'syncHash'];

var DEFAULT_SETTINGS = {
  companyName: 'Day Seven',
  region: 'england-and-wales',
  leaveYearStart: '01-01',      // MM-DD
  defaultAllowance: '25',
  maxOffPerDay: '2',            // clash warning threshold (per team)
  approvalRequired: 'true'
};

// ═══ WEB ENDPOINTS ═════════════════════════════════════════════════════════

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'ics') return serveIcs(p);
    if (p.action === 'ping') return json({ ok: true, version: 3 });
    requireToken(p.token);
    if (p.action === 'data' || !p.action) return json({ ok: true, data: readAll() });
    return json({ ok: false, error: 'Unknown action: ' + p.action });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'Body was not valid JSON' });
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    requireToken(body.token);
    ensureSheets();

    switch (body.action) {
      case 'saveEmployee':   return json({ ok: true, data: saveEmployee(body) });
      case 'removeEmployee': return json({ ok: true, data: removeEmployee(body) });
      case 'saveLeave':      return json({ ok: true, data: saveLeave(body) });
      case 'decideLeave':    return json({ ok: true, data: decideLeave(body) });
      case 'cancelLeave':    return json({ ok: true, data: cancelLeave(body) });
      case 'saveSettings':   return json({ ok: true, data: saveSettings(body) });
      case 'syncCalendar':   syncCalendar(); return json({ ok: true, data: readAll() });
      default: return json({ ok: false, error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function requireToken(token) {
  if (String(token || '') !== String(CONFIG.API_TOKEN)) {
    throw new Error('Bad or missing token — check API_TOKEN in Code.gs matches config.js');
  }
}

function requirePin(pin) {
  if (String(pin || '') !== String(CONFIG.MANAGER_PIN)) {
    throw new Error('Wrong manager PIN');
  }
}

// ═══ SHEET PLUMBING ════════════════════════════════════════════════════════

function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

function ensureSheets() {
  var book = ss();

  var emp = book.getSheetByName(SHEETS.employees);
  if (!emp) {
    emp = book.insertSheet(SHEETS.employees);
    emp.appendRow(EMP_COLS);
    emp.setFrozenRows(1);
  }

  var lv = book.getSheetByName(SHEETS.leave);
  if (!lv) {
    lv = book.insertSheet(SHEETS.leave);
    lv.appendRow(LEAVE_COLS);
    lv.setFrozenRows(1);
  }

  var st = book.getSheetByName(SHEETS.settings);
  if (!st) {
    st = book.insertSheet(SHEETS.settings);
    st.appendRow(['key', 'value']);
    st.setFrozenRows(1);
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      st.appendRow([k, DEFAULT_SETTINGS[k]]);
    });
  }

  // Add any columns introduced by a later version of this script.
  padHeaders(emp, EMP_COLS);
  padHeaders(lv, LEAVE_COLS);
}

function padHeaders(sheet, cols) {
  var have = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0]
    .map(function (v) { return String(v).trim(); });
  cols.forEach(function (c) {
    if (have.indexOf(c) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(c);
      have.push(c);
    }
  });
}

/** Read a sheet as an array of objects keyed by header name. */
function readSheet(name) {
  var sheet = ss().getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getDisplayValues();
  var headers = values.shift().map(function (h) { return String(h).trim(); });
  return values
    .filter(function (row) { return row.join('').trim() !== ''; })
    .map(function (row) {
      var obj = {};
      headers.forEach(function (h, i) { if (h) obj[h] = row[i]; });
      return obj;
    });
}

function headerIndex(sheet, cols) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var idx = {};
  cols.forEach(function (c) { idx[c] = headers.indexOf(c) + 1; });
  return idx;
}

function findRowById(sheet, id) {
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var ids = sheet.getRange(2, 1, last - 1, 1).getDisplayValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === String(id).trim()) return i + 2;
  }
  return -1;
}

/* Sheets coerces the strings "true"/"false" into booleans, which read back as
   "TRUE"/"FALSE". Normalise before comparing. */
function isFalse(v) { return String(v).trim().toLowerCase() === 'false'; }
function isTrue(v)  { return String(v).trim().toLowerCase() === 'true'; }

function uid(prefix) {
  return prefix + '-' + Utilities.getUuid().split('-')[0] + Date.now().toString(36).slice(-4);
}

function readSettings() {
  var out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { out[k] = DEFAULT_SETTINGS[k]; });
  readSheet(SHEETS.settings).forEach(function (r) {
    if (r.key) out[String(r.key).trim()] = r.value;
  });
  return out;
}

function readAll() {
  ensureSheets();
  return {
    employees: readSheet(SHEETS.employees).filter(function (e) { return e.id; }),
    leave: readSheet(SHEETS.leave).filter(function (l) { return l.id; }),
    settings: readSettings(),
    bankHolidays: bankHolidays(),
    serverTime: new Date().toISOString()
  };
}

// ═══ WRITE ACTIONS ═════════════════════════════════════════════════════════

function saveEmployee(body) {
  requirePin(body.pin);
  var emp = body.employee || {};
  if (!emp.name) throw new Error('Employee needs a name');

  var sheet = ss().getSheetByName(SHEETS.employees);
  var idx = headerIndex(sheet, EMP_COLS);
  var settings = readSettings();

  var record = {
    id: emp.id || uid('emp'),
    name: String(emp.name).trim(),
    email: String(emp.email || '').trim(),
    team: String(emp.team || '').trim(),
    allowance: emp.allowance === '' || emp.allowance == null ? settings.defaultAllowance : emp.allowance,
    carryOver: emp.carryOver == null || emp.carryOver === '' ? 0 : emp.carryOver,
    startDate: emp.startDate || '',
    active: emp.active === false || isFalse(emp.active) ? 'false' : 'true',
    manager: emp.manager === true || isTrue(emp.manager) ? 'true' : 'false'
  };

  var row = emp.id ? findRowById(sheet, emp.id) : -1;
  if (row === -1) {
    row = sheet.getLastRow() + 1;
  }
  EMP_COLS.forEach(function (c) {
    if (idx[c]) sheet.getRange(row, idx[c]).setValue(record[c]);
  });

  return readAll();
}

function removeEmployee(body) {
  requirePin(body.pin);
  var sheet = ss().getSheetByName(SHEETS.employees);
  var row = findRowById(sheet, body.id);
  if (row === -1) throw new Error('Employee not found');

  // Pull their calendar events before deleting the leave rows.
  var leaveSheet = ss().getSheetByName(SHEETS.leave);
  readSheet(SHEETS.leave).forEach(function (l) {
    if (String(l.employeeId) === String(body.id)) {
      if (l.calEventId) deleteCalendarEvent(l.calEventId);
      var r = findRowById(leaveSheet, l.id);
      if (r > 0) leaveSheet.deleteRow(r);
    }
  });

  sheet.deleteRow(row);
  return readAll();
}

function saveLeave(body) {
  var lv = body.leave || {};
  var settings = readSettings();
  var employees = readSheet(SHEETS.employees);
  var employee = employees.filter(function (e) { return String(e.id) === String(lv.employeeId); })[0];
  if (!employee) throw new Error('Pick an employee first');

  if (!lv.startDate) throw new Error('Start date is required');
  var start = lv.startDate;
  var end = lv.endDate || lv.startDate;
  if (end < start) throw new Error('End date is before the start date');

  var dayType = lv.dayType === 'am' || lv.dayType === 'pm' ? lv.dayType : 'full';
  if (dayType !== 'full') end = start;  // half days are single-day only

  var days = workingDays(start, end, dayType);
  if (days <= 0) throw new Error('That range is all weekend / bank holiday — nothing to book');

  var sheet = ss().getSheetByName(SHEETS.leave);
  var idx = headerIndex(sheet, LEAVE_COLS);
  var existingRow = lv.id ? findRowById(sheet, lv.id) : -1;
  var existing = null;
  if (existingRow > 0) {
    existing = readSheet(SHEETS.leave).filter(function (r) { return String(r.id) === String(lv.id); })[0];
  }

  var approvalRequired = !isFalse(settings.approvalRequired);
  var status = lv.status || (existing && existing.status) || (approvalRequired ? 'pending' : 'approved');
  if (lv.status && lv.status !== (existing && existing.status)) requirePin(body.pin);

  var record = {
    id: lv.id || uid('lv'),
    employeeId: lv.employeeId,
    type: lv.type || 'annual',
    startDate: start,
    endDate: end,
    dayType: dayType,
    days: days,
    status: status,
    note: String(lv.note || '').slice(0, 500),
    createdAt: (existing && existing.createdAt) || new Date().toISOString(),
    decidedBy: (existing && existing.decidedBy) || '',
    decidedAt: (existing && existing.decidedAt) || '',
    calEventId: (existing && existing.calEventId) || '',
    syncHash: ''   // force a re-sync
  };

  var row = existingRow > 0 ? existingRow : sheet.getLastRow() + 1;
  LEAVE_COLS.forEach(function (c) {
    if (idx[c]) sheet.getRange(row, idx[c]).setValue(record[c]);
  });

  safeSync();
  return readAll();
}

function decideLeave(body) {
  requirePin(body.pin);
  var sheet = ss().getSheetByName(SHEETS.leave);
  var row = findRowById(sheet, body.id);
  if (row === -1) throw new Error('Request not found');

  var idx = headerIndex(sheet, LEAVE_COLS);
  var status = body.status === 'approved' ? 'approved' : 'rejected';
  sheet.getRange(row, idx.status).setValue(status);
  sheet.getRange(row, idx.decidedBy).setValue(body.by || 'Manager');
  sheet.getRange(row, idx.decidedAt).setValue(new Date().toISOString());
  sheet.getRange(row, idx.syncHash).setValue('');

  safeSync();
  if (CONFIG.EMAIL_ON_DECISION) notifyDecision(body.id, status);
  return readAll();
}

function cancelLeave(body) {
  var sheet = ss().getSheetByName(SHEETS.leave);
  var row = findRowById(sheet, body.id);
  if (row === -1) throw new Error('Request not found');

  var record = readSheet(SHEETS.leave).filter(function (r) { return String(r.id) === String(body.id); })[0];
  // Anything already approved needs the PIN to unpick.
  if (record && record.status === 'approved') requirePin(body.pin);
  if (record && record.calEventId) deleteCalendarEvent(record.calEventId);

  sheet.deleteRow(row);
  return readAll();
}

function saveSettings(body) {
  requirePin(body.pin);
  var sheet = ss().getSheetByName(SHEETS.settings);
  var incoming = body.settings || {};
  var rows = readSheet(SHEETS.settings);

  Object.keys(incoming).forEach(function (key) {
    var found = -1;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].key).trim() === key) { found = i + 2; break; }
    }
    if (found === -1) sheet.appendRow([key, incoming[key]]);
    else sheet.getRange(found, 2).setValue(incoming[key]);
  });

  return readAll();
}

// ═══ WORKING DAYS & BANK HOLIDAYS ══════════════════════════════════════════

function bankHolidays() {
  var settings = readSettings();
  var region = settings.region || CONFIG.BANK_HOLIDAY_REGION;
  var cache = CacheService.getScriptCache();
  var key = 'bh-' + region;
  var hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var dates = [];
  try {
    var res = UrlFetchApp.fetch('https://www.gov.uk/bank-holidays.json', { muteHttpExceptions: true });
    var data = JSON.parse(res.getContentText());
    dates = (data[region] && data[region].events || []).map(function (ev) {
      return { date: ev.date, title: ev.title };
    });
    cache.put(key, JSON.stringify(dates), 21600); // 6 hours
  } catch (err) {
    dates = [];
  }
  return dates;
}

function bankHolidaySet() {
  var set = {};
  bankHolidays().forEach(function (b) { set[b.date] = true; });
  return set;
}

function workingDays(start, end, dayType) {
  var holidays = bankHolidaySet();
  var count = 0;
  var d = new Date(start + 'T12:00:00');
  var stop = new Date(end + 'T12:00:00');
  while (d <= stop) {
    var iso = Utilities.formatDate(d, 'Europe/London', 'yyyy-MM-dd');
    var dow = d.getDay();
    if (dow !== 0 && dow !== 6 && !holidays[iso]) count++;
    d.setDate(d.getDate() + 1);
  }
  if (dayType === 'am' || dayType === 'pm') return count > 0 ? 0.5 : 0;
  return count;
}

// ═══ GOOGLE CALENDAR SYNC ══════════════════════════════════════════════════

function calendar() {
  if (!CONFIG.CALENDAR_ID || CONFIG.CALENDAR_ID === 'primary') return CalendarApp.getDefaultCalendar();
  var cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  if (!cal) throw new Error('Cannot open calendar ' + CONFIG.CALENDAR_ID);
  return cal;
}

function safeSync() {
  try { syncCalendar(); } catch (err) { console.error('Calendar sync failed: ' + err); }
}

/**
 * Mirrors approved leave into the shared Google Calendar. Safe to run again —
 * it only touches events whose details have changed since the last run.
 * Also runs nightly if you set up the trigger via firstRunSetup().
 */
function syncCalendar() {
  ensureSheets();
  var cal = calendar();
  var sheet = ss().getSheetByName(SHEETS.leave);
  var idx = headerIndex(sheet, LEAVE_COLS);
  var employees = {};
  readSheet(SHEETS.employees).forEach(function (e) { employees[String(e.id)] = e; });

  readSheet(SHEETS.leave).forEach(function (lv) {
    var row = findRowById(sheet, lv.id);
    if (row < 2) return;
    var emp = employees[String(lv.employeeId)];
    if (!emp) return;

    var shouldExist = lv.status === 'approved';
    var hash = [lv.employeeId, lv.startDate, lv.endDate, lv.dayType, lv.type, lv.status, emp.name].join('|');

    if (!shouldExist) {
      if (lv.calEventId) {
        deleteCalendarEvent(lv.calEventId);
        sheet.getRange(row, idx.calEventId).setValue('');
        sheet.getRange(row, idx.syncHash).setValue(hash);
      }
      return;
    }

    if (lv.calEventId && String(lv.syncHash) === hash) return; // already in sync
    if (lv.calEventId) deleteCalendarEvent(lv.calEventId);

    var title = (CONFIG.EVENT_PREFIX || '') + leaveTitle(lv, emp);
    var options = { description: leaveDescription(lv, emp) };
    if (CONFIG.INVITE_EMPLOYEE && emp.email) {
      options.guests = emp.email;
      options.sendInvites = false;
    }

    var event;
    if (lv.dayType === 'full') {
      var endExclusive = new Date(lv.endDate + 'T12:00:00');
      endExclusive.setDate(endExclusive.getDate() + 1);
      event = cal.createAllDayEvent(title, new Date(lv.startDate + 'T12:00:00'), endExclusive, options);
    } else {
      var slot = lv.dayType === 'am' ? CONFIG.AM : CONFIG.PM;
      event = cal.createEvent(
        title,
        new Date(lv.startDate + 'T' + slot.start + ':00'),
        new Date(lv.startDate + 'T' + slot.end + ':00'),
        options
      );
    }

    try { event.setColor(CalendarApp.EventColor.PALE_BLUE); } catch (e) {}
    sheet.getRange(row, idx.calEventId).setValue(event.getId());
    sheet.getRange(row, idx.syncHash).setValue(hash);
  });
}

function leaveTitle(lv, emp) {
  var labels = {
    annual: 'Annual leave', unpaid: 'Unpaid leave', sick: 'Sick leave',
    toil: 'TOIL', parental: 'Parental leave', other: 'Leave'
  };
  var label = labels[lv.type] || 'Leave';
  var half = lv.dayType === 'am' ? ' (AM)' : lv.dayType === 'pm' ? ' (PM)' : '';
  return emp.name + ' — ' + label + half;
}

function leaveDescription(lv, emp) {
  var lines = [
    'Booked via the annual leave tracker.',
    'Employee: ' + emp.name + (emp.email ? ' <' + emp.email + '>' : ''),
    'Type: ' + lv.type,
    'Days: ' + lv.days
  ];
  if (lv.note) lines.push('Note: ' + lv.note);
  return lines.join('\n');
}

function deleteCalendarEvent(eventId) {
  try {
    var event = calendar().getEventById(eventId);
    if (event) event.deleteEvent();
  } catch (err) {
    console.warn('Could not delete event ' + eventId + ': ' + err);
  }
}

function notifyDecision(leaveId, status) {
  try {
    var lv = readSheet(SHEETS.leave).filter(function (r) { return String(r.id) === String(leaveId); })[0];
    if (!lv) return;
    var emp = readSheet(SHEETS.employees).filter(function (e) { return String(e.id) === String(lv.employeeId); })[0];
    if (!emp || !emp.email) return;

    var settings = readSettings();
    var when = lv.startDate === lv.endDate ? lv.startDate : lv.startDate + ' to ' + lv.endDate;
    var half = lv.dayType === 'am' ? ' (morning)' : lv.dayType === 'pm' ? ' (afternoon)' : '';

    MailApp.sendEmail({
      to: emp.email,
      subject: 'Leave ' + status + ': ' + when,
      body: [
        'Hi ' + (emp.name || '').split(' ')[0] + ',',
        '',
        'Your leave request for ' + when + half + ' has been ' + status + '.',
        status === 'approved' ? 'It is now on the shared calendar.' : '',
        '',
        '— ' + (settings.companyName || 'Leave tracker')
      ].join('\n')
    });
  } catch (err) {
    console.warn('Decision email failed: ' + err);
  }
}

// ═══ ICS FEED ══════════════════════════════════════════════════════════════

function serveIcs(p) {
  if (String(p.token || '') !== String(CONFIG.API_TOKEN)) {
    return ContentService.createTextOutput('Bad token').setMimeType(ContentService.MimeType.TEXT);
  }
  return ContentService.createTextOutput(buildIcs(p.employee || ''))
    .setMimeType(ContentService.MimeType.ICAL);
}

function buildIcs(employeeId) {
  var employees = {};
  readSheet(SHEETS.employees).forEach(function (e) { employees[String(e.id)] = e; });
  var settings = readSettings();

  var lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Annual Leave Tracker//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + (settings.companyName || 'Team') + ' annual leave',
    'X-WR-TIMEZONE:Europe/London',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H'
  ];

  readSheet(SHEETS.leave).forEach(function (lv) {
    if (lv.status !== 'approved') return;
    if (employeeId && String(lv.employeeId) !== String(employeeId)) return;
    var emp = employees[String(lv.employeeId)];
    if (!emp) return;

    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + lv.id + '@leave-tracker');
    lines.push('DTSTAMP:' + icsStamp(new Date()));
    lines.push('SUMMARY:' + icsEscape(leaveTitle(lv, emp)));
    lines.push('DESCRIPTION:' + icsEscape(leaveDescription(lv, emp)));

    if (lv.dayType === 'full') {
      var endExclusive = new Date(lv.endDate + 'T12:00:00');
      endExclusive.setDate(endExclusive.getDate() + 1);
      lines.push('DTSTART;VALUE=DATE:' + lv.startDate.replace(/-/g, ''));
      lines.push('DTEND;VALUE=DATE:' + Utilities.formatDate(endExclusive, 'Europe/London', 'yyyyMMdd'));
      lines.push('X-MICROSOFT-CDO-ALLDAYEVENT:TRUE');
    } else {
      var slot = lv.dayType === 'am' ? CONFIG.AM : CONFIG.PM;
      lines.push('DTSTART:' + icsStamp(new Date(lv.startDate + 'T' + slot.start + ':00')));
      lines.push('DTEND:' + icsStamp(new Date(lv.startDate + 'T' + slot.end + ':00')));
    }

    lines.push('TRANSP:TRANSPARENT');
    lines.push('STATUS:CONFIRMED');
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n');
}

function icsStamp(date) {
  return Utilities.formatDate(date, 'UTC', "yyyyMMdd'T'HHmmss'Z'");
}

function icsEscape(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function foldIcsLine(line) {
  if (line.length <= 74) return line;
  var out = line.slice(0, 74);
  var rest = line.slice(74);
  while (rest.length > 73) {
    out += '\r\n ' + rest.slice(0, 73);
    rest = rest.slice(73);
  }
  return out + (rest ? '\r\n ' + rest : '');
}

// ═══ ONE-TIME SETUP & SHEET MENU ═══════════════════════════════════════════

function firstRunSetup() {
  ensureSheets();

  // Nightly re-sync, so anything edited straight in the Sheet still reaches
  // the calendar even if nobody opens the web app.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncCalendar') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncCalendar').timeBased().everyHours(6).create();

  calendar();          // triggers the calendar permission prompt
  bankHolidays();      // triggers the external-fetch permission prompt

  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Sheets created and hourly calendar sync scheduled. Now: Deploy ▸ New deployment ▸ Web app.',
    'Leave tracker ready', 10
  );
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Leave tracker')
    .addItem('Run first-time setup', 'firstRunSetup')
    .addItem('Sync calendar now', 'syncCalendar')
    .addItem('Show web app + feed URLs', 'showUrls')
    .addToUi();
}

function showUrls() {
  var base = ScriptApp.getService().getUrl();
  var msg = base
    ? 'Web app URL (paste into config.js):\n' + base +
      '\n\nWhole-team calendar feed:\n' + base + '?action=ics&token=' + CONFIG.API_TOKEN
    : 'Not deployed yet — use Deploy ▸ New deployment ▸ Web app first.';
  SpreadsheetApp.getUi().alert('Leave tracker URLs', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}
