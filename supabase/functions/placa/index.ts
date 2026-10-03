// ALTUS · placa
// Consulta dados do veículo pela placa num fornecedor externo.
// Configuração (secrets): PLACA_URL com {placa} e {token}, ex.:
//   https://fornecedor.com/api/{placa}/{token}   e   PLACA_TOKEN=xxxx
// Opcional: PLACA_HEADER_AUTH="Authorization: Bearer {token}" quando o token vai no cabeçalho.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// procura um campo pelo nome em qualquer nível do JSON do fornecedor
function achar(o: unknown, nomes: string[]): string | null {
  const alvo = nomes.map((n) => n.toLowerCase());
  const fila: unknown[] = [o];
  while (fila.length) {
    const x = fila.shift();
    if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
        if (alvo.includes(k.toLowerCase()) && (typeof v === "string" || typeof v === "number") && String(v).trim()) return String(v).trim();
        if (v && typeof v === "object") fila.push(v);
      }
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: u } = await sb.auth.getUser(token);
    if (!u?.user) return json({ erro: "Faça login de novo." }, 401);
    const { data: m } = await sb.from("membros").select("oficina_id").eq("user_id", u.user.id).maybeSingle();
    if (!m) return json({ erro: "Cadastre sua oficina primeiro." }, 400);

    const { placa } = await req.json();
    const p = String(placa ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(p)) return json({ erro: "Placa inválida. Use o formato ABC1D23 ou ABC1234." }, 400);

    const tpl = Deno.env.get("PLACA_URL"), tok = Deno.env.get("PLACA_TOKEN") ?? "";
    if (!tpl) return json({ erro: "A consulta por placa ainda não foi ativada no Altus." }, 501);

    const { data: of } = await sb.from("oficinas").select("id, planos(consultas_placa_mes)").eq("id", m.oficina_id).single();
    const mes = new Date().toISOString().slice(0, 7) + "-01";
    const { data: uso } = await sb.from("uso_mensal").select("*").eq("oficina_id", m.oficina_id).eq("mes", mes).maybeSingle();
    // deno-lint-ignore no-explicit-any
    const limite = (of as any)?.planos?.consultas_placa_mes ?? 100;
    if (uso && uso.consultas_placa >= limite) return json({ erro: `Limite de ${limite} consultas de placa no mês atingido.` }, 429);

    const headers: Record<string, string> = { Accept: "application/json" };
    const ha = Deno.env.get("PLACA_HEADER_AUTH");
    if (ha) { const [k, ...v] = ha.replace("{token}", tok).split(":"); headers[k.trim()] = v.join(":").trim(); }
    const res = await fetch(tpl.replace("{placa}", p).replace("{token}", tok), { headers });
    const dados = await res.json().catch(() => null);
    if (!res.ok || !dados) return json({ erro: "O serviço de placas não respondeu. Preencha os dados à mão." }, 502);

    await sb.from("uso_mensal").upsert({ oficina_id: m.oficina_id, mes, orcamentos_ia: uso?.orcamentos_ia ?? 0, consultas_placa: (uso?.consultas_placa ?? 0) + 1 });

    return json({
      placa: p,
      marca: achar(dados, ["marca", "MARCA", "brand", "fabricante"]),
      modelo: achar(dados, ["modelo", "MODELO", "model", "submodelo"]),
      versao: achar(dados, ["versao", "VERSAO", "version"]),
      ano: achar(dados, ["anoModelo", "ano_modelo", "ano", "ANO", "year"]),
      cor: achar(dados, ["cor", "COR", "color"]),
      chassi: achar(dados, ["chassi", "CHASSI", "vin"]),
    });
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
});
