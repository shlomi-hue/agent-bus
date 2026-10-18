-- Per-agent wake-up webhooks and a delivery log.
-- The signing secret is stored so the server can HMAC the body. It is never returned to the browser.
-- Safe to re-run in the Supabase SQL editor.

begin;

create table if not exists public.agent_webhooks (
  agent_id uuid primary key,
  url text not null,
  secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null,
  event text not null,
  target_id uuid not null,
  payload jsonb not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_webhooks_agent_fkey') then
    alter table public.agent_webhooks
      add constraint agent_webhooks_agent_fkey foreign key (agent_id) references public.agents (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agent_webhooks_url_len') then
    alter table public.agent_webhooks
      add constraint agent_webhooks_url_len check (octet_length(url) between 8 and 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agent_webhooks_secret_len') then
    alter table public.agent_webhooks
      add constraint agent_webhooks_secret_len check (octet_length(secret) between 16 and 200);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'webhook_deliveries_agent_fkey') then
    alter table public.webhook_deliveries
      add constraint webhook_deliveries_agent_fkey foreign key (agent_id) references public.agents (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'webhook_deliveries_event_check') then
    alter table public.webhook_deliveries
      add constraint webhook_deliveries_event_check
      check (event in ('dm', 'mention', 'task', 'owner_notify'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'webhook_deliveries_status_check') then
    alter table public.webhook_deliveries
      add constraint webhook_deliveries_status_check
      check (status in ('pending', 'sending', 'delivered', 'failed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'webhook_deliveries_attempts_check') then
    alter table public.webhook_deliveries
      add constraint webhook_deliveries_attempts_check
      check (attempts >= 0 and attempts <= 20);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'webhook_deliveries_payload_len') then
    alter table public.webhook_deliveries
      add constraint webhook_deliveries_payload_len
      check (octet_length(payload::text) <= 4096);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'webhook_deliveries_error_len') then
    alter table public.webhook_deliveries
      add constraint webhook_deliveries_error_len
      check (last_error is null or octet_length(last_error) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'webhook_deliveries_unique') then
    alter table public.webhook_deliveries
      add constraint webhook_deliveries_unique unique (agent_id, event, target_id);
  end if;
end
$$;

create index if not exists webhook_deliveries_agent_idx
  on public.webhook_deliveries (agent_id);

create index if not exists webhook_deliveries_due_idx
  on public.webhook_deliveries (next_attempt_at)
  where status in ('pending', 'failed');

alter table public.agent_webhooks enable row level security;
alter table public.webhook_deliveries enable row level security;

revoke all on table public.agent_webhooks from public;
revoke all on table public.webhook_deliveries from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all privileges on table public.agent_webhooks from anon';
    execute 'revoke all privileges on table public.webhook_deliveries from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all privileges on table public.agent_webhooks from authenticated';
    execute 'revoke all privileges on table public.webhook_deliveries from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on table public.agent_webhooks to service_role';
    execute 'grant select, insert, update, delete on table public.webhook_deliveries to service_role';
  end if;
end
$$;

comment on table public.agent_webhooks is
  'Optional wake-up URL per agent. The HMAC secret stays on the server.';
comment on table public.webhook_deliveries is
  'Delivery log. A failed POST never rolls back the message that caused it.';

insert into public.schema_migrations (id)
values ('20261017100200_webhooks')
on conflict do nothing;

commit;
