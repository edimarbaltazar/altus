// ALTUS · orcar
// Recebe { orcamento_id } (fotos + IA), { orcamento_id, danos } (danos marcados) ou
// { orcamento_id, danos, calcular: true } (só devolve os itens calculados). Com fotos, pede ao Claude para identificar
// os danos, cruza com o histórico (ia_stats) e monta o orçamento sugerido.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5";
const DEC = ["TROCAR", "RECUPERAR", "SO_PINTAR", "REMOVER_INSTALAR"];
const MAX_FOTOS = 20;

// ---------- nomes de peça ----------
const norm = (t: string) => String(t ?? "").replace(/\s*\[Forn:[^\]]*\]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
function iaBase(t: string) {
  let s = " " + norm(t) + " ";
  s = s.replace(/ (DIANTEIRA|DIANTEIRO)(?= )/g, " DIANT").replace(/ (TRASEIRA|TRASEIRO)(?= )/g, " TRAS")
    .replace(/ (ESQUERDA|ESQUERDO|DIREITA|DIREITO|ESQ|DIR|LE|LD)(?= )/g, "");
  return s.replace(/\s+/g, " ").trim();
}
const strip = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
function matchVocab(name: string, vocab: string[]): string {
  const b = iaBase(name);
  const key = strip(b);
  const exact = vocab.find((v) => strip(v) === key);
  if (exact) return exact;
  const tk = new Set(key.split(" "));
  let best = "", bs = 0;
  for (const v of vocab) {
    const t2 = strip(v).split(" ");
    const inter = t2.filter((t) => tk.has(t)).length;
    const sc = inter / (tk.size + t2.length - inter);
    if (sc > bs) { bs = sc; best = v; }
  }
  return bs >= 0.5 ? best : b;
}
// Peças de iluminação (farol, lanterna, brake light, pisca, repetidor):
//   troca = 0,5 h elétrica + 0,5 h R&I · recuperar = no mínimo 0,5 h elétrica + 0,5 h R&I · só R&I = 0,5 h R&I
const ILUMINACAO = /^(FAROL|LANTERNA|BRAKE LIGHT|PISCA|REPETIDOR|LUZ D[AEO])/;
const ehIluminacao = (peca: string) => ILUMINACAO.test(strip(norm(peca)));
function padraoIluminacao(it: { peca: string; decisao: string; pinta: boolean; hf: number; hp: number; hri: number; hout: number; just: string }) {
  if (!ehIluminacao(it.peca)) return;
  let txt = "";
  if (it.decisao === "TROCAR") { it.hf = 0; it.hri = 0.5; it.hout = 0.5; txt = "0,5 h elétrica + 0,5 h R&I"; }
  else if (it.decisao === "RECUPERAR") { it.hri = Math.max(num(it.hri), 0.5); it.hout = Math.max(num(it.hout), 0.5); txt = "0,5 h elétrica + 0,5 h R&I"; }
  else if (it.decisao === "REMOVER_INSTALAR") { it.hf = 0; it.hp = 0; it.pinta = false; it.hri = 0.5; it.hout = 0; txt = "0,5 h R&I"; }
  if (txt) it.just = (it.just ? it.just + " " : "") + `Padrão iluminação: ${txt}.`;
}
// Apelidos de marca usados no dia a dia
const MARCAS: Record<string, string> = {
  GM: "CHEVROLET", "GENERAL MOTORS": "CHEVROLET", CHEV: "CHEVROLET", VW: "VOLKSWAGEN", VOLKS: "VOLKSWAGEN",
  MERCEDES: "MERCEDES-BENZ", MB: "MERCEDES-BENZ", "MERCEDES BENZ": "MERCEDES-BENZ", "CITROËN": "CITROEN",
  LANDROVER: "LAND ROVER", "GREAT WALL": "GWM", "CAOA CHERY": "CHERY", IVECO: "IVECO/FIAT",
};
// Híbridos/elétricos: desenergização quando há desamassado em peça soldada da carroceria
const TERMOS_ELETRIFICADO = /(^|[^A-Z])(HYBRID|HIBRIDO|HEV|PHEV|MHEV|BEV|EV|ELETRICO|ELECTRIC|E-TECH|E-TRON|E-POWER|RECHARGE|EQA|EQB|EQC|EQE|EQS|PLUG-IN)([^A-Z]|$)/;
const MARCAS_ELETRIFICADAS = /^(BYD|TESLA|ZEEKR|NETA|JAC E|SERES)/;
const MODELOS_ELETRIFICADOS = /(^|[^A-Z])(DOLPHIN|SEAL|YUAN|SONG|TAN|HAN|KING|SHARK|LEAF|BOLT|IONIQ|ID\.?[34]|ID\.?BUZZ|EX30|EX40|C40|I3|IX|IX1|IX3|TAYCAN|ORA|HAVAL H6|TANK 300|E-JS1|E-JS4|E-208|E-2008|KWID E|SPARK EUV|EQUINOX EV|BLAZER EV|MUSTANG MACH|ARIATTO|AION|TIGGO 7 PRO HYBRID|TIGGO 8 PRO HYBRID)([^A-Z0-9]|$)/;
function ehEletrificado(...textos: (string | null | undefined)[]) {
  const t = strip(textos.filter(Boolean).join(" ")).toUpperCase().replace(/\s+/g, " ").trim();
  return !!t && (TERMOS_ELETRIFICADO.test(t) || MARCAS_ELETRIFICADAS.test(t) || MODELOS_ELETRIFICADOS.test(t));
}
const SOLDADAS = /^(LATERAL|PARALAMA TRAS|COLUNA|CAIXA DE RODA|CAIXA DA SOLEIRA|SOLEIRA|LONGARINA|PAINEL TRAS|PAINEL DIANT|ASSOALHO|TETO|TRAVESSA|AVENTAL|TORRE|ALOJAMENTO|CHASSI|CAIXA DE AR|QUADRO DO PARABRISA|ESTRUTURA|FECHAMENTO DA LATERAL|LATERAL EXTERNA)/;
const ehPecaSoldada = (peca: string) => SOLDADAS.test(strip(norm(peca)));
const marcaPadrao = (m: string) => { const k = String(m ?? "").toUpperCase().trim(); return MARCAS[k] ?? k; };
const num = (v: unknown) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const r5 = (v: number) => Math.round(v * 2) / 2;

// ---------- Claude ----------
async function claude(content: unknown[], maxTokens = 4096) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("A chave da IA (ANTHROPIC_API_KEY) não está configurada no servidor.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error("Erro da IA: " + (body?.error?.message ?? res.status));
  const text = (body.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("A IA respondeu fora do formato esperado.");
  return JSON.parse(text.slice(a, b + 1));
}

function b64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

type Dano = {
  peca: string; lado?: string; material?: string; tipo_dano?: string; severidade?: string;
  vinco_ou_dobra?: boolean; pintura_danificada?: boolean; fotos?: number[]; confianca?: number; observacao?: string;
};
type Stats = {
  n: number; n_oficina: number; trocar: number; recuperar: number; so_pintar: number; ri: number; pct_pinta: number | null;
  hf_med: number | null; hf_p75: number | null; hp_med: number | null; hri_med: number | null; hout_med: number | null;
  valor_modelo: number | null; codigo_modelo: string | null; valor_geral: number | null;
  exemplos: { modelo: string; lado: string; decisao: string; h_funilaria: number; h_pintura: number; h_ri: number; h_outras: number }[];
};
type Item = {
  peca: string; lado: string; decisao: string; pinta: boolean; hf: number; hp: number; hri: number; hout: number;
  valor: number; codigo: string; conf: number; just: string; n: number; peca_base: string;
};

function regraLocal(d: Dano, base: string, st: Stats | null): Item {
  const sev = d.severidade ?? "MEDIO";
  const dano = strip(String(d.tipo_dano ?? "")).toLowerCase();
  const fragil = /trinc|quebr|rasg/.test(dano);
  const pctT = st && st.trocar + st.recuperar > 0 ? st.trocar / (st.trocar + st.recuperar) : null;
  let dec = "RECUPERAR";
  if (sev === "GRAVE" && (fragil || (d.material ?? "") !== "METAL")) dec = "TROCAR";
  else if (fragil && (d.material === "PLASTICO" || d.material === "VIDRO")) dec = "TROCAR";
  else if (pctT !== null && pctT > 0.6 && sev !== "LEVE") dec = "TROCAR";
  else if (dano.includes("risc") && sev === "LEVE") dec = "SO_PINTAR";
  else if (st && st.n > 0 && st.trocar + st.recuperar === 0) dec = "REMOVER_INSTALAR";
  if (ehIluminacao(base)) {
    // iluminação: quebrado/trincado/grave = troca; riscado/amassado/deformado = recuperar
    if (fragil || sev === "GRAVE") dec = "TROCAR";
    else if (dec === "SO_PINTAR" || dec === "REMOVER_INSTALAR") dec = "RECUPERAR";
  }
  const semDano = /sem dano|solto/.test(dano) && (dano.includes("sem dano") || ehIluminacao(base));
  if (semDano) dec = "REMOVER_INSTALAR"; // não danificou: só remover e instalar de novo
  const pinta = dec !== "REMOVER_INSTALAR" && !ehIluminacao(base) && (!!d.pintura_danificada || (st?.pct_pinta ?? 0) > 50);
  const it: Item = {
    peca: base, lado: d.lado ?? "", decisao: dec, pinta, hf: 0, hp: 0, hri: 0, hout: 0, valor: 0, codigo: "",
    conf: d.confianca ?? 0.6, n: st?.n ?? 0, peca_base: base,
    just: st && st.n ? `Histórico: ${st.n} casos, trocou ${st.trocar}, recuperou ${st.recuperar}.` : "Peça sem histórico. Confira.",
  };
  if (dec === "RECUPERAR") it.hf = st?.hf_med != null ? r5(sev === "GRAVE" ? (st.hf_p75 ?? st.hf_med) : sev === "LEVE" ? Math.max(0.5, st.hf_med * 0.6) : st.hf_med) : 2;
  if (pinta && dec !== "REMOVER_INSTALAR") it.hp = st?.hp_med != null ? r5(st.hp_med) : 2;
  if (dec === "TROCAR" || dec === "REMOVER_INSTALAR") it.hri = st?.hri_med ?? (dec === "TROCAR" ? 1 : 0.5);
  return it;
}

function valorPeca(it: Item, st: Stats | null) {
  if (it.decisao !== "TROCAR") { it.valor = 0; it.codigo = ""; return; }
  if (!it.valor) {
    const v = st?.valor_modelo ?? st?.valor_geral ?? 0;
    it.valor = v ? Math.round(v * 100) / 100 : 0;
    it.codigo = st?.valor_modelo ? (st.codigo_modelo ?? "") : "";
  }
}

function aplicarIA(o: Record<string, unknown>, it: Item, st: Stats | null): Item {
  const d = String(o.decisao ?? "").toUpperCase();
  if (DEC.includes(d)) it.decisao = d;
  if (typeof o.pinta === "boolean") it.pinta = o.pinta;
  it.hf = num(o.h_funilaria); it.hp = num(o.h_pintura); it.hri = num(o.h_ri); it.hout = num(o.h_outros);
  if (o.confianca != null) it.conf = Math.max(0, Math.min(1, num(o.confianca)));
  if (o.justificativa) it.just = String(o.justificativa);
  valorPeca(it, st);
  return it;
}

function fmt(v: number | null | undefined) { return v == null ? "-" : String(Math.round(v * 10) / 10).replace(".", ","); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let orcId = "";
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: u } = await sb.auth.getUser(token);
    if (!u?.user) return json({ erro: "Faça login de novo." }, 401);
    const body = await req.json();
    const { orcamento_id } = body;

    // informações para a tela: IA ligada? vocabulário de peças
    if (body.info) {
      const { data: vocab } = await sb.rpc("ia_vocabulario", { p_limite: 600 });
      return json({ ia: !!Deno.env.get("ANTHROPIC_API_KEY"), vocabulario: vocab ?? [] });
    }
    orcId = orcamento_id;
    const danosManuais: Dano[] | null = Array.isArray(body.danos)
      ? body.danos.filter((d: Dano) => d && String(d.peca ?? "").trim()).slice(0, 40).map((d: Dano) => ({
          peca: norm(d.peca), lado: ["ESQ", "DIR"].includes(String(d.lado)) ? d.lado : "",
          material: String(d.material ?? "METAL").toUpperCase(), tipo_dano: String(d.tipo_dano ?? "amassado"),
          severidade: ["LEVE", "MEDIO", "GRAVE"].includes(String(d.severidade)) ? d.severidade : "MEDIO",
          vinco_ou_dobra: !!d.vinco_ou_dobra, pintura_danificada: d.pintura_danificada !== false, confianca: 0.9, observacao: "marcado pelo orçador",
        }))
      : null;
    if (danosManuais && !danosManuais.length) return json({ erro: "Marque pelo menos um dano." }, 400);
    const calcular = !!body.calcular && !!danosManuais;
    if (calcular) orcId = ""; // erro no cálculo não mexe no status do orçamento

    const { data: orc } = await sb.from("orcamentos").select("*").eq("id", orcamento_id).single();
    if (!orc) return json({ erro: "Orçamento não encontrado." }, 404);
    const { data: membro } = await sb.from("membros").select("papel").eq("oficina_id", orc.oficina_id).eq("user_id", u.user.id).maybeSingle();
    if (!membro) return json({ erro: "Orçamento não encontrado." }, 404);
    const { data: of } = await sb.from("oficinas").select("*, planos(*)").eq("id", orc.oficina_id).single();
    const ativa = (of.status === "trial" && new Date(of.trial_ate) > new Date()) || of.status === "ativa";
    if (!ativa) return json({ erro: "A assinatura da oficina não está ativa. Regularize em Assinatura para continuar orçando." }, 402);

    const mes = new Date().toISOString().slice(0, 7) + "-01";
    const { data: uso } = await sb.from("uso_mensal").select("*").eq("oficina_id", of.id).eq("mes", mes).maybeSingle();
    if (!danosManuais && uso && uso.orcamentos_ia >= (of.planos?.orcamentos_ia_mes ?? 300))
      return json({ erro: "Limite mensal de orçamentos com IA atingido. Fale com o suporte do Altus." }, 429);

    const temIA = !!Deno.env.get("ANTHROPIC_API_KEY");
    const veic = `${orc.marca ?? ""} ${orc.modelo ?? ""} ${orc.versao ?? ""} ${orc.ano ?? ""}`.replace(/\s+/g, " ").trim();
    // deno-lint-ignore no-explicit-any
    let r1: any = {};
    let danos: Dano[];
    let vocab: string[] = [];

    if (danosManuais) {
      // MODO MARCAR DANOS — sem IA, só histórico
      const { data: v } = await sb.rpc("ia_vocabulario", { p_limite: 2500 });
      vocab = v ?? [];
      danos = danosManuais;
    } else {
      if (!temIA) return json({ erro: "A leitura de fotos pela IA ainda não está ativada. Use “Marcar danos” para orçar pelo histórico." }, 503);
      const { data: fotos } = await sb.from("orcamento_fotos").select("caminho").eq("orcamento_id", orc.id).order("ordem").limit(MAX_FOTOS);
      if (!fotos?.length) return json({ erro: "Envie pelo menos uma foto do dano." }, 400);
      await sb.from("orcamentos").update({ status: "analisando", erro: null }).eq("id", orc.id);

      const imgs: unknown[] = [];
      for (const f of fotos) {
        const { data: blob, error } = await sb.storage.from("fotos").download(f.caminho);
        if (error || !blob) continue;
        const type = blob.type && blob.type.startsWith("image/") ? blob.type : "image/jpeg";
        imgs.push({ type: "image", source: { type: "base64", media_type: type, data: b64(await blob.arrayBuffer()) } });
      }
      if (!imgs.length) throw new Error("Não foi possível ler as fotos enviadas.");

      const { data: v } = await sb.rpc("ia_vocabulario", { p_limite: 300 });
      vocab = v ?? [];

      // ETAPA 1 — identificar danos
      const p1 = `Você é um orçamentista sênior de funilaria e pintura no Brasil e trabalha com sinistros de seguradora.
As ${imgs.length} imagens acima (numeradas de 1 a ${imgs.length}, na ordem) são do veículo ${veic || "(modelo não informado)"}.
Identifique cada peça danificada PELO SINISTRO (ignore desgaste antigo, sujeira e reflexos). Junte a mesma peça vista em várias fotos num único item.
Para o nome da peça use, sempre que possível, exatamente um destes nomes (sem o lado; o lado vai no campo "lado"):
${vocab.join(" | ")}
Responda SOMENTE com JSON:
{"danos":[{"peca":"PARALAMA DIANT","lado":"ESQ","material":"METAL","tipo_dano":"amassado","severidade":"MEDIO","vinco_ou_dobra":false,"pintura_danificada":true,"fotos":[1,3],"confianca":0.8,"observacao":"amassado de ~20 cm no arco de roda"}],
"suspeitas_ocultas":["..."],"qualidade_fotos":"comentário curto sobre fotos faltando ou ruins"}
lado = "ESQ", "DIR" ou "". material = METAL, PLASTICO, VIDRO ou OUTRO. tipo_dano = amassado, riscado, trincado, quebrado, rasgado, deformado, solto ou outro. severidade = LEVE, MEDIO ou GRAVE.`;
      r1 = await claude([...imgs, { type: "text", text: p1 }]);
      danos = (Array.isArray(r1?.danos) ? r1.danos : []).filter((d: Dano) => d && d.peca);
      if (!danos.length) throw new Error("Nenhuma peça danificada foi identificada. Confira se as fotos mostram o dano de perto.");
    }

    // ETAPA 2 — histórico
    const bases = danos.map((d) => matchVocab(d.peca, vocab));
    const stats: (Stats | null)[] = [];
    for (const b of bases) {
      const { data } = await sb.rpc("ia_stats", { p_peca_base: b, p_modelo: orc.modelo ?? "", p_marca: marcaPadrao(orc.marca ?? ""), p_oficina: of.id });
      stats.push(data && data.n > 0 ? data as Stats : null);
    }
    const blocos = danos.map((d, i) => {
      const st = stats[i];
      let s = `#${i + 1} ${bases[i]} ${d.lado ?? ""} — ${d.material ?? "?"}, ${d.tipo_dano ?? "?"}, ${d.severidade ?? "?"}, ${d.vinco_ou_dobra ? "com vinco/dobra" : "sem vinco"}, pintura ${d.pintura_danificada ? "danificada" : "ok"}. Visto: ${d.observacao ?? "-"}.`;
      if (!st) return s + "\n   Sem histórico para esta peça.";
      s += `\n   Histórico (${st.n} casos${st.n_oficina ? `, ${st.n_oficina} desta oficina` : ""}): trocar ${st.trocar}, recuperar ${st.recuperar}, só pintar ${st.so_pintar}, R&I ${st.ri}; pinta em ${st.pct_pinta ?? 0}%.`;
      s += `\n   Recuperar: mediana ${fmt(st.hf_med)} h funilaria (p75 ${fmt(st.hf_p75)} h). Pintura mediana ${fmt(st.hp_med)} h. R&I mediana ${fmt(st.hri_med)} h. Outras mediana ${fmt(st.hout_med)} h.`;
      if (st.exemplos?.length) s += "\n   Casos: " + st.exemplos.map((e) => `${e.modelo ?? "?"} ${e.lado ?? ""}: ${e.decisao} fun ${fmt(e.h_funilaria)} pin ${fmt(e.h_pintura)} ri ${fmt(e.h_ri)} out ${fmt(e.h_outras)}`).join("; ");
      return s;
    }).join("\n");

    // ETAPA 3 — montar orçamento
    const p2 = `Você é orçamentista sênior de funilaria e pintura (sinistros de seguradora, Brasil). Monte o orçamento do ${veic} seguindo o MÉTODO DA OFICINA mostrado no histórico de cada peça.
Danos identificados nas fotos:
${blocos}

Regras:
- decisao: TROCAR, RECUPERAR, SO_PINTAR ou REMOVER_INSTALAR, seguindo o que mais se fez em casos parecidos, ajustado pela severidade (plástico/vidro trincado, quebrado ou rasgado e dano GRAVE tendem a TROCAR; metal LEVE/MEDIO sem vinco tende a RECUPERAR).
- Horas: mediana do histórico; GRAVE perto do p75; LEVE abaixo da mediana. Peça trocada tem R&I e, se costuma ser pintada, pintura. Múltiplos de 0,5 h.
- "adicionais": itens de remoção/instalação, tapeçaria ou elétrica que a oficina costuma lançar junto (ex.: forro e componentes da porta ao recuperar a porta). Não inclua insumos nem taxas.
- "verificar_desmontagem": danos ocultos prováveis.
Responda SOMENTE com JSON:
{"itens":[{"ref":1,"decisao":"RECUPERAR","pinta":true,"h_funilaria":4.5,"h_pintura":3,"h_ri":0,"h_outros":0,"confianca":0.7,"justificativa":"frase curta citando o histórico"}],
"adicionais":[{"peca":"FORRO DA PORTA DIANT","lado":"DIR","decisao":"REMOVER_INSTALAR","pinta":false,"h_funilaria":0,"h_pintura":0,"h_ri":0,"h_outros":0.5,"confianca":0.7,"justificativa":"..."}],
"verificar_desmontagem":["..."],"observacoes":["..."]}`;
    const itens: Item[] = danos.map((d, i) => { const it = regraLocal(d, bases[i], stats[i]); valorPeca(it, stats[i]); return it; });
    const obs: string[] = [];
    let verificar: string[] = (r1.suspeitas_ocultas ?? []).map(String);
    try {
      if (!temIA || calcular) throw new Error("sem IA");
      const r2 = await claude([{ type: "text", text: p2 }]);
      (r2.itens ?? []).forEach((o: Record<string, unknown>) => {
        const i = num(o.ref) - 1;
        if (itens[i]) aplicarIA(o, itens[i], stats[i]);
      });
      for (const a of r2.adicionais ?? []) {
        if (!a?.peca) continue;
        const b = iaBase(a.peca);
        const it: Item = { peca: norm(a.peca), lado: a.lado ?? "", decisao: "REMOVER_INSTALAR", pinta: false, hf: 0, hp: 0, hri: 0, hout: 0, valor: 0, codigo: "", conf: 0.5, just: "", n: 0, peca_base: b };
        itens.push(aplicarIA(a, it, null));
      }
      verificar = [...verificar, ...(r2.verificar_desmontagem ?? []).map(String)];
      obs.push(...(r2.observacoes ?? []).map(String));
    } catch (e) {
      obs.push(temIA ? "A etapa de montagem da IA falhou; itens calculados só pelo histórico. (" + (e as Error).message + ")"
        : "Orçamento montado pelo histórico da base a partir dos danos marcados. Confira as horas e inclua os itens de remoção e instalação.");
    }
    itens.forEach(padraoIluminacao);
    const eletrificado = !!orc.eletrificado || ehEletrificado(orc.marca, orc.modelo, orc.versao);
    if (!calcular && eletrificado && itens.some((i) => i.decisao === "RECUPERAR" && ehPecaSoldada(i.peca)) && !itens.some((i) => strip(i.peca).toUpperCase().startsWith("DESENERGIZ"))) {
      itens.push({ peca: "DESENERGIZAÇÃO DO SISTEMA DE ALTA TENSÃO", lado: "", decisao: "SERVICO", pinta: false, hf: 0, hp: 0, hri: 0, hout: 0,
        valor: Number(of.valor_desenergizacao ?? 750) || 750, codigo: "", conf: 1, n: 0, peca_base: "DESENERGIZACAO",
        just: "Automático: veículo híbrido/elétrico com desamassado em peça soldada da carroceria." });
    }
    danos.forEach((d, i) => { if (d.fotos?.length && itens[i]) itens[i].just += ` (fotos ${d.fotos.join(", ")})`; });
    if (r1.qualidade_fotos) obs.push("Fotos: " + r1.qualidade_fotos);

    // cortes prováveis da seguradora: por peça quando houver histórico, senão a média geral
    const { data: cortesRows } = await sb.from("ia_cortes").select("peca_base, categoria, razao");
    const cmap = new Map<string, number>();
    for (const c of cortesRows ?? []) cmap.set(`${c.peca_base}|${c.categoria}`, Number(c.razao));
    const geral = { fun: cmap.get("*|fun") ?? 0.736, pin: cmap.get("*|pin") ?? 0.823, ri: cmap.get("*|ri") ?? 0.796, out: cmap.get("*|out") ?? 0.754 };
    const itensComCorte = itens.map((it) => {
      const cut: Record<string, number> = {};
      for (const k of ["fun", "pin", "ri", "out"]) { const v = cmap.get(`${it.peca_base}|${k}`); if (v != null) cut[k] = v; }
      return Object.keys(cut).length ? { ...it, cut } : it;
    });
    const totais = {
      ...(orc.totais ?? {}),
      cortes: geral,
      taxas: orc.totais?.taxas ?? { fun: Number(of.taxa_funilaria), pin: Number(of.taxa_pintura), ri: Number(of.taxa_ri), out: Number(of.taxa_outras) },
    };

    // só calcular itens para acrescentar a um orçamento já aberto (não grava)
    if (calcular) return json({ itens: itensComCorte });

    await sb.from("orcamentos").update({
      status: "sugerido", origem: danosManuais ? "manual" : "ia", eletrificado, danos, itens: itensComCorte, totais, verificar: [...new Set(verificar)], observacoes: obs, modelo_ia: temIA ? MODEL : null, erro: null,
    }).eq("id", orc.id);
    if (!danosManuais) await sb.from("uso_mensal").upsert({ oficina_id: of.id, mes, orcamentos_ia: (uso?.orcamentos_ia ?? 0) + 1, consultas_placa: uso?.consultas_placa ?? 0 });

    const { data: final } = await sb.from("orcamentos").select("*").eq("id", orc.id).single();
    return json({ orcamento: final });
  } catch (e) {
    const msg = (e as Error).message ?? "Erro inesperado.";
    if (orcId) await sb.from("orcamentos").update({ status: "rascunho", erro: msg }).eq("id", orcId);
    return json({ erro: msg }, 500);
  }
});
