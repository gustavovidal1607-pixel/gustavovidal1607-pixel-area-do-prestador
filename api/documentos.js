// PDFs do portal do prestador: protocolos de envio e documentos de repasse.
//
//   GET    /api/documentos?acao=lista[&categoria=protocolo|repasse][&prestador=ID][&excluidos=1]
//   GET    /api/documentos?id=ID[&baixar=1]     -> abre/baixa o PDF (nunca link público)
//   DELETE /api/documentos?id=ID                -> exclusão lógica (só equipe; apaga o PDF, fica o registro)
//   POST   /api/documentos?acao=editar  JSON { id, competencia?, convenio?, numero?, data_envio?, tipo?, observacao? } (só equipe)
//
// Envio (só equipe Faturas Med), mesmos dados nos dois caminhos:
//   { categoria, prestador_id, convenio, competencia:AAAA-MM, numero, data_envio:AAAA-MM-DD, tipo, observacao }
//   - local: POST /api/documentos?acao=enviar&<dados>&nome=..   corpo = o PDF
//   - produção (Blob direto): sobe por /api/upload (caminho prestador-<id>/...) e depois
//     POST /api/documentos?acao=registrar  JSON { chave, nome, tamanho, ...dados }
//
// O prestador só lista e baixa os documentos dele.

const crypto = require('crypto');
const L = require('./_lib');

module.exports = L.rota(async (req, res) => {
  const u = await L.exigirUsuario(req, res, ['prestador', 'faturas']);
  if (!u) return;
  const db = await L.prepararBanco();
  const p = L.parametros(req);
  const acao = p.get('acao');
  const equipe = u.perfil === 'faturas';

  // Sugestão de previsão de pagamento pela regra do convênio (tela da equipe).
  if (req.method === 'GET' && acao === 'sugerir-previsao'){
    return L.responder(res, 200, { previsao: L.sugerirPrevisao({ convenio: p.get('convenio'), data_envio: p.get('data_envio'), competencia: p.get('competencia') }) });
  }

  if (req.method === 'GET' && acao === 'lista'){
    if (!equipe && p.get('prestador') && Number(p.get('prestador')) !== u.prestador_id){
      return L.responder(res, 403, { erro: 'Você só pode ver os seus próprios documentos.' });
    }
    const prestador = equipe ? (/^\d+$/.test(p.get('prestador') || '') ? Number(p.get('prestador')) : null) : u.prestador_id;
    const categoria = ['protocolo', 'repasse'].includes(p.get('categoria')) ? p.get('categoria') : null;
    const comExcluidos = equipe && p.get('excluidos') === '1';
    const documentos = await db.query(
      `SELECT d.id, d.prestador_id, pr.nome AS prestador_nome, d.categoria, d.convenio, d.competencia, d.numero,
              to_char(d.data_envio, 'YYYY-MM-DD') AS data_envio, d.tipo, d.observacao, d.nome_original, d.tamanho,
              d.criado_em, d.excluido_em, ue.nome AS enviado_por_nome, ux.nome AS excluido_por_nome,
              to_char(d.previsao_pagamento, 'YYYY-MM-DD') AS previsao_pagamento,
              to_char(COALESCE(d.previsao_pagamento, (SELECT max(p.previsao_pagamento) FROM producao p
                 WHERE p.prestador_id = d.prestador_id AND p.lote = d.numero AND d.categoria = 'protocolo')), 'YYYY-MM-DD') AS previsao,
              (d.categoria = 'protocolo' AND EXISTS (SELECT 1 FROM producao p WHERE p.prestador_id = d.prestador_id AND p.lote = d.numero)
                AND NOT EXISTS (SELECT 1 FROM producao p WHERE p.prestador_id = d.prestador_id AND p.lote = d.numero AND p.situacao = 'aguardando')) AS lote_pago
         FROM documentos d
         JOIN prestadores pr ON pr.id = d.prestador_id
         LEFT JOIN usuarios ue ON ue.id = d.enviado_por
         LEFT JOIN usuarios ux ON ux.id = d.excluido_por
        WHERE ($1::int IS NULL OR d.prestador_id = $1)
          AND ($2::text IS NULL OR d.categoria = $2)
          AND ($3::boolean OR d.excluido_em IS NULL)
        ORDER BY d.competencia DESC, d.convenio, d.data_envio DESC NULLS LAST, d.id DESC`,
      [prestador, categoria, comExcluidos]
    );
    // O prestador não precisa ver quem da equipe subiu.
    if (!equipe) documentos.forEach(d => { delete d.enviado_por_nome; delete d.excluido_por_nome; });
    return L.responder(res, 200, { documentos });
  }

  if (req.method === 'GET' || req.method === 'DELETE'){
    const id = Number(p.get('id'));
    if (!Number.isInteger(id) || id <= 0) return L.responder(res, 400, { erro: 'Documento inválido.' });
    const [doc] = await db.query(
      `SELECT * FROM documentos WHERE id = $1 AND excluido_em IS NULL AND ($2::int IS NULL OR prestador_id = $2)`,
      [id, equipe ? null : u.prestador_id]
    );
    if (!doc) return L.responder(res, 404, { erro: 'Esse documento não existe mais.' });

    if (req.method === 'DELETE'){
      if (!equipe) return L.responder(res, 403, { erro: 'Só a equipe Faturas Med exclui documentos.' });
      await db.query(`UPDATE documentos SET excluido_em = now(), excluido_por = $2, chave = NULL WHERE id = $1`, [id, u.id]);
      try { if (doc.chave) await L.apagarPdfs([doc.chave]); } catch (e){ console.error('PDF do documento não apagado:', id, e); }
      return L.responder(res, 200, { ok: true });
    }

    const conteudo = doc.chave ? await L.lerPdf(doc.chave) : null;
    if (!conteudo) return L.responder(res, 404, { erro: 'O PDF não foi encontrado no armazenamento.' });
    const nome = String(doc.nome_original || 'documento.pdf');
    const ascii = nome.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ._()-]/g, '_');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', conteudo.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `${p.get('baixar') === '1' ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nome)}`);
    return res.end(conteudo);
  }

  if (req.method !== 'POST') return L.responder(res, 405, { erro: 'Método não permitido.' });
  if (!equipe) return L.responder(res, 403, { erro: 'Só a equipe Faturas Med envia documentos.' });

  // Corrigir os dados de um documento (ex.: convênio BRADESCO -> SAÚDE/OPERADORA, competência).
  if (acao === 'editar'){
    const corpo = await L.lerJson(req);
    const id = Number(corpo.id);
    const [doc] = await db.query(`SELECT *, to_char(data_envio, 'YYYY-MM-DD') AS data_envio_txt, to_char(previsao_pagamento, 'YYYY-MM-DD') AS previsao_txt FROM documentos WHERE id = $1 AND excluido_em IS NULL`, [id]);
    if (!doc) return L.responder(res, 404, { erro: 'Esse documento não existe mais.' });
    const atual = { categoria: doc.categoria, prestador_id: doc.prestador_id, competencia: doc.competencia, convenio: doc.convenio, numero: doc.numero,
      data_envio: doc.data_envio_txt || '', tipo: doc.tipo, observacao: doc.observacao };
    atual.previsao_pagamento = doc.previsao_txt || '';
    const campos = ['competencia', 'convenio', 'numero', 'data_envio', 'tipo', 'observacao', 'previsao_pagamento'];
    const novo = { ...atual };
    campos.forEach(c => { if (corpo[c] !== undefined) novo[c] = corpo[c]; });
    const meta = await conferirMeta(db, novo);
    if (meta.erro) return L.responder(res, 400, { erro: meta.erro });
    await db.query(
      `UPDATE documentos SET competencia = $2, convenio = $3, numero = $4, data_envio = $5::date, tipo = $6, observacao = $7, previsao_pagamento = $8::date WHERE id = $1`,
      [id, meta.competencia, meta.convenio, meta.numero, meta.data_envio, meta.tipo, meta.observacao, meta.previsao_pagamento]
    );
    return L.responder(res, 200, { ok: true });
  }

  if (acao === 'registrar'){
    if (!L.uploadDireto()) return L.responder(res, 400, { erro: 'O envio direto não está ativo neste ambiente.' });
    const corpo = await L.lerJson(req);
    const meta = await conferirMeta(db, corpo);
    const chave = String(corpo.chave || '');
    if (meta.erro){ return L.responder(res, 400, { erro: meta.erro }); }
    if (!chave.startsWith(`prestador-${meta.prestador_id}/`) || chave.includes('..')) return L.responder(res, 400, { erro: 'Arquivo inválido.' });
    const info = await L.infoPdf(chave);
    if (!info) return L.responder(res, 400, { erro: 'O PDF não chegou ao armazenamento. Tente enviar de novo.' });
    const id = await gravar(db, u, meta, { chave, nome: limparNome(corpo.nome), tamanho: info.size });
    return L.responder(res, 201, { ok: true, id });
  }

  if (acao === 'enviar'){
    const meta = await conferirMeta(db, Object.fromEntries(p.entries()));
    if (meta.erro) return L.responder(res, 400, { erro: meta.erro });
    let pdf;
    try { pdf = await L.lerCorpo(req, L.LIMITE_PDF); }
    catch (e){
      if (e.codigo === 'GRANDE') return L.responder(res, 413, { erro: 'O arquivo é grande demais para este caminho de envio.' });
      throw e;
    }
    if (!L.ehPdf(pdf)) return L.responder(res, 400, { erro: 'O arquivo não é um PDF.' });
    const nome = limparNome(p.get('nome'));
    const sufixo = crypto.randomBytes(4).toString('hex');
    const chave = await L.guardarPdf(`prestador-${meta.prestador_id}/${meta.categoria}/${meta.competencia}/${L.slug(nome.replace(/\.pdf$/i, '')).slice(0, 80)}-${sufixo}.pdf`, pdf);
    const id = await gravar(db, u, meta, { chave, nome, tamanho: pdf.length });
    return L.responder(res, 201, { ok: true, id });
  }

  return L.responder(res, 400, { erro: 'Ação desconhecida.' });
});

async function conferirMeta(db, x){
  const categoria = x.categoria;
  if (categoria !== 'protocolo' && categoria !== 'repasse') return { erro: 'Escolha se é protocolo ou documento de repasse.' };
  const prestador_id = Number(x.prestador_id);
  const [p] = Number.isInteger(prestador_id) && prestador_id > 0 ? await db.query(`SELECT id FROM prestadores WHERE id = $1`, [prestador_id]) : [];
  if (!p) return { erro: 'Escolha o prestador.' };
  const competencia = String(x.competencia || '');
  if (!L.ehCompetencia(competencia)) return { erro: 'Digite a competência (mês/ano).' };
  const convenio = String(x.convenio || '').trim().toUpperCase().slice(0, 60);
  if (categoria === 'protocolo' && !convenio) return { erro: 'Escolha o convênio do protocolo.' };
  const numero = String(x.numero || '').trim().slice(0, 60);
  if (categoria === 'protocolo' && !numero) return { erro: 'Digite o número do protocolo.' };
  const data_envio = String(x.data_envio || '');
  if (data_envio && !/^\d{4}-\d{2}-\d{2}$/.test(data_envio)) return { erro: 'Data de envio inválida.' };
  if (categoria === 'protocolo' && !data_envio) return { erro: 'Digite a data de envio do protocolo.' };
  const tipo = String(x.tipo || '').trim().slice(0, 80);
  if (categoria === 'repasse' && !tipo) return { erro: 'Escolha o tipo do documento de repasse.' };
  const previsao = String(x.previsao_pagamento || '');
  if (previsao && !/^\d{4}-\d{2}-\d{2}$/.test(previsao)) return { erro: 'Previsão de pagamento inválida.' };
  return { categoria, prestador_id, competencia, convenio, numero, data_envio: data_envio || null, tipo, observacao: String(x.observacao || '').trim().slice(0, 500),
    previsao_pagamento: categoria === 'protocolo' && previsao ? previsao : null };
}

// Protocolo com convênio genérico "BRADESCO": tenta achar se é Saúde ou
// Operadora pelo lote de mesmo número na planilha ou pelo prefixo do número
// (341 = Operadora, 340 = Saúde).
async function convenioEspecifico(db, m){
  if (m.convenio !== 'BRADESCO') return m.convenio;
  if (m.numero){
    const [x] = await db.query(`SELECT convenio FROM producao WHERE prestador_id = $1 AND fonte = 'BRADESCO' AND lote = $2 LIMIT 1`, [m.prestador_id, m.numero]);
    if (x) return x.convenio;
    if (m.numero.startsWith('341')) return 'BRADESCO OPERADORA';
    if (m.numero.startsWith('340')) return 'BRADESCO SAÚDE';
  }
  return m.convenio;
}

async function gravar(db, u, m, arquivo){
  m.convenio = await convenioEspecifico(db, m);
  // Protocolo de um lote já sincronizado: usa a competência do lote.
  if (m.categoria === 'protocolo' && m.numero){
    const [x] = await db.query(`SELECT competencia FROM producao WHERE prestador_id = $1 AND lote = $2 ORDER BY competencia DESC LIMIT 1`, [m.prestador_id, m.numero]);
    if (x) m.competencia = x.competencia;
  }
  const [d] = await db.query(
    `INSERT INTO documentos (prestador_id, categoria, convenio, competencia, numero, data_envio, tipo, observacao, nome_original, tamanho, chave, enviado_por, previsao_pagamento)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12, $13::date) RETURNING id`,
    [m.prestador_id, m.categoria, m.convenio, m.competencia, m.numero, m.data_envio, m.tipo, m.observacao, arquivo.nome, arquivo.tamanho, arquivo.chave, u.id, m.previsao_pagamento]
  );
  return d.id;
}

function limparNome(valor){
  let n = String(valor || 'documento.pdf').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 180);
  if (!n) n = 'documento.pdf';
  return /\.pdf$/i.test(n) ? n : n + '.pdf';
}
