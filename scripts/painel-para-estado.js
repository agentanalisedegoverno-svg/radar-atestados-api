// Converte os dados do painel publicado (HTML) no formato de estado da API v1.
// Uso: node scripts/painel-para-estado.js <painel.html> <saida.json> [rodadaId]
const fs = require('fs');
const vm = require('vm');

const [, , entrada, saida, rodadaId = new Date().toISOString().slice(0, 10)] = process.argv;
if (!entrada || !saida) {
  console.error('Uso: node scripts/painel-para-estado.js <painel.html> <saida.json> [rodadaId]');
  process.exit(1);
}
const html = fs.readFileSync(entrada, 'utf8');

function extrairArray(nome) {
  const ini = html.indexOf(`const ${nome}=[`);
  if (ini < 0) throw new Error(`Array ${nome} não encontrado no painel.`);
  let i = html.indexOf('[', ini);
  let nivel = 0;
  let emTexto = null;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (emTexto) {
      if (c === '\\') { j++; continue; }
      if (c === emTexto) emTexto = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { emTexto = c; continue; }
    if (c === '[') nivel++;
    if (c === ']' && --nivel === 0) return vm.runInNewContext(`(${html.slice(i, j + 1)})`, {}, { timeout: 1000 });
  }
  throw new Error(`Array ${nome} sem fechamento.`);
}

const ESFERA = { F: 'federal', E: 'estatal', S: 'estadual', P: 'privado', '?': 'nao_identificado' };
const ALERTA = {
  O: 'sem_texto_ocr', S: 'assinatura_nao_verificavel', Q: 'sem_quantitativos', A: 'sem_avaliacao_qualidade',
  P: 'penalidade_registrada', V: 'versao_conflitante', R: 'razao_social_divergente', I: 'executado_pela_interaktiv',
  T: 'papel_timbrado_ctc',
};
const NIVEL = { A: 1, B: 1, C: 2, '?': 4 };

const D = extrairArray('D');
const DL = extrairArray('DL');
const G = extrairArray('G');

const atestados = D.map(([id, emitente, es, ano, fr, forca, fl, destaque]) => {
  const alertas = (fl ? fl.split(' ') : []).map((f) => ALERTA[f] || f);
  return {
    id, emitente, esfera: ESFERA[es] || 'nao_identificado', ano: ano || null, emissao: null,
    contrato: null, frentes: fr ? fr.split(' ') : [], tecnologias: [], quantitativos: [],
    forca, nivelEvidencia: NIVEL[forca] ?? 4, alertas, destaque: destaque || null,
    versao: { vigente: !/^Superado|^Substituído/i.test(destaque || ''), conflitaCom: [] },
    usoRestrito: false, link: null,
    textoLegivel: forca !== '?',
    origemDados: 'painel-2026-10-05',
  };
});

const prazos = DL.map((p) => ({
  contrato: p.c, data: p.d, tipo: p.fila ? 'fila_parada' : /12 meses/i.test(p.k) ? '12_meses' : 'fim_contrato',
  // Sem nomes de pessoas na API: troca "para assinatura de <Nome>, <cargo>" por "para assinatura da <cargo>".
  motivo: p.k, acao: p.a.replace(/para assinatura de [A-ZÀ-Ú][^,]+, ([^)]+)\)/, 'para assinatura da $1)'), estimado: Boolean(p.est),
}));

const lacunas = G.map((g) => ({
  requisito: g.r, exigido: g.e, evidencia: g.ev, proporcao: Math.round(Math.min(1, g.p) * 100) / 100,
  situacao: g.s === 'ok' ? 'atendido' : g.s === 'gap' ? 'lacuna' : 'parcial', rotulo: g.st,
}));

const estado = {
  rodada: {
    rodadaId, versaoEsquema: '1.0', tipo: 'completa', geradoEm: new Date().toISOString(),
    arquivosLidos: atestados.length, novos: 0, alterados: 0,
    observacao: 'Carga inicial a partir do painel Radar de Atestados (leitura de 05/10/2026). Quantitativos estruturados e links entram na próxima rodada do agente.',
  },
  atestados, prazos, lacunas,
};
fs.writeFileSync(saida, JSON.stringify(estado, null, 2));
console.log(`OK: ${atestados.length} atestados, ${prazos.length} prazos, ${lacunas.length} lacunas -> ${saida}`);
