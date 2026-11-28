# Hourglass setup

Most of the app works as soon as it is deployed. These steps switch on the rest. Do them in this order.

| Feature | Needs |
|---|---|
| Log in, logging, graphs, calendar, settings | Step 1 (already done if you could log in) |
| Apple Calendar link, saved AI chats | Step 1.4 (publish the rules) |
| Data going to your spreadsheet | Step 2 |
| AI assistant | Nothing (free on-device AI); step 3 for the full AI |
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

## 3. AI assistant
**With no setup at all**, the AI tab uses a free on-device AI: a small model that runs privately inside the student's own browser
(no account, no key, no cost, chats never leave the device). The first time, it asks to download about 1 GB, so use Wi-Fi.
It needs a recent Chrome or Edge (computer or newer Android phone). It is simpler than the full AI: it chats, logs time,
adds deadlines, sets reminders, remembers things, makes short quizzes, and drafts emails, but its answers are less reliable,
and it only sees the start of long Drive files.

**Optional upgrade (needs an adult, 18+, to create the key):** add ONE of these in Vercel: project → **Settings → Environment
Variables** (Production), then **Deployments → ⋯ → Redeploy**. When a key is present the app uses it automatically.
- Free: `GEMINI_API_KEY` from https://aistudio.google.com/apikey (an adult's Google account). Free keys have a per-minute limit,
  can't search the web, and Google's terms for free keys may let it use chats and may restrict apps for under-18s: read
  https://ai.google.dev/gemini-api/terms first. `GEMINI_MODEL` is optional (default `gemini-2.5-flash`).
- Paid, best answers: `ANTHROPIC_API_KEY` (console.anthropic.com, with credit added). If both are set, Anthropic is used.
  Optional `AI_MODEL` (default `claude-opus-5-5`) and `AI_DAILY_LIMIT` (needs step 5's service account).

## 4. Link Gmail, Google Calendar and Drive
1. console.cloud.google.com → your project → **APIs & Services → Library**: enable **Google Calendar API**, **Gmail API**, **Google Drive API**.
2. **OAuth consent screen → Data access**: add `gmail.readonly`, `gmail.send`, `calendar.events`, `drive.readonly`, `drive.file`.
3. **Audience → Test users**: add the Gmail address of everyone who will link Google (up to 100). Reading Gmail and Drive are
   "restricted" permissions, so an unverified app only works for test users. Opening it to everyone needs Google's
   verification and a paid security review.
4. **Credentials → your OAuth client → Authorized JavaScript origins** must include your Vercel address (no trailing slash).
5. Anyone who linked before this update should **Unlink**, then **Link** again to grant the new permissions.

## 5. Optional: alerts when the app is closed
Two settings in Vercel plus two lines in your Apps Script. The server makes its own push keys, so there is nothing else to paste.
1. **Service account:** Firebase → ⚙ Project settings → **Service accounts** → **Generate new private key** → Generate. Open the downloaded
   `.json` file in a text editor, select everything and copy it. It is a master key to your database: never share it, post it, or
   commit it to GitHub, and delete the file afterwards.
2. **Vercel → Settings → Environment Variables** (Production), then redeploy:
   - `FIREBASE_SERVICE_ACCOUNT` = the whole contents of that file.
   - `CRON_SECRET` = any long random string (letters and numbers).
3. **Timer** (Vercel's free plan can't run a job every few minutes, so your Apps Script does it): in `apps-script.gs` set `APP_URL` to your
   Vercel address and `CRON_SECRET` to the same string as in Vercel, Save, choose `setupReminderTimer`, **Run**, and approve. It then calls your
   app every minute (alerts arrive within about a minute; if many students use the app, change `everyMinutes(1)` to 5 to stay inside free limits). Do not commit the secret to GitHub.
4. In the app: **Settings → Reminder alerts → Turn on alerts for this device → Send me a test alert.**

iPhone/iPad (iOS 16.4+) only allow alerts after **Share → Add to Home Screen**, then opening Hourglass from the icon.

## Apple Calendar
Students tap **Settings → Apple Calendar → Subscribe on this device**. Their deadlines then appear in the iPhone Calendar
app and stay up to date. One-way (Hourglass → Apple). It needs only the published rules (step 1.4).

## Known limits
- No password reset (no email is collected). The sign-up screen tells students to write their password down.
- Emails are sent only when the student presses Send. Replies are detected while the app is open and Gmail is linked.
- Free tiers (Firebase, Vercel, Google) have limits that can change.
