# Hourglass setup

Most of the app works as soon as it is deployed. These steps switch on the rest. Do them in this order.

| Feature | Needs |
|---|---|
| Log in, logging, graphs, calendar, settings | Step 1 (already done if you could log in) |
| Apple Calendar link, saved AI chats | Step 1.4 (publish the rules) |
| Data going to your spreadsheet | Step 2 |
| AI assistant | Step 3 (free key) |
| Gmail / Calendar / Drive linking | Step 4 |
| Alerts when the app is closed | Step 5 (optional) |

## Before real students use it
Get school approval and parent/guardian consent for the study, and have your sponsoring teacher read the consent
text in `app/app.js` (search for "Research consent").

## 1. Database and log-in (Firebase, free)
1. console.firebase.google.com → your project. **Build → Authentication → Sign-in method → Email/Password → Enable.**
2. **Build → Firestore Database** → create it in production mode.
3. **Authentication → Settings → Authorized domains**: add your Vercel address.
4. **Firestore → Rules tab**: replace everything with the contents of `firestore.rules`, then **Publish**.
   Do this again whenever `firestore.rules` changes (it changed in this update).
5. `app/config.js` holds your Firebase web values (already filled in).

## 2. Research spreadsheet in YOUR Google Drive
1. Open your `Hourglass Research Data` sheet → **Extensions → Apps Script**. Delete everything and paste in all of `apps-script.gs`.
2. `STUDY_KEY` in the script must be **exactly** the same as `STUDY_KEY` in `app/config.js`.
3. **Deploy → Manage deployments → pencil → Version: New version → Deploy.** Saving alone does not update the live script.
4. In the editor pick `testWrite` and **Run** (approve). A `P-TEST0000` row appears on the `Logs` tab; delete it.
5. In the app, **Settings → Research sharing** shows "Last sync: ok" once it works.

Written to the sheet: a random study code, category, date, hours, rating and a Status column. Never the User ID,
name or email. Rows are never deleted: deleting a log marks its row "Deleted in app"; stopping sharing or deleting
an account leaves existing rows alone. Logs saved before the sheet worked are sent the next time each consenting
student opens the app.

## 3. AI assistant (free option)
Add ONE of these in Vercel: project → **Settings → Environment Variables** (Production), then **Deployments → ⋯ → Redeploy**.

**Free: `GEMINI_API_KEY`.** Go to https://aistudio.google.com/apikey, sign in with Google, click **Create API key**. No credit card is needed.
Free keys have a per-minute limit, so the assistant may say "busy, try again in a minute" when several students use it at once.
`GEMINI_MODEL` is optional (default `gemini-2.5-flash`); set it if Google retires that name.
Important: Google's terms for free Gemini keys may let Google use the chats to improve its products, and may restrict
apps aimed at under-18s. Read https://ai.google.dev/gemini-api/terms before real students use the AI, and tell
them not to type private information into it.

**Paid (better answers): `ANTHROPIC_API_KEY`.** From console.anthropic.com → API keys, with credit added. If both keys
are set, Anthropic is used. Optional: `AI_MODEL` (default `claude-opus-5-5`) and `AI_DAILY_LIMIT` (needs step 5's service account).

The free Gemini option cannot search the web; everything else (emails, Drive study material, quizzes, deadlines, memory) works.

## 4. Link Gmail, Google Calendar and Drive
1. console.cloud.google.com → your project → **APIs & Services → Library**: enable **Google Calendar API**, **Gmail API**, **Google Drive API**.
2. **OAuth consent screen → Data access**: add `gmail.readonly`, `gmail.send`, `calendar.events`, `drive.readonly`, `drive.file`.
3. **Audience → Test users**: add the Gmail address of everyone who will link Google (up to 100). Reading Gmail and Drive are
   "restricted" permissions, so an unverified app only works for test users. Opening it to everyone needs Google's
   verification and a paid security review.
4. **Credentials → your OAuth client → Authorized JavaScript origins** must include your Vercel address (no trailing slash).
5. Anyone who linked before this update should **Unlink**, then **Link** again to grant the new permissions.

## 5. Optional: alerts when the app is closed
Needs three things on top of the above.
1. **Firebase service account:** Firebase → ⚙ Project settings → Service accounts → **Generate new private key**. In Vercel add
   `FIREBASE_SERVICE_ACCOUNT` = the whole contents of that JSON file.
2. **Push keys:** run `npx web-push generate-vapid-keys`; add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
   (`mailto:you@gmail.com`) and `CRON_SECRET` (any long random string) in Vercel. Redeploy.
3. **Timer:** Vercel's free plan can't run a job every few minutes, so the Apps Script from step 2 does it. In `apps-script.gs`
   set `APP_URL` (your Vercel address) and `CRON_SECRET` (same value as in Vercel), save, then run `setupReminderTimer` once.
   Do not commit the secret to GitHub.
Then in the app: **Settings → Reminder alerts → Turn on alerts for this device → Send me a test alert.**
iPhone/iPad (iOS 16.4+) only allow alerts after **Share → Add to Home Screen**, then opening Hourglass from the icon.

## Apple Calendar
Students tap **Settings → Apple Calendar → Subscribe on this device**. Their deadlines then appear in the iPhone Calendar
app and stay up to date. One-way (Hourglass → Apple). It needs only the published rules (step 1.4).

## Known limits
- No password reset (no email is collected). The sign-up screen tells students to write their password down.
- Emails are sent only when the student presses Send. Replies are detected while the app is open and Gmail is linked.
- Free tiers (Firebase, Vercel, Google) have limits that can change.
