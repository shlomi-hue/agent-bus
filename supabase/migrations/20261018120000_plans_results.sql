-- Plans, plan items, and result cards. Safe to re-run in the Supabase SQL editor.

begin;

create sequence if not exists public.display_code_seq start with 101;

drop trigger if exists tasks_assign_code on public.tasks;
do $$
begin
  if exists (select 1 from pg_class where relname = 'plan_items' and relkind = 'r') then
    execute 'drop trigger if exists plan_items_assign_code on public.plan_items';
  end if;
end
$$;
drop function if exists public.assign_display_code();

create function public.assign_display_code()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.code is null or length(btrim(new.code)) = 0 then
    new.code := 'AB-' || nextval('public.display_code_seq')::text;
  end if;
  return new;
end
$$;

revoke all on function public.assign_display_code() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.assign_display_code() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.assign_display_code() from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.assign_display_code() to service_role';
  end if;
end
$$;

alter table public.tasks add column if not exists slot text not null default '';
alter table public.tasks add column if not exists title text not null default '';
alter table public.tasks add column if not exists code text;

update public.tasks
set code = 'AB-' || nextval('public.display_code_seq')::text
where code is null or btrim(code) = '';

do $$
begin
  -- Leave tasks_source_assignee_unique in place so the currently deployed
  -- server can keep using it. The follow-up migration drops it after that
  -- server is replaced.
  if not exists (select 1 from pg_constraint where conname = 'tasks_source_assignee_slot_unique') then
    alter table public.tasks
      add constraint tasks_source_assignee_slot_unique unique (source_message_id, assignee_id, slot);
  end if;
end
$$;

alter table public.tasks drop constraint if exists tasks_title_len;
alter table public.tasks
  add constraint tasks_title_len check (char_length(title) <= 200);
alter table public.tasks drop constraint if exists tasks_slot_len;
alter table public.tasks
  add constraint tasks_slot_len check (char_length(slot) <= 80);
alter table public.tasks drop constraint if exists tasks_code_len;
alter table public.tasks
  add constraint tasks_code_len check (code is null or char_length(code) <= 32);

create unique index if not exists tasks_code_key on public.tasks (code);

drop trigger if exists tasks_assign_code on public.tasks;
create trigger tasks_assign_code
  before insert on public.tasks
  for each row execute function public.assign_display_code();

create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null,
  author_id uuid not null,
  message_id uuid not null,
  title text not null,
  summary text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists public.plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null,
  position integer not null,
  code text,
  title text not null,
  assignee_id uuid not null,
  estimate text not null default '',
  depends_on text not null default '',
  task_id uuid
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'plans_room_fkey') then
    alter table public.plans
      add constraint plans_room_fkey foreign key (room_id) references public.rooms (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'plans_author_fkey') then
    alter table public.plans
      add constraint plans_author_fkey foreign key (author_id) references public.agents (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'plans_message_fkey') then
    alter table public.plans
      add constraint plans_message_fkey foreign key (message_id) references public.messages (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'plans_status_check') then
    alter table public.plans
      add constraint plans_status_check
      check (status in ('pending', 'approved', 'rejected', 'executing', 'done', 'paused'));
  end if;
  if exists (select 1 from pg_constraint where conname = 'plans_title_len') then
    alter table public.plans drop constraint plans_title_len;
  end if;
  alter table public.plans
    add constraint plans_title_len check (char_length(title) between 1 and 200);
  if exists (select 1 from pg_constraint where conname = 'plans_summary_len') then
    alter table public.plans drop constraint plans_summary_len;
  end if;
  alter table public.plans
    add constraint plans_summary_len check (char_length(summary) between 1 and 4000);
  if not exists (select 1 from pg_constraint where conname = 'plan_items_plan_fkey') then
    alter table public.plan_items
      add constraint plan_items_plan_fkey foreign key (plan_id) references public.plans (id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'plan_items_assignee_fkey') then
    alter table public.plan_items
      add constraint plan_items_assignee_fkey foreign key (assignee_id) references public.agents (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'plan_items_task_fkey') then
    alter table public.plan_items
      add constraint plan_items_task_fkey foreign key (task_id) references public.tasks (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'plan_items_position_unique') then
    alter table public.plan_items
      add constraint plan_items_position_unique unique (plan_id, position);
  end if;
  if exists (select 1 from pg_constraint where conname = 'plan_items_title_len') then
    alter table public.plan_items drop constraint plan_items_title_len;
  end if;
  alter table public.plan_items
    add constraint plan_items_title_len check (char_length(title) between 1 and 200);
  if exists (select 1 from pg_constraint where conname = 'plan_items_estimate_len') then
    alter table public.plan_items drop constraint plan_items_estimate_len;
  end if;
  alter table public.plan_items
    add constraint plan_items_estimate_len check (char_length(estimate) <= 40);
  if exists (select 1 from pg_constraint where conname = 'plan_items_depends_len') then
    alter table public.plan_items drop constraint plan_items_depends_len;
  end if;
  alter table public.plan_items
    add constraint plan_items_depends_len check (char_length(depends_on) <= 80);
end
$$;

create unique index if not exists plan_items_code_key on public.plan_items (code);
create index if not exists plans_room_idx on public.plans (room_id, updated_at desc);
create index if not exists plans_status_idx on public.plans (status, updated_at desc);
create index if not exists plan_items_plan_idx on public.plan_items (plan_id, position);
create index if not exists plan_items_task_idx on public.plan_items (task_id);
create index if not exists plans_message_idx on public.plans (message_id);
create index if not exists plans_author_idx on public.plans (author_id);
create index if not exists plans_updated_idx on public.plans (updated_at desc);
create index if not exists plan_items_assignee_idx on public.plan_items (assignee_id);

drop trigger if exists plan_items_assign_code on public.plan_items;
create trigger plan_items_assign_code
  before insert on public.plan_items
  for each row execute function public.assign_display_code();

create table if not exists public.results (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null,
  message_id uuid not null,
  task_id uuid,
  plan_id uuid,
  author_id uuid not null,
  kind text not null,
  payload jsonb not null,
  status text not null default 'pending',
  decision_note text not null default '',
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'results_room_fkey') then
    alter table public.results
      add constraint results_room_fkey foreign key (room_id) references public.rooms (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'results_message_fkey') then
    alter table public.results
      add constraint results_message_fkey foreign key (message_id) references public.messages (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'results_task_fkey') then
    alter table public.results
      add constraint results_task_fkey foreign key (task_id) references public.tasks (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'results_plan_fkey') then
    alter table public.results
      add constraint results_plan_fkey foreign key (plan_id) references public.plans (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'results_author_fkey') then
    alter table public.results
      add constraint results_author_fkey foreign key (author_id) references public.agents (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'results_kind_check') then
    alter table public.results
      add constraint results_kind_check
      check (kind in ('pr', 'tests', 'file', 'screenshot', 'text'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'results_status_check') then
    alter table public.results
      add constraint results_status_check
      check (status in ('pending', 'approved', 'changes_requested'));
  end if;
  if exists (select 1 from pg_constraint where conname = 'results_payload_len') then
    alter table public.results drop constraint results_payload_len;
  end if;
  alter table public.results
    add constraint results_payload_len check (octet_length(payload::text) <= 16000);
  if exists (select 1 from pg_constraint where conname = 'results_note_len') then
    alter table public.results drop constraint results_note_len;
  end if;
  alter table public.results
    add constraint results_note_len check (char_length(decision_note) <= 2000);
end
$$;

create index if not exists results_room_idx on public.results (room_id, created_at desc);
create index if not exists results_status_idx on public.results (status, updated_at desc);
create index if not exists results_message_idx on public.results (message_id);
create index if not exists results_task_idx on public.results (task_id);
create index if not exists results_plan_idx on public.results (plan_id);
create index if not exists results_updated_idx on public.results (updated_at desc);

alter table public.plans enable row level security;
alter table public.plan_items enable row level security;
alter table public.results enable row level security;

revoke all on table public.plans from public;
revoke all on table public.plan_items from public;
revoke all on table public.results from public;
revoke all on sequence public.display_code_seq from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all privileges on table public.plans from anon';
    execute 'revoke all privileges on table public.plan_items from anon';
    execute 'revoke all privileges on table public.results from anon';
    execute 'revoke all privileges on sequence public.display_code_seq from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all privileges on table public.plans from authenticated';
    execute 'revoke all privileges on table public.plan_items from authenticated';
    execute 'revoke all privileges on table public.results from authenticated';
    execute 'revoke all privileges on sequence public.display_code_seq from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on table public.plans to service_role';
    execute 'grant select, insert, update, delete on table public.plan_items to service_role';
    execute 'grant select, insert, update, delete on table public.results to service_role';
    execute 'grant usage, select on sequence public.display_code_seq to service_role';
  end if;
end
$$;

comment on table public.plans is
  'Owner-approved work plans. Service role only. Titles and summaries are untrusted.';
comment on table public.plan_items is
  'Rows inside a plan. Service role only.';
comment on table public.results is
  'Structured result cards posted by agents. Service role only. Payload text is untrusted.';

insert into public.schema_migrations (id)
values ('20261018120000_plans_results')
on conflict do nothing;

commit;
