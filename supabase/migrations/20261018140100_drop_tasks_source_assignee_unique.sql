-- Drop the pre-slot task unique constraint.
-- Apply this only after the server that uses
-- tasks_source_assignee_slot_unique is deployed.
-- Until then, 20261018120000_plans_results.sql keeps the old constraint
-- so the previous server can still insert mention tasks.

begin;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'tasks_source_assignee_unique') then
    alter table public.tasks drop constraint tasks_source_assignee_unique;
  end if;
end
$$;

insert into public.schema_migrations (id)
values ('20261018140100_drop_tasks_source_assignee_unique')
on conflict do nothing;

commit;
