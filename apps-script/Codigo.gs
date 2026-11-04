/**
 * Busca de ADs da EASA — servidor (Google Apps Script, App da Web).
 *
 * O navegador não consegue ler o site da EASA (bloqueio CORS). Este App da Web lê as duas fontes
 * oficiais, junta, guarda em cache e devolve só o resultado da busca, em JSON:
 *   GET .../exec?numero=&modelo=&fabricante=&pagina=   (sem senha: só lê dados públicos da EASA)
 *   GET .../exec?acao=status                            (versão do serviço)
 *
 * COMO PUBLICAR (uma vez):
 *  1. script.google.com > Novo projeto > apague o conteúdo e cole este arquivo inteiro. Salve.
 *  2. Implantar > Nova implantação > tipo "App da Web":
 *       Executar como: Eu        Quem pode acessar: Qualquer pessoa
 *     Autorize quando pedir (serviço externo e Google Drive — o Drive guarda uma cópia de reserva)
 *     e copie a URL que termina em /exec.
 *  3. Cole essa URL em config.js (APPS_SCRIPT_URL) e publique o site.
 *  Opcional: escolha a função instalarHistoricoEasa e clique em Executar. Ela cria um gatilho de
 *  hora em hora que mantém o cache pronto (a busca não espera o download da EASA).
 *  Teste: função testeHistoricoEasa (mostra no registro uma busca de exemplo).
 *
 * Ao mudar este código: Implantar > Gerenciar implantações > Editar (lápis) > Versão: Nova versão
 * > Implantar. Assim a URL continua a mesma.
 */

var VERSAO = 1;
var EASA_WWW = "https://www.easa.europa.eu";
var EASA_PROVISORIA = EASA_WWW + "/en/domains/aircraft-products/airworthiness-directives-ad/safety-publications-tool-interim-solution";

function doGet(e) {
  var p = (e && e.parameter) || {};
  var acao = String(p.acao || "");
  if (acao === "status") return json_({ ok: true, servico: "busca-ad-easa", versao: VERSAO });
  if (acao && acao !== "easa-historico" && acao !== "busca") return json_({ ok: false, codigo: 400, erro: "Ação desconhecida." });
  var r = ehistBusca_(p);
  r.versao = VERSAO;
  return json_(r);
}

function json_(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}

// Texto puro a partir de HTML (tira tags e decodifica entidades).
function easaTexto_(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&ndash;/gi, "–").replace(/&mdash;/gi, "—")
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();
}

// ============================================================================================
// BUSCA NO HISTÓRICO DE ADs DA EASA — servidor da página de busca (index.html / app.js).
// GET ?numero=&modelo=&fabricante=&pagina=  (sem token: só lê dados públicos
// da EASA, de dois endereços fixos aqui no código; o site manda apenas os filtros).
// Junta duas fontes oficiais, sem repetir número:
//   1. Arquivo histórico (dataset JSON da EASA, ~5.700 ADs desde 2003);
//   2. Página provisória "Safety Publications Tool – Interim Solution" (as publicações recentes).
// Regras (iguais às do projeto easa-busca):
//   - só ADs da própria EASA: classe AD/EAD/ADR e número 20AA-NNNN (com R1, -E, -CN), ano >= 2003;
//     na página provisória, emissor "EU" e nada de "Proposed AD" (PAD);
//   - mesmo número nas duas fontes: vale a data de emissão mais nova; empate = página provisória;
//     fabricante, modelo e documentos vazios são completados pela outra fonte;
//   - documentos: só https://www.easa.europa.eu/download/... ou /downloads/<id>/en;
//   - filtros sem acento/pontuação/maiúsculas, todos juntos (E), por trecho; 20 por página;
//   - o filtro "fabricante" procura no detentor OU no assunto (Subject),
//     para achar o fabricante do componente ou o nome do componente.
// Cache: cada fonte fica 1 h no CacheService (compactada, em pedaços de 90 KB, guardada por até
// 6 h). Se a EASA falhar, usa a última leitura ("cache_antigo") e só tenta de novo após 60 s.
// Reserva no Google Drive (arquivo "Busca de ADs EASA - reserva.json") para quando o cache
// expirar com a EASA fora do ar. OPCIONAL: execute instalarHistoricoEasa para criar um gatilho de
// hora em hora que mantém o cache quente (a busca não espera o download da EASA).
// ============================================================================================
var EHIST_ARQUIVO = EASA_WWW + "/en/datasets/144347/export/json";
var EHIST_TTL_S = 3600;            // leitura nova a cada 1 h
var EHIST_GUARDAR_S = 21600;       // máximo do CacheService (6 h)
var EHIST_RETRY_S = 60;            // depois de uma falha, espera 60 s para tentar de novo
var EHIST_PEDACO = 90000;          // o CacheService aceita até 100 KB por chave
var EHIST_POR_PAGINA = 20;
var EHIST_MAX_FILTRO = 120;
var EHIST_RESERVA_PROP = "EHIST_RESERVA_ARQUIVO";
var EHIST_RESERVA_NOME = "Busca de ADs EASA - reserva.json";
var EHIST_NUMERO = /^20\d{2}-\d{4}(?:R\d+|-E|-CN)*$/i;
var EHIST_COBERTURA = "Arquivo histórico e publicações disponíveis na página provisória da EASA, sem duplicar números.";
var EHIST_CRITERIO = "Arquivo: numeração EASA inferida. Página provisória: emissor EU explícito e numeração de AD.";

function ehistBusca_(p) {
  p = p || {};
  var filtros = {};
  var nomes = ["numero", "modelo", "fabricante"];
  for (var i = 0; i < nomes.length; i += 1) {
    var v = String(p[nomes[i]] || "").trim();
    if (v.length > EHIST_MAX_FILTRO) return { ok: false, codigo: 400, erro: "Use até 120 caracteres em cada filtro." };
    if (v && !ehistCompacto_(v)) return { ok: false, codigo: 400, erro: "Informe letras ou números nos filtros." };
    filtros[nomes[i]] = v;
  }
  var paginaTxt = String(p.pagina == null || p.pagina === "" ? "1" : p.pagina).trim();
  if (!/^\d{1,6}$/.test(paginaTxt) || Number(paginaTxt) < 1) {
    return { ok: false, codigo: 400, erro: "A página deve ser um número inteiro maior que zero." };
  }
  var inicio = Date.now();
  var carregado;
  try { carregado = ehistCarregar_(false); } catch (e) {
    console.error("easa-historico: " + ((e && e.stack) || e));
    return { ok: false, codigo: 502, erro: "Não foi possível consultar a EASA. Tente novamente em alguns instantes." };
  }
  if (!carregado) return { ok: false, codigo: 502, erro: "Não foi possível consultar a EASA. Tente novamente em alguns instantes." };
  var achados = ehistFiltrar_(carregado.itens, filtros);
  var paginas = Math.max(1, Math.ceil(achados.length / EHIST_POR_PAGINA));
  var pagina = Math.min(Number(paginaTxt), paginas);
  var ini = (pagina - 1) * EHIST_POR_PAGINA;
  var fontes = carregado.fontes;
  var datas = fontes.map(function (f) { return f.consultadoEm; }).filter(Boolean).sort();
  return {
    ok: true,
    resultados: achados.slice(ini, ini + EHIST_POR_PAGINA).map(ehistSaida_),
    total: achados.length, pagina: pagina, paginas: paginas, porPagina: EHIST_POR_PAGINA,
    totalEasa: carregado.itens.length, filtros: filtros,
    fonte: EHIST_ARQUIVO, publicacoesRecentes: EASA_PROVISORIA, cobertura: EHIST_COBERTURA,
    fontes: fontes, consultadoEm: datas.length ? datas[datas.length - 1] : null,
    cacheDesatualizado: fontes.some(function (f) { return f.status === "cache_antigo"; }),
    buscaParcial: fontes.some(function (f) { return f.status === "indisponivel"; }),
    criterioOrigem: EHIST_CRITERIO, fabricanteInclui: "assunto", ms: Date.now() - inicio
  };
}

// ---- texto / normalização ------------------------------------------------------------------
function ehistCompacto_(valor) {
  return String(valor == null ? "" : valor).normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
function ehistLimpo_(valor) {
  return String(valor == null ? "" : valor).replace(/­/g, "").replace(/\s+/g, " ").trim();
}
function ehistDataIso_(valor) {
  var t = ehistLimpo_(valor), m;
  if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return ehistDataValida_(+m[3], +m[1], +m[2]);
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return ehistDataValida_(+m[1], +m[2], +m[3]);
  return null;
}
function ehistDataValida_(a, mes, dia) {
  var d = new Date(Date.UTC(a, mes - 1, dia));
  if (d.getUTCFullYear() !== a || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return a + "-" + ("0" + mes).slice(-2) + "-" + ("0" + dia).slice(-2);
}
function ehistEhEasa_(classe, numero) {
  numero = String(numero || "").trim();
  return (classe === "AD" || classe === "EAD" || classe === "ADR") && EHIST_NUMERO.test(numero) && Number(numero.slice(0, 4)) >= 2003;
}

// Só documentos do próprio www.easa.europa.eu: /download/... ou /downloads/<id>/en.
function ehistDocUrl_(href) {
  var u = String(href || "").trim().replace(/&amp;/gi, "&");
  if (!u) return null;
  if (u.charAt(0) === "/" && u.charAt(1) !== "/") u = EASA_WWW + u;
  var m = u.match(/^https:\/\/www\.easa\.europa\.eu(\/[^?#\s"'<>]*)(?:[?#][^\s"'<>]*)?$/i);
  if (!m) return null;
  var caminho = m[1];
  if (caminho.indexOf("/download/") === 0 || /^\/(?:en\/)?downloads\/\d+\/en\/?$/.test(caminho)) return u.slice(0, 400);
  return null;
}
function ehistDocumentos_(html) {
  var docs = [], ra = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi, a;
  while ((a = ra.exec(String(html || "")))) {
    var href = a[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    var url = ehistDocUrl_(href ? (href[1] != null ? href[1] : href[2]) : "");
    if (!url) continue;
    var caminho = url.replace(/^https:\/\/www\.easa\.europa\.eu/i, "").split(/[?#]/)[0];
    var arquivo = "";
    try { arquivo = decodeURIComponent(caminho.split("/").pop() || ""); } catch (e) { arquivo = caminho.split("/").pop() || ""; }
    var ext = /\.([A-Za-z0-9]{1,8})$/.exec(arquivo);
    var rotulo = ehistLimpo_(easaTexto_(a[2]));
    var dica = /\b(PDF|ZIP)\b/i.exec(rotulo);
    var tipo = ext ? ext[1].toUpperCase() : (dica ? dica[1].toUpperCase() : "ARQUIVO");
    var nome = ext ? arquivo : (rotulo || "Documento");
    if (docs.some(function (d) { return d[2] === url; })) continue;
    docs.push([nome.slice(0, 160), tipo.slice(0, 10), url]);
  }
  return docs.slice(0, 12);
}

// ---- fonte 1: arquivo histórico (JSON) ------------------------------------------------------
function ehistBaixar_(url, aceita) {
  if (url !== EHIST_ARQUIVO && url !== EASA_PROVISORIA) throw new Error("endereço fora da EASA");
  var resposta = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { "Accept": aceita, "Accept-Language": "en" } });
  var codigo = resposta.getResponseCode();
  if (codigo < 200 || codigo >= 300) throw new Error("a EASA respondeu HTTP " + codigo);
  return resposta.getContentText("UTF-8").replace(/^﻿/, "");
}

function ehistLerArquivo_() {
  var payload = JSON.parse(ehistBaixar_(EHIST_ARQUIVO, "application/json"));
  var linhas = payload && payload.data;
  if (!Array.isArray(linhas) || !linhas.length) throw new Error("Resposta vazia ou inesperada do arquivo EASA");
  var itens = [];
  linhas.forEach(function (row) {
    if (!row || !ehistEhEasa_(row["AD class"], row["Class number"])) return;
    var detentor = String(row["Approval Holder / Type Designation"] || "");
    var quebra = detentor.indexOf("\n");
    itens.push([
      String(row["Class number"]).trim(),
      String(row["AD class"]),
      (quebra < 0 ? detentor : detentor.slice(0, quebra)).trim().slice(0, 300),
      (quebra < 0 ? "" : detentor.slice(quebra + 1)).trim().slice(0, 1500),
      String(row["Subject"] || "").slice(0, 600),
      ehistDataIso_(row["Issue Date"]),
      ehistDataIso_(row["Effective date"]),
      ehistDocumentos_(row["Documents"])
    ]);
  });
  if (!itens.length) throw new Error("Nenhum registro reconhecido; conferir o formato do arquivo");
  return itens;
}

// ---- fonte 2: página provisória (tabela HTML) -----------------------------------------------
// A tabela é achada pelos títulos das colunas (não pela posição), como no easa-busca.
var EHIST_COLUNAS = ["number", "issuedby", "issuedate", "subject", "approvalholdertypedesignation", "effectivedate", "attachment"];

function ehistCelulas_(trHtml) {
  return String(trHtml).split(/<td\b[^>]*>/i).slice(1).map(function (td) { return td.split(/<\/td>/i)[0]; });
}

function ehistLerProvisoria_() {
  return ehistLinhasProvisoria_(ehistBaixar_(EASA_PROVISORIA, "text/html"));
}

function ehistLinhasProvisoria_(html) {
  html = String(html || "");
  var tabelas = html.split(/<table\b/i).slice(1).map(function (t) { return t.split(/<\/table>/i)[0]; });
  var tabela = null, col = null;
  for (var i = 0; i < tabelas.length && !tabela; i += 1) {
    var thead = (tabelas[i].match(/<thead\b[\s\S]*?<\/thead>/i) || [""])[0];
    var titulos = thead.split(/<th\b[^>]*>/i).slice(1).map(function (th) { return ehistCompacto_(easaTexto_(th.split(/<\/th>/i)[0])); });
    if (EHIST_COLUNAS.every(function (c) { return titulos.indexOf(c) >= 0; })) {
      tabela = tabelas[i];
      col = {};
      EHIST_COLUNAS.forEach(function (c) { col[c] = titulos.indexOf(c); });
    }
  }
  if (!tabela) throw new Error("Tabela de publicações não encontrada; revisar o coletor da página provisória");
  var maxCol = Math.max.apply(null, EHIST_COLUNAS.map(function (c) { return col[c]; }));
  var corpo = tabela.replace(/<thead\b[\s\S]*?<\/thead>/i, "");
  var itens = [], linhasLidas = 0;
  corpo.split(/<tr\b[^>]*>/i).slice(1).forEach(function (bloco) {
    var tds = ehistCelulas_(bloco.split(/<\/tr>/i)[0]);
    if (!tds.length) return;
    linhasLidas += 1;
    if (tds.length <= maxCol) throw new Error("Número de colunas inesperado na página provisória");
    var numero = ehistLimpo_(easaTexto_(tds[col.number]));
    var celEmissor = tds[col.issuedby];
    var aria = String(celEmissor).match(/\b(?:aria-label|title|alt)\s*=\s*["']([^"']{1,60})["']/i);
    var emissor = (ehistLimpo_(easaTexto_(celEmissor)) || (aria ? ehistLimpo_(aria[1]) : "")).toUpperCase();
    var assunto = ehistLimpo_(easaTexto_(String(tds[col.subject])
      .replace(/<span class=["']spamspan["'][\s\S]*?<\/span><\/span>/gi, " ")
      .replace(/<a[^>]+mailto:[\s\S]*?<\/a>/gi, " ")));
    var classe = numero.toUpperCase().indexOf("-E") >= 0 ? "EAD" : "AD";
    // "EU" declara o emissor; o formato do número também exclui as PADs.
    if (!(emissor === "EU" || emissor === "EUROPEAN UNION") || !ehistEhEasa_(classe, numero)) return;
    if (/^\s*(?:proposed\s+(?:AD|airworthiness\s+directive)\b|PAD\s*:)/i.test(assunto)) return;
    var emissao = ehistDataIso_(easaTexto_(tds[col.issuedate]));
    if (!emissao) throw new Error("Data de emissão inválida na página provisória: " + numero);
    var dm = ehistDetentor_(tds[col.approvalholdertypedesignation]);
    itens.push([numero, classe, dm[0].slice(0, 300), dm[1].slice(0, 1500), assunto.slice(0, 600), emissao,
      ehistDataIso_(easaTexto_(tds[col.effectivedate])), ehistDocumentos_(tds[col.attachment])]);
  });
  if (!linhasLidas) throw new Error("Tabela provisória vazia; mantendo a última consulta disponível");
  return itens;
}

// Detentor / modelos. Há dois layouts reais: detentor em <p> + lista de modelos, ou detentor no
// 1º nível de uma lista e os modelos nos níveis de dentro. Lê as tags em ordem (sem DOM).
function ehistDetentor_(celula) {
  var html = String(celula || "");
  var ps = [], lis = [], pilha = [], profLista = 0, emP = null, re = /<(\/?)(ul|ol|li|p)\b[^>]*>|([^<]+)|<[^>]*>/gi, m;
  while ((m = re.exec(html))) {
    if (m[3] != null) {
      var txt = m[3];
      if (pilha.length) pilha[pilha.length - 1].txt += txt;
      else if (emP !== null) emP += txt;
      continue;
    }
    if (!m[2]) continue;
    var fecha = m[1] === "/", tag = m[2].toLowerCase();
    if (tag === "ul" || tag === "ol") { profLista += fecha ? -1 : 1; if (profLista < 0) profLista = 0; continue; }
    if (tag === "p") {
      if (pilha.length) continue;            // <p> dentro de <li>: o texto já vai para o item
      if (!fecha) emP = ""; else if (emP !== null) { ps.push(emP); emP = null; }
      continue;
    }
    if (!fecha) pilha.push({ prof: profLista, txt: "" });
    else if (pilha.length) lis.push(pilha.pop());
  }
  while (pilha.length) lis.push(pilha.pop());
  if (emP !== null) ps.push(emP);
  var limpa = function (t) { return ehistLimpo_(easaTexto_(t)); };
  var detentores = ps.map(limpa).filter(Boolean), modelos = [];
  lis = lis.map(function (l) { return { prof: l.prof, txt: limpa(l.txt) }; });
  if (detentores.length) {
    modelos = lis.map(function (l) { return l.txt; });
  } else {
    lis.forEach(function (l) { if (l.prof <= 1) detentores.push(l.txt); else modelos.push(l.txt); });
  }
  if (!detentores.filter(Boolean).length) {
    var partes = html.replace(/<br\s*\/?>|<\/(?:p|li|div)>/gi, "\n").split("\n").map(limpa).filter(Boolean);
    detentores = partes.slice(0, 1);
    modelos = partes.slice(1);
  }
  var unicos = function (lista) { var v = {}; return lista.filter(function (x) { if (!x || v[x]) return false; v[x] = true; return true; }); };
  return [unicos(detentores).join(" / "), unicos(modelos).join("/")];
}

// ---- cache (CacheService compactado + reserva no Drive) -------------------------------------
function ehistChave_(nome, parte) { return "ehist_v1_" + nome + "_" + parte; }

function ehistGravarCache_(cache, nome, itens, quando) {
  var b64 = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(itens), "application/json")).getBytes());
  var valores = {}, n = Math.ceil(b64.length / EHIST_PEDACO);
  for (var i = 0; i < n; i += 1) valores[ehistChave_(nome, "p" + i)] = b64.slice(i * EHIST_PEDACO, (i + 1) * EHIST_PEDACO);
  valores[ehistChave_(nome, "meta")] = JSON.stringify({ at: quando, ms: new Date(quando).getTime(), pedacos: n, total: itens.length });
  cache.putAll(valores, EHIST_GUARDAR_S);
}

function ehistLerCache_(cache, nome) {
  var metaTxt = cache.get(ehistChave_(nome, "meta"));
  if (!metaTxt) return null;
  var meta = JSON.parse(metaTxt), chaves = [];
  for (var i = 0; i < meta.pedacos; i += 1) chaves.push(ehistChave_(nome, "p" + i));
  var achados = cache.getAll(chaves), b64 = "";
  for (var j = 0; j < chaves.length; j += 1) {
    if (achados[chaves[j]] == null) return null;      // um pedaço saiu do cache: lê de novo
    b64 += achados[chaves[j]];
  }
  var json = Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(b64), "application/x-gzip")).getDataAsString("UTF-8");
  return { at: meta.at, ms: meta.ms, itens: JSON.parse(json) };
}

function ehistReservaLer_() {
  try {
    var id = PropertiesService.getScriptProperties().getProperty(EHIST_RESERVA_PROP);
    if (!id) return null;
    return JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString("UTF-8"));
  } catch (e) { console.warn("easa-historico: reserva do Drive indisponível: " + e); return null; }
}

function ehistReservaGravar_(nome, itens, quando) {
  try {
    var props = PropertiesService.getScriptProperties();
    var reserva = ehistReservaLer_() || {};
    reserva[nome] = { at: quando, itens: itens };
    var json = JSON.stringify(reserva), id = props.getProperty(EHIST_RESERVA_PROP);
    if (id) DriveApp.getFileById(id).setContent(json);
    else props.setProperty(EHIST_RESERVA_PROP, DriveApp.createFile(EHIST_RESERVA_NOME, json, MimeType.PLAIN_TEXT).getId());
  } catch (e) { console.warn("easa-historico: não gravou a reserva no Drive: " + e); }
}

// Lê uma fonte: cache novo (< 1 h) ou baixa de novo; se falhar, usa a última leitura guardada.
function ehistFonte_(nome, url, ler, forcar, reservaRef) {
  var cache = CacheService.getScriptCache();
  var atual = null;
  try { atual = ehistLerCache_(cache, nome); } catch (e) { atual = null; }
  var agora = Date.now();
  var fresco = atual && agora - atual.ms < EHIST_TTL_S * 1000;
  var bloqueado = Boolean(cache.get(ehistChave_(nome, "retry")));
  var erro = bloqueado && !fresco;
  if ((!fresco || forcar) && (!bloqueado || forcar)) {
    var trava = LockService.getScriptLock();
    if (trava.tryLock(atual ? 3000 : 25000)) {
      try {
        // Outra execução pode ter acabado de atualizar enquanto esperávamos a trava.
        var outro = null;
        try { outro = ehistLerCache_(cache, nome); } catch (e) { outro = null; }
        if (!forcar && outro && Date.now() - outro.ms < EHIST_TTL_S * 1000) {
          atual = outro; erro = false;
        } else {
          try {
            var itens = ler();
            var quando = new Date().toISOString();
            ehistGravarCache_(cache, nome, itens, quando);
            cache.remove(ehistChave_(nome, "retry"));
            ehistReservaGravar_(nome, itens, quando);
            atual = { at: quando, ms: Date.now(), itens: itens };
            erro = false;
          } catch (e) {
            console.error("Falha ao consultar a fonte EASA " + nome + ": " + ((e && e.stack) || e));
            cache.put(ehistChave_(nome, "retry"), "1", EHIST_RETRY_S);
            erro = true;
            if (outro) atual = outro;
          }
        }
      } finally { trava.releaseLock(); }
    }
  }
  if (!atual) {
    if (reservaRef.dados === undefined) reservaRef.dados = ehistReservaLer_();
    var r = reservaRef.dados && reservaRef.dados[nome];
    if (r && Array.isArray(r.itens) && r.itens.length) { atual = { at: r.at, ms: new Date(r.at).getTime(), itens: r.itens }; erro = true; }
  }
  var status = !atual ? "indisponivel" : (erro ? "cache_antigo" : "atualizado");
  return { itens: atual ? atual.itens : null, estado: { nome: nome, url: url, status: status, consultadoEm: atual ? atual.at : null, total: atual ? atual.itens.length : 0 } };
}

function ehistCarregar_(forcar) {
  var reservaRef = {};
  var arq = ehistFonte_("arquivo", EHIST_ARQUIVO, ehistLerArquivo_, forcar, reservaRef);
  var prov = ehistFonte_("provisoria", EASA_PROVISORIA, ehistLerProvisoria_, forcar, reservaRef);
  if (!arq.itens && !prov.itens) return null;
  return { itens: ehistJuntar_(arq.itens || [], prov.itens || []), fontes: [arq.estado, prov.estado] };
}

// ---- junção, filtro e saída -----------------------------------------------------------------
// Item guardado: [numero, classe, fabricante, modelo, assunto, emissao, efetividade, docs]; na junção
// ganha [8] = fontes onde aparece e [9] = fonte do registro que valeu.
function ehistJuntar_(arquivo, provisoria) {
  var mapa = {};
  var marcar = function (lista, fonte) { return lista.map(function (it) { var x = it.slice(0, 8); x[8] = [fonte]; x[9] = fonte; return x; }); };
  // Igual à tupla (emissão, é_provisória) do easa-busca: compara a data e, no empate, a fonte.
  var ganha = function (a, b) {
    var da = a[5] || "", db = b[5] || "";
    if (da !== db) return da > db;
    return (a[9] === "provisoria" ? 1 : 0) >= (b[9] === "provisoria" ? 1 : 0);
  };
  marcar(arquivo, "arquivo").concat(marcar(provisoria, "provisoria")).forEach(function (item) {
    var chave = ehistCompacto_(item[0]);      // R1/R2 continuam separados da edição original
    var antes = mapa[chave];
    if (!antes) { mapa[chave] = item; return; }
    // Data de emissão mais nova vence; empate: vence a página provisória.
    var principal = ganha(item, antes) ? item : antes, reserva = principal === item ? antes : item;
    var novo = principal.slice();
    novo[2] = principal[2] || reserva[2];
    novo[3] = principal[3] || reserva[3];
    novo[7] = (principal[7] && principal[7].length) ? principal[7] : reserva[7];
    var fontes = {};
    antes[8].concat(item[8]).forEach(function (f) { fontes[f] = true; });
    novo[8] = Object.keys(fontes).sort();
    mapa[chave] = novo;
  });
  return Object.keys(mapa).map(function (k) { return mapa[k]; }).sort(function (a, b) {
    var da = a[5] || "", db = b[5] || "";      // sem data vai para o fim (como no easa-busca)
    if (da !== db) return da < db ? 1 : -1;
    return a[0] < b[0] ? 1 : (a[0] > b[0] ? -1 : 0);
  });
}

function ehistFiltrar_(itens, filtros) {
  var q = { numero: ehistCompacto_(filtros.numero), modelo: ehistCompacto_(filtros.modelo), fabricante: ehistCompacto_(filtros.fabricante) };
  if (!q.numero && !q.modelo && !q.fabricante) return itens;
  return itens.filter(function (it) {
    return (!q.numero || ehistCompacto_(it[0]).indexOf(q.numero) >= 0) &&
      (!q.modelo || ehistCompacto_(it[3]).indexOf(q.modelo) >= 0) &&
      // "fabricante" procura no detentor E no assunto (Subject), para achar o fabricante
      // do componente ou o nome do componente (ex.: "Thales", "starter generator").
      (!q.fabricante || ehistCompacto_(it[2]).indexOf(q.fabricante) >= 0 || ehistCompacto_(it[4]).indexOf(q.fabricante) >= 0);
  });
}

function ehistSaida_(it) {
  var prov = it[9] === "provisoria";
  return {
    numero: it[0], classe: it[1], fabricante: it[2], modelo: it[3], assunto: it[4],
    emissao: it[5] || null, efetividade: it[6] || null,
    documentos: (it[7] || []).map(function (d) { return { nome: d[0], tipo: d[1], url: d[2] }; }),
    fontes: it[8],
    fonteUrl: prov ? EASA_PROVISORIA : EHIST_ARQUIVO,
    criterioOrigem: prov ? "Emissor EU informado pela EASA" : "Numeração EASA (inferida do arquivo)"
  };
}

// ---- gatilho opcional e teste ---------------------------------------------------------------
function ehistAtualizarGatilho() { ehistCarregar_(true); }

function instalarHistoricoEasa() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "ehistAtualizarGatilho") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("ehistAtualizarGatilho").timeBased().everyHours(1).create();
  testeHistoricoEasa();
}

function testeHistoricoEasa() {
  var r = ehistBusca_({ modelo: "AS 350" });
  console.log(JSON.stringify({ ok: r.ok, erro: r.erro, total: r.total, totalEasa: r.totalEasa, fontes: r.fontes, ms: r.ms, primeiro: r.resultados && r.resultados[0] }, null, 2));
}

