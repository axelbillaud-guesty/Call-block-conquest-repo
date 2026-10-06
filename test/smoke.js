// End-to-end smoke test: starts the server on the in-memory store and plays a short game.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { HEX, HEXIDX, neighbors } from "../public/map.js";

const PORT = 3999, BASE = `http://127.0.0.1:${PORT}`, ADMIN = "test-code";
const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, CBC_MEMORY:"1", ADMIN_CODE:ADMIN, PORT:String(PORT) }, stdio:["ignore","pipe","inherit"] });
await new Promise(r => srv.stdout.on("data", d => String(d).includes("listening") && r()));

async function call(path, { body, method, player, admin } = {}){
  const headers = { "Content-Type":"application/json" };
  if (player) headers["x-player"] = player;
  if (admin) headers["x-admin"] = admin;
  const r = await fetch(BASE+path, { method: method || (body!==undefined?"POST":"GET"), headers, body: body!==undefined?JSON.stringify(body):undefined });
  return { status: r.status, json: await r.json().catch(()=>({})) };
}
async function state(){
  const r = await fetch(BASE+"/api/events"); const reader = r.body.getReader(); let buf = "";
  while (!buf.includes("\n\n")) buf += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  return JSON.parse(buf.split("data: ")[1].split("\n")[0]);
}
const wait = ms => new Promise(r=>setTimeout(r, ms));
let ok = 0; const t = (name, fn) => fn().then(()=>{ ok++; console.log("  ✓", name); });

try {
  await t("seeds the 16 BDRs", async ()=>{
    const s = await state();
    assert.equal(s.roster.reps.length, 16);
    assert.ok(s.roster.reps.some(r=>r.name==="Faïda" && r.slug==="faida"));
    assert.ok(s.roster.reps.some(r=>r.name==="Millie"));
  });
  await t("admin endpoints need the code", async ()=>{
    assert.equal((await call("/api/admin/start", { body:{ mins:30 } })).status, 401);
    assert.equal((await call("/api/admin/start", { body:{ mins:30 }, admin:"nope" })).status, 401);
    assert.equal((await call("/api/admin/check", { body:{}, admin:ADMIN })).status, 200);
  });

  let carmen, julia;
  await t("picking a name; a taken name needs takeover", async ()=>{
    carmen = (await call("/api/pick", { body:{ slug:"carmen" } })).json;
    assert.ok(carmen.token);
    const again = await call("/api/pick", { body:{ slug:"carmen" } });
    assert.equal(again.status, 409);
    const take = await call("/api/pick", { body:{ slug:"carmen", takeover:true } });
    assert.equal(take.status, 200);
    assert.equal((await call("/api/contacts", { player: carmen.token })).status, 403, "old browser lost the name");
    carmen = take.json;
    julia = (await call("/api/pick", { body:{ slug:"julia" } })).json;
  });

  await t("import routes accounts by first name", async ()=>{
    const r = await call("/api/admin/import", { admin:ADMIN, body:{ headers:["Company","Phone"], fields:{ company:"Company", phone:"Phone" }, groups:[
      { slug:"carmen", name:"Carmen", rows:[{ Company:"Acme" },{ Company:"Beta" },{ Company:"Gamma" }] },
      { slug:"julia", name:"Julia", rows:[{ Company:"Delta" }] },
      { slug:null, name:"Newbie Person", rows:[{ Company:"Zeta" }] },
    ] } });
    assert.equal(r.status, 200);
    const s = await state();
    assert.equal(s.roster.reps.length, 3);
    const c = await call("/api/contacts", { player: carmen.token });
    assert.deepEqual(c.json.rows.map(x=>x.cid), ["carmen--0","carmen--1","carmen--2"]);
  });

  await t("nothing scores before the block starts", async ()=>{
    assert.equal((await call("/api/log", { player:carmen.token, body:{ cid:"carmen--0", c:true, p:true, m:true } })).status, 409);
  });
  await t("start the block", async ()=>{
    assert.equal((await call("/api/admin/start", { admin:ADMIN, body:{ mins:30 } })).status, 200);
    assert.equal((await state()).game.status, "live");
  });

  await t("logging calls: points, retries, locks, ownership", async ()=>{
    let r = await call("/api/log", { player:carmen.token, body:{ cid:"carmen--0", c:true, p:true, m:true } });
    assert.equal(r.json.log.pts, 26);
    assert.equal((await call("/api/log", { player:carmen.token, body:{ cid:"carmen--0", c:false } })).status, 409, "connected call is locked");
    r = await call("/api/log", { player:carmen.token, body:{ cid:"carmen--1", c:false, p:true, m:true } });
    assert.equal(r.json.log.pts, 1, "no answer can't carry positive/meeting");
    r = await call("/api/log", { player:carmen.token, body:{ cid:"carmen--1", c:true, p:false, m:false } });
    assert.equal(r.json.gain, 0, "retry pays only the difference");
    assert.equal((await call("/api/log", { player:carmen.token, body:{ cid:"julia--0", c:true } })).status, 404, "can't log someone else's account");
    assert.equal((await call("/api/log", { body:{ cid:"carmen--2", c:true } })).status, 403, "need a name");
  });

  const start = HEX[Math.floor(HEX.length/2)].id;
  const far = HEX[0].id;
  await t("claiming: first hex anywhere free, then adjacency, then balance", async ()=>{
    assert.equal((await call("/api/claim", { player:julia.token, body:{ hex:start } })).status, 409, "julia has no points");
    assert.equal((await call("/api/claim", { player:carmen.token, body:{ hex:start } })).status, 200);
    assert.equal((await call("/api/claim", { player:carmen.token, body:{ hex:start } })).status, 409, "already yours");
    assert.equal((await call("/api/claim", { player:carmen.token, body:{ hex:far } })).status, 409, "not adjacent");
    const nb = neighbors(HEX[HEXIDX.get(start)]);
    for (const id of nb) assert.equal((await call("/api/claim", { player:carmen.token, body:{ hex:id } })).status, 200);
    const s = await state();
    assert.equal(s.round.spent.carmen, 1 + nb.length);
    assert.equal(Object.values(s.round.hexes).filter(h=>h.o==="carmen").length, 1 + nb.length);
  });
  await t("balance runs out", async ()=>{
    // carmen earned 27 (26 + 1); spend the rest and expect a refusal
    let s = await state(), spent = s.round.spent.carmen, frontier = Object.keys(s.round.hexes);
    while (spent < 27){
      const id = HEX.find(h=>!s.round.hexes[h.id] && neighbors(h).some(n=>s.round.hexes[n]?.o==="carmen")).id;
      assert.equal((await call("/api/claim", { player:carmen.token, body:{ hex:id } })).status, 200);
      s.round.hexes[id] = { o:"carmen" }; spent++;
    }
    const next = HEX.find(h=>!s.round.hexes[h.id] && neighbors(h).some(n=>s.round.hexes[n]?.o==="carmen")).id;
    const r = await call("/api/claim", { player:carmen.token, body:{ hex:next } });
    assert.equal(r.status, 409); assert.match(r.json.error, /earn points/);
  });
  await t("shield blocks stealing a fresh hex", async ()=>{
    await call("/api/log", { player:julia.token, body:{ cid:"julia--0", c:true, p:true, m:false } });
    const s = await state();
    const target = Object.keys(s.round.hexes)[0];
    const r = await call("/api/claim", { player:julia.token, body:{ hex:target } });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /free hex|Shielded/);
  });

  await t("admin code with non-ASCII characters is a clean 401", async ()=>{
    assert.equal((await call("/api/admin/check", { body:{}, admin:"test-codé" })).status, 401);
  });
  await t("an oversized import is refused without ending the live block", async ()=>{
    const rows = Array.from({ length:5001 }, (_,i)=>({ Company:`C${i}` }));
    const r = await call("/api/admin/import", { admin:ADMIN, body:{ headers:["Company"], fields:{}, groups:[{ slug:"carmen", name:"Carmen", rows }] } });
    assert.equal(r.status, 413);
    const s = await state();
    assert.equal(s.game.status, "live"); assert.ok(s.game.endAt > Date.now());
    assert.ok(Object.keys(s.round.hexes).length > 0, "map untouched");
  });
  let roundId;
  await t("end the block → contest saved to History with standings", async ()=>{
    roundId = (await state()).round.id;
    assert.equal((await call("/api/admin/end", { admin:ADMIN, body:{} })).status, 200);
    assert.equal((await call("/api/claim", { player:carmen.token, body:{ hex:far } })).status, 409, "no play after the end");
    await wait(50);
    const h = (await call("/api/history")).json.rounds;
    assert.equal(h.length, 1);
    assert.equal(h[0].status, "done");
    assert.equal(h[0].summary.winner, "carmen");
    const c = h[0].summary.rows.find(x=>x.slug==="carmen");
    assert.equal(c.pts, 27); assert.equal(c.dials, 2); assert.equal(c.demos, 1); assert.equal(c.hexes, 27);
  });
  await t("a second contest keeps the first in History", async ()=>{
    await call("/api/admin/start", { admin:ADMIN, body:{ mins:10 } });
    const s = await state();
    assert.notEqual(s.round.id, roundId);
    assert.equal(Object.keys(s.round.hexes).length, 0, "fresh map");
    const h = (await call("/api/history")).json.rounds;
    assert.equal(h.length, 2);
    const today = h[0].date;
    assert.equal((await call(`/api/history?from=${today}&to=${today}`)).json.rounds.length, 2);
    assert.equal((await call(`/api/history?from=1999-01-01&to=1999-12-31`)).json.rounds.length, 0);
  });
  await t("admin: delete a past contest, release and remove players, clear list", async ()=>{
    assert.equal((await call(`/api/admin/round/${(await state()).round.id}`, { method:"DELETE", admin:ADMIN })).status, 409, "can't delete the live one");
    assert.equal((await call(`/api/admin/round/${roundId}`, { method:"DELETE", admin:ADMIN })).status, 200);
    assert.equal((await call("/api/history")).json.rounds.length, 1);
    await call("/api/admin/release", { admin:ADMIN, body:{ slug:"julia" } });
    assert.equal((await call("/api/contacts", { player: julia.token })).status, 403);
    await call("/api/admin/player", { admin:ADMIN, body:{ name:"Oliver" } });
    assert.ok((await state()).roster.reps.some(r=>r.name==="Oliver"));
    await call("/api/admin/player/newbie-person", { method:"DELETE", admin:ADMIN });
    assert.ok(!(await state()).roster.reps.some(r=>r.slug==="newbie-person"));
    await call("/api/admin/clear-contacts", { admin:ADMIN, body:{} });
    assert.equal((await call("/api/contacts", { player: carmen.token })).json.rows.length, 0);
  });
  await t("a removed player re-added mid-round starts clean", async ()=>{
    await call("/api/admin/import", { admin:ADMIN, body:{ headers:["Company"], fields:{ company:"Company" }, groups:[
      { slug:"carmen", name:"Carmen", rows:[{ Company:"Acme" }] }, { slug:"julia", name:"Julia", rows:[{ Company:"Delta" }] } ] } });
    await call("/api/admin/start", { admin:ADMIN, body:{ mins:10 } });
    carmen = (await call("/api/pick", { body:{ slug:"carmen", takeover:true } })).json;
    assert.equal((await call("/api/log", { player:carmen.token, body:{ cid:"carmen--0", c:true, p:true } })).status, 200);
    await call("/api/admin/player/carmen", { method:"DELETE", admin:ADMIN });
    await call("/api/admin/player", { admin:ADMIN, body:{ name:"Carmen" } });
    const s = await state();
    const fresh = s.roster.reps.find(r=>r.name==="Carmen");
    assert.equal(fresh.slug, "carmen-2");
    assert.ok(!s.round.logs.some(([,l])=>l.rep===fresh.slug), "no inherited calls");
    assert.ok(s.round.logs.some(([,l])=>l.rep==="carmen"), "old play stays with the old player");
  });
  await t("serves the page and map module", async ()=>{
    const html = await (await fetch(BASE+"/")).text();
    assert.match(html, /Call Block Conquest/);
    assert.equal((await fetch(BASE+"/map.js")).status, 200);
  });
  console.log(`\n${ok} checks passed`);
} catch (e) {
  console.error("\nFAILED:", e.message); process.exitCode = 1;
} finally { srv.kill(); }
