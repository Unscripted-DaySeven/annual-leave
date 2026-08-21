# Annual Leave Tracker

A leave-booking site for a small team. It runs as a static page on GitHub Pages,
stores everything in a Google Sheet you own, and writes approved leave straight
into a shared Google Calendar plus each employee's own calendar.

- Full days and half days (morning / afternoon)
- Weekends and UK bank holidays skipped automatically
- Allowance tracking — used, booked ahead, pending, remaining
- Approval workflow with a manager PIN
- Clash warnings when too many people in a team are off on the same day
- Month calendar and a year wall chart of the whole team
- Subscribable `.ics` feeds, per person and for the whole team

Nothing to host, nothing to pay for, no database.

---

## What you need

- A Google account (Workspace or personal) that will own the sheet and calendar
- A GitHub account
- About 20 minutes

---

## Step 1 — Create the Google Sheet and paste in the script

1. Go to [sheets.new](https://sheets.new) and name it something like
   **Annual Leave — Day Seven**.
2. **Extensions ▸ Apps Script**. Delete whatever is in `Code.gs`.
3. Open `Code.gs` from this repo, copy all of it, paste it in.
4. At the top of the file, edit the `CONFIG` block:

   ```js
   API_TOKEN: 'CHANGE-ME-to-a-long-random-string',   // ← invent a long random string
   MANAGER_PIN: '2468',                              // ← the PIN that approves leave
   CALENDAR_ID: 'primary',                           // ← or a shared calendar's ID
   ```

   Keep the token somewhere — you need the exact same string in step 3.

5. Save (💾), then in the function dropdown pick **firstRunSetup** and press **Run**.
6. Google will ask you to authorise. Choose your account ▸ *Advanced* ▸
   *Go to (project name)* ▸ *Allow*. That warning is normal for a script you
   wrote yourself.

The sheet now has three tabs — `Employees`, `Leave`, `Settings` — and a
**Leave tracker** menu appears in the sheet's menu bar.

### Using a dedicated calendar instead of your own

If you'd rather leave not land on your personal calendar:

1. Google Calendar ▸ **Other calendars ▸ + ▸ Create new calendar**, call it
   *Day Seven — Annual Leave*, create it.
2. Open its **Settings**, scroll to **Integrate calendar**, copy the
   **Calendar ID**.
3. Paste that into `CALENDAR_ID` in `Code.gs` and save.
4. Under *Share with specific people or groups*, add your team so they can see it.

---

## Step 2 — Deploy the script as a web app

1. In Apps Script: **Deploy ▸ New deployment**.
2. Click the gear next to *Select type* and choose **Web app**.
3. Set:
   - **Description**: `Leave tracker API`
   - **Execute as**: **Me**
   - **Who has access**: **Anyone**
4. **Deploy**, authorise if asked, then copy the **Web app URL**. It ends in
   `/exec`.

> "Anyone" means anyone with the URL can reach the script — that's why there's a
> token. The URL is not published anywhere except your own repo. If your team is
> all on the same Google Workspace and you'd rather lock it down, set access to
> *Anyone within Day Seven* instead; everyone then has to be signed in to that
> Workspace in the browser they use the site from.

**Whenever you edit `Code.gs` later**, use **Deploy ▸ Manage deployments ▸
✏️ ▸ Version: New version ▸ Deploy**, otherwise the live URL keeps running the
old code.

---

## Step 3 — Put the site on GitHub Pages

1. Create a new repository, e.g. `annual-leave`. Public or private both work
   (Pages on a private repo needs a paid GitHub plan).
2. Upload every file from this folder, keeping the structure:

   ```
   index.html
   app.js
   styles.css
   config.js
   bank-holidays.json
   Code.gs            (reference copy of the Apps Script — not used by the site)
   README.md
   ```

   Everything sits in the root of the repo, so you can edit any of it straight
   from GitHub's web editor.

3. Edit `config.js` and fill in the two values:

   ```js
   apiUrl: 'https://script.google.com/macros/s/AKfy...../exec',
   token:  'the same long random string you put in Code.gs',
   ```

4. **Settings ▸ Pages ▸ Source: Deploy from a branch ▸ main / (root) ▸ Save.**
5. A minute later the site is at
   `https://<your-username>.github.io/annual-leave/`.

Open it. The amber "demo mode" banner should be gone and the **Setup** tab should
show a green dot.

---

## Step 4 — Add your team

1. **Team ▸ Add employee**. You'll be asked for the manager PIN.
2. Fill in name, work email (this is the address that gets the calendar invite),
   team, and their allowance in days.

Teams matter for the clash warnings — people are only compared against others in
the same team.

---

## Step 5 — Subscribe to the calendar feeds

Approved leave is written directly into the shared Google Calendar, so if you
shared that calendar in step 1 there is nothing else to do.

For anyone outside that calendar — or for Outlook, Apple Calendar, or a personal
account — the **Setup** tab lists a subscribable feed URL for the whole team and
one per person. To use one:

- **Google Calendar** — Other calendars ▸ **+** ▸ *From URL* ▸ paste ▸ Add.
- **Outlook** — Add calendar ▸ *Subscribe from web* ▸ paste.
- **Apple Calendar** — File ▸ *New Calendar Subscription* ▸ paste.

Subscribed feeds refresh on the calendar provider's own schedule — usually every
few hours, sometimes up to 24. The direct Google Calendar write is instant, so
use that for the people who need it live.

---

## How it decides things

| Question | Answer |
|---|---|
| What counts as a day? | Mon–Fri, excluding bank holidays for the region set on the Setup tab. Live from `gov.uk`, with a bundled copy as a fallback. |
| What does a half day cost? | 0.5 days. AM is 09:00–13:00, PM is 13:00–17:30 — change those in `CONFIG` in `Code.gs`. |
| What comes off the allowance? | Annual leave and TOIL. Sick, unpaid, parental and other leave are recorded and shown on the calendar but not deducted. |
| When is the leave year? | Set on the Setup tab. 1 January by default; pick 1 April if that's your year. |
| Who can approve? | Anyone with the manager PIN. Click **Manager mode**, enter it once per browser session. |
| What triggers a clash warning? | When the number of people off in that team on that day reaches the threshold on the Setup tab. It's a warning, not a block. |

---

## Day-to-day

- **Booking**: Book leave tab ▸ pick person, dates, full/half day ▸ *Request leave*.
  It shows the cost and what's left before you commit.
- **Approving**: Approvals tab ▸ Manager mode ▸ Approve / Reject. Approving writes
  the calendar event and emails the employee.
- **Cancelling**: the Cancel button on any booking. Approved bookings need the PIN.
  The calendar event is removed too.
- **Editing in the sheet**: you can edit the `Leave` tab by hand. Clear the row's
  `syncHash` cell to force a re-sync, or use **Leave tracker ▸ Sync calendar now**.
  The script also re-syncs every 6 hours on its own.

---

## Troubleshooting

**"Could not reach the sheet"** — usually one of: the URL in `config.js` isn't the
`/exec` one, the token doesn't match `Code.gs` exactly, or you edited the script
without deploying a *new version*.

**Calendar events aren't appearing** — run **Leave tracker ▸ Sync calendar now**
in the sheet and watch for an error. If it says it can't open the calendar, the
`CALENDAR_ID` is wrong or that account can't write to it.

**Employees don't see the invite** — `INVITE_EMPLOYEE` must be `true` and their
email must be filled in on the Team tab. Guests may need to accept the invite, or
have "add invitations to calendar" set to *automatically* in their own Calendar
settings.

**Bank holidays look wrong** — check the region on the Setup tab. Scotland and
Northern Ireland have different dates.

**Someone shared the URL** — change `API_TOKEN` in `Code.gs`, deploy a new
version, update `config.js`, commit. Old links stop working immediately.

---

## A note on security

This is a small-team tool, not an HR system. The token in `config.js` is visible
to anyone who can read the repo or view the page source, and the PIN only gates
the buttons in the UI. That's a reasonable trade for a team who all trust each
other; it is not appropriate for holding sensitive data about people outside the
team. Keep sick-leave notes out of the notes field if that matters to you.

The data lives in your Google account. Nothing is sent anywhere else.
