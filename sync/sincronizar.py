#!/usr/bin/env python3
"""Sincroniza as planilhas de controle de pagamento com o portal do prestador.

Para cada prestador da lista PRESTADORES, procura em
  \\\\faturasmed\\Documents\\CONTROLE DE PAGAMENTO\\<CONVENIO>\\<PRESTADOR>\\<PRESTADOR> - <CONVENIO>.xlsx
COPIA a planilha para uma pasta temporária (o original nunca é aberto para
escrita — os robôs usam esses arquivos), lê a aba CONTROLE (ou a aba que tiver
o cabeçalho certo), normaliza as linhas e manda para POST /api/sync, um
convênio por vez. O portal troca todas as linhas daquele prestador+convênio.

Uso:
  python sync/sincronizar.py --url https://<portal> --login <usuario.equipe>   (senha: FATURAS_SYNC_SENHA ou pergunta)
  python sync/sincronizar.py --url http://localhost:3000 --token teste         (token, se SYNC_TOKEN existir no portal)
  python sync/sincronizar.py --json saida.json                                 (só gera o JSON, não envia)
  python sync/sincronizar.py --prestador "RENAN BRITO" --url ... --login ...

Autenticação: login de um usuário da EQUIPE Faturas Med (perfil equipe) OU o
token SYNC_TOKEN. A senha nunca fica em arquivo: vem da variável de ambiente
FATURAS_SYNC_SENHA ou é pedida no terminal.

Variáveis de ambiente aceitas: PORTAL_URL, FATURAS_SYNC_LOGIN, FATURAS_SYNC_SENHA,
SYNC_TOKEN, CONTROLE_PAGAMENTO (pasta base).
Requer: Python 3.8+ e openpyxl.
"""

import argparse
import datetime as dt
import getpass
import http.cookiejar
import json
import os
import shutil
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.request

import openpyxl

PASTA_BASE = r"\\faturasmed\Documents\CONTROLE DE PAGAMENTO"

# Prestadores sincronizados (nome igual ao da pasta e ao cadastro do portal).
PRESTADORES = [
    "ADRIANO LIMA", "ALEXANDRE NEAGELE", "ANCARDIO", "ANGIOMED", "AZUL OFTALMOLOGIA",
    "BOCKUS", "BRUNO SANTOS", "CAEM", "CARLA MARCELI", "CDT", "CENTRUS",
    "CHRISTIANO MANHÃES", "CLAUDIA LEMOS", "CLAYTON CESAR", "CLINICAR", "CORPO & MENTE",
    "FABIO PESSANHA BRITO", "FACIAL CARE", "FELIPE CURVELO", "FERNANDO DE SIQUEIRA",
    "FERNANDO LINHARES", "GABRIEL FABRIS", "GUTO MAXILO", "HMS RIO", "HS ENDOSCOPIA",
    "HUMBERTO HENRIQUE", "IMN - MACAÉ", "IMN - RO", "INSPIRAR", "INTEGRADA INFANTIL",
    "IRNAK", "JOÃO GUILHERME", "JOSÉ CARLOS DE MENEZES", "LUCAS MISSIBA PJ",
    "MARCELO SOARES NEVES", "MAXILO FACIAL", "MS SANTOS", "MULTIFISIO",
    "NATHALIA SABER DE ANDRADE", "NILBERTO SIQUEIRA", "NORTEMED", "OXIGENIO", "PAM",
    "PATHOLOGY", "PAULA BECKER", "PEDRO MAY", "RAFAEL PEÇANHA", "RENAN BRITO",
    "RODRIGO LOUREIRO-HMS", "SAMIRA SALIM DE CARVALHO", "VANESSA ZUBATY",
    "VERONICA RODRIGUES", "VINICIUS ANTUNES",
]

# Pastas com OUTRO nome que pertencem ao mesmo prestador (planilhas somadas no
# portal): {prestador: {pasta: nome do médico}}. As linhas dessas pastas entram
# com esse médico (o portal deixa ver por médico ou tudo junto). Nas planilhas
# que têm a coluna MÉDICO (Azul), o médico vem da coluna.
# CAEM na Petrobras fatura como pessoa física; a Azul tem uma pasta por médico na Unimed.
PASTAS_EXTRAS = {
    "CAEM": {"CLAUDIO LUIZ LOURENÇO": "CLAUDIO LUIZ LOURENÇO"},
    "AZUL OFTALMOLOGIA": {"ERICK MARCET - AZUL OFTALMOLOGIA": "ERICK MARCET",
                          "RACHEL CAMARGO - AZUL OFTALMOLOGIA": "RACHEL CAMARGO"},
}

# Campo normalizado -> nomes possíveis do cabeçalho (já sem acento, maiúsculo).
# Bradesco/SulAmérica/Petrobras usam os nomes curtos; Unimed usa os longos.
CAMPOS = {
    "operadora": ["CONVENIO"],
    "comp": ["COMP", "COMPETENCIA"],
    "lote": ["LOTE"],
    "data_lote": ["DATA LOTE", "DATA DE FATURAMENTO", "DATA DO LOTE"],
    "tipo": ["TIPO", "TIPO DE GUIA"],
    "paciente": ["PACIENTE", "NOME DO PACIENTE"],
    "matricula": ["MATRICULA", "CARTEIRINHA", "CARTEIRA"],
    "guia": ["GUIA", "NUMERO DA GUIA"],
    "data": ["DATA", "DATA DO ATENDIMENTO", "DATA ATENDIMENTO"],
    "grau": ["GRAU"],
    "codigo": ["CODIGO", "CODIGO DO PROCEDIMENTO"],
    "procedimento": ["PROCEDIMENTO", "NOME DO PROCEDIMENTO"],
    "qtd": ["QTD", "QUANTIDADE"],
    "faturado": ["VALOR FATURADO"],
    "recebido": ["VALOR RECEBIDO"],
    "glosado": ["VALOR GLOSADO", "VALOR DE GLOSA"],
    "data_pagamento": ["DATA PAGAMENTO", "DATA DE PAGAMENTO"],
    "status": ["STATUS"],
    "motivo_glosa": ["MOTIVO DE GLOSA", "CRITICA DE GLOSA"],
    "medico": ["MEDICO", "NOME DO MEDICO", "MEDICO EXECUTANTE", "PROFISSIONAL", "EXECUTANTE"],
    "previsao_pagamento": ["PREVISAO DE PAGAMENTO", "PREVISAO PAGAMENTO", "PREVISAO"],
}
OBRIGATORIOS = ["comp", "guia", "faturado"]

# Fora da Unimed, data do lote no dia 01 é tratada como marcador de mês (não é
# a data real de envio): a linha fica com a coluna COMP. Na Unimed a DATA DE
# FATURAMENTO é sempre dia 01 e vale o mês dela (mês de envio).
DIA_01_E_MARCADOR = True

# Regra da competência pela pausa nos envios (ver competencias_por_envio).
PAUSA_MINIMA_DIAS = 7
PRIMEIRO_GRUPO_ATE_DIA = 15
# Corte informado pelo Willian (fechamento da competência anterior no escritório): no mês da chave, lote
# enviado ATÉ a data é da competência anterior e depois dela é do mês vigente. Vale para todos os prestadores
# (menos Unimed e Petrobrás, que são pelo mês de envio) e manda sobre a regra da pausa / 5º dia útil.
CORTES_COMPETENCIA = {
    "2026-11": "2026-11-13",   # Willian 23/11: lotes fechados até 13/11 = competência 10/2026
}
DIA_UTIL_LIMITE = 5


def sem_acento(texto):
    """'Motivo de  glosa' -> 'MOTIVO DE GLOSA' (sem acento, um espaço)."""
    t = unicodedata.normalize("NFD", str(texto or ""))
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return " ".join(t.upper().split())


def so_digitos(v):
    return "".join(c for c in str(texto_id(v) or "") if c.isdigit())


def convenio_da_linha(fonte, matricula, lote):
    """Convênio normalizado da linha. Regra da casa para o Bradesco:
    carteirinha começando com 954 = BRADESCO OPERADORA, o resto = BRADESCO SAÚDE;
    sem carteirinha, pelo lote/protocolo: 341 = Operadora, 340 = Saúde."""
    if sem_acento(fonte) != "BRADESCO":
        return fonte
    m = so_digitos(matricula)
    if m:
        return "BRADESCO OPERADORA" if m.startswith("954") else "BRADESCO SAÚDE"
    l = so_digitos(lote)
    if l.startswith("341"):
        return "BRADESCO OPERADORA"
    return "BRADESCO SAÚDE"


def mapear_cabecalho(linha):
    """Devolve {campo: índice da coluna}. A primeira coluna com o nome vence."""
    nomes = [sem_acento(c) for c in linha]
    mapa = {}
    for campo, opcoes in CAMPOS.items():
        for opcao in opcoes:
            if opcao in nomes:
                mapa[campo] = nomes.index(opcao)
                break
    return mapa


def valor_json(v):
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer() and abs(v) > 1e6:
        return str(int(v))  # número de guia/lote lido como float
    return v


def texto_id(v):
    """Lote, guia, código: sempre texto, sem '.0'."""
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    t = str(v).strip()
    return t or None


def competencia(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return f"{v.year:04d}-{v.month:02d}"
    t = str(v or "").strip()
    for formato in ("%m/%Y", "%m.%Y", "%Y-%m", "%d/%m/%Y", "%Y-%m-%d"):
        try:
            d = dt.datetime.strptime(t[:10], formato)
            return f"{d.year:04d}-{d.month:02d}"
        except ValueError:
            pass
    return None


def como_data(v):
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    t = str(v or "").strip()[:10]
    for formato in ("%d/%m/%Y", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(t, formato).date()
        except ValueError:
            pass
    return None


def pascoa(ano):
    """Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher)."""
    a, b, c = ano % 19, ano // 100, ano % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    mes = (h + l - 7 * m + 114) // 31
    dia = (h + l - 7 * m + 114) % 31 + 1
    return dt.date(ano, mes, dia)


def feriados(ano):
    """Feriados nacionais + Carnaval (seg/ter) e Corpus Christi, que param o envio."""
    p = pascoa(ano)
    fixos = [(1, 1), (4, 21), (5, 1), (9, 7), (10, 12), (11, 2), (11, 15), (11, 20), (12, 25)]
    moveis = [p - dt.timedelta(days=48), p - dt.timedelta(days=47), p - dt.timedelta(days=2), p + dt.timedelta(days=60)]
    return {dt.date(ano, m, d) for m, d in fixos} | set(moveis)


def dia_util(ano, mes, n=DIA_UTIL_LIMITE):
    """n-ésimo dia útil do mês (seg-sex, sem feriado)."""
    fer = feriados(ano)
    d, conta = dt.date(ano, mes, 1), 0
    while True:
        if d.weekday() < 5 and d not in fer:
            conta += 1
            if conta == n:
                return d
        d += dt.timedelta(days=1)


def mes_anterior(ano, mes):
    return (ano - 1, 12) if mes == 1 else (ano, mes - 1)


def competencias_por_envio(datas):
    """Regra do Willian para as datas de envio/fechamento dos lotes de UM
    prestador + convênio. Para cada mês: ordena as datas e acha a maior pausa
    entre envios seguidos. Se a pausa for >= 7 dias e o primeiro grupo terminar
    até o dia 15, o primeiro grupo é da competência anterior e o resto do mês
    vigente. Sem pausa assim: se todos os envios do mês estão até o 5º dia útil,
    o mês todo é da competência anterior; senão, do mês vigente.
    Devolve ({data: 'AAAA-MM'}, [detalhe por mês])."""
    por_mes = {}
    for d in sorted(set(datas)):
        por_mes.setdefault((d.year, d.month), []).append(d)
    comp, detalhe = {}, []
    for (ano, mes), ds in sorted(por_mes.items()):
        ant = "%04d-%02d" % mes_anterior(ano, mes)
        vig = "%04d-%02d" % (ano, mes)
        quinto = dia_util(ano, mes)
        corte = CORTES_COMPETENCIA.get(vig)
        if corte:
            corte_d = dt.date.fromisoformat(corte)
            grupos = [(g, c) for g, c in (([d for d in ds if d <= corte_d], ant), ([d for d in ds if d > corte_d], vig)) if g]
            for g, c in grupos:
                for d in g:
                    comp[d] = c
            detalhe.append({"mes": vig, "motivo": f"corte do escritório: até {corte_d:%d/%m} -> anterior", "grupos": [([d.isoformat() for d in g], c) for g, c in grupos]})
            continue
        gaps = [((ds[i + 1] - ds[i]).days, i) for i in range(len(ds) - 1)]
        maior, corte = max(gaps) if gaps else (0, -1)
        if maior >= PAUSA_MINIMA_DIAS and ds[corte].day <= PRIMEIRO_GRUPO_ATE_DIA:
            grupos = [(ds[:corte + 1], ant), (ds[corte + 1:], vig)]
            motivo = f"pausa de {maior} dias depois de {ds[corte]:%d/%m}"
        elif ds[-1] <= quinto:
            grupos = [(ds, ant)]
            motivo = f"todos até o 5º dia útil ({quinto:%d/%m})"
        elif ds[0] <= quinto:
            # Willian 23/11: sem pausa, o que foi enviado até o 5º dia útil é da competência anterior
            ate = [d for d in ds if d <= quinto]
            grupos = [(ate, ant), ([d for d in ds if d > quinto], vig)]
            motivo = f"até o 5º dia útil ({quinto:%d/%m}) -> anterior; depois -> vigente"
        else:
            grupos = [(ds, vig)]
            motivo = f"sem pausa >= {PAUSA_MINIMA_DIAS} dias e envios depois do 5º dia útil ({quinto:%d/%m})" if gaps else f"envio depois do 5º dia útil ({quinto:%d/%m})"
        for g, c in grupos:
            for d in g:
                comp[d] = c
        detalhe.append({"mes": vig, "motivo": motivo, "grupos": [([d.isoformat() for d in g], c) for g, c in grupos]})
    return comp, detalhe


# Gustavo 23/11/2026: a coluna COMP da planilha MANDA quando está preenchida
# (ele mantém as competências à mão). A regra pela data do lote só vale para
# linha sem COMP.
PLANILHA_MANDA = False   # Willian 23/11 tarde: competência pela regra da pausa / 5º dia útil (Unimed = mês de envio); COMP só quando não há data


def aplicar_competencias(linhas, convenio=""):
    """Competência de cada linha. Com PLANILHA_MANDA, a coluna COMP preenchida
    prevalece; o cálculo abaixo só preenche as linhas sem COMP.
    - UNIMED (Voxis): o próprio MÊS DE ENVIO do lote (a Unimed fecha do dia 1 ao
      último dia do mês). Aqui a DATA DE FATURAMENTO vem sempre no dia 01, mas
      o mês dela é o mês de envio. Sem data: coluna COMP.
    - Demais convênios: regra da pausa / 5º dia útil (competencias_por_envio)
      sobre as datas do lote; sem data (ou dia 01, que é só marcador): coluna COMP."""
    detalhe = _competencias_pela_data(linhas, convenio)
    if PLANILHA_MANDA:
        for l in linhas:
            if l["comp_planilha"]:
                l["comp"] = l["comp_planilha"]
    return detalhe


def _competencias_pela_data(linhas, convenio=""):
    if sem_acento(convenio).startswith(("UNIMED", "PETROBRAS")):   # Willian 23/11: Petrobrás igual à Unimed (mês de envio)
        por_mes = {}
        for l in linhas:
            d = como_data(l.get("data_lote"))
            l["comp"] = f"{d.year:04d}-{d.month:02d}" if d else l["comp_planilha"]
            if d:
                por_mes.setdefault(l["comp"], set()).add(d)
        return [{"mes": m, "motivo": "Unimed/Petrobrás: competência = mês de envio",
                 "grupos": [(sorted(x.isoformat() for x in ds), m)]} for m, ds in sorted(por_mes.items())]
    datas = {}
    for l in linhas:
        d = como_data(l.get("data_lote"))
        if d and not (DIA_01_E_MARCADOR and d.day == 1):
            datas[id(l)] = d
    mapa, detalhe = competencias_por_envio(datas.values())
    for l in linhas:
        d = datas.get(id(l))
        l["comp"] = mapa[d] if d else l["comp_planilha"]
    return detalhe


def achar_planilha(prestador, pasta_base):
    """[(convenio, [(caminho, medico_da_pasta)])] de todas as planilhas do prestador (pasta dele + PASTAS_EXTRAS)."""
    try:
        convenios = sorted(os.listdir(pasta_base))
    except OSError as e:
        raise SystemExit(f"Não consegui abrir {pasta_base}: {e}")
    nomes = [(prestador, None)] + list(PASTAS_EXTRAS.get(prestador, {}).items())
    achadas = {}
    for convenio in convenios:
        for nome, medico in nomes:
            pasta = os.path.join(pasta_base, convenio, nome)
            if not os.path.isdir(pasta):
                continue
            esperado = os.path.join(pasta, f"{nome} - {convenio}.xlsx")
            if os.path.isfile(esperado):
                achadas.setdefault(convenio, []).append((esperado, medico))
                continue
            candidatos = [f for f in os.listdir(pasta)
                          if f.lower().endswith(".xlsx") and not f.startswith("~$")
                          and sem_acento(f).startswith(sem_acento(nome))]
            if len(candidatos) == 1:
                achadas.setdefault(convenio, []).append((os.path.join(pasta, candidatos[0]), medico))
            elif candidatos:
                print(f"  ! {convenio}: mais de uma planilha em {pasta}, pulei: {candidatos}", file=sys.stderr)
    return sorted(achadas.items())


def ler_planilha(caminho, convenio, medico_pasta=None):
    """Copia para pasta temporária e lê. Devolve (linhas, avisos, aba)."""
    temp = tempfile.mkdtemp(prefix="sync_prestador_")
    try:
        copia = os.path.join(temp, "copia.xlsx")
        shutil.copyfile(caminho, copia)  # só leitura do original
        wb = openpyxl.load_workbook(copia, read_only=True, data_only=True)
        try:
            aba, mapa, linhas_aba = None, None, None
            nomes = ["CONTROLE"] + [n for n in wb.sheetnames if n != "CONTROLE"]
            for nome in nomes:
                if nome not in wb.sheetnames:
                    continue
                ws = wb[nome]
                todas = ws.iter_rows(values_only=True)
                cab = next(todas, None)
                if not cab:
                    continue
                m = mapear_cabecalho(cab)
                if all(c in m for c in OBRIGATORIOS):
                    aba, mapa, linhas_aba = nome, m, list(todas)
                    break
            if aba is None:
                return [], ["nenhuma aba com cabeçalho COMP/GUIA/VALOR FATURADO"], None, []
            linhas, avisos = [], []
            for n, r in enumerate(linhas_aba, start=2):
                if not any(c not in (None, "") for c in r):
                    continue
                pega = lambda campo: r[mapa[campo]] if campo in mapa and mapa[campo] < len(r) else None
                comp_planilha = competencia(pega("comp"))
                # A competência final sai de aplicar_competencias (data do lote);
                # aqui só garante que a linha tem COMP ou data do lote.
                comp = comp_planilha or (competencia(pega("data_lote")) if como_data(pega("data_lote")) else None)
                fat = pega("faturado")
                if comp is None:
                    avisos.append(f"linha {n}: sem competência")
                    continue
                if fat in (None, ""):
                    avisos.append(f"linha {n}: sem valor faturado")
                    continue
                linha = {
                    "linha_planilha": n,
                    "comp_planilha": comp_planilha,
                    "convenio": convenio_da_linha(convenio, pega("matricula"), pega("lote")),
                    "operadora": pega("operadora"),
                    "comp": comp,
                    "lote": texto_id(pega("lote")),
                    "data_lote": valor_json(pega("data_lote")),
                    "tipo": pega("tipo"),
                    "paciente": pega("paciente"),
                    "guia": texto_id(pega("guia")),
                    "data": valor_json(pega("data")),
                    "grau": texto_id(pega("grau")),
                    "codigo": texto_id(pega("codigo")),
                    "procedimento": pega("procedimento"),
                    "qtd": pega("qtd"),
                    "faturado": fat,
                    "recebido": pega("recebido"),
                    "glosado": pega("glosado"),
                    "data_pagamento": valor_json(pega("data_pagamento")),
                    "status": pega("status"),
                    "motivo_glosa": pega("motivo_glosa"),
                    # coluna MÉDICO da planilha; sem ela, o médico da pasta (PASTAS_EXTRAS)
                    "medico": (str(pega("medico")).strip() if pega("medico") not in (None, "") else None) or medico_pasta,
                    # sem a coluna, o portal calcula pela regra do convênio
                    "previsao_pagamento": valor_json(pega("previsao_pagamento")),
                }
                # Datas que vieram como texto ficam como texto; o portal entende DD/MM/AAAA.
                linhas.append({k: (valor_json(v) if not isinstance(v, str) else v.strip()) for k, v in linha.items()})
            detalhe = aplicar_competencias(linhas, convenio)
            return linhas, avisos, aba, detalhe
        finally:
            wb.close()
    finally:
        shutil.rmtree(temp, ignore_errors=True)


class Portal:
    """Conversa com o portal: sessão da equipe (cookie) ou token."""

    def __init__(self, url, token=None):
        self.url = url.rstrip("/")
        self.token = token
        self.abridor = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def _post(self, caminho, corpo):
        cab = {"Content-Type": "application/json"}
        if self.token:
            cab["X-Sync-Token"] = self.token
        req = urllib.request.Request(self.url + caminho, data=json.dumps(corpo, ensure_ascii=False).encode("utf-8"),
                                     method="POST", headers=cab)
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
        r = self._post("/api/auth?acao=entrar", {"login": login, "senha": senha, "perfil": "faturas"})
        u = r.get("usuario") or {}
        if u.get("perfil") != "faturas":
            raise RuntimeError("o usuário não é da equipe Faturas Med")
        return u

    def sair(self):
        try:
            self._post("/api/auth?acao=sair", {})
        except Exception:
            pass

    LIMITE_PARTE = 2_500_000   # bytes de JSON por requisição (a Vercel aceita 4,5 MB)
    LINHAS_PARTE = 15000

    def sincronizar(self, pacote):
        """Manda o pacote; se for grande, em partes (o portal só troca tudo na última)."""
        corpo = json.dumps(pacote, ensure_ascii=False).encode("utf-8")
        linhas = pacote["linhas"]
        n = max(-(-len(corpo) // self.LIMITE_PARTE), -(-len(linhas) // self.LINHAS_PARTE), 1)
        if n == 1:
            return self._post("/api/sync", pacote)
        envio = "sync-" + dt.datetime.now().strftime("%Y%m%d%H%M%S") + "-" + os.urandom(4).hex()
        tamanho = -(-len(linhas) // n)
        resposta = None
        for i in range(n):
            parte = dict(pacote, linhas=linhas[i * tamanho:(i + 1) * tamanho], envio=envio, parte=i + 1, partes=n)
            resposta = self._post("/api/sync", parte)
        resposta["partes"] = n
        return resposta


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Sincroniza as planilhas de controle com o portal do prestador.")
    ap.add_argument("--url", default=os.environ.get("PORTAL_URL"), help="endereço do portal (ex.: http://localhost:3000)")
    ap.add_argument("--login", default=os.environ.get("FATURAS_SYNC_LOGIN"), help="usuário da EQUIPE Faturas Med (senha: FATURAS_SYNC_SENHA ou pergunta)")
    ap.add_argument("--token", default=os.environ.get("SYNC_TOKEN"), help="SYNC_TOKEN do portal (alternativa ao --login)")
    ap.add_argument("--json", metavar="SAIDA", help="só grava o JSON normalizado neste arquivo (não envia)")
    ap.add_argument("--pasta", default=os.environ.get("CONTROLE_PAGAMENTO", PASTA_BASE), help="pasta CONTROLE DE PAGAMENTO")
    ap.add_argument("--prestador", action="append", help="sincroniza só este prestador (pode repetir)")
    ap.add_argument("--detalhe", action="store_true", help="mostra as datas de envio de cada mês e a competência de cada grupo")
    a = ap.parse_args()
    if not a.json and (not a.url or not (a.login or a.token)):
        ap.error("informe --url e --login (ou --token), ou use --json")

    portal = None
    if not a.json:
        portal = Portal(a.url, None if a.login else a.token)
        if a.login:
            senha = os.environ.get("FATURAS_SYNC_SENHA") or getpass.getpass(f"Senha de {a.login} no portal: ")
            try:
                u = portal.entrar(a.login, senha)
            except Exception as e:
                raise SystemExit(f"Não consegui entrar no portal como {a.login}: {e}")
            print(f"Entrou no portal como {u.get('nome')} (equipe).")

    prestadores = [p.upper() for p in (a.prestador or PRESTADORES)]
    pacotes, falhas = [], 0
    for prestador in prestadores:
        print(f"== {prestador}")
        for convenio, caminhos in achar_planilha(prestador, a.pasta):
            linhas, avisos, detalhe, abas, modificado, erro = [], [], [], [], None, False
            for caminho, medico_pasta in caminhos:
                try:
                    l1, a1, aba1, d1 = ler_planilha(caminho, convenio, medico_pasta)
                except Exception as e:  # planilha aberta/corrompida: segue com as outras
                    print(f"  ! {convenio}: não consegui ler {os.path.basename(caminho)} ({e})", file=sys.stderr)
                    erro = True
                    break
                linhas += l1; avisos += a1; detalhe += d1
                if aba1: abas.append(aba1)
                m = dt.datetime.fromtimestamp(os.path.getmtime(caminho)).astimezone().isoformat()
                modificado = max(modificado or m, m)
            if erro:  # não manda metade: o portal trocaria tudo do convênio pelo que leu
                falhas += 1
                continue
            aba = "+".join(abas) if len(abas) > 1 else (abas[0] if abas else None)
            pacote = {"prestador": prestador, "convenio": convenio,
                      "arquivo": " + ".join(os.path.basename(c) for c, _ in caminhos),
                      "arquivo_modificado": modificado, "linhas": linhas,
                      "competencias_por_envio": detalhe}
            total = round(sum(float(l["faturado"]) for l in linhas if isinstance(l["faturado"], (int, float))), 2)
            print(f"  {convenio:<12} aba {aba or '-':<9} {len(linhas):>5} linhas  faturado {total:>12,.2f}"
                  + (f"  ({len(avisos)} ignoradas)" if avisos else ""))
            if a.detalhe:
                for m in detalhe:
                    grupos = "  |  ".join(f"{', '.join(x[8:10] + '/' + x[5:7] for x in g)} -> {c[5:7]}/{c[:4]}" for g, c in m["grupos"])
                    print(f"      envios {m['mes'][5:7]}/{m['mes'][:4]}: {grupos}   ({m['motivo']})")
            mudou = [l for l in linhas if l["comp_planilha"] and l["comp"] != l["comp_planilha"]]
            sem_data = sum(1 for l in linhas if not l.get("data_lote"))
            sem_comp = sum(1 for l in linhas if not l["comp_planilha"])
            if PLANILHA_MANDA:
                print(f"    competência: coluna COMP da planilha" + (f" ({sem_comp} linhas sem COMP calculadas pela data do lote)" if sem_comp else ""))
            else:
                print(f"    competência pela data do lote: {len(mudou)} de {len(linhas)} linhas mudaram em relação à coluna COMP"
                      + (f" ({sem_data} sem data do lote: ficou a COMP)" if sem_data else ""))
            subconv = sorted({l["convenio"] for l in linhas} - {convenio})
            for sc in subconv:
                sl = [l for l in linhas if l["convenio"] == sc]
                sm = sum(1 for l in sl if l["comp_planilha"] and l["comp"] != l["comp_planilha"])
                print(f"    {sc:<20} {len(sl):>5} linhas  faturado {sum(float(l['faturado']) for l in sl):>12,.2f}  ({sm} mudaram de competência)")
            if not linhas and aba:
                print(f"    (aba {aba} só tem o cabeçalho: nenhuma linha lançada)")
            if a.json:
                pacotes.append(pacote)
                continue
            if aba is None:
                print(f"  ! {convenio}: {avisos[0]} — não enviei para não apagar o que já está no portal", file=sys.stderr)
                falhas += 1
                continue
            try:
                r = portal.sincronizar(pacote)
                print(f"    -> portal: {r.get('linhas')} linhas gravadas" + (f" (em {r.get('partes')} partes)" if r.get("partes") else "") + (f", {r.get('ignoradas')} ignoradas" if r.get("ignoradas") else ""))
            except Exception as e:
                print(f"  ! {convenio}: envio falhou: {e}", file=sys.stderr)
                falhas += 1
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(pacotes, f, ensure_ascii=False, indent=1)
        print(f"JSON gravado em {a.json}")
    if portal and a.login:
        portal.sair()
    sys.exit(1 if falhas else 0)


if __name__ == "__main__":
    main()
