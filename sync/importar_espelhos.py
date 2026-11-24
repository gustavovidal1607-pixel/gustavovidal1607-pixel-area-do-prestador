#!/usr/bin/env python3
"""Importa os ESPELHOS / DEMONSTRATIVOS DE PAGAMENTO para a Área do Prestador.

Fonte: \\\\faturasmed\\Documents\\CONTROLE DE PAGAMENTO\\<CONVÊNIO>\\<PASTA DO PRESTADOR>\\...
(só PDF). Cada PDF vira um documento da categoria "espelho" (aba "Espelhos de
pagamento" do portal). A competência é a do PAGAMENTO. Espelho já anexado
(mesmo prestador + mesmo nome visível, mesmo que a equipe tenha excluído) não
entra de novo, então pode rodar todo dia (sync\\local\\sincronizar.bat).

Padrões que entende (23/11/2026):
  UNIMED\\<P>\\ESPELHO DE PAGAMENTO\\Analitico\\MM-AAAA SEQ n.pdf      (também "MM-AA <nome> Seq n.pdf")
  (UNIMED ...\\Sintetico NÃO entra no portal — Willian 23/11)
  UNIMED\\<P>\\ESPELHO DE PAGAMENTO\\ESBOÇO DE NOTA FISCAL\\MM-AAAA ESBOÇO DE NOTA FISCAL SEQ n.pdf
      (Novos/Processados são pastas de passagem dos robôs: ignoradas)
  BRADESCO\\<P>\\Demonstrativos\\Processados\\SAUDE|OPERADORA_DEMOSTRATIVO_<cód>_AAAA-MM-Qn.pdf
      data do pagamento = "Data do pagamento" dentro do PDF (vale ela para a competência)
      (Demonstrativos\\Recursos = demonstrativo de RECURSO DE GLOSA: não é pagamento, ignorado)
  MEDISERVICE\\<P>\\Demonstrativo de Pagamento\\DEMONSTRATIVO MM-AAAA - PAGO dd-mm-aaaa[ e dd-mm-aaaa].pdf
  SULAMÉRICA\\<P>\\Demonstrativos\\Novos\\AAAA-MM-DD pagamento\\DEMONSTRATIVO DE PAGAMENTO - dd.mm.aa[ (n)].pdf
      (ANALISE DE CONTA - dd.mm.aa.pdf NÃO entra no portal — Willian 24/11)
  Petrobras, Amil, Cassi e outros: ainda não têm PDF de demonstrativo nas pastas.

Prestador = nome da pasta (PRESTADORES do sincronizar.py); as pastas de
PASTAS_EXTRAS vão para o prestador principal marcadas com o médico/executante.
Pasta que não é prestador cadastrado (ex-cliente) é ignorada.

Uso:
  python sync/importar_espelhos.py --so-listar [--desde 2026-07]        (não precisa de login; mostra o que faria e o total em MB)
  python sync/importar_espelhos.py --url https://<portal> --login <usuario.equipe>   (senha: FATURAS_SYNC_SENHA)
  python sync/importar_espelhos.py --prestador "CENTRUS" --url ... --login ...
Variáveis: PORTAL_URL, FATURAS_SYNC_LOGIN, FATURAS_SYNC_SENHA, ESPELHOS_PASTA, ESPELHOS_DESDE (padrão 2026-07).
Requer: pypdf (só para ler a data do pagamento do Bradesco).
"""

import argparse
import collections
import getpass
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sincronizar import PRESTADORES, PASTAS_EXTRAS  # noqa: E402
from importar_capas import Portal, sem_acento, texto_pdf, data_br, LIMITE_PDF  # noqa: E402

PASTA_BASE = os.environ.get("ESPELHOS_PASTA", "//faturasmed/Documents/CONTROLE DE PAGAMENTO")
DESDE = os.environ.get("ESPELHOS_DESDE", "2026-07")

NOME_CONVENIO = {"UNIMED": "Unimed", "BRADESCO SAÚDE": "Bradesco Saúde", "BRADESCO OPERADORA": "Bradesco Operadora",
                 "MEDISERVICE": "Mediservice", "SULAMÉRICA": "SulAmérica"}


def subpasta(base, *nomes):
    """Acha a subpasta ignorando maiúsculas/acentos (Analitico x ANALITICO)."""
    atual = base
    for nome in nomes:
        if not os.path.isdir(atual):
            return None
        alvo = sem_acento(nome)
        achou = next((d for d in os.listdir(atual) if sem_acento(d) == alvo and os.path.isdir(os.path.join(atual, d))), None)
        if not achou:
            return None
        atual = os.path.join(atual, achou)
    return atual


def pdfs(pasta):
    if not pasta or not os.path.isdir(pasta):
        return []
    return sorted(f for f in os.listdir(pasta) if f.lower().endswith(".pdf"))


def comp_br(c):
    return f"{c[5:7]}/{c[:4]}"


def data_txt(iso):
    return f"{iso[8:10]}/{iso[5:7]}/{iso[:4]}" if iso else ""


def pastas_convenio(base, convenio):
    p = os.path.join(base, convenio)
    if not os.path.isdir(p):
        return []
    return sorted(d for d in os.listdir(p) if os.path.isdir(os.path.join(p, d)))


# ---------------------------------------------------------------- leitura das pastas

# Willian 23/11: só Analítico e Esboço de nota fiscal; o Sintético NÃO entra no portal.
TIPOS_UNIMED = [("Analitico", "Analítico"), ("ESBOÇO DE NOTA FISCAL", "Esboço de nota fiscal")]


def espelhos_unimed(base):
    for pasta in pastas_convenio(base, "UNIMED"):
        raiz = os.path.join(base, "UNIMED", pasta)
        for sub, tipo in TIPOS_UNIMED:
            p = subpasta(raiz, "ESPELHO DE PAGAMENTO", sub)
            for nome in pdfs(p):
                m = re.match(r"(\d{2})-(\d{2}|\d{4})\b.*?\bSEQ\s*(\d+)", nome, re.I)
                if not m:
                    print(f"  ? UNIMED/{pasta}/{sub}/{nome}: sem MM-AAAA ... SEQ n no nome, pulei")
                    continue
                ano = m.group(2) if len(m.group(2)) == 4 else "20" + m.group(2)
                yield {"convenio": "UNIMED", "pasta": pasta, "competencia": f"{ano}-{m.group(1)}", "tipo": tipo,
                       "numero": f"Seq {int(m.group(3))}", "data": None, "caminho": os.path.join(p, nome),
                       "origem": f"UNIMED/{pasta}/{sub}/{nome}"}


def espelhos_bradesco(base, ler_pdf=True):
    for pasta in pastas_convenio(base, "BRADESCO"):
        p = subpasta(os.path.join(base, "BRADESCO", pasta), "Demonstrativos", "Processados")
        for nome in pdfs(p):
            m = re.match(r"(SAUDE|OPERADORA)_DEMO[N]?STRATIVO_(\d+)_(\d{4})-(\d{2})-Q(\d)", nome, re.I)
            if not m:
                print(f"  ? BRADESCO/{pasta}/{nome}: nome fora do padrão, pulei")
                continue
            caminho = os.path.join(p, nome)
            comp = f"{m.group(3)}-{m.group(4)}"
            yield {"convenio": "BRADESCO SAÚDE" if m.group(1).upper() == "SAUDE" else "BRADESCO OPERADORA", "pasta": pasta,
                   "competencia": comp, "tipo": "Demonstrativo de pagamento", "numero": f"{m.group(5)}ª quinzena",
                   "data": None, "ler_data": ler_pdf, "caminho": caminho, "origem": f"BRADESCO/{pasta}/{nome}"}


def data_pagamento_bradesco(c):
    """Data do pagamento escrita no PDF; vale ela para a competência (o nome pode ser do processamento)."""
    d = data_br((re.search(r"Data do pagamento\s*(\d{2}/\d{2}/\d{4})", texto_pdf(c["caminho"])) or [None, ""])[1])
    if d:
        c["data"] = d
        c["competencia"] = d[:7]


def espelhos_mediservice(base):
    for pasta in pastas_convenio(base, "MEDISERVICE"):
        p = subpasta(os.path.join(base, "MEDISERVICE", pasta), "Demonstrativo de Pagamento")
        for nome in pdfs(p):
            m = re.match(r"DEMONSTRATIVO (\d{2})-(\d{4})(?:.*?PAGO (\d{2})-(\d{2})-(\d{4}))?", nome, re.I)
            if not m:
                print(f"  ? MEDISERVICE/{pasta}/{nome}: nome fora do padrão, pulei")
                continue
            datas = re.findall(r"(\d{2})-(\d{2})-(\d{4})", nome)
            yield {"convenio": "MEDISERVICE", "pasta": pasta, "competencia": f"{m.group(2)}-{m.group(1)}",
                   "tipo": "Demonstrativo de pagamento", "numero": "",
                   "data": f"{datas[0][2]}-{datas[0][1]}-{datas[0][0]}" if datas else None,
                   "datas_extra": [f"{d}/{mm}/{a}" for d, mm, a in datas[1:]],
                   "caminho": os.path.join(p, nome), "origem": f"MEDISERVICE/{pasta}/{nome}"}


def espelhos_sulamerica(base):
    for pasta in pastas_convenio(base, "SULAMÉRICA"):
        dem = subpasta(os.path.join(base, "SULAMÉRICA", pasta), "Demonstrativos")
        if not dem:
            continue
        # As pastas "AAAA-MM-DD pagamento" ficam em Novos (e, se um dia mudar, em Processados ou na raiz).
        for onde in ("", "Novos", "Processados"):
            p0 = subpasta(dem, onde) if onde else dem
            if not p0:
                continue
            for sub in sorted(os.listdir(p0)):
                md = re.match(r"(\d{4})-(\d{2})-(\d{2}) pagamento", sub, re.I)
                if not md or not os.path.isdir(os.path.join(p0, sub)):
                    continue
                data = f"{md.group(1)}-{md.group(2)}-{md.group(3)}"
                for nome in pdfs(os.path.join(p0, sub)):
                    u = sem_acento(nome)
                    if u.startswith("DEMONSTRATIVO DE PAGAMENTO"):
                        tipo = "Demonstrativo de pagamento"
                    elif u.startswith("ANALISE DE CONTA"):
                        continue  # Willian 24/11: Análise de conta NÃO entra no portal
                    else:
                        print(f"  ? SULAMÉRICA/{pasta}/{sub}/{nome}: não é demonstrativo, pulei")
                        continue
                    extra = re.search(r"\((\d+)\)\s*\.pdf$", nome, re.I)
                    yield {"convenio": "SULAMÉRICA", "pasta": pasta, "competencia": data[:7], "tipo": tipo,
                           "numero": f"parte {extra.group(1)}" if extra else "", "data": data,
                           "caminho": os.path.join(p0, sub, nome), "origem": f"SULAMÉRICA/{pasta}/{sub}/{nome}"}


# ---------------------------------------------------------------- prestador pela pasta

def indice_pastas(prestadores):
    """pasta normalizada -> (id, nome do prestador, médico). prestadores = [{id, nome}]"""
    por_nome = {sem_acento(p["nome"]): p for p in prestadores}
    idx = {}
    for prest, pastas in PASTAS_EXTRAS.items():
        alvo = por_nome.get(sem_acento(prest))
        if alvo:
            for pasta, medico in pastas.items():
                idx[sem_acento(pasta)] = (alvo["id"], alvo["nome"], medico)
    for p in prestadores:
        idx.setdefault(sem_acento(p["nome"]), (p["id"], p["nome"], ""))
    return idx


def nome_visivel(c, medico):
    partes = [NOME_CONVENIO.get(c["convenio"], c["convenio"].title()), c["tipo"]]
    if c["convenio"] == "SULAMÉRICA":
        partes.append(f"pago {data_txt(c['data'])}")
    else:
        partes.append(comp_br(c["competencia"]))
    if c["numero"]:
        partes.append(c["numero"])
    if c["convenio"] == "MEDISERVICE" and c["data"]:
        partes.append("pago " + " e ".join([data_txt(c["data"])] + c.get("datas_extra", [])))
    if medico:
        partes.append(medico)
    # "/" não pode em nome de arquivo: no nome do PDF a data vai com "-" (a tela mostra com "/").
    return " · ".join(partes).replace("/", "-") + ".pdf"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Anexa os espelhos/demonstrativos de pagamento no portal do prestador.")
    ap.add_argument("--url", default=os.environ.get("PORTAL_URL", "http://localhost:3000"))
    ap.add_argument("--login", default=os.environ.get("FATURAS_SYNC_LOGIN"))
    ap.add_argument("--pasta", default=PASTA_BASE)
    ap.add_argument("--desde", default=DESDE, help="competência de pagamento mínima AAAA-MM (padrão 2026-07)")
    ap.add_argument("--prestador", action="append", help="só este(s) prestador(es)")
    ap.add_argument("--so-listar", action="store_true", help="não envia nada, só mostra (sem login)")
    ap.add_argument("--limite", type=int, default=0, help="envia no máximo N (teste)")
    a = ap.parse_args()

    portal = None
    if a.so_listar:
        prestadores = [{"id": i + 1, "nome": n} for i, n in enumerate(PRESTADORES)]
        existentes = set()
    else:
        if not a.login:
            raise SystemExit("Informe --login (usuário da equipe) ou FATURAS_SYNC_LOGIN.")
        portal = Portal(a.url)
        senha = os.environ.get("FATURAS_SYNC_SENHA") or getpass.getpass(f"Senha de {a.login}: ")
        u = portal.entrar(a.login, senha)
        print(f"Entrou no portal como {u.get('nome')} (equipe).")
        prestadores = [p for p in portal.dados()["prestadores"] if p["ativo"]]
        docs = portal._req("/api/documentos?acao=lista&categoria=espelho&excluidos=1")["documentos"]
        existentes = {(d["prestador_id"], d["nome_original"]) for d in docs}
    idx = indice_pastas(prestadores)
    filtro = {sem_acento(x) for x in (a.prestador or [])}

    candidatos = []
    for fn in (espelhos_unimed, espelhos_bradesco, espelhos_mediservice, espelhos_sulamerica):
        candidatos.extend(fn(a.pasta))

    ignoradas = collections.Counter()
    fila = []
    for c in candidatos:
        alvo = idx.get(sem_acento(c["pasta"]))
        if not alvo:
            ignoradas[f"{c['convenio'].split(' ')[0]}/{c['pasta']}"] += 1
            continue
        pid, pnome, medico = alvo
        if filtro and sem_acento(pnome) not in filtro:
            continue
        # Bradesco: a competência sai da data do pagamento no PDF (só lê os que podem entrar).
        if c.pop("ler_data", False) and c["competencia"] >= _mes_antes(a.desde):
            data_pagamento_bradesco(c)
        if c["competencia"] < a.desde:
            continue
        c.update(prestador_id=pid, prestador=pnome, medico=medico, nome=nome_visivel(c, medico),
                 tamanho=os.path.getsize(c["caminho"]))
        fila.append(c)

    if ignoradas:
        print("Pastas que não são prestador cadastrado (ignoradas): " + ", ".join(f"{k} ({v})" for k, v in sorted(ignoradas.items())))

    novos = [c for c in fila if (c["prestador_id"], c["nome"]) not in existentes]
    total = collections.defaultdict(lambda: [0, 0])
    for c in novos:
        total[c["convenio"]][0] += 1
        total[c["convenio"]][1] += c["tamanho"]
    print(f"{len(fila)} espelho(s) desde {comp_br(a.desde)}; {len(fila) - len(novos)} já estavam; {len(novos)} novo(s), "
          f"{sum(t[1] for t in total.values()) / 1048576:.1f} MB")
    for conv, (n, b) in sorted(total.items()):
        print(f"  {conv:<19} {n:>5} PDF  {b / 1048576:7.1f} MB")

    enviados = puladas = 0
    for c in novos:
        if a.limite and enviados >= a.limite:
            break
        linha = f"  {c['prestador']:<26} {c['nome']}"
        if c["tamanho"] > LIMITE_PDF:
            print(f"{linha}  ! {c['tamanho'] / 1048576:.1f} MB passa de 4 MB, anexe pela tela (pulei)")
            puladas += 1
            continue
        if a.so_listar:
            print(linha)
            continue
        meta = {"categoria": "espelho", "prestador_id": c["prestador_id"], "convenio": c["convenio"],
                "competencia": c["competencia"], "numero": c["numero"], "data_envio": c["data"] or "",
                "tipo": c["tipo"], "medico": c["medico"], "nome": c["nome"],
                "observacao": ("Pago em " + " e ".join([data_txt(c["data"])] + c["datas_extra"])) if c.get("datas_extra") else ""}
        try:
            portal.enviar(meta, c["caminho"])
            existentes.add((c["prestador_id"], c["nome"]))
            enviados += 1
            print(f"{linha}  -> anexado")
        except Exception as e:
            print(f"{linha}  ! falhou ({c['origem']}): {e}")
            puladas += 1
    if not a.so_listar:
        print(f"\nAnexados: {enviados}. Já estavam: {len(fila) - len(novos)}. Pulados/falhas: {puladas}.")


def _mes_antes(comp):
    ano, mes = int(comp[:4]), int(comp[5:7]) - 1
    if mes == 0:
        ano, mes = ano - 1, 12
    return f"{ano}-{mes:02d}"


if __name__ == "__main__":
    main()
