-- Rooms, room membership, and a human flag on agents.
-- Forward-only. Do not edit 20261015120000_init.sql; that file is already applied.
-- Safe to re-run in the Supabase SQL editor.

begin;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  constraint rooms_name_format check (name ~ '^[a-z][a-z0-9_-]{0,63}$'),
  constraint rooms_name_unique unique (name)
);

create table if not exists public.room_members (
  room_id uuid not null,
  agent_id uuid not null,
  joined_at timestamptz not null default now(),
  constraint room_members_pkey primary key (room_id, agent_id),
  constraint room_members_room_fkey foreign key (room_id) references public.rooms (id),
  constraint room_members_agent_fkey foreign key (agent_id) references public.agents (id)
);

alter table public.agents
  add column if not exists is_human boolean not null default false;

alter table public.messages
  alter column to_agent drop not null;

alter table public.messages
  add column if not exists room_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'messages_room_id_fkey'
  ) then
    alter table public.messages
      add constraint messages_room_id_fkey
      foreign key (room_id) references public.rooms (id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'messages_target_xor'
  ) then
    alter table public.messages
      add constraint messages_target_xor check (
        (room_id is null and to_agent is not null)
        or (room_id is not null and to_agent is null)
      );
  end if;
end
$$;

create index if not exists messages_room_created_idx
  on public.messages (room_id, created_at)
  where room_id is not null;

create index if not exists room_members_agent_idx
  on public.room_members (agent_id);

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;

revoke all on table public.rooms from public;
revoke all on table public.room_members from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all privileges on table public.rooms from anon';
    execute 'revoke all privileges on table public.room_members from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all privileges on table public.rooms from authenticated';
    execute 'revoke all privileges on table public.room_members from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on table public.rooms to service_role';
    execute 'grant select, insert, update, delete on table public.room_members to service_role';
  end if;
end
$$;

comment on table public.rooms is
  'Named rooms. Members read the same log. Access with the service role only.';
comment on column public.agents.is_human is
  'True for the human owner. A run of agent-only room posts pauses until a human writes.';

insert into public.schema_migrations (id)
values ('20261016150000_rooms')
on conflict do nothing;

commit;
