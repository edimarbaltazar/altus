// Comunicação com o Supabase sem bibliotecas: Auth, REST, RPC, Storage e Functions.
const CFG = window.ALTUS_CONFIG;
const URL_ = CFG.SUPABASE_URL;
const KEY = CFG.SUPABASE_KEY;
const SKEY = "altus.sessao";

let sessao = null;
try { sessao = JSON.parse(localStorage.getItem(SKEY) || "null"); } catch { sessao = null; }

function salvar(s) {
  sessao = s;
  try { s ? localStorage.setItem(SKEY, JSON.stringify(s)) : localStorage.removeItem(SKEY); } catch { /* sem storage */ }
}
function comExpira(s) {
  if (s && !s.expires_at && s.expires_in) s.expires_at = Math.floor(Date.now() / 1000) + Number(s.expires_in);
  return s;
}

export class ErroAPI extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

function traduz(msg = "") {
  const m = String(msg);
  if (/Invalid login credentials/i.test(m)) return "E-mail ou senha incorretos.";
  if (/Email not confirmed/i.test(m)) return "Confirme seu e-mail pelo link que enviamos antes de entrar.";
  if (/User already registered/i.test(m)) return "Já existe uma conta com este e-mail. Entre ou recupere a senha.";
  if (/Password should be at least/i.test(m)) return "A senha precisa ter pelo menos 6 caracteres.";
  if (/rate limit/i.test(m)) return "Muitas tentativas seguidas. Espere alguns minutos e tente de novo.";
  if (/JWT expired/i.test(m)) return "Sua sessão expirou. Entre de novo.";
  return m;
}

async function req(path, { method = "GET", body, headers = {}, auth = true, raw = false } = {}) {
  const h = { apikey: KEY, ...headers };
  if (auth) {
    const t = await token();
    if (t) h.Authorization = "Bearer " + t;
  }
  if (body !== undefined && !(body instanceof Blob) && !h["Content-Type"]) h["Content-Type"] = "application/json";
  const res = await fetch(URL_ + path, {
    method, headers: h,
    body: body === undefined ? undefined : (body instanceof Blob ? body : JSON.stringify(body)),
  });
  if (raw) return res;
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!res.ok) {
    const msg = (data && (data.erro || data.msg || data.message || data.error_description || data.error)) || `Erro ${res.status}`;
    if (res.status === 401 && auth && sessao) { salvar(null); location.hash = "#/entrar"; }
    throw new ErroAPI(traduz(msg), res.status);
  }
  return data;
}

// ---------- autenticação ----------
export function usuario() { return sessao?.user ?? null; }
export function logado() { return !!sessao?.access_token; }

export async function token() {
  if (!sessao) return null;
  const agora = Math.floor(Date.now() / 1000);
  if (sessao.expires_at && sessao.expires_at - agora < 60) {
    try {
      const s = await req("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: sessao.refresh_token }, auth: false });
      salvar(comExpira(s));
    } catch { salvar(null); return null; }
  }
  return sessao?.access_token ?? null;
}

export async function entrar(email, senha) {
  const s = await req("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password: senha }, auth: false });
  salvar(comExpira(s));
  return s.user;
}

export async function cadastrar(email, senha, nome) {
  const r = await req("/auth/v1/signup?redirect_to=" + encodeURIComponent(location.origin + "/"), {
    method: "POST", auth: false,
    body: { email, password: senha, data: { nome } },
  });
  if (r && r.access_token) { salvar(comExpira(r)); return { logado: true }; }
  return { logado: false }; // precisa confirmar o e-mail
}

export async function recuperarSenha(email) {
  await req("/auth/v1/recover?redirect_to=" + encodeURIComponent(location.origin + "/#/nova-senha"), { method: "POST", body: { email }, auth: false });
}

export async function trocarSenha(senha) {
  await req("/auth/v1/user", { method: "PUT", body: { password: senha } });
}

export async function sair() {
  try { await req("/auth/v1/logout", { method: "POST" }); } catch { /* ignora */ }
  salvar(null);
}

// Links de confirmação e de recuperação chegam com o token no endereço
export async function lerTokenDoEndereco() {
  const h = location.hash.replace(/^#\/?/, "");
  if (!/access_token=/.test(h)) return null;
  const p = new URLSearchParams(h.includes("?") ? h.split("?")[1] : h);
  const s = { access_token: p.get("access_token"), refresh_token: p.get("refresh_token"), expires_in: p.get("expires_in"), token_type: "bearer" };
  salvar(comExpira(s));
  try { s.user = await req("/auth/v1/user"); salvar(s); } catch { /* segue */ }
  return p.get("type") || "login";
}

// ---------- dados ----------
export const rest = {
  get: (q) => req("/rest/v1/" + q),
  insert: (tabela, dados) => req("/rest/v1/" + tabela, { method: "POST", body: dados, headers: { Prefer: "return=representation" } }),
  update: (tabela, filtro, dados) => req(`/rest/v1/${tabela}?${filtro}`, { method: "PATCH", body: dados, headers: { Prefer: "return=representation" } }),
  remove: (tabela, filtro) => req(`/rest/v1/${tabela}?${filtro}`, { method: "DELETE" }),
};
export const rpc = (nome, args = {}) => req("/rest/v1/rpc/" + nome, { method: "POST", body: args });
export const funcao = (nome, args = {}) => req("/functions/v1/" + nome, { method: "POST", body: args });

export async function enviarFoto(caminho, blob) {
  return req("/storage/v1/object/fotos/" + caminho, { method: "POST", body: blob, headers: { "Content-Type": blob.type || "image/jpeg", "x-upsert": "true" } });
}
export async function linksFotos(caminhos) {
  if (!caminhos.length) return [];
  const r = await req("/storage/v1/object/sign/fotos", { method: "POST", body: { expiresIn: 3600, paths: caminhos } });
  return (r || []).map((x) => (x.signedURL ? URL_ + "/storage/v1" + x.signedURL : null));
}
