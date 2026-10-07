const path = require('path');
const { conectar, getDb } = require('./db');
const { criarApp } = require('./app');

// Na primeira subida (banco vazio e SEED_INICIAL=true), cria a fonte atual e carrega o estado do painel.
async function cargaInicial(db) {
  if (process.env.SEED_INICIAL !== 'true') return;
  if (await db.collection('fontes').countDocuments()) return;
  const estado = require(path.join(__dirname, '..', 'data', 'estado-inicial-governo2.json'));
  const agora = new Date();
  await db.collection('fontes').insertOne({
    _id: 'governo2-base-act',
    nome: 'Base de ACT — Governo',
    tipo: 'sharepoint',
    link: 'https://connectcomcloud.sharepoint.com/sites/GOVERNO2/Shared%20Documents/General/LICITA%C3%87%C3%95ES/Documenta%C3%A7%C3%A3o%20T%C3%A9cnica%20-%20ACT%20-%20DCT',
    driveId: 'b!CLxZnv93iEiZpGzQ6DiPEvlY0WGvMu9Fls3ZquPmV8vnPjGQ6yj9SKgYneGWN1M6',
    itemId: '01FBRTFC56VKKFVBDJOFG3MLBMZINGIVHD',
    subpastas: true,
    ignorar: ['EXCLUIR', 'ACT Antigos*', '3.Arquivos Backup'],
    restritas: ['ACT Específicos - Usar quando Pedro Autorizar'],
    planilhaControle: 'Controle de Atestados.xlsx',
    ativa: true, padrao: true, status: 'pronta',
    ultimaLeitura: agora, arquivos: estado.atestados.length,
    criadoPor: 'carga-inicial', criadoEm: agora, atualizadoEm: agora,
  });
  const fonte = 'governo2-base-act';
  await db.collection('atestados').insertMany(estado.atestados.map((a) => ({ ...a, fonte, atualizadoEm: agora })));
  await db.collection('prazos').insertMany(estado.prazos.map((p) => ({ ...p, fonte })));
  await db.collection('lacunas').insertMany(estado.lacunas.map((l) => ({ ...l, fonte })));
  await db.collection('rodadas').insertOne({ ...estado.rodada, fonte, geradoEm: new Date(estado.rodada.geradoEm), recebidoEm: agora });
  console.log(`Carga inicial: ${estado.atestados.length} atestados, ${estado.prazos.length} prazos, ${estado.lacunas.length} lacunas.`);
}

(async () => {
  const db = await conectar();
  await cargaInicial(db);
  const porta = Number(process.env.PORT) || 3000;
  criarApp(getDb).listen(porta, () => console.log(`Radar API ouvindo na porta ${porta}`));
})().catch((e) => {
  console.error('Falha ao iniciar:', e.message);
  process.exit(1);
});

module.exports = { cargaInicial };
