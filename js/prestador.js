// Área do Prestador (médico/clínica cliente da Faturas Med) e a aba
// "Prestadores" da equipe. Usa os utilitários de js/app.js (window.CF).
(function(){
  'use strict';

  const CF = () => window.CF;
  const $ = (s, r) => CF().$(s, r);
  const $$ = (s, r) => CF().$$(s, r);
  const h = s => CF().h(s);

  const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const dinheiro = v => moeda.format(Number(v) || 0);
  const dinheiroCurto = v => {
    const n = Number(v) || 0;
    if (Math.abs(n) >= 1e6) return `R$ ${(n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
    if (Math.abs(n) >= 1e3) return `R$ ${(n / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`;
    return `R$ ${n.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;
  };
  const pct = v => `${(Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  const compBR = c => c ? `${c.slice(5, 7)}/${c.slice(0, 4)}` : '';
  const compNome = c => c ? `${CF().MESES[Number(c.slice(5, 7)) - 1]} de ${c.slice(0, 4)}` : 'Todas as competências';
  const dataBR = iso => CF().dataBR(iso);

  const SITUACOES = {
    pago: { nome: 'Pago', classe: 'pago' },
    parcial: { nome: 'Parcial', classe: 'parcial' },
    glosado: { nome: 'Glosado', classe: 'glosado' },
    aguardando: { nome: 'Aguardando', classe: 'aguardando' },
  };
  const TIPO_NOME = { 'CONSULTA': 'Consulta', 'SADT': 'SADT', 'HONORÁRIO': 'Honorário (GIH)' };
  const tipoNome = t => TIPO_NOME[t] || t;
  const CONVENIO_NOME = { 'UNIMED': 'Unimed', 'BRADESCO SAÚDE': 'Bradesco Saúde', 'BRADESCO OPERADORA': 'Bradesco Operadora', 'MEDISERVICE': 'Mediservice', 'SULAMÉRICA': 'SulAmérica', 'PETROBRÁS': 'Petrobras' };

  // Estado da Área do Prestador (zera a cada login).
  let P = null;
  function novoEstado(){
    return { usuario: CF().estado.usuario.id, painel: null, atualizado: null, comp: null, convenio: '', faturas: {}, filtroSit: '', busca: '', docs: {},
      medico: '', medicos: [], semMedico: false, aba: 'painel' };
  }

  // ================================================================ PORTAL DO PRESTADOR
  async function portal(caixa, aba){
    if (!P || P.usuario !== CF().estado.usuario.id) P = novoEstado();
    P.aba = aba || 'painel';
    caixa.innerHTML = `<div class="portal" id="portal"><div class="carregando">Carregando…</div></div>`;
    try {
      if (!P.painel){
        const r = await CF().api(`/api/prestador?acao=painel${qMedico()}`);
        P.painel = r.linhas; P.atualizado = r.atualizado_em; P.proximos = r.proximos || []; P.hoje = r.hoje;
        P.medicos = r.medicos || []; P.semMedico = !!r.sem_medico;
        const comps = competencias();
        if (P.comp === null) P.comp = comps[0] || '';
      }
    } catch (e){ $('#portal').innerHTML = `<div class="vazio"><strong>Não deu para carregar</strong>${h(e.message)}</div>`; return; }
    if (aba === 'faturas') return telaFaturas();
    if (aba === 'resumo') return telaResumo();
    if (aba === 'lotes') return telaLotes($('#portal'));
    if (aba === 'protocolos') return telaDocumentos('protocolo');
    if (aba === 'espelhos') return telaDocumentos('espelho');
    if (aba === 'repasses') return telaDocumentos('repasse');
    return telaPainel();
  }

  const competencias = () => Array.from(new Set(P.painel.map(l => l.competencia))).sort().reverse();
  const conveniosDoPainel = () => Array.from(new Set(P.painel.map(l => l.convenio))).sort();

  function somar(linhas){
    const t = { faturado: 0, recebido: 0, glosado: 0, a_receber: 0, guias: 0, procedimentos: 0 };
    linhas.forEach(l => { for (const k in t) t[k] += Number(l[k]) || 0; });
    t.pct_glosa = t.faturado > 0 ? (t.glosado / t.faturado) * 100 : 0;
    return t;
  }

  // Médico dentro da clínica (Azul, CAEM…): '' = tudo junto, '-' = sem médico, NOME = só ele.
  const qMedico = () => P.medico ? `&medico=${encodeURIComponent(P.medico)}` : '';
  const nomeMedico = m => m === '-' ? 'Sem executante informado' : (m || 'Todos os executantes');
  function seletorMedico(id){
    if (!P.medicos.length) return '';
    return `
        <label class="campo"><span>Executante</span>
          <select id="${id}">
            <option value="" ${P.medico === '' ? 'selected' : ''}>Todos (clínica inteira)</option>
            ${P.medicos.map(m => `<option value="${h(m)}" ${m === P.medico ? 'selected' : ''}>${h(m)}</option>`).join('')}
            ${P.semMedico ? `<option value="-" ${P.medico === '-' ? 'selected' : ''}>Sem executante informado</option>` : ''}
          </select>
        </label>`;
  }
  function trocarMedico(v){
    P.medico = v; P.painel = null; P.faturas = {}; P.docs = {};
    CF().irParaAba(P.aba);
  }

  function filtros({ todas = true, resumo = true } = {}){
    const comps = competencias();
    return `
      <div class="filtros-portal">
        <label class="campo"><span>Competência</span>
          <select id="f-comp">
            ${todas ? `<option value="" ${P.comp === '' ? 'selected' : ''}>Todas</option>` : ''}
            ${comps.map(c => `<option value="${c}" ${c === P.comp ? 'selected' : ''}>${compBR(c)}</option>`).join('')}
          </select>
        </label>
        <label class="campo"><span>Convênio</span>
          <select id="f-conv">
            <option value="">Todos</option>
            ${conveniosDoPainel().map(c => `<option value="${h(c)}" ${c === P.convenio ? 'selected' : ''}>${h(c)}</option>`).join('')}
          </select>
        </label>
        ${seletorMedico('f-med')}
        ${resumo ? `<button type="button" class="botao primario" id="btn-resumo">Ver resumo</button>` : ''}
      </div>`;
  }

  function ligarFiltros(aoMudar){
    $('#f-comp').onchange = ev => { P.comp = ev.target.value; aoMudar(); };
    $('#f-conv').onchange = ev => { P.convenio = ev.target.value; aoMudar(); };
    const fm = $('#f-med');
    if (fm) fm.onchange = ev => trocarMedico(ev.target.value);
    const b = $('#btn-resumo');
    if (b) b.onclick = () => { if (!P.comp) P.comp = competencias()[0]; CF().irParaAba('resumo'); };
  }

  function cabecalho(titulo, sub, extra){
    return `
      <div class="portal-cabeca">
        <div>
          <h2>${h(titulo)}</h2>
          ${sub ? `<p>${sub}</p>` : ''}
        </div>
        ${extra || ''}
      </div>`;
  }

  // ---------------------------------------------------------------- painel
  function telaPainel(){
    const caixa = $('#portal');
    if (!P.painel.length){
      caixa.innerHTML = cabecalho('Painel', '') + `<div class="painel vazio"><strong>Ainda não há faturamento aqui</strong>Os números aparecem assim que a Faturas Med sincronizar as suas planilhas.</div>`;
      return;
    }
    const doConv = P.painel.filter(l => !P.convenio || l.convenio === P.convenio);
    const sel = doConv.filter(l => !P.comp || l.competencia === P.comp);
    const t = somar(sel);
    const atualizado = P.atualizado ? `Atualizado em ${h(CF().quandoBR(P.atualizado))}.` : '';
    caixa.innerHTML = `
      ${cabecalho('Painel', `${h(compNome(P.comp))}${P.convenio ? ' · ' + h(P.convenio) : ''}${P.medico ? ' · ' + h(nomeMedico(P.medico)) : ''}. ${atualizado}`, filtros())}
      <div class="cartoes">
        ${cartao('Faturado', dinheiro(t.faturado), `${t.guias} guia${t.guias === 1 ? '' : 's'}`, 'faturado')}
        ${cartao('Recebido', dinheiro(t.recebido), t.faturado ? `${pct(t.recebido / t.faturado * 100)} do faturado` : '', 'recebido')}
        ${cartao('Glosado', dinheiro(t.glosado), '', 'glosado')}
        ${cartao('A receber', dinheiro(t.a_receber), 'faturado e ainda não pago', 'areceber')}
        ${cartao('% de glosa', pct(t.pct_glosa), 'glosado ÷ faturado', 'pctglosa')}
      </div>
      <section class="painel bloco-grafico">
        <div class="bloco-titulo">
          <h3>Mês a mês${P.convenio ? ` · ${h(P.convenio)}` : ''}</h3>
          <ul class="legenda" aria-label="Legenda">
            <li><i class="sw recebido"></i>Recebido</li>
            <li><i class="sw areceber"></i>A receber</li>
            <li><i class="sw glosado"></i>Glosado</li>
          </ul>
        </div>
        <div id="grafico" class="grafico"></div>
        <p class="nota-grafico">Toque numa barra para ver a competência.</p>
      </section>
      ${MOSTRAR_PROXIMOS ? `<section class="painel" id="proximos">${proximosPagamentos()}</section>` : ''}
      <section class="painel">
        <div class="bloco-titulo"><h3>Por convênio · ${h(compNome(P.comp))}</h3></div>
        ${tabelaConvenios(sel)}
      </section>`;
    ligarFiltros(telaPainel);
    const todos = $('#proximos-todos');
    if (todos) todos.onclick = () => { P.proximosTodos = true; $('#proximos').innerHTML = proximosPagamentos(); };
    desenharGrafico($('#grafico'), doConv);
    $$('[data-ver-faturas]', caixa).forEach(b => b.onclick = () => {
      P.convenio = b.dataset.verFaturas;
      if (!P.comp) P.comp = competencias()[0];
      CF().irParaAba('faturas');
    });
  }

  // Willian 23/11: a lista "Próximos pagamentos" fica escondida por enquanto (a previsão segue em Faturas e Protocolos)
  const MOSTRAR_PROXIMOS = false;

  // "Próximos pagamentos previstos": lotes com valor a receber (só situação
  // aguardando — o que já foi pago não entra), pela previsão de pagamento.
  function proximosPagamentos(){
    const lista = (P.proximos || []).filter(x => (!P.convenio || x.convenio === P.convenio) && (!P.comp || x.competencia === P.comp));
    const total = lista.reduce((s, x) => s + x.a_receber, 0);
    const LIMITE = 8;
    const mostrar = P.proximosTodos ? lista : lista.slice(0, LIMITE);
    const titulo = `<div class="bloco-titulo"><h3>Próximos pagamentos previstos</h3><span class="quando">${lista.length} lote${lista.length === 1 ? '' : 's'} · ${dinheiro(total)} a receber</span></div>`;
    if (!lista.length) return titulo + `<p class="vazio-curto">Nada a receber${P.comp ? ` em ${h(compNome(P.comp))}` : ''}.</p>`;
    return titulo + `
      <div class="rolagem">
      <table class="tabela-valores tabela-proximos cartoes-mobile">
        <thead><tr><th>Previsão</th><th>Convênio</th><th>Lote / protocolo</th><th>Competência</th><th>Guias</th><th>A receber</th></tr></thead>
        <tbody>${mostrar.map(x => {
          const atrasado = x.previsao && P.hoje && x.previsao < P.hoje;
          return `<tr class="${atrasado ? 'atrasado' : ''}">
            <th scope="row" data-r="">${x.previsao ? `${dataBR(x.previsao)}${atrasado ? ' <span class="sit glosado">atrasado</span>' : ''}` : '<span class="quando">sem previsão</span>'}</th>
            <td data-r="Convênio">${h(x.convenio)}</td>
            <td data-r="Lote / protocolo" class="mono">${h(x.lote || '—')}</td>
            <td data-r="Competência">${compBR(x.competencia)}</td>
            <td data-r="Guias">${x.guias}</td>
            <td data-r="A receber">${dinheiro(x.a_receber)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
      </div>
      ${lista.length > mostrar.length ? `<button type="button" class="link" id="proximos-todos">Mostrar todos (${lista.length})</button>` : ''}`;
  }

  function cartao(rotulo, valor, sub, classe){
    return `<div class="cartao ${classe}"><span class="rotulo">${h(rotulo)}</span><strong class="valor">${valor}</strong>${sub ? `<small>${h(sub)}</small>` : ''}</div>`;
  }

  function tabelaConvenios(linhas){
    const por = {};
    linhas.forEach(l => { (por[l.convenio] = por[l.convenio] || []).push(l); });
    const nomes = Object.keys(por).sort();
    if (!nomes.length) return `<div class="vazio"><strong>Nada nesta competência</strong>Escolha outra competência acima.</div>`;
    const total = somar(linhas);
    const linha = (nome, t, ehTotal) => `
      <tr class="${ehTotal ? 'total' : ''}">
        <th scope="row" data-r="">${ehTotal ? 'Total' : `<button type="button" class="link" data-ver-faturas="${h(nome)}" title="Ver as faturas">${h(nome)}</button>`}</th>
        <td data-r="Guias">${t.guias}</td>
        <td data-r="Faturado">${dinheiro(t.faturado)}</td>
        <td data-r="Recebido">${dinheiro(t.recebido)}</td>
        <td data-r="Glosado">${dinheiro(t.glosado)}</td>
        <td data-r="A receber">${dinheiro(t.a_receber)}</td>
        <td data-r="% glosa">${pct(t.pct_glosa)}</td>
      </tr>`;
    return `
      <div class="rolagem">
      <table class="tabela-valores cartoes-mobile">
        <thead><tr><th>Convênio</th><th>Guias</th><th>Faturado</th><th>Recebido</th><th>Glosado</th><th>A receber</th><th>% glosa</th></tr></thead>
        <tbody>${nomes.map(n => linha(n, somar(por[n]))).join('')}</tbody>
        ${nomes.length > 1 ? `<tfoot>${linha('', total, true)}</tfoot>` : ''}
      </table>
      </div>`;
  }

  // Barras empilhadas por competência: recebido + a receber + glosado.
  // SVG puro; redesenha quando a largura muda (celular girando, etc.).
  let observador = null;
  function desenharGrafico(alvo, linhas){
    if (observador){ observador.disconnect(); observador = null; }
    const comps = Array.from(new Set(linhas.map(l => l.competencia))).sort().slice(-12);
    const dados = comps.map(c => ({ comp: c, ...somar(linhas.filter(l => l.competencia === c)) }));
    if (!dados.length){ alvo.innerHTML = '<div class="vazio">Sem dados.</div>'; return; }

    const desenhar = () => {
      const largura = Math.max(280, alvo.clientWidth || 600);
      const estreito = largura < 520;
      const altura = estreito ? 220 : 260;
      const m = { t: 14, r: 8, b: 34, l: estreito ? 46 : 64 };
      const w = largura - m.l - m.r, hgt = altura - m.t - m.b;
      const max = Math.max(1, ...dados.map(d => d.recebido + d.a_receber + d.glosado));
      const passo = escalaPasso(max);
      const topo = Math.ceil(max / passo) * passo;
      const y = v => m.t + hgt - (v / topo) * hgt;
      const banda = w / dados.length;
      const bw = Math.max(8, Math.min(44, banda * 0.62));
      const grades = [];
      for (let v = 0; v <= topo + 0.001; v += passo) grades.push(v);
      const segs = ['recebido', 'a_receber', 'glosado'];
      const classe = { recebido: 'recebido', a_receber: 'areceber', glosado: 'glosado' };
      const nomes = { recebido: 'Recebido', a_receber: 'A receber', glosado: 'Glosado' };
      const barras = dados.map((d, i) => {
        const x = m.l + banda * i + (banda - bw) / 2;
        let base = 0, segsHtml = '';
        const ativo = !P.comp || P.comp === d.comp;
        const partes = segs.filter(s => d[s] > 0);
        partes.forEach((s, k) => {
          const y0 = y(base), y1 = y(base + d[s]);
          const alt = Math.max(0, y0 - y1 - (k > 0 ? 2 : 0)); // 2px de respiro entre segmentos
          segsHtml += k === partes.length - 1
            ? `<path class="seg ${classe[s]}" d="${caminhoTopoArredondado(x, y1, bw, alt, 4)}"/>`
            : `<rect class="seg ${classe[s]}" x="${x}" y="${y1}" width="${bw}" height="${alt}"/>`;
          base += d[s];
        });
        const rotuloMes = CF().MESES_CURTO[Number(d.comp.slice(5, 7)) - 1];
        const mostrarAno = d.comp.slice(5, 7) === '01' || (i === 0 && !(dados[1] && dados[1].comp.slice(5, 7) === '01'));
        return `<g class="barra ${ativo ? '' : 'apagada'}" data-comp="${d.comp}" tabindex="0" role="button" aria-label="${h(compBR(d.comp))}: faturado ${h(dinheiro(d.faturado))}">
          <rect class="alvo" x="${m.l + banda * i}" y="${m.t}" width="${banda}" height="${altura - m.t}"/>
          ${segsHtml}
          <text class="eixo-x" x="${x + bw / 2}" y="${altura - 18}" text-anchor="middle">${estreito ? rotuloMes.slice(0, 1) + rotuloMes.slice(1).toLowerCase() : rotuloMes}</text>
          ${mostrarAno ? `<text class="eixo-x ano" x="${x + bw / 2}" y="${altura - 4}" text-anchor="middle">${d.comp.slice(0, 4)}</text>` : ''}
        </g>`;
      }).join('');
      const svg = `
        <svg viewBox="0 0 ${largura} ${altura}" width="${largura}" height="${altura}" role="img" aria-label="Faturamento por competência">
          ${grades.map(v => `<line class="grade" x1="${m.l}" x2="${largura - m.r}" y1="${y(v)}" y2="${y(v)}"/>
            <text class="eixo-y" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v === 0 ? '0' : h(dinheiroCurto(v).replace('R$ ', ''))}</text>`).join('')}
          ${barras}
        </svg>
        <div class="dica-grafico" hidden></div>`;
      alvo.innerHTML = svg;
      const dica = $('.dica-grafico', alvo);
      const mostrar = (g, ev) => {
        const d = dados.find(x => x.comp === g.dataset.comp);
        dica.innerHTML = `<strong>${compNome(d.comp)}</strong>
          <span><b>Faturado</b> ${dinheiro(d.faturado)}</span>
          ${segs.map(s => `<span><i class="sw ${classe[s]}"></i>${nomes[s]} ${dinheiro(d[s])}</span>`).join('')}`;
        dica.hidden = false;
        const caixa = alvo.getBoundingClientRect();
        const r = g.getBoundingClientRect();
        let left = r.left - caixa.left + r.width / 2 - dica.offsetWidth / 2;
        left = Math.max(0, Math.min(left, caixa.width - dica.offsetWidth));
        dica.style.left = `${left}px`;
        dica.style.top = `0px`;
      };
      $$('.barra', alvo).forEach(g => {
        g.addEventListener('mouseenter', ev => mostrar(g, ev));
        g.addEventListener('focus', ev => mostrar(g, ev));
        g.addEventListener('mouseleave', () => { dica.hidden = true; });
        g.addEventListener('blur', () => { dica.hidden = true; });
        const escolher = () => { P.comp = P.comp === g.dataset.comp ? '' : g.dataset.comp; telaPainel(); };
        g.addEventListener('click', escolher);
        g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' '){ ev.preventDefault(); escolher(); } });
      });
    };

    desenhar();
    let ultimaLargura = alvo.clientWidth;
    if (window.ResizeObserver){
      observador = new ResizeObserver(() => {
        if (!document.body.contains(alvo)){ observador.disconnect(); return; }
        if (Math.abs(alvo.clientWidth - ultimaLargura) > 4){ ultimaLargura = alvo.clientWidth; desenhar(); }
      });
      observador.observe(alvo);
    }
  }

  function escalaPasso(max){
    const bruto = max / 4;
    const p10 = Math.pow(10, Math.floor(Math.log10(bruto)));
    const n = bruto / p10;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p10;
  }

  // Retângulo com os cantos de cima arredondados (base reta no eixo).
  function caminhoTopoArredondado(x, y, w, altura, r){
    r = Math.min(r, w / 2, altura);
    return `M${x},${y + altura} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + altura} Z`;
  }

  // ---------------------------------------------------------------- faturas
  async function telaFaturas(){
    const caixa = $('#portal');
    if (P.comp === null) P.comp = competencias()[0] || '';
    if (!competencias().length){
      caixa.innerHTML = cabecalho('Faturas', '') + `<div class="painel vazio"><strong>Ainda não há faturas</strong>Elas aparecem depois da sincronização das planilhas.</div>`;
      return;
    }
    caixa.innerHTML = `
      ${cabecalho('Faturas', 'Lotes e guias da competência, com a situação de cada procedimento.', filtros({ todas: true }))}
      <div class="pasta faturas-pasta">
        <div class="pasta-barra">
          <div class="pasta-resumo" id="fat-resumo"></div>
          <div class="pasta-filtros">
            <div class="segmento rolavel" role="group" aria-label="Situação">
              ${[['', 'Todas'], ['pago', 'Pagas'], ['parcial', 'Parciais'], ['glosado', 'Glosadas'], ['aguardando', 'Aguardando']].map(([v, n]) =>
                `<button type="button" data-sit="${v}" aria-pressed="${P.filtroSit === v}">${n}</button>`).join('')}
            </div>
            <input type="search" id="fat-busca" placeholder="Buscar paciente ou guia" value="${h(P.busca)}" aria-label="Buscar paciente ou guia">
          </div>
        </div>
        <div id="fat-lista"><div class="carregando">Carregando…</div></div>
      </div>`;
    ligarFiltros(telaFaturas);
    $('.segmento', caixa).onclick = ev => {
      const b = ev.target.closest('[data-sit]');
      if (!b) return;
      P.filtroSit = b.dataset.sit;
      $$('.segmento button', caixa).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      listaFaturas();
    };
    $('#fat-busca').oninput = ev => { P.busca = ev.target.value; listaFaturas(); };
    // "Todas": carrega competência por competência (cada uma fica no cache).
    const chave = P.comp;
    const faltam = (chave ? [chave] : competencias()).filter(c => !P.faturas[c]);
    try {
      let feitas = 0;
      await Promise.all(faltam.map(async c => {
        P.faturas[c] = (await CF().api(`/api/prestador?acao=faturas&mes=${c}${qMedico()}`)).linhas;
        feitas++;
        const alvo = $('#fat-lista');
        if (alvo && faltam.length > 1 && feitas < faltam.length) alvo.innerHTML = `<div class="carregando">Carregando ${feitas} de ${faltam.length} competências…</div>`;
      }));
    } catch (e){ $('#fat-lista').innerHTML = `<div class="vazio"><strong>Não deu para carregar</strong>${h(e.message)}</div>`; return; }
    if (P.comp === chave) listaFaturas();
  }

  function listaFaturas(){
    const fonte = P.comp ? (P.faturas[P.comp] || []) : competencias().flatMap(c => (P.faturas[c] || []).map(l => ({ ...l, competencia: c })));
    const todas = fonte.filter(l => !P.convenio || l.convenio === P.convenio);
    const b = P.busca.trim().toUpperCase();
    const lista = todas.filter(l => (!P.filtroSit || l.situacao === P.filtroSit)
      && (!b || String(l.paciente || '').toUpperCase().includes(b) || String(l.guia || '').includes(b)));
    const t = somar(todas.map(l => ({ faturado: l.faturado, recebido: l.recebido, glosado: Math.max(0, l.glosado || 0), a_receber: l.situacao === 'aguardando' ? l.faturado : 0 })));
    const guias = new Set(todas.map(l => `${l.convenio}|${l.guia}`)).size;
    $('#fat-resumo').innerHTML = `<strong>${h(compNome(P.comp))}</strong> · ${guias} guia${guias === 1 ? '' : 's'} · faturado ${dinheiro(t.faturado)} · recebido ${dinheiro(t.recebido)}`;
    const alvo = $('#fat-lista');
    if (!lista.length){
      alvo.innerHTML = `<div class="vazio"><strong>${todas.length ? 'Nada com esse filtro' : 'Nada nesta competência'}</strong>${todas.length ? 'Mude a situação ou limpe a busca.' : 'Escolha outra competência ou convênio.'}</div>`;
      return;
    }
    // Agrupa por convênio + lote.
    const grupos = [];
    const idx = {};
    lista.forEach(l => {
      const k = `${l.competencia || P.comp}|${l.convenio}|${l.lote || ''}`;
      if (!idx[k]){ idx[k] = { competencia: l.competencia || P.comp, convenio: l.convenio, lote: l.lote, data_lote: l.data_lote, linhas: [] }; grupos.push(idx[k]); }
      idx[k].linhas.push(l);
    });
    if (!P.comp) grupos.sort((a, b) => b.competencia.localeCompare(a.competencia));
    alvo.innerHTML = grupos.map(g => {
      const tg = somar(g.linhas.map(l => ({ faturado: l.faturado, recebido: l.recebido, glosado: Math.max(0, l.glosado || 0) })));
      const nGuias = new Set(g.linhas.map(l => l.guia)).size;
      const sitLote = situacaoLote(g.linhas);
      return `
        <section class="lote">
          <header class="lote-cabeca">
            <div class="lote-id">
              ${P.comp ? '' : `<span class="chip comp">${compBR(g.competencia)}</span>`}
              <span class="chip conv">${h(g.convenio)}</span>
              <strong>Lote ${h(g.lote || 'sem número')}</strong>
              ${g.data_lote ? `<span class="quando">${dataBR(g.data_lote)}</span>` : ''}
            </div>
            <div class="lote-tot">
              <span>${nGuias} guia${nGuias === 1 ? '' : 's'}</span>
              <span>Faturado <b>${dinheiro(tg.faturado)}</b></span>
              <span>Recebido <b>${dinheiro(tg.recebido)}</b></span>
              <span class="previsao">${situacaoHtml(g.convenio, situacaoLinhas(g.linhas))}</span>
              ${selo(sitLote)}
            </div>
          </header>
          <div class="rolagem">
          <table class="tabela-faturas cartoes-mobile">
            <thead><tr><th>Paciente</th><th>Guia</th><th>Data</th><th>Tipo</th><th>Código</th><th>Procedimento</th><th>Faturado</th><th>Recebido</th><th>Glosado</th><th>Situação</th></tr></thead>
            <tbody>
              ${g.linhas.map(l => `
                <tr>
                  <th scope="row" class="c-pac" data-r="">${h(l.paciente || '—')}${l.medico && !P.medico ? `<small class="quando bloco">${h(l.medico)}</small>` : ''}</th>
                  <td class="mono" data-r="Guia">${h(l.guia || '—')}</td>
                  <td class="mono" data-r="Data">${dataBR(l.data)}</td>
                  <td data-r="Tipo">${h(tipoNome(l.tipo))}${l.grau && l.grau !== '00' ? ` <small class="quando">grau ${h(l.grau)}</small>` : ''}</td>
                  <td class="mono" data-r="Código">${h(l.codigo || '')}</td>
                  <td class="c-proc" data-r="Procedimento">${h(l.procedimento || '')}${l.qtd && l.qtd !== 1 ? ` <small class="quando">× ${String(l.qtd).replace('.', ',')}</small>` : ''}</td>
                  <td class="num" data-r="Faturado">${dinheiro(l.faturado)}</td>
                  <td class="num" data-r="Recebido">${l.recebido === null ? '—' : dinheiro(l.recebido)}</td>
                  <td class="num" data-r="Glosado">${l.glosado === null ? '—' : dinheiro(Math.max(0, l.glosado))}</td>
                  <td data-r="Situação">${selo(l.situacao)}${l.data_pagamento && l.situacao !== 'aguardando' ? `<small class="quando bloco">pago em ${dataBR(l.data_pagamento)}</small>` : ''}${l.motivo_glosa && (l.situacao === 'glosado' || l.situacao === 'parcial') ? `<small class="motivo">${h(l.motivo_glosa)}</small>` : ''}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          </div>
        </section>`;
    }).join('');
  }


  function situacaoLote(linhas){
    const s = new Set(linhas.map(l => l.situacao));
    if (s.size === 1) return [...s][0];
    return s.has('aguardando') ? 'aguardando' : 'parcial'; // lote misto
  }

  // Sugestão de competência pela data de envio (regra do Willian): enviado até
  // o 5º dia útil do mês = competência anterior; depois = mês vigente. É só
  // sugestão (o campo continua editável). Mesma regra do sync/sincronizar.py.
  function pascoa(ano){
    const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    return new Date(Date.UTC(ano, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1));
  }
  function feriados(ano){
    const iso = d => d.toISOString().slice(0, 10);
    const p = pascoa(ano), mais = n => iso(new Date(p.getTime() + n * 864e5));
    const fixos = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].map(x => `${ano}-${x}`);
    return new Set([...fixos, mais(-48), mais(-47), mais(-2), mais(60)]); // Carnaval, Sexta Santa, Corpus Christi
  }
  function quintoDiaUtil(ano, mes){
    const fer = feriados(ano);
    let conta = 0;
    for (let dia = 1; dia <= 31; dia++){
      const d = new Date(Date.UTC(ano, mes - 1, dia));
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !fer.has(d.toISOString().slice(0, 10)) && ++conta === 5) return dia;
    }
    return 7;
  }
  // Unimed (Voxis) é exceção: competência = o próprio mês de envio.
  function competenciaPelaData(iso, convenio){
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    if (/^UNIMED/.test(String(convenio || ''))) return `${m[1]}-${m[2]}`;
    let ano = Number(m[1]), mes = Number(m[2]);
    if (Number(m[3]) <= quintoDiaUtil(ano, mes)){ mes -= 1; if (!mes){ mes = 12; ano -= 1; } }
    return `${ano}-${String(mes).padStart(2, '0')}`;
  }

  const selo = sit => { const s = SITUACOES[sit] || { nome: sit, classe: '' }; return `<span class="sit ${s.classe}">${h(s.nome)}</span>`; };

  // ---------------------------------------------------------------- protocolos e repasses
  async function telaDocumentos(categoria){
    const caixa = $('#portal');
    const titulo = { protocolo: 'Protocolos de envio', espelho: 'Espelhos de pagamento' }[categoria] || 'Documentos de repasse';
    const sub = {
      protocolo: 'Comprovantes do envio das suas faturas aos convênios.',
      espelho: 'Espelhos e demonstrativos de pagamento dos convênios, pela competência do pagamento.',
    }[categoria] || 'Relatórios de repasse e espelhos de pagamento.';
    caixa.innerHTML = cabecalho(titulo, sub) + `<div id="docs"><div class="carregando">Carregando…</div></div>`;
    try {
      if (!P.docs[categoria]) P.docs[categoria] = (await CF().api(`/api/documentos?acao=lista&categoria=${categoria}${qMedico()}`)).documentos;
    } catch (e){ $('#docs').innerHTML = `<div class="vazio"><strong>Não deu para carregar</strong>${h(e.message)}</div>`; return; }
    const docs = P.docs[categoria];
    const comps = Array.from(new Set(docs.map(d => d.competencia))).sort().reverse();
    const convs = Array.from(new Set(docs.map(d => d.convenio).filter(Boolean))).sort();
    const filtroDoc = P[`filtro_${categoria}`] || (P[`filtro_${categoria}`] = { comp: '', conv: '' });
    const desenhar = () => {
      const lista = docs.filter(d => (!filtroDoc.comp || d.competencia === filtroDoc.comp) && (!filtroDoc.conv || d.convenio === filtroDoc.conv));
      const porComp = {};
      lista.forEach(d => (porComp[d.competencia] = porComp[d.competencia] || []).push(d));
      // Espelhos: por convênio, executante, tipo e Seq/quinzena em ordem (Seq 1, 2, 3…).
      if (categoria === 'espelho') Object.values(porComp).forEach(l => l.sort((a, b) =>
        [a.convenio, a.medico, a.tipo, a.data_envio || '', a.numero].join('|').localeCompare([b.convenio, b.medico, b.tipo, b.data_envio || '', b.numero].join('|'), 'pt-BR', { numeric: true })));
      $('#docs-lista').innerHTML = lista.length ? Object.keys(porComp).sort().reverse().map(c => `
        <section class="painel grupo-docs">
          <h3>${h(compNome(c))}</h3>
          <ul class="docs">${porComp[c].map(d => itemDocumento(d, false)).join('')}</ul>
        </section>`).join('')
        : `<div class="painel vazio"><strong>Nenhum documento${docs.length ? ' com esse filtro' : ' ainda'}</strong>${docs.length ? 'Mude o filtro.' : 'Quando a Faturas Med anexar, eles aparecem aqui.'}</div>`;
    };
    $('#docs').innerHTML = `
      <div class="filtros-portal">
        <label class="campo"><span>Competência</span><select id="d-comp"><option value="">Todas</option>${comps.map(c => `<option value="${c}" ${filtroDoc.comp === c ? 'selected' : ''}>${compBR(c)}</option>`).join('')}</select></label>
        ${convs.length ? `<label class="campo"><span>Convênio</span><select id="d-conv"><option value="">Todos</option>${convs.map(c => `<option ${filtroDoc.conv === c ? 'selected' : ''}>${h(c)}</option>`).join('')}</select></label>` : ''}
        ${seletorMedico('d-med')}
      </div>
      <div id="docs-lista"></div>`;
    $('#d-comp').onchange = ev => { filtroDoc.comp = ev.target.value; desenhar(); };
    if ($('#d-conv')) $('#d-conv').onchange = ev => { filtroDoc.conv = ev.target.value; desenhar(); };
    if ($('#d-med')) $('#d-med').onchange = ev => trocarMedico(ev.target.value);
    desenhar();
  }

  function itemDocumento(d, equipe){
    // Espelho: título montado dos campos ("Unimed · Analítico · 10/2026 · Seq 1").
    const espelho = d.categoria === 'espelho';
    const titulo = d.categoria === 'protocolo'
      ? `Protocolo ${h(d.numero)}`
      : espelho ? h([CONVENIO_NOME[d.convenio] || d.convenio, d.tipo, compBR(d.competencia), d.numero].filter(Boolean).join(' · ')) : h(d.tipo || 'Documento');
    const meta = [
      d.convenio ? `<span class="chip conv">${h(d.convenio)}</span>` : '',
      d.medico ? `<span class="chip med">${h(d.medico)}</span>` : '',
      d.data_envio ? `<span>${d.categoria === 'protocolo' ? 'enviado em' : espelho ? 'pago em' : 'de'} ${dataBR(d.data_envio)}</span>` : '',
      d.categoria === 'protocolo' ? (d.lote_pago ? '<span class="sit pago">pago</span>'
        : d.previsao ? `<span class="previsao">previsão de pagamento <b>${dataBR(d.previsao)}</b></span>` : '<span class="quando">sem previsão de pagamento</span>') : '',
      equipe ? `<span>${h(d.prestador_nome)} · ${compBR(d.competencia)}</span>` : '',
    ].filter(Boolean).join('');
    return `
      <li class="${d.excluido_em ? 'excluido' : ''}">
        <span class="pdf-ico" aria-hidden="true">PDF</span>
        <div class="doc-info">
          <strong>${titulo}</strong>
          <div class="doc-meta">${meta}</div>
          <small class="doc-nome" title="${h(d.nome_original)}">${espelho ? '' : h(d.nome_original) + ' · '}${CF().tamanhoBR(d.tamanho)}</small>
          ${d.observacao ? `<small class="doc-obs">${h(d.observacao)}</small>` : ''}
          ${equipe && d.excluido_em ? `<small class="situacao excluida">Excluído ${h(CF().quandoBR(d.excluido_em))}${d.excluido_por_nome ? ' por ' + h(d.excluido_por_nome) : ''}</small>` : ''}
        </div>
        ${d.excluido_em ? '' : `<div class="doc-acoes">
          <a class="botao secundario pequeno" href="/api/documentos?id=${d.id}" target="_blank" rel="noopener">Abrir</a>
          <a class="botao primario pequeno" href="/api/documentos?id=${d.id}&baixar=1" data-baixar="${d.id}">Baixar</a>
          ${equipe ? `<button type="button" class="botao fantasma pequeno" data-editar-doc="${d.id}">Editar</button><button type="button" class="botao fantasma pequeno perigo-texto" data-excluir-doc="${d.id}">Excluir</button>` : ''}
        </div>`}
      </li>`;
  }

  // ---------------------------------------------------------------- resumo mensal de faturamento
  // Folha única da competência: para cada convênio e tipo de lote, guias,
  // faturado, recebido, glosado, a receber, % de glosa e previsão de pagamento,
  // com subtotal por convênio e total (Willian 23/11: mesmas colunas e mesmas
  // contas do painel — glosa negativa da Unimed não conta; a receber = faturado
  // das linhas sem recebido e sem glosa). Sem os protocolos dos portais.
  // O prestador vê na aba "Resumo"; a equipe abre pelo botão "Resumo" do prestador.
  // Situação do grupo / lote (Willian 23/11): "Pago em …", "Aguardando pagamento dia …"
  // (Bradesco não tem data certa: "… até …"), misto = as duas coisas, sem data = "(sem data)".
  // s = { n_pagos, n_aguardando, tudo_glosado, pago_de, data_pagamento, previsao }
  const ddmm = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '';
  function situacaoGrupo(convenio, s){
    const aguarda = s.previsao ? `${/^BRADESCO/i.test(convenio || '') ? 'até' : 'dia'} ${dataBR(s.previsao)}` : '(sem data)';
    const ate = s.data_pagamento;
    if (!s.n_aguardando){
      if (s.tudo_glosado) return { partes: ['Glosado'], classe: 'glosado' };
      if (!ate) return { partes: ['Pago'], classe: 'pago' };
      return { partes: [s.pago_de && s.pago_de !== ate ? `Pago em ${ddmm(s.pago_de)} a ${dataBR(ate)}` : `Pago em ${dataBR(ate)}`], classe: 'pago' };
    }
    if (!s.n_pagos) return { partes: [`Aguardando pagamento ${aguarda}`], classe: 'aguardando' };
    return { partes: [ate ? `Pago em ${ddmm(ate)}` : 'Parte paga', `resto aguardando ${aguarda}`], classe: 'misto' };
  }
  // Mesmos números para um lote da aba Faturas (a partir das linhas).
  function situacaoLinhas(linhas){
    const pagos = linhas.filter(l => l.situacao !== 'aguardando'), aguard = linhas.filter(l => l.situacao === 'aguardando');
    const datas = pagos.map(l => l.data_pagamento).filter(Boolean).sort();
    return {
      n_pagos: pagos.length, n_aguardando: aguard.length, tudo_glosado: linhas.length > 0 && linhas.every(l => l.situacao === 'glosado'),
      pago_de: datas[0] || null, data_pagamento: datas[datas.length - 1] || null,
      previsao: aguard.map(l => l.previsao).filter(Boolean).sort().pop() || null,
    };
  }
  const situacaoHtml = (convenio, s) => { const x = situacaoGrupo(convenio, s); return x.partes.map(p => `<span>${h(p)}</span>`).join(' · '); };
  const pctGlosa = g => g.faturado > 0 ? (g.glosado / g.faturado) * 100 : 0;
  const RODAPE_EMPRESA = 'Faturas Med · Avenida Rui Barbosa, 1011, Sl 205 e 206, Centro – Macaé/RJ · www.faturasmed.com.br · (22) 2213-0101 · WhatsApp (22) 99877-5196';
  const NOTA_RESUMO = 'Glosado = faturado e não pago pelo convênio (pagamento acima do faturado não conta como glosa). A receber = faturado ainda sem pagamento e sem glosa. % glosa = glosado ÷ faturado. Situação: "Pago em" = data do pagamento; "Aguardando pagamento dia" = data prevista; Bradesco não tem data certa, por isso "até" (prazo máximo).';
  // Linhas da folha (tela e PDF): grupo convênio × tipo, subtotal do convênio quando há mais de um tipo.
  function linhasResumo(r){
    const sub = {};
    (r.por_convenio || []).forEach(c => { sub[c.convenio] = c; });
    const out = [];
    agruparResumo(r.grupos).forEach(([conv, gs]) => {
      gs.forEach((g, i) => out.push({ tipo: 'grupo', primeira: i === 0, g }));
      if (gs.length > 1) out.push({ tipo: 'sub', g: { convenio: conv, ...(sub[conv] || somaResumo(gs)) } });
    });
    return out;
  }
  const totalResumo = r => (r.por_convenio && r.por_convenio.length ? somaResumo(r.por_convenio) : somaResumo(r.grupos));

  function htmlFolha(r, medico){
    const total = totalResumo(r);
    const gerado = new Date(r.gerado_em);
    const valores = g => `<td class="n">${g.guias}</td><td class="n">${dinheiro(g.faturado)}</td><td class="n">${dinheiro(g.recebido)}</td><td class="n">${dinheiro(g.glosado)}</td><td class="n">${dinheiro(g.a_receber)}</td><td class="n">${pct(pctGlosa(g))}</td>`;
    const cabValores = '<th class="n">Guias</th><th class="n">Faturado</th><th class="n">Recebido</th><th class="n">Glosado</th><th class="n">A receber</th><th class="n">% glosa</th>';
    return `
        <header class="folha-cabeca">
          <img src="img/logo.svg" alt="Faturas Med" class="folha-logo">
          <div class="folha-titulo">
            <h1>Resumo mensal de faturamento</h1>
            <p><span>Prestador</span><strong>${h(r.prestador.nome)}</strong></p>
            ${medico ? `<p><span>Executante</span><strong>${h(nomeMedico(medico))}</strong></p>` : ''}
            <p><span>Mês</span><strong>${h(compNome(r.mes))}</strong></p>
          </div>
        </header>
        ${r.grupos.length ? `
        <div class="folha-rolagem">
        <table class="folha-tabela">
          <thead><tr><th>Convênio</th><th>Tipo do lote</th>${cabValores}<th class="sit-txt">Situação</th></tr></thead>
          <tbody>${linhasResumo(r).map(l => l.tipo === 'sub'
            ? `<tr class="subtotal"><td></td><td>Subtotal</td>${valores(l.g)}<td></td></tr>`
            : `<tr class="${l.primeira ? 'novo-conv' : ''}">
              <td class="conv">${l.primeira ? h(l.g.convenio) : ''}</td>
              <td>${h(tipoNome(l.g.tipo))}</td>
              ${valores(l.g)}
              <td class="sit-txt ${situacaoGrupo(l.g.convenio, l.g).classe}">${situacaoHtml(l.g.convenio, l.g)}</td>
            </tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="2">Total</td>${valores(total)}<td></td></tr></tfoot>
        </table>
        </div>` : `<p class="folha-vazio">Nada faturado nesta competência.</p>`}
        ${r.por_medico && r.por_medico.length > 1 ? `
        <section class="folha-conv">
          <h2>Por executante</h2>
          <div class="folha-rolagem">
          <table class="folha-tabela">
            <thead><tr><th>Executante</th>${cabValores}</tr></thead>
            <tbody>${r.por_medico.map(g => `<tr><td>${h(g.medico || 'Sem executante informado')}</td>${valores(g)}</tr>`).join('')}</tbody>
          </table>
          </div>
        </section>` : ''}
        <div class="folha-total">
          <span>Total faturado · ${total.guias} guia${total.guias === 1 ? '' : 's'}</span>
          <strong>${dinheiro(total.faturado)}</strong>
        </div>
        <p class="folha-nota">${h(NOTA_RESUMO)}</p>
        <footer class="folha-rodape">${h(RODAPE_EMPRESA)}<br>gerado em ${h(CF().quandoBR(gerado))}</footer>`;
  }

  // capas = anexa os PDFs dos protocolos da competência (só quando o prestador
  // pede para imprimir); abrir = abre numa aba para imprimir em vez de baixar.
  async function baixarResumo(r, medico, botao, status, { capas = false, abrir = false, prestadorId = null } = {}){
    if (botao) botao.disabled = true;
    const aviso = t => { if (status) status.textContent = t; };
    try {
      let protocolos = [];
      if (capas){
        aviso('Buscando os protocolos…');
        const q = (prestadorId ? `&prestador=${prestadorId}` : '') + (medico ? `&medico=${encodeURIComponent(medico)}` : '');
        const docs = await CF().api(`/api/documentos?acao=lista&categoria=protocolo${q}`);
        protocolos = docs.documentos.filter(d => d.competencia === r.mes && (!prestadorId || d.prestador_id === prestadorId)).sort(ordemProtocolo);
      }
      const { bytes, paginas, falhas } = await gerarPdfResumo(r, aviso, protocolos);
      const nome = `RESUMO ${compBR(r.mes).replace('/', '-')} - ${r.prestador.nome}${medico && medico !== '-' ? ' - ' + medico : ''}${capas ? ' - COM CAPAS' : ''}.pdf`;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      let aberto = null;
      if (abrir) aberto = window.open(url, '_blank');
      if (!aberto){
        const a = document.createElement('a');
        a.href = url; a.download = nome;
        document.body.appendChild(a); a.click(); a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      aviso(`Pronto: ${nome} (${paginas} página${paginas === 1 ? '' : 's'})${capas && !protocolos.length ? ' — sem capas: nenhum protocolo desta competência foi anexado na aba Protocolos' : capas ? ` — ${protocolos.length} capa${protocolos.length === 1 ? '' : 's'}` : ''}${falhas && falhas.length ? ` — não deu para anexar: ${falhas.join(', ')}` : ''}`);
      if (capas && !protocolos.length) CF().aviso('Nenhum protocolo desta competência está anexado no sistema. As capas vêm dos PDFs que a equipe anexa em Protocolos.', true);
    } catch (e){
      console.error(e);
      if (status) status.textContent = '';
      CF().aviso(e.message || 'Não deu para gerar o PDF.', true);
    } finally { if (botao) botao.disabled = false; }
  }

  // Aba "Resumo" do prestador.
  async function telaResumo(){
    const caixa = $('#portal');
    const comps = competencias();
    if (!comps.length){
      caixa.innerHTML = cabecalho('Resumo de faturamento', '') + `<div class="painel vazio"><strong>Ainda não há faturamento aqui</strong>O resumo aparece depois da sincronização das planilhas.</div>`;
      return;
    }
    if (!P.comp || !comps.includes(P.comp)) P.comp = comps[0];
    caixa.innerHTML = `
      ${cabecalho('Resumo de faturamento', 'O que foi faturado no mês, por convênio e tipo de lote: recebido, glosado, a receber e até quando cada um tem para pagar.', `
      <div class="filtros-portal">
        <label class="campo"><span>Competência</span>
          <select id="f-comp">${comps.map(c => `<option value="${c}" ${c === P.comp ? 'selected' : ''}>${compBR(c)}</option>`).join('')}</select>
        </label>
        ${seletorMedico('f-med')}
        <button type="button" class="botao primario" id="btn-baixar-resumo" disabled>Baixar PDF</button>
        <button type="button" class="botao secundario" id="btn-capas-resumo" disabled title="Baixa o resumo com os protocolos de envio da competência atrás, para imprimir">Baixar com as capas</button>
      </div>`)}
      <div class="resumo-aba"><article class="folha" id="folha"><div class="carregando">Carregando…</div></article></div>
      <p class="resumo-status" id="r-status" aria-live="polite"></p>`;
    $('#f-comp').onchange = ev => { P.comp = ev.target.value; telaResumo(); };
    const fm = $('#f-med'); if (fm) fm.onchange = ev => trocarMedico(ev.target.value);
    const comp = P.comp;
    let r;
    try { r = await CF().api(`/api/prestador?acao=resumo&mes=${comp}${qMedico()}`); }
    catch (e){ $('#folha').innerHTML = `<div class="vazio"><strong>Não deu para carregar</strong>${h(e.message)}</div>`; return; }
    if (P.comp !== comp || P.aba !== 'resumo') return;
    $('#folha').innerHTML = htmlFolha(r, P.medico);
    const b = $('#btn-baixar-resumo'), bc = $('#btn-capas-resumo');
    b.disabled = false; bc.disabled = false;
    b.onclick = () => baixarResumo(r, P.medico, b, $('#r-status'));
    bc.onclick = () => baixarResumo(r, P.medico, bc, $('#r-status'), { capas: true });
  }

  // Equipe: resumo de um prestador numa tela por cima (com competência e médico).
  async function abrirResumo(comp, prestadorId, baixar = true, medico = ''){
    const tela = $('#resumo');
    const comps = P && P.painel && !prestadorId ? competencias() : [comp];
    tela.hidden = false;
    document.body.classList.add('com-resumo');
    tela.innerHTML = `<div class="resumo-barra"><span>Carregando o resumo…</span></div>`;
    let r;
    try {
      const q = (prestadorId ? `&prestador=${prestadorId}` : '') + (medico ? `&medico=${encodeURIComponent(medico)}` : '');
      r = await CF().api(`/api/prestador?acao=resumo&mes=${comp}${q}`);
    } catch (e){ CF().aviso(e.message, true); fecharResumo(); return; }
    tela.innerHTML = `
      <div class="resumo-barra nao-imprimir">
        <label class="campo"><span>Competência</span>
          <select id="r-comp">${comps.map(c => `<option value="${c}" ${c === comp ? 'selected' : ''}>${compBR(c)}</option>`).join('')}</select>
        </label>
        ${r.medicos && r.medicos.length ? `
        <label class="campo"><span>Executante</span>
          <select id="r-med">
            <option value="" ${!medico ? 'selected' : ''}>Todos (clínica inteira)</option>
            ${r.medicos.map(m => `<option value="${h(m)}" ${m === medico ? 'selected' : ''}>${h(m)}</option>`).join('')}
            ${r.sem_medico ? `<option value="-" ${medico === '-' ? 'selected' : ''}>Sem executante informado</option>` : ''}
          </select>
        </label>` : ''}
        <div class="resumo-botoes">
          <button type="button" class="botao primario" id="r-baixar">Baixar PDF</button>
          <button type="button" class="botao secundario" id="r-capas">Baixar com as capas</button>
          <button type="button" class="botao fantasma" id="r-fechar">Fechar</button>
        </div>
        <p class="resumo-status" id="r-status" aria-live="polite"></p>
      </div>
      <article class="folha" id="folha">${htmlFolha(r, medico)}</article>`;
    const botao = $('#r-baixar');
    $('#r-fechar').onclick = fecharResumo;
    botao.onclick = () => baixarResumo(r, medico, botao, $('#r-status'));
    $('#r-capas').onclick = () => baixarResumo(r, medico, $('#r-capas'), $('#r-status'), { capas: true, prestadorId });
    $('#r-comp').onchange = ev => abrirResumo(ev.target.value, prestadorId, false, medico);
    if ($('#r-med')) $('#r-med').onchange = ev => abrirResumo(comp, prestadorId, false, ev.target.value);
    tela.scrollTop = 0;
    botao.focus();
    if (baixar) baixarResumo(r, medico, botao, $('#r-status'));
  }

  const ordemProtocolo = (a, b) => (a.convenio || '').localeCompare(b.convenio || '', 'pt-BR')
    || String(a.data_envio || '').localeCompare(String(b.data_envio || '')) || String(a.numero).localeCompare(String(b.numero)) || a.id - b.id;
  function agruparResumo(grupos){
    const por = {};
    grupos.forEach(g => (por[g.convenio] = por[g.convenio] || []).push(g));
    return Object.entries(por);
  }
  const somaResumo = gs => gs.reduce((s, g) => ({
    guias: s.guias + g.guias, faturado: s.faturado + g.faturado, recebido: s.recebido + (g.recebido || 0),
    glosado: s.glosado + (g.glosado || 0), a_receber: s.a_receber + (g.a_receber || 0),
  }), { guias: 0, faturado: 0, recebido: 0, glosado: 0, a_receber: 0 });

  function fecharResumo(){
    const tela = $('#resumo');
    tela.hidden = true; tela.innerHTML = '';
    document.body.classList.remove('com-resumo');
  }
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !$('#resumo').hidden) fecharResumo(); });

  function carregarPdfLib(){
    if (window.PDFLib) return Promise.resolve();
    return new Promise((ok, falha) => {
      const s = document.createElement('script');
      s.src = 'js/vendor/pdf-lib.min.js';
      s.onload = ok;
      s.onerror = () => falha(new Error('Não deu para carregar o gerador de PDF. Confira a internet.'));
      document.head.appendChild(s);
    });
  }

  // A logo é SVG (só caminhos): vira PNG num canvas para entrar no PDF.
  async function logoPng(){
    const svg = (await (await fetch('img/logo.svg')).text()).replace('<svg', '<svg width="1640" height="320"');
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 1640; c.height = 320;
      c.getContext('2d').drawImage(img, 0, 0, 1640, 320);
      const blob = await new Promise(ok => c.toBlob(ok, 'image/png'));
      return new Uint8Array(await blob.arrayBuffer());
    } finally { URL.revokeObjectURL(url); }
  }

  async function gerarPdfResumo(r, aviso, protocolos = []){
    aviso('Preparando o PDF…');
    await carregarPdfLib();
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const medicoPdf = r.medico ? nomeMedico(r.medico) : '';
    doc.setTitle(`Resumo mensal de faturamento ${compBR(r.mes)} - ${r.prestador.nome}${medicoPdf ? ' - ' + medicoPdf : ''}`);
    doc.setAuthor('Faturas Med');
    const fonte = await doc.embedFont(StandardFonts.Helvetica);
    const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
    let logo = null;
    try { logo = await doc.embedPng(await logoPng()); } catch (e){ console.warn('logo', e); }

    const cor = hex => rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
    const AZUL = cor('#0B60B5'), TINTA = cor('#0D2440'), CINZA = cor('#5E6772'), CLARO = cor('#E7F0FA'), LINHA = cor('#D5DFEA'), FINA = cor('#EBF0F5'), VERDE = cor('#1B7F4B');
    const t = s => String(s ?? '').replace(/[^\x20-\x7E\xA0-\xFF–—•…‘’“”]/g, '?');
    // Paisagem (A4 deitada): cabem as 9 colunas inteiras.
    const W = 841.89, H = 595.28, M = 40;
    const larg = (s, f, tam) => f.widthOfTextAtSize(t(s), tam);
    let pagina, y;
    const texto = (s, x, yy, { f = fonte, tam = 10, c = TINTA, alinhar = 'esq' } = {}) => {
      const w = larg(s, f, tam);
      pagina.drawText(t(s), { x: alinhar === 'dir' ? x - w : alinhar === 'centro' ? x - w / 2 : x, y: yy, size: tam, font: f, color: c });
    };
    const rodape = () => {
      texto(RODAPE_EMPRESA, W / 2, 36, { tam: 7.5, c: CINZA, alinhar: 'centro' });
      texto(`gerado em ${CF().quandoBR(new Date(r.gerado_em))}`, W / 2, 25, { tam: 7, c: CINZA, alinhar: 'centro' });
    };
    const novaPagina = (primeira) => {
      pagina = doc.addPage([W, H]);
      y = H - M;
      if (primeira){
        if (logo){ const lw = 170, lh = lw * logo.height / logo.width; pagina.drawImage(logo, { x: M, y: y - lh, width: lw, height: lh }); }
        texto('RESUMO MENSAL DE FATURAMENTO', W - M, y - 14, { f: negrito, tam: 14, c: AZUL, alinhar: 'dir' });
        const linhaCab = (rot, val, yy) => {
          const wv = larg(val, negrito, 10.5);
          texto(val, W - M, yy, { f: negrito, tam: 10.5, alinhar: 'dir' });
          texto(rot, W - M - wv - 8, yy, { tam: 8, c: CINZA, alinhar: 'dir' });
        };
        linhaCab('PRESTADOR', r.prestador.nome, y - 32);
        if (medicoPdf){ linhaCab('MÉDICO', medicoPdf, y - 47); linhaCab('MÊS', compNome(r.mes).toUpperCase(), y - 62); y -= 77; }
        else { linhaCab('MÊS', compNome(r.mes).toUpperCase(), y - 47); y -= 62; }
      } else {
        texto(`Resumo mensal de faturamento · ${r.prestador.nome}${medicoPdf ? ' · ' + medicoPdf : ''} · ${compBR(r.mes)}`, M, y - 10, { f: negrito, tam: 10, c: AZUL });
        y -= 20;
      }
      pagina.drawRectangle({ x: M, y, width: W - 2 * M, height: 2.5, color: AZUL });
      y -= 26;
      rodape();
    };
    const espaco = precisa => { if (y - precisa < 70) novaPagina(false); };

    novaPagina(true);
    // Colunas: Convênio | Tipo do lote | Guias | Faturado | Recebido | Glosado | A receber | % glosa | Situação
    const xConv = M + 8, xTipo = 160, xSit = 602, xFim = W - M - 6;
    const COLS = [  // números alinhados à direita
      { rot: 'GUIAS', x: 262, v: g => String(g.guias) },
      { rot: 'FATURADO', x: 337, v: g => dinheiro(g.faturado) },
      { rot: 'RECEBIDO', x: 410, v: g => dinheiro(g.recebido) },
      { rot: 'GLOSADO', x: 478, v: g => dinheiro(g.glosado) },
      { rot: 'A RECEBER', x: 548, v: g => dinheiro(g.a_receber) },
      { rot: '% GLOSA', x: 590, v: g => pct(pctGlosa(g)) },
    ];
    const cabecalhoTabela = (primeiro = 'CONVÊNIO', comTipo = true, comPrev = true) => {
      pagina.drawRectangle({ x: M, y: y - 9, width: W - 2 * M, height: 26, color: CLARO });
      texto(primeiro, xConv, y, { f: negrito, tam: 7.5, c: CINZA });
      if (comTipo) texto('TIPO DO LOTE', xTipo, y, { f: negrito, tam: 7.5, c: CINZA });
      COLS.forEach(c => texto(c.rot, c.x, y, { f: negrito, tam: 7.5, c: CINZA, alinhar: 'dir' }));
      if (comPrev) texto('SITUAÇÃO', xSit, y, { f: negrito, tam: 7.5, c: CINZA });
      y -= 25;
    };
    const valoresLinha = (g, opc) => COLS.forEach(c => texto(c.v(g), c.x, y, { tam: 9, alinhar: 'dir', ...opc }));
    // corta o texto para caber até a largura (nomes longos de médico/convênio)
    const caber = (s, f, tam, w) => { s = String(s); if (larg(s, f, tam) <= w) return s; while (s.length > 1 && larg(s + '…', f, tam) > w) s = s.slice(0, -1); return s + '…'; };
    if (!r.grupos.length){ texto('Nada faturado nesta competência.', M, y, { c: CINZA }); y -= 24; }
    else {
      cabecalhoTabela();
      let convAtual = null;
      for (const l of linhasResumo(r)){
        if (y - 18 < 70){ novaPagina(false); cabecalhoTabela(); convAtual = null; }
        const g = l.g;
        if (l.tipo === 'sub'){
          pagina.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 18, color: FINA });
          texto('Subtotal', xTipo, y, { f: negrito, tam: 9 });
          valoresLinha(g, { f: negrito });
        } else {
          if (l.primeira || g.convenio !== convAtual) { const tc = larg(g.convenio, negrito, 9) <= xTipo - xConv - 6 ? 9 : 8; texto(caber(g.convenio, negrito, tc, xTipo - xConv - 4), xConv, y, { f: negrito, tam: tc }); }
          texto(caber(tipoNome(g.tipo), fonte, 9, COLS[0].x - xTipo - 30), xTipo, y, { tam: 9 });
          valoresLinha(g);
          // situação: uma linha; se não couber (pago + aguardando), duas linhas menores
          const sg = situacaoGrupo(g.convenio, g), corSit = sg.classe === 'pago' ? VERDE : TINTA;
          const umaLinha = sg.partes.join(' · ');
          if (larg(umaLinha, fonte, 8.5) <= xFim - xSit){
            if (sg.partes.length > 1){  // parte paga em verde, o resto normal
              const p0 = sg.partes[0] + ' · ';
              texto(p0, xSit, y, { tam: 8.5, c: VERDE });
              texto(sg.partes.slice(1).join(' · '), xSit + larg(p0, fonte, 8.5), y, { tam: 8.5 });
            } else texto(umaLinha, xSit, y, { tam: 8.5, c: corSit });
          }
          else if (sg.partes.length > 1){
            texto(caber(sg.partes[0] + ' ·', fonte, 7.5, xFim - xSit), xSit, y + 4, { tam: 7.5, c: VERDE });
            texto(caber(sg.partes[1], fonte, 7.5, xFim - xSit), xSit, y - 4.5, { tam: 7.5 });
          } else texto(caber(umaLinha, fonte, 7.5, xFim - xSit), xSit, y, { tam: 7.5, c: corSit });
        }
        convAtual = g.convenio;
        y -= 6; pagina.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: LINHA }); y -= 13;
      }
    }
    y -= 10;  // respiro entre a última linha e a faixa do total
    espaco(40);
    const total = totalResumo(r);
    const BRANCO = rgb(1, 1, 1);
    pagina.drawRectangle({ x: M, y: y - 11, width: W - 2 * M, height: 30, color: TINTA });
    texto('TOTAL', M + 14, y, { f: negrito, tam: 10.5, c: BRANCO });
    COLS.forEach(c => texto(c.v(total), c.x, y, { f: negrito, tam: 9.5, c: BRANCO, alinhar: 'dir' }));
    y -= 44;
    if (r.por_medico && r.por_medico.length > 1){
      espaco(22 + 34 + 19 * (r.por_medico.length + 1) + 14);
      pagina.drawRectangle({ x: M, y: y - 16, width: W - 2 * M, height: 22, color: CLARO });
      pagina.drawRectangle({ x: M, y: y - 16, width: 4, height: 22, color: AZUL });
      texto('POR MÉDICO', M + 12, y - 9, { f: negrito, tam: 11 });
      y -= 40;
      cabecalhoTabela('MÉDICO', false, false);
      for (const g of r.por_medico){
        if (y - 18 < 70){ novaPagina(false); cabecalhoTabela('MÉDICO', false, false); }
        texto(caber(g.medico || 'Sem executante informado', fonte, 9, COLS[0].x - xConv - 40), xConv, y, { tam: 9 });
        valoresLinha(g);
        y -= 6; pagina.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: LINHA }); y -= 13;
      }
      y -= 12;
    }
    espaco(30);
    // nota em até duas linhas
    const palavras = NOTA_RESUMO.split(' '); let lin = '';
    for (const w of palavras){
      if (larg(lin + ' ' + w, fonte, 7.5) > W - 2 * M - 10){ texto(lin, M, y, { tam: 7.5, c: CINZA }); y -= 10; lin = w; }
      else lin = lin ? lin + ' ' + w : w;
    }
    if (lin) texto(lin, M, y, { tam: 7.5, c: CINZA });

    // Capas: os PDFs dos protocolos da competência, um atrás do outro (só quando pedido).
    const falhas = [];
    for (let i = 0; i < protocolos.length; i++){
      const d = protocolos[i];
      aviso(`Anexando capa ${i + 1} de ${protocolos.length}…`);
      try {
        const resp = await fetch(`/api/documentos?id=${d.id}`, { credentials: 'same-origin' });
        if (!resp.ok) throw new Error(String(resp.status));
        const pdf = await PDFDocument.load(await resp.arrayBuffer(), { ignoreEncryption: true });
        const paginas = await doc.copyPages(pdf, pdf.getPageIndices());
        paginas.forEach(p => doc.addPage(p));
      } catch (e){ console.error('protocolo', d.id, e); falhas.push(d.numero); }
    }
    aviso('Salvando…');
    return { bytes: await doc.save(), paginas: doc.getPageCount(), falhas };
  }

  // ================================================================ LOTES BRADESCO (aba exclusiva da PATHOLOGY)
  // Willian 24/11/2026: listagem dos lotes do Bradesco (Saúde e Operadora) do ano, lote a lote,
  // com cara de planilha (modelo que a Dra. recebeu): cada pagamento picado numa linha embaixo
  // do lote, glosa, aguardando, recurso (em análise, acatado, recebido com data, negado),
  // situação e observação. Números de /api/prestador?acao=lotes (api/_lotes.js).
  // Em lote de recurso a diferença é "Recurso negado", nunca glosa (regra da casa).
  const LT = { dados: null, ano: '', conv: '', mes: '', sit: '', prestadorId: null };
  const convCurto = c => /OPERADORA/i.test(c) ? 'Bradesco Operadora' : 'Bradesco Saúde';
  const SITUACOES_LOTE = [['', 'Todas'], ['aguardando', 'Aguardando pagamento'], ['finalizado', 'Finalizado'], ['com_recurso', 'Com recurso'], ['com_glosa', 'Com glosa ou recurso negado']];
  const COLUNAS_LOTE = [  // [chave, título, tipo]
    ['convenio', 'Convênio'], ['data_envio', 'Data envio', 'data'], ['lote', 'Protocolo'], ['faturado', 'Faturado', 'v'],
    ['recebido', 'Recebido', 'v'], ['data_pag', 'Data pagamento', 'data'], ['glosa', 'Glosa', 'v'], ['aguardando', 'Aguardando pagamento', 'v'],
    ['em_analise', 'Recurso em análise', 'v'], ['acatado', 'Acatado', 'v'], ['recurso_recebido', 'Recurso recebido', 'v'], ['data_rec', 'Data pagamento recurso', 'data'],
    ['recurso_negado', 'Recurso negado', 'v'], ['situacao', 'Situação'], ['obs', 'Observação'],
  ];
  const CAMPOS_SOMA = ['faturado', 'recebido', 'glosa', 'aguardando', 'recursado', 'em_analise', 'acatado', 'recurso_recebido', 'recurso_a_receber', 'recurso_negado'];

  function lotesFiltrados(){
    return LT.dados.lotes.filter(l => (!LT.conv || l.convenio === LT.conv)
      && (!LT.mes || (l.data_envio || '').slice(0, 7) === LT.mes)
      && (!LT.sit || (LT.sit === 'aguardando' ? l.classe === 'aguardando' : LT.sit === 'finalizado' ? l.classe === 'finalizado'
        : LT.sit === 'com_recurso' ? l.recursado >= 0.01 : (l.glosa >= 0.01 || l.recurso_negado >= 0.01))));
  }
  function somaLotes(lotes){
    const t = { lotes: lotes.length, guias: 0 };
    CAMPOS_SOMA.forEach(c => { t[c] = 0; });
    lotes.forEach(l => { t.guias += l.guias; CAMPOS_SOMA.forEach(c => { t[c] += l[c] || 0; }); });
    CAMPOS_SOMA.forEach(c => { t[c] = Math.round(t[c] * 100) / 100; });
    return t;
  }
  // Linhas da planilha de um lote: a 1ª com o lote; as outras só com os pagamentos picados.
  function linhasDoLote(l){
    const n = Math.max(1, l.pagamentos.length, l.recurso_pagamentos.length);
    const out = [];
    for (let i = 0; i < n; i++){
      const p = l.pagamentos[i], r = l.recurso_pagamentos[i];
      out.push(i === 0 ? {
        primeira: true, lote: l, convenio: convCurto(l.convenio), data_envio: l.data_envio, lote_num: l.lote, faturado: l.faturado,
        recebido: p ? p.valor : 0, data_pag: p ? p.data : null, glosa: l.glosa, aguardando: l.aguardando,
        em_analise: l.em_analise, acatado: l.acatado, recurso_recebido: r ? r.valor : null, data_rec: r ? r.data : null,
        recurso_negado: l.recurso_negado, situacao: l.situacao, obs: l.obs,
      } : { primeira: false, lote: l, recebido: p ? p.valor : null, data_pag: p ? p.data : null, recurso_recebido: r ? r.valor : null, data_rec: r ? r.data : null });
    }
    return out;
  }
  const filtroTexto = () => [LT.conv ? convCurto(LT.conv) : 'Bradesco Saúde e Operadora', LT.mes ? `enviados em ${compBR(LT.mes)}` : '',
    LT.sit ? SITUACOES_LOTE.find(s => s[0] === LT.sit)[1].toLowerCase() : ''].filter(Boolean).join(' · ');

  // alvo = onde desenhar (aba do prestador ou a tela da equipe por cima); prestadorId só para a equipe.
  async function telaLotes(alvo, prestadorId = null){
    LT.prestadorId = prestadorId;
    const outro = LT.dados && prestadorId && LT.dados.prestador.id !== prestadorId;
    if (!LT.dados || outro || (LT.ano && LT.dados.ano !== LT.ano)){
      alvo.innerHTML = `<div class="carregando">Carregando…</div>`;
      try {
        LT.dados = await CF().api(`/api/prestador?acao=lotes${LT.ano ? `&ano=${LT.ano}` : ''}${prestadorId ? `&prestador=${prestadorId}` : ''}`);
        LT.ano = LT.dados.ano;
      } catch (e){ alvo.innerHTML = `<div class="vazio"><strong>Não deu para carregar</strong>${h(e.message)}</div>`; return; }
    }
    desenharLotes(alvo);
  }

  function desenharLotes(alvo){
    const d = LT.dados;
    const meses = Array.from(new Set(d.lotes.map(l => (l.data_envio || '').slice(0, 7)).filter(Boolean))).sort();
    const convs = Array.from(new Set(d.lotes.map(l => l.convenio))).sort();
    if (LT.mes && !meses.includes(LT.mes)) LT.mes = '';
    const lotes = lotesFiltrados(), t = somaLotes(lotes);
    const atualizado = d.atualizado_em ? `Atualizado em ${h(CF().quandoBR(d.atualizado_em))}.` : '';
    const dt = iso => iso ? dataBR(iso) : '';
    const celula = (row, [k, , tipo]) => {
      if (k === 'lote') return row.primeira ? `<td class="mono lote-num">${h(row.lote_num || '—')}</td>` : '<td></td>';
      const val = row[k];
      if (tipo === 'v'){
        if (val === null || val === undefined) return '<td></td>';
        const n = Number(val) || 0;
        const classe = (k === 'recebido' || k === 'recurso_recebido') && n >= 0.005 ? ' pos' : (k === 'glosa' || k === 'recurso_negado') && n >= 0.005 ? ' neg' : '';
        const mostra = n >= 0.005 || (row.primeira && (k === 'recebido' || k === 'faturado'));
        return `<td class="n${classe}">${mostra ? dinheiro(n) : ''}</td>`;
      }
      if (tipo === 'data') return `<td class="d">${dt(val)}</td>`;
      if (k === 'situacao') return row.primeira ? `<td><span class="sit-lote ${row.lote.classe}">${h(val)}</span></td>` : '<td></td>';
      if (k === 'obs') return `<td class="obs" title="${row.primeira ? h(val || '') : ''}">${row.primeira ? h(val || '') : ''}</td>`;
      return `<td class="${k === 'convenio' ? 'conv' : ''}">${row.primeira ? h(val || '') : ''}</td>`;
    };
    const linhaTotal = classe => `<tr class="total ${classe}">
        <td colspan="3">Total · ${t.lotes} lote${t.lotes === 1 ? '' : 's'}</td><td class="n">${dinheiro(t.faturado)}</td><td class="n">${dinheiro(t.recebido)}</td><td></td>
        <td class="n">${dinheiro(t.glosa)}</td><td class="n">${dinheiro(t.aguardando)}</td><td class="n">${dinheiro(t.em_analise)}</td><td class="n">${dinheiro(t.acatado)}</td>
        <td class="n">${dinheiro(t.recurso_recebido)}</td><td></td><td class="n">${dinheiro(t.recurso_negado)}</td><td colspan="2"></td></tr>`;
    const pags = l => l.pagamentos.map(p => `<li><span>${p.data ? dataBR(p.data) : 'sem data'}</span><b>${dinheiro(p.valor)}</b></li>`).join('')
      + l.recurso_pagamentos.map(p => `<li class="rec"><span>${p.data ? dataBR(p.data) : 'sem data'} · recurso</span><b>${dinheiro(p.valor)}</b></li>`).join('');
    const valorMobile = (rot, v, classe = '') => v >= 0.005 ? `<div><dt>${rot}</dt><dd class="${classe}">${dinheiro(v)}</dd></div>` : '';
    alvo.innerHTML = `
      ${cabecalho(`Lotes Bradesco ${d.ano}`, `Cada lote enviado ao Bradesco Saúde e ao Bradesco Operadora: cada pagamento com a data, glosa, recurso e o que falta receber. ${atualizado}`, `
      <div class="filtros-portal lotes-filtros">
        ${d.anos.length > 1 ? `<label class="campo"><span>Ano</span><select id="lt-ano">${d.anos.map(a => `<option ${a === d.ano ? 'selected' : ''}>${a}</option>`).join('')}</select></label>` : ''}
        <label class="campo"><span>Convênio</span><select id="lt-conv"><option value="">Saúde e Operadora</option>${convs.map(c => `<option value="${h(c)}" ${c === LT.conv ? 'selected' : ''}>${h(convCurto(c))}</option>`).join('')}</select></label>
        <label class="campo"><span>Mês de envio</span><select id="lt-mes"><option value="">Todos</option>${meses.map(m => `<option value="${m}" ${m === LT.mes ? 'selected' : ''}>${h(CF().MESES[Number(m.slice(5, 7)) - 1])}</option>`).join('')}</select></label>
        <label class="campo"><span>Situação</span><select id="lt-sit">${SITUACOES_LOTE.map(([k, n]) => `<option value="${k}" ${k === LT.sit ? 'selected' : ''}>${h(n)}</option>`).join('')}</select></label>
        <button type="button" class="botao secundario" id="lt-excel" ${lotes.length ? '' : 'disabled'}>Baixar Excel</button>
        <button type="button" class="botao primario" id="lt-pdf" ${lotes.length ? '' : 'disabled'}>Baixar PDF</button>
      </div>`)}
      <p class="resumo-status" id="lt-status" aria-live="polite"></p>
      <div class="cartoes lotes-cartoes">
        ${cartao('Faturado', dinheiro(t.faturado), `${t.lotes} lote${t.lotes === 1 ? '' : 's'} · ${t.guias} guias`, 'faturado')}
        ${cartao('Recebido', dinheiro(t.recebido), t.faturado ? `${pct(t.recebido / t.faturado * 100)} do faturado` : '', 'recebido')}
        ${cartao('Glosa', dinheiro(t.glosa), t.faturado ? `${pct(t.glosa / t.faturado * 100)} do faturado` : '', 'glosado')}
        ${cartao('Aguardando pagamento', dinheiro(t.aguardando), '', 'areceber')}
        ${cartao('Recurso recebido', dinheiro(t.recurso_recebido), t.recursado >= 0.01 ? `de ${dinheiro(t.recursado)} recursados` : 'nenhum recurso', 'recurso-rec')}
        ${cartao('Recurso negado', dinheiro(t.recurso_negado), t.em_analise >= 0.01 ? `${dinheiro(t.em_analise)} em análise` : 'nada em análise', 'recurso-neg')}
      </div>
      ${lotes.length ? `
      <section class="painel planilha-lotes">
        <div class="planilha-rolagem">
        <table class="planilha">
          <thead><tr>${COLUNAS_LOTE.map(([k, n, tipo]) => `<th class="${tipo === 'v' ? 'n' : ''} c-${k}">${h(n)}</th>`).join('')}</tr>${linhaTotal('cima')}</thead>
          ${lotes.map((l, i) => `<tbody class="lote${i % 2 ? ' par' : ''}">${linhasDoLote(l).map(row => `<tr class="${row.primeira ? 'cab' : 'picado'}">${COLUNAS_LOTE.map(c => celula(row, c)).join('')}</tr>`).join('')}</tbody>`).join('')}
          <tfoot>${linhaTotal('')}</tfoot>
        </table>
        </div>
      </section>
      <ul class="lotes-mobile">
        ${lotes.map(l => `
          <li class="lote-cartao">
            <div class="lc-cab"><div><strong class="mono">${h(l.lote || '—')}</strong><small>${h(convCurto(l.convenio))} · enviado em ${dt(l.data_envio)}</small></div><span class="sit-lote ${l.classe}">${h(l.situacao)}</span></div>
            <dl class="lc-valores">
              <div><dt>Faturado</dt><dd>${dinheiro(l.faturado)}</dd></div>
              <div><dt>Recebido</dt><dd class="pos">${dinheiro(l.recebido)}</dd></div>
              ${valorMobile('Glosa', l.glosa, 'neg')}${valorMobile('Aguardando', l.aguardando)}${valorMobile('Recurso em análise', l.em_analise)}
              ${valorMobile('Acatado', l.acatado)}${valorMobile('Recurso recebido', l.recurso_recebido, 'pos')}${valorMobile('Recurso negado', l.recurso_negado, 'neg')}
            </dl>
            ${l.pagamentos.length || l.recurso_pagamentos.length ? `<ul class="lc-pags">${pags(l)}</ul>` : ''}
            ${l.obs ? `<p class="lc-obs">${h(l.obs)}</p>` : ''}
          </li>`).join('')}
        <li class="lote-cartao total"><div class="lc-cab"><strong>Total · ${t.lotes} lote${t.lotes === 1 ? '' : 's'}</strong></div>
          <dl class="lc-valores">
            <div><dt>Faturado</dt><dd>${dinheiro(t.faturado)}</dd></div><div><dt>Recebido</dt><dd>${dinheiro(t.recebido)}</dd></div>
            <div><dt>Glosa</dt><dd>${dinheiro(t.glosa)}</dd></div><div><dt>Aguardando</dt><dd>${dinheiro(t.aguardando)}</dd></div>
            <div><dt>Recurso recebido</dt><dd>${dinheiro(t.recurso_recebido)}</dd></div><div><dt>Recurso negado</dt><dd>${dinheiro(t.recurso_negado)}</dd></div>
          </dl></li>
      </ul>` : `<div class="painel vazio"><strong>Nenhum lote</strong>Nada com esses filtros.</div>`}`;
    const ano = $('#lt-ano', alvo);
    if (ano) ano.onchange = ev => { LT.ano = ev.target.value; telaLotes(alvo, LT.prestadorId); };
    $('#lt-conv', alvo).onchange = ev => { LT.conv = ev.target.value; desenharLotes(alvo); };
    $('#lt-mes', alvo).onchange = ev => { LT.mes = ev.target.value; desenharLotes(alvo); };
    $('#lt-sit', alvo).onchange = ev => { LT.sit = ev.target.value; desenharLotes(alvo); };
    const st = $('#lt-status', alvo);
    $('#lt-excel', alvo).onclick = () => {
      try { const nome = nomeArquivoLotes('xlsx'); baixarArquivo(excelLotes(lotes, t), nome, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); st.textContent = `Pronto: ${nome}`; }
      catch (e){ console.error(e); CF().aviso('Não deu para gerar o Excel.', true); }
    };
    $('#lt-pdf', alvo).onclick = async ev => {
      const b = ev.currentTarget; b.disabled = true;
      try { st.textContent = 'Preparando o PDF…'; const nome = nomeArquivoLotes('pdf'); baixarArquivo(await pdfLotes(lotes, t), nome, 'application/pdf'); st.textContent = `Pronto: ${nome}`; }
      catch (e){ console.error(e); st.textContent = ''; CF().aviso(e.message || 'Não deu para gerar o PDF.', true); }
      finally { b.disabled = false; }
    };
  }

  const nomeArquivoLotes = ext => `LOTES BRADESCO ${LT.dados.ano} - ${LT.dados.prestador.nome}${LT.conv ? ' - ' + convCurto(LT.conv).toUpperCase() : ''}${LT.mes ? ' - ENVIO ' + compBR(LT.mes).replace('/', '-') : ''} - ${CF().hojeISO().split('-').reverse().join('-')}.${ext}`;
  function baixarArquivo(bytes, nome, tipo){
    const url = URL.createObjectURL(new Blob([bytes], { type: tipo }));
    const a = document.createElement('a');
    a.href = url; a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  // Equipe: a mesma aba numa tela por cima (botão "Lotes Bradesco" do prestador).
  async function abrirLotes(prestadorId){
    const tela = $('#resumo');
    tela.hidden = false;
    document.body.classList.add('com-resumo');
    tela.innerHTML = `
      <div class="resumo-barra nao-imprimir lotes-barra"><strong>Lotes Bradesco</strong><div class="resumo-botoes"><button type="button" class="botao fantasma" id="lt-fechar">Fechar</button></div></div>
      <div class="portal lotes-equipe" id="lotes-equipe"></div>`;
    $('#lt-fechar').onclick = fecharResumo;
    if (LT.dados && LT.dados.prestador.id !== prestadorId){ LT.dados = null; LT.ano = ''; LT.conv = ''; LT.mes = ''; LT.sit = ''; }
    await telaLotes($('#lotes-equipe'), prestadorId);
    tela.scrollTop = 0;
  }

  // ---------------------------------------------------------------- Excel (.xlsx sem biblioteca)
  // No formato do modelo: uma linha por lote e embaixo as linhas dos pagamentos picados; totais no
  // topo e no rodapé; valores em R$ e datas de verdade (o filtro do Excel funciona).
  function excelLotes(lotes, t){
    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    const col = i => { let s = ''; i++; while (i > 0){ const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
    const serial = iso => (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000;
    // estilos: 0 normal, 1 cabeçalho, 2 R$, 3 data, 4 negrito, 5 R$ negrito, 6 título, 7 total (faixa), 8 total R$, 9 texto cinza
    const linhas = [];
    let r = 0;
    const cel = (c, v, s = 0) => {
      const ref = `${col(c)}${r}`;
      if (v === null || v === undefined || v === '') return s ? `<c r="${ref}" s="${s}"/>` : '';
      if (typeof v === 'number') return `<c r="${ref}" s="${s}"><v>${Math.round(v * 100) / 100}</v></c>`;
      if (typeof v === 'object' && v.data) return `<c r="${ref}" s="${s || 3}"><v>${serial(v.data)}</v></c>`;
      return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    };
    const linha = (cels, alt) => {
      r++;
      linhas.push(`<row r="${r}"${alt ? ` ht="${alt}" customHeight="1"` : ''}>${cels.map((x, i) => (x === undefined || x === '') ? '' : Array.isArray(x) ? cel(i, x[0], x[1]) : cel(i, x)).join('')}</row>`);
    };
    const d = LT.dados;
    linha([[`LOTES BRADESCO ${d.ano} · ${d.prestador.nome}`, 6]], 22);
    linha([[`${filtroTexto()} · gerado em ${CF().quandoBR(new Date())} · Faturas Med`, 9]]);
    r++;
    [['TOTAL FATURADO', t.faturado], ['TOTAL RECEBIDO', t.recebido], ['TOTAL GLOSA', t.glosa], ['AGUARDANDO PAGAMENTO', t.aguardando],
      ['RECURSO EM ANÁLISE', t.em_analise], ['RECURSO ACATADO', t.acatado], ['RECURSO RECEBIDO', t.recurso_recebido], ['RECURSO NEGADO', t.recurso_negado]]
      .forEach(([n, v]) => linha([[n, 4], undefined, [v, 5]]));
    r++;
    linha(COLUNAS_LOTE.map(c => [c[1].toUpperCase(), 1]), 30);
    const linhaCab = r;
    const num = (x, mostrarZero) => (x === null || x === undefined) ? '' : (Math.abs(x) >= 0.005 || mostrarZero ? [x, 2] : '');
    for (const l of lotes){
      for (const row of linhasDoLote(l)){
        const p = row.primeira;
        linha([
          p ? row.convenio : '', p && row.data_envio ? { data: row.data_envio } : '', p ? row.lote_num : '', p ? num(row.faturado, true) : '',
          num(row.recebido, p), row.data_pag ? { data: row.data_pag } : '', p ? num(row.glosa) : '', p ? num(row.aguardando) : '',
          p ? num(row.em_analise) : '', p ? num(row.acatado) : '', num(row.recurso_recebido), row.data_rec ? { data: row.data_rec } : '',
          p ? num(row.recurso_negado) : '', p ? row.situacao : '', p ? row.obs : '',
        ]);
      }
    }
    const fim = r;
    linha([['TOTAL', 7], [`${t.lotes} lotes`, 7], ['', 7], [t.faturado, 8], [t.recebido, 8], ['', 7], [t.glosa, 8], [t.aguardando, 8], [t.em_analise, 8], [t.acatado, 8], [t.recurso_recebido, 8], ['', 7], [t.recurso_negado, 8], ['', 7], ['', 7]]);
    const larguras = [20, 12, 14, 15, 15, 13, 13, 15, 13, 13, 15, 13, 14, 26, 70];
    const ultimaCol = col(COLUNAS_LOTE.length - 1);
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${linhaCab}" topLeftCell="A${linhaCab + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${larguras.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${linhas.join('')}</sheetData>
<autoFilter ref="A${linhaCab}:${ultimaCol}${fim}"/>
<pageSetup paperSize="9" orientation="landscape"/>
</worksheet>`;
    const estilos = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00"/></numFmts>
<fonts count="5"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FF0B60B5"/><name val="Calibri"/></font><font><sz val="9"/><color rgb="FF5E6772"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B60B5"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7F0FA"/></patternFill></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center" horizontal="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="2" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
    const nomeAba = `LOTES ${d.ano}`;
    return zipSemCompressao({
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
      '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${nomeAba}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${nomeAba}'!$A$${linhaCab}:$${ultimaCol}$${fim}</definedName></definedNames></workbook>`,
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      'xl/worksheets/sheet1.xml': sheet,
      'xl/styles.xml': estilos,
    });
  }

  // ZIP "stored" (sem compressão) — basta para o .xlsx.
  let TABELA_CRC = null;
  function crc32(bytes){
    if (!TABELA_CRC){
      TABELA_CRC = new Uint32Array(256);
      for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; TABELA_CRC[n] = c >>> 0; }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = TABELA_CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipSemCompressao(arquivos){
    const enc = new TextEncoder(), partes = [], central = [];
    let pos = 0;
    const agora = new Date();
    const hora = (agora.getHours() << 11) | (agora.getMinutes() << 5) | (agora.getSeconds() >> 1);
    const dia = ((agora.getFullYear() - 1980) << 9) | ((agora.getMonth() + 1) << 5) | agora.getDate();
    const nomes = Object.keys(arquivos);
    for (const nome of nomes){
      const n = enc.encode(nome), dados = enc.encode(arquivos[nome]), crc = crc32(dados);
      const loc = new DataView(new ArrayBuffer(30));
      loc.setUint32(0, 0x04034b50, true); loc.setUint16(4, 20, true); loc.setUint16(6, 0x0800, true); loc.setUint16(8, 0, true);
      loc.setUint16(10, hora, true); loc.setUint16(12, dia, true); loc.setUint32(14, crc, true);
      loc.setUint32(18, dados.length, true); loc.setUint32(22, dados.length, true); loc.setUint16(26, n.length, true); loc.setUint16(28, 0, true);
      partes.push(new Uint8Array(loc.buffer), n, dados);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true);
      cen.setUint16(12, hora, true); cen.setUint16(14, dia, true); cen.setUint32(16, crc, true); cen.setUint32(20, dados.length, true); cen.setUint32(24, dados.length, true);
      cen.setUint16(28, n.length, true); cen.setUint32(42, pos, true);
      central.push(new Uint8Array(cen.buffer), n);
      pos += 30 + n.length + dados.length;
    }
    const tamCentral = central.reduce((s, x) => s + x.length, 0);
    const fim = new DataView(new ArrayBuffer(22));
    fim.setUint32(0, 0x06054b50, true); fim.setUint16(8, nomes.length, true); fim.setUint16(10, nomes.length, true);
    fim.setUint32(12, tamCentral, true); fim.setUint32(16, pos, true);
    const tudo = [...partes, ...central, new Uint8Array(fim.buffer)];
    const out = new Uint8Array(tudo.reduce((s, x) => s + x.length, 0));
    let o = 0; tudo.forEach(x => { out.set(x, o); o += x.length; });
    return out;
  }

  // ---------------------------------------------------------------- PDF (padrão da casa)
  // A4 deitada: logo Faturas Med no canto superior esquerdo; "Gustavo Vidal / Coordenador / data" no
  // canto superior direito; totais em cartões; a planilha com os pagamentos picados; sem nota de método.
  async function pdfLotes(lotes, t){
    await carregarPdfLib();
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const d = LT.dados;
    doc.setTitle(`Lotes Bradesco ${d.ano} - ${d.prestador.nome}`);
    doc.setAuthor('Faturas Med');
    const fonte = await doc.embedFont(StandardFonts.Helvetica);
    const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
    let logo = null;
    try { logo = await doc.embedPng(await logoPng()); } catch (e){ console.warn('logo', e); }
    const cor = hex => rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
    const AZUL = cor('#0B60B5'), TINTA = cor('#0D2440'), CINZA = cor('#5E6772'), LINHA = cor('#D5DFEA'), FINA = cor('#F3F7FB'),
      VERDE = cor('#1B7F4B'), VERMELHO = cor('#B3261E'), BRANCO = rgb(1, 1, 1), LARANJA = cor('#B3611A'), CIANO = cor('#06AEE9');
    const tx = s => String(s ?? '').replace(/[^\x20-\x7E\xA0-\xFF–—•…‘’“”]/g, '?');
    const W = 841.89, H = 595.28, M = 26;
    const larg = (s, f, tam) => f.widthOfTextAtSize(tx(s), tam);
    const caber = (s, f, tam, w) => { s = String(s ?? ''); if (larg(s, f, tam) <= w) return s; while (s.length > 1 && larg(s + '…', f, tam) > w) s = s.slice(0, -1); return s + '…'; };
    let pagina, y, numPag = 0;
    const texto = (s, x, yy, { f = fonte, tam = 8, c = TINTA, alinhar = 'esq' } = {}) => {
      const w = larg(s, f, tam);
      pagina.drawText(tx(s), { x: alinhar === 'dir' ? x - w : alinhar === 'centro' ? x - w / 2 : x, y: yy, size: tam, font: f, color: c });
    };
    const hoje = CF().hojeISO().split('-').reverse().join('/');
    const COLS = [  // [chave, título, largura, tipo]
      ['convenio', 'CONVÊNIO', 44], ['data_envio', 'ENVIO', 40, 'data'], ['lote', 'PROTOCOLO', 48], ['faturado', 'FATURADO', 52, 'v'],
      ['recebido', 'RECEBIDO', 52, 'v'], ['data_pag', 'DATA PGTO', 40, 'data'], ['glosa', 'GLOSA', 45, 'v'], ['aguardando', 'AGUARDANDO', 50, 'v'],
      ['em_analise', 'REC. ANÁLISE', 46, 'v'], ['acatado', 'ACATADO', 45, 'v'], ['recurso_recebido', 'REC. RECEBIDO', 52, 'v'], ['data_rec', 'DATA REC.', 40, 'data'],
      ['recurso_negado', 'REC. NEGADO', 48, 'v'], ['situacao', 'SITUAÇÃO', 76], ['obs', 'OBSERVAÇÃO', 0],
    ];
    let x0 = M; COLS.forEach(c => { c.x = x0; x0 += c[2]; });
    COLS[COLS.length - 1][2] = W - M - COLS[COLS.length - 1].x;
    const moedaPdf = v => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const cabecalhoTabela = () => {
      pagina.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 18, color: TINTA });
      COLS.forEach(c => texto(c[1], c[3] === 'v' ? c.x + c[2] - 3 : c.x + 3, y, { f: negrito, tam: 5.8, c: BRANCO, alinhar: c[3] === 'v' ? 'dir' : 'esq' }));
      y -= 18;
    };
    const novaPagina = primeira => {
      pagina = doc.addPage([W, H]); numPag++;
      y = H - M;
      if (logo){ const lw = primeira ? 150 : 110, lh = lw * logo.height / logo.width; pagina.drawImage(logo, { x: M, y: y - lh, width: lw, height: lh }); }
      texto('Gustavo Vidal', W - M, y - 10, { f: negrito, tam: 10, alinhar: 'dir' });
      texto('Coordenador', W - M, y - 22, { tam: 8.5, c: CINZA, alinhar: 'dir' });
      texto(hoje, W - M, y - 33, { tam: 8.5, c: CINZA, alinhar: 'dir' });
      y -= 52;
      texto(`LOTES BRADESCO ${d.ano} · ${d.prestador.nome}`, M, y, { f: negrito, tam: primeira ? 13 : 10, c: AZUL });
      texto(filtroTexto(), W - M, y, { tam: 8, c: CINZA, alinhar: 'dir' });
      y -= 8;
      pagina.drawRectangle({ x: M, y, width: W - 2 * M, height: 2, color: AZUL });
      y -= 18;
      texto(RODAPE_EMPRESA, W / 2, 14, { tam: 6.5, c: CINZA, alinhar: 'centro' });
      texto(`página ${numPag}`, W - M, 14, { tam: 6.5, c: CINZA, alinhar: 'dir' });
    };
    novaPagina(true);
    const cards = [['FATURADO', t.faturado, TINTA], ['RECEBIDO', t.recebido, AZUL], ['GLOSA', t.glosa, LARANJA], ['AGUARDANDO PAGAMENTO', t.aguardando, CIANO],
      ['RECURSO EM ANÁLISE', t.em_analise, CINZA], ['RECURSO RECEBIDO', t.recurso_recebido, VERDE], ['RECURSO NEGADO', t.recurso_negado, VERMELHO]];
    const gap = 6, cw = (W - 2 * M - gap * (cards.length - 1)) / cards.length;
    cards.forEach(([rot, val, c], i) => {
      const cx = M + i * (cw + gap);
      pagina.drawRectangle({ x: cx, y: y - 28, width: cw, height: 36, color: FINA });
      pagina.drawRectangle({ x: cx, y: y + 6, width: cw, height: 2, color: c });
      texto(rot, cx + 6, y - 4, { f: negrito, tam: 6, c: CINZA });
      texto(`R$ ${moedaPdf(val)}`, cx + 6, y - 20, { f: negrito, tam: 10 });
    });
    texto(`${t.lotes} lote${t.lotes === 1 ? '' : 's'} · ${t.guias} guias${t.faturado ? ` · glosa = ${pct(t.glosa / t.faturado * 100)} do faturado` : ''}${t.recursado >= 0.01 ? ` · recursado R$ ${moedaPdf(t.recursado)} · acatado R$ ${moedaPdf(t.acatado)}` : ''}`, M, y - 42, { tam: 7.5, c: CINZA });
    y -= 62;
    cabecalhoTabela();
    const ALT = 10.5, BASE = 34;
    lotes.forEach((l, li) => {
      const rows = linhasDoLote(l);
      if (y - ALT * rows.length < BASE){ novaPagina(false); cabecalhoTabela(); }
      if (li % 2) pagina.drawRectangle({ x: M, y: y - 3.5 - ALT * (rows.length - 1), width: W - 2 * M, height: ALT * rows.length, color: FINA });
      rows.forEach(row => {
        if (y < BASE){ novaPagina(false); cabecalhoTabela(); }
        COLS.forEach(c => {
          const [k, , w, tipo] = c;
          const val = k === 'lote' ? (row.primeira ? row.lote_num : '') : row[k];
          if (tipo === 'v'){
            if (val === null || val === undefined) return;
            const n = Number(val) || 0;
            const s = n >= 0.005 || (row.primeira && (k === 'recebido' || k === 'faturado')) ? moedaPdf(n) : '';
            if (!s) return;
            const opc = { tam: 6.7 };
            if ((k === 'glosa' || k === 'recurso_negado') && n >= 0.005) opc.c = VERMELHO;
            if (k === 'recurso_recebido') opc.c = VERDE;
            if (k === 'faturado') opc.f = negrito;
            texto(s, c.x + w - 3, y, { ...opc, alinhar: 'dir' });
            return;
          }
          let s = tipo === 'data' ? (val ? dataBR(val) : '') : (row.primeira ? (val || '') : '');
          if (k === 'convenio' && s) s = s.replace('Bradesco ', '');
          if (!s) return;
          let opc = { tam: 6.7 };
          if (k === 'situacao') opc = { tam: 6.3, f: negrito, c: l.classe === 'finalizado' ? VERDE : l.classe === 'aguardando' ? AZUL : LARANJA };
          if (k === 'obs') opc = { tam: 5.8, c: CINZA };
          if (k === 'lote') opc.f = negrito;
          texto(caber(s, opc.f || fonte, opc.tam, w - 6), c.x + 3, y, opc);
        });
        y -= ALT;
      });
      pagina.drawLine({ start: { x: M, y: y + ALT - 3.5 }, end: { x: W - M, y: y + ALT - 3.5 }, thickness: 0.4, color: LINHA });
    });
    if (y < BASE + 14) novaPagina(false);
    y -= 6;
    pagina.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 18, color: TINTA });
    texto(`TOTAL · ${t.lotes} LOTES`, M + 4, y, { f: negrito, tam: 7, c: BRANCO });
    COLS.forEach(c => { if (c[3] === 'v') texto(moedaPdf(t[c[0]]), c.x + c[2] - 3, y, { f: negrito, tam: 6.5, c: BRANCO, alinhar: 'dir' }); });
    return doc.save();
  }

  // ================================================================ EQUIPE: aba Prestadores
  const E = { admin: null, docs: null, filtroPrestador: '', filtroCategoria: '', verExcluidos: false, categoria: 'protocolo' };

  async function equipe(caixa){
    caixa.innerHTML = `<div class="carregando">Carregando…</div>`;
    try {
      const [admin, docs] = await Promise.all([
        CF().api('/api/admin?acao=dados'),
        CF().api(`/api/documentos?acao=lista${E.verExcluidos ? '&excluidos=1' : ''}`),
      ]);
      E.admin = admin; E.docs = docs.documentos;
      CF().estado.admin = admin;
    } catch (e){ caixa.innerHTML = `<div class="vazio"><strong>Não deu para carregar</strong>${h(e.message)}</div>`; return; }
    const { prestadores } = E.admin;
    const ativos = prestadores.filter(p => p.ativo);
    caixa.innerHTML = `
      <div class="equipe-prest">
        <section class="painel prest-coluna">
          <div class="bloco-titulo">
            <h2>Prestadores <small class="contagem" id="prest-contagem">${prestadores.length}</small></h2>
            <label class="busca"><span class="sr-only">Pesquisar prestador</span>
              <input type="search" id="busca-prest" placeholder="Pesquisar prestador…" autocomplete="off" value="${h(E.buscaPrest || '')}">
            </label>
          </div>
          <p class="sub">Médicos e clínicas com acesso ao portal. O nome é o mesmo da pasta das planilhas em CONTROLE DE PAGAMENTO. O login do prestador se cria em <b>Acessos</b>.</p>
          <ul class="lista-simples prestadores rolavel" id="lista-prest">
            ${prestadores.length ? prestadores.map(p => `
              <li class="${p.ativo ? '' : 'inativo'}" data-nome="${h(semAcento(p.nome))}">
                <div class="info">
                  <strong>${h(p.nome)}</strong>
                  <small>${p.usuarios} acesso${p.usuarios === 1 ? '' : 's'} · ${p.linhas.toLocaleString('pt-BR')} linhas · ${p.documentos} documento${p.documentos === 1 ? '' : 's'}${p.ativo ? '' : ' · desativado'}</small>
                  ${p.sincronizacoes.length ? `<small class="sync">${p.sincronizacoes.map(s => `${h(s.convenio)} ${s.linhas} (${h(CF().quandoBR(s.quando))})`).join(' · ')}</small>` : '<small class="sync">Ainda não sincronizado.</small>'}
                </div>
                <div class="acoes-li">
                  <button type="button" class="link" data-ver-resumo="${p.id}" ${p.linhas ? '' : 'disabled'}>Resumo</button>
                  ${(p.abas_extras || []).includes('lotes') ? `<button type="button" class="link" data-ver-lotes="${p.id}" ${p.linhas ? '' : 'disabled'}>Lotes Bradesco</button>` : ''}
                  <button type="button" class="link" data-renomear-p="${p.id}">Renomear</button>
                  <button type="button" class="link ${p.ativo ? 'perigo' : ''}" data-ativo-p="${p.id}" data-valor="${!p.ativo}">${p.ativo ? 'Desativar' : 'Reativar'}</button>
                </div>
              </li>`).join('') : '<li><div class="info"><small>Nenhum prestador cadastrado ainda.</small></div></li>'}
          </ul>
          <form id="form-prestador" class="form-linha">
            <label class="campo"><span>Novo prestador</span><input name="nome" maxlength="120" placeholder="Ex.: VINICIUS ANTUNES" required></label>
            <button class="botao primario" type="submit">Cadastrar</button>
          </form>
          <p class="erro" id="erro-prestador" role="alert"></p>
        </section>

        <section class="painel">
          <h2>Enviar documento</h2>
          <p class="sub">PDF que o prestador vai ver e baixar no portal dele.</p>
          <form id="form-doc" class="form-grade" novalidate>
            <div class="inteiro segmento grande" role="group" aria-label="Tipo de documento">
              <button type="button" data-cat="protocolo" aria-pressed="${E.categoria === 'protocolo'}">Protocolo enviado</button>
              <button type="button" data-cat="repasse" aria-pressed="${E.categoria === 'repasse'}">Documento de repasse</button>
            </div>
            <label class="campo"><span>Prestador</span>
              <select name="prestador_id" required>${ativos.map(p => `<option value="${p.id}">${h(p.nome)}</option>`).join('') || '<option value="">Cadastre um prestador</option>'}</select>
            </label>
            <label class="campo" id="campo-medico" hidden><span>Médico <small>(clínica com vários)</small></span>
              <select name="medico"><option value="">Clínica inteira</option></select>
              <small>Documento de um médico só aparece para ele; da clínica inteira aparece para todos.</small>
            </label>
            <label class="campo"><span>Competência</span>
              <input name="competencia" inputmode="numeric" placeholder="MM/AAAA" maxlength="7" autocomplete="off" required>
              <small id="dica-comp">Envio até o 5º dia útil = competência anterior.</small>
            </label>
            <label class="campo"><span>Convênio <small data-so="repasse">(opcional)</small></span>
              <select name="convenio"><option value="">—</option>${E.admin.convenios_prestador.map(c => `<option>${h(c)}</option>`).join('')}</select>
            </label>
            <label class="campo" data-so="protocolo"><span>Número do protocolo</span><input name="numero" maxlength="60" autocomplete="off"></label>
            <label class="campo" data-so="protocolo"><span>Data de envio</span><input name="data_envio" type="date" max="${CF().hojeISO()}"></label>
            <label class="campo" data-so="repasse"><span>Tipo</span>
              <select name="tipo">${E.admin.tipos_repasse.map(t => `<option>${h(t)}</option>`).join('')}</select>
            </label>
            <label class="campo" data-so="protocolo"><span>Previsão de pagamento</span><input name="previsao_pagamento" type="date">
              <small id="dica-prev">Sugerida pela regra do convênio; pode mudar.</small></label>
            <label class="campo inteiro"><span>Observação</span><input name="observacao" maxlength="500" autocomplete="off" placeholder="Opcional"></label>
            <label class="soltar inteiro" id="doc-soltar">
              <input type="file" name="pdf" accept="application/pdf,.pdf">
              <strong>Arraste o PDF aqui ou <u>escolha o arquivo</u></strong>
              <small id="doc-arquivo">Só PDF.</small>
            </label>
            <p class="erro inteiro" id="erro-doc" role="alert"></p>
            <div class="inteiro"><button class="botao primario largo" type="submit" id="btn-doc">Salvar documento</button></div>
          </form>
        </section>

        <section class="painel inteiro-grade">
          <div class="bloco-titulo">
            <h2>Documentos enviados</h2>
            <div class="filtros-portal compacto">
              <select id="e-prest" aria-label="Prestador"><option value="">Todos os prestadores</option>${prestadores.map(p => `<option value="${p.id}" ${String(p.id) === E.filtroPrestador ? 'selected' : ''}>${h(p.nome)}</option>`).join('')}</select>
              <select id="e-cat" aria-label="Tipo"><option value="">Todos os documentos</option><option value="protocolo" ${E.filtroCategoria === 'protocolo' ? 'selected' : ''}>Protocolos</option><option value="espelho" ${E.filtroCategoria === 'espelho' ? 'selected' : ''}>Espelhos de pagamento</option><option value="repasse" ${E.filtroCategoria === 'repasse' ? 'selected' : ''}>Repasses</option></select>
              <label class="marcar"><input type="checkbox" id="e-excl" ${E.verExcluidos ? 'checked' : ''}> mostrar excluídos</label>
            </div>
          </div>
          <ul class="docs" id="e-docs"></ul>
        </section>
      </div>`;
    ligarEquipe(caixa);
  }

  function listaDocsEquipe(){
    const lista = E.docs.filter(d => (!E.filtroPrestador || String(d.prestador_id) === E.filtroPrestador) && (!E.filtroCategoria || d.categoria === E.filtroCategoria));
    $('#e-docs').innerHTML = lista.length ? lista.map(d => itemDocumento(d, true)).join('') : '<li class="vazio-li">Nenhum documento.</li>';
  }

  function semAcento(t){ return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim(); }

  // Filtro da lista de prestadores (pelo nome, sem acento). Mantém o que foi
  // digitado quando a tela se redesenha.
  function filtrarPrestadores(){
    const termo = semAcento(E.buscaPrest);
    let vistos = 0;
    $$('#lista-prest li[data-nome]').forEach(li => {
      const mostra = !termo || li.dataset.nome.includes(termo);
      li.hidden = !mostra; if (mostra) vistos++;
    });
    const total = $$('#lista-prest li[data-nome]').length;
    const c = $('#prest-contagem'); if (c) c.textContent = termo ? `${vistos} de ${total}` : String(total);
    const vazio = $('#lista-prest .sem-resultado');
    if (termo && !vistos){
      if (!vazio) $('#lista-prest').insertAdjacentHTML('beforeend', `<li class="vazio-li sem-resultado">Nenhum prestador com "${h(E.buscaPrest)}".</li>`);
    } else if (vazio) vazio.remove();
  }

  function ligarEquipe(caixa){
    listaDocsEquipe();
    filtrarPrestadores();
    $('#busca-prest').oninput = ev => { E.buscaPrest = ev.target.value; filtrarPrestadores(); };
    $('#e-prest').onchange = ev => { E.filtroPrestador = ev.target.value; listaDocsEquipe(); };
    $('#e-cat').onchange = ev => { E.filtroCategoria = ev.target.value; listaDocsEquipe(); };
    $('#e-excl').onchange = ev => { E.verExcluidos = ev.target.checked; equipe($('#conteudo')); };

    $('#form-prestador').onsubmit = async ev => {
      ev.preventDefault();
      try {
        await CF().api('/api/admin?acao=prestador', { method: 'POST', body: JSON.stringify({ nome: ev.target.nome.value }) });
        CF().aviso('Prestador cadastrado.'); equipe($('#conteudo'));
      } catch (e){ $('#erro-prestador').textContent = e.message; }
    };

    // ---- formulário do documento
    const f = $('#form-doc');
    // Médico: só aparece quando o prestador escolhido tem médicos nas planilhas.
    const atualizarMedicos = () => {
      const pr = E.admin.prestadores.find(x => String(x.id) === f.prestador_id.value);
      const ms = (pr && pr.medicos) || [];
      $('#campo-medico').hidden = !ms.length;
      f.medico.innerHTML = `<option value="">Clínica inteira</option>` + ms.map(m => `<option>${h(m)}</option>`).join('');
    };
    atualizarMedicos();
    f.prestador_id.addEventListener('change', atualizarMedicos);
    let arquivo = null;
    const ajustar = () => {
      $$('[data-cat]', f).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cat === E.categoria)));
      $$('[data-so]', f).forEach(el => { el.hidden = el.dataset.so !== E.categoria; });
    };
    ajustar();
    $('.segmento', f).onclick = ev => { const b = ev.target.closest('[data-cat]'); if (b){ E.categoria = b.dataset.cat; ajustar(); } };
    f.competencia.oninput = () => {
      let v = f.competencia.value.replace(/\D/g, '').slice(0, 6);
      if (v.length > 2) v = v.slice(0, 2) + '/' + v.slice(2);
      f.competencia.value = v;
      f.competencia.dataset.mexido = v ? '1' : '';
    };
    // Competência sugerida pela data de envio (regra da casa: até o dia 10 é
    // a competência anterior). Pode ser editada; se editar, não muda mais sozinha.
    const sugerirComp = () => {
      const c = competenciaPelaData(f.data_envio.value, f.convenio.value);
      if (c && !f.competencia.dataset.mexido){
        f.competencia.value = compBR(c);
        $('#dica-comp').textContent = /^UNIMED/.test(f.convenio.value) ? 'Unimed: mês do envio.' : 'Sugerida pela data de envio (até o 5º dia útil = mês anterior).';
      }
    };
    // Previsão de pagamento sugerida pela tabela de regras do servidor
    // (Bradesco por tipo de guia do lote, Unimed/Petrobrás último dia útil do mês
    // seguinte à competência, Mediservice dia 28; outros: vazio). Editou, não muda mais.
    const sugerirPrevisao = async () => {
      if (f.previsao_pagamento.dataset.mexido) return;
      const m = f.competencia.value.match(/^(0[1-9]|1[0-2])\/(\d{4})$/);
      // número + prestador: o servidor acha o tipo de guia do lote (Bradesco conta os dias pelo tipo)
      const q = new URLSearchParams({ acao: 'sugerir-previsao', convenio: f.convenio.value, data_envio: f.data_envio.value, competencia: m ? `${m[2]}-${m[1]}` : '', numero: f.numero.value.trim(), prestador: f.prestador_id.value });
      try {
        const r = await CF().api(`/api/documentos?${q}`);
        if (f.previsao_pagamento.dataset.mexido) return;
        f.previsao_pagamento.value = r.previsao || '';
        $('#dica-prev').textContent = r.previsao ? 'Sugerida pela regra do convênio; pode mudar.' : 'Sem regra para este convênio: preencha se souber.';
      } catch {}
    };
    f.previsao_pagamento.oninput = () => { f.previsao_pagamento.dataset.mexido = f.previsao_pagamento.value ? '1' : ''; };
    f.data_envio.onchange = () => { sugerirComp(); sugerirPrevisao(); };
    f.convenio.addEventListener('change', () => { sugerirComp(); sugerirPrevisao(); });
    f.competencia.addEventListener('change', sugerirPrevisao);
    f.numero.addEventListener('change', sugerirPrevisao);
    const receber = lista => {
      const a = lista && lista[0];
      if (!a) return;
      if (!(/\.pdf$/i.test(a.name) || a.type === 'application/pdf')){ $('#erro-doc').textContent = 'Escolha um arquivo PDF.'; return; }
      arquivo = a;
      $('#erro-doc').textContent = '';
      $('#doc-arquivo').textContent = `${a.name} · ${CF().tamanhoBR(a.size)}`;
      // Sugere competência e número a partir do nome ("... 10.2026 ... 232670955 - CAPA.pdf").
      const comp = a.name.match(/(\d{2})[.\-/](20\d{2})/);
      if (comp && !f.competencia.value && !f.data_envio.value) f.competencia.value = `${comp[1]}/${comp[2]}`;
      const num = a.name.match(/\b(\d{8,12})\b/);
      if (num && E.categoria === 'protocolo' && !f.numero.value) f.numero.value = num[1];
    };
    f.pdf.onchange = () => { receber(f.pdf.files); f.pdf.value = ''; };
    const soltar = $('#doc-soltar');
    ['dragenter', 'dragover'].forEach(t => soltar.addEventListener(t, ev => { ev.preventDefault(); soltar.classList.add('sobre'); }));
    ['dragleave', 'drop'].forEach(t => soltar.addEventListener(t, ev => { ev.preventDefault(); soltar.classList.remove('sobre'); }));
    soltar.addEventListener('drop', ev => receber(ev.dataTransfer.files));

    f.onsubmit = async ev => {
      ev.preventDefault();
      const erro = $('#erro-doc');
      erro.textContent = '';
      const m = f.competencia.value.match(/^(0[1-9]|1[0-2])\/(\d{4})$/);
      if (!m){ erro.textContent = 'Digite a competência como MM/AAAA (ex.: 10/2026).'; f.competencia.focus(); return; }
      if (!arquivo){ erro.textContent = 'Escolha o PDF.'; return; }
      const meta = {
        categoria: E.categoria, prestador_id: f.prestador_id.value, competencia: `${m[2]}-${m[1]}`, convenio: f.convenio.value,
        numero: E.categoria === 'protocolo' ? f.numero.value.trim() : '', data_envio: E.categoria === 'protocolo' ? f.data_envio.value : '',
        tipo: E.categoria === 'repasse' ? f.tipo.value : '', observacao: f.observacao.value.trim(),
        previsao_pagamento: E.categoria === 'protocolo' ? f.previsao_pagamento.value : '',
        medico: $('#campo-medico').hidden ? '' : f.medico.value,
      };
      if (meta.categoria === 'protocolo' && (!meta.convenio || !meta.numero || !meta.data_envio)){
        erro.textContent = 'Protocolo precisa de convênio, número e data de envio.'; return;
      }
      const botao = $('#btn-doc');
      botao.disabled = true; botao.textContent = 'Enviando…';
      try {
        await enviarDocumento(meta, arquivo, p => { botao.textContent = `Enviando… ${Math.round(p * 100)}%`; });
        CF().aviso(`${meta.categoria === 'protocolo' ? 'Protocolo' : 'Documento'} salvo.`);
        equipe($('#conteudo'));
      } catch (e){ erro.textContent = e.message; }
      finally { botao.disabled = false; botao.textContent = 'Salvar documento'; }
    };

    caixa.onclick = async ev => {
      const t = ev.target.closest('[data-excluir-doc],[data-editar-doc],[data-renomear-p],[data-ativo-p],[data-ver-resumo]');
      if (!t) return;
      try {
        if (t.dataset.editarDoc){
          const d = E.docs.find(x => x.id === Number(t.dataset.editarDoc));
          if (!(await editarDocumento(d))) return;
          CF().aviso('Documento atualizado.');
        } else if (t.dataset.excluirDoc){
          const d = E.docs.find(x => x.id === Number(t.dataset.excluirDoc));
          if (!(await CF().confirmar({ titulo: 'Excluir este documento?', texto: `<strong>${h(d.nome_original)}</strong> sai do portal de ${h(d.prestador_nome)}. Fica só o registro de quem excluiu.`, botao: 'Excluir', perigo: true }))) return;
          await CF().api(`/api/documentos?id=${d.id}`, { method: 'DELETE' });
          CF().aviso('Documento excluído.');
        } else if (t.dataset.renomearP){
          const p = E.admin.prestadores.find(x => x.id === Number(t.dataset.renomearP));
          const nome = await CF().pedirTexto('Renomear prestador', 'Nome (igual ao da pasta das planilhas)', p.nome);
          if (nome === null || nome === p.nome) return;
          await CF().api('/api/admin?acao=prestador-editar', { method: 'POST', body: JSON.stringify({ id: p.id, nome }) });
          CF().aviso('Prestador renomeado.');
        } else if (t.dataset.ativoP){
          const p = E.admin.prestadores.find(x => x.id === Number(t.dataset.ativoP));
          const ativar = t.dataset.valor === 'true';
          if (!ativar && !(await CF().confirmar({ titulo: `Desativar ${h(p.nome)}?`, texto: 'Os acessos desse prestador deixam de entrar na hora. Os dados continuam guardados.', botao: 'Desativar', perigo: true }))) return;
          await CF().api('/api/admin?acao=prestador-editar', { method: 'POST', body: JSON.stringify({ id: p.id, ativo: ativar }) });
          CF().aviso(ativar ? 'Prestador reativado.' : 'Prestador desativado.');
        } else if (t.dataset.verLotes){
          return abrirLotes(Number(t.dataset.verLotes));
        } else if (t.dataset.verResumo){
          const comp = await CF().pedirTexto('Resumo de faturamento', 'Competência (MM/AAAA)', compBR(CF().hojeISO().slice(0, 7)));
          const m = comp && comp.match(/^(0[1-9]|1[0-2])\/(\d{4})$/);
          if (!m){ if (comp !== null) CF().aviso('Competência inválida. Use MM/AAAA.', true); return; }
          return abrirResumo(`${m[2]}-${m[1]}`, Number(t.dataset.verResumo));
        }
        equipe($('#conteudo'));
      } catch (e){ CF().aviso(e.message, true); }
    };
  }

  // Diálogo para corrigir convênio / competência / número / data de um documento.
  function editarDocumento(d){
    return new Promise(resolve => {
      const dlg = $('#dialogo');
      const convs = E.admin.convenios_prestador.slice();
      if (d.convenio && !convs.includes(d.convenio)) convs.unshift(d.convenio);
      const prDoc = E.admin.prestadores.find(x => x.id === d.prestador_id);
      const medicosDoc = ((prDoc && prDoc.medicos) || []).slice();
      if (d.medico && !medicosDoc.includes(d.medico)) medicosDoc.unshift(d.medico);
      dlg.innerHTML = `
        <form id="form-editar-doc">
          <h2>Editar ${d.categoria === 'protocolo' ? 'protocolo' : 'documento'}</h2>
          <p>${h(d.nome_original)}</p>
          <label class="campo"><span>Convênio</span><select name="convenio"><option value="">—</option>${convs.map(c => `<option ${c === d.convenio ? 'selected' : ''}>${h(c)}</option>`).join('')}</select></label>
          ${medicosDoc.length ? `<label class="campo"><span>Executante</span><select name="medico"><option value="">Clínica inteira</option>${medicosDoc.map(m => `<option ${m === d.medico ? 'selected' : ''}>${h(m)}</option>`).join('')}</select></label>` : ''}
          ${d.categoria === 'protocolo' ? `
            <label class="campo"><span>Número do protocolo</span><input name="numero" value="${h(d.numero)}"></label>
            <label class="campo"><span>Data de envio</span><input name="data_envio" type="date" value="${h(d.data_envio || '')}"></label>
            <label class="campo"><span>Previsão de pagamento</span><input name="previsao_pagamento" type="date" value="${h(d.previsao_pagamento || '')}">
              <small>${d.previsao_pagamento ? 'Definida no protocolo.' : d.previsao ? `Vazia = vale a do lote (${dataBR(d.previsao)}).` : 'Vazia = sem previsão.'}</small></label>` : ''}
          <label class="campo"><span>Competência</span><input name="competencia" value="${compBR(d.competencia)}" placeholder="MM/AAAA" maxlength="7"></label>
          <label class="campo"><span>Observação</span><input name="observacao" value="${h(d.observacao)}"></label>
          <p class="erro" role="alert"></p>
          <div class="rodape-dialogo">
            <button type="button" class="botao fantasma" data-fechar>Cancelar</button>
            <button type="submit" class="botao primario">Salvar</button>
          </div>
        </form>`;
      let salvo = false;
      const f = $('#form-editar-doc');
      $('[data-fechar]', dlg).onclick = () => dlg.close();
      if (f.data_envio) f.data_envio.onchange = () => { const c = competenciaPelaData(f.data_envio.value, f.convenio.value); if (c) f.competencia.value = compBR(c); };
      f.onsubmit = async ev => {
        ev.preventDefault();
        const m = f.competencia.value.trim().match(/^(0[1-9]|1[0-2])\/(\d{4})$/);
        if (!m){ $('.erro', f).textContent = 'Competência como MM/AAAA.'; return; }
        const corpo = { id: d.id, convenio: f.convenio.value, competencia: `${m[2]}-${m[1]}`, observacao: f.observacao.value };
        if (f.medico) corpo.medico = f.medico.value;
        if (f.numero){ corpo.numero = f.numero.value; corpo.data_envio = f.data_envio.value; corpo.previsao_pagamento = f.previsao_pagamento.value; }
        try { await CF().api('/api/documentos?acao=editar', { method: 'POST', body: JSON.stringify(corpo) }); salvo = true; dlg.close(); }
        catch (e){ $('.erro', f).textContent = e.message; }
      };
      dlg.onclose = () => resolve(salvo);
      dlg.showModal();
    });
  }

  // Produção: PDF vai direto para o Blob privado; local: passa pelo servidor.
  async function enviarDocumento(meta, arquivo, progresso){
    if (!CF().estado.direto){
      const q = new URLSearchParams({ acao: 'enviar', ...meta, nome: arquivo.name });
      return CF().enviarPdfPeloServidor(`/api/documentos?${q}`, arquivo, progresso);
    }
    const caminho = `prestador-${meta.prestador_id}/${meta.categoria}/${meta.competencia}/${CF().slug(arquivo.name.replace(/\.pdf$/i, '')).slice(0, 80)}-${Date.now()}.pdf`;
    let r;
    try {
      r = await VercelBlob.upload(caminho, arquivo, {
        access: 'private', handleUploadUrl: '/api/upload', contentType: 'application/pdf',
        multipart: arquivo.size > 20 * 1024 * 1024,
        onUploadProgress: p => progresso((p.percentage || 0) / 100),
      });
    } catch (e){
      console.error('upload direto:', e);
      throw new Error('Não foi possível enviar o PDF. Confira a internet e tente de novo.');
    }
    return CF().api('/api/documentos?acao=registrar', { method: 'POST', body: JSON.stringify({ ...meta, chave: r.pathname, nome: arquivo.name, tamanho: arquivo.size }) });
  }

  window.CFPrestador = { portal, equipe, abrirResumo, abrirLotes };
})();
