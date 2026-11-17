/**
 * Munshi ledger gateway (multi-tenant).
 * The master spreadsheet (DEFAULT_SHEET_ID) holds the Farmers registry plus
 * Pending and Processed_Ids. Each farmer's cows, milk, sales and other data
 * live on their own sheet, copied from this template.
 *
 * Script Properties:
 *   SHEETS_SECRET   required shared secret, also set on the Render service
 *   SPREADSHEET_ID  optional, defaults to the bound spreadsheet
 *
 * If this script is already deployed, paste this file and use
 * Deploy > Manage deployments > the existing web app > pencil > New version
 * so the URL stays the same. The first time you deploy this version, Google
 * will ask you to authorize Drive (used only to copy a blank ledger for a
 * new farmer). Do not change SHEETS_SECRET or the web app URL.
 *
 * This version also adds Farmers.last_inbound_at, Farmers.web_token, and a
 * master-only Reminder_Log tab. Existing milk, sales, and other rows are kept.
 * web_token is the personal recorder link secret. Paste this file and deploy
 * a new version of the same web app before minting recorder links.
 */
var DEFAULT_SHEET_ID = "1sIDMkUs76cgl8ecBGIOWFIPiofGzwGJI1D3Az6OyDW8";
var MASTER_PHONE = "923155506704";

var migratedThisRequest_ = false;
var masterMigratedThisRequest_ = false;

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json_({ ok: false, error: "empty body" });
    }
    var body = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty("SHEETS_SECRET");
    if (!secret || body.secret !== secret) {
      return json_({ ok: false, error: "unauthorized" });
    }
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      return json_(handle_(body));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet() {
  return ContentService.createTextOutput("ok");
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function masterSs_() {
  var id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  try {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (err) {}
  return SpreadsheetApp.openById(id || DEFAULT_SHEET_ID);
}

function isMasterPhone_(phone) {
  return normalizePhone_(phone) === MASTER_PHONE;
}

function isMasterSheetId_(id) {
  return String(id || "").trim() === DEFAULT_SHEET_ID;
}

function ledgerSs_(body) {
  body = body || {};
  var sender = normalizePhone_(body.sender || body.phone);
  var ss = null;
  if (body.sheetId) {
    if (isMasterSheetId_(body.sheetId) && sender && !isMasterPhone_(sender)) {
      throw new Error("Ledger is number ke liye available nahi.");
    }
    ss = SpreadsheetApp.openById(body.sheetId);
  } else if (sender) {
    var farmer = findFarmerRow_(sender);
    if (farmer && farmer.sheetId) {
      if (isMasterSheetId_(farmer.sheetId) && !isMasterPhone_(sender)) {
        throw new Error("Ledger is number ke liye available nahi.");
      }
      ss = SpreadsheetApp.openById(farmer.sheetId);
    } else if (isMasterPhone_(sender)) {
      ss = masterSs_();
    } else {
      throw new Error("Farm ka ledger abhi tayyar nahi. Pehle onboarding mukammal karein.");
    }
  } else {
    throw new Error("sheetId or sender required");
  }
  migrateLedger_(ss);
  return ss;
}

function todayISO_() {
  return Utilities.formatDate(new Date(), "Asia/Karachi", "yyyy-MM-dd");
}

function addDaysISO_(iso, days) {
  var parts = String(iso || todayISO_()).slice(0, 10).split("-");
  var dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + Number(days)));
  return Utilities.formatDate(dt, "UTC", "yyyy-MM-dd");
}

function daysBetween_(a, b) {
  var pa = String(a).slice(0, 10).split("-");
  var pb = String(b).slice(0, 10).split("-");
  var ua = Date.UTC(Number(pa[0]), Number(pa[1]) - 1, Number(pa[2]));
  var ub = Date.UTC(Number(pb[0]), Number(pb[1]) - 1, Number(pb[2]));
  return Math.round((ub - ua) / 86400000);
}

function normalizeCycle_(raw) {
  var t = String(raw || "").trim().toLowerCase();
  if (!t) return "daily";
  if (/(do\s*hafta|bi-?week|fortnight|15\s*din|pandrah)/i.test(t)) return "biweekly";
  if (/(hafte|hafta|week|weekly)/i.test(t)) return "weekly";
  if (/(mahine|mahina|month|monthly)/i.test(t)) return "monthly";
  if (/(roz|daily|har din|rozana)/i.test(t)) return "daily";
  if (t === "daily" || t === "weekly" || t === "biweekly" || t === "monthly") return t;
  return "daily";
}

function clampDay_(year, month, day) {
  var last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(day, last);
}

function monthlyPeriod_(ref, billingDay) {
  var p = String(ref).slice(0, 10).split("-");
  var y = Number(p[0]);
  var m = Number(p[1]);
  var d = Number(p[2]);
  var day = billingDay || 1;
  if (d >= day) {
    var start = y + "-" + pad2_(m) + "-" + pad2_(clampDay_(y, m, day));
    var ny = y;
    var nm = m + 1;
    if (nm > 12) { nm = 1; ny += 1; }
    var end = addDaysISO_(ny + "-" + pad2_(nm) + "-" + pad2_(clampDay_(ny, nm, day)), -1);
    return { periodStart: start, periodEnd: end, dueDate: end };
  }
  var py = y;
  var pm = m - 1;
  if (pm < 1) { pm = 12; py -= 1; }
  var start2 = py + "-" + pad2_(pm) + "-" + pad2_(clampDay_(py, pm, day));
  var end2 = addDaysISO_(y + "-" + pad2_(m) + "-" + pad2_(clampDay_(y, m, day)), -1);
  return { periodStart: start2, periodEnd: end2, dueDate: end2 };
}

function pad2_(n) {
  return (n < 10 ? "0" : "") + n;
}

function periodFor_(cycle, cycleStart, refDate) {
  var today = String(refDate || todayISO_()).slice(0, 10);
  var cyc = normalizeCycle_(cycle);
  var anchor = String(cycleStart || today).slice(0, 10);
  if (cyc === "daily") return { periodStart: today, periodEnd: today, dueDate: today };
  if (cyc === "monthly") {
    var day = Number(String(anchor).slice(8, 10)) || 1;
    return monthlyPeriod_(today, day);
  }
  var length = cyc === "biweekly" ? 14 : 7;
  var offset = daysBetween_(anchor, today);
  if (offset < 0) {
    return { periodStart: anchor, periodEnd: addDaysISO_(anchor, length - 1), dueDate: addDaysISO_(anchor, length - 1) };
  }
  var index = Math.floor(offset / length);
  var start = addDaysISO_(anchor, index * length);
  var end = addDaysISO_(start, length - 1);
  return { periodStart: start, periodEnd: end, dueDate: end };
}

function tabHeaders_() {
  return {
    Animal_Events: ["date", "cow", "event_type", "details", "doctor_name", "diagnosis", "medicines", "cost_pkr", "next_due_date", "source_note"],
    Feed_Stock: ["item", "quantity", "unit", "daily_use", "updated_at", "notes", "days_left", "run_out_date", "reorder_by", "avg_cost_per_kg"],
    Due_Bills: ["customer", "period_start", "period_end", "due_date", "litres", "amount", "paid", "balance_due", "status"],
    Upcoming_Events: ["date", "cow", "event", "details"],
    Committees: ["name", "amount", "frequency", "start_date", "organizer", "status", "notes"],
    Committee_Log: ["date", "committee", "status", "amount", "note"],
    Committee_Status: ["committee", "frequency", "as_of", "paid_periods", "missed_periods", "paid_amount", "arrears", "given_so_far", "today_status"]
  };
}

function extraColumns_() {
  return {
    Customers: ["billing_cycle", "cycle_start_date", "supply_type", "daily_litres"],
    Cows: ["last_insemination", "pregnancy_status", "expected_calving", "dry_off_due", "pregnancy_check_due"]
  };
}

function ensureTab_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var existing = sh.getRange(1, 1, 1, lastCol).getValues()[0] || [];
  var empty = true;
  var i;
  for (i = 0; i < existing.length; i++) {
    if (String(existing[i] || "").trim()) { empty = false; break; }
  }
  if (empty) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    return sh;
  }
  var missing = [];
  for (i = 0; i < headers.length; i++) {
    if (headerIndex_(existing, headers[i]) === -1) missing.push(headers[i]);
  }
  if (missing.length) {
    sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function ensureColumns_(ss, tab, cols) {
  var sh = ss.getSheetByName(tab);
  if (!sh) return;
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var existing = sh.getRange(1, 1, 1, lastCol).getValues()[0] || [];
  var missing = [];
  var i;
  for (i = 0; i < cols.length; i++) {
    if (headerIndex_(existing, cols[i]) === -1) missing.push(cols[i]);
  }
  if (missing.length) {
    sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
}

function ensureDashboard_(ss) {
  var sh = ss.getSheetByName("Dashboard");
  if (!sh) return;
  var label = String(sh.getRange("A26").getValue() || "");
  if (!/due bills/i.test(label)) {
    sh.getRange("A26").setValue("DUE BILLS");
    sh.getRange("A27").setFormula('=IFERROR(QUERY(Due_Bills!A2:I50,"select A, D, H, I where H > 0 order by D",1),"Koi bill due nahi")');
    sh.getRange("A34").setValue("UPCOMING (30 DAYS)");
    sh.getRange("A35").setFormula('=IFERROR(QUERY(Upcoming_Events!A2:D50,"select A, B, C, D order by A",1),"Koi event nahi")');
    sh.getRange("A44").setValue("FEED STOCK");
    sh.getRange("A45").setFormula('=IFERROR(QUERY(Feed_Stock!A2:D20,"select A, B, C, D",1),"Stock nahi")');
  }
  var found = false;
  var col = sh.getRange("A1:A80").getValues();
  var i;
  for (i = 0; i < col.length; i++) {
    if (/^committee$/i.test(String(col[i][0] || "").trim())) found = true;
  }
  if (!found) {
    var row = String(sh.getRange("A52").getValue() || "") ? 60 : 52;
    sh.getRange(row, 1).setValue("COMMITTEE");
    sh.getRange(row + 1, 1).setFormula('=IFERROR(QUERY(Committee_Status!A2:I40,"select A, I, G, H",1),"Koi committee nahi")');
  }
}

function isSchemaCurrent_(ss) {
  if (!ss.getSheetByName("Animal_Events")) return false;
  if (!ss.getSheetByName("Feed_Stock")) return false;
  if (!ss.getSheetByName("Due_Bills")) return false;
  if (!ss.getSheetByName("Upcoming_Events")) return false;
  var feed = ss.getSheetByName("Feed_Stock").getRange(1, 1, 1, Math.max(ss.getSheetByName("Feed_Stock").getLastColumn(), 1)).getValues()[0];
  if (headerIndex_(feed, "days_left") === -1 || headerIndex_(feed, "avg_cost_per_kg") === -1) return false;
  var cust = ss.getSheetByName("Customers");
  if (!cust) return false;
  var chead = cust.getRange(1, 1, 1, Math.max(cust.getLastColumn(), 1)).getValues()[0];
  if (headerIndex_(chead, "billing_cycle") === -1) return false;
  if (headerIndex_(chead, "supply_type") === -1 || headerIndex_(chead, "daily_litres") === -1) return false;
  var cows = ss.getSheetByName("Cows");
  if (cows) {
    var cowHead = cows.getRange(1, 1, 1, Math.max(cows.getLastColumn(), 1)).getValues()[0];
    if (headerIndex_(cowHead, "expected_calving") === -1) return false;
  }
  if (!ss.getSheetByName("Committees")) return false;
  if (!ss.getSheetByName("Committee_Log")) return false;
  if (!ss.getSheetByName("Committee_Status")) return false;
  var comm = ss.getSheetByName("Committees").getRange(1, 1, 1, Math.max(ss.getSheetByName("Committees").getLastColumn(), 1)).getValues()[0];
  if (headerIndex_(comm, "amount") === -1 || headerIndex_(comm, "frequency") === -1) return false;
  var clog = ss.getSheetByName("Committee_Log").getRange(1, 1, 1, Math.max(ss.getSheetByName("Committee_Log").getLastColumn(), 1)).getValues()[0];
  if (headerIndex_(clog, "status") === -1) return false;
  return true;
}

function migrateLedger_(ss) {
  if (!ss) return;
  if (migratedThisRequest_) return;
  if (isSchemaCurrent_(ss)) {
    migratedThisRequest_ = true;
    return;
  }
  var tabs = tabHeaders_();
  var name;
  for (name in tabs) {
    if (tabs.hasOwnProperty(name)) ensureTab_(ss, name, tabs[name]);
  }
  var extra = extraColumns_();
  for (name in extra) {
    if (extra.hasOwnProperty(name)) ensureColumns_(ss, name, extra[name]);
  }
  ensureDashboard_(ss);
  var due = ss.getSheetByName("Due_Bills");
  if (due) due.getRange("B:D").setNumberFormat("yyyy-mm-dd");
  var feedSh = ss.getSheetByName("Feed_Stock");
  if (feedSh) {
    var h = feedSh.getRange(1, 1, 1, Math.max(feedSh.getLastColumn(), 1)).getValues()[0];
    var runIdx = headerIndex_(h, "run_out_date");
    var reoIdx = headerIndex_(h, "reorder_by");
    var updIdx = headerIndex_(h, "updated_at");
    if (runIdx !== -1) feedSh.getRange(1, runIdx + 1, feedSh.getMaxRows(), 1).setNumberFormat("yyyy-mm-dd");
    if (reoIdx !== -1) feedSh.getRange(1, reoIdx + 1, feedSh.getMaxRows(), 1).setNumberFormat("yyyy-mm-dd");
    if (updIdx !== -1) feedSh.getRange(1, updIdx + 1, feedSh.getMaxRows(), 1).setNumberFormat("yyyy-mm-dd");
  }
  var commSh = ss.getSheetByName("Committees");
  if (commSh) {
    var ch = commSh.getRange(1, 1, 1, Math.max(commSh.getLastColumn(), 1)).getValues()[0];
    var startIdx = headerIndex_(ch, "start_date");
    if (startIdx !== -1) commSh.getRange(1, startIdx + 1, commSh.getMaxRows(), 1).setNumberFormat("yyyy-mm-dd");
  }
  var logSh = ss.getSheetByName("Committee_Log");
  if (logSh) logSh.getRange("A:A").setNumberFormat("yyyy-mm-dd");
  var statSh = ss.getSheetByName("Committee_Status");
  if (statSh) {
    var shh = statSh.getRange(1, 1, 1, Math.max(statSh.getLastColumn(), 1)).getValues()[0];
    var asOf = headerIndex_(shh, "as_of");
    if (asOf !== -1) statSh.getRange(1, asOf + 1, statSh.getMaxRows(), 1).setNumberFormat("yyyy-mm-dd");
  }
  migratedThisRequest_ = true;
}

function normalizeEventType_(raw) {
  var t = String(raw || "").trim().toLowerCase();
  if (/(vet_appointment|appointment|dekhne aay|aayenge|aayega)/.test(t) && /(doctor|daktar|vet|appointment)/.test(t)) return "vet_appointment";
  if (t === "vet_appointment") return "vet_appointment";
  if (t === "vet_visit" || (/(doctor|daktar|vet)/.test(t) && /(visit|dekha|bataya|aaye)/.test(t))) return "vet_visit";
  if (/(inseminat|ai\b|artificial|pucca teeka|semen)/.test(t)) return "insemination";
  if (/(natural service|natural|saand)/.test(t)) return "natural_service";
  if (/(pregnancy.?check|check karaya|gaban check)/.test(t)) return "pregnancy_check";
  if (/(calving|bachha|bacha diya|calved|bya)/.test(t)) return "calving";
  if (/(dry.?off|soye|sukh|dry off)/.test(t)) return "dry_off";
  if (/(heat|garmi)/.test(t)) return "heat";
  if (/(vaccin|teeka)/.test(t) && !/(pucca|ai|semen)/.test(t)) return "vaccination";
  if (/(treatment|dawai|medicine|injection|sui|ilaaj)/.test(t)) return "treatment";
  if (t) return t.replace(/\s+/g, "_");
  return "other";
}

function cowNameCol_(header) {
  var idx = headerIndex_(header, "name");
  return idx === -1 ? 1 : idx;
}

function deriveAndUpcoming_(ss, today) {
  var cows = values_(ss, "Cows");
  var events = values_(ss, "Animal_Events");
  var cHeader = cows[0] || [];
  var eHeader = events[0] || [];
  var nameCol = cowNameCol_(cHeader);
  var typeCol = headerIndex_(cHeader, "type");
  var lastInsemCol = headerIndex_(cHeader, "last_insemination");
  var pregCol = headerIndex_(cHeader, "pregnancy_status");
  var calvCol = headerIndex_(cHeader, "expected_calving");
  var dryCol = headerIndex_(cHeader, "dry_off_due");
  var checkCol = headerIndex_(cHeader, "pregnancy_check_due");
  var evDate = headerIndex_(eHeader, "date"); if (evDate === -1) evDate = 0;
  var evCow = headerIndex_(eHeader, "cow"); if (evCow === -1) evCow = 1;
  var evType = headerIndex_(eHeader, "event_type"); if (evType === -1) evType = 2;
  var evDetails = headerIndex_(eHeader, "details"); if (evDetails === -1) evDetails = 3;
  var evDoc = headerIndex_(eHeader, "doctor_name");
  var evNext = headerIndex_(eHeader, "next_due_date"); if (evNext === -1) evNext = 8;
  var upcoming = [];
  var i;
  var sh = sheet_(ss, "Cows");
  for (i = 1; i < cows.length; i++) {
    var cowName = String(cows[i][nameCol] || "");
    if (!cowName) continue;
    var animalType = typeCol === -1 ? "cow" : String(cows[i][typeCol] || "cow");
    var gest = /buffalo|bhains/i.test(animalType) ? 310 : 283;
    var lastInsem = "";
    var status = "open";
    var expected = "";
    var dryDue = "";
    var checkDue = "";
    var evs = [];
    var j;
    for (j = 1; j < events.length; j++) {
      if (String(events[j][evCow] || "").toLowerCase() !== cowName.toLowerCase()) continue;
      evs.push(events[j]);
    }
    evs.sort(function (a, b) { return String(cellDate_(a[evDate])).localeCompare(String(cellDate_(b[evDate]))); });
    for (j = 0; j < evs.length; j++) {
      var typ = normalizeEventType_(evs[j][evType]);
      var dt = cellDate_(evs[j][evDate]);
      if (typ === "insemination" || typ === "natural_service") {
        lastInsem = dt;
        status = "bred";
        expected = addDaysISO_(dt, gest);
        dryDue = addDaysISO_(expected, -60);
        checkDue = addDaysISO_(dt, 60);
      } else if (typ === "pregnancy_check") {
        var result = String(evs[j][evDetails] || "").toLowerCase();
        if (/(neg|nahi|open|not pregnant|negative)/.test(result)) {
          status = "open"; expected = ""; dryDue = "";
        } else if (/(pos|gaban|pregnant|positive|hai)/.test(result)) {
          status = "pregnant";
          if (lastInsem) {
            expected = addDaysISO_(lastInsem, gest);
            dryDue = addDaysISO_(expected, -60);
          }
        }
      } else if (typ === "calving") {
        status = "open"; expected = ""; dryDue = ""; checkDue = ""; lastInsem = lastInsem;
      } else if (typ === "dry_off") {
        if (status === "pregnant") status = "dry";
      }
    }
    var row = i + 1;
    if (lastInsemCol !== -1) sh.getRange(row, lastInsemCol + 1).setValue(lastInsem);
    if (pregCol !== -1) sh.getRange(row, pregCol + 1).setValue(status);
    if (calvCol !== -1) sh.getRange(row, calvCol + 1).setValue(expected);
    if (dryCol !== -1) sh.getRange(row, dryCol + 1).setValue(dryDue);
    if (checkCol !== -1) sh.getRange(row, checkCol + 1).setValue(checkDue);
    var horizon = addDaysISO_(today, 30);
    function pushUp(date, event, details) {
      if (date && date >= today && date <= horizon) upcoming.push([date, cowName, event, details || ""]);
    }
    pushUp(checkDue, "pregnancy_check", "check due");
    pushUp(dryDue, "dry_off", "soye / dry off due");
    pushUp(expected, "calving", "expected calving");
  }
  for (i = 1; i < events.length; i++) {
    var typ2 = normalizeEventType_(events[i][evType]);
    var due = evNext !== -1 ? cellDate_(events[i][evNext]) : "";
    var scheduled = typ2 === "vet_appointment" ? cellDate_(events[i][evDate]) : "";
    var dates = [due, scheduled];
    var d;
    for (d = 0; d < dates.length; d++) {
      if (dates[d] && dates[d] >= today && dates[d] <= addDaysISO_(today, 30)) {
        var details = [evDoc !== -1 ? events[i][evDoc] : "", events[i][evDetails]].filter(function (x) { return x; }).join(" - ");
        upcoming.push([dates[d], events[i][evCow] || "all", typ2, details]);
      }
    }
  }
  return upcoming;
}

function statementFor_(ss, customerName, today) {
  var customers = values_(ss, "Customers");
  var sales = values_(ss, "Sales");
  var payments = values_(ss, "Payments");
  var header = customers[0] || [];
  var idx = findRow_(customers, 0, customerName);
  if (idx === -1) return null;
  var row = customers[idx];
  var cycle = normalizeCycle_(headerIndex_(header, "billing_cycle") === -1 ? "daily" : row[headerIndex_(header, "billing_cycle")]);
  var startIdx = headerIndex_(header, "cycle_start_date");
  var cycleStart = startIdx === -1 ? "" : cellDate_(row[startIdx]);
  var period = periodFor_(cycle, cycleStart, today);
  var rateIdx = headerIndex_(header, "rate_pkr");
  var rate = rateIdx === -1 ? 0 : parseAmount_(row[rateIdx]);
  var litres = 0;
  var amount = 0;
  var paid = 0;
  var i;
  for (i = 1; i < sales.length; i++) {
    if (String(sales[i][1] || "").toLowerCase() !== String(customerName).toLowerCase()) continue;
    var d = cellDate_(sales[i][0]);
    if (d < period.periodStart || d > period.periodEnd) continue;
    litres += parseAmount_(sales[i][2]);
    amount += parseAmount_(sales[i][4]);
    paid += parseAmount_(sales[i][5]);
  }
  if (!amount && litres && rate) amount = litres * rate;
  var paidFromSales = paid;
  paid = paidFromSales;
  for (i = 1; i < payments.length; i++) {
    if (String(payments[i][1] || "").toLowerCase() !== String(customerName).toLowerCase()) continue;
    var pd = cellDate_(payments[i][0]);
    if (pd < period.periodStart || pd > period.periodEnd) continue;
    paid += parseAmount_(payments[i][2]);
  }
  var balanceDue = Math.round((amount - paid) * 100) / 100;
  var status = balanceDue > 0 && today >= period.dueDate ? "due" : (balanceDue > 0 ? "open" : "paid");
  return {
    customer: row[0],
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    dueDate: period.dueDate,
    litres: litres,
    amount: amount,
    paid: paid,
    balanceDue: balanceDue,
    status: status
  };
}

function refreshDerived_(ss) {
  migrateLedger_(ss);
  refreshFeedStock_(ss);
  var today = todayISO_();
  var customers = values_(ss, "Customers");
  var dueSh = sheet_(ss, "Due_Bills");
  var last = dueSh.getLastRow();
  if (last > 1) dueSh.getRange(2, 1, last - 1, Math.max(dueSh.getLastColumn(), 9)).clearContent();
  var i;
  var r = 2;
  for (i = 1; i < customers.length; i++) {
    if (!customers[i][0]) continue;
    var bill = statementFor_(ss, customers[i][0], today);
    if (!bill || !(bill.balanceDue > 0)) continue;
    dueSh.getRange(r, 1, 1, 9).setValues([[bill.customer, bill.periodStart, bill.periodEnd, bill.dueDate, bill.litres, bill.amount, bill.paid, bill.balanceDue, bill.status]]);
    r++;
  }
  var upcoming = deriveAndUpcoming_(ss, today);
  var upSh = sheet_(ss, "Upcoming_Events");
  last = upSh.getLastRow();
  if (last > 1) upSh.getRange(2, 1, last - 1, Math.max(upSh.getLastColumn(), 4)).clearContent();
  if (upcoming.length) {
    upSh.getRange(2, 1, upcoming.length, 4).setValues(upcoming);
  }
  writeCommitteeStatus_(ss, today);
}


function toKg_(quantity, unit) {
  var qty = Number(quantity) || 0;
  var u = String(unit || "").toLowerCase();
  if (u === "mann" || u === "man" || u === "mun") return qty * 40;
  if (u === "kg" || u === "kilo" || u === "kgs") return qty;
  return 0;
}

function averageCostPerKg_(ss, item) {
  var fodder = values_(ss, "Fodder");
  var needle = fodderItemName_(item);
  var cost = 0;
  var kg = 0;
  var i;
  for (i = 1; i < fodder.length; i++) {
    if (fodderItemName_(fodder[i][1]) !== needle) continue;
    var converted = toKg_(fodder[i][2], fodder[i][3]);
    var rowCost = parseAmount_(fodder[i][4]);
    if (converted > 0 && rowCost > 0) {
      kg += converted;
      cost += rowCost;
    }
  }
  if (!kg) return "";
  return Math.round((cost / kg) * 100) / 100;
}

function refreshFeedStock_(ss) {
  migrateLedger_(ss);
  var sh = sheet_(ss, "Feed_Stock");
  var data = values_(ss, "Feed_Stock");
  var header = data[0] || [];
  var qtyIdx = headerIndex_(header, "quantity");
  var useIdx = headerIndex_(header, "daily_use");
  var daysIdx = headerIndex_(header, "days_left");
  var runIdx = headerIndex_(header, "run_out_date");
  var reoIdx = headerIndex_(header, "reorder_by");
  var avgIdx = headerIndex_(header, "avg_cost_per_kg");
  var today = todayISO_();
  var i;
  for (i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    var qty = parseAmount_(data[i][qtyIdx === -1 ? 1 : qtyIdx]);
    var daily = parseAmount_(data[i][useIdx === -1 ? 3 : useIdx]);
    var row = i + 1;
    var daysLeft = "";
    var runOut = "";
    var reorder = "";
    if (daily > 0) {
      daysLeft = Math.floor(qty / daily);
      if (daysLeft < 0) daysLeft = 0;
      runOut = addDaysISO_(today, daysLeft);
      reorder = addDaysISO_(runOut, -3);
    } else if (qty <= 0) {
      daysLeft = 0;
      runOut = today;
      reorder = today;
    }
    if (daysIdx !== -1) sh.getRange(row, daysIdx + 1).setValue(daysLeft);
    if (runIdx !== -1) sh.getRange(row, runIdx + 1).setValue(runOut);
    if (reoIdx !== -1) sh.getRange(row, reoIdx + 1).setValue(reorder);
    if (avgIdx !== -1) sh.getRange(row, avgIdx + 1).setValue(averageCostPerKg_(ss, data[i][0]));
  }
}

function applyStockDelta_(ss, item, quantity, unit, dailyUse, notes, today) {
  migrateLedger_(ss);
  var sh = sheet_(ss, "Feed_Stock");
  var data = values_(ss, "Feed_Stock");
  var header = data[0] || [];
  var name = fodderItemName_(item || "other");
  var idx = findRow_(data, 0, name);
  var qtyIdx = headerIndex_(header, "quantity"); if (qtyIdx === -1) qtyIdx = 1;
  var unitIdx = headerIndex_(header, "unit");
  var useIdx = headerIndex_(header, "daily_use");
  var updIdx = headerIndex_(header, "updated_at");
  var noteIdx = headerIndex_(header, "notes");
  if (idx === -1) {
    var rowVals = [];
    var c;
    for (c = 0; c < Math.max(header.length, 6); c++) rowVals[c] = "";
    rowVals[0] = name;
    rowVals[qtyIdx] = Number(quantity) || 0;
    if (unit && unitIdx !== -1) rowVals[unitIdx] = unit;
    if (dailyUse != null && dailyUse !== "" && useIdx !== -1) rowVals[useIdx] = dailyUse;
    if (updIdx !== -1) rowVals[updIdx] = today || todayISO_();
    if (notes && noteIdx !== -1) rowVals[noteIdx] = notes;
    sh.appendRow(rowVals);
    return sh.getLastRow();
  }
  var row = idx + 1;
  var current = parseAmount_(sh.getRange(row, qtyIdx + 1).getValue());
  if (quantity != null && quantity !== "") {
    sh.getRange(row, qtyIdx + 1).setValue(Math.round((current + Number(quantity)) * 1000) / 1000);
  }
  if (unit && unitIdx !== -1 && !sh.getRange(row, unitIdx + 1).getValue()) sh.getRange(row, unitIdx + 1).setValue(unit);
  if (dailyUse != null && dailyUse !== "" && useIdx !== -1) sh.getRange(row, useIdx + 1).setValue(dailyUse);
  if (updIdx !== -1) sh.getRange(row, updIdx + 1).setValue(today || todayISO_());
  if (notes && noteIdx !== -1) appendNote_(sh, row, noteIdx + 1, notes);
  return row;
}

function setSupply_(ss, entry, note) {
  var sh = sheet_(ss, "Customers");
  var data = values_(ss, "Customers");
  var header = data[0] || [];
  var idx = findRow_(data, 0, entry.customer);
  if (idx === -1) return { error: "Customer nahi mila: " + entry.customer };
  var row = idx + 1;
  applyCustomerSupply_(sh, header, row, entry);
  if (entry.billing_cycle || entry.cycle_start_date) {
    applyCustomerCycle_(sh, header, row, entry.billing_cycle, entry.cycle_start_date, false);
  }
  var notesIdx = headerIndex_(header, "notes");
  if (entry.supply_note && notesIdx !== -1) {
    var prev = String(sh.getRange(row, notesIdx + 1).getValue() || "");
    if (prev.indexOf(entry.supply_note) === -1) appendNote_(sh, row, notesIdx + 1, entry.supply_note);
  }
  setLastWrite_(ss, "Customers", row, "set_supply", entry.customer + " " + (entry.supply_type || ""));
  return { ok: true, sheet: "Customers", row: row };
}

function changeBillingCycle_(ss, entry, note) {
  var sh = sheet_(ss, "Customers");
  var data = values_(ss, "Customers");
  var header = data[0] || [];
  var idx = findRow_(data, 0, entry.customer);
  if (idx === -1) return { error: "Customer nahi mila: " + entry.customer };
  var row = idx + 1;
  var cycleIdx = headerIndex_(header, "billing_cycle");
  var startIdx = headerIndex_(header, "cycle_start_date");
  var notesIdx = headerIndex_(header, "notes");
  var prev = cycleIdx === -1 ? "" : data[idx][cycleIdx];
  if (cycleIdx !== -1) sh.getRange(row, cycleIdx + 1).setValue(normalizeCycle_(entry.billing_cycle));
  if (startIdx !== -1) {
    if (entry.cycle_start_date) sh.getRange(row, startIdx + 1).setValue(entry.cycle_start_date);
    else if (!data[idx][startIdx]) sh.getRange(row, startIdx + 1).setValue(todayISO_());
  }
  if (notesIdx !== -1) appendNote_(sh, row, notesIdx + 1, "cycle " + prev + " -> " + normalizeCycle_(entry.billing_cycle) + " (" + note + ")");
  setLastWrite_(ss, "Customers", row, "change_billing_cycle", entry.customer + " " + entry.billing_cycle);
  return { ok: true, sheet: "Customers", row: row };
}

function appendAnimalEvent_(ss, entry, note) {
  migrateLedger_(ss);
  var typ = entry.event_type || entry.type;
  var sh = sheet_(ss, "Animal_Events");
  var header = values_(ss, "Animal_Events")[0] || [];
  var rowVals = [];
  var c;
  for (c = 0; c < Math.max(header.length, 10); c++) rowVals[c] = "";
  function setCol(name, val) {
    var i = headerIndex_(header, name);
    if (i !== -1) rowVals[i] = val == null ? "" : val;
  }
  setCol("date", entry.date);
  setCol("cow", entry.cow_name || entry.cow || "all");
  setCol("event_type", typ);
  setCol("details", entry.details || "");
  setCol("doctor_name", entry.doctor_name || "");
  setCol("diagnosis", entry.diagnosis || "");
  setCol("medicines", entry.medicines || "");
  setCol("cost_pkr", entry.cost_pkr != null ? entry.cost_pkr : (entry.fee_pkr != null ? entry.fee_pkr : ""));
  setCol("next_due_date", entry.next_due_date || entry.next_appointment_date || "");
  setCol("source_note", entry.note || note);
  sh.appendRow(rowVals);
  var row = sh.getLastRow();
  setLastWrite_(ss, "Animal_Events", row, typ, (entry.cow_name || entry.cow || "all") + " " + typ);
  return { ok: true, sheet: "Animal_Events", row: row };
}


function sheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error("Missing tab: " + name);
  return sh;
}

function values_(ss, name) {
  var data = sheet_(ss, name).getDataRange().getValues();
  return data && data.length ? data : [[]];
}

function append_(ss, name, row) {
  var sh = sheet_(ss, name);
  sh.appendRow(row);
  return sh.getLastRow();
}

function parseAmount_(value) {
  if (typeof value === "number" && isFinite(value)) return value;
  if (value == null || value === "") return 0;
  var n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return isFinite(n) ? n : 0;
}

function todayMinus_(days) {
  var d = new Date();
  d.setDate(d.getDate() - days);
  return Utilities.formatDate(d, "Asia/Karachi", "yyyy-MM-dd");
}

function nowStamp_() {
  return Utilities.formatDate(new Date(), "Asia/Karachi", "yyyy-MM-dd'T'HH:mm:ss");
}

function cellDate_(value) {
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value)) {
    return Utilities.formatDate(value, "Asia/Karachi", "yyyy-MM-dd");
  }
  return String(value || "");
}

function normalizePhone_(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function isAllowedFlag_(value) {
  if (value === true || value === 1) return true;
  var s = String(value || "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1";
}

function headerIndex_(header, name) {
  var needle = String(name || "").toLowerCase();
  for (var i = 0; i < header.length; i++) {
    if (String(header[i] || "").toLowerCase() === needle) return i;
  }
  return -1;
}

function findRow_(data, colIndex, name) {
  var needle = String(name || "").toLowerCase();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][colIndex] || "").toLowerCase() === needle) return i;
  }
  return -1;
}

function nextCowId_(data) {
  var max = 0;
  for (var i = 1; i < data.length; i++) {
    var m = String(data[i][0] || "").match(/(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  var n = String(max + 1);
  while (n.length < 3) n = "0" + n;
  return "C-" + n;
}

function openingCol_(header) {
  var idx = headerIndex_(header, "opening_balance");
  return idx === -1 ? 2 : idx;
}

function balanceCol_(header) {
  var idx = headerIndex_(header, "current_balance");
  return idx === -1 ? 3 : idx;
}

function rateCol_(header) {
  return headerIndex_(header, "rate_pkr");
}

function balanceFormula_(row, openingCol) {
  var colLetter = openingCol === 3 ? "D" : "C";
  return (
    "=" + colLetter + row +
    "+SUMIF(Sales!B:B,A" + row + ",Sales!G:G)-SUMIF(Payments!B:B,A" + row + ",Payments!C:C)"
  );
}

function upsertCustomer_(ss, name, phone, rate, opening, cycle, cycleStart) {
  var sh = sheet_(ss, "Customers");
  var data = sh.getDataRange().getValues();
  var header = data[0] || [];
  var idx = findRow_(data, 0, name);
  var openCol = openingCol_(header);
  var balCol = balanceCol_(header);
  var rateIdx = rateCol_(header);
  var notesIdx = headerIndex_(header, "notes");
  if (idx === -1) {
    var rowVals = [];
    var width = Math.max(header.length, 5);
    for (var c = 0; c < width; c++) rowVals[c] = "";
    rowVals[0] = name;
    rowVals[1] = phone || "";
    if (rateIdx !== -1) rowVals[rateIdx] = rate == null || rate === "" ? "" : rate;
    rowVals[openCol] = opening == null || opening === "" ? 0 : opening;
    sh.appendRow(rowVals);
    var row = sh.getLastRow();
    sh.getRange(row, balCol + 1).setFormula(balanceFormula_(row, openCol));
    applyCustomerCycle_(sh, header, row, cycle, cycleStart, true);
    return;
  }
  var row = idx + 1;
  if (phone) sh.getRange(row, 2).setValue(phone);
  if (rate != null && rate !== "" && rateIdx !== -1) {
    sh.getRange(row, rateIdx + 1).setValue(rate);
  }
  if (opening != null && opening !== "") {
    sh.getRange(row, openCol + 1).setValue(opening);
  }
  if (!sh.getRange(row, balCol + 1).getFormula()) {
    sh.getRange(row, balCol + 1).setFormula(balanceFormula_(row, openCol));
  }
  applyCustomerCycle_(sh, header, row, cycle, cycleStart, false);
}

function applyCustomerSupply_(sh, header, row, entry) {
  var type = String(entry.supply_type || "").toLowerCase();
  if (type !== "fixed" && type !== "flexible") return;
  var typeCol = headerIndex_(header, "supply_type");
  var litreCol = headerIndex_(header, "daily_litres");
  if (typeCol !== -1) sh.getRange(row, typeCol + 1).setValue(type);
  if (litreCol !== -1) {
    if (type === "flexible") sh.getRange(row, litreCol + 1).setValue("");
    else if (entry.daily_litres != null && entry.daily_litres !== "") sh.getRange(row, litreCol + 1).setValue(entry.daily_litres);
  }
}

function applyCustomerCycle_(sh, header, row, cycle, cycleStart, isNew) {
  var cycleCol = headerIndex_(header, "billing_cycle");
  var startCol = headerIndex_(header, "cycle_start_date");
  if (cycleCol !== -1) {
    if (cycle) sh.getRange(row, cycleCol + 1).setValue(normalizeCycle_(cycle));
    else if (isNew) sh.getRange(row, cycleCol + 1).setValue("daily");
  }
  if (startCol !== -1) {
    if (cycleStart) sh.getRange(row, startCol + 1).setValue(cycleStart);
    else if (isNew && !sh.getRange(row, startCol + 1).getValue()) sh.getRange(row, startCol + 1).setValue(todayISO_());
  }
}

function appendNote_(sh, row, col, note) {
  if (!note || col < 1) return;
  var prev = String(sh.getRange(row, col).getValue() || "");
  sh.getRange(row, col).setValue(prev ? prev + "; " + note : note);
}

function setLastWrite_(ss, tab, row, type, summary) {
  var sh = ss.getSheetByName("Last_Write");
  if (!sh) return;
  sh.getRange(2, 1, 1, 5).setValues([[tab, row, type, summary || "", nowStamp_()]]);
}

function handle_(body) {
  migratedThisRequest_ = false;
  masterMigratedThisRequest_ = false;
  migrateMaster_();
  var started = Date.now();
  var action = body.action;
  if (action === "ping") return { ok: true, multiTenant: true };
  if (action === "getFarmer") return getFarmer_(body.phone || body.sender);
  if (action === "upsertFarmer") return upsertFarmer_(body);
  if (action === "copyLedger") return copyLedger_(body);
  if (action === "listFarmers") return listFarmers_(false);
  if (action === "listRecorderFarmers") return listFarmers_(true);
  if (action === "findFarmerByToken") return findFarmerByToken_(body.webToken || body.token);
  if (action === "setWebToken") return setWebToken_(body);
  if (action === "touchLastInbound") return touchLastInbound_(body.phone || body.sender, body.at);
  if (action === "claimReminder") return claimReminder_(body);
  if (action === "releaseReminder") return releaseReminder_(body);
  if (action === "isProcessed") return isProcessed_(body.messageId);
  if (action === "markProcessed") return markProcessed_(body.messageId, body.sender);
  if (action === "setPending") return setPending_(body);
  if (action === "getPending") return getPending_(body.sender);
  if (action === "clearPending") return clearPending_(body.sender, body.status);
  var ss = ledgerSs_(body);
  if (action === "getContext") return getContext_(ss);
  if (action === "commitRecords") return commitRecords_(ss, body);
  if (action === "readRecent") return readRecent_(ss, body.days || 30, body.refresh);
  if (action === "refreshDerived") {
    refreshDerived_(ss);
    return { ok: true, refreshed: true, elapsedMs: Date.now() - started };
  }
  return { ok: false, error: "unknown action" };
}

function farmersData_() {
  var ss = masterSs_();
  var sh = ss.getSheetByName("Farmers");
  if (!sh) return { sh: null, data: [["phone", "sheet_id", "name", "farm_name", "onboarding_state", "allowed", "created_at", "last_inbound_at", "web_token"]] };
  return { sh: sh, data: sh.getDataRange().getValues() };
}

function findFarmerRow_(phone) {
  phone = normalizePhone_(phone);
  var pack = farmersData_();
  var data = pack.data;
  var header = data[0] || [];
  var phoneCol = Math.max(0, headerIndex_(header, "phone"));
  for (var i = 1; i < data.length; i++) {
    if (normalizePhone_(data[i][phoneCol]) === phone) {
      var row = data[i];
      return {
        index: i,
        row: i + 1,
        phone: phone,
        sheetId: String(row[1] || ""),
        name: String(row[2] || ""),
        farmName: String(row[3] || ""),
        onboardingState: String(row[4] || ""),
        allowed: isAllowedFlag_(row[5]),
        createdAt: String(row[6] || ""),
        lastInboundAt: cellInstant_(inboundValue_(header, row)),
        webToken: webTokenValue_(header, row),
      };
    }
  }
  return null;
}

function inboundValue_(header, row) {
  var col = headerIndex_(header, "last_inbound_at");
  if (col === -1) return "";
  return row[col];
}

function webTokenValue_(header, row) {
  var col = headerIndex_(header, "web_token");
  if (col === -1) return "";
  return String(row[col] || "");
}

function cellInstant_(value) {
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value)) {
    return Utilities.formatDate(value, "UTC", "yyyy-MM-dd'T'HH:mm:ss'Z'");
  }
  return String(value || "");
}

function farmerJson_(f) {
  if (!f) return null;
  return {
    phone: f.phone,
    sheetId: f.sheetId,
    name: f.name,
    farmName: f.farmName,
    onboardingState: f.onboardingState,
    allowed: f.allowed,
    createdAt: f.createdAt,
    lastInboundAt: f.lastInboundAt || "",
    webToken: f.webToken || "",
  };
}

function getFarmer_(phone) {
  var farmer = farmerJson_(findFarmerRow_(phone));
  if (farmer) delete farmer.webToken;
  return { ok: true, farmer: farmer };
}

function listFarmers_(withTokens) {
  var pack = farmersData_();
  var out = [];
  for (var i = 1; i < pack.data.length; i++) {
    var row = pack.data[i];
    if (!row[0]) continue;
    var item = {
      phone: normalizePhone_(row[0]),
      sheetId: String(row[1] || ""),
      name: String(row[2] || ""),
      farmName: String(row[3] || ""),
      onboardingState: String(row[4] || ""),
      allowed: isAllowedFlag_(row[5]),
      createdAt: String(row[6] || ""),
      lastInboundAt: cellInstant_(inboundValue_(pack.data[0] || [], row)),
    };
    if (withTokens) item.webToken = webTokenValue_(pack.data[0] || [], row);
    out.push(item);
  }
  return { ok: true, farmers: out };
}

function migrateMaster_() {
  if (masterMigratedThisRequest_) return;
  var ss = masterSs_();
  ensureColumns_(ss, "Farmers", ["last_inbound_at", "web_token"]);
  var farmers = ss.getSheetByName("Farmers");
  if (farmers) {
    var head = farmers.getRange(1, 1, 1, Math.max(farmers.getLastColumn(), 1)).getValues()[0];
    var tokenCol = headerIndex_(head, "web_token");
    if (tokenCol !== -1 && farmers.getRange(1, tokenCol + 1).getNumberFormat() !== "@") {
      farmers.getRange(1, tokenCol + 1, farmers.getMaxRows(), 1).setNumberFormat("@");
    }
  }
  var sh = ensureTab_(ss, "Reminder_Log", ["phone", "date", "slot", "sent_at"]);
  if (sh && sh.getLastRow() <= 1) {
    sh.getRange(1, 2, sh.getMaxRows(), 1).setNumberFormat("@");
    sh.getRange(1, 4, sh.getMaxRows(), 1).setNumberFormat("@");
  }
  masterMigratedThisRequest_ = true;
}

function touchLastInbound_(phone, at) {
  migrateMaster_();
  phone = normalizePhone_(phone);
  if (!phone) return { ok: false, error: "phone required" };
  var found = findFarmerRow_(phone);
  if (!found) return { ok: true, updated: false };
  var pack = farmersData_();
  var col = headerIndex_(pack.data[0] || [], "last_inbound_at");
  if (col === -1) return { ok: false, error: "last_inbound_at column missing" };
  pack.sh.getRange(found.row, col + 1).setValue(String(at || new Date().toISOString()));
  return { ok: true, updated: true };
}

function findFarmerByToken_(token) {
  token = String(token || "").trim();
  if (!token) return { ok: true, farmer: null };
  migrateMaster_();
  var pack = farmersData_();
  var header = pack.data[0] || [];
  var col = headerIndex_(header, "web_token");
  if (col === -1) return { ok: true, farmer: null };
  var i;
  for (i = 1; i < pack.data.length; i++) {
    if (String(pack.data[i][col] || "") !== token) continue;
    var row = pack.data[i];
    return {
      ok: true,
      farmer: farmerJson_({
        phone: normalizePhone_(row[0]),
        sheetId: String(row[1] || ""),
        name: String(row[2] || ""),
        farmName: String(row[3] || ""),
        onboardingState: String(row[4] || ""),
        allowed: isAllowedFlag_(row[5]),
        createdAt: String(row[6] || ""),
        lastInboundAt: cellInstant_(inboundValue_(header, row)),
        webToken: "",
      }),
    };
  }
  return { ok: true, farmer: null };
}

function setWebToken_(body) {
  migrateMaster_();
  var phone = normalizePhone_(body.phone || body.sender);
  var token = String(body.webToken || body.token || "").trim();
  if (!phone || !token) return { ok: false, error: "phone and token required" };
  var pack = farmersData_();
  if (!pack.sh) return { ok: false, error: "Missing tab: Farmers" };
  var header = pack.data[0] || [];
  var col = headerIndex_(header, "web_token");
  if (col === -1) return { ok: false, error: "web_token column missing" };
  var i;
  for (i = 1; i < pack.data.length; i++) {
    if (String(pack.data[i][col] || "") === token && normalizePhone_(pack.data[i][0]) !== phone) {
      return { ok: false, error: "token already used" };
    }
  }
  var found = findFarmerRow_(phone);
  if (!found) return { ok: false, error: "farmer not found" };
  pack.sh.getRange(found.row, col + 1).setNumberFormat("@");
  pack.sh.getRange(found.row, col + 1).setValue(token);
  return { ok: true, updated: true };
}

function reminderPack_() {
  migrateMaster_();
  var ss = masterSs_();
  var sh = ss.getSheetByName("Reminder_Log");
  if (!sh) throw new Error("Missing tab: Reminder_Log");
  return { sh: sh, data: sh.getDataRange().getValues() };
}

function reminderMatch_(row, header, phone, date, slot) {
  var phoneCol = headerIndex_(header, "phone");
  var dateCol = headerIndex_(header, "date");
  var slotCol = headerIndex_(header, "slot");
  if (phoneCol === -1) phoneCol = 0;
  if (dateCol === -1) dateCol = 1;
  if (slotCol === -1) slotCol = 2;
  var rowDate = cellDate_(row[dateCol]);
  if (/^\d{4}-\d{2}-\d{2}/.test(rowDate)) rowDate = String(rowDate).slice(0, 10);
  return normalizePhone_(row[phoneCol]) === normalizePhone_(phone) &&
    rowDate === String(date) &&
    String(row[slotCol] || "") === String(slot);
}

function claimReminder_(body) {
  var phone = normalizePhone_(body.phone || body.sender);
  var date = String(body.date || "");
  var slot = String(body.slot || "");
  if (!phone || !date || !slot) return { ok: false, error: "phone, date, and slot required" };
  var pack = reminderPack_();
  var header = pack.data[0] || [];
  var i;
  for (i = 1; i < pack.data.length; i++) {
    if (reminderMatch_(pack.data[i], header, phone, date, slot)) {
      return { ok: true, claimed: false, already: true };
    }
  }
  append_(masterSs_(), "Reminder_Log", [phone, date, slot, String(body.sentAt || new Date().toISOString())]);
  return { ok: true, claimed: true, already: false };
}

function releaseReminder_(body) {
  var phone = normalizePhone_(body.phone || body.sender);
  var date = String(body.date || "");
  var slot = String(body.slot || "");
  var pack = reminderPack_();
  var header = pack.data[0] || [];
  var removed = 0;
  var i;
  for (i = pack.data.length - 1; i >= 1; i--) {
    if (reminderMatch_(pack.data[i], header, phone, date, slot)) {
      pack.sh.deleteRow(i + 1);
      removed++;
    }
  }
  return { ok: true, removed: removed };
}

function upsertFarmer_(body) {
  var phone = normalizePhone_(body.phone || body.sender);
  if (!phone) return { ok: false, error: "phone required" };
  var pack = farmersData_();
  var sh = pack.sh;
  if (!sh) throw new Error("Missing tab: Farmers");
  var existing = findFarmerRow_(phone);
  var allowed = body.allowed == null ? (existing ? existing.allowed : false) : isAllowedFlag_(body.allowed);
  var name = body.name != null ? body.name : existing ? existing.name : "";
  var farmName = body.farmName != null ? body.farmName : existing ? existing.farmName : "";
  var state = body.onboardingState != null ? body.onboardingState : existing ? existing.onboardingState : "pending_profile";
  var sheetId = body.sheetId != null ? body.sheetId : existing ? existing.sheetId : "";
  var created = existing ? existing.createdAt : nowStamp_();
  if (existing) {
    sh.getRange(existing.row, 1, 1, 7).setValues([[phone, sheetId, name, farmName, state, allowed, created]]);
  } else {
    sh.appendRow([phone, sheetId, name, farmName, state, allowed, created]);
  }
  return getFarmer_(phone);
}

function clearData_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) return;
  var last = sh.getLastRow();
  var cols = Math.max(sh.getLastColumn(), 1);
  if (last > 1) sh.getRange(2, 1, last - 1, cols).clearContent();
}

function copyLedger_(body) {
  var farmName = body.farmName || "Dairy Farm";
  var template = DriveApp.getFileById(DEFAULT_SHEET_ID);
  var copy = template.makeCopy("Munshi - " + farmName);
  var ss = SpreadsheetApp.openById(copy.getId());
  var farmers = ss.getSheetByName("Farmers");
  if (farmers) ss.deleteSheet(farmers);
  var reminders = ss.getSheetByName("Reminder_Log");
  if (reminders) ss.deleteSheet(reminders);
  migrateLedger_(ss);
  var tabs = ["Milk_Log", "Sales", "Payments", "Expenses", "Fodder", "Pending", "Processed_Ids", "Last_Write", "Cows", "Customers", "Animal_Events", "Feed_Stock", "Due_Bills", "Upcoming_Events", "Committees", "Committee_Log", "Committee_Status"];
  for (var i = 0; i < tabs.length; i++) clearData_(ss, tabs[i]);
  if (body.phone) {
    upsertFarmer_({
      phone: body.phone,
      sheetId: copy.getId(),
      name: body.name,
      farmName: farmName,
      onboardingState: body.onboardingState || "pending_animals",
      allowed: body.allowed == null ? true : body.allowed,
    });
  }
  refreshDerived_(ss);
  return { ok: true, sheetId: copy.getId(), url: copy.getUrl() };
}

function getContext_(ss) {
  var cows = [];
  var cowRows = values_(ss, "Cows");
  var header = cowRows[0] || [];
  var nameCol = cowNameCol_(header);
  var statusCol = headerIndex_(header, "status");
  for (var i = 1; i < cowRows.length; i++) {
    var status = statusCol === -1 ? "" : String(cowRows[i][statusCol] || "");
    if (cowRows[i][nameCol] && status.toLowerCase() !== "removed") {
      cows.push(String(cowRows[i][nameCol]));
    }
  }
  var customers = [];
  var custRows = values_(ss, "Customers");
  for (var j = 1; j < custRows.length; j++) {
    if (custRows[j][0]) customers.push(String(custRows[j][0]));
  }
  var committees = [];
  var commRows = values_(ss, "Committees");
  var chead = commRows[0] || [];
  var nameCol = headerIndex_(chead, "name"); if (nameCol === -1) nameCol = 0;
  var amtCol = headerIndex_(chead, "amount");
  var freqCol = headerIndex_(chead, "frequency");
  var startCol = headerIndex_(chead, "start_date");
  var statCol = headerIndex_(chead, "status");
  for (var k = 1; k < commRows.length; k++) {
    if (!commRows[k][nameCol]) continue;
    var st = statCol === -1 ? "active" : String(commRows[k][statCol] || "active");
    if (st.toLowerCase() === "paused") continue;
    committees.push({
      name: String(commRows[k][nameCol]),
      amount: amtCol === -1 ? 0 : parseAmount_(commRows[k][amtCol]),
      frequency: freqCol === -1 ? "daily" : String(commRows[k][freqCol] || "daily"),
      start_date: startCol === -1 ? "" : cellDate_(commRows[k][startCol])
    });
  }
  var customerSupply = [];
  var supplyCol = headerIndex_(custRows[0] || [], "supply_type");
  var litreCol = headerIndex_(custRows[0] || [], "daily_litres");
  var noteCol = headerIndex_(custRows[0] || [], "notes");
  for (var s = 1; s < custRows.length; s++) {
    if (!custRows[s][0]) continue;
    var supplyType = supplyCol === -1 ? "" : String(custRows[s][supplyCol] || "").toLowerCase();
    var supplyLitres = litreCol === -1 ? "" : custRows[s][litreCol];
    var supplyNotes = noteCol === -1 ? "" : String(custRows[s][noteCol] || "");
    if (supplyType === "fixed" && supplyLitres !== "" && supplyLitres != null) {
      customerSupply.push(String(custRows[s][0]) + " fixed " + supplyLitres + " L/day");
    } else if (supplyType === "flexible") {
      var typical = supplyNotes.match(/typical\s+[\d.]+\s*L\/day/i);
      customerSupply.push(String(custRows[s][0]) + " flexible" + (typical ? " " + typical[0] : ""));
    }
  }
  return { ok: true, cows: cows, customers: customers, committees: committees, customer_supply: customerSupply };
}

function isProcessed_(messageId) {
  var rows = values_(masterSs_(), "Processed_Ids");
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(messageId)) return { ok: true, processed: true };
  }
  return { ok: true, processed: false };
}

function markProcessed_(messageId, sender) {
  var already = isProcessed_(messageId);
  if (already.processed) return { ok: true, already: true };
  append_(masterSs_(), "Processed_Ids", [messageId, nowStamp_(), sender || ""]);
  return { ok: true };
}

function isOpenPending_(status) {
  var s = String(status || "").toLowerCase();
  return s === "pending" || s === "editing";
}

function setPending_(body) {
  var ss = masterSs_();
  var sh = sheet_(ss, "Pending");
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(body.sender) && isOpenPending_(data[i][4])) {
      sh.getRange(i + 1, 5).setValue("superseded");
    }
  }
  append_(ss, "Pending", [
    body.sender,
    nowStamp_(),
    body.language || "roman_urdu",
    JSON.stringify(body.entries || []),
    body.status === "editing" ? "editing" : "pending",
    body.messageId || "",
  ]);
  return { ok: true };
}

function getPending_(sender) {
  var data = values_(masterSs_(), "Pending");
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === String(sender) && isOpenPending_(data[i][4])) {
      return {
        ok: true,
        pending: {
          sender: data[i][0],
          created_at: data[i][1],
          language: data[i][2],
          entries: JSON.parse(data[i][3] || "[]"),
          status: data[i][4],
          message_id: data[i][5],
        },
      };
    }
  }
  return { ok: true, pending: null };
}

function clearPending_(sender, status) {
  var sh = sheet_(masterSs_(), "Pending");
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(sender) && isOpenPending_(data[i][4])) {
      sh.getRange(i + 1, 5).setValue(status || "cancelled");
    }
  }
  return { ok: true };
}

function isFodderCategory_(category) {
  var c = String(category || "").toLowerCase();
  return /\b(chara|chaara|charay|wanda|bhoosa|toori|silage|khal|fodder|green fodder|hara chara|khoraak|khurak|feed)\b/.test(c);
}

function fodderItemName_(raw) {
  var t = String(raw || "").toLowerCase();
  if (t.indexOf("wanda") !== -1) return "wanda";
  if (t.indexOf("bhoosa") !== -1 || t.indexOf("toori") !== -1) return "bhoosa";
  if (t.indexOf("silage") !== -1) return "silage";
  if (t.indexOf("khal") !== -1) return "khal";
  if (
    t.indexOf("chara") !== -1 ||
    t.indexOf("green fodder") !== -1 ||
    t.indexOf("hara chara") !== -1 ||
    t.indexOf("fodder") !== -1
  ) {
    return "chara";
  }
  return "other";
}

function normalizeAnimalType_(raw) {
  var t = String(raw || "").toLowerCase();
  if (/bhains|buffalo|bheins|bhainse/.test(t)) return "buffalo";
  return "cow";
}

function canonicalExpense_(raw) {
  var s = String(raw || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  if (/^(kharcha|kharch|expense|expenses|other)$/i.test(s)) return "kharcha";
  var rules = [
    ["labor", /\b(mazdo+ri|mazduri|mazdoor|labour|labor|mzdori)\b/i],
    ["salary", /\b(tankhwa?h|tankwah|tankhah|tanakhah|salary)\b/i],
    ["electricity", /\b(bijli|electricity|light bill|light)\b/i],
    ["fuel", /\b(fuel|diesel|petrol|disel)\b/i],
    ["medicine", /\b(dawai|davai|dawa|medicine|medicines)\b/i],
    ["transport", /\b(transport|kiraya|kirayah|sawari|travel)\b/i],
    ["repairs", /\b(marammat|maramat|repair|repairs)\b/i],
    ["animal_health", /\banimal[ _]?health\b/i]
  ];
  var fillers = { ka: 1, ki: 1, ke: 1, aaj: 1, kal: 1, roz: 1, daily: 1, bill: 1, wala: 1, wali: 1, wale: 1, the: 1, of: 1, for: 1 };
  var words = s.toLowerCase().split(/\s+/);
  var i;
  for (i = 0; i < rules.length; i++) {
    if (!rules[i][1].test(s)) continue;
    var leftover = false;
    var w;
    for (w = 0; w < words.length; w++) {
      if (rules[i][1].test(words[w]) || fillers[words[w]]) continue;
      leftover = true;
    }
    if (!leftover) return rules[i][0];
  }
  return s.toLowerCase();
}

function committeeAmount_(ss, name) {
  var rows = values_(ss, "Committees");
  var header = rows[0] || [];
  var nameCol = headerIndex_(header, "name");
  if (nameCol === -1) nameCol = 0;
  var amtCol = headerIndex_(header, "amount");
  var idx = findRow_(rows, nameCol, name);
  if (idx === -1 || amtCol === -1) return 0;
  return parseAmount_(rows[idx][amtCol]);
}

function upsertCommittee_(ss, entry) {
  var sh = sheet_(ss, "Committees");
  var data = values_(ss, "Committees");
  var header = data[0] || [];
  var name = entry.name || "Committee";
  var nameCol = headerIndex_(header, "name");
  if (nameCol === -1) nameCol = 0;
  var idx = findRow_(data, nameCol, name);
  function put(arr, colName, val) {
    var i = headerIndex_(header, colName);
    if (i !== -1 && val != null && val !== "") arr[i] = val;
  }
  if (idx === -1) {
    var rowVals = [];
    var c;
    for (c = 0; c < header.length; c++) rowVals[c] = "";
    put(rowVals, "name", name);
    put(rowVals, "amount", entry.amount);
    put(rowVals, "frequency", entry.frequency || "daily");
    put(rowVals, "start_date", entry.start_date || "");
    put(rowVals, "organizer", entry.organizer || "");
    put(rowVals, "status", entry.status || "active");
    put(rowVals, "notes", entry.note || "");
    sh.appendRow(rowVals);
    var row = sh.getLastRow();
    setLastWrite_(ss, "Committees", row, "setup_committee", name + " " + (entry.amount || ""));
    return { ok: true, sheet: "Committees", row: row };
  }
  var rowNum = idx + 1;
  function setCell(colName, val) {
    var i = headerIndex_(header, colName);
    if (i === -1 || val == null || val === "") return;
    sh.getRange(rowNum, i + 1).setValue(val);
  }
  setCell("amount", entry.amount);
  setCell("frequency", entry.frequency || "");
  setCell("start_date", entry.start_date || "");
  setCell("organizer", entry.organizer || "");
  setCell("status", entry.status || "");
  setLastWrite_(ss, "Committees", rowNum, "setup_committee", name + " " + (entry.amount || ""));
  return { ok: true, sheet: "Committees", row: rowNum };
}

function appendCommitteeLog_(ss, entry) {
  var status = entry.status || "paid";
  var amount = entry.amount;
  if (status === "not_paid") amount = "";
  if (status !== "not_paid" && !parseAmount_(amount)) {
    var known = committeeAmount_(ss, entry.committee);
    if (status === "paid" && known) amount = known;
    else return { ok: true, skipped: true };
  }
  var row = append_(ss, "Committee_Log", [
    entry.date || "",
    entry.committee || "Committee",
    status,
    amount === "" || amount == null ? "" : amount,
    entry.note || ""
  ]);
  setLastWrite_(ss, "Committee_Log", row, "committee_log", (entry.committee || "") + " " + status);
  return { ok: true, sheet: "Committee_Log", row: row };
}

function committeePeriods_(freq, start, today) {
  var periods = [];
  if (!start || start > today) return periods;
  var cursor;
  if (freq === "daily") {
    cursor = start;
    while (cursor <= today && periods.length < 800) {
      periods.push({ start: cursor, end: cursor, closed: true });
      cursor = addDaysISO_(cursor, 1);
    }
    return periods;
  }
  var step = freq === "weekly" ? 7 : (freq === "biweekly" ? 14 : 0);
  if (step) {
    cursor = start;
    while (cursor <= today && periods.length < 400) {
      var end = addDaysISO_(cursor, step - 1);
      periods.push({ start: cursor, end: end, closed: end <= today });
      cursor = addDaysISO_(cursor, step);
    }
    return periods;
  }
  cursor = start;
  while (cursor <= today && periods.length < 120) {
    var parts = String(cursor).split("-");
    var y = Number(parts[0]);
    var m = Number(parts[1]) + 1;
    var d = Number(parts[2]);
    if (m > 12) { m = 1; y += 1; }
    var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    var next = y + "-" + (m < 10 ? "0" : "") + m + "-" + (Math.min(d, last) < 10 ? "0" : "") + Math.min(d, last);
    var mend = addDaysISO_(next, -1);
    periods.push({ start: cursor, end: mend, closed: mend <= today });
    cursor = addDaysISO_(mend, 1);
  }
  return periods;
}

function summarizeCommitteeGs_(name, expected, freq, start, logs, ld, lc, ls, la, today) {
  var periods = committeePeriods_(freq, start, today);
  var monthStart = String(today).slice(0, 8) + "01";
  var summary = { monthPaid: 0, monthMissed: 0, monthPaidAmount: 0, arrears: 0, given: 0, todayStatus: "not_paid" };
  var p;
  for (p = 0; p < periods.length; p++) {
    var period = periods[p];
    var log = null;
    var j;
    for (j = 1; j < logs.length; j++) {
      if (String(logs[j][lc] || "").toLowerCase() !== String(name).toLowerCase()) continue;
      var dt = cellDate_(logs[j][ld]);
      if (!dt || dt < period.start || dt > period.end) continue;
      log = logs[j];
    }
    var status = log ? String(log[ls] || "not_paid") : "not_paid";
    var amount = log ? parseAmount_(log[la]) : 0;
    if (status === "paid" && !amount && expected) amount = expected;
    if (status === "paid" && expected && amount > 0 && amount < expected) status = "partial";
    var inMonth = period.start >= monthStart && period.start <= today;
    if (status === "paid") {
      summary.given += amount;
      if (inMonth) { summary.monthPaid += 1; summary.monthPaidAmount += amount; }
    } else if (status === "partial") {
      summary.given += amount;
      if (period.closed) summary.arrears += Math.max(0, expected - amount);
      if (inMonth) { summary.monthPaidAmount += amount; summary.monthMissed += 1; }
    } else if (period.closed) {
      summary.arrears += expected;
      if (inMonth) summary.monthMissed += 1;
    } else if (inMonth) {
      summary.monthMissed += 1;
    }
    if (period.start <= today && period.end >= today) summary.todayStatus = status === "paid" || status === "partial" ? status : "not_paid";
  }
  return summary;
}

function writeCommitteeStatus_(ss, today) {
  var sh = sheet_(ss, "Committee_Status");
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, Math.max(sh.getLastColumn(), 9)).clearContent();
  var committees = values_(ss, "Committees");
  var logs = values_(ss, "Committee_Log");
  var header = committees[0] || [];
  var nameCol = headerIndex_(header, "name"); if (nameCol === -1) nameCol = 0;
  var amtCol = headerIndex_(header, "amount");
  var freqCol = headerIndex_(header, "frequency");
  var startCol = headerIndex_(header, "start_date");
  var statCol = headerIndex_(header, "status");
  var lhead = logs[0] || [];
  var ld = headerIndex_(lhead, "date"); if (ld === -1) ld = 0;
  var lc = headerIndex_(lhead, "committee"); if (lc === -1) lc = 1;
  var ls = headerIndex_(lhead, "status"); if (ls === -1) ls = 2;
  var la = headerIndex_(lhead, "amount"); if (la === -1) la = 3;
  var out = [];
  var i;
  for (i = 1; i < committees.length; i++) {
    var name = String(committees[i][nameCol] || "");
    if (!name) continue;
    var st = statCol === -1 ? "active" : String(committees[i][statCol] || "active");
    if (String(st).toLowerCase() === "paused") continue;
    var expected = amtCol === -1 ? 0 : parseAmount_(committees[i][amtCol]);
    var freq = normalizeCycle_(freqCol === -1 ? "daily" : committees[i][freqCol]);
    var start = startCol === -1 ? today : (cellDate_(committees[i][startCol]) || today);
    var summary = summarizeCommitteeGs_(name, expected, freq, start, logs, ld, lc, ls, la, today);
    out.push([name, freq, today, summary.monthPaid, summary.monthMissed, summary.monthPaidAmount, summary.arrears, summary.given, summary.todayStatus]);
  }
  if (out.length) sh.getRange(2, 1, out.length, 9).setValues(out);
}

function commitRecords_(ss, body) {
  var started = Date.now();
  var entries = body.entries || [];
  var note = body.sourceNote || ("WhatsApp " + (body.sender || ""));
  var saved = 0;
  var last = null;
  for (var i = 0; i < entries.length; i++) {
    var result = commitOne_(ss, entries[i], note);
    if (result && result.ok) {
      saved++;
      last = result;
    } else if (result && result.error) {
      return { ok: false, error: result.error, saved: saved, elapsedMs: Date.now() - started };
    }
  }
  if (body.refresh !== false) refreshDerived_(ss);
  clearPending_(body.sender, "saved");
  return { ok: true, saved: saved, lastWrite: last || null, elapsedMs: Date.now() - started };
}

function commitOne_(ss, entry, note) {
  entry = entry || {};
  if (entry.type === "expense" && isFodderCategory_(entry.category)) {
    entry = {
      type: "fodder",
      date: entry.date,
      item: fodderItemName_(entry.item || entry.category),
      quantity: entry.quantity == null ? "" : entry.quantity,
      unit: entry.unit || "",
      cost_pkr: entry.cost_pkr != null ? entry.cost_pkr : entry.amount,
      supplier: entry.supplier || "",
      cash_paid: entry.cash_paid == null || entry.cash_paid === "" ? 0 : entry.cash_paid,
      balance_owed:
        entry.balance_owed == null || entry.balance_owed === ""
          ? (Number(entry.cost_pkr != null ? entry.cost_pkr : entry.amount) || 0) -
            (Number(entry.cash_paid) || 0)
          : entry.balance_owed,
      note: entry.note,
    };
  }
  if (entry.type === "milk") {
    var row = append_(ss, "Milk_Log", [
      entry.date,
      entry.session || "",
      entry.cow_name,
      entry.litres,
      entry.note || note,
    ]);
    setLastWrite_(ss, "Milk_Log", row, "milk", entry.cow_name + " " + entry.litres + " L");
    return { ok: true, sheet: "Milk_Log", row: row };
  }
  if (entry.type === "sale") {
    var row = append_(ss, "Sales", [
      entry.date,
      entry.customer,
      entry.litres,
      entry.rate_pkr,
      entry.amount,
      entry.cash_received,
      entry.balance_added,
      entry.note || note,
    ]);
    upsertCustomer_(ss, entry.customer, "", entry.rate_pkr, "");
    setLastWrite_(ss, "Sales", row, "sale", entry.customer + " " + entry.amount);
    return { ok: true, sheet: "Sales", row: row };
  }
  if (entry.type === "payment") {
    var row = append_(ss, "Payments", [
      entry.date,
      entry.customer,
      entry.amount,
      entry.method || "",
    ]);
    upsertCustomer_(ss, entry.customer, "", "", "");
    setLastWrite_(ss, "Payments", row, "payment", entry.customer + " " + entry.amount);
    return { ok: true, sheet: "Payments", row: row };
  }
  if (entry.type === "expense") {
    if (isFodderCategory_(entry.category || entry.item)) {
      var fodderCost = entry.cost_pkr != null ? entry.cost_pkr : entry.amount;
      if (!fodderCost && (entry.quantity == null || entry.quantity === "")) {
        return { ok: true, skipped: true };
      }
      entry = {
        type: "fodder",
        date: entry.date,
        item: fodderItemName_(entry.item || entry.category),
        quantity: entry.quantity == null ? "" : entry.quantity,
        unit: entry.unit || "",
        cost_pkr: fodderCost,
        supplier: entry.supplier || "",
        cash_paid: entry.cash_paid == null || entry.cash_paid === "" ? 0 : entry.cash_paid,
        balance_owed: entry.balance_owed,
        note: entry.note,
      };
      return commitOne_(ss, entry, note);
    }
    var amt = parseAmount_(entry.amount);
    if (!amt) return { ok: true, skipped: true };
    entry.category = canonicalExpense_(entry.category || entry.note);
    if (!entry.category) entry.category = "kharcha";
    var row = append_(ss, "Expenses", [entry.date, entry.category, entry.amount, entry.note || note]);
    setLastWrite_(ss, "Expenses", row, "expense", entry.category + " " + entry.amount);
    return { ok: true, sheet: "Expenses", row: row };
  }
  if (entry.type === "fodder") {
    var row = append_(ss, "Fodder", [
      entry.date,
      entry.item,
      entry.quantity == null ? "" : entry.quantity,
      entry.unit || "",
      entry.cost_pkr,
      entry.supplier || "",
      entry.cash_paid,
      entry.balance_owed,
      entry.note || note,
    ]);
    setLastWrite_(ss, "Fodder", row, "fodder", entry.item + " " + entry.cost_pkr);
    if (entry.quantity != null && entry.quantity !== "") {
      applyStockDelta_(ss, entry.item, Number(entry.quantity) || 0, entry.unit || "", entry.daily_use, "purchase", entry.date);
    }
    return { ok: true, sheet: "Fodder", row: row };
  }
  if (entry.type === "cow" || entry.type === "add_cow" || entry.type === "animals") {
    return addCow_(ss, entry, note);
  }
  if (entry.type === "customer" || entry.type === "add_customer" || entry.type === "customers_onboard") {
    upsertCustomer_(ss, entry.customer || entry.name, entry.phone || "", entry.rate_pkr, entry.opening_balance, entry.billing_cycle, entry.cycle_start_date);
    var cust = values_(ss, "Customers");
    var idx = findRow_(cust, 0, entry.customer || entry.name);
    var row = idx === -1 ? sheet_(ss, "Customers").getLastRow() : idx + 1;
    var custSheet = sheet_(ss, "Customers");
    var notesCol = headerIndex_(cust[0], "notes");
    if (notesCol !== -1) appendNote_(custSheet, row, notesCol + 1, entry.note || note);
    applyCustomerSupply_(custSheet, cust[0], row, entry);
    if (entry.supply_note && notesCol !== -1) {
      var prevNote = String(custSheet.getRange(row, notesCol + 1).getValue() || "");
      if (prevNote.indexOf(entry.supply_note) === -1) appendNote_(custSheet, row, notesCol + 1, entry.supply_note);
    }
    setLastWrite_(ss, "Customers", row, "add_customer", entry.customer || entry.name);
    return { ok: true, sheet: "Customers", row: row };
  }
  if (entry.type === "set_supply") return setSupply_(ss, entry, note);
  if (entry.type === "rename_cow") return renameCow_(ss, entry, note);
  if (entry.type === "remove_cow") return removeCow_(ss, entry, note);
  if (entry.type === "change_rate") return changeRate_(ss, entry, note);
  if (entry.type === "correct_entry") return correctEntry_(ss, entry, note);
  if (entry.type === "delete_last") return deleteLast_(ss, note);
  if (entry.type === "change_billing_cycle") return changeBillingCycle_(ss, entry, note);
  if (entry.type === "animal_event" || entry.type === "vet_visit" || entry.type === "vet_appointment") {
    return appendAnimalEvent_(ss, entry, note);
  }
  if (entry.type === "feed_use") {
    var rowUse = applyStockDelta_(ss, entry.item, -(Number(entry.quantity) || 0), entry.unit || "", entry.daily_use, entry.note || "feed_use", entry.date);
    setLastWrite_(ss, "Feed_Stock", rowUse, "feed_use", (entry.item || "") + " " + (entry.quantity || ""));
    return { ok: true, sheet: "Feed_Stock", row: rowUse };
  }
  if (entry.type === "set_daily_use") {
    var rowDaily = applyStockDelta_(ss, entry.item, 0, entry.unit || "", entry.daily_use, entry.note || "set_daily_use", entry.date);
    setLastWrite_(ss, "Feed_Stock", rowDaily, "set_daily_use", (entry.item || "") + " " + (entry.daily_use || ""));
    return { ok: true, sheet: "Feed_Stock", row: rowDaily };
  }
  if (entry.type === "feed_stock") {
    var rowStock = applyStockDelta_(ss, entry.item, Number(entry.quantity) || 0, entry.unit || "", entry.daily_use, entry.note || "feed_stock", entry.date);
    setLastWrite_(ss, "Feed_Stock", rowStock, "feed_stock", (entry.item || "") + " " + (entry.quantity || ""));
    return { ok: true, sheet: "Feed_Stock", row: rowStock };
  }
  if (entry.type === "setup_committee") return upsertCommittee_(ss, entry, note);
  if (entry.type === "committee_log") return appendCommitteeLog_(ss, entry, note);
  if (entry.type === "profile") return { ok: true };
  return { ok: true, skipped: true };
}

function addCow_(ss, entry, note) {
  var sh = sheet_(ss, "Cows");
  var data = values_(ss, "Cows");
  var header = data[0] || [];
  var name = entry.cow_name || entry.name;
  var nameCol = cowNameCol_(header);
  if (findRow_(data, nameCol, name) !== -1) return { ok: true, already: true };
  var typeCol = headerIndex_(header, "type");
  var breedCol = headerIndex_(header, "breed");
  var statusCol = headerIndex_(header, "status");
  var avgCol = headerIndex_(header, "avg_daily_litres");
  var notesCol = headerIndex_(header, "notes");
  var idCol = headerIndex_(header, "cow_id");
  var rowVals = [];
  for (var c = 0; c < Math.max(header.length, 5); c++) rowVals[c] = "";
  if (idCol !== -1) rowVals[idCol] = nextCowId_(data);
  rowVals[nameCol] = name;
  if (typeCol !== -1) rowVals[typeCol] = normalizeAnimalType_(entry.animal_type || "cow");
  if (breedCol !== -1) rowVals[breedCol] = entry.breed || "";
  if (statusCol !== -1) rowVals[statusCol] = entry.status || "milking";
  if (avgCol !== -1) rowVals[avgCol] = entry.avg_daily_litres == null ? "" : entry.avg_daily_litres;
  if (notesCol !== -1) rowVals[notesCol] = entry.notes || note;
  sh.appendRow(rowVals);
  var row = sh.getLastRow();
  setLastWrite_(ss, "Cows", row, "add_cow", name);
  return { ok: true, sheet: "Cows", row: row };
}

function renameCow_(ss, entry, note) {
  var sh = sheet_(ss, "Cows");
  var data = values_(ss, "Cows");
  var nameCol = cowNameCol_(data[0] || []);
  var idx = findRow_(data, nameCol, entry.cow_name);
  if (idx === -1) return { ok: false, error: "Gay nahi mili: " + entry.cow_name };
  var row = idx + 1;
  var newName = entry.new_name;
  sh.getRange(row, nameCol + 1).setValue(newName);
  var notesCol = headerIndex_(data[0], "notes");
  appendNote_(sh, row, notesCol + 1, "renamed from " + entry.cow_name + " (" + (entry.note || note) + ")");
  var milk = sheet_(ss, "Milk_Log");
  var milkData = milk.getDataRange().getValues();
  for (var i = 1; i < milkData.length; i++) {
    if (String(milkData[i][2] || "").toLowerCase() === String(entry.cow_name).toLowerCase()) {
      milk.getRange(i + 1, 3).setValue(newName);
    }
  }
  setLastWrite_(ss, "Cows", row, "rename_cow", entry.cow_name + " -> " + newName);
  return { ok: true, sheet: "Cows", row: row };
}

function removeCow_(ss, entry, note) {
  var sh = sheet_(ss, "Cows");
  var data = values_(ss, "Cows");
  var idx = findRow_(data, cowNameCol_(data[0] || []), entry.cow_name);
  if (idx === -1) return { ok: false, error: "Gay nahi mili: " + entry.cow_name };
  var row = idx + 1;
  var statusCol = headerIndex_(data[0], "status");
  var notesCol = headerIndex_(data[0], "notes");
  if (statusCol !== -1) sh.getRange(row, statusCol + 1).setValue("removed");
  appendNote_(sh, row, notesCol + 1, "removed (" + (entry.note || note) + ")");
  setLastWrite_(ss, "Cows", row, "remove_cow", entry.cow_name);
  return { ok: true, sheet: "Cows", row: row };
}

function changeRate_(ss, entry, note) {
  var sh = sheet_(ss, "Customers");
  var data = values_(ss, "Customers");
  var idx = findRow_(data, 0, entry.customer);
  if (idx === -1) return { ok: false, error: "Customer nahi mila: " + entry.customer };
  var row = idx + 1;
  var rateIdx = rateCol_(data[0]);
  if (rateIdx === -1) return { ok: false, error: "rate_pkr column missing" };
  var prev = data[idx][rateIdx];
  sh.getRange(row, rateIdx + 1).setValue(entry.rate_pkr);
  var notesCol = headerIndex_(data[0], "notes");
  appendNote_(sh, row, notesCol + 1, "rate " + prev + " -> " + entry.rate_pkr + " (" + (entry.note || note) + ")");
  setLastWrite_(ss, "Customers", row, "change_rate", entry.customer + " " + entry.rate_pkr);
  return { ok: true, sheet: "Customers", row: row };
}

function correctEntry_(ss, entry, note) {
  var tab = entry.sheet || sheetForEntryType_(entry.entry_type || entry.target_type);
  if (!tab) return { ok: false, error: "Kis record ko theek karna hai samajh nahi aaya." };
  var sh = sheet_(ss, tab);
  var data = sh.getDataRange().getValues();
  var found = -1;
  for (var i = 1; i < data.length; i++) {
    if (rowMatchesCorrection_(tab, data[i], entry)) {
      found = i;
      break;
    }
  }
  if (found === -1) return { ok: false, error: "Purana record nahi mila." };
  var row = found + 1;
  var fieldCol = fieldColFor_(tab, entry.field, data[0]);
  if (fieldCol === -1) return { ok: false, error: "Field nahi mili." };
  var oldVal = data[found][fieldCol];
  var newVal = entry.new_value;
  sh.getRange(row, fieldCol + 1).setValue(newVal);
  var noteCol = noteColFor_(tab, data[0]);
  appendNote_(
    sh,
    row,
    noteCol + 1,
    "corrected " + (entry.field || "value") + " " + oldVal + " -> " + newVal + " (" + (entry.note || note) + ")"
  );
  setLastWrite_(ss, tab, row, "correct_entry", tab + " " + oldVal + " -> " + newVal);
  return { ok: true, sheet: tab, row: row };
}

function sheetForEntryType_(type) {
  var t = String(type || "").toLowerCase();
  if (t === "milk") return "Milk_Log";
  if (t === "sale") return "Sales";
  if (t === "payment") return "Payments";
  if (t === "expense") return "Expenses";
  if (t === "fodder") return "Fodder";
  if (t === "committee" || t === "committee_log") return "Committee_Log";
  return "";
}

function fieldColFor_(tab, field, header) {
  var f = String(field || "").toLowerCase();
  if (tab === "Milk_Log") {
    if (f === "litres" || f === "" || f === "amount") return 3;
    if (f === "session") return 1;
    if (f === "cow_name") return 2;
  }
  if (tab === "Sales") {
    if (f === "litres") return 2;
    if (f === "rate_pkr" || f === "rate") return 3;
    if (f === "amount" || f === "") return 4;
    if (f === "cash_received") return 5;
    if (f === "balance_added") return 6;
  }
  if (tab === "Payments" && (f === "amount" || f === "")) return 2;
  if (tab === "Expenses" && (f === "amount" || f === "")) return 2;
  if (tab === "Committee_Log" && (f === "amount" || f === "")) return 3;
  if (tab === "Fodder") {
    if (f === "cost_pkr" || f === "amount" || f === "") return 4;
    if (f === "quantity") return 2;
    if (f === "cash_paid") return 6;
    if (f === "balance_owed") return 7;
  }
  var idx = headerIndex_(header, field);
  return idx;
}

function noteColFor_(tab, header) {
  var idx = headerIndex_(header, "source_note");
  if (idx !== -1) return idx;
  idx = headerIndex_(header, "note");
  if (idx !== -1) return idx;
  if (tab === "Milk_Log") return 4;
  if (tab === "Sales") return 7;
  if (tab === "Expenses") return 3;
  if (tab === "Committee_Log") return 4;
  if (tab === "Fodder") return 8;
  return header.length - 1;
}

function rowMatchesCorrection_(tab, row, entry) {
  if (entry.date && cellDate_(row[0]) !== String(entry.date)) return false;
  if (tab === "Milk_Log") {
    if (entry.cow_name && String(row[2] || "").toLowerCase() !== String(entry.cow_name).toLowerCase()) return false;
    if (entry.session && String(row[1] || "") !== String(entry.session)) return false;
    if (entry.old_value != null && entry.old_value !== "" && parseAmount_(row[3]) !== parseAmount_(entry.old_value)) return false;
    return true;
  }
  if (tab === "Sales" || tab === "Payments") {
    if (entry.customer && String(row[1] || "").toLowerCase() !== String(entry.customer).toLowerCase()) return false;
    if (entry.old_value != null && entry.old_value !== "") {
      var col = tab === "Sales" ? (entry.field === "litres" ? 2 : 4) : 2;
      if (parseAmount_(row[col]) !== parseAmount_(entry.old_value)) return false;
    }
    return true;
  }
  if (tab === "Committee_Log") {
    if (entry.committee && String(row[1] || "").toLowerCase() !== String(entry.committee).toLowerCase()) return false;
    if (entry.old_value != null && entry.old_value !== "" && parseAmount_(row[3]) !== parseAmount_(entry.old_value)) return false;
    return true;
  }
  if (tab === "Expenses" || tab === "Fodder") {
    if (entry.old_value != null && entry.old_value !== "") {
      var amtCol = tab === "Fodder" ? 4 : 2;
      if (parseAmount_(row[amtCol]) !== parseAmount_(entry.old_value)) return false;
    }
    return true;
  }
  return false;
}

function deleteLast_(ss, note) {
  var sh = ss.getSheetByName("Last_Write");
  if (!sh || sh.getLastRow() < 2) return { ok: false, error: "Koi akhri record nahi mila." };
  var info = sh.getRange(2, 1, 1, 5).getValues()[0];
  var tab = String(info[0] || "");
  var row = Number(info[1] || 0);
  if (!tab || !row || row < 2) return { ok: false, error: "Koi akhri record nahi mila." };
  var target = sheet_(ss, tab);
  if (row > target.getLastRow()) return { ok: false, error: "Akhri record pehle hi hat chuka hai." };
  var noteCol = noteColFor_(tab, target.getRange(1, 1, 1, target.getLastColumn()).getValues()[0]);
  appendNote_(target, row, noteCol + 1, "deleted (" + (note || "") + ")");
  target.deleteRow(row);
  sh.getRange(2, 1, 1, 5).clearContent();
  return { ok: true, sheet: tab, row: row, deleted: true };
}

function readRecent_(ss, days, refresh) {
  if (refresh === true) refreshDerived_(ss);
  var cutoff = todayMinus_(days);
  return {
    ok: true,
    cows: values_(ss, "Cows"),
    customers: values_(ss, "Customers"),
    milk: filterDated_(ss, "Milk_Log", 0, cutoff),
    sales: filterDated_(ss, "Sales", 0, cutoff),
    payments: filterDated_(ss, "Payments", 0, cutoff),
    expenses: filterDated_(ss, "Expenses", 0, cutoff),
    fodder: filterDated_(ss, "Fodder", 0, cutoff),
    animal_events: values_(ss, "Animal_Events"),
    feed_stock: values_(ss, "Feed_Stock"),
    due_bills: values_(ss, "Due_Bills"),
    upcoming_events: values_(ss, "Upcoming_Events"),
    committees: values_(ss, "Committees"),
    committee_log: values_(ss, "Committee_Log"),
    committee_status: values_(ss, "Committee_Status"),
  };
}

function filterDated_(ss, name, dateIdx, cutoff) {
  var data = values_(ss, name);
  if (!data.length) return data;
  var out = [data[0]];
  for (var i = 1; i < data.length; i++) {
    if (cellDate_(data[i][dateIdx]) >= cutoff) out.push(data[i]);
  }
  return out;
}
