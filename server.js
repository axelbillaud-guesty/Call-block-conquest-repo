// Call Block Conquest server: holds the live game in memory, enforces the rules,
// streams state to browsers, and saves everything to Firestore.
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Firestore } from "@google-cloud/firestore";
import { HEX, HEXIDX, neighbors, ptsFor, SHIELD_MS } from "./public/map.js";

const PORT = process.env.PORT || 8080;
const ADMIN_CODE = process.env.ADMIN_CODE || "";
const TZ = process.env.GAME_TZ || "Europe/Madrid";   // which calendar day a contest belongs to
const DEFAULT_REPS = ["Faïda","Carmen","Claudio","Felix","Julia","Faisal","Caitlin","Mariana","Oliver","Naod","Michael","Nicole","Laura","Justin","Gabriela","Millie"];

// ---------- storage ----------
// The project's (default) Firestore database is shared with other apps. Everything this app
// stores lives under the single document callblockconquest/main and its subcollections:
// every reference below is built from ROOT, so the app cannot read, write or delete anything else.
const fs = process.env.CBC_MEMORY==="1"
  ? new (await import("./memstore.js")).MemFirestore()
  : new Firestore({ ignoreUndefinedProperties: true });
const ROOT = fs.collection("callblockconquest").doc("main");
const roundsCol = () => ROOT.collection("rounds");
const roundRef = id => roundsCol().doc(id);
const contactsRef = slug => ROOT.collection("contacts").doc(slug);

// ---------- state ----------
let S = { game:{ status:"lobby", round:null, startAt:0, endAt:0 }, roster:{ reps:[], headers:[], fields:{}, at:0 }, bindings:{} };
let R = null;                    // current round: { id, meta, logs: Map, hexes:{}, spent:{} }
const contacts = new Map();      // slug -> rows, loaded on demand

const now = () => Date.now();
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const slugify = s => String(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,60) || "rep";
const repOf = slug => S.roster.reps.find(r=>r.slug===slug);
const isLive = () => S.game.status==="live" && now() < S.game.endAt;
const newRoundId = () => "r" + now().toString(36);
const dayOf = ms => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" }).format(ms);

function emptyRound(id){ return { id, meta:null, logs:new Map(), hexes:{}, spent:{} }; }

async function load(){
  const snap = await ROOT.get();
  if (snap.exists){
    const d = snap.data();
    S = { game: d.game || S.game, roster: d.roster || S.roster, bindings: d.bindings || {} };
  } else {
    S.roster = { reps: DEFAULT_REPS.map(name=>({ slug: slugify(name), name })), headers:[], fields:{}, at: now() };
    S.game = { status:"lobby", round:newRoundId(), startAt:0, endAt:0 };
    await ROOT.set(S);
  }
  R = emptyRound(S.game.round);
  if (S.game.round){
    const rs = await roundRef(S.game.round).get();
    if (rs.exists){ const d=rs.data(); R.meta = d.meta || null; R.hexes = d.hexes || {}; R.spent = d.spent || {}; }
    const ls = await roundRef(S.game.round).collection("logs").get();
    for (const doc of ls.docs) R.logs.set(doc.id, doc.data());
  }
  console.log(`loaded: round ${S.game.round} (${S.game.status}), ${R.logs.size} logs, ${Object.keys(R.hexes).length} hexes`);
}

// Debounced writes: the root doc and the round doc change often during play.
let rootTimer=null, roundTimer=null;
function saveRoot(){ clearTimeout(rootTimer); rootTimer=setTimeout(()=>ROOT.set(S).catch(e=>console.error("saveRoot", e)), 300); }
function saveRound(){
  if (!R?.meta) return;            // rounds are stored once they have started
  const r = R; clearTimeout(roundTimer);
  roundTimer=setTimeout(()=>roundRef(r.id).set({ meta:r.meta, hexes:r.hexes, spent:r.spent }, { merge:true }).catch(e=>console.error("saveRound", e)), 800);
}
async function flushRound(){
  clearTimeout(roundTimer);
  if (R?.meta) await roundRef(R.id).set({ meta:R.meta, hexes:R.hexes, spent:R.spent }, { merge:true });
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
function territory(slug){ let n=0; for (const h of Object.values(R.hexes)) if (h.o===slug) n++; return n; }

// Close out the current round: freeze it and store its final standings for History.
async function finalize(endAt = Math.min(now(), S.game.endAt || now())){
  if (!R?.meta || R.meta.status==="done") return;
  R.meta.endAt = endAt; R.meta.status = "done";
  const summary = summarize(R);
  await flushRound();
  await roundRef(R.id).set({ summary }, { merge:true });
}
setInterval(()=>{ if (S.game.status==="live" && now()>=S.game.endAt && R?.meta?.status==="live") finalize(S.game.endAt).then(broadcast).catch(e=>console.error("finalize", e)); }, 2000);

// ---------- live updates (server-sent events) ----------
const clients = new Set();
function publicState(){
  return {
    now: now(), game: S.game, roster: S.roster,
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
function me(req){
  const t = req.get("x-player"); if (!t) return null;
  const h = sha(t);
  for (const [slug, b] of Object.entries(S.bindings)) if (b.h===h) return slug;
  return null;
}
function adminOk(req){
  const c = req.get("x-admin") || "";
  if (!ADMIN_CODE || c.length!==ADMIN_CODE.length) return false;
  return crypto.timingSafeEqual(Buffer.from(c), Buffer.from(ADMIN_CODE));
}
const admin = (req,res,next) => adminOk(req) ? next() : fail(res, 401, "Wrong admin code.");
const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);

app.get("/api/events", (req,res)=>{
  res.set({ "Content-Type":"text/event-stream", "Cache-Control":"no-cache, no-transform", "Connection":"keep-alive", "X-Accel-Buffering":"no" });
  res.flushHeaders();
  res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
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
  if (!contacts.has(slug)){ const s = await contactsRef(slug).get(); contacts.set(slug, s.exists ? (s.data().rows||[]) : []); }
  return contacts.get(slug);
}

app.post("/api/log", wrap(async (req,res)=>{
  const slug = me(req); if (!slug) return fail(res, 403, "Pick your name first.");
  const { cid } = req.body || {};
  const c = !!req.body?.c, p = c && !!req.body?.p, m = c && !!req.body?.m;
  const rows = await contactsOf(slug);
  if (!rows.some(x=>x.cid===cid)) return fail(res, 404, "That account isn't on your list.");
  if (!isLive()) return fail(res, 409, "The block isn't running.");
  const prev = R.logs.get(cid);
  if (prev?.c) return fail(res, 409, "This call is already logged.");
  const log = { rep: slug, c, p: p||m, m, pts: ptsFor(c, p||m, m), n: (prev?.n||0)+1, at: now() };
  R.logs.set(cid, log);
  const rid = R.id;
  broadcast();
  await roundRef(rid).collection("logs").doc(cid).set(log);
  res.json({ ok:true, log, gain: log.pts - (prev?.pts||0) });
}));

app.post("/api/claim", (req,res)=>{
  const slug = me(req); if (!slug) return fail(res, 403, "Pick your name first.");
  const id = req.body?.hex;
  if (!HEXIDX.has(id)) return fail(res, 404, "Not a hex.");
  if (!isLive()) return fail(res, 409, "The block isn't running.");
  const h = R.hexes[id];
  if (h?.o===slug) return fail(res, 409, "Already yours.");
  if (earned(slug) - (R.spent[slug]||0) < 1) return fail(res, 409, "Log calls to earn points.");
  if (h && now()-h.t < SHIELD_MS) return fail(res, 409, "Shielded. Someone just took it.");
  if (territory(slug)===0){
    if (h && HEX.some(x=>!R.hexes[x.id])) return fail(res, 409, "Start on a free hex.");
  } else if (!neighbors(HEX[HEXIDX.get(id)]).some(n=>R.hexes[n]?.o===slug)) {
    return fail(res, 409, "Must touch your territory.");
  }
  R.hexes[id] = { o: slug, t: now() };
  R.spent[slug] = (R.spent[slug]||0) + 1;
  saveRound(); broadcast();
  res.json({ ok:true });
});

// History: one entry per contest that was started, with its final standings.
app.get("/api/history", wrap(async (req,res)=>{
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = day.test(req.query.from) ? req.query.from : "0000-00-00";
  const to = day.test(req.query.to) ? req.query.to : "9999-99-99";
  const snap = await roundsCol().where("meta.date", ">=", from).where("meta.date", "<=", to).get();
  const out = snap.docs.map(d=>{
    const x = d.data();
    const summary = (R?.id===d.id && R.meta?.status==="live") ? summarize(R) : x.summary;
    return { id:d.id, ...x.meta, ...(R?.id===d.id && R.meta ? R.meta : {}), summary: summary || { rows:[], winner:null } };
  }).sort((a,b)=> b.startAt - a.startAt);
  res.json({ rounds: out, tz: TZ });
}));

// ---------- admin ----------
app.post("/api/admin/check", admin, (req,res)=> res.json({ ok:true }));

app.post("/api/admin/start", admin, wrap(async (req,res)=>{
  const mins = Math.max(5, Math.min(240, Math.round(+req.body?.mins || 60)));
  if (R?.meta) { await finalize(); R = emptyRound(newRoundId()); }          // a started round becomes history
  const t = now();
  S.game = { status:"live", round:R.id, startAt:t, endAt:t+mins*60000 };
  R.meta = { date: dayOf(t), startAt:t, endAt:S.game.endAt, mins, status:"live", reps: S.roster.reps.map(({slug,name})=>({slug,name})) };
  await flushRound(); saveRoot(); broadcast();
  res.json({ ok:true });
}));
app.post("/api/admin/end", admin, wrap(async (req,res)=>{
  if (!isLive()) return fail(res, 409, "The block isn't running.");
  S.game = { ...S.game, endAt: now() };
  await finalize(S.game.endAt); saveRoot(); broadcast();
  res.json({ ok:true });
}));
app.post("/api/admin/reset", admin, wrap(async (req,res)=>{
  if (R?.meta) await finalize();
  S.game = { status:"lobby", round:newRoundId(), startAt:0, endAt:0 };
  R = emptyRound(S.game.round);
  saveRoot(); broadcast();
  res.json({ ok:true });
}));

// Replace the call list. Rows are grouped by rep in the browser (CSV parsed there).
app.post("/api/admin/import", admin, wrap(async (req,res)=>{
  const { headers, fields, groups } = req.body || {};
  if (!Array.isArray(groups) || !Array.isArray(headers)) return fail(res, 400, "Bad import.");
  const reps = [], seen = new Set();
  for (const g of groups){
    const name = String(g.name||"").trim().slice(0,80); if (!name) continue;
    let slug = repOf(g.slug)?.slug || slugify(name);
    while (seen.has(slug)) slug += "-2";
    seen.add(slug);
    const rows = (g.rows||[]).slice(0,2000).map((r,i)=>({ cid:`${slug}--${i}`, row:r }));
    if (Buffer.byteLength(JSON.stringify(rows)) > 900_000) return fail(res, 413, `${name}'s list is too big to store (shorten long note columns).`);
    reps.push({ slug, name, rows });
  }
  if (R?.meta) await finalize();
  const old = await ROOT.collection("contacts").listDocuments();
  for (const d of old) if (!seen.has(d.id)) await d.delete();
  for (const r of reps) await contactsRef(r.slug).set({ rows: r.rows });
  contacts.clear();
  for (const slug of Object.keys(S.bindings)) if (!seen.has(slug)) delete S.bindings[slug];
  S.roster = { reps: reps.map(({slug,name})=>({slug,name})), headers: headers.map(String).slice(0,200), fields: fields||{}, at: now() };
  S.game = { status:"lobby", round:newRoundId(), startAt:0, endAt:0 };
  R = emptyRound(S.game.round);
  saveRoot(); broadcast();
  res.json({ ok:true, reps: reps.length });
}));
app.post("/api/admin/clear-contacts", admin, wrap(async (req,res)=>{
  for (const d of await ROOT.collection("contacts").listDocuments()) await d.delete();
  contacts.clear(); S.roster = { ...S.roster, at: now() }; saveRoot(); broadcast();
  res.json({ ok:true });
}));
app.post("/api/admin/release", admin, (req,res)=>{
  delete S.bindings[req.body?.slug]; saveRoot(); broadcast(); res.json({ ok:true });
});
app.post("/api/admin/player", admin, (req,res)=>{
  const name = String(req.body?.name||"").trim().slice(0,80);
  if (!name) return fail(res, 400, "Type a name.");
  let slug = slugify(name); while (repOf(slug)) slug += "-2";
  S.roster = { ...S.roster, reps: [...S.roster.reps, { slug, name }], at: now() };
  saveRoot(); broadcast(); res.json({ ok:true });
});
app.delete("/api/admin/player/:slug", admin, wrap(async (req,res)=>{
  const slug = req.params.slug;
  if (!repOf(slug)) return fail(res, 404, "No such player.");
  S.roster = { ...S.roster, reps: S.roster.reps.filter(r=>r.slug!==slug), at: now() };
  delete S.bindings[slug];
  await contactsRef(slug).delete(); contacts.delete(slug);
  saveRoot(); broadcast(); res.json({ ok:true });
}));
app.delete("/api/admin/round/:id", admin, wrap(async (req,res)=>{
  const id = req.params.id;
  if (!/^r[0-9a-z]+$/.test(id)) return fail(res, 400, "Bad round id.");
  if (R?.id===id && R.meta?.status==="live") return fail(res, 409, "End this block before deleting it.");
  await fs.recursiveDelete(roundRef(id));          // only ever under callblockconquest/main/rounds
  if (R?.id===id) { R = emptyRound(newRoundId()); S.game = { status:"lobby", round:R.id, startAt:0, endAt:0 }; saveRoot(); broadcast(); }
  res.json({ ok:true });
}));

app.use((err, req, res, next)=>{ console.error(err); fail(res, 500, "Server error. Try again."); });

await load();
const server = app.listen(PORT, ()=> console.log(`listening on ${PORT}`));
// Cloud Run stops idle instances with SIGTERM: write pending changes before exiting.
process.on("SIGTERM", async ()=>{
  clearTimeout(rootTimer);
  try { await ROOT.set(S); await flushRound(); } catch(e){ console.error("shutdown save", e); }
  for (const res of clients) res.end();
  server.close(()=> process.exit(0));
  setTimeout(()=> process.exit(0), 5000).unref();
});
