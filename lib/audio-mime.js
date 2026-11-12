const { spawn } = require("child_process");

function normalizeAudioMime(mime) {
  const raw = String(mime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!raw) return "audio/ogg";
  if (raw === "video/webm" || raw === "audio/webm") return "audio/webm";
  if (raw === "audio/opus" || raw === "audio/ogg" || raw === "application/ogg") return "audio/ogg";
  if (raw === "audio/mp3" || raw === "audio/mpeg") return "audio/mpeg";
  if (raw === "audio/x-aac" || raw === "audio/aac") return "audio/aac";
  if (raw === "audio/mp4" || raw === "audio/m4a" || raw === "audio/x-m4a") return "audio/mp4";
  if (raw === "audio/wav" || raw === "audio/wave" || raw === "audio/x-wav") return "audio/wav";
  if (raw === "audio/flac" || raw === "audio/x-flac") return "audio/flac";
  if (raw === "audio/aiff" || raw === "audio/x-aiff") return "audio/aiff";
  if (raw.startsWith("audio/")) return raw;
  return "audio/ogg";
}

const PASSTHROUGH = new Set(["audio/ogg", "audio/mpeg", "audio/wav", "audio/flac", "audio/aac", "audio/aiff"]);

function ffmpegBin() {
  return (process.env.FFMPEG_PATH || "").trim() || "ffmpeg";
}

function runFfmpeg(buffer, codecArgs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        ffmpegBin(),
        ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", ...codecArgs, "-f", "ogg", "pipe:1"],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 8000);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(Buffer.concat(err).toString("utf8").slice(0, 180) || `ffmpeg exit ${code}`));
        return;
      }
      const converted = Buffer.concat(out);
      if (!converted.length) {
        reject(new Error("ffmpeg produced empty audio"));
        return;
      }
      resolve(converted);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(buffer);
  });
}

async function prepareAudioForGemini(buffer, mimeType) {
  const mime = normalizeAudioMime(mimeType);
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { buffer: Buffer.alloc(0), mimeType: mime };
  if (PASSTHROUGH.has(mime)) return { buffer, mimeType: mime };
  // Gemini accepts audio/webm. When ffmpeg is on PATH, remux webm/mp4 to ogg/opus
  // so the bytes match WhatsApp voice notes. The Render Node image has no ffmpeg.
  if (mime === "audio/webm" || mime === "audio/mp4") {
    try {
      const copied = await runFfmpeg(buffer, ["-c:a", "copy"]);
      return { buffer: copied, mimeType: "audio/ogg" };
    } catch (copyErr) {
      try {
        const encoded = await runFfmpeg(buffer, ["-c:a", "libopus", "-b:a", "24k"]);
        return { buffer: encoded, mimeType: "audio/ogg" };
      } catch (encodeErr) {
        console.error("audio convert failed", encodeErr.message || copyErr.message);
        return { buffer, mimeType: mime };
      }
    }
  }
  return { buffer, mimeType: mime };
}

module.exports = {
  normalizeAudioMime,
  prepareAudioForGemini,
};
