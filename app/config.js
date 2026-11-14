// Paste your own values here (see SETUP.md). Nothing in this file is a password.
// Note: everything in this file is visible to anyone who opens the website. That is normal for
// these values; your data is protected by the database rules in firestore.rules.

// Step 1 in SETUP.md: Firebase project settings -> "Your apps" -> Web app config
export const firebaseConfig = {
  apiKey: "AIzaSyA98mtdrnVUmyAnTrPkiliogx4nQYeXj_8",
  authDomain: "hourglass-4f6f9.firebaseapp.com",
  projectId: "hourglass-4f6f9",
  appId: "1:1042436528905:web:670da5afdf852f691a11d8"
};

// Step 2 in SETUP.md: the Google Apps Script web app URL that writes consenting students'
// logs into the spreadsheet in YOUR Google Drive, and the same STUDY_KEY you set in that script.
export const RESEARCH_URL = "https://script.google.com/macros/s/AKfycbzIrCNmr59i7in2tZKHOgYsPxRXBaaZDrVc_kuRXynSoCJHnqFJxJTWuyGVhUWgY8nmUA/exec";
export const STUDY_KEY = "9837rjc9urnc834rny987c49c08n30c98038ch7f";

// Step 3 in SETUP.md (optional): Google OAuth client ID, only needed for Gmail/Calendar/Drive linking.
export const GOOGLE_CLIENT_ID = "PASTE_GOOGLE_OAUTH_CLIENT_ID";

// User IDs are turned into a made-up address so no real email is ever collected.
export const ID_DOMAIN = "hourglass-study.app";
