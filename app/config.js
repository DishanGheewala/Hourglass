// Paste your own values here (see SETUP.md). Nothing in this file is a password.
// Note: everything in this file is visible to anyone who opens the website. That is normal for
// these values; your data is protected by the database rules in firestore.rules.

// Step 1 in SETUP.md: Firebase project settings -> "Your apps" -> Web app config
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_AUTH_DOMAIN",
  projectId: "PASTE_PROJECT_ID",
  appId: "PASTE_APP_ID"
};

// Step 2 in SETUP.md: the Google Apps Script web app URL that writes consenting students'
// logs into the spreadsheet in YOUR Google Drive, and the same STUDY_KEY you set in that script.
export const RESEARCH_URL = "PASTE_APPS_SCRIPT_WEB_APP_URL";
export const STUDY_KEY = "PASTE_A_RANDOM_STUDY_KEY";

// Step 3 in SETUP.md (optional): Google OAuth client ID, only needed for Gmail/Calendar/Drive linking.
export const GOOGLE_CLIENT_ID = "PASTE_GOOGLE_OAUTH_CLIENT_ID";

// User IDs are turned into a made-up address so no real email is ever collected.
export const ID_DOMAIN = "hourglass-study.app";
