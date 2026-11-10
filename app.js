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
const map = L.map("map", { preferCanvas: true, zoomControl: false }).setView([62.5, 16.5], 5);
// crossOrigin lets the offline helper (sw.js) keep viewed map tiles compactly.
const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18, crossOrigin: true, attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);
const layersControl = L.control.layers({
  "Map": osm,
  "Topo": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17, crossOrigin: true, attribution: "&copy; OpenTopoMap" }),
  "Satellite": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18, crossOrigin: true, attribution: "&copy; Esri" }),
}); // added after the other map buttons, so it sits below them

// Inside Adventure Map's mushroom mode the buttons sit where Adventure Map's do: menu and the switch
// back at top left; location and add-a-spot at top right.
const EMBEDDED = (() => { try { return window.parent !== window && !!window.parent.setMushroomMode; } catch { return false; } })();

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
  renderSpots();
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

// While filtering by month, show a spot only if a find or visit falls in those months; undated spots are hidden.
function inSelectedMonths(s) {
  if (gbifFilter.months.size === 12) return true;
  return spotHistory(s).some((v) => v.date && gbifFilter.months.has(+v.date.slice(5, 7)));
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
    if (!hiddenSpecies.has(s.speciesId) && inSelectedMonths(s)) mineLayer.addLayer(m);
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
  renderTimeChart(); // species ticked, colours or spots changed
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
// Tapping the map moves the pin while a spot is being added or edited, or starts a new spot once the add button is on.
map.on("click", (e) => {
  if (draft) setDraftPosition(e.latlng);
  else if (placing) { setPlacing(false); openForm(e.latlng); }
});

// ---------- my location ----------
// Follows the device's GPS while tracking is on; browsers only allow this over HTTPS (or localhost).
let myPos = null;
let pendingAdd = false;
const posAccuracy = L.circle([0, 0], { radius: 0, color: "#1a73e8", weight: 1, fillOpacity: 0.12, interactive: false });
const posDot = L.circleMarker([0, 0], { radius: 7, fillColor: "#1a73e8", fillOpacity: 1, color: "#ffffff", weight: 3, pane: "mine", renderer: mineRenderer, interactive: false });

const LocateControl = L.Control.extend({
  options: { position: EMBEDDED ? "topright" : "topleft" },
  onAdd() {
    const btn = L.DomUtil.create("a", "leaflet-bar locate-btn");
    btn.href = "#";
    btn.title = "Show my location";
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", "Show my location");
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="currentColor" stroke-width="2"/></svg>`;
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, "click", (e) => { L.DomEvent.preventDefault(e); toggleTracking(); });
    return btn;
  },
});
const locateBtn = new LocateControl().addTo(map).getContainer();

// ---------- hide / show the menu ----------
const MENU_KEY = "svampkartan.menuHidden";
const MENU_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
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
if (EMBEDDED) document.body.classList.add("embedded");

const BackControl = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const btn = L.DomUtil.create("a", "leaflet-bar back-btn");
    btn.href = "#";
    btn.title = "Back to Adventure Map";
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", "Back to Adventure Map");
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M2 20 9 8l4 6 3-4 6 10z" fill="currentColor"/><circle cx="17" cy="5" r="2" fill="currentColor"/></svg>`;
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, "click", (e) => { L.DomEvent.preventDefault(e); window.parent.setMushroomMode(false); });
    return btn;
  },
});
if (EMBEDDED) {
  new BackControl().addTo(map);
  window.parent.mushroomBackShown?.(); // Adventure Map can drop its own fallback button
}

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

// ---------- add a spot on the map ----------
let placing = false; // the next tap on the map starts a new spot
const PlaceControl = L.Control.extend({
  options: { position: EMBEDDED ? "topright" : "topleft" },
  onAdd() {
    const btn = L.DomUtil.create("a", "leaflet-bar place-btn");
    btn.href = "#";
    btn.setAttribute("role", "button");
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 22s7-7.2 7-12.5a7 7 0 0 0-14 0C5 14.8 12 22 12 22z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 6.5v6M9 9.5h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, "click", (e) => { L.DomEvent.preventDefault(e); setPlacing(!placing); });
    return btn;
  },
});
const placeBtn = new PlaceControl().addTo(map).getContainer();
layersControl.addTo(map);

function setPlacing(on) {
  placing = on;
  placeBtn.classList.toggle("active", on);
  map.getContainer().classList.toggle("placing", on);
  const label = on ? "Cancel adding a spot" : "Add a spot on the map";
  placeBtn.title = label;
  placeBtn.setAttribute("aria-label", label);
  placeBtn.setAttribute("aria-pressed", String(on));
}
setPlacing(false);

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

// ---------- finds by time ----------
// A pop-up with two bar charts on the same time axis: GBIF records and my finds, for the species ticked in
// the list. Each has its own scale (GBIF counts are thousands, mine are tens), stacked by species colour.
let timeGroup = "month"; // or "week" (ISO week of the year)
const isoWeek = (iso) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // Thursday of that week decides the year
  const week = Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
  return Math.min(week, 52); // the rare week 53 joins week 52
};
// Bin index for a date string, or -1 if the date is too vague for this grouping.
function timeBin(date) {
  if (!date || date.length < 7) return -1;
  if (timeGroup === "month") return +date.slice(5, 7) - 1;
  return date.length >= 10 ? isoWeek(date.slice(0, 10)) - 1 : -1;
}
const compact = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(n));
function niceStep(max) {
  const raw = max / 3, p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) || p;
}

// ---------- regions: Swedish counties (län) and their landsdel, from data/regions.js ----------
const REGION_KEY = "svampkartan.timeRegion";
// Each ring as a flat [x0, y0, x1, y1, …] array with its own bounding box, so most tests stop at the box.
const ringOf = (pts) => {
  const xy = new Float64Array(pts.flat());
  let w = 180, e = -180, s = 90, n = -90;
  for (let i = 0; i < xy.length; i += 2) { w = Math.min(w, xy[i]); e = Math.max(e, xy[i]); s = Math.min(s, xy[i + 1]); n = Math.max(n, xy[i + 1]); }
  return { xy, w, s, e, n };
};
const counties = (window.SE_REGIONS || []).map((c) => {
  const polys = c.polys.map((p) => p.map(ringOf));
  const outer = polys.map((p) => p[0]);
  return { ...c, polys, bbox: [Math.min(...outer.map((r) => r.w)), Math.min(...outer.map((r) => r.s)), Math.max(...outer.map((r) => r.e)), Math.max(...outer.map((r) => r.n))] };
});
function inRing(x, y, r) {
  if (x < r.w || x > r.e || y < r.s || y > r.n) return false;
  const p = r.xy, len = p.length;
  let inside = false;
  for (let i = 0, j = len - 2; i < len; j = i, i += 2) {
    const yi = p[i + 1], yj = p[j + 1];
    if ((yi > y) !== (yj > y) && x < ((p[j] - p[i]) * (y - yi)) / (yj - yi) + p[i]) inside = !inside;
  }
  return inside;
}
// County code for a point. The boundaries are simplified, so a find just off the coast or on a small
// island goes to the nearest county within about 10 km; anything further out (e.g. abroad) gets none.
function countyAt(lat, lon) {
  for (const c of counties) {
    const [w, s, e, n] = c.bbox;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    for (const poly of c.polys) {
      if (inRing(lon, lat, poly[0]) && !poly.slice(1).some((hole) => inRing(lon, lat, hole))) return c.code;
    }
  }
  const k = Math.cos((lat * Math.PI) / 180);
  let best = null, bestD = 0.09 ** 2; // ~10 km, in degrees of latitude
  for (const c of counties) {
    const [w, s, e, n] = c.bbox;
    if (lon < w - 0.2 || lon > e + 0.2 || lat < s - 0.1 || lat > n + 0.1) continue;
    for (const poly of c.polys) {
      const p = poly[0].xy;
      for (let i = 0; i < p.length; i += 2) {
        const d = (p[i + 1] - lat) ** 2 + ((p[i] - lon) * k) ** 2;
        if (d < bestD) { bestD = d; best = c.code; }
      }
    }
  }
  return best;
}
const countyCache = new WeakMap(); // GBIF record -> county code, worked out once
function recordCounty(r) {
  if (!countyCache.has(r)) countyCache.set(r, countyAt(r[0], r[1]));
  return countyCache.get(r);
}
let timeRegion = readJson(REGION_KEY, "all"); // "all" | "view" | "part:Norrland" | "lan:AB"
function regionTest() {
  if (timeRegion === "view") {
    const b = map.getBounds();
    return (lat, lon) => b.contains([lat, lon]);
  }
  const [kind, value] = timeRegion.split(":");
  const codes = new Set(kind === "part" ? counties.filter((c) => c.part === value).map((c) => c.code) : kind === "lan" ? [value] : []);
  if (!codes.size) return null; // all of Sweden, and anything else
  return (lat, lon, r) => codes.has(r ? recordCounty(r) : countyAt(lat, lon));
}
function renderRegionSelect() {
  const sel = $("timeRegion");
  const parts = ["Götaland", "Svealand", "Norrland"];
  sel.innerHTML = `<option value="all">All of Sweden</option><option value="view">Area shown on the map</option>`
    + `<optgroup label="Landsdel">${parts.map((p) => `<option value="part:${p}">${p}</option>`).join("")}</optgroup>`
    + `<optgroup label="Län">${counties.map((c) => `<option value="lan:${c.code}">${escapeHtml(c.name)}</option>`).join("")}</optgroup>`;
  if (![...sel.options].some((o) => o.value === timeRegion)) timeRegion = "all";
  sel.value = timeRegion;
}

function timeCounts() {
  const bins = timeGroup === "month" ? 12 : 52;
  const shown = [...species.values()].filter((s) => !hiddenSpecies.has(s.id));
  const inRegion = regionTest();
  const gbif = new Map(), mine = new Map();
  let gbifVague = 0, mineVague = 0;
  for (const s of shown) {
    if (s.gbif.length) {
      const c = new Array(bins).fill(0);
      for (const r of s.gbif) {
        if (inRegion && !inRegion(r[0], r[1], r)) continue;
        const b = timeBin(r[2]); b < 0 ? gbifVague++ : c[b]++;
      }
      gbif.set(s.id, c);
    }
    const c = new Array(bins).fill(0);
    for (const p of spots) {
      if (p.speciesId !== s.id) continue;
      if (inRegion && !inRegion(p.lat, p.lon)) continue;
      // The first find and every visit that found something; "None" visits are not finds.
      let placed = false;
      for (const v of spotHistory(p)) {
        if (v.amount === 0) continue;
        const b = timeBin(v.date);
        if (b >= 0) { c[b]++; placed = true; }
      }
      if (!placed) mineVague++; // spots with no usable date, e.g. imported from Google Maps
    }
    if (c.some(Boolean)) mine.set(s.id, c);
  }
  return { bins, shown, gbif, mine, gbifVague, mineVague };
}

function barChartSvg(width, bins, series, style) {
  const height = 130, top = 14, bottom = 18, left = 34, right = 4;
  const plotH = height - top - bottom, plotW = width - left - right, slot = plotW / bins;
  const totals = new Array(bins).fill(0);
  for (const c of series.values()) c.forEach((n, i) => { totals[i] += n; });
  const max = Math.max(1, ...totals);
  const step = niceStep(max), yMax = Math.ceil(max / step) * step;
  const y = (n) => top + plotH - (n / yMax) * plotH;
  let out = "";
  for (let t = 0; t <= yMax; t += step) {
    out += `<line x1="${left}" x2="${width - right}" y1="${y(t)}" y2="${y(t)}" stroke="var(--border)"/>`
      + `<text x="${left - 4}" y="${y(t) + 3}" text-anchor="end">${compact(t)}</text>`;
  }
  const gap = Math.min(4, slot * 0.2), barW = slot - gap;
  for (let i = 0; i < bins; i++) {
    const x = left + i * slot + gap / 2;
    let base = 0;
    for (const [id, c] of series) {
      if (!c[i]) continue;
      out += `<rect x="${x}" y="${y(base + c[i])}" width="${barW}" height="${y(base) - y(base + c[i])}" fill="${colorOf(id)}" ${style}>`
        + `<title>${escapeHtml(species.get(id).name)}: ${c[i]}</title></rect>`;
      base += c[i];
    }
    if (timeGroup === "month" && totals[i]) {
      out += `<text x="${x + barW / 2}" y="${y(totals[i]) - 3}" text-anchor="middle" style="fill:var(--fg)">${compact(totals[i])}</text>`;
    }
  }
  // Time axis: month names, or for weeks the name at the week each month starts in.
  for (let m = 0; m < 12; m++) {
    const at = timeGroup === "month" ? m + 0.5 : isoWeek(`2025-${String(m + 1).padStart(2, "0")}-04`) - 0.5;
    const label = slot * (timeGroup === "month" ? 1 : 4.3) < 26 ? MONTHS[m][0] : MONTHS[m];
    out += `<text x="${left + at * slot}" y="${height - 4}" text-anchor="middle">${label}</text>`;
  }
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${out}</svg>`;
}

function renderTimeChart() {
  if (!$("timeDialog").open) return;
  const { bins, shown, gbif, mine, gbifVague, mineVague } = timeCounts();
  const width = Math.max(260, $("timeChart").clientWidth || 600);
  const sum = (m) => [...m.values()].reduce((n, c) => n + c.reduce((a, b) => a + b, 0), 0);
  const vague = (n, what) => (n ? ` · ${n.toLocaleString("sv-SE")} ${what} without ${timeGroup === "month" ? "a month" : "a full date"}` : "");
  const panel = (title, mk, series, style, total, nVague, what, empty) => `<div class="tc-panel">
      <h4><span class="mk ${mk}"></span>${title} <small>${total.toLocaleString("sv-SE")} finds${vague(nVague, what)}</small></h4>
      ${total ? barChartSvg(width, bins, series, style) : `<p class="tc-empty">${empty}</p>`}</div>`;
  const used = shown.filter((s) => gbif.get(s.id)?.some(Boolean) || mine.has(s.id));
  $("timeChart").innerHTML = !shown.length
    ? `<p class="tc-empty">No species are ticked. Tick species in the list to see their finds over the year.</p>`
    : panel("GBIF records", "gbif", gbif, `fill-opacity="0.6"`, sum(gbif), gbifVague, "records", "No GBIF records for these species.")
      + panel("My finds", "mine", mine, `stroke="#1a1a1a" stroke-width="1"`, sum(mine), mineVague, "spots",
        "No dated finds of your own for these species yet. Finds and visits with a date show up here.")
      + `<div class="tc-legend">${used.map((s) => `<span><i style="--c:${colorOf(s.id)}"></i>${escapeHtml(s.name)}</span>`).join("")}</div>`;
}

function openTimeChart() {
  if (!$("timeDialog").open) $("timeDialog").showModal();
  renderTimeChart();
}
renderRegionSelect();
$("timeRegion").onchange = (e) => { timeRegion = e.target.value; writeJson(REGION_KEY, timeRegion); renderTimeChart(); };
$("timeBtn").onclick = openTimeChart;
$("timeClose").onclick = () => $("timeDialog").close();
// Tapping the dimmed area outside the box closes it.
$("timeDialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$("timeDialog").querySelector(".seg").onclick = (e) => {
  const g = e.target.dataset?.group;
  if (!g) return;
  timeGroup = g;
  e.currentTarget.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.group === g)));
  renderTimeChart();
};
window.addEventListener("resize", renderTimeChart);

const TimeControl = L.Control.extend({
  options: { position: EMBEDDED ? "topright" : "topleft" },
  onAdd() {
    const btn = L.DomUtil.create("a", "leaflet-bar chart-btn");
    btn.href = "#";
    btn.title = "Finds by time";
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", "Finds by time");
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 20h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M6 17v-5M10 17V7M14 17v-7M18 17V4" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>`;
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, "click", (e) => { L.DomEvent.preventDefault(e); openTimeChart(); });
    return btn;
  },
});
// Sits below the other map buttons, above the layer switcher.
map.removeControl(layersControl);
new TimeControl().addTo(map);
layersControl.addTo(map);

// ---------- offline ----------
// sw.js keeps the app, the GBIF data and viewed map tiles on the device so the app opens without signal.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
function showNetwork() { $("netStatus").hidden = navigator.onLine; }
window.addEventListener("online", showNetwork);
window.addEventListener("offline", showNetwork);
showNetwork();
