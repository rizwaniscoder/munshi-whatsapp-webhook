const fs = require("fs");
const path = require("path");
const { GRAPH_VERSION, PHONE_NUMBER_ID, optionalEnv } = require("./config");

function token() {
  const value = (process.env.WHATSAPP_TOKEN || "").trim();
  if (!value) throw new Error("WHATSAPP_TOKEN is not set");
  return value;
}

function dryRun() {
  return optionalEnv("WHATSAPP_DRY_RUN", "") === "1";
}

const outboundLog = [];

function recordOutbound(entry) {
  outboundLog.push(entry);
}

function takeOutbound() {
  const copy = outboundLog.slice();
  outboundLog.length = 0;
  return copy;
}


function graphUrl(path) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
}

async function sendPayload(payload) {
  if (dryRun()) {
    recordOutbound(payload);
    console.log(
      "whatsapp dry-run send",
      JSON.stringify({ to: payload.to, type: payload.type })
    );
    return { dryRun: true, payload };
  }

  const url = graphUrl(`${PHONE_NUMBER_ID}/messages`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const errMsg = body?.error?.message || `HTTP ${res.status}`;
    console.error("whatsapp send failed", res.status, errMsg);
    const error = new Error(`WhatsApp send failed: ${errMsg}`);
    error.status = res.status;
    error.meta = body?.error || null;
    throw error;
  }
  return body;
}

async function sendText(to, body) {
  return sendPayload({ to, type: "text", text: { preview_url: false, body } });
}

async function sendConfirmButtons(to, body) {
  return sendPayload({
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body.slice(0, 1024) },
      action: {
        buttons: [
          { type: "reply", reply: { id: "confirm_yes", title: "Haan" } },
          { type: "reply", reply: { id: "confirm_no", title: "Nahi" } },
        ],
      },
    },
  });
}

function testMediaFile(mediaId) {
  const dir = (process.env.MUNSHI_TEST_MEDIA_DIR || "").trim();
  if (!dir || !mediaId) return "";
  const candidate = path.join(dir, path.basename(String(mediaId)));
  return fs.existsSync(candidate) ? candidate : "";
}

async function downloadMedia(mediaId) {
  const local = testMediaFile(mediaId);
  if (local) {
    const ext = path.extname(local).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    const buffer = fs.readFileSync(local);
    console.log("loaded test media", mediaId, "bytes", buffer.length, "mime", mime);
    return { buffer, mimeType: mime };
  }

  const metaRes = await fetch(graphUrl(mediaId), {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!metaRes.ok) {
    const errText = await metaRes.text();
    throw new Error(
      `Media metadata failed: HTTP ${metaRes.status} ${errText.slice(0, 200)}`
    );
  }
  const meta = await metaRes.json();
  const mediaUrl = meta.url;
  const mimeType = meta.mime_type || "audio/ogg";
  if (!mediaUrl) throw new Error("Media metadata missing url");

  const fileRes = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!fileRes.ok) {
    throw new Error(`Media download failed: HTTP ${fileRes.status}`);
  }
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  console.log("downloaded media", mediaId, "bytes", buffer.length, "mime", mimeType);
  return { buffer, mimeType };
}

async function uploadMedia(buffer, mimeType, filename) {
  if (dryRun()) {
    return { dryRun: true, id: "dry-run-media" };
  }
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType || "image/png");
  form.append("file", new Blob([buffer], { type: mimeType || "image/png" }), filename || "parchi.png");
  const res = await fetch(graphUrl(`${PHONE_NUMBER_ID}/media`), {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}` },
    body: form,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`WhatsApp media upload failed: HTTP ${res.status}`);
  }
  if (!res.ok || !body.id) {
    throw new Error(body.error?.message || `WhatsApp media upload failed: HTTP ${res.status}`);
  }
  return body;
}

async function sendImage(to, { buffer, caption, filename, mimeType }) {
  if (dryRun()) {
    const payload = { to, type: "image", caption, bytes: buffer?.length || 0, buffer };
    recordOutbound(payload);
    console.log(
      "whatsapp dry-run send",
      JSON.stringify({ to, type: "image", bytes: buffer?.length || 0, caption: caption || "" })
    );
    return { dryRun: true, payload };
  }
  const uploaded = await uploadMedia(buffer, mimeType || "image/png", filename || "parchi.png");
  return sendPayload({
    to,
    type: "image",
    image: { id: uploaded.id, caption: (caption || "").slice(0, 1024) },
  });
}

module.exports = {
  sendText,
  sendConfirmButtons,
  downloadMedia,
  sendImage,
  uploadMedia,
  dryRun,
  takeOutbound,
};
