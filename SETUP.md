# Hourglass setup

Do these in order. Steps 1, 2 and 4 are required. Everything is free except the AI (step 4), which
bills a small amount per message to your Anthropic account.

## Before real students use it
Get school approval and parent/guardian consent for the study, and have your sponsoring teacher read
the consent text in `app/app.js` (search for "Research consent"). Edit the wording to match your approved plan.

## 1. Database and log-in (Firebase, free "Spark" plan)
1. Go to console.firebase.google.com and click **Add project**. Name it `hourglass`. Turn Google Analytics off.
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable → Save.**
3. **Build → Firestore Database → Create database.** Choose **production mode** and any US location.
4. In Firestore, open the **Rules** tab, replace everything with the contents of `firestore.rules`, and click
   **Publish**. (Do this again every time `firestore.rules` changes, including now.)
5. **Project settings (gear icon) → Your apps → Web (`</>`)**. Copy `apiKey`, `authDomain`, `projectId`, `appId`
   into `app/config.js`.
6. **Authentication → Settings → Authorized domains → Add domain**: add your Vercel address.

## 2. Research spreadsheet in YOUR Google Drive
1. Open your `Hourglass research data` sheet (or make one at sheets.new).
2. **Extensions → Apps Script.** Delete everything and paste in all of the new `apps-script.gs`.
3. `STUDY_KEY` at the top must be **exactly** the same as `STUDY_KEY` in `app/config.js`.
   (This was the bug: the script's key had an extra `a` at the end, so the sheet rejected every row.)
4. Save, then **Deploy → Manage deployments → pencil (edit) → Version: New version → Deploy.**
   Editing the code is not enough: until you deploy a new version, Google keeps running the old code.
   Keep **Execute as: Me** and **Who has access: Anyone**. The web app URL stays the same.
5. Test it: in the editor choose `testWrite` and press **Run**. A `P-TEST0000` row should appear on the `Logs`
   tab (delete it afterwards). Then log something in the app with a test account that said yes to research.
6. In the app, **Settings → Research sharing** shows "Last sync". If it says `error: bad key`, the keys still
   don't match.

What gets written: a random study code, category, date, hours, the 1–10 rating, and a Status column. Never the
User ID, name or email. Rows are never deleted by the app: deleting a log marks its row "Deleted in app", and
deleting an account or stopping sharing leaves existing rows in place. Logs saved before this fix are sent
automatically the next time each consenting student opens the app.

## 3. Link Gmail, Google Calendar and Drive
1. Go to console.cloud.google.com and open the project that has your OAuth client.
2. **APIs & Services → Library**: enable **Google Calendar API**, **Gmail API** and **Google Drive API**.
3. **OAuth consent screen → Data access (Scopes)**: add `gmail.readonly`, `gmail.send`, `calendar.events`,
   `drive.readonly` and `drive.file`.
4. **Audience → Test users**: add the Gmail address of everyone who will link Google (up to 100).
   Gmail-reading and Drive-reading are "restricted" Google permissions: an unverified app can only be used by
   test users. Opening it to everyone requires Google's app verification and a security assessment, which is
   not free. For a class project, test users are the practical choice.
5. Your OAuth client's **Authorized JavaScript origins** must include your Vercel address (no trailing slash).
6. People who linked Google before this update should press **Unlink** then **Link** so Google asks for the new
   permissions.

## 4. Vercel settings (AI assistant, alerts, Apple Calendar)
In Vercel: your project → **Settings → Environment Variables**. Add each of these for **Production** (and
Preview if you use it), then redeploy.

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Create one at console.anthropic.com → API keys. Add a few dollars of credit and set a monthly spend limit. |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase → Project settings → **Service accounts** → **Generate new private key**. Paste the whole JSON file's contents. |
| `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` | On any computer with Node.js run `npx web-push generate-vapid-keys` and paste the two keys. |
| `VAPID_SUBJECT` | `mailto:` followed by your email, e.g. `mailto:you@gmail.com` |
| `CRON_SECRET` | Any long random string (letters and numbers). |
| `AI_MODEL` (optional) | Defaults to `claude-opus-5-5`. `claude-sonnet-5-5` or `claude-haiku-5-5` are cheaper. |
| `AI_DAILY_LIMIT` (optional) | AI steps per student per day. Default 200. |

Never put these values in `config.js` or anywhere in GitHub: they are secrets.

Costs: with Claude Opus 5.5 at medium effort, a typical chat message costs roughly 1–5 cents (more when it
reads long files). Set a spend limit in the Anthropic console so a busy week can't surprise you.

## 5. Alerts when the app is closed (free timer)
Vercel's free plan only runs scheduled jobs once a day, so the Apps Script from step 2 does the timing:
1. In `apps-script.gs`, set `APP_URL` to your Vercel address and `CRON_SECRET` to the same value as in Vercel.
2. Save, choose `setupReminderTimer` in the editor, press **Run**, and approve. It now calls your app every
   5 minutes, and the app sends each student's alerts when they are due (within about 5 minutes).
3. In the app: **Settings → Reminder alerts → Turn on alerts for this device → Send me a test alert.**

On iPhone and iPad (iOS 16.4+), alerts only work after **Share → Add to Home Screen**, then opening Hourglass
from the Home Screen icon. That is an Apple rule for all websites. Android, Windows and Mac browsers work directly.

## 6. Apple Calendar
Nothing to set up beyond step 4. Students tap **Settings → Apple Calendar → Subscribe on this device** and their
Hourglass deadlines appear in the iPhone Calendar app, updating by themselves, with an alert the day before.
The same link also works in Google Calendar and Outlook ("subscribe from URL").
This is one-way (Hourglass → Apple). Reading a student's Apple calendar would need their iCloud app-specific
password, which isn't a safe thing to ask teenagers for.

## 7. Publish
Push to GitHub; Vercel redeploys automatically. Open `your-site.vercel.app/app/` on your phone and add it to
your Home Screen.

## Known limits
- **No password reset.** There is no email on file. The sign-up screen tells students to write their password down.
- **Emails are sent only when the student presses Send.** The assistant writes the whole email; the student
  reviews it and sends it. Replies are detected while the app is open and Gmail is linked (Google sign-ins last
  about an hour).
- **Free tiers** (Firebase, Vercel, Google) have usage limits and can change. Check them before a big launch.
