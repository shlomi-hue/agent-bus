-- agent-bus initial schema.
-- Apply in the Supabase SQL editor, or locally with `npm run db:migrate`.
-- The server connects as the service role (or the table owner). Both bypass RLS.
-- anon and authenticated keep no policies, so the Data API cannot read these tables.

begin;

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  token_hash text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint agents_name_format check (name ~ '^[a-z][a-z0-9_-]{0,63}$'),
  constraint agents_name_unique unique (name),
  constraint agents_description_length check (char_length(description) <= 500),
  constraint agents_token_hash_len check (char_length(token_hash) = 64),
  constraint agents_token_hash_unique unique (token_hash)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null,
  from_agent uuid not null,
  to_agent uuid not null,
  body text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  acked_at timestamptz,
  hop_count integer not null,
  reply_to uuid,
  constraint messages_body_size check (octet_length(body) between 1 and 16384),
  constraint messages_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint messages_metadata_size check (octet_length(metadata::text) <= 16384),
  constraint messages_hop_count_range check (hop_count >= 0 and hop_count <= 100),
  constraint messages_not_self check (from_agent <> to_agent),
  constraint messages_from_agent_fkey foreign key (from_agent) references public.agents (id),
  constraint messages_to_agent_fkey foreign key (to_agent) references public.agents (id),
  constraint messages_reply_to_fkey foreign key (reply_to) references public.messages (id)
);

create table public.rate_events (
  id bigint generated always as identity primary key,
  agent_id uuid not null,
  created_at timestamptz not null default now(),
  constraint rate_events_agent_fkey foreign key (agent_id) references public.agents (id)
);

create table public.schema_migrations (
  id text primary key,
  applied_at timestamptz not null default now()
);

-- Inbox scans are always "messages for this recipient, oldest first",
-- often restricted to rows that have not been read yet.
create index messages_inbox_idx
  on public.messages (to_agent, created_at);

create index messages_inbox_unread_idx
  on public.messages (to_agent, created_at)
  where read_at is null;

create index messages_thread_created_idx
  on public.messages (thread_id, created_at);

create index messages_from_agent_created_idx
  on public.messages (from_agent, created_at desc);

create index messages_reply_to_idx
  on public.messages (reply_to);

create index rate_events_agent_created_idx
  on public.rate_events (agent_id, created_at desc);

alter table public.agents enable row level security;
alter table public.messages enable row level security;
alter table public.rate_events enable row level security;
alter table public.schema_migrations enable row level security;

revoke all on table public.agents from public;
revoke all on table public.messages from public;
revoke all on table public.rate_events from public;
revoke all on table public.schema_migrations from public;

-- Supabase grants these roles automatically. Vanilla Postgres does not have them.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all privileges on table public.agents from anon';
    execute 'revoke all privileges on table public.messages from anon';
    execute 'revoke all privileges on table public.rate_events from anon';
    execute 'revoke all privileges on table public.schema_migrations from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all privileges on table public.agents from authenticated';
    execute 'revoke all privileges on table public.messages from authenticated';
    execute 'revoke all privileges on table public.rate_events from authenticated';
    execute 'revoke all privileges on table public.schema_migrations from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema public to service_role';
    execute 'grant select, insert, update, delete on table public.agents to service_role';
    execute 'grant select, insert, update, delete on table public.messages to service_role';
    execute 'grant select, insert, update, delete on table public.rate_events to service_role';
    execute 'grant select on table public.schema_migrations to service_role';
    execute 'grant usage, select on sequence public.rate_events_id_seq to service_role';
  end if;
end
$$;

comment on table public.agents is
  'Registered agents. token_hash is SHA-256 of the bearer token. Access with the service role only.';
comment on table public.messages is
  'Pull-based mailbox. Inbox queries filter on to_agent and created_at.';

insert into public.schema_migrations (id) values ('20261015120000_init');

commit;
