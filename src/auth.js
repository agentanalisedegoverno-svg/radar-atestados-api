// Chaves de API por consumidor. Guardamos só o hash SHA-256; a chave aparece uma única vez, na criação.
const crypto = require('crypto');

const PERMISSOES = ['leitura', 'pedidos', 'fontes', 'restrito', 'agente'];

function hashChave(chave) {
  return crypto.createHash('sha256').update(chave, 'utf8').digest('hex');
}

function gerarChave(prefixo = 'rdr') {
  return `${prefixo}_${crypto.randomBytes(32).toString('base64url')}`;
}

function iguaisEmTempoConstante(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Middleware: resolve o consumidor pela chave e exige as permissões pedidas.
function exigir(db, ...permissoes) {
  return async (req, res, next) => {
    try {
      const chave = req.get('x-api-key');
      if (!chave) return res.status(401).json({ erro: 'Envie a chave no cabeçalho x-api-key.' });
      const consumidor = await db().collection('consumidores').findOne({ hash: hashChave(chave), ativo: true });
      if (!consumidor) return res.status(401).json({ erro: 'Chave inválida ou revogada.' });
      const falta = permissoes.filter((p) => !consumidor.permissoes.includes(p));
      if (falta.length) return res.status(403).json({ erro: `Chave sem a permissão: ${falta.join(', ')}.` });
      req.consumidor = consumidor;
      db().collection('consumidores').updateOne({ _id: consumidor._id }, { $set: { ultimoUso: new Date() } }).catch(() => {});
      next();
    } catch (e) {
      next(e);
    }
  };
}

function exigirAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || token.length < 32) return res.status(503).json({ erro: 'ADMIN_TOKEN não configurado (mínimo 32 caracteres).' });
  if (!iguaisEmTempoConstante(req.get('x-admin-token'), token)) return res.status(401).json({ erro: 'Token de administrador inválido.' });
  next();
}

module.exports = { PERMISSOES, hashChave, gerarChave, exigir, exigirAdmin };
