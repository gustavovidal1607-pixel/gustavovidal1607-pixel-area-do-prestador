// Aba "Lotes Bradesco" (exclusiva da PATHOLOGY — Willian 24/11/2026): os lotes do
// Bradesco (Saúde e Operadora) do ano, lote a lote, com cada pagamento picado,
// glosa, aguardando, recurso (recursado, acatado, recebido, negado) e situação.
//
// Tudo sai das linhas da planilha CONTROLE (tabela producao). Linha baixada como
// recurso pelo Bradescolino (STATUS INICIAL = RECURSADO; STATUS = RECURSO RECEBIDO /
// RECURSO RECEBIDO PARCIAL / RECURSO NEGADO) tem no VALOR RECEBIDO o pagamento original
// + o acatado no recurso, e no VALOR GLOSADO o que sobrou (negado). O sync põe em cada
// linha o recursado e o acatado da resposta do recurso (XML), então:
//   pagamento original = recebido - acatado, na DATA DO PAGAMENTO INICIAL;
//   recurso recebido   = acatado, na DATA PAGAMENTO;
//   recurso negado     = glosado da linha de recurso (regra da casa: nunca "glosa").
// Por lote: faturado = recebido + glosa + aguardando + recurso em análise
//           + recurso recebido + recurso a receber + recurso negado.

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const sem = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

function somarEm(lista, data, valor){
  if (Math.abs(valor) < 0.005) return;
  const d = data || null;
  const x = lista.find(p => p.data === d);
  if (x) x.valor += valor; else lista.push({ data: d, valor });
}

function montarLotes(linhas, hoje = null){
  const por = new Map();
  for (const l of linhas){
    const chave = `${l.convenio}|${l.lote || '(sem lote)'}`;
    let t = por.get(chave);
    if (!t){
      t = { convenio: l.convenio, lote: l.lote || '', data_envio: null, tipos: new Set(), guias: new Set(),
        faturado: 0, recebido: 0, pagamentos: [], glosa: 0, aguardando: 0, previsao: null,
        recursado: 0, em_analise: 0, acatado: 0, recurso_recebido: 0, recurso_pagamentos: [], recurso_a_receber: 0, recurso_negado: 0,
        motivos: new Map(), linhas: 0 };
      por.set(chave, t);
    }
    t.linhas++;
    if (l.data_lote && (!t.data_envio || l.data_lote < t.data_envio)) t.data_envio = l.data_lote;
    if (l.tipo) t.tipos.add(l.tipo);
    t.guias.add(l.guia || `linha-${t.linhas}`);
    const fat = Number(l.faturado) || 0, rec = Number(l.recebido) || 0, glo = Math.max(Number(l.glosado) || 0, 0);
    t.faturado += fat;
    if (l.situacao === 'aguardando'){
      t.aguardando += fat;
      if (l.previsao && (!t.previsao || l.previsao > t.previsao)) t.previsao = l.previsao;
      continue;
    }
    const st = sem(l.status), ini = sem(l.status_inicial);
    const ehRecurso = ini.includes('RECURS') || st.startsWith('RECURSO');
    let glosaFinal = 0;  // o que fica como glosa (motivo entra na observação)
    if (ehRecurso && st === 'RECURSADO'){
      // recurso enviado, ainda sem resposta
      somarEm(t.pagamentos, l.data_pagamento_inicial || l.data_pagamento, rec); t.recebido += rec;
      t.em_analise += glo; t.recursado += glo;
    } else if (ehRecurso){
      const ac = st.includes('NEGADO') ? 0 : Math.min(Math.max(Number(l.recurso_acatado) || 0, 0), rec);
      const original = rec - ac;
      somarEm(t.pagamentos, l.data_pagamento_inicial || l.data_pagamento, original); t.recebido += original;
      somarEm(t.recurso_pagamentos, l.data_pagamento, ac); t.recurso_recebido += ac; t.acatado += ac;
      t.recurso_negado += glo; t.recursado += ac + glo;
      if (glo > 0.005) glosaFinal = glo;
    } else {
      somarEm(t.pagamentos, l.data_pagamento, rec); t.recebido += rec;
      const recursado = Math.min(Math.max(Number(l.recurso_recursado) || 0, 0), glo);
      if (recursado > 0.005){
        // resposta do recurso já veio, mas a baixa ainda não foi feita na planilha
        const ac = Math.min(Math.max(Number(l.recurso_acatado) || 0, 0), recursado);
        t.recursado += recursado; t.acatado += ac; t.recurso_a_receber += ac; t.recurso_negado += recursado - ac;
        t.glosa += glo - recursado;
      } else t.glosa += glo;
      glosaFinal = glo;
    }
    if (glosaFinal > 0.005 && l.motivo_glosa){
      const m = String(l.motivo_glosa).split(' / ')[0].trim();
      t.motivos.set(m, (t.motivos.get(m) || 0) + glosaFinal);
    }
  }
  const lotes = [];
  for (const t of por.values()){
    const ordenar = ps => ps.map(p => ({ data: p.data, valor: r2(p.valor) })).filter(p => Math.abs(p.valor) >= 0.005)
      .sort((a, b) => String(a.data || '9').localeCompare(String(b.data || '9')));
    const x = {
      convenio: t.convenio, lote: t.lote, data_envio: t.data_envio, tipos: Array.from(t.tipos).sort(), guias: t.guias.size,
      faturado: r2(t.faturado), recebido: r2(t.recebido), pagamentos: ordenar(t.pagamentos), glosa: r2(t.glosa),
      aguardando: r2(t.aguardando), previsao: t.previsao,
      recursado: r2(t.recursado), em_analise: r2(t.em_analise), acatado: r2(t.acatado),
      recurso_recebido: r2(t.recurso_recebido), recurso_pagamentos: ordenar(t.recurso_pagamentos),
      recurso_a_receber: r2(t.recurso_a_receber), recurso_negado: r2(t.recurso_negado),
    };
    // situação do lote
    if (x.aguardando >= 0.01){
      x.situacao = x.recebido >= 0.01 || x.glosa >= 0.01 ? 'Aguardando restante' : 'Aguardando pagamento';
      x.classe = 'aguardando';
    } else if (x.em_analise >= 0.01){ x.situacao = 'Recurso em análise'; x.classe = 'recurso'; }
    else if (x.recurso_a_receber >= 0.01){ x.situacao = 'Recurso acatado, aguardando pagamento'; x.classe = 'recurso'; }
    else { x.situacao = 'Finalizado'; x.classe = 'finalizado'; }
    // observação: previsão do que falta e os principais motivos de glosa / recurso negado
    const obs = [];
    if (x.aguardando >= 0.01 && x.previsao){
      const br = `${x.previsao.slice(8, 10)}/${x.previsao.slice(5, 7)}/${x.previsao.slice(0, 4)}`;
      obs.push(hoje && x.previsao < hoje ? `Prazo de pagamento venceu em ${br}` : `Previsão de pagamento até ${br}`);
    }
    if (x.recursado >= 0.01) obs.push(x.em_analise >= 0.01 ? 'Recurso enviado, aguardando resposta'
      : x.recurso_negado < 0.01 ? 'Recurso aceito integralmente' : x.acatado < 0.01 ? 'Recurso negado pela operadora' : 'Recurso aceito em parte');
    const motivos = Array.from(t.motivos.entries()).filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([m]) => m);
    if (motivos.length) obs.push(`Motivo: ${motivos.join('; ')}`);
    x.obs = obs.join(' · ');
    lotes.push(x);
  }
  lotes.sort((a, b) => String(a.data_envio || '').localeCompare(String(b.data_envio || '')) || a.convenio.localeCompare(b.convenio) || String(a.lote).localeCompare(String(b.lote)));
  return lotes;
}

const CAMPOS_TOTAIS = ['faturado', 'recebido', 'glosa', 'aguardando', 'recursado', 'em_analise', 'acatado', 'recurso_recebido', 'recurso_a_receber', 'recurso_negado'];
function somarLotes(lotes){
  const t = { lotes: lotes.length, guias: 0 };
  CAMPOS_TOTAIS.forEach(c => { t[c] = 0; });
  lotes.forEach(l => { t.guias += l.guias; CAMPOS_TOTAIS.forEach(c => { t[c] += l[c]; }); });
  CAMPOS_TOTAIS.forEach(c => { t[c] = r2(t[c]); });
  return t;
}

module.exports = { montarLotes, somarLotes, CAMPOS_TOTAIS };
