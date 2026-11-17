-- Munshi ledger. Apply this file first.
-- RLS is enabled on every table and there are no policies.
-- The Express server uses the Supabase service role, which bypasses RLS.
-- anon and authenticated have no grants, so the Data API cannot read or write these tables.

create or replace function public.munshi_text(value jsonb)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when value is null or value = 'null'::jsonb then ''
    else btrim(value #>> '{}')
  end;
$$;

create or replace function public.munshi_num(value jsonb)
returns numeric
language plpgsql
immutable
set search_path = public
as $$
declare
  raw text;
begin
  if value is null or value = 'null'::jsonb then
    return null;
  end if;
  raw := btrim(value #>> '{}');
  if raw = '' then
    return null;
  end if;
  return raw::numeric;
exception when others then
  return null;
end;
$$;

create or replace function public.munshi_int(value jsonb)
returns integer
language plpgsql
immutable
set search_path = public
as $$
declare
  raw text;
begin
  raw := public.munshi_text(value);
  if raw = '' or raw !~ '^-?\d+$' then
    return null;
  end if;
  return raw::integer;
exception when others then
  return null;
end;
$$;

create or replace function public.munshi_date(value jsonb)
returns date
language plpgsql
immutable
set search_path = public
as $$
declare
  raw text;
begin
  raw := public.munshi_text(value);
  if raw = '' then
    return null;
  end if;
  if raw ~ '^\d{4}-\d{2}-\d{2}' then
    return substring(raw from 1 for 10)::date;
  end if;
  return null;
exception when others then
  return null;
end;
$$;

create table public.ledger_meta (
  id integer primary key default 1 check (id = 1),
  version bigint not null default 0
);

insert into public.ledger_meta (id, version) values (1, 0);

create table public.farmers (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique check (phone <> ''),
  sheet_id text not null default '',
  name text not null default '',
  farm_name text not null default '',
  onboarding_state text not null default '',
  allowed boolean not null default false,
  created_at text not null default '',
  last_inbound_at text not null default '',
  web_token text,
  settings jsonb not null default '{}'::jsonb,
  constraint farmers_settings_object check (jsonb_typeof(settings) = 'object'),
  constraint farmers_web_token_unique unique (web_token)
);

create index farmers_sheet_id_idx on public.farmers (sheet_id);

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid references public.farmers (id) on delete set null,
  phone text not null,
  reminder_date date not null,
  slot text not null,
  sent_at text not null default '',
  constraint reminders_phone_day_slot unique (phone, reminder_date, slot)
);

create index reminders_farmer_idx on public.reminders (farmer_id);

create table public.pending_entries (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid references public.farmers (id) on delete set null,
  sender text not null default '',
  created_at text not null default '',
  language text not null default '',
  entries_json text not null default '[]',
  status text not null default '',
  message_id text not null default '',
  sort_order integer not null default 0
);

create index pending_entries_farmer_idx on public.pending_entries (farmer_id);
create index pending_entries_sender_idx on public.pending_entries (sender);

create table public.processed_messages (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid references public.farmers (id) on delete set null,
  message_id text not null unique,
  received_at text not null default '',
  sender text not null default ''
);

create index processed_messages_farmer_idx on public.processed_messages (farmer_id);

create table public.cows (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet_key text not null,
  origin text not null unique,
  sort_order integer not null default 0,
  cow_id text not null default '',
  name text not null default '',
  animal_type text not null default '',
  breed text not null default '',
  status text not null default '',
  avg_daily_litres numeric,
  notes text not null default '',
  date_added text not null default '',
  last_insemination text not null default '',
  pregnancy_status text not null default '',
  expected_calving text not null default '',
  dry_off_due text not null default '',
  pregnancy_check_due text not null default ''
);

create index cows_farmer_idx on public.cows (farmer_id);
create index cows_sheet_idx on public.cows (sheet_key);

create table public.milk_records (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet_key text not null,
  origin text not null unique,
  sort_order integer not null default 0,
  record_date date,
  session text not null default '',
  cow_name text not null default '',
  litres numeric,
  source_note text not null default ''
);

create index milk_records_farmer_idx on public.milk_records (farmer_id);
create index milk_records_sheet_date_idx on public.milk_records (sheet_key, record_date);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet_key text not null,
  origin text not null unique,
  sort_order integer not null default 0,
  name text not null default '',
  phone text not null default '',
  rate_pkr numeric,
  opening_balance numeric,
  current_balance numeric,
  notes text not null default '',
  billing_cycle text not null default '',
  cycle_start_date date,
  supply_type text,
  daily_litres numeric,
  constraint customers_supply_type_chk check (supply_type is null or supply_type in ('fixed', 'flexible'))
);

create index customers_farmer_idx on public.customers (farmer_id);
create index customers_sheet_idx on public.customers (sheet_key);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet_key text not null,
  origin text not null unique,
  sort_order integer not null default 0,
  record_date date,
  customer text not null default '',
  litres numeric,
  rate_pkr numeric,
  amount numeric,
  cash_received numeric,
  balance_added numeric,
  source_note text not null default ''
);

create index sales_farmer_idx on public.sales (farmer_id);
create index sales_sheet_date_idx on public.sales (sheet_key, record_date);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet_key text not null,
  origin text not null unique,
  sort_order integer not null default 0,
  record_date date,
  customer text not null default '',
  amount numeric,
  method text not null default ''
);

create index payments_farmer_idx on public.payments (farmer_id);
create index payments_sheet_date_idx on public.payments (sheet_key, record_date);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet_key text not null,
  origin text not null unique,
  sort_order integer not null default 0,
  record_date date,
  category text not null default '',
  amount numeric,
  note text not null default ''
);

create index expenses_farmer_idx on public.expenses (farmer_id);
create index expenses_sheet_date_idx on public.expenses (sheet_key, record_date);

create table public.fodder_purchases (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet_key text not null,
  origin text not null unique,
  sort_order integer not null default 0,
  record_date date,
  item text not null default '',
  quantity numeric,
  unit text not null default '',
  cost_pkr numeric,
  supplier text not null default '',
  cash_paid numeric,
  balance_owed numeric,
  source_note text not null default ''
);

create index fodder_purchases_farmer_idx on public.fodder_purchases (farmer_id);
create index fodder_purchases_sheet_date_idx on public.fodder_purchases (sheet_key, record_date);
create index fodder_purchases_supplier_idx on public.fodder_purchases (sheet_key, supplier);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet_key text not null,
  origin text not null unique,
  sort_order integer not null default 0,
  name text not null default '',
  balance_owed numeric not null default 0
);

create index suppliers_farmer_idx on public.suppliers (farmer_id);
create index suppliers_sheet_idx on public.suppliers (sheet_key);

create table public.committees (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet_key text not null,
  origin text not null unique,
  sort_order integer not null default 0,
  name text not null default '',
  amount numeric,
  frequency text not null default '',
  start_date date,
  organizer text not null default '',
  status text not null default '',
  notes text not null default ''
);

create index committees_farmer_idx on public.committees (farmer_id);
create index committees_sheet_idx on public.committees (sheet_key);

create table public.committee_log (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet_key text not null,
  origin text not null unique,
  sort_order integer not null default 0,
  record_date date,
  committee text not null default '',
  status text not null default '',
  amount numeric,
  note text not null default ''
);

create index committee_log_farmer_idx on public.committee_log (farmer_id);
create index committee_log_sheet_date_idx on public.committee_log (sheet_key, record_date);

create table public.committee_status (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet_key text not null,
  origin text not null unique,
  sort_order integer not null default 0,
  committee text not null default '',
  frequency text not null default '',
  as_of date,
  paid_periods integer,
  missed_periods integer,
  paid_amount numeric,
  arrears numeric,
  given_so_far numeric,
  today_status text not null default ''
);

create index committee_status_farmer_idx on public.committee_status (farmer_id);
create index committee_status_sheet_idx on public.committee_status (sheet_key);

create table public.animal_events (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet_key text not null,
  origin text not null unique,
  sort_order integer not null default 0,
  record_date date,
  cow text not null default '',
  event_type text not null default '',
  details text not null default '',
  doctor_name text not null default '',
  diagnosis text not null default '',
  medicines text not null default '',
  cost_pkr numeric,
  next_due_date date,
  source_note text not null default ''
);

create index animal_events_farmer_idx on public.animal_events (farmer_id);
create index animal_events_sheet_date_idx on public.animal_events (sheet_key, record_date);

create table public.feed_stock (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet_key text not null,
  origin text not null unique,
  sort_order integer not null default 0,
  item text not null default '',
  quantity numeric,
  unit text not null default '',
  daily_use numeric,
  updated_at text not null default '',
  notes text not null default '',
  days_left numeric,
  run_out_date date,
  reorder_by date,
  avg_cost_per_kg numeric
);

create index feed_stock_farmer_idx on public.feed_stock (farmer_id);
create index feed_stock_sheet_idx on public.feed_stock (sheet_key);

create table public.due_bills (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet_key text not null,
  origin text not null unique,
  sort_order integer not null default 0,
  customer text not null default '',
  period_start date,
  period_end date,
  due_date date,
  litres numeric,
  amount numeric,
  paid numeric,
  balance_due numeric,
  status text not null default ''
);

create index due_bills_farmer_idx on public.due_bills (farmer_id);
create index due_bills_sheet_idx on public.due_bills (sheet_key);

create table public.upcoming_events (
  id uuid primary key default gen_random_uuid(),
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet_key text not null,
  origin text not null unique,
  sort_order integer not null default 0,
  record_date date,
  cow text not null default '',
  event text not null default '',
  details text not null default ''
);

create index upcoming_events_farmer_idx on public.upcoming_events (farmer_id);
create index upcoming_events_sheet_date_idx on public.upcoming_events (sheet_key, record_date);

create table public.last_writes (
  sheet_key text primary key,
  farmer_id uuid not null references public.farmers (id) on delete cascade,
  sheet text not null default '',
  row_num integer,
  entry_type text not null default '',
  summary text not null default '',
  written_at text not null default ''
);

create index last_writes_farmer_idx on public.last_writes (farmer_id);

comment on table public.farmers is
  'One row per farm. RLS is on and there are no policies; the server uses the service role.';

-- Lock the Data API out. The service role keeps its own grant and bypasses RLS.
do $$
declare
  tbl text;
  tables text[] := array[
    'ledger_meta',
    'farmers',
    'reminders',
    'pending_entries',
    'processed_messages',
    'cows',
    'milk_records',
    'customers',
    'sales',
    'payments',
    'expenses',
    'fodder_purchases',
    'suppliers',
    'committees',
    'committee_log',
    'committee_status',
    'animal_events',
    'feed_stock',
    'due_bills',
    'upcoming_events',
    'last_writes'
  ];
begin
  foreach tbl in array tables loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('alter table public.%I force row level security', tbl);
    execute format('revoke all on table public.%I from public', tbl);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table public.%I from anon', tbl);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table public.%I from authenticated', tbl);
    end if;
  end loop;
end;
$$;

do $$
declare
  fn text;
  fns text[] := array[
    'munshi_text(jsonb)',
    'munshi_num(jsonb)',
    'munshi_int(jsonb)',
    'munshi_date(jsonb)'
  ];
begin
  foreach fn in array fns loop
    execute format('revoke all on function public.%s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%s from anon', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function public.%s from authenticated', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function public.%s to service_role', fn);
    end if;
  end loop;
end;
$$;
