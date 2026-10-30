const STORAGE_KEY = "svampkartan.spots";
const COLORS_KEY = "svampkartan.colors";
const HIDDEN_KEY = "svampkartan.hiddenSpecies";
const FILTER_KEY = "svampkartan.gbifFilter";

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
// A spot: {id, lat, lon, speciesId, species, date (first find), amount, notes, visits: [{date, amount, notes}], …}
const AMOUNTS = ["None", "A few", "Good", "Lots"];
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

// While signed in, sync.js sets `cloud` so every change also goes to the private online copy.
let cloud = null;
function addSpots(list) {
  spots.push(...list);
  saveSpots();
  cloud?.save(list);
}
function updateSpot(spot) {
  saveSpots();
  cloud?.save([spot]);
}
function removeSpot(id) {
  spots = spots.filter((x) => x.id !== id);
  saveSpots();
  cloud?.remove(id);
}

// First find plus every logged visit, newest first.
function spotHistory(s) {
  const first = s.date || s.amount != null ? [{ date: s.date || "", amount: s.amount, notes: "", first: true }] : [];
  return [...first, ...(s.visits || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}
const lastDate = (s) => spotHistory(s)[0]?.date || "";
const amountText = (a) => (a == null || a === "" ? "" : AMOUNTS[a]);

function isoDate(d) { return d.toISOString().slice(0, 10); }

// ---------- map ----------
const map = L.map("map", { preferCanvas: true }).setView([62.5, 16.5], 5);
// crossOrigin lets the offline helper (sw.js) keep viewed map tiles compactly.
const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18, crossOrigin: true, attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);
L.control.layers({
  "Map": osm,
  "Topo": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17, crossOrigin: true, attribution: "&copy; OpenTopoMap" }),
  "Satellite": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18, crossOrigin: true, attribution: "&copy; Esri" }),
}).addTo(map);

// My spots get their own pane above the GBIF records so they are never hidden underneath.
map.createPane("mine").style.zIndex = 650;
const mineRenderer = L.canvas({ pane: "mine" });
const gbifRenderer = L.canvas({ padding: 0.3 });

// Same fill color per species; the edge and opacity tell the sources apart.
// bubblingMouseEvents: false so tapping a dot doesn't also count as tapping the map (which starts a new spot).
const gbifStyle = (id) => ({ radius: 5, fillColor: colorOf(id), fillOpacity: 0.55, color: "#ffffff", weight: 1, opacity: 0.9, bubblingMouseEvents: false });
const mineStyle = (id) => ({ radius: 8, fillColor: colorOf(id), fillOpacity: 1, color: "#1a1a1a", weight: 3, opacity: 1, bubblingMouseEvents: false });

function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#1a1a1a" : "#ffffff";
}

// ---------- GBIF records: filters ----------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const savedFilter = readJson(FILTER_KEY, {});
const gbifFilter = {
  months: new Set(savedFilter.months || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  maxUncertainty: savedFilter.maxUncertainty || 0, // metres; 0 = any. Records without a value count as imprecise.
};
const filterActive = () => gbifFilter.months.size < 12 || gbifFilter.maxUncertainty > 0;
function passesFilter(r) {
  if (gbifFilter.maxUncertainty && !(r[4] != null && r[4] <= gbifFilter.maxUncertainty)) return false;
  return gbifFilter.months.size === 12 || gbifFilter.months.has(+r[2].slice(5, 7));
}

// ---------- GBIF records: layer ----------
// One Supercluster index per species, built on first use and after a filter change. It groups tens of
// thousands of records in milliseconds, and only the clusters and dots in view are drawn.
const gbifIndex = new Map(); // id -> Supercluster
const gbifCounts = new Map(); // id -> records passing the filter
const gbifLayer = L.layerGroup().addTo(map);
const gbifPopup = L.popup();

function countFiltered() {
  for (const s of species.values()) {
    gbifCounts.set(s.id, filterActive() ? s.gbif.reduce((n, r) => n + passesFilter(r), 0) : s.gbif.length);
  }
}
function indexFor(s) {
  if (!gbifIndex.has(s.id)) {
    const points = [];
    s.gbif.forEach((r, i) => {
      if (passesFilter(r)) points.push({ type: "Feature", properties: { i }, geometry: { type: "Point", coordinates: [r[1], r[0]] } });
    });
    // extent 256 matches Leaflet's tile size, so radius is in screen pixels; points stand alone from zoom 12.
    gbifIndex.set(s.id, new Supercluster({ radius: 50, extent: 256, maxZoom: 11 }).load(points));
  }
  return gbifIndex.get(s.id);
}

function gbifPopupHtml(s, r) {
  const [, , date, gbifId, unc] = r;
  return `<span class="tag" style="--c:${colorOf(s.id)}"></span><b>${escapeHtml(s.name)}</b>
    <i>${escapeHtml(s.scientific)}</i><br><span class="src">GBIF record</span> · ${date || "unknown date"}
    <br><small>${unc != null ? `Location within ±${unc.toLocaleString("sv-SE")} m` : "Location precision unknown"}</small>
    <br><a href="https://www.gbif.org/occurrence/${gbifId}" target="_blank" rel="noopener">Open on GBIF</a>`;
}

let drawQueued = false;
function drawGbif() {
  if (drawQueued) return;
  drawQueued = true;
  // Several changes in a row (filter, visibility, colour) redraw once.
  setTimeout(() => {
    drawQueued = false;
    gbifLayer.clearLayers();
    if (!$("showGbif").checked) return;
    const b = map.getBounds().pad(0.3);
    const bbox = [Math.max(-180, b.getWest()), Math.max(-85, b.getSouth()), Math.min(180, b.getEast()), Math.min(85, b.getNorth())];
    const zoom = Math.round(map.getZoom());
    for (const s of species.values()) {
      if (!s.gbif.length || hiddenSpecies.has(s.id)) continue;
      const index = indexFor(s);
      const c = colorOf(s.id);
      for (const f of index.getClusters(bbox, zoom)) {
        const [lon, lat] = f.geometry.coordinates;
        if (f.properties.cluster) {
          const n = f.properties.point_count;
          const size = n < 10 ? 26 : n < 100 ? 32 : n < 1000 ? 38 : 44;
          const m = L.marker([lat, lon], {
            keyboard: false,
            icon: L.divIcon({
              className: "",
              iconSize: [size, size],
              html: `<div class="cluster" style="width:${size}px;height:${size}px;background:${c}cc;color:${textOn(c)};box-shadow:0 0 0 4px ${c}44">${n}</div>`,
            }),
          });
          m.on("click", () => map.setView([lat, lon], Math.min(index.getClusterExpansionZoom(f.properties.cluster_id), 18)));
          gbifLayer.addLayer(m);
        } else {
          const r = s.gbif[f.properties.i];
          const m = L.circleMarker([lat, lon], { ...gbifStyle(s.id), renderer: gbifRenderer });
          // A map-level popup survives the redraw that follows its auto-pan.
          m.on("click", () => gbifPopup.setLatLng([lat, lon]).setContent(gbifPopupHtml(s, r)).openOn(map));
          gbifLayer.addLayer(m);
        }
      }
    }
  }, 0);
}
map.on("moveend", drawGbif);

const mineLayer = L.layerGroup().addTo(map);
const mineMarkers = new Map(); // spot id -> marker

function applyVisibility() {
  drawGbif();
  $("showMine").checked ? map.addLayer(mineLayer) : map.removeLayer(mineLayer);
  renderSpots();
}

function recolor() {
  drawGbif();
  renderSpots();
  renderSpeciesList();
}

// ---------- sidebar: species list with color pickers ----------
function renderSpeciesList() {
  const list = $("speciesList");
  list.innerHTML = "";
  for (const s of species.values()) {
    const mine = spots.filter((p) => p.speciesId === s.id).length;
    const shown = gbifCounts.get(s.id) ?? s.gbif.length;
    const count = filterActive() && s.gbif.length
      ? `${shown.toLocaleString("sv-SE")}<small>of ${s.gbif.length.toLocaleString("sv-SE")} · ${mine} mine</small>`
      : `${s.gbif.length.toLocaleString("sv-SE")}<small>${mine} mine</small>`;
    const li = document.createElement("li");
    li.innerHTML = `
      <input type="checkbox" id="vis-${s.id}" ${hiddenSpecies.has(s.id) ? "" : "checked"} aria-label="Show ${escapeHtml(s.name)}">
      <label class="swatch" style="--c:${colorOf(s.id)}" title="Change color">
        <input type="color" id="col-${s.id}" value="${colorOf(s.id)}" aria-label="Color for ${escapeHtml(s.name)}">
      </label>
      <span class="sname">${escapeHtml(s.name)}${s.scientific ? `<small>${escapeHtml(s.scientific)}</small>` : ""}</span>
      <span class="counts">${count}</span>`;
    li.querySelector('input[type="checkbox"]').onchange = (e) => {
      e.target.checked ? hiddenSpecies.delete(s.id) : hiddenSpecies.add(s.id);
      writeJson(HIDDEN_KEY, [...hiddenSpecies]);
      applyVisibility();
    };
    const picker = li.querySelector('input[type="color"]');
    picker.oninput = (e) => { li.querySelector(".swatch").style.setProperty("--c", e.target.value); };
    picker.onchange = (e) => { colors[s.id] = e.target.value; writeJson(COLORS_KEY, colors); cloud?.saveColors(colors); recolor(s.id); };
    list.appendChild(li);
  }
  const total = [...species.values()].reduce((n, s) => n + (gbifCounts.get(s.id) ?? s.gbif.length), 0);
  $("gbifCount").textContent = total.toLocaleString("sv-SE");
  renderSpeciesSelect();
}

function renderSpeciesSelect() {
  const sel = $("fSpecies");
  const current = sel.value;
  sel.innerHTML = [...species.values()].map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("")
    + `<option value="__other">Other species…</option>`;
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

// ---------- sidebar: GBIF filters ----------
function renderFilters() {
  $("monthChips").innerHTML = MONTHS.map((m, i) =>
    `<button type="button" class="chip" data-month="${i + 1}" aria-pressed="${gbifFilter.months.has(i + 1)}">${m}</button>`).join("");
  $("precision").value = String(gbifFilter.maxUncertainty);
}
function applyFilter() {
  writeJson(FILTER_KEY, { months: [...gbifFilter.months], maxUncertainty: gbifFilter.maxUncertainty });
  gbifIndex.clear();
  countFiltered();
  renderFilters();
  renderSpeciesList();
  drawGbif();
}
$("monthChips").onclick = (e) => {
  const m = +e.target.dataset?.month;
  if (!m) return;
  gbifFilter.months.has(m) ? gbifFilter.months.delete(m) : gbifFilter.months.add(m);
  applyFilter();
};
$("monthsNow").onclick = () => {
  // This month plus whichever neighbouring month is closer to today.
  const now = new Date();
  const m = now.getMonth() + 1;
  const other = now.getDate() <= 15 ? (m === 1 ? 12 : m - 1) : (m === 12 ? 1 : m + 1);
  gbifFilter.months = new Set([m, other]);
  applyFilter();
};
$("monthsAll").onclick = () => { gbifFilter.months = new Set(MONTHS.map((_, i) => i + 1)); applyFilter(); };
$("precision").onchange = (e) => { gbifFilter.maxUncertainty = +e.target.value; applyFilter(); };

// ---------- my spots rendering ----------
// One shared popup for my spots, filled by the app. Re-rendering markers (e.g. when a sync update arrives)
// never closes it, and the log-visit form inside it is never rebuilt behind your back.
const spotPopupLayer = L.popup({ minWidth: 220 });
let openSpotId = null;
spotPopupLayer.on("remove", () => { openSpotId = null; });

function historyHtml(s) {
  const h = spotHistory(s);
  if (!h.length) return "";
  return `<ul class="visits">${h.map((v) => `<li>${v.date || "date unknown"}${amountText(v.amount) ? ` · <b>${amountText(v.amount)}</b>` : ""}${v.first ? " <small>(first find)</small>" : ""}${v.notes ? ` · ${escapeHtml(v.notes)}` : ""}</li>`).join("")}</ul>`;
}

function openSpot(id) {
  const s = spots.find((x) => x.id === id);
  if (!s) return map.closePopup(spotPopupLayer);
  openSpotId = id;
  spotPopupLayer.setLatLng([s.lat, s.lon]).setContent(spotPopup(s));
  if (!map.hasLayer(spotPopupLayer)) spotPopupLayer.openOn(map);
}

function spotPopup(s) {
  const el = document.createElement("div");
  el.className = "spot-popup";
  el.innerHTML = `<span class="tag mine" style="--c:${colorOf(s.speciesId)}"></span><b>${escapeHtml(s.species)}</b>
    <br><span class="src">My record</span>
    ${s.source ? `<br><small>From ${escapeHtml(s.source)}</small>` : ""}
    ${s.notes ? `<br>${escapeHtml(s.notes)}` : ""}
    ${historyHtml(s)}
    <div class="row actions"><button class="log primary">Log visit</button><button class="edit">Edit</button><button class="del">Delete</button></div>`;
  // Buttons here replace themselves (e.g. with the visit form); without this Leaflet can't tell the click
  // came from inside the popup and treats it as a tap on the map.
  L.DomEvent.disableClickPropagation(el);
  L.DomEvent.on(el, "click", L.DomEvent.stopPropagation);

  el.querySelector(".log").onclick = () => {
    el.querySelector(".actions").outerHTML = `<form class="visit-form">
        <label>Date <input type="date" name="date" value="${isoDate(new Date())}" required></label>
        <label>Amount <select name="amount">${AMOUNTS.map((a, i) => `<option value="${i}" ${i === 2 ? "selected" : ""}>${a}</option>`).join("")}</select></label>
        <label>Note <input name="notes" placeholder="Optional"></label>
        <div class="row"><button type="submit" class="primary">Save visit</button><button type="button" class="cancel">Cancel</button></div>
      </form>`;
    const form = el.querySelector(".visit-form");
    form.querySelector(".cancel").onclick = () => openSpot(s.id);
    form.onsubmit = (e) => {
      e.preventDefault();
      const d = new FormData(form);
      s.visits = [...(s.visits || []), { date: d.get("date"), amount: +d.get("amount"), notes: String(d.get("notes")).trim() }];
      updateSpot(s);
      renderSpots();
      openSpot(s.id);
    };
    spotPopupLayer.update(); // content is a plain element, so this only resizes the popup
  };
  el.querySelector(".edit").onclick = () => { map.closePopup(spotPopupLayer); openForm(L.latLng(s.lat, s.lon), s); };
  // Inline confirmation: dialogs like confirm() are not available everywhere.
  el.querySelector(".del").onclick = () => {
    const row = el.querySelector(".actions");
    row.innerHTML = `<span>Delete this spot and its visits?</span><button class="yes danger">Delete</button><button class="no">Keep</button>`;
    row.querySelector(".yes").onclick = () => { map.closePopup(spotPopupLayer); removeSpot(s.id); renderSpots(); renderSpeciesList(); };
    row.querySelector(".no").onclick = () => openSpot(s.id);
  };
  return el;
}

function renderSpots() {
  mineLayer.clearLayers();
  mineMarkers.clear();
  const list = $("spotList");
  list.innerHTML = "";
  // Most recent activity first; spots without any date (e.g. imported from Google Maps) go last.
  [...spots].sort((a, b) => lastDate(b).localeCompare(lastDate(a))).forEach((s) => {
    const m = L.circleMarker([s.lat, s.lon], { ...mineStyle(s.speciesId), pane: "mine", renderer: mineRenderer });
    m.on("click", () => openSpot(s.id));
    if (!hiddenSpecies.has(s.speciesId)) mineLayer.addLayer(m);
    mineMarkers.set(s.id, m);

    const visits = spotHistory(s).length;
    const li = document.createElement("li");
    li.innerHTML = `<span class="tag mine" style="--c:${colorOf(s.speciesId)}"></span>${escapeHtml(s.species)}
      <br><small>${lastDate(s) ? `Last ${lastDate(s)}` : "date unknown"}${visits > 1 ? ` · ${visits} visits` : ""}</small>`;
    li.onclick = () => {
      if (hiddenSpecies.has(s.speciesId)) { hiddenSpecies.delete(s.speciesId); writeJson(HIDDEN_KEY, [...hiddenSpecies]); renderSpeciesList(); applyVisibility(); }
      map.setView([s.lat, s.lon], 14);
      openSpot(s.id);
    };
    list.appendChild(li);
  });
  $("mineCount").textContent = spots.length;
  $("spotsCount").textContent = spots.length;
  // Refresh an open spot popup with the latest data, unless you're in the middle of logging a visit.
  if (openSpotId && !spotPopupLayer.getElement()?.querySelector(".visit-form")) openSpot(openSpotId);
}

$("showGbif").onchange = applyVisibility;
$("showMine").onchange = applyVisibility;
countFiltered();
renderFilters();
renderSpeciesList();
applyVisibility();

// The list of my spots starts collapsed; remember if it was opened.
const SPOTS_OPEN_KEY = "svampkartan.spotsOpen";
$("spotsBox").open = readJson(SPOTS_OPEN_KEY, false);
$("spotsBox").addEventListener("toggle", () => writeJson(SPOTS_OPEN_KEY, $("spotsBox").open));

// ---------- add / edit form ----------
let draft = null; // {lat, lon, editing: spot | null}
const draftMarker = L.circleMarker([0, 0], { radius: 9, fillOpacity: 0.3, color: "#1a1a1a", weight: 2, dashArray: "4 3", pane: "mine", renderer: mineRenderer, interactive: false });

function updateDraftColor() {
  const id = $("fSpecies").value;
  $("fOtherWrap").hidden = id !== "__other";
  draftMarker.setStyle({ fillColor: id === "__other" ? "#7f7f7f" : colorOf(id) });
}

function setDraftPosition(latlng) {
  draft.lat = latlng.lat;
  draft.lon = latlng.lng;
  draftMarker.setLatLng(latlng).addTo(map);
  $("fPos").value = `${draft.lat.toFixed(5)}, ${draft.lon.toFixed(5)}`;
}

function openForm(latlng, editing = null) {
  setMenuHidden(false);
  draft = { lat: 0, lon: 0, editing };
  setDraftPosition(latlng);
  $("form").hidden = false;
  $("formTitle").textContent = editing ? "Edit spot" : "New spot";
  $("fSave").textContent = editing ? "Save changes" : "Save spot";
  $("fMoveHint").hidden = !editing;
  if (editing) {
    $("fSpecies").value = species.has(editing.speciesId) ? editing.speciesId : "__other";
    $("fOther").value = species.has(editing.speciesId) ? "" : editing.species;
    $("fDate").value = editing.date || "";
    $("fAmount").value = editing.amount ?? "";
    $("fNotes").value = editing.notes || "";
  } else if (!$("fDate").value) {
    $("fDate").value = isoDate(new Date());
  }
  updateDraftColor();
  $("form").scrollIntoView({ block: "nearest" });
}
// Tapping the map starts a new spot, or moves the pin while a spot is being added or edited.
map.on("click", (e) => (draft ? setDraftPosition(e.latlng) : openForm(e.latlng)));

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
  $("fAmount").value = "";
}
$("fCancel").onclick = closeForm;

$("form").onsubmit = (e) => {
  e.preventDefault();
  if (!draft) return;
  let id = $("fSpecies").value;
  if (id === "__other") {
    const name = $("fOther").value.trim();
    if (!name) { $("fOther").focus(); return; }
    const existing = [...species.values()].find((s) => s.name.toLowerCase() === name.toLowerCase());
    id = existing ? existing.id : slug(name);
    ensureSpecies(id, existing ? existing.name : name);
  }
  const fields = {
    lat: +draft.lat.toFixed(6), lon: +draft.lon.toFixed(6),
    speciesId: id, species: species.get(id).name,
    date: $("fDate").value,
    amount: $("fAmount").value === "" ? null : +$("fAmount").value,
    notes: $("fNotes").value.trim(),
  };
  const editing = draft.editing;
  if (editing) {
    Object.assign(editing, fields);
    updateSpot(editing);
  } else {
    addSpots([{ id: crypto.randomUUID(), ...fields, created: new Date().toISOString() }]);
  }
  closeForm(); renderSpeciesList(); $("fSpecies").value = id; renderSpots();
  if (editing) openSpot(editing.id);
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
    if (data.colors) { colors = { ...data.colors, ...colors }; writeJson(COLORS_KEY, colors); cloud?.saveColors(colors); }
    const known = new Set(spots.map((s) => s.id));
    const added = incoming.filter((s) => s.id && !known.has(s.id) && isFinite(s.lat) && isFinite(s.lon));
    added.forEach((s) => {
      if (!s.speciesId) s.speciesId = [...species.values()].find((k) => s.species?.toLowerCase().startsWith(k.name.toLowerCase()))?.id || slug(s.species || "Okänd");
      ensureSpecies(s.speciesId, s.species);
    });
    addSpots(added);
    renderSpeciesList(); renderSpots();
    $("importStatus").textContent = `Imported ${added.length} spot(s).`;
  } catch (err) {
    $("importStatus").textContent = `Could not import: ${err.message}`;
  }
  e.target.value = "";
};

// ---------- offline ----------
// sw.js keeps the app, the GBIF data and viewed map tiles on the device so the app opens without signal.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
function showNetwork() { $("netStatus").hidden = navigator.onLine; }
window.addEventListener("online", showNetwork);
window.addEventListener("offline", showNetwork);
showNetwork();
