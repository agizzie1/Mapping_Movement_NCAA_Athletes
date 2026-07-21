// ---------------------------------------------------------------------------
// Reusable "search a player by name" feature for On3 transfer-portal chord
// diagrams (built for the basketball diagram, written to also drop into the
// football one's fbs/fcs/combined panels unchanged).
//
// Two pieces, matching how this codebase already separates "stuff that gets
// rebuilt every render" from "stuff wired once at boot":
//
//   - createPlayerSearchController(opts): call once per render, inside
//     renderUniverse (or its football equivalent), AFTER that render's own
//     tick registry / pin state / placeTip helper exist. Returns
//     { searchPlayers, selectResult, clearSearch, refresh } -- put those on
//     the handle object the render function already returns.
//
//   - wirePlayerSearchInput(universeKey, handleRef): call once at boot
//     (alongside wireUniverseControls), for the SAME reason zoom/direction/
//     pin-clear are wired that way -- handleRef.current gets replaced on
//     every re-render, so the search <input>'s own event listeners stay
//     attached exactly once while always delegating to whichever render is
//     current.
//
// Host contract (what a viz.js must already have, per universe, to use
// this):
//   - HTML: a `#playersearch-${key}` <input> + `#playersearch-results-${key}`
//     dropdown container in the toolbar, and a `#player-search-tip-${key}`
//     box element near the diagram's #tooltip/#pin-tooltip. See
//     chord_diagram_template.html for the CSS these expect (.player-search,
//     .player-search-results, .player-search-result, #player-search-tip-*
//     and its .ps-* children).
//   - JS: a per-player tick registry (one entry per searchable player, each
//     with the DOM node for its tick, its dep record, its school, and its
//     tick's start/end angles so a ribbon can be drawn without having
//     zoomed in first), a single shared "pin" slot with get/set functions
//     (setPin(null) clears it, setPin({type:"player", key, school, dep,
//     tickStart, tickEnd}) both pins AND redraws the ribbon), a
//     placeTip(d3Selection, anchorRect) corner-placement helper shared with
//     the conference pin-tooltip, a routeHtml(school, dep) formatter for
//     the "from -> to" / status line, and a playerKey(school, dep) formatter
//     for a stable per-player-event key.
// ---------------------------------------------------------------------------

function createPlayerSearchController({ universeKey, d3, getEntries, placeTip, routeHtml, playerKey, getPin, setPin }) {
  const tip = d3.select(`#player-search-tip-${universeKey}`);
  let searchedPlayer = null; // one entry from getEntries(), or null
  let priorExpanded = false;

  function priorRowsHtml(entry) {
    const pt = entry.dep.pt;
    return pt.map((stop, i) => {
      const from = i === 0 ? "&mdash;" : pt[i - 1].s;
      // "g" (grade at that prior school) is football-only and only present
      // when merge_prior_transfer_grades.py found a matching historical
      // snapshot -- basketball's stops, and the ~20% of football stops with
      // no match, just fall back to year-only, same as before grades existed.
      const yearText = stop.g ? `${stop.g} &middot; ${stop.y || "Unknown"}` : (stop.y || "Unknown");
      return `<div class="ps-prior-row"><div class="ps-prior-route">${from} &rarr; ${stop.s}</div><div class="ps-prior-year">${yearText}</div></div>`;
    }).join("");
  }

  // Two shapes of "pt" show up across the diagrams this module serves:
  // an array of {s, y} chain stops (basketball -- real school/year history,
  // expandable), or a plain integer count with no chain detail (football --
  // "Prior Transfers" is scraped as a count only). Anything else (null/
  // undefined/0) means no prior-transfer info at all.
  function priorTransfersHtml(entry) {
    const pt = entry.dep.pt;
    if (Array.isArray(pt) && pt.length) {
      return `<button type="button" class="ps-toggle-prior">${priorExpanded ? "Hide" : "Show"} prior transfers (${pt.length})</button>`
        + (priorExpanded ? `<div class="ps-prior-list">${priorRowsHtml(entry)}</div>` : "");
    }
    if (typeof pt === "number" && pt > 0) {
      return `<div class="ps-prior-count">${pt} prior transfer${pt === 1 ? "" : "s"}</div>`;
    }
    return "";
  }

  function isPinned(entry) {
    const pin = getPin();
    return !!(pin && pin.type === "player" && pin.key === playerKey(entry.school, entry.dep));
  }

  function statsHtml(entry) {
    const dep = entry.dep;
    return `
      <button type="button" class="ps-close" title="Close">&times;</button>
      <div class="ps-name">${dep.n}</div>
      <div class="ps-route">${routeHtml(entry.school, dep)}</div>
      <div class="ps-meta">${dep.d} &middot; ${dep.gr} &middot; ${dep.pos}</div>
      ${priorTransfersHtml(entry)}
      <div class="ps-hint">${isPinned(entry) ? "Click to un-highlight ribbon" : "Click to highlight ribbon"}</div>
    `;
  }

  function selectResult(entry) {
    searchedPlayer = entry;
    tip.style("display", "block").classed("ps-active", isPinned(entry)).html(statsHtml(entry));
    placeTip(tip, entry.el.getBoundingClientRect());
  }
  function refresh() {
    if (!searchedPlayer) return;
    tip.classed("ps-active", isPinned(searchedPlayer)).html(statsHtml(searchedPlayer));
  }
  function clearSearch() {
    searchedPlayer = null;
    priorExpanded = false;
    tip.style("display", "none");
  }
  function toggleHighlight() {
    if (!searchedPlayer) return;
    const key = playerKey(searchedPlayer.school, searchedPlayer.dep);
    const pin = getPin();
    if (pin && pin.type === "player" && pin.key === key) setPin(null);
    else setPin({ type: "player", key, school: searchedPlayer.school, dep: searchedPlayer.dep, tickStart: searchedPlayer.a0, tickEnd: searchedPlayer.a1 });
    refresh();
  }
  // d3's selection.on(typename, listener) replaces any prior listener of
  // the same typename on this element, so re-running this once per render
  // (createPlayerSearchController is called fresh each renderUniverse pass)
  // doesn't stack up duplicate handlers.
  tip.on("click", (event) => {
    if (event.target.closest(".ps-close")) { clearSearch(); return; }
    if (event.target.closest(".ps-toggle-prior")) { priorExpanded = !priorExpanded; refresh(); return; }
    toggleHighlight();
  });

  // Case-insensitive; names starting with the query rank above names that
  // merely contain it.
  function searchPlayers(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const starts = [], contains = [];
    for (const entry of getEntries()) {
      const name = entry.dep.n.toLowerCase();
      if (name.startsWith(q)) starts.push(entry);
      else if (name.includes(q)) contains.push(entry);
    }
    const byName = (a, b) => a.dep.n.localeCompare(b.dep.n);
    return [...starts.sort(byName), ...contains.sort(byName)].slice(0, 20);
  }

  return { searchPlayers, selectResult, clearSearch, refresh };
}

// Wires the toolbar <input> + results dropdown ONCE (at boot), delegating
// to whichever render's controller is current via handleRef.current --
// same indirection pattern wireUniverseControls already uses for zoom/
// direction/pin-clear. handleRef.current must expose searchPlayers/
// selectResult (e.g. by spreading createPlayerSearchController()'s return
// value into the object a render function returns).
function wirePlayerSearchInput(universeKey, handleRef) {
  const searchInput = document.getElementById(`playersearch-${universeKey}`);
  const searchResults = document.getElementById(`playersearch-results-${universeKey}`);
  if (!searchInput || !searchResults) return;

  let matches = [];
  function renderResults() {
    searchResults.innerHTML = matches.map((m, i) => `
      <button type="button" class="player-search-result" data-i="${i}">
        <span class="psr-name">${m.dep.n}</span><span class="psr-school">${m.school}</span>
      </button>`).join("");
    searchResults.hidden = matches.length === 0;
  }
  searchInput.addEventListener("input", () => {
    matches = handleRef.current.searchPlayers(searchInput.value);
    renderResults();
  });
  searchInput.addEventListener("focus", () => { if (searchInput.value.trim()) renderResults(); });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { searchResults.hidden = true; searchInput.blur(); }
  });
  searchResults.addEventListener("click", (event) => {
    const btn = event.target.closest(".player-search-result");
    if (!btn) return;
    const entry = matches[Number(btn.dataset.i)];
    if (!entry) return;
    handleRef.current.selectResult(entry);
    searchInput.value = entry.dep.n;
    searchResults.hidden = true;
  });
  document.addEventListener("click", (event) => {
    if (!searchInput.contains(event.target) && !searchResults.contains(event.target)) searchResults.hidden = true;
  });
}
