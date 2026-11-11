const { GRAPH_VERSION, PHONE_NUMBER_ID, optionalEnv } = require("./config");

function token() {
  const value = (process.env.WHATSAPP_TOKEN || "").trim();
  if (!value) throw new Error("WHATSAPP_TOKEN is not set");
  return value;
}

function dryRun() {
  return optionalEnv("WHATSAPP_DRY_RUN", "") === "1";
}

function graphUrl(path) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
}

async function sendPayload(payload) {
  if (dryRun()) {
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

async function downloadMedia(mediaId) {
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
  console.log("downloaded audio", mediaId, "bytes", buffer.length, "mime", mimeType);
  return { buffer, mimeType };
}

module.exports = {
  sendText,
  sendConfirmButtons,
  downloadMedia,
  dryRun,
};
