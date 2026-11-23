// Portal do prestador: números do faturamento vindos das planilhas.
//   GET /api/prestador?acao=painel                 -> totais por competência + convênio
//   GET /api/prestador?acao=faturas&mes=AAAA-MM[&convenio=X] -> linhas (procedimentos) do mês
//   GET /api/prestador?acao=resumo&mes=AAAA-MM     -> resumo por convênio + tipo de guia
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

  const mes = p.get('mes') || '';
  if (!L.ehCompetencia(mes)) return L.responder(res, 400, { erro: 'Competência inválida.' });

  if (acao === 'faturas'){
    const convenio = p.get('convenio') || null;
    const linhas = await db.query(
      `SELECT id, convenio, operadora, lote, to_char(data_lote, 'YYYY-MM-DD') AS data_lote, tipo, paciente, guia,
              to_char(data, 'YYYY-MM-DD') AS data, grau, codigo, procedimento, qtd::float8 AS qtd,
              faturado::float8 AS faturado, recebido::float8 AS recebido, glosado::float8 AS glosado,
              to_char(data_pagamento, 'YYYY-MM-DD') AS data_pagamento, status, situacao, motivo_glosa, medico,
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
              bool_and(situacao <> 'aguardando') AS pago,
              to_char(max(data_pagamento), 'YYYY-MM-DD') AS data_pagamento,
              -- até quando o prestador tem para receber: a maior previsão dos lotes do grupo
              -- (a do protocolo cadastrado pela equipe vale mais que a da planilha/regra)
              to_char(max(COALESCE((SELECT d.previsao_pagamento FROM documentos d
                 WHERE d.prestador_id = producao.prestador_id AND d.categoria = 'protocolo' AND d.excluido_em IS NULL
                   AND d.numero = producao.lote AND d.previsao_pagamento IS NOT NULL ORDER BY d.id DESC LIMIT 1),
                 previsao_pagamento)), 'YYYY-MM-DD') AS previsao,
              min(to_char(data_lote, 'YYYY-MM-DD')) AS primeiro_envio,
              max(to_char(data_lote, 'YYYY-MM-DD')) AS ultimo_envio
         FROM producao WHERE prestador_id = $1 AND competencia = $2 AND ($3::text IS NULL OR ($3 = '-' AND medico IS NULL) OR medico = $3)
        GROUP BY convenio, tipo
        ORDER BY convenio, CASE tipo WHEN 'CONSULTA' THEN 1 WHEN 'SADT' THEN 2 WHEN 'HONORÁRIO' THEN 3 ELSE 4 END, tipo`,
      [prestadorId, mes, medico]
    );
    // Tudo junto numa clínica com médicos: também o total de cada médico.
    const por_medico = !medico && medicos.length ? await db.query(
      `SELECT COALESCE(medico, '') AS medico,
              count(DISTINCT COALESCE(guia, 'linha-' || id))::int AS guias,
              COALESCE(sum(faturado), 0)::float8 AS faturado
         FROM producao WHERE prestador_id = $1 AND competencia = $2
        GROUP BY COALESCE(medico, '') ORDER BY COALESCE(medico, '') = '', 1`,
      [prestadorId, mes]) : [];
    return L.responder(res, 200, { prestador, mes, grupos, por_medico, gerado_em: new Date().toISOString(), ...infoMedico });
  }

  return L.responder(res, 400, { erro: 'Ação desconhecida.' });
});
