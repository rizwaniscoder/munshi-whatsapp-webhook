const { GEMINI_MODEL, todayISO, TIMEZONE } = require("./config");
const { routeFodderEntries, normalizeEditEntries } = require("./ledger");

const PARSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    intent: {
      type: "STRING",
      enum: ["record", "query", "confirm", "cancel", "receipt", "edit", "other"],
    },
    language: { type: "STRING" },
    summary: { type: "STRING" },
    reply: { type: "STRING" },
    milk: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          date: { type: "STRING" },
          session: { type: "STRING" },
          cow_name: { type: "STRING" },
          litres: { type: "NUMBER" },
          note: { type: "STRING" },
        },
        required: ["date", "cow_name", "litres"],
      },
    },
    sales: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          date: { type: "STRING" },
          customer: { type: "STRING" },
          litres: { type: "NUMBER" },
          rate_pkr: { type: "NUMBER" },
          amount: { type: "NUMBER" },
          cash_received: { type: "NUMBER" },
          balance_added: { type: "NUMBER" },
          note: { type: "STRING" },
        },
        required: [
          "date",
          "customer",
          "litres",
          "rate_pkr",
          "amount",
          "cash_received",
          "balance_added",
        ],
      },
    },
    payments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          date: { type: "STRING" },
          customer: { type: "STRING" },
          amount: { type: "NUMBER" },
          method: { type: "STRING" },
        },
        required: ["date", "customer", "amount"],
      },
    },
    expenses: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          date: { type: "STRING" },
          category: { type: "STRING" },
          amount: { type: "NUMBER" },
          note: { type: "STRING" },
        },
        required: ["date", "category", "amount"],
      },
    },
    cows: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          cow_name: { type: "STRING" },
          animal_type: { type: "STRING" },
          breed: { type: "STRING" },
          status: { type: "STRING" },
          avg_daily_litres: { type: "NUMBER" },
          notes: { type: "STRING" },
        },
        required: ["cow_name"],
      },
    },
    fodder: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          date: { type: "STRING" },
          item: { type: "STRING" },
          quantity: { type: "NUMBER" },
          unit: { type: "STRING" },
          cost_pkr: { type: "NUMBER" },
          supplier: { type: "STRING" },
          cash_paid: { type: "NUMBER" },
          balance_owed: { type: "NUMBER" },
          note: { type: "STRING" },
        },
        required: ["date", "item", "cost_pkr", "cash_paid", "balance_owed"],
      },
    },
    animal_events: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          date: { type: "STRING" },
          cow_name: { type: "STRING" },
          event_type: { type: "STRING" },
          details: { type: "STRING" },
          doctor_name: { type: "STRING" },
          diagnosis: { type: "STRING" },
          medicines: { type: "STRING" },
          cost_pkr: { type: "NUMBER" },
          fee_pkr: { type: "NUMBER" },
          next_due_date: { type: "STRING" },
          next_appointment_date: { type: "STRING" },
          note: { type: "STRING" },
        },
        required: ["date", "event_type"],
      },
    },
    feed_stock: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          date: { type: "STRING" },
          item: { type: "STRING" },
          quantity: { type: "NUMBER" },
          unit: { type: "STRING" },
          daily_use: { type: "NUMBER" },
          note: { type: "STRING" },
          action: { type: "STRING" },
        },
        required: ["item"],
      },
    },
    receipt_customer: { type: "STRING" },
    period_start: { type: "STRING" },
    period_end: { type: "STRING" },
    edits: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          action: { type: "STRING" },
          cow_name: { type: "STRING" },
          new_name: { type: "STRING" },
          animal_type: { type: "STRING" },
          breed: { type: "STRING" },
          avg_daily_litres: { type: "NUMBER" },
          customer: { type: "STRING" },
          phone: { type: "STRING" },
          rate_pkr: { type: "NUMBER" },
          opening_balance: { type: "NUMBER" },
          billing_cycle: { type: "STRING" },
          cycle_start_date: { type: "STRING" },
          entry_type: { type: "STRING" },
          date: { type: "STRING" },
          session: { type: "STRING" },
          field: { type: "STRING" },
          old_value: { type: "NUMBER" },
          new_value: { type: "NUMBER" },
          note: { type: "STRING" },
        },
        required: ["action"],
      },
    },
  },
  required: ["intent", "language"],
};

function apiKey() {
  const value = (process.env.GEMINI_API_KEY || "").trim();
  if (!value) throw new Error("GEMINI_API_KEY is not set");
  return value;
}

function flattenParsed(parsed, sourceText) {
  const entries = [];
  for (const row of parsed.milk || []) entries.push({ type: "milk", ...row });
  for (const row of parsed.sales || []) entries.push({ type: "sale", ...row });
  for (const row of parsed.payments || []) entries.push({ type: "payment", ...row });
  for (const row of parsed.expenses || []) entries.push({ type: "expense", ...row });
  for (const row of parsed.cows || []) entries.push({ type: "cow", ...row });
  for (const row of parsed.fodder || []) entries.push({ type: "fodder", ...row });
  for (const row of parsed.animal_events || []) {
    entries.push({ type: "animal_event", ...row });
  }
  for (const row of parsed.feed_stock || []) {
    const action = String(row.action || "").toLowerCase();
    const typ = action === "use" || action === "feed_use" ? "feed_use"
      : action === "daily" || action === "set_daily_use" ? "set_daily_use"
      : "feed_stock";
    entries.push({ type: typ, ...row });
  }
  for (const row of parsed.edits || []) {
    entries.push({ type: row.action || "edit", ...row });
  }
  return {
    intent: parsed.intent,
    language: parsed.language || "roman_urdu",
    summary: parsed.summary || "",
    reply: parsed.reply || "",
    receipt_customer: parsed.receipt_customer || "",
    period_start: parsed.period_start || "",
    period_end: parsed.period_end || "",
    entries: normalizeEditEntries(
      routeFodderEntries(entries),
      [parsed.summary || "", parsed.reply || "", sourceText || ""].join(" ")
    ),
    sourceText: sourceText || "",
  };
}

function buildParsePrompt(context) {
  const cows = (context.cows || []).join(", ") || "unknown";
  const customers = (context.customers || []).join(", ") || "unknown";
  return `You are Munshi, a dairy farm bookkeeping assistant.
Today's date is ${todayISO(TIMEZONE)} (${TIMEZONE}).
Known cows: ${cows}.
Known customers: ${customers}.

Fill the JSON schema.
intent is record, query, confirm, cancel, receipt, edit, or other.
- record: the user is logging milk, a sale, a payment, an expense, fodder (chara), an animal health/breeding/vet event, or a feed stock change.
- query: the user is asking a question about the farm or accounts (not asking for a receipt image), including due bills, a customer's period bill, which cows are pregnant, when a cow will dry off or calve, a cow's health history, when the doctor is coming, or when feed will run out.
- confirm: the user is approving a pending record (haan, han, yes, ji, theek hai).
- cancel: the user is rejecting a pending record (nahi, nahin, no).
- receipt: the user wants a customer receipt / parchi / bill image, e.g. "Aslam ki parchi bhejo" or "Aslam ka is mahine ka bill parchi". Set receipt_customer to the customer name. If they name a period, set period_start and period_end (YYYY-MM-DD). If they say "is mahine", use this calendar month. If omitted, the app uses the customer's billing cycle.
- edit: the user wants to add/rename/remove a cow or buffalo, add a customer, change a customer's rate or billing cycle, correct a previous entry, or delete the last entry. Put one or more objects in edits.
- other: greeting, help, or anything else.
Default date is ${todayISO(TIMEZONE)} when the user says aaj/today or omits a date.
Milk: one object per cow, with cow_name (match known names when possible) and litres. If the user says subah, sobah, morning, or am, set session to am. If they say shaam, evening, raat, or pm, set session to pm. If they do not say a time of day, leave session empty; the app will default it from the clock.
Sale: amount = litres * rate_pkr. balance_added = amount - cash_received. If cash omitted, cash_received=0 and balance_added=amount. If paid in full, cash_received=amount and balance_added=0.
Payment: customer, amount, method if stated (cash, JazzCash, bank transfer, etc.).
Expense: category (labour, vet, fuel, other), amount, note if stated. Never put fodder or animal-feed purchases in expenses. Medicine or vet fees that belong with an animal_event should be on that event as cost_pkr or fee_pkr; the app will also write the expense once.
Fodder: use this for chara, green fodder, wanda, bhoosa, silage, khal, or other animal feed purchases. item should be one of: chara, wanda, bhoosa, silage, khal, other (use chara for green fodder / hara chara). quantity and unit if stated (unit is kg, mann, gathri, or bag; 1 mann = 40 kg). cost_pkr is the total cost. supplier if named. cash_paid is what was paid now; balance_owed = cost_pkr - cash_paid. If cash omitted, cash_paid=0 and balance_owed=cost_pkr. If paid in full, cash_paid=cost_pkr and balance_owed=0. Example: "aaj 2 mann wanda liya 6000 ka, 4000 diye" is one fodder row: item wanda, quantity 2, unit mann, cost_pkr 6000, cash_paid 4000, balance_owed 2000. A fodder purchase also increases feed stock.
Animal events: use animal_events for breeding and health. event_type is one of: insemination, natural_service, pregnancy_check, calving, dry_off, heat, vaccination, treatment, vet_appointment, vet_visit, other. Examples: "Gori ko aaj teeka/injection laga" is vaccination or treatment; "Kali ka check karaya, gaban hai" is pregnancy_check with details "gaban hai"; "Gori ne bachha diya" is calving; "Doctor sahab kal Kali ko dekhne aayenge" is vet_appointment (date = tomorrow, cow Kali, doctor if named); "Doctor ne Gori ko bukhar bataya, 3 din injection" is vet_visit with diagnosis and medicines. Set cost_pkr or fee_pkr if a fee or medicine cost is stated. Set next_due_date or next_appointment_date when a follow-up is given. cow_name can be "all" if the visit is for the whole farm. A prescription photo plus caption is also an animal_event when readable.
Feed stock: use feed_stock for inventory that is not a purchase (purchases go in fodder). action is "use" when they fed or used stock ("wanda 2 mann khila diya"), "daily" when they set daily use ("roz 1 mann wanda khapta hai"), or "add" when they only adjust stock on hand. item, quantity, unit, daily_use as stated.
Do not use record+cows for add/rename/remove; those are intent=edit.
Edit actions:
- add_cow: cow_name, animal_type (cow or buffalo), avg_daily_litres if stated, breed if stated.
- rename_cow: cow_name (old) and new_name.
- remove_cow: cow_name.
- add_customer: customer, rate_pkr if stated, opening_balance if stated, phone if stated, billing_cycle if stated (daily, weekly, biweekly, monthly).
- change_rate: customer, rate_pkr.
- change_billing_cycle: customer, billing_cycle must be exactly one of: daily, weekly, biweekly, monthly. Map roz/rozana/daily = daily, hafta/hafte/weekly = weekly, 15 din/pandrah/biweekly = biweekly, mahina/mahine baad/monthly = monthly. Example: "aslam monthly" or "Aslam ab mahine baad paise dega" has billing_cycle "monthly". Never put the cycle in unit or any other field. unit is only for fodder/feed quantity units (kg, mann, gathri, bag).
- correct_entry: entry_type (milk, sale, payment, expense, fodder), date (kal = yesterday, aaj = today), cow_name or customer, field (litres, amount, ...), and numeric old_value and new_value (required). Example: "kal ka Gori ka doodh 18 nahi 16 tha" is milk, yesterday, Gori, field litres, old_value 18, new_value 16.
- delete_last: no other fields. Use when they want the most recently saved record removed.
Receipt: reply may be empty. receipt_customer is required for intent=receipt.
summary: short confirmation in the user's language (Roman Urdu if mixed or unclear). No em dashes.
reply: only for intent=other, a short helpful message in the user's language. No em dashes.`;
}

async function generateJson({ parts, schema, model }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || GEMINI_MODEL}:generateContent`;
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0,
    },
  });
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey(),
          "Content-Type": "application/json",
        },
        body,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 400)}`);
        if (res.status >= 500 || res.status === 429) throw err;
        throw err;
      }
      const data = JSON.parse(text);
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) throw new Error("Gemini returned no text");
      return JSON.parse(raw);
    } catch (err) {
      lastErr = err;
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|429|HTTP 5/i.test(err.message || "");
      if (!transient || attempt === 3) throw err;
      console.error("gemini retry", attempt, err.message);
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw lastErr;
}


function normalizeImageMime(mime) {
  const raw = String(mime || "image/jpeg").split(";")[0].trim().toLowerCase();
  if (raw === "image/jpg") return "image/jpeg";
  if (raw.startsWith("image/")) return raw;
  return "image/jpeg";
}

function appendMediaParts(parts, { text, audio, image }) {
  if (image?.buffer) {
    parts.push({
      text: "The next part is a photo from the farmer. It may be a handwritten khata or register page, a fodder or feed bill, a receipt, or a note. Read the image yourself and extract every bookkeeping fact you can. Writing may be Urdu, Punjabi, English, or Roman Urdu. Do not invent numbers you cannot read. If the image is unreadable or has no farm records, leave entry arrays empty and set intent to other.",
    });
    if (text) {
      parts.push({ text: `The farmer also sent this caption or note:\n${text}` });
    }
    parts.push({
      inlineData: {
        mimeType: normalizeImageMime(image.mimeType),
        data: image.buffer.toString("base64"),
      },
    });
    return;
  }
  if (audio?.buffer) {
    parts.push({
      text: "The next part is a voice note from the farmer. Transcribe it yourself and parse it. The spoken language may be Urdu, Punjabi, English, or Roman Urdu.",
    });
    const mime = (audio.mimeType || "audio/ogg").split(";")[0].trim();
    parts.push({
      inlineData: {
        mimeType: mime,
        data: audio.buffer.toString("base64"),
      },
    });
    return;
  }
  parts.push({ text: `User message:\n${text || ""}` });
}

async function parseUserMessage({ text, audio, image, context }) {
  const parts = [{ text: buildParsePrompt(context || {}) }];
  appendMediaParts(parts, { text, audio, image });
  const parsed = await generateJson({ parts, schema: PARSE_SCHEMA });
  return flattenParsed(parsed, text || "");
}

async function answerQuery({ question, data }) {
  const schema = {
    type: "OBJECT",
    properties: {
      reply: { type: "STRING" },
    },
    required: ["reply"],
  };
  const prompt = `You are Munshi, a dairy farm bookkeeping assistant.
Today's date is ${todayISO(TIMEZONE)} (${TIMEZONE}).
Answer the farmer's question using only the ledger data below. Be concise. Reply in the farmer's language (Roman Urdu if mixed or unclear). No em dashes. If the data is not enough, say so briefly. Do not invent numbers.
Fodder (chara, wanda, bhoosa, silage, khal) is in the Fodder section, not Expenses. For questions like "is mahine chare pe kitna kharcha hua?", sum Fodder cost_pkr for the requested period.
Also use Animal_Events, Feed_Stock, Due_Bills, Upcoming_Events, and customer billing_cycle / cycle_start_date when present. For "kis ka bill due hai" use Due_Bills or unpaid cycle balances. For "Aslam ka is mahine ka bill" give litres, amount, payments, and balance due. For "kaun si gaye gaban hai" use pregnancy_status. For dry-off or calving dates use Cows derived columns or Upcoming_Events. For "doctor kab aayega" use upcoming vet_appointment. For a cow's health history list that cow's Animal_Events. For feed runout use Feed_Stock quantity / daily_use.

Ledger data (last 30 days plus cow and customer lists):
${data}

Farmer question:
${question}`;
  const parsed = await generateJson({
    parts: [{ text: prompt }],
    schema,
  });
  return parsed.reply;
}

const ONBOARD_SCHEMAS = {
  profile: {
    type: "OBJECT",
    properties: {
      name: { type: "STRING" },
      farm_name: { type: "STRING" },
    },
    required: ["name", "farm_name"],
  },
  animals: {
    type: "OBJECT",
    properties: {
      animals: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" },
            animal_type: { type: "STRING" },
            avg_daily_litres: { type: "NUMBER" },
            breed: { type: "STRING" },
          },
          required: ["name", "animal_type"],
        },
      },
    },
    required: ["animals"],
  },
  customers: {
    type: "OBJECT",
    properties: {
      skip: { type: "BOOLEAN" },
      customers: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" },
            rate_pkr: { type: "NUMBER" },
            opening_balance: { type: "NUMBER" },
            phone: { type: "STRING" },
            billing_cycle: { type: "STRING" },
          },
          required: ["name"],
        },
      },
    },
    required: ["skip"],
  },
};

function onboardPrompt(step) {
  const today = todayISO(TIMEZONE);
  if (step === "profile") {
    return `Extract the person's name and farm name from this message. Today's date is ${today}. Reply JSON only. Use Roman Urdu/English names as written. animal types are not needed.`;
  }
  if (step === "animals") {
    return `Extract every animal mentioned. Today's date is ${today}.
animal_type must be cow or buffalo (gay/gai/gaaye = cow, bhains/buffalo = buffalo).
avg_daily_litres is their usual daily milk if stated. name is the animal's name.`;
  }
  return `Extract customers. Today's date is ${today}.
skip=true if they want to skip or have no customers.
Otherwise skip=false and list customers with name, rate_pkr (price per litre), opening_balance (udhaar, default 0), phone if given, and billing_cycle if given (daily, weekly, biweekly, or monthly). roz/rozana = daily, hafte/hafta = weekly, 15 din/pandrah = biweekly, mahine/mahina = monthly. If cycle is not said, leave billing_cycle empty (the app defaults to daily).`;
}

async function parseOnboarding(step, { text, audio, image }) {
  const parts = [{ text: onboardPrompt(step) }];
  appendMediaParts(parts, { text, audio, image });
  return generateJson({ parts, schema: ONBOARD_SCHEMAS[step] });
}


const PENDING_EDIT_SCHEMA = {
  type: "OBJECT",
  properties: {
    applied: { type: "BOOLEAN" },
    summary: { type: "STRING" },
    entries: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING" },
          date: { type: "STRING" },
          session: { type: "STRING" },
          cow_name: { type: "STRING" },
          name: { type: "STRING" },
          farm_name: { type: "STRING" },
          litres: { type: "NUMBER" },
          customer: { type: "STRING" },
          rate_pkr: { type: "NUMBER" },
          amount: { type: "NUMBER" },
          cash_received: { type: "NUMBER" },
          balance_added: { type: "NUMBER" },
          opening_balance: { type: "NUMBER" },
          phone: { type: "STRING" },
          billing_cycle: { type: "STRING" },
          cycle_start_date: { type: "STRING" },
          category: { type: "STRING" },
          item: { type: "STRING" },
          quantity: { type: "NUMBER" },
          unit: { type: "STRING" },
          cost_pkr: { type: "NUMBER" },
          cash_paid: { type: "NUMBER" },
          balance_owed: { type: "NUMBER" },
          supplier: { type: "STRING" },
          animal_type: { type: "STRING" },
          avg_daily_litres: { type: "NUMBER" },
          new_name: { type: "STRING" },
          action: { type: "STRING" },
          entry_type: { type: "STRING" },
          field: { type: "STRING" },
          old_value: { type: "NUMBER" },
          new_value: { type: "NUMBER" },
          note: { type: "STRING" },
        },
      },
    },
  },
  required: ["applied", "entries"],
};

function isBlank(value) {
  return value == null || value === "";
}

function mergePendingEntries(original, updated) {
  const src = Array.isArray(original) ? original : [];
  const next = Array.isArray(updated) && updated.length ? updated : src;
  const length = Math.max(src.length, next.length);
  const out = [];
  for (let i = 0; i < length; i++) {
    const base = src[i] || src[0] || {};
    const patch = next[i] || {};
    const merged = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (!isBlank(value)) merged[key] = value;
    }
    if ((merged.type || base.type) === "profile") {
      merged.type = "profile";
      merged.name = merged.name || base.name || "";
      merged.farm_name = merged.farm_name || merged.farmName || patch.farm || base.farm_name || "";
    }
    out.push(merged);
  }
  return out;
}

function applyProfileTextHints(entries, text) {
  const s = String(text || "").trim();
  if (!s) return entries;
  const farmMatch = s.match(/farm(?:\s+ka)?\s+naam\s+(.+?)(?:\s+hai)?$/i);
  const nameMatch = s.match(/(?:mera\s+)?naam\s+(.+?)(?:\s+hai)?$/i);
  return (entries || []).map((entry) => {
    if (entry.type !== "profile") return entry;
    const next = { ...entry };
    if (farmMatch) next.farm_name = farmMatch[1].replace(/[?.!,]+$/g, "").trim();
    if (nameMatch && !/^farm\b/i.test(nameMatch[1]) && !/farm\s+ka\s+naam/i.test(s)) {
      next.name = nameMatch[1].replace(/[?.!,]+$/g, "").trim();
    }
    return next;
  });
}

function applyCycleTextHints(entries, text) {
  const { inferCycleFromText } = require("./billing");
  const cycle = inferCycleFromText(text);
  if (!cycle) return entries;
  return (entries || []).map((entry) => {
    if (entry.type === "change_billing_cycle" || entry.type === "add_customer" || entry.type === "customer") {
      return { ...entry, billing_cycle: cycle };
    }
    return entry;
  });
}

async function applyPendingEdit({ entries, text, audio, image }) {
  const parts = [
    {
      text: `You are updating a pending Munshi bookkeeping confirmation.
Today's date is ${todayISO(TIMEZONE)} (${TIMEZONE}).
Here are the current pending entries as JSON:
${JSON.stringify(entries || [], null, 2)}

The farmer asked to change something. Apply only the requested change.
Copy every field from the current entries. Do not drop name, farm_name, litres, customer, billing_cycle, or type.
Only change the fields the user asked to change.
If they change a billing cycle, set billing_cycle to exactly daily, weekly, biweekly, or monthly (monthly/mahina/mahine baad = monthly, weekly/hafta = weekly, 15 din = biweekly, roz/daily = daily). Do not put the cycle in unit.
If the request is unclear, set applied=false and return the original entries.
Return the full updated entries array. Reply in Roman Urdu for summary. No em dashes.`,
    },
  ];
  appendMediaParts(parts, { text, audio, image });
  const parsed = await generateJson({ parts, schema: PENDING_EDIT_SCHEMA });
  let next = mergePendingEntries(entries, parsed.entries);
  next = applyProfileTextHints(next, text);
  next = applyCycleTextHints(next, text);
  const changed = JSON.stringify(next) !== JSON.stringify(entries || []);
  return {
    applied: Boolean(parsed.applied) || changed,
    summary: parsed.summary || "",
    entries: next,
  };
}

module.exports = {
  parseUserMessage,
  answerQuery,
  flattenParsed,
  parseOnboarding,
  applyPendingEdit,
  mergePendingEntries,
  applyCycleTextHints,
};
