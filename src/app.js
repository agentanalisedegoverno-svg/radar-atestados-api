// API do Radar de Atestados CTC — v1.
// Consumidores leem o acervo e criam pedidos; só a chave do agente grava o estado analisado.
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { PERMISSOES, hashChave, gerarChave, exigir, exigirAdmin } = require('./auth');

const VERSAO_ESQUEMA = '1.0';
const FORCAS = ['A', 'B', 'C', '?'];
const ESFERAS = ['federal', 'estatal', 'estadual', 'privado', 'nao_identificado'];
const TIPOS_FONTE = ['sharepoint', 'onedrive'];
const TIPOS_PEDIDO = ['cruzamento', 'indexacao'];
const STATUS_PEDIDO = ['na_fila', 'processando', 'concluido', 'erro'];
const STATUS_FONTE = ['aguardando_leitura', 'pronta', 'sem_acesso', 'link_invalido'];
const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

// ---------- utilitários ----------
class ErroEntrada extends Error {
  constructor(msg) { super(msg); this.status = 400; }
}
const texto = (v, max = 500) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ErroEntrada('Valor de texto inválido.');
  const s = v.trim();
  if (s.length > max) throw new ErroEntrada(`Texto acima de ${max} caracteres.`);
  return s;
};
const numero = (v, nome) => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ErroEntrada(`Parâmetro ${nome} precisa ser numérico.`);
  return n;
};
const lista = (v, max = 50) => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || x.length > 200)) {
    throw new ErroEntrada('Lista inválida.');
  }
  return v.map((x) => x.trim());
};
const umDe = (v, opcoes, nome) => {
  if (v === undefined) return undefined;
  if (!opcoes.includes(v)) throw new ErroEntrada(`${nome} deve ser um de: ${opcoes.join(', ')}.`);
  return v;
};
const bool = (v, nome) => {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ErroEntrada(`${nome} deve ser true ou false.`);
  return v;
};
const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hojeUTC = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };
const diasAte = (iso) => Math.round((new Date(`${iso}T00:00:00Z`) - hojeUTC()) / 864e5);
const limite = (v, padrao = 100, max = 500) => Math.min(Math.max(numero(v, 'limit') ?? padrao, 1), max);
const semId = ({ _id, ...resto }) => resto;

function severidade(p) {
  if (p.tipo === 'fila_parada') return 'fila';
  if (p.diasRestantes <= 30) return 'critico';
  if (p.diasRestantes <= 120) return 'atencao';
  return 'planejado';
}

// ---------- aplicação ----------
function criarApp(db) {
  const app = express();
  app.set('query parser', 'simple'); // impede objetos na query (injeção de operadores do Mongo)
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

  const col = (nome) => db().collection(nome);
  const leitura = exigir(db, 'leitura');

  async function fontePadrao() {
    const f = await col('fontes').findOne({ padrao: true, ativa: true });
    return f?._id;
  }
  // Resolve ?fonte= (uma ou várias, separadas por vírgula). Sem o parâmetro, usa a fonte padrão.
  async function filtroFonte(req) {
    const bruto = texto(req.query.fonte, 400);
    if (bruto === 'todas') {
      const ativas = await col('fontes').find({ ativa: true }, { projection: { _id: 1 } }).toArray();
      return { $in: ativas.map((f) => f._id) };
    }
    if (bruto) {
      const ids = bruto.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.some((i) => !ID_RE.test(i))) throw new ErroEntrada('Identificador de fonte inválido.');
      return { $in: ids };
    }
    const padrao = await fontePadrao();
    if (!padrao) throw new ErroEntrada('Nenhuma fonte padrão ativa. Informe ?fonte=<id> ou ?fonte=todas.');
    return padrao;
  }
  const podeRestrito = (req) => req.consumidor.permissoes.includes('restrito');

  // Saúde (sem autenticação) — também acorda o serviço no plano gratuito do Render.
  app.get('/v1/saude', async (_req, res) => {
    try {
      await db().command({ ping: 1 });
      res.json({ ok: true, versaoEsquema: VERSAO_ESQUEMA, agora: new Date().toISOString() });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // ---------- leitura ----------
  app.get('/v1/rodadas', leitura, async (req, res, next) => {
    try {
      const fonte = await filtroFonte(req);
      const itens = await col('rodadas').find({ fonte }).sort({ geradoEm: -1 }).limit(limite(req.query.limit, 10, 100)).toArray();
      res.json(itens.map(semId));
    } catch (e) { next(e); }
  });

  app.get('/v1/atestados', leitura, async (req, res, next) => {
    try {
      const q = { fonte: await filtroFonte(req), 'versao.vigente': { $ne: false } };
      if (!podeRestrito(req)) q.usoRestrito = { $ne: true };
      const frente = texto(req.query.frente, 10);
      if (frente) q.frentes = { $all: frente.split(',').map((s) => s.trim().toUpperCase()) };
      const forca = texto(req.query.forca, 10);
      if (forca) {
        const fs = forca.split(',').map((s) => s.trim().toUpperCase());
        fs.forEach((f) => umDe(f, FORCAS, 'forca'));
        q.forca = { $in: fs };
      }
      const esfera = texto(req.query.esfera, 20);
      if (esfera) q.esfera = umDe(esfera, ESFERAS, 'esfera');
      const tecnologia = texto(req.query.tecnologia, 60);
      if (tecnologia) q.tecnologias = { $regex: escaparRegex(tecnologia), $options: 'i' };
      const busca = texto(req.query.q, 80);
      if (busca) {
        const r = { $regex: escaparRegex(busca), $options: 'i' };
        q.$or = [{ emitente: r }, { destaque: r }, { id: r }, { 'contrato.numero': r }];
      }
      const itens = await col('atestados')
        .find(q, { projection: { _id: 0, quantitativos: 0 } })
        .sort({ forca: 1, emissao: -1 })
        .limit(limite(req.query.limit))
        .toArray();
      res.json(itens);
    } catch (e) { next(e); }
  });

  app.get('/v1/atestados/:id', leitura, async (req, res, next) => {
    try {
      const q = { fonte: await filtroFonte(req), id: texto(req.params.id, 40) };
      if (!podeRestrito(req)) q.usoRestrito = { $ne: true };
      const a = await col('atestados').findOne(q, { projection: { _id: 0 } });
      if (!a) return res.status(404).json({ erro: 'Atestado não encontrado nesta fonte.' });
      res.json(a);
    } catch (e) { next(e); }
  });

  // Uma linha por número extraído (ex.: ?metrica=vms&min=200&natureza=executado)
  app.get('/v1/quantitativos', leitura, async (req, res, next) => {
    try {
      const base = { fonte: await filtroFonte(req), 'versao.vigente': { $ne: false } };
      if (!podeRestrito(req)) base.usoRestrito = { $ne: true };
      const qq = {};
      const metrica = texto(req.query.metrica, 40);
      if (metrica) qq['quantitativos.metrica'] = metrica;
      const min = numero(req.query.min, 'min');
      if (min !== undefined) qq['quantitativos.valor'] = { $gte: min };
      const natureza = texto(req.query.natureza, 20);
      if (natureza) qq['quantitativos.natureza'] = umDe(natureza, ['executado', 'contratado'], 'natureza');
      const itens = await col('atestados').aggregate([
        { $match: base },
        { $unwind: '$quantitativos' },
        { $match: qq },
        { $project: {
          _id: 0, atestadoId: '$id', fonte: 1, emitente: 1, forca: 1, link: 1,
          metrica: '$quantitativos.metrica', valor: '$quantitativos.valor', comparador: '$quantitativos.comparador',
          natureza: '$quantitativos.natureza', trecho: '$quantitativos.trecho',
        } },
        { $sort: { valor: -1 } },
        { $limit: limite(req.query.limit) },
      ]).toArray();
      res.json(itens);
    } catch (e) { next(e); }
  });

  app.get('/v1/prazos', leitura, async (req, res, next) => {
    try {
      const ate = numero(req.query.ate, 'ate');
      const itens = (await col('prazos').find({ fonte: await filtroFonte(req) }, { projection: { _id: 0 } }).toArray())
        .map((p) => ({ ...p, diasRestantes: diasAte(p.data) }))
        .map((p) => ({ ...p, severidade: severidade(p) }))
        .filter((p) => ate === undefined || p.tipo === 'fila_parada' || p.diasRestantes <= ate)
        .sort((a, b) => a.diasRestantes - b.diasRestantes);
      res.json(itens);
    } catch (e) { next(e); }
  });

  app.get('/v1/lacunas', leitura, async (req, res, next) => {
    try {
      res.json(await col('lacunas').find({ fonte: await filtroFonte(req) }, { projection: { _id: 0 } }).toArray());
    } catch (e) { next(e); }
  });

  // ---------- fontes ----------
  app.get('/v1/fontes', leitura, async (_req, res, next) => {
    try {
      const itens = await col('fontes').find({}).sort({ padrao: -1, _id: 1 }).toArray();
      res.json(itens.map(({ _id, ...f }) => ({ id: _id, ...f })));
    } catch (e) { next(e); }
  });

  function lerFonte(body, parcial) {
    const f = {
      nome: texto(body.nome, 120),
      tipo: umDe(body.tipo, TIPOS_FONTE, 'tipo'),
      link: texto(body.link, 2000),
      subpastas: bool(body.subpastas, 'subpastas'),
      ignorar: lista(body.ignorar),
      restritas: lista(body.restritas),
      planilhaControle: texto(body.planilhaControle, 200),
      ativa: bool(body.ativa, 'ativa'),
      padrao: bool(body.padrao, 'padrao'),
    };
    if (f.link && !/^https:\/\/[a-z0-9-]+(-my)?\.sharepoint\.com\//i.test(f.link)) {
      throw new ErroEntrada('O link precisa ser de uma pasta do SharePoint ou do OneDrive corporativo (*.sharepoint.com).');
    }
    if (!parcial) {
      for (const c of ['nome', 'tipo', 'link']) if (!f[c]) throw new ErroEntrada(`Campo obrigatório: ${c}.`);
    }
    Object.keys(f).forEach((k) => f[k] === undefined && delete f[k]);
    return f;
  }

  async function marcarPadrao(id) {
    await col('fontes').updateMany({ _id: { $ne: id } }, { $set: { padrao: false } });
  }

  app.post('/v1/fontes', exigir(db, 'fontes'), async (req, res, next) => {
    try {
      const id = texto(req.body.id, 63);
      if (!id || !ID_RE.test(id)) throw new ErroEntrada('id: use letras minúsculas, números e hífen (2 a 63).');
      const f = lerFonte(req.body, false);
      const doc = {
        _id: id, subpastas: true, ignorar: [], restritas: [], ativa: true, padrao: false, ...f,
        status: 'aguardando_leitura', driveId: null, itemId: null, ultimaLeitura: null, arquivos: 0,
        criadoPor: req.consumidor._id, criadoEm: new Date(), atualizadoEm: new Date(),
      };
      await col('fontes').insertOne(doc);
      if (doc.padrao) await marcarPadrao(id);
      const { _id, ...resto } = doc;
      res.status(201).json({ id: _id, ...resto, proximoPasso: 'O agente lê a pasta na próxima execução e muda o status para pronta, sem_acesso ou link_invalido.' });
    } catch (e) {
      if (e.code === 11000) return res.status(409).json({ erro: 'Já existe uma fonte com esse id.' });
      next(e);
    }
  });

  app.patch('/v1/fontes/:id', exigir(db, 'fontes'), async (req, res, next) => {
    try {
      const id = texto(req.params.id, 63);
      const f = lerFonte(req.body, true);
      if (!Object.keys(f).length) throw new ErroEntrada('Nada para alterar.');
      if (f.link) Object.assign(f, { status: 'aguardando_leitura', driveId: null, itemId: null });
      const r = await col('fontes').findOneAndUpdate({ _id: id }, { $set: { ...f, atualizadoEm: new Date() } }, { returnDocument: 'after' });
      if (!r) return res.status(404).json({ erro: 'Fonte não encontrada.' });
      if (f.padrao === true) await marcarPadrao(id);
      const { _id, ...resto } = r;
      res.json({ id: _id, ...resto });
    } catch (e) { next(e); }
  });

  // ---------- pedidos (fila para o agente) ----------
  app.post('/v1/pedidos', exigir(db, 'pedidos'), async (req, res, next) => {
    try {
      const tipo = umDe(req.body.tipo, TIPOS_PEDIDO, 'tipo');
      if (!tipo) throw new ErroEntrada('Campo obrigatório: tipo.');
      const entrada = {};
      if (tipo === 'indexacao') {
        const fonte = texto(req.body.fonte, 63);
        if (!fonte || !(await col('fontes').findOne({ _id: fonte }))) throw new ErroEntrada('Fonte inexistente.');
        entrada.fonte = fonte;
      } else {
        const fontes = lista(req.body.fontes, 20) || [await fontePadrao()].filter(Boolean);
        const requisitos = req.body.requisitos;
        if (!Array.isArray(requisitos) || !requisitos.length || requisitos.length > 200) {
          throw new ErroEntrada('requisitos: envie de 1 a 200 itens.');
        }
        entrada.fontes = fontes;
        entrada.edital = texto(req.body.edital, 300);
        entrada.requisitos = requisitos.map((r) => ({
          id: texto(r.id, 60), texto: texto(r.texto, 4000), metrica: texto(r.metrica, 40),
          minimo: numero(r.minimo, 'minimo'), tecnologia: texto(r.tecnologia, 120),
          concomitante: bool(r.concomitante, 'concomitante') ?? false,
          somatorioPermitido: bool(r.somatorioPermitido, 'somatorioPermitido') ?? true,
        }));
        entrada.querPacoteHabilitacao = bool(req.body.querPacoteHabilitacao, 'querPacoteHabilitacao') ?? false;
      }
      const doc = {
        _id: crypto.randomUUID(), tipo, status: 'na_fila', consumidor: req.consumidor._id,
        entrada, resultado: null, erro: null, criadoEm: new Date(), atualizadoEm: new Date(),
      };
      await col('pedidos').insertOne(doc);
      res.status(202).json({ id: doc._id, status: doc.status, criadoEm: doc.criadoEm });
    } catch (e) { next(e); }
  });

  app.get('/v1/pedidos/:id', exigir(db, 'pedidos'), async (req, res, next) => {
    try {
      const filtro = { _id: texto(req.params.id, 40) };
      if (!req.consumidor.permissoes.includes('agente')) filtro.consumidor = req.consumidor._id;
      const p = await col('pedidos').findOne(filtro);
      if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
      const { _id, ...resto } = p;
      res.json({ id: _id, ...resto });
    } catch (e) { next(e); }
  });

  // ---------- agente (única chave que grava o estado analisado) ----------
  const agente = exigir(db, 'agente');

  // Substitui o estado de uma fonte pelo resultado da rodada (transação: ou grava tudo, ou nada).
  app.put('/v1/agente/fontes/:fonte/estado', agente, async (req, res, next) => {
    const fonte = texto(req.params.fonte, 63);
    const { rodada, atestados, prazos, lacunas } = req.body || {};
    try {
      if (!(await col('fontes').findOne({ _id: fonte }))) throw new ErroEntrada('Fonte inexistente.');
      if (!rodada || !Array.isArray(atestados) || !Array.isArray(prazos) || !Array.isArray(lacunas)) {
        throw new ErroEntrada('Envie rodada, atestados, prazos e lacunas.');
      }
      if (rodada.versaoEsquema !== VERSAO_ESQUEMA) throw new ErroEntrada(`versaoEsquema deve ser ${VERSAO_ESQUEMA}.`);
      if (atestados.some((a) => !a || typeof a.id !== 'string')) throw new ErroEntrada('Todo atestado precisa de id.');
      const agora = new Date();
      const session = require('./db').getClient()?.startSession();
      const gravar = async (opts) => {
        await col('atestados').deleteMany({ fonte }, opts);
        if (atestados.length) await col('atestados').insertMany(atestados.map((a) => ({ ...a, fonte, atualizadoEm: agora })), opts);
        await col('prazos').deleteMany({ fonte }, opts);
        if (prazos.length) await col('prazos').insertMany(prazos.map((p) => ({ ...p, fonte })), opts);
        await col('lacunas').deleteMany({ fonte }, opts);
        if (lacunas.length) await col('lacunas').insertMany(lacunas.map((l) => ({ ...l, fonte })), opts);
        await col('rodadas').insertOne({ ...rodada, fonte, geradoEm: new Date(rodada.geradoEm || agora), recebidoEm: agora }, opts);
        await col('fontes').updateOne({ _id: fonte }, { $set: { status: 'pronta', ultimaLeitura: agora, arquivos: atestados.length, atualizadoEm: agora } }, opts);
      };
      if (session) {
        try { await session.withTransaction(() => gravar({ session })); } finally { await session.endSession(); }
      } else {
        await gravar({});
      }
      res.json({ ok: true, fonte, atestados: atestados.length, prazos: prazos.length, lacunas: lacunas.length });
    } catch (e) { next(e); }
  });

  app.patch('/v1/agente/fontes/:fonte', agente, async (req, res, next) => {
    try {
      const set = {
        status: umDe(req.body.status, STATUS_FONTE, 'status'),
        driveId: texto(req.body.driveId, 200), itemId: texto(req.body.itemId, 200),
        mensagem: texto(req.body.mensagem, 500),
      };
      Object.keys(set).forEach((k) => set[k] === undefined && delete set[k]);
      const r = await col('fontes').updateOne({ _id: texto(req.params.fonte, 63) }, { $set: { ...set, atualizadoEm: new Date() } });
      if (!r.matchedCount) return res.status(404).json({ erro: 'Fonte não encontrada.' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.get('/v1/agente/pedidos', agente, async (req, res, next) => {
    try {
      const status = umDe(texto(req.query.status, 20) || 'na_fila', STATUS_PEDIDO, 'status');
      const itens = await col('pedidos').find({ status }).sort({ criadoEm: 1 }).limit(limite(req.query.limit, 20, 100)).toArray();
      res.json(itens.map(({ _id, ...p }) => ({ id: _id, ...p })));
    } catch (e) { next(e); }
  });

  app.patch('/v1/agente/pedidos/:id', agente, async (req, res, next) => {
    try {
      const set = { status: umDe(req.body.status, STATUS_PEDIDO, 'status'), atualizadoEm: new Date() };
      if (!set.status) throw new ErroEntrada('Campo obrigatório: status.');
      if (req.body.resultado !== undefined) set.resultado = req.body.resultado;
      if (req.body.erro !== undefined) set.erro = texto(req.body.erro, 2000);
      const r = await col('pedidos').updateOne({ _id: texto(req.params.id, 40) }, { $set: set });
      if (!r.matchedCount) return res.status(404).json({ erro: 'Pedido não encontrado.' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---------- administração de chaves (cabeçalho x-admin-token = ADMIN_TOKEN) ----------
  app.post('/v1/admin/consumidores', exigirAdmin, async (req, res, next) => {
    try {
      const nome = texto(req.body.nome, 63);
      if (!nome || !ID_RE.test(nome)) throw new ErroEntrada('nome: letras minúsculas, números e hífen.');
      const permissoes = lista(req.body.permissoes, 10) || ['leitura'];
      permissoes.forEach((p) => umDe(p, PERMISSOES, 'permissao'));
      const chave = gerarChave(permissoes.includes('agente') ? 'rdr_agente' : 'rdr');
      await col('consumidores').insertOne({ _id: nome, hash: hashChave(chave), permissoes, ativo: true, criadoEm: new Date() });
      res.status(201).json({ nome, permissoes, chave, aviso: 'Guarde a chave agora: ela não será mostrada de novo.' });
    } catch (e) {
      if (e.code === 11000) return res.status(409).json({ erro: 'Já existe um consumidor com esse nome. Revogue e crie outro.' });
      next(e);
    }
  });

  app.get('/v1/admin/consumidores', exigirAdmin, async (_req, res, next) => {
    try {
      const itens = await col('consumidores').find({}, { projection: { hash: 0 } }).toArray();
      res.json(itens.map(({ _id, ...c }) => ({ nome: _id, ...c })));
    } catch (e) { next(e); }
  });

  app.delete('/v1/admin/consumidores/:nome', exigirAdmin, async (req, res, next) => {
    try {
      const r = await col('consumidores').updateOne({ _id: texto(req.params.nome, 63) }, { $set: { ativo: false, revogadoEm: new Date() } });
      if (!r.matchedCount) return res.status(404).json({ erro: 'Consumidor não encontrado.' });
      res.json({ ok: true, revogado: req.params.nome });
    } catch (e) { next(e); }
  });

  app.use((_req, res) => res.status(404).json({ erro: 'Rota não encontrada. Veja /v1/saude e o README.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.status === 400 || err.type === 'entity.parse.failed') return res.status(400).json({ erro: err.message });
    console.error(err);
    res.status(500).json({ erro: 'Erro interno.' });
  });
  return app;
}

module.exports = { criarApp, VERSAO_ESQUEMA };
