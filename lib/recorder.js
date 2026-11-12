const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { handleMessage } = require("./bot");
const { prepareAudioForGemini } = require("./audio-mime");
const { runWebTurn } = require("./web-channel");
const { GENERIC_DENY, findAllowedFarmerByToken } = require("./web-token");

const PAGE_PATH = path.join(__dirname, "../pages/recorder.html");
const ACTIONS = {
  confirm_yes: "Haan",
  confirm_no: "Nahi",
  confirm_edit: "Edit",
};

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function renderDeniedPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Munshi</title>
</head>
<body style="font-family: sans-serif; background:#f4f7f2; color:#142018; padding:32px;">
  <p style="font-size:1.25rem;">${escapeHtml(GENERIC_DENY)}</p>
</body>
</html>`;
}

function renderRecorderPage(farmer, token) {
  const boot = JSON.stringify({
    farm: farmer.farmName || farmer.name || "Munshi",
  }).replace(/</g, "\\u003c");
  const manifest = `/r/${encodeURIComponent(token)}/manifest.webmanifest`;
  const html = fs.readFileSync(PAGE_PATH, "utf8");
  return html.replace("__BOOT_JSON__", boot).replace("__MANIFEST_HREF__", manifest);
}

function renderManifest(token) {
  return {
    name: "Munshi",
    short_name: "Munshi",
    description: "Doodh, sale, aur kharcha ki awaz",
    start_url: `/r/${token}`,
    scope: `/r/${token}`,
    id: `/r/${token}`,
    display: "standalone",
    background_color: "#f4f7f2",
    theme_color: "#14532d",
    icons: [
      { src: "/recorder/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/recorder/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  };
}

function webMessageId() {
  return `web-${crypto.randomBytes(8).toString("hex")}`;
}

async function handleRecorderTurn(sheets, { token, text, action, audio } = {}) {
  const farmer = await findAllowedFarmerByToken(sheets, token);
  if (!farmer) return { ok: false, status: 404, error: GENERIC_DENY };

  const id = webMessageId();
  const timestamp = String(Math.floor(Date.now() / 1000));
  let message;
  if (audio && Buffer.isBuffer(audio.buffer)) {
    if (audio.buffer.length < 200) {
      return { ok: false, status: 400, error: "Awaz nahi mili. Dobara record karein." };
    }
    const prepared = await prepareAudioForGemini(audio.buffer, audio.mimeType || "audio/webm");
    message = {
      id,
      from: farmer.phone,
      timestamp,
      type: "audio",
      audio: {
        id: "web-audio",
        mime_type: prepared.mimeType,
        buffer: prepared.buffer,
      },
    };
  } else if (action) {
    const idAction = String(action || "");
    if (!ACTIONS[idAction]) {
      return { ok: false, status: 400, error: "Yeh jawab theek nahi." };
    }
    message = {
      id,
      from: farmer.phone,
      timestamp,
      type: "interactive",
      interactive: { button_reply: { id: idAction, title: ACTIONS[idAction] } },
    };
  } else if (String(text || "").trim()) {
    message = {
      id,
      from: farmer.phone,
      timestamp,
      type: "text",
      text: { body: String(text).trim().slice(0, 2000) },
    };
  } else {
    return { ok: false, status: 400, error: "Awaz ya likha hua hisab bhejein." };
  }

  try {
    const replies = await runWebTurn(() =>
      handleMessage(sheets, { message, waId: farmer.phone, contactName: farmer.name || "" })
    );
    return { ok: true, status: 200, replies };
  } catch (err) {
    console.error("recorder turn failed", err.message);
    return { ok: false, status: 500, error: "Masla aa gaya. Thori dair baad dubara koshish karein." };
  }
}

module.exports = {
  GENERIC_DENY,
  renderDeniedPage,
  renderRecorderPage,
  renderManifest,
  handleRecorderTurn,
};
