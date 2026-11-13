import { escapeHTML as h, nextMilestone, readStored, formatScanAge } from './radar-utils.js';
import { saveProfileAndRun } from './github-profile.js';
const DEMO_NOW = new Date();
const state = {
  opportunities: [],
  filter: "all",
  discoveryIndex: 0,
  watchlist: readStored(localStorage, "radar-watchlist", ["cvpr-2027"], value => Array.isArray(value) && value.every(id => typeof id === "string")),
  profile: null,
};

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

function nextActionable(opportunity) {
  return nextMilestone(opportunity, new Date());
}

function daysUntil(datetime) {
  return Math.max(0, Math.ceil((new Date(datetime) - new Date()) / 86400000));
}

function formatDate(milestone, includeTime = false) {
  // Render the source's calendar date without letting the viewer's timezone
  // shift an AoE date into the following day. Local conversion is separate.
  const [year, month, day] = milestone.datetime.slice(0, 10).split("-").map(Number);
  const sourceDate = new Date(Date.UTC(year, month - 1, day));
  const base = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(sourceDate);
  if (!includeTime) return base;
  return `${base} · ${milestone.datetime.slice(11, 16)} ${milestone.timezone_label === "Anywhere on Earth" ? "AoE" : milestone.timezone}`;
}

function localDate(milestone) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(milestone.datetime));
}

function sortedOpportunities() {
  return state.opportunities.filter(op => op.matches_profile !== false && nextActionable(op)).sort((a, b) => new Date(nextActionable(a).datetime) - new Date(nextActionable(b).datetime));
}

function renderHero() {
  const op = sortedOpportunities()[0];
  if (!op) {
    $("#hero-title").textContent = "No upcoming deadlines";
    $("#hero-days").textContent = "—";
    $("#hero-type").textContent = "Check source pages for new calls";
    $("#open-hero").hidden = true; $("#watch-hero").hidden = true;
    return;
  }
  const milestone = nextActionable(op);
  $("#hero-title").textContent = op.title;
  $("#hero-type").textContent = `${op.type_label} · ${op.relevance.label}`;
  $("#hero-milestone").textContent = `${milestone.label} · ${formatDate(milestone)}`;
  $("#hero-days").textContent = daysUntil(milestone.datetime);
  $("#hero-date").textContent = formatDate(milestone, true);
  $("#hero-reason").textContent = op.relevance.reason;
  $("#open-hero").onclick = () => openDetails(op.id);
  const watch = $("#watch-hero");
  const tracked = state.watchlist.includes(op.id);
  watch.classList.toggle("tracked", tracked);
  watch.innerHTML = tracked ? "<span>✓</span> Tracking" : "<span>＋</span> Track";
  watch.onclick = () => toggleWatch(op.id);
}

function renderList() {
  const all = sortedOpportunities().slice(1);
  const items = (state.filter === "all" ? all : all.filter(op => op.type === state.filter)).slice(0, 4);
  $("#opportunity-list").innerHTML = items.map(op => {
    const deadline = nextActionable(op);
    return `<article class="opportunity-row" tabindex="0" data-open="${h(op.id)}">
      <div class="opportunity-name"><span class="type-mark ${h(op.type)}"></span><div><h3>${h(op.title)}</h3><p>${h(deadline.label)} · ${formatDate(deadline)}</p></div></div>
      <span class="mini-match">${h(op.relevance.label)}</span>
      <div class="row-count"><strong>${daysUntil(deadline.datetime)}</strong><span>days</span></div>
    </article>`;
  }).join("") || `<div class="search-empty">No ${state.filter}s in range.</div>`;
  bindOpeners();
}

function renderDiscovery() {
  const discoveries = state.opportunities.filter(op => op.discovered && op.matches_profile !== false);
  const op = discoveries[state.discoveryIndex % discoveries.length];
  if (!op) return;
  $("#discovery-card").innerHTML = `<div class="discovery-visual"><span>NEW SIGNAL · ${h(op.type.toUpperCase())}</span></div>
    <div class="discovery-body"><h3>${h(op.title)}</h3><p>${h(op.relevance.reason)}</p><div class="tag-row">${op.relevance.matched_topics.map(t => `<span class="tag">${h(t)}</span>`).join("")}</div>
    <div class="discovery-footer"><span>${op.parent_event ? `At ${h(op.parent_event)}` : h(op.type_label)}</span><button data-open="${h(op.id)}">Inspect →</button></div></div>`;
  bindOpeners();
}

function renderTimeline() {
  const now = new Date();
  const months = Array.from({ length: 6 }, (_, i) => new Date(now.getFullYear(), now.getMonth() + i, 1));
  $("#timeline").innerHTML = months.map(month => {
    const events = sortedOpportunities().filter(op => {
      const d = new Date(nextActionable(op).datetime);
      return d.getMonth() === month.getMonth() && d.getFullYear() === month.getFullYear();
    });
    return `<div class="month"><div class="month-name">${month.toLocaleString("en-US", { month: "long" })}</div>${events.map(op => `<div class="timeline-event ${h(op.type)}"><i></i><span>${h(op.short_title || op.title)}</span></div>`).join("")}</div>`;
  }).join("");
}

function cardTemplate(op) {
  const deadline = nextActionable(op);
  const tracked = state.watchlist.includes(op.id);
  return `<article class="opportunity-card"><div class="card-top"><span class="card-type">${h(op.type_label)}${op.parent_event ? ` · ${h(op.parent_event)}` : ""}</span><button class="card-watch ${tracked ? "tracked" : ""}" data-watch="${h(op.id)}" aria-label="${tracked ? "Remove from" : "Add to"} watchlist">${tracked ? "✓" : "+"}</button></div>
    <h2>${h(op.title)}</h2><div class="card-date">${deadline ? `${h(deadline.label)} · ${formatDate(deadline)}` : "No upcoming milestones"}</div><p class="card-reason">${h(op.relevance.reason)}</p>
    <div class="card-bottom"><span class="match-label">${h(op.relevance.label)}</span><button data-open="${h(op.id)}">Details →</button></div></article>`;
}

function renderGrids() {
  const discoveries = state.opportunities.filter(op => op.discovered && op.matches_profile !== false);
  $("#discoveries-grid").innerHTML = discoveries.map(cardTemplate).join("");
  const watched = state.opportunities.filter(op => state.watchlist.includes(op.id));
  $("#watchlist-grid").innerHTML = watched.map(cardTemplate).join("");
  $("#watchlist-empty").style.display = watched.length ? "none" : "block";
  bindOpeners();
  $$('[data-watch]').forEach(button => button.onclick = () => toggleWatch(button.dataset.watch));
}

function bindOpeners() {
  $$('[data-open]').forEach(el => {
    el.onclick = () => openDetails(el.dataset.open);
    el.onkeydown = event => { if (event.key === "Enter") openDetails(el.dataset.open); };
  });
}

function openDetails(id) {
  const op = state.opportunities.find(item => item.id === id);
  const next = nextActionable(op);
  $("#detail-content").innerHTML = `<header class="detail-head"><p class="eyebrow">${h(op.type_label)}${op.parent_event ? ` · ${h(op.parent_event)}` : ""}</p><h2 id="detail-title">${h(op.title)}</h2><p>${h(op.organization)}</p><span class="detail-count">${next ? `${daysUntil(next.datetime)} days to ${h(next.label)}` : "No upcoming milestones"}</span></header>
    <div class="detail-body">
      ${op.updated ? `<div class="demo-notice"><span>Deadline changed</span>${h(op.change_note)}</div>` : ""}
      <section class="detail-section"><h3>Milestones</h3><div class="milestone-list">${op.milestones.map(m => `<div class="milestone ${m === next ? "next" : ""}"><b>${h(m.label)}</b><span>${formatDate(m, true)}<br><small>Local: ${localDate(m)}</small></span></div>`).join("")}</div></section>
      <section class="detail-section"><h3>Why this matches you</h3><div class="tag-row">${op.relevance.matched_topics.map(t => `<span class="tag">${h(t)}</span>`).join("")}</div><p>${h(op.relevance.reason)}</p></section>
      <section class="detail-section"><h3>Opportunity</h3><p>${h(op.type_label)}${op.parent_event ? ` attached to ${h(op.parent_event)}` : ""} · ${h(op.location.city)}, ${h(op.location.country)}${op.location.virtual ? " · Virtual option" : ""}</p></section>
      <section class="detail-section"><h3>Source verification</h3><div class="source-card"><div><p>${h(op.source.type)}</p><small>Last checked ${new Date(op.source.last_verified).toLocaleString()} · ${h(op.source.evidence)}</small></div><a href="${h(op.source.url)}" target="_blank" rel="noopener">Open source ↗</a></div></section>
    </div>`;
  showModal("detail-modal");
}

function toggleWatch(id) {
  const existing = state.watchlist.indexOf(id);
  if (existing >= 0) state.watchlist.splice(existing, 1); else state.watchlist.push(id);
  localStorage.setItem("radar-watchlist", JSON.stringify(state.watchlist));
  renderHero(); renderGrids();
  toast(existing >= 0 ? "Removed from watchlist" : "Added to watchlist");
}

function showView(name) {
  $$(".view").forEach(view => view.classList.toggle("active", view.id === `view-${name}`));
  $$(".nav-link").forEach(button => button.classList.toggle("active", button.dataset.view === name));
  if (location.hash !== `#${name}`) location.hash = name;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showModal(id) {
  const modal = $(`#${id}`); modal.hidden = false; document.body.style.overflow = "hidden";
  setTimeout(() => $("button, input", modal)?.focus(), 20);
}

let profileSaveController;
function closeModal(id) { if (id === "profile-modal") profileSaveController?.abort(); $(`#${id}`).hidden = true; document.body.style.overflow = ""; }

function toast(message) {
  const el = $("#toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2200);
}

function openSearch() {
  $("#search-overlay").hidden = false; document.body.style.overflow = "hidden";
  $("#search-input").value = ""; renderSearch(""); $("#search-input").focus();
}

function closeSearch() { $("#search-overlay").hidden = true; document.body.style.overflow = ""; }

function renderSearch(query) {
  const q = query.toLowerCase().trim();
  const matches = state.opportunities.filter(op => !q || [op.title, op.organization, op.type_label, op.location.city, op.location.country, ...op.topics].join(" ").toLowerCase().includes(q));
  $("#search-results").innerHTML = matches.length ? matches.map(op => `<button class="search-result" data-search-open="${h(op.id)}"><div><b>${h(op.title)}</b><span>${h(op.type_label)} · ${h(op.topics.slice(0,2).join(" · "))}</span></div><span>${nextActionable(op) ? `${daysUntil(nextActionable(op).datetime)} days` : "Closed"}</span></button>`).join("") : `<div class="search-empty">No signal found for “${h(query)}”.</div>`;
  $$('[data-search-open]').forEach(button => button.onclick = () => { closeSearch(); openDetails(button.dataset.searchOpen); });
}

function setupProfile(profile) {
  state.profile ||= profile;
  const form = $("#profile-form");
  form.areas.value = state.profile.research_areas.join("\n");
  form.projects.value = state.profile.current_projects.join("\n");
  form.keywords.value = state.profile.keywords.join("\n");
  form.onsubmit = async event => {
    event.preventDefault();
    if (profileSaveController) return;
    const lines = value => value.split("\n").map(v => v.trim()).filter(Boolean);
    const changes = { research_areas: lines(form.areas.value), current_projects: lines(form.projects.value), keywords: lines(form.keywords.value) };
    const token = $("#github-token").value;
    $("#github-token").value = "";
    profileSaveController = new AbortController();
    $("#profile-fields").disabled = true;
    $("#profile-save").disabled = true;
    $("#profile-save").textContent = "Saving profile…";
    $("#profile-cancel").textContent = "Continue in background";
    const progress = $("#profile-progress");
    progress.hidden = false;
    progress.classList.add("busy");
    $("#profile-run-link").hidden = true;
    const update = ({message,runURL}) => {
      $("#profile-status").textContent = message;
      if (runURL) { $("#profile-run-link").href = runURL; $("#profile-run-link").hidden = false; }
    };
    try {
      const result = await saveProfileAndRun({token,changes,signal:profileSaveController.signal,onStatus:update});
      state.profile = {...state.profile,...result.profile};
      try { localStorage.removeItem("radar-profile"); } catch { /* Repository is authoritative. */ }
      $("#profile-status").textContent = "Profile saved and radar published. Reloading your radar…";
      // Let Pages propagation begin; subsequent data requests bypass the browser cache.
      setTimeout(() => location.reload(), 3000);
    } catch (error) {
      if (error.name !== "AbortError") update({message:error.message,runURL:error.runURL});
    } finally {
      progress.classList.remove("busy");
      $("#profile-fields").disabled = false;
      $("#profile-save").disabled = false;
      $("#profile-save").textContent = "Save profile & update radar";
      $("#profile-cancel").textContent = "Close";
      profileSaveController = null;
    }
  };
}

function bindUI() {
  $$(".nav-link").forEach(button => button.onclick = () => showView(button.dataset.view));
  $$('[data-go]').forEach(button => button.onclick = () => showView(button.dataset.go));
  $$("[data-close]").forEach(button => button.onclick = () => closeModal(button.dataset.close));
  $$(".modal-backdrop").forEach(modal => modal.onclick = event => { if (event.target === modal) closeModal(modal.id); });
  $$(".segmented button").forEach(button => button.onclick = () => { state.filter = button.dataset.filter; $$(".segmented button").forEach(b => b.classList.toggle("active", b === button)); renderList(); });
  window.addEventListener("hashchange", () => { const view = location.hash.slice(1); showView(["radar","discoveries","watchlist"].includes(view) ? view : "radar"); });
  $("#next-discovery").onclick = () => { state.discoveryIndex++; renderDiscovery(); };
  $("#view-all").onclick = () => showView("discoveries");
  $("#profile-button").onclick = () => showModal("profile-modal");
  $("#search-button").onclick = openSearch;
  $("#search-input").oninput = event => renderSearch(event.target.value);
  $("#search-overlay").onclick = event => { if (event.target.id === "search-overlay") closeSearch(); };
  $("#dismiss-demo").onclick = event => event.currentTarget.parentElement.remove();
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") { closeSearch(); $$(".modal-backdrop").forEach(m => { if (!m.hidden) closeModal(m.id); }); }
    if ((event.metaKey || event.ctrlKey) && event.key === "k") { event.preventDefault(); openSearch(); }
  });
}

async function init() {
  try {
    const [opportunities, profile] = await Promise.all([fetch("data/opportunities.json", {cache:"no-store"}).then(r => r.json()), fetch("data/profile.json", {cache:"no-store"}).then(r => r.json())]);
    state.opportunities = opportunities.opportunities;
    $("#prototype-notice").hidden = !state.opportunities.some(op => /demonstration/i.test(op.source?.evidence || ""));
    $("#discovery-count").textContent = state.opportunities.filter(op => op.discovered && op.matches_profile !== false).length;
    $("#today-label").textContent = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(DEMO_NOW);
    $("#scan-age").textContent = opportunities.data_mode === "demonstration" ? "prototype dataset" : formatScanAge(opportunities.generated_at, DEMO_NOW);
    setupProfile(profile);
    renderHero(); renderList(); renderDiscovery(); renderTimeline(); renderGrids(); bindUI();
    const initial = location.hash.slice(1);
    if (["discoveries", "watchlist"].includes(initial)) showView(initial);
  } catch (error) {
    console.error(error);
    $("main").innerHTML = `<div class="empty-state" style="display:block"><h2>The radar could not load</h2><p>Serve this folder over HTTP so the structured data can be read.</p></div>`;
  }
}

init();
