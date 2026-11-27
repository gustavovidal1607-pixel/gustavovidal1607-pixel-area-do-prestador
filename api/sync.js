// Sincronização diária das planilhas de controle (sync/sincronizar.py).
//   POST /api/sync   (sessão da equipe  OU  cabeçalho X-Sync-Token: <SYNC_TOKEN>)
//   JSON { prestador, convenio, arquivo?, arquivo_modificado?, linhas: [ {...}, ... ] }
//
// "convenio" é o da planilha (pasta). Cada linha pode trazer um convênio mais
// específico que comece com ele (planilha BRADESCO -> linhas BRADESCO SAÚDE /
// BRADESCO OPERADORA).
//
// Cada envio TROCA todas as linhas daquele prestador + planilha (tudo numa
// transação: ou entra a planilha inteira, ou nada muda). O prestador
// precisa estar cadastrado pela equipe (aba Prestadores).
//
// Planilha grande (a Vercel aceita 4,5 MB por requisição): o script manda em
// partes, { envio: <id>, parte: i, partes: n, linhas: [...] }. As partes ficam
// em sync_partes e só a última troca a produção, numa transação só.
//
// Planilha BRADESCO pode trazer "chamados": [{ lote, chamado, aberto_em, protocolo, guias_pendentes, situacao }]
// (CHAMADOS BRADESCO.json da pasta do prestador): trocam os chamados desta planilha na mesma transação.
//
// Autorização: sessão de um usuário da EQUIPE (login normal, perfil faturas)
// OU cabeçalho X-Sync-Token igual à variável SYNC_TOKEN (opcional; no modo
// local sem variável aceita "teste"). Prestador e recepção não sincronizam.

const crypto = require('crypto');
const L = require('./_lib');

const LIMITE_CORPO = 15 * 1024 * 1024;
const MAX_LINHAS = 20000;

module.exports = L.rota(async (req, res) => {
  if (req.method !== 'POST') return L.responder(res, 405, { erro: 'Método não permitido.' });

  // Dois jeitos de autorizar:
  //  1) cabeçalho X-Sync-Token = SYNC_TOKEN (quando a variável existe; no modo local, "teste");
  //  2) sessão de um usuário da EQUIPE Faturas Med (o sincronizar.py faz login com --login).
  const local = !(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  const esperado = process.env.SYNC_TOKEN || (local ? 'teste' : '');
  const recebido = String(req.headers['x-sync-token'] || '');
  if (recebido){
    const a = crypto.createHash('sha256').update(recebido).digest();
    const b = crypto.createHash('sha256').update(esperado || crypto.randomBytes(16).toString('hex')).digest();
    if (!esperado || !crypto.timingSafeEqual(a, b)) return L.responder(res, 401, { erro: 'Token de sincronização inválido.' });
  } else {
    const u = await L.usuarioDaSessao(req);
    if (!u) return L.responder(res, 401, { erro: 'Entre com um usuário da equipe Faturas Med (ou use o token de sincronização).' });
    if (u.perfil !== 'faturas') return L.responder(res, 403, { erro: 'Só a equipe Faturas Med pode sincronizar.' });
  }

  let corpo;
  try {
    let pronto; try { pronto = req.body; } catch {}
    if (pronto && typeof pronto === 'object' && !Buffer.isBuffer(pronto)) corpo = pronto;
    else corpo = JSON.parse((await L.lerCorpo(req, LIMITE_CORPO)).toString('utf8'));
  } catch (e){
    if (e.codigo === 'GRANDE') return L.responder(res, 413, { erro: 'Envio grande demais. Mande um convênio por vez.' });
    return L.responder(res, 400, { erro: 'JSON inválido.' });
  }

  const db = await L.prepararBanco();
  const nomePrestador = String(corpo.prestador || '').trim().replace(/\s+/g, ' ').toUpperCase();
  const convenio = String(corpo.convenio || '').trim().toUpperCase();
  if (!nomePrestador || !convenio) return L.responder(res, 400, { erro: 'Informe prestador e convenio.' });
  const [prestador] = await db.query(`SELECT id FROM prestadores WHERE upper(nome) = $1`, [nomePrestador]);
  if (!prestador) return L.responder(res, 404, { erro: `Prestador "${nomePrestador}" não está cadastrado no portal.` });
  if (!Array.isArray(corpo.linhas)) return L.responder(res, 400, { erro: 'Faltam as linhas.' });
  if (corpo.linhas.length > MAX_LINHAS) return L.responder(res, 413, { erro: `Mais de ${MAX_LINHAS} linhas num envio.` });

  const avisos = [];
  const linhas = [];
  corpo.linhas.forEach((x, i) => {
    const r = normalizar(x || {}, convenio);
    if (r.erro){ avisos.push(`linha ${x && x.linha_planilha || i + 1}: ${r.erro}`); return; }
    linhas.push(r);
  });

  const colunas = ['previsao_pagamento', 'convenio', 'operadora', 'competencia', 'lote', 'data_lote', 'tipo', 'tipo_original', 'paciente', 'guia', 'data', 'grau',
    'codigo', 'procedimento', 'qtd', 'faturado', 'recebido', 'glosado', 'data_pagamento', 'status', 'situacao', 'motivo_glosa', 'medico',
    'status_inicial', 'data_pagamento_inicial', 'recurso_recursado', 'recurso_acatado', 'recurso_data', 'recurso_protocolo', 'resposta_operadora'];
  const tipos = { previsao_pagamento: 'date', data_lote: 'date', data: 'date', data_pagamento: 'date', qtd: 'numeric', faturado: 'numeric', recebido: 'numeric', glosado: 'numeric',
    data_pagamento_inicial: 'date', recurso_recursado: 'numeric', recurso_acatado: 'numeric', recurso_data: 'date' };
  const definicao = colunas.map(c => `${c} ${tipos[c] || 'text'}`).join(', ');
  const modificado = /^\d{4}-\d{2}-\d{2}T/.test(String(corpo.arquivo_modificado || '')) ? corpo.arquivo_modificado : null;

  // Envio em partes?
  const partes = Number(corpo.partes || 1);
  const parte = Number(corpo.parte || 1);
  const envio = String(corpo.envio || '');
  if (partes > 1){
    if (!Number.isInteger(partes) || !Number.isInteger(parte) || parte < 1 || parte > partes || partes > 500) return L.responder(res, 400, { erro: 'Parte inválida.' });
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(envio)) return L.responder(res, 400, { erro: 'Informe o id do envio (envio).' });
  }
  // Chamados do Bradesco (CHAMADOS BRADESCO.json da pasta do prestador — Willian 26-27/11): quando o
  // pacote traz "chamados" (lista), eles trocam os chamados desta planilha junto com as linhas.
  // Pacote sem a chave (script antigo) deixa os chamados como estão.
  const chamados = Array.isArray(corpo.chamados) ? normalizarChamados(corpo.chamados) : null;
  const trocaChamados = chamados ? [
    [`DELETE FROM chamados WHERE prestador_id = $1 AND fonte = $2`, [prestador.id, convenio]],
    [`INSERT INTO chamados (prestador_id, fonte, lote, chamado, aberto_em, protocolo, guias_pendentes, situacao, atualizado_em)
      SELECT $1, $2, lote, chamado, aberto_em, protocolo, COALESCE(guias_pendentes, '[]'::jsonb), situacao, now()
        FROM jsonb_to_recordset($3::jsonb) AS x(lote text, chamado text, aberto_em date, protocolo text, guias_pendentes jsonb, situacao text)`,
      [prestador.id, convenio, JSON.stringify(chamados)]],
  ] : [];
  const insercao = (origem) => `INSERT INTO producao (prestador_id, fonte, ${colunas.join(', ')}) ${origem}`;
  const fechamento = [
    // Protocolo cujo número é um lote desta planilha segue o lote: convênio
    // (ex.: "BRADESCO" genérico -> BRADESCO SAÚDE/OPERADORA) e competência
    // (a mesma calculada para o lote), para o resumo anexar o protocolo certo.
    [`UPDATE documentos d SET convenio = x.convenio, competencia = x.competencia
        FROM (SELECT DISTINCT ON (lote) lote, convenio, competencia FROM producao
               WHERE prestador_id = $1 AND fonte = $2 AND lote IS NOT NULL ORDER BY lote, competencia DESC, convenio) x
       WHERE d.prestador_id = $1 AND d.categoria = 'protocolo' AND d.excluido_em IS NULL AND d.numero = x.lote
         AND (d.convenio = $2 OR d.convenio = x.convenio)
         AND (d.convenio <> x.convenio OR d.competencia <> x.competencia)`,
      [prestador.id, convenio]],
    [`INSERT INTO sincronizacoes (prestador_id, convenio, linhas, arquivo, arquivo_modificado, quando)
      VALUES ($1, $2, (SELECT count(*) FROM producao WHERE prestador_id = $1 AND fonte = $2), $3, $4::timestamptz, now())
      ON CONFLICT (prestador_id, convenio) DO UPDATE SET linhas = EXCLUDED.linhas, arquivo = EXCLUDED.arquivo,
        arquivo_modificado = EXCLUDED.arquivo_modificado, quando = now()`,
      [prestador.id, convenio, String(corpo.arquivo || '').slice(0, 300), modificado]],
  ];

  if (partes === 1){
    await db.transacao([
      [`DELETE FROM producao WHERE prestador_id = $1 AND fonte = $2`, [prestador.id, convenio]],
      [insercao(`SELECT $1, $2, ${colunas.join(', ')} FROM json_to_recordset($3::json) AS x(${definicao})`),
        [prestador.id, convenio, JSON.stringify(linhas)]],
      ...fechamento,
      ...trocaChamados,
    ]);
    return L.responder(res, 200, { ok: true, prestador: nomePrestador, convenio, linhas: linhas.length, chamados: chamados ? chamados.length : undefined, ignoradas: avisos.length, avisos: avisos.slice(0, 50) });
  }

  // Parte de um envio grande: guarda. Partes velhas (envio que não terminou) são limpas.
  await db.query(`DELETE FROM sync_partes WHERE criado_em < now() - interval '1 day'`);
  await db.query(
    `INSERT INTO sync_partes (envio, parte, prestador_id, fonte, linhas) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (envio, parte) DO UPDATE SET linhas = EXCLUDED.linhas, prestador_id = EXCLUDED.prestador_id, fonte = EXCLUDED.fonte, criado_em = now()`,
    [envio, parte, prestador.id, convenio, JSON.stringify(linhas)]
  );
  if (parte < partes) return L.responder(res, 200, { ok: true, prestador: nomePrestador, convenio, parte, partes, linhas: linhas.length, ignoradas: avisos.length, avisos: avisos.slice(0, 50) });

  const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM sync_partes WHERE envio = $1 AND prestador_id = $2 AND fonte = $3`, [envio, prestador.id, convenio]);
  if (n !== partes) return L.responder(res, 409, { erro: `Chegaram ${n} de ${partes} partes do envio. Mande de novo.` });
  await db.transacao([
    [`DELETE FROM producao WHERE prestador_id = $1 AND fonte = $2`, [prestador.id, convenio]],
    [insercao(`SELECT $1, $2, ${colunas.join(', ')} FROM sync_partes sp
        CROSS JOIN LATERAL jsonb_to_recordset(sp.linhas) AS x(${definicao})
        WHERE sp.envio = $3 AND sp.prestador_id = $1 AND sp.fonte = $2 ORDER BY sp.parte`),
      [prestador.id, convenio, envio]],
    ...fechamento,
    ...trocaChamados,
    [`DELETE FROM sync_partes WHERE envio = $1`, [envio]],
  ]);
  const [{ n: gravadas }] = await db.query(`SELECT count(*)::int AS n FROM producao WHERE prestador_id = $1 AND fonte = $2`, [prestador.id, convenio]);
  return L.responder(res, 200, { ok: true, prestador: nomePrestador, convenio, parte, partes, linhas: gravadas, chamados: chamados ? chamados.length : undefined, ignoradas: avisos.length, avisos: avisos.slice(0, 50) });
});

// ---------------------------------------------------------------- normalização

const texto = (v, max = 300) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim().replace(/\s+/g, ' ');
  return t ? t.slice(0, max) : null;
};

function numero(v){
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  let t = String(v).trim().replace(/[R$\s]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function data(v){
  const t = String(v || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// "RECURSADO DIA 25/11/2026", "RECURSADO DIA 29/06/26", "RECURSADO EM 20/11/26" -> "2026-11-25"
// (data do envio do recurso escrita no STATUS / STATUS INICIAL)
function dataDoRecurso(v){
  const m = String(v || '').toUpperCase().match(/RECURSAD[OA]\D*(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/);
  if (!m) return null;
  const iso = `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(iso + 'T12:00:00Z');  // data impossível (31/02, 13º mês) fica sem data, não derruba o envio
  return !isNaN(d) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

// "10/2026", "2026-10", "2026-10-01" -> "2026-10"
function competencia(v){
  const t = String(v || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  m = t.match(/^(\d{1,2})[/.](\d{4})$/);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  return null;
}

// Tipo de guia do resumo: CONSULTA, SADT, HONORÁRIO (GIH) ou o próprio texto.
function tipoGuia(v){
  const t = String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!t) return 'OUTROS';
  if (t.startsWith('CONSULTA')) return 'CONSULTA';
  if (t.includes('SADT')) return 'SADT';
  if (t === 'GIH' || t.includes('HONORARIO') || t === 'HI') return 'HONORÁRIO';
  if (t.includes('INTERNA')) return 'INTERNAÇÃO';
  return t.slice(0, 40);
}

// pago | glosado | parcial | aguardando — pelos valores da linha.
function situacao(faturado, recebido, glosado){
  const rec = recebido || 0, glo = glosado || 0;
  if (recebido === null && glosado === null) return 'aguardando';
  if (rec <= 0.005 && glo <= 0.005) return faturado > 0.005 ? 'aguardando' : 'pago';
  if (glo > 0.005 && rec > 0.005) return 'parcial';
  if (glo > 0.005) return 'glosado';
  return 'pago';
}

// Chamados: [{ lote, chamado, aberto_em, protocolo, guias_pendentes: [...], situacao }] (lote sem número ou
// sem chamado fica de fora; mesmo lote duas vezes = vale o último).
function normalizarChamados(lista){
  const por = new Map();
  for (const c of lista.slice(0, 5000)){
    if (!c || typeof c !== 'object') continue;
    const lote = texto(c.lote, 60), chamado = texto(c.chamado, 40);
    if (!lote || !chamado) continue;
    const guias = Array.isArray(c.guias_pendentes) ? c.guias_pendentes.map(g => texto(g, 60)).filter(Boolean).slice(0, 2000) : [];
    por.set(lote, { lote, chamado, aberto_em: data(c.aberto_em), protocolo: texto(c.protocolo ?? c.protocolo_bradesco, 40),
      guias_pendentes: guias, situacao: texto(c.situacao, 60) });
  }
  return Array.from(por.values());
}

function normalizar(x, fonte){
  const comp = competencia(x.comp ?? x.competencia);
  if (!comp || !L.ehCompetencia(comp)) return { erro: 'competência inválida' };
  const faturado = numero(x.faturado);
  if (faturado === null) return { erro: 'sem valor faturado' };
  const recebido = numero(x.recebido), glosado = numero(x.glosado);
  // Convênio da linha: o da planilha ou um mais específico que comece com ele.
  const conv = String(x.convenio || '').trim().replace(/\s+/g, ' ').toUpperCase();
  const convenio = conv && (conv === fonte || conv.startsWith(fonte + ' ')) ? conv.slice(0, 60) : fonte;
  // Previsão: a da planilha (se tiver a coluna) ou a da regra do convênio
  // (a partir da data do lote = envio). A do protocolo, se houver, prevalece na leitura.
  // Bradesco: os dias dependem do tipo de guia (consulta/SADT/honorário).
  const tipo = tipoGuia(x.tipo);
  const previsao = data(x.previsao_pagamento) || L.sugerirPrevisao({ convenio, data_envio: data(x.data_lote), competencia: comp, tipo });
  return {
    previsao_pagamento: previsao,
    convenio,
    operadora: texto(x.operadora, 80),
    competencia: comp,
    lote: texto(x.lote, 60),
    data_lote: data(x.data_lote),
    tipo,
    tipo_original: texto(x.tipo, 40),
    paciente: texto(x.paciente, 160),
    guia: texto(x.guia, 60),
    data: data(x.data),
    grau: texto(x.grau, 10),
    codigo: texto(x.codigo, 30),
    procedimento: texto(x.procedimento, 300),
    qtd: numero(x.qtd),
    faturado,
    recebido,
    glosado,
    data_pagamento: data(x.data_pagamento),
    status: texto(x.status, 80),
    // (comp_planilha, quando vier, é só informativo: a competência já vem calculada)
    situacao: situacao(faturado, recebido, glosado),
    motivo_glosa: texto(x.motivo_glosa, 500),
    // Médico (clínica com vários): coluna MÉDICO ou pasta do médico; vazio = sem médico.
    medico: (texto(x.medico, 120) || '').toUpperCase() || null,
    // Recurso de glosa (planilhas com STATUS INICIAL / respostas de recurso em XML; aba Lotes Bradesco).
    status_inicial: texto(x.status_inicial, 60),
    data_pagamento_inicial: data(x.data_pagamento_inicial),
    recurso_recursado: numero(x.recurso_recursado),
    recurso_acatado: numero(x.recurso_acatado),
    // Aba Recursos (Gustavo 26/11): data em que o recurso foi enviado. Vale o que a equipe escreveu na
    // planilha ("RECURSADO DIA dd/mm/aaaa" no STATUS ou no STATUS INICIAL); sem isso, a <dataRecurso> do XML.
    recurso_data: dataDoRecurso(x.status) || dataDoRecurso(x.status_inicial) || data(x.recurso_data),
    recurso_protocolo: texto(x.recurso_protocolo, 30),
    resposta_operadora: texto(x.resposta_operadora, 500),
  };
}
