// In-memory stand-in for the slice of the Firestore API that server.js uses.
// Local development only (CBC_MEMORY=1): data is lost when the process stops.
export class MemFirestore {
  constructor(){ this.docs = new Map(); }   // full path -> data
  collection(p){ return new Col(this, p); }
  doc(p){ return new Doc(this, p); }
  async recursiveDelete(ref){ for (const k of [...this.docs.keys()]) if (k===ref.path || k.startsWith(ref.path+"/")) this.docs.delete(k); }
}
const clone = v => v===undefined ? undefined : JSON.parse(JSON.stringify(v));
const get = (o, path) => path.split(".").reduce((a,k)=>a?.[k], o);

class Doc {
  constructor(db, path){ this.db=db; this.path=path; this.id=path.split("/").pop(); }
  collection(name){ return new Col(this.db, `${this.path}/${name}`); }
  async get(){ const d=this.db.docs.get(this.path); return snap(this, d); }
  async set(data, opts){
    const prev = opts?.merge ? (this.db.docs.get(this.path) || {}) : {};
    this.db.docs.set(this.path, clone({ ...prev, ...data }));
  }
  async delete(){ this.db.docs.delete(this.path); }
}
class Col {
  constructor(db, path, filters=[]){ this.db=db; this.path=path; this.filters=filters; }
  doc(id){ return new Doc(this.db, `${this.path}/${id}`); }
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
