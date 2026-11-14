# Hourglass setup (all free)

Do these in order. Steps 1 and 2 are required; step 3 is optional.

## Before real students use it
Get school approval and parent/guardian consent for the study, and have your sponsoring teacher read
the consent text in `app/app.js` (search for "Research consent"). Edit the wording to match your approved plan.

## 1. Database and log-in (Firebase, free "Spark" plan)
1. Go to console.firebase.google.com and click **Add project**. Name it `hourglass`. Turn Google Analytics off.
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable → Save.**
3. **Build → Firestore Database → Create database.** Choose **production mode** and any US location.
4. In Firestore, open the **Rules** tab, replace everything with the contents of `firestore.rules`, and click **Publish**.
5. **Project settings (gear icon) → Your apps → Web (`</>`)**. Register an app named `hourglass`. Copy the four values
   (`apiKey`, `authDomain`, `projectId`, `appId`) into `app/config.js`.
6. **Authentication → Settings → Authorized domains → Add domain**: add your Vercel address (for example
   `hourglass-yourname.vercel.app`). Log-in will not work from your website until you do this.

## 2. Research spreadsheet in YOUR Google Drive
1. Go to sheets.new. Name the spreadsheet `Hourglass research data`. It is created in your Drive.
2. **Extensions → Apps Script.** Delete the sample code and paste in all of `apps-script.gs`.
3. Change `STUDY_KEY` at the top to a long random string. Put the exact same string in `app/config.js` as `STUDY_KEY`.
4. Click **Deploy → New deployment → Web app.** Set **Execute as: Me** and **Who has access: Anyone**. Click Deploy
   and approve the permissions when Google asks.
5. Copy the **Web app URL** into `app/config.js` as `RESEARCH_URL`.
6. Test it: create a test account in your app, say yes to the consent, add a log, and check that a row appears on the
   `Logs` tab. Delete the log in the app and check the row disappears.

What gets written: a random study code, category, date, hours, and the 1–10 rating. Never the User ID, name or email.

Note: `STUDY_KEY` is visible to anyone who views your website's code, so it only blocks casual junk, it is not a
password. The script rejects badly formed data. Check the sheet occasionally for strange rows.

## 3. Optional: link Gmail, Google Calendar and Drive
Linking Google is optional, and I recommend using it for your own account only. Gmail and Drive access are
"sensitive" Google permissions, and Google only lets an unverified app be used by accounts you add as test users.
1. Go to console.cloud.google.com and create a project.
2. **APIs & Services → Library**: enable **Google Calendar API**, **Gmail API** and **Google Drive API**.
3. **OAuth consent screen**: choose External, fill in the app name, and under **Test users** add your own Gmail address.
4. **Credentials → Create credentials → OAuth client ID → Web application.** Under **Authorized JavaScript origins**,
   add your Vercel address (no trailing slash). Copy the **Client ID** into `app/config.js` as `GOOGLE_CLIENT_ID`.
5. In the app: **Settings → Linked Google accounts → Link.** Google will warn that the app is unverified, which is
   expected in test mode.

Safety rules built in: Gmail is **send only** (it cannot read your inbox), Drive is **read only**, emails go only
to addresses you approve in Settings, and nothing is sent until you press **Send** on a draft.

## 4. Publish
1. Upload everything in this folder to your GitHub repo (keep the `app` folder structure).
2. Vercel redeploys automatically. Open `your-site.vercel.app/app/` on your phone and choose **Add to Home Screen**.

## Known limits
- **No password reset.** There is no email on file. If a student forgets their password, that account can't be
  recovered (they can make a new one). The sign-up screen tells them to write it down.
- **Reminders** can't be true background push notifications on a free website. The app offers a daily calendar
  reminder (works on any phone), alerts while the app is open, and an optional Google Calendar reminder.
- **The AI tab follows set commands** (log, deadlines, summary, email drafts, quizzes). It is not a chatbot that
  understands anything. A real AI model needs a paid key kept on a server, so it is not part of the free version.
- **Free tiers** (Firebase, Vercel, Google) have usage limits and can change. Check them before a big launch.
