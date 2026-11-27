// Portal do prestador: números do faturamento vindos das planilhas.
//   GET /api/prestador?acao=painel                 -> totais por competência + convênio
//   GET /api/prestador?acao=faturas&mes=AAAA-MM[&convenio=X] -> linhas (procedimentos) do mês
//   GET /api/prestador?acao=resumo&mes=AAAA-MM     -> resumo por convênio + tipo de guia
//   GET /api/prestador?acao=recursos               -> recursos de glosa, glosas acatadas e em análise para recurso
//   Todas aceitam &medico=NOME (só esse médico), &medico=- (linhas sem médico) ou nada (tudo junto).
//
// O prestador só enxerga o próprio cadastro (vem da sessão, nunca do
// parâmetro). A equipe Faturas Med pode consultar um prestador com &prestador=ID.

const L = require('./_lib');

module.exports = L.rota(async (req, res) => {
  const u = await L.exigirUsuario(req, res, ['prestador', 'faturas']);
  if (!u) return;
  if (req.method !== 'GET') return L.responder(res, 405, { erro: 'Método não permitido.' });
  const db = await L.prepararBanco();
  const p = L.parametros(req);
  const acao = p.get('acao');

  // Prestador: sempre o próprio cadastro. Se tentar pedir outro (&prestador=X), recusa.
  if (u.perfil === 'prestador' && p.get('prestador') && Number(p.get('prestador')) !== u.prestador_id){
    return L.responder(res, 403, { erro: 'Você só pode ver os seus próprios dados.' });
  }
  const prestadorId = u.perfil === 'prestador' ? u.prestador_id : Number(p.get('prestador'));
  if (!Number.isInteger(prestadorId) || prestadorId <= 0) return L.responder(res, 400, { erro: 'Escolha o prestador.' });
  const [prestador] = await db.query(`SELECT id, nome FROM prestadores WHERE id = $1`, [prestadorId]);
  if (!prestador) return L.responder(res, 404, { erro: 'Prestador não encontrado.' });

  // Médico dentro do prestador (clínica com vários médicos): '' = todos, '-' = sem médico, NOME = só ele.
  const medico = (p.get('medico') || '').trim().toUpperCase() || null;
  const medicos = (await db.query(`SELECT DISTINCT medico FROM producao WHERE prestador_id = $1 AND medico IS NOT NULL ORDER BY medico`, [prestadorId])).map(x => x.medico);
  const [{ n: semMedico }] = await db.query(`SELECT count(*)::int AS n FROM producao WHERE prestador_id = $1 AND medico IS NULL`, [prestadorId]);
  const infoMedico = { medico: medico || '', medicos, sem_medico: medicos.length > 0 && semMedico > 0 };

  if (acao === 'painel'){
    const linhas = await db.query(
      `SELECT competencia, convenio,
              count(DISTINCT COALESCE(guia, 'linha-' || id))::int AS guias,
              count(*)::int AS procedimentos,
              COALESCE(sum(faturado), 0)::float8 AS faturado,
              COALESCE(sum(recebido), 0)::float8 AS recebido,
              COALESCE(sum(GREATEST(glosado, 0)), 0)::float8 AS glosado,  -- Unimed às vezes paga acima do faturado (glosa negativa): não conta como glosa
              COALESCE(sum(faturado) FILTER (WHERE situacao = 'aguardando'), 0)::float8 AS a_receber
         FROM producao WHERE prestador_id = $1 AND ($2::text IS NULL OR ($2 = '-' AND medico IS NULL) OR medico = $2)
        GROUP BY competencia, convenio
        ORDER BY competencia, convenio`,
      [prestadorId, medico]
    );
    const [sync] = await db.query(`SELECT max(quando) AS quando FROM sincronizacoes WHERE prestador_id = $1`, [prestadorId]);
    // Próximos pagamentos: lotes com valor ainda não pago (situação aguardando),
    // com a previsão do protocolo (se houver) ou a do lote.
    const proximos = await db.query(
      `SELECT x.*, COALESCE(x.previsao_protocolo, x.previsao_lote) AS previsao FROM (
         SELECT p.competencia, p.convenio, p.lote,
                count(DISTINCT COALESCE(p.guia, 'linha-' || p.id))::int AS guias,
                sum(p.faturado)::float8 AS a_receber,
                to_char(max(p.previsao_pagamento), 'YYYY-MM-DD') AS previsao_lote,
                (SELECT to_char(d.previsao_pagamento, 'YYYY-MM-DD') FROM documentos d
                  WHERE d.prestador_id = $1 AND d.categoria = 'protocolo' AND d.excluido_em IS NULL
                    AND d.numero = p.lote AND d.previsao_pagamento IS NOT NULL ORDER BY d.id DESC LIMIT 1) AS previsao_protocolo
           FROM producao p
          WHERE p.prestador_id = $1 AND p.situacao = 'aguardando' AND ($2::text IS NULL OR ($2 = '-' AND p.medico IS NULL) OR p.medico = $2)
          GROUP BY p.competencia, p.convenio, p.lote) x
        ORDER BY COALESCE(x.previsao_protocolo, x.previsao_lote) NULLS LAST, x.convenio, x.lote`,
      [prestadorId, medico]
    );
    return L.responder(res, 200, { prestador, linhas, proximos, hoje: L.hojeBrasil(), atualizado_em: sync && sync.quando, ...infoMedico });
  }

  // Aba exclusiva "Lotes Bradesco" (só quem tem a aba: PATHOLOGY). Lotes do ano pela data de envio.
  if (acao === 'lotes'){
    if (!L.abasExtras(prestador.nome).includes('lotes')) return L.responder(res, 404, { erro: 'Esta aba não existe para este prestador.' });
    const ano = /^\d{4}$/.test(p.get('ano') || '') ? p.get('ano') : L.hojeBrasil().slice(0, 4);
    const linhas = await db.query(
      `SELECT convenio, lote, to_char(data_lote, 'YYYY-MM-DD') AS data_lote, tipo, guia,
              faturado::float8 AS faturado, recebido::float8 AS recebido, glosado::float8 AS glosado,
              to_char(data_pagamento, 'YYYY-MM-DD') AS data_pagamento, status, situacao, motivo_glosa,
              status_inicial, to_char(data_pagamento_inicial, 'YYYY-MM-DD') AS data_pagamento_inicial,
              recurso_recursado::float8 AS recurso_recursado, recurso_acatado::float8 AS recurso_acatado,
              -- chamado aberto no Bradesco para o lote (Willian 26-27/11): nº, data e se a guia está entre as pendentes
              (SELECT json_build_object('numero', c.chamado, 'aberto_em', to_char(c.aberto_em, 'YYYY-MM-DD'),
                      'guia_pendente', jsonb_array_length(c.guias_pendentes) = 0 OR c.guias_pendentes @> jsonb_build_array(producao.guia))
                 FROM chamados c WHERE c.prestador_id = producao.prestador_id AND c.fonte = producao.fonte AND c.lote = producao.lote) AS chamado,
              to_char(COALESCE((SELECT d.previsao_pagamento FROM documentos d
                 WHERE d.prestador_id = producao.prestador_id AND d.categoria = 'protocolo' AND d.excluido_em IS NULL
                   AND d.numero = producao.lote AND d.previsao_pagamento IS NOT NULL ORDER BY d.id DESC LIMIT 1),
                 previsao_pagamento), 'YYYY-MM-DD') AS previsao
         FROM producao
        WHERE prestador_id = $1 AND convenio LIKE 'BRADESCO%'
          AND to_char(COALESCE(data_lote, to_date(competencia || '-01', 'YYYY-MM-DD')), 'YYYY') = $2
          AND ($3::text IS NULL OR ($3 = '-' AND medico IS NULL) OR medico = $3)`,
      [prestadorId, ano, medico]
    );
    const anos = (await db.query(
      `SELECT DISTINCT to_char(COALESCE(data_lote, to_date(competencia || '-01', 'YYYY-MM-DD')), 'YYYY') AS ano
         FROM producao WHERE prestador_id = $1 AND convenio LIKE 'BRADESCO%' ORDER BY 1 DESC`, [prestadorId])).map(x => x.ano);
    const { montarLotes, somarLotes } = require('./_lotes');
    const lotes = montarLotes(linhas, L.hojeBrasil());
    const [sync] = await db.query(`SELECT quando FROM sincronizacoes WHERE prestador_id = $1 AND convenio = 'BRADESCO'`, [prestadorId]);
    return L.responder(res, 200, { prestador, ano, anos, lotes, totais: somarLotes(lotes), hoje: L.hojeBrasil(),
      atualizado_em: sync && sync.quando, gerado_em: new Date().toISOString() });
  }

  // Aba "Recursos" (Gustavo 26/11/2026; só quem tem a opção abaRecursos em PERSONALIZACAO, api/_lib.js): recursos de glosa enviados (com a data),
  // recebidos, negados, glosas acatadas e glosas em análise para recurso (STATUS ATENÇÃO). Contas em api/_lotes.js.
  if (acao === 'recursos'){
    if (!L.opcoesPrestador(prestador.nome).abaRecursos) return L.responder(res, 404, { erro: 'Esta aba não existe para este prestador.' });
    const linhas = await db.query(
      `SELECT convenio, lote, to_char(data_lote, 'YYYY-MM-DD') AS data_lote, paciente, guia, to_char(data, 'YYYY-MM-DD') AS data,
              codigo, procedimento, faturado::float8 AS faturado, recebido::float8 AS recebido, glosado::float8 AS glosado,
              to_char(data_pagamento, 'YYYY-MM-DD') AS data_pagamento, status, status_inicial, motivo_glosa, resposta_operadora, medico,
              recurso_recursado::float8 AS recurso_recursado, recurso_acatado::float8 AS recurso_acatado,
              to_char(recurso_data, 'YYYY-MM-DD') AS recurso_data, recurso_protocolo
         FROM producao
        WHERE prestador_id = $1
          AND (upper(status) LIKE 'RECURS%' OR upper(status) LIKE 'ACATAD%' OR upper(status) LIKE 'ATEN%'
               OR upper(status_inicial) LIKE '%RECURS%' OR recurso_recursado IS NOT NULL)
          AND ($2::text IS NULL OR ($2 = '-' AND medico IS NULL) OR medico = $2)
        ORDER BY convenio, data_lote, lote, guia, data, id`,
      [prestadorId, medico]
    );
    const { montarRecursos, somarRecursos } = require('./_lotes');
    const r = montarRecursos(linhas);
    const [sync] = await db.query(`SELECT max(quando) AS quando FROM sincronizacoes WHERE prestador_id = $1`, [prestadorId]);
    return L.responder(res, 200, { prestador, ...r, totais: somarRecursos(r), hoje: L.hojeBrasil(), opcoes: L.opcoesPrestador(prestador.nome),
      atualizado_em: sync && sync.quando, gerado_em: new Date().toISOString(), ...infoMedico });
  }

  const mes = p.get('mes') || '';
  if (!L.ehCompetencia(mes)) return L.responder(res, 400, { erro: 'Competência inválida.' });

  if (acao === 'faturas'){
    const convenio = p.get('convenio') || null;
    const linhas = await db.query(
      `SELECT id, convenio, operadora, lote, to_char(data_lote, 'YYYY-MM-DD') AS data_lote, tipo, paciente, guia,
              to_char(data, 'YYYY-MM-DD') AS data, grau, codigo, procedimento, qtd::float8 AS qtd,
              faturado::float8 AS faturado, recebido::float8 AS recebido, glosado::float8 AS glosado,
              to_char(data_pagamento, 'YYYY-MM-DD') AS data_pagamento, status, situacao, motivo_glosa, medico,
              -- histórico da guia (recurso / glosa acatada) na coluna Situação — Gustavo 26/11
              status_inicial, to_char(data_pagamento_inicial, 'YYYY-MM-DD') AS data_pagamento_inicial,
              recurso_recursado::float8 AS recurso_recursado, recurso_acatado::float8 AS recurso_acatado,
              to_char(recurso_data, 'YYYY-MM-DD') AS recurso_data, recurso_protocolo, resposta_operadora,
              -- chamado aberto no Bradesco para o lote (Willian 26-27/11): nº, data e se a guia está entre as pendentes
              (SELECT json_build_object('numero', c.chamado, 'aberto_em', to_char(c.aberto_em, 'YYYY-MM-DD'),
                      'guia_pendente', jsonb_array_length(c.guias_pendentes) = 0 OR c.guias_pendentes @> jsonb_build_array(producao.guia))
                 FROM chamados c WHERE c.prestador_id = producao.prestador_id AND c.fonte = producao.fonte AND c.lote = producao.lote) AS chamado,
              to_char(COALESCE((SELECT d.previsao_pagamento FROM documentos d
                 WHERE d.prestador_id = producao.prestador_id AND d.categoria = 'protocolo' AND d.excluido_em IS NULL
                   AND d.numero = producao.lote AND d.previsao_pagamento IS NOT NULL ORDER BY d.id DESC LIMIT 1),
                 previsao_pagamento), 'YYYY-MM-DD') AS previsao
         FROM producao
        WHERE prestador_id = $1 AND competencia = $2 AND ($3::text IS NULL OR convenio = $3)
          AND ($4::text IS NULL OR ($4 = '-' AND medico IS NULL) OR medico = $4)
        ORDER BY convenio, data_lote NULLS LAST, lote NULLS LAST, paciente, guia, id`,
      [prestadorId, mes, convenio, medico]
    );
    return L.responder(res, 200, { prestador, mes, linhas, ...infoMedico });
  }

  if (acao === 'resumo'){
    const grupos = await db.query(
      `SELECT convenio, tipo,
              count(DISTINCT COALESCE(guia, 'linha-' || id))::int AS guias,
              count(*)::int AS procedimentos,
              COALESCE(sum(faturado), 0)::float8 AS faturado,
              COALESCE(sum(recebido), 0)::float8 AS recebido,
              COALESCE(sum(GREATEST(glosado, 0)), 0)::float8 AS glosado,  -- igual ao painel: glosa negativa (Unimed) não conta
              COALESCE(sum(faturado) FILTER (WHERE situacao = 'aguardando'), 0)::float8 AS a_receber,
              bool_and(situacao <> 'aguardando') AS pago,
              -- Situação do grupo (coluna "Situação" da folha): o que já foi pago (datas)
              -- e o que está aguardando (até quando).
              count(*) FILTER (WHERE situacao <> 'aguardando')::int AS n_pagos,
              count(*) FILTER (WHERE situacao = 'aguardando')::int AS n_aguardando,
              bool_and(situacao = 'glosado') AS tudo_glosado,
              to_char(min(data_pagamento) FILTER (WHERE situacao <> 'aguardando'), 'YYYY-MM-DD') AS pago_de,
              to_char(max(data_pagamento) FILTER (WHERE situacao <> 'aguardando'), 'YYYY-MM-DD') AS data_pagamento,
              -- até quando o prestador tem para receber: a maior previsão das linhas aguardando
              -- (a do protocolo cadastrado pela equipe vale mais que a da planilha/regra)
              to_char(max(COALESCE((SELECT d.previsao_pagamento FROM documentos d
                 WHERE d.prestador_id = producao.prestador_id AND d.categoria = 'protocolo' AND d.excluido_em IS NULL
                   AND d.numero = producao.lote AND d.previsao_pagamento IS NOT NULL ORDER BY d.id DESC LIMIT 1),
                 previsao_pagamento)) FILTER (WHERE situacao = 'aguardando'), 'YYYY-MM-DD') AS previsao,
              min(to_char(data_lote, 'YYYY-MM-DD')) AS primeiro_envio,
              max(to_char(data_lote, 'YYYY-MM-DD')) AS ultimo_envio
         FROM producao WHERE prestador_id = $1 AND competencia = $2 AND ($3::text IS NULL OR ($3 = '-' AND medico IS NULL) OR medico = $3)
        GROUP BY convenio, tipo
        ORDER BY convenio, CASE tipo WHEN 'CONSULTA' THEN 1 WHEN 'SADT' THEN 2 WHEN 'HONORÁRIO' THEN 3 ELSE 4 END, tipo`,
      [prestadorId, mes, medico]
    );
    // Mesmas somas do painel (convênio inteiro): subtotais e total da folha batem com o painel.
    const SOMAS = `count(DISTINCT COALESCE(guia, 'linha-' || id))::int AS guias,
              COALESCE(sum(faturado), 0)::float8 AS faturado,
              COALESCE(sum(recebido), 0)::float8 AS recebido,
              COALESCE(sum(GREATEST(glosado, 0)), 0)::float8 AS glosado,
              COALESCE(sum(faturado) FILTER (WHERE situacao = 'aguardando'), 0)::float8 AS a_receber`;
    const por_convenio = await db.query(
      `SELECT convenio, ${SOMAS}
         FROM producao WHERE prestador_id = $1 AND competencia = $2 AND ($3::text IS NULL OR ($3 = '-' AND medico IS NULL) OR medico = $3)
        GROUP BY convenio ORDER BY convenio`,
      [prestadorId, mes, medico]
    );
    // Tudo junto numa clínica com médicos: também o total de cada médico.
    const por_medico = !medico && medicos.length ? await db.query(
      `SELECT COALESCE(medico, '') AS medico, ${SOMAS}
         FROM producao WHERE prestador_id = $1 AND competencia = $2
        GROUP BY COALESCE(medico, '') ORDER BY COALESCE(medico, '') = '', 1`,
      [prestadorId, mes]) : [];
    return L.responder(res, 200, { prestador, mes, grupos, por_convenio, por_medico, gerado_em: new Date().toISOString(), ...infoMedico });
  }

  return L.responder(res, 400, { erro: 'Ação desconhecida.' });
});
