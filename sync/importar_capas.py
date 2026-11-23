#!/usr/bin/env python3
"""Importa as CAPAS (protocolos de envio dos portais) para a Área do Prestador.

Os robôs de faturamento salvam o PDF do protocolo de cada lote em
  Z:\\FATURAMENTO\\<CONVÊNIO>\\<mês>\\...   (CAMINHOS.ini [faturamento])
Este script acha esses PDFs, descobre prestador / competência / número do
protocolo / data de envio e anexa cada um como PROTOCOLO no portal
(POST /api/documentos?acao=enviar). É o que o "Baixar com as capas" do
resumo de faturamento usa. Protocolo já anexado (mesmo prestador + número)
não entra de novo, então pode rodar todo dia.

Padrões que entende (23/11/2026):
  BRADESCO\\MM.AAAA\\<PRESTADOR>[ - <MÉDICO>] - MM.AAAA - <TIPO> - <protocolo> - CAPA.pdf
      data de envio = "Data do Fechamento" dentro do PDF
  PETROBRAS\\COMP MM.AA\\<PRESTADOR> - LOTE <n> - N GUIAS[ - PROTOCOLO <p>] - <TIPO>.pdf
      número = "NUMERO DO PROTOCOLO" dentro do PDF (é o que a planilha chama de LOTE)
  SULAMERICA\\MM.AAAA\\<PRESTADOR> - <TIPO> - GRD <n> - dd.mm.aa.pdf
  AMIL\\COMP MM.AA\\<PRESTADOR>.pdf   (lista de protocolos gerados; o 1º vira o número, os outros vão na observação)
  UNIMED: ainda não (pasta VOXIS/LOTE GUIA tem outro formato).

Uso:
  python sync/importar_capas.py --url https://<portal> --login <usuario.equipe>   (senha: FATURAS_SYNC_SENHA)
  python sync/importar_capas.py --so-listar                                        (só mostra o que faria)
  python sync/importar_capas.py --prestador "MARCELO SOARES NEVES" --url ... --login ...
Variáveis: PORTAL_URL, FATURAS_SYNC_LOGIN, FATURAS_SYNC_SENHA, CAPAS_PASTA (padrão Z:\\FATURAMENTO).
Requer: pypdf.
"""

import argparse
import datetime as dt
import getpass
import http.cookiejar
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

try:
    from pypdf import PdfReader
except ImportError:  # pragma: no cover
    PdfReader = None

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sincronizar import PASTAS_EXTRAS  # noqa: E402  (pasta do médico -> prestador)

PASTA_CAPAS = os.environ.get("CAPAS_PASTA", r"Z:\FATURAMENTO")
LIMITE_PDF = 4 * 1024 * 1024  # o caminho pelo servidor aceita até 4 MB na Vercel


def sem_acento(t):
    t = unicodedata.normalize("NFD", str(t or ""))
    return "".join(c for c in t if unicodedata.category(c) != "Mn").upper().strip()


def texto_pdf(caminho, paginas=1):
    if not PdfReader:
        return ""
    try:
        r = PdfReader(caminho)
        return " ".join((p.extract_text() or "") for p in r.pages[:paginas])
    except Exception as e:  # PDF estranho: segue sem texto
        print(f"    ! não li o PDF ({e})", file=sys.stderr)
        return ""


def data_br(s):
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", s or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


def data_arquivo(caminho):
    return dt.date.fromtimestamp(os.path.getmtime(caminho)).isoformat()


# ---------------------------------------------------------------- leitura das pastas

def capas_bradesco(base, so_prestador=None):
    pasta = os.path.join(base, "BRADESCO")
    if not os.path.isdir(pasta):
        return
    for mes in sorted(os.listdir(pasta)):
        if not re.fullmatch(r"\d{2}\.\d{4}", mes):
            continue
        for nome in sorted(os.listdir(os.path.join(pasta, mes))):
            if not nome.upper().endswith(" - CAPA.PDF"):
                continue
            partes = [p.strip() for p in nome[:-4].split(" - ")]
            try:
                i = next(k for k, p in enumerate(partes) if re.fullmatch(r"\d{2}\.\d{4}", p))
            except StopIteration:
                print(f"  ? BRADESCO/{mes}/{nome}: sem MM.AAAA no nome, pulei")
                continue
            prestador, medico = partes[0], " - ".join(partes[1:i]) or None
            tipo = partes[i + 1] if len(partes) > i + 1 else ""
            numero = next((p for p in partes[i + 1:] if re.fullmatch(r"\d{8,}", p)), None)
            if not numero:
                print(f"  ? BRADESCO/{mes}/{nome}: sem número de protocolo no nome, pulei")
                continue
            caminho = os.path.join(pasta, mes, nome)
            txt = texto_pdf(caminho)
            m = re.search(r"(\d{2}/\d{2}/\d{4}) \d{2}:\d{2}:\d{2}", txt)
            yield {
                "convenio": "BRADESCO", "competencia": f"{mes[3:]}-{mes[:2]}", "prestador": prestador, "medico": medico,
                "numero": numero, "data_envio": data_br(m.group(1)) if m else data_arquivo(caminho),
                "tipo": tipo, "caminho": caminho, "origem": f"BRADESCO/{mes}/{nome}",
            }


def comp_de_pasta(nome):
    m = re.fullmatch(r"COMP (\d{2})\.(\d{2})", nome)
    return f"20{m.group(2)}-{m.group(1)}" if m else None


def capas_petrobras(base, so_prestador=None):
    pasta = os.path.join(base, "PETROBRAS")
    if not os.path.isdir(pasta):
        return
    for sub in sorted(os.listdir(pasta)):
        comp = comp_de_pasta(sub)
        if not comp:
            continue
        for nome in sorted(os.listdir(os.path.join(pasta, sub))):
            if not nome.lower().endswith(".pdf"):
                continue
            partes = [p.strip() for p in nome[:-4].split(" - ")]
            caminho = os.path.join(pasta, sub, nome)
            txt = texto_pdf(caminho)
            m = re.search(r"NUMERO DO PROTOCOLO\s*(\d{6,})", txt) or re.search(r"PROTOCOLO (\d{6,})", nome)
            lote = re.search(r"LOTE (\d+)", nome)
            numero = m.group(1) if m else (lote.group(1) if lote else None)
            if not numero:
                print(f"  ? PETROBRAS/{sub}/{nome}: sem número de protocolo, pulei")
                continue
            d = re.search(r"Data de envio lote:\s*(\d{2}/\d{2}/\d{4})", txt)
            yield {
                "convenio": "PETROBRÁS", "competencia": comp, "prestador": partes[0], "medico": None,
                "numero": numero, "data_envio": data_br(d.group(1)) if d else data_arquivo(caminho),
                "tipo": partes[-1] if len(partes) > 1 else "", "caminho": caminho, "origem": f"PETROBRAS/{sub}/{nome}",
                "observacao": f"Lote {lote.group(1)}" if lote and lote.group(1) != numero else "",
            }


def capas_sulamerica(base, so_prestador=None):
    pasta = os.path.join(base, "SULAMERICA")
    if not os.path.isdir(pasta):
        return
    for mes in sorted(os.listdir(pasta)):
        if not re.fullmatch(r"\d{2}\.\d{4}", mes):
            continue
        for nome in sorted(os.listdir(os.path.join(pasta, mes))):
            if not nome.lower().endswith(".pdf"):
                continue
            partes = [p.strip() for p in nome[:-4].split(" - ")]
            grd = next((re.match(r"GRD (\d+)", p) for p in partes if re.match(r"GRD (\d+)", p)), None)
            if not grd:
                print(f"  ? SULAMERICA/{mes}/{nome}: sem GRD no nome, pulei")
                continue
            dm = next((re.fullmatch(r"(\d{2})\.(\d{2})\.(\d{2})", p) for p in partes if re.fullmatch(r"\d{2}\.\d{2}\.\d{2}", p)), None)
            caminho = os.path.join(pasta, mes, nome)
            yield {
                "convenio": "SULAMÉRICA", "competencia": f"{mes[3:]}-{mes[:2]}", "prestador": partes[0], "medico": None,
                "numero": grd.group(1), "data_envio": f"20{dm.group(3)}-{dm.group(2)}-{dm.group(1)}" if dm else data_arquivo(caminho),
                "tipo": partes[1] if len(partes) > 2 else "", "caminho": caminho, "origem": f"SULAMERICA/{mes}/{nome}",
            }


def capas_amil(base, so_prestador=None):
    pasta = os.path.join(base, "AMIL")
    if not os.path.isdir(pasta):
        return
    for sub in sorted(os.listdir(pasta)):
        comp = comp_de_pasta(sub)
        if not comp:
            continue
        for nome in sorted(os.listdir(os.path.join(pasta, sub))):
            if not nome.lower().endswith(".pdf"):
                continue
            caminho = os.path.join(pasta, sub, nome)
            txt = texto_pdf(caminho)
            # "<protocolo> MM/AAAA MM/AAAA dd/mm/aaaa hh:mm:ss"  (uma linha por protocolo gerado)
            achados = re.findall(r"\b(\d{10})\s+\d{2}/\d{4}\s+\d{2}/\d{4}\s+(\d{2}/\d{2}/\d{4})", txt)
            if not achados:
                print(f"  ? AMIL/{sub}/{nome}: não achei protocolo dentro do PDF, pulei")
                continue
            numero, data = achados[0]
            outros = [p for p, _ in achados[1:]]
            yield {
                "convenio": "AMIL", "competencia": comp, "prestador": nome[:-4].strip(), "medico": None,
                "numero": numero, "data_envio": data_br(data), "tipo": "", "caminho": caminho, "origem": f"AMIL/{sub}/{nome}",
                "observacao": ("Protocolos no mesmo PDF: " + ", ".join(outros)) if outros else "",
            }


# ---------------------------------------------------------------- prestador pelo nome do arquivo

def montar_indice(prestadores):
    """nome normalizado -> (id, nome, medico_fixo)"""
    idx = {}
    for p in prestadores:
        idx[sem_acento(p["nome"])] = (p["id"], p["nome"], None)
    for prest, pastas in PASTAS_EXTRAS.items():
        alvo = idx.get(sem_acento(prest))
        if alvo:
            for pasta, medico in pastas.items():
                idx.setdefault(sem_acento(pasta), (alvo[0], alvo[1], medico))
                idx.setdefault(sem_acento(medico), (alvo[0], alvo[1], medico))
    return idx


def achar_prestador(nome, idx, partes=None):
    """nome = 1º pedaço do nome do arquivo; partes = pedaços (separados por " - "):
    prestador com " - " no nome (IMN - MACAÉ) ocupa dois pedaços."""
    for k in range(min(3, len(partes or [])), 1, -1):
        junto = sem_acento(" - ".join(partes[:k]))
        if junto in idx:
            return idx[junto]
    n = sem_acento(nome)
    if n in idx:
        return idx[n]
    # começa igual (um contém o outro) — "ALEXANDRE NAEGELE DE OLIVEIRA" ~ "ALEXANDRE NEAGELE" não casa; vai pelo 1º nome
    cand = [v for k, v in idx.items() if k.startswith(n + " ") or n.startswith(k + " ")]
    if len({c[0] for c in cand}) == 1:
        return cand[0]
    primeiro = n.split(" ")[0]
    cand = [v for k, v in idx.items() if k.split(" ")[0] == primeiro]
    if len({c[0] for c in cand}) == 1:
        return cand[0]
    return None


# ---------------------------------------------------------------- portal

class Portal:
    def __init__(self, url):
        self.url = url.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.abridor = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def _req(self, caminho, dados=None, tipo="application/json", metodo=None):
        req = urllib.request.Request(self.url + caminho, data=dados, method=metodo or ("POST" if dados is not None else "GET"))
        if dados is not None:
            req.add_header("Content-Type", tipo)
        try:
            with self.abridor.open(req, timeout=180) as r:
                return json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            texto = e.read().decode("utf-8", "replace")
            try:
                texto = json.loads(texto).get("erro", texto)
            except ValueError:
                pass
            raise RuntimeError(f"HTTP {e.code}: {texto}")

    def entrar(self, login, senha):
        r = self._req("/api/auth?acao=entrar", json.dumps({"login": login, "senha": senha, "perfil": "faturas"}).encode("utf-8"))
        if (r.get("usuario") or {}).get("perfil") != "faturas":
            raise RuntimeError("o usuário não é da equipe Faturas Med")
        return r["usuario"]

    def dados(self):
        return self._req("/api/admin?acao=dados")

    def protocolos(self):
        return self._req("/api/documentos?acao=lista&categoria=protocolo")["documentos"]

    def enviar(self, meta, caminho):
        with open(caminho, "rb") as f:
            pdf = f.read()
        q = urllib.parse.urlencode({k: v for k, v in meta.items() if v not in (None, "")})
        return self._req(f"/api/documentos?acao=enviar&{q}", pdf, "application/pdf")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Anexa as capas (protocolos dos portais) no portal do prestador.")
    ap.add_argument("--url", default=os.environ.get("PORTAL_URL", "http://localhost:3000"))
    ap.add_argument("--login", default=os.environ.get("FATURAS_SYNC_LOGIN"))
    ap.add_argument("--pasta", default=PASTA_CAPAS)
    ap.add_argument("--prestador", action="append", help="só este(s) prestador(es)")
    ap.add_argument("--so-listar", action="store_true", help="não envia nada, só mostra")
    a = ap.parse_args()

    capas = []
    for fn in (capas_bradesco, capas_petrobras, capas_sulamerica, capas_amil):
        capas.extend(fn(a.pasta))
    print(f"{len(capas)} capa(s) encontradas em {a.pasta}")

    portal = Portal(a.url)
    if not a.login:
        raise SystemExit("Informe --login (usuário da equipe) ou FATURAS_SYNC_LOGIN.")
    senha = os.environ.get("FATURAS_SYNC_SENHA") or getpass.getpass(f"Senha de {a.login}: ")
    u = portal.entrar(a.login, senha)
    print(f"Entrou no portal como {u.get('nome')} (equipe).")
    dados = portal.dados()
    idx = montar_indice([p for p in dados["prestadores"] if p["ativo"]])
    existentes = {(d["prestador_id"], str(d["numero"])) for d in portal.protocolos() if not d.get("excluido_em")}

    filtro = {sem_acento(x) for x in (a.prestador or [])}
    enviadas = puladas = repetidas = 0
    for c in capas:
        achado = achar_prestador(c["prestador"], idx, [x.strip() for x in os.path.basename(c["caminho"])[:-4].split(" - ")])
        if not achado:
            print(f"  ? {c['origem']}: prestador \"{c['prestador']}\" não está cadastrado no portal, pulei")
            puladas += 1
            continue
        pid, pnome, medico_fixo = achado
        if filtro and sem_acento(pnome) not in filtro:
            continue
        if (pid, c["numero"]) in existentes:
            repetidas += 1
            continue
        tamanho = os.path.getsize(c["caminho"])
        if tamanho > LIMITE_PDF:
            print(f"  ! {c['origem']}: {tamanho / 1048576:.1f} MB passa de 4 MB, anexe pela tela (pulei)")
            puladas += 1
            continue
        meta = {
            "categoria": "protocolo", "prestador_id": pid, "convenio": c["convenio"], "competencia": c["competencia"],
            "numero": c["numero"], "data_envio": c["data_envio"], "medico": medico_fixo or c.get("medico") or "",
            "observacao": c.get("observacao", ""), "nome": os.path.basename(c["caminho"]),
        }
        print(f"  {pnome:<28} {c['convenio']:<11} {c['competencia']}  prot. {c['numero']:<12} envio {c['data_envio']}"
              + (f"  médico {meta['medico']}" if meta["medico"] else "") + ("" if a.so_listar else "  -> anexando"))
        if a.so_listar:
            continue
        try:
            portal.enviar(meta, c["caminho"])
            existentes.add((pid, c["numero"]))
            enviadas += 1
        except Exception as e:
            print(f"    ! falhou: {e}")
            puladas += 1
    print(f"\nAnexadas: {enviadas}. Já estavam: {repetidas}. Puladas: {puladas}.")


if __name__ == "__main__":
    main()
