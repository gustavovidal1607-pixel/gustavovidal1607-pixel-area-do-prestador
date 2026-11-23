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

  // Estado da Área do Prestador (zera a cada login).
  let P = null;
  function novoEstado(){
    return { usuario: CF().estado.usuario.id, painel: null, atualizado: null, comp: null, convenio: '', faturas: {}, filtroSit: '', busca: '', docs: {} };
  }

  // ================================================================ PORTAL DO PRESTADOR
  async function portal(caixa, aba){
    if (!P || P.usuario !== CF().estado.usuario.id) P = novoEstado();
    caixa.innerHTML = `<div class="portal" id="portal"><div class="carregando">Carregando…</div></div>`;
    try {
      if (!P.painel){
        const r = await CF().api('/api/prestador?acao=painel');
        P.painel = r.linhas; P.atualizado = r.atualizado_em; P.proximos = r.proximos || []; P.hoje = r.hoje;
        const comps = competencias();
        if (P.comp === null) P.comp = comps[0] || '';
      }
    } catch (e){ $('#portal').innerHTML = `<div class="vazio"><strong>Não deu para carregar</strong>${h(e.message)}</div>`; return; }
    if (aba === 'faturas') return telaFaturas();
    if (aba === 'protocolos') return telaDocumentos('protocolo');
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
        ${resumo ? `<button type="button" class="botao primario" id="btn-resumo">Gerar resumo</button>` : ''}
      </div>`;
  }

  function ligarFiltros(aoMudar){
    $('#f-comp').onchange = ev => { P.comp = ev.target.value; aoMudar(); };
    $('#f-conv').onchange = ev => { P.convenio = ev.target.value; aoMudar(); };
    const b = $('#btn-resumo');
    if (b) b.onclick = () => abrirResumo(P.comp || competencias()[0]);
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
      ${cabecalho('Painel', `${h(compNome(P.comp))}${P.convenio ? ' · ' + h(P.convenio) : ''}. ${atualizado}`, filtros())}
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
    if (!P.comp) P.comp = competencias()[0] || '';
    if (!P.comp){
      caixa.innerHTML = cabecalho('Faturas', '') + `<div class="painel vazio"><strong>Ainda não há faturas</strong>Elas aparecem depois da sincronização das planilhas.</div>`;
      return;
    }
    caixa.innerHTML = `
      ${cabecalho('Faturas', 'Lotes e guias da competência, com a situação de cada procedimento.', filtros({ todas: false }))}
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
    const chave = P.comp;
    try {
      if (!P.faturas[chave]) P.faturas[chave] = (await CF().api(`/api/prestador?acao=faturas&mes=${chave}`)).linhas;
    } catch (e){ $('#fat-lista').innerHTML = `<div class="vazio"><strong>Não deu para carregar</strong>${h(e.message)}</div>`; return; }
    if (P.comp === chave) listaFaturas();
  }

  function listaFaturas(){
    const todas = (P.faturas[P.comp] || []).filter(l => !P.convenio || l.convenio === P.convenio);
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
      const k = `${l.convenio}|${l.lote || ''}`;
      if (!idx[k]){ idx[k] = { convenio: l.convenio, lote: l.lote, data_lote: l.data_lote, linhas: [] }; grupos.push(idx[k]); }
      idx[k].linhas.push(l);
    });
    alvo.innerHTML = grupos.map(g => {
      const tg = somar(g.linhas.map(l => ({ faturado: l.faturado, recebido: l.recebido, glosado: Math.max(0, l.glosado || 0) })));
      const nGuias = new Set(g.linhas.map(l => l.guia)).size;
      const sitLote = situacaoLote(g.linhas);
      return `
        <section class="lote">
          <header class="lote-cabeca">
            <div class="lote-id">
              <span class="chip conv">${h(g.convenio)}</span>
              <strong>Lote ${h(g.lote || 'sem número')}</strong>
              ${g.data_lote ? `<span class="quando">${dataBR(g.data_lote)}</span>` : ''}
            </div>
            <div class="lote-tot">
              <span>${nGuias} guia${nGuias === 1 ? '' : 's'}</span>
              <span>Faturado <b>${dinheiro(tg.faturado)}</b></span>
              <span>Recebido <b>${dinheiro(tg.recebido)}</b></span>
              ${sitLote !== 'pago' && previsaoLote(g.linhas) ? `<span class="previsao">Previsão <b>${dataBR(previsaoLote(g.linhas))}</b></span>` : ''}
              ${selo(sitLote)}
            </div>
          </header>
          <div class="rolagem">
          <table class="tabela-faturas cartoes-mobile">
            <thead><tr><th>Paciente</th><th>Guia</th><th>Data</th><th>Tipo</th><th>Código</th><th>Procedimento</th><th>Faturado</th><th>Recebido</th><th>Glosado</th><th>Situação</th></tr></thead>
            <tbody>
              ${g.linhas.map(l => `
                <tr>
                  <th scope="row" class="c-pac" data-r="">${h(l.paciente || '—')}</th>
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

  const previsaoLote = linhas => linhas.map(l => l.previsao).filter(Boolean).sort().pop() || '';

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
    const titulo = categoria === 'protocolo' ? 'Protocolos de envio' : 'Documentos de repasse';
    const sub = categoria === 'protocolo'
      ? 'Comprovantes do envio das suas faturas aos convênios.'
      : 'Relatórios de repasse e espelhos de pagamento.';
    caixa.innerHTML = cabecalho(titulo, sub) + `<div id="docs"><div class="carregando">Carregando…</div></div>`;
    try {
      if (!P.docs[categoria]) P.docs[categoria] = (await CF().api(`/api/documentos?acao=lista&categoria=${categoria}`)).documentos;
    } catch (e){ $('#docs').innerHTML = `<div class="vazio"><strong>Não deu para carregar</strong>${h(e.message)}</div>`; return; }
    const docs = P.docs[categoria];
    const comps = Array.from(new Set(docs.map(d => d.competencia))).sort().reverse();
    const convs = Array.from(new Set(docs.map(d => d.convenio).filter(Boolean))).sort();
    const filtroDoc = P[`filtro_${categoria}`] || (P[`filtro_${categoria}`] = { comp: '', conv: '' });
    const desenhar = () => {
      const lista = docs.filter(d => (!filtroDoc.comp || d.competencia === filtroDoc.comp) && (!filtroDoc.conv || d.convenio === filtroDoc.conv));
      const porComp = {};
      lista.forEach(d => (porComp[d.competencia] = porComp[d.competencia] || []).push(d));
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
      </div>
      <div id="docs-lista"></div>`;
    $('#d-comp').onchange = ev => { filtroDoc.comp = ev.target.value; desenhar(); };
    if ($('#d-conv')) $('#d-conv').onchange = ev => { filtroDoc.conv = ev.target.value; desenhar(); };
    desenhar();
  }

  function itemDocumento(d, equipe){
    const titulo = d.categoria === 'protocolo'
      ? `Protocolo ${h(d.numero)}`
      : h(d.tipo || 'Documento');
    const meta = [
      d.convenio ? `<span class="chip conv">${h(d.convenio)}</span>` : '',
      d.data_envio ? `<span>${d.categoria === 'protocolo' ? 'enviado em' : 'de'} ${dataBR(d.data_envio)}</span>` : '',
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
          <small class="doc-nome" title="${h(d.nome_original)}">${h(d.nome_original)} · ${CF().tamanhoBR(d.tamanho)}</small>
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

  // ---------------------------------------------------------------- resumo de faturamento (PDF único: resumo + protocolos)
  // "Gerar resumo" mostra a prévia e já baixa
  // "RESUMO <MM-AAAA> - <PRESTADOR>.pdf": página(s) do resumo + todos os PDFs
  // de protocolo da competência (ordem convênio -> data de envio), montado no
  // navegador com pdf-lib (js/vendor/pdf-lib.min.js, carregado só aqui).
  async function abrirResumo(comp, prestadorId, baixar = true){
    const tela = $('#resumo');
    const comps = P && P.painel && !prestadorId ? competencias() : [comp];
    tela.hidden = false;
    document.body.classList.add('com-resumo');
    tela.innerHTML = `<div class="resumo-barra"><span>Carregando o resumo…</span></div>`;
    let r, protocolos;
    try {
      const q = prestadorId ? `&prestador=${prestadorId}` : '';
      const [res, docs] = await Promise.all([
        CF().api(`/api/prestador?acao=resumo&mes=${comp}${q}`),
        CF().api(`/api/documentos?acao=lista&categoria=protocolo${q}`),
      ]);
      r = res;
      protocolos = docs.documentos.filter(d => d.competencia === comp && (!prestadorId || d.prestador_id === prestadorId)).sort(ordemProtocolo);
    } catch (e){ CF().aviso(e.message, true); fecharResumo(); return; }
    const porConv = agruparResumo(r.grupos);
    const total = somaResumo(r.grupos);
    const gerado = new Date(r.gerado_em);
    tela.innerHTML = `
      <div class="resumo-barra nao-imprimir">
        <label class="campo"><span>Competência</span>
          <select id="r-comp">${comps.map(c => `<option value="${c}" ${c === comp ? 'selected' : ''}>${compBR(c)}</option>`).join('')}</select>
        </label>
        <div class="resumo-botoes">
          <button type="button" class="botao primario" id="r-baixar">Baixar PDF</button>
          <button type="button" class="botao fantasma" id="r-fechar">Fechar</button>
        </div>
        <p class="resumo-status" id="r-status" aria-live="polite"></p>
      </div>
      <article class="folha" id="folha">
        <header class="folha-cabeca">
          <img src="img/logo.svg" alt="Faturas Med" class="folha-logo">
          <div class="folha-titulo">
            <h1>Resumo de faturamento</h1>
            <p><span>Prestador</span><strong>${h(r.prestador.nome)}</strong></p>
            <p><span>Competência</span><strong>${compBR(r.mes)}</strong></p>
          </div>
        </header>
        ${r.grupos.length ? porConv.map(([c, gs]) => {
          const st = somaResumo(gs);
          return `
            <section class="folha-conv">
              <h2>${h(c)}</h2>
              <table>
                <thead><tr><th>Tipo de guia</th><th class="n">Guias</th><th class="n">Valor faturado</th></tr></thead>
                <tbody>${gs.map(g => `<tr><td>${h(tipoNome(g.tipo))}</td><td class="n">${g.guias}</td><td class="n">${dinheiro(g.faturado)}</td></tr>`).join('')}</tbody>
                <tfoot><tr><td>Total ${h(c)}</td><td class="n">${st.guias}</td><td class="n">${dinheiro(st.faturado)}</td></tr></tfoot>
              </table>
            </section>`;
        }).join('') : `<p class="folha-vazio">Nada faturado nesta competência.</p>`}
        <div class="folha-total">
          <span>Total geral · ${total.guias} guia${total.guias === 1 ? '' : 's'}</span>
          <strong>${dinheiro(total.faturado)}</strong>
        </div>
        <footer class="folha-rodape">Faturas Med · Faturamento Médico e Hospitalar · gerado em ${h(CF().quandoBR(gerado))}</footer>
      </article>`;
    const status = $('#r-status');
    const botao = $('#r-baixar');
    const gerar = async () => {
      botao.disabled = true;
      try {
        const { bytes, paginas, falhas } = await gerarPdfResumo(r, protocolos, t => { status.textContent = t; });
        const nome = `RESUMO ${compBR(r.mes).replace('/', '-')} - ${r.prestador.nome}.pdf`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        a.download = nome;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        status.textContent = `Pronto: ${nome} (${paginas} página${paginas === 1 ? '' : 's'})${falhas.length ? ` — não deu para anexar: ${falhas.join(', ')}` : ''}`;
      } catch (e){
        console.error(e);
        status.textContent = '';
        CF().aviso(e.message || 'Não deu para gerar o PDF.', true);
      } finally { botao.disabled = false; }
    };
    $('#r-fechar').onclick = fecharResumo;
    botao.onclick = gerar;
    $('#r-comp').onchange = ev => abrirResumo(ev.target.value, prestadorId, false);
    tela.scrollTop = 0;
    botao.focus();
    if (baixar) gerar();
  }

  const ordemProtocolo = (a, b) => (a.convenio || '').localeCompare(b.convenio || '', 'pt-BR')
    || String(a.data_envio || '').localeCompare(String(b.data_envio || '')) || String(a.numero).localeCompare(String(b.numero)) || a.id - b.id;
  function agruparResumo(grupos){
    const por = {};
    grupos.forEach(g => (por[g.convenio] = por[g.convenio] || []).push(g));
    return Object.entries(por);
  }
  const somaResumo = gs => gs.reduce((s, g) => ({ guias: s.guias + g.guias, faturado: s.faturado + g.faturado }), { guias: 0, faturado: 0 });

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

  async function gerarPdfResumo(r, protocolos, aviso){
    aviso('Preparando o PDF…');
    await carregarPdfLib();
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    doc.setTitle(`Resumo de faturamento ${compBR(r.mes)} - ${r.prestador.nome}`);
    doc.setAuthor('Faturas Med');
    const fonte = await doc.embedFont(StandardFonts.Helvetica);
    const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
    let logo = null;
    try { logo = await doc.embedPng(await logoPng()); } catch (e){ console.warn('logo', e); }

    // Busca os protocolos antes de desenhar (para marcar os que falharem).
    const anexos = [], falhas = [];
    for (let i = 0; i < protocolos.length; i++){
      const d = protocolos[i];
      aviso(`Anexando protocolo ${i + 1} de ${protocolos.length}…`);
      try {
        const resp = await fetch(`/api/documentos?id=${d.id}`, { credentials: 'same-origin' });
        if (!resp.ok) throw new Error(String(resp.status));
        anexos.push({ d, pdf: await PDFDocument.load(await resp.arrayBuffer(), { ignoreEncryption: true }) });
      } catch (e){ console.error('protocolo', d.id, e); falhas.push(d.numero); }
    }

    const cor = hex => rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
    const AZUL = cor('#0B60B5'), TINTA = cor('#0D2440'), CINZA = cor('#5E6772'), CLARO = cor('#E7F0FA'), LINHA = cor('#D5DFEA'), FINA = cor('#EBF0F5');
    // Helvetica padrão só tem os caracteres do Latin-1 (acentos do português ok).
    const t = s => String(s ?? '').replace(/[^\x20-\x7E\xA0-\xFF–—•…‘’“”]/g, '?');
    const W = 595.28, H = 841.89, M = 48;
    const larg = (s, f, tam) => f.widthOfTextAtSize(t(s), tam);
    let pagina, y;
    const texto = (s, x, yy, { f = fonte, tam = 10, c = TINTA, alinhar = 'esq' } = {}) => {
      const w = larg(s, f, tam);
      pagina.drawText(t(s), { x: alinhar === 'dir' ? x - w : alinhar === 'centro' ? x - w / 2 : x, y: yy, size: tam, font: f, color: c });
    };
    const rodape = () => texto(`Faturas Med · Faturamento Médico e Hospitalar · gerado em ${CF().quandoBR(new Date(r.gerado_em))}`, W / 2, 28, { tam: 7.5, c: CINZA, alinhar: 'centro' });
    const novaPagina = (primeira) => {
      pagina = doc.addPage([W, H]);
      y = H - M;
      if (primeira){
        if (logo){ const lw = 170, lh = lw * logo.height / logo.width; pagina.drawImage(logo, { x: M, y: y - lh, width: lw, height: lh }); }
        texto('RESUMO DE FATURAMENTO', W - M, y - 14, { f: negrito, tam: 15, c: AZUL, alinhar: 'dir' });
        const linhaCab = (rot, val, yy) => {
          const wv = larg(val, negrito, 10.5);
          texto(val, W - M, yy, { f: negrito, tam: 10.5, alinhar: 'dir' });
          texto(rot, W - M - wv - 8, yy, { tam: 8, c: CINZA, alinhar: 'dir' });
        };
        linhaCab('PRESTADOR', r.prestador.nome, y - 32);
        linhaCab('COMPETÊNCIA', compBR(r.mes), y - 47);
        y -= 62;
      } else {
        texto(`Resumo de faturamento · ${r.prestador.nome} · ${compBR(r.mes)}`, M, y - 10, { f: negrito, tam: 10, c: AZUL });
        y -= 20;
      }
      pagina.drawRectangle({ x: M, y, width: W - 2 * M, height: 2.5, color: AZUL });
      y -= 24;
      rodape();
    };
    const espaco = precisa => { if (y - precisa < 60) novaPagina(false); };

    novaPagina(true);
    const xGuias = 380, xValor = W - M - 8;
    const grupos = agruparResumo(r.grupos);
    if (!grupos.length){ texto('Nada faturado nesta competência.', M, y, { c: CINZA }); y -= 24; }
    for (const [conv, gs] of grupos){
      espaco(22 + 18 + 18 * (gs.length + 1) + 14);
      pagina.drawRectangle({ x: M, y: y - 16, width: W - 2 * M, height: 22, color: CLARO });
      pagina.drawRectangle({ x: M, y: y - 16, width: 4, height: 22, color: AZUL });
      texto(conv, M + 12, y - 9, { f: negrito, tam: 11 });
      y -= 32;
      texto('TIPO DE GUIA', M + 8, y, { f: negrito, tam: 7.5, c: CINZA });
      texto('GUIAS', xGuias, y, { f: negrito, tam: 7.5, c: CINZA, alinhar: 'dir' });
      texto('VALOR FATURADO', xValor, y, { f: negrito, tam: 7.5, c: CINZA, alinhar: 'dir' });
      y -= 6; pagina.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: LINHA }); y -= 13;
      for (const g of gs){
        texto(tipoNome(g.tipo), M + 8, y);
        texto(String(g.guias), xGuias, y, { alinhar: 'dir' });
        texto(dinheiro(g.faturado), xValor, y, { alinhar: 'dir' });
        y -= 6; pagina.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: FINA }); y -= 13;
      }
      const st = somaResumo(gs);
      texto(`Total ${conv}`, M + 8, y, { f: negrito });
      texto(String(st.guias), xGuias, y, { f: negrito, alinhar: 'dir' });
      texto(dinheiro(st.faturado), xValor, y, { f: negrito, alinhar: 'dir' });
      y -= 30;
    }
    espaco(50);
    const total = somaResumo(r.grupos);
    pagina.drawRectangle({ x: M, y: y - 14, width: W - 2 * M, height: 34, color: TINTA });
    texto(`TOTAL GERAL · ${total.guias} GUIA${total.guias === 1 ? '' : 'S'}`, M + 14, y - 1, { f: negrito, tam: 10.5, c: rgb(1, 1, 1) });
    texto(dinheiro(total.faturado), W - M - 14, y - 2, { f: negrito, tam: 14, c: rgb(1, 1, 1), alinhar: 'dir' });
    y -= 50;

    // Willian 23/11: a lista "Protocolos anexados" não vai no PDF (os protocolos já vêm nas páginas seguintes)
    for (const { pdf } of anexos){
      const paginas = await doc.copyPages(pdf, pdf.getPageIndices());
      paginas.forEach(p => doc.addPage(p));
    }
    aviso('Salvando…');
    return { bytes: await doc.save(), paginas: doc.getPageCount(), falhas };
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
        <section class="painel">
          <h2>Prestadores</h2>
          <p class="sub">Médicos e clínicas com acesso ao portal. O nome é o mesmo da pasta das planilhas em CONTROLE DE PAGAMENTO. O login do prestador se cria em <b>Clínicas e acessos</b>.</p>
          <ul class="lista-simples prestadores">
            ${prestadores.length ? prestadores.map(p => `
              <li class="${p.ativo ? '' : 'inativo'}">
                <div class="info">
                  <strong>${h(p.nome)}</strong>
                  <small>${p.usuarios} acesso${p.usuarios === 1 ? '' : 's'} · ${p.linhas.toLocaleString('pt-BR')} linhas · ${p.documentos} documento${p.documentos === 1 ? '' : 's'}${p.ativo ? '' : ' · desativado'}</small>
                  ${p.sincronizacoes.length ? `<small class="sync">${p.sincronizacoes.map(s => `${h(s.convenio)} ${s.linhas} (${h(CF().quandoBR(s.quando))})`).join(' · ')}</small>` : '<small class="sync">Ainda não sincronizado.</small>'}
                </div>
                <div class="acoes-li">
                  <button type="button" class="link" data-ver-resumo="${p.id}" ${p.linhas ? '' : 'disabled'}>Resumo</button>
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
              <select id="e-cat" aria-label="Tipo"><option value="">Protocolos e repasses</option><option value="protocolo" ${E.filtroCategoria === 'protocolo' ? 'selected' : ''}>Protocolos</option><option value="repasse" ${E.filtroCategoria === 'repasse' ? 'selected' : ''}>Repasses</option></select>
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

  function ligarEquipe(caixa){
    listaDocsEquipe();
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
    // (Bradesco Saúde +60 dias, Operadora +65, Unimed último dia útil do mês
    // seguinte à competência; outros convênios: vazio). Editou, não muda mais.
    const sugerirPrevisao = async () => {
      if (f.previsao_pagamento.dataset.mexido) return;
      const m = f.competencia.value.match(/^(0[1-9]|1[0-2])\/(\d{4})$/);
      const q = new URLSearchParams({ acao: 'sugerir-previsao', convenio: f.convenio.value, data_envio: f.data_envio.value, competencia: m ? `${m[2]}-${m[1]}` : '' });
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
      dlg.innerHTML = `
        <form id="form-editar-doc">
          <h2>Editar ${d.categoria === 'protocolo' ? 'protocolo' : 'documento'}</h2>
          <p>${h(d.nome_original)}</p>
          <label class="campo"><span>Convênio</span><select name="convenio"><option value="">—</option>${convs.map(c => `<option ${c === d.convenio ? 'selected' : ''}>${h(c)}</option>`).join('')}</select></label>
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

  window.CFPrestador = { portal, equipe, abrirResumo };
})();
