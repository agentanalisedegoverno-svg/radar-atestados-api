// Banco falso em memória para testes: implementa só o subconjunto do driver do MongoDB usado pela API,
// com a linguagem de consulta real do Mongo (via mingo). Não substitui um teste contra o Atlas.
require('mingo/init/system'); // registra todos os operadores ($unwind, $project...)
const { Query, Aggregator } = require('mingo');

const clone = (o) => (o === undefined ? o : structuredClone(o));

function aplicarProjecao(doc, projection) {
  if (!projection) return doc;
  const out = { ...doc };
  const excluir = Object.entries(projection).filter(([, v]) => v === 0).map(([k]) => k);
  const incluir = Object.entries(projection).filter(([, v]) => v === 1).map(([k]) => k);
  if (incluir.length) {
    const r = {};
    for (const k of incluir) if (k in doc) r[k] = doc[k];
    if (projection._id !== 0 && '_id' in doc) r._id = doc._id;
    return r;
  }
  excluir.forEach((k) => delete out[k]);
  return out;
}

function ordenar(docs, sort) {
  if (!sort) return docs;
  const chaves = Object.entries(sort);
  return [...docs].sort((a, b) => {
    for (const [k, dir] of chaves) {
      const va = a[k] ?? null; const vb = b[k] ?? null;
      if (va === vb) continue;
      if (va === null) return -1 * dir;
      if (vb === null) return 1 * dir;
      return (va < vb ? -1 : 1) * dir;
    }
    return 0;
  });
}

class Cursor {
  constructor(docs) { this.docs = docs; this._sort = null; this._limit = 0; }
  sort(s) { this._sort = s; return this; }
  limit(n) { this._limit = n; return this; }
  async toArray() {
    let r = ordenar(this.docs, this._sort);
    if (this._limit) r = r.slice(0, this._limit);
    return clone(r);
  }
}

class Colecao {
  constructor() { this.docs = []; this.unicos = []; }
  async createIndexes(specs) { for (const s of specs) if (s.unique) this.unicos.push(Object.keys(s.key)); }
  _filtrar(f) { const q = new Query(f || {}); return this.docs.filter((d) => q.test(d)); }
  _checaUnico(doc) {
    const chaves = [['_id'], ...this.unicos];
    for (const ks of chaves) {
      if (ks.some((k) => doc[k] === undefined)) continue;
      if (this.docs.some((d) => ks.every((k) => d[k] === doc[k]))) { const e = new Error('duplicate key'); e.code = 11000; throw e; }
    }
  }
  find(f, opts = {}) { return new Cursor(this._filtrar(f).map((d) => aplicarProjecao(d, opts.projection))); }
  async findOne(f, opts = {}) { const d = this._filtrar(f)[0]; return d ? clone(aplicarProjecao(d, opts.projection)) : null; }
  async countDocuments(f) { return this._filtrar(f).length; }
  async insertOne(doc) { const d = clone(doc); if (d._id === undefined) d._id = `${Date.now()}${Math.random()}`; this._checaUnico(d); this.docs.push(d); return { insertedId: d._id }; }
  async insertMany(docs) { for (const d of docs) await this.insertOne(d); return { insertedCount: docs.length }; }
  async deleteMany(f) { const alvo = new Set(this._filtrar(f)); this.docs = this.docs.filter((d) => !alvo.has(d)); return { deletedCount: alvo.size }; }
  _set(d, upd) { Object.assign(d, clone(upd.$set || {})); }
  async updateOne(f, upd) { const d = this._filtrar(f)[0]; if (d) this._set(d, upd); return { matchedCount: d ? 1 : 0 }; }
  async updateMany(f, upd) { const ds = this._filtrar(f); ds.forEach((d) => this._set(d, upd)); return { matchedCount: ds.length }; }
  async findOneAndUpdate(f, upd) { const d = this._filtrar(f)[0]; if (!d) return null; this._set(d, upd); return clone(d); }
  aggregate(pipeline) { const docs = this.docs; return { toArray: async () => clone(new Aggregator(pipeline).run(docs)) }; }
}

function criarBancoFalso() {
  const cols = new Map();
  return {
    collection(nome) { if (!cols.has(nome)) cols.set(nome, new Colecao()); return cols.get(nome); },
    async command() { return { ok: 1 }; },
  };
}

module.exports = { criarBancoFalso };
