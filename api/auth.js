// Entrar, sair, quem está logado e troca da própria senha.
//   GET  /api/auth?acao=eu
//   POST /api/auth?acao=entrar   { login, senha, perfil: 'prestador' | 'faturas' }
//   POST /api/auth?acao=sair
//   POST /api/auth?acao=senha    { atual, nova }

const L = require('./_lib');

const MAX_TENTATIVAS = 8; // erros em 15 minutos antes de travar aquele login

// Confere login e senha. Devolve { u, login } ou { status, erro }.
async function conferirCredenciais(db, loginBruto, senhaBruta){
  const login = L.normalizarLogin(loginBruto);
  const senha = String(senhaBruta || '');
  if (!login || !senha) return { status: 400, erro: 'Preencha usuário e senha.' };
  const [{ n }] = await db.query(
    `SELECT count(*)::int AS n FROM tentativas_login WHERE login = $1 AND quando > now() - interval '15 minutes'`,
    [login]
  );
  if (n >= MAX_TENTATIVAS) return { status: 429, erro: 'Muitas tentativas com senha errada. Espere 15 minutos e tente de novo.' };
  const [u] = await db.query(
    `SELECT u.*, p.ativo AS prestador_ativo FROM usuarios u LEFT JOIN prestadores p ON p.id = u.prestador_id WHERE u.login = $1`,
    [login]
  );
  const senhaOk = u ? await L.conferirSenha(senha, u.salt, u.hash) : false;
  if (!senhaOk){
    await db.query(`INSERT INTO tentativas_login (login) VALUES ($1)`, [login]);
    return { status: 401, erro: 'Usuário ou senha incorretos.' };
  }
  if (!u.ativo || (u.perfil === 'prestador' && !u.prestador_ativo)){
    return { status: 403, erro: 'Este acesso está desativado. Fale com a Faturas Med.' };
  }
  return { u, login };
}

module.exports = L.rota(async (req, res) => {
  const acao = L.parametros(req).get('acao');
  const db = await L.prepararBanco();

  if (req.method === 'GET' && acao === 'eu'){
    return L.responder(res, 200, { usuario: await L.usuarioDaSessao(req), direto: L.uploadDireto() });
  }

  if (req.method !== 'POST') return L.responder(res, 405, { erro: 'Método não permitido.' });

  if (acao === 'entrar'){
    const corpo = await L.lerJson(req);
    const perfil = corpo.perfil === 'faturas' ? 'faturas' : 'prestador';
    const r = await conferirCredenciais(db, corpo.login, corpo.senha);
    if (!r.u) return L.responder(res, r.status, { erro: r.erro });
    if (r.u.perfil !== perfil){
      return L.responder(res, 409, {
        erro: r.u.perfil === 'faturas'
          ? 'Este usuário é da equipe FaturasMed. Escolha "FaturasMed" acima.'
          : 'Este usuário é de um prestador. Escolha "Prestador" acima.',
        perfilCerto: r.u.perfil,
      });
    }
    await db.query(`DELETE FROM tentativas_login WHERE login = $1 OR quando < now() - interval '1 day'`, [r.login]);
    await L.abrirSessao(req, res, r.u.id);
    return L.responder(res, 200, { usuario: await usuarioPorId(db, r.u.id), direto: L.uploadDireto() });
  }

  if (acao === 'sair'){
    await L.fecharSessao(req, res);
    return L.responder(res, 200, { ok: true });
  }

  if (acao === 'senha'){
    const u = await L.exigirUsuario(req, res);
    if (!u) return;
    const { atual, nova } = await L.lerJson(req);
    if (!nova || String(nova).length < 6) return L.responder(res, 400, { erro: 'A nova senha precisa ter pelo menos 6 caracteres.' });
    const [linha] = await db.query(`SELECT salt, hash FROM usuarios WHERE id = $1`, [u.id]);
    if (!(await L.conferirSenha(String(atual || ''), linha.salt, linha.hash))){
      return L.responder(res, 400, { erro: 'A senha atual não confere.' });
    }
    const salt = require('crypto').randomBytes(16).toString('hex');
    await db.query(`UPDATE usuarios SET salt = $1, hash = $2 WHERE id = $3`, [salt, await L.hashSenha(String(nova), salt), u.id]);
    return L.responder(res, 200, { ok: true });
  }

  return L.responder(res, 400, { erro: 'Ação desconhecida.' });
});

async function usuarioPorId(db, id){
  const [u] = await db.query(
    `SELECT u.id, u.login, u.nome, u.perfil, u.prestador_id, p.nome AS prestador_nome
       FROM usuarios u LEFT JOIN prestadores p ON p.id = u.prestador_id WHERE u.id = $1`,
    [id]
  );
  return u;
}
