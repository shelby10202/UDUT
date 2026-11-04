// Busca de ADs da EASA — site independente (HTML/CSS/JS estáticos, sem login e sem banco de dados).
// A busca roda num App da Web do Google Apps Script (apps-script/Codigo.gs), que lê o arquivo
// histórico da EASA e a página provisória de publicações recentes, junta as duas e devolve JSON.
// O endereço do App da Web fica em config.js. Tudo o que vem da EASA é escrito com textContent
// (nunca como HTML) e só são aceitos links de documentos do próprio site da EASA.
import { APPS_SCRIPT_URL } from "./config.js";

const TIMEOUT_MS = 90000; // a 1ª consulta da hora baixa o arquivo histórico da EASA (alguns MB)
const MAX_FILTRO = 120;
const FILTROS = ["numero", "modelo", "fabricante"];

const $ = (id) => document.getElementById(id);
const el = {
  form: $("filtros"), msg: $("formMsg"), go: $("buscar"), lista: $("lista"), count: $("contagem"),
  aviso: $("aviso"), vazio: $("vazio"), pager: $("paginacao"), prev: $("anterior"), next: $("proxima"),
  pagina: $("paginaAtual"), meta: $("meta"), tema: $("tema")
};
let filtros = { numero: "", modelo: "", fabricante: "" };
let pagina = 1, paginas = 1, sequencia = 0;

// ---- tema claro/escuro (o tema-inicial.js já aplicou o salvo antes de pintar a página) -------
function temaAtual() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
function atualizarBotaoTema() {
  const escuro = temaAtual() === "dark";
  el.tema.setAttribute("aria-label", escuro ? "Mudar para o tema claro" : "Mudar para o tema escuro");
  el.tema.title = escuro ? "Tema claro" : "Tema escuro";
}
el.tema.addEventListener("click", () => {
  const novo = temaAtual() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = novo;
  try { localStorage.setItem("tema", novo); } catch { /* sem armazenamento: vale só nesta visita */ }
  atualizarBotaoTema();
});
atualizarBotaoTema();

// ---- util ----------------------------------------------------------------------------------
// Igual ao servidor: sem acento, minúsculas, só letras e números (AS 350 = as350).
function compacto(valor) {
  return String(valor == null ? "" : valor).normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
function dataBr(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "não informada";
}
function no(tag, texto, classe) {
  const n = document.createElement(tag);
  if (texto !== undefined && texto !== null) n.textContent = String(texto);
  if (classe) n.className = classe;
  return n;
}
// Só documentos do próprio www.easa.europa.eu (/download/... ou /downloads/<id>/en).
function urlDocumento(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "https:" || u.host !== "www.easa.europa.eu") return "";
    if (!(u.pathname.startsWith("/download/") || /^\/(?:en\/)?downloads\/\d+\/en\/?$/.test(u.pathname))) return "";
    return u.href;
  } catch { return ""; }
}
// O App da Web tem de ser do Google.
function urlAppsScript(url) {
  const t = String(url || "").trim();
  return /^https:\/\/script\.google(?:usercontent)?\.com\/[^\s"'<>]+$/i.test(t) ? t : "";
}
const appsScriptUrl = urlAppsScript(APPS_SCRIPT_URL);

// ---- render --------------------------------------------------------------------------------
function cartao(item) {
  const rec = no("article", null, "registro");
  const correcao = /^\s*\[correction\]/i.test(String(item.assunto || ""));
  const id = no("div", null, "registro-id");
  id.append(no("h3", item.numero, "registro-numero"));
  const selos = no("p", null, "selos");
  selos.append(no("span", item.classe || "AD", "selo"));
  if (correcao) selos.append(no("span", "Correção", "selo selo-alerta"));
  id.append(selos);
  // Numa correção a EASA informa a data da correção como emissão (pode ser depois da efetividade).
  id.append(
    no("p", `${correcao ? "Emissão (correção)" : "Emissão"}: ${dataBr(item.emissao)}`, "registro-data"),
    no("p", `Efetividade: ${dataBr(item.efetividade)}`, "registro-data")
  );
  const prov = Array.isArray(item.fontes) && item.fontes.includes("provisoria");
  id.append(no("p", prov ? "Página provisória" : "Arquivo histórico", `registro-fonte${prov ? " is-recente" : ""}`));

  const det = no("div", null, "registro-corpo");
  det.append(no("h3", item.fabricante || "Detentor não informado", "registro-detentor"));
  // Modelos como a EASA escreve: "/" separa modelos, mas também faz parte de nomes (RTM 322-01/9).
  if (item.modelo) det.append(no("p", String(item.modelo), "registro-modelos"));
  det.append(no("p", String(item.assunto || "").replace(/^\s*\[correction\]\s*/i, ""), "registro-assunto"));
  const docs = no("div", null, "registro-docs");
  (Array.isArray(item.documentos) ? item.documentos : []).forEach((d) => {
    const href = urlDocumento(d && d.url);
    if (!href) return;
    const tipo = String((d && d.tipo) || "").toUpperCase().slice(0, 10);
    const a = no("a", `${tipo === "PDF" ? "Documento" : "Anexo"} ${tipo || "ARQUIVO"} ↗`, "text-link");
    a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.title = String((d && d.nome) || "");
    a.setAttribute("aria-label", `${item.numero}: ${(d && d.nome) || "documento"} (abre o site da EASA)`);
    docs.append(a);
  });
  if (!docs.children.length) docs.append(no("span", "Sem documento vinculado na fonte.", "registro-sem-doc"));
  det.append(docs);
  rec.append(id, det);
  return rec;
}

function textoFontes(fontes) {
  return (fontes || []).map((f) => {
    const nome = f.nome === "arquivo" ? "Arquivo histórico" : "Página provisória";
    if (f.status === "indisponivel") return `${nome}: indisponível`;
    const quando = f.consultadoEm ? new Date(f.consultadoEm).toLocaleString("pt-BR") : "—";
    return `${nome}: consulta em ${quando}${f.status === "cache_antigo" ? " (consulta armazenada)" : ""}`;
  }).join(" · ");
}
function avisosFontes(fontes) {
  return (fontes || []).filter((f) => f.status !== "atualizado").map((f) => {
    const nome = f.nome === "arquivo" ? "o arquivo histórico" : "a página provisória";
    return f.status === "indisponivel"
      ? `Falha ao consultar ${nome}. Os resultados desta fonte não estão incluídos.`
      : `${nome.charAt(0).toUpperCase()}${nome.slice(1)} está indisponível. Usando a última consulta armazenada desta fonte.`;
  });
}
function mostrarAviso(texto, erro = false) {
  el.aviso.textContent = texto || "";
  el.aviso.hidden = !texto;
  el.aviso.classList.toggle("is-erro", Boolean(erro));
}

// ---- busca ---------------------------------------------------------------------------------
function sincronizarUrl() {
  try {
    const q = new URLSearchParams();
    FILTROS.forEach((k) => { if (filtros[k]) q.set(k, filtros[k]); });
    if (pagina > 1) q.set("pagina", String(pagina));
    const s = q.toString();
    history.replaceState(null, "", s ? `${location.pathname}?${s}` : location.pathname);
  } catch { /* sem histórico: segue */ }
}

async function buscar(alvo = 1) {
  const atual = ++sequencia;
  mostrarAviso("");
  el.count.textContent = "Consultando a EASA…";
  el.lista.setAttribute("aria-busy", "true");
  el.prev.disabled = true; el.next.disabled = true; el.go.disabled = true;
  const lento = setTimeout(() => {
    if (atual === sequencia) el.count.textContent = "Consultando a EASA… a primeira consulta da hora baixa o arquivo histórico e pode levar até 1 minuto.";
  }, 6000);
  try {
    if (!appsScriptUrl) throw new Error("A busca ainda não está configurada: coloque a URL do App da Web (Apps Script) em config.js.");
    const q = new URLSearchParams({ ...filtros, pagina: String(alvo) });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${appsScriptUrl}${appsScriptUrl.includes("?") ? "&" : "?"}${q}`, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: ctrl.signal });
    } catch (error) {
      throw new Error(error && error.name === "AbortError" ? "A EASA demorou demais para responder. Tente de novo em alguns instantes." : "Não foi possível falar com o servidor da busca agora. Confira a conexão e tente de novo.");
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new Error(`O servidor da busca respondeu HTTP ${res.status}.`);
    let dados;
    try { dados = await res.json(); } catch { throw new Error("O servidor da busca respondeu num formato inesperado. Confira a URL em config.js e se o App da Web está publicado para “Qualquer pessoa”."); }
    if (!dados || dados.ok === false || !Array.isArray(dados.resultados)) {
      throw new Error((dados && dados.erro) || "O servidor da busca respondeu sem resultados. Confira se o Codigo.gs publicado é o desta pasta.");
    }
    if (atual !== sequencia) return;
    pagina = Number(dados.pagina) || 1; paginas = Number(dados.paginas) || 1;
    el.lista.replaceChildren(...dados.resultados.map(cartao));
    const total = Number(dados.total) || 0;
    el.count.textContent = `${total.toLocaleString("pt-BR")} ${total === 1 ? "diretriz encontrada" : "diretrizes encontradas"} de ${(Number(dados.totalEasa) || 0).toLocaleString("pt-BR")}`;
    el.vazio.hidden = total !== 0;
    el.pager.hidden = paginas <= 1;
    el.pagina.textContent = `Página ${pagina} de ${paginas}`;
    el.prev.disabled = pagina <= 1; el.next.disabled = pagina >= paginas;
    el.meta.textContent = textoFontes(dados.fontes);
    const avisos = avisosFontes(dados.fontes);
    if (avisos.length) mostrarAviso(avisos.join(" "));
    sincronizarUrl();
  } catch (error) {
    if (atual !== sequencia) return;
    el.lista.replaceChildren(); el.vazio.hidden = true; el.pager.hidden = true; el.meta.textContent = "";
    el.count.textContent = "Consulta não concluída";
    mostrarAviso(error && error.message ? error.message : "Não foi possível consultar a EASA.", true);
  } finally {
    clearTimeout(lento);
    if (atual === sequencia) { el.lista.setAttribute("aria-busy", "false"); el.go.disabled = false; }
  }
}

function lerFormulario() {
  const f = {};
  FILTROS.forEach((k) => { f[k] = String(el.form.elements[k].value || "").trim(); });
  return f;
}
function validar(f) {
  if (FILTROS.some((k) => f[k].length > MAX_FILTRO)) return "Use até 120 caracteres em cada filtro.";
  if (FILTROS.some((k) => f[k] && !compacto(f[k]))) return "Informe letras ou números nos filtros.";
  return "";
}

el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const rascunho = lerFormulario();
  const erro = validar(rascunho);
  el.msg.textContent = erro;
  el.msg.classList.toggle("is-erro", Boolean(erro));
  if (erro) return;
  filtros = rascunho;
  buscar(1);
});
el.form.addEventListener("reset", () => {
  el.msg.textContent = ""; el.msg.classList.remove("is-erro");
  filtros = { numero: "", modelo: "", fabricante: "" };
  setTimeout(() => buscar(1), 0);
});
el.prev.addEventListener("click", () => { buscar(pagina - 1); el.lista.scrollIntoView({ block: "start" }); });
el.next.addEventListener("click", () => { buscar(pagina + 1); el.lista.scrollIntoView({ block: "start" }); });

// ---- início --------------------------------------------------------------------------------
// Filtros vindos do link (ex.: ?modelo=AS350) — dá para mandar uma busca pronta.
try {
  const q = new URLSearchParams(location.search);
  FILTROS.forEach((k) => { const v = String(q.get(k) || "").trim().slice(0, MAX_FILTRO); if (v) { filtros[k] = v; el.form.elements[k].value = v; } });
  const p = Number(q.get("pagina"));
  if (Number.isInteger(p) && p > 1) pagina = p;
} catch { /* sem parâmetros */ }
if (validar(filtros)) filtros = { numero: "", modelo: "", fabricante: "" };
buscar(pagina);
