/* ---------------------------------------------------------------------------
 *  Annual Leave Tracker — front-end configuration
 * ------------------------------------------------------------------------- */
window.LEAVE_CONFIG = {

  // The /exec URL from Apps Script ▸ Deploy ▸ Manage deployments.
  // If you ever deploy a brand-new deployment, paste the new URL here.
  apiUrl: 'https://script.google.com/macros/s/AKfycby10-nftmVhna91VqjpqknT_Wl58hruz8pGN4ct4cTU3psoMhqaVfQpSf6aQKbdnUy6Cw/exec',

  // Must match API_TOKEN in Code.gs exactly.
  token: 'aqwfHSruZvkhJdLSWxXIPyfohvqfcZmNbwfjI0gH',

  // Shown in the header until the sheet's own setting loads.
  companyName: 'Day Seven',

  // Half-day hours used for display (the calendar times come from Code.gs).
  amHours: '09:00–13:00',
  pmHours: '13:00–17:30'
};
