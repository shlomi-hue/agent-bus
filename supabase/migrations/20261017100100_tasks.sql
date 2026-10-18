-- Tasks created from @mentions. Safe to re-run in the Supabase SQL editor.

begin;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  assignee_id uuid not null,
  creator_id uuid not null,
  source_message_id uuid not null,
  room_id uuid,
  thread_id uuid not null,
  status text not null default 'open',
  result_note text not null default '',
  result_link text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_assignee_fkey') then
    alter table public.tasks
      add constraint tasks_assignee_fkey foreign key (assignee_id) references public.agents (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_creator_fkey') then
    alter table public.tasks
      add constraint tasks_creator_fkey foreign key (creator_id) references public.agents (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_source_message_fkey') then
    alter table public.tasks
      add constraint tasks_source_message_fkey foreign key (source_message_id) references public.messages (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_room_fkey') then
    alter table public.tasks
      add constraint tasks_room_fkey foreign key (room_id) references public.rooms (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_status_check') then
    alter table public.tasks
      add constraint tasks_status_check
      check (status in ('open', 'working', 'done', 'blocked'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_result_note_len') then
    alter table public.tasks
      add constraint tasks_result_note_len
      check (octet_length(result_note) <= 2000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_result_link_len') then
    alter table public.tasks
      add constraint tasks_result_link_len
      check (result_link is null or octet_length(result_link) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_source_assignee_unique') then
    alter table public.tasks
      add constraint tasks_source_assignee_unique unique (source_message_id, assignee_id);
  end if;
end
$$;

create index if not exists tasks_assignee_idx on public.tasks (assignee_id, updated_at desc);
create index if not exists tasks_creator_idx on public.tasks (creator_id);
create index if not exists tasks_source_message_idx on public.tasks (source_message_id);
create index if not exists tasks_room_idx on public.tasks (room_id);
create index if not exists tasks_assignee_open_idx
  on public.tasks (assignee_id, updated_at desc)
  where status in ('open', 'working');

alter table public.tasks enable row level security;
revoke all on table public.tasks from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all privileges on table public.tasks from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all privileges on table public.tasks from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on table public.tasks to service_role';
  end if;
end
$$;

comment on table public.tasks is
  'Work items created from @mentions. Service role only. Mention text stays untrusted.';

insert into public.schema_migrations (id)
values ('20261017100100_tasks')
on conflict do nothing;

commit;
