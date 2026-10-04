import * as api from "./api.js";
import { ehEletrificado, aplicarDesenergizacao } from "./regras.js";

// ================================================================
// utilidades
// ================================================================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $("#app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/\./g, (m, i, s) => (s.includes(",") ? "" : m)).replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const fmtR = (v) => (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtH = (v) => (Math.round((v || 0) * 10) / 10).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const fmtData = (d) => (d ? new Date(d).toLocaleDateString("pt-BR") : "—");
const DEC = ["TROCAR", "RECUPERAR", "SO_PINTAR", "REMOVER_INSTALAR", "SERVICO"];
const DEC_NOME = { TROCAR: "Trocar", RECUPERAR: "Recuperar", SO_PINTAR: "Só pintar", REMOVER_INSTALAR: "R&I", SERVICO: "Serviço" };
const STATUS_NOME = { rascunho: "Rascunho", analisando: "Analisando", sugerido: "Sugerido pela IA", finalizado: "Finalizado" };
const OF_STATUS = { trial: "Período de teste", ativa: "Ativa", inadimplente: "Pagamento pendente", cancelada: "Cancelada" };
const CORTE_PADRAO = { fun: 0.736, pin: 0.823, ri: 0.796, out: 0.745 };
// Peças de iluminação: na troca, padrão de 0,5 h de elétrica + 0,5 h de R&I
const ILUMINACAO = /^(FAROL|LANTERNA|BRAKE LIGHT|PISCA|REPETIDOR|LUZ D[AEO])/;
const semAcento = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
const MARCAS = { GM: "CHEVROLET", "GENERAL MOTORS": "CHEVROLET", CHEV: "CHEVROLET", VW: "VOLKSWAGEN", VOLKS: "VOLKSWAGEN",
  MERCEDES: "MERCEDES-BENZ", MB: "MERCEDES-BENZ", "MERCEDES BENZ": "MERCEDES-BENZ", "CITROËN": "CITROEN",
  LANDROVER: "LAND ROVER", "GREAT WALL": "GWM", "CAOA CHERY": "CHERY", IVECO: "IVECO/FIAT" };
const marcaPadrao = (m) => { const k = String(m || "").toUpperCase().trim(); return MARCAS[k] || k || null; };

let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3200);
}
const MARCA_SVG = `<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="currentColor" opacity=".12"/><path d="M8 23 16 8l8 15" fill="none" stroke="var(--fita)" stroke-width="3.2" stroke-linejoin="round"/></svg>`;

// ================================================================
// contexto do usuário
// ================================================================
const ctx = { user: null, membro: null, oficina: null, admin: false };

async function carregarContexto() {
  ctx.user = api.usuario();
  ctx.membro = null; ctx.oficina = null; ctx.admin = false;
  if (!api.logado() || !ctx.user) return;
  const [m, a] = await Promise.all([
    api.rest.get(`membros?select=papel,nome,oficina_id,oficinas(*,planos(*))&user_id=eq.${ctx.user.id}`),
    api.rest.get(`admins?select=user_id&user_id=eq.${ctx.user.id}`).catch(() => []),
  ]);
  if (m && m[0]) { ctx.membro = m[0]; ctx.oficina = m[0].oficinas; }
  ctx.admin = !!(a && a.length);
}
const ehDono = () => ctx.membro?.papel === "dono";
function oficinaAtiva(of = ctx.oficina) {
  if (!of) return false;
  return (of.status === "trial" && new Date(of.trial_ate) > new Date()) || of.status === "ativa";
}
function diasTeste(of = ctx.oficina) {
  if (!of?.trial_ate) return 0;
  return Math.max(0, Math.ceil((new Date(of.trial_ate) - new Date()) / 86400000));
}

// ================================================================
// roteador
// ================================================================
const PUBLICAS = ["entrar", "cadastrar", "recuperar", "nova-senha"];
async function rotear() {
  const h = location.hash.replace(/^#\/?/, "");
  if (/access_token=/.test(h)) {
    const tipo = await api.lerTokenDoEndereco();
    history.replaceState(null, "", location.pathname + (tipo === "recovery" ? "#/nova-senha" : "#/orcamentos"));
    return rotear();
  }
  const [rota, arg] = h.split("/");
  if (!api.logado()) {
    if (!PUBLICAS.includes(rota)) { location.hash = "#/entrar"; return; }
    return telaEntrada(rota || "entrar");
  }
  if (rota === "nova-senha") return telaNovaSenha();
  if (!ctx.user) {
    app.innerHTML = `<div class="carregando">Carregando…</div>`;
    try { await carregarContexto(); } catch (e) { app.innerHTML = `<div class="carregando">${esc(e.message)}</div>`; return; }
  }
  if (!ctx.oficina && rota !== "admin") return telaNovaOficina();
  switch (rota) {
    case "novo": return telaNovo();
    case "orcamento": return telaEditor(arg);
    case "configuracoes": return telaConfig();
    case "assinatura": return telaAssinatura();
    case "admin": return ctx.admin ? telaAdmin() : (location.hash = "#/orcamentos");
    case "orcamentos": return telaLista();
    default: location.hash = "#/orcamentos";
  }
}
window.addEventListener("hashchange", rotear);

// ================================================================
// casca
// ================================================================
function casca(ativo, html) {
  const of = ctx.oficina;
  const link = (r, t) => `<a href="#/${r}" class="${ativo === r ? "ativo" : ""}">${t}</a>`;
  app.innerHTML = `
  <div class="casca">
    <aside class="barra">
      <div class="marca">${MARCA_SVG}ALTUS</div>
      <nav aria-label="Principal">
        ${of ? link("orcamentos", "Orçamentos") + link("novo", "Novo orçamento") + link("configuracoes", "Oficina") + (ehDono() ? link("assinatura", "Assinatura") : "") : ""}
        ${ctx.admin ? link("admin", "Administração") : ""}
      </nav>
      <div class="rodape">
        <span class="quem"><b>${esc(of?.nome ?? "")}</b><br>${esc(ctx.user?.email ?? "")}</span>
        <button type="button" id="sair">Sair</button>
      </div>
    </aside>
    <main class="conteudo">${avisoAssinatura()}${html}</main>
  </div>`;
  $("#sair").onclick = async () => { await api.sair(); ctx.user = null; location.hash = "#/entrar"; };
}
function avisoAssinatura() {
  const of = ctx.oficina;
  if (!of) return "";
  if (of.status === "trial" && oficinaAtiva()) {
    const d = diasTeste();
    return d <= 3 ? `<div class="aviso nao-imprime"><span>Seu período de teste termina em <b>${d} dia${d === 1 ? "" : "s"}</b>.</span>${ehDono() ? `<a class="btn" href="#/assinatura">Assinar o Altus</a>` : ""}</div>` : "";
  }
  if (!oficinaAtiva()) {
    return `<div class="aviso erro nao-imprime"><span>${of.status === "trial" ? "O período de teste terminou." : of.status === "inadimplente" ? "Há uma mensalidade em aberto." : "A assinatura está cancelada."} Você ainda vê seus orçamentos, mas não consegue criar novos.</span>${ehDono() ? `<a class="btn primario" href="#/assinatura">Regularizar assinatura</a>` : `<span class="small muted">Fale com o responsável pela oficina.</span>`}</div>`;
  }
  return "";
}

// ================================================================
// entrada: entrar / cadastrar / recuperar
// ================================================================
function telaEntrada(modo) {
  const titulos = { entrar: "Entrar no Altus", cadastrar: "Criar conta da oficina", recuperar: "Recuperar senha" };
  app.innerHTML = `
  <div class="entrada">
    <section class="lado">
      <div class="marca">${MARCA_SVG}ALTUS</div>
      <p class="tese">Fotos do sinistro viram <span class="fita-traco">orçamento</span> em minutos.</p>
      <ul>
        <li>Identifica as peças danificadas e decide o que trocar e o que recuperar.</li>
        <li>Calcula horas de funilaria, pintura e R&amp;I com base em milhares de orçamentos reais.</li>
        <li>Mostra quanto a seguradora provavelmente vai aprovar.</li>
        <li>Aprende com os orçamentos da sua oficina.</li>
      </ul>
      <p class="preco"><b>R$ 199</b> por mês · 7 dias grátis para testar, sem cartão</p>
    </section>
    <section class="form">
      <h1>${titulos[modo] ?? titulos.entrar}</h1>
      <form id="f" novalidate>
        ${modo === "cadastrar" ? `<label class="f">Seu nome<input id="nome" autocomplete="name" required></label>` : ""}
        <label class="f">E-mail<input id="email" type="email" autocomplete="email" required></label>
        ${modo !== "recuperar" ? `<label class="f">Senha<input id="senha" type="password" autocomplete="${modo === "cadastrar" ? "new-password" : "current-password"}" minlength="6" required></label>` : ""}
        <p class="erro-txt" id="erro" hidden></p>
        <button class="btn primario grande" id="ok">${modo === "cadastrar" ? "Criar conta e testar grátis" : modo === "recuperar" ? "Enviar link de recuperação" : "Entrar"}</button>
      </form>
      <div class="troca-modo acoes">
        ${modo !== "entrar" ? `<a href="#/entrar">Já tenho conta</a>` : `<a href="#/cadastrar">Criar conta da oficina</a><span class="muted">·</span><a href="#/recuperar">Esqueci a senha</a>`}
      </div>
    </section>
  </div>`;
  $("#email").focus();
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const erro = $("#erro"); erro.hidden = true;
    const email = $("#email").value.trim(), senha = $("#senha")?.value ?? "";
    if (!/^\S+@\S+\.\S+$/.test(email)) { erro.textContent = "Digite um e-mail válido."; erro.hidden = false; return; }
    if (modo !== "recuperar" && senha.length < 6) { erro.textContent = "A senha precisa ter pelo menos 6 caracteres."; erro.hidden = false; return; }
    const b = $("#ok"); b.disabled = true;
    try {
      if (modo === "entrar") {
        await api.entrar(email, senha); ctx.user = null; location.hash = "#/orcamentos"; rotear();
      } else if (modo === "cadastrar") {
        const r = await api.cadastrar(email, senha, $("#nome").value.trim());
        if (r.logado) { ctx.user = null; location.hash = "#/orcamentos"; rotear(); }
        else $(".form").innerHTML = `<h1>Confirme seu e-mail</h1><p>Enviamos um link para <b>${esc(email)}</b>. Abra o e-mail e clique no link para ativar a conta.</p><p class="muted small">Não chegou? Veja a caixa de spam.</p><a class="btn" href="#/entrar">Voltar para entrar</a>`;
      } else {
        await api.recuperarSenha(email);
        $(".form").innerHTML = `<h1>Confira seu e-mail</h1><p>Se existir uma conta com <b>${esc(email)}</b>, você vai receber um link para criar uma nova senha.</p><a class="btn" href="#/entrar">Voltar para entrar</a>`;
      }
    } catch (ex) { erro.textContent = ex.message; erro.hidden = false; }
    finally { if (b.isConnected) b.disabled = false; }
  };
}

function telaNovaSenha() {
  app.innerHTML = `<div class="entrada"><section class="lado"><div class="marca">${MARCA_SVG}ALTUS</div></section>
  <section class="form"><h1>Criar nova senha</h1>
  <form id="f"><label class="f">Nova senha<input id="senha" type="password" minlength="6" autocomplete="new-password" required></label>
  <p class="erro-txt" id="erro" hidden></p><button class="btn primario grande">Salvar nova senha</button></form></section></div>`;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    try { await api.trocarSenha($("#senha").value); toast("Senha alterada."); location.hash = "#/orcamentos"; }
    catch (ex) { $("#erro").textContent = ex.message; $("#erro").hidden = false; }
  };
}

// ================================================================
// cadastro da oficina
// ================================================================
function telaNovaOficina() {
  casca("", `
  <div class="topo"><div><h1>Cadastre sua oficina</h1><p class="muted">Você ganha 7 dias para testar o Altus sem pagar nada.</p></div></div>
  <form class="painel" id="f" style="max-width:720px">
    <label class="f">Nome da oficina<input id="nome" required></label>
    <div class="grid2">
      <label class="f">CNPJ ou CPF<input id="cnpj" inputmode="numeric"></label>
      <label class="f">WhatsApp<input id="tel" inputmode="tel"></label>
    </div>
    <div class="grid3">
      <label class="f" style="grid-column:span 2">Cidade<input id="cidade"></label>
      <label class="f">UF<input id="uf" maxlength="2"></label>
    </div>
    <label class="f">Seu nome<input id="pessoa" value="${esc(ctx.user?.user_metadata?.nome ?? "")}"></label>
    <p class="erro-txt" id="erro" hidden></p>
    <div class="acoes"><button class="btn primario grande">Começar a usar</button></div>
  </form>`);
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api.rpc("criar_oficina", { p_nome: $("#nome").value, p_cnpj: $("#cnpj").value, p_telefone: $("#tel").value, p_cidade: $("#cidade").value, p_uf: $("#uf").value, p_nome_usuario: $("#pessoa").value });
      await carregarContexto(); toast("Oficina cadastrada."); location.hash = "#/novo";
    } catch (ex) { $("#erro").textContent = ex.message; $("#erro").hidden = false; }
  };
}

// ================================================================
// lista de orçamentos
// ================================================================
async function telaLista() {
  casca("orcamentos", `
  <div class="topo"><div><h1>Orçamentos</h1><p class="muted">${esc(ctx.oficina.nome)}</p></div>
  <div class="acoes"><input id="busca" placeholder="Buscar placa, cliente ou modelo" style="width:260px"><a class="btn primario" href="#/novo">Novo orçamento</a></div></div>
  <div id="lista"><div class="carregando">Carregando orçamentos…</div></div>`);
  let dados = [];
  try {
    dados = await api.rest.get(`orcamentos?select=id,numero,criado_em,placa,marca,modelo,ano,cliente_nome,seguradora,status,origem,itens,totais&oficina_id=eq.${ctx.oficina.id}&order=criado_em.desc&limit=300`);
  } catch (e) { $("#lista").innerHTML = `<div class="aviso erro">${esc(e.message)}</div>`; return; }
  const desenhar = (filtro = "") => {
    const f = filtro.toLowerCase();
    const lista = dados.filter((o) => !f || [o.placa, o.cliente_nome, o.modelo, o.marca, o.seguradora].join(" ").toLowerCase().includes(f));
    if (!dados.length) {
      $("#lista").innerHTML = `<div class="painel vazio"><h2>Nenhum orçamento ainda</h2><p class="muted">Comece pelas fotos do veículo. O Altus identifica os danos e monta o orçamento.</p><a class="btn primario grande" href="#/novo">Fazer o primeiro orçamento</a></div>`;
      return;
    }
    $("#lista").innerHTML = `<div class="tabela"><table><thead><tr><th>Nº</th><th>Data</th><th>Placa</th><th>Veículo</th><th>Cliente</th><th>Seguradora</th><th>Situação</th><th style="text-align:right">Total</th></tr></thead><tbody>
      ${lista.map((o) => `<tr class="clicavel" data-id="${o.id}" tabindex="0">
        <td class="num">${o.numero}</td><td class="num">${fmtData(o.criado_em)}</td><td><b>${esc(o.placa ?? "—")}</b></td>
        <td>${esc([o.marca, o.modelo, o.ano].filter(Boolean).join(" ") || "—")}</td><td>${esc(o.cliente_nome ?? "—")}</td><td>${esc(o.seguradora ?? "—")}</td>
        <td><span class="etiqueta e-${o.status}">${STATUS_NOME[o.status]}</span></td>
        <td class="num" style="text-align:right">${o.itens?.length ? fmtR(calcular(o.itens, { ...taxasOficina(), ...(o.totais?.taxas || {}) }, CORTE_PADRAO, o.totais?.terceiros).total) : "—"}</td></tr>`).join("")}
      </tbody></table></div>${!lista.length ? `<p class="muted" style="padding:12px">Nada encontrado para “${esc(filtro)}”.</p>` : ""}`;
    $$("tr.clicavel").forEach((tr) => {
      const ir = () => (location.hash = "#/orcamento/" + tr.dataset.id);
      tr.onclick = ir; tr.onkeydown = (e) => { if (e.key === "Enter") ir(); };
    });
  };
  desenhar();
  $("#busca").oninput = (e) => desenhar(e.target.value);
}

// ================================================================
// novo orçamento
// ================================================================
async function comprimir(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!bmp) return file;
  const max = 1600, k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob((b) => r(b || file), "image/jpeg", 0.82));
}

function telaNovo() {
  const bloqueado = !oficinaAtiva();
  casca("novo", `
  <div class="topo"><div><h1>Novo orçamento</h1><p class="muted">Placa, fotos e pronto. Os dados do cliente são opcionais.</p></div>
    <div class="acoes"><button type="button" class="btn" id="xmlbtn" ${bloqueado ? "disabled" : ""}>Importar XML da seguradora</button><input type="file" id="xmlarq" accept=".xml,text/xml,application/xml" hidden></div></div>
  <p class="erro-txt" id="xmlerro" hidden></p>
  <form class="painel" id="f" novalidate>
    <header><h2>Veículo</h2></header>
    <div class="placa-linha">
      <label class="f">Placa<input id="placa" class="placa-input" maxlength="8" placeholder="ABC1D23" autocomplete="off"></label>
      <button type="button" class="btn" id="buscar">Buscar dados pela placa</button>
    </div>
    <p class="small muted" id="placa-msg" hidden></p>
    <div class="grid4">
      <label class="f">Marca<input id="marca" placeholder="CHEVROLET"></label>
      <label class="f">Modelo<input id="modelo" placeholder="ONIX"></label>
      <label class="f">Versão<input id="versao"></label>
      <label class="f">Ano<input id="ano" inputmode="numeric" maxlength="9"></label>
      <label class="f">Cor<input id="cor"></label>
      <label class="f" style="grid-column:span 2">Chassi<input id="chassi"></label>
      <label class="chk-l" style="grid-column:span 2"><input type="checkbox" id="eletrico"> Veículo híbrido ou elétrico</label>
    </div>
    <header><h2>Cliente e sinistro</h2></header>
    <div class="grid4">
      <label class="f">Cliente<input id="cliente"></label>
      <label class="f">Telefone<input id="telefone" inputmode="tel"></label>
      <label class="f">Seguradora<input id="seguradora"></label>
      <label class="f">Nº do sinistro<input id="sinistro"></label>
    </div>
    <header><h2>Fotos do dano</h2><span class="small muted" id="nfotos">Até 20 fotos</span></header>
    <div class="solta" id="solta" role="button" tabindex="0">
      <b>Escolher fotos</b><span class="muted small">ou arraste para cá. Use as 4 vistas do carro e closes de cada dano.</span>
    </div>
    <input type="file" id="arq" accept="image/*" multiple hidden>
    <div class="miniaturas" id="minis"></div>
    <header><h2>Marcar danos</h2><span class="small muted">O Altus monta o orçamento pelo histórico de 15.500 decisões reais.</span></header>
    <div class="marcar">
      <label class="f" style="grid-column:span 2">Peça<input id="mpeca" list="mvocab" placeholder="PARALAMA DIANT" autocomplete="off"><datalist id="mvocab"></datalist></label>
      <label class="f">Lado<select id="mlado"><option value="">Central</option><option>ESQ</option><option>DIR</option></select></label>
      <label class="f">Material<select id="mmat"><option value="METAL">Metal</option><option value="PLASTICO">Plástico</option><option value="VIDRO">Vidro</option><option value="OUTRO">Outro</option></select></label>
      <label class="f">Dano<select id="mtipo"><option>amassado</option><option>riscado</option><option>trincado</option><option>quebrado</option><option>rasgado</option><option>deformado</option><option>solto</option></select></label>
      <label class="f">Gravidade<select id="msev"><option value="LEVE">Leve</option><option value="MEDIO" selected>Médio</option><option value="GRAVE">Grave</option></select></label>
      <label class="chk-l"><input type="checkbox" id="mpint" checked> Pintura danificada</label>
      <label class="chk-l"><input type="checkbox" id="mvinco"> Com vinco ou dobra</label>
      <button type="button" class="btn" id="madd">Adicionar dano</button>
    </div>
    <ul class="mlista" id="mlista"></ul>
    <div class="progresso" id="prog" hidden>
      <div class="passo" id="p1"><i></i><span>Enviando fotos</span></div>
      <div class="passo" id="p2"><i></i><span>Lendo as fotos e identificando danos</span></div>
      <div class="passo" id="p3"><i></i><span>Comparando com o histórico e montando o orçamento</span></div>
    </div>
    <p class="erro-txt" id="erro" hidden></p>
    <p class="small muted" id="ia-aviso" hidden>A leitura automática das fotos pela IA será ativada em breve. Por enquanto, marque os danos acima: as fotos ficam guardadas no orçamento.</p>
    <div class="acoes">
      <button type="button" class="btn primario grande" id="pordanos" ${bloqueado ? "disabled" : ""}>Orçar pelos danos marcados</button>
      <button class="btn grande" id="ia" ${bloqueado ? "disabled" : ""}>Orçar com IA pelas fotos</button>
      <button type="button" class="btn" id="manual" ${bloqueado ? "disabled" : ""}>Montar em branco</button>
    </div>
  </form>`);
  $("#xmlbtn").onclick = () => $("#xmlarq").click();
  $("#xmlarq").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    const er = $("#xmlerro"); er.hidden = true;
    const b = $("#xmlbtn"); b.disabled = true; b.textContent = "Lendo o XML…";
    try {
      const { lerXmlOrcamento } = await import("./xml.js");
      const x = lerXmlOrcamento(await f.text());
      const tx = { ...taxasOficina(), ...(x.totais.taxas || {}) };
      const elet = ehEletrificado(x.veiculo.marca, x.veiculo.modelo, x.veiculo.versao);
      aplicarDesenergizacao(x.itens, elet, ctx.oficina.valor_desenergizacao);
      const [o] = await api.rest.insert("orcamentos", {
        oficina_id: ctx.oficina.id, criado_por: ctx.user.id, origem: "xml", status: "sugerido",
        ...x.veiculo, marca: marcaPadrao(x.veiculo.marca), cliente_nome: x.cliente_nome, seguradora: x.seguradora, sinistro: x.sinistro,
        itens: x.itens, observacoes: x.observacoes, verificar: [], eletrificado: elet,
        totais: { ...x.totais, taxas: tx, cortes: CORTE_PADRAO },
      });
      toast(`XML importado: ${x.itens.length} itens.`);
      location.hash = "#/orcamento/" + o.id;
    } catch (ex) { er.textContent = ex.message; er.hidden = false; b.disabled = false; b.textContent = "Importar XML da seguradora"; }
  };
  let eletricoManual = false;
  const detectar = () => { if (!eletricoManual) $("#eletrico").checked = ehEletrificado($("#marca").value, $("#modelo").value, $("#versao").value); };
  ["marca", "modelo", "versao"].forEach((k) => $("#" + k).addEventListener("input", detectar));
  $("#eletrico").addEventListener("change", () => { eletricoManual = true; });
  const danosMarcados = [];
  const desenharDanos = () => {
    $("#mlista").innerHTML = danosMarcados.map((d, i) => `<li><span><b>${esc(d.peca)}${d.lado ? " " + d.lado : ""}</b> · ${esc(d.tipo_dano)}, ${d.severidade.toLowerCase()}${d.pintura_danificada ? ", pintura danificada" : ""}${d.vinco_ou_dobra ? ", com vinco" : ""}</span><button type="button" class="x" data-i="${i}" aria-label="Remover dano">×</button></li>`).join("");
    $$("#mlista .x").forEach((b) => (b.onclick = () => { danosMarcados.splice(+b.dataset.i, 1); desenharDanos(); }));
  };
  $("#madd").onclick = () => {
    const peca = $("#mpeca").value.trim().toUpperCase();
    if (!peca) { $("#mpeca").focus(); return; }
    danosMarcados.push({ peca, lado: $("#mlado").value, material: $("#mmat").value, tipo_dano: $("#mtipo").value, severidade: $("#msev").value, pintura_danificada: $("#mpint").checked, vinco_ou_dobra: $("#mvinco").checked });
    $("#mpeca").value = ""; $("#mvinco").checked = false; desenharDanos(); $("#mpeca").focus();
  };
  $("#mpeca").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#madd").click(); } });
  api.funcao("orcar", { info: true }).then((r) => {
    $("#mvocab").innerHTML = (r.vocabulario || []).map((p) => `<option value="${esc(p)}">`).join("");
    if (!r.ia) { $("#ia-aviso").hidden = false; $("#ia").disabled = true; }
  }).catch(() => {});
  const fotos = [];
  const desenhar = () => {
    $("#minis").innerHTML = fotos.map((f, i) => `<div class="mini"><img src="${f.url}" alt="Foto ${i + 1}"><span>${i + 1}</span><button type="button" data-i="${i}" aria-label="Remover foto ${i + 1}">×</button></div>`).join("");
    $$("#minis button").forEach((b) => (b.onclick = () => { const [f] = fotos.splice(+b.dataset.i, 1); URL.revokeObjectURL(f.url); desenhar(); }));
    $("#nfotos").textContent = fotos.length ? `${fotos.length} de 20 fotos` : "Até 20 fotos";
  };
  const adicionar = async (lista) => {
    for (const f of [...lista]) {
      if (!f.type.startsWith("image/") || fotos.length >= 20) continue;
      const b = await comprimir(f);
      fotos.push({ blob: b, url: URL.createObjectURL(b) });
    }
    desenhar();
  };
  const solta = $("#solta");
  solta.onclick = () => $("#arq").click();
  solta.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#arq").click(); } };
  solta.ondragover = (e) => { e.preventDefault(); solta.classList.add("sobre"); };
  solta.ondragleave = () => solta.classList.remove("sobre");
  solta.ondrop = (e) => { e.preventDefault(); solta.classList.remove("sobre"); adicionar(e.dataTransfer.files); };
  $("#arq").onchange = (e) => { adicionar(e.target.files); e.target.value = ""; };

  $("#placa").oninput = (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""); };
  $("#buscar").onclick = async () => {
    const msg = $("#placa-msg"); msg.hidden = false; msg.textContent = "Consultando…";
    try {
      const r = await api.funcao("placa", { placa: $("#placa").value });
      ["marca", "modelo", "versao", "ano", "cor", "chassi"].forEach((k) => { if (r[k]) $("#" + k).value = r[k]; });
      msg.textContent = "Dados preenchidos. Confira antes de seguir.";
      detectar();
    } catch (e) { msg.textContent = e.message; }
  };

  const dadosForm = () => ({
    oficina_id: ctx.oficina.id, criado_por: ctx.user.id,
    placa: $("#placa").value.replace(/-/g, "") || null, marca: marcaPadrao($("#marca").value),
    modelo: $("#modelo").value.trim().toUpperCase() || null, versao: $("#versao").value.trim() || null, ano: $("#ano").value.trim() || null,
    cor: $("#cor").value.trim() || null, chassi: $("#chassi").value.trim().toUpperCase() || null,
    cliente_nome: $("#cliente").value.trim() || null, cliente_telefone: $("#telefone").value.trim() || null,
    seguradora: $("#seguradora").value.trim() || null, sinistro: $("#sinistro").value.trim() || null,
    eletrificado: $("#eletrico").checked,
  });
  const erro = (m) => { const e = $("#erro"); e.textContent = m; e.hidden = !m; };
  const passo = (n) => ["p1", "p2", "p3"].forEach((id, i) => ($("#" + id).className = "passo" + (i + 1 < n ? " ok" : i + 1 === n ? " on" : "")));

  $("#manual").onclick = async () => {
    try {
      const [o] = await api.rest.insert("orcamentos", { ...dadosForm(), origem: "manual" });
      if (fotos.length) await subirFotos(o.id, fotos);
      location.hash = "#/orcamento/" + o.id;
    } catch (e) { erro(e.message); }
  };
  $("#pordanos").onclick = async () => {
    erro("");
    if (!danosMarcados.length) return erro("Marque pelo menos um dano: escolha a peça, o tipo e a gravidade e clique em “Adicionar dano”.");
    const b = $("#pordanos"); b.disabled = true; b.textContent = "Montando o orçamento…";
    try {
      const [o] = await api.rest.insert("orcamentos", { ...dadosForm(), origem: "manual" });
      if (fotos.length) await subirFotos(o.id, fotos);
      await api.funcao("orcar", { orcamento_id: o.id, danos: danosMarcados });
      location.hash = "#/orcamento/" + o.id;
    } catch (ex) { erro(ex.message); b.disabled = false; b.textContent = "Orçar pelos danos marcados"; }
  };
  $("#f").onsubmit = async (e) => {
    e.preventDefault(); erro("");
    if (!fotos.length) return erro("Adicione pelo menos uma foto do dano.");
    if (!$("#modelo").value.trim()) return erro("Informe o modelo do veículo. A IA usa o modelo para buscar orçamentos parecidos.");
    $("#ia").disabled = true; $("#manual").disabled = true; $("#prog").hidden = false;
    let id = null;
    try {
      passo(1);
      const [o] = await api.rest.insert("orcamentos", { ...dadosForm(), origem: "ia" });
      id = o.id;
      await subirFotos(id, fotos, (k) => ($("#p1 span").textContent = `Enviando fotos (${k} de ${fotos.length})`));
      passo(2);
      const t = setTimeout(() => passo(3), 25000);
      await api.funcao("orcar", { orcamento_id: id });
      clearTimeout(t); passo(4);
      location.hash = "#/orcamento/" + id;
    } catch (ex) {
      erro(ex.message + (id ? " O orçamento ficou salvo como rascunho com as fotos; você pode tentar de novo por lá." : ""));
      $("#prog").hidden = true; $("#ia").disabled = false; $("#manual").disabled = false;
      if (id) setTimeout(() => (location.hash = "#/orcamento/" + id), 2500);
    }
  };
}

async function subirFotos(orcId, fotos, onProg) {
  const linhas = [];
  for (let i = 0; i < fotos.length; i++) {
    const caminho = `${ctx.oficina.id}/${orcId}/${String(i + 1).padStart(2, "0")}-${Date.now().toString(36)}.jpg`;
    await api.enviarFoto(caminho, fotos[i].blob);
    linhas.push({ orcamento_id: orcId, oficina_id: ctx.oficina.id, caminho, ordem: i + 1 });
    onProg?.(i + 1);
  }
  if (linhas.length) await api.rest.insert("orcamento_fotos", linhas);
}

// ================================================================
// cálculo
// ================================================================
function taxasOficina() {
  const o = ctx.oficina || {};
  return { fun: +o.taxa_funilaria || 54, pin: +o.taxa_pintura || 68, ri: +o.taxa_ri || 51, out: +o.taxa_outras || 51 };
}
function calcular(itens, tx, cortes = CORTE_PADRAO, terceiros = 0) {
  const t = { hf: 0, hp: 0, hri: 0, hout: 0, ahf: 0, ahp: 0, ahri: 0, ahout: 0, pecas: 0, trocas: 0, recup: 0, vrec: 0, servicos: 0, terceiros: num(terceiros) };
  for (const it of itens) {
    const c = { ...cortes, ...(it.cut || {}) };
    t.hf += num(it.hf); t.hp += num(it.hp); t.hri += num(it.hri); t.hout += num(it.hout);
    t.ahf += num(it.hf) * Math.min(1, c.fun); t.ahp += num(it.hp) * Math.min(1, c.pin);
    t.ahri += num(it.hri) * Math.min(1, c.ri); t.ahout += num(it.hout) * Math.min(1, c.out);
    if (it.decisao === "TROCAR") { t.pecas += num(it.valor); t.trocas++; }
    if (it.decisao === "RECUPERAR") t.recup++;
    t.vrec += num(it.vrec);
    if (it.decisao === "SERVICO") t.servicos += num(it.valor);
  }
  t.mo = t.hf * tx.fun + t.hp * tx.pin + t.hri * tx.ri + t.hout * tx.out;
  t.amo = t.ahf * tx.fun + t.ahp * tx.pin + t.ahri * tx.ri + t.ahout * tx.out;
  t.total = t.mo + t.pecas + t.vrec + t.terceiros + t.servicos; t.atotal = t.amo + t.pecas + t.vrec + t.terceiros + t.servicos;
  return t;
}

// ================================================================
// editor do orçamento
// ================================================================
async function telaEditor(id) {
  casca("orcamentos", `<div class="carregando">Abrindo orçamento…</div>`);
  let o, fotos;
  try {
    [[o], fotos] = await Promise.all([
      api.rest.get(`orcamentos?select=*&id=eq.${id}`),
      api.rest.get(`orcamento_fotos?select=caminho,ordem&orcamento_id=eq.${id}&order=ordem`),
    ]);
  } catch (e) { $(".conteudo").innerHTML = `<div class="aviso erro">${esc(e.message)}</div>`; return; }
  if (!o) { $(".conteudo").innerHTML = `<div class="aviso erro">Orçamento não encontrado.</div>`; return; }

  const itens = (o.itens || []).map((x) => ({ ...x }));
  const tx = { ...taxasOficina(), ...(o.totais?.taxas || {}) };
  const cortes = { ...CORTE_PADRAO, ...(o.totais?.cortes || {}) };
  let sujo = false;
  const podeEditar = oficinaAtiva() && o.status !== "analisando";
  const veiculo = [o.marca, o.modelo, o.versao, o.ano].filter(Boolean).join(" ");

  $(".conteudo").innerHTML = `
  ${avisoAssinatura()}
  <div class="topo">
    <div><h1>Orçamento nº ${o.numero}</h1>
      <div class="cab-orc" style="margin-top:10px">
        ${o.placa ? `<span class="placa-tag">${esc(o.placa)}</span>` : ""}
        <span><b>${esc(veiculo || "Veículo não informado")}</b></span>
        ${o.cliente_nome ? `<span>Cliente <b>${esc(o.cliente_nome)}</b></span>` : ""}
        ${o.seguradora ? `<span>Seguradora <b>${esc(o.seguradora)}</b>${o.sinistro ? ` · sinistro ${esc(o.sinistro)}` : ""}</span>` : ""}
        <span class="etiqueta e-${o.status}">${STATUS_NOME[o.status]}</span>
        <label class="chk-l nao-imprime"><input type="checkbox" id="ed-elet" ${o.eletrificado ? "checked" : ""} ${podeEditar ? "" : "disabled"}> Híbrido ou elétrico</label>
      </div>
    </div>
    <div class="acoes nao-imprime">
      ${fotos.length && podeEditar ? `<button class="btn" id="reorcar">${o.status === "rascunho" ? "Orçar com IA" : "Orçar de novo com IA"}</button>` : ""}
      <button class="btn" id="salvar" ${podeEditar ? "" : "disabled"}>Salvar</button>
      <button class="btn primario" id="finalizar" ${podeEditar ? "" : "disabled"}>${o.status === "finalizado" ? "Salvar e manter finalizado" : "Finalizar orçamento"}</button>
    </div>
  </div>
  ${o.erro ? `<div class="aviso erro nao-imprime"><span>Última análise da IA: ${esc(o.erro)}</span></div>` : ""}
  ${o.status === "analisando" ? `<div class="aviso nao-imprime"><span>A IA está analisando as fotos. Atualize a página em alguns segundos.</span><button class="btn" onclick="location.reload()">Atualizar</button></div>` : ""}
  ${fotos.length ? `<section class="painel nao-imprime"><header><h2>Fotos</h2><span class="small muted">${fotos.length} foto${fotos.length > 1 ? "s" : ""}</span></header><div class="galeria" id="galeria"></div></section>` : ""}
  <section class="painel ed">
    <header><h2>Itens</h2><span class="small muted" id="resumo"></span></header>
    <div class="tabela"><table>
      <thead><tr><th>Peça</th><th>Lado</th><th>Decisão</th><th>Pinta</th><th>Funil. h</th><th>Pint. h</th><th>R&amp;I h</th><th>Outras h</th><th>Peça R$</th><th>Código</th><th>Confiança</th><th>Por quê</th><th></th></tr></thead>
      <tbody id="corpo"></tbody>
    </table></div>
    <div class="acoes nao-imprime"><button class="btn" id="add" ${podeEditar ? "" : "disabled"}>Adicionar item</button></div>
  </section>
  <section class="painel">
    <div class="totais">
      <div class="coluna-tot"><h3>Valor da hora</h3>
        <div class="lt"><label for="tfun">Funilaria</label><input id="tfun" value="${tx.fun}" inputmode="decimal"></div>
        <div class="lt"><label for="tpin">Pintura</label><input id="tpin" value="${tx.pin}" inputmode="decimal"></div>
        <div class="lt"><label for="tri">R&amp;I</label><input id="tri" value="${tx.ri}" inputmode="decimal"></div>
        <div class="lt"><label for="tout">Outras</label><input id="tout" value="${tx.out}" inputmode="decimal"></div>
      </div>
      <div class="coluna-tot" id="totA"></div>
      <div class="coluna-tot" id="totB"></div>
    </div>
  </section>
  <section class="painel listas">
    <div><h3>Verificar na desmontagem</h3><ul>${(o.verificar || []).map((s) => `<li>${esc(s)}</li>`).join("") || "<li class='muted'>Nada indicado.</li>"}</ul></div>
    <div><h3>Observações da análise</h3><ul>${(o.observacoes || []).map((s) => `<li>${esc(s)}</li>`).join("") || "<li class='muted'>Nenhuma.</li>"}</ul></div>
  </section>
  <div class="acoes nao-imprime">
    <button class="btn" id="copiar">Copiar texto</button>
    <button class="btn" id="csv">Baixar planilha</button>
    <button class="btn" id="imprimir">Imprimir ou salvar PDF</button>
    ${ehDono() ? `<button class="btn perigo" id="excluir">Excluir orçamento</button>` : ""}
  </div>`;

  if (fotos.length) {
    api.linksFotos(fotos.map((f) => f.caminho)).then((urls) => {
      $("#galeria").innerHTML = urls.map((u, i) => (u ? `<a href="${u}" target="_blank" rel="noopener"><img src="${u}" alt="Foto ${i + 1}" loading="lazy"><span>${i + 1}</span></a>` : "")).join("");
    }).catch(() => {});
  }

  const marcar = () => { sujo = true; $("#salvar").textContent = "Salvar alterações"; };
  const lerTaxas = () => { tx.fun = num($("#tfun").value); tx.pin = num($("#tpin").value); tx.ri = num($("#tri").value); tx.out = num($("#tout").value); };
  ["tfun", "tpin", "tri", "tout"].forEach((k) => ($("#" + k).oninput = () => { lerTaxas(); marcar(); totais(); }));

  function linha(it, i) {
    const conf = Math.round((it.conf ?? 1) * 100);
    const cls = conf >= 75 ? "hi" : conf >= 50 ? "md" : "lo";
    const v = (x) => (num(x) ? String(num(x)).replace(".", ",") : "");
    return `<tr data-i="${i}">
      <td class="c-peca"><input data-k="peca" value="${esc(it.peca)}" aria-label="Peça"></td>
      <td><select data-k="lado" aria-label="Lado"><option value="">—</option>${["ESQ", "DIR"].map((l) => `<option ${it.lado === l ? "selected" : ""}>${l}</option>`).join("")}</select></td>
      <td class="c-dec"><select data-k="decisao" class="d-${it.decisao}" aria-label="Decisão">${DEC.map((d) => `<option value="${d}" ${it.decisao === d ? "selected" : ""}>${DEC_NOME[d]}</option>`).join("")}</select></td>
      <td><input type="checkbox" data-k="pinta" ${it.pinta ? "checked" : ""} aria-label="Pinta"></td>
      <td class="c-num"><input data-k="hf" value="${v(it.hf)}" inputmode="decimal" aria-label="Horas de funilaria"></td>
      <td class="c-num"><input data-k="hp" value="${v(it.hp)}" inputmode="decimal" aria-label="Horas de pintura"></td>
      <td class="c-num"><input data-k="hri" value="${v(it.hri)}" inputmode="decimal" aria-label="Horas de R&I"></td>
      <td class="c-num"><input data-k="hout" value="${v(it.hout)}" inputmode="decimal" aria-label="Outras horas"></td>
      <td class="c-val"><input data-k="valor" value="${it.valor ? num(it.valor).toFixed(2).replace(".", ",") : ""}" placeholder="${it.decisao === "TROCAR" ? "cotar" : ""}" inputmode="decimal" aria-label="Valor da peça"></td>
      <td><input data-k="codigo" value="${esc(it.codigo ?? "")}" style="width:120px" aria-label="Código da peça"></td>
      <td><span class="conf ${cls}">${conf}%</span></td>
      <td class="porque">${esc(it.just ?? "")}</td>
      <td><button class="x" aria-label="Remover item">×</button></td></tr>`;
  }
  function desenhar() {
    $("#corpo").innerHTML = itens.length ? itens.map(linha).join("") : `<tr><td colspan="13" class="muted" style="padding:20px;text-align:center">Nenhum item. Use “Adicionar item” ou “Orçar com IA”.</td></tr>`;
    $$("#corpo tr[data-i]").forEach((tr) => {
      const it = itens[+tr.dataset.i];
      $$("[data-k]", tr).forEach((el) => {
        const k = el.dataset.k;
        const ev = el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input";
        el.addEventListener(ev, () => {
          if (k === "pinta") it.pinta = el.checked;
          else if (["hf", "hp", "hri", "hout", "valor"].includes(k)) it[k] = num(el.value);
          else if (k === "peca") it.peca = el.value.toUpperCase();
          else it[k] = el.value;
          if (k === "decisao") {
            el.className = "d-" + el.value;
            if (el.value === "RECUPERAR" && o.eletrificado) { marcar(); totais(); regraEletrico(); return; }
            if (el.value === "TROCAR" && ILUMINACAO.test(semAcento(it.peca)) && !num(it.hri) && !num(it.hout)) {
              it.hri = 0.5; it.hout = 0.5; marcar(); desenhar(); return;
            }
          }
          marcar(); totais();
        });
        if (!podeEditar) el.disabled = true;
      });
      $(".x", tr).onclick = () => { if (!podeEditar) return; itens.splice(+tr.dataset.i, 1); marcar(); desenhar(); };
    });
    totais();
  }
  function totais() {
    const t = calcular(itens, tx, cortes, o.totais?.terceiros);
    $("#resumo").textContent = `${itens.length} itens · ${t.trocas} trocar · ${t.recup} recuperar`;
    $("#totA").innerHTML = `<h3>Orçamento</h3>
      <div class="lt"><span>Funilaria</span><b>${fmtH(t.hf)} h · ${fmtR(t.hf * tx.fun)}</b></div>
      <div class="lt"><span>Pintura</span><b>${fmtH(t.hp)} h · ${fmtR(t.hp * tx.pin)}</b></div>
      <div class="lt"><span>R&amp;I</span><b>${fmtH(t.hri)} h · ${fmtR(t.hri * tx.ri)}</b></div>
      <div class="lt"><span>Outras</span><b>${fmtH(t.hout)} h · ${fmtR(t.hout * tx.out)}</b></div>
      <div class="lt"><span>Peças (${t.trocas})</span><b>${fmtR(t.pecas)}</b></div>
      ${t.vrec ? `<div class="lt"><span>Recuperação negociada</span><b>${fmtR(t.vrec)}</b></div>` : ""}
      ${t.terceiros ? `<div class="lt"><span>Serviços de terceiros</span><b>${fmtR(t.terceiros)}</b></div>` : ""}
      ${t.servicos ? `<div class="lt"><span>Serviços</span><b>${fmtR(t.servicos)}</b></div>` : ""}
      <div class="lt total"><span>Total</span><b>${fmtR(t.total)}</b></div>
      ${o.totais?.xml_total ? `<p class="small muted">No XML da seguradora: total ${fmtR(+o.totais.xml_total)}${o.totais.xml_franquia ? `, franquia ${fmtR(+o.totais.xml_franquia)}, liberado ${fmtR(+o.totais.xml_liberado)}` : ""}.</p>` : ""}`;
    $("#totB").innerHTML = `<h3>Provável aprovado pela seguradora</h3>
      <div class="lt"><span>Funilaria</span><b>${fmtH(t.ahf)} h</b></div>
      <div class="lt"><span>Pintura</span><b>${fmtH(t.ahp)} h</b></div>
      <div class="lt"><span>R&amp;I + outras</span><b>${fmtH(t.ahri + t.ahout)} h</b></div>
      <div class="lt"><span>Mão de obra</span><b>${fmtR(t.amo)}</b></div>
      <div class="lt"><span>Peças</span><b>${fmtR(t.pecas)}</b></div>
      <div class="lt total"><span>Total</span><b>${fmtR(t.atotal)}</b></div>
      <p class="small muted">Estimativa pelos cortes que as seguradoras fizeram em orçamentos parecidos.</p>`;
  }
  const regraEletrico = () => {
    if (aplicarDesenergizacao(itens, o.eletrificado, ctx.oficina.valor_desenergizacao)) {
      toast("Desenergização do sistema de alta tensão incluída automaticamente.");
      if (podeEditar) marcar();
      desenhar();
    }
  };
  desenhar();
  regraEletrico();
  $("#ed-elet").onchange = (e) => { o.eletrificado = e.target.checked; marcar(); regraEletrico(); };

  $("#add").onclick = () => { itens.push({ peca: "", lado: "", decisao: "RECUPERAR", pinta: true, hf: 0, hp: 0, hri: 0, hout: 0, valor: 0, codigo: "", conf: 1, just: "Incluído manualmente." }); marcar(); desenhar(); $$("#corpo .c-peca input").pop()?.focus(); };

  async function salvar(finalizar = false) {
    const t = calcular(itens, tx, cortes, o.totais?.terceiros);
    await api.rest.update("orcamentos", `id=eq.${o.id}`, {
      itens: itens.filter((i) => i.peca?.trim()), eletrificado: !!o.eletrificado,
      totais: { ...(o.totais || {}), taxas: tx, cortes, total: t.total, mao_de_obra: t.mo, pecas: t.pecas, provavel_aprovado: t.atotal },
    });
    if (finalizar) await api.rpc("finalizar_orcamento", { p_orcamento: o.id });
    sujo = false; $("#salvar").textContent = "Salvar";
  }
  $("#salvar").onclick = async () => { try { await salvar(); toast("Orçamento salvo."); } catch (e) { toast(e.message); } };
  $("#finalizar").onclick = async () => {
    try { await salvar(true); toast("Orçamento finalizado. A IA vai usar estas decisões nos próximos orçamentos."); telaEditor(o.id); }
    catch (e) { toast(e.message); }
  };
  $("#reorcar")?.addEventListener("click", async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "Analisando as fotos…";
    try { if (sujo) await salvar(); await api.funcao("orcar", { orcamento_id: o.id }); toast("Orçamento gerado pela IA."); telaEditor(o.id); }
    catch (ex) { toast(ex.message); b.disabled = false; b.textContent = "Orçar com IA"; }
  });
  $("#copiar").onclick = async () => {
    const t = calcular(itens, tx, cortes, o.totais?.terceiros);
    const L = [`ORÇAMENTO Nº ${o.numero} — ${ctx.oficina.nome}`, [o.placa, veiculo].filter(Boolean).join(" · "), ""];
    itens.forEach((it) => L.push(`${DEC_NOME[it.decisao].toUpperCase().padEnd(10)} ${it.peca}${it.lado ? " " + it.lado : ""}${it.pinta ? " + pintura" : ""} | fun ${fmtH(it.hf)}h pin ${fmtH(it.hp)}h R&I ${fmtH(it.hri)}h outras ${fmtH(it.hout)}h${it.decisao === "TROCAR" ? ` | peça ${it.valor ? fmtR(num(it.valor)) : "cotar"}${it.codigo ? " (" + it.codigo + ")" : ""}` : ""}`));
    L.push("", `Mão de obra ${fmtR(t.mo)} | Peças ${fmtR(t.pecas)} | TOTAL ${fmtR(t.total)}`);
    if (o.verificar?.length) L.push("", "Verificar na desmontagem:", ...o.verificar.map((s) => "- " + s));
    try { await navigator.clipboard.writeText(L.join("\n")); toast("Texto copiado."); } catch { toast("Não foi possível copiar. Use Baixar planilha."); }
  };
  $("#csv").onclick = () => {
    const rows = [["peca", "lado", "decisao", "pinta", "h_funilaria", "h_pintura", "h_ri", "h_outras", "valor_peca", "codigo", "justificativa"]];
    itens.forEach((it) => rows.push([it.peca, it.lado, DEC_NOME[it.decisao], it.pinta ? "sim" : "não", fmtH(it.hf), fmtH(it.hp), fmtH(it.hri), fmtH(it.hout), it.valor ? num(it.valor).toFixed(2).replace(".", ",") : "", it.codigo ?? "", it.just ?? ""]));
    const csv = "﻿" + rows.map((r) => r.map((v) => { const s = String(v ?? "").replace(/"/g, '""'); return /[;"\n]/.test(s) ? `"${s}"` : s; }).join(";")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `orcamento-${o.numero}${o.placa ? "-" + o.placa : ""}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $("#imprimir").onclick = () => window.print();
  $("#excluir")?.addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (b.dataset.conf !== "1") { b.dataset.conf = "1"; b.textContent = "Clique de novo para excluir"; setTimeout(() => { b.dataset.conf = ""; b.textContent = "Excluir orçamento"; }, 4000); return; }
    try { await api.rest.remove("orcamentos", `id=eq.${o.id}`); toast("Orçamento excluído."); location.hash = "#/orcamentos"; }
    catch (ex) { toast(ex.message); }
  });
  window.onbeforeunload = () => (sujo ? true : undefined);
}

// ================================================================
// oficina (configurações)
// ================================================================
async function telaConfig() {
  const of = ctx.oficina; const dono = ehDono();
  casca("configuracoes", `
  <div class="topo"><div><h1>Oficina</h1><p class="muted">Dados da oficina e valor da hora usado nos orçamentos.</p></div></div>
  <form class="painel" id="f" style="max-width:820px">
    <label class="f">Nome da oficina<input id="nome" value="${esc(of.nome)}"></label>
    <div class="grid4">
      <label class="f">CNPJ ou CPF<input id="cnpj" value="${esc(of.cnpj ?? "")}"></label>
      <label class="f">WhatsApp<input id="tel" value="${esc(of.telefone ?? "")}"></label>
      <label class="f">Cidade<input id="cidade" value="${esc(of.cidade ?? "")}"></label>
      <label class="f">UF<input id="uf" maxlength="2" value="${esc(of.uf ?? "")}"></label>
    </div>
    <header><h2>Valor da hora (R$)</h2></header>
    <div class="grid4">
      <label class="f">Funilaria<input id="tf" inputmode="decimal" value="${of.taxa_funilaria}"></label>
      <label class="f">Pintura<input id="tp" inputmode="decimal" value="${of.taxa_pintura}"></label>
      <label class="f">Remoção e instalação<input id="tr" inputmode="decimal" value="${of.taxa_ri}"></label>
      <label class="f">Outras (tapeçaria, elétrica)<input id="to" inputmode="decimal" value="${of.taxa_outras}"></label>
    </div>
    <header><h2>Serviços automáticos</h2></header>
    <div class="grid4">
      <label class="f" style="grid-column:span 2">Desenergização de híbrido/elétrico (R$)<input id="tdes" inputmode="decimal" value="${of.valor_desenergizacao ?? 750}"></label>
    </div>
    <p class="small muted">Incluída sozinha quando o veículo é híbrido ou elétrico e há desamassado em peça soldada da carroceria.</p>
    <p class="erro-txt" id="erro" hidden></p>
    ${dono ? `<div class="acoes"><button class="btn primario">Salvar dados da oficina</button></div>` : `<p class="small muted">Só o responsável pela oficina pode alterar estes dados.</p>`}
  </form>
  <section class="painel" style="max-width:820px"><header><h2>Pessoas com acesso</h2></header><div id="pessoas" class="muted">Carregando…</div>
  <p class="small muted">Para incluir outro orçamentista, fale com o suporte do Altus.</p></section>`);
  if (!dono) $$("#f input").forEach((i) => (i.disabled = true));
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const [n] = await api.rest.update("oficinas", `id=eq.${of.id}`, {
        nome: $("#nome").value.trim(), cnpj: $("#cnpj").value.trim() || null, telefone: $("#tel").value.trim() || null,
        cidade: $("#cidade").value.trim() || null, uf: $("#uf").value.trim().toUpperCase() || null,
        taxa_funilaria: num($("#tf").value), taxa_pintura: num($("#tp").value), taxa_ri: num($("#tr").value), taxa_outras: num($("#to").value), valor_desenergizacao: num($("#tdes").value) || 750,
      });
      Object.assign(ctx.oficina, n); toast("Dados da oficina salvos.");
    } catch (ex) { $("#erro").textContent = ex.message; $("#erro").hidden = false; }
  };
  try {
    const ms = await api.rest.get(`membros?select=nome,papel,criado_em&oficina_id=eq.${of.id}&order=criado_em`);
    $("#pessoas").innerHTML = `<div class="tabela"><table><thead><tr><th>Nome</th><th>Papel</th><th>Desde</th></tr></thead><tbody>${ms.map((m) => `<tr><td>${esc(m.nome || "—")}</td><td>${m.papel === "dono" ? "Responsável" : "Orçamentista"}</td><td>${fmtData(m.criado_em)}</td></tr>`).join("")}</tbody></table></div>`;
  } catch { $("#pessoas").textContent = "Não foi possível carregar."; }
}

// ================================================================
// assinatura
// ================================================================
function telaAssinatura() {
  const of = ctx.oficina; const pl = of.planos || { nome: "Altus Mensal", valor: 199 };
  if (!ehDono()) { location.hash = "#/orcamentos"; return; }
  const situacao = of.status === "trial"
    ? (oficinaAtiva() ? `Período de teste até <b>${fmtData(of.trial_ate)}</b> (${diasTeste()} dia${diasTeste() === 1 ? "" : "s"}).` : "O período de teste terminou.")
    : of.status === "ativa" ? `Assinatura ativa${of.pago_ate ? `, paga até <b>${fmtData(of.pago_ate)}</b>` : ""}.`
    : of.status === "inadimplente" ? "Há uma mensalidade vencida. Pague para continuar criando orçamentos." : "A assinatura foi cancelada.";
  casca("assinatura", `
  <div class="topo"><div><h1>Assinatura</h1><p class="muted">${situacao}</p></div><span class="etiqueta e-${of.status}">${OF_STATUS[of.status]}</span></div>
  <section class="painel" style="max-width:820px">
    <div class="plano">
      <div><h2>${esc(pl.nome)}</h2><p class="muted" style="margin-top:6px">Orçamentos com IA, histórico da oficina, consulta de placa e acesso para a equipe.</p></div>
      <div class="valor">${fmtR(+pl.valor)}<small> /mês</small></div>
    </div>
    <label class="f" style="max-width:320px">CPF ou CNPJ para a cobrança<input id="doc" inputmode="numeric" value="${esc(of.cnpj ?? "")}"></label>
    <p class="small muted">Você escolhe pagar com Pix, boleto ou cartão na página de pagamento. ${of.status === "trial" && oficinaAtiva() ? "A primeira cobrança vence no fim do período de teste." : ""}</p>
    <p class="erro-txt" id="erro" hidden></p>
    <div class="acoes">
      <button class="btn primario grande" id="pagar">${of.status === "ativa" ? "Ver cobrança atual" : "Gerar cobrança e pagar"}</button>
      <button class="btn" id="atualizar">Já paguei, atualizar situação</button>
    </div>
    <div id="link"></div>
  </section>`);
  $("#pagar").onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; $("#erro").hidden = true;
    try {
      const r = await api.funcao("assinatura", { cpf_cnpj: $("#doc").value });
      $("#link").innerHTML = r.url
        ? `<div class="aviso"><span>Cobrança de <b>${fmtR(r.valor)}</b> com vencimento em <b>${r.vencimento ? new Date(r.vencimento + "T12:00").toLocaleDateString("pt-BR") : "—"}</b>.</span><a class="btn primario" href="${esc(r.url)}" target="_blank" rel="noopener">Abrir página de pagamento</a></div>`
        : `<div class="aviso"><span>Assinatura criada. A cobrança aparece em instantes; clique de novo em “Ver cobrança atual”.</span></div>`;
    } catch (ex) { $("#erro").textContent = ex.message; $("#erro").hidden = false; }
    finally { b.disabled = false; }
  };
  $("#atualizar").onclick = async () => { await carregarContexto(); telaAssinatura(); toast(oficinaAtiva() ? "Assinatura em dia." : "O pagamento ainda não foi confirmado. Pix confirma em minutos; boleto pode levar até 3 dias úteis."); };
}

// ================================================================
// administração
// ================================================================
async function telaAdmin() {
  casca("admin", `<div class="topo"><div><h1>Administração</h1><p class="muted">Oficinas cadastradas no Altus.</p></div></div><div id="adm" class="carregando">Carregando…</div>`);
  try {
    const l = await api.rpc("admin_oficinas");
    const ativas = l.filter((o) => o.status === "ativa").length, teste = l.filter((o) => o.status === "trial").length;
    $("#adm").className = "";
    $("#adm").innerHTML = `
      <p class="muted" style="margin-bottom:12px">${l.length} oficinas · ${ativas} pagantes · ${teste} em teste · receita mensal estimada ${fmtR(ativas * 199)}</p>
      <div class="tabela"><table><thead><tr><th>Oficina</th><th>Cidade</th><th>Contato</th><th>Situação</th><th>Teste até</th><th>Pago até</th><th>Usuários</th><th>Orçamentos</th><th>No mês</th><th>Cadastro</th></tr></thead><tbody>
      ${l.map((o) => `<tr><td><b>${esc(o.nome)}</b></td><td>${esc([o.cidade, o.uf].filter(Boolean).join("/") || "—")}</td><td class="small">${esc(o.email ?? "")}<br>${esc(o.telefone ?? "")}</td>
        <td><span class="etiqueta e-${o.status}">${OF_STATUS[o.status]}</span></td><td class="num">${fmtData(o.trial_ate)}</td><td class="num">${fmtData(o.pago_ate)}</td>
        <td class="num">${o.usuarios}</td><td class="num">${o.orcamentos}</td><td class="num">${o.orcamentos_mes}</td><td class="num">${fmtData(o.criado_em)}</td></tr>`).join("")}
      </tbody></table></div>`;
  } catch (e) { $("#adm").innerHTML = `<div class="aviso erro">${esc(e.message)}</div>`; }
}

rotear();
