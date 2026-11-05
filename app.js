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

// ---------- comparisons ----------
const toMap = (list) => new Map(list.map((e) => [e.u, e]));
const newestFirst = (rows) => rows.sort((a, b) => (b.t || 0) - (a.t || 0) || a.u.localeCompare(b.u));

function unfollowedMe(prev, cur) {
  const now = toMap(cur.followers), following = toMap(cur.following);
  return prev.followers.filter((e) => !now.has(e.u) && following.has(e.u))
    .map((e) => ({ ...following.get(e.u), detected: cur.created }))
    .sort((a, b) => a.u.localeCompare(b.u));
}
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

// ---------- helpers ----------
const MNL = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", year: "numeric", month: "short",
  day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
const MNL_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", year: "numeric", month: "short", day: "numeric" });
const fmtTs = (ts) => (ts ? MNL.format(new Date(ts * 1000)) : "date unknown");
const fmtDay = (ts) => MNL_DAY.format(new Date(ts * 1000));
function stamp() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
}
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (u) => (u.replace(/[^a-z0-9]/g, "").slice(0, 2) || u.slice(0, 2)).toUpperCase();
const hue = (u) => [...u].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 8;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------- lists ----------
const LISTS = {
  notback: { label: "Don't follow you back", desc: "You follow them, but they don't follow you.",
    date: "You followed", empty: "Everyone you follow follows you back.", handle: true },
  unfollowed: { label: "Unfollowed you", desc: "They followed you in your previous snapshot, not anymore, and you still follow them.",
    date: "Noticed", empty: "Nobody unfollowed you since your previous snapshot.", handle: true, noTs: true },
  mutual: { label: "Mutual", desc: "You follow each other.", date: "Followed you", empty: "No mutual follows yet." },
  fans: { label: "You don't follow back", desc: "They follow you, but you don't follow them.",
    date: "Followed you", empty: "You follow back everyone who follows you." },
  followers: { label: "Newest followers", desc: "Everyone who follows you, newest first.", date: "Followed you", empty: "No followers found." },
  following: { label: "Newest following", desc: "Everyone you follow, newest first.", date: "You followed", empty: "You don't follow anyone." },
  new: { label: "Gained", desc: "People who started following you between two snapshots.", date: "Followed you",
    empty: "No new followers between these snapshots.", compare: true },
  lost: { label: "Lost", desc: "People who stopped following you between two snapshots.", date: "Had followed you",
    empty: "Nobody stopped following you between these snapshots.", compare: true },
};

// ---------- state ----------
const state = { snapshots: [], handled: new Set(), view: null, list: "notback", f: {}, flash: [], user: Prefs.get("user") };
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
  const v = { name, ...meta, rows: [], info: "" };
  if (!cur) return v;
  if (name === "unfollowed") {
    if (!prev) v.info = "This fills in after your second upload. Add a newer export in a week or so and it compares the two.";
    else v.rows = unfollowedMe(prev, cur);
  } else if (name === "notback") v.rows = notBack(cur);
  else if (name === "mutual") v.rows = mutual(cur);
  else if (name === "fans") v.rows = fans(cur);
  else if (name === "followers" || name === "following") v.rows = latest(cur, name);
  else {
    const a = byId(f.a ?? prev?.id), b = byId(f.b ?? cur.id);
    if (!a || !b) v.info = "Comparing needs at least two uploads. Add a newer export later.";
    else { const [gained, lost] = followerDiff(a, b); v.rows = name === "new" ? gained : lost; }
  }
  v.total = v.rows.length;
  const q = (f.q || "").trim().toLowerCase().replace(/^@/, "");
  if (q) v.rows = v.rows.filter((r) => r.u.includes(q));
  if (f.days && !v.noTs) {
    const cutoff = Date.now() / 1000 - Number(f.days) * 86400;
    v.rows = v.rows.filter((r) => r.t && r.t >= cutoff);
  }
  if (f.hide && v.handle) v.rows = v.rows.filter((r) => !state.handled.has(r.u));
  return v;
}

// ---------- rendering ----------
function renderNav() {
  const has = state.snapshots.length > 0;
  $("#nav").innerHTML = has
    ? `<a href="#" class="${state.view === "home" ? "active" : ""}">Results</a>
       <a href="#history" class="${state.view === "history" ? "active" : ""}">Uploads</a>
       ${state.user ? `<span class="chip-user">@${esc(state.user)}</span>` : ""}`
    : "";
}

function render() {
  const has = state.snapshots.length > 0;
  renderNav();
  const flashes = state.flash.map(([k, m]) => `<div class="notice ${k}">${esc(m)}</div>`).join("");
  state.flash = [];
  const body = !has && state.view !== "history" ? onboardingHtml()
    : state.view === "history" ? historyHtml() : dashboardHtml();
  $("#main").innerHTML = flashes + body;
  document.querySelectorAll("[data-w]").forEach((el) => { el.style.width = `${el.dataset.w}%`; });
  if (has && state.view === "home") renderList();
}

function usernameField() {
  return `<div class="field">
    <span class="field-prefix">@</span>
    <input id="uname" type="text" inputmode="text" autocomplete="username" spellcheck="false"
      placeholder="yourusername" value="${esc(state.user)}" maxlength="30">
  </div>`;
}

function dropHtml(title = "Drop your files here") {
  return `<label class="drop" id="drop">
    <input type="file" id="files" multiple accept=".json,.html,.htm" hidden>
    <svg class="drop-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-5 5m5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <strong>${title}</strong>
    <span>or click to choose <b>followers_1.json</b> and <b>following.json</b> (select both)</span>
  </label>`;
}

function onboardingHtml() {
  return `<section class="hero">
    <h1>See who follows you back</h1>
    <p class="lead">Find out who doesn't follow you back, who unfollowed you, and who your mutuals are.
      It takes about five minutes, and your data stays on this device.</p>
  </section>
  <ol class="steps">
    <li class="card step">
      <span class="num">1</span>
      <div class="step-body">
        <h2>Your Instagram username</h2>
        <p class="muted">Used to label your results. Saved on this device only.</p>
        ${usernameField()}
      </div>
    </li>
    <li class="card step">
      <span class="num">2</span>
      <div class="step-body">
        <h2>Download your followers list from Instagram</h2>
        <p class="muted">Instagram doesn't let apps read your followers, but it lets <em>you</em> download them.
          It's free and usually ready within minutes.</p>
        <a class="btn" href="https://accountscenter.instagram.com/info_and_permissions/dyi/" target="_blank"
          rel="noopener noreferrer">Open Instagram's download page</a>
        <ul class="checklist">
          <li>Choose <b>Download or transfer information</b>, then <b>Some of your information</b>.</li>
          <li>Tick only <b>Followers and following</b>.</li>
          <li>Pick <b>Download to device</b>, format <b>JSON</b>, date range <b>All time</b>.</li>
          <li>When it's ready, download the zip and unzip it.</li>
        </ul>
      </div>
    </li>
    <li class="card step">
      <span class="num">3</span>
      <div class="step-body">
        <h2>Add the files</h2>
        <p class="muted">They're inside the unzipped folder at <code>connections/followers_and_following</code>.</p>
        ${dropHtml()}
        <p class="center"><button id="sample" class="btn-link">No file yet? Try it with sample data</button></p>
      </div>
    </li>
  </ol>`;
}

function dashboardHtml() {
  const [cur, prev] = state.snapshots;
  const nb = notBack(cur).length, mu = mutual(cur).length, fa = fans(cur).length;
  const un = prev ? unfollowedMe(prev, cur).length : null;
  const total = nb + mu + fa || 1;
  const pct = (n) => Math.max(n ? 2 : 0, Math.round((n / total) * 100));
  const tile = (key, label, value, tone = "") => `<button class="tile ${tone} ${state.list === key ? "selected" : ""}" data-list="${key}">
    <span class="tile-value">${value ?? "-"}</span><span class="tile-label">${label}</span></button>`;
  const who = state.user ? `@${esc(state.user)}` : "there";
  return `<section class="hello">
      <div>
        <p class="eyebrow">Latest upload: ${fmtDay(cur.created)}${prev ? ` · compared with ${fmtDay(prev.created)}` : ""}</p>
        <h1>Hi ${who}</h1>
        <p class="lead">Here's how your followers match up.</p>
      </div>
      <a class="btn ghost" href="#history">Add a newer export</a>
    </section>

    <section class="card match">
      <div class="match-head">
        <h2>Follow match</h2>
        <span class="muted">${plural(cur.followers.length, "follower")} · ${cur.following.length} following</span>
      </div>
      <div class="bar" role="img" aria-label="${mu} mutual, ${nb} don't follow you back, ${fa} you don't follow back">
        <span class="seg seg-mutual" data-w="${pct(mu)}"></span>
        <span class="seg seg-notback" data-w="${pct(nb)}"></span>
        <span class="seg seg-fans" data-w="${pct(fa)}"></span>
      </div>
      <div class="legend">
        <button data-list="mutual"><i class="dot dot-mutual"></i><b>${mu}</b> mutual</button>
        <button data-list="notback"><i class="dot dot-notback"></i><b>${nb}</b> don't follow you back</button>
        <button data-list="fans"><i class="dot dot-fans"></i><b>${fa}</b> you don't follow back</button>
      </div>
    </section>

    <section class="tiles">
      ${tile("notback", "Don't follow you back", nb, "warn")}
      ${tile("unfollowed", "Unfollowed you", un, "alert")}
      ${tile("mutual", "Mutual", mu, "good")}
      ${tile("followers", "Followers", cur.followers.length)}
      ${tile("following", "Following", cur.following.length)}
    </section>

    <section class="card panel" id="panel"></section>`;
}

function renderList() {
  const v = buildList(state.list), f = state.f, [cur, prev] = state.snapshots;
  const chips = Object.entries(LISTS).map(([k, m]) =>
    `<button class="chip ${k === v.name ? "active" : ""}" data-list="${k}">${m.label}</button>`).join("");
  const opts = (sel) => state.snapshots.map((s) =>
    `<option value="${s.id}" ${s.id === sel ? "selected" : ""}>Upload ${s.id} · ${fmtDay(s.created)}</option>`).join("");
  $("#panel").innerHTML = `
    <div class="chips" role="tablist">${chips}</div>
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
      ${v.noTs ? "" : `<select id="fdays" aria-label="Time range"><option value="">Any time</option>${[7, 30, 90].map((d) =>
        `<option value="${d}" ${String(d) === f.days ? "selected" : ""}>Last ${d} days</option>`).join("")}</select>`}
      ${v.handle ? `<label class="toggle"><input type="checkbox" id="fhide" ${f.hide ? "checked" : ""}><span>Hide done</span></label>` : ""}
    </div>
    ${v.name === "unfollowed" && v.rows.length ? `<div class="notice soft">Accounts that were deactivated or
      temporarily disabled also show up here, so check their profile before unfollowing.</div>` : ""}
    <div id="rows"></div>`;
  renderRows(v);
}

function renderRows(v = buildList(state.list)) {
  const box = $("#rows");
  if (!box) return;
  if (v.info) { box.innerHTML = `<div class="empty">${esc(v.info)}</div>`; return; }
  if (!v.rows.length) {
    box.innerHTML = `<div class="empty">${v.total ? "No matches for these filters." : esc(v.empty)}</div>`;
    return;
  }
  box.innerHTML = `<ul class="people">${v.rows.map((r) => {
    const done = v.handle && state.handled.has(r.u);
    return `<li class="person ${done ? "done" : ""}">
      <span class="avatar av${hue(r.u)}" aria-hidden="true">${initials(r.u)}</span>
      <div class="person-info">
        <a href="${profileUrl(r.u)}" target="_blank" rel="noopener noreferrer">@${esc(r.u)}</a>
        <span class="muted small">${v.date} ${r.detected ? fmtDay(r.detected) : fmtTs(r.t)}</span>
      </div>
      ${v.handle ? `<button class="btn small ${done ? "ghost" : "soft"}" data-handle="${esc(r.u)}">${done ? "Undo" : "Mark done"}</button>` : ""}
    </li>`;
  }).join("")}</ul>`;
}

function historyHtml() {
  const rows = state.snapshots.map((s, i) => `<li class="upload-row">
      <div>
        <strong>Upload ${s.id}</strong>${i === 0 ? ` <span class="badge">Latest</span>` : ""}
        <span class="muted small block">${fmtTs(s.created)}</span>
      </div>
      <span class="muted small">${plural(s.followers.length, "follower")} · ${s.following.length} following</span>
      <button class="btn ghost small" data-del="${s.id}">Delete</button>
    </li>`).join("");
  return `<section class="hello"><div><h1>Uploads</h1>
      <p class="lead">Each export you add becomes a snapshot. "Unfollowed you" compares your two most recent ones.</p></div></section>
    <section class="card">
      <h2>Add a newer export</h2>
      <p class="muted">Download a fresh copy from
        <a href="https://accountscenter.instagram.com/info_and_permissions/dyi/" target="_blank" rel="noopener noreferrer">Instagram's download page</a>,
        then drop both files here.</p>
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
  if (!errors.length && !followers.length) errors.push("The followers file is missing. Add followers_1.json too.");
  if (!errors.length && !following.length) errors.push("The following file is missing. Add following.json too.");
  if (errors.length) {
    errors.forEach((m) => flash(m, "error"));
    flash("Nothing was saved. Select both files together and try again.", "error");
    render();
    return false;
  }
  const dedupe = (list) => [...toMap(list).values()];
  const snap = { created: Math.floor(Date.now() / 1000), followers: dedupe(followers), following: dedupe(following) };
  const id = await DB.put("snapshots", snap);
  await load();
  flash(`Upload ${id} saved: ${plural(snap.followers.length, "follower")}, ${snap.following.length} following.`);
  state.list = "notback";
  location.hash = "";
  state.view = "home";
  render();
  return true;
}

async function addFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  await saveSnapshot(await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() }))));
}

async function uploadSample() {
  for (const set of SAMPLE_EXPORTS) if (!(await saveSnapshot(set))) return;
}

function exportCsv() {
  const v = buildList(state.list);
  const cell = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const head = ["username", "profile_url", `${v.date.toLowerCase()} (Manila time)`, ...(v.handle ? ["done"] : [])];
  const lines = [head.map(cell).join(",")];
  for (const r of v.rows) {
    lines.push([r.u, profileUrl(r.u), r.detected ? fmtDay(r.detected) : fmtTs(r.t),
      ...(v.handle ? [state.handled.has(r.u) ? "yes" : "no"] : [])].map(cell).join(","));
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv" }));
  a.download = `${v.name}_${stamp()}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("button");
  if (!el) return;
  if (el.dataset.list) {
    state.list = el.dataset.list;
    state.f = { q: "", days: "", hide: false, a: state.f.a, b: state.f.b };
    if (state.view !== "home") { location.hash = ""; return; }
    document.querySelectorAll(".tile").forEach((t) => t.classList.toggle("selected", t.dataset.list === state.list));
    renderList();
    if (!el.classList.contains("chip")) $("#panel").scrollIntoView({ behavior: "smooth", block: "start" });
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

document.addEventListener("input", (e) => {
  if (e.target.id === "fq") { state.f.q = e.target.value; renderRows(); }
  else if (e.target.id === "uname") {
    state.user = e.target.value.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 30);
    Prefs.set("user", state.user);
  }
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "files") { addFiles(t.files); return; }
  if (t.id === "uname") { renderNav(); return; }
  if (t.id === "fdays") state.f.days = t.value;
  else if (t.id === "fhide") state.f.hide = t.checked;
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
  else state.view = h === "history" ? "history" : "home";
  render();
}
window.addEventListener("hashchange", route);

(async () => {
  try { await load(); }
  catch { flash("This browser is blocking storage (private mode?), so uploads can't be saved.", "error"); }
  route();
})();
