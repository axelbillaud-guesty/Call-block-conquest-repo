# Call Block Conquest

A real-time territory game for sales call blocks. Reps log call outcomes, earn points, and spend them to claim hexes on a shared map. Whoever holds the most territory when the clock runs out wins.

Built as a single self-contained HTML page (`index.html`) that runs as a published Claude artifact with a shared live database.

## How the game works

**Scoring** (per contact, cumulative):

| Outcome | Points |
|---|---|
| Call logged (any dial) | 1 |
| Positive conversation | +5 |
| Meeting booked | +20 |

A call that books a meeting earns 26 points. Booking a meeting automatically counts as positive.

**Logging** happens on the call card with three yes/no questions: call connected, positive conversation, meeting booked. If the call didn't connect, the other two are disabled. Logging is trust-based and is for the game only — real notes belong in the CRM.

- Connected results are locked once logged.
- "No answer" contacts stay in the *To call* queue. A connected retry earns only the difference, so the dial point is never counted twice.

**Territory**

- The map has 412 hexes; each costs 1 point.
- A rep's first hex can be any free hex. After that, new hexes must touch the rep's own territory.
- Once neutral land runs out, the only way to grow is to steal from neighbors.
- A freshly claimed hex is shielded for 30 seconds (dashed outline) so it can't be stolen right back.
- If a rep loses every hex, they can restart on any free hex (or any unshielded hex if the map is full).

**Live extras:** leaderboard by territory, activity feed, and a map-wide banner whenever someone books a demo.

## Running a block

1. Open the published artifact and click **Host controls** (only the artifact owner sees this).
2. Upload the CSV and click **Import call list**. Rows are matched to the BDR roster by the BDR routing column — accents and capitals are ignored and a first name is enough. The preview flags BDRs with no accounts and CSV names not on the roster (those get added as new players).
3. Share the artifact with reps as **Contributors**. Viewers can watch but can't play.
4. Each rep opens the link, picks their name, and sees only their accounts.
5. Click **Start the block** (default 60 minutes). **End now** stops the clock; **Clear map and scores** starts a fresh round and keeps the call list.

Importing a new CSV also starts a fresh round.

## CSV format

One row per contact. Only the BDR routing column is required; every other column is optional and any unrecognized column still shows on the call card.

Recognized columns (matched loosely by name):

`BDR Routing`, `First Name`, `Last Name`, `Business Tier`, `Number of Listings`, `Current PMS`, `Last Activity`, `Email`, `Phone`, `Billing City`, `Billing State`, `Billing Country`, `Demo Notes`, `SDR Comments`, `Discovery Handover`

See `samples/sample-call-list-FAKE.csv` (fake data only).

## Current roster

Faïda, Carmen, Claudio, Felix, Julia, Faisal, Caitlin, Mariana, Oliver, Naod, Michael, Nicole, Laura, Justin, Gabriela, Millie.

The roster lives in the game database (`game/roster`), not in the code.

## Configuration

Constants at the top of the `<script>` in `index.html`:

| Constant | Default | Purpose |
|---|---|---|
| `PTS.call` / `PTS.positive` / `PTS.meeting` | 1 / 5 / 20 | Scoring |
| `SHIELD_MS` | 30000 | Steal protection after a claim |
| `COLORS` | 18 colors | Player colors, assigned by roster order |
| `COLS`, `ROWS` | 30, 19 | Map grid before the island mask (yields 412 hexes) |

## Data model

All state lives in the artifact's shared database:

| Path | Contents | Who writes |
|---|---|---|
| `game/state` | `status` (lobby/live), `round`, `startAt`, `endAt` | Host only |
| `game/roster` | reps `{slug, name}`, CSV headers, detected column mapping | Host only |
| `contacts/<slug>` | that rep's rows `{cid, row}` | Host only |
| `rounds/<round>/logs/<cid>` | `{rep, c, p, m, pts, n, at, by}` | Reps |
| `rounds/<round>/hexes/<hexId>` | `{o: ownerSlug, t: claimedAt, by}` | Reps |
| `rounds/<round>/players/<slug>` | `{spent}` points spent on hexes | Reps |
| `data/users/<uid>/me` | the viewer's chosen player (private) | Each viewer |

Points balance = sum of the rep's log points − `spent`. A new round is just a new `round` id, so resets never delete data.

## Hosting and access

The page uses the Claude artifact runtime (`window.claude.use("db")` and `window.claude.use("user")`). That means:

- It works when published as a Claude artifact. Players must be signed in to claude.ai as members of the organization; guests can only view.
- Opened anywhere else (GitHub Pages, a local file), the map renders but the game can't connect.

To run it outside Claude, replace the small `db`/`user` layer (`init()`, `subRound()`, `subContacts()`, and the `.set()` calls) with a backend such as Supabase or Firebase. The rest of the page — map, scoring, call cards — is plain JavaScript with no build step.

## Privacy note

Contact data (including emails and phone numbers) is stored in the shared database and is readable by everyone who can open the artifact. Keep sharing limited to the sales team.
