// In-memory stand-in for the slice of the Firestore API that server.js uses.
// Local development only (CBC_MEMORY=1): data is lost when the process stops.
import fs from "node:fs";
export class MemFirestore {
  // file: optional JSON file so data survives a restart (CBC_MEMORY_FILE)
  constructor(file){
    this.file = file;
    this.docs = new Map(file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : []);
  }
  _save(){ if (this.file) fs.writeFileSync(this.file, JSON.stringify([...this.docs])); }
  collection(p){ return new Col(this, p); }
  doc(p){ return new Doc(this, p); }
  increment(n){ return { __inc: n }; }
  async runTransaction(fn){
    const writes = [];
    const tx = { get: r=>r.get(), set(r,d,o){ writes.push(()=>r.set(d,o)); return tx; }, delete(r){ writes.push(()=>r.delete()); return tx; } };
    const out = await fn(tx);
    for (const w of writes) await w();
    return out;
  }
  async recursiveDelete(ref){ for (const k of [...this.docs.keys()]) if (k===ref.path || k.startsWith(ref.path+"/")) this.docs.delete(k); this._save(); }
}
const clone = v => v===undefined ? undefined : JSON.parse(JSON.stringify(v));
const get = (o, path) => path.split(".").reduce((a,k)=>a?.[k], o);

class Doc {
  constructor(db, path){ this.db=db; this.path=path; this.id=path.split("/").pop(); }
  collection(name){ return new Col(this.db, `${this.path}/${name}`); }
  async get(){ const d=this.db.docs.get(this.path); return snap(this, d); }
  async set(data, opts){
    const prev = opts?.merge ? (this.db.docs.get(this.path) || {}) : {};
    const out = { ...prev };
    for (const [k,v] of Object.entries(data)) out[k] = v?.__inc!==undefined ? (out[k]||0) + v.__inc : v;
    this.db.docs.set(this.path, clone(out)); this.db._save();
  }
  async delete(){ this.db.docs.delete(this.path); this.db._save(); }
}
class Col {
  constructor(db, path, filters=[]){ this.db=db; this.path=path; this.filters=filters; }
  doc(id){ return new Doc(this.db, `${this.path}/${id}`); }
  select(){ return this; }
  where(field, op, val){ return new Col(this.db, this.path, [...this.filters, [field, op, val]]); }
  async listDocuments(){ return this.#own().map(([k])=>new Doc(this.db, k)); }
  async get(){
    const ok = d => this.filters.every(([f,op,v])=>{ const x=get(d,f); return x!==undefined && (op===">=" ? x>=v : op==="<=" ? x<=v : op==="==" ? x===v : false); });
    const docs = this.#own().filter(([,d])=>ok(d)).map(([k,d])=>snap(new Doc(this.db,k), d));
    return { docs, size: docs.length, empty: !docs.length };
  }
  #own(){
    const depth = this.path.split("/").length + 1;
    return [...this.db.docs.entries()].filter(([k])=>k.startsWith(this.path+"/") && k.split("/").length===depth);
  }
}
function snap(ref, d){ return { id: ref.id, ref, exists: d!==undefined, data: ()=>clone(d) }; }
