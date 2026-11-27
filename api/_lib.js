// Módulo interno (o "_" na frente faz a Vercel não publicar como rota).
// Junta tudo que as rotas usam: banco, armazenamento dos PDFs, sessão,
// leitura/resposta de requisição e as regras de previsão de pagamento.
//
// Dois modos, escolhidos sozinhos pelas variáveis de ambiente:
//  - ONLINE (Vercel): DATABASE_URL (Neon/Postgres) + BLOB_READ_WRITE_TOKEN
//    (Vercel Blob, loja PRIVADA). Os PDFs nunca ficam com link público.
//  - LOCAL (teste no PC): sem essas variáveis, o banco é um Postgres
//    embutido (PGlite) e os PDFs vão para a pasta dados-local/.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Envio pelo servidor: na Vercel a função não recebe mais que 4,5 MB (por
// isso lá o PDF vai direto para o Blob); no PC não há esse limite.
const LIMITE_PDF = process.env.BLOB_READ_WRITE_TOKEN ? 4 * 1024 * 1024 : 300 * 1024 * 1024;
const LIMITE_PDF_DIRETO = 100 * 1024 * 1024; // teto de segurança do envio direto
// Convênios: os mesmos nomes das pastas de
// \\faturasmed\Documents\CONTROLE DE PAGAMENTO (de onde vêm as planilhas).
// Bradesco aparece separado em SAÚDE e OPERADORA (regra no sincronizar.py).
// Abas que só um prestador tem (nome do cadastro -> abas). Willian 24/11/2026: "Lotes Bradesco" só da PATHOLOGY.
// O prestador só vê a aba se estiver aqui, e a API recusa para os outros.
const ABAS_EXCLUSIVAS = { 'PATHOLOGY': ['lotes'] };
// Personalização por prestador (Gustavo 27/11/2026: cada prestador é personalizado do jeito dele; quem não está
// aqui fica com o comportamento padrão). Vai para o front em "opcoes" (sessão e lista de prestadores da equipe)
// e o front só liga cada comportamento se a opção estiver ativa. Opções:
//   abaRecursos        aba "Recursos" (recursos de glosa, glosas acatadas e em análise para recurso)
//   lotesFechados      Faturas: cada lote fechado (faturado, pago, glosado, aguardando) e abre ao clicar
//   atencaoEmAnalise   STATUS ATENÇÃO = selo "Glosado - Em análise para recurso" + filtro próprio
//   historicoGuia      coluna Situação com o histórico da guia (glosa, recurso, resposta) e o selo do recurso
//   seloLoteRecurso    selo do lote segue o recurso/glosa ("Recursado dia ...", "Recurso negado"...)
//   acatadoComoAcatado STATUS ACATADO = selo "Acatado"
//   cartoesRecursoClicaveis  aba Recursos: cartões dos totais filtram a lista (padrão dos cartões de Lotes Bradesco)
const PERSONALIZACAO = {
  'INTEGRADA INFANTIL': { abaRecursos: true, lotesFechados: true, atencaoEmAnalise: true, historicoGuia: true, seloLoteRecurso: true, acatadoComoAcatado: true, cartoesRecursoClicaveis: true },   // Gustavo 26/11
};
const opcoesPrestador = nome => ({ ...(PERSONALIZACAO[String(nome || '').trim().toUpperCase()] || {}) });
const abasExtras = nome => (ABAS_EXCLUSIVAS[String(nome || '').trim().toUpperCase()] || [])
  .concat(opcoesPrestador(nome).abaRecursos ? ['recursos'] : []);

const CONVENIOS_PRESTADOR = ['AMIL', 'ASSIM', 'BRADESCO SAÚDE', 'BRADESCO OPERADORA', 'CABERJ - INTEGRAL', 'CABERJ - SAÚDE', 'CASSI', 'MEDISERVICE', 'OMINT', 'PETROBRÁS', 'SULAMÉRICA', 'UNIMED', 'VALE'];
// Previsão de pagamento sugerida por convênio. Para cadastrar a regra de um
// convênio novo, basta acrescentar aqui:
//   { tipo: 'dias_apos_envio', dias: N }           -> data de envio + N dias
//     (+ por_tipo: { CONSULTA: N, SADT: N, 'HONORÁRIO': N } -> dias pelo tipo de guia do lote)
//   { tipo: 'ultimo_dia_util_mes_seguinte' }       -> último dia útil do mês seguinte à competência
//   { tipo: 'dia_fixo_mes_seguinte', dia: N }      -> dia N do mês seguinte à competência
// Convênio sem regra: a previsão fica vazia para a equipe preencher.
// A chave pode ser o nome completo ou o começo dele ("UNIMED" vale para UNIMED ...).
const REGRAS_PREVISAO = {
  // Bradesco: dias a partir do fechamento/envio do lote por TIPO DE GUIA (Willian 23/11);
  // tipo fora da lista ou desconhecido = a regra antiga do Medware (dias).
  'BRADESCO SAÚDE': { tipo: 'dias_apos_envio', dias: 60, por_tipo: { 'CONSULTA': 10, 'SADT': 45, 'HONORÁRIO': 30 } },
  'BRADESCO OPERADORA': { tipo: 'dias_apos_envio', dias: 65, por_tipo: { 'CONSULTA': 30, 'HONORÁRIO': 45, 'SADT': 55 } },
  'UNIMED': { tipo: 'ultimo_dia_util_mes_seguinte' },
  'PETROBRÁS': { tipo: 'ultimo_dia_util_mes_seguinte' },          // Willian 23/11
  'PETROBRAS': { tipo: 'ultimo_dia_util_mes_seguinte' },
  'MEDISERVICE': { tipo: 'dia_fixo_mes_seguinte', dia: 28 },      // Willian 23/11: dia 28 do mês seguinte ao fechamento
};
const TIPOS_REPASSE = ['Repasse instrumentador', 'Repasse honorário', 'Espelho de pagamento', 'Demonstrativo de pagamento', 'Outro'];

// "Bradesco Saúde" -> "BRADESCO-SAUDE" (para nome de arquivo e pasta)
function slug(texto){
  return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}
const HORAS_SESSAO = 12;
const PASTA_LOCAL = path.join(__dirname, '..', 'dados-local');

// ---------------------------------------------------------------- banco

let dbPromise = null;
function conectar(){
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (url){
      const { neon } = require('@neondatabase/serverless');
      const sql = neon(url);
      return {
        query: (texto, params = []) => sql.query(texto, params),
        // Várias consultas numa transação só (tudo ou nada).
        transacao: (lista) => sql.transaction(lista.map(([texto, params]) => sql.query(texto, params || []))),
      };
    }
    const { PGlite } = await import('@electric-sql/pglite');
    fs.mkdirSync(PASTA_LOCAL, { recursive: true });
    const pg = new PGlite(path.join(PASTA_LOCAL, 'banco'));
    return {
      query: async (texto, params = []) => (await pg.query(texto, params)).rows,
      transacao: (lista) => pg.transaction(async tx => {
        const saida = [];
        for (const [texto, params] of lista) saida.push((await tx.query(texto, params || [])).rows);
        return saida;
      }),
    };
  })();
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

let esquemaPronto = null;
function prepararBanco(){
  if (esquemaPronto) return esquemaPronto;
  esquemaPronto = (async () => {
    const db = await conectar();
    // Prestador = médico/clínica cliente da Faturas Med. O nome é o mesmo da
    // pasta das planilhas em CONTROLE DE PAGAMENTO.
    await db.query(`CREATE TABLE IF NOT EXISTS prestadores (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL UNIQUE,
      ativo BOOLEAN NOT NULL DEFAULT true,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // perfil: 'faturas' (equipe, administra tudo) ou 'prestador' (só vê o seu).
    await db.query(`CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      login TEXT NOT NULL UNIQUE,
      nome TEXT NOT NULL,
      perfil TEXT NOT NULL CHECK (perfil IN ('faturas','prestador')),
      prestador_id INT REFERENCES prestadores(id),
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      ativo BOOLEAN NOT NULL DEFAULT true,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Guarda só o hash do token: quem ler o banco não consegue entrar.
    await db.query(`CREATE TABLE IF NOT EXISTS sessoes (
      token_hash TEXT PRIMARY KEY,
      usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      expira_em TIMESTAMPTZ NOT NULL
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS tentativas_login (
      login TEXT NOT NULL,
      quando TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Uma linha por procedimento da planilha CONTROLE. A sincronização troca
    // todas as linhas do prestador + planilha (fonte) de uma vez.
    // situacao: pago | glosado | parcial | aguardando (calculada dos valores).
    // fonte = convênio da planilha (pasta); convenio pode ser mais específico
    // (planilha BRADESCO -> BRADESCO SAÚDE / BRADESCO OPERADORA).
    await db.query(`CREATE TABLE IF NOT EXISTS producao (
      id BIGSERIAL PRIMARY KEY,
      prestador_id INT NOT NULL REFERENCES prestadores(id) ON DELETE CASCADE,
      fonte TEXT,
      convenio TEXT NOT NULL,
      operadora TEXT,
      competencia CHAR(7) NOT NULL,
      lote TEXT,
      data_lote DATE,
      tipo TEXT NOT NULL,
      tipo_original TEXT,
      paciente TEXT,
      guia TEXT,
      data DATE,
      grau TEXT,
      codigo TEXT,
      procedimento TEXT,
      qtd NUMERIC,
      faturado NUMERIC(14,2) NOT NULL DEFAULT 0,
      recebido NUMERIC(14,2),
      glosado NUMERIC(14,2),
      data_pagamento DATE,
      status TEXT,
      situacao TEXT NOT NULL,
      motivo_glosa TEXT,
      previsao_pagamento DATE
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS producao_por_mes ON producao (prestador_id, competencia)`);
    await db.query(`CREATE INDEX IF NOT EXISTS producao_por_fonte ON producao (prestador_id, fonte)`);
    await db.query(`CREATE INDEX IF NOT EXISTS producao_por_convenio ON producao (prestador_id, convenio)`);
    // Médico dentro do prestador (clínica com vários médicos: Azul, CAEM). NULL = sem médico.
    await db.query(`ALTER TABLE producao ADD COLUMN IF NOT EXISTS medico TEXT`);
    // Recurso de glosa (aba Lotes Bradesco, 24/11/2026): status/data do pagamento original da linha
    // baixada como recurso e o recursado/acatado da resposta do recurso (XML). Vazio nos outros prestadores.
    await db.query(`ALTER TABLE producao ADD COLUMN IF NOT EXISTS status_inicial TEXT`);
    await db.query(`ALTER TABLE producao ADD COLUMN IF NOT EXISTS data_pagamento_inicial DATE`);
    await db.query(`ALTER TABLE producao ADD COLUMN IF NOT EXISTS recurso_recursado NUMERIC(14,2)`);
    await db.query(`ALTER TABLE producao ADD COLUMN IF NOT EXISTS recurso_acatado NUMERIC(14,2)`);
    // Aba Recursos (Gustavo 26/11/2026): data do envio do recurso (planilha ou XML), protocolo do recurso (XML)
    // e a RESPOSTA DA OPERADORA da planilha.
    await db.query(`ALTER TABLE producao ADD COLUMN IF NOT EXISTS recurso_data DATE`);
    await db.query(`ALTER TABLE producao ADD COLUMN IF NOT EXISTS recurso_protocolo TEXT`);
    await db.query(`ALTER TABLE producao ADD COLUMN IF NOT EXISTS resposta_operadora TEXT`);
    await db.query(`CREATE TABLE IF NOT EXISTS sincronizacoes (
      prestador_id INT NOT NULL REFERENCES prestadores(id) ON DELETE CASCADE,
      convenio TEXT NOT NULL,
      linhas INT NOT NULL,
      arquivo TEXT,
      arquivo_modificado TIMESTAMPTZ,
      quando TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (prestador_id, convenio)
    )`);
    // Envio grande da sincronização chega em partes (limite de 4,5 MB por
    // requisição na Vercel); as partes ficam aqui até a última montar tudo.
    await db.query(`CREATE TABLE IF NOT EXISTS sync_partes (
      envio TEXT NOT NULL,
      parte INT NOT NULL,
      prestador_id INT NOT NULL REFERENCES prestadores(id) ON DELETE CASCADE,
      fonte TEXT NOT NULL,
      linhas JSONB NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (envio, parte)
    )`);
    // PDFs do prestador: protocolos de envio, documentos de repasse e espelhos/
    // demonstrativos de pagamento dos convênios (sync/importar_espelhos.py).
    // Excluir não apaga a linha (fica quem excluiu e quando), só o PDF.
    await db.query(`CREATE TABLE IF NOT EXISTS documentos (
      id SERIAL PRIMARY KEY,
      prestador_id INT NOT NULL REFERENCES prestadores(id),
      categoria TEXT NOT NULL CHECK (categoria IN ('protocolo','repasse','espelho')),
      convenio TEXT NOT NULL DEFAULT '',
      competencia CHAR(7) NOT NULL,
      numero TEXT NOT NULL DEFAULT '',
      data_envio DATE,
      previsao_pagamento DATE,
      tipo TEXT NOT NULL DEFAULT '',
      observacao TEXT NOT NULL DEFAULT '',
      nome_original TEXT NOT NULL,
      tamanho INT NOT NULL,
      chave TEXT,
      enviado_por INT REFERENCES usuarios(id),
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      excluido_em TIMESTAMPTZ,
      excluido_por INT REFERENCES usuarios(id)
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS documentos_por_prestador ON documentos (prestador_id, categoria, competencia)`);
    await db.query(`ALTER TABLE documentos ADD COLUMN IF NOT EXISTS medico TEXT NOT NULL DEFAULT ''`);
    // Banco criado antes de existir a categoria 'espelho' (23/11/2026): troca a regra uma vez só.
    const [regra] = await db.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'documentos_categoria_check'`);
    if (regra && !regra.def.includes('espelho')){
      await db.query(`ALTER TABLE documentos DROP CONSTRAINT documentos_categoria_check`);
      await db.query(`ALTER TABLE documentos ADD CONSTRAINT documentos_categoria_check CHECK (categoria IN ('protocolo','repasse','espelho'))`);
    }

    // Primeiro acesso da equipe: se ainda não existe ninguém da Faturas,
    // cria a conta com ADMIN_LOGIN / ADMIN_SENHA (variáveis de ambiente).
    const senhaAdmin = process.env.ADMIN_SENHA;
    if (senhaAdmin){
      const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM usuarios WHERE perfil = 'faturas'`);
      if (n === 0){
        const login = normalizarLogin(process.env.ADMIN_LOGIN || 'admin');
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = await hashSenha(senhaAdmin, salt);
        await db.query(
          `INSERT INTO usuarios (login, nome, perfil, salt, hash) VALUES ($1, $2, 'faturas', $3, $4)
           ON CONFLICT (login) DO NOTHING`,
          [login, process.env.ADMIN_NOME || 'Faturas Med', salt, hash]
        );
      }
    }
    return db;
  })();
  esquemaPronto.catch(() => { esquemaPronto = null; });
  return esquemaPronto;
}

// ---------------------------------------------------------------- senhas e sessão

function hashSenha(senha, salt){
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(senha), salt, 64, (err, chave) => err ? reject(err) : resolve(chave.toString('hex')));
  });
}

async function conferirSenha(senha, salt, hashGuardado){
  const a = Buffer.from(await hashSenha(senha, salt), 'hex');
  const b = Buffer.from(hashGuardado, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizarLogin(login){
  return String(login || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9._-]/g, '');
}

function hashToken(token){
  return crypto.createHash('sha256').update(token).digest('hex');
}

const COOKIE = 'ap_sessao';

function lerCookies(req){
  const saida = {};
  String(req.headers.cookie || '').split(';').forEach(par => {
    const i = par.indexOf('=');
    if (i > 0) saida[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  });
  return saida;
}

function ehHttps(req){
  return String(req.headers['x-forwarded-proto'] || '').includes('https');
}

async function abrirSessao(req, res, usuarioId){
  const db = await prepararBanco();
  const token = crypto.randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
    [hashToken(token), usuarioId, String(HORAS_SESSAO)]
  );
  // Aproveita para limpar sessões vencidas.
  await db.query(`DELETE FROM sessoes WHERE expira_em < now()`);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${HORAS_SESSAO * 3600}${ehHttps(req) ? '; Secure' : ''}`);
}

async function fecharSessao(req, res){
  const token = lerCookies(req)[COOKIE];
  if (token){
    const db = await prepararBanco();
    await db.query(`DELETE FROM sessoes WHERE token_hash = $1`, [hashToken(token)]);
  }
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${ehHttps(req) ? '; Secure' : ''}`);
}

async function usuarioDaSessao(req){
  const token = lerCookies(req)[COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const db = await prepararBanco();
  const linhas = await db.query(
    `SELECT u.id, u.login, u.nome, u.perfil, u.prestador_id, p.nome AS prestador_nome
       FROM sessoes s
       JOIN usuarios u ON u.id = s.usuario_id
       LEFT JOIN prestadores p ON p.id = u.prestador_id
      WHERE s.token_hash = $1 AND s.expira_em > now() AND u.ativo
        AND (u.perfil = 'faturas' OR (u.perfil = 'prestador' AND p.ativo))`,
    [hashToken(token)]
  );
  return linhas[0] || null;
}

// Devolve o usuário logado ou responde 401/403 e devolve null.
// perfil: um perfil ou lista de perfis aceitos.
async function exigirUsuario(req, res, perfil){
  const u = await usuarioDaSessao(req);
  if (!u){ responder(res, 401, { erro: 'Sua sessão terminou. Entre de novo.' }); return null; }
  const aceitos = perfil ? [].concat(perfil) : null;
  if (aceitos && !aceitos.includes(u.perfil)){ responder(res, 403, { erro: 'Este acesso não permite essa ação.' }); return null; }
  return u;
}

// ---------------------------------------------------------------- requisição / resposta

function parametros(req){
  return new URL(req.url, 'http://local').searchParams;
}

function lerCorpo(req, limite){
  // Na Vercel o corpo já vem lido em req.body (Buffer para
  // application/octet-stream, objeto para JSON, string para texto) e o
  // fluxo não pode mais ser lido. No PC (dev-server) req.body não existe.
  let pronto;
  try { pronto = req.body; } catch { pronto = undefined; }
  if (pronto !== undefined && pronto !== null){
    const buf = Buffer.isBuffer(pronto) ? pronto
      : typeof pronto === 'string' ? Buffer.from(pronto, 'utf8')
      : Buffer.from(JSON.stringify(pronto), 'utf8');
    if (buf.length > limite) return Promise.reject(Object.assign(new Error('grande'), { codigo: 'GRANDE' }));
    return Promise.resolve(buf);
  }
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    let estourou = false;
    req.on('data', parte => {
      if (estourou) return;
      total += parte.length;
      if (total > limite){ estourou = true; reject(Object.assign(new Error('grande'), { codigo: 'GRANDE' })); return; }
      partes.push(parte);
    });
    req.on('end', () => { if (!estourou) resolve(Buffer.concat(partes)); });
    req.on('error', reject);
  });
}

async function lerJson(req){
  try { if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body; } catch {}
  // A sincronização manda planilhas inteiras: o limite é maior que o dos formulários.
  const corpo = await lerCorpo(req, 20 * 1024 * 1024);
  if (!corpo.length) return {};
  try { return JSON.parse(corpo.toString('utf8')); } catch { return {}; }
}

function responder(res, status, dados){
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(dados));
}

// Envolve a rota: qualquer erro inesperado vira 500 com mensagem simples
// (o detalhe vai só para o log).
function rota(fn){
  return async (req, res) => {
    try { await fn(req, res); }
    catch (e){
      console.error(e);
      if (!res.headersSent) responder(res, 500, { erro: 'Algo deu errado no servidor. Tente de novo em instantes.' });
    }
  };
}

// ---------------------------------------------------------------- PDFs

const usaBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;

// Competência AAAA-MM válida?
const ehCompetencia = c => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(c || ''));

async function guardarPdf(chave, conteudo){
  if (usaBlob()){
    const { put } = require('@vercel/blob');
    const r = await put(chave, conteudo, { access: 'private', contentType: 'application/pdf', addRandomSuffix: true });
    return r.pathname;
  }
  const destino = path.join(PASTA_LOCAL, 'arquivos', chave);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, conteudo);
  return chave;
}

async function lerPdf(chave){
  if (usaBlob()){
    const { get } = require('@vercel/blob');
    const r = await get(chave, { access: 'private' });
    if (!r || r.statusCode !== 200) return null;
    return Buffer.from(await new Response(r.stream).arrayBuffer());
  }
  const origem = path.join(PASTA_LOCAL, 'arquivos', chave);
  return fs.existsSync(origem) ? fs.readFileSync(origem) : null;
}

// Confere se o PDF existe no armazenamento e devolve { size }.
async function infoPdf(chave){
  if (usaBlob()){
    const { head } = require('@vercel/blob');
    try { const r = await head(chave); return r ? { size: r.size } : null; }
    catch { return null; }
  }
  const origem = path.join(PASTA_LOCAL, 'arquivos', chave);
  return fs.existsSync(origem) ? { size: fs.statSync(origem).size } : null;
}

async function apagarPdfs(chaves){
  if (!chaves.length) return;
  if (usaBlob()){
    const { del } = require('@vercel/blob');
    await del(chaves);
    return;
  }
  for (const chave of chaves){
    try { fs.unlinkSync(path.join(PASTA_LOCAL, 'arquivos', chave)); } catch {}
  }
}

function ehPdf(conteudo){
  return conteudo.length > 5 && conteudo.subarray(0, 1024).includes(Buffer.from('%PDF-'));
}

// ---------------------------------------------------------------- dias úteis e previsão de pagamento

function pascoa(ano){
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(Date.UTC(ano, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1));
}

// Feriados nacionais + Carnaval (seg/ter), Sexta-feira Santa e Corpus Christi.
function feriados(ano){
  const iso = d => d.toISOString().slice(0, 10);
  const p = pascoa(ano), mais = n => iso(new Date(p.getTime() + n * 864e5));
  const fixos = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].map(x => `${ano}-${x}`);
  return new Set([...fixos, mais(-48), mais(-47), mais(-2), mais(60)]);
}

function ultimoDiaUtil(ano, mes){
  const fer = feriados(ano);
  for (let d = new Date(Date.UTC(ano, mes, 0)); ; d = new Date(d.getTime() - 864e5)){
    const dia = d.getUTCDay();
    if (dia !== 0 && dia !== 6 && !fer.has(d.toISOString().slice(0, 10))) return d.toISOString().slice(0, 10);
  }
}

function regraPrevisao(convenio){
  const c = String(convenio || '').toUpperCase();
  if (REGRAS_PREVISAO[c]) return REGRAS_PREVISAO[c];
  const chave = Object.keys(REGRAS_PREVISAO).find(k => c.startsWith(k + ' ') || c.startsWith(k + ' -'));
  return chave ? REGRAS_PREVISAO[chave] : null;
}

// Previsão sugerida (AAAA-MM-DD) ou null se o convênio não tem regra / faltam dados.
// tipo = tipo de guia do lote (CONSULTA, SADT, HONORÁRIO), usado nas regras por_tipo.
function sugerirPrevisao({ convenio, data_envio, competencia, tipo }){
  const r = regraPrevisao(convenio);
  if (!r) return null;
  if (r.tipo === 'dias_apos_envio'){
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data_envio || ''))) return null;
    const t = String(tipo || '').toUpperCase();
    const dias = r.por_tipo && r.por_tipo[t] != null ? r.por_tipo[t] : r.dias;
    return new Date(Date.parse(data_envio + 'T00:00:00Z') + dias * 864e5).toISOString().slice(0, 10);
  }
  if (r.tipo === 'dia_fixo_mes_seguinte'){
    if (!ehCompetencia(competencia)) return null;
    let ano = Number(competencia.slice(0, 4)), mes = Number(competencia.slice(5, 7)) + 1;
    if (mes === 13){ mes = 1; ano += 1; }
    return `${ano}-${String(mes).padStart(2, '0')}-${String(r.dia).padStart(2, '0')}`;
  }
  if (r.tipo === 'ultimo_dia_util_mes_seguinte'){
    if (!ehCompetencia(competencia)) return null;
    let ano = Number(competencia.slice(0, 4)), mes = Number(competencia.slice(5, 7)) + 1;
    if (mes === 13){ mes = 1; ano += 1; }
    return ultimoDiaUtil(ano, mes);
  }
  return null;
}

function hojeBrasil(){
  // en-CA formata como AAAA-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

module.exports = {
  LIMITE_PDF, LIMITE_PDF_DIRETO, CONVENIOS_PRESTADOR, TIPOS_REPASSE, slug, ehCompetencia, abasExtras, opcoesPrestador, PERSONALIZACAO,
  REGRAS_PREVISAO, sugerirPrevisao, ultimoDiaUtil,
  prepararBanco, hashSenha, conferirSenha, normalizarLogin,
  abrirSessao, fecharSessao, usuarioDaSessao, exigirUsuario,
  parametros, lerCorpo, lerJson, responder, rota,
  guardarPdf, lerPdf, infoPdf, apagarPdfs, ehPdf, hojeBrasil,
  uploadDireto: usaBlob,
};
