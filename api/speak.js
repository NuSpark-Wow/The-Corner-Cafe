// The Corner Café — optional voice (ElevenLabs). Chats are text unless the visitor turns voice on.
// Env: ELEVENLABS_API_KEY (needed for voice), ELEVENLABS_MODEL (optional, default Flash: the low-cost model)
// Optional voice swaps: VOICES_MALE and VOICES_FEMALE (comma-separated ElevenLabs voice IDs)
// Only the friend's own words are sent here. No visitor audio ever reaches this server.

const MALE = list(process.env.VOICES_MALE) || [
  "CwhRBWXzGAHq8TQ4Fs17", // Roger - laid-back, resonant
  "bIHbv24MWmeRgasZH58o", // Will - relaxed optimist
  "cjVigY5qzO86Huf0OWal", // Eric - smooth, trustworthy
  "iP95p4xoKVk53GoZ742B", // Chris - charming, down-to-earth
  "pqHfZKP75CvOlQylNhV4"  // Bill - wise, mature
];
const FEMALE = list(process.env.VOICES_FEMALE) || [
  "cgSgspJ2msm6clMCkdW9", // Jessica - playful, bright, warm
  "XrExE9yKIg1WjnnlVkGX", // Matilda - confident alto
  "bb2q8Tox15YHJ7ceE9tu", // Liza - pleasant, smooth
  "EXAVITQu4vr4xnSDxMaL"  // Sarah - confident, reassuring
];
// Each style gets its own delivery.
const STYLE = {
  straight: { stability: 0.6, style: 0.25, speed: 1.03 },
  easy:     { stability: 0.45, style: 0.45, speed: 1.0 },
  warm:     { stability: 0.55, style: 0.35, speed: 0.95 }
};
const MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
const cache = new Map();

function list(s) { const a = String(s || "").split(",").map(x => x.trim()).filter(Boolean); return a.length ? a : null; }

module.exports = async (req, res) => {
  if (!allowedRequest(req)) return blockRequest(res);
  const key = process.env.ELEVENLABS_API_KEY;
  if (req.method === "GET") {
    const out = { api_key_set: !!key, male: MALE.length, female: FEMALE.length, model: MODEL };
    if (String((req.query && req.query.check) || "") && key) {
      try {
        const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${MALE[0]}?output_format=mp3_22050_32`, {
          method: "POST", headers: { "xi-api-key": key, "content-type": "application/json" },
          body: JSON.stringify({ text: "Hi.", model_id: MODEL })
        });
        out.voice = r.ok ? "working" : `error ${r.status}: ${(await r.text()).slice(0, 200)}`;
      } catch (e) { out.voice = "error: " + e.message; }
    }
    return res.json(out);
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!key) return res.status(501).json({ error: "voice_off", message: "Voice isn't switched on for this tool yet." });
  const b = req.body || {};
  const pool = b.gender === "female" ? FEMALE : MALE;
  const idx = Math.abs(parseInt(b.slot, 10) || 0) % pool.length;
  const voice = pool[idx];
  const st = STYLE[b.style] || STYLE.easy;
  const slow = b.speed === "slow";
  const speed = Math.max(0.7, +(st.speed * (slow ? 0.85 : 1)).toFixed(2));
  const text = String(b.text || "").replace(/[*_#`>]/g, "").trim().slice(0, 1200);
  if (!text) return res.status(400).json({ error: "empty" });
  const ck = voice + "|" + (b.style || "") + "|" + (slow ? "s" : "n") + "|" + text;
  if (cache.has(ck)) return res.json(cache.get(ck));
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability: st.stability, similarity_boost: 0.8, style: st.style, speed, use_speaker_boost: true } })
    });
    if (!r.ok) return res.status(502).json({ error: "voice_failed", message: "The voice didn't come through. The text is still there." });
    const buf = Buffer.from(await r.arrayBuffer());
    const out = { audio: buf.toString("base64") };
    if (cache.size > 200) cache.clear();
    cache.set(ck, out);
    return res.json(out);
  } catch (e) {
    return res.status(502).json({ error: "voice_failed", message: "The voice didn't come through. The text is still there." });
  }
};

// ---------- website lock (same as the other tools) ----------
function allowedRequest(req) {
  if (String(process.env.LOCK_OFF || "") === "1") return true;
  const sites = ["nusparkpublishing.com", "nusparkmarketing.com", "nusparklearnwow.com"]
    .concat(String(process.env.ALLOWED_SITES || "").split(",").map(s => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean));
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase().split(":")[0];
  const ok = u => {
    try {
      const h = new URL(u).hostname.toLowerCase();
      return h === host || h === "localhost" || h === "127.0.0.1" || sites.some(d => h === d || h.endsWith("." + d));
    } catch (e) { return false; }
  };
  const origin = req.headers.origin, ref = req.headers.referer || req.headers.referrer;
  if (origin && origin !== "null") return ok(origin);
  if (ref) return ok(ref);
  return req.method === "GET";
}
function blockRequest(res) {
  res.statusCode = 403;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "not_allowed", message: "This tool only works on NuSpark websites." }));
}
