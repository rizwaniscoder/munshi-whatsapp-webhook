-- Additive committee fields. Apply on the live database.
-- skip_31st stays false until a committee is edited. Turn it on for Naab Dairy's
-- committee named Committee from the Hisaab card (31 chhorain).

alter table public.committees
  add column if not exists total_periods integer,
  add column if not exists opening_paid_periods integer not null default 0,
  add column if not exists skip_31st boolean not null default false;

create or replace function public.load_ledger_snapshot()
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'version', coalesce((select version from public.ledger_meta where id = 1), 0),
    'farmers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'phone', f.phone,
        'sheet_id', f.sheet_id,
        'name', f.name,
        'farm_name', f.farm_name,
        'onboarding_state', f.onboarding_state,
        'allowed', f.allowed,
        'created_at', f.created_at,
        'last_inbound_at', f.last_inbound_at,
        'web_token', coalesce(f.web_token, ''),
        'settings', f.settings
      ) order by f.phone)
      from public.farmers f
    ), '[]'::jsonb),
    'reminders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'phone', r.phone,
        'reminder_date', public.munshi_day(r.reminder_date),
        'slot', r.slot,
        'sent_at', r.sent_at
      ) order by r.phone, r.reminder_date, r.slot)
      from public.reminders r
    ), '[]'::jsonb),
    'pending', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sender', p.sender,
        'created_at', p.created_at,
        'language', p.language,
        'entries_json', p.entries_json,
        'status', p.status,
        'message_id', p.message_id,
        'sort_order', p.sort_order
      ) order by p.sort_order, p.created_at)
      from public.pending_entries p
    ), '[]'::jsonb),
    'processed', coalesce((
      select jsonb_agg(jsonb_build_object(
        'message_id', m.message_id,
        'received_at', m.received_at,
        'sender', m.sender
      ) order by m.received_at, m.message_id)
      from public.processed_messages m
    ), '[]'::jsonb),
    'ledgers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sheet_key', keys.sheet_key,
        'owner_phone', coalesce(
          (select f.phone from public.farmers f where f.sheet_id = keys.sheet_key order by f.phone limit 1),
          (select f.phone from public.farmers f join public.milk_records rec on rec.farmer_id = f.id where rec.sheet_key = keys.sheet_key order by f.phone limit 1),
          ''
        ),
        'cows', coalesce((
          select jsonb_agg(jsonb_build_object(
            'origin', c.origin, 'sort_order', c.sort_order, 'cow_id', c.cow_id, 'name', c.name,
            'animal_type', c.animal_type, 'breed', c.breed, 'status', c.status,
            'avg_daily_litres', c.avg_daily_litres, 'notes', c.notes, 'date_added', c.date_added,
            'last_insemination', c.last_insemination, 'pregnancy_status', c.pregnancy_status,
            'expected_calving', c.expected_calving, 'dry_off_due', c.dry_off_due,
            'pregnancy_check_due', c.pregnancy_check_due
          ) order by c.sort_order, c.origin)
          from public.cows c where c.sheet_key = keys.sheet_key
        ), '[]'::jsonb),
        'milk', coalesce((
          select jsonb_agg(jsonb_build_object(
            'origin', rec.origin, 'sort_order', rec.sort_order,
            'record_date', public.munshi_day(rec.record_date), 'session', rec.session,
            'cow_name', rec.cow_name, 'litres', rec.litres, 'source_note', rec.source_note
          ) order by rec.sort_order, rec.origin)
          from public.milk_records rec where rec.sheet_key = keys.sheet_key
        ), '[]'::jsonb),
        'customers', coalesce((
          select jsonb_agg(jsonb_build_object(
            'origin', rec.origin, 'sort_order', rec.sort_order, 'name', rec.name, 'phone', rec.phone,
            'rate_pkr', rec.rate_pkr, 'opening_balance', rec.opening_balance,
            'current_balance', rec.current_balance, 'notes', rec.notes,
            'billing_cycle', rec.billing_cycle, 'cycle_start_date', public.munshi_day(rec.cycle_start_date),
            'supply_type', rec.supply_type, 'daily_litres', rec.daily_litres
          ) order by rec.sort_order, rec.origin)
          from public.customers rec where rec.sheet_key = keys.sheet_key
        ), '[]'::jsonb),
        'sales', coalesce((
          select jsonb_agg(jsonb_build_object(
            'origin', rec.origin, 'sort_order', rec.sort_order,
            'record_date', public.munshi_day(rec.record_date), 'customer', rec.customer,
            'litres', rec.litres, 'rate_pkr', rec.rate_pkr, 'amount', rec.amount,
            'cash_received', rec.cash_received, 'balance_added', rec.balance_added,
            'source_note', rec.source_note
          ) order by rec.sort_order, rec.origin)
          from public.sales rec where rec.sheet_key = keys.sheet_key
        ), '[]'::jsonb),
        'payments', coalesce((
          select jsonb_agg(jsonb_build_object(
            'origin', rec.origin, 'sort_order', rec.sort_order,
            'record_date', public.munshi_day(rec.record_date), 'customer', rec.customer,
            'amount', rec.amount, 'method', rec.method
          ) order by rec.sort_order, rec.origin)
          from public.payments rec where rec.sheet_key = keys.sheet_key
        ), '[]'::jsonb),
        'expenses', coalesce((
          select jsonb_agg(jsonb_build_object(
            'origin', rec.origin, 'sort_order', rec.sort_order,
            'record_date', public.munshi_day(rec.record_date), 'category', rec.category,
            'amount', rec.amount, 'note', rec.note
          ) order by rec.sort_order, rec.origin)
          from public.expenses rec where rec.sheet_key = keys.sheet_key
        ), '[]'::jsonb),
        'fodder', coalesce((
          select jsonb_agg(jsonb_build_object(
            'origin', rec.origin, 'sort_order', rec.sort_order,
            'record_date', public.munshi_day(rec.record_date), 'item', rec.item,
            'quantity', rec.quantity, 'unit', rec.unit, 'cost_pkr', rec.cost_pkr,
            'supplier', rec.supplier, 'cash_paid', rec.cash_paid, 'balance_owed', rec.balance_owed,
            'source_note', rec.source_note
          ) order by rec.sort_order, rec.origin)
          from public.fodder_purchases rec where rec.sheet_key = keys.sheet_key
        ), '[]'::jsonb),
        'suppliers', coalesce((
          select jsonb_agg(jsonb_build_object(
            'origin', rec.origin, 'sort_order', rec.sort_order,
            'name', rec.name, 'balance_owed', rec.balance_owed
          ) order by rec.sort_order, rec.origin)
          from public.suppliers rec where rec.sheet_key = keys.sheet_key
        ), '[]'::jsonb),
        'committees', coalesce((
          select jsonb_agg(jsonb_build_object(
            'origin', rec.origin, 'sort_order', rec.sort_order, 'name', rec.name,
            'amount', rec.amount, 'frequency', rec.frequency,
            'start_date', public.munshi_day(rec.start_date), 'organizer', rec.organizer,
            'status', rec.status, 'notes', rec.notes,
            'total_periods', rec.total_periods, 'opening_paid_periods', rec.opening_paid_periods,
            'skip_31st', rec.skip_31st
          ) order by rec.sort_order, rec.origin)
          from public.committees rec where rec.sheet_key = keys.sheet_key
        ), '[]'::jsonb),
        'committee_log', coalesce((
          select jsonb_agg(jsonb_build_object(
            'origin', rec.origin, 'sort_order', rec.sort_order,
            'record_date', public.munshi_day(rec.record_date), 'committee', rec.committee,
            'status', rec.status, 'amount', rec.amount, 'note', rec.note
          ) order by rec.sort_order, rec.origin)
          from public.committee_log rec where rec.sheet_key = keys.sheet_key
        ), '[]'::jsonb),
        'committee_status', coalesce((
          select jsonb_agg(jsonb_build_object(
            'origin', rec.origin, 'sort_order', rec.sort_order, 'committee', rec.committee,
            'frequency', rec.frequency, 'as_of', public.munshi_day(rec.as_of),
            'paid_periods', rec.paid_periods, 'missed_periods', rec.missed_periods,
            'paid_amount', rec.paid_amount, 'arrears', rec.arrears,
            'given_so_far', rec.given_so_far, 'today_status', rec.today_status
          ) order by rec.sort_order, rec.origin)
          from public.committee_status rec where rec.sheet_key = keys.sheet_key
        ), '[]'::jsonb),
        'animal_events', coalesce((
          select jsonb_agg(jsonb_build_object(
            'origin', rec.origin, 'sort_order', rec.sort_order,
            'record_date', public.munshi_day(rec.record_date), 'cow', rec.cow,
            'event_type', rec.event_type, 'details', rec.details, 'doctor_name', rec.doctor_name,
            'diagnosis', rec.diagnosis, 'medicines', rec.medicines, 'cost_pkr', rec.cost_pkr,
            'next_due_date', public.munshi_day(rec.next_due_date), 'source_note', rec.source_note
          ) order by rec.sort_order, rec.origin)
          from public.animal_events rec where rec.sheet_key = keys.sheet_key
        ), '[]'::jsonb),
        'feed_stock', coalesce((
          select jsonb_agg(jsonb_build_object(
            'origin', rec.origin, 'sort_order', rec.sort_order, 'item', rec.item,
            'quantity', rec.quantity, 'unit', rec.unit, 'daily_use', rec.daily_use,
            'updated_at', rec.updated_at, 'notes', rec.notes, 'days_left', rec.days_left,
            'run_out_date', public.munshi_day(rec.run_out_date),
            'reorder_by', public.munshi_day(rec.reorder_by),
            'avg_cost_per_kg', rec.avg_cost_per_kg
          ) order by rec.sort_order, rec.origin)
          from public.feed_stock rec where rec.sheet_key = keys.sheet_key
        ), '[]'::jsonb),
        'due_bills', coalesce((
          select jsonb_agg(jsonb_build_object(
            'origin', rec.origin, 'sort_order', rec.sort_order, 'customer', rec.customer,
            'period_start', public.munshi_day(rec.period_start),
            'period_end', public.munshi_day(rec.period_end),
            'due_date', public.munshi_day(rec.due_date),
            'litres', rec.litres, 'amount', rec.amount, 'paid', rec.paid,
            'balance_due', rec.balance_due, 'status', rec.status
          ) order by rec.sort_order, rec.origin)
          from public.due_bills rec where rec.sheet_key = keys.sheet_key
        ), '[]'::jsonb),
        'upcoming_events', coalesce((
          select jsonb_agg(jsonb_build_object(
            'origin', rec.origin, 'sort_order', rec.sort_order,
            'record_date', public.munshi_day(rec.record_date), 'cow', rec.cow,
            'event', rec.event, 'details', rec.details
          ) order by rec.sort_order, rec.origin)
          from public.upcoming_events rec where rec.sheet_key = keys.sheet_key
        ), '[]'::jsonb),
        'last_write', (
          select jsonb_build_object(
            'sheet', w.sheet, 'row_num', w.row_num, 'entry_type', w.entry_type,
            'summary', w.summary, 'written_at', w.written_at
          )
          from public.last_writes w where w.sheet_key = keys.sheet_key
        )
      ) order by keys.sheet_key)
      from (
        select distinct sheet_key from (
          select sheet_id as sheet_key from public.farmers where sheet_id <> ''
          union select sheet_key from public.cows
          union select sheet_key from public.milk_records
          union select sheet_key from public.customers
          union select sheet_key from public.sales
          union select sheet_key from public.payments
          union select sheet_key from public.expenses
          union select sheet_key from public.fodder_purchases
          union select sheet_key from public.suppliers
          union select sheet_key from public.committees
          union select sheet_key from public.committee_log
          union select sheet_key from public.committee_status
          union select sheet_key from public.animal_events
          union select sheet_key from public.feed_stock
          union select sheet_key from public.due_bills
          union select sheet_key from public.upcoming_events
          union select sheet_key from public.last_writes
        ) raw
        where coalesce(sheet_key, '') <> ''
      ) keys
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create or replace function public.save_ledger_snapshot(snapshot jsonb, expected_version bigint)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_version bigint;
  v_farmer record;
  v_ledger record;
  v_sheet_key text;
  v_owner text;
  v_fid uuid;
begin
  if snapshot is null or jsonb_typeof(snapshot) <> 'object' then
    raise exception 'snapshot must be an object';
  end if;
  perform pg_advisory_xact_lock(481516234);
  select version into v_version from public.ledger_meta where id = 1 for update;
  if v_version is null then
    insert into public.ledger_meta (id, version) values (1, 0);
    v_version := 0;
  end if;
  if expected_version is distinct from v_version then
    return jsonb_build_object('ok', false, 'conflict', true, 'version', v_version);
  end if;

  DELETE FROM public.milk_records WHERE true;
  DELETE FROM public.sales WHERE true;
  DELETE FROM public.payments WHERE true;
  DELETE FROM public.expenses WHERE true;
  DELETE FROM public.fodder_purchases WHERE true;
  DELETE FROM public.suppliers WHERE true;
  DELETE FROM public.committee_log WHERE true;
  DELETE FROM public.committee_status WHERE true;
  DELETE FROM public.committees WHERE true;
  DELETE FROM public.animal_events WHERE true;
  DELETE FROM public.feed_stock WHERE true;
  DELETE FROM public.due_bills WHERE true;
  DELETE FROM public.upcoming_events WHERE true;
  DELETE FROM public.cows WHERE true;
  DELETE FROM public.customers WHERE true;
  DELETE FROM public.last_writes WHERE true;
  DELETE FROM public.reminders WHERE true;
  DELETE FROM public.pending_entries WHERE true;
  DELETE FROM public.processed_messages WHERE true;
  DELETE FROM public.farmers WHERE true;

  for v_farmer in
    select value as doc from jsonb_array_elements(coalesce(snapshot->'farmers', '[]'::jsonb))
  loop
    if public.munshi_text(v_farmer.doc->'phone') = '' then
      continue;
    end if;
    insert into public.farmers (
      phone, sheet_id, name, farm_name, onboarding_state, allowed,
      created_at, last_inbound_at, web_token, settings
    ) values (
      public.munshi_text(v_farmer.doc->'phone'),
      public.munshi_text(v_farmer.doc->'sheet_id'),
      public.munshi_text(v_farmer.doc->'name'),
      public.munshi_text(v_farmer.doc->'farm_name'),
      public.munshi_text(v_farmer.doc->'onboarding_state'),
      case
        when coalesce(v_farmer.doc->>'allowed', '') in ('true', 'TRUE', 't', '1', 'yes') then true
        else false
      end,
      public.munshi_text(v_farmer.doc->'created_at'),
      public.munshi_text(v_farmer.doc->'last_inbound_at'),
      nullif(public.munshi_text(v_farmer.doc->'web_token'), ''),
      case
        when jsonb_typeof(v_farmer.doc->'settings') = 'object' then v_farmer.doc->'settings'
        else '{}'::jsonb
      end
    );
  end loop;

  insert into public.reminders (farmer_id, phone, reminder_date, slot, sent_at)
  select
    (select f.id from public.farmers f where f.phone = public.munshi_text(t.rec->'phone') limit 1),
    public.munshi_text(t.rec->'phone'),
    public.munshi_date(t.rec->'reminder_date'),
    public.munshi_text(t.rec->'slot'),
    public.munshi_text(t.rec->'sent_at')
  from jsonb_array_elements(coalesce(snapshot->'reminders', '[]'::jsonb)) as t(rec)
  where public.munshi_text(t.rec->'phone') <> ''
    and public.munshi_date(t.rec->'reminder_date') is not null
    and public.munshi_text(t.rec->'slot') <> '';

  insert into public.pending_entries (
    farmer_id, sender, created_at, language, entries_json, status, message_id, sort_order
  )
  select
    (select f.id from public.farmers f where f.phone = public.munshi_text(t.rec->'sender') limit 1),
    public.munshi_text(t.rec->'sender'),
    public.munshi_text(t.rec->'created_at'),
    public.munshi_text(t.rec->'language'),
    case when public.munshi_text(t.rec->'entries_json') = '' then '[]' else public.munshi_text(t.rec->'entries_json') end,
    public.munshi_text(t.rec->'status'),
    public.munshi_text(t.rec->'message_id'),
    coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer)
  from jsonb_array_elements(coalesce(snapshot->'pending', '[]'::jsonb)) with ordinality as t(rec, ord);

  insert into public.processed_messages (farmer_id, message_id, received_at, sender)
  select
    (select f.id from public.farmers f where f.phone = public.munshi_text(t.rec->'sender') limit 1),
    public.munshi_text(t.rec->'message_id'),
    public.munshi_text(t.rec->'received_at'),
    public.munshi_text(t.rec->'sender')
  from jsonb_array_elements(coalesce(snapshot->'processed', '[]'::jsonb)) as t(rec)
  where public.munshi_text(t.rec->'message_id') <> '';

  for v_ledger in
    select value as doc from jsonb_array_elements(coalesce(snapshot->'ledgers', '[]'::jsonb))
  loop
    v_sheet_key := public.munshi_text(v_ledger.doc->'sheet_key');
    v_owner := public.munshi_text(v_ledger.doc->'owner_phone');
    if v_sheet_key = '' or v_owner = '' then
      continue;
    end if;
    select id into v_fid from public.farmers where phone = v_owner;
    if v_fid is null then
      raise exception 'ledger owner not found';
    end if;

    insert into public.cows (
      farmer_id, sheet_key, origin, sort_order, cow_id, name, animal_type, breed, status,
      avg_daily_litres, notes, date_added, last_insemination, pregnancy_status,
      expected_calving, dry_off_due, pregnancy_check_due
    )
    select
      v_fid, v_sheet_key,
      coalesce(nullif(public.munshi_text(t.rec->'origin'), ''), 'app:' || gen_random_uuid()::text),
      coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer),
      public.munshi_text(t.rec->'cow_id'), public.munshi_text(t.rec->'name'),
      public.munshi_text(t.rec->'animal_type'), public.munshi_text(t.rec->'breed'),
      public.munshi_text(t.rec->'status'), public.munshi_num(t.rec->'avg_daily_litres'),
      public.munshi_text(t.rec->'notes'), public.munshi_text(t.rec->'date_added'),
      public.munshi_text(t.rec->'last_insemination'), public.munshi_text(t.rec->'pregnancy_status'),
      public.munshi_text(t.rec->'expected_calving'), public.munshi_text(t.rec->'dry_off_due'),
      public.munshi_text(t.rec->'pregnancy_check_due')
    from jsonb_array_elements(coalesce(v_ledger.doc->'cows', '[]'::jsonb)) with ordinality as t(rec, ord);

    insert into public.milk_records (
      farmer_id, sheet_key, origin, sort_order, record_date, session, cow_name, litres, source_note
    )
    select
      v_fid, v_sheet_key,
      coalesce(nullif(public.munshi_text(t.rec->'origin'), ''), 'app:' || gen_random_uuid()::text),
      coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer),
      public.munshi_date(t.rec->'record_date'), public.munshi_text(t.rec->'session'),
      public.munshi_text(t.rec->'cow_name'), public.munshi_num(t.rec->'litres'),
      public.munshi_text(t.rec->'source_note')
    from jsonb_array_elements(coalesce(v_ledger.doc->'milk', '[]'::jsonb)) with ordinality as t(rec, ord);

    insert into public.customers (
      farmer_id, sheet_key, origin, sort_order, name, phone, rate_pkr, opening_balance,
      current_balance, notes, billing_cycle, cycle_start_date, supply_type, daily_litres
    )
    select
      v_fid, v_sheet_key,
      coalesce(nullif(public.munshi_text(t.rec->'origin'), ''), 'app:' || gen_random_uuid()::text),
      coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer),
      public.munshi_text(t.rec->'name'), public.munshi_text(t.rec->'phone'),
      public.munshi_num(t.rec->'rate_pkr'), public.munshi_num(t.rec->'opening_balance'),
      public.munshi_num(t.rec->'current_balance'), public.munshi_text(t.rec->'notes'),
      public.munshi_text(t.rec->'billing_cycle'), public.munshi_date(t.rec->'cycle_start_date'),
      case
        when public.munshi_text(t.rec->'supply_type') in ('fixed', 'flexible') then public.munshi_text(t.rec->'supply_type')
        else null
      end,
      public.munshi_num(t.rec->'daily_litres')
    from jsonb_array_elements(coalesce(v_ledger.doc->'customers', '[]'::jsonb)) with ordinality as t(rec, ord);

    insert into public.sales (
      farmer_id, sheet_key, origin, sort_order, record_date, customer, litres, rate_pkr,
      amount, cash_received, balance_added, source_note
    )
    select
      v_fid, v_sheet_key,
      coalesce(nullif(public.munshi_text(t.rec->'origin'), ''), 'app:' || gen_random_uuid()::text),
      coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer),
      public.munshi_date(t.rec->'record_date'), public.munshi_text(t.rec->'customer'),
      public.munshi_num(t.rec->'litres'), public.munshi_num(t.rec->'rate_pkr'),
      public.munshi_num(t.rec->'amount'), public.munshi_num(t.rec->'cash_received'),
      public.munshi_num(t.rec->'balance_added'), public.munshi_text(t.rec->'source_note')
    from jsonb_array_elements(coalesce(v_ledger.doc->'sales', '[]'::jsonb)) with ordinality as t(rec, ord);

    insert into public.payments (
      farmer_id, sheet_key, origin, sort_order, record_date, customer, amount, method
    )
    select
      v_fid, v_sheet_key,
      coalesce(nullif(public.munshi_text(t.rec->'origin'), ''), 'app:' || gen_random_uuid()::text),
      coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer),
      public.munshi_date(t.rec->'record_date'), public.munshi_text(t.rec->'customer'),
      public.munshi_num(t.rec->'amount'), public.munshi_text(t.rec->'method')
    from jsonb_array_elements(coalesce(v_ledger.doc->'payments', '[]'::jsonb)) with ordinality as t(rec, ord);

    insert into public.expenses (
      farmer_id, sheet_key, origin, sort_order, record_date, category, amount, note
    )
    select
      v_fid, v_sheet_key,
      coalesce(nullif(public.munshi_text(t.rec->'origin'), ''), 'app:' || gen_random_uuid()::text),
      coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer),
      public.munshi_date(t.rec->'record_date'), public.munshi_text(t.rec->'category'),
      public.munshi_num(t.rec->'amount'), public.munshi_text(t.rec->'note')
    from jsonb_array_elements(coalesce(v_ledger.doc->'expenses', '[]'::jsonb)) with ordinality as t(rec, ord);

    insert into public.fodder_purchases (
      farmer_id, sheet_key, origin, sort_order, record_date, item, quantity, unit,
      cost_pkr, supplier, cash_paid, balance_owed, source_note
    )
    select
      v_fid, v_sheet_key,
      coalesce(nullif(public.munshi_text(t.rec->'origin'), ''), 'app:' || gen_random_uuid()::text),
      coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer),
      public.munshi_date(t.rec->'record_date'), public.munshi_text(t.rec->'item'),
      public.munshi_num(t.rec->'quantity'), public.munshi_text(t.rec->'unit'),
      public.munshi_num(t.rec->'cost_pkr'), public.munshi_text(t.rec->'supplier'),
      public.munshi_num(t.rec->'cash_paid'), public.munshi_num(t.rec->'balance_owed'),
      public.munshi_text(t.rec->'source_note')
    from jsonb_array_elements(coalesce(v_ledger.doc->'fodder', '[]'::jsonb)) with ordinality as t(rec, ord);

    insert into public.suppliers (farmer_id, sheet_key, origin, sort_order, name, balance_owed)
    select
      v_fid, v_sheet_key,
      coalesce(nullif(public.munshi_text(t.rec->'origin'), ''), 'supplier:' || v_sheet_key || ':' || t.ord::text),
      coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer),
      public.munshi_text(t.rec->'name'),
      coalesce(public.munshi_num(t.rec->'balance_owed'), 0)
    from jsonb_array_elements(coalesce(v_ledger.doc->'suppliers', '[]'::jsonb)) with ordinality as t(rec, ord);

    insert into public.committees (
      farmer_id, sheet_key, origin, sort_order, name, amount, frequency, start_date, organizer, status, notes,
      total_periods, opening_paid_periods, skip_31st
    )
    select
      v_fid, v_sheet_key,
      coalesce(nullif(public.munshi_text(t.rec->'origin'), ''), 'app:' || gen_random_uuid()::text),
      coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer),
      public.munshi_text(t.rec->'name'), public.munshi_num(t.rec->'amount'),
      public.munshi_text(t.rec->'frequency'), public.munshi_date(t.rec->'start_date'),
      public.munshi_text(t.rec->'organizer'), public.munshi_text(t.rec->'status'),
      public.munshi_text(t.rec->'notes'),
      public.munshi_int(t.rec->'total_periods'),
      coalesce(public.munshi_int(t.rec->'opening_paid_periods'), 0),
      coalesce(public.munshi_text(t.rec->'skip_31st'), '') in ('true', '1', 'yes', 't')
    from jsonb_array_elements(coalesce(v_ledger.doc->'committees', '[]'::jsonb)) with ordinality as t(rec, ord);

    insert into public.committee_log (
      farmer_id, sheet_key, origin, sort_order, record_date, committee, status, amount, note
    )
    select
      v_fid, v_sheet_key,
      coalesce(nullif(public.munshi_text(t.rec->'origin'), ''), 'app:' || gen_random_uuid()::text),
      coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer),
      public.munshi_date(t.rec->'record_date'), public.munshi_text(t.rec->'committee'),
      public.munshi_text(t.rec->'status'), public.munshi_num(t.rec->'amount'),
      public.munshi_text(t.rec->'note')
    from jsonb_array_elements(coalesce(v_ledger.doc->'committee_log', '[]'::jsonb)) with ordinality as t(rec, ord);

    insert into public.committee_status (
      farmer_id, sheet_key, origin, sort_order, committee, frequency, as_of,
      paid_periods, missed_periods, paid_amount, arrears, given_so_far, today_status
    )
    select
      v_fid, v_sheet_key,
      coalesce(nullif(public.munshi_text(t.rec->'origin'), ''), 'app:' || gen_random_uuid()::text),
      coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer),
      public.munshi_text(t.rec->'committee'), public.munshi_text(t.rec->'frequency'),
      public.munshi_date(t.rec->'as_of'), public.munshi_int(t.rec->'paid_periods'),
      public.munshi_int(t.rec->'missed_periods'), public.munshi_num(t.rec->'paid_amount'),
      public.munshi_num(t.rec->'arrears'), public.munshi_num(t.rec->'given_so_far'),
      public.munshi_text(t.rec->'today_status')
    from jsonb_array_elements(coalesce(v_ledger.doc->'committee_status', '[]'::jsonb)) with ordinality as t(rec, ord);

    insert into public.animal_events (
      farmer_id, sheet_key, origin, sort_order, record_date, cow, event_type, details,
      doctor_name, diagnosis, medicines, cost_pkr, next_due_date, source_note
    )
    select
      v_fid, v_sheet_key,
      coalesce(nullif(public.munshi_text(t.rec->'origin'), ''), 'app:' || gen_random_uuid()::text),
      coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer),
      public.munshi_date(t.rec->'record_date'), public.munshi_text(t.rec->'cow'),
      public.munshi_text(t.rec->'event_type'), public.munshi_text(t.rec->'details'),
      public.munshi_text(t.rec->'doctor_name'), public.munshi_text(t.rec->'diagnosis'),
      public.munshi_text(t.rec->'medicines'), public.munshi_num(t.rec->'cost_pkr'),
      public.munshi_date(t.rec->'next_due_date'), public.munshi_text(t.rec->'source_note')
    from jsonb_array_elements(coalesce(v_ledger.doc->'animal_events', '[]'::jsonb)) with ordinality as t(rec, ord);

    insert into public.feed_stock (
      farmer_id, sheet_key, origin, sort_order, item, quantity, unit, daily_use, updated_at,
      notes, days_left, run_out_date, reorder_by, avg_cost_per_kg
    )
    select
      v_fid, v_sheet_key,
      coalesce(nullif(public.munshi_text(t.rec->'origin'), ''), 'app:' || gen_random_uuid()::text),
      coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer),
      public.munshi_text(t.rec->'item'), public.munshi_num(t.rec->'quantity'),
      public.munshi_text(t.rec->'unit'), public.munshi_num(t.rec->'daily_use'),
      public.munshi_text(t.rec->'updated_at'), public.munshi_text(t.rec->'notes'),
      public.munshi_num(t.rec->'days_left'), public.munshi_date(t.rec->'run_out_date'),
      public.munshi_date(t.rec->'reorder_by'), public.munshi_num(t.rec->'avg_cost_per_kg')
    from jsonb_array_elements(coalesce(v_ledger.doc->'feed_stock', '[]'::jsonb)) with ordinality as t(rec, ord);

    insert into public.due_bills (
      farmer_id, sheet_key, origin, sort_order, customer, period_start, period_end, due_date,
      litres, amount, paid, balance_due, status
    )
    select
      v_fid, v_sheet_key,
      coalesce(nullif(public.munshi_text(t.rec->'origin'), ''), 'app:' || gen_random_uuid()::text),
      coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer),
      public.munshi_text(t.rec->'customer'), public.munshi_date(t.rec->'period_start'),
      public.munshi_date(t.rec->'period_end'), public.munshi_date(t.rec->'due_date'),
      public.munshi_num(t.rec->'litres'), public.munshi_num(t.rec->'amount'),
      public.munshi_num(t.rec->'paid'), public.munshi_num(t.rec->'balance_due'),
      public.munshi_text(t.rec->'status')
    from jsonb_array_elements(coalesce(v_ledger.doc->'due_bills', '[]'::jsonb)) with ordinality as t(rec, ord);

    insert into public.upcoming_events (
      farmer_id, sheet_key, origin, sort_order, record_date, cow, event, details
    )
    select
      v_fid, v_sheet_key,
      coalesce(nullif(public.munshi_text(t.rec->'origin'), ''), 'app:' || gen_random_uuid()::text),
      coalesce(public.munshi_int(t.rec->'sort_order'), t.ord::integer),
      public.munshi_date(t.rec->'record_date'), public.munshi_text(t.rec->'cow'),
      public.munshi_text(t.rec->'event'), public.munshi_text(t.rec->'details')
    from jsonb_array_elements(coalesce(v_ledger.doc->'upcoming_events', '[]'::jsonb)) with ordinality as t(rec, ord);

    if jsonb_typeof(v_ledger.doc->'last_write') = 'object' then
      insert into public.last_writes (sheet_key, farmer_id, sheet, row_num, entry_type, summary, written_at)
      values (
        v_sheet_key, v_fid,
        public.munshi_text(v_ledger.doc->'last_write'->'sheet'),
        public.munshi_int(v_ledger.doc->'last_write'->'row_num'),
        public.munshi_text(v_ledger.doc->'last_write'->'entry_type'),
        public.munshi_text(v_ledger.doc->'last_write'->'summary'),
        public.munshi_text(v_ledger.doc->'last_write'->'written_at')
      );
    end if;
  end loop;

  update public.ledger_meta set version = v_version + 1 where id = 1;
  return jsonb_build_object('ok', true, 'conflict', false, 'version', v_version + 1);
end;
$$;
