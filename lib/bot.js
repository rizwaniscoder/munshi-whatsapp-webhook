const { isAllowed, normalizePhone } = require("./config");
const { parseUserMessage, answerQuery } = require("./gemini");
const { sendText, sendConfirmButtons, downloadMedia } = require("./whatsapp");
const { formatLedgerData } = require("./sheets");
const { applyMilkSessions } = require("./session");
const {
  confirmationText,
  savedText,
  isYesText,
  isNoText,
  isDeleteRequest,
} = require("./ledger");

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

async function handleConfirm(sheets, to, yes) {
  const found = await sheets.getPending(to);
  const pending = found.pending;
  if (!pending || !pending.entries?.length) {
    await safeSend(() =>
      sendText(to, "Koi pending record nahi hai. Apna hisab bhej dein.")
    );
    return;
  }
  if (!yes) {
    await sheets.clearPending(to, "cancelled");
    await safeSend(() =>
      sendText(to, "Theek hai, yeh record nahi likha. Dobara bhej dein.")
    );
    return;
  }
  await sheets.commitRecords({
    sender: to,
    entries: pending.entries,
    sourceNote: `WhatsApp ${to}`,
  });
  await safeSend(() => sendText(to, savedText(pending.entries)));
}

async function handleRecord(sheets, to, parsed, messageId) {
  if (!parsed.entries.length) {
    await safeSend(() =>
      sendText(
        to,
        parsed.reply ||
          "Record samajh nahi aaya. Dobara detail ke sath bhej dein, jaise gay ka naam aur litre."
      )
    );
    return;
  }
  await sheets.setPending({
    sender: to,
    language: parsed.language,
    entries: parsed.entries,
    messageId,
  });
  const body = confirmationText(parsed);
  const sent = await safeSend(() => sendConfirmButtons(to, body));
  if (!sent) {
    await safeSend(() => sendText(to, `${body}\n\nJawab mein Haan ya Nahi likh dein.`));
  }
}

async function handleQuery(sheets, to, question) {
  const data = await sheets.readRecent(30);
  const reply = await answerQuery({
    question,
    data: formatLedgerData(data),
  });
  await safeSend(() =>
    sendText(to, reply || "Is sawal ka jawab ledger se nahi nikal saka.")
  );
}

async function getContext(sheets) {
  try {
    return await sheets.getContext();
  } catch (err) {
    console.error("getContext failed", err.message);
    return {
      cows: ["Gori", "Kali", "Rani", "Moti", "Champi", "Sundri", "Lali"],
      customers: ["Aslam", "Bashir", "Hotel Mehran"],
    };
  }
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

  if (!isAllowed(from)) {
    console.log("blocked sender not on allowlist", from);
    return;
  }

  const buttonId = message.interactive?.button_reply?.id;
  if (message.type === "interactive" && buttonId) {
    if (buttonId === "confirm_yes") return handleConfirm(sheets, from, true);
    if (buttonId === "confirm_no") return handleConfirm(sheets, from, false);
  }

  let text = "";
  if (message.type === "text") text = message.text?.body || "";
  else if (message.type === "button") text = message.button?.text || "";
  else if (message.type === "interactive") {
    text = message.interactive?.button_reply?.title || "";
  }

  if (text && isDeleteRequest(text)) {
    await safeSend(() =>
      sendText(
        from,
        "Data delete karne ki request mil gayi. rizwan@nodeable.ai par email karein, ya isi number se 'delete my data' likh dein. Hum confirm karke aapka data hata denge."
      )
    );
    return;
  }

  if (text && isYesText(text)) return handleConfirm(sheets, from, true);
  if (text && isNoText(text)) return handleConfirm(sheets, from, false);

  let audio = null;
  if (message.type === "audio") {
    const mediaId = message.audio?.id;
    const mimeType = message.audio?.mime_type || "audio/ogg";
    console.log("audio media id:", mediaId, "mime type:", mimeType);
    if (!mediaId) {
      await safeSend(() => sendText(from, "Voice note mili nahi. Dobara bhej dein."));
      return;
    }
    try {
      audio = await downloadMedia(mediaId);
    } catch (err) {
      console.error("audio download failed", err.message);
      await safeSend(() =>
        sendText(from, "Voice note download nahi ho saki. Thori dair baad dobara bhej dein.")
      );
      return;
    }
  } else if (message.type !== "text" && message.type !== "button") {
    await safeSend(() =>
      sendText(from, "Abhi text ya voice note bhej dein. Main hisab likh lunga.")
    );
    return;
  }

  const context = await getContext(sheets);
  let parsed;
  try {
    parsed = await parseUserMessage({ text, audio, context });
  } catch (err) {
    console.error("gemini parse failed", err.message);
    await safeSend(() =>
      sendText(from, "Samajh nahi aaya, dobara bhej dein.")
    );
    return;
  }

  parsed = applyMilkSessions(parsed, {
    text,
    timestamp: message.timestamp,
  });
  console.log("parsed intent", parsed.intent, "entries", parsed.entries.length);

  if (parsed.intent === "confirm") return handleConfirm(sheets, from, true);
  if (parsed.intent === "cancel") return handleConfirm(sheets, from, false);
  if (parsed.intent === "record") return handleRecord(sheets, from, parsed, messageId);
  if (parsed.intent === "query") return handleQuery(sheets, from, text || parsed.summary);
  await safeSend(() =>
    sendText(
      from,
      parsed.reply ||
        "Assalam o alaikum, main Munshi hoon. Doodh, sale, payment ya kharcha bhej dein, ya apna hisab poochh lein."
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
