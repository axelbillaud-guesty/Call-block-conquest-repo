// Call Block Conquest server: holds the live game in memory, enforces the rules,
// streams state to browsers, and saves everything to Firestore.
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Firestore, FieldValue } from "@google-cloud/firestore";
import { HEXIDX, ptsFor, claimBlock } from "./public/map.js";

const PORT = process.env.PORT || 8080;
const ADMIN_CODE = Buffer.from(process.env.ADMIN_CODE || "");
const TZ = process.env.GAME_TZ || "Europe/Madrid";   // which calendar day a contest belongs to
const MAX_ROWS = 5000;                                // accounts per player
const DEFAULT_REPS = ["Faïda","Carmen","Claudio","Felix","Julia","Faisal","Caitlin","Mariana","Oliver","Naod","Michael","Nicole","Laura","Justin","Gabriela","Millie"];

// ---------- storage ----------
// The project's (default) Firestore database is shared with other apps. Everything this app
// stores lives under the single document callblockconquest/main and its subcollections:
// every reference below is built from ROOT, so the app cannot read, write or delete anything else.
const fs = process.env.CBC_MEMORY==="1"
  ? new (await import("./memstore.js")).MemFirestore(process.env.CBC_MEMORY_FILE)
  : new Firestore({ ignoreUndefinedProperties: true });
const ROOT = fs.collection("callblockconquest").doc("main");
const OWNER_REF = ROOT.collection("meta").doc("owner");
const roundsCol = () => ROOT.collection("rounds");
const roundRef = id => roundsCol().doc(id);
// Call lists are versioned: an import writes a whole new list, then the roster switches to it.
const listCol = listId => ROOT.collection("lists").doc(listId);
const listRef = (listId, slug) => listCol(listId).collection("contacts").doc(slug);
const listId = () => S.roster.listId || "l0";
const inc = n => fs.increment ? fs.increment(n) : FieldValue.increment(n);

// Only one server instance may write. During a redeploy the old and new revisions overlap
// briefly: the newest instance claims ownership at boot, and every write checks it inside a
// transaction, so an outgoing instance can never overwrite the new one's state.
const OWNER = crypto.randomUUID();
let retired = false;
class Retired extends Error {}
async function persist(write){
  if (retired) throw new Retired();
  await fs.runTransaction(async tx => {
    const o = await tx.get(OWNER_REF);
    if (o.exists && o.data().id !== OWNER){ retire(); throw new Retired(); }
    write(tx);
  });
}
function retire(){
  if (retired) return;
  retired = true;
  console.log("a newer instance took over; handing off clients");
  for (const res of clients) res.end();      // browsers reconnect to the new instance
  clients.clear();
}
setInterval(()=>{ if (!retired) OWNER_REF.get().then(o=>{ if (o.exists && o.data().id!==OWNER) retire(); }).catch(()=>{}); }, 5000);

// ---------- state ----------
let S = { game:{ status:"lobby", round:null, startAt:0, endAt:0 }, roster:{ reps:[], headers:[], fields:{}, at:0 }, bindings:{} };
let R = null;                    // current round: { id, meta, logs: Map, hexes:{}, spent:{} }
const contacts = new Map();      // slug -> rows, loaded on demand
const unsaved = new Map();       // round id -> finished round not yet stored (retried)
const saving = new Map();        // round id -> in-flight save of a finished round
const logging = new Set();       // "round/account" calls being saved right now

const now = () => Date.now();
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const slugify = s => String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,60) || "rep";
const repOf = slug => S.roster.reps.find(r=>r.slug===slug);
const isLive = () => !retired && S.game.status==="live" && now() < S.game.endAt && R?.meta?.status==="live";
const newRoundId = () => "r" + now().toString(36) + crypto.randomBytes(2).toString("hex");
const dayOf = ms => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" }).format(ms);
const cap = s => s[0].toUpperCase() + s.slice(1) + ".";

function emptyRound(id){ return { id, meta:null, logs:new Map(), hexes:{}, spent:{} }; }
// A slug is in use if it's on the roster or already has play in the current round
// (so removing a player and re-adding the name starts them clean).
function slugInUse(slug){
  return !!repOf(slug) || R.spent[slug]!==undefined
    || [...R.logs.values()].some(l=>l.rep===slug) || Object.values(R.hexes).some(h=>h.o===slug);
}
function freshSlug(name, taken = new Set()){
  const base = slugify(name); let slug = base, i = 2;
  while (slugInUse(slug) || taken.has(slug)) slug = `${base}-${i++}`;
  return slug;
}

async function load(){
  await OWNER_REF.set({ id: OWNER, at: now() });
  const snap = await ROOT.get();
  if (snap.exists){
    const d = snap.data();
    S = { game: d.game || S.game, roster: d.roster || S.roster, bindings: d.bindings || {} };
  } else {
    S.roster = { reps: DEFAULT_REPS.map(name=>({ slug: slugify(name), name })), headers:[], fields:{}, at: now() };
    S.game = { status:"lobby", round:newRoundId(), startAt:0, endAt:0 };
    await persist(tx=>tx.set(ROOT, S));
  }
  R = emptyRound(S.game.round);
  if (S.game.round){
    const rs = await roundRef(S.game.round).get();
    if (rs.exists) R.meta = rs.data().meta || null;
    const sub = name => roundRef(S.game.round).collection(name).get();
    const [ls, hs, ps] = await Promise.all([sub("logs"), sub("hexes"), sub("players")]);
    for (const doc of ls.docs) R.logs.set(doc.id, doc.data());
    for (const doc of hs.docs) R.hexes[doc.id] = doc.data();
    for (const doc of ps.docs) R.spent[doc.id] = doc.data().spent || 0;
  }
  console.log(`loaded: round ${S.game.round} (${S.game.status}), ${R.logs.size} logs, ${Object.keys(R.hexes).length} hexes`);
}

// The root doc (game, roster, name holders) changes in bursts: its writes are debounced.
// Calls and hex claims are stored one document each, before the player gets an answer.
let rootTimer=null;
function saveRoot(){
  clearTimeout(rootTimer);
  rootTimer=setTimeout(()=>persist(tx=>tx.set(ROOT, S)).catch(e=>{ if (!(e instanceof Retired)) console.error("saveRoot", e); }), 300);
}
async function saveRootNow(){ clearTimeout(rootTimer); await persist(tx=>tx.set(ROOT, S)); }
async function flushRound(){
  const r = R;
  if (r?.meta && r.meta.status==="live") await persist(tx=>tx.set(roundRef(r.id), { meta:r.meta }, { merge:true }));
}

// ---------- scoring ----------
function summarize(r){
  const names = new Map((r.meta?.reps || []).map(x=>[x.slug, x.name]));
  for (const x of S.roster.reps) if (!names.has(x.slug)) names.set(x.slug, x.name);
  const rows = new Map();
  const row = slug => rows.get(slug) || rows.set(slug, { slug, name: names.get(slug) || slug, dials:0, connects:0, positives:0, demos:0, pts:0, hexes:0, spent:0 }).get(slug);
  for (const l of r.logs.values()){ const x=row(l.rep); x.dials++; if(l.c) x.connects++; if(l.p) x.positives++; if(l.m) x.demos++; x.pts+=l.pts||0; }
  for (const h of Object.values(r.hexes)) row(h.o).hexes++;
  for (const [slug, n] of Object.entries(r.spent)) row(slug).spent = n;
  const list = [...rows.values()].filter(x=>x.dials || x.hexes)
    .sort((a,b)=> b.hexes-a.hexes || b.pts-a.pts || a.name.localeCompare(b.name));
  list.forEach((x,i)=> x.rank=i+1);
  return { rows:list, winner: list[0]?.slug || null };
}
function earned(slug){ let s=0; for (const l of R.logs.values()) if (l.rep===slug) s+=l.pts||0; return s; }

// Close a round: it stops accepting plays immediately (synchronously, before any await),
// then its final standings are stored for History. Failed writes are retried until they land.
function closeRound(r, endAt = Math.min(now(), S.game.endAt || now())){
  if (!r?.meta || r.meta.status!=="live") return Promise.resolve();
  r.meta.endAt = endAt; r.meta.status = "done";
  unsaved.set(r.id, { meta:{ ...r.meta }, summary: summarize(r) });
  return flushUnsaved();
}
async function flushUnsaved(){
  for (const [id, data] of unsaved){
    if (saving.has(id)) { await saving.get(id); continue; }
    const p = persist(tx=>tx.set(roundRef(id), data, { merge:true }))
      .then(()=>{ if (unsaved.get(id)===data) unsaved.delete(id); })
      .catch(e=>{ if (!(e instanceof Retired)) console.error("save finished round", id, e); })
      .finally(()=>saving.delete(id));
    saving.set(id, p); await p;
    if (retired) return;
  }
}
// A call or claim that was still saving when its round closed: refresh that round's standings.
function resummarize(r){
  if (r.meta?.status!=="done") return;
  unsaved.set(r.id, { meta:{ ...r.meta }, summary: summarize(r) });
  flushUnsaved();
}
setInterval(()=>{
  if (S.game.status==="live" && now()>=S.game.endAt && R?.meta?.status==="live") { closeRound(R, S.game.endAt); broadcast(); }
  if (unsaved.size) flushUnsaved();
}, 2000);

// ---------- live updates (server-sent events) ----------
const clients = new Set();
function publicState(){
  return {
    now: now(), tz: TZ, game: S.game, roster: S.roster,
    taken: Object.fromEntries(Object.entries(S.bindings).map(([slug,b])=>[slug, b.id])),
    round: R ? { id:R.id, logs:[...R.logs.entries()], hexes:R.hexes, spent:R.spent } : null,
  };
}
let bTimer=null;
function broadcast(){
  if (bTimer) return;
  bTimer=setTimeout(()=>{ bTimer=null; const msg=`event: state\ndata: ${JSON.stringify(publicState())}\n\n`; for (const res of clients) res.write(msg); }, 120);
}
setInterval(()=>{ for (const res of clients) res.write(": ping\n\n"); }, 20000);

// ---------- http ----------
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "15mb" }));
const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(here, "public"), { setHeaders: res => res.setHeader("Cache-Control", "no-cache") }));

const fail = (res, code, msg) => res.status(code).json({ error: msg });
// Writes are refused once a newer instance owns the game; the browser retries against it.
app.use("/api", (req,res,next)=> retired && req.method!=="GET" ? fail(res, 503, "The game was just updated. Try again.") : next());
function me(req){
  const t = req.get("x-player"); if (!t) return null;
  const h = sha(t);
  for (const [slug, b] of Object.entries(S.bindings)) if (b.h===h) return slug;
  return null;
}
function adminOk(req){
  const c = Buffer.from(req.get("x-admin") || "");
  return ADMIN_CODE.length > 0 && c.length===ADMIN_CODE.length && crypto.timingSafeEqual(c, ADMIN_CODE);
}
const admin = (req,res,next) => adminOk(req) ? next() : fail(res, 401, "Wrong admin code.");
const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);

app.get("/api/ping", (req,res)=> res.json({ ok:true }));

app.get("/api/events", (req,res)=>{
  if (retired) return fail(res, 503, "Reconnecting.");
  res.set({ "Content-Type":"text/event-stream", "Cache-Control":"no-cache, no-transform", "Connection":"keep-alive", "X-Accel-Buffering":"no" });
  res.flushHeaders();
  res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(publicState())}\n\n`);
  clients.add(res);
  req.on("close", ()=> clients.delete(res));
});

// Pick a name. No login: the browser gets a token for that name. Picking a name someone
// else holds needs takeover=true and moves the name to this browser.
app.post("/api/pick", (req,res)=>{
  const { slug, takeover } = req.body || {};
  if (!repOf(slug)) return fail(res, 404, "That name isn't on the list.");
  const mine = me(req);
  if (S.bindings[slug] && mine!==slug && !takeover) return res.status(409).json({ error:"taken" });
  if (mine && mine!==slug) delete S.bindings[mine];
  const token = crypto.randomBytes(24).toString("hex"), id = crypto.randomBytes(6).toString("hex");
  S.bindings[slug] = { h: sha(token), id, at: now() };
  saveRoot(); broadcast();
  res.json({ token, slug, id });
});
app.post("/api/leave", (req,res)=>{
  const mine = me(req); if (mine){ delete S.bindings[mine]; saveRoot(); broadcast(); }
  res.json({ ok:true });
});

app.get("/api/contacts", wrap(async (req,res)=>{
  const slug = me(req); if (!slug) return fail(res, 403, "Pick your name first.");
  res.json({ slug, rows: await contactsOf(slug) });
}));
async function contactsOf(slug){
  const key = `${listId()}/${slug}`;
  if (!contacts.has(key)){ const s = await listRef(listId(), slug).get(); contacts.set(key, s.exists ? (s.data().rows||[]) : []); }
  return contacts.get(key);
}

app.post("/api/log", wrap(async (req,res)=>{
  const slug = me(req); if (!slug) return fail(res, 403, "Pick your name first.");
  const { cid } = req.body || {};
  const c = !!req.body?.c, m = c && !!req.body?.m, p = c && (!!req.body?.p || m);
  const rows = await contactsOf(slug);
  if (!rows.some(x=>x.cid===cid)) return fail(res, 404, "That account isn't on your list.");
  if (!isLive()) return fail(res, 409, "The block isn't running.");
  const r = R, prev = r.logs.get(cid), key = `${r.id}/${cid}`;
  if (prev?.c) return fail(res, 409, "This call is already logged.");
  if (logging.has(key)) return fail(res, 409, "This call is already being saved.");
  const log = { rep: slug, c, p, m, pts: ptsFor(c, p, m), n: (prev?.n||0)+1, at: now() };
  // Points only count once the call is stored, so nobody can spend points that might vanish.
  logging.add(key);
  try { await persist(tx=>tx.set(roundRef(r.id).collection("logs").doc(cid), log)); }
  finally { logging.delete(key); }
  r.logs.set(cid, log);
  resummarize(r);
  broadcast();
  res.json({ ok:true, log, gain: log.pts - (prev?.pts||0) });
}));

app.post("/api/claim", wrap(async (req,res)=>{
  const slug = me(req); if (!slug) return fail(res, 403, "Pick your name first.");
  const id = req.body?.hex;
  if (!HEXIDX.has(id)) return fail(res, 404, "Not a hex.");
  if (!isLive()) return fail(res, 409, "The block isn't running.");
  const why = claimBlock(id, slug, x=>R.hexes[x], earned(slug) - (R.spent[slug]||0), now());
  if (why) return fail(res, 409, why==="yours" ? "Already yours." : cap(why));
  // Take the hex in memory first (so two clicks can't both win it), store it, then answer.
  const r = R, prev = r.hexes[id], rec = { o: slug, t: now() };
  r.hexes[id] = rec; r.spent[slug] = (r.spent[slug]||0) + 1;
  broadcast();
  try {
    await persist(tx=>{
      tx.set(roundRef(r.id).collection("hexes").doc(id), rec);
      tx.set(roundRef(r.id).collection("players").doc(slug), { spent: inc(1) }, { merge:true });
    });
  } catch(e){
    if (r.hexes[id]===rec){ if (prev) r.hexes[id] = prev; else delete r.hexes[id]; }
    r.spent[slug]--; resummarize(r); broadcast();
    throw e;
  }
  res.json({ ok:true });
}));

// History: one entry per contest that was started, with its final standings.
app.get("/api/history", wrap(async (req,res)=>{
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = day.test(req.query.from) ? req.query.from : "0000-00-00";
  const to = day.test(req.query.to) ? req.query.to : "9999-99-99";
  const snap = await roundsCol().where("meta.date", ">=", from).where("meta.date", "<=", to).select("meta", "summary").get();
  const found = new Map(snap.docs.map(d=>[d.id, d.data()]));
  for (const [id, x] of unsaved) if (x.meta.date>=from && x.meta.date<=to) found.set(id, x);
  if (R?.meta?.status==="live" && R.meta.date>=from && R.meta.date<=to) found.set(R.id, { meta:R.meta, summary:summarize(R) });
  const out = [...found].map(([id, x])=>({ id, ...x.meta, summary: x.summary || { rows:[], winner:null } }))
    .sort((a,b)=> b.startAt - a.startAt);
  res.json({ rounds: out, tz: TZ });
}));

// ---------- admin ----------
app.post("/api/admin/check", admin, (req,res)=> res.json({ ok:true }));

app.post("/api/admin/start", admin, wrap(async (req,res)=>{
  const mins = Math.max(5, Math.min(240, Math.round(+req.body?.mins || 60)));
  const closing = closeRound(R);                                  // a started round becomes history
  if (R.meta) R = emptyRound(newRoundId());
  const t = now();
  S.game = { status:"live", round:R.id, startAt:t, endAt:t+mins*60000 };
  R.meta = { date: dayOf(t), startAt:t, endAt:S.game.endAt, mins, status:"live", reps: S.roster.reps.map(({slug,name})=>({slug,name})) };
  broadcast(); saveRoot();
  await closing; await flushRound();
  res.json({ ok:true });
}));
app.post("/api/admin/end", admin, wrap(async (req,res)=>{
  if (!isLive()) return fail(res, 409, "The block isn't running.");
  S.game = { ...S.game, endAt: now() };
  const closing = closeRound(R, S.game.endAt);
  broadcast(); saveRoot();
  await closing;
  res.json({ ok:true });
}));
app.post("/api/admin/reset", admin, wrap(async (req,res)=>{
  const closing = closeRound(R);
  S.game = { status:"lobby", round:newRoundId(), startAt:0, endAt:0 };
  R = emptyRound(S.game.round);
  broadcast(); saveRoot();
  await closing;
  res.json({ ok:true });
}));

// Replace the call list. Rows are grouped by player in the browser (the CSV is parsed there).
app.post("/api/admin/import", admin, wrap(async (req,res)=>{
  const { headers, fields, groups } = req.body || {};
  if (!Array.isArray(groups) || !Array.isArray(headers)) return fail(res, 400, "Bad import.");
  const reps = [], seen = new Set();
  for (const g of groups){
    const name = String(g.name||"").trim().slice(0,80); if (!name) continue;
    const slug = (repOf(g.slug) && !seen.has(g.slug)) ? g.slug : freshSlug(name, seen);
    seen.add(slug);
    const list = Array.isArray(g.rows) ? g.rows : [];
    if (list.length > MAX_ROWS) return fail(res, 413, `${name} has ${list.length} accounts; the limit is ${MAX_ROWS} per player.`);
    const rows = list.map((r,i)=>({ cid:`${slug}--${i}`, row:r }));
    if (Buffer.byteLength(JSON.stringify(rows)) > 900_000) return fail(res, 413, `${name}'s list is too big to store (shorten long note columns).`);
    reps.push({ slug, name, rows });
  }
  // Write the whole new list next to the old one. If anything fails, the old list stays in use.
  const newList = "l" + now().toString(36) + crypto.randomBytes(2).toString("hex"), oldList = listId();
  try { await Promise.all(reps.map(r=>persist(tx=>tx.set(listRef(newList, r.slug), { rows: r.rows })))); }
  catch(e){ fs.recursiveDelete(listCol(newList)).catch(()=>{}); throw e; }
  // Switch over: the current round closes (it becomes History) and a fresh lobby round opens.
  const closing = closeRound(R);
  S.game = { status:"lobby", round:newRoundId(), startAt:0, endAt:0 };
  R = emptyRound(S.game.round);
  for (const slug of Object.keys(S.bindings)) if (!seen.has(slug)) delete S.bindings[slug];
  S.roster = { reps: reps.map(({slug,name})=>({slug,name})), headers: headers.map(String).slice(0,200), fields: fields||{}, at: now(), listId: newList };
  contacts.clear(); broadcast();
  await saveRootNow();
  await closing;
  fs.recursiveDelete(listCol(oldList)).catch(e=>console.error("delete old list", e));
  res.json({ ok:true, reps: reps.length });
}));
app.post("/api/admin/clear-contacts", admin, wrap(async (req,res)=>{
  const oldList = listId();
  S.roster = { ...S.roster, at: now(), listId: "l" + now().toString(36) + crypto.randomBytes(2).toString("hex") };
  contacts.clear(); broadcast();
  await saveRootNow();
  fs.recursiveDelete(listCol(oldList)).catch(e=>console.error("delete old list", e));
  res.json({ ok:true });
}));
app.post("/api/admin/release", admin, (req,res)=>{
  delete S.bindings[req.body?.slug]; saveRoot(); broadcast(); res.json({ ok:true });
});
app.post("/api/admin/player", admin, (req,res)=>{
  const name = String(req.body?.name||"").trim().slice(0,80);
  if (!name) return fail(res, 400, "Type a name.");
  const slug = freshSlug(name);
  S.roster = { ...S.roster, reps: [...S.roster.reps, { slug, name }], at: now() };
  saveRoot(); broadcast(); res.json({ ok:true });
});
app.delete("/api/admin/player/:slug", admin, wrap(async (req,res)=>{
  const slug = req.params.slug;
  if (!repOf(slug)) return fail(res, 404, "No such player.");
  await persist(tx=>tx.delete(listRef(listId(), slug)));
  S.roster = { ...S.roster, reps: S.roster.reps.filter(r=>r.slug!==slug), at: now() };
  delete S.bindings[slug]; contacts.delete(`${listId()}/${slug}`);
  saveRoot(); broadcast(); res.json({ ok:true });
}));
app.delete("/api/admin/round/:id", admin, wrap(async (req,res)=>{
  const id = req.params.id;
  if (!/^r[0-9a-z]+$/.test(id)) return fail(res, 400, "Bad round id.");
  if (R?.id===id && R.meta?.status==="live") return fail(res, 409, "End this block before deleting it.");
  if (retired) return fail(res, 503, "The game was just updated. Try again.");
  unsaved.delete(id);
  await saving.get(id);                            // let an in-flight save land first, so it can't resurrect the round
  await fs.recursiveDelete(roundRef(id));          // only ever under callblockconquest/main/rounds
  if (R?.id===id) { R = emptyRound(newRoundId()); S.game = { status:"lobby", round:R.id, startAt:0, endAt:0 }; saveRoot(); broadcast(); }
  res.json({ ok:true });
}));

app.use((err, req, res, next)=>{
  if (err instanceof Retired) return fail(res, 503, "The game was just updated. Try again.");
  console.error(err); fail(res, 500, "Couldn't save. Try again.");
});

await load();
const server = app.listen(PORT, ()=> console.log(`listening on ${PORT}`));
// Cloud Run stops idle instances with SIGTERM: write pending changes before exiting
// (persist() skips this if a newer instance already owns the game).
process.on("SIGTERM", async ()=>{
  clearTimeout(rootTimer);
  try { await persist(tx=>tx.set(ROOT, S)); await flushRound(); await flushUnsaved(); }
  catch(e){ if (!(e instanceof Retired)) console.error("shutdown save", e); }
  for (const res of clients) res.end();
  server.close(()=> process.exit(0));
  setTimeout(()=> process.exit(0), 5000).unref();
});
