const { GEMINI_MODEL, todayISO, TIMEZONE } = require("./config");
const { routeFodderEntries } = require("./ledger");

const PARSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    intent: {
      type: "STRING",
      enum: ["record", "query", "confirm", "cancel", "other"],
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
          breed: { type: "STRING" },
          status: { type: "STRING" },
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
  },
  required: ["intent", "language"],
};

function apiKey() {
  const value = (process.env.GEMINI_API_KEY || "").trim();
  if (!value) throw new Error("GEMINI_API_KEY is not set");
  return value;
}

function flattenParsed(parsed) {
  const entries = [];
  for (const row of parsed.milk || []) entries.push({ type: "milk", ...row });
  for (const row of parsed.sales || []) entries.push({ type: "sale", ...row });
  for (const row of parsed.payments || []) entries.push({ type: "payment", ...row });
  for (const row of parsed.expenses || []) entries.push({ type: "expense", ...row });
  for (const row of parsed.cows || []) entries.push({ type: "cow", ...row });
  for (const row of parsed.fodder || []) entries.push({ type: "fodder", ...row });
  return {
    intent: parsed.intent,
    language: parsed.language || "roman_urdu",
    summary: parsed.summary || "",
    reply: parsed.reply || "",
    entries: routeFodderEntries(entries),
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
intent is record, query, confirm, cancel, or other.
- record: the user is logging milk, a sale, a payment, an expense, fodder (chara), or a new cow.
- query: the user is asking a question about the farm or accounts.
- confirm: the user is approving a pending record (haan, han, yes, ji, theek hai).
- cancel: the user is rejecting a pending record (nahi, nahin, no).
- other: greeting, help, or anything else.
Default date is ${todayISO(TIMEZONE)} when the user says aaj/today or omits a date.
Milk: one object per cow, with cow_name (match known names when possible) and litres. If the user says subah, sobah, morning, or am, set session to am. If they say shaam, evening, raat, or pm, set session to pm. If they do not say a time of day, leave session empty; the app will default it from the clock.
Sale: amount = litres * rate_pkr. balance_added = amount - cash_received. If cash omitted, cash_received=0 and balance_added=amount. If paid in full, cash_received=amount and balance_added=0.
Payment: customer, amount, method if stated (cash, JazzCash, bank transfer, etc.).
Expense: category (labour, vet, fuel, other), amount, note if stated. Never put fodder or animal-feed purchases in expenses.
Fodder: use this for chara, green fodder, wanda, bhoosa, silage, khal, or other animal feed. item should be one of: chara, wanda, bhoosa, silage, khal, other (use chara for green fodder / hara chara). quantity and unit if stated (unit is kg, mann, gathri, or bag; 1 mann = 40 kg). cost_pkr is the total cost. supplier if named. cash_paid is what was paid now; balance_owed = cost_pkr - cash_paid. If cash omitted, cash_paid=0 and balance_owed=cost_pkr. If paid in full, cash_paid=cost_pkr and balance_owed=0. Example: "aaj 2 mann wanda liya 6000 ka, 4000 diye" is one fodder row: item wanda, quantity 2, unit mann, cost_pkr 6000, cash_paid 4000, balance_owed 2000.
Cow: only when registering a new cow.
summary: short confirmation in the user's language (Roman Urdu if mixed or unclear). No em dashes.
reply: only for intent=other, a short helpful message in the user's language. No em dashes.`;
}

async function generateJson({ parts, schema, model }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0,
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = JSON.parse(text);
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error("Gemini returned no text");
  return JSON.parse(raw);
}

async function parseUserMessage({ text, audio, context }) {
  const parts = [{ text: buildParsePrompt(context || {}) }];
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
  } else {
    parts.push({ text: `User message:\n${text || ""}` });
  }
  const parsed = await generateJson({ parts, schema: PARSE_SCHEMA });
  return flattenParsed(parsed);
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

module.exports = {
  parseUserMessage,
  answerQuery,
  flattenParsed,
};
