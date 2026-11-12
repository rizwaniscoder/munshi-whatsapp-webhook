const { normalizePhone, allowedNumbers, isTruthyAllowed, hasOwnLedger } = require("./config");
const { cycleLabel } = require("./billing");
const { tx } = require("./reply");
const { formatRs } = require("./format");
const { parseCommitteeOnboarding } = require("./committee");

const ASK_COMMITTEE =
  "Kya aap kisi committee (kameti) mein hain? Roz, hafte, ya mahine kitni dete hain? Maslan: roz 200 ki committee, naam Bazar. Agar nahi, ya baad mein, to skip likh dein.";

const ASK_PROFILE =
  "Assalam o alaikum, main Munshi hoon. Pehle apna naam aur farm ka naam bhej dein. Maslan: Mera naam Ali hai, farm Al-Noor Dairy.";

const ASK_ANIMALS =
  "Ab apni gayen aur bhainsain bata dein, ek hi message mein. Har janwar ka naam, type (gay ya bhains), aur rozana kitna doodh deti hai. Maslan: Gori gay 18 litre, Lali bhains 15 litre.";

const ASK_CUSTOMERS =
  "Ab customers bata dein: naam, litre ka rate, shuru ka udhaar, phone agar ho, aur bill kab due hota hai. Maslan: Aslam rate 190, 2000 udhaar, phone 03001112233, hafte baad paise deta hai. Aslam roz paise deta hai, hafte baad, 15 din baad ya mahine baad? Agar abhi nahi batana to skip likh dein.";

const INVITE_MESSAGE =
  "Assalam o alaikum, main Munshi hoon. Yeh service invite se chalti hai. Access ke liye Rizwan se rabta karein: rizwan@nodeable.ai";

function howToMessage(name) {
  const helloR = name ? `Setup ho gaya, ${name}.` : "Setup ho gaya.";
  const helloU = name ? `سیٹ اپ ہو گیا، ${name}۔` : "سیٹ اپ ہو گیا۔";
  const roman = `${helloR} Ab aise hisab bhejain:

1) Subah Gori ne 18 litre doodh diya
2) Aslam ko 20 litre diye, rate 190, 2000 cash liye
3) Aaj kitna doodh hua?

Sale ki parchi ke liye likhein: Aslam ki parchi bhejo.
Committee: aaj committee di, ya committee nahi di.
Kharcha: aaj 500 mazdoori aur 2000 tankhwah.
Bill, sehat aur khoraak ke sawal: kis ka bill due hai, Gori ka check karaya gaban hai, doctor kab aayega, wanda kab khatam hoga.`;
  const urdu = `${helloU} اب ایسے حساب بھیجیں:

1) صبح Gori نے 18 litre دودھ دیا
2) Aslam کو 20 litre دیے، rate 190، 2000 نقد لیے
3) آج کتنا دودھ ہوا؟

سیل کی پرچی کے لیے لکھیں: Aslam کی پرچی بھیجو۔
کمیٹی: آج committee دی، یا committee نہیں دی۔
خرچہ: آج 500 مزدوری اور 2000 تنخواہ۔
بل، صحت اور خوراک کے سوال: کس کا بل due ہے، Gori کا چیک کرایا گابن ہے، ڈاکٹر کب آئے گا، Wanda کب ختم ہوگا۔`;
  return tx(urdu, roman);
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

function customerOnboardLines(entries, script) {
  const rows = (entries || []).map((c) => {
    const name = c.customer || c.name;
    const phone = c.phone ? `, phone ${c.phone}` : "";
    const cycle = c.billing_cycle ? `, bill ${cycleLabel(c.billing_cycle)}` : "";
    const rate = c.rate_pkr == null || c.rate_pkr === "" ? "-" : formatRs(c.rate_pkr);
    const udhaar = formatRs(c.opening_balance == null ? 0 : c.opening_balance);
    return {
      urdu: `- ${name}: rate ${rate}, ادھار ${udhaar}${phone}${cycle}`,
      roman: `- ${name}: rate ${rate}, udhaar ${udhaar}${phone}${cycle}`,
    };
  });
  const urdu = rows.map((r) => r.urdu).join("\n");
  const roman = rows.map((r) => r.roman).join("\n");
  if (script === "urdu") return urdu;
  if (script === "roman") return roman;
  return tx(urdu, roman);
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
  return tx(
    `کیا یہ آپ کا نام اور فارم ہے؟\n\n${name}, ${farm}?\n\nہاں دبائیں تو سیو ہو جائے گا۔ نہیں دبائیں تو کینسل۔ Edit دبائیں تو تبدیلی کریں۔`,
    `Yeh aapka naam aur farm hai?\n\n${name}, ${farm}?\n\nHaan dabain to save ho jayega. Nahi dabain to cancel. Edit dabain to tabdeeli karein.`
  );
}


function askProfile() {
  return tx("السلام علیکم، میں منشی ہوں۔ پہلے اپنا نام اور فارم کا نام بھیج دیں۔ مثلاً: میرا نام علی ہے، فارم Al-Noor Dairy۔", ASK_PROFILE);
}
function askAnimals() {
  return tx("اب اپنی گائیں اور بھینسیں بتا دیں، ایک ہی میسج میں۔ ہر جانور کا نام، قسم (گائے یا بھینس)، اور روزانہ کتنا دودھ دیتی ہے۔ مثلاً: Gori گائے 18 litre، Lali بھینس 15 litre۔", ASK_ANIMALS);
}
function askCustomers() {
  return tx("اب کسٹمرز بتا دیں: نام، litre کا rate، شروع کا ادھار، فون اگر ہو، اور بل کب due ہوتا ہے۔ مثلاً: Aslam rate 190، 2000 ادھار، فون 03001112233، ہفتے بعد پیسے دیتا ہے۔ روز، ہفتے بعد، 15 دن بعد یا مہینے بعد؟ اگر ابھی نہیں بتانا تو skip لکھ دیں۔", ASK_CUSTOMERS);
}
function askCommittee() {
  return tx("کیا آپ کسی کمیٹی (kameti) میں ہیں؟ روز، ہفتے، یا مہینے کتنی دیتے ہیں؟ مثلاً: روز 200 کی کمیٹی، نام Bazar۔ اگر نہیں، یا بعد میں، تو skip لکھ دیں۔", ASK_COMMITTEE);
}
function inviteMessage() {
  return tx("السلام علیکم، میں منشی ہوں۔ یہ سروس دعوت سے چلتی ہے۔ رسائی کے لیے Rizwan سے رابطہ کریں: rizwan@nodeable.ai", INVITE_MESSAGE);
}

module.exports = {
  ASK_PROFILE,
  ASK_ANIMALS,
  ASK_CUSTOMERS,
  ASK_COMMITTEE,
  INVITE_MESSAGE,
  askProfile,
  askAnimals,
  askCustomers,
  askCommittee,
  parseCommitteeOnboarding,
  inviteMessage,
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
