# Área do Prestador · Faturas Med

Sistema **separado** do Envio de Guias: cada prestador cliente da Faturas Med (médico ou clínica) entra com login e senha próprios e acompanha **só o próprio** faturamento. A equipe Faturas Med administra prestadores, acessos, protocolos e repasses.

Entrada: pelo site institucional, **Acessar sistema → Área do Prestador**, que abre este sistema (tela de login própria).

## Perfis

**Equipe (FaturasMed)**
- **Prestadores** — cadastro (o nome tem que ser igual ao da pasta em `\\faturasmed\Documents\CONTROLE DE PAGAMENTO\<CONVÊNIO>\<PRESTADOR>`), situação da sincronização por convênio, envio de **protocolos** (convênio, competência, número, data de envio, previsão de pagamento, observação) e **documentos de repasse** (competência, tipo, observação), listar/editar/excluir (exclusão lógica: o registro fica marcado, o PDF é apagado).
- **Acessos** — criar, redefinir senha e desativar usuários da equipe e dos prestadores; ao criar, mostra login, senha e link para copiar.

**Prestador** (vê só o que é dele; pela API outro prestador recebe 403/404)
- **Painel** — filtros de competência e convênio; Faturado, Recebido, Glosado, A receber e % de glosa; gráfico mês a mês; tabela por convênio. Sem lista de próximos pagamentos.
- **Faturas** — lotes da competência com as guias (paciente, guia, data, código, procedimento, faturado, recebido, glosado, situação, motivo da glosa). Lote ainda não pago mostra a previsão de pagamento.
- **Protocolos** e **Repasses** — PDFs para abrir/baixar (sempre pelo servidor, nunca link público).
- **Gerar resumo** — um PDF só, `RESUMO <MM-AAAA> - <PRESTADOR>.pdf`: página 1 com logo, prestador e competência, faturado por convênio → tipo de guia (quantidade e valor, subtotal por convênio, total geral); depois os PDFs de todos os protocolos da competência (ordem convênio → data). Sem lista de protocolos, sem previsão, sem notas de método. Montado no navegador com pdf-lib (`js/vendor/pdf-lib.min.js`).

## De onde vêm os números

`sync/sincronizar.py` (Python 3 + `openpyxl`) procura `\\faturasmed\Documents\CONTROLE DE PAGAMENTO\<CONVÊNIO>\<PRESTADOR>\<PRESTADOR> - <CONVÊNIO>.xlsx`, **copia** cada planilha para uma pasta temporária (o original nunca é aberto), lê a aba `CONTROLE` (Petrobras: `Plan1`), localiza cada coluna **pelo nome do cabeçalho** (Unimed usa nomes longos) e manda um convênio por vez para `/api/sync`. Cada envio substitui todas as linhas daquele prestador + convênio, numa transação.

```
python sync/sincronizar.py --url http://localhost:3000 --token teste                 # local
python sync/sincronizar.py --url https://<sistema> --login <usuario.da.equipe>      # produção (senha: FATURAS_SYNC_SENHA ou pergunta)
python sync/sincronizar.py --json saida.json                                         # só gera o JSON
python sync/sincronizar.py --prestador "RENAN BRITO" --url ... --login ...           # um prestador
```
Os prestadores sincronizados ficam na lista `PRESTADORES` no começo do script. A senha nunca fica em arquivo. Para rodar todo dia, agendar no Agendador de Tarefas do Windows num PC com acesso a `\\faturasmed`.

Regras aplicadas:
- **Competência** = fechamento/envio do lote. **Unimed**: mês de envio. Outros: dentro do mês, se há um grupo de envios no começo (terminando até o dia 15), uma pausa ≥ 7 dias e depois outros envios, o primeiro grupo é da competência anterior; sem pausa assim, envio até o **5º dia útil** é da competência anterior. Sem data do lote: coluna COMP. `--detalhe` mostra as datas e a competência de cada grupo.
- **Bradesco** separado: carteirinha começando com **954** = BRADESCO OPERADORA, o resto = BRADESCO SAÚDE; sem carteirinha, lote 341 = Operadora, 340 = Saúde.
- **Unimed com glosa negativa** (pagou mais que o faturado): não conta como glosa; o recebido é o real.
- **Tipo de guia**: CONSULTA → Consulta; SADT e SP/SADT → SADT; GIH/HONORÁRIO → Honorário (GIH). Guias = números de guia distintos.
- **Situação** da linha: sem recebido e sem glosa = aguardando; recebido e glosa = parcial; só glosa = glosado; resto = pago. **A receber** = faturado das linhas aguardando; **% glosa** = glosado ÷ faturado.
- **Previsão de pagamento** (aparece em Faturas e Protocolos; não no painel nem no resumo): prioridade protocolo cadastrado pela equipe → coluna da planilha → regra do convênio. Regras em `REGRAS_PREVISAO` (`api/_lib.js`): Bradesco Saúde = envio + 60 dias; Bradesco Operadora = envio + 65; Unimed = último dia útil do mês seguinte à competência; Petrobras, SulAmérica e outros ainda sem regra (fica vazio para a equipe preencher).

## Tecnologia

HTML/CSS/JS puro sem build; `api/*.js` como funções serverless da Vercel; banco Neon (`@neondatabase/serverless`, tabelas criadas no primeiro acesso); PDFs no Vercel Blob **privado** (download pela API, que confere a sessão); sessão por cookie HttpOnly; senha com scrypt + sal; bloqueio de 15 min após 8 senhas erradas. Celular: abaixo de 720 px tudo em uma coluna, tabelas viram cartões, botões ≥ 44 px.

Em produção o PDF vai do navegador **direto para o Blob** (`js/vendor/blob-client.js`, token emitido por `api/upload.js`, só equipe, caminho `prestador-<id>/...`) e depois é registrado em `/api/documentos?acao=registrar`. No modo local passa pelo servidor.

## Rodar no PC

```
npm install
node dev-server.js
```
Abre em http://localhost:3000. Sem variáveis usa um banco embutido (PGlite) e grava os PDFs em `dados-local/`. Primeiro acesso da equipe: `admin` / `teste123` (só local). Depois: **Prestadores** → cadastrar → **Acessos** → novo acesso com perfil Prestador → `python sync/sincronizar.py --url http://localhost:3000 --token teste`.

## Colocar no ar (Vercel + Neon + Blob)

1. Importar o repositório na Vercel (framework *Other*).
2. Storage → **Blob store Private** ligado ao projeto (cria `BLOB_READ_WRITE_TOKEN`).
3. Banco no Neon → `DATABASE_URL`.
4. `ADMIN_LOGIN`, `ADMIN_NOME`, `ADMIN_SENHA` (ver `.env.example`). `SYNC_TOKEN` é opcional.
5. Deploy. Entrar como FaturasMed → Prestadores → cadastrar → Acessos → criar o login do prestador.

## Estrutura

- `api/_lib.js` — banco, PDFs, sessão, utilitários, regras de previsão.
- `api/auth.js` — entrar/sair/quem sou/trocar senha.
- `api/admin.js` — prestadores e acessos (só equipe).
- `api/prestador.js` — painel, faturas e resumo (o prestador só vê o próprio cadastro).
- `api/documentos.js` — protocolos e repasses (PDF privado; envio e exclusão só pela equipe).
- `api/upload.js` — token de envio direto para o Blob (só equipe).
- `api/sync.js` — recebe as planilhas de controle.
- `sync/sincronizar.py` — lê as planilhas e manda para `/api/sync`.
- `index.html`, `css/app.css`, `js/app.js` (núcleo), `js/prestador.js` (telas do prestador e aba Prestadores), `js/vendor/`.
- `dev-server.js` — servidor local de teste.
