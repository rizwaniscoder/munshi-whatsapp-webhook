/**
 * Munshi ledger gateway. Bind this script to the Munshi Dairy Farm Ledger
 * spreadsheet (or set SPREADSHEET_ID in Script Properties).
 *
 * Script Properties:
 *   SHEETS_SECRET   required shared secret, also set on the Render service
 *   SPREADSHEET_ID  optional, defaults to the bound spreadsheet
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

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  try {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (err) {}
  return SpreadsheetApp.openById(id || DEFAULT_SHEET_ID);
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error("Missing tab: " + name);
  return sh;
}

function values_(name) {
  var data = sheet_(name).getDataRange().getValues();
  return data && data.length ? data : [[]];
}

function append_(name, row) {
  sheet_(name).appendRow(row);
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

function cellDate_(value) {
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value)) {
    return Utilities.formatDate(value, "Asia/Karachi", "yyyy-MM-dd");
  }
  return String(value || "");
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

function upsertCustomer_(name, phone, delta) {
  var sh = sheet_("Customers");
  var data = sh.getDataRange().getValues();
  var idx = findRow_(data, 0, name);
  if (idx === -1) {
    sh.appendRow([name, phone || "", 0, delta || 0]);
    return;
  }
  var row = idx + 1;
  if (phone) sh.getRange(row, 2).setValue(phone);
  var current = parseAmount_(data[idx][3]) + (delta || 0);
  sh.getRange(row, 4).setValue(current);
}

function handle_(body) {
  var action = body.action;
  if (action === "ping") return { ok: true };
  if (action === "getContext") return getContext_();
  if (action === "isProcessed") return isProcessed_(body.messageId);
  if (action === "markProcessed") return markProcessed_(body.messageId, body.sender);
  if (action === "setPending") return setPending_(body);
  if (action === "getPending") return getPending_(body.sender);
  if (action === "clearPending") return clearPending_(body.sender, body.status);
  if (action === "commitRecords") return commitRecords_(body);
  if (action === "readRecent") return readRecent_(body.days || 30);
  return { ok: false, error: "unknown action" };
}

function getContext_() {
  var cows = [];
  var cowRows = values_("Cows");
  for (var i = 1; i < cowRows.length; i++) {
    if (cowRows[i][1]) cows.push(String(cowRows[i][1]));
  }
  var customers = [];
  var custRows = values_("Customers");
  for (var j = 1; j < custRows.length; j++) {
    if (custRows[j][0]) customers.push(String(custRows[j][0]));
  }
  return { ok: true, cows: cows, customers: customers };
}

function isProcessed_(messageId) {
  var rows = values_("Processed_Ids");
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(messageId)) return { ok: true, processed: true };
  }
  return { ok: true, processed: false };
}

function markProcessed_(messageId, sender) {
  var already = isProcessed_(messageId);
  if (already.processed) return { ok: true, already: true };
  append_("Processed_Ids", [
    messageId,
    Utilities.formatDate(new Date(), "Asia/Karachi", "yyyy-MM-dd'T'HH:mm:ss"),
    sender || "",
  ]);
  return { ok: true };
}

function setPending_(body) {
  var sh = sheet_("Pending");
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(body.sender) && String(data[i][4]) === "pending") {
      sh.getRange(i + 1, 5).setValue("superseded");
    }
  }
  append_("Pending", [
    body.sender,
    Utilities.formatDate(new Date(), "Asia/Karachi", "yyyy-MM-dd'T'HH:mm:ss"),
    body.language || "roman_urdu",
    JSON.stringify(body.entries || []),
    "pending",
    body.messageId || "",
  ]);
  return { ok: true };
}

function getPending_(sender) {
  var data = values_("Pending");
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
  var sh = sheet_("Pending");
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(sender) && String(data[i][4]) === "pending") {
      sh.getRange(i + 1, 5).setValue(status || "cancelled");
    }
  }
  return { ok: true };
}

function commitRecords_(body) {
  var entries = body.entries || [];
  var note = body.sourceNote || ("WhatsApp " + (body.sender || ""));
  var cows = values_("Cows");
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (entry.type === "milk") {
      append_("Milk_Log", [
        entry.date,
        entry.session || "",
        entry.cow_name,
        entry.litres,
        entry.note || note,
      ]);
    } else if (entry.type === "sale") {
      append_("Sales", [
        entry.date,
        entry.customer,
        entry.litres,
        entry.rate_pkr,
        entry.amount,
        entry.cash_received,
        entry.balance_added,
        entry.note || note,
      ]);
      upsertCustomer_(entry.customer, "", parseAmount_(entry.balance_added));
    } else if (entry.type === "payment") {
      append_("Payments", [
        entry.date,
        entry.customer,
        entry.amount,
        entry.method || "",
      ]);
      upsertCustomer_(entry.customer, "", -parseAmount_(entry.amount));
    } else if (entry.type === "expense") {
      append_("Expenses", [entry.date, entry.category, entry.amount, entry.note || note]);
    } else if (entry.type === "cow") {
      if (findRow_(cows, 1, entry.cow_name) === -1) {
        var id = nextCowId_(cows);
        append_("Cows", [
          id,
          entry.cow_name,
          entry.breed || "",
          entry.status || "milking",
          entry.notes || note,
        ]);
        cows.push([id, entry.cow_name]);
      }
    }
  }
  clearPending_(body.sender, "saved");
  return { ok: true, saved: entries.length };
}

function readRecent_(days) {
  var cutoff = todayMinus_(days);
  return {
    ok: true,
    cows: values_("Cows"),
    customers: values_("Customers"),
    milk: filterDated_("Milk_Log", 0, cutoff),
    sales: filterDated_("Sales", 0, cutoff),
    payments: filterDated_("Payments", 0, cutoff),
    expenses: filterDated_("Expenses", 0, cutoff),
  };
}

function filterDated_(name, dateIdx, cutoff) {
  var data = values_(name);
  if (!data.length) return data;
  var out = [data[0]];
  for (var i = 1; i < data.length; i++) {
    if (cellDate_(data[i][dateIdx]) >= cutoff) out.push(data[i]);
  }
  return out;
}
