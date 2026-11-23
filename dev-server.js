// Servidor para testar no PC, sem Vercel: `node dev-server.js` e abrir
// http://localhost:3000. Usa o mesmo código das rotas da pasta api/.
// Sem DATABASE_URL / BLOB_READ_WRITE_TOKEN, grava tudo em dados-local/.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORTA = Number(process.env.PORT || 3000);
const RAIZ = __dirname;
if (!process.env.ADMIN_SENHA) process.env.ADMIN_SENHA = 'teste123'; // só para o teste local

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};
const ROTAS = ['auth', 'admin', 'upload', 'prestador', 'documentos', 'sync'];

http.createServer(async (req, res) => {
  const caminho = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  const api = caminho.match(/^\/api\/([a-z-]+)$/);
  if (api){
    if (!ROTAS.includes(api[1])){ res.statusCode = 404; return res.end('{}'); }
    return require(`./api/${api[1]}.js`)(req, res);
  }
  let arquivo = path.normalize(path.join(RAIZ, caminho === '/' ? 'index.html' : caminho));
  const publico = ['index.html', 'css', 'js', 'img'].some(p => arquivo.startsWith(path.join(RAIZ, p)));
  if (!publico || !fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()){ res.statusCode = 404; return res.end('Não encontrado'); }
  res.setHeader('Content-Type', TIPOS[path.extname(arquivo)] || 'application/octet-stream');
  fs.createReadStream(arquivo).pipe(res);
}).listen(PORTA, () => {
  console.log(`Área do Prestador em http://localhost:${PORTA}`);
  console.log(`Primeiro acesso da equipe: usuário "${process.env.ADMIN_LOGIN || 'admin'}" / senha definida em ADMIN_SENHA`);
});
