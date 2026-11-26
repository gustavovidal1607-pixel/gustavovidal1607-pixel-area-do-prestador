# Área do Prestador · Faturas Med

Sistema **separado** do Envio de Guias: cada prestador cliente da Faturas Med (médico ou clínica) entra com login e senha próprios e acompanha **só o próprio** faturamento. A equipe Faturas Med administra prestadores, acessos, protocolos e repasses.

Entrada: pelo site institucional, **Acessar sistema → Área do Prestador**, que abre este sistema (tela de login própria).

## Perfis

**Equipe (FaturasMed)**
- **Prestadores** — cadastro (o nome tem que ser igual ao da pasta em `\\faturasmed\Documents\CONTROLE DE PAGAMENTO\<CONVÊNIO>\<PRESTADOR>`), situação da sincronização por convênio, envio de **protocolos** (convênio, competência, número, data de envio, previsão de pagamento, observação) e **documentos de repasse** (competência, tipo, observação), listar/editar/excluir (exclusão lógica: o registro fica marcado, o PDF é apagado).
- **Acessos** — criar, redefinir senha e desativar usuários da equipe e dos prestadores; ao criar, mostra login, senha e link para copiar.

**Prestador** (vê só o que é dele; pela API outro prestador recebe 403/404)
- **Painel** — filtros de competência e convênio; Faturado, Recebido, Glosado, A receber e % de glosa; gráfico mês a mês; tabela por convênio. Sem lista de próximos pagamentos.
- **Faturas** — lotes da competência; cada lote aparece **fechado** com o faturado, o pago, o glosado (se houver) e o aguardando pagamento, e abre ao clicar mostrando as guias (paciente, guia, data, código, procedimento, faturado, recebido, glosado, situação, motivo da glosa); com busca de paciente/guia os lotes abrem sozinhos (Gustavo 26/11). Lote ainda não pago mostra a previsão de pagamento. Linha com STATUS **ATENÇÃO** na planilha aparece como **"Glosado - Em análise para recurso"** (filtro "Em análise p/ recurso"); nas contas continua glosado. A coluna Situação mostra o **histórico da guia** (Gustavo 26/11): selo com a situação atual (Pago, Glosado, Acatado, Em análise para recurso, Recurso em análise / negado / recebido / aceito em parte) e as etapas com as datas que existirem: pago (valor e data), glosado (valor, data e motivo), recursado (valor, data e protocolo), resposta (recebido com valor e data, negado com data, resposta do convênio). Mesmas regras da aba Recursos. Lote em que a única glosa foi acatada: selo "Pago (glosa acatada)".
- **Recursos** (aba, todos os prestadores — Gustavo 26/11, pedido da INTEGRADA INFANTIL) — cartões com recursado, recurso recebido, recurso negado, recurso em análise, glosas em análise para recurso (STATUS ATENÇÃO) e glosas acatadas (STATUS ACATADO); lista dos recursos realizados (convênio + **data do envio** + lote, fechado com os totais, abre com as guias, o motivo da glosa e a resposta do convênio), filtros de convênio e situação. Data do recurso: "RECURSADO DIA dd/mm/aa(aa)" do STATUS ou do STATUS INICIAL; sem isso, a `<dataRecurso>` do XML de resposta (prestadores de `RECURSOS_XML`: PATHOLOGY e INTEGRADA INFANTIL). Recebido = acatado do XML (sem XML, o recebido da linha); negado = glosado que sobrou na linha respondida. Contas em `api/_lotes.js` (`montarRecursos`). A equipe abre pelo botão "Recursos" do prestador.
- **Protocolos**, **Espelhos de pagamento** e **Repasses** — PDFs para abrir/baixar (sempre pelo servidor, nunca link público). Espelhos = espelhos/demonstrativos de pagamento dos convênios (categoria `espelho`), agrupados pela competência do pagamento, com filtro de competência, convênio e executante; a equipe vê em Prestadores → Documentos enviados (filtro "Espelhos de pagamento").
- **Resumo** (aba) — folha única da competência: para cada convênio e tipo de lote, **Guias, Faturado, Recebido, Glosado, A receber, % glosa** (mesmas contas do painel; subtotal por convênio e total batem com o painel) e **Situação** ("Pago em dd/mm/aaaa"; "Aguardando pagamento dia dd/mm/aaaa"; Bradesco "… até dd/mm/aaaa"; parte paga e parte aguardando = "Pago em dd/mm · resto aguardando …"; sem previsão = "(sem data)"; o mesmo texto aparece no cabeçalho de cada lote em Faturas), e "Por médico" (mesmas colunas) nas clínicas com médicos. **Baixar PDF** = só a folha (A4 deitada, para caberem as colunas); **Baixar com as capas** = folha + PDFs dos protocolos da competência que a equipe anexou em Protocolos (ordem convênio → data). Sem protocolo anexado, avisa. Montado no navegador com pdf-lib (`js/vendor/pdf-lib.min.js`). A equipe abre o mesmo resumo pelo botão Resumo do prestador.

**Aba exclusiva "Lotes Bradesco"** (só a PATHOLOGY — `ABAS_EXCLUSIVAS` em `api/_lib.js`; a equipe abre pelo botão "Lotes Bradesco" do prestador; para os outros a aba não aparece e `/api/prestador?acao=lotes` dá 404) — lotes do Bradesco Saúde e Operadora do ano (pela data de envio), com cara de planilha: faturado, cada pagamento picado com a data, glosa, aguardando, recurso em análise, acatado, recurso recebido (valor + data), recurso negado, situação e observação; totais no topo e no rodapé; filtros de convênio, mês de envio e situação; Excel (.xlsx) e PDF (logo à esquerda, "Gustavo Vidal / Coordenador / data" à direita). Contas em `api/_lotes.js`: linha baixada como recurso (STATUS INICIAL = RECURSADO) tem no recebido o original + o acatado — o original vai para a DATA DO PAGAMENTO INICIAL e o acatado (resposta do recurso em XML, `Demonstrativos\Recursos`, lida pelo sync só para os prestadores de `RECURSOS_XML`) para a DATA PAGAMENTO; o glosado que sobra é **recurso negado**, nunca glosa. Por lote: faturado = recebido + glosa + aguardando + recurso em análise + recurso recebido + recurso a receber + recurso negado.

## De onde vêm os números

`sync/sincronizar.py` (Python 3 + `openpyxl`) procura `\\faturasmed\Documents\CONTROLE DE PAGAMENTO\<CONVÊNIO>\<PRESTADOR>\<PRESTADOR> - <CONVÊNIO>.xlsx`, **copia** cada planilha para uma pasta temporária (o original nunca é aberto), lê a aba `CONTROLE` (Petrobras: `Plan1`), localiza cada coluna **pelo nome do cabeçalho** (Unimed usa nomes longos) e manda um convênio por vez para `/api/sync`. Cada envio substitui todas as linhas daquele prestador + convênio, numa transação. Célula com **fórmula sem valor calculado** (planilha salva pelo openpyxl dos robôs perde o cache: ex. VALOR RECEBIDO `=N193`) é calculada pelo sync quando é simples (referências de célula, números, + - * / e parênteses); fórmula complexa fica vazia e sai aviso no log (Gustavo 26/11).

```
python sync/sincronizar.py --url http://localhost:3000 --token teste                 # local
python sync/sincronizar.py --url https://<sistema> --login <usuario.da.equipe>      # produção (senha: FATURAS_SYNC_SENHA ou pergunta)
python sync/sincronizar.py --json saida.json                                         # só gera o JSON
python sync/sincronizar.py --prestador "RENAN BRITO" --url ... --login ...           # um prestador
```
Os prestadores sincronizados ficam na lista `PRESTADORES` no começo do script.

`sync/importar_capas.py` anexa como **protocolos** os PDFs de capa que os robôs de faturamento salvam em `Z:\FATURAMENTO\<CONVÊNIO>\<mês>\` (Bradesco `… - <protocolo> - CAPA.pdf`, Petrobras `… - LOTE n …` com o número do protocolo lido de dentro do PDF, SulAmérica `… - GRD n - dd.mm.aa.pdf`, Amil `<PRESTADOR>.pdf` com a lista de protocolos). Mesmo prestador + número não entra duas vezes; roda todo dia depois da sincronização (mesmo .bat). A competência do protocolo segue a do lote na planilha (coluna COMP), não a pasta do mês. Unimed ainda não. A senha nunca fica em arquivo. Para rodar todo dia, agendar no Agendador de Tarefas do Windows num PC com acesso a `\\faturasmed`.

`sync/importar_espelhos.py` anexa como **espelhos de pagamento** os PDFs de `\\faturasmed\Documents\CONTROLE DE PAGAMENTO\<CONVÊNIO>\<PASTA>\`: Unimed `ESPELHO DE PAGAMENTO\Analitico|ESBOÇO DE NOTA FISCAL\MM-AAAA … SEQ n.pdf` (o Sintético não entra — Willian 23/11); Bradesco `Demonstrativos\Processados\SAUDE|OPERADORA_DEMOSTRATIVO_…_AAAA-MM-Qn.pdf` (competência pela "Data do pagamento" do PDF; `Recursos` = demonstrativo de recurso de glosa, fica fora); Mediservice `Demonstrativo de Pagamento\DEMONSTRATIVO MM-AAAA - PAGO dd-mm-aaaa.pdf`; SulAmérica `Demonstrativos\Novos\AAAA-MM-DD pagamento\DEMONSTRATIVO DE PAGAMENTO ….pdf` (a Análise de conta não entra — Willian 24/11). Petrobras ainda não tem PDF (só planilhas). Competência = a do pagamento, desde 07/2026 (`--desde`). Pastas de `PASTAS_EXTRAS` vão para o prestador principal com o executante; pasta que não é prestador cadastrado é ignorada. Mesmo prestador + mesmo nome não entra duas vezes (nem o que a equipe excluiu); roda todo dia no mesmo .bat. `--so-listar` mostra o que faria e o total em MB, sem login.

Regras aplicadas:
- **Competência** = coluna **COMP** da planilha quando preenchida (decisão do Gustavo em 23/11/2026: ele mantém as competências à mão; `PLANILHA_MANDA` no script). Linha sem COMP: fechamento/envio do lote. **Unimed**: mês de envio. Outros: dentro do mês, se há um grupo de envios no começo (terminando até o dia 15), uma pausa ≥ 7 dias e depois outros envios, o primeiro grupo é da competência anterior; sem pausa assim, envio até o **5º dia útil** é da competência anterior. Sem data do lote: coluna COMP. `--detalhe` mostra as datas e a competência de cada grupo.
- **Bradesco** separado: carteirinha começando com **954** = BRADESCO OPERADORA, o resto = BRADESCO SAÚDE; sem carteirinha, lote 341 = Operadora, 340 = Saúde.
- **Unimed com glosa negativa** (pagou mais que o faturado): não conta como glosa; o recebido é o real.
- **Tipo de guia**: CONSULTA → Consulta; SADT e SP/SADT → SADT; GIH/HONORÁRIO → Honorário (GIH). Guias = números de guia distintos.
- **Situação** da linha: sem recebido e sem glosa = aguardando; recebido e glosa = parcial; só glosa = glosado; resto = pago. **A receber** = faturado das linhas aguardando; **% glosa** = glosado ÷ faturado.
- **Previsão de pagamento** (usada na Situação do resumo, em Faturas e em Protocolos): prioridade protocolo cadastrado pela equipe → coluna da planilha → regra do convênio. Regras em `REGRAS_PREVISAO` (`api/_lib.js`), contadas da data do lote (fechamento/envio): **Bradesco Saúde** consulta +10 dias, SADT +45, honorário +30; **Bradesco Operadora** consulta +30, honorário +45, SADT +55 (outro tipo: +60 Saúde / +65 Operadora); Unimed e Petrobras = último dia útil do mês seguinte à competência; Mediservice = dia 28 do mês seguinte; SulAmérica e outros ainda sem regra (fica vazio para a equipe preencher). A previsão da regra é gravada na sincronização (rodar de novo depois de mudar a regra). No envio de protocolo a sugestão usa o tipo do lote com aquele número; sem lote conhecido, a regra antiga.

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
