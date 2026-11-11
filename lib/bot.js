const { normalizePhone } = require("./config");
const { parseUserMessage, answerQuery, parseOnboarding } = require("./gemini");
const { sendText, sendConfirmButtons, downloadMedia, sendImage } = require("./whatsapp");
const { formatLedgerData } = require("./sheets");
const { applyMilkSessions } = require("./session");
const {
  confirmationText,
  savedText,
  isYesText,
  isNoText,
  isDeleteRequest,
  routeFodderEntries,
  normalizeEditEntries,
} = require("./ledger");
const {
  ASK_PROFILE,
  ASK_ANIMALS,
  ASK_CUSTOMERS,
  INVITE_MESSAGE,
  howToMessage,
  isSkipText,
  resolveAccess,
  profileLines,
  animalLines,
  customerOnboardLines,
} = require("./onboarding");
const { buildReceiptData, renderReceiptPng } = require("./receipt");

const processedMemory = new Set();

function extractMessages(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      for (const message of change.value?.messages || []) {
        const contact = (change.value.contacts || [])[0];
        out.push({
          message,
          contactName: contact?.profile?.name || "",
          waId: message.from || contact?.wa_id || "",
        });
      }
    }
  }
  return out;
}

function scope(farmer, sender) {
  return { sender, sheetId: farmer?.sheetId || undefined };
}

async function alreadyProcessed(sheets, messageId) {
  if (!messageId) return false;
  if (processedMemory.has(messageId)) return true;
  try {
    const result = await sheets.isProcessed(messageId);
    if (result.processed) {
      processedMemory.add(messageId);
      return true;
    }
  } catch (err) {
    console.error("isProcessed failed", err.message);
  }
  return false;
}

async function markProcessed(sheets, messageId, sender) {
  if (!messageId) return;
  processedMemory.add(messageId);
  try {
    await sheets.markProcessed(messageId, sender);
  } catch (err) {
    console.error("markProcessed failed", err.message);
  }
}

async function safeSend(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error("outbound whatsapp error", err.message);
    return null;
  }
}

async function askConfirm(to, body) {
  const sent = await safeSend(() => sendConfirmButtons(to, body));
  if (!sent) {
    await safeSend(() => sendText(to, `${body}\n\nJawab mein Haan ya Nahi likh dein.`));
  }
}

async function handleConfirm(sheets, to, yes, farmer) {
  const found = await sheets.getPending(to);
  const pending = found.pending;
  if (!pending || !pending.entries?.length) {
    await safeSend(() =>
      sendText(to, "Koi pending record nahi hai. Apna hisab bhej dein.")
    );
    return;
  }
  const kind = pending.entries[0].type;
  if (!yes) {
    await sheets.clearPending(to, "cancelled");
    await safeSend(() =>
      sendText(to, "Theek hai, yeh record nahi likha. Dobara bhej dein.")
    );
    return;
  }

  if (kind === "profile") {
    const entry = pending.entries[0];
    try {
      await sheets.upsertFarmer({
        phone: to,
        name: entry.name,
        farmName: entry.farm_name,
        allowed: true,
        onboardingState: "pending_animals",
      });
      const copy = await sheets.copyLedger({
        phone: to,
        name: entry.name,
        farmName: entry.farm_name,
        allowed: true,
        onboardingState: "pending_animals",
      });
      await sheets.upsertFarmer({
        phone: to,
        name: entry.name,
        farmName: entry.farm_name,
        sheetId: copy.sheetId,
        allowed: true,
        onboardingState: "pending_animals",
      });
      await sheets.clearPending(to, "saved");
      await safeSend(() => sendText(to, `Theek hai, ${entry.name}. ${ASK_ANIMALS}`));
    } catch (err) {
      console.error("onboarding copyLedger failed", err.message);
      await safeSend(() =>
        sendText(
          to,
          "Farm ka ledger banate hue masla aaya. Thori dair baad dobara Haan bhej dein, ya Rizwan se rabta karein."
        )
      );
    }
    return;
  }

  if (
    farmer?.onboardingState === "pending_animals" &&
    pending.entries.every((e) => e.type === "add_cow" || e.type === "cow" || e.type === "animals")
  ) {
    const result = await sheets.commitRecords({
      ...scope(farmer, to),
      sender: to,
      entries: pending.entries,
      sourceNote: `WhatsApp ${to}`,
    });
    if (result.ok === false) {
      await safeSend(() => sendText(to, result.error || "Animals save nahi ho sake."));
      return;
    }
    await sheets.upsertFarmer({
      phone: to,
      onboardingState: "pending_customers",
      sheetId: farmer?.sheetId,
    });
    await safeSend(() => sendText(to, ASK_CUSTOMERS));
    return;
  }

  if (farmer?.onboardingState === "pending_customers" && pending.entries.every((e) => e.type === "add_customer" || e.type === "customer")) {
    const result = await sheets.commitRecords({
      ...scope(farmer, to),
      sender: to,
      entries: pending.entries,
      sourceNote: `WhatsApp ${to}`,
    });
    if (result.ok === false) {
      await safeSend(() => sendText(to, result.error || "Customers save nahi ho sake."));
      return;
    }
    await sheets.upsertFarmer({
      phone: to,
      onboardingState: "complete",
      sheetId: farmer?.sheetId,
    });
    const name = farmer?.name || "";
    await safeSend(() => sendText(to, howToMessage(name)));
    return;
  }

  const result = await sheets.commitRecords({
    ...scope(farmer, to),
    sender: to,
    entries: routeFodderEntries(pending.entries),
    sourceNote: `WhatsApp ${to}`,
  });
  if (result.ok === false) {
    await safeSend(() => sendText(to, result.error || "Record save nahi ho saka."));
    return;
  }
  await safeSend(() => sendText(to, savedText(pending.entries)));
}

async function handleRecord(sheets, to, parsed, messageId, farmer, fromImage) {
  if (!parsed.entries.length) {
    await safeSend(() =>
      sendText(
        to,
        fromImage
          ? CLEARER_PHOTO
          : parsed.reply ||
            "Record samajh nahi aaya. Dobara detail ke sath bhej dein, jaise gay ka naam aur litre."
      )
    );
    return;
  }
  parsed.entries = normalizeEditEntries(
    routeFodderEntries(parsed.entries),
    [parsed.summary || "", parsed.sourceText || ""].join(" ")
  );
  await sheets.setPending({
    sender: to,
    language: parsed.language,
    entries: parsed.entries,
    messageId,
    ...scope(farmer, to),
  });
  await askConfirm(to, confirmationText(parsed));
}

async function handleQuery(sheets, to, question, farmer) {
  const data = await sheets.readRecent({ days: 30, ...scope(farmer, to) });
  const reply = await answerQuery({
    question,
    data: formatLedgerData(data),
  });
  await safeSend(() =>
    sendText(to, reply || "Is sawal ka jawab ledger se nahi nikal saka.")
  );
}

async function handleReceipt(sheets, to, parsed, farmer) {
  const customer = parsed.receipt_customer || parsed.entries?.[0]?.customer;
  if (!customer) {
    await safeSend(() =>
      sendText(to, "Kis customer ki parchi chahiye? Maslan: Aslam ki parchi bhejo.")
    );
    return;
  }
  try {
    const data = await sheets.readRecent({ days: 60, ...scope(farmer, to) });
    const receipt = buildReceiptData({
      ledger: data,
      customer,
      farmName: farmer?.farmName || "Dairy Farm",
      periodStart: parsed.period_start || "",
      periodEnd: parsed.period_end || "",
    });
    if (!receipt.ok) {
      await safeSend(() => sendText(to, receipt.error));
      return;
    }
    const png = await renderReceiptPng(receipt);
    const caption = `Yeh ${receipt.customer} ki parchi hai. Isay unhen forward kar dein.`;
    const sent = await safeSend(() =>
      sendImage(to, { buffer: png, caption, filename: `parchi-${receipt.customer}.png` })
    );
    if (!sent) {
      await safeSend(() => sendText(to, "Parchi bani lekin bhej nahi saka. Thori dair baad dobara try karein."));
    }
    return { receipt, png };
  } catch (err) {
    console.error("receipt failed", err.message);
    await safeSend(() =>
      sendText(to, "Parchi banate hue masla aaya. Thori dair baad dobara try karein.")
    );
  }
}

async function enrichDeleteLast(sheets, farmer, sender, entries) {
  const out = [];
  for (const entry of entries) {
    if (entry.type !== "delete_last") {
      out.push(entry);
      continue;
    }
    try {
      const data = await sheets.readRecent({ days: 30, ...scope(farmer, sender) });
      const last = data; // Last_Write is not in readRecent; confirmation can stay generic
      out.push({ ...entry, summary: entry.summary || "jo sab se last save hua" });
    } catch {
      out.push(entry);
    }
  }
  return out;
}

async function getContext(sheets, farmer, sender) {
  try {
    return await sheets.getContext(scope(farmer, sender));
  } catch (err) {
    console.error("getContext failed", err.message);
    return { cows: [], customers: [] };
  }
}

async function startOnboarding(sheets, to, { text, audio, image, messageId }) {
  await sheets.upsertFarmer({
    phone: to,
    allowed: true,
    onboardingState: "pending_profile",
  });
  if (text || audio) {
    try {
      const parsed = await parseOnboarding("profile", { text, audio, image });
      if (parsed?.name && parsed?.farm_name) {
        await sheets.setPending({
          sender: to,
          language: "roman_urdu",
          entries: [{ type: "profile", name: parsed.name, farm_name: parsed.farm_name }],
          messageId,
        });
        await askConfirm(
          to,
          `Yeh save karun?\n\n${profileLines(parsed)}\n\nHaan dabain to save ho jayega. Nahi dabain to cancel.`
        );
        return;
      }
    } catch (err) {
      console.error("profile pre-parse failed", err.message);
    }
  }
  await safeSend(() => sendText(to, ASK_PROFILE));
}

async function handleOnboarding(sheets, to, farmer, { text, audio, image, messageId }) {
  const state = farmer.onboardingState || "pending_profile";
  if (state === "pending_profile") {
    let parsed;
    try {
      parsed = await parseOnboarding("profile", { text, audio, image });
    } catch (err) {
      console.error("profile parse failed", err.message);
      await safeSend(() => sendText(to, "Naam aur farm ka naam samajh nahi aaya. Dobara bhej dein."));
      return;
    }
    if (!parsed?.name || !parsed?.farm_name) {
      await safeSend(() => sendText(to, "Naam aur farm dono bhej dein. Maslan: Mera naam Ali hai, farm Al-Noor Dairy."));
      return;
    }
    await sheets.setPending({
      sender: to,
      language: "roman_urdu",
      entries: [{ type: "profile", name: parsed.name, farm_name: parsed.farm_name }],
      messageId,
    });
    await askConfirm(
      to,
      `Yeh save karun?\n\n${profileLines(parsed)}\n\nHaan dabain to save ho jayega. Nahi dabain to cancel.`
    );
    return;
  }

  if (state === "pending_animals") {
    let parsed;
    try {
      parsed = await parseOnboarding("animals", { text, audio, image });
    } catch (err) {
      console.error("animals parse failed", err.message);
      await safeSend(() => sendText(to, "Janwar samajh nahi aaye. Dobara ek message mein naam, type aur doodh bhej dein."));
      return;
    }
    const animals = parsed?.animals || [];
    if (!animals.length) {
      await safeSend(() => sendText(to, "Koi janwar nahi mila. Dobara bhej dein, maslan: Gori gay 18 litre, Lali bhains 15 litre."));
      return;
    }
    const entries = animals.map((a) => ({
      type: "add_cow",
      cow_name: a.name,
      animal_type: a.animal_type,
      avg_daily_litres: a.avg_daily_litres,
      breed: a.breed || "",
    }));
    await sheets.setPending({
      sender: to,
      language: "roman_urdu",
      entries,
      messageId,
    });
    await askConfirm(
      to,
      `Yeh janwar save karun?\n\n${animalLines(entries)}\n\nHaan dabain to save ho jayega. Nahi dabain to cancel.`
    );
    return;
  }

  if (state === "pending_customers") {
    if (isSkipText(text)) {
      await sheets.upsertFarmer({
        phone: to,
        onboardingState: "complete",
        sheetId: farmer.sheetId,
      });
      await safeSend(() => sendText(to, howToMessage(farmer.name)));
      return;
    }
    let parsed;
    try {
      parsed = await parseOnboarding("customers", { text, audio, image });
    } catch (err) {
      console.error("customers parse failed", err.message);
      await safeSend(() => sendText(to, "Customers samajh nahi aaye. Dobara bhej dein, ya skip likh dein."));
      return;
    }
    if (parsed?.skip) {
      await sheets.upsertFarmer({
        phone: to,
        onboardingState: "complete",
        sheetId: farmer.sheetId,
      });
      await safeSend(() => sendText(to, howToMessage(farmer.name)));
      return;
    }
    const customers = parsed?.customers || [];
    if (!customers.length) {
      await safeSend(() => sendText(to, "Koi customer nahi mila. Dobara bhej dein, ya skip likh dein."));
      return;
    }
    const entries = customers.map((c) => ({
      type: "add_customer",
      customer: c.name,
      rate_pkr: c.rate_pkr,
      opening_balance: c.opening_balance == null ? 0 : c.opening_balance,
      phone: c.phone || "",
    }));
    await sheets.setPending({
      sender: to,
      language: "roman_urdu",
      entries,
      messageId,
    });
    await askConfirm(
      to,
      `Yeh customers save karun?\n\n${customerOnboardLines(entries)}\n\nHaan dabain to save ho jayega. Nahi dabain to cancel.`
    );
  }
}

const CLEARER_PHOTO =
  "Yeh tasveer saaf nahi padh saki. Thori roshni mein, seedha khara karke clear photo bhej dein. Caption mein short note bhi likh sakte hain.";

function imageMeta(message) {
  if (message.type === "image" && message.image) {
    return {
      id: message.image.id,
      mimeType: message.image.mime_type || "image/jpeg",
      caption: message.image.caption || "",
    };
  }
  if (message.type === "document" && message.document) {
    const mime = message.document.mime_type || "";
    if (mime.startsWith("image/")) {
      return {
        id: message.document.id,
        mimeType: mime,
        caption: message.document.caption || "",
      };
    }
  }
  return null;
}

function isSupportedInbound(message) {
  if (["text", "button", "audio", "interactive", "image"].includes(message.type)) return true;
  return Boolean(imageMeta(message));
}

async function inboundMedia(message) {
  let text = "";
  if (message.type === "text") text = message.text?.body || "";
  else if (message.type === "button") text = message.button?.text || "";
  else if (message.type === "interactive") {
    text = message.interactive?.button_reply?.title || "";
  }

  const meta = imageMeta(message);
  if (meta) {
    if (meta.caption) text = meta.caption;
    if (!meta.id) return { text, audio: null, image: null, imageMissing: true };
    try {
      console.log("image media id:", meta.id, "mime type:", meta.mimeType);
      const image = await downloadMedia(meta.id);
      image.mimeType = image.mimeType || meta.mimeType;
      return { text, audio: null, image };
    } catch (err) {
      console.error("image download failed", err.message);
      return { text, audio: null, image: null, imageFailed: true };
    }
  }

  let audio = null;
  if (message.type === "audio") {
    const mediaId = message.audio?.id;
    const mimeType = message.audio?.mime_type || "audio/ogg";
    console.log("audio media id:", mediaId, "mime type:", mimeType);
    if (!mediaId) {
      return { text, audio: null, image: null, audioMissing: true };
    }
    try {
      audio = await downloadMedia(mediaId);
    } catch (err) {
      console.error("audio download failed", err.message);
      return { text, audio: null, image: null, audioFailed: true };
    }
  }
  return { text, audio, image: null };
}

async function handleMessage(sheets, { message, waId, contactName }) {
  const from = normalizePhone(waId || message.from);
  const messageId = message.id;
  console.log("incoming", {
    from,
    name: contactName,
    type: message.type,
    id: messageId,
  });

  if (await alreadyProcessed(sheets, messageId)) {
    console.log("skip duplicate", messageId);
    return;
  }
  await markProcessed(sheets, messageId, from);

  const access = await resolveAccess(sheets, from);
  let farmer = access.farmer;

  if (!access.allowed) {
    console.log("blocked sender not on allowlist or registry", from);
    await safeSend(() => sendText(from, INVITE_MESSAGE));
    return;
  }

  const buttonId = message.interactive?.button_reply?.id;
  if (message.type === "interactive" && buttonId) {
    if (buttonId === "confirm_yes") return handleConfirm(sheets, from, true, farmer);
    if (buttonId === "confirm_no") return handleConfirm(sheets, from, false, farmer);
  }

  const extracted = await inboundMedia(message);
  if (extracted.audioMissing) {
    await safeSend(() => sendText(from, "Voice note mili nahi. Dobara bhej dein."));
    return;
  }
  if (extracted.audioFailed) {
    await safeSend(() =>
      sendText(from, "Voice note download nahi ho saki. Thori dair baad dobara bhej dein.")
    );
    return;
  }
  if (extracted.imageMissing) {
    await safeSend(() => sendText(from, "Tasveer mili nahi. Dobara photo bhej dein."));
    return;
  }
  if (extracted.imageFailed) {
    await safeSend(() =>
      sendText(from, "Tasveer download nahi ho saki. Thori dair baad dobara bhej dein.")
    );
    return;
  }
  const text = extracted.text;
  const audio = extracted.audio;
  const image = extracted.image;

  if (text && isDeleteRequest(text)) {
    await safeSend(() =>
      sendText(
        from,
        "Data delete karne ki request mil gayi. rizwan@nodeable.ai par email karein, ya isi number se 'delete my data' likh dein. Hum confirm karke aapka data hata denge."
      )
    );
    return;
  }

  if (text && isYesText(text)) return handleConfirm(sheets, from, true, farmer);
  if (text && isNoText(text)) return handleConfirm(sheets, from, false, farmer);

  if (!isSupportedInbound(message)) {
    await safeSend(() =>
      sendText(from, "Abhi text, voice note, ya photo bhej dein. Main hisab likh lunga.")
    );
    return;
  }

  if (!access.registryUnavailable) {
    if (!farmer) {
      await startOnboarding(sheets, from, { text, audio, image, messageId });
      return;
    }
    if (farmer.onboardingState && farmer.onboardingState !== "complete") {
      return handleOnboarding(sheets, from, farmer, { text, audio, image, messageId });
    }
  }

  const context = await getContext(sheets, farmer, from);
  let parsed;
  try {
    parsed = await parseUserMessage({ text, audio, image, context });
  } catch (err) {
    console.error("gemini parse failed", err.message);
    await safeSend(() =>
      sendText(from, image ? CLEARER_PHOTO : "Samajh nahi aaya, dobara bhej dein.")
    );
    return;
  }

  parsed = applyMilkSessions(parsed, {
    text,
    timestamp: message.timestamp,
  });
  console.log("parsed intent", parsed.intent, "entries", parsed.entries.length);

  if (image && !parsed.entries.length && parsed.intent !== "query" && parsed.intent !== "receipt" && parsed.intent !== "confirm" && parsed.intent !== "cancel") {
    await safeSend(() => sendText(from, CLEARER_PHOTO));
    return;
  }
  if (parsed.intent === "confirm") return handleConfirm(sheets, from, true, farmer);
  if (parsed.intent === "cancel") return handleConfirm(sheets, from, false, farmer);
  if (parsed.intent === "receipt") return handleReceipt(sheets, from, parsed, farmer);
  if (parsed.intent === "edit") {
    parsed.entries = await enrichDeleteLast(sheets, farmer, from, parsed.entries);
    return handleRecord(sheets, from, parsed, messageId, farmer, Boolean(image));
  }
  if (parsed.intent === "record") return handleRecord(sheets, from, parsed, messageId, farmer, Boolean(image));
  if (parsed.intent === "query") return handleQuery(sheets, from, text || parsed.summary, farmer);
  await safeSend(() =>
    sendText(
      from,
      parsed.reply ||
        "Assalam o alaikum, main Munshi hoon. Doodh, sale, payment, chara ya kharcha bhej dein, tasveer bhej dein, parchi mango, ya apna hisab poochh lein."
    )
  );
}

async function processPayload(sheets, payload) {
  const messages = extractMessages(payload);
  for (const item of messages) {
    try {
      await handleMessage(sheets, item);
    } catch (err) {
      console.error("handleMessage failed", err.message);
    }
  }
}

module.exports = {
  processPayload,
  extractMessages,
  handleMessage,
};
