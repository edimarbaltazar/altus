# Altus — orçamento de funilaria com IA

- `web/` — site (HTML/CSS/JS sem build), publicado no Netlify.
- `supabase/migrations/` — banco (tabelas, regras de acesso).
- `supabase/functions/` — funções do servidor: `orcar` (IA), `assinatura` e `asaas-webhook` (cobrança), `placa`.

## Segredos do servidor (Supabase → Edge Functions → Secrets)
- `ANTHROPIC_API_KEY` — chave da API do Claude.
- `ANTHROPIC_MODEL` (opcional) — padrão `claude-sonnet-5-5`.
- `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`, `ASAAS_BASE_URL` (produção: `https://api.asaas.com/v3`).
- `PLACA_URL`, `PLACA_TOKEN` — fornecedor de consulta de placa.

## Banco
As migrações aplicadas ficam no histórico do próprio Supabase (projeto `altus`):
`altus_init_tabelas`, `altus_init_funcoes`, `altus_protecoes`, mais a carga de `ia_cortes` (`supabase/seed/cortes.sql`).
A base compartilhada `ia_base_decisoes` é carregada a partir de `web/dados/`.
