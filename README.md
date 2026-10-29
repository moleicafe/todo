# EP To-Do

Quick task capture for phone and PC. Importance (High / Medium / Low) is learned from your own choices, on your device. No AI API.

## Put it online (GitHub Pages, free, about 5 minutes)
1. Sign in at github.com and click **New repository**. Name it `todo`, set it to **Public**, tick **Add a README**, then **Create repository**.
2. Click **Add file > Upload files**. Drag in every file from this folder (index.html, app.js, learn.js, sw.js, manifest.json, icon-192.png, icon-512.png). Click **Commit changes**.
3. Go to **Settings > Pages**. Under *Branch*, choose **main** and **/(root)**, then **Save**.
4. After a minute, your app is at `https://<your-github-username>.github.io/todo/`.

The code is public, but your tasks are not: they live in your Supabase database and only your login can read them.

## Install it
- **Android (Chrome):** open the link, tap the menu (⋮) > **Add to Home screen / Install app**.
- **Windows (Edge or Chrome):** open the link, click the install icon in the address bar (or menu > Apps > Install).

## First use
1. Tap **Create account** with your email and a password.
2. Open the confirmation email and tap the link. If the page after that shows an error, ignore it: your email is already confirmed.
3. Back in the app, **Sign in**. Do the same sign-in on your other device.
4. Settings (⚙) > **Connect Telegram** > **Open Telegram to link** > press **Start**. Reminders now come through Telegram.

## How it works
- Type a task, pick High / Medium / Low, press Enter. A time in the text ("at 3pm", "tmr 10.30am", "by 15:30") fills the due time.
- After 5 tasks, it pre-selects importance from how you rated tasks starting with the same action words ("get payment", "list … NPIs"). Change it whenever it's wrong; changes teach it faster.
- Tasks due within an hour or overdue move up the list.
- Daily tab: tasks that untick every morning, each with its own optional reminder time.
- Works offline; changes sync when you're back online.

## Telegram (@eptodo_bot)
- Send any task as a message, e.g. `get payment from Jason tmr 11am`. It appears in the app, with importance picked from your history; tap High / Medium / Low to change it.
- `/daily lock #04-04 6.30pm` adds a daily task with a reminder.
- `/list` shows open tasks and today's daily tasks.
- Reminders arrive at the due time with **Done** and **+30 min** buttons, even when the app is closed.
- While Telegram is connected, the app's own pop-up reminders switch off so you don't get two.

## Limits
- Supabase's free plan pauses a project after about a week with no use; open the app regularly and it stays awake.
