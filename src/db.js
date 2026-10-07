// Conexão com o MongoDB Atlas e criação dos índices (idempotente).
const { MongoClient } = require('mongodb');

let client;
let db;

async function conectar(uri = process.env.MONGODB_URI, nomeBanco = process.env.MONGODB_DB || 'radar') {
  if (db) return db;
  if (!uri) throw new Error('MONGODB_URI não definida');
  client = new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 15000 });
  await client.connect();
  db = client.db(nomeBanco);
  await criarIndices(db);
  return db;
}

async function criarIndices(d) {
  await Promise.all([
    d.collection('atestados').createIndexes([
      { key: { fonte: 1, id: 1 }, unique: true },
      { key: { frentes: 1, forca: 1 } },
      { key: { 'quantitativos.metrica': 1, 'quantitativos.valor': 1 } },
      { key: { tecnologias: 1 } },
    ]),
    d.collection('prazos').createIndexes([{ key: { fonte: 1, data: 1 } }]),
    d.collection('lacunas').createIndexes([{ key: { fonte: 1 } }]),
    d.collection('rodadas').createIndexes([{ key: { fonte: 1, geradoEm: -1 } }]),
    d.collection('pedidos').createIndexes([
      { key: { status: 1, criadoEm: 1 } },
      { key: { consumidor: 1, criadoEm: -1 } },
    ]),
    d.collection('consumidores').createIndexes([{ key: { hash: 1 }, unique: true }]),
  ]);
}

async function fechar() {
  if (client) await client.close();
  client = undefined;
  db = undefined;
}

module.exports = { conectar, fechar, getDb: () => db, getClient: () => client };
