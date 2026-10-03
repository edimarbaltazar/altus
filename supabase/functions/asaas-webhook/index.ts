// ALTUS · asaas-webhook
// Recebe os avisos de pagamento do Asaas e libera ou bloqueia a oficina.
// Configure no Asaas: URL = <SUPABASE_URL>/functions/v1/asaas-webhook
// e o mesmo token de ASAAS_WEBHOOK_TOKEN. Publicar com verify_jwt = false.
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const esperado = Deno.env.get("ASAAS_WEBHOOK_TOKEN");
  if (!esperado || req.headers.get("asaas-access-token") !== esperado) return new Response("unauthorized", { status: 401 });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const ev = await req.json().catch(() => null);
  if (!ev?.event) return new Response("ok");

  const p = ev.payment ?? {};
  const s = ev.subscription ?? {};
  const subId = p.subscription ?? s.id ?? null;
  const ref = p.externalReference ?? s.externalReference ?? null;

  let of: { id: string; pago_ate: string | null } | null = null;
  if (subId) of = (await sb.from("oficinas").select("id, pago_ate").eq("asaas_subscription_id", subId).maybeSingle()).data;
  if (!of && ref) of = (await sb.from("oficinas").select("id, pago_ate").eq("id", ref).maybeSingle()).data;
  if (!of && p.customer) of = (await sb.from("oficinas").select("id, pago_ate").eq("asaas_customer_id", p.customer).maybeSingle()).data;

  await sb.from("pagamentos_eventos").insert({ evento: ev.event, oficina_id: of?.id ?? null, payload: ev });
  if (!of) return new Response("ok");

  switch (ev.event) {
    case "PAYMENT_CONFIRMED":
    case "PAYMENT_RECEIVED": {
      const base = p.dueDate ? new Date(p.dueDate + "T12:00:00-03:00") : new Date();
      const ate = new Date(base); ate.setMonth(ate.getMonth() + 1); ate.setDate(ate.getDate() + 3); // 3 dias de folga
      await sb.from("oficinas").update({ status: "ativa", pago_ate: ate.toISOString() }).eq("id", of.id);
      break;
    }
    case "PAYMENT_OVERDUE":
      await sb.from("oficinas").update({ status: "inadimplente" }).eq("id", of.id);
      break;
    case "SUBSCRIPTION_DELETED":
    case "SUBSCRIPTION_INACTIVATED":
      await sb.from("oficinas").update({ status: "cancelada", asaas_subscription_id: null }).eq("id", of.id);
      break;
  }
  return new Response("ok");
});
