-- History of ledger creates, updates, and deletes.
-- Apply after 20261119000000_fix_snapshot_delete_where.sql.
--
-- save_ledger_snapshot rewrites farm tables with DELETE ... WHERE true.
-- This table is not one of those tables, and this migration does not
-- replace save_ledger_snapshot, so a snapshot save cannot wipe history.
--
-- farmer_id is the farmers.id value at insert time. The snapshot rewrite
-- deletes and recreates farmers, so a foreign key would either cascade
-- away the history or dangle. farmer_phone is the stable lookup key.

create table public.record_history (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid,
  farmer_phone text not null default '',
  sheet_key text not null default '',
  table_name text not null,
  record_id text not null,
  action text not null,
  old_values jsonb,
  new_values jsonb,
  source text not null,
  created_at timestamptz not null default now(),
  constraint record_history_action_chk check (action in ('create', 'update', 'delete')),
  constraint record_history_source_chk check (source in ('voice', 'manual', 'whatsapp')),
  constraint record_history_old_object check (old_values is null or jsonb_typeof(old_values) = 'object'),
  constraint record_history_new_object check (new_values is null or jsonb_typeof(new_values) = 'object'),
  constraint record_history_table_chk check (table_name <> ''),
  constraint record_history_record_chk check (record_id <> '')
);

comment on table public.record_history is
  'Append-only audit log. Excluded from save_ledger_snapshot so ledger rewrites do not delete it.';

comment on column public.record_history.farmer_id is
  'Farmers.id at insert time. No foreign key: snapshot rewrite replaces farmer rows.';

create index record_history_phone_idx on public.record_history (farmer_phone, created_at desc);
create index record_history_sheet_idx on public.record_history (sheet_key, created_at desc);
create index record_history_record_idx on public.record_history (record_id, created_at desc);
create index record_history_table_idx on public.record_history (table_name, created_at desc);

alter table public.record_history enable row level security;
alter table public.record_history force row level security;

revoke all on table public.record_history from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.record_history from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.record_history from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert on table public.record_history to service_role';
  end if;
end;
$$;

create or replace function public.append_record_history(events jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  inserted integer := 0;
begin
  if events is null or jsonb_typeof(events) <> 'array' then
    raise exception 'events must be an array';
  end if;

  insert into public.record_history (
    farmer_id, farmer_phone, sheet_key, table_name, record_id,
    action, old_values, new_values, source, created_at
  )
  select
    (
      select f.id
      from public.farmers f
      where f.phone = public.munshi_text(e.event->'farmer_phone')
      limit 1
    ),
    public.munshi_text(e.event->'farmer_phone'),
    public.munshi_text(e.event->'sheet_key'),
    public.munshi_text(e.event->'table_name'),
    public.munshi_text(e.event->'record_id'),
    public.munshi_text(e.event->'action'),
    case when jsonb_typeof(e.event->'old_values') = 'object' then e.event->'old_values' else null end,
    case when jsonb_typeof(e.event->'new_values') = 'object' then e.event->'new_values' else null end,
    public.munshi_text(e.event->'source'),
    case
      when public.munshi_text(e.event->'created_at') ~ '^\d{4}-\d{2}-\d{2}'
        then public.munshi_text(e.event->'created_at')::timestamptz
      else now()
    end
  from jsonb_array_elements(events) as e(event)
  where public.munshi_text(e.event->'table_name') <> ''
    and public.munshi_text(e.event->'record_id') <> ''
    and public.munshi_text(e.event->'action') in ('create', 'update', 'delete')
    and public.munshi_text(e.event->'source') in ('voice', 'manual', 'whatsapp');

  get diagnostics inserted = row_count;
  return jsonb_build_object('ok', true, 'inserted', inserted);
end;
$$;

revoke all on function public.append_record_history(jsonb) from public;

do $$
declare
  fn text := 'append_record_history(jsonb)';
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute format('revoke all on function public.%s from anon', fn);
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute format('revoke all on function public.%s from authenticated', fn);
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute format('grant execute on function public.%s to service_role', fn);
  end if;
end;
$$;

-- Chat threads for the Bolein tab. Same rule as record_history:
-- save_ledger_snapshot does not mention this table, so a ledger rewrite
-- cannot delete the messages. farmer_id has no foreign key because that
-- rewrite also replaces farmer rows. farmer_phone is the stable key.

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid,
  farmer_phone text not null default '',
  sheet_key text not null default '',
  thread_id text not null,
  role text not null,
  content text not null default '',
  payload jsonb,
  created_at timestamptz not null default now(),
  constraint chat_messages_role_chk check (role in ('farmer', 'munshi')),
  constraint chat_messages_thread_chk check (thread_id <> ''),
  constraint chat_messages_payload_object check (payload is null or jsonb_typeof(payload) = 'object')
);

comment on table public.chat_messages is
  'Bolein chat. Excluded from save_ledger_snapshot.';

create index chat_messages_thread_idx on public.chat_messages (farmer_phone, thread_id, created_at desc);
create index chat_messages_phone_idx on public.chat_messages (farmer_phone, created_at desc);

alter table public.chat_messages enable row level security;
alter table public.chat_messages force row level security;

revoke all on table public.chat_messages from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.chat_messages from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.chat_messages from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on table public.chat_messages to service_role';
  end if;
end;
$$;
