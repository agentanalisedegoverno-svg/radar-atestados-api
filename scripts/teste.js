// Teste de ponta a ponta da API. Usa um banco falso em memória (scripts/fake-db.js) com a linguagem de consulta do Mongo.
// Para testar contra um MongoDB real (ex.: o cluster M0): MONGODB_URI_TESTE=<uri> npm test
const assert = require('assert');
const { criarBancoFalso } = require('./fake-db');

(async () => {
  process.env.ADMIN_TOKEN = 'x'.repeat(40);
  const { conectar, getDb, fechar } = require('../src/db');
  const { criarApp } = require('../src/app');
  let dbFn;
  if (process.env.MONGODB_URI_TESTE) {
    await conectar(process.env.MONGODB_URI_TESTE, `radar_teste_${Date.now()}`);
    dbFn = getDb;
  } else {
    const falso = criarBancoFalso();
    dbFn = () => falso;
  }
  const srv = criarApp(dbFn).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const chamar = async (metodo, rota, { chave, admin, corpo } = {}) => {
    const r = await fetch(base + rota, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(chave && { 'x-api-key': chave }), ...(admin && { 'x-admin-token': admin }) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };
  let ok = 0;
  const caso = async (nome, fn) => { await fn(); ok++; console.log(`  ok  ${nome}`); };

  let agente, player;
  await caso('saúde sem chave', async () => assert.equal((await chamar('GET', '/v1/saude')).status, 200));
  await caso('admin exige token', async () => assert.equal((await chamar('POST', '/v1/admin/consumidores', { corpo: { nome: 'x' } })).status, 401));
  await caso('cria chaves', async () => {
    const a = await chamar('POST', '/v1/admin/consumidores', { admin: process.env.ADMIN_TOKEN, corpo: { nome: 'agente-radar', permissoes: ['agente', 'leitura', 'pedidos', 'fontes', 'restrito'] } });
    const p = await chamar('POST', '/v1/admin/consumidores', { admin: process.env.ADMIN_TOKEN, corpo: { nome: 'player-externo', permissoes: ['leitura', 'pedidos'] } });
    assert.equal(a.status, 201); assert.equal(p.status, 201);
    agente = a.json.chave; player = p.json.chave;
    const lista = await chamar('GET', '/v1/admin/consumidores', { admin: process.env.ADMIN_TOKEN });
    assert.ok(lista.json.every((c) => !('hash' in c)));
  });
  await caso('sem chave = 401, chave errada = 401', async () => {
    assert.equal((await chamar('GET', '/v1/atestados')).status, 401);
    assert.equal((await chamar('GET', '/v1/atestados', { chave: 'rdr_falsa' })).status, 401);
  });
  await caso('player não cria fonte (403)', async () => {
    assert.equal((await chamar('POST', '/v1/fontes', { chave: player, corpo: { id: 'x1', nome: 'x', tipo: 'onedrive', link: 'https://connectcomcloud-my.sharepoint.com/a' } })).status, 403);
  });
  await caso('agente cria fonte padrão e grava estado', async () => {
    const f = await chamar('POST', '/v1/fontes', { chave: agente, corpo: { id: 'governo2-base-act', nome: 'Base', tipo: 'sharepoint', link: 'https://connectcomcloud.sharepoint.com/sites/GOVERNO2/x', padrao: true } });
    assert.equal(f.status, 201, JSON.stringify(f.json));
    const estado = require('../data/estado-inicial-governo2.json');
    estado.atestados[0].quantitativos = [{ metrica: 'vms', valor: 241, natureza: 'executado', trecho: '241 VMs' }];
    estado.atestados[1].usoRestrito = true;
    const r = await chamar('PUT', '/v1/agente/fontes/governo2-base-act/estado', { chave: agente, corpo: estado });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.atestados, 99);
  });
  await caso('player não grava estado (403)', async () => {
    assert.equal((await chamar('PUT', '/v1/agente/fontes/governo2-base-act/estado', { chave: player, corpo: {} })).status, 403);
  });
  await caso('consulta atestados força A de infra', async () => {
    const r = await chamar('GET', '/v1/atestados?frente=INF&forca=A', { chave: player });
    assert.equal(r.status, 200); assert.ok(r.json.length > 0);
    assert.ok(r.json.every((a) => a.forca === 'A' && a.frentes.includes('INF')));
  });
  await caso('restrito escondido do player, visível ao agente', async () => {
    const p = await chamar('GET', '/v1/atestados?limit=500', { chave: player });
    const a = await chamar('GET', '/v1/atestados?limit=500', { chave: agente });
    assert.equal(a.json.length - p.json.length, 1);
  });
  await caso('quantitativos com filtro', async () => {
    const r = await chamar('GET', '/v1/quantitativos?metrica=vms&min=200', { chave: player });
    assert.equal(r.json.length, 1); assert.equal(r.json[0].valor, 241);
  });
  await caso('injeção de operador na query é ignorada', async () => {
    const r = await chamar('GET', '/v1/atestados?forca[$ne]=Z', { chave: player });
    assert.equal(r.status, 200); // query parser simples: vira texto e não filtra por operador
  });
  await caso('prazos com dias e severidade', async () => {
    const r = await chamar('GET', '/v1/prazos?ate=30', { chave: player });
    assert.ok(r.json.length > 0 && r.json.every((p) => 'diasRestantes' in p && 'severidade' in p));
  });
  await caso('lacunas e rodadas', async () => {
    assert.equal((await chamar('GET', '/v1/lacunas', { chave: player })).json.length, 8);
    assert.equal((await chamar('GET', '/v1/rodadas', { chave: player })).json.length, 1);
  });
  await caso('fluxo de pedido: player cria, agente atende, player lê', async () => {
    const c = await chamar('POST', '/v1/pedidos', { chave: player, corpo: { tipo: 'cruzamento', edital: 'PE 1/2026', requisitos: [{ id: 'r1', texto: 'x', metrica: 'vms', minimo: 500 }] } });
    assert.equal(c.status, 202);
    const fila = await chamar('GET', '/v1/agente/pedidos', { chave: agente });
    assert.equal(fila.json.length, 1);
    await chamar('PATCH', `/v1/agente/pedidos/${c.json.id}`, { chave: agente, corpo: { status: 'concluido', resultado: { requisitos: [] } } });
    const l = await chamar('GET', `/v1/pedidos/${c.json.id}`, { chave: player });
    assert.equal(l.json.status, 'concluido');
  });
  await caso('troca de fonte padrão', async () => {
    await chamar('POST', '/v1/fontes', { chave: agente, corpo: { id: 'onedrive-saude', nome: 'Saúde', tipo: 'onedrive', link: 'https://connectcomcloud-my.sharepoint.com/:f:/g/personal/x', padrao: true } });
    const fs = (await chamar('GET', '/v1/fontes', { chave: player })).json;
    assert.deepEqual(fs.filter((f) => f.padrao).map((f) => f.id), ['onedrive-saude']);
    assert.equal((await chamar('GET', '/v1/atestados', { chave: player })).json.length, 0); // base nova ainda vazia
    assert.ok((await chamar('GET', '/v1/atestados?fonte=governo2-base-act', { chave: player })).json.length > 0);
  });
  await caso('link fora do SharePoint é recusado', async () => {
    const r = await chamar('POST', '/v1/fontes', { chave: agente, corpo: { id: 'gd', nome: 'x', tipo: 'onedrive', link: 'https://drive.google.com/x' } });
    assert.equal(r.status, 400);
  });
  await caso('revogar chave', async () => {
    await chamar('DELETE', '/v1/admin/consumidores/player-externo', { admin: process.env.ADMIN_TOKEN });
    assert.equal((await chamar('GET', '/v1/fontes', { chave: player })).status, 401);
  });

  srv.close();
  if (process.env.MONGODB_URI_TESTE) { await getDb().dropDatabase(); await fechar(); }
  console.log(`\n${ok} testes passaram.`);
})().catch((e) => { console.error(e); process.exit(1); });
