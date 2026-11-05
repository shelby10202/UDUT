// Painel do administrador — indicadores de uso da busca de ADs.
// Pede os números ao servidor da busca (Apps Script, POST {acao:"painel", senha, dias}); a senha é
// a propriedade ADMIN_SENHA do script. Tudo que vem do servidor é escrito com textContent.
import { APPS_SCRIPT_URL } from "./config.js";

const $ = (id) => document.getElementById(id);
const el = {
  login: $("login"), loginForm: $("loginForm"), senha: $("senha"), lembrar: $("lembrar"), entrar: $("entrar"), loginMsg: $("loginMsg"),
  painel: $("painel"), periodo: $("periodo"), atualizar: $("atualizar"), planilha: $("planilha"), status: $("status"),
  conteudo: $("conteudoPainel"), kpis: $("kpis"), graficos: $("graficos"), dica: $("dica"), sair: $("sair"), tema: $("tema")
};
const appsScriptUrl = /^https:\/\/script\.google(?:usercontent)?\.com\/[^\s"'<>]+$/i.test(String(APPS_SCRIPT_URL || "").trim()) ? String(APPS_SCRIPT_URL).trim() : "";
const semMovimento = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let senha = "";
let dias = 7;
let dados = null;
let pedido = 0;
const tabelasAbertas = new Set();

// ---- tema ----------------------------------------------------------------------------------
function atualizarBotaoTema() {
  const escuro = document.documentElement.dataset.theme === "dark";
  el.tema.setAttribute("aria-label", escuro ? "Mudar para o tema claro" : "Mudar para o tema escuro");
}
el.tema.addEventListener("click", () => {
  const novo = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  const aplicar = () => {
    document.documentElement.dataset.theme = novo;
    try { localStorage.setItem("tema", novo); } catch { /* vale só nesta visita */ }
    atualizarBotaoTema();
  };
  if (document.startViewTransition && !semMovimento()) document.startViewTransition(aplicar); else aplicar();
});
atualizarBotaoTema();

// ---- util ----------------------------------------------------------------------------------
function no(tag, texto, classe) {
  const n = document.createElement(tag);
  if (texto !== undefined && texto !== null) n.textContent = String(texto);
  if (classe) n.className = classe;
  return n;
}
const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
function duracao(seg) {
  const s = Math.max(0, Math.round(Number(seg) || 0));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
function tempo(ms) {
  const n = Math.round(Number(ms) || 0);
  return n >= 1000 ? `${(n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s` : `${n} ms`;
}
const diaCurto = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const diaLongo = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
// Topo do eixo = 4 passos "redondos" (1, 2 ou 5 × 10^n, nunca fração): marcas 0, 5, 10, 15, 20.
function maxBonito(v) {
  const bruto = Math.max(1, v / 4);
  const p = Math.pow(10, Math.floor(Math.log10(bruto)));
  const f = bruto / p;
  return Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p) * 4;
}

// ---- dica (tooltip): valor primeiro, nome da série depois -------------------------------------
function mostrarDica(alvo, titulo, linhas) {
  el.dica.replaceChildren();
  el.dica.append(no("p", titulo, "dica-titulo"));
  linhas.forEach(([nome, valor, cls]) => {
    const l = no("p", null, "dica-linha");
    if (cls) l.append(no("i", null, `dica-chave ${cls}`));
    l.append(no("strong", valor), no("span", nome));
    el.dica.append(l);
  });
  el.dica.hidden = false;
  const r = alvo.getBoundingClientRect(), d = el.dica.getBoundingClientRect();
  let x = r.left + r.width / 2 - d.width / 2, y = r.top - d.height - 10;
  x = Math.max(8, Math.min(innerWidth - d.width - 8, x));
  if (y < 8) y = r.bottom + 10;
  el.dica.style.transform = `translate(${Math.round(x + scrollX)}px, ${Math.round(y + scrollY)}px)`;
}
function esconderDica() { el.dica.hidden = true; }
function ligarDica(alvo, titulo, linhas) {
  alvo.tabIndex = 0;
  alvo.setAttribute("aria-label", `${titulo}: ${linhas.map(([n, v]) => `${n} ${v}`).join(", ")}`);
  const abrir = () => mostrarDica(alvo, titulo, linhas);
  alvo.addEventListener("pointerenter", abrir);
  alvo.addEventListener("focus", abrir);
  alvo.addEventListener("pointerleave", esconderDica);
  alvo.addEventListener("blur", esconderDica);
}
window.addEventListener("scroll", esconderDica, { passive: true });

// ---- gráficos ------------------------------------------------------------------------------
// Colunas (empilhadas ou agrupadas) com eixo de 0 ao "máximo bonito", grade de 4 linhas.
function colunas(baldes, series, { agrupado = false, formatar = fmt, cadaRotulo = 1 } = {}) {
  const total = (b) => (agrupado ? Math.max(...b.valores) : b.valores.reduce((a, v) => a + v, 0));
  const max = maxBonito(Math.max(0, ...baldes.map(total)));
  const raiz = no("div", null, "grafico");
  const eixo = no("div", null, "eixo-y");
  const area = no("div", null, "area");
  for (let i = 4; i >= 0; i -= 1) {
    eixo.append(no("span", formatar(Math.round((max * i) / 4))));
    const g = no("i", null, i === 0 ? "grade base" : "grade");
    g.style.bottom = `${(i / 4) * 100}%`;
    area.append(g);
  }
  const cols = no("div", null, "colunas");
  baldes.forEach((b, k) => {
    const banda = no("div", null, "banda");
    banda.style.setProperty("--i", String(k));
    const pilha = no("div", null, agrupado ? "grupo" : "pilha");
    b.valores.forEach((v, s) => {
      if (!agrupado && !v) return;
      const seg = no("i", null, `seg ${series[s].cls}`);
      seg.style.height = `${(v / max) * 100}%`;
      pilha.append(seg);
    });
    banda.append(pilha);
    ligarDica(banda, b.dica, series.map((s, i) => [s.nome, formatar(b.valores[i]), s.cls]));
    cols.append(banda);
  });
  area.append(cols);
  const rotulos = no("div", null, "eixo-x");
  baldes.forEach((b, k) => rotulos.append(no("span", k % cadaRotulo === 0 ? b.rotulo : "")));
  raiz.append(eixo, area, no("span", null, "canto"), rotulos);
  return raiz;
}
// Barras horizontais com rótulo e valor diretos (uma série só).
function barras(linhas, nomeSerie) {
  if (!linhas.length || !linhas.some((l) => l.n > 0)) return no("p", "Nada no período.", "vazio-grafico");
  const max = Math.max(...linhas.map((l) => l.n)) || 1;
  const raiz = no("div", null, "barras");
  linhas.forEach((l, k) => {
    const linha = no("div", null, "barra-linha");
    linha.style.setProperty("--i", String(k));
    const trilho = no("div", null, "trilho");
    const b = no("i", null, "barra s1");
    b.style.width = `${Math.max(l.n ? 1.5 : 0, (l.n / max) * 100)}%`;
    trilho.append(b);
    linha.append(no("span", l.rotulo, "barra-rotulo"), trilho, no("strong", fmt(l.n), "barra-valor"));
    ligarDica(linha, l.rotulo, [[nomeSerie, fmt(l.n), "s1"]]);
    raiz.append(linha);
  });
  return raiz;
}
function tabela(cabecalho, linhas) {
  if (!linhas.length) return no("p", "Nada no período.", "vazio-grafico");
  const wrap = no("div", null, "tabela-wrap");
  const t = no("table", null, "tabela");
  const thead = no("thead"), tr = no("tr");
  const ehNum = (c) => typeof c === "string" && /^[\d.,\s%]+(ms|s|min)?$/.test(c);
  const numCol = cabecalho.map((_, i) => i > 0 && linhas.every((l) => ehNum(l[i])));
  cabecalho.forEach((h, i) => tr.append(no("th", h, numCol[i] ? "num" : "")));
  thead.append(tr);
  const tbody = no("tbody");
  linhas.forEach((l) => {
    const r = no("tr");
    l.forEach((c, i) => r.append(no("td", c, numCol[i] ? "num" : "")));
    tbody.append(r);
  });
  t.append(thead, tbody);
  wrap.append(t);
  return wrap;
}
function legenda(series) {
  const l = no("div", null, "legenda");
  series.forEach((s) => { const it = no("span"); it.append(no("i", null, `chave ${s.cls}`), document.createTextNode(s.nome)); l.append(it); });
  return l;
}
function cartaoGrafico(id, { titulo, subtitulo, series = null, grafico, tabela: tab = null, largo = false }) {
  const c = no("article", null, `cartao-grafico${largo ? " largo" : ""}`);
  const cab = no("header", null, "cartao-cab");
  const txt = no("div");
  txt.append(no("h3", titulo));
  if (subtitulo) txt.append(no("p", subtitulo));
  cab.append(txt);
  const corpo = no("div", null, "cartao-corpo");
  const aberto = tabelasAbertas.has(id);
  if (tab) {
    const b = no("button", aberto ? "Ver gráfico" : "Ver tabela", "alternar");
    b.type = "button";
    b.setAttribute("aria-pressed", String(aberto));
    b.addEventListener("click", () => {
      if (tabelasAbertas.has(id)) tabelasAbertas.delete(id); else tabelasAbertas.add(id);
      render();
    });
    cab.append(b);
  }
  c.append(cab);
  if (series && series.length > 1 && !aberto) c.append(legenda(series));
  corpo.append(aberto && tab ? tab : grafico);
  c.append(corpo);
  return c;
}

// ---- KPIs ----------------------------------------------------------------------------------
function kpi(rotulo, valor, nota = "", tom = "") {
  const k = no("article", null, `kpi${tom ? ` tom-${tom}` : ""}`);
  const r = no("span", null, "kpi-rotulo");
  if (tom) r.append(no("i", tom === "crit" ? "!!" : "!", "kpi-icone"));
  r.append(document.createTextNode(rotulo));
  k.append(r, no("strong", valor, "kpi-valor"));
  if (nota) k.append(no("small", nota));
  return k;
}

// ---- render --------------------------------------------------------------------------------
function render() {
  esconderDica();
  if (!dados) return;
  const t = dados.totais || {};
  const erroPct = pct(t.erro, t.buscas), vazioPct = pct(t.vazio, t.buscas);
  el.kpis.replaceChildren(
    kpi("Buscas", fmt(t.buscas), t.buscas ? `${fmt(t.ok)} com resultado · ${fmt(t.vazio)} sem resultado` : "nenhuma no período"),
    kpi("Sessões", fmt(dados.sessoes), `${fmt((dados.funil || [])[1]?.n)} buscaram com filtro`),
    kpi("Visitantes", fmt(dados.visitantes), dados.online ? `${fmt(dados.online)} online agora` : "ninguém online agora"),
    kpi("Acessos à página", fmt(t.acessos), `${fmt(t.documentos)} ${t.documentos === 1 ? "documento aberto" : "documentos abertos"}`),
    kpi("Tempo médio por sessão", duracao(dados.sessoesComTempo ? t.segundos / dados.sessoesComTempo : 0), `${duracao(t.segundos)} de uso no total`),
    kpi("Tempo de resposta", tempo(dados.ms?.media), dados.ms?.mediana ? `mediana ${tempo(dados.ms.mediana)} · 95% até ${tempo(dados.ms.p95)}` : "no servidor", dados.ms?.media >= 20000 ? "warn" : ""),
    kpi("Erros", fmt(t.erro), t.buscas ? `${erroPct}% das buscas${t.parcial ? ` · ${fmt(t.parcial)} com fonte parcial` : ""}` : "", erroPct >= 20 ? "crit" : t.erro ? "warn" : ""),
    kpi("Sem resultado", `${vazioPct}%`, `${fmt(t.vazio)} buscas sem nenhuma AD`, t.buscas && vazioPct >= 40 ? "warn" : "")
  );

  if (!dados.eventos) {
    el.graficos.replaceChildren(no("p", "Nenhum uso registrado no período. Os indicadores aparecem assim que alguém usar a busca.", "vazio-painel"));
    return;
  }
  const porDia = dados.porDia || [];
  const cada = porDia.length > 14 ? Math.ceil(porDia.length / 10) : 1;
  const sRes = [{ nome: "Com resultado", cls: "st-good" }, { nome: "Sem resultado", cls: "st-warn" }, { nome: "Fonte parcial", cls: "st-serious" }, { nome: "Erro", cls: "st-crit" }];
  const sAce = [{ nome: "Sessões", cls: "s1" }, { nome: "Visitantes", cls: "s2" }];
  const bRes = porDia.map((d) => ({ rotulo: diaCurto(d.dia), dica: diaLongo(d.dia), valores: [d.ok, d.vazio, d.parcial, d.erro] }));
  const bAce = porDia.map((d) => ({ rotulo: diaCurto(d.dia), dica: diaLongo(d.dia), valores: [d.sessoes, d.visitantes] }));
  const bMs = porDia.map((d) => ({ rotulo: diaCurto(d.dia), dica: diaLongo(d.dia), valores: [d.msMedia] }));
  const bHora = (dados.horas || []).map((v, h) => ({ rotulo: `${String(h).padStart(2, "0")}h`, dica: `${String(h).padStart(2, "0")}h às ${String(h).padStart(2, "0")}h59`, valores: [v] }));
  const linhasTab = (bs, nomes, f = fmt) => bs.map((b) => [b.dica, ...b.valores.map(f)]);
  const statusTxt = { ok: "com resultado", vazio: "sem resultado", parcial: "fonte parcial", cache_antigo: "consulta armazenada", erro: "erro" };
  const recentes = (dados.recentes || []).map((e) => {
    const f = [["nº", e.numero], ["modelo", e.modelo], ["fab./assunto", e.fabricante]].filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ");
    const quando = e.quando ? new Date(e.quando).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    return [quando, (f || (e.origem === "pagina" ? "troca de página" : "sem filtro")) + (e.pagina > 1 ? ` · pág. ${e.pagina}` : ""), e.status === "erro" ? "erro" : `${fmt(e.total)} (${statusTxt[e.status] || e.status || "—"})`, tempo(e.ms)];
  });
  const hb = (lista) => (lista || []).map((x) => ({ rotulo: x.rotulo, n: x.n }));
  const hbTab = (lista, unidade) => tabela(["Item", unidade], hb(lista).map((x) => [x.rotulo, fmt(x.n)]));

  el.graficos.replaceChildren(
    cartaoGrafico("res", { titulo: "Buscas por dia", subtitulo: "Resultado de cada consulta à EASA", series: sRes, grafico: colunas(bRes, sRes, { cadaRotulo: cada }), tabela: tabela(["Dia", ...sRes.map((s) => s.nome)], linhasTab(bRes)) }),
    cartaoGrafico("ace", { titulo: "Acessos por dia", subtitulo: "Sessões abertas e visitantes diferentes", series: sAce, grafico: colunas(bAce, sAce, { agrupado: true, cadaRotulo: cada }), tabela: tabela(["Dia", "Sessões", "Visitantes"], linhasTab(bAce)) }),
    cartaoGrafico("hora", { titulo: "Horário de uso", subtitulo: `Buscas por hora do dia (${dados.fuso || "horário local"})`, grafico: colunas(bHora, [{ nome: "Buscas", cls: "s1" }], { cadaRotulo: 3 }), tabela: tabela(["Hora", "Buscas"], linhasTab(bHora)) }),
    cartaoGrafico("ms", { titulo: "Tempo de resposta por dia", subtitulo: "Média no servidor (a 1ª busca da hora baixa o arquivo da EASA)", grafico: colunas(bMs, [{ nome: "Tempo médio", cls: "s1" }], { formatar: tempo, cadaRotulo: cada }), tabela: tabela(["Dia", "Tempo médio"], linhasTab(bMs, null, tempo)) }),
    cartaoGrafico("funil", { titulo: "Fluxo da sessão", subtitulo: "Quantas sessões chegaram a cada passo", grafico: barras(hb(dados.funil), "Sessões"), tabela: hbTab(dados.funil, "Sessões") }),
    cartaoGrafico("filtros", { titulo: "Filtros usados", subtitulo: "Campos preenchidos (sem contar a troca de página)", grafico: barras(hb(dados.filtros), "Buscas"), tabela: hbTab(dados.filtros, "Buscas") }),
    cartaoGrafico("termos", { titulo: "Termos mais buscados", subtitulo: "Por campo, sem diferenciar acento e espaço", grafico: barras(hb(dados.termos), "Buscas"), tabela: hbTab(dados.termos, "Buscas") }),
    cartaoGrafico("docs", { titulo: "ADs mais abertas", subtitulo: "Documentos abertos a partir da busca", grafico: barras(hb(dados.documentos), "Aberturas"), tabela: hbTab(dados.documentos, "Aberturas") }),
    cartaoGrafico("recentes", { titulo: "Últimas buscas", subtitulo: "As 30 mais recentes do período", grafico: tabela(["Quando", "Filtros", "Resultado", "Tempo"], recentes), largo: true })
  );
}

// ---- dados ---------------------------------------------------------------------------------
async function pedirPainel(senhaTentativa) {
  if (!appsScriptUrl) throw Object.assign(new Error("Falta a URL do servidor da busca em config.js."), { codigo: 0 });
  let res;
  try {
    // text/plain evita a pré-verificação de CORS; o Apps Script lê o corpo em e.postData.contents.
    res = await fetch(appsScriptUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ acao: "painel", senha: senhaTentativa, dias }), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  } catch { throw Object.assign(new Error("Não foi possível falar com o servidor da busca agora."), { codigo: 0 }); }
  let json;
  try { json = await res.json(); } catch { throw Object.assign(new Error("O servidor respondeu num formato inesperado. Publique a versão nova do Codigo.gs (versão 2)."), { codigo: 0 }); }
  if (!json || json.ok !== true) throw Object.assign(new Error((json && json.erro) || "Não foi possível carregar o painel."), { codigo: json && json.codigo });
  return json;
}

async function carregar() {
  const meu = ++pedido;
  el.status.textContent = "Carregando…";
  el.atualizar.disabled = true;
  el.conteudo.setAttribute("aria-busy", "true");
  try {
    const r = await pedirPainel(senha);
    if (meu !== pedido) return;
    dados = r;
    render();
    if (r.planilhaUrl && /^https:\/\/docs\.google\.com\//.test(r.planilhaUrl)) { el.planilha.href = r.planilhaUrl; el.planilha.hidden = false; }
    el.status.textContent = `Atualizado às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} · ${fmt(r.eventos)} eventos no período`;
  } catch (erro) {
    if (meu !== pedido) return;
    if (erro.codigo === 401 || erro.codigo === 429) { sair(erro.message); return; }
    el.status.textContent = erro.message;
  } finally {
    if (meu === pedido) { el.atualizar.disabled = false; el.conteudo.setAttribute("aria-busy", "false"); }
  }
}

function mostrarPainel() {
  el.login.hidden = true;
  el.painel.hidden = false;
  el.sair.hidden = false;
}
function sair(mensagem = "") {
  senha = ""; dados = null; pedido += 1;
  try { sessionStorage.removeItem("painel_senha"); } catch { /* sem armazenamento */ }
  el.painel.hidden = true; el.sair.hidden = true; el.login.hidden = false;
  el.kpis.replaceChildren(); el.graficos.replaceChildren(); el.planilha.hidden = true;
  el.loginMsg.textContent = mensagem; el.loginMsg.classList.toggle("is-erro", Boolean(mensagem));
  el.senha.value = ""; el.senha.focus();
}

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const tentativa = el.senha.value;
  if (!tentativa) { el.loginMsg.textContent = "Digite a senha."; el.loginMsg.classList.add("is-erro"); return; }
  el.entrar.disabled = true;
  el.loginMsg.classList.remove("is-erro");
  el.loginMsg.textContent = "Entrando…";
  try {
    const r = await pedirPainel(tentativa);
    senha = tentativa;
    if (el.lembrar.checked) { try { sessionStorage.setItem("painel_senha", tentativa); } catch { /* sem armazenamento */ } }
    el.loginMsg.textContent = "";
    el.senha.value = "";
    dados = r;
    mostrarPainel();
    render();
    if (r.planilhaUrl && /^https:\/\/docs\.google\.com\//.test(r.planilhaUrl)) { el.planilha.href = r.planilhaUrl; el.planilha.hidden = false; }
    el.status.textContent = `Atualizado às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} · ${fmt(r.eventos)} eventos no período`;
  } catch (erro) {
    el.loginMsg.textContent = erro.message;
    el.loginMsg.classList.add("is-erro");
  } finally { el.entrar.disabled = false; }
});
el.sair.addEventListener("click", () => sair());
el.atualizar.addEventListener("click", carregar);
el.periodo.addEventListener("click", (event) => {
  const b = event.target.closest("button[data-dias]");
  if (!b) return;
  dias = Number(b.dataset.dias) || 7;
  el.periodo.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  carregar();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") esconderDica(); });

// Volta conectado se a senha ficou guardada nesta aba.
try {
  const guardada = sessionStorage.getItem("painel_senha");
  if (guardada) { senha = guardada; el.lembrar.checked = true; mostrarPainel(); carregar(); }
} catch { /* sem armazenamento */ }
if (!appsScriptUrl) { el.loginMsg.textContent = "Falta a URL do servidor da busca em config.js."; el.loginMsg.classList.add("is-erro"); }
