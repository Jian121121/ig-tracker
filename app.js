"use strict";
// IG Tracker (browser-only). Parses Instagram export files and stores snapshots in IndexedDB.

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
    throw new ParseError(`${name}: this is not a followers/following list. Upload followers_*.json and following.json.`);
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

// ---------- storage (IndexedDB, stays in this browser) ----------
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
const latest = (cur, kind) => newestFirst([...cur[kind]]);
function followerDiff(a, b) {
  const A = toMap(a.followers), B = toMap(b.followers);
  return [newestFirst(b.followers.filter((e) => !A.has(e.u))), newestFirst(a.followers.filter((e) => !B.has(e.u)))];
}

// ---------- helpers ----------
const MNL = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: true });
function mnlParts(ts) { return Object.fromEntries(MNL.formatToParts(new Date(ts * 1000)).map((p) => [p.type, p.value])); }
function fmtTs(ts) {
  if (!ts) return "-";
  const p = mnlParts(ts);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.dayPeriod}`;
}
function stamp() {
  const p = mnlParts(Date.now() / 1000);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
}
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- state ----------
const LISTS = {
  unfollowed: "Unfollowed me (I still follow them)", notback: "Not following me back",
  followers: "Latest followers", following: "Latest following", new: "New followers", lost: "Lost followers",
};
const NAV = [["home", "Home"], ["unfollowed", "Unfollowed me"], ["notback", "Not following back"],
  ["followers", "Latest followers"], ["following", "Latest following"], ["new", "Compare"]];
const state = { snapshots: [], handled: new Set(), view: null, f: {}, flash: [] };
const byId = (id) => state.snapshots.find((s) => s.id === id);

async function load() {
  state.snapshots = (await DB.all("snapshots")).sort((a, b) => b.id - a.id);
  state.handled = new Set((await DB.all("handled")).map((h) => h.u));
  if (!byId(state.f.a)) state.f.a = null;
  if (!byId(state.f.b)) state.f.b = null;
}
const flash = (msg, kind = "ok") => state.flash.push([kind, msg]);

function buildList(name) {
  const [cur, prev] = state.snapshots, f = state.f;
  const v = { title: LISTS[name], rows: [], info: "", dateLabel: "Followed on",
    canHandle: name === "unfollowed" || name === "notback", hasTs: name !== "unfollowed" };
  if (!cur) { v.info = "No snapshots yet. Upload your export files on the Home page."; return v; }

  if (name === "unfollowed") {
    v.dateLabel = "Detected";
    if (!prev) v.info = "Needs at least two snapshots. Upload a newer export later to compare.";
    else {
      v.rows = unfollowedMe(prev, cur);
      v.info = "Deactivated or temporarily disabled accounts also disappear from followers, so double-check before unfollowing.";
    }
  } else if (name === "notback") {
    v.dateLabel = "I followed on";
    v.rows = notBack(cur);
  } else if (name === "followers" || name === "following") {
    v.rows = latest(cur, name);
  } else {
    const a = byId(f.a ?? prev?.id), b = byId(f.b ?? cur.id);
    if (!a || !b) v.info = "Pick two snapshots to compare (needs at least two uploads).";
    else { const [n, l] = followerDiff(a, b); v.rows = name === "new" ? n : l; }
  }

  const q = (f.q || "").trim().toLowerCase();
  if (q) v.rows = v.rows.filter((r) => r.u.includes(q));
  if (f.days && v.hasTs) {
    const cutoff = Date.now() / 1000 - Number(f.days) * 86400;
    v.rows = v.rows.filter((r) => r.t && r.t >= cutoff);
  }
  if (f.hide && v.canHandle) v.rows = v.rows.filter((r) => !state.handled.has(r.u));
  return v;
}

// ---------- rendering ----------
function render() {
  const active = state.view === "lost" ? "new" : state.view;
  $("#nav").innerHTML = NAV.map(([k, l]) => `<a href="#${k}" class="${k === active ? "active" : ""}">${l}</a>`).join("");

  const [cur, prev] = state.snapshots;
  const stats = [["Followers", cur?.followers.length, "followers"], ["Following", cur?.following.length, "following"],
    ["Not following back", cur ? notBack(cur).length : null, "notback"],
    ["Unfollowed me", cur && prev ? unfollowedMe(prev, cur).length : null, "unfollowed"]];
  $("#stats").innerHTML = stats.map(([l, v, h]) => `<a class="stat" href="#${h}"><span>${v ?? "-"}</span>${l}</a>`).join("");

  const flashes = state.flash.map(([k, m]) => `<p class="flash ${k}">${esc(m)}</p>`).join("");
  state.flash = [];
  $("#main").innerHTML = flashes + (state.view === "home" ? homeHtml() : listHtml());
  if (state.view !== "home") renderTable();
}

function homeHtml() {
  const rows = state.snapshots.map((s) => `<tr><td>${s.id}</td><td>${fmtTs(s.created)}</td>
    <td>${s.followers.length}</td><td>${s.following.length}</td>
    <td><button class="small danger" data-del="${s.id}">Delete</button></td></tr>`).join("");
  return `<section class="card">
    <h2>Upload a new export</h2>
    <div class="upload">
      <input type="file" id="files" multiple accept=".json,.html,.htm">
      <button id="upload">Upload snapshot</button>
      <button id="sample" class="ghost">Try with sample data</button>
    </div>
    <p class="muted">Select <b>followers_1.json</b> (plus followers_2.json, ... if present) and
      <b>following.json</b> together. HTML versions also work. Files are read inside your browser only.</p>
    <details>
      <summary>How to get your export</summary>
      <ol>
        <li>Instagram → Accounts Center → Your information and permissions → Download your information.</li>
        <li>Choose <b>Followers and following</b>, format <b>JSON</b>, date range <b>All time</b>.</li>
        <li>Unzip it and pick the files from <code>connections/followers_and_following/</code>.</li>
        <li>Repeat every week or so. Each upload becomes a snapshot, and "Unfollowed me" compares the last two.</li>
      </ol>
    </details>
  </section>
  <section class="card">
    <h2>Snapshots</h2>
    ${rows ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Uploaded (Manila)</th><th>Followers</th>
      <th>Following</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <p><button id="wipe" class="small ghost">Delete all data from this browser</button></p>`
      : `<p class="muted">No snapshots yet.</p>`}
  </section>`;
}

function listHtml() {
  const v = state.view, f = state.f, [cur, prev] = state.snapshots;
  const tabs = (items) => `<div class="tabs">${items.map(([k, l]) =>
    `<a href="#${k}" class="${k === v ? "active" : ""}">${l}</a>`).join("")}</div>`;
  const isCompare = v === "new" || v === "lost";
  const opts = (sel) => state.snapshots.map((s) =>
    `<option value="${s.id}" ${s.id === sel ? "selected" : ""}>#${s.id} · ${fmtTs(s.created)}</option>`).join("");
  const hasTs = v !== "unfollowed", canHandle = v === "unfollowed" || v === "notback";
  return `<section class="card">
    ${isCompare ? tabs([["new", "New followers"], ["lost", "Lost followers"]]) : ""}
    ${v === "followers" || v === "following" ? tabs([["followers", "Latest followers"], ["following", "Latest following"]]) : ""}
    <h2>${LISTS[v]} <small id="count"></small></h2>
    <p class="muted" id="info"></p>
    <div class="controls">
      ${isCompare ? `<label>From <select id="fa">${opts(f.a ?? prev?.id)}</select></label>
        <label>To <select id="fb">${opts(f.b ?? cur?.id)}</select></label>` : ""}
      <input type="search" id="fq" placeholder="Search username" value="${esc(f.q || "")}">
      ${hasTs ? `<select id="fdays"><option value="">All time</option>${[7, 30, 90].map((d) =>
        `<option value="${d}" ${String(d) === f.days ? "selected" : ""}>Last ${d} days</option>`).join("")}</select>` : ""}
      ${canHandle ? `<label class="check"><input type="checkbox" id="fhide" ${f.hide ? "checked" : ""}> Hide handled</label>` : ""}
      <button id="export" class="small">Download CSV</button>
    </div>
    <div id="table"></div>
  </section>`;
}

function renderTable() {
  const v = buildList(state.view);
  $("#count").textContent = `(${v.rows.length})`;
  $("#info").textContent = v.info;
  $("#info").hidden = !v.info;
  if (!v.rows.length) { $("#table").innerHTML = v.info ? "" : `<p class="muted">Nobody here.</p>`; return; }
  const rows = v.rows.map((r, i) => {
    const done = v.canHandle && state.handled.has(r.u);
    return `<tr class="${done ? "done" : ""}"><td>${i + 1}</td>
      <td><a href="${profileUrl(r.u)}" target="_blank" rel="noopener noreferrer">@${esc(r.u)}</a></td>
      <td>${fmtTs(r.detected || r.t)}</td>
      ${v.canHandle ? `<td><button class="small ${done ? "ghost" : ""}" data-handle="${esc(r.u)}">${done ? "Handled ✓ (undo)" : "Mark handled"}</button></td>` : ""}</tr>`;
  }).join("");
  $("#table").innerHTML = `<div class="table-wrap"><table><thead><tr><th>#</th><th>Username</th>
    <th>${v.dateLabel} (Manila)</th>${v.canHandle ? "<th>Status</th>" : ""}</tr></thead><tbody>${rows}</tbody></table></div>`;
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
  if (!errors.length && !followers.length) errors.push("No followers file found (followers_1.json).");
  if (!errors.length && !following.length) errors.push("No following file found (following.json).");
  if (errors.length) {
    errors.forEach((m) => flash(m, "error"));
    flash("Nothing was saved. Fix the files above and try again.", "error");
    render();
    return false;
  }
  const dedupe = (list) => [...toMap(list).values()];
  const snap = { created: Math.floor(Date.now() / 1000), followers: dedupe(followers), following: dedupe(following) };
  const id = await DB.put("snapshots", snap);
  await load();
  flash(`Snapshot #${id} saved: ${snap.followers.length} followers, ${snap.following.length} following.`);
  render();
  return true;
}

async function uploadFiles() {
  const files = [...($("#files").files || [])];
  if (!files.length) { flash("Choose your followers and following files first.", "error"); render(); return; }
  await saveSnapshot(await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() }))));
}

async function uploadSample() {
  for (const set of SAMPLE_EXPORTS) if (!(await saveSnapshot(set))) return;
}

function exportCsv() {
  const v = buildList(state.view);
  const cell = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const head = ["username", "profile_url", `${v.dateLabel.toLowerCase()} (manila)`, ...(v.canHandle ? ["handled"] : [])];
  const lines = [head.map(cell).join(",")];
  for (const r of v.rows) {
    lines.push([r.u, profileUrl(r.u), fmtTs(r.detected || r.t),
      ...(v.canHandle ? [state.handled.has(r.u) ? "yes" : "no"] : [])].map(cell).join(","));
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv" }));
  a.download = `${state.view}_${stamp()}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.dataset.handle) {
    const u = btn.dataset.handle;
    if (state.handled.has(u)) { await DB.del("handled", u); state.handled.delete(u); }
    else { await DB.put("handled", { u, at: Date.now() }); state.handled.add(u); }
    renderTable();
  } else if (btn.dataset.del) {
    const id = Number(btn.dataset.del);
    if (confirm(`Delete snapshot #${id}?`)) { await DB.del("snapshots", id); await load(); flash(`Snapshot #${id} deleted.`); render(); }
  } else if (btn.id === "upload") await uploadFiles();
  else if (btn.id === "sample") await uploadSample();
  else if (btn.id === "export") exportCsv();
  else if (btn.id === "wipe" && confirm("Delete all snapshots and handled marks from this browser?")) {
    await DB.clear("snapshots"); await DB.clear("handled"); await load(); flash("All data deleted."); render();
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "fq") { state.f.q = e.target.value; renderTable(); }
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "fdays") state.f.days = t.value;
  else if (t.id === "fhide") state.f.hide = t.checked;
  else if (t.id === "fa" || t.id === "fb") state.f[t.id === "fa" ? "a" : "b"] = Number(t.value);
  else return;
  renderTable();
});

function route() {
  const h = location.hash.slice(1);
  const view = h in LISTS ? h : "home";
  if (view !== state.view) {
    state.f = { q: "", days: "", hide: false, a: state.f.a ?? null, b: state.f.b ?? null };
    state.view = view;
  }
  render();
}
window.addEventListener("hashchange", route);

(async () => {
  try { await load(); }
  catch { flash("This browser blocked local storage (private mode?), so snapshots can't be saved.", "error"); }
  route();
})();
