const { normalizePhone, allowedNumbers, isTruthyAllowed, hasOwnLedger } = require("./config");

const ASK_PROFILE =
  "Assalam o alaikum, main Munshi hoon. Pehle apna naam aur farm ka naam bhej dein. Maslan: Mera naam Ali hai, farm Al-Noor Dairy.";

const ASK_ANIMALS =
  "Ab apni gayen aur bhainsain bata dein, ek hi message mein. Har janwar ka naam, type (gay ya bhains), aur rozana kitna doodh deti hai. Maslan: Gori gay 18 litre, Lali bhains 15 litre.";

const ASK_CUSTOMERS =
  "Ab customers bata dein: naam, litre ka rate, shuru ka udhaar, aur phone agar ho. Maslan: Aslam rate 190, 2000 udhaar, phone 03001112233. Agar abhi nahi batana to skip likh dein.";

const INVITE_MESSAGE =
  "Assalam o alaikum, main Munshi hoon. Yeh service invite se chalti hai. Access ke liye Rizwan se rabta karein: rizwan@nodeable.ai";

function howToMessage(name) {
  const hello = name ? `Setup ho gaya, ${name}.` : "Setup ho gaya.";
  return `${hello} Ab aise hisab bhejain:

1) Subah Gori ne 18 litre doodh diya
2) Aslam ko 20 litre diye, rate 190, 2000 cash liye
3) Aaj kitna doodh hua?

Sale ki parchi ke liye likhein: Aslam ki parchi bhejo.`;
}

function isSkipText(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[!?.]+$/g, "");
  if (!t) return false;
  if (["skip", "skip karo", "skip kardo", "chor do", "chordeo", "rehne do", "baad mein"].includes(t)) {
    return true;
  }
  return (
    t.includes("skip") ||
    t.includes("koi customer nahi") ||
    t.includes("customer nahi") ||
    t.includes("customers nahi")
  );
}

function isOnAllowlist(phone) {
  const list = allowedNumbers();
  return list.includes(normalizePhone(phone));
}

async function resolveAccess(sheets, phone) {
  const from = normalizePhone(phone);
  let farmer = null;
  let registryUnavailable = false;
  try {
    const result = await sheets.getFarmer(from);
    if (result?.registryUnavailable) registryUnavailable = true;
    farmer = result?.farmer || null;
  } catch (err) {
    if (/unknown action/i.test(err.message || "")) {
      registryUnavailable = true;
    } else {
      console.error("getFarmer failed", err.message);
      registryUnavailable = true;
    }
  }
  if (registryUnavailable) {
    const { isAllowed } = require("./config");
    return { farmer: null, registryUnavailable: true, allowed: isAllowed(from) };
  }
  const allowed = (farmer && isTruthyAllowed(farmer.allowed)) || isOnAllowlist(from);
  return { farmer, registryUnavailable: false, allowed };
}

function animalLabel(type) {
  return String(type || "").toLowerCase() === "buffalo" ? "bhains" : "gay";
}

function profileLines(entry) {
  return `Naam: ${entry.name || "-"}\nFarm: ${entry.farm_name || "-"}`;
}

function animalLines(entries) {
  return (entries || [])
    .map((a) => {
      const avg =
        a.avg_daily_litres != null && a.avg_daily_litres !== ""
          ? `, rozana ${a.avg_daily_litres} L`
          : "";
      return `- ${a.cow_name || a.name} (${animalLabel(a.animal_type || a.type)})${avg}`;
    })
    .join("\n");
}

function customerOnboardLines(entries) {
  return (entries || [])
    .map((c) => {
      const name = c.customer || c.name;
      const phone = c.phone ? `, phone ${c.phone}` : "";
      return `- ${name}: rate ${c.rate_pkr == null ? "-" : c.rate_pkr}, udhaar ${c.opening_balance == null ? 0 : c.opening_balance}${phone}`;
    })
    .join("\n");
}


function needsOnboarding(farmer, phone) {
  if (!farmer) return true;
  if (!hasOwnLedger(farmer, phone)) return true;
  const state = String(farmer.onboardingState || "").trim().toLowerCase();
  return !state || state !== "complete";
}

function hasPrefillProfile(farmer) {
  return Boolean(String(farmer?.name || "").trim() && String(farmer?.farmName || farmer?.farm_name || "").trim());
}

function prefillConfirmText(farmer) {
  const name = String(farmer?.name || "").trim();
  const farm = String(farmer?.farmName || farmer?.farm_name || "").trim();
  return `Yeh aapka naam aur farm hai?\n\n${name}, ${farm}?\n\nHaan dabain to save ho jayega. Nahi dabain to cancel. Edit dabain to tabdeeli karein.`;
}

module.exports = {
  ASK_PROFILE,
  ASK_ANIMALS,
  ASK_CUSTOMERS,
  INVITE_MESSAGE,
  howToMessage,
  isSkipText,
  isTruthyAllowed,
  isOnAllowlist,
  resolveAccess,
  needsOnboarding,
  hasPrefillProfile,
  prefillConfirmText,
  animalLabel,
  profileLines,
  animalLines,
  customerOnboardLines,
};
