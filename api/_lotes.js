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
    const ehRecurso = ini.includes('RECURS') || st.startsWith('RECURSO') || st.startsWith('RECURSADO');
    let glosaFinal = 0;  // o que fica como glosa (motivo entra na observação)
    if (ehRecurso && st.startsWith('RECURSADO')){  // "RECURSADO" ou "RECURSADO DIA dd/mm/aaaa"
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

// ---------------------------------------------------------------- aba Recursos
// Gustavo 26/11/2026 (reunião com a INTEGRADA INFANTIL): recursos de glosa realizados, com a data em que
// cada um foi enviado, os negados, os recebidos (pagos) e as glosas acatadas. Vale para todos os prestadores
// (sai do STATUS da planilha CONTROLE); onde há XML de resposta (RECURSOS_XML no sincronizar.py) entram
// também o recursado/acatado item a item, a data e o protocolo do recurso.
//   STATUS "RECURSADO DIA dd/mm/aaaa"         -> recurso enviado, em análise (valor = glosado)
//   STATUS "RECURSO RECEBIDO" / "... PARCIAL" -> respondido: recebido = acatado do XML (sem XML, o recebido
//   / "RECURSO NEGADO" (ou STATUS INICIAL        da linha); negado = o glosado que sobrou
//   "RECURSADO DIA ...")
//   resposta no XML sem baixa na planilha      -> acatado aguardando pagamento + negado
//   STATUS "ACATADO"                           -> glosa acatada (aceita, não recursada)
//   STATUS "ATENÇÃO"                           -> glosado, em análise para recurso (ainda não recursado)
// Por recurso (convênio + data do recurso + lote): recursado = recebido + a receber + negado + em análise.
const CAMPOS_RECURSO = ['recursado', 'recebido', 'a_receber', 'negado', 'em_analise'];

function classificarRecurso(l){
  const st = sem(l.status), ini = sem(l.status_inicial);
  const rec = Math.max(Number(l.recebido) || 0, 0), glo = Math.max(Number(l.glosado) || 0, 0);
  const temXml = l.recurso_recursado !== null && l.recurso_recursado !== undefined;
  if (st.startsWith('ACATAD')) return { grupo: 'acatada', valor: glo };
  // "RECURSO PRONTO PARA LIBERAÇÃO NO PORTAL" (Amil) = recurso montado, ainda não enviado
  if (st.startsWith('ATENCAO') || st.startsWith('RECURSO PRONTO')) return { grupo: 'analise', valor: glo };
  const v = { grupo: 'recurso', recursado: 0, recebido: 0, a_receber: 0, negado: 0, em_analise: 0 };
  if (st.startsWith('RECURSADO')){  // "RECURSADO", "RECURSADO DIA dd/mm/aa(aa)", "RECURSADO EM ..."
    v.em_analise = glo; v.situacao = 'analise';
  } else if (st.startsWith('RECURSO RECEBIDO') || st.startsWith('RECURSO NEGADO') || ini.includes('RECURS')){
    const ac = st.includes('NEGADO') ? 0 : temXml ? Math.min(Math.max(Number(l.recurso_acatado) || 0, 0), rec) : rec;
    v.recebido = ac; v.negado = glo;
    v.situacao = ac < 0.005 ? 'negado' : glo >= 0.005 ? 'parcial' : 'recebido';
  } else if (temXml && Number(l.recurso_recursado) > 0.005){
    // resposta do recurso já veio (XML), mas a baixa ainda não foi feita na planilha
    const recursado = glo > 0.005 ? Math.min(Number(l.recurso_recursado), glo) : Number(l.recurso_recursado);
    const ac = Math.min(Math.max(Number(l.recurso_acatado) || 0, 0), recursado);
    v.a_receber = ac; v.negado = recursado - ac;
    v.situacao = ac < 0.005 ? 'negado' : 'a_receber';
  } else return null;
  v.recursado = v.recebido + v.a_receber + v.negado + v.em_analise;
  return v;
}

const NOMES_RECURSO = { analise: 'Em análise', recebido: 'Recebido', parcial: 'Recebido em parte', negado: 'Negado', a_receber: 'Acatado, aguardando pagamento' };

function montarRecursos(linhas){
  const por = new Map(), acatadas = [], analise = [];
  for (const l of linhas){
    const c = classificarRecurso(l);
    if (!c) continue;
    const item = { convenio: l.convenio, lote: l.lote || '', data_lote: l.data_lote, paciente: l.paciente, guia: l.guia, data: l.data,
      codigo: l.codigo, procedimento: l.procedimento, faturado: r2(l.faturado), data_pagamento: l.data_pagamento,
      motivo: l.motivo_glosa || '', resposta: l.resposta_operadora || '', medico: l.medico || '' };
    if (c.grupo === 'acatada'){ acatadas.push({ ...item, valor: r2(c.valor) }); continue; }
    if (c.grupo === 'analise'){ analise.push({ ...item, valor: r2(c.valor) }); continue; }
    const chave = `${l.convenio}|${l.recurso_data || ''}|${l.lote || ''}`;
    let g = por.get(chave);
    if (!g){
      g = { convenio: l.convenio, lote: l.lote || '', data_lote: l.data_lote, data_recurso: l.recurso_data || null,
        protocolos: new Set(), guias: new Set(), pagamentos: new Set(), itens: [] };
      CAMPOS_RECURSO.forEach(k => { g[k] = 0; });
      por.set(chave, g);
    }
    if (l.recurso_protocolo) g.protocolos.add(l.recurso_protocolo);
    g.guias.add(l.guia || `linha-${g.itens.length}`);
    if (c.recebido >= 0.005 && l.data_pagamento) g.pagamentos.add(l.data_pagamento);
    CAMPOS_RECURSO.forEach(k => { g[k] += c[k]; });
    const it = { ...item, situacao: c.situacao, nome_situacao: NOMES_RECURSO[c.situacao] };
    CAMPOS_RECURSO.forEach(k => { it[k] = r2(c[k]); });
    g.itens.push(it);
  }
  const recursos = Array.from(por.values()).map(g => {
    const x = { convenio: g.convenio, lote: g.lote, data_lote: g.data_lote, data_recurso: g.data_recurso,
      protocolos: Array.from(g.protocolos).sort(), guias: g.guias.size, pagamentos: Array.from(g.pagamentos).sort(), itens: g.itens };
    CAMPOS_RECURSO.forEach(k => { x[k] = r2(g[k]); });
    if (x.em_analise >= 0.01){ x.situacao = 'Em análise'; x.classe = 'recurso'; x.chave = 'analise'; }
    else if (x.a_receber >= 0.01){ x.situacao = 'Acatado, aguardando pagamento'; x.classe = 'aguardando'; x.chave = 'a_receber'; }
    else if (x.negado < 0.01){ x.situacao = 'Recebido'; x.classe = 'finalizado'; x.chave = 'recebido'; }
    else if (x.recebido < 0.01){ x.situacao = 'Negado'; x.classe = 'negado'; x.chave = 'negado'; }
    else { x.situacao = 'Recebido em parte'; x.classe = 'finalizado'; x.chave = 'parcial'; }
    return x;
  });
  // mais recente primeiro; recurso sem data no fim
  recursos.sort((a, b) => String(b.data_recurso || '').localeCompare(String(a.data_recurso || '')) || a.convenio.localeCompare(b.convenio) || String(a.lote).localeCompare(String(b.lote)));
  const ordem = (a, b) => String(b.data_lote || '').localeCompare(String(a.data_lote || '')) || String(a.lote).localeCompare(String(b.lote)) || String(a.guia).localeCompare(String(b.guia));
  acatadas.sort(ordem); analise.sort(ordem);
  return { recursos, acatadas, analise };
}

function somarRecursos({ recursos, acatadas, analise }){
  const t = { recursos: recursos.length, itens: 0, sem_data: 0,
    acatadas: r2(acatadas.reduce((s, x) => s + x.valor, 0)), n_acatadas: acatadas.length,
    analise: r2(analise.reduce((s, x) => s + x.valor, 0)), n_analise: analise.length };
  CAMPOS_RECURSO.forEach(c => { t[c] = 0; });
  recursos.forEach(r => { t.itens += r.itens.length; if (!r.data_recurso) t.sem_data += r.itens.length; CAMPOS_RECURSO.forEach(c => { t[c] += r[c]; }); });
  CAMPOS_RECURSO.forEach(c => { t[c] = r2(t[c]); });
  return t;
}

module.exports = { montarLotes, somarLotes, CAMPOS_TOTAIS, montarRecursos, somarRecursos, CAMPOS_RECURSO };
