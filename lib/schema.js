function headerIndex(header, name) {
  const needle = String(name || "").toLowerCase();
  return (header || []).findIndex((h) => String(h || "").toLowerCase() === needle);
}

const TAB_HEADERS = {
  Animal_Events: [
    "date",
    "cow",
    "event_type",
    "details",
    "doctor_name",
    "diagnosis",
    "medicines",
    "cost_pkr",
    "next_due_date",
    "source_note",
  ],
  Feed_Stock: ["item", "quantity", "unit", "daily_use", "updated_at", "notes", "days_left", "run_out_date", "reorder_by", "avg_cost_per_kg"],
  Due_Bills: [
    "customer",
    "period_start",
    "period_end",
    "due_date",
    "litres",
    "amount",
    "paid",
    "balance_due",
    "status",
  ],
  Upcoming_Events: ["date", "cow", "event", "details"],
};

const EXTRA_COLUMNS = {
  Customers: ["billing_cycle", "cycle_start_date"],
  Cows: [
    "last_insemination",
    "pregnancy_status",
    "expected_calving",
    "dry_off_due",
    "pregnancy_check_due",
  ],
};

function ensureHeaderRow(rows, required) {
  if (!rows || !rows.length) {
    return [required.slice()];
  }
  const header = rows[0].slice();
  let changed = false;
  for (const col of required) {
    if (headerIndex(header, col) === -1) {
      header.push(col);
      changed = true;
    }
  }
  if (!changed) return rows;
  rows[0] = header;
  for (let i = 1; i < rows.length; i++) {
    while (rows[i].length < header.length) rows[i].push("");
  }
  return rows;
}

module.exports = {
  headerIndex,
  TAB_HEADERS,
  EXTRA_COLUMNS,
  ensureHeaderRow,
};
