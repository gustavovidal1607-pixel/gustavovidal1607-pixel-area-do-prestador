// Área do Prestador — núcleo das telas: abertura, login, topo, acessos da
// equipe e utilitários. As telas do prestador e a aba Prestadores ficam em
// js/prestador.js (usam window.CF).
(function(){
  'use strict';

  const $ = (sel, raiz = document) => raiz.querySelector(sel);
  const $$ = (sel, raiz = document) => Array.from(raiz.querySelectorAll(sel));
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

  const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const MESES_CURTO = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
  const slug = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');

  const estado = {
    usuario: null,
    direto: false,   // true = PDF vai do navegador direto para o armazenamento (produção)
    aba: 'painel',
    admin: null,     // { prestadores, usuarios, ... }
  };

  // ---------------------------------------------------------------- utilidades
  function hojeISO(){
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const dataBR = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';
  function quandoBR(ts){
    if (!ts) return '';
    const d = new Date(ts);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} às ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const tamanhoBR = n => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

  function aviso(texto, erro){
    const el = document.createElement('div');
    el.className = 'aviso' + (erro ? ' erro-aviso' : '');
    el.textContent = texto;
    $('#avisos').appendChild(el);
    setTimeout(() => { el.classList.add('some'); setTimeout(() => el.remove(), 350); }, erro ? 7000 : 4000);
  }

  async function api(url, opcoes = {}){
    const r = await fetch(url, { credentials: 'same-origin', ...opcoes, headers: { 'Content-Type': 'application/json', ...(opcoes.headers || {}) } });
    let dados = {};
    try { dados = await r.json(); } catch {}
    if (r.status === 401 && estado.usuario){
      estado.usuario = null;
      mostrarLogin('Sua sessão terminou. Entre de novo.');
      throw new Error(dados.erro || 'Sessão encerrada.');
    }
    if (!r.ok) throw new Error(dados.erro || 'Não foi possível concluir. Tente de novo.');
    return dados;
  }

  // Diálogo genérico: confirmar(opções) -> true/false
  function confirmar({ titulo, texto, botao = 'Confirmar', perigo = false }){
    return new Promise(resolve => {
      const dlg = $('#dialogo');
      dlg.innerHTML = `
        <form method="dialog">
          <h2>${h(titulo)}</h2>
          <p>${texto}</p>
          <div class="rodape-dialogo">
            <button type="button" class="botao fantasma" value="nao">Cancelar</button>
            <button type="submit" class="botao ${perigo ? 'perigo' : 'primario'}" value="sim">${h(botao)}</button>
          </div>
        </form>`;
      $('button[value=nao]', dlg).onclick = () => dlg.close('nao');
      dlg.onclose = () => resolve(dlg.returnValue === 'sim');
      dlg.showModal();
    });
  }

  function pedirTexto(titulo, rotulo, valor){
    return new Promise(resolve => {
      const dlg = $('#dialogo');
      dlg.innerHTML = `
        <form id="form-texto">
          <h2>${h(titulo)}</h2>
          <label class="campo"><span>${h(rotulo)}</span><input name="v" value="${h(valor)}" required autocomplete="off"></label>
          <div class="rodape-dialogo">
            <button type="button" class="botao fantasma" data-fechar>Cancelar</button>
            <button type="submit" class="botao primario">Salvar</button>
          </div>
        </form>`;
      let resultado = null;
      $('[data-fechar]', dlg).onclick = () => dlg.close();
      $('#form-texto').onsubmit = ev => { ev.preventDefault(); resultado = ev.target.v.value.trim(); dlg.close(); };
      dlg.onclose = () => resolve(resultado);
      dlg.showModal();
      $('input', dlg).select();
    });
  }

  // Envio de PDF pelo servidor (modo local). Em produção o PDF vai direto
  // para o armazenamento (ver js/prestador.js).
  function enviarPdfPeloServidor(url, arquivo, aoProgredir){
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', url);
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = e => { if (e.lengthComputable && aoProgredir) aoProgredir(e.loaded / e.total); };
      x.onload = () => {
        let dados = {};
        try { dados = JSON.parse(x.responseText); } catch {}
        if (x.status === 401){ estado.usuario = null; mostrarLogin('Sua sessão terminou. Entre de novo.'); reject(new Error('Sessão encerrada.')); return; }
        if (x.status >= 200 && x.status < 300) resolve(dados);
        else reject(new Error(dados.erro || (x.status === 413 ? 'O arquivo passa do tamanho permitido.' : 'Não foi possível enviar. Tente de novo.')));
      };
      x.onerror = () => reject(new Error('Sem conexão com o servidor. Confira a internet e tente de novo.'));
      x.send(arquivo);
    });
  }

  // ---------------------------------------------------------------- abertura
  async function abertura(){
    const caixa = $('#abertura-logo');
    try {
      const svg = await (await fetch('img/logo.svg')).text();
      caixa.innerHTML = svg;
    } catch { caixa.innerHTML = '<img src="img/logo.svg" alt="Faturas Med">'; }
    const tela = $('#abertura');
    const foto = $('.abertura-foto', tela);
    // Espera a foto estar pronta (no máximo 1,5 s) para a sequência não começar com o fundo vazio.
    await Promise.race([foto.decode().catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
    requestAnimationFrame(() => tela.classList.add('animar'));
    // A sequência inteira dura ~3,4 s; segura mais um pouco no final. Um clique na tela pula a espera.
    let pular;
    const espera = new Promise(r => { pular = r; setTimeout(r, 4300); });
    tela.addEventListener('click', () => pular(), { once: true });
    let usuario = null;
    try { const r = await api('/api/auth?acao=eu'); usuario = r.usuario; estado.direto = !!r.direto; } catch {}
    await espera;
    if (usuario) entrar(usuario); else mostrarLogin();
    tela.classList.add('saindo');
    setTimeout(() => tela.remove(), 600);
  }

  // ---------------------------------------------------------------- login
  let perfilLogin = 'prestador';
  function mostrarLogin(mensagem){
    $('#app').hidden = true;
    const tela = $('#tela-login');
    tela.hidden = false;
    $('#login-erro').textContent = mensagem || '';
    $('#login-senha').value = '';
    setTimeout(() => $('#login-usuario').focus(), 50);
  }

  function definirPerfilLogin(p){
    perfilLogin = p;
    $$('.seletor-perfil button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.perfil === p)));
    $('#login-dica').textContent = p === 'prestador'
      ? 'Médico ou clínica: entre com o seu usuário para acompanhar o faturamento.'
      : 'Acesso da equipe FaturasMed: prestadores, protocolos, repasses e acessos.';
  }

  $$('.seletor-perfil button').forEach(b => b.addEventListener('click', () => definirPerfilLogin(b.dataset.perfil)));

  $('#form-login').addEventListener('submit', async ev => {
    ev.preventDefault();
    const botao = $('button[type=submit]', ev.target);
    const erro = $('#login-erro');
    erro.textContent = '';
    botao.disabled = true; botao.textContent = 'Entrando…';
    try {
      const r = await fetch('/api/auth?acao=entrar', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: $('#login-usuario').value, senha: $('#login-senha').value, perfil: perfilLogin }),
      });
      const dados = await r.json().catch(() => ({}));
      if (!r.ok){
        if (dados.perfilCerto) definirPerfilLogin(dados.perfilCerto);
        erro.textContent = dados.erro || 'Não foi possível entrar.';
        return;
      }
      $('#login-senha').value = '';
      estado.direto = !!dados.direto;
      entrar(dados.usuario);
    } catch {
      erro.textContent = 'Sem conexão com o servidor. Confira a internet e tente de novo.';
    } finally {
      botao.disabled = false; botao.textContent = 'Entrar';
    }
  });

  // ---------------------------------------------------------------- entrada no sistema
  const ABAS = {
    faturas: [['prestadores', 'Prestadores'], ['acessos', 'Acessos']],
    prestador: [['painel', 'Painel'], ['faturas', 'Faturas'], ['resumo', 'Resumo'], ['protocolos', 'Protocolos'], ['repasses', 'Repasses']],
  };

  function entrar(usuario){
    estado.usuario = usuario;
    estado.admin = null;
    $('#tela-login').hidden = true;
    $('#app').hidden = false;
    $('#topo-nome').textContent = usuario.nome;
    $('#topo-local').textContent = usuario.perfil === 'prestador' ? usuario.prestador_nome : 'Equipe Faturas Med';
    const abas = ABAS[usuario.perfil] || [];
    estado.aba = abas[0][0];
    const nav = $('#topo-abas');
    nav.innerHTML = abas.map(([id, nome], i) => `<button type="button" data-aba="${id}" ${i === 0 ? 'aria-current="page"' : ''}>${nome}</button>`).join('');
    nav.hidden = false;
    document.body.dataset.perfil = usuario.perfil;
    renderizar();
  }

  // Troca de aba também por código (ex.: clicar num mês do painel abre Faturas).
  function irParaAba(aba){
    estado.aba = aba;
    $$('#topo-abas button').forEach(x => x.dataset.aba === aba ? x.setAttribute('aria-current', 'page') : x.removeAttribute('aria-current'));
    const b = $(`#topo-abas button[data-aba="${aba}"]`);
    if (b && b.scrollIntoView) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    renderizar();
    window.scrollTo(0, 0);
  }

  $('#btn-sair').addEventListener('click', async () => {
    try { await api('/api/auth?acao=sair', { method: 'POST' }); } catch {}
    estado.usuario = null;
    mostrarLogin();
  });

  $('#topo-abas').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-aba]');
    if (b) irParaAba(b.dataset.aba);
  });

  $('#btn-senha').addEventListener('click', () => {
    const dlg = $('#dialogo');
    dlg.innerHTML = `
      <form id="form-senha">
        <h2>Trocar minha senha</h2>
        <label class="campo"><span>Senha atual</span><input type="password" name="atual" autocomplete="current-password" required></label>
        <label class="campo"><span>Nova senha</span><input type="password" name="nova" autocomplete="new-password" minlength="6" required><small>Pelo menos 6 caracteres.</small></label>
        <label class="campo"><span>Repita a nova senha</span><input type="password" name="nova2" autocomplete="new-password" required></label>
        <p class="erro" role="alert"></p>
        <div class="rodape-dialogo">
          <button type="button" class="botao fantasma" data-fechar>Cancelar</button>
          <button type="submit" class="botao primario">Salvar nova senha</button>
        </div>
      </form>`;
    $('[data-fechar]', dlg).onclick = () => dlg.close();
    dlg.onclose = null;
    $('#form-senha').onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target, erro = $('.erro', f);
      if (f.nova.value !== f.nova2.value){ erro.textContent = 'As duas senhas novas não são iguais.'; return; }
      try {
        await api('/api/auth?acao=senha', { method: 'POST', body: JSON.stringify({ atual: f.atual.value, nova: f.nova.value }) });
        dlg.close(); aviso('Senha trocada.');
      } catch (e){ erro.textContent = e.message; }
    };
    dlg.showModal();
  });

  // ---------------------------------------------------------------- renderização principal
  function renderizar(){
    const u = estado.usuario;
    const c = $('#conteudo');
    if (u.perfil === 'prestador') return window.CFPrestador.portal(c, estado.aba);
    if (estado.aba === 'acessos'){
      c.innerHTML = `<div class="acessos" id="acessos"><div class="carregando">Carregando…</div></div>`;
      return carregarAcessos();
    }
    return window.CFPrestador.equipe(c);
  }

  // ---------------------------------------------------------------- equipe: acessos
  async function carregarAcessos(){
    try { estado.admin = await api('/api/admin?acao=dados'); }
    catch (e){ $('#acessos').innerHTML = `<div class="vazio"><strong>Não deu para carregar</strong>${h(e.message)}</div>`; return; }
    renderizarAcessos();
  }

  function gerarSenha(){
    const letras = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, b => letras[b % letras.length]).join('');
  }

  function renderizarAcessos(){
    const { usuarios, eu } = estado.admin;
    const prestadores = estado.admin.prestadores || [];
    const ativosP = prestadores.filter(p => p.ativo);
    const semAcento = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
    $('#acessos').innerHTML = `
      <section class="painel prest-coluna">
        <div class="bloco-titulo">
          <h2>Acessos <small class="contagem" id="acessos-contagem">${usuarios.length}</small></h2>
          <label class="busca"><span class="sr-only">Pesquisar acesso</span>
            <input type="search" id="busca-acesso" placeholder="Pesquisar por nome, usuário ou prestador…" autocomplete="off" value="${h(estado.buscaAcesso || '')}">
          </label>
        </div>
        <p class="sub">Quem entra no sistema. Cada prestador vê só os próprios dados; a equipe vê tudo. A senha pode ser redefinida a qualquer momento.</p>
        <ul class="lista-simples rolavel" id="lista-acessos">
          ${usuarios.map(x => `
            <li class="${x.ativo ? '' : 'inativo'}" data-nome="${h(semAcento(x.nome + ' ' + x.login + ' ' + (x.prestador_nome || '')))}">
              <div class="info">
                <strong>${h(x.nome)} <span class="mono" style="font-weight:500;color:var(--cinza);font-size:13px">${h(x.login)}</span></strong>
                <small><span class="selo ${x.perfil}">${x.perfil === 'faturas' ? 'Faturas Med' : 'Prestador'}</span> ${h(x.prestador_nome || '')}${x.ativo ? '' : ' <span class="selo off">desativado</span>'}${x.id === eu ? ' · você' : ''}</small>
              </div>
              <button type="button" class="link" data-redefinir="${x.id}">Redefinir senha</button>
              ${x.id === eu ? '' : `<button type="button" class="link ${x.ativo ? 'perigo' : ''}" data-usuario-ativo="${x.id}" data-valor="${!x.ativo}">${x.ativo ? 'Desativar' : 'Reativar'}</button>`}
            </li>`).join('')}
        </ul>
      </section>
      <section class="painel">
        <h2>Novo acesso</h2>
        <p class="sub">Crie o login de um prestador (ele vê só o que é dele) ou de alguém da equipe.</p>
        <form id="form-usuario" class="form-grade" autocomplete="off">
          <label class="campo"><span>Nome da pessoa</span><input name="nome" maxlength="120" required></label>
          <label class="campo"><span>Usuário (para entrar)</span><input name="login" maxlength="40" autocapitalize="none" required><small>Sem espaço nem acento. Ex.: renan.brito</small></label>
          <label class="campo"><span>Perfil</span>
            <select name="perfil"><option value="prestador">Prestador (médico/clínica)</option><option value="faturas">Equipe Faturas Med</option></select>
          </label>
          <label class="campo" data-para="prestador"><span>Prestador</span>
            <select name="prestador_id" ${ativosP.length ? '' : 'disabled'}>${ativosP.map(p => `<option value="${p.id}">${h(p.nome)}</option>`).join('') || '<option value="">Cadastre o prestador na aba Prestadores</option>'}</select>
          </label>
          <label class="campo inteiro"><span>Senha inicial</span>
            <div class="senha-linha"><input name="senha" minlength="6" maxlength="60" value="${gerarSenha()}" required><button type="button" class="botao fantasma" id="gerar-senha">Gerar outra</button></div>
            <small>Anote e passe para a pessoa; ela pode trocar depois em "Trocar senha".</small>
          </label>
          <p class="erro inteiro" id="erro-usuario" role="alert"></p>
          <div class="inteiro"><button class="botao primario" type="submit">Criar acesso</button></div>
        </form>
      </section>`;

    const caixa = $('#acessos');
    const filtrar = () => {
      const termo = semAcento(estado.buscaAcesso);
      let vistos = 0;
      const itens = $$('#lista-acessos li[data-nome]');
      itens.forEach(li => { const m = !termo || li.dataset.nome.includes(termo); li.hidden = !m; if (m) vistos++; });
      $('#acessos-contagem').textContent = termo ? `${vistos} de ${itens.length}` : String(itens.length);
      const vazio = $('#lista-acessos .sem-resultado');
      if (termo && !vistos){ if (!vazio) $('#lista-acessos').insertAdjacentHTML('beforeend', `<li class="vazio-li sem-resultado">Nenhum acesso com "${h(estado.buscaAcesso)}".</li>`); }
      else if (vazio) vazio.remove();
    };
    filtrar();
    $('#busca-acesso').oninput = ev => { estado.buscaAcesso = ev.target.value; filtrar(); };
    const fu = $('#form-usuario');
    const ajustar = () => { $$('[data-para]', fu).forEach(el => { el.hidden = el.dataset.para !== fu.perfil.value; }); };
    fu.perfil.onchange = ajustar; ajustar();
    $('#gerar-senha').onclick = () => { fu.senha.value = gerarSenha(); };
    fu.nome.oninput = () => {
      if (fu.login.dataset.mexido) return;
      fu.login.value = fu.nome.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim().split(/\s+/).slice(0, 2).join('.').replace(/[^a-z0-9._-]/g, '');
    };
    fu.login.oninput = () => { fu.login.dataset.mexido = '1'; };
    fu.onsubmit = async ev => {
      ev.preventDefault();
      const dados = { nome: fu.nome.value, login: fu.login.value, perfil: fu.perfil.value, prestador_id: fu.prestador_id.value, senha: fu.senha.value };
      try {
        const r = await api('/api/admin?acao=usuario', { method: 'POST', body: JSON.stringify(dados) });
        mostrarCredenciais(dados.nome, r.login, dados.senha, dados.perfil);
        carregarAcessos();
      } catch (e){ $('#erro-usuario').textContent = e.message; }
    };

    caixa.onclick = async ev => {
      const t = ev.target.closest('button[data-redefinir],button[data-usuario-ativo]');
      if (!t) return;
      try {
        if (t.dataset.redefinir){
          const x = estado.admin.usuarios.find(y => y.id === Number(t.dataset.redefinir));
          const senha = await pedirTexto(`Nova senha para ${x.nome}`, 'Nova senha (mín. 6)', gerarSenha());
          if (senha === null) return;
          await api('/api/admin?acao=usuario-editar', { method: 'POST', body: JSON.stringify({ id: x.id, senha }) });
          mostrarCredenciais(x.nome, x.login, senha, x.perfil);
        } else if (t.dataset.usuarioAtivo){
          const x = estado.admin.usuarios.find(y => y.id === Number(t.dataset.usuarioAtivo));
          const ativar = t.dataset.valor === 'true';
          if (!ativar && !(await confirmar({ titulo: `Desativar o acesso de ${x.nome}?`, texto: 'A pessoa é desconectada na hora e não entra mais até ser reativada.', botao: 'Desativar', perigo: true }))) return;
          await api('/api/admin?acao=usuario-editar', { method: 'POST', body: JSON.stringify({ id: x.id, ativo: ativar }) });
          aviso(ativar ? 'Acesso reativado.' : 'Acesso desativado.');
        }
        carregarAcessos();
      } catch (e){ aviso(e.message, true); }
    };
  }

  function mostrarCredenciais(nome, login, senha, perfil){
    const dlg = $('#dialogo');
    const texto = `Área do Prestador — Faturas Med\n${location.origin}\nEntrar como: ${perfil === 'faturas' ? 'FaturasMed' : 'Prestador'}\nUsuário: ${login}\nSenha: ${senha}`;
    dlg.innerHTML = `
      <form method="dialog">
        <h2>Acesso de ${h(nome)}</h2>
        <p>Passe estes dados para a pessoa. A senha não aparece de novo depois de fechar.</p>
        <div class="credenciais">${h(texto).replace(/\n/g, '<br>')}</div>
        <div class="rodape-dialogo">
          <button type="button" class="botao secundario" id="copiar-cred">Copiar</button>
          <button type="submit" class="botao primario">Fechar</button>
        </div>
      </form>`;
    dlg.onclose = null;
    $('#copiar-cred').onclick = async () => {
      try { await navigator.clipboard.writeText(texto); aviso('Copiado.'); } catch { aviso('Não deu para copiar — anote os dados.', true); }
    };
    dlg.showModal();
  }

  // ---------------------------------------------------------------- compartilhado com js/prestador.js
  window.CF = {
    $, $$, h, api, aviso, confirmar, pedirTexto, mostrarCredenciais, estado, irParaAba,
    enviarPdfPeloServidor, MESES, MESES_CURTO, dataBR, quandoBR, tamanhoBR, slug, hojeISO, mostrarLogin,
  };

  // ---------------------------------------------------------------- começo
  abertura();
})();
