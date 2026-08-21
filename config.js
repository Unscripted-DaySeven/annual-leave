/* ---------------------------------------------------------------------------
 *  Annual Leave Tracker — front-end configuration
 *  Edit the two values below, commit, and the site is live.
 * ------------------------------------------------------------------------- */
window.LEAVE_CONFIG = {

  // Paste the /exec URL from Apps Script ▸ Deploy ▸ New deployment ▸ Web app.
  // Leave it empty to run the site in demo mode with sample data.
  apiUrl: '',

  // Must match API_TOKEN in Code.gs exactly.
  token: '',

  // Shown in the header until the sheet's own setting loads.
  companyName: 'Day Seven',

  // Half-day hours used for display (the calendar times come from Code.gs).
  amHours: '09:00–13:00',
  pmHours: '13:00–17:30'
};
