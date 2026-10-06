# Call Block Conquest

A live game for BDR call blocks. Reps log their calls to earn points and spend the points to claim hexes on a shared map. When the clock runs out, the biggest territory wins. Every block is saved, so daily, weekly and monthly performance can be reviewed in **History**.

## Playing

1. Open the link and **pick your name**. There's no login. The name stays with that browser.
   - If you open the game in another browser, pick your name again and confirm. The game moves to the new browser.
   - Not playing? Choose **Just watch**.
2. When the host starts the block, open an account in **My calls**, answer the three questions and press **Log call**.

   | Result | Points |
   |---|---|
   | Dialed, no answer | 1 |
   | Connected | 1 |
   | Positive conversation | +5 |
   | Meeting booked | +20 (counts as positive, so 26 total) |

   A connected call is final. A no-answer can be logged again if you get through later, and you only earn the difference.
3. Spend points on the **Map**: 1 point per hex.
   - Your first hex can be any free hex. After that, every hex must touch your territory.
   - You can take other players' hexes, except ones claimed in the last 30 seconds.

The server checks every rule, so editing the page can't add points or hexes.

## Hosting (admins)

Press **Admin** in the header and enter the admin code. Admins can:

- **Start the block** for 5–240 minutes, or **End now**. Each block that's started is saved as one contest in History.
- **Import the call list** from a CSV. Rows go to players through the BDR routing column (first names are enough), and the preview shows who matched before you import. Importing replaces the whole list.
- **Delete the call list.** Players, scores and History are kept.
- **Players:** add a player, **Release** a name that's stuck on someone's old browser, or **Remove** a player and their list.
- **Clear map and scores** to open a fresh round. Past contests stay in History.
- **Delete a contest** from History.

In **History**, pick a range (today, this week, this month, last month, all time or custom dates) to see each player's totals: contests, wins, dials, connects, positive calls, demos, points and hexes. You can also open each contest's final standings. **Download CSV** exports one row per player per contest.

## How it runs

- One Node server (`server.js`) on **Cloud Run** in project `agentic-workflows-485210`, region `europe-west1`. It keeps the live game in memory, checks every action and pushes updates to browsers with server-sent events.
- It runs with `--max-instances 1`, so a single process owns the game state and there are no races.
- Data goes to the project's existing (default) **Firestore** database. That database is shared with other apps, so this app reads and writes **only** under the document `callblockconquest/main`:

  ```
  callblockconquest/main                 game state, players, which browser holds which name
  callblockconquest/main/contacts/{rep}  each player's call list
  callblockconquest/main/rounds/{id}     one contest: map, wallets, final standings (History)
  callblockconquest/main/rounds/{id}/logs/{account}
  ```

  Every Firestore reference in the code is built from that root, so the app can't touch other collections.
- Contest dates use the `GAME_TZ` time zone (default `Europe/Madrid`).

## Local development

```bash
npm install
npm run dev     # http://localhost:3000, in-memory data, admin code "dev"
npm test        # end-to-end checks against the in-memory store
```

## Deploying

```bash
gcloud run deploy call-block-conquest --source . \
  --project agentic-workflows-485210 --region europe-west1 \
  --max-instances 1 --concurrency 500 --timeout 3600 --memory 512Mi \
  --no-invoker-iam-check \
  --update-env-vars ADMIN_CODE=<code>,GAME_TZ=Europe/Madrid
```

To change the admin code, redeploy with a new `ADMIN_CODE`. Admins will be asked for the new code the next time they open Host controls.
