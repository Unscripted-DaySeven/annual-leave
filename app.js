/* ===========================================================================
   Annual Leave Tracker — front end
   Vanilla JS, no build step. Talks to the Apps Script web app in apps-script/.
   =========================================================================== */
(function () {
'use strict';

var CFG = window.LEAVE_CONFIG || {};
var DEDUCTING = { annual: true, toil: true };
var TYPE_LABEL = {
  annual: 'Annual leave', toil: 'TOIL', unpaid: 'Unpaid',
  sick: 'Sick', parental: 'Parental', other: 'Other'
};
var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
var MONTHS = ['January','February','March','April','May','June',
              'July','August','September','October','November','December'];
var MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

var state = {
  employees: [], leave: [], settings: {}, bankHolidays: [],
  demo: false, pin: '', view: 'dashboard',
  calMode: 'month', calCursor: new Date(), calYear: new Date().getFullYear(),
  teamFilter: '', loading: false
};

var $  = function (sel, root) { return (root || document).querySelector(sel); };
var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

// ═══ DATES ════════════════════════════════════════════════════════════════

function iso(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function pad(n) { return (n < 10 ? '0' : '') + n; }
function parseISO(s) {
  var p = String(s).split('-');
  return new Date(+p[0], +p[1] - 1, +p[2], 12, 0, 0);
}
function addDays(d, n) { var c = new Date(d.getTime()); c.setDate(c.getDate() + n); return c; }
function todayISO() { return iso(new Date()); }
function isWeekend(d) { var g = d.getDay(); return g === 0 || g === 6; }

function fmtDate(s) {
  var d = parseISO(s);
  return d.getDate() + ' ' + MONTHS_SHORT[d.getMonth()] + ' ' + d.getFullYear();
}
function fmtShort(s) {
  var d = parseISO(s);
  return d.getDate() + ' ' + MONTHS_SHORT[d.getMonth()];
}
function fmtRange(lv) {
  var half = lv.dayType === 'am' ? ' (AM)' : lv.dayType === 'pm' ? ' (PM)' : '';
  if (lv.startDate === lv.endDate) return fmtDate(lv.startDate) + half;
  return fmtShort(lv.startDate) + ' – ' + fmtDate(lv.endDate);
}

function bhMap() {
  var map = {};
  (state.bankHolidays || []).forEach(function (b) { map[b.date] = b.title; });
  return map;
}

function leaveYearRange() {
  var startStr = state.settings.leaveYearStart || '01-01';
  var parts = startStr.split('-');
  var mm = +parts[0] || 1, dd = +parts[1] || 1;
  var now = new Date();
  var year = now.getFullYear();
  var start = new Date(year, mm - 1, dd, 12);
  if (now < start) { year -= 1; start = new Date(year, mm - 1, dd, 12); }
  var end = new Date(start.getTime());
  end.setFullYear(end.getFullYear() + 1);
  end = addDays(end, -1);
  return { start: iso(start), end: iso(end) };
}

// ═══ LEAVE MATHS ══════════════════════════════════════════════════════════

/** Expand a leave record into working-day portions: [{date, portion}] */
function expandLeave(lv, holidays) {
  var out = [];
  if (!lv.startDate) return out;
  var d = parseISO(lv.startDate);
  var stop = parseISO(lv.endDate || lv.startDate);
  var half = lv.dayType === 'am' || lv.dayType === 'pm';
  while (d <= stop) {
    var key = iso(d);
    if (!isWeekend(d) && !holidays[key]) out.push({ date: key, portion: half ? 0.5 : 1 });
    d = addDays(d, 1);
    if (half) break;
  }
  return out;
}

/** dayIndex[date] = [{leave, employee, portion}] */
function buildDayIndex() {
  var holidays = bhMap();
  var byId = {};
  state.employees.forEach(function (e) { byId[String(e.id)] = e; });

  var index = {};
  state.leave.forEach(function (lv) {
    if (lv.status === 'rejected' || lv.status === 'cancelled') return;
    var emp = byId[String(lv.employeeId)];
    if (!emp) return;
    expandLeave(lv, holidays).forEach(function (part) {
      (index[part.date] = index[part.date] || []).push({
        leave: lv, employee: emp, portion: part.portion
      });
    });
  });
  return index;
}

function workingDaysBetween(start, end, dayType) {
  return expandLeave({ startDate: start, endDate: end, dayType: dayType }, bhMap())
    .reduce(function (sum, p) { return sum + p.portion; }, 0);
}

function employeeStats(emp) {
  var range = leaveYearRange();
  var holidays = bhMap();
  var today = todayISO();
  var used = 0, booked = 0, pending = 0, other = 0;

  state.leave.forEach(function (lv) {
    if (String(lv.employeeId) !== String(emp.id)) return;
    if (lv.status === 'rejected' || lv.status === 'cancelled') return;

    expandLeave(lv, holidays).forEach(function (part) {
      if (part.date < range.start || part.date > range.end) return;
      if (!DEDUCTING[lv.type]) { other += part.portion; return; }
      if (lv.status === 'pending') pending += part.portion;
      else if (part.date < today) used += part.portion;
      else booked += part.portion;
    });
  });

  var entitlement = num(emp.allowance, num(state.settings.defaultAllowance, 25)) + num(emp.carryOver, 0);
  return {
    entitlement: entitlement,
    used: used, booked: booked, pending: pending, other: other,
    taken: used + booked,
    remaining: Math.round((entitlement - used - booked) * 10) / 10
  };
}

function num(v, fallback) {
  var n = parseFloat(v);
  return isFinite(n) ? n : (fallback == null ? 0 : fallback);
}

function clashesOn(date, excludeLeaveId, team) {
  var index = buildDayIndex();
  return (index[date] || []).filter(function (entry) {
    if (excludeLeaveId && entry.leave.id === excludeLeaveId) return false;
    if (team && String(entry.employee.team || '') !== String(team)) return false;
    return true;
  });
}

function colourFor(id) {
  var s = String(id), h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return 'hsl(' + h + ' 46% 42%)';
}
function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2)
    .map(function (w) { return w[0]; }).join('').toUpperCase();
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function empById(id) {
  return state.employees.filter(function (e) { return String(e.id) === String(id); })[0];
}
function isActive(e) { return String(e.active) !== 'false'; }

// ═══ API ══════════════════════════════════════════════════════════════════

function connected() { return !!(CFG.apiUrl && CFG.token); }

function apiGet() {
  var url = CFG.apiUrl + (CFG.apiUrl.indexOf('?') === -1 ? '?' : '&') +
            'action=data&token=' + encodeURIComponent(CFG.token);
  return fetch(url, { method: 'GET', redirect: 'follow' })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (!res.ok) throw new Error(res.error || 'Request failed');
      return res.data;
    });
}

function apiPost(action, payload) {
  var body = Object.assign({ action: action, token: CFG.token, pin: state.pin }, payload || {});
  return fetch(CFG.apiUrl, {
    method: 'POST',
    redirect: 'follow',
    // text/plain keeps this a "simple" request, so the browser skips the
    // CORS preflight that Apps Script cannot answer.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (!res.ok) throw new Error(res.error || 'Request failed');
      return res.data;
    });
}

function absorb(data) {
  state.employees = data.employees || [];
  state.leave = data.leave || [];
  state.settings = data.settings || {};
  state.bankHolidays = data.bankHolidays && data.bankHolidays.length
    ? data.bankHolidays
    : state.bankHolidays;
  if (state.demo) saveDemo();
}

function load() {
  if (!connected()) return startDemo();
  setBanner('');
  state.loading = true;
  renderAll();
  return apiGet()
    .then(function (data) {
      absorb(data);
      state.loading = false;
      renderAll();
      // If the server could not reach gov.uk, fall back to the bundled copy.
      if (!state.bankHolidays.length) return loadLocalBankHolidays().then(renderAll);
    })
    .catch(function (err) {
      state.loading = false;
      setBanner('Could not reach the sheet — ' + err.message +
        '  <a href="#" data-goto="setup">Check setup</a>');
      renderAll();
    });
}

function act(action, payload, okMessage) {
  if (state.demo) return demoAct(action, payload, okMessage);
  return apiPost(action, payload)
    .then(function (data) { absorb(data); renderAll(); if (okMessage) toast(okMessage); })
    .catch(function (err) { toast(err.message, true); throw err; });
}

// ═══ DEMO MODE ════════════════════════════════════════════════════════════

var DEMO_KEY = 'leave-tracker-demo-v1';

function startDemo() {
  state.demo = true;
  setBanner('Demo mode — sample data stored in this browser only. ' +
            'Add your Apps Script URL in <em>config.js</em> to go live. ' +
            '<a href="#" data-goto="setup">Setup steps</a>');

  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(DEMO_KEY) || 'null'); } catch (e) {}

  if (saved && saved.employees) {
    state.employees = saved.employees;
    state.leave = saved.leave || [];
    state.settings = saved.settings || {};
  } else {
    seedDemo();
  }

  return loadLocalBankHolidays().then(renderAll);
}

function seedDemo() {
  var t = new Date();
  var mk = function (offset, len, dayType, type, status) {
    var s = addDays(t, offset);
    while (isWeekend(s)) s = addDays(s, 1);
    var e = addDays(s, len - 1);
    return { startDate: iso(s), endDate: iso(e), dayType: dayType, type: type, status: status };
  };

  state.employees = [
    { id: 'emp-1', name: 'Sylvester Crabtree', email: 'sylvester@example.com', team: 'Leadership', allowance: 28, carryOver: 2, active: 'true', manager: 'true' },
    { id: 'emp-2', name: 'Priya Raman',   email: 'priya@example.com',  team: 'Delivery', allowance: 25, carryOver: 0, active: 'true', manager: 'false' },
    { id: 'emp-3', name: 'Tom Fletcher',  email: 'tom@example.com',    team: 'Delivery', allowance: 25, carryOver: 1, active: 'true', manager: 'false' },
    { id: 'emp-4', name: 'Aisha Bello',   email: 'aisha@example.com',  team: 'Studio',   allowance: 25, carryOver: 0, active: 'true', manager: 'false' },
    { id: 'emp-5', name: 'Dan Okafor',    email: 'dan@example.com',    team: 'Studio',   allowance: 25, carryOver: 0, active: 'true', manager: 'false' }
  ];

  var plans = [
    ['emp-2', mk(3, 5, 'full', 'annual', 'approved')],
    ['emp-3', mk(4, 3, 'full', 'annual', 'pending')],
    ['emp-4', mk(1, 1, 'am',   'annual', 'approved')],
    ['emp-1', mk(14, 10, 'full', 'annual', 'approved')],
    ['emp-5', mk(-12, 2, 'full', 'annual', 'approved')],
    ['emp-2', mk(-30, 1, 'pm', 'annual', 'approved')],
    ['emp-3', mk(45, 5, 'full', 'annual', 'pending')],
    ['emp-5', mk(-4, 1, 'full', 'sick', 'approved')]
  ];

  state.leave = plans.map(function (p, i) {
    var lv = p[1];
    lv.id = 'lv-demo-' + (i + 1);
    lv.employeeId = p[0];
    lv.note = '';
    lv.days = workingDaysBetween(lv.startDate, lv.endDate, lv.dayType);
    lv.createdAt = new Date().toISOString();
    return lv;
  });

  state.settings = {
    companyName: CFG.companyName || 'Day Seven',
    region: 'england-and-wales',
    leaveYearStart: '01-01',
    defaultAllowance: '25',
    maxOffPerDay: '2',
    approvalRequired: 'true'
  };
  saveDemo();
}

function saveDemo() {
  if (!state.demo) return;
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify({
      employees: state.employees, leave: state.leave, settings: state.settings
    }));
  } catch (e) { /* private browsing — stay in memory */ }
}

function loadLocalBankHolidays() {
  var region = state.settings.region || 'england-and-wales';
  return fetch('https://www.gov.uk/bank-holidays.json')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      state.bankHolidays = (data[region] && data[region].events) || [];
    })
    .catch(function () {
      return fetch('bank-holidays.json')
        .then(function (r) { return r.json(); })
        .then(function (data) { state.bankHolidays = (data[region] && data[region].events) || []; })
        .catch(function () { state.bankHolidays = []; });
    });
}

function demoAct(action, payload, okMessage) {
  return new Promise(function (resolve, reject) {
    try {
      if (action === 'saveEmployee') {
        var emp = payload.employee;
        if (!emp.id) { emp.id = 'emp-' + Date.now().toString(36); state.employees.push(emp); }
        else {
          state.employees = state.employees.map(function (e) {
            return String(e.id) === String(emp.id) ? Object.assign({}, e, emp) : e;
          });
        }
      } else if (action === 'removeEmployee') {
        state.employees = state.employees.filter(function (e) { return String(e.id) !== String(payload.id); });
        state.leave = state.leave.filter(function (l) { return String(l.employeeId) !== String(payload.id); });
      } else if (action === 'saveLeave') {
        var lv = payload.leave;
        if (lv.dayType !== 'full') lv.endDate = lv.startDate;
        lv.endDate = lv.endDate || lv.startDate;
        lv.days = workingDaysBetween(lv.startDate, lv.endDate, lv.dayType);
        if (lv.days <= 0) throw new Error('That range is all weekend / bank holiday');
        if (!lv.id) {
          lv.id = 'lv-' + Date.now().toString(36);
          lv.status = String(state.settings.approvalRequired) === 'false' ? 'approved' : 'pending';
          lv.createdAt = new Date().toISOString();
          state.leave.push(lv);
        } else {
          state.leave = state.leave.map(function (l) {
            return String(l.id) === String(lv.id) ? Object.assign({}, l, lv) : l;
          });
        }
      } else if (action === 'decideLeave') {
        state.leave = state.leave.map(function (l) {
          if (String(l.id) !== String(payload.id)) return l;
          return Object.assign({}, l, {
            status: payload.status, decidedBy: payload.by || 'Manager',
            decidedAt: new Date().toISOString()
          });
        });
      } else if (action === 'cancelLeave') {
        state.leave = state.leave.filter(function (l) { return String(l.id) !== String(payload.id); });
      } else if (action === 'saveSettings') {
        state.settings = Object.assign({}, state.settings, payload.settings);
      }
      saveDemo();
      renderAll();
      if (okMessage) toast(okMessage + ' (demo)');
      resolve();
    } catch (err) {
      toast(err.message, true);
      reject(err);
    }
  });
}

// ═══ CHROME ═══════════════════════════════════════════════════════════════

function setBanner(html) {
  var el = $('#banner');
  el.innerHTML = html;
  el.hidden = !html;
}

var toastTimer;
function toast(message, bad) {
  var el = $('#toast');
  el.textContent = message;
  el.className = 'toast' + (bad ? ' bad' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.hidden = true; }, bad ? 5200 : 2800);
}

function switchView(name) {
  state.view = name;
  $$('.tab').forEach(function (t) { t.classList.toggle('is-active', t.dataset.view === name); });
  $$('.view').forEach(function (v) { v.classList.toggle('is-active', v.dataset.view === name); });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function ensurePin() {
  if (state.pin) return true;
  var entered = window.prompt('Manager PIN');
  if (entered == null || entered === '') return false;
  state.pin = entered;
  $('#manager-btn').classList.add('is-on');
  $('#manager-btn').textContent = 'Manager mode: on';
  return true;
}

function managerMode() { return !!state.pin; }

// ═══ RENDER ═══════════════════════════════════════════════════════════════

function renderAll() {
  $('#company-name').textContent = state.settings.companyName || CFG.companyName || 'Annual Leave';
  var range = leaveYearRange();
  $('#leave-year-label').textContent = 'Leave year ' + fmtShort(range.start) + ' – ' + fmtDate(range.end);

  renderStats();
  renderStrip();
  renderAllowances();
  renderUpcoming();
  renderBookOptions();
  renderBookSummary();
  renderCalendar();
  renderTeam();
  renderApprovals();
  renderSetup();
}

/* ── Dashboard ──────────────────────────────────────────────────────────── */

function renderStats() {
  var index = buildDayIndex();
  var today = todayISO();
  var offToday = (index[today] || []).filter(function (e) { return e.leave.status === 'approved'; });

  var weekEnd = iso(addDays(new Date(), 7));
  var weekPeople = {};
  Object.keys(index).forEach(function (d) {
    if (d >= today && d <= weekEnd) {
      index[d].forEach(function (e) {
        if (e.leave.status === 'approved') weekPeople[e.employee.id] = true;
      });
    }
  });

  var pending = state.leave.filter(function (l) { return l.status === 'pending'; });
  var totalBooked = state.employees.reduce(function (sum, e) {
    return sum + employeeStats(e).taken;
  }, 0);
  var totalEntitle = state.employees.filter(isActive).reduce(function (sum, e) {
    return sum + employeeStats(e).entitlement;
  }, 0);

  var pct = totalEntitle ? Math.round((totalBooked / totalEntitle) * 100) : 0;

  $('#stats').innerHTML = [
    stat(offToday.length, 'Off today', offToday.map(function (e) { return e.employee.name.split(' ')[0]; }).join(', ') || 'Full team in'),
    stat(Object.keys(weekPeople).length, 'Off in the next 7 days', ''),
    stat(pending.length, 'Awaiting approval', pending.length ? 'Needs a decision' : 'Nothing outstanding', pending.length > 0),
    stat(pct + '%', 'Team allowance used', round(totalBooked) + ' of ' + round(totalEntitle) + ' days')
  ].join('');

  var count = pending.length;
  $('#pending-count').hidden = count === 0;
  $('#pending-count').textContent = count;
}

function stat(value, label, sub, warn) {
  return '<div class="stat' + (warn ? ' is-warn' : '') + '">' +
    '<div class="stat-value">' + esc(value) + '</div>' +
    '<div class="stat-label">' + esc(label) + '</div>' +
    (sub ? '<div class="stat-sub">' + esc(sub) + '</div>' : '') +
    '</div>';
}

function round(n) { return Math.round(n * 10) / 10; }

function renderStrip() {
  var index = buildDayIndex();
  var holidays = bhMap();
  var today = todayISO();
  var html = '';

  for (var i = 0; i < 14; i++) {
    var d = addDays(new Date(), i);
    var key = iso(d);
    var entries = (index[key] || []);
    var classes = ['strip-day'];
    if (isWeekend(d)) classes.push('is-weekend');
    if (holidays[key]) classes.push('is-bh');
    if (key === today) classes.push('is-today');

    var names = entries.map(function (e) {
      return '<span class="who-chip' + (e.leave.status === 'pending' ? ' is-pending' : '') +
        (e.portion === 0.5 ? ' is-half' : '') + '" title="' +
        esc(e.employee.name + ' — ' + TYPE_LABEL[e.leave.type] + ' (' + e.leave.status + ')') + '">' +
        esc(e.employee.name.split(' ')[0]) + '</span>';
    }).join('');

    html += '<div class="' + classes.join(' ') + '">' +
      '<div class="strip-dow">' + DOW[(d.getDay() + 6) % 7] + '</div>' +
      '<div class="strip-num">' + d.getDate() + '</div>' +
      '<div class="strip-names">' +
        (names || (holidays[key] ? '<span class="strip-empty">' + esc(holidays[key]) + '</span>'
                                 : '<span class="strip-empty">—</span>')) +
      '</div></div>';
  }

  $('#today-strip').innerHTML = html;
  $('#strip-range').textContent = 'next 14 days';
}

function renderAllowances() {
  var rows = state.employees.filter(isActive).map(function (emp) {
    var s = employeeStats(emp);
    var pctUsed = s.entitlement ? (s.used / s.entitlement) * 100 : 0;
    var pctBooked = s.entitlement ? (s.booked / s.entitlement) * 100 : 0;
    var pctPending = s.entitlement ? (s.pending / s.entitlement) * 100 : 0;

    return '<div class="allowance-row">' +
      '<div class="allowance-name">' + avatar(emp) + esc(emp.name) + '</div>' +
      '<div class="allowance-num">' + round(s.remaining) + ' left of ' + round(s.entitlement) + '</div>' +
      '<div class="bar">' +
        '<div class="bar-used" style="width:' + pctUsed.toFixed(1) + '%"></div>' +
        '<div class="bar-booked" style="width:' + pctBooked.toFixed(1) + '%"></div>' +
        '<div class="bar-pending" style="width:' + pctPending.toFixed(1) + '%"></div>' +
      '</div></div>';
  });

  $('#allowance-list').innerHTML = rows.length ? rows.join('') :
    '<div class="empty">No employees yet — add your team on the Team tab.</div>';
}

function avatar(emp) {
  return '<span class="avatar" style="background:' + colourFor(emp.id) + '">' +
    esc(initials(emp.name)) + '</span>';
}

function renderUpcoming() {
  var days = +$('#upcoming-window').value || 60;
  var today = todayISO();
  var limit = iso(addDays(new Date(), days));

  var rows = state.leave
    .filter(function (l) {
      return l.status !== 'rejected' && l.status !== 'cancelled' &&
             (l.endDate || l.startDate) >= today && l.startDate <= limit;
    })
    .sort(function (a, b) { return a.startDate < b.startDate ? -1 : 1; })
    .map(function (lv) {
      var emp = empById(lv.employeeId);
      if (!emp) return '';
      return '<tr>' +
        '<td>' + avatar(emp) + esc(emp.name) + '</td>' +
        '<td>' + esc(fmtRange(lv)) + '</td>' +
        '<td>' + esc(TYPE_LABEL[lv.type] || lv.type) + '</td>' +
        '<td class="num">' + esc(lv.days) + '</td>' +
        '<td>' + statusTag(lv.status) + '</td>' +
        '<td class="actions"><button class="btn btn-sm btn-danger" data-cancel="' + esc(lv.id) + '">Cancel</button></td>' +
        '</tr>';
    }).filter(Boolean);

  $('#upcoming-table').innerHTML =
    '<thead><tr><th>Employee</th><th>Dates</th><th>Type</th><th class="num">Days</th><th>Status</th><th></th></tr></thead>' +
    '<tbody>' + (rows.join('') || '<tr><td colspan="6" class="empty">Nothing booked in this window.</td></tr>') + '</tbody>';
}

function statusTag(status) {
  var cls = status === 'approved' ? 'tag-approved' : status === 'pending' ? 'tag-pending' : 'tag-rejected';
  return '<span class="tag ' + cls + '">' + esc(status) + '</span>';
}

/* ── Book leave ─────────────────────────────────────────────────────────── */

function renderBookOptions() {
  var select = $('#b-employee');
  var current = select.value;
  select.innerHTML = '<option value="">Choose…</option>' +
    state.employees.filter(isActive).map(function (e) {
      return '<option value="' + esc(e.id) + '">' + esc(e.name) + (e.team ? ' · ' + esc(e.team) : '') + '</option>';
    }).join('');
  if (current) select.value = current;

  var teams = {};
  state.employees.forEach(function (e) { if (e.team) teams[e.team] = true; });
  var teamSelect = $('#cal-team');
  var currentTeam = teamSelect.value;
  teamSelect.innerHTML = '<option value="">All teams</option>' +
    Object.keys(teams).sort().map(function (t) {
      return '<option value="' + esc(t) + '">' + esc(t) + '</option>';
    }).join('');
  teamSelect.value = currentTeam;
}

function renderBookSummary() {
  var empId = $('#b-employee').value;
  var start = $('#b-start').value;
  var end = $('#b-end').value || start;
  var dayType = $('#b-daytype').value;
  var halfDay = dayType !== 'full';

  $('#b-end-field').style.display = halfDay ? 'none' : '';

  var summary = $('#book-summary');
  var clash = $('#book-clash');
  clash.innerHTML = '';

  if (!empId || !start) {
    summary.innerHTML = 'Pick an employee and a date to see how many days it costs.';
    return;
  }
  if (!halfDay && end && end < start) {
    summary.innerHTML = '<strong>Last day is before the first day.</strong>';
    return;
  }

  var days = workingDaysBetween(start, halfDay ? start : end, dayType);
  var emp = empById(empId);
  var s = employeeStats(emp);
  var deducts = DEDUCTING[$('#b-type').value];
  var after = deducts ? round(s.remaining - days) : round(s.remaining);

  summary.innerHTML =
    '<strong>' + days + (days === 1 ? ' working day' : ' working days') + '</strong>' +
    (halfDay ? ' — ' + (dayType === 'am' ? 'morning ' + (CFG.amHours || '') : 'afternoon ' + (CFG.pmHours || '')) : '') +
    '. Weekends and bank holidays are skipped automatically.<br>' +
    esc(emp.name) + ' has <strong>' + round(s.remaining) + '</strong> days left' +
    (deducts ? ', <strong>' + after + '</strong> after this booking.' : '. This type does not use the allowance.');

  var notices = [];
  if (deducts && after < 0) {
    notices.push('<div class="notice notice-bad">This takes ' + esc(emp.name.split(' ')[0]) +
      ' <strong>' + Math.abs(after) + '</strong> days over their allowance.</div>');
  }

  // Clash check across the requested range.
  var threshold = num(state.settings.maxOffPerDay, 2);
  var holidays = bhMap();
  var parts = expandLeave({ startDate: start, endDate: halfDay ? start : end, dayType: dayType }, holidays);
  var index = buildDayIndex();
  var clashDays = [];

  parts.forEach(function (part) {
    var others = (index[part.date] || []).filter(function (entry) {
      return String(entry.employee.id) !== String(empId) &&
             (!emp.team || String(entry.employee.team || '') === String(emp.team || ''));
    });
    if (others.length + 1 >= threshold) {
      clashDays.push({ date: part.date, who: others.map(function (o) { return o.employee.name.split(' ')[0]; }) });
    }
  });

  if (clashDays.length) {
    var first = clashDays.slice(0, 3).map(function (c) {
      return fmtShort(c.date) + (c.who.length ? ' (' + c.who.join(', ') + ')' : '');
    }).join(', ');
    notices.push('<div class="notice"><strong>Cover check:</strong> ' +
      (emp.team ? esc(emp.team) + ' has ' : '') + 'other people off on ' + esc(first) +
      (clashDays.length > 3 ? ' and ' + (clashDays.length - 3) + ' more day(s)' : '') +
      '. You can still book it.</div>');
  }

  clash.innerHTML = notices.join('');
  renderEmployeeLeave(empId);
}

function renderEmployeeLeave(empId) {
  var box = $('#employee-leave');
  if (!empId) { box.innerHTML = '<div class="empty">Choose an employee to see their bookings.</div>'; return; }

  var today = todayISO();
  var rows = state.leave
    .filter(function (l) { return String(l.employeeId) === String(empId) && l.status !== 'rejected'; })
    .sort(function (a, b) { return a.startDate < b.startDate ? 1 : -1; })
    .map(function (lv) {
      var past = (lv.endDate || lv.startDate) < today;
      return '<div class="mini-row"' + (past ? ' style="opacity:.6"' : '') + '>' +
        '<div><div class="when">' + esc(fmtRange(lv)) + '</div>' +
        '<div class="muted">' + esc(TYPE_LABEL[lv.type] || lv.type) + ' · ' + esc(lv.days) + 'd' +
        (lv.note ? ' · ' + esc(lv.note) : '') + '</div></div>' +
        '<div>' + statusTag(lv.status) +
        (past ? '' : ' <button class="btn btn-sm btn-danger" data-cancel="' + esc(lv.id) + '">Cancel</button>') +
        '</div></div>';
    });

  box.innerHTML = rows.join('') || '<div class="empty">No leave booked yet.</div>';
}

/* ── Calendar ───────────────────────────────────────────────────────────── */

function renderCalendar() {
  $('#cal-month-btn').classList.toggle('is-on', state.calMode === 'month');
  $('#cal-year-btn').classList.toggle('is-on', state.calMode === 'year');
  $('#cal-month').hidden = state.calMode !== 'month';
  $('#cal-year').hidden = state.calMode !== 'year';

  if (state.calMode === 'month') renderMonth();
  else renderYear();

  $('#cal-legend').innerHTML = [
    legendItem('var(--accent)', 'Approved'),
    legendItem('var(--pending)', 'Pending'),
    legendItem('var(--bankhol)', 'Bank holiday'),
    legendItem('var(--weekend)', 'Weekend')
  ].join('');
}

function legendItem(colour, label) {
  return '<span class="legend-item"><span class="legend-swatch" style="background:' + colour +
    ';border:1px solid var(--line)"></span>' + esc(label) + '</span>';
}

function teamFiltered(entries) {
  if (!state.teamFilter) return entries;
  return entries.filter(function (e) { return String(e.employee.team || '') === state.teamFilter; });
}

function renderMonth() {
  var cursor = state.calCursor;
  var year = cursor.getFullYear(), month = cursor.getMonth();
  $('#cal-label').textContent = MONTHS[month] + ' ' + year;

  var index = buildDayIndex();
  var holidays = bhMap();
  var today = todayISO();

  var first = new Date(year, month, 1, 12);
  var offset = (first.getDay() + 6) % 7;              // Monday-first
  var gridStart = addDays(first, -offset);

  var html = DOW.map(function (d) { return '<div class="month-dow">' + d + '</div>'; }).join('');

  for (var i = 0; i < 42; i++) {
    var d = addDays(gridStart, i);
    var key = iso(d);
    var classes = ['day'];
    if (d.getMonth() !== month) classes.push('is-out');
    if (isWeekend(d)) classes.push('is-weekend');
    if (holidays[key]) classes.push('is-bh');
    if (key === today) classes.push('is-today');

    var entries = teamFiltered(index[key] || []);
    var shown = entries.slice(0, 4).map(function (e) {
      return '<span class="who-chip' + (e.leave.status === 'pending' ? ' is-pending' : '') +
        (e.portion === 0.5 ? ' is-half' : '') +
        '" style="border-left-color:' + colourFor(e.employee.id) + '" title="' +
        esc(e.employee.name + ' — ' + (TYPE_LABEL[e.leave.type] || e.leave.type) + ' (' + e.leave.status + ')') +
        '">' + esc(e.employee.name.split(' ')[0]) + '</span>';
    }).join('');

    html += '<div class="' + classes.join(' ') + '">' +
      '<div class="day-num">' + d.getDate() + '</div>' +
      (holidays[key] ? '<span class="day-bh">' + esc(holidays[key]) + '</span>' : '') +
      '<div class="day-chips">' + shown +
      (entries.length > 4 ? '<span class="day-more">+' + (entries.length - 4) + ' more</span>' : '') +
      '</div></div>';
  }

  $('#cal-month').innerHTML = html;
}

function renderYear() {
  var year = state.calYear;
  $('#cal-label').textContent = String(year);

  var index = buildDayIndex();
  var holidays = bhMap();
  var today = todayISO();
  var people = state.employees.filter(isActive).filter(function (e) {
    return !state.teamFilter || String(e.team || '') === state.teamFilter;
  });

  if (!people.length) {
    $('#cal-year').innerHTML = '<div class="empty">No employees to chart yet.</div>';
    return;
  }

  var totalDays = ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) ? 366 : 365;
  var cols = '<colgroup><col style="width:190px">' +
             new Array(totalDays + 1).join('<col style="width:9px">') + '</colgroup>';

  var monthHead = '<tr><th class="name-cell"></th>';
  for (var m = 0; m < 12; m++) {
    var dim = new Date(year, m + 1, 0).getDate();
    monthHead += '<th class="month-head' + (m % 2 ? ' alt' : '') + '" colspan="' + dim + '">' +
                 MONTHS_SHORT[m] + '</th>';
  }
  monthHead += '</tr>';

  var body = people.map(function (emp) {
    var row = '<tr><td class="name-cell">' + avatar(emp) + esc(emp.name) + '</td>';
    for (var mm = 0; mm < 12; mm++) {
      var daysInMonth = new Date(year, mm + 1, 0).getDate();
      for (var dd = 1; dd <= daysInMonth; dd++) {
        var d = new Date(year, mm, dd, 12);
        var key = iso(d);
        var cls = ['cell'];
        if (dd === 1) cls.push('ms');
        if (isWeekend(d)) cls.push('wk');
        if (holidays[key]) cls.push('bh');

        var hit = (index[key] || []).filter(function (e) {
          return String(e.employee.id) === String(emp.id);
        })[0];

        var title = emp.name + ' · ' + fmtDate(key);
        if (hit) {
          if (hit.leave.status === 'pending') cls.push('pend');
          else cls.push(hit.portion === 0.5 ? 'half' : 'on');
          title += ' — ' + (TYPE_LABEL[hit.leave.type] || hit.leave.type) +
                   (hit.portion === 0.5 ? ' (half day)' : '') + ' · ' + hit.leave.status;
        } else if (holidays[key]) {
          title += ' — ' + holidays[key];
        }
        if (key === today) cls.push('is-today');
        row += '<td class="' + cls.join(' ') + '" title="' + esc(title) + '"></td>';
      }
    }
    return row + '</tr>';
  }).join('');

  var wrap = $('#cal-year');
  wrap.innerHTML =
    '<table class="year" style="width:' + (190 + totalDays * 9) + 'px">' +
    cols + '<thead>' + monthHead + '</thead><tbody>' + body + '</tbody></table>';

  // Open on the current month rather than 1 January.
  var now = new Date();
  if (now.getFullYear() === year) {
    var dayOfYear = Math.round((new Date(year, now.getMonth(), 1, 12) - new Date(year, 0, 1, 12)) / 86400000);
    wrap.scrollLeft = Math.max(0, dayOfYear * 9 - 40);
  } else {
    wrap.scrollLeft = 0;
  }
}

/* ── Team ───────────────────────────────────────────────────────────────── */

function renderTeam() {
  var rows = state.employees.map(function (emp) {
    var s = employeeStats(emp);
    return '<tr' + (isActive(emp) ? '' : ' style="opacity:.5"') + '>' +
      '<td>' + avatar(emp) + esc(emp.name) + (String(emp.manager) === 'true' ? ' <span class="tag">manager</span>' : '') + '</td>' +
      '<td class="muted">' + esc(emp.email || '—') + '</td>' +
      '<td>' + esc(emp.team || '—') + '</td>' +
      '<td class="num">' + round(s.entitlement) + '</td>' +
      '<td class="num">' + round(s.used) + '</td>' +
      '<td class="num">' + round(s.booked) + '</td>' +
      '<td class="num">' + (s.pending ? '<span class="tag tag-pending">' + round(s.pending) + '</span>' : '—') + '</td>' +
      '<td class="num"><strong>' + round(s.remaining) + '</strong></td>' +
      '<td class="actions">' +
        '<button class="btn btn-sm" data-edit="' + esc(emp.id) + '">Edit</button> ' +
        '<button class="btn btn-sm btn-danger" data-remove="' + esc(emp.id) + '">Remove</button>' +
      '</td></tr>';
  });

  $('#team-table').innerHTML =
    '<thead><tr><th>Name</th><th>Email</th><th>Team</th>' +
    '<th class="num">Allowance</th><th class="num">Used</th><th class="num">Booked</th>' +
    '<th class="num">Pending</th><th class="num">Left</th><th></th></tr></thead>' +
    '<tbody>' + (rows.join('') || '<tr><td colspan="9" class="empty">No employees yet.</td></tr>') + '</tbody>';
}

function employeeModal(emp) {
  emp = emp || {};
  $('#modal-title').textContent = emp.id ? 'Edit employee' : 'Add employee';
  $('#modal-body').innerHTML =
    '<form class="form" id="emp-form">' +
      '<label class="field"><span>Full name</span><input id="e-name" required value="' + esc(emp.name || '') + '"></label>' +
      '<label class="field"><span>Work email <span class="muted">(gets the calendar invite)</span></span>' +
        '<input id="e-email" type="email" value="' + esc(emp.email || '') + '"></label>' +
      '<div class="field-row">' +
        '<label class="field"><span>Team</span><input id="e-team" value="' + esc(emp.team || '') + '"></label>' +
        '<label class="field"><span>Allowance (days)</span><input id="e-allowance" type="number" step="0.5" min="0" value="' +
          esc(emp.allowance != null && emp.allowance !== '' ? emp.allowance : (state.settings.defaultAllowance || 25)) + '"></label>' +
      '</div>' +
      '<div class="field-row">' +
        '<label class="field"><span>Carried over</span><input id="e-carry" type="number" step="0.5" min="0" value="' +
          esc(emp.carryOver || 0) + '"></label>' +
        '<label class="field"><span>Status</span><select id="e-active">' +
          '<option value="true"' + (String(emp.active) !== 'false' ? ' selected' : '') + '>Active</option>' +
          '<option value="false"' + (String(emp.active) === 'false' ? ' selected' : '') + '>Left / inactive</option>' +
        '</select></label>' +
      '</div>' +
      '<label class="field"><span>Can approve leave</span><select id="e-manager">' +
        '<option value="false"' + (String(emp.manager) !== 'true' ? ' selected' : '') + '>No</option>' +
        '<option value="true"' + (String(emp.manager) === 'true' ? ' selected' : '') + '>Yes</option>' +
      '</select></label>' +
      '<div class="form-actions"><button class="btn btn-primary" type="submit">Save</button>' +
      '<button class="btn" type="button" id="emp-cancel">Cancel</button></div>' +
    '</form>';

  $('#modal').hidden = false;
  $('#e-name').focus();

  $('#emp-cancel').onclick = closeModal;
  $('#emp-form').onsubmit = function (ev) {
    ev.preventDefault();
    if (!ensurePin()) return;
    act('saveEmployee', {
      employee: {
        id: emp.id || '',
        name: $('#e-name').value.trim(),
        email: $('#e-email').value.trim(),
        team: $('#e-team').value.trim(),
        allowance: $('#e-allowance').value,
        carryOver: $('#e-carry').value,
        active: $('#e-active').value,
        manager: $('#e-manager').value
      }
    }, 'Saved').then(closeModal).catch(function () {});
  };
}

function closeModal() { $('#modal').hidden = true; $('#modal-body').innerHTML = ''; }

/* ── Approvals ──────────────────────────────────────────────────────────── */

function renderApprovals() {
  var pending = state.leave.filter(function (l) { return l.status === 'pending'; })
    .sort(function (a, b) { return a.startDate < b.startDate ? -1 : 1; });

  $('#approvals-hint').textContent = managerMode()
    ? 'Manager mode is on'
    : 'Turn on manager mode to approve or reject';

  $('#approvals-list').innerHTML = pending.length ? pending.map(function (lv) {
    var emp = empById(lv.employeeId);
    if (!emp) return '';
    var others = clashesOn(lv.startDate, lv.id, emp.team).map(function (o) { return o.employee.name.split(' ')[0]; });
    var s = employeeStats(emp);
    return '<div class="approval">' +
      '<div class="approval-main">' +
        '<div class="approval-when">' + avatar(emp) + esc(emp.name) + ' · ' + esc(fmtRange(lv)) + '</div>' +
        '<div class="approval-meta">' + esc(TYPE_LABEL[lv.type] || lv.type) + ' · ' + esc(lv.days) +
          ' day(s) · ' + round(s.remaining) + ' left after pending' +
          (lv.note ? ' · “' + esc(lv.note) + '”' : '') + '</div>' +
        (others.length ? '<div class="approval-meta" style="color:var(--pending)">Also off that day: ' +
          esc(others.join(', ')) + '</div>' : '') +
      '</div>' +
      '<div class="approval-actions">' +
        '<button class="btn btn-primary btn-sm" data-approve="' + esc(lv.id) + '">Approve</button>' +
        '<button class="btn btn-danger btn-sm" data-reject="' + esc(lv.id) + '">Reject</button>' +
      '</div></div>';
  }).join('') : '<div class="empty">Nothing waiting. 🎉</div>';

  var decided = state.leave
    .filter(function (l) { return l.decidedAt; })
    .sort(function (a, b) { return a.decidedAt < b.decidedAt ? 1 : -1; })
    .slice(0, 12)
    .map(function (lv) {
      var emp = empById(lv.employeeId);
      return '<tr><td>' + (emp ? esc(emp.name) : '—') + '</td><td>' + esc(fmtRange(lv)) + '</td>' +
        '<td>' + statusTag(lv.status) + '</td><td class="muted">' + esc(lv.decidedBy || '') + '</td>' +
        '<td class="muted">' + esc((lv.decidedAt || '').slice(0, 10)) + '</td></tr>';
    });

  $('#decided-table').innerHTML =
    '<thead><tr><th>Employee</th><th>Dates</th><th>Outcome</th><th>By</th><th>When</th></tr></thead>' +
    '<tbody>' + (decided.join('') || '<tr><td colspan="5" class="empty">No decisions recorded yet.</td></tr>') + '</tbody>';
}

/* ── Setup ──────────────────────────────────────────────────────────────── */

function renderSetup() {
  var ok = connected() && !state.demo;
  $('#conn-status').innerHTML =
    '<div class="conn-row"><span class="dot ' + (ok ? 'ok' : 'bad') + '"></span>' +
      (ok ? 'Connected to your Google Sheet.' : 'Not connected — running on demo data.') + '</div>' +
    '<div class="conn-row muted">Web app URL: ' + (CFG.apiUrl ? esc(CFG.apiUrl) : 'not set in config.js') + '</div>' +
    '<div class="conn-row muted">Token: ' + (CFG.token ? '••••••' + esc(String(CFG.token).slice(-4)) : 'not set') + '</div>' +
    (ok ? '' : '<p class="muted small">Open <em>config.js</em> in your repo, paste the ' +
      '<em>/exec</em> URL from Apps Script into <em>apiUrl</em> and the same token you set in ' +
      '<em>Code.gs</em> into <em>token</em>, then commit. Full steps are in README.md.</p>');

  var feeds = $('#feeds');
  if (!ok) {
    feeds.innerHTML = '<div class="empty">Connect the sheet to get your calendar feed URLs.</div>';
  } else {
    var base = CFG.apiUrl + (CFG.apiUrl.indexOf('?') === -1 ? '?' : '&') +
               'action=ics&token=' + encodeURIComponent(CFG.token);
    var rows = [feedRow('Whole team', base)];
    state.employees.filter(isActive).forEach(function (e) {
      rows.push(feedRow(e.name, base + '&employee=' + encodeURIComponent(e.id)));
    });
    feeds.innerHTML = rows.join('');
  }

  $('#s-company').value = state.settings.companyName || '';
  $('#s-region').value = state.settings.region || 'england-and-wales';
  $('#s-year-start').value = state.settings.leaveYearStart || '01-01';
  $('#s-allowance').value = state.settings.defaultAllowance || 25;
  $('#s-max-off').value = state.settings.maxOffPerDay || 2;
  $('#s-approval').value = String(state.settings.approvalRequired) === 'false' ? 'false' : 'true';
}

function feedRow(name, url) {
  return '<div class="feed-row"><span class="who">' + esc(name) + '</span>' +
    '<span class="feed-url">' + esc(url) + '</span>' +
    '<button class="btn btn-sm" data-copy="' + esc(url) + '">Copy</button></div>';
}

// ═══ EVENTS ═══════════════════════════════════════════════════════════════

function wire() {
  $('#tabs').addEventListener('click', function (ev) {
    var tab = ev.target.closest('.tab');
    if (tab) switchView(tab.dataset.view);
  });

  $('#banner').addEventListener('click', function (ev) {
    var link = ev.target.closest('[data-goto]');
    if (link) { ev.preventDefault(); switchView(link.dataset.goto); }
  });

  $('#refresh-btn').addEventListener('click', function () {
    if (state.demo) { loadLocalBankHolidays().then(renderAll); toast('Demo data reloaded'); }
    else load().then(function () { toast('Up to date'); });
  });

  $('#manager-btn').addEventListener('click', function () {
    if (managerMode()) {
      state.pin = '';
      this.classList.remove('is-on');
      this.textContent = 'Manager mode';
      toast('Manager mode off');
    } else if (ensurePin()) {
      toast('Manager mode on');
    }
    renderApprovals();
  });

  $('#upcoming-window').addEventListener('change', renderUpcoming);

  ['#b-employee', '#b-start', '#b-end', '#b-daytype', '#b-type'].forEach(function (sel) {
    $(sel).addEventListener('change', renderBookSummary);
    $(sel).addEventListener('input', renderBookSummary);
  });

  $('#b-start').addEventListener('change', function () {
    var end = $('#b-end');
    if (!end.value || end.value < this.value) end.value = this.value;
    renderBookSummary();
  });

  $('#book-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var dayType = $('#b-daytype').value;
    var start = $('#b-start').value;
    var payload = {
      leave: {
        employeeId: $('#b-employee').value,
        type: $('#b-type').value,
        startDate: start,
        endDate: dayType === 'full' ? ($('#b-end').value || start) : start,
        dayType: dayType,
        note: $('#b-note').value.trim()
      }
    };
    if (!payload.leave.employeeId) return toast('Pick an employee first', true);
    if (!start) return toast('Pick a start date', true);

    var btn = $('#book-submit');
    btn.disabled = true;
    $('#book-status').textContent = 'Saving…';

    act('saveLeave', payload,
        String(state.settings.approvalRequired) === 'false' ? 'Leave booked' : 'Request sent for approval')
      .then(function () {
        $('#b-note').value = '';
        $('#book-status').textContent = '';
        renderBookSummary();
      })
      .catch(function () { $('#book-status').textContent = ''; })
      .then(function () { btn.disabled = false; });
  });

  $('#cal-month-btn').addEventListener('click', function () { state.calMode = 'month'; renderCalendar(); });
  $('#cal-year-btn').addEventListener('click', function () { state.calMode = 'year'; renderCalendar(); });
  $('#cal-prev').addEventListener('click', function () {
    if (state.calMode === 'month') state.calCursor = new Date(state.calCursor.getFullYear(), state.calCursor.getMonth() - 1, 1, 12);
    else state.calYear -= 1;
    renderCalendar();
  });
  $('#cal-next').addEventListener('click', function () {
    if (state.calMode === 'month') state.calCursor = new Date(state.calCursor.getFullYear(), state.calCursor.getMonth() + 1, 1, 12);
    else state.calYear += 1;
    renderCalendar();
  });
  $('#cal-today').addEventListener('click', function () {
    state.calCursor = new Date();
    state.calYear = new Date().getFullYear();
    renderCalendar();
  });
  $('#cal-team').addEventListener('change', function () {
    state.teamFilter = this.value;
    renderCalendar();
  });

  $('#add-employee-btn').addEventListener('click', function () {
    if (!ensurePin()) return;
    employeeModal(null);
  });

  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', function (ev) { if (ev.target === this) closeModal(); });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeModal(); });

  $('#settings-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!ensurePin()) return;
    $('#settings-status').textContent = 'Saving…';
    act('saveSettings', {
      settings: {
        companyName: $('#s-company').value.trim(),
        region: $('#s-region').value,
        leaveYearStart: $('#s-year-start').value,
        defaultAllowance: $('#s-allowance').value,
        maxOffPerDay: $('#s-max-off').value,
        approvalRequired: $('#s-approval').value
      }
    }, 'Settings saved').then(function () {
      $('#settings-status').textContent = '';
      if (state.demo) loadLocalBankHolidays().then(renderAll);
    }).catch(function () { $('#settings-status').textContent = ''; });
  });

  // Delegated buttons across the whole app.
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-approve],[data-reject],[data-cancel],[data-edit],[data-remove],[data-copy]');
    if (!el) return;

    if (el.dataset.copy) {
      navigator.clipboard.writeText(el.dataset.copy)
        .then(function () { toast('Feed URL copied'); })
        .catch(function () { window.prompt('Copy this URL:', el.dataset.copy); });
      return;
    }
    if (el.dataset.approve || el.dataset.reject) {
      if (!ensurePin()) return;
      var id = el.dataset.approve || el.dataset.reject;
      act('decideLeave', { id: id, status: el.dataset.approve ? 'approved' : 'rejected' },
          el.dataset.approve ? 'Approved — calendar updated' : 'Rejected');
      return;
    }
    if (el.dataset.cancel) {
      var lv = state.leave.filter(function (l) { return String(l.id) === String(el.dataset.cancel); })[0];
      if (lv && lv.status === 'approved' && !ensurePin()) return;
      if (!window.confirm('Delete this booking? It will be removed from the calendar too.')) return;
      act('cancelLeave', { id: el.dataset.cancel }, 'Booking deleted');
      return;
    }
    if (el.dataset.edit) {
      if (!ensurePin()) return;
      employeeModal(empById(el.dataset.edit));
      return;
    }
    if (el.dataset.remove) {
      if (!ensurePin()) return;
      var emp = empById(el.dataset.remove);
      if (!window.confirm('Remove ' + (emp ? emp.name : 'this person') +
          ' and all of their leave? This cannot be undone.')) return;
      act('removeEmployee', { id: el.dataset.remove }, 'Employee removed');
    }
  });
}

// ═══ BOOT ═════════════════════════════════════════════════════════════════

function boot() {
  var today = todayISO();
  $('#b-start').value = today;
  $('#b-end').value = today;
  wire();
  load();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
