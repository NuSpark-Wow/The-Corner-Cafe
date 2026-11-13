// The Corner Café — chat server
// Parts (POST JSON with "part"):
//   chat  { mode: "one"|"round", friend, styles:[...], approach, extended, history:[{role:"user"|"friend", style, round, text}], userText, recap }
//   recap { friend, styles, history }   -> short summary used when someone uploads a saved chat to continue
//   copy  { friend, style, approach }             -> the persona text to paste into ChatGPT, Claude, Copilot or Gemini (no AI cost)
// GET ?part=data -> the friend list, styles and fine print for the page.  GET (no part) -> status check.
// Env: ANTHROPIC_API_KEY (required), CLAUDE_MODEL (optional, default Haiku: fast and low cost)

const P = require("./_personas.js");

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const MAX_REPLIES = 6;   // One-on-One with a "help" friend: friend replies per chat
const TALK_REPLIES = 8;  // One-on-One with a "just talk" friend
const TALK_EXTRA = 4;    // ...plus 4 more if the visitor chooses to keep going
const MAX_ROUNDS = 3;    // Roundtable: rounds per chat
const HOURLY_LIMIT = 60; // AI calls per visitor per hour
const hits = new Map();

module.exports = async (req, res) => {
  if (!allowedRequest(req)) return blockRequest(res);
  if (req.method === "GET") {
    const part = String((req.query && req.query.part) || "");
    if (part === "data") {
      return res.json({
        tabs: P.TABS, sections: P.SECTIONS,
        friends: P.FRIENDS.map(f => ({ id: f.id, tab: f.tab, section: P.sectionOf(f), icon: f.icon, name: f.name, blurb: f.blurb })),
        styles: P.STYLES.map(s => ({ id: s.id, name: s.name, short: s.short, color: s.color })),
        approaches: P.APPROACHES.map(a => ({ id: a.id, name: a.name, short: a.short })), noChallenger: P.NO_CHALLENGER,
        finePrint: P.FINE_PRINT, credit: P.CREDIT, site: P.SITE,
        maxReplies: MAX_REPLIES, talkReplies: TALK_REPLIES, talkExtra: TALK_EXTRA, maxRounds: MAX_ROUNDS
      });
    }
    return res.json({ ok: true, anthropic_key_set: !!process.env.ANTHROPIC_API_KEY, model: MODEL });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = req.body || {};
  if (body.part === "copy") {
    const t = P.personaText(String(body.friend || ""), String(body.style || ""), true, String(body.approach || ""));
    if (!t) return res.status(400).json({ error: "unknown_friend" });
    return res.json({ text: t });
  }
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "missing_key", message: "The tool isn't set up yet (missing AI key)." });
  if (limited(req)) return res.status(429).json({ error: "slow_down", message: "That's a lot of chatting for one hour! Take a short break and come back soon." });
  try {
    if (body.part === "chat") return res.json(await chat(body));
    if (body.part === "recap") return res.json(await recap(body));
    return res.status(400).json({ error: "unknown_part" });
  } catch (e) {
    console.error(e);
    const msg = e.userMessage || "Your friend lost their train of thought. Please try again.";
    return res.status(e.status || 502).json({ error: "failed", message: msg });
  }
};

// ---------- helpers ----------
function clip(s, n) { return String(s == null ? "" : s).slice(0, n).trim(); }
function fail(status, message) { const e = new Error(message); e.status = status; e.userMessage = message; return e; }
function limited(req) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x";
  const now = Date.now(), hr = 3600e3;
  const list = (hits.get(ip) || []).filter(t => now - t < hr);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > HOURLY_LIMIT;
}
async function anthropic(body) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("api_" + r.status + " " + t.slice(0, 200)); }
  return r.json();
}
function modelExtras() { return /haiku/i.test(MODEL) ? { thinking: { type: "disabled" } } : {}; }
function textOf(data) { return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim(); }
function cleanHistory(h) {
  return (Array.isArray(h) ? h : []).slice(-40).map(m => ({
    role: m && m.role === "user" ? "user" : "friend",
    style: clip(m && m.style, 20),
    round: Number(m && m.round) || 0,
    text: clip(m && m.text, 1500)
  })).filter(m => m.text);
}
function pickStyles(list, mode) {
  const ids = (Array.isArray(list) ? list : []).map(String).filter((s, i, a) => P.styleById(s) && a.indexOf(s) === i);
  if (!ids.length) throw fail(400, "Pick a style first.");
  return mode === "round" ? ids.slice(0, 3) : ids.slice(0, 1);
}

// ---------- chat ----------
async function chat(body) {
  const mode = body.mode === "round" ? "round" : "one";
  const f = P.friendById(String(body.friend || ""));
  if (!f) throw fail(400, "Pick a friend first.");
  const styles = pickStyles(body.styles, mode);
  const history = cleanHistory(body.history);
  const userText = clip(body.userText, 1500);
  const recapText = clip(body.recap, 1200);
  const recapLine = recapText ? `\nEARLIER CONVERSATION (the person saved it and came back to continue): ${recapText}\nWelcome them back warmly in your first reply and pick up from there.` : "";

  if (mode === "one") {
    const talk = P.sectionOf(f) === "talk";
    const max = talk ? TALK_REPLIES + (body.extended ? TALK_EXTRA : 0) : MAX_REPLIES;
    const used = history.filter(m => m.role === "friend").length;
    if (used >= max) throw fail(400, "This chat is complete. Download it, take this friend with you, or start a new chat.");
    if (!userText) throw fail(400, "Type a message first.");
    // The final reply wraps up. A "just talk" chat at reply 8 doesn't wrap up yet, since the visitor may keep going.
    const last = used === max - 1 && !(talk && !body.extended);
    const system = P.personaText(f.id, styles[0], false, String(body.approach || "")) + recapLine +
      (last ? `\nTHIS IS YOUR LAST REPLY IN THIS CHAT: answer their message, then wrap up warmly with a short recap of what you talked about and one next step. Do not end with a question.` : "");
    const messages = [];
    for (const m of history) push(messages, m.role === "user" ? "user" : "assistant", m.text);
    push(messages, "user", userText);
    if (messages[0].role !== "user") messages.unshift({ role: "user", content: "(The chat begins.)" });
    const data = await anthropic({ model: MODEL, max_tokens: 500, system, ...modelExtras(), messages });
    const reply = textOf(data);
    if (!reply) throw new Error("empty");
    const reached = used + 1 >= max;
    const offerMore = reached && talk && !body.extended;
    return { replies: [{ style: styles[0], text: reply }], used: used + 1, max, done: reached && !offerMore, offerMore };
  }

  // Roundtable: every chosen style answers in one AI call, and they react to each other.
  const rounds = history.reduce((n, m) => Math.max(n, m.round || 0), 0);
  if (rounds >= MAX_ROUNDS) throw fail(400, "This Roundtable is complete. Download it, take a friend with you, or start a new one.");
  if (!userText && !history.length) throw fail(400, "Ask the table a question first.");
  const last = rounds === MAX_ROUNDS - 1;
  const seats = styles.map(id => { const s = P.styleById(id); return `- "${s.id}" = ${s.name}: ${s.voice.replace(/^STYLE: [^.]+\.\s*/, "")}`; }).join("\n");
  const system = `You run a Roundtable at "The Corner Café" (${P.CREDIT}). ${styles.length} versions of the same AI friend, "${f.name}", sit at a café table with the person and talk it through together.
WHAT THIS FRIEND DOES: ${f.focus}
THE SEATS (same friend, different styles):
${seats}
HOW A ROUND WORKS: each seat speaks once, in the order listed. Each line is 2 to 4 sentences. Seats should offer genuinely different angles and alternative opinions, react to each other by style name ("I'd push back on Straight Shooter there..."), and stay friendly. If the person just spoke, answer them directly first. If the person said nothing new, keep the discussion going on its own and go a little deeper.
${last ? "THIS IS THE LAST ROUND: the final seat wraps up with a short recap of where the table landed and one next step for the person." : "The final seat ends with a question for the person."}
${P.RULES}${recapLine}`;
  const transcript = history.map(m => m.role === "user" ? `PERSON: ${m.text}` : `${(P.styleById(m.style) || {}).name || "Friend"}: ${m.text}`).join("\n");
  const ask = (transcript ? `CONVERSATION SO FAR:\n${transcript}\n\n` : "") +
    (userText ? `THE PERSON NOW SAYS: ${userText}` : `The person is listening. Keep the discussion going.`);
  const tool = {
    name: "roundtable_round",
    description: "One round of the Roundtable: each seat's line, in order.",
    input_schema: {
      type: "object",
      properties: { lines: { type: "array", items: { type: "object", properties: { style: { type: "string", enum: styles }, text: { type: "string" } }, required: ["style", "text"] } } },
      required: ["lines"]
    }
  };
  const data = await anthropic({ model: MODEL, max_tokens: 1200, system, ...modelExtras(), tools: [tool], tool_choice: { type: "tool", name: tool.name }, messages: [{ role: "user", content: ask }] });
  const block = (data.content || []).find(b => b.type === "tool_use");
  let lines = block && block.input && Array.isArray(block.input.lines) ? block.input.lines : [];
  lines = lines.filter(l => l && styles.includes(l.style) && clip(l.text, 2000)).map(l => ({ style: l.style, text: clip(l.text, 2000) }));
  if (!lines.length) throw new Error("bad_round");
  return { replies: lines, round: rounds + 1, done: rounds + 1 >= MAX_ROUNDS };
}
function push(messages, role, content) {
  const prev = messages[messages.length - 1];
  if (prev && prev.role === role) prev.content += "\n\n" + content; else messages.push({ role, content });
}

// ---------- recap (for continuing a saved chat) ----------
async function recap(body) {
  const f = P.friendById(String(body.friend || ""));
  if (!f) throw fail(400, "That saved chat couldn't be read.");
  const history = cleanHistory(body.history);
  if (!history.length) throw fail(400, "That saved chat is empty.");
  const transcript = history.map(m => m.role === "user" ? `PERSON: ${m.text}` : `${f.name}${m.style ? " (" + ((P.styleById(m.style) || {}).name || "") + ")" : ""}: ${m.text}`).join("\n");
  const data = await anthropic({
    model: MODEL, max_tokens: 300, ...modelExtras(),
    system: "Summarize this chat between a person and an AI friend in 3 to 4 plain sentences: what the person brought up, what was suggested, and where things were left. No names or personal details beyond what's needed.",
    messages: [{ role: "user", content: transcript.slice(0, 12000) }]
  });
  const out = textOf(data);
  if (!out) throw new Error("empty");
  return { recap: clip(out, 1200) };
}

// ---------- website lock ----------
// Only answer this tool's own pages and Paul's websites, so nobody else can run the tool on his credits.
// Add more sites in Vercel with an ALLOWED_SITES setting (comma separated); set LOCK_OFF to 1 to switch the lock off.
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
