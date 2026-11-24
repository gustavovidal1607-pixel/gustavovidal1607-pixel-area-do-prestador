// Prestadores e acessos — só a equipe Faturas Med.
//   GET  /api/admin?acao=dados
//   POST /api/admin?acao=prestador        { nome }
//   POST /api/admin?acao=prestador-editar { id, nome?, ativo? }
//   POST /api/admin?acao=usuario          { login, nome, perfil, prestador_id?, senha }
//   POST /api/admin?acao=usuario-editar   { id, nome?, ativo?, senha?, prestador_id? }

const crypto = require('crypto');
const L = require('./_lib');

module.exports = L.rota(async (req, res) => {
  const u = await L.exigirUsuario(req, res, 'faturas');
  if (!u) return;
  const db = await L.prepararBanco();
  const acao = L.parametros(req).get('acao');

  if (req.method === 'GET' && acao === 'dados'){
    const usuarios = await db.query(
      `SELECT u.id, u.login, u.nome, u.perfil, u.prestador_id, p.nome AS prestador_nome, u.ativo, u.criado_em
         FROM usuarios u LEFT JOIN prestadores p ON p.id = u.prestador_id
        ORDER BY u.ativo DESC, u.perfil, p.nome NULLS FIRST, u.nome`
    );
    const prestadores = await db.query(
      `SELECT p.id, p.nome, p.ativo,
              (SELECT count(*)::int FROM usuarios x WHERE x.prestador_id = p.id AND x.ativo) AS usuarios,
              (SELECT count(*)::int FROM producao r WHERE r.prestador_id = p.id) AS linhas,
              (SELECT count(*)::int FROM documentos d WHERE d.prestador_id = p.id AND d.excluido_em IS NULL) AS documentos,
              COALESCE((SELECT json_agg(json_build_object('convenio', s.convenio, 'linhas', s.linhas, 'quando', s.quando, 'arquivo_modificado', s.arquivo_modificado) ORDER BY s.convenio)
                          FROM sincronizacoes s WHERE s.prestador_id = p.id), '[]'::json) AS sincronizacoes,
              COALESCE((SELECT json_agg(DISTINCT r.medico) FROM producao r WHERE r.prestador_id = p.id AND r.medico IS NOT NULL), '[]'::json) AS medicos
         FROM prestadores p ORDER BY p.ativo DESC, p.nome`
    );
    prestadores.forEach(p => { p.abas_extras = L.abasExtras(p.nome); });
    return L.responder(res, 200, { prestadores, usuarios, eu: u.id, convenios_prestador: L.CONVENIOS_PRESTADOR, tipos_repasse: L.TIPOS_REPASSE });
  }

  if (req.method !== 'POST') return L.responder(res, 405, { erro: 'Método não permitido.' });
  const corpo = await L.lerJson(req);

  if (acao === 'prestador'){
    const nome = nomePrestador(corpo.nome);
    if (!nome) return L.responder(res, 400, { erro: 'Digite o nome do prestador.' });
    const [existe] = await db.query(`SELECT id FROM prestadores WHERE upper(nome) = $1`, [nome]);
    if (existe) return L.responder(res, 409, { erro: 'Já existe um prestador com esse nome.' });
    const [p] = await db.query(`INSERT INTO prestadores (nome) VALUES ($1) RETURNING id`, [nome]);
    return L.responder(res, 201, { ok: true, id: p.id });
  }

  if (acao === 'prestador-editar'){
    const id = Number(corpo.id);
    const [p] = await db.query(`SELECT * FROM prestadores WHERE id = $1`, [id]);
    if (!p) return L.responder(res, 404, { erro: 'Prestador não encontrado.' });
    const nome = corpo.nome !== undefined ? nomePrestador(corpo.nome) : p.nome;
    if (!nome) return L.responder(res, 400, { erro: 'Digite o nome do prestador.' });
    const [outro] = await db.query(`SELECT id FROM prestadores WHERE upper(nome) = $1 AND id <> $2`, [nome, id]);
    if (outro) return L.responder(res, 409, { erro: 'Já existe um prestador com esse nome.' });
    const ativo = corpo.ativo !== undefined ? !!corpo.ativo : p.ativo;
    await db.query(`UPDATE prestadores SET nome = $1, ativo = $2 WHERE id = $3`, [nome, ativo, id]);
    if (!ativo) await db.query(`DELETE FROM sessoes WHERE usuario_id IN (SELECT id FROM usuarios WHERE prestador_id = $1)`, [id]);
    return L.responder(res, 200, { ok: true });
  }

  if (acao === 'usuario'){
    const login = L.normalizarLogin(corpo.login);
    const nome = String(corpo.nome || '').trim().slice(0, 120);
    const perfil = corpo.perfil === 'faturas' ? 'faturas' : 'prestador';
    const senha = String(corpo.senha || '');
    if (!login || login.length < 3) return L.responder(res, 400, { erro: 'O usuário precisa de pelo menos 3 letras ou números (sem espaço).' });
    if (!nome) return L.responder(res, 400, { erro: 'Digite o nome da pessoa.' });
    if (senha.length < 6) return L.responder(res, 400, { erro: 'A senha precisa ter pelo menos 6 caracteres.' });
    let prestadorId = null;
    if (perfil === 'prestador'){
      prestadorId = Number(corpo.prestador_id);
      const [p] = await db.query(`SELECT id FROM prestadores WHERE id = $1 AND ativo`, [prestadorId]);
      if (!p) return L.responder(res, 400, { erro: 'Escolha o prestador desse acesso.' });
    }
    const [existe] = await db.query(`SELECT id FROM usuarios WHERE login = $1`, [login]);
    if (existe) return L.responder(res, 409, { erro: `O usuário "${login}" já existe. Escolha outro.` });
    const salt = crypto.randomBytes(16).toString('hex');
    await db.query(
      `INSERT INTO usuarios (login, nome, perfil, prestador_id, salt, hash) VALUES ($1, $2, $3, $4, $5, $6)`,
      [login, nome, perfil, prestadorId, salt, await L.hashSenha(senha, salt)]
    );
    return L.responder(res, 201, { ok: true, login });
  }

  if (acao === 'usuario-editar'){
    const id = Number(corpo.id);
    const [alvo] = await db.query(`SELECT * FROM usuarios WHERE id = $1`, [id]);
    if (!alvo) return L.responder(res, 404, { erro: 'Usuário não encontrado.' });
    if (corpo.ativo === false && alvo.id === u.id) return L.responder(res, 400, { erro: 'Você não pode desativar o seu próprio acesso.' });

    const nome = corpo.nome !== undefined ? String(corpo.nome).trim().slice(0, 120) : alvo.nome;
    if (!nome) return L.responder(res, 400, { erro: 'Digite o nome da pessoa.' });
    const novaSenha = corpo.senha !== undefined && corpo.senha !== '' ? String(corpo.senha) : null;
    if (novaSenha !== null && novaSenha.length < 6) return L.responder(res, 400, { erro: 'A senha precisa ter pelo menos 6 caracteres.' });
    const ativo = corpo.ativo !== undefined ? !!corpo.ativo : alvo.ativo;
    let prestadorId = alvo.prestador_id;
    if (alvo.perfil === 'prestador' && corpo.prestador_id !== undefined){
      prestadorId = Number(corpo.prestador_id);
      const [p] = await db.query(`SELECT id FROM prestadores WHERE id = $1`, [prestadorId]);
      if (!p) return L.responder(res, 400, { erro: 'Prestador não encontrado.' });
    }
    await db.query(`UPDATE usuarios SET nome = $1, ativo = $2, prestador_id = $3 WHERE id = $4`, [nome, ativo, prestadorId, id]);

    if (novaSenha !== null){
      const salt = crypto.randomBytes(16).toString('hex');
      await db.query(`UPDATE usuarios SET salt = $1, hash = $2 WHERE id = $3`, [salt, await L.hashSenha(novaSenha, salt), id]);
      await db.query(`DELETE FROM tentativas_login WHERE login = $1`, [alvo.login]);
    }
    // Senha trocada, desativado ou mudou de prestador: derruba as sessões abertas.
    if (!ativo || prestadorId !== alvo.prestador_id || (novaSenha !== null && id !== u.id)){
      await db.query(`DELETE FROM sessoes WHERE usuario_id = $1`, [id]);
    }
    return L.responder(res, 200, { ok: true });
  }

  return L.responder(res, 400, { erro: 'Ação desconhecida.' });
});

// Nome do prestador como nas pastas das planilhas: maiúsculas, um espaço.
function nomePrestador(v){
  return String(v || '').trim().replace(/\s+/g, ' ').toUpperCase().slice(0, 120);
}
