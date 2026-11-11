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
 */
var DEFAULT_SHEET_ID = "1sIDMkUs76cgl8ecBGIOWFIPiofGzwGJI1D3Az6OyDW8";

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

function ledgerSs_(body) {
  body = body || {};
  if (body.sheetId) return SpreadsheetApp.openById(body.sheetId);
  if (body.sender) {
    var farmer = findFarmerRow_(normalizePhone_(body.sender));
    if (farmer && farmer.sheetId) return SpreadsheetApp.openById(farmer.sheetId);
  }
  return masterSs_();
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

function upsertCustomer_(ss, name, phone, rate, opening) {
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
  var action = body.action;
  if (action === "ping") return { ok: true, multiTenant: true };
  if (action === "getFarmer") return getFarmer_(body.phone || body.sender);
  if (action === "upsertFarmer") return upsertFarmer_(body);
  if (action === "copyLedger") return copyLedger_(body);
  if (action === "listFarmers") return listFarmers_();
  if (action === "isProcessed") return isProcessed_(body.messageId);
  if (action === "markProcessed") return markProcessed_(body.messageId, body.sender);
  if (action === "setPending") return setPending_(body);
  if (action === "getPending") return getPending_(body.sender);
  if (action === "clearPending") return clearPending_(body.sender, body.status);
  var ss = ledgerSs_(body);
  if (action === "getContext") return getContext_(ss);
  if (action === "commitRecords") return commitRecords_(ss, body);
  if (action === "readRecent") return readRecent_(ss, body.days || 30);
  return { ok: false, error: "unknown action" };
}

function farmersData_() {
  var ss = masterSs_();
  var sh = ss.getSheetByName("Farmers");
  if (!sh) return { sh: null, data: [["phone", "sheet_id", "name", "farm_name", "onboarding_state", "allowed", "created_at"]] };
  return { sh: sh, data: sh.getDataRange().getValues() };
}

function findFarmerRow_(phone) {
  phone = normalizePhone_(phone);
  var pack = farmersData_();
  var data = pack.data;
  var header = data[0] || [];
  var phoneCol = Math.max(0, headerIndex_(header, "phone"));
  var idx = findRow_(data, phoneCol, phone);
  if (idx === -1) return null;
  var row = data[idx];
  return {
    index: idx,
    row: idx + 1,
    phone: normalizePhone_(row[0]),
    sheetId: String(row[1] || ""),
    name: String(row[2] || ""),
    farmName: String(row[3] || ""),
    onboardingState: String(row[4] || ""),
    allowed: isAllowedFlag_(row[5]),
    createdAt: String(row[6] || ""),
  };
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
  };
}

function getFarmer_(phone) {
  return { ok: true, farmer: farmerJson_(findFarmerRow_(phone)) };
}

function listFarmers_() {
  var pack = farmersData_();
  var out = [];
  for (var i = 1; i < pack.data.length; i++) {
    var row = pack.data[i];
    if (!row[0]) continue;
    out.push({
      phone: normalizePhone_(row[0]),
      sheetId: String(row[1] || ""),
      name: String(row[2] || ""),
      farmName: String(row[3] || ""),
      onboardingState: String(row[4] || ""),
      allowed: isAllowedFlag_(row[5]),
      createdAt: String(row[6] || ""),
    });
  }
  return { ok: true, farmers: out };
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
  var tabs = ["Milk_Log", "Sales", "Payments", "Expenses", "Fodder", "Pending", "Processed_Ids", "Last_Write", "Cows", "Customers"];
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
  return { ok: true, sheetId: copy.getId(), url: copy.getUrl() };
}

function getContext_(ss) {
  var cows = [];
  var cowRows = values_(ss, "Cows");
  var typeCol = headerIndex_(cowRows[0] || [], "type");
  for (var i = 1; i < cowRows.length; i++) {
    if (cowRows[i][1] && String(cowRows[i][headerIndex_(cowRows[0], "status") === -1 ? 3 : headerIndex_(cowRows[0], "status")] || "").toLowerCase() !== "removed") {
      cows.push(String(cowRows[i][1]));
    }
  }
  var customers = [];
  var custRows = values_(ss, "Customers");
  for (var j = 1; j < custRows.length; j++) {
    if (custRows[j][0]) customers.push(String(custRows[j][0]));
  }
  return { ok: true, cows: cows, customers: customers };
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

function setPending_(body) {
  var ss = masterSs_();
  var sh = sheet_(ss, "Pending");
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(body.sender) && String(data[i][4]) === "pending") {
      sh.getRange(i + 1, 5).setValue("superseded");
    }
  }
  append_(ss, "Pending", [
    body.sender,
    nowStamp_(),
    body.language || "roman_urdu",
    JSON.stringify(body.entries || []),
    "pending",
    body.messageId || "",
  ]);
  return { ok: true };
}

function getPending_(sender) {
  var data = values_(masterSs_(), "Pending");
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === String(sender) && String(data[i][4]) === "pending") {
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
    if (String(data[i][0]) === String(sender) && String(data[i][4]) === "pending") {
      sh.getRange(i + 1, 5).setValue(status || "cancelled");
    }
  }
  return { ok: true };
}

function isFodderCategory_(category) {
  var c = String(category || "").toLowerCase();
  return /(chara|chaara|charay|wanda|bhoosa|toori|silage|khal|fodder|^feed$|green fodder|hara chara)/.test(c);
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

function commitRecords_(ss, body) {
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
      return { ok: false, error: result.error, saved: saved };
    }
  }
  clearPending_(body.sender, "saved");
  return { ok: true, saved: saved, lastWrite: last || null };
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
    return { ok: true, sheet: "Fodder", row: row };
  }
  if (entry.type === "cow" || entry.type === "add_cow" || entry.type === "animals") {
    return addCow_(ss, entry, note);
  }
  if (entry.type === "customer" || entry.type === "add_customer" || entry.type === "customers_onboard") {
    upsertCustomer_(ss, entry.customer || entry.name, entry.phone || "", entry.rate_pkr, entry.opening_balance);
    var cust = values_(ss, "Customers");
    var idx = findRow_(cust, 0, entry.customer || entry.name);
    var row = idx === -1 ? sheet_(ss, "Customers").getLastRow() : idx + 1;
    var notesCol = headerIndex_(cust[0], "notes");
    if (notesCol !== -1) appendNote_(sheet_(ss, "Customers"), row, notesCol + 1, entry.note || note);
    setLastWrite_(ss, "Customers", row, "add_customer", entry.customer || entry.name);
    return { ok: true, sheet: "Customers", row: row };
  }
  if (entry.type === "rename_cow") return renameCow_(ss, entry, note);
  if (entry.type === "remove_cow") return removeCow_(ss, entry, note);
  if (entry.type === "change_rate") return changeRate_(ss, entry, note);
  if (entry.type === "correct_entry") return correctEntry_(ss, entry, note);
  if (entry.type === "delete_last") return deleteLast_(ss, note);
  if (entry.type === "profile") return { ok: true };
  return { ok: true, skipped: true };
}

function addCow_(ss, entry, note) {
  var sh = sheet_(ss, "Cows");
  var data = values_(ss, "Cows");
  var header = data[0] || [];
  var name = entry.cow_name || entry.name;
  if (findRow_(data, 1, name) !== -1) return { ok: true, already: true };
  var typeCol = headerIndex_(header, "type");
  var breedCol = headerIndex_(header, "breed");
  var statusCol = headerIndex_(header, "status");
  var avgCol = headerIndex_(header, "avg_daily_litres");
  var notesCol = headerIndex_(header, "notes");
  var rowVals = [];
  for (var c = 0; c < Math.max(header.length, 5); c++) rowVals[c] = "";
  rowVals[0] = nextCowId_(data);
  rowVals[1] = name;
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
  var idx = findRow_(data, 1, entry.cow_name);
  if (idx === -1) return { ok: false, error: "Gay nahi mili: " + entry.cow_name };
  var row = idx + 1;
  var newName = entry.new_name;
  sh.getRange(row, 2).setValue(newName);
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
  var idx = findRow_(data, 1, entry.cow_name);
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

function readRecent_(ss, days) {
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
