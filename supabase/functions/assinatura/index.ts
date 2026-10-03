// ALTUS · assinatura
// Cria (ou reaproveita) o cliente e a assinatura mensal da oficina no Asaas
// e devolve o link de pagamento da próxima cobrança.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Sandbox por padrão. Em produção: ASAAS_BASE_URL=https://api.asaas.com/v3
const BASE = Deno.env.get("ASAAS_BASE_URL") ?? "https://api-sandbox.asaas.com/v3";

async function asaas(path: string, init: RequestInit = {}) {
  const key = Deno.env.get("ASAAS_API_KEY");
  if (!key) throw new Error("A chave do Asaas (ASAAS_API_KEY) não está configurada no servidor.");
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "access_token": key, "Content-Type": "application/json", "User-Agent": "Altus", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.errors?.map((e: { description: string }) => e.description).join("; ") || `Asaas respondeu ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

const hoje = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10); // data de Brasília

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: u } = await sb.auth.getUser(token);
    if (!u?.user) return json({ erro: "Faça login de novo." }, 401);

    const { data: m } = await sb.from("membros").select("oficina_id, papel").eq("user_id", u.user.id).maybeSingle();
    if (!m) return json({ erro: "Cadastre sua oficina primeiro." }, 400);
    if (m.papel !== "dono") return json({ erro: "Só o responsável pela oficina pode gerenciar a assinatura." }, 403);

    const body = await req.json().catch(() => ({}));
    const { data: of } = await sb.from("oficinas").select("*, planos(*)").eq("id", m.oficina_id).single();

    const doc = String(body.cpf_cnpj ?? of.cnpj ?? "").replace(/\D/g, "");
    if (doc.length !== 11 && doc.length !== 14) return json({ erro: "Informe um CPF ou CNPJ válido para emitir a cobrança." }, 400);
    if (doc !== String(of.cnpj ?? "").replace(/\D/g, "")) await sb.from("oficinas").update({ cnpj: doc }).eq("id", of.id);

    let customer = of.asaas_customer_id;
    if (!customer) {
      const c = await asaas("/customers", {
        method: "POST",
        body: JSON.stringify({
          name: of.nome, cpfCnpj: doc, email: of.email ?? u.user.email,
          mobilePhone: String(of.telefone ?? "").replace(/\D/g, "") || undefined,
          externalReference: of.id, notificationDisabled: false,
        }),
      });
      customer = c.id;
      await sb.from("oficinas").update({ asaas_customer_id: customer }).eq("id", of.id);
    }

    let sub = of.asaas_subscription_id;
    if (sub) {
      const s = await asaas(`/subscriptions/${sub}`).catch(() => null);
      if (!s || s.deleted || s.status === "INACTIVE" || s.status === "EXPIRED") sub = null;
    }
    if (!sub) {
      const trialFim = of.status === "trial" && of.trial_ate && new Date(of.trial_ate) > new Date()
        ? new Date(of.trial_ate).toISOString().slice(0, 10) : hoje();
      const s = await asaas("/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          customer, billingType: Deno.env.get("ASAAS_BILLING_TYPE") ?? "UNDEFINED",
          value: Number(of.planos?.valor ?? 199), nextDueDate: trialFim, cycle: "MONTHLY",
          description: `${of.planos?.nome ?? "Altus Mensal"} — ${of.nome}`, externalReference: of.id,
        }),
      });
      sub = s.id;
      await sb.from("oficinas").update({ asaas_subscription_id: sub }).eq("id", of.id);
    }

    const pays = await asaas(`/subscriptions/${sub}/payments`);
    const lista = (pays.data ?? []) as { status: string; invoiceUrl: string; dueDate: string; value: number }[];
    const aberta = lista.find((p) => ["PENDING", "OVERDUE"].includes(p.status)) ?? lista[0];
    return json({ url: aberta?.invoiceUrl ?? null, vencimento: aberta?.dueDate ?? null, valor: aberta?.value ?? null, status: aberta?.status ?? null });
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
});
