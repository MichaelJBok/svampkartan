const STORAGE_KEY = "svampkartan.spots";
const COLORS_KEY = "svampkartan.colors";
const HIDDEN_KEY = "svampkartan.hiddenSpecies";

const $ = (id) => document.getElementById(id);
const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- species & colors ----------
const DEFAULT_COLORS = {
  "kantarell": "#f2a900",
  "trattkantarell": "#d9541e",
  "svart-trumpetsvamp": "#4b3f72",
  "karljohan": "#8b5a2b",
  "blek-taggsvamp": "#2a9d8f",
  "blomkalssvamp": "#d0459c",
};
const EXTRA_COLORS = ["#1f77b4", "#d62728", "#9467bd", "#17becf", "#7f7f7f", "#bcbd22"];

const gbifSpecies = window.GBIF_SPECIES || [];
const species = new Map(); // id -> {id, name, scientific, gbif: records[]}
gbifSpecies.forEach((s) => species.set(s.id, { id: s.id, name: s.name, scientific: s.scientific, taxonKey: s.taxonKey, gbif: s.records }));

let colors = readJson(COLORS_KEY, {});
let hiddenSpecies = new Set(readJson(HIDDEN_KEY, []));
const colorOf = (id) => colors[id] || DEFAULT_COLORS[id] || "#7f7f7f";

const slug = (name) => "custom:" + name.trim().toLowerCase();
function ensureSpecies(id, name) {
  if (species.has(id)) return species.get(id);
  const s = { id, name, scientific: "", gbif: [] };
  species.set(id, s);
  if (!colors[id] && !DEFAULT_COLORS[id]) {
    const used = new Set([...species.keys()].map(colorOf));
    colors[id] = EXTRA_COLORS.find((c) => !used.has(c)) || EXTRA_COLORS[species.size % EXTRA_COLORS.length];
    writeJson(COLORS_KEY, colors);
  }
  return s;
}

// ---------- my spots ----------
let spots = readJson(STORAGE_KEY, []);
// Older spots stored a display name like "Kantarell (Cantharellus cibarius)"; map them to a species id.
spots.forEach((s) => {
  if (s.speciesId) return;
  const known = [...species.values()].find((k) => s.species?.toLowerCase().startsWith(k.name.toLowerCase()));
  s.speciesId = known ? known.id : slug(s.species || "Okänd");
  if (known) s.species = known.name;
});
spots.forEach((s) => ensureSpecies(s.speciesId, s.species));
const saveSpots = () => writeJson(STORAGE_KEY, spots);

function isoDate(d) { return d.toISOString().slice(0, 10); }

// ---------- map ----------
const map = L.map("map", { preferCanvas: true }).setView([62.5, 16.5], 5);
const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18, attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);
L.control.layers({
  "Map": osm,
  "Topo": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17, attribution: "&copy; OpenTopoMap" }),
  "Satellite": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18, attribution: "&copy; Esri" }),
}).addTo(map);

// My spots get their own pane above the GBIF clusters so they are never hidden underneath.
map.createPane("mine").style.zIndex = 650;
const mineRenderer = L.canvas({ pane: "mine" });

// Same fill color per species; the edge and opacity tell the sources apart.
const gbifStyle = (id) => ({ radius: 5, fillColor: colorOf(id), fillOpacity: 0.55, color: "#ffffff", weight: 1, opacity: 0.9 });
const mineStyle = (id) => ({ radius: 8, fillColor: colorOf(id), fillOpacity: 1, color: "#1a1a1a", weight: 3, opacity: 1 });

function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#1a1a1a" : "#ffffff";
}

// GBIF layers: one cluster group per species so each keeps its color when zoomed out.
const gbifGroups = new Map();
for (const s of species.values()) {
  if (!s.gbif.length) continue;
  const group = L.markerClusterGroup({
    chunkedLoading: true, disableClusteringAtZoom: 12, maxClusterRadius: 50, showCoverageOnHover: false,
    iconCreateFunction: (cluster) => {
      const n = cluster.getChildCount();
      const size = n < 10 ? 26 : n < 100 ? 32 : n < 1000 ? 38 : 44;
      const c = colorOf(s.id);
      return L.divIcon({
        className: "",
        iconSize: [size, size],
        html: `<div class="cluster" style="width:${size}px;height:${size}px;background:${c}cc;color:${textOn(c)};box-shadow:0 0 0 4px ${c}44">${n}</div>`,
      });
    },
  });
  group.addLayers(s.gbif.map(([lat, lon, date, gbifId, unc]) => {
    const m = L.circleMarker([lat, lon], gbifStyle(s.id));
    m.bindPopup(() => {
      const el = document.createElement("div");
      el.innerHTML = `<span class="tag" style="--c:${colorOf(s.id)}"></span><b>${escapeHtml(s.name)}</b>
        <i>${escapeHtml(s.scientific)}</i><br><span class="src">GBIF record</span> · ${date || "unknown date"}
        ${unc ? `<br><small>±${Math.round(unc)} m</small>` : ""}
        <br><a href="https://www.gbif.org/occurrence/${gbifId}" target="_blank" rel="noopener">Open on GBIF</a>`;
      return el;
    });
    return m;
  }));
  gbifGroups.set(s.id, group);
}

const mineLayer = L.layerGroup().addTo(map);
const mineMarkers = new Map(); // spot id -> marker

function applyVisibility() {
  const showGbif = $("showGbif").checked;
  for (const [id, group] of gbifGroups) {
    const on = showGbif && !hiddenSpecies.has(id);
    if (on && !map.hasLayer(group)) map.addLayer(group);
    if (!on && map.hasLayer(group)) map.removeLayer(group);
  }
  $("showMine").checked ? map.addLayer(mineLayer) : map.removeLayer(mineLayer);
  renderSpots();
}

function recolor(id) {
  const group = gbifGroups.get(id);
  if (group) {
    const style = gbifStyle(id);
    group.eachLayer((m) => m.setStyle(style));
    group.refreshClusters();
  }
  renderSpots();
  renderSpeciesList();
}

// ---------- sidebar: species list with color pickers ----------
function renderSpeciesList() {
  const list = $("speciesList");
  list.innerHTML = "";
  for (const s of species.values()) {
    const mine = spots.filter((p) => p.speciesId === s.id).length;
    const li = document.createElement("li");
    li.innerHTML = `
      <input type="checkbox" id="vis-${s.id}" ${hiddenSpecies.has(s.id) ? "" : "checked"} aria-label="Show ${escapeHtml(s.name)}">
      <label class="swatch" style="--c:${colorOf(s.id)}" title="Change color">
        <input type="color" id="col-${s.id}" value="${colorOf(s.id)}" aria-label="Color for ${escapeHtml(s.name)}">
      </label>
      <span class="sname">${escapeHtml(s.name)}${s.scientific ? `<small>${escapeHtml(s.scientific)}</small>` : ""}</span>
      <span class="counts">${s.gbif.length.toLocaleString("sv-SE")}<small>${mine} mine</small></span>`;
    li.querySelector('input[type="checkbox"]').onchange = (e) => {
      e.target.checked ? hiddenSpecies.delete(s.id) : hiddenSpecies.add(s.id);
      writeJson(HIDDEN_KEY, [...hiddenSpecies]);
      applyVisibility();
    };
    const picker = li.querySelector('input[type="color"]');
    picker.oninput = (e) => { li.querySelector(".swatch").style.setProperty("--c", e.target.value); };
    picker.onchange = (e) => { colors[s.id] = e.target.value; writeJson(COLORS_KEY, colors); recolor(s.id); };
    list.appendChild(li);
  }
  renderSpeciesSelect();
}

function renderSpeciesSelect() {
  const sel = $("fSpecies");
  const current = sel.value;
  sel.innerHTML = [...species.values()].map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("")
    + `<option value="__other">Other species…</option>`;
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

// ---------- my spots rendering ----------
function renderSpots() {
  mineLayer.clearLayers();
  mineMarkers.clear();
  const list = $("spotList");
  list.innerHTML = "";
  // Newest first; spots without a date (e.g. imported from Google Maps) go last.
  [...spots].sort((a, b) => (b.date || "").localeCompare(a.date || "")).forEach((s) => {
    const visible = !hiddenSpecies.has(s.speciesId);
    const m = L.circleMarker([s.lat, s.lon], { ...mineStyle(s.speciesId), pane: "mine", renderer: mineRenderer });
    const el = document.createElement("div");
    el.innerHTML = `<span class="tag mine" style="--c:${colorOf(s.speciesId)}"></span><b>${escapeHtml(s.species)}</b>
      <br><span class="src">My record</span> · ${s.date || "date unknown"}
      ${s.source ? `<br><small>From ${escapeHtml(s.source)}</small>` : ""}
      ${s.notes ? `<br>${escapeHtml(s.notes)}` : ""}
      <div class="row confirm"><button class="del">Delete</button></div>`;
    // Inline confirmation: dialogs like confirm() are not available everywhere.
    el.querySelector(".del").onclick = (e) => {
      const row = e.target.parentElement;
      row.innerHTML = `<span>Delete this spot?</span><button class="yes danger">Delete</button><button class="no">Keep</button>`;
      row.querySelector(".yes").onclick = () => { spots = spots.filter((x) => x.id !== s.id); saveSpots(); renderSpots(); renderSpeciesList(); };
      row.querySelector(".no").onclick = () => m.closePopup();
    };
    m.bindPopup(el);
    if (visible) mineLayer.addLayer(m);
    mineMarkers.set(s.id, m);

    const li = document.createElement("li");
    li.innerHTML = `<span class="tag mine" style="--c:${colorOf(s.speciesId)}"></span>${escapeHtml(s.species)}
      <br><small>${s.date || "date unknown"}</small>`;
    li.onclick = () => {
      if (hiddenSpecies.has(s.speciesId)) { hiddenSpecies.delete(s.speciesId); writeJson(HIDDEN_KEY, [...hiddenSpecies]); renderSpeciesList(); applyVisibility(); }
      map.setView([s.lat, s.lon], 14);
      mineMarkers.get(s.id).openPopup();
    };
    list.appendChild(li);
  });
  $("mineCount").textContent = spots.length;
}

$("gbifCount").textContent = [...species.values()].reduce((n, s) => n + s.gbif.length, 0).toLocaleString("sv-SE");
$("showGbif").onchange = applyVisibility;
$("showMine").onchange = applyVisibility;
renderSpeciesList();
applyVisibility();

// ---------- add-spot form ----------
let draft = null;
const draftMarker = L.circleMarker([0, 0], { radius: 9, fillOpacity: 0.3, color: "#1a1a1a", weight: 2, dashArray: "4 3", pane: "mine", renderer: mineRenderer });

function updateDraftColor() {
  const id = $("fSpecies").value;
  $("fOtherWrap").hidden = id !== "__other";
  draftMarker.setStyle({ fillColor: id === "__other" ? "#7f7f7f" : colorOf(id) });
}

function openForm(latlng) {
  setMenuHidden(false);
  draft = { lat: latlng.lat, lon: latlng.lng };
  draftMarker.setLatLng(latlng).addTo(map);
  $("form").hidden = false;
  $("fPos").value = `${draft.lat.toFixed(5)}, ${draft.lon.toFixed(5)}`;
  if (!$("fDate").value) $("fDate").value = isoDate(new Date());
  updateDraftColor();
  $("fSpecies").focus();
}
map.on("click", (e) => openForm(e.latlng));

// ---------- my location ----------
// Follows the device's GPS while tracking is on; browsers only allow this over HTTPS (or localhost).
let myPos = null;
let pendingAdd = false;
const posAccuracy = L.circle([0, 0], { radius: 0, color: "#1a73e8", weight: 1, fillOpacity: 0.12, interactive: false });
const posDot = L.circleMarker([0, 0], { radius: 7, fillColor: "#1a73e8", fillOpacity: 1, color: "#ffffff", weight: 3, pane: "mine", renderer: mineRenderer, interactive: false });

const LocateControl = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const btn = L.DomUtil.create("a", "leaflet-bar locate-btn");
    btn.href = "#";
    btn.title = "Show my location";
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", "Show my location");
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="currentColor" stroke-width="2"/></svg>`;
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, "click", (e) => { L.DomEvent.preventDefault(e); toggleTracking(); });
    return btn;
  },
});
const locateBtn = new LocateControl().addTo(map).getContainer();

// ---------- hide / show the menu ----------
const MENU_KEY = "svampkartan.menuHidden";
const MENU_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
const MenuControl = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const btn = L.DomUtil.create("a", "leaflet-bar menu-btn");
    btn.href = "#";
    btn.setAttribute("role", "button");
    btn.innerHTML = MENU_ICON;
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, "click", (e) => { L.DomEvent.preventDefault(e); setMenuHidden(!$("app").classList.contains("menu-hidden")); });
    return btn;
  },
});
const menuBtn = new MenuControl().addTo(map).getContainer();

function setMenuHidden(hidden) {
  $("app").classList.toggle("menu-hidden", hidden);
  const label = hidden ? "Show menu" : "Hide menu";
  menuBtn.title = label;
  menuBtn.setAttribute("aria-label", label);
  menuBtn.setAttribute("aria-pressed", String(hidden));
  writeJson(MENU_KEY, hidden);
  map.invalidateSize();
}
setMenuHidden(readJson(MENU_KEY, false));

function startTracking(centerOnFix) {
  locateBtn.classList.add("active", "waiting");
  map.locate({ watch: true, enableHighAccuracy: true, setView: false, maximumAge: 10000, timeout: 20000 });
  map.once("locationfound", (e) => { if (centerOnFix) map.setView(e.latlng, Math.max(map.getZoom(), 15)); });
}
function stopTracking() {
  map.stopLocate();
  locateBtn.classList.remove("active", "waiting");
  map.removeLayer(posDot); map.removeLayer(posAccuracy);
  myPos = null;
}
function toggleTracking() {
  if (locateBtn.classList.contains("active")) {
    if (myPos && !map.getBounds().contains(myPos.latlng)) map.setView(myPos.latlng, Math.max(map.getZoom(), 15));
    else stopTracking();
  } else {
    startTracking(true);
  }
}

map.on("locationfound", (e) => {
  myPos = { latlng: e.latlng, accuracy: e.accuracy };
  locateBtn.classList.remove("waiting");
  posAccuracy.setLatLng(e.latlng).setRadius(e.accuracy).addTo(map);
  posDot.setLatLng(e.latlng).addTo(map);
  $("locStatus").textContent = `GPS accuracy ±${Math.round(e.accuracy)} m`;
  if (pendingAdd) { pendingAdd = false; openForm(e.latlng); }
});
map.on("locationerror", (e) => {
  const denied = e.code === 1;
  stopTracking();
  pendingAdd = false;
  $("locStatus").textContent = denied
    ? "Location is blocked. Allow location for this site in your browser settings, then try again."
    : `Could not get your location (${e.message}). Try again outdoors or with better signal.`;
});

$("addHereBtn").onclick = () => {
  if (myPos) return openForm(myPos.latlng);
  pendingAdd = true;
  $("locStatus").textContent = "Finding your location…";
  startTracking(true);
};
$("fSpecies").onchange = updateDraftColor;

function closeForm() {
  draft = null;
  map.removeLayer(draftMarker);
  $("form").hidden = true;
  $("fNotes").value = "";
  $("fOther").value = "";
}
$("fCancel").onclick = closeForm;

$("form").onsubmit = (e) => {
  e.preventDefault();
  if (!draft) return;
  let id = $("fSpecies").value;
  let name;
  if (id === "__other") {
    name = $("fOther").value.trim();
    if (!name) { $("fOther").focus(); return; }
    const existing = [...species.values()].find((s) => s.name.toLowerCase() === name.toLowerCase());
    id = existing ? existing.id : slug(name);
    ensureSpecies(id, existing ? existing.name : name);
  }
  name = species.get(id).name;
  spots.push({
    id: crypto.randomUUID(),
    lat: +draft.lat.toFixed(6), lon: +draft.lon.toFixed(6),
    speciesId: id, species: name,
    date: $("fDate").value,
    notes: $("fNotes").value.trim(),
    created: new Date().toISOString(),
  });
  saveSpots(); closeForm(); renderSpeciesList(); $("fSpecies").value = id; renderSpots();
};

// ---------- export / import ----------
$("exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify({ spots, colors }, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob), download: `svampspots-${isoDate(new Date())}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
};
$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.spots || [];
    if (data.colors) { colors = { ...data.colors, ...colors }; writeJson(COLORS_KEY, colors); }
    const known = new Set(spots.map((s) => s.id));
    const added = incoming.filter((s) => s.id && !known.has(s.id) && isFinite(s.lat) && isFinite(s.lon));
    added.forEach((s) => {
      if (!s.speciesId) s.speciesId = [...species.values()].find((k) => s.species?.toLowerCase().startsWith(k.name.toLowerCase()))?.id || slug(s.species || "Okänd");
      ensureSpecies(s.speciesId, s.species);
    });
    spots.push(...added);
    saveSpots(); renderSpeciesList(); renderSpots();
    $("importStatus").textContent = `Imported ${added.length} spot(s).`;
  } catch (err) {
    $("importStatus").textContent = `Could not import: ${err.message}`;
  }
  e.target.value = "";
};
