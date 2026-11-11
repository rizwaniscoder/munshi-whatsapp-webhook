const { todayISO, TIMEZONE } = require("./config");
const { addDaysISO } = require("./billing");
const { parseSheetDate, eventLabel: formatEventLabel } = require("./format");

const GESTATION_DAYS = { cow: 283, buffalo: 310 };
const CHECK_AFTER = 60;
const DRY_OFF_BEFORE = 60;

function normalizeEventType(raw) {
  const t = String(raw || "").trim().toLowerCase();
  if (/(vet_appointment|doctor[^\n]{0,40}(aayenge|aaye ga|aayega|dekhne aay)|appointment|muaina scheduled)/.test(t)) {
    return "vet_appointment";
  }
  if (/(vet_visit|doctor[^\n]{0,40}(ne |aaye|dekha|bataya|visit)|daktar|vet visit)/.test(t)) {
    return "vet_visit";
  }
  if (/(inseminat|ai\b|artificial|pucca teeka|semen|seedha teeka)/.test(t)) return "insemination";
  if (/(natural service|natural|khud|bull service|saand)/.test(t)) return "natural_service";
  if (/(pregnancy.?check|check karaya|gaban check|pregnancy)/.test(t) && /check|gaban|positive|negative|hai/.test(t)) {
    return "pregnancy_check";
  }
  if (/(calving|bachha|bacha diya|calved|bya)/.test(t)) return "calving";
  if (/(dry.?off|soye|sukh|dry off|soona)/.test(t)) return "dry_off";
  if (/(heat|garmi|haryai| rutting)/.test(t)) return "heat";
  if (/(vaccin|teeka|wixin)/.test(t) && !/(pucca|ai|semen)/.test(t)) return "vaccination";
  if (/(treatment|dawai|medicine|injection|sui|ilaaj)/.test(t)) return "treatment";
  if (t) return t.replace(/\s+/g, "_");
  return "other";
}

function eventLabel(type, script = "roman") {
  return formatEventLabel(type, script);
}

function gestationDays(animalType) {
  return String(animalType || "").toLowerCase() === "buffalo" ? GESTATION_DAYS.buffalo : GESTATION_DAYS.cow;
}

function deriveCow(cowName, animalType, events) {
  const rows = (events || [])
    .filter((e) => String(e.cow || e.cow_name || "").toLowerCase() === String(cowName).toLowerCase())
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let lastInsemination = "";
  let pregnancyStatus = "open";
  let expectedCalving = "";
  let dryOffDue = "";
  let pregnancyCheckDue = "";
  let lastCalving = "";
  for (const ev of rows) {
    const typ = normalizeEventType(ev.event_type || ev.type);
    if (typ === "insemination" || typ === "natural_service") {
      lastInsemination = ev.date;
      pregnancyStatus = "bred";
      expectedCalving = addDaysISO(ev.date, gestationDays(animalType));
      dryOffDue = addDaysISO(expectedCalving, -DRY_OFF_BEFORE);
      pregnancyCheckDue = addDaysISO(ev.date, CHECK_AFTER);
    } else if (typ === "pregnancy_check") {
      const result = String(ev.result || ev.details || "").toLowerCase();
      if (/(neg|nahi|open|not pregnant|negative)/.test(result)) {
        pregnancyStatus = "open";
        expectedCalving = "";
        dryOffDue = "";
      } else if (/(pos|gaban|pregnant|positive|hai)/.test(result)) {
        pregnancyStatus = "pregnant";
        if (lastInsemination) {
          expectedCalving = addDaysISO(lastInsemination, gestationDays(animalType));
          dryOffDue = addDaysISO(expectedCalving, -DRY_OFF_BEFORE);
        }
      }
    } else if (typ === "calving") {
      lastCalving = ev.date;
      pregnancyStatus = "open";
      expectedCalving = "";
      dryOffDue = "";
      pregnancyCheckDue = "";
    } else if (typ === "dry_off") {
      pregnancyStatus = pregnancyStatus === "pregnant" ? "dry" : pregnancyStatus;
    }
  }
  return {
    cow: cowName,
    last_insemination: lastInsemination,
    pregnancy_status: pregnancyStatus,
    expected_calving: expectedCalving,
    dry_off_due: dryOffDue,
    pregnancy_check_due: pregnancyCheckDue,
    last_calving: lastCalving,
  };
}

function rowToEvent(row, header) {
  if (!row) return {};
  if (!Array.isArray(row)) {
    return { ...row, cow: row.cow || row.cow_name, event_type: row.event_type || row.type };
  }
  const get = (name, fallbackIndex) => {
    if (header) {
      const i = (header || []).findIndex((h) => String(h || "").toLowerCase() === name);
      return i === -1 ? "" : row[i];
    }
    return row[fallbackIndex];
  };
  return {
    date: parseSheetDate(get("date", 0)) || get("date", 0),
    cow: get("cow", 1),
    event_type: get("event_type", 2),
    details: get("details", 3),
    doctor_name: get("doctor_name", 4),
    diagnosis: get("diagnosis", 5),
    medicines: get("medicines", 6),
    cost_pkr: get("cost_pkr", 7),
    next_due_date: parseSheetDate(get("next_due_date", 8)) || get("next_due_date", 8),
    source_note: get("source_note", 9),
    result: get("details", 3),
  };
}

function upcomingFromDerived(derived, today, withinDays = 30) {
  const end = addDaysISO(today, withinDays);
  const out = [];
  const push = (date, event, details) => {
    if (date && date >= today && date <= end) out.push({ date, cow: derived.cow, event, details });
  };
  push(derived.pregnancy_check_due, "pregnancy_check", "check due");
  push(derived.dry_off_due, "dry_off", "soye / dry off due");
  push(derived.expected_calving, "calving", "expected calving");
  return out;
}

function upcomingEvents(cows, events, refDate, withinDays = 30) {
  const today = (refDate || todayISO(TIMEZONE)).slice(0, 10);
  const out = [];
  let cowHeader = null;
  let cowRows = cows || [];
  if (Array.isArray(cows) && cows.length && Array.isArray(cows[0]) && /^(name|cow_id)$/i.test(String(cows[0][0] || ""))) {
    cowHeader = cows[0];
    cowRows = cows.slice(1);
  }
  const evs = (events && events[0] && Array.isArray(events[0]) && /date/i.test(String(events[0][0] || "")))
    ? events.slice(1).map((e) => rowToEvent(e, events[0]))
    : (events || []).map((e) => rowToEvent(e));
  for (const cow of cowRows) {
    let name;
    let typ;
    if (cowHeader) {
      const ni = cowHeader.findIndex((h) => String(h || "").toLowerCase() === "name");
      const ti = cowHeader.findIndex((h) => String(h || "").toLowerCase() === "type");
      name = cow[ni];
      typ = (ti === -1 ? "cow" : cow[ti]) || "cow";
    } else {
      name = cow.name || cow[1] || cow[0];
      typ = cow.type || cow[2] || "cow";
    }
    if (!name) continue;
    const derived = deriveCow(name, typ, evs);
    out.push(...upcomingFromDerived(derived, today, withinDays));
  }
  for (const rec of evs) {
    const typ = normalizeEventType(rec.event_type || rec.type);
    const due = parseSheetDate(rec.next_due_date || rec.nextDue || rec.next_appointment_date);
    const scheduled = typ === "vet_appointment" ? parseSheetDate(rec.date) : "";
    for (const date of [due, scheduled]) {
      if (date && date >= today && date <= addDaysISO(today, withinDays)) {
        const already = out.some((x) => x.date === date && x.cow === rec.cow && x.event === typ);
        if (!already) {
          const details = [rec.doctor_name, rec.diagnosis, rec.details].filter(Boolean).join(" - ") || typ;
          out.push({ date, cow: rec.cow || rec.cow_name || "all", event: typ, details });
        }
      }
    }
  }
  out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return out;
}

function healthExpenseNote(entry) {
  const cow = entry.cow_name || entry.cow || "";
  const typ = normalizeEventType(entry.event_type || entry.type);
  return `Animal health: ${cow} ${eventLabel(typ)}`.trim();
}

function attachHealthExpenses(entries) {
  const out = [...(entries || [])];
  for (const entry of entries || []) {
    if (entry.type !== "animal_event" && entry.type !== "vet_visit") continue;
    const cost = Number(entry.cost_pkr ?? entry.fee_pkr ?? entry.amount) || 0;
    if (cost <= 0) continue;
    const typ = normalizeEventType(entry.event_type || entry.type);
    if (!/(vaccination|treatment|insemination|natural_service|vet_visit|other)/.test(typ)) continue;
    const date = entry.date;
    const already = out.some(
      (x) =>
        x.type === "expense" &&
        String(x.date) === String(date) &&
        Number(x.amount) === cost &&
        /animal|health|dawai|medicine|teeka|vaccin|treatment/i.test(String(x.category || x.note || ""))
    );
    if (already) continue;
    out.push({
      type: "expense",
      date,
      category: "animal_health",
      amount: cost,
      note: healthExpenseNote(entry),
    });
  }
  return out;
}

function pregnantCows(derivedList) {
  return (derivedList || []).filter((d) => d.pregnancy_status === "pregnant" || d.pregnancy_status === "dry");
}

module.exports = {
  GESTATION_DAYS,
  CHECK_AFTER,
  DRY_OFF_BEFORE,
  normalizeEventType,
  eventLabel,
  gestationDays,
  deriveCow,
  upcomingEvents,
  attachHealthExpenses,
  pregnantCows,
  healthExpenseNote,
  rowToEvent,
};
