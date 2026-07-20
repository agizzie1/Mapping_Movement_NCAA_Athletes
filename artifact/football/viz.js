// =============================================================================
// Transfer portal flow diagram -- two-ring radial layout (roster / portal
// entries) plus chord ribbons showing player movement, one instance each for
// FBS and FCS.
// =============================================================================

const PALETTES = {
  fbs: {
    conferences: ["SEC", "Big Ten", "ACC", "Big 12", "American", "Conference USA", "MAC", "Mountain West", "Sun Belt", "Pac-12", "FBS Independent"],
    light: ["#c15975", "#71ab52", "#4b69bd", "#c25f41", "#0cb289", "#7b5ab1", "#b26f00", "#00b0bb", "#9b4d91", "#8f8200", "#20a4de"],
    dark:  ["#b04363", "#609e3d", "#3b59b2", "#b24928", "#00a67b", "#6e48a5", "#a25b00", "#00a3af", "#8e3b84", "#7f7000", "#0097d4"],
  },
  fcs: {
    conferences: ["CAA", "Missouri Valley", "Big Sky", "Southland", "SoCon", "Patriot League", "NEC", "Ivy League", "MEAC", "SWAC", "UAC", "OVC", "Pioneer League", "Big South"],
    light: ["#c45a5e", "#55af68", "#5d64bb", "#c06232", "#00b392", "#7f58ae", "#b17000", "#00b0b9", "#984e95", "#977f00", "#00a8d7", "#a84874", "#728c1e", "#539ce8"],
    dark:  ["#b3444a", "#3da257", "#4e54b0", "#b04d0f", "#00a684", "#7247a3", "#a15c00", "#00a3ad", "#8b3c88", "#876d00", "#009acd", "#9b3566", "#5f7b00", "#3c8edf"],
  },
};

const SCHOOL_PAD = 0.0022;
const CONF_PAD = 0.028;
const MIN_PORTAL_WEIGHT = 0.6; // visual floor so 0-entry schools still get a sliver
const ZOOM_DETAIL_THRESHOLD = 3; // zoom scale (k) past which individual player lines become interactive
const ZOOM_OUT_FLOOR = 0.4; // how far below 100% the +/- buttons, Ctrl/Cmd+scroll, and pinch can shrink the diagram

function currentMode() {
  const stamped = document.documentElement.getAttribute("data-theme");
  if (stamped === "dark" || stamped === "light") return stamped;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getDirection(key) {
  const el = document.querySelector(`input[name="dir-${key}"]:checked`);
  return el ? el.value : "both";
}

// ---------------------------------------------------------------------------
// Ring layout: groups (already sorted by conference then school) laid out
// around the full circle, weighted by `weightFn`, with a small pad between
// schools and a larger pad at conference boundaries (including the
// wrap-around gap between the last and first conference -- the total pad
// budget below is chosen so that gap comes out to exactly one confPad with
// no extra bookkeeping; see the derivation this matches in the corresponding
// design notes).
// ---------------------------------------------------------------------------
function layoutRing(items, conferenceOrder, weightFn) {
  const sorted = items.slice().sort((a, b) =>
    conferenceOrder.indexOf(a.conference) - conferenceOrder.indexOf(b.conference) ||
    a.school.localeCompare(b.school)
  );
  const nConf = conferenceOrder.length;
  const n = sorted.length;
  const totalWeight = d3.sum(sorted, weightFn);
  const totalPad = (n - nConf) * SCHOOL_PAD + nConf * CONF_PAD;
  const scale = (2 * Math.PI - totalPad) / totalWeight;

  let angle = 0;
  let prevConf = null;
  const out = [];
  for (const s of sorted) {
    if (prevConf !== null) angle += (s.conference !== prevConf) ? CONF_PAD : SCHOOL_PAD;
    const width = weightFn(s) * scale;
    out.push(Object.assign({}, s, { startAngle: angle, endAngle: angle + width }));
    angle += width;
    prevConf = s.conference;
  }
  return out;
}

function conferenceSpans(ringLayout, conferenceOrder) {
  const spans = new Map();
  for (const c of conferenceOrder) {
    const items = ringLayout.filter(d => d.conference === c);
    if (!items.length) continue;
    spans.set(c, {
      conference: c,
      startAngle: items[0].startAngle,
      endAngle: items[items.length - 1].endAngle,
      portalEntries: d3.sum(items, d => d.portalEntries),
      roster: d3.sum(items, d => d.roster),
      schools: items,
    });
  }
  return spans;
}

// Subdivide a span's angular range among its outgoing flows (largest first),
// then whatever is left over. `weightOf(flow)` returns the flow's count;
// `total` is the true denominator (real portal-entry count, NOT the
// floored/visual weight used for arc sizing) so proportions reflect reality
// even for the tiny-sliver zero-entry case.
function subdivide(span, flows, total) {
  const sorted = flows.slice().sort((a, b) => b.count - a.count);
  const arcSpan = span.endAngle - span.startAngle;
  const denom = Math.max(total, 1e-9);
  let a = span.startAngle;
  const segments = [];
  for (const f of sorted) {
    const w = (f.count / denom) * arcSpan;
    segments.push({ target: f.target, count: f.count, startAngle: a, endAngle: a + w });
    a += w;
  }
  return { segments, leftoverStart: a, leftoverEnd: span.endAngle };
}

// Evenly split an angular range among a list of items (used to lay out
// individual player lines within a destination segment or the leftover
// segment). Returns [] for an empty list rather than dividing by zero.
function evenTicks(startAngle, endAngle, items) {
  const n = items.length;
  if (n === 0) return [];
  const w = (endAngle - startAngle) / n;
  return items.map((item, i) => ({ item, startAngle: startAngle + i * w, endAngle: startAngle + (i + 1) * w }));
}

// Look up the precise angular slice a conference/school's INCOMING
// subdivision (confSubIncoming / schoolSubIncoming) allocated to a specific
// sender, for use as a ribbon's target endpoint. Falls back to the full
// span if not found (shouldn't happen for a real flow, but keeps a missing
// entry from throwing rather than just drawing a slightly-off ribbon).
function incomingSegment(subIncomingMap, targetKey, sourceKey, fallbackSpan) {
  const sub = subIncomingMap.get(targetKey);
  const seg = sub && sub.segments.find(s => s.target === sourceKey);
  return seg || fallbackSpan;
}

// Split a school's raw departures list into per-destination groups (for
// tracked targets -- same universe, or same "combined" scope, per
// `isTracked`) and a leftover bucket (still in the portal, or left this
// scope entirely). Mirrors the same predicate the Python side uses to build
// the aggregate `flows` counts, so a segment's `count` always matches the
// length of its corresponding player group here.
function classifyDepartures(departures, isTracked) {
  const byTarget = new Map();
  const leftover = [];
  for (const dep of departures || []) {
    if (dep.t !== "Still in Portal" && isTracked(dep.tc)) {
      if (!byTarget.has(dep.t)) byTarget.set(dep.t, []);
      byTarget.get(dep.t).push(dep);
    } else {
      leftover.push(dep);
    }
  }
  return { byTarget, leftover };
}
function buildSchoolPlayers(layoutItems, isTracked) {
  const m = new Map();
  for (const s of layoutItems) m.set(s.school, classifyDepartures(s.departures, isTracked));
  return m;
}

function polar(angle, radius, offset) {
  const ox = offset ? offset[0] : 0, oy = offset ? offset[1] : 0;
  return [ox + radius * Math.sin(angle), oy - radius * Math.cos(angle)];
}

function midAngle(d) { return (d.startAngle + d.endAngle) / 2; }

// ---------------------------------------------------------------------------
// Build everything needed to render one universe (fbs or fcs).
// ---------------------------------------------------------------------------
function prepareUniverse(data, conferenceOrder) {
  const schools = data.schools;
  const outerLayout = layoutRing(schools, conferenceOrder, d => d.roster);
  const innerLayout = layoutRing(schools, conferenceOrder, d => Math.max(d.portalEntries, MIN_PORTAL_WEIGHT));

  const outerByName = new Map(outerLayout.map(d => [d.school, d]));
  const innerByName = new Map(innerLayout.map(d => [d.school, d]));

  const flowsBySource = new Map();
  const flowsByTarget = new Map();
  for (const f of data.flows) {
    if (!flowsBySource.has(f.source)) flowsBySource.set(f.source, []);
    flowsBySource.get(f.source).push(f);
    if (!flowsByTarget.has(f.target)) flowsByTarget.set(f.target, []);
    flowsByTarget.get(f.target).push(f);
  }

  // Per-school subdivision of the inner arc among its own outgoing flows.
  const schoolSub = new Map();
  for (const s of innerLayout) {
    const flows = flowsBySource.get(s.school) || [];
    schoolSub.set(s.school, subdivide(s, flows, s.portalEntries));
  }

  // Mirror of schoolSub for INCOMING flows: subdivides the same arc among
  // the schools this one received players FROM. Every incoming flow is
  // "tracked" by construction (it only exists as a flow record at all if
  // both ends are known), so total-incoming exactly fills the arc with no
  // leftover bucket needed -- unlike the outgoing subdivision, which always
  // leaves room for untracked departures.
  //
  // A ribbon's source endpoint already uses the sender's schoolSub segment
  // (proportional to that flow's count out of the sender's own total); the
  // target endpoint should use THIS map's segment instead of the whole
  // destination arc, or the ribbon flares out to the destination's total
  // size regardless of how many players that specific flow represents.
  const schoolSubIncoming = new Map();
  for (const s of innerLayout) {
    const inFlows = (flowsByTarget.get(s.school) || []).map(f => ({ target: f.source, count: f.count }));
    const totalIn = d3.sum(inFlows, f => f.count);
    schoolSubIncoming.set(s.school, subdivide(s, inFlows, totalIn));
  }

  // Per-school, per-destination lists of the actual departing players, used
  // to draw individual lines within each segment on zoom.
  const confSet = new Set(conferenceOrder);
  const schoolPlayers = buildSchoolPlayers(innerLayout, tc => confSet.has(tc));

  // Conference-level aggregate (the default, always-visible chord view).
  const innerConfSpans = conferenceSpans(innerLayout, conferenceOrder);
  const flowsBySourceConf = new Map();
  const flowsByTargetConf = new Map();
  for (const f of data.flows) {
    const srcConf = innerByName.get(f.source).conference;
    const tgtConf = innerByName.get(f.target).conference;
    if (!flowsBySourceConf.has(srcConf)) flowsBySourceConf.set(srcConf, new Map());
    const outM = flowsBySourceConf.get(srcConf);
    outM.set(tgtConf, (outM.get(tgtConf) || 0) + f.count);
    if (!flowsByTargetConf.has(tgtConf)) flowsByTargetConf.set(tgtConf, new Map());
    const inM = flowsByTargetConf.get(tgtConf);
    inM.set(srcConf, (inM.get(srcConf) || 0) + f.count);
  }
  const confSub = new Map();
  const confSubIncoming = new Map();
  for (const [conf, span] of innerConfSpans) {
    const outFlows = Array.from(flowsBySourceConf.get(conf) || [], ([target, count]) => ({ target, count }));
    confSub.set(conf, subdivide(span, outFlows, span.portalEntries));
    const inFlows = Array.from(flowsByTargetConf.get(conf) || [], ([source, count]) => ({ target: source, count }));
    const totalIn = d3.sum(inFlows, f => f.count);
    confSubIncoming.set(conf, subdivide(span, inFlows, totalIn));
  }

  return {
    data, conferenceOrder,
    outerLayout, innerLayout, outerByName, innerByName,
    flowsBySource, flowsByTarget, schoolSub, schoolSubIncoming, schoolPlayers,
    innerConfSpans, confSub, confSubIncoming,
  };
}

// ---------------------------------------------------------------------------
// Build everything needed to render the combined FBS<->FCS side-by-side
// view. Each school still lays out on its OWN circle (FBS conferences on
// one, FCS conferences on the other) via the same layoutRing()/subdivide()
// helpers used for the solo diagrams -- the only new thing here is that
// `data.flows` includes CROSS-level transfers too, so a school's inner-arc
// subdivision (and each conference's aggregate) now has real ribbons for
// FBS<->FCS movement instead of folding it into "leftover".
// ---------------------------------------------------------------------------
function prepareCombined(data) {
  const fbsSchools = data.schools.filter(s => s.universe === "fbs");
  const fcsSchools = data.schools.filter(s => s.universe === "fcs");

  const outerLayoutFbs = layoutRing(fbsSchools, PALETTES.fbs.conferences, d => d.roster);
  const innerLayoutFbs = layoutRing(fbsSchools, PALETTES.fbs.conferences, d => Math.max(d.portalEntries, MIN_PORTAL_WEIGHT));
  const outerLayoutFcs = layoutRing(fcsSchools, PALETTES.fcs.conferences, d => d.roster);
  const innerLayoutFcs = layoutRing(fcsSchools, PALETTES.fcs.conferences, d => Math.max(d.portalEntries, MIN_PORTAL_WEIGHT));

  const innerByName = new Map();
  for (const d of innerLayoutFbs) innerByName.set(d.school, Object.assign({}, d, { universe: "fbs" }));
  for (const d of innerLayoutFcs) innerByName.set(d.school, Object.assign({}, d, { universe: "fcs" }));
  const outerByName = new Map();
  for (const d of outerLayoutFbs) outerByName.set(d.school, Object.assign({}, d, { universe: "fbs" }));
  for (const d of outerLayoutFcs) outerByName.set(d.school, Object.assign({}, d, { universe: "fcs" }));

  const flowsBySource = new Map();
  const flowsByTarget = new Map();
  for (const f of data.flows) {
    if (!flowsBySource.has(f.source)) flowsBySource.set(f.source, []);
    flowsBySource.get(f.source).push(f);
    if (!flowsByTarget.has(f.target)) flowsByTarget.set(f.target, []);
    flowsByTarget.get(f.target).push(f);
  }

  const schoolSub = new Map();
  const schoolSubIncoming = new Map();
  for (const [name, d] of innerByName) {
    schoolSub.set(name, subdivide(d, flowsBySource.get(name) || [], d.portalEntries));
    const inFlows = (flowsByTarget.get(name) || []).map(f => ({ target: f.source, count: f.count }));
    const totalIn = d3.sum(inFlows, f => f.count);
    schoolSubIncoming.set(name, subdivide(d, inFlows, totalIn));
  }

  const allConfSet = new Set([...PALETTES.fbs.conferences, ...PALETTES.fcs.conferences]);
  const schoolPlayers = buildSchoolPlayers(Array.from(innerByName.values()), tc => allConfSet.has(tc));

  // Conference names are disjoint between the two lists (no FBS conference
  // shares a name with an FCS one), so they can share one Map keyed by name.
  const innerConfSpansFbs = conferenceSpans(innerLayoutFbs, PALETTES.fbs.conferences);
  const innerConfSpansFcs = conferenceSpans(innerLayoutFcs, PALETTES.fcs.conferences);
  const innerConfSpans = new Map([...innerConfSpansFbs, ...innerConfSpansFcs]);
  const outerConfSpansFbs = conferenceSpans(outerLayoutFbs, PALETTES.fbs.conferences);
  const outerConfSpansFcs = conferenceSpans(outerLayoutFcs, PALETTES.fcs.conferences);

  const flowsBySourceConf = new Map();
  const flowsByTargetConf = new Map();
  for (const f of data.flows) {
    const srcConf = innerByName.get(f.source).conference;
    const tgtConf = innerByName.get(f.target).conference;
    if (!flowsBySourceConf.has(srcConf)) flowsBySourceConf.set(srcConf, new Map());
    const outM = flowsBySourceConf.get(srcConf);
    outM.set(tgtConf, (outM.get(tgtConf) || 0) + f.count);
    if (!flowsByTargetConf.has(tgtConf)) flowsByTargetConf.set(tgtConf, new Map());
    const inM = flowsByTargetConf.get(tgtConf);
    inM.set(srcConf, (inM.get(srcConf) || 0) + f.count);
  }
  const confSub = new Map();
  const confSubIncoming = new Map();
  for (const [conf, span] of innerConfSpans) {
    const outFlows = Array.from(flowsBySourceConf.get(conf) || [], ([target, count]) => ({ target, count }));
    confSub.set(conf, subdivide(span, outFlows, span.portalEntries));
    const inFlows = Array.from(flowsByTargetConf.get(conf) || [], ([source, count]) => ({ target: source, count }));
    const totalIn = d3.sum(inFlows, f => f.count);
    confSubIncoming.set(conf, subdivide(span, inFlows, totalIn));
  }

  return {
    data, fbsSchools, fcsSchools,
    outerLayoutFbs, innerLayoutFbs, outerLayoutFcs, innerLayoutFcs,
    outerConfSpansFbs, outerConfSpansFcs,
    outerByName, innerByName,
    flowsBySource, flowsByTarget, schoolSub, schoolSubIncoming, schoolPlayers,
    innerConfSpans, confSub, confSubIncoming,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function attachZoom(svg, target, scaleExtent, onZoomLevel) {
  let panned = false;
  const zoom = d3.zoom()
    .scaleExtent(scaleExtent || [1, 8])
    .filter((event) => {
      if (event.type === "wheel") return event.ctrlKey || event.metaKey;
      return !event.button;
    })
    .on("start", (event) => { if (event.sourceEvent) panned = false; })
    .on("zoom", (event) => {
      target.attr("transform", event.transform);
      if (event.sourceEvent && event.sourceEvent.type !== "wheel") panned = true;
      if (onZoomLevel) onZoomLevel(event.transform.k);
    });
  svg.call(zoom).on("dblclick.zoom", null);
  return {
    zoomBy: (factor) => svg.transition().duration(200).call(zoom.scaleBy, factor),
    reset: () => svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity),
    wasPanned: () => { const p = panned; panned = false; return p; },
  };
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

// Shared player-detail helpers, used by tooltips and the side panel alike so
// the two stay worded consistently.
function depStatusHtml(dep) {
  return dep.t === "Still in Portal"
    ? "still in the transfer portal"
    : `transferred to ${dep.t}${dep.tc && dep.tc !== "Unknown" ? " (" + dep.tc + ")" : ""}`;
}
function playerMetaHtml(dep) {
  const pt = dep.pt === null || dep.pt === undefined ? "unknown prior transfers" : `${dep.pt} prior transfer${dep.pt === 1 ? "" : "s"}`;
  return `${dep.pos} &middot; ${dep.gr} &middot; ${pt}`;
}
function playerKey(school, dep) { return school + " " + dep.n + " " + dep.d; }

// ---------------------------------------------------------------------------
// Filters: position, class/grade, prior-transfer count, and transfer month
// are all "additive" (multi-select within a dimension is OR) and "stackable"
// (across dimensions is AND). Ring/segment geometry never changes shape from
// these -- only which ticks/ribbons are highlighted vs. dimmed, which
// players show up in the side panel, and a live match count. That keeps the
// diagram visually stable while still answering "how many X are
// transferring, in general and from this conference/school" via the count
// and the (filtered) segment click-through.
// ---------------------------------------------------------------------------
const FILTER_DIMS = [
  { key: "conf", label: "Conference" },
  { key: "school", label: "School" },
  { key: "pos", label: "Position" },
  { key: "gr", label: "Class" },
  { key: "pt", label: "Prior transfers" },
  { key: "d", label: "Transfer date" },
];
const GRADE_ORDER = [
  "Freshman", "RedShirt Freshman", "Sophomore", "RedShirt Sophomore",
  "Junior", "RedShirt Junior", "Senior", "RedShirt Senior", "Unknown",
];
const MONTH_INDEX = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};
function dateSortKey(s) {
  const [month, year] = s.split(" ");
  return parseInt(year, 10) * 12 + (MONTH_INDEX[month] || 0);
}
// `conferenceOrder` (ring layout order) is only needed to sort the "conf"
// dimension's chips; every other dimension sorts by its own fixed rule.
function sortFilterValues(dim, values, conferenceOrder) {
  const arr = Array.from(values);
  if (dim === "d") return arr.sort((a, b) => dateSortKey(a) - dateSortKey(b));
  if (dim === "gr") return arr.sort((a, b) => GRADE_ORDER.indexOf(a) - GRADE_ORDER.indexOf(b));
  if (dim === "pt") return arr.sort((a, b) => (a === null ? Infinity : a) - (b === null ? Infinity : b));
  if (dim === "conf" && conferenceOrder) return arr.sort((a, b) => conferenceOrder.indexOf(a) - conferenceOrder.indexOf(b));
  return arr.sort((a, b) => (a === "Unknown" ? 1 : b === "Unknown" ? -1 : a.localeCompare(b)));
}
function filterValueLabel(dim, v) {
  if (dim === "pt") return v === null ? "Unknown" : String(v);
  return v;
}
// `home` is the departing player's origin { conf, school } -- neither is a
// field on `dep` itself (which only carries the *destination* school/
// conference, `t`/`tc`), so every caller passes it in from whatever school
// or conference it's already iterating. Matching on origin means the
// "Conference"/"School" filters are inherently "out of this conference/
// school" filters (see the note on the auto-rendered filtered view below
// for why that's the useful behavior).
function matchesFilters(dep, filters, home) {
  for (const { key: dim } of FILTER_DIMS) {
    if (dim === "conf") {
      if (filters.conf.size && !filters.conf.has(home.conf)) return false;
      continue;
    }
    if (dim === "school") {
      if (filters.school.size && !filters.school.has(home.school)) return false;
      continue;
    }
    const set = filters[dim];
    if (set.size && !set.has(dep[dim])) return false;
  }
  return true;
}
function filtersActive(filters) {
  return FILTER_DIMS.some(({ key: dim }) => filters[dim].size > 0);
}
// A conference-pair ribbon naturally aggregates every school in each
// conference, so "SEC -> ACC" is its correct label by default. But once
// filters (a School pick, especially) narrow the underlying players down to
// a single origin school and/or a single destination school, showing the
// conference name on that side is needlessly vague -- swap in the specific
// school instead, independently per side, so "Alabama -> SEC" (one matching
// origin, several destinations) and "Alabama -> Georgia" (both narrowed)
// are both shown as precisely as the current filters actually support.
function pairLabel(deps, fallbackSource, fallbackTarget) {
  const schools = new Set(deps.map(r => r.school));
  const targets = new Set(deps.map(r => r.dep.t));
  const sourceLabel = schools.size === 1 ? [...schools][0] : fallbackSource;
  const targetLabel = targets.size === 1 ? [...targets][0] : fallbackTarget;
  return `${sourceLabel} &rarr; ${targetLabel}`;
}

// Builds the chip UI for one panel's filter bar from its full player list,
// and returns the live filter state plus a way to subscribe to changes.
// `allDeps` is every departure in the universe (colored + leftover alike),
// each tagged with the departing player's home conference, used both to
// populate each dimension's chip values and to compute the live "N of M
// players match" count.
function buildFilterBar(key, allDeps, conferenceOrder) {
  const filters = {};
  for (const { key: dim } of FILTER_DIMS) filters[dim] = new Set();
  const listeners = [];

  function refreshChrome() {
    const activeCount = FILTER_DIMS.reduce((n, { key: dim }) => n + filters[dim].size, 0);
    const matchCount = allDeps.reduce((n, r) => n + (matchesFilters(r.dep, filters, { conf: r.conf, school: r.school }) ? 1 : 0), 0);
    const countEl = document.getElementById(`filtercount-${key}`);
    if (countEl) {
      countEl.textContent = activeCount
        ? `${activeCount} active · ${matchCount.toLocaleString()} of ${allDeps.length.toLocaleString()} match`
        : `${allDeps.length.toLocaleString()} players`;
    }
    const clearBtn = document.getElementById(`filterclear-${key}`);
    if (clearBtn) clearBtn.classList.toggle("visible", activeCount > 0);
    const toggleBtn = document.getElementById(`filtertoggle-${key}`);
    if (toggleBtn) toggleBtn.classList.toggle("has-active", activeCount > 0);
  }

  for (const { key: dim } of FILTER_DIMS) {
    const container = document.getElementById(`chips-${key}-${dim}`);
    if (!container) continue;
    container.innerHTML = "";
    const raw = dim === "conf" ? allDeps.map(r => r.conf)
      : dim === "school" ? allDeps.map(r => r.school)
      : allDeps.map(r => r.dep[dim]);
    const values = sortFilterValues(dim, new Set(raw), conferenceOrder);
    for (const v of values) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "filter-chip";
      btn.textContent = filterValueLabel(dim, v);
      btn.addEventListener("click", () => {
        if (filters[dim].has(v)) filters[dim].delete(v); else filters[dim].add(v);
        btn.classList.toggle("active");
        refreshChrome();
        listeners.forEach(fn => fn());
      });
      container.appendChild(btn);
    }
  }

  const clearBtn = document.getElementById(`filterclear-${key}`);
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      for (const { key: dim } of FILTER_DIMS) filters[dim].clear();
      document.querySelectorAll(`#filterpanel-${key} .filter-chip.active`).forEach(el => el.classList.remove("active"));
      refreshChrome();
      listeners.forEach(fn => fn());
    });
  }

  const toggleBtn = document.getElementById(`filtertoggle-${key}`);
  const panelEl = document.getElementById(`filterpanel-${key}`);
  if (toggleBtn && panelEl) {
    toggleBtn.addEventListener("click", () => {
      const wasHidden = panelEl.hasAttribute("hidden");
      if (wasHidden) panelEl.removeAttribute("hidden"); else panelEl.setAttribute("hidden", "");
      toggleBtn.classList.toggle("open", wasHidden);
    });
  }

  refreshChrome();
  return { filters, onChange: fn => listeners.push(fn) };
}

// ---- side panel: full player lists for a clicked segment, or a single
// player's detail, without crowding the diagram itself with a big tooltip.
// A row may carry an `onClick(selected)` -- used only for rows whose whole
// origin->destination ribbon is exactly that one player, so "isolating" the
// row's ribbon is unambiguous. Rows without onClick (multi-player pairs)
// render as plain, non-interactive text.
//
// The panel itself lives in normal document flow, not position: fixed, so
// it can never float above a diagram's filters -- it shares a row with
// that panel's .filter-panel dropdown instead (filters on the left, popup
// on the right, matching height), pushing the diagram down while open.
// Each of renderUniverse/renderCombined defines a LOCAL showSidePanel()
// that shadows this one: it first moves the single shared #side-panel node
// into that panel's own .filter-panel-row (via positionSidePanel), then
// delegates here to fill it in. Call renderSidePanelBody directly only
// from code that's already certain the panel is positioned correctly (i.e.
// nothing outside this file).
function positionSidePanel(rowEl) {
  const panel = document.getElementById("side-panel");
  if (panel && rowEl && panel.parentElement !== rowEl) {
    rowEl.appendChild(panel);
  }
}
function renderSidePanelBody(title, rows) {
  const panel = document.getElementById("side-panel");
  if (!panel) return;
  document.getElementById("side-panel-title").innerHTML = title;
  document.getElementById("side-panel-count").textContent =
    rows.length ? `${rows.length} player${rows.length === 1 ? "" : "s"}` : "";
  const body = document.getElementById("side-panel-body");
  body.innerHTML = rows.length
    ? rows.map(r => `<div class="side-panel-row${r.onClick ? " spr-clickable" : ""}"><span class="spr-name">${r.name}</span><span class="spr-detail">${r.detail}</span></div>`).join("")
    : `<div class="side-panel-empty">No players</div>`;
  panel.classList.add("open");
  [...body.children].forEach((el, i) => {
    const onClick = rows[i] && rows[i].onClick;
    if (!onClick) return;
    el.addEventListener("click", () => {
      const nowSelected = !el.classList.contains("selected");
      [...body.children].forEach(sib => sib.classList.remove("selected"));
      if (nowSelected) el.classList.add("selected");
      onClick(nowSelected);
    });
  });
}
function hideSidePanel() {
  const panel = document.getElementById("side-panel");
  if (panel) panel.classList.remove("open");
  clearRibbonIsolation();
}

// Highlights the single ribbon matching `pairKey` (an origin::destination
// school pair) and dims every other currently-rendered ribbon so a
// single-player connection can be picked out of a busy fan-out. Scoped by
// a shared `data-pair-key` attribute set on every school-pair ribbon path,
// not by which panel/universe is currently visible -- fine in practice
// since a school-pair key is specific enough that stale matches in a
// hidden tab are inert.
function isolateRibbon(pairKey) {
  document.querySelectorAll("[data-pair-key]").forEach(el => {
    const mine = el.getAttribute("data-pair-key") === pairKey;
    el.classList.toggle("player-isolated", mine);
    el.classList.toggle("sibling-dimmed", !mine);
  });
}
function clearRibbonIsolation() {
  document.querySelectorAll(".player-isolated, .sibling-dimmed").forEach(el => {
    el.classList.remove("player-isolated", "sibling-dimmed");
  });
}
function renderUniverse(svgEl, legendEl, universeKey, label, prepared, geo) {
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();
  const root = svg.append("g").attr("class", "diagram-root");

  // Shadows the module-level showSidePanel/openPlayerPanel for every call
  // within this closure, so every existing showSidePanel(...) call site
  // below automatically re-anchors the shared #side-panel node into THIS
  // panel's own filter-panel-row before rendering into it -- see
  // positionSidePanel.
  const filterPanelRowEl = document.getElementById(`filterpanelrow-${universeKey}`);
  function showSidePanel(title, rows) {
    positionSidePanel(filterPanelRowEl);
    renderSidePanelBody(title, rows);
  }
  function openPlayerPanel(school, dep) {
    showSidePanel(dep.n, [{ name: `${school} &mdash; ${depStatusHtml(dep)}`, detail: `${dep.d}<br>${playerMetaHtml(dep)}` }]);
  }

  let zoomDetail = false;
  // FBS packs roughly 5x as many portal entries into a similarly-sized
  // circle as FCS (136 schools sharing 5,274 entries vs 123 schools sharing
  // 995), so its individual player ticks are proportionally that much
  // thinner at any given zoom level -- it needs a much higher zoom ceiling
  // to reach the same on-screen tick width FCS already gets at a modest zoom.
  const maxZoom = universeKey === "fbs" ? 150 : 30;
  const zoomCtl = attachZoom(svg, root, [ZOOM_OUT_FLOOR, maxZoom], (k) => {
    zoomDetail = k >= ZOOM_DETAIL_THRESHOLD;
    root.classed("zoom-detail", zoomDetail);
    currentZoomK = k;
    refreshRibbonsForZoom();
  });
  // Whatever's currently on screen -- a hover fan-out, a pin, or the
  // filtered "show all" backdrop -- needs its ribbons rebuilt at the new
  // zoom level so shrinkSpan's width actually updates; these are the same
  // three cases setDirection and the filter onChange handler each refresh.
  function refreshRibbonsForZoom() {
    if (hoverActive) {
      if (hoverActive.type === "school") renderSchoolChords(gSchoolChords, hoverActive.key, direction);
      else renderConferenceChords(gConfChords, hoverActive.key, direction);
    } else if (shouldAutoShow()) {
      renderAllConferenceChords();
    }
    if (pin) redrawPin();
  }

  const palette = PALETTES[universeKey];
  const mode = currentMode();
  const colorOf = conf => palette[mode][palette.conferences.indexOf(conf)];

  const arcOuter = d3.arc().innerRadius(geo.outerInner).outerRadius(geo.outerOuter);
  const arcInner = d3.arc().innerRadius(geo.innerInner).outerRadius(geo.innerOuter);
  const ribbon = d3.ribbon().radius(geo.chordRadius);

  // Ribbons live in the same zoomed <g> as everything else, so by default
  // their angular width -- and the gaps between neighboring ribbons -- grow
  // at the same rate as the rings do. That keeps the *relative* crowding
  // identical at any zoom level: a fan-out that's hard to pick a single
  // ribbon out of stays exactly as hard, just bigger. Dividing each ribbon
  // end's angular half-width by the current zoom level (holding its center
  // angle fixed) keeps its on-screen width roughly constant instead, so
  // zooming in visibly opens up gaps between ribbons rather than just
  // magnifying the whole cluster uniformly.
  let currentZoomK = 1;
  function shrinkSpan(startAngle, endAngle, radius) {
    if (currentZoomK <= 1) return { startAngle, endAngle, radius };
    const mid = (startAngle + endAngle) / 2;
    const half = (endAngle - startAngle) / 2 / currentZoomK;
    return { startAngle: mid - half, endAngle: mid + half, radius };
  }
  function zoomAwareRibbon(spec) {
    return ribbon({
      source: shrinkSpan(spec.source.startAngle, spec.source.endAngle, spec.source.radius),
      target: shrinkSpan(spec.target.startAngle, spec.target.endAngle, spec.target.radius),
    });
  }

  const tooltip = d3.select("#tooltip");
  function showTip(html, event) {
    tooltip.style("display", "block").html(html);
    moveTip(event);
  }
  function moveTip(event) {
    const pad = 14;
    tooltip.style("left", (event.clientX + pad) + "px").style("top", (event.clientY + pad) + "px");
  }
  function hideTip() { tooltip.style("display", "none"); }

  // ---- player search box positioning ---------------------------------
  // Ported from the basketball diagram (which also has a conference
  // pin-tooltip using this same corner logic; this diagram doesn't have
  // that box, but the player-search box needs the same placement math).
  // Prefers sitting fully outside the diagram's left/right edge, falling
  // back to that side's corner of the SVG's own square canvas when the
  // viewport's too narrow, and never sits on top of the Filters panel.
  function pinTipFilterFloor() {
    const pad = 10;
    const panel = document.getElementById(`filterpanel-${universeKey}`);
    if (panel && !panel.hasAttribute("hidden")) {
      return panel.getBoundingClientRect().bottom + pad;
    }
    const toggle = document.getElementById(`filtertoggle-${universeKey}`);
    if (toggle) {
      return toggle.getBoundingClientRect().bottom + pad + 10;
    }
    return null;
  }
  function placeTip(tipSelection, anchorRect) {
    const pad = 14;
    const svgRect = svgEl.getBoundingClientRect();
    const tipRect = tipSelection.node().getBoundingClientRect();
    const onLeft = (anchorRect.left + anchorRect.width / 2) < (svgRect.left + svgRect.width / 2);
    const onTop = (anchorRect.top + anchorRect.height / 2) < (svgRect.top + svgRect.height / 2);

    let left = onLeft ? (svgRect.left - pad - tipRect.width) : (svgRect.right + pad);
    const fitsOutside = left >= 8 && left + tipRect.width <= window.innerWidth - 8;
    let top;
    if (fitsOutside) {
      top = anchorRect.top;
    } else {
      left = onLeft ? (svgRect.left + pad) : (svgRect.right - pad - tipRect.width);
      top = onTop ? (svgRect.top + pad) : (svgRect.bottom - pad - tipRect.height);
    }
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - tipRect.height - 8));
    const filterFloor = pinTipFilterFloor();
    if (filterFloor != null) top = Math.max(top, filterFloor);
    tipSelection.style("left", (left + window.scrollX) + "px").style("top", (top + window.scrollY) + "px");
  }
  const playerSearch = createPlayerSearchController({
    universeKey, d3,
    getEntries: () => tickRegistry,
    placeTip,
    routeHtml: (school, dep) => `${school} &mdash; ${depStatusHtml(dep)}`,
    playerKey,
    getPin: () => pin,
    setPin: (next) => setPin(next),
  });

  // ---- filters: chip UI + filtered-count helpers used by ribbon opacity --
  const allDeps = [];
  for (const s of prepared.innerLayout) for (const dep of s.departures || []) allDeps.push({ school: s.school, dep, conf: s.conference });
  const filterCtl = buildFilterBar(universeKey, allDeps, prepared.conferenceOrder);
  const filters = filterCtl.filters;
  function filteredSchoolCount(source, target) {
    const deps = prepared.schoolPlayers.get(source).byTarget.get(target) || [];
    const home = { conf: prepared.innerByName.get(source).conference, school: source };
    let n = 0;
    for (const dep of deps) if (matchesFilters(dep, filters, home)) n++;
    return n;
  }
  // Every school in `sourceConf`, filtered and grouped by target conference
  // -- used both for conference-pair ribbon opacity (via .length) and to
  // populate the side panel when one of those ribbons is clicked.
  function filteredConfDeps(sourceConf, targetConf) {
    const out = [];
    for (const s of prepared.innerConfSpans.get(sourceConf).schools) {
      const home = { conf: sourceConf, school: s.school };
      for (const [targetSchool, deps] of prepared.schoolPlayers.get(s.school).byTarget) {
        if (prepared.innerByName.get(targetSchool).conference !== targetConf) continue;
        for (const dep of deps) if (matchesFilters(dep, filters, home)) out.push({ school: s.school, dep });
      }
    }
    return out;
  }
  // Same walk as filteredSchoolCount, but collecting the actual matching
  // records instead of just counting -- used to populate the side panel
  // when a school-pair ribbon is clicked.
  function filteredSchoolDeps(source, target) {
    const deps = prepared.schoolPlayers.get(source).byTarget.get(target) || [];
    const home = { conf: prepared.innerByName.get(source).conference, school: source };
    return deps.filter(dep => matchesFilters(dep, filters, home));
  }
  // Ticks register themselves here as they're built so a filter change can
  // dim the ones that no longer match without a full re-render.
  const tickRegistry = [];
  function applyFilterDim() {
    const active = filtersActive(filters);
    for (const { el, dep, conf, school } of tickRegistry) el.classList.toggle("tick-dim", active && !matchesFilters(dep, filters, { conf, school }));
  }

  // ---- layers, back to front -------------------------------------------
  const gPinConfChords = root.append("g").attr("class", "layer-pin-conf-chords");
  const gPinSchoolChords = root.append("g").attr("class", "layer-pin-school-chords");
  const gPinPlayerChords = root.append("g").attr("class", "layer-pin-player-chords");
  const gConfChords = root.append("g").attr("class", "layer-conf-chords");
  const gSchoolChords = root.append("g").attr("class", "layer-school-chords");
  const gPlayerChords = root.append("g").attr("class", "layer-player-chords");
  const gOuter = root.append("g").attr("class", "layer-outer");
  const gInner = root.append("g").attr("class", "layer-inner");
  const gConfLabels = root.append("g").attr("class", "layer-conf-labels");
  const gCenter = root.append("g").attr("class", "layer-center");

  // ---- center summary -----------------------------------------------------
  const totalSchools = prepared.data.schools.length;
  const totalPortal = d3.sum(prepared.data.schools, d => d.portalEntries);
  const totalFlow = d3.sum(prepared.data.flows, d => d.count);
  gCenter.append("text").attr("class", "center-title").attr("y", -10).text(label);
  gCenter.append("text").attr("class", "center-stat").attr("y", 14)
    .text(`${totalSchools} schools`);
  gCenter.append("text").attr("class", "center-stat").attr("y", 32)
    .text(`${totalPortal.toLocaleString()} portal entries`);
  gCenter.append("text").attr("class", "center-stat").attr("y", 50)
    .text(`${totalFlow.toLocaleString()} transfers within ${universeKey.toUpperCase()}`);

  // ---- outer ring: roster -------------------------------------------------
  gOuter.selectAll("path.outer-school")
    .data(prepared.outerLayout)
    .join("path")
    .attr("class", "outer-school")
    .attr("d", d => arcOuter({ startAngle: d.startAngle, endAngle: d.endAngle }))
    .attr("fill", d => shadeForSchool(colorOf(d.conference), d, mode))
    .attr("data-school", d => d.school)
    .on("mouseenter", (event, d) => {
      showTip(`<strong>${d.school}</strong><br>${d.conference}<br>Roster limit: ${d.roster}`, event);
    })
    .on("mousemove", moveTip)
    .on("mouseleave", hideTip)
    .on("click", (event, d) => { if (!zoomCtl.wasPanned()) togglePin({ type: "school", key: d.school }); });

  // ---- inner ring: portal entries, subdivided by destination -------------
  const innerGroups = gInner.selectAll("g.inner-school")
    .data(prepared.innerLayout)
    .join("g")
    .attr("class", "inner-school")
    .attr("data-school", d => d.school);

  innerGroups.each(function (d) {
    const g = d3.select(this);
    const sub = prepared.schoolSub.get(d.school);
    const players = prepared.schoolPlayers.get(d.school);
    const baseColor = colorOf(d.conference);
    const gTicks = g.append("g").attr("class", "inner-seg-players");

    sub.segments.forEach(seg => {
      const deps = players.byTarget.get(seg.target) || [];
      g.append("path")
        .attr("class", "inner-seg")
        .attr("d", arcInner({ startAngle: seg.startAngle, endAngle: seg.endAngle }))
        .attr("fill", shadeForSchool(baseColor, d, mode))
        .attr("data-target", seg.target)
        .on("mouseenter", (event) => {
          showTip(`<strong>${d.school} &rarr; ${seg.target}</strong><br>${seg.count} player${seg.count === 1 ? "" : "s"}<br><em>Click for the full list</em>`, event);
        })
        .on("mousemove", moveTip)
        .on("mouseleave", hideTip)
        .on("click", (event) => {
          event.stopPropagation();
          if (zoomCtl.wasPanned()) return;
          const segKey = `${d.school}::${seg.target}`;
          if (pin && pin.type === "school" && pin.key === d.school && pinnedSegKey === segKey) {
            setPin(null);
            hideSidePanel();
            lastPanelRefresh = null;
            return;
          }
          setPin({ type: "school", key: d.school });
          pinnedSegKey = segKey;
          openSegmentPanel(() => {
            const matched = filtersActive(filters) ? deps.filter(dep => matchesFilters(dep, filters, { conf: d.conference, school: d.school })) : deps;
            const rows = matched.map(dep => ({
              name: dep.n, detail: `${dep.d}<br>${playerMetaHtml(dep)}`,
              onClick: matched.length === 1 ? (selected) => (selected ? isolateRibbon(segKey) : clearRibbonIsolation()) : undefined,
            }));
            showSidePanel(`${d.school} &rarr; ${seg.target}`, rows);
          });
        });

      evenTicks(seg.startAngle, seg.endAngle, deps).forEach(({ item: dep, startAngle: a0, endAngle: a1 }) => {
        const tickSel = gTicks.append("path")
          .attr("class", "player-tick")
          .attr("data-player-key", playerKey(d.school, dep))
          .attr("d", arcInner({ startAngle: a0, endAngle: a1 }))
          .attr("fill", shadeForSchool(baseColor, d, mode))
          .on("mouseenter", (event) => enterPlayerTick(d.school, dep, a0, a1, event))
          .on("mousemove", (event) => { moveTip(event); cancelPlayerHoverClear(); })
          .on("mouseleave", () => leavePlayerTick())
          .on("click", (event) => {
            event.stopPropagation();
            togglePlayerPin(d.school, dep, a0, a1);
          });
        tickRegistry.push({ el: tickSel.node(), dep, conf: d.conference, school: d.school, a0, a1 });
      });
    });

    if (sub.leftoverEnd > sub.leftoverStart) {
      g.append("path")
        .attr("class", "inner-seg inner-leftover")
        .attr("d", arcInner({ startAngle: sub.leftoverStart, endAngle: sub.leftoverEnd }))
        .attr("fill", "var(--leftover)")
        .on("mouseenter", (event) => {
          showTip(`<strong>${d.school}</strong><br>${players.leftover.length} player${players.leftover.length === 1 ? "" : "s"} still in the portal, or transferred outside ${universeKey.toUpperCase()}<br><em>Click for the full list</em>`, event);
        })
        .on("mousemove", moveTip)
        .on("mouseleave", hideTip)
        .on("click", (event) => {
          event.stopPropagation();
          openSegmentPanel(() => {
            const list = filtersActive(filters) ? players.leftover.filter(dep => matchesFilters(dep, filters, { conf: d.conference, school: d.school })) : players.leftover;
            const rows = list.map(dep => ({ name: dep.n, detail: `${depStatusHtml(dep)} &middot; ${dep.d}<br>${playerMetaHtml(dep)}` }));
            showSidePanel(`${d.school} &mdash; still in portal / left ${universeKey.toUpperCase()}`, rows);
          });
        });

      evenTicks(sub.leftoverStart, sub.leftoverEnd, players.leftover).forEach(({ item: dep, startAngle: a0, endAngle: a1 }) => {
        const tickSel = gTicks.append("path")
          .attr("class", "player-tick player-tick-leftover")
          .attr("data-player-key", playerKey(d.school, dep))
          .attr("d", arcInner({ startAngle: a0, endAngle: a1 }))
          .attr("fill", "var(--leftover)")
          .on("mouseenter", (event) => {
            showTip(`<strong>${dep.n}</strong><br>${d.school} &mdash; ${depStatusHtml(dep)}<br>${dep.d}<br>${playerMetaHtml(dep)}`, event);
            setDim(n => n.school === d.school);
          })
          .on("mousemove", (event) => moveTip(event))
          .on("mouseleave", () => { hideTip(); restoreBaseDim(); })
          .on("click", (event) => {
            event.stopPropagation();
            togglePlayerPin(d.school, dep, a0, a1);
          });
        tickRegistry.push({ el: tickSel.node(), dep, conf: d.conference, school: d.school, a0, a1 });
      });
    }
  });
  applyFilterDim();

  innerGroups
    .on("mouseenter", (event, d) => { if (!zoomDetail) enterSchool(d); })
    .on("mousemove", (event) => moveTip(event))
    .on("mouseleave", () => { if (!zoomDetail) leaveSchool(); })
    .on("click", (event, d) => { if (!zoomDetail && !zoomCtl.wasPanned()) togglePin({ type: "school", key: d.school }); });

  // ---- conference rim labels (curved, always visible) ---------------------
  const outerConfSpans = conferenceSpans(prepared.outerLayout, prepared.conferenceOrder);
  gConfLabels.selectAll("text.conf-label")
    .data(Array.from(outerConfSpans.values()))
    .join("text")
    .attr("class", "conf-label")
    .attr("data-conf", d => d.conference)
    .each(function (d) {
      const a = midAngle(d);
      const flipped = a > Math.PI / 2 && a < 3 * Math.PI / 2;
      const [x, y] = polar(a, geo.outerOuter + 6);
      const rot = (a * 180 / Math.PI) - 90 + (flipped ? 180 : 0);
      d3.select(this)
        .attr("transform", `translate(${x},${y}) rotate(${rot})`)
        .attr("text-anchor", flipped ? "end" : "start")
        .attr("dy", "0.35em")
        .text(d.conference);
    })
    .on("mouseenter", (event, d) => {
      enterConference(d.conference);
      const innerSpan = prepared.innerConfSpans.get(d.conference);
      const outTotal = d3.sum(prepared.confSub.get(d.conference).segments, s => s.count);
      showTip(`<strong>${d.conference}</strong><br>${d.schools.length} schools &middot; ${innerSpan.portalEntries} portal entries<br>${outTotal} transfers to other ${universeKey.toUpperCase()} conferences`, event);
    })
    .on("mousemove", (event) => moveTip(event))
    .on("mouseleave", () => leaveConference())
    .on("click", (event, d) => { if (!zoomCtl.wasPanned()) togglePin({ type: "conference", key: d.conference }); });

  // ---- shared ribbon-render helpers (used by both hover and pin) ----------
  // Rendering all ~114 (FBS) conference-pair ribbons simultaneously was tried
  // first and rejected: alpha-blending that many overlapping colored ribbons
  // converges to a flat gray/brown wash near the center no matter how
  // opacity is tuned (that's a property of compositing many hues together,
  // not a tunable weight) -- the diagram read as a muddy hairball with no
  // information legible at a glance. Isolating one conference (or school, or
  // player) at a time reads cleanly, so the circle starts empty at rest and
  // reveals exactly one entity's ribbons on hover, with the direction
  // toggle further narrowing to just outgoing or just incoming.
  // Ring/segment geometry (arc positions) always comes from the full-season
  // sub/span data -- filters never resize anything. Ribbon opacity and
  // existence, though, are recomputed from the filtered subset every time:
  // a flow with zero matching players is skipped entirely rather than drawn
  // as a barely-visible sliver, and the opacity scale is recalibrated to
  // whatever the current filtered max is so a narrow filter doesn't render
  // everything near-invisible.
  function renderConferenceChords(layer, conf, direction) {
    layer.selectAll("*").remove();
    const sub = prepared.confSub.get(conf);
    const mySpan = prepared.innerConfSpans.get(conf);
    const showOut = direction !== "in";
    const showIn = direction !== "out";

    const outRibbons = showOut
      ? sub.segments.map(seg => ({ seg, deps: filteredConfDeps(conf, seg.target) })).filter(r => r.deps.length > 0)
      : [];
    const inRibbons = [];
    if (showIn) {
      for (const [otherConf, otherSub] of prepared.confSub) {
        if (otherConf === conf) continue;
        for (const seg of otherSub.segments) {
          if (seg.target !== conf) continue;
          const deps = filteredConfDeps(otherConf, conf);
          if (deps.length > 0) inRibbons.push({ otherConf, seg, deps });
        }
      }
    }
    const maxCount = d3.max([...outRibbons, ...inRibbons], r => r.deps.length) || 1;
    const opacityScale = d3.scalePow().exponent(0.5).domain([0, maxCount]).range([0.5, 1]).clamp(true);

    for (const { seg, deps } of outRibbons) {
      const targetSeg = incomingSegment(prepared.confSubIncoming, seg.target, conf, prepared.innerConfSpans.get(seg.target));
      const label = pairLabel(deps, conf, seg.target);
      layer.append("path")
        .attr("class", "chord chord-conf")
        .attr("d", zoomAwareRibbon({
          source: { startAngle: seg.startAngle, endAngle: seg.endAngle, radius: geo.chordRadius },
          target: { startAngle: targetSeg.startAngle, endAngle: targetSeg.endAngle, radius: geo.chordRadius },
        }))
        .attr("fill", colorOf(conf))
        .attr("stroke", colorOf(conf))
        .style("opacity", opacityScale(deps.length))
        .on("mouseenter", (event) => {
          showTip(`<strong>${label}</strong><br>${deps.length} player${deps.length === 1 ? "" : "s"}<br><em>Click for the full list</em>`, event);
        })
        .on("mousemove", moveTip)
        .on("mouseleave", hideTip)
        .on("click", (event) => {
          event.stopPropagation();
          openSegmentPanel(() => {
            const fresh = filteredConfDeps(conf, seg.target);
            const rows = fresh.map(({ school, dep }) => ({
              name: dep.n, detail: `${school} &rarr; ${dep.t} &middot; ${dep.d}<br>${playerMetaHtml(dep)}`,
            }));
            showSidePanel(pairLabel(fresh, conf, seg.target), rows);
          });
        });
    }
    for (const { otherConf, seg, deps } of inRibbons) {
      const myIncoming = prepared.confSubIncoming.get(conf);
      const targetSeg = (myIncoming && myIncoming.segments.find(s => s.target === otherConf)) || mySpan;
      const label = pairLabel(deps, otherConf, conf);
      layer.append("path")
        .attr("class", "chord chord-conf")
        .attr("d", zoomAwareRibbon({
          source: { startAngle: seg.startAngle, endAngle: seg.endAngle, radius: geo.chordRadius },
          target: { startAngle: targetSeg.startAngle, endAngle: targetSeg.endAngle, radius: geo.chordRadius },
        }))
        .attr("fill", colorOf(otherConf))
        .attr("stroke", colorOf(otherConf))
        .style("opacity", opacityScale(deps.length))
        .on("mouseenter", (event) => {
          showTip(`<strong>${label}</strong><br>${deps.length} player${deps.length === 1 ? "" : "s"}<br><em>Click for the full list</em>`, event);
        })
        .on("mousemove", moveTip)
        .on("mouseleave", hideTip)
        .on("click", (event) => {
          event.stopPropagation();
          openSegmentPanel(() => {
            const fresh = filteredConfDeps(otherConf, conf);
            const rows = fresh.map(({ school, dep }) => ({
              name: dep.n, detail: `${school} &rarr; ${dep.t} &middot; ${dep.d}<br>${playerMetaHtml(dep)}`,
            }));
            showSidePanel(pairLabel(fresh, otherConf, conf), rows);
          });
        });
    }
  }

  function renderSchoolChords(layer, school, direction) {
    layer.selectAll("*").remove();
    const d = prepared.innerByName.get(school);
    const sub = prepared.schoolSub.get(school);
    const baseColor = colorOf(d.conference);
    const showOut = direction !== "in";
    const showIn = direction !== "out";

    if (showOut) {
      for (const seg of sub.segments) {
        const count = filteredSchoolCount(school, seg.target);
        if (count === 0) continue;
        const targetLayout = prepared.innerByName.get(seg.target);
        const targetSeg = incomingSegment(prepared.schoolSubIncoming, seg.target, school, targetLayout);
        layer.append("path")
          .attr("class", "chord chord-school chord-out")
          .attr("d", zoomAwareRibbon({
            source: { startAngle: seg.startAngle, endAngle: seg.endAngle, radius: geo.chordRadius },
            target: { startAngle: targetSeg.startAngle, endAngle: targetSeg.endAngle, radius: geo.chordRadius },
          }))
          .attr("fill", baseColor)
          .attr("stroke", baseColor)
          .attr("data-pair-key", `${school}::${seg.target}`)
          .on("mouseenter", (event) => {
            showTip(`<strong>${school} &rarr; ${seg.target}</strong><br>${count} player${count === 1 ? "" : "s"}<br><em>Click for the full list</em>`, event);
          })
          .on("mousemove", moveTip)
          .on("mouseleave", hideTip)
          .on("click", (event) => {
            event.stopPropagation();
            openSegmentPanel(() => {
              const deps = filteredSchoolDeps(school, seg.target);
              const pairKey = `${school}::${seg.target}`;
              const rows = deps.map(dep => ({
                name: dep.n, detail: `${dep.d}<br>${playerMetaHtml(dep)}`,
                onClick: deps.length === 1 ? (selected) => (selected ? isolateRibbon(pairKey) : clearRibbonIsolation()) : undefined,
              }));
              showSidePanel(`${school} &rarr; ${seg.target}`, rows);
            });
          });
      }
    }
    if (showIn) {
      const incoming = prepared.flowsByTarget.get(school) || [];
      const myIncoming = prepared.schoolSubIncoming.get(school);
      for (const f of incoming) {
        const count = filteredSchoolCount(f.source, school);
        if (count === 0) continue;
        const srcSub = prepared.schoolSub.get(f.source);
        const srcSeg = srcSub.segments.find(s => s.target === school);
        if (!srcSeg) continue;
        const targetSeg = (myIncoming && myIncoming.segments.find(s => s.target === f.source)) || d;
        const srcColor = colorOf(prepared.innerByName.get(f.source).conference);
        layer.append("path")
          .attr("class", "chord chord-school chord-in")
          .attr("d", zoomAwareRibbon({
            source: { startAngle: srcSeg.startAngle, endAngle: srcSeg.endAngle, radius: geo.chordRadius },
            target: { startAngle: targetSeg.startAngle, endAngle: targetSeg.endAngle, radius: geo.chordRadius },
          }))
          .attr("fill", srcColor)
          .attr("stroke", srcColor)
          .attr("data-pair-key", `${f.source}::${school}`)
          .on("mouseenter", (event) => {
            showTip(`<strong>${f.source} &rarr; ${school}</strong><br>${count} player${count === 1 ? "" : "s"}<br><em>Click for the full list</em>`, event);
          })
          .on("mousemove", moveTip)
          .on("mouseleave", hideTip)
          .on("click", (event) => {
            event.stopPropagation();
            openSegmentPanel(() => {
              const deps = filteredSchoolDeps(f.source, school);
              const pairKey = `${f.source}::${school}`;
              const rows = deps.map(dep => ({
                name: dep.n, detail: `${dep.d}<br>${playerMetaHtml(dep)}`,
                onClick: deps.length === 1 ? (selected) => (selected ? isolateRibbon(pairKey) : clearRibbonIsolation()) : undefined,
              }));
              showSidePanel(`${f.source} &rarr; ${school}`, rows);
            });
          });
      }
    }
  }

  // `interactive` (used only for the transient hover-drawn copy, never the
  // pinned one) wires the ribbon into the same hover-hold timer as its
  // source tick, and always gets a click handler so a player can be pinned
  // by clicking either the tick or the ribbon itself.
  function renderPlayerChordInto(layer, school, dep, a0, a1, interactive) {
    layer.selectAll("*").remove();
    const targetLayout = prepared.innerByName.get(dep.t);
    if (!targetLayout) return;
    const targetSeg = incomingSegment(prepared.schoolSubIncoming, dep.t, school, targetLayout);
    const sel = layer.append("path")
      .attr("class", "chord chord-player")
      .attr("d", zoomAwareRibbon({
        source: { startAngle: a0, endAngle: a1, radius: geo.chordRadius },
        target: { startAngle: targetSeg.startAngle, endAngle: targetSeg.endAngle, radius: geo.chordRadius },
      }))
      .attr("fill", colorOf(prepared.innerByName.get(school).conference))
      .attr("stroke", colorOf(prepared.innerByName.get(school).conference))
      .style("opacity", 0.9)
      .on("click", (event) => { event.stopPropagation(); togglePlayerPin(school, dep, a0, a1); });
    if (interactive) {
      sel.on("mouseenter", (event) => { showTip(`<strong>${dep.n}</strong><br>${school} &rarr; ${dep.t}<br>${dep.d}<br>${playerMetaHtml(dep)}`, event); cancelPlayerHoverClear(); })
        .on("mousemove", (event) => { moveTip(event); cancelPlayerHoverClear(); })
        .on("mouseleave", () => schedulePlayerHoverClear());
    } else {
      sel.on("mouseenter", (event) => showTip(`<strong>${dep.n}</strong><br>${school} &rarr; ${dep.t}<br>${dep.d}<br>${playerMetaHtml(dep)}`, event))
        .on("mousemove", moveTip)
        .on("mouseleave", hideTip);
    }
  }

  // Pinning a player also drives the side panel: pin it and open the panel,
  // or -- if it's already pinned -- unpin and close the panel, so the two
  // stay in lockstep no matter whether the tick or its ribbon was clicked.
  function togglePlayerPin(school, dep, a0, a1) {
    const key = playerKey(school, dep);
    const wasPinned = pin && pin.type === "player" && pin.key === key;
    togglePin({ type: "player", key, school, dep, tickStart: a0, tickEnd: a1 });
    lastPanelRefresh = null;
    if (wasPinned) hideSidePanel(); else openPlayerPanel(school, dep);
  }
  // A segment/leftover-box click opens the panel via `render`, and also
  // remembers it so a later filter-chip toggle can recompute the same list
  // in place instead of leaving it showing stale (pre-filter) rows.
  function openSegmentPanel(render) {
    lastPanelRefresh = render;
    render();
  }

  // ---- "show all" mode: every conference-pair ribbon at once, opt-in -----
  // This is the dense view rejected as the *default* (see note above), but
  // kept available on demand since some readers want the full gestalt
  // despite the overlap, especially at low zoom before picking a spot to
  // zoom into. Not affected by the direction toggle -- every ribbon in this
  // view is simultaneously an "out" for its source and an "in" for its
  // target, so there's no single direction to filter to.
  let showAll = false;
  function renderAllConferenceChords() {
    gConfChords.selectAll("*").remove();
    const ribbons = [];
    for (const [conf, sub] of prepared.confSub) {
      for (const seg of sub.segments) {
        const deps = filteredConfDeps(conf, seg.target);
        if (deps.length > 0) ribbons.push({ conf, seg, deps });
      }
    }
    const maxCount = d3.max(ribbons, r => r.deps.length) || 1;
    const opacityScale = d3.scalePow().exponent(0.5).domain([0, maxCount]).range([0.08, 0.5]).clamp(true);
    for (const { conf, seg, deps } of ribbons) {
      const targetSeg = incomingSegment(prepared.confSubIncoming, seg.target, conf, prepared.innerConfSpans.get(seg.target));
      const label = pairLabel(deps, conf, seg.target);
      gConfChords.append("path")
        .attr("class", "chord chord-conf")
        .attr("d", zoomAwareRibbon({
          source: { startAngle: seg.startAngle, endAngle: seg.endAngle, radius: geo.chordRadius },
          target: { startAngle: targetSeg.startAngle, endAngle: targetSeg.endAngle, radius: geo.chordRadius },
        }))
        .attr("fill", colorOf(conf))
        .attr("stroke", colorOf(conf))
        .style("opacity", opacityScale(deps.length))
        .on("mouseenter", (event) => {
          showTip(`<strong>${label}</strong><br>${deps.length} player${deps.length === 1 ? "" : "s"}<br><em>Click for the full list</em>`, event);
        })
        .on("mousemove", moveTip)
        .on("mouseleave", hideTip)
        .on("click", (event) => {
          event.stopPropagation();
          openSegmentPanel(() => {
            const fresh = filteredConfDeps(conf, seg.target);
            const rows = fresh.map(({ school, dep }) => ({
              name: dep.n,
              detail: `${school} &rarr; ${dep.t} &middot; ${dep.d}<br>${playerMetaHtml(dep)}`,
            }));
            showSidePanel(pairLabel(fresh, conf, seg.target), rows);
          });
        });
    }
  }
  function setShowAll(v) {
    showAll = v;
    if (shouldAutoShow()) renderAllConferenceChords(); else gConfChords.selectAll("*").remove();
  }
  // Any active filter (position/class/prior-transfers/date/conference)
  // implies "show all" for the conference-pair backdrop too -- otherwise a
  // filter chip would only ever affect whatever's already hovered or
  // pinned, which is exactly the confusing behavior this replaces: picking
  // "Cornerback" alone used to show nothing until you separately hovered a
  // school. Now a filter (with nothing else selected) draws every matching
  // conference-pair ribbon on its own, and adding a "Conference" filter
  // narrows that down further since filteredConfDeps is empty for any
  // source conference not in the selected set.
  function shouldAutoShow() { return showAll || filtersActive(filters); }

  // ---- dimming ----------------------------------------------------------
  function setDim(matchFn) {
    root.selectAll(".outer-school, .inner-school").classed("dimmed", n => !matchFn(n));
  }
  function clearDim() { root.selectAll(".outer-school, .inner-school").classed("dimmed", false); }
  function restoreBaseDim() {
    if (!pin) { clearDim(); return; }
    if (pin.type === "conference") setDim(n => n.conference === pin.key);
    else if (pin.type === "school") setDim(n => n.school === pin.key);
    else if (pin.type === "player") setDim(n => n.school === pin.school || n.school === pin.dep.t);
  }

  // ---- hover: school / conference / player -------------------------------
  let hoverActive = null;
  function enterSchool(d) {
    hoverActive = { type: "school", key: d.school };
    gConfChords.selectAll("*").remove();
    renderSchoolChords(gSchoolChords, d.school, direction);
    setDim(n => n.school === d.school);
  }
  function leaveSchool() {
    hoverActive = null;
    gSchoolChords.selectAll("*").remove();
    restoreBaseDim();
    if (shouldAutoShow()) renderAllConferenceChords();
  }
  function enterConference(conf) {
    hoverActive = { type: "conference", key: conf };
    gSchoolChords.selectAll("*").remove();
    renderConferenceChords(gConfChords, conf, direction);
    setDim(n => n.conference === conf);
  }
  function leaveConference() {
    hoverActive = null;
    if (shouldAutoShow()) renderAllConferenceChords(); else gConfChords.selectAll("*").remove();
    restoreBaseDim();
    hideTip();
  }
  // chordRadius matches innerInner exactly so a player's ribbon touches the
  // tick that spawned it with no radial gap to cross, but the mouse can
  // still leave both for an instant while moving between them. A short
  // grace timer (cancelled by any further movement over either the tick or
  // its own ribbon) keeps the ribbon alive across that instant.
  let playerHoverTimer = null;
  function cancelPlayerHoverClear() { clearTimeout(playerHoverTimer); }
  function schedulePlayerHoverClear() {
    clearTimeout(playerHoverTimer);
    playerHoverTimer = setTimeout(() => {
      gPlayerChords.selectAll("*").remove();
      restoreBaseDim();
      hideTip();
    }, 300);
  }
  function enterPlayerTick(school, dep, a0, a1, event) {
    cancelPlayerHoverClear();
    renderPlayerChordInto(gPlayerChords, school, dep, a0, a1, true);
    setDim(n => n.school === school || n.school === dep.t);
    showTip(`<strong>${dep.n}</strong><br>${school} &rarr; ${dep.t}<br>${dep.d}<br>${playerMetaHtml(dep)}`, event);
  }
  function leavePlayerTick() {
    schedulePlayerHoverClear();
  }

  // ---- click-to-pin -------------------------------------------------------
  // Clicking a conference, school, or (when zoomed in) an individual player
  // line keeps its ribbons visible after the mouse moves away, in a
  // persistent layer separate from the transient hover layers above.
  // Clicking the same entity again, or clicking empty space, releases it.
  let pin = null;
  let lastPanelRefresh = null;
  // Which segment (school+target) most recently pinned via a segment click,
  // so re-clicking that exact segment releases the pin while clicking a
  // *different* segment on an already-pinned school just switches the panel
  // instead of unpinning -- see the inner-seg click handler below.
  let pinnedSegKey = null;
  let direction = getDirection(universeKey);

  function pinLabel(p) {
    if (p.type === "player") return `${p.dep.n} &mdash; ${p.school} &rarr; ${p.dep.t} (${p.dep.d})`;
    return p.key;
  }
  function redrawPin() {
    gPinConfChords.selectAll("*").remove();
    gPinSchoolChords.selectAll("*").remove();
    gPinPlayerChords.selectAll("*").remove();
    root.selectAll(".pin-highlight").classed("pin-highlight", false);
    if (pin) {
      if (pin.type === "conference") {
        renderConferenceChords(gPinConfChords, pin.key, direction);
        gConfLabels.selectAll("text.conf-label").filter(d => d.conference === pin.key).classed("pin-highlight", true);
      } else if (pin.type === "school") {
        renderSchoolChords(gPinSchoolChords, pin.key, direction);
        root.selectAll(`.outer-school[data-school="${cssEscape(pin.key)}"], .inner-school[data-school="${cssEscape(pin.key)}"]`).classed("pin-highlight", true);
      } else if (pin.type === "player") {
        renderPlayerChordInto(gPinPlayerChords, pin.school, pin.dep, pin.tickStart, pin.tickEnd);
        root.selectAll(`[data-player-key="${cssEscape(pin.key)}"]`).classed("pin-highlight", true);
      }
    }
    restoreBaseDim();
    updatePinIndicator();
    playerSearch.refresh();
  }
  function setPin(next) { pin = next; pinnedSegKey = null; redrawPin(); }
  function togglePin(candidate) {
    if (pin && pin.type === candidate.type && pin.key === candidate.key) setPin(null);
    else setPin(candidate);
  }
  function updatePinIndicator() {
    const chip = document.getElementById("pinchip-" + universeKey);
    const labelEl = document.getElementById("pinlabel-" + universeKey);
    if (!chip || !labelEl) return;
    if (pin) { chip.classList.add("active"); labelEl.innerHTML = pinLabel(pin); }
    else { chip.classList.remove("active"); labelEl.textContent = ""; }
  }
  function setDirection(v) {
    direction = v;
    redrawPin();
    if (hoverActive) {
      if (hoverActive.type === "school") renderSchoolChords(gSchoolChords, hoverActive.key, direction);
      else renderConferenceChords(gConfChords, hoverActive.key, direction);
    }
  }

  // A filter-chip toggle needs to ripple into everything that shows
  // player-derived counts: the dimmed/undimmed ticks, whatever ribbons are
  // currently on screen (hover, pin, or "show all"), and an open segment
  // panel (a single-player panel doesn't depend on filters, so it's left
  // alone -- see `lastPanelRefresh`, only set by segment/leftover clicks).
  filterCtl.onChange(() => {
    applyFilterDim();
    // Hover always wins the gConfChords layer while it's active (unchanged
    // from before); only fall back to the filtered "show all" backdrop when
    // nothing's currently hovered, so a filter chip can populate the whole
    // diagram on its own instead of waiting for a hover/pin to reveal it.
    if (!hoverActive) {
      if (shouldAutoShow()) renderAllConferenceChords(); else gConfChords.selectAll("*").remove();
    } else if (hoverActive.type === "school") {
      renderSchoolChords(gSchoolChords, hoverActive.key, direction);
    } else {
      renderConferenceChords(gConfChords, hoverActive.key, direction);
    }
    if (pin) redrawPin();
    if (lastPanelRefresh) lastPanelRefresh();
  });

  svg.on("click", (event) => {
    if (zoomCtl.wasPanned()) return;
    if (event.target === svgEl) { setPin(null); lastPanelRefresh = null; hideSidePanel(); }
  });

  // ---- legend ---------------------------------------------------------
  const legend = d3.select(legendEl);
  legend.selectAll("*").remove();
  const items = legend.selectAll(".legend-item")
    .data(prepared.conferenceOrder)
    .join("div")
    .attr("class", "legend-item");
  items.append("span").attr("class", "legend-swatch").style("background", d => colorOf(d));
  items.append("span").attr("class", "legend-label").text(d => d);
  const leftoverItem = legend.append("div").attr("class", "legend-item");
  leftoverItem.append("span").attr("class", "legend-swatch").style("background", "var(--leftover)");
  leftoverItem.append("span").attr("class", "legend-label").text("Still in portal / left this level");

  return {
    setShowAll,
    setDirection,
    clearPin: () => setPin(null),
    zoomIn: () => zoomCtl.zoomBy(1.5),
    zoomOut: () => zoomCtl.zoomBy(1 / 1.5),
    zoomReset: () => zoomCtl.reset(),
    searchPlayers: playerSearch.searchPlayers,
    selectResult: playerSearch.selectResult,
    clearSearch: playerSearch.clearSearch,
  };
}

function universeOfConference(conf) {
  return PALETTES.fbs.conferences.includes(conf) ? "fbs" : "fcs";
}
function colorOfConf(conf, mode) {
  const universe = universeOfConference(conf);
  const p = PALETTES[universe];
  return p[mode][p.conferences.indexOf(conf)];
}

// Ribbon between two DIFFERENT circles (different centers), so d3.ribbon()
// (which assumes both ends share one center) doesn't apply. Approximates
// each thin school/conference sub-arc as a straight edge (segments are
// small enough that the difference from a true arc is imperceptible) and
// bows the two long edges through a shared midpoint x, like a two-sided
// Sankey link.
function crossRibbonPath(p1, p2, p3, p4, midX) {
  return `M${p1}C${midX},${p1[1]} ${midX},${p3[1]} ${p3}L${p4}C${midX},${p4[1]} ${midX},${p2[1]} ${p2}Z`;
}

function renderCombined(svgEl, legendEl, prepared, geo) {
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();
  const root = svg.append("g").attr("class", "diagram-root");

  // See the matching block in renderUniverse.
  const filterPanelRowEl = document.getElementById("filterpanelrow-combined");
  function showSidePanel(title, rows) {
    positionSidePanel(filterPanelRowEl);
    renderSidePanelBody(title, rows);
  }
  function openPlayerPanel(school, dep) {
    showSidePanel(dep.n, [{ name: `${school} &mdash; ${depStatusHtml(dep)}`, detail: `${dep.d}<br>${playerMetaHtml(dep)}` }]);
  }

  let zoomDetail = false;
  // Both halves share one pan/zoom transform, so the ceiling has to
  // accommodate the denser FBS side (see the equivalent note in
  // renderUniverse) even though that leaves more zoom headroom than FCS
  // strictly needs on its own.
  const zoomCtl = attachZoom(svg, root, [ZOOM_OUT_FLOOR, 170], (k) => {
    zoomDetail = k >= ZOOM_DETAIL_THRESHOLD;
    root.classed("zoom-detail", zoomDetail);
    currentZoomK = k;
    refreshRibbonsForZoom();
  });
  // See the matching function in renderUniverse.
  function refreshRibbonsForZoom() {
    if (hoverActive) {
      if (hoverActive.type === "school") renderSchoolChords(hoverSchoolSame, gCrossChords, hoverActive.key, direction);
      else renderConferenceChords(hoverSame, gCrossChords, hoverActive.key, direction);
    } else if (shouldAutoShow()) {
      renderAllConferenceChords();
    }
    if (pin) redrawPin();
  }

  const mode = currentMode();
  const offFbs = [-geo.offset, 0], offFcs = [geo.offset, 0];
  const offsetOf = universe => (universe === "fbs" ? offFbs : offFcs);

  const arcOuter = d3.arc().innerRadius(geo.outerInner).outerRadius(geo.outerOuter);
  const arcInner = d3.arc().innerRadius(geo.innerInner).outerRadius(geo.innerOuter);
  const localRibbon = d3.ribbon().radius(geo.chordRadius);

  // See the matching comment in renderUniverse -- keeps each ribbon's
  // on-screen angular width roughly constant across zoom levels instead of
  // growing with everything else, so zoomed-in fan-outs actually gain
  // visible gaps between neighboring ribbons.
  let currentZoomK = 1;
  function shrinkSpan(startAngle, endAngle, radius) {
    if (currentZoomK <= 1) return { startAngle, endAngle, radius };
    const mid = (startAngle + endAngle) / 2;
    const half = (endAngle - startAngle) / 2 / currentZoomK;
    return { startAngle: mid - half, endAngle: mid + half, radius };
  }

  const tooltip = d3.select("#tooltip");
  function showTip(html, event) { tooltip.style("display", "block").html(html); moveTip(event); }
  function moveTip(event) {
    const pad = 14;
    tooltip.style("left", (event.clientX + pad) + "px").style("top", (event.clientY + pad) + "px");
  }
  function hideTip() { tooltip.style("display", "none"); }

  // ---- player search box positioning (see renderUniverse's copy of this
  // for the full explanation; "combined" is hardcoded here the same way
  // the rest of this function hardcodes it instead of taking a universeKey
  // param) ----------------------------------------------------------------
  function pinTipFilterFloor() {
    const pad = 10;
    const panel = document.getElementById("filterpanel-combined");
    if (panel && !panel.hasAttribute("hidden")) {
      return panel.getBoundingClientRect().bottom + pad;
    }
    const toggle = document.getElementById("filtertoggle-combined");
    if (toggle) {
      return toggle.getBoundingClientRect().bottom + pad + 10;
    }
    return null;
  }
  function placeTip(tipSelection, anchorRect) {
    const pad = 14;
    const svgRect = svgEl.getBoundingClientRect();
    const tipRect = tipSelection.node().getBoundingClientRect();
    const onLeft = (anchorRect.left + anchorRect.width / 2) < (svgRect.left + svgRect.width / 2);
    const onTop = (anchorRect.top + anchorRect.height / 2) < (svgRect.top + svgRect.height / 2);

    let left = onLeft ? (svgRect.left - pad - tipRect.width) : (svgRect.right + pad);
    const fitsOutside = left >= 8 && left + tipRect.width <= window.innerWidth - 8;
    let top;
    if (fitsOutside) {
      top = anchorRect.top;
    } else {
      left = onLeft ? (svgRect.left + pad) : (svgRect.right - pad - tipRect.width);
      top = onTop ? (svgRect.top + pad) : (svgRect.bottom - pad - tipRect.height);
    }
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - tipRect.height - 8));
    const filterFloor = pinTipFilterFloor();
    if (filterFloor != null) top = Math.max(top, filterFloor);
    tipSelection.style("left", (left + window.scrollX) + "px").style("top", (top + window.scrollY) + "px");
  }
  const playerSearch = createPlayerSearchController({
    universeKey: "combined", d3,
    getEntries: () => tickRegistry,
    placeTip,
    routeHtml: (school, dep) => `${school} &mdash; ${depStatusHtml(dep)}`,
    playerKey,
    getPin: () => pin,
    setPin: (next) => setPin(next),
  });

  // ---- filters: chip UI + filtered-count helpers used by ribbon opacity --
  const allDeps = [];
  for (const s of [...prepared.fbsSchools, ...prepared.fcsSchools]) for (const dep of s.departures || []) allDeps.push({ school: s.school, dep, conf: s.conference });
  const filterCtl = buildFilterBar("combined", allDeps, [...PALETTES.fbs.conferences, ...PALETTES.fcs.conferences]);
  const filters = filterCtl.filters;
  function filteredSchoolCount(source, target) {
    const deps = prepared.schoolPlayers.get(source).byTarget.get(target) || [];
    const home = { conf: prepared.innerByName.get(source).conference, school: source };
    let n = 0;
    for (const dep of deps) if (matchesFilters(dep, filters, home)) n++;
    return n;
  }
  // Every school in `sourceConf`, filtered and grouped by target conference
  // -- used both for conference-pair ribbon opacity (via .length) and to
  // populate the side panel when one of those ribbons is clicked.
  function filteredConfDeps(sourceConf, targetConf) {
    const out = [];
    for (const s of prepared.innerConfSpans.get(sourceConf).schools) {
      const home = { conf: sourceConf, school: s.school };
      for (const [targetSchool, deps] of prepared.schoolPlayers.get(s.school).byTarget) {
        if (prepared.innerByName.get(targetSchool).conference !== targetConf) continue;
        for (const dep of deps) if (matchesFilters(dep, filters, home)) out.push({ school: s.school, dep });
      }
    }
    return out;
  }
  // Same walk as filteredSchoolCount, but collecting the actual matching
  // records instead of just counting -- used to populate the side panel
  // when a school-pair ribbon is clicked.
  function filteredSchoolDeps(source, target) {
    const deps = prepared.schoolPlayers.get(source).byTarget.get(target) || [];
    const home = { conf: prepared.innerByName.get(source).conference, school: source };
    return deps.filter(dep => matchesFilters(dep, filters, home));
  }
  const tickRegistry = [];
  function applyFilterDim() {
    const active = filtersActive(filters);
    for (const { el, dep, conf, school } of tickRegistry) el.classList.toggle("tick-dim", active && !matchesFilters(dep, filters, { conf, school }));
  }

  // ---- layers, back to front ----------------------------------------------
  const gPinCrossChords = root.append("g").attr("class", "layer-pin-cross-chords");
  const gCrossChords = root.append("g").attr("class", "layer-cross-chords");
  const halves = {};
  for (const universe of ["fbs", "fcs"]) {
    const wrap = root.append("g").attr("class", `half half-${universe}`).attr("transform", `translate(${offsetOf(universe)})`);
    halves[universe] = {
      wrap,
      gPinConfChords: wrap.append("g").attr("class", "layer-pin-conf-chords"),
      gPinSchoolChords: wrap.append("g").attr("class", "layer-pin-school-chords"),
      gPinPlayerChords: wrap.append("g").attr("class", "layer-pin-player-chords"),
      gConfChords: wrap.append("g").attr("class", "layer-conf-chords"),
      gSchoolChords: wrap.append("g").attr("class", "layer-school-chords"),
      gPlayerChords: wrap.append("g").attr("class", "layer-player-chords"),
      gOuter: wrap.append("g").attr("class", "layer-outer"),
      gInner: wrap.append("g").attr("class", "layer-inner"),
      gConfLabels: wrap.append("g").attr("class", "layer-conf-labels"),
      gCenter: wrap.append("g").attr("class", "layer-center"),
    };
  }

  const outerLayoutByUniverse = { fbs: prepared.outerLayoutFbs, fcs: prepared.outerLayoutFcs };
  const innerLayoutByUniverse = { fbs: prepared.innerLayoutFbs, fcs: prepared.innerLayoutFcs };
  const outerConfSpansByUniverse = { fbs: prepared.outerConfSpansFbs, fcs: prepared.outerConfSpansFcs };

  for (const universe of ["fbs", "fcs"]) {
    const h = halves[universe];
    const schools = universe === "fbs" ? prepared.fbsSchools : prepared.fcsSchools;
    const totalPortal = d3.sum(schools, d => d.portalEntries);
    const totalFlow = d3.sum(prepared.data.flows, f =>
      (prepared.innerByName.get(f.source).universe === universe) ? f.count : 0);

    h.gCenter.append("text").attr("class", "center-title").attr("y", -10).text(universe.toUpperCase());
    h.gCenter.append("text").attr("class", "center-stat").attr("y", 14).text(`${schools.length} schools`);
    h.gCenter.append("text").attr("class", "center-stat").attr("y", 32).text(`${totalPortal.toLocaleString()} portal entries`);
    h.gCenter.append("text").attr("class", "center-stat").attr("y", 50).text(`${totalFlow.toLocaleString()} transfers out of ${universe.toUpperCase()}`);

    h.gOuter.selectAll("path.outer-school")
      .data(outerLayoutByUniverse[universe])
      .join("path")
      .attr("class", "outer-school")
      .attr("d", d => arcOuter({ startAngle: d.startAngle, endAngle: d.endAngle }))
      .attr("fill", d => shadeForSchool(colorOfConf(d.conference, mode), d, mode))
      .attr("data-school", d => d.school)
      .on("mouseenter", (event, d) => showTip(`<strong>${d.school}</strong><br>${d.conference}<br>Roster limit: ${d.roster}`, event))
      .on("mousemove", moveTip)
      .on("mouseleave", hideTip)
      .on("click", (event, d) => { if (!zoomCtl.wasPanned()) togglePin({ type: "school", key: d.school }); });

    const innerGroups = h.gInner.selectAll("g.inner-school")
      .data(innerLayoutByUniverse[universe])
      .join("g")
      .attr("class", "inner-school")
      .attr("data-school", d => d.school);

    innerGroups.each(function (d) {
      const g = d3.select(this);
      const sub = prepared.schoolSub.get(d.school);
      const players = prepared.schoolPlayers.get(d.school);
      const baseColor = colorOfConf(d.conference, mode);
      const gTicks = g.append("g").attr("class", "inner-seg-players");

      sub.segments.forEach(seg => {
        const deps = players.byTarget.get(seg.target) || [];
        g.append("path")
          .attr("class", "inner-seg")
          .attr("d", arcInner({ startAngle: seg.startAngle, endAngle: seg.endAngle }))
          .attr("fill", shadeForSchool(baseColor, d, mode))
          .on("mouseenter", (event) => showTip(`<strong>${d.school} &rarr; ${seg.target}</strong><br>${seg.count} player${seg.count === 1 ? "" : "s"}<br><em>Click for the full list</em>`, event))
          .on("mousemove", moveTip)
          .on("mouseleave", hideTip)
          .on("click", (event) => {
            event.stopPropagation();
            if (zoomCtl.wasPanned()) return;
            const segKey = `${d.school}::${seg.target}`;
            if (pin && pin.type === "school" && pin.key === d.school && pinnedSegKey === segKey) {
              setPin(null);
              hideSidePanel();
              lastPanelRefresh = null;
              return;
            }
            setPin({ type: "school", key: d.school });
            pinnedSegKey = segKey;
            openSegmentPanel(() => {
              const matched = filtersActive(filters) ? deps.filter(dep => matchesFilters(dep, filters, { conf: d.conference, school: d.school })) : deps;
              const rows = matched.map(dep => ({
                name: dep.n, detail: `${dep.d}<br>${playerMetaHtml(dep)}`,
                onClick: matched.length === 1 ? (selected) => (selected ? isolateRibbon(segKey) : clearRibbonIsolation()) : undefined,
              }));
              showSidePanel(`${d.school} &rarr; ${seg.target}`, rows);
            });
          });

        evenTicks(seg.startAngle, seg.endAngle, deps).forEach(({ item: dep, startAngle: a0, endAngle: a1 }) => {
          const tickSel = gTicks.append("path")
            .attr("class", "player-tick")
            .attr("data-player-key", playerKey(d.school, dep))
            .attr("d", arcInner({ startAngle: a0, endAngle: a1 }))
            .attr("fill", shadeForSchool(baseColor, d, mode))
            .on("mouseenter", (event) => enterPlayerTick(d.school, dep, a0, a1, event))
            .on("mousemove", (event) => { moveTip(event); cancelPlayerHoverClear(); })
            .on("mouseleave", () => leavePlayerTick())
            .on("click", (event) => {
              event.stopPropagation();
              togglePlayerPin(d.school, dep, a0, a1);
            });
          tickRegistry.push({ el: tickSel.node(), dep, conf: d.conference, school: d.school, a0, a1 });
        });
      });
      if (sub.leftoverEnd > sub.leftoverStart) {
        g.append("path")
          .attr("class", "inner-seg inner-leftover")
          .attr("d", arcInner({ startAngle: sub.leftoverStart, endAngle: sub.leftoverEnd }))
          .attr("fill", "var(--leftover)")
          .on("mouseenter", (event) => {
            showTip(`<strong>${d.school}</strong><br>${players.leftover.length} player${players.leftover.length === 1 ? "" : "s"} still in the portal, or transferred to a non-FBS/FCS program<br><em>Click for the full list</em>`, event);
          })
          .on("mousemove", moveTip)
          .on("mouseleave", hideTip)
          .on("click", (event) => {
            event.stopPropagation();
            openSegmentPanel(() => {
              const list = filtersActive(filters) ? players.leftover.filter(dep => matchesFilters(dep, filters, { conf: d.conference, school: d.school })) : players.leftover;
              const rows = list.map(dep => ({ name: dep.n, detail: `${depStatusHtml(dep)} &middot; ${dep.d}<br>${playerMetaHtml(dep)}` }));
              showSidePanel(`${d.school} &mdash; still in portal / left FBS+FCS entirely`, rows);
            });
          });

        evenTicks(sub.leftoverStart, sub.leftoverEnd, players.leftover).forEach(({ item: dep, startAngle: a0, endAngle: a1 }) => {
          const tickSel = gTicks.append("path")
            .attr("class", "player-tick player-tick-leftover")
            .attr("data-player-key", playerKey(d.school, dep))
            .attr("d", arcInner({ startAngle: a0, endAngle: a1 }))
            .attr("fill", "var(--leftover)")
            .on("mouseenter", (event) => {
              showTip(`<strong>${dep.n}</strong><br>${d.school} &mdash; ${depStatusHtml(dep)}<br>${dep.d}<br>${playerMetaHtml(dep)}`, event);
              setDim(n => n.school === d.school);
            })
            .on("mousemove", (event) => moveTip(event))
            .on("mouseleave", () => { hideTip(); restoreBaseDim(); })
            .on("click", (event) => {
              event.stopPropagation();
              togglePlayerPin(d.school, dep, a0, a1);
            });
          tickRegistry.push({ el: tickSel.node(), dep, conf: d.conference, school: d.school, a0, a1 });
        });
      }
    });

    innerGroups
      .on("mouseenter", (event, d) => { if (!zoomDetail) enterSchool(Object.assign({}, d, { universe })); })
      .on("mousemove", (event) => moveTip(event))
      .on("mouseleave", () => { if (!zoomDetail) leaveSchool(); })
      .on("click", (event, d) => { if (!zoomDetail && !zoomCtl.wasPanned()) togglePin({ type: "school", key: d.school }); });

    h.gConfLabels.selectAll("text.conf-label")
      .data(Array.from(outerConfSpansByUniverse[universe].values()))
      .join("text")
      .attr("class", "conf-label")
      .attr("data-conf", d => d.conference)
      .each(function (d) {
        const a = midAngle(d);
        const flipped = a > Math.PI / 2 && a < 3 * Math.PI / 2;
        const [x, y] = polar(a, geo.outerOuter + 6);
        const rot = (a * 180 / Math.PI) - 90 + (flipped ? 180 : 0);
        d3.select(this)
          .attr("transform", `translate(${x},${y}) rotate(${rot})`)
          .attr("text-anchor", flipped ? "end" : "start")
          .attr("dy", "0.35em")
          .text(d.conference);
      })
      .on("mouseenter", (event, d) => {
        enterConference(d.conference);
        const innerSpan = prepared.innerConfSpans.get(d.conference);
        const outTotal = d3.sum(prepared.confSub.get(d.conference).segments, s => s.count);
        showTip(`<strong>${d.conference}</strong><br>${d.schools.length} schools &middot; ${innerSpan.portalEntries} portal entries<br>${outTotal} transfers to other conferences`, event);
      })
      .on("mousemove", (event) => moveTip(event))
      .on("mouseleave", () => leaveConference())
      .on("click", (event, d) => { if (!zoomCtl.wasPanned()) togglePin({ type: "conference", key: d.conference }); });
  }
  applyFilterDim();

  // ---- shared chord-drawing helpers (route to the right layer/coord-space) -
  function appendFlowRibbon(layer, sourceSeg, targetSpan, sourceUniverse, targetUniverse, fillConf, tipHtml, opts) {
    opts = opts || {};
    const srcSpan = shrinkSpan(sourceSeg.startAngle, sourceSeg.endAngle, geo.chordRadius);
    const tgtSpan = shrinkSpan(targetSpan.startAngle, targetSpan.endAngle, geo.chordRadius);
    let sel;
    if (sourceUniverse === targetUniverse) {
      sel = layer.same.append("path")
        .attr("class", "chord")
        .attr("d", localRibbon({ source: srcSpan, target: tgtSpan }))
        .attr("fill", colorOfConf(fillConf, mode))
        .attr("stroke", colorOfConf(fillConf, mode))
        .style("opacity", layer.opacity);
    } else {
      const srcOff = offsetOf(sourceUniverse), tgtOff = offsetOf(targetUniverse);
      const midX = (srcOff[0] + tgtOff[0]) / 2;
      const p1 = polar(srcSpan.startAngle, geo.chordRadius, srcOff);
      const p2 = polar(srcSpan.endAngle, geo.chordRadius, srcOff);
      const p3 = polar(tgtSpan.startAngle, geo.chordRadius, tgtOff);
      const p4 = polar(tgtSpan.endAngle, geo.chordRadius, tgtOff);
      sel = layer.cross.append("path")
        .attr("class", "chord chord-cross")
        .attr("d", crossRibbonPath(p1, p2, p3, p4, midX))
        .attr("fill", colorOfConf(fillConf, mode))
        .attr("stroke", colorOfConf(fillConf, mode))
        .style("opacity", layer.opacity);
    }
    if (opts.extraClass) sel.classed(opts.extraClass, true);
    if (opts.pairKey) sel.attr("data-pair-key", opts.pairKey);
    if (opts.onClick) sel.on("click", opts.onClick);
    if (opts.interactive) {
      sel.on("mouseenter", (event) => { showTip(tipHtml, event); cancelPlayerHoverClear(); })
        .on("mousemove", (event) => { moveTip(event); cancelPlayerHoverClear(); })
        .on("mouseleave", () => schedulePlayerHoverClear());
    } else {
      sel.on("mouseenter", (event) => showTip(tipHtml, event))
        .on("mousemove", moveTip)
        .on("mouseleave", hideTip);
    }
  }

  function renderConferenceChords(sameGroups, crossGroup, conf, direction) {
    sameGroups.fbs.selectAll("*").remove();
    sameGroups.fcs.selectAll("*").remove();
    crossGroup.selectAll("*").remove();
    const universe = universeOfConference(conf);
    const sub = prepared.confSub.get(conf);
    const mySpan = prepared.innerConfSpans.get(conf);
    const showOut = direction !== "in";
    const showIn = direction !== "out";

    const outRibbons = showOut
      ? sub.segments.map(seg => ({ seg, deps: filteredConfDeps(conf, seg.target) })).filter(r => r.deps.length > 0)
      : [];
    const inRibbons = [];
    if (showIn) {
      for (const [otherConf, otherSub] of prepared.confSub) {
        if (otherConf === conf) continue;
        for (const seg of otherSub.segments) {
          if (seg.target !== conf) continue;
          const deps = filteredConfDeps(otherConf, conf);
          if (deps.length > 0) inRibbons.push({ otherConf, seg, deps });
        }
      }
    }
    const maxCount = d3.max([...outRibbons, ...inRibbons], r => r.deps.length) || 1;
    const opacityScale = d3.scalePow().exponent(0.5).domain([0, maxCount]).range([0.5, 1]).clamp(true);

    for (const { seg, deps } of outRibbons) {
      const targetUniverse = universeOfConference(seg.target);
      const targetSeg = incomingSegment(prepared.confSubIncoming, seg.target, conf, prepared.innerConfSpans.get(seg.target));
      const label = pairLabel(deps, conf, seg.target);
      appendFlowRibbon({ same: sameGroups[universe], cross: crossGroup, opacity: opacityScale(deps.length) },
        seg, targetSeg, universe, targetUniverse, conf,
        `<strong>${label}</strong><br>${deps.length} player${deps.length === 1 ? "" : "s"}<br><em>Click for the full list</em>`,
        {
          onClick: () => openSegmentPanel(() => {
            const fresh = filteredConfDeps(conf, seg.target);
            const rows = fresh.map(({ school, dep }) => ({
              name: dep.n, detail: `${school} &rarr; ${dep.t} &middot; ${dep.d}<br>${playerMetaHtml(dep)}`,
            }));
            showSidePanel(pairLabel(fresh, conf, seg.target), rows);
          }),
        });
    }
    const myIncoming = prepared.confSubIncoming.get(conf);
    for (const { otherConf, seg, deps } of inRibbons) {
      const otherUniverse = universeOfConference(otherConf);
      const targetSeg = (myIncoming && myIncoming.segments.find(s => s.target === otherConf)) || mySpan;
      const label = pairLabel(deps, otherConf, conf);
      appendFlowRibbon({ same: sameGroups[otherUniverse], cross: crossGroup, opacity: opacityScale(deps.length) },
        seg, targetSeg, otherUniverse, universe, otherConf,
        `<strong>${label}</strong><br>${deps.length} player${deps.length === 1 ? "" : "s"}<br><em>Click for the full list</em>`,
        {
          onClick: () => openSegmentPanel(() => {
            const fresh = filteredConfDeps(otherConf, conf);
            const rows = fresh.map(({ school, dep }) => ({
              name: dep.n, detail: `${school} &rarr; ${dep.t} &middot; ${dep.d}<br>${playerMetaHtml(dep)}`,
            }));
            showSidePanel(pairLabel(fresh, otherConf, conf), rows);
          }),
        });
    }
  }

  function renderSchoolChords(sameGroups, crossGroup, school, direction) {
    sameGroups.fbs.selectAll("*").remove();
    sameGroups.fcs.selectAll("*").remove();
    crossGroup.selectAll("*").remove();
    const d = prepared.innerByName.get(school);
    const sub = prepared.schoolSub.get(school);
    const showOut = direction !== "in";
    const showIn = direction !== "out";

    if (showOut) {
      for (const seg of sub.segments) {
        const count = filteredSchoolCount(school, seg.target);
        if (count === 0) continue;
        const targetLayout = prepared.innerByName.get(seg.target);
        const targetSeg = incomingSegment(prepared.schoolSubIncoming, seg.target, school, targetLayout);
        appendFlowRibbon({ same: sameGroups[d.universe], cross: crossGroup, opacity: 0.9 },
          seg, targetSeg, d.universe, targetLayout.universe, d.conference,
          `<strong>${school} &rarr; ${seg.target}</strong><br>${count} player${count === 1 ? "" : "s"}<br><em>Click for the full list</em>`,
          {
            pairKey: `${school}::${seg.target}`,
            onClick: () => openSegmentPanel(() => {
              const deps = filteredSchoolDeps(school, seg.target);
              const pairKey = `${school}::${seg.target}`;
              const rows = deps.map(dep => ({
                name: dep.n, detail: `${dep.d}<br>${playerMetaHtml(dep)}`,
                onClick: deps.length === 1 ? (selected) => (selected ? isolateRibbon(pairKey) : clearRibbonIsolation()) : undefined,
              }));
              showSidePanel(`${school} &rarr; ${seg.target}`, rows);
            }),
          });
      }
    }
    if (showIn) {
      const incoming = prepared.flowsByTarget.get(school) || [];
      const myIncoming = prepared.schoolSubIncoming.get(school);
      for (const f of incoming) {
        const count = filteredSchoolCount(f.source, school);
        if (count === 0) continue;
        const srcSub = prepared.schoolSub.get(f.source);
        const srcSeg = srcSub.segments.find(s => s.target === school);
        if (!srcSeg) continue;
        const srcLayout = prepared.innerByName.get(f.source);
        const targetSeg = (myIncoming && myIncoming.segments.find(s => s.target === f.source)) || d;
        appendFlowRibbon({ same: sameGroups[srcLayout.universe], cross: crossGroup, opacity: 0.9 },
          srcSeg, targetSeg, srcLayout.universe, d.universe, srcLayout.conference,
          `<strong>${f.source} &rarr; ${school}</strong><br>${count} player${count === 1 ? "" : "s"}<br><em>Click for the full list</em>`,
          {
            pairKey: `${f.source}::${school}`,
            onClick: () => openSegmentPanel(() => {
              const deps = filteredSchoolDeps(f.source, school);
              const pairKey = `${f.source}::${school}`;
              const rows = deps.map(dep => ({
                name: dep.n, detail: `${dep.d}<br>${playerMetaHtml(dep)}`,
                onClick: deps.length === 1 ? (selected) => (selected ? isolateRibbon(pairKey) : clearRibbonIsolation()) : undefined,
              }));
              showSidePanel(`${f.source} &rarr; ${school}`, rows);
            }),
          });
      }
    }
  }

  function renderPlayerChordInto(sameGroups, crossGroup, school, dep, a0, a1, interactive) {
    sameGroups.fbs.selectAll("*").remove();
    sameGroups.fcs.selectAll("*").remove();
    crossGroup.selectAll("*").remove();
    const d = prepared.innerByName.get(school);
    const targetLayout = prepared.innerByName.get(dep.t);
    if (!targetLayout) return;
    const targetSeg = incomingSegment(prepared.schoolSubIncoming, dep.t, school, targetLayout);
    appendFlowRibbon({ same: sameGroups[d.universe], cross: crossGroup, opacity: 0.9 },
      { startAngle: a0, endAngle: a1 }, targetSeg, d.universe, targetLayout.universe, d.conference,
      `<strong>${dep.n}</strong><br>${school} &rarr; ${dep.t}<br>${dep.d}<br>${playerMetaHtml(dep)}`,
      {
        interactive,
        extraClass: "chord-player",
        onClick: () => togglePlayerPin(school, dep, a0, a1),
      });
  }

  // Pinning a player also drives the side panel: pin it and open the panel,
  // or -- if it's already pinned -- unpin and close the panel, so the two
  // stay in lockstep no matter whether the tick or its ribbon was clicked.
  function togglePlayerPin(school, dep, a0, a1) {
    const key = playerKey(school, dep);
    const wasPinned = pin && pin.type === "player" && pin.key === key;
    togglePin({ type: "player", key, school, dep, tickStart: a0, tickEnd: a1 });
    lastPanelRefresh = null;
    if (wasPinned) hideSidePanel(); else openPlayerPanel(school, dep);
  }
  // A segment/leftover-box click opens the panel via `render`, and also
  // remembers it so a later filter-chip toggle can recompute the same list
  // in place instead of leaving it showing stale (pre-filter) rows.
  function openSegmentPanel(render) {
    lastPanelRefresh = render;
    render();
  }

  const hoverSame = { fbs: halves.fbs.gConfChords, fcs: halves.fcs.gConfChords };
  const hoverSchoolSame = { fbs: halves.fbs.gSchoolChords, fcs: halves.fcs.gSchoolChords };
  const hoverPlayerSame = { fbs: halves.fbs.gPlayerChords, fcs: halves.fcs.gPlayerChords };
  const pinConfSame = { fbs: halves.fbs.gPinConfChords, fcs: halves.fcs.gPinConfChords };
  const pinSchoolSame = { fbs: halves.fbs.gPinSchoolChords, fcs: halves.fcs.gPinSchoolChords };
  const pinPlayerSame = { fbs: halves.fbs.gPinPlayerChords, fcs: halves.fcs.gPinPlayerChords };

  let showAll = false;
  function renderAllConferenceChords() {
    hoverSame.fbs.selectAll("*").remove();
    hoverSame.fcs.selectAll("*").remove();
    gCrossChords.selectAll("*").remove();
    const ribbons = [];
    for (const [conf, sub] of prepared.confSub) {
      for (const seg of sub.segments) {
        const deps = filteredConfDeps(conf, seg.target);
        if (deps.length > 0) ribbons.push({ conf, seg, deps });
      }
    }
    const maxCount = d3.max(ribbons, r => r.deps.length) || 1;
    const opacityScale = d3.scalePow().exponent(0.5).domain([0, maxCount]).range([0.06, 0.45]).clamp(true);
    for (const { conf, seg, deps } of ribbons) {
      const universe = universeOfConference(conf);
      const targetUniverse = universeOfConference(seg.target);
      const targetSeg = incomingSegment(prepared.confSubIncoming, seg.target, conf, prepared.innerConfSpans.get(seg.target));
      const label = pairLabel(deps, conf, seg.target);
      appendFlowRibbon({ same: hoverSame[universe], cross: gCrossChords, opacity: opacityScale(deps.length) },
        seg, targetSeg, universe, targetUniverse, conf,
        `<strong>${label}</strong><br>${deps.length} player${deps.length === 1 ? "" : "s"}<br><em>Click for the full list</em>`,
        {
          onClick: () => {
            openSegmentPanel(() => {
              const fresh = filteredConfDeps(conf, seg.target);
              const rows = fresh.map(({ school, dep }) => ({
                name: dep.n,
                detail: `${school} &rarr; ${dep.t} &middot; ${dep.d}<br>${playerMetaHtml(dep)}`,
              }));
              showSidePanel(pairLabel(fresh, conf, seg.target), rows);
            });
          },
        });
    }
  }
  function setShowAll(v) {
    showAll = v;
    if (shouldAutoShow()) renderAllConferenceChords();
    else { hoverSame.fbs.selectAll("*").remove(); hoverSame.fcs.selectAll("*").remove(); gCrossChords.selectAll("*").remove(); }
  }
  // See the equivalent note in renderUniverse: any active filter implies
  // "show all" for the conference-pair backdrop too, so a filter chip draws
  // its matching ribbons on its own instead of only ever affecting whatever
  // happens to be hovered or pinned.
  function shouldAutoShow() { return showAll || filtersActive(filters); }

  function setDim(matchFn) {
    root.selectAll(".outer-school, .inner-school").classed("dimmed", n => !matchFn(n));
  }
  function clearDim() { root.selectAll(".outer-school, .inner-school").classed("dimmed", false); }
  function restoreBaseDim() {
    if (!pin) { clearDim(); return; }
    if (pin.type === "conference") setDim(n => n.conference === pin.key);
    else if (pin.type === "school") setDim(n => n.school === pin.key);
    else if (pin.type === "player") setDim(n => n.school === pin.school || n.school === pin.dep.t);
  }

  let hoverActive = null;
  function enterSchool(d) {
    hoverActive = { type: "school", key: d.school };
    hoverSame.fbs.selectAll("*").remove();
    hoverSame.fcs.selectAll("*").remove();
    renderSchoolChords(hoverSchoolSame, gCrossChords, d.school, direction);
    setDim(n => n.school === d.school);
  }
  function leaveSchool() {
    hoverActive = null;
    hoverSchoolSame.fbs.selectAll("*").remove();
    hoverSchoolSame.fcs.selectAll("*").remove();
    restoreBaseDim();
    if (shouldAutoShow()) renderAllConferenceChords();
  }
  function enterConference(conf) {
    hoverActive = { type: "conference", key: conf };
    hoverSchoolSame.fbs.selectAll("*").remove();
    hoverSchoolSame.fcs.selectAll("*").remove();
    renderConferenceChords(hoverSame, gCrossChords, conf, direction);
    setDim(n => n.conference === conf);
  }
  function leaveConference() {
    hoverActive = null;
    if (shouldAutoShow()) renderAllConferenceChords();
    else { hoverSame.fbs.selectAll("*").remove(); hoverSame.fcs.selectAll("*").remove(); gCrossChords.selectAll("*").remove(); }
    restoreBaseDim();
    hideTip();
  }
  // See the equivalent note in renderUniverse: the ribbon sits just inside
  // the radius of the tick that spawned it, so clearing it the instant the
  // mouse leaves the tick made it impossible to ever move the cursor onto
  // the ribbon to click it. This timer bridges that gap.
  let playerHoverTimer = null;
  function cancelPlayerHoverClear() { clearTimeout(playerHoverTimer); }
  function schedulePlayerHoverClear() {
    clearTimeout(playerHoverTimer);
    playerHoverTimer = setTimeout(() => {
      hoverPlayerSame.fbs.selectAll("*").remove();
      hoverPlayerSame.fcs.selectAll("*").remove();
      restoreBaseDim();
      hideTip();
    }, 300);
  }
  function enterPlayerTick(school, dep, a0, a1, event) {
    cancelPlayerHoverClear();
    renderPlayerChordInto(hoverPlayerSame, gCrossChords, school, dep, a0, a1, true);
    setDim(n => n.school === school || n.school === dep.t);
    showTip(`<strong>${dep.n}</strong><br>${school} &rarr; ${dep.t}<br>${dep.d}<br>${playerMetaHtml(dep)}`, event);
  }
  function leavePlayerTick() {
    schedulePlayerHoverClear();
  }

  let pin = null;
  let lastPanelRefresh = null;
  // See the matching comment in renderUniverse: tracks which segment
  // (school+target) most recently pinned via a segment click.
  let pinnedSegKey = null;
  let direction = getDirection("combined");

  function pinLabel(p) {
    if (p.type === "player") return `${p.dep.n} &mdash; ${p.school} &rarr; ${p.dep.t} (${p.dep.d})`;
    return p.key;
  }
  function redrawPin() {
    pinConfSame.fbs.selectAll("*").remove();
    pinConfSame.fcs.selectAll("*").remove();
    pinSchoolSame.fbs.selectAll("*").remove();
    pinSchoolSame.fcs.selectAll("*").remove();
    pinPlayerSame.fbs.selectAll("*").remove();
    pinPlayerSame.fcs.selectAll("*").remove();
    gPinCrossChords.selectAll("*").remove();
    root.selectAll(".pin-highlight").classed("pin-highlight", false);
    if (pin) {
      if (pin.type === "conference") {
        renderConferenceChords(pinConfSame, gPinCrossChords, pin.key, direction);
        root.selectAll("text.conf-label").filter(d => d.conference === pin.key).classed("pin-highlight", true);
      } else if (pin.type === "school") {
        renderSchoolChords(pinSchoolSame, gPinCrossChords, pin.key, direction);
        root.selectAll(`.outer-school[data-school="${cssEscape(pin.key)}"], .inner-school[data-school="${cssEscape(pin.key)}"]`).classed("pin-highlight", true);
      } else if (pin.type === "player") {
        renderPlayerChordInto(pinPlayerSame, gPinCrossChords, pin.school, pin.dep, pin.tickStart, pin.tickEnd);
        root.selectAll(`[data-player-key="${cssEscape(pin.key)}"]`).classed("pin-highlight", true);
      }
    }
    restoreBaseDim();
    updatePinIndicator();
    playerSearch.refresh();
  }
  function setPin(next) { pin = next; pinnedSegKey = null; redrawPin(); }
  function togglePin(candidate) {
    if (pin && pin.type === candidate.type && pin.key === candidate.key) setPin(null);
    else setPin(candidate);
  }
  function updatePinIndicator() {
    const chip = document.getElementById("pinchip-combined");
    const labelEl = document.getElementById("pinlabel-combined");
    if (!chip || !labelEl) return;
    if (pin) { chip.classList.add("active"); labelEl.innerHTML = pinLabel(pin); }
    else { chip.classList.remove("active"); labelEl.textContent = ""; }
  }
  function setDirection(v) {
    direction = v;
    redrawPin();
    if (hoverActive) {
      if (hoverActive.type === "school") renderSchoolChords(hoverSchoolSame, gCrossChords, hoverActive.key, direction);
      else renderConferenceChords(hoverSame, gCrossChords, hoverActive.key, direction);
    }
  }

  filterCtl.onChange(() => {
    applyFilterDim();
    if (!hoverActive) {
      if (shouldAutoShow()) renderAllConferenceChords();
      else { hoverSame.fbs.selectAll("*").remove(); hoverSame.fcs.selectAll("*").remove(); gCrossChords.selectAll("*").remove(); }
    } else if (hoverActive.type === "school") {
      renderSchoolChords(hoverSchoolSame, gCrossChords, hoverActive.key, direction);
    } else {
      renderConferenceChords(hoverSame, gCrossChords, hoverActive.key, direction);
    }
    if (pin) redrawPin();
    if (lastPanelRefresh) lastPanelRefresh();
  });

  svg.on("click", (event) => {
    if (zoomCtl.wasPanned()) return;
    if (event.target === svgEl) { setPin(null); lastPanelRefresh = null; hideSidePanel(); }
  });

  // ---- legend --------------------------------------------------------------
  const legend = d3.select(legendEl);
  legend.selectAll("*").remove();
  const allConfs = [...PALETTES.fbs.conferences, ...PALETTES.fcs.conferences];
  const items = legend.selectAll(".legend-item").data(allConfs).join("div").attr("class", "legend-item");
  items.append("span").attr("class", "legend-swatch").style("background", d => colorOfConf(d, mode));
  items.append("span").attr("class", "legend-label").text(d => d);
  const leftoverItem = legend.append("div").attr("class", "legend-item");
  leftoverItem.append("span").attr("class", "legend-swatch").style("background", "var(--leftover)");
  leftoverItem.append("span").attr("class", "legend-label").text("Still in portal / left FBS+FCS entirely");

  return {
    setShowAll,
    setDirection,
    clearPin: () => setPin(null),
    zoomIn: () => zoomCtl.zoomBy(1.5),
    zoomOut: () => zoomCtl.zoomBy(1 / 1.5),
    zoomReset: () => zoomCtl.reset(),
    searchPlayers: playerSearch.searchPlayers,
    selectResult: playerSearch.selectResult,
    clearSearch: playerSearch.clearSearch,
  };
}

// Shade a conference's base color per-school for texture (ordinal step by
// index within conference, alternating so neighbors contrast). Purely a
// visual-separation device -- the shade itself carries no meaning.
function shadeForSchool(baseHex, d, mode) {
  const idx = d._shadeIndex !== undefined ? d._shadeIndex : (d._shadeIndex = hashShadeIndex(d.school));
  const steps = [0, -14, 10, -7, 5];
  const delta = steps[idx % steps.length];
  return adjustLightness(baseHex, mode === "dark" ? delta * 0.6 : delta);
}
function hashShadeIndex(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 5;
}
function adjustLightness(hex, deltaPct) {
  const c = d3.hsl(hex);
  c.l = Math.max(0.08, Math.min(0.92, c.l + deltaPct / 100));
  return c.formatHex();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function wireUniverseControls(key, handleRef) {
  const showAllBox = document.getElementById(`showall-${key}`);
  showAllBox.addEventListener("change", () => handleRef.current.setShowAll(showAllBox.checked));
  document.getElementById(`zoomin-${key}`).addEventListener("click", () => handleRef.current.zoomIn());
  document.getElementById(`zoomout-${key}`).addEventListener("click", () => handleRef.current.zoomOut());
  document.getElementById(`zoomreset-${key}`).addEventListener("click", () => handleRef.current.zoomReset());
  document.querySelectorAll(`input[name="dir-${key}"]`).forEach(radio => {
    radio.addEventListener("change", () => { if (radio.checked) handleRef.current.setDirection(radio.value); });
  });
  const pinClear = document.getElementById(`pinclear-${key}`);
  if (pinClear) pinClear.addEventListener("click", () => handleRef.current.clearPin());

  wirePlayerSearchInput(key, handleRef);
}

function wireTabs() {
  const buttons = Array.from(document.querySelectorAll(".tab-btn"));
  buttons.forEach(btn => btn.addEventListener("click", () => {
    buttons.forEach(b => b.classList.toggle("active", b === btn));
    document.getElementById("view-separate").style.display = btn.dataset.view === "separate" ? "" : "none";
    document.getElementById("view-combined").style.display = btn.dataset.view === "combined" ? "" : "none";
  }));
}

function boot(CHORD_DATA) {
  const geo = {
    outerOuter: 336, outerInner: 300,
    innerOuter: 292, innerInner: 250,
    chordRadius: 250,
  };
  const geoCombined = {
    outerOuter: 300, outerInner: 268,
    innerOuter: 260, innerInner: 222,
    chordRadius: 222, offset: 420,
  };

  const fbsPrepared = prepareUniverse(CHORD_DATA.fbs, PALETTES.fbs.conferences);
  const fcsPrepared = prepareUniverse(CHORD_DATA.fcs, PALETTES.fcs.conferences);
  const combinedPrepared = prepareCombined(CHORD_DATA.combined);

  const fbsHandleRef = { current: null };
  const fcsHandleRef = { current: null };
  const combinedHandleRef = { current: null };

  function renderAll() {
    fbsHandleRef.current = renderUniverse(document.getElementById("svg-fbs"), document.getElementById("legend-fbs"), "fbs", "FBS", fbsPrepared, geo);
    fcsHandleRef.current = renderUniverse(document.getElementById("svg-fcs"), document.getElementById("legend-fcs"), "fcs", "FCS", fcsPrepared, geo);
    combinedHandleRef.current = renderCombined(document.getElementById("svg-combined"), document.getElementById("legend-combined"), combinedPrepared, geoCombined);
    // Preserve whatever "show all" state each panel's checkbox already
    // reflects (relevant on theme-toggle re-renders, which rebuild the SVG).
    // Direction is re-read from the radio DOM at construction time inside
    // each render function, so it doesn't need re-syncing here. Pins are
    // NOT preserved across a theme-toggle re-render (fresh SVG, fresh
    // state) -- an acceptable reset, since theme toggles are rare and not
    // part of the normal explore-the-data flow.
    if (document.getElementById("showall-fbs").checked) fbsHandleRef.current.setShowAll(true);
    if (document.getElementById("showall-fcs").checked) fcsHandleRef.current.setShowAll(true);
    if (document.getElementById("showall-combined").checked) combinedHandleRef.current.setShowAll(true);
  }

  renderAll();
  wireUniverseControls("fbs", fbsHandleRef);
  wireUniverseControls("fcs", fcsHandleRef);
  wireUniverseControls("combined", combinedHandleRef);
  wireTabs();
  document.getElementById("side-panel-close").addEventListener("click", hideSidePanel);

  const observer = new MutationObserver(renderAll);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderAll);
}

fetch("chord_data.json")
  .then((res) => res.json())
  .then((data) => boot(data));
