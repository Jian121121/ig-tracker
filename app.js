"use strict";
// Follow Back (browser-only). Parses Instagram export files and stores snapshots in IndexedDB.

// ---------- parsing ----------
const USERNAME_RE = /^[a-z0-9._]{1,30}$/;
const HREF_RE = /instagram\.com\/(?:_u\/)?([A-Za-z0-9._]+)/;
const DATE_RE = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))? ?([AaPp][Mm])/;
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
const NOT_RELATIONSHIP_FILES = ["hashtag", "pending", "request", "unfollow", "removed",
  "close_friend", "blocked", "restricted", "suggestion"];

class ParseError extends Error {}

const profileUrl = (u) => `https://www.instagram.com/${u}/`;
const fromHref = (h) => { const m = HREF_RE.exec(h || ""); return m ? m[1].toLowerCase() : ""; };

function makeEntry(name, href, ts) {
  let u = String(name || "").trim().replace(/^@/, "").toLowerCase();
  if (!USERNAME_RE.test(u)) u = fromHref(href);
  if (!u) return null;
  ts = parseInt(ts, 10);
  return { u, t: Number.isFinite(ts) && ts > 0 ? ts : null };
}

function kindHint(name) {
  name = name.toLowerCase();
  if (name.includes("following")) return "following";
  if (name.includes("follower")) return "followers";
  return null;
}

function entryFromItem(item) {
  if (!item || typeof item !== "object") return null;
  const sld = item.string_list_data;
  const d = Array.isArray(sld) && sld[0] && typeof sld[0] === "object" ? sld[0] : {};
  return makeEntry(d.value || item.title, d.href, d.timestamp);
}

function parseJson(name, text, hint) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new ParseError(`${name}: not valid JSON (${e.message}).`); }
  let kind = null, items = null;
  if (Array.isArray(data)) {
    kind = hint || "followers"; items = data;
  } else if (data && typeof data === "object") {
    if (Array.isArray(data.relationships_following)) { kind = "following"; items = data.relationships_following; }
    else if (Array.isArray(data.relationships_followers)) { kind = "followers"; items = data.relationships_followers; }
    else {
      const lists = Object.values(data).filter(Array.isArray);
      if (hint && lists.length === 1) { kind = hint; items = lists[0]; }
    }
  }
  if (!items) {
    const keys = data && typeof data === "object" ? Object.keys(data).slice(0, 5).join(", ") : typeof data;
    throw new ParseError(`${name}: doesn't look like a followers/following export ` +
      `(expected a list or 'relationships_following', found: ${keys}).`);
  }
  if (items.length && !items.some((i) => i && typeof i === "object" && "string_list_data" in i)) {
    throw new ParseError(`${name}: items have no 'string_list_data'; this isn't a followers/following file.`);
  }
  return [kind, items.map(entryFromItem).filter(Boolean)];
}

function parseHtmlDate(text) {
  const m = DATE_RE.exec(text || "");
  if (!m) return null;
  const idx = MONTHS.indexOf(m[1]);
  if (idx < 0 || idx % 3) return null;
  let h = +m[4] % 12;
  if (/p/i.test(m[7])) h += 12;
  // Export times are treated as Manila time (UTC+8).
  return Math.floor(Date.UTC(+m[3], idx / 3, +m[2], h - 8, +m[5], +(m[6] || 0)) / 1000);
}

function parseHtml(name, text, hint) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const kind = hint || kindHint(doc.title || "");
  if (!kind) {
    throw new ParseError(`${name}: can't tell if this HTML is followers or following. ` +
      "Keep the original file name (followers_1.html / following.html).");
  }
  const entries = [...doc.querySelectorAll('a[href*="instagram.com/"]')].map((a) => {
    const box = a.parentElement?.parentElement || a.parentElement;
    return makeEntry(a.textContent, a.getAttribute("href"), parseHtmlDate(box?.textContent));
  }).filter(Boolean);
  return [kind, entries];
}

function parseFile(name, text) {
  const low = name.toLowerCase();
  if (NOT_RELATIONSHIP_FILES.some((w) => low.includes(w))) {
    throw new ParseError(`${name}: this is not a followers/following list. Use followers_1.json and following.json.`);
  }
  const hint = kindHint(low);
  text = text.replace(/^\uFEFF/, "");
  const head = text.trimStart().slice(0, 2000).toLowerCase();
  let result;
  if (head.startsWith("{") || head.startsWith("[")) result = parseJson(name, text, hint);
  else if (head.includes("<html") || head.includes("<!doctype") || /\.html?$/.test(low)) result = parseHtml(name, text, hint);
  else throw new ParseError(`${name}: unsupported file. Use the JSON or HTML export files.`);
  if (!result[1].length) throw new ParseError(`${name}: no accounts found in this file.`);
  return result;
}

// ---------- storage (IndexedDB + localStorage, stays in this browser) ----------
const DB = {
  _db: null,
  open() {
    return (this._db ||= new Promise((resolve, reject) => {
      const req = indexedDB.open("ig-tracker", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("snapshots", { keyPath: "id", autoIncrement: true });
        req.result.createObjectStore("handled", { keyPath: "u" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  },
  async run(store, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  },
  all: (s) => DB.run(s, "readonly", (st) => st.getAll()),
  put: (s, v) => DB.run(s, "readwrite", (st) => st.put(v)),
  del: (s, k) => DB.run(s, "readwrite", (st) => st.delete(k)),
  clear: (s) => DB.run(s, "readwrite", (st) => st.clear()),
};
const Prefs = {
  get: (k) => { try { return localStorage.getItem(`fb-${k}`) || ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem(`fb-${k}`, v); } catch { /* storage blocked */ } },
};

// ---------- zip (Instagram export) ----------
const ZIP_WANTED = /^(followers(_\d+)?|following)\.(json|html?)$/i;

async function inflateRaw(data) {
  if (typeof DecompressionStream === "undefined") {
    throw new ParseError("This browser can't open zip files. Unzip it first, then select followers_1.json and following.json.");
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ParseError(`${file.name}: this doesn't look like a valid zip file.`);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let n = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen)).split("/").pop();
    p += 46 + nameLen + extraLen + commentLen;
    if (!ZIP_WANTED.test(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = buf.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new ParseError(`${name}: unsupported compression inside the zip.`);
    out.push({ name, text: dec.decode(method === 8 ? await inflateRaw(data) : data) });
  }
  if (!out.length) {
    throw new ParseError(`${file.name}: no followers or following files inside. ` +
      "When downloading from Instagram, make sure \"Followers and following\" is ticked.");
  }
  return out;
}

// ---------- comparisons ----------
const toMap = (list) => new Map(list.map((e) => [e.u, e]));
const newestFirst = (rows, key = "t") => rows.sort((a, b) => (b[key] || 0) - (a[key] || 0) || a.u.localeCompare(b.u));
const oldestFirst = () => [...state.snapshots].sort((a, b) => a.id - b.id);

function notBack(cur) {
  const followers = toMap(cur.followers);
  return newestFirst(cur.following.filter((e) => !followers.has(e.u)));
}
function mutual(cur) {
  const following = toMap(cur.following);
  return newestFirst(cur.followers.filter((e) => following.has(e.u)));
}
function fans(cur) {
  const following = toMap(cur.following);
  return newestFirst(cur.followers.filter((e) => !following.has(e.u)));
}
const latest = (cur, kind) => newestFirst([...cur[kind]]);
function followerDiff(a, b) {
  const A = toMap(a.followers), B = toMap(b.followers);
  return [newestFirst(b.followers.filter((e) => !A.has(e.u))), newestFirst(a.followers.filter((e) => !B.has(e.u)))];
}

/** Every follower that disappeared between consecutive uploads, newest first. */
function unfollowHistory() {
  const snaps = oldestFirst();
  const stillFollow = toMap(snaps.at(-1)?.following || []);
  const events = [];
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1], cur = snaps[i], now = toMap(cur.followers);
    for (const e of prev.followers) {
      if (!now.has(e.u)) events.push({ u: e.u, t: e.t, since: prev.created, detected: cur.created, still: stillFollow.has(e.u) });
    }
  }
  return newestFirst(events, "detected");
}

// ---------- helpers ----------
const MNL = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", year: "numeric", month: "short",
  day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
const MNL_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", year: "numeric", month: "short", day: "numeric" });
const MNL_SHORT = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric" });
const fmtTs = (ts) => MNL.format(new Date(ts * 1000));
const fmtDay = (ts) => MNL_DAY.format(new Date(ts * 1000));
const fmtShort = (ts) => MNL_SHORT.format(new Date(ts * 1000));
const when = (prefix, ts) => (ts ? `${prefix} ${fmtTs(ts)}` : `${prefix} (date not in export)`);
function stamp() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
}
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (u) => (u.replace(/[^a-z0-9]/g, "").slice(0, 2) || u.slice(0, 2) || "IG").toUpperCase();
const hue = (u) => [...u].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 8;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const DOWNLOAD_URL = "https://accountscenter.instagram.com/info_and_permissions/dyi/";
const ICONS = {
  unfollow: '<path d="M15 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M8.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM17 8h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  swap: '<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

// ---------- lists ----------
const LISTS = {
  unfollowed: { label: "Unfollowers", desc: "People who stopped following you, found by comparing all your uploads.",
    sub: (r) => `Unfollowed between ${fmtShort(r.since)} and ${fmtDay(r.detected)}`, key: "detected",
    empty: "No unfollowers found between your uploads.", handle: true },
  notback: { label: "Don't follow you back", desc: "You follow them, but they don't follow you.",
    sub: (r) => when("You followed", r.t), empty: "Everyone you follow follows you back.", handle: true },
  followers: { label: "New followers", desc: "Everyone who follows you, newest first.",
    sub: (r) => when("Followed you", r.t), empty: "No followers found." },
  following: { label: "New following", desc: "Everyone you follow, newest first.",
    sub: (r) => when("You followed", r.t), empty: "You don't follow anyone." },
  mutual: { label: "Mutual", desc: "You follow each other.", sub: (r) => when("Followed you", r.t), empty: "No mutual follows yet." },
  fans: { label: "You don't follow back", desc: "They follow you, but you don't follow them.",
    sub: (r) => when("Followed you", r.t), empty: "You follow back everyone who follows you." },
  new: { label: "Compare: gained", desc: "People who started following you between two uploads.",
    sub: (r) => when("Followed you", r.t), empty: "No new followers between these uploads.", compare: true },
  lost: { label: "Compare: lost", desc: "People who stopped following you between two uploads.",
    sub: (r) => when("Had followed you", r.t), empty: "Nobody stopped following you between these uploads.", compare: true },
};
const freshFilters = () => ({ q: "", days: "", hide: false, still: true, a: state.f?.a ?? null, b: state.f?.b ?? null });

// ---------- state ----------
const state = { snapshots: [], handled: new Set(), view: null, list: "unfollowed", f: null, flash: [], user: Prefs.get("user") };
state.f = freshFilters();
const byId = (id) => state.snapshots.find((s) => s.id === id);
const flash = (msg, kind = "ok") => state.flash.push([kind, msg]);

async function load() {
  state.snapshots = (await DB.all("snapshots")).sort((a, b) => b.id - a.id);
  state.handled = new Set((await DB.all("handled")).map((h) => h.u));
  if (!byId(state.f.a)) state.f.a = null;
  if (!byId(state.f.b)) state.f.b = null;
}

function buildList(name) {
  const [cur, prev] = state.snapshots, f = state.f, meta = LISTS[name];
  const v = { name, ...meta, key: meta.key || "t", rows: [], info: "" };
  if (!cur) return v;
  if (name === "unfollowed") {
    if (!prev) v.info = "Unfollowers show up after your second upload. Download a fresh export in a week or so and add it here.";
    else v.rows = unfollowHistory();
  } else if (name === "notback") v.rows = notBack(cur);
  else if (name === "mutual") v.rows = mutual(cur);
  else if (name === "fans") v.rows = fans(cur);
  else if (name === "followers" || name === "following") v.rows = latest(cur, name);
  else {
    const a = byId(f.a ?? prev?.id), b = byId(f.b ?? cur.id);
    if (!a || !b) v.info = "Comparing needs at least two uploads.";
    else { const [gained, lost] = followerDiff(a, b); v.rows = name === "new" ? gained : lost; }
  }
  if (name === "unfollowed" && f.still) v.rows = v.rows.filter((r) => r.still);
  v.total = v.rows.length;
  const q = (f.q || "").trim().toLowerCase().replace(/^@/, "");
  if (q) v.rows = v.rows.filter((r) => r.u.includes(q));
  if (f.days) {
    const cutoff = Date.now() / 1000 - Number(f.days) * 86400;
    v.rows = v.rows.filter((r) => r[v.key] && r[v.key] >= cutoff);
  }
  if (f.hide && v.handle) v.rows = v.rows.filter((r) => !state.handled.has(r.u));
  return v;
}

// ---------- rendering ----------
function renderNav() {
  const has = state.snapshots.length > 0;
  const link = (hash, label, view) => `<a href="#${hash}" class="${state.view === view ? "active" : ""}">${label}</a>`;
  $("#nav").innerHTML = has
    ? `${link("", "Results", "home")}${link("uploads", "Uploads", "uploads")}${link("help", "Help", "help")}
       ${state.user ? `<span class="chip-user">@${esc(state.user)}</span>` : ""}`
    : `<button class="nav-btn" data-scroll="how">How it works</button><button class="nav-btn" data-scroll="faq">FAQ</button>`;
}

function render() {
  const has = state.snapshots.length > 0;
  renderNav();
  const flashes = state.flash.map(([k, m]) => `<div class="notice ${k}">${esc(m)}</div>`).join("");
  state.flash = [];
  let body;
  if (state.view === "help") body = helpHtml();
  else if (!has) body = landingHtml();
  else if (state.view === "uploads") body = uploadsHtml();
  else body = dashboardHtml();
  $("#main").innerHTML = flashes + body;
  document.querySelectorAll("[data-w]").forEach((el) => { el.style.width = `${el.dataset.w}%`; });
  if (has && state.view === "home") renderList();
}

function usernameField(id = "uname") {
  return `<div class="field">
    <span class="field-prefix">@</span>
    <input id="${id}" class="uname" type="text" autocomplete="username" spellcheck="false" autocapitalize="none"
      placeholder="yourusername" value="${esc(state.user)}" maxlength="30" aria-label="Instagram username">
  </div>`;
}

function dropHtml() {
  return `<label class="drop" id="drop">
    <input type="file" id="files" multiple accept=".zip,.json,.html,.htm,application/zip" hidden>
    <svg class="drop-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-5 5m5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>
    <strong id="drop-title">Drop your Instagram zip here</strong>
    <span>or click to choose it. No need to unzip. The JSON files work too.</span>
  </label>`;
}

function stepsHtml() {
  return `<section id="how" class="section">
    <h2 class="section-title">How it works in 3 steps</h2>
    <ol class="steps">
      <li class="card step">
        <span class="num">1</span>
        <div class="step-body">
          <h3>Enter your username</h3>
          <p class="muted">Used to label your results. Saved on this device only.</p>
          ${usernameField("uname-step")}
        </div>
      </li>
      <li class="card step">
        <span class="num">2</span>
        <div class="step-body">
          <h3>Download your followers from Instagram</h3>
          <p class="muted">It's free, official, and usually ready within minutes.</p>
          <a class="btn" href="${DOWNLOAD_URL}" target="_blank" rel="noopener noreferrer">Open Instagram's download page</a>
          <ul class="checklist">
            <li>Choose <b>Download or transfer information</b>, then <b>Some of your information</b>.</li>
            <li>Tick only <b>Followers and following</b>.</li>
            <li>Pick <b>Download to device</b>, format <b>JSON</b>, date range <b>All time</b>.</li>
          </ul>
        </div>
      </li>
      <li class="card step">
        <span class="num">3</span>
        <div class="step-body">
          <h3>Drop the zip here</h3>
          <p class="muted">Your results appear instantly. Add a fresh export every week to catch unfollowers.</p>
          ${dropHtml()}
          <p class="center"><button id="sample" class="btn-link">No file yet? Try it with sample data</button></p>
        </div>
      </li>
    </ol>
  </section>`;
}

function featuresHtml() {
  const f = (ic, title, text) => `<div class="card feature">${icon(ic)}<h3>${title}</h3><p class="muted">${text}</p></div>`;
  return `<section class="section">
    <h2 class="section-title">Everything Instagram doesn't tell you</h2>
    <div class="features">
      ${f("unfollow", "Unfollower history", "Instagram never notifies you. Every upload is compared with the last, so you see who left and when.")}
      ${f("swap", "Who doesn't follow back", "One list of everyone you follow who doesn't follow you, ready to clean up.")}
      ${f("clock", "Newest first", "Followers and following sorted by date, so you see who just followed you.")}
      ${f("lock", "Private by design", "No login and no servers. Your file is read in your browser and never leaves your device.")}
    </div>
  </section>`;
}

function compareHtml() {
  const rows = [
    ["Spot unfollowers", "Listed with dates", "Instagram never tells you", "Yes"],
    ["Who doesn't follow back", "One tap", "Compare two lists by hand", "Yes"],
    ["Newest first", "Yes", "No longer shown", "Yes"],
    ["Risk to your account", "None. It never touches Instagram", "None", "Relies on scraping, which breaks Instagram's rules"],
    ["Where your data goes", "Stays on your device", "Nowhere", "Their servers"],
    ["Cost", "Free", "Free", "Usually a subscription"],
  ];
  return `<section class="section">
    <h2 class="section-title">How it compares</h2>
    <div class="card table-card">
      <div class="table-scroll"><table class="compare">
        <thead><tr><th></th><th class="us">Follow Back</th><th>Checking Instagram manually</th><th>Username lookup apps</th></tr></thead>
        <tbody>${rows.map(([a, b, c, d]) => `<tr><th scope="row">${a}</th><td class="us">${b}</td><td>${c}</td><td>${d}</td></tr>`).join("")}</tbody>
      </table></div>
    </div>
  </section>`;
}

function faqHtml() {
  const qa = [
    ["Is this safe for my Instagram account?", "Yes. Follow Back never logs in to Instagram and never touches your account. It only reads the file Instagram gives you."],
    ["Why do I need to download my data?", "Instagram doesn't let any app read follower lists. Apps that work from just a username use fake accounts and scraping, which breaks Instagram's rules. Your official download is the only safe and accurate source."],
    ["How does it find unfollowers?", "Every upload is saved as a snapshot. When someone is in an older snapshot but missing from a newer one, they appear under Unfollowers with the dates in between."],
    ["Can I check someone else's account?", "No. Instagram only lets each person download their own data. Friends can use Follow Back on their own phone for their own account."],
    ["Where is my data stored?", "Only in this browser on this device. Nothing is uploaded, and the site blocks all network requests. You can delete everything anytime from Uploads."],
    ["How often should I upload?", "About once a week works well. The more often you upload, the more precisely you'll know when someone unfollowed."],
    ["Why does someone show as unfollowed when they didn't?", "Deactivated or temporarily disabled accounts drop off your followers list, and a username change looks like an unfollow plus a new follower. Check their profile before acting."],
  ];
  return `<section id="faq" class="section">
    <h2 class="section-title">Frequently asked questions</h2>
    <div class="card faq">${qa.map(([q, a]) => `<details><summary>${q}</summary><p class="muted">${a}</p></details>`).join("")}</div>
  </section>`;
}

function landingHtml() {
  return `<section class="hero">
      <p class="eyebrow-pill">Free · No login · Nothing uploaded</p>
      <h1>Instagram follower tracker<br><span class="accent">for your own account</span></h1>
      <p class="lead">See who unfollowed you, who doesn't follow you back, and your newest followers, sorted newest first.</p>
      <form id="start" class="hero-form" autocomplete="off">
        ${usernameField()}
        <button class="btn btn-lg" type="submit">Get started</button>
      </form>
      <p class="muted small">Works with Instagram's official data download. Your account is never at risk.</p>
    </section>
    ${stepsHtml()}
    ${featuresHtml()}
    ${compareHtml()}
    ${faqHtml()}`;
}

function helpHtml() {
  return `<section class="hello"><div><h1>Help</h1>
    <p class="lead">How Follow Back works, and answers to common questions.</p></div></section>
    ${stepsHtml()}${compareHtml()}${faqHtml()}`;
}

function chartHtml() {
  const snaps = oldestFirst();
  if (snaps.length < 2) return `<div class="empty">Your growth chart appears after your second upload.</div>`;
  const series = [["followers", "Followers", (s) => s.followers.length], ["following", "Following", (s) => s.following.length],
    ["mutual", "Mutual", (s) => mutual(s).length]];
  const W = 640, H = 220, L = 44, R = 16, T = 14, B = 30;
  const values = series.flatMap(([, , fn]) => snaps.map(fn));
  let lo = Math.min(...values), hi = Math.max(...values);
  const pad = Math.max(1, Math.ceil((hi - lo) * 0.15));
  lo = Math.max(0, lo - pad); hi += pad;
  const x = (i) => L + (i * (W - L - R)) / (snaps.length - 1);
  const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const ticks = [0, 1, 2, 3, 4].map((k) => Math.round(lo + (k * (hi - lo)) / 4));
  const grid = ticks.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>
    <text class="ax" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join("");
  const labelIdx = [...new Set([0, Math.floor((snaps.length - 1) / 2), snaps.length - 1])];
  const xl = labelIdx.map((i) => `<text class="ax" x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === snaps.length - 1 ? "end" : "middle"}">${fmtShort(snaps[i].created)}</text>`).join("");
  const lines = series.map(([k, label, fn]) => {
    const pts = snaps.map((s, i) => [x(i), y(fn(s)), fn(s), s]);
    return `<polyline class="ln ln-${k}" points="${pts.map(([px, py]) => `${px},${py}`).join(" ")}"/>` +
      pts.map(([px, py, v, s]) => `<circle class="pt pt-${k}" cx="${px}" cy="${py}" r="4"><title>${label}: ${v} (${fmtDay(s.created)})</title></circle>`).join("");
  }).join("");
  const last = snaps.at(-1), first = snaps[0];
  const delta = (fn) => { const d = fn(last) - fn(first); return `<b class="${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${d}</b>`; };
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Followers, following and mutual over time">${grid}${xl}${lines}</svg>
    <div class="legend">${series.map(([k, label, fn]) => `<span><i class="dot dot-${k}"></i>${label} ${delta(fn)}</span>`).join("")}
      <span class="muted small">since ${fmtDay(first.created)}</span></div>`;
}

function dashboardHtml() {
  const [cur] = state.snapshots;
  const nb = notBack(cur).length, mu = mutual(cur).length, fa = fans(cur).length;
  const hist = state.snapshots.length > 1 ? unfollowHistory().filter((r) => r.still).length : null;
  const month = Date.now() / 1000 - 30 * 86400;
  const newF = cur.followers.filter((e) => e.t && e.t >= month).length;
  const newG = cur.following.filter((e) => e.t && e.t >= month).length;
  const total = nb + mu + fa || 1;
  const pct = (n) => (n ? Math.max(2, Math.round((n / total) * 100)) : 0);
  const tile = (key, label, value, tone = "") => `<button class="tile ${tone} ${state.list === key ? "selected" : ""}" data-list="${key}">
    <span class="tile-value">${value ?? "-"}</span><span class="tile-label">${label}</span></button>`;
  const name = state.user || "your account";
  return `<section class="card profile">
      <span class="avatar xl av${hue(name)}" aria-hidden="true">${initials(name)}</span>
      <div class="profile-main">
        <h1>${state.user ? `@${esc(state.user)}` : "Your account"}</h1>
        <div class="profile-stats">
          <button data-list="followers"><b>${cur.followers.length}</b> followers</button>
          <button data-list="following"><b>${cur.following.length}</b> following</button>
          <button data-list="mutual"><b>${mu}</b> mutual</button>
        </div>
        <p class="muted small">Last upload ${fmtDay(cur.created)} · ${plural(state.snapshots.length, "upload")}</p>
      </div>
      <a class="btn ghost" href="#uploads">Add newer export</a>
    </section>

    <section class="tiles">
      ${tile("unfollowed", "Unfollowed you", hist, "alert")}
      ${tile("notback", "Don't follow you back", nb, "warn")}
      ${tile("followers", "New followers (30 days)", newF, "good")}
      ${tile("following", "New following (30 days)", newG)}
    </section>

    <section class="card panel" id="panel"></section>

    <div class="two-col">
      <section class="card match">
        <h2>Follow match</h2>
        <p class="muted small">How your followers and following overlap.</p>
        <div class="bar" role="img" aria-label="${mu} mutual, ${nb} don't follow you back, ${fa} you don't follow back">
          <span class="seg seg-mutual" data-w="${pct(mu)}"></span>
          <span class="seg seg-notback" data-w="${pct(nb)}"></span>
          <span class="seg seg-fans" data-w="${pct(fa)}"></span>
        </div>
        <div class="legend stack">
          <button data-list="mutual"><i class="dot dot-mutual"></i><b>${mu}</b> mutual</button>
          <button data-list="notback"><i class="dot dot-notback"></i><b>${nb}</b> don't follow you back</button>
          <button data-list="fans"><i class="dot dot-fans"></i><b>${fa}</b> you don't follow back</button>
        </div>
      </section>
      <section class="card growth">
        <h2>Growth</h2>
        <p class="muted small">Followers, following and mutuals across your uploads.</p>
        ${chartHtml()}
      </section>
    </div>`;
}

function renderList() {
  const v = buildList(state.list), f = state.f, [cur, prev] = state.snapshots;
  const tabs = Object.entries(LISTS).map(([k, m]) =>
    `<button class="tab ${k === v.name ? "active" : ""}" data-list="${k}" role="tab" aria-selected="${k === v.name}">${m.label}</button>`).join("");
  const opts = (sel) => state.snapshots.map((s) =>
    `<option value="${s.id}" ${s.id === sel ? "selected" : ""}>Upload ${s.id} · ${fmtDay(s.created)}</option>`).join("");
  $("#panel").innerHTML = `
    <div class="tabs" role="tablist">${tabs}</div>
    <div class="panel-head">
      <div>
        <h2>${v.label} <span class="count">${v.total ?? 0}</span></h2>
        <p class="muted">${v.desc}</p>
      </div>
      <button id="export" class="btn ghost small">Download CSV</button>
    </div>
    <div class="toolbar">
      ${v.compare ? `<label class="select-label">From <select id="fa">${opts(f.a ?? prev?.id)}</select></label>
        <label class="select-label">To <select id="fb">${opts(f.b ?? cur?.id)}</select></label>` : ""}
      <input type="search" id="fq" placeholder="Search username" value="${esc(f.q || "")}" autocomplete="off">
      <select id="fdays" aria-label="Time range"><option value="">Any time</option>${[7, 30, 90].map((d) =>
        `<option value="${d}" ${String(d) === f.days ? "selected" : ""}>Last ${d} days</option>`).join("")}</select>
      ${v.name === "unfollowed" ? `<label class="toggle"><input type="checkbox" id="fstill" ${f.still ? "checked" : ""}><span>Only people I still follow</span></label>` : ""}
      ${v.handle ? `<label class="toggle"><input type="checkbox" id="fhide" ${f.hide ? "checked" : ""}><span>Hide done</span></label>` : ""}
    </div>
    ${v.name === "unfollowed" && v.rows.length ? `<div class="notice soft">Deactivated accounts and username changes also
      show up here, so check their profile before unfollowing.</div>` : ""}
    <div id="rows"></div>`;
  renderRows(v);
}

function renderRows(v = buildList(state.list)) {
  const box = $("#rows");
  if (!box) return;
  $("#panel .count").textContent = v.total ?? 0;
  if (v.info) { box.innerHTML = `<div class="empty">${esc(v.info)}</div>`; return; }
  if (!v.rows.length) {
    box.innerHTML = `<div class="empty">${v.total ? "No matches for these filters." : esc(v.empty)}</div>`;
    return;
  }
  box.innerHTML = `<ul class="people">${v.rows.map((r) => {
    const done = v.handle && state.handled.has(r.u);
    const tag = v.name === "unfollowed" ? (r.still ? `<span class="tag warn">You still follow</span>` : `<span class="tag">You don't follow</span>`) : "";
    return `<li class="person ${done ? "done" : ""}">
      <span class="avatar av${hue(r.u)}" aria-hidden="true">${initials(r.u)}</span>
      <div class="person-info">
        <span class="person-name"><a href="${profileUrl(r.u)}" target="_blank" rel="noopener noreferrer">@${esc(r.u)}</a>${tag}</span>
        <span class="muted small">${v.sub(r)}</span>
      </div>
      ${v.handle ? `<button class="btn small ${done ? "ghost" : "soft"}" data-handle="${esc(r.u)}">${done ? "Undo" : "Mark done"}</button>` : ""}
    </li>`;
  }).join("")}</ul>`;
}

function uploadsHtml() {
  const snaps = oldestFirst();
  const rows = snaps.map((s, i) => {
    const prev = snaps[i - 1];
    const change = prev ? (() => { const [g, l] = followerDiff(prev, s); return `<span class="up">+${g.length}</span> / <span class="down">-${l.length}</span>`; })() : `<span class="muted">first upload</span>`;
    return `<li class="upload-row">
      <div>
        <strong>Upload ${s.id}</strong>${i === snaps.length - 1 ? ` <span class="tag good">Latest</span>` : ""}
        <span class="muted small block">${fmtTs(s.created)}</span>
      </div>
      <span class="small">${plural(s.followers.length, "follower")} · ${s.following.length} following</span>
      <span class="small">${change}</span>
      <button class="btn ghost small" data-del="${s.id}">Delete</button>
    </li>`;
  }).reverse().join("");
  return `<section class="hello"><div><h1>Uploads</h1>
      <p class="lead">Each export becomes a snapshot. Unfollowers are found by comparing them.</p></div></section>
    <section class="card">
      <h2>Add a newer export</h2>
      <p class="muted">Download a fresh copy from <a href="${DOWNLOAD_URL}" target="_blank" rel="noopener noreferrer">Instagram's download page</a>, then drop the zip here.</p>
      ${dropHtml()}
    </section>
    <section class="card">
      <h2>Your username</h2>
      ${usernameField()}
    </section>
    <section class="card">
      <h2>Snapshots</h2>
      ${rows ? `<ul class="uploads">${rows}</ul>
        <p><button id="wipe" class="btn-link danger">Delete all data from this device</button></p>`
        : `<div class="empty">No uploads yet.</div>`}
    </section>`;
}

// ---------- actions ----------
async function saveSnapshot(files) {
  const followers = [], following = [], errors = [];
  for (const f of files) {
    try {
      const [kind, rows] = parseFile(f.name, f.text);
      const target = kind === "followers" ? followers : following;
      for (const r of rows) target.push(r);
    } catch (e) {
      errors.push(e instanceof ParseError ? e.message : `${f.name}: ${e.message}`);
    }
  }
  if (!errors.length && !followers.length) errors.push("The followers file is missing. Add followers_1.json too, or drop the whole zip.");
  if (!errors.length && !following.length) errors.push("The following file is missing. Add following.json too, or drop the whole zip.");
  if (errors.length) {
    errors.forEach((m) => flash(m, "error"));
    flash("Nothing was saved. Drop the whole Instagram zip, or select both files together.", "error");
    render();
    return false;
  }
  const dedupe = (list) => [...toMap(list).values()];
  const snap = { created: Math.floor(Date.now() / 1000), followers: dedupe(followers), following: dedupe(following) };
  const id = await DB.put("snapshots", snap);
  await load();
  flash(`Upload ${id} saved: ${plural(snap.followers.length, "follower")}, ${snap.following.length} following.`);
  state.list = state.snapshots.length > 1 ? "unfollowed" : "notback";
  state.f = freshFilters();
  if (location.hash) location.hash = "";
  state.view = "home";
  render();
  return true;
}

async function addFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const title = $("#drop-title");
  if (title) { title.textContent = "Reading your file..."; $("#drop").classList.add("busy"); }
  const out = [];
  try {
    for (const f of files) {
      if (/\.zip$/i.test(f.name) || /zip/.test(f.type)) out.push(...(await readZip(f)));
      else out.push({ name: f.name, text: await f.text() });
    }
  } catch (e) {
    flash(e instanceof ParseError ? e.message : `Couldn't read the file: ${e.message}`, "error");
    render();
    return;
  }
  const hasJson = out.some((f) => /\.json$/i.test(f.name));
  await saveSnapshot(hasJson ? out.filter((f) => !/\.html?$/i.test(f.name)) : out);
}

async function uploadSample() {
  for (const set of SAMPLE_EXPORTS) if (!(await saveSnapshot(set))) return;
}

function exportCsv() {
  const v = buildList(state.list);
  const cell = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const head = ["username", "profile_url", "details (Manila time)", ...(v.handle ? ["done"] : [])];
  const lines = [head.map(cell).join(",")];
  for (const r of v.rows) {
    lines.push([r.u, profileUrl(r.u), v.sub(r), ...(v.handle ? [state.handled.has(r.u) ? "yes" : "no"] : [])].map(cell).join(","));
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv" }));
  a.download = `${v.name}_${stamp()}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function setUser(value) {
  state.user = value.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 30);
  Prefs.set("user", state.user);
  document.querySelectorAll(".uname").forEach((el) => { if (el.value !== state.user && document.activeElement !== el) el.value = state.user; });
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("button");
  if (!el) return;
  if (el.dataset.scroll) {
    document.getElementById(el.dataset.scroll)?.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (el.dataset.list) {
    state.list = el.dataset.list;
    state.f = freshFilters();
    if (state.view !== "home") { location.hash = ""; return; }
    document.querySelectorAll(".tile").forEach((t) => t.classList.toggle("selected", t.dataset.list === state.list));
    renderList();
    if (!el.classList.contains("tab")) $("#panel").scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (el.dataset.handle) {
    const u = el.dataset.handle;
    if (state.handled.has(u)) { await DB.del("handled", u); state.handled.delete(u); }
    else { await DB.put("handled", { u, at: Date.now() }); state.handled.add(u); }
    renderRows();
  } else if (el.dataset.del) {
    const id = Number(el.dataset.del);
    if (confirm(`Delete upload ${id}?`)) { await DB.del("snapshots", id); await load(); flash(`Upload ${id} deleted.`); render(); }
  } else if (el.id === "sample") await uploadSample();
  else if (el.id === "export") exportCsv();
  else if (el.id === "wipe" && confirm("Delete all uploads and marks from this device?")) {
    await DB.clear("snapshots"); await DB.clear("handled"); await load(); flash("All data deleted."); render();
  }
});

document.addEventListener("submit", (e) => {
  if (e.target.id !== "start") return;
  e.preventDefault();
  setUser($("#uname").value);
  document.getElementById("how")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

document.addEventListener("input", (e) => {
  if (e.target.id === "fq") { state.f.q = e.target.value; renderRows(); }
  else if (e.target.classList.contains("uname")) setUser(e.target.value);
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "files") { addFiles(t.files); return; }
  if (t.classList.contains("uname")) { renderNav(); return; }
  if (t.id === "fdays") state.f.days = t.value;
  else if (t.id === "fhide") state.f.hide = t.checked;
  else if (t.id === "fstill") state.f.still = t.checked;
  else if (t.id === "fa" || t.id === "fb") state.f[t.id === "fa" ? "a" : "b"] = Number(t.value);
  else return;
  renderRows();
});

["dragenter", "dragover"].forEach((type) => document.addEventListener(type, (e) => {
  const drop = e.target.closest?.(".drop");
  if (drop) { e.preventDefault(); drop.classList.add("over"); }
}));
document.addEventListener("dragleave", (e) => e.target.closest?.(".drop")?.classList.remove("over"));
document.addEventListener("drop", (e) => {
  const drop = e.target.closest?.(".drop");
  if (!drop) return;
  e.preventDefault();
  drop.classList.remove("over");
  addFiles(e.dataTransfer.files);
});

function route() {
  const h = location.hash.slice(1);
  if (h in LISTS) { state.list = h; state.view = "home"; }
  else state.view = ["uploads", "help"].includes(h) ? h : "home";
  render();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

(async () => {
  try { await load(); }
  catch { flash("This browser is blocking storage (private mode?), so uploads can't be saved.", "error"); }
  route();
})();
