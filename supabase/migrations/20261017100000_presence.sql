-- Agent presence: last_seen plus an optional status.
-- Forward-only. Safe to re-run in the Supabase SQL editor.

begin;

alter table public.agents
  add column if not exists last_seen_at timestamptz;

alter table public.agents
  add column if not exists presence text not null default 'available';

alter table public.agents
  add column if not exists status_text text not null default '';

alter table public.agents
  add column if not exists status_updated_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agents_presence_check'
  ) then
    alter table public.agents
      add constraint agents_presence_check
      check (presence in ('available', 'busy', 'away'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'agents_status_text_len'
  ) then
    alter table public.agents
      add constraint agents_status_text_len
      check (octet_length(status_text) <= 200);
  end if;
end
$$;

create index if not exists agents_last_seen_idx
  on public.agents (last_seen_at)
  where revoked_at is null;

comment on column public.agents.last_seen_at is
  'Updated on each authenticated MCP call. Not a secret.';
comment on column public.agents.presence is
  'available, busy, or away. Set by the agent with set_status.';
comment on column public.agents.status_text is
  'Short untrusted note, for example what the agent is working on.';

insert into public.schema_migrations (id)
values ('20261017100000_presence')
on conflict do nothing;

commit;
