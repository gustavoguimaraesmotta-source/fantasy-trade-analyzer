import { api } from "./api.js";

const CORE = ["QB", "RB", "WR", "TE"];
const ALL_POS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const STREAM = ["K", "DEF"];
const STATUS = { need: "Escassez", surplus: "Excesso", balanced: "Equilíbrio" };

const state = {
  user: null,
  overview: null,
  myRosterId: null,
  partnerId: null,
  sent: new Set(),
  received: new Set(),
  tab: "rosters",
};

// --- Utilitários -------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const fmt = (n) => Math.round(n ?? 0).toLocaleString("pt-BR");
const signed = (n) => (n > 0 ? "+" : "") + fmt(n);
const pctFmt = (p) => `${p > 0 ? "+" : ""}${(p * 100).toFixed(1)}%`;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sem storage */ } },
};

const teamById = (id) => state.overview?.teams.find((t) => t.roster_id === id);
const teamName = (t) => (t ? t.team_name || t.display_name : "—");
const posBadge = (pos) => `<span class="pos pos-${esc(pos || "NA")}">${esc(pos || "?")}</span>`;
const deltaClass = (n) => (n > 0 ? "pos-delta" : n < 0 ? "neg-delta" : "");
const avatar = (t) => (t.avatar ? `<img src="${esc(t.avatar)}" alt="">` : `<span class="ph"></span>`);

function playerName(p) {
  const inj = p.injury_status ? `<span class="tag inj">${esc(p.injury_status)}</span>` : "";
  return `${esc(p.name)} <small>${esc(p.team || "FA")}</small>${inj}`;
}

function setStatus(msg, kind = "info") {
  const el = $("#status");
  el.hidden = !msg;
  el.className = `status ${kind}`;
  el.textContent = msg || "";
}

async function withStatus(msg, fn) {
  setStatus(msg);
  try {
    const result = await fn();
    setStatus(null);
    return result;
  } catch (err) {
    setStatus(err.message, "error");
    return null;
  }
}

const options = (teams, selected) =>
  teams.map((t) => `<option value="${t.roster_id}" ${t.roster_id === selected ? "selected" : ""}>${esc(teamName(t))}</option>`).join("");

// --- Conexão / carregamento ---------------------------------------------------
async function connect(ev) {
  ev.preventDefault();
  const username = $("#username").value.trim();
  const season = $("#season").value.trim();
  if (!username) return;

  const data = await withStatus("Buscando usuário e ligas no Sleeper...", () => api.leagues(username, season));
  if (!data) return;
  store.set("fta.username", username);
  state.user = data.user;
  if (!season) $("#season").value = data.season;

  if (!data.leagues.length) {
    setStatus(`Nenhuma liga encontrada para ${username} em ${data.season}.`, "error");
    return;
  }
  const saved = store.get("fta.league");
  const preferred =
    data.leagues.find((l) => l.league_id === saved) ||
    data.leagues.find((l) => /galera/i.test(l.name)) ||
    data.leagues[0];
  $("#league-select").innerHTML = data.leagues
    .map((l) => `<option value="${esc(l.league_id)}">${esc(l.name)} (${l.total_rosters} times)</option>`)
    .join("");
  $("#league-select").value = preferred.league_id;
  $("#league-bar").hidden = false;
  await loadLeague(preferred.league_id);
}

// Cada carregamento ganha um número; se o usuário trocar de liga no meio, a resposta antiga é descartada.
let loadSeq = 0;

async function loadLeague(leagueId, refresh = false) {
  const seq = ++loadSeq;
  setStatus("Importando elencos e valores de mercado (na primeira visita do dia leva uns segundos)...");
  let ov;
  try {
    ov = await api.league(leagueId, refresh);
  } catch (err) {
    if (seq === loadSeq) setStatus(err.message, "error");
    return;
  }
  if (seq !== loadSeq) return;
  setStatus(null);
  store.set("fta.league", leagueId);
  state.overview = ov;

  const uid = state.user?.user_id;
  const mine = ov.teams.find((t) => t.owner_id === uid || t.co_owners.includes(uid)) || ov.teams[0];
  setMyTeam(mine.roster_id);

  $("#league-meta").textContent = `${ov.league.season} · ${ov.league.scoring} · ${ov.league.format} · valores: ${ov.league.value_source}`;
  $("#tabs").hidden = false;
  $("#empty-state").hidden = true;
  showTab(state.tab);
}

function setMyTeam(rosterId) {
  const teams = state.overview.teams;
  state.myRosterId = rosterId;
  const others = teams.filter((t) => t.roster_id !== rosterId);
  if (!others.some((t) => t.roster_id === state.partnerId)) state.partnerId = others[0]?.roster_id ?? null;
  state.sent.clear();
  state.received.clear();

  $("#my-team-select").innerHTML = options(teams, rosterId);
  $("#partner-select").innerHTML = options(others, state.partnerId);
  $("#cmp-a").innerHTML = options(teams, rosterId);
  $("#cmp-b").innerHTML = options(teams, state.partnerId);
  $("#finder-summary").innerHTML = "";
  $("#finder-results").innerHTML = "";
  $("#trade-result").hidden = true;
  $("#target-team").innerHTML = options(others, state.partnerId);
  setTargetTeam(state.partnerId);
  state.offer = new Set();
  renderOfferPicker();
  state.waiversKey = null;
  if (state.tab === "waivers") loadWaivers();
  renderPower();
  renderCompare();
  renderAnalyzer();
}

function showTab(name) {
  state.tab = name;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  if (name === "waivers" && state.overview) loadWaivers();
}

// --- Elencos (power table) ----------------------------------------------------
function renderPower() {
  const teams = [...state.overview.teams].sort((a, b) => b.lineup_value - a.lineup_value);
  const head = `<thead><tr><th>#</th><th>Time</th><th>Recorde</th><th class="num">Pts</th>
    <th class="num">Lineup titular</th><th class="num">Valor total</th>${CORE.map((p) => `<th class="num">${p}</th>`).join("")}</tr></thead>`;
  const rows = teams
    .map((t, i) => {
      const r = t.record;
      const cells = CORE.map((p) => {
        const s = t.positions[p];
        return `<td class="num"><span class="rank ${s.status}" title="${STATUS[s.status]} · força ${s.strength_index}% · banco ${s.depth_index}% da média">${s.rank}º</span></td>`;
      }).join("");
      return `<tr class="${t.roster_id === state.myRosterId ? "mine" : ""}">
        <td>${i + 1}</td>
        <td><div class="team-cell">${avatar(t)}<div><strong>${esc(teamName(t))}</strong><small>${esc(t.display_name)}</small></div></div></td>
        <td>${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}</td>
        <td class="num">${r.fpts.toFixed(1)}</td>
        <td class="num"><strong>${fmt(t.lineup_value)}</strong></td>
        <td class="num">${fmt(t.total_value)}</td>${cells}</tr>`;
    })
    .join("");
  $("#power-table").innerHTML = `${head}<tbody>${rows}</tbody>`;
}

// --- Comparador lado a lado ----------------------------------------------------
function renderCompare() {
  const a = teamById(+$("#cmp-a").value);
  const b = teamById(+$("#cmp-b").value);
  if (!a || !b) return;

  const summary = `<div class="table-wrap compare-block"><table class="data"><thead><tr>
      <th>${esc(teamName(a))}</th><th class="num">Métrica</th><th class="num">${esc(teamName(b))}</th></tr></thead><tbody>
      ${compareRow("Lineup titular", a.lineup_value, b.lineup_value)}
      ${compareRow("Valor total", a.total_value, b.total_value)}
      ${CORE.map((p) => compareRow(`Força ${p}`, a.positions[p].strength, b.positions[p].strength)).join("")}
    </tbody></table></div>`;

  const blocks = ALL_POS.map((pos) => {
    const pa = a.players.filter((p) => p.position === pos);
    const pb = b.players.filter((p) => p.position === pos);
    if (!pa.length && !pb.length) return "";
    const n = Math.max(pa.length, pb.length);
    let rows = "";
    for (let i = 0; i < n; i++) rows += comparePlayerRow(pa[i], pb[i]);
    return `<div class="compare-block"><h3>${posBadge(pos)} ${pos}</h3>
      <div class="table-wrap"><table class="data"><tbody>${rows}</tbody></table></div></div>`;
  }).join("");

  $("#compare-grid").innerHTML = summary + blocks;
}

function compareRow(label, va, vb) {
  return `<tr><td class="${va > vb ? "better" : ""}">${fmt(va)}</td><td class="num muted">${label}</td>
    <td class="num ${vb > va ? "better" : ""}">${fmt(vb)}</td></tr>`;
}

function comparePlayerRow(pa, pb) {
  const side = (p) => (p ? `${playerName(p)}${p.lineup_slot ? `<span class="tag start">${esc(p.lineup_slot)}</span>` : ""}` : "");
  return `<tr><td class="a">${side(pa)}</td><td class="num">${pa ? fmt(pa.value) : ""}</td>
    <td class="num">${pb ? fmt(pb.value) : ""}</td><td class="b">${side(pb)}</td></tr>`;
}

// --- Trade Analyzer ------------------------------------------------------------
function renderAnalyzer() {
  const me = teamById(state.myRosterId);
  const partner = teamById(state.partnerId);
  $("#sent-title").textContent = `Você envia — ${teamName(me)}`;
  $("#received-title").textContent = `Você recebe — ${teamName(partner)}`;
  renderPlayerList("#sent-list", me?.players ?? [], state.sent);
  renderPlayerList("#received-list", partner?.players ?? [], state.received);
}

function renderPlayerList(sel, players, selected) {
  $(sel).innerHTML =
    players
      .map(
        (p) => `<label class="player-row" data-name="${esc(p.name.toLowerCase())}">
          <input type="checkbox" value="${esc(p.id)}" ${selected.has(p.id) ? "checked" : ""}>
          ${posBadge(p.position)}<span>${playerName(p)}</span><span class="val">${fmt(p.value)}</span></label>`,
      )
      .join("") || `<p class="muted">Sem jogadores.</p>`;
}

let analyzeTimer;
function scheduleAnalyze() {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(runAnalyze, 250);
}

async function runAnalyze() {
  const box = $("#trade-result");
  if (!state.sent.size && !state.received.size) {
    box.hidden = true;
    return;
  }
  try {
    const result = await api.analyze(state.overview.league.league_id, {
      my_roster_id: state.myRosterId,
      partner_roster_id: state.partnerId,
      sent: [...state.sent],
      received: [...state.received],
    });
    box.innerHTML = renderTradeResult(result);
  } catch (err) {
    box.innerHTML = `<p class="neg-delta">${esc(err.message)}</p>`;
  }
  box.hidden = false;
}

function renderTradeResult(r) {
  const sideHtml = (title, side) => `<div>
      <h3>${title}</h3>
      <ul>${side.players.map((p) => `<li>${posBadge(p.position)} ${playerName(p)}<span class="v">${fmt(p.value)}</span></li>`).join("") || "<li class='muted'>Nada</li>"}</ul>
      <div class="total">${fmt(side.adjusted_total)}</div>
      <small>Soma bruta ${fmt(side.raw_total)} · ajustado por tamanho do pacote</small></div>`;

  // pct > 0: você ganha. Marcador vai para a direita; ±30% satura a barra.
  const marker = Math.min(100, Math.max(0, 50 + (r.balance_pct / 0.3) * 50));

  let impact = "";
  if (r.lineup_impact) {
    const row = (label, d) => `<tr><td>${label}</td><td class="num">${fmt(d.before)}</td><td class="num">${fmt(d.after)}</td>
      <td class="num ${deltaClass(d.delta)}">${signed(d.delta)}</td></tr>`;
    impact = `<div class="impact table-wrap"><table class="data"><thead><tr><th>Impacto no lineup titular</th>
      <th class="num">Antes</th><th class="num">Depois</th><th class="num">Δ</th></tr></thead><tbody>
      ${row(esc(teamName(teamById(state.myRosterId))), r.lineup_impact.me)}
      ${r.lineup_impact.partner ? row(esc(teamName(teamById(state.partnerId))), r.lineup_impact.partner) : ""}
      </tbody></table></div>`;
  }

  return `<div class="verdict ${r.verdict.code}">${esc(r.verdict.label)}
      <small>(${signed(r.balance)} · ${pctFmt(r.balance_pct)})</small></div>
    <div class="sides">${sideHtml("Você envia", r.sent)}${sideHtml("Você recebe", r.received)}</div>
    <div class="balance-bar"><div class="marker" style="left:${marker}%"></div></div>
    <div class="balance-legend"><span>Parceiro vence</span><span>Justa</span><span>Você vence</span></div>
    ${impact}
    <div class="trade-actions">
      <button type="button" id="share-trade">📤 Compartilhar troca</button>
      <a class="button-link ghost" href="https://sleeper.com/leagues/${esc(state.overview.league.league_id)}" target="_blank" rel="noopener">Propor no Sleeper ↗</a>
    </div>
    <small class="muted">O Sleeper não permite abrir uma troca já montada: no app, entre em Trades e escolha os mesmos jogadores.</small>`;
}

// --- Link da troca ----------------------------------------------------------------
// O link guarda liga, times e jogadores; quem abre vê a mesma troca já analisada.
function tradeLink() {
  const q = new URLSearchParams({
    liga: state.overview.league.league_id,
    de: state.myRosterId,
    para: state.partnerId,
    envia: [...state.sent].join(","),
    recebe: [...state.received].join(","),
  });
  return `${location.origin}${location.pathname}?${q}`;
}

async function shareTrade() {
  const me = teamById(state.myRosterId);
  const partner = teamById(state.partnerId);
  const names = (t, ids) => t.players.filter((p) => ids.has(p.id)).map((p) => p.name).join(", ") || "nada";
  const text = `Proposta de troca (${state.overview.league.name})\n` +
    `${teamName(me)} envia: ${names(me, state.sent)}\n${teamName(partner)} envia: ${names(partner, state.received)}\nVeja a análise:`;
  const url = tradeLink();

  // No celular abre o menu de compartilhar (WhatsApp etc.); no computador copia o link.
  if (navigator.share) {
    try {
      await navigator.share({ title: "Proposta de troca", text, url });
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    setStatus("Troca copiada. Cole no grupo da liga.");
  } catch {
    window.prompt("Copie o link da troca:", url);
  }
}

async function openTradeLink() {
  const q = new URLSearchParams(location.search);
  const leagueId = q.get("liga");
  if (!leagueId) return;
  history.replaceState(null, "", location.pathname);
  const ids = (k) => (q.get(k) || "").split(",").filter(Boolean);
  let from = Number(q.get("de"));
  let to = Number(q.get("para"));
  let sent = ids("envia");
  let received = ids("recebe");

  // Se o usuário já usou o app neste aparelho, abre com as ligas dele (e descobre qual é o time dele).
  const username = store.get("fta.username");
  const data = username ? await api.leagues(username, "").catch(() => null) : null;
  if (data) state.user = data.user;
  $("#league-select").innerHTML = (data?.leagues ?? [])
    .map((l) => `<option value="${esc(l.league_id)}">${esc(l.name)} (${l.total_rosters} times)</option>`)
    .join("");
  $("#league-bar").hidden = false;

  state.tab = "analyzer";
  await loadLeague(leagueId);
  const ov = state.overview;
  if (ov?.league.league_id !== leagueId) return;
  if (![...$("#league-select").options].some((o) => o.value === leagueId)) {
    $("#league-select").insertAdjacentHTML("beforeend", `<option value="${esc(leagueId)}">${esc(ov.league.name)} (${ov.league.total_rosters} times)</option>`);
  }
  $("#league-select").value = leagueId;
  if (!teamById(from) || !teamById(to) || from === to) {
    setStatus("Esse link de troca não confere com os times da liga.", "error");
    return;
  }

  // Quem recebeu a proposta vê do próprio lado: "Você envia" passa a ser o que ele manda.
  if (state.user && to === state.myRosterId) {
    [from, to, sent, received] = [to, from, received, sent];
  }
  state.partnerId = to;
  setMyTeam(from);
  const owned = (rid, list) => list.filter((pid) => teamById(rid).players.some((p) => p.id === pid));
  state.sent = new Set(owned(from, sent));
  state.received = new Set(owned(to, received));
  renderAnalyzer();
  showTab("analyzer");
  await runAnalyze();
  const missing = sent.length + received.length - state.sent.size - state.received.size;
  setStatus(missing
    ? `Troca aberta pelo link. ${missing} jogador(es) já não estão mais nesses times e ficaram de fora.`
    : `Troca aberta pelo link: ${teamName(teamById(from))} ↔ ${teamName(teamById(to))}.`);
}

// --- Trade Finder ---------------------------------------------------------------
async function runFinder() {
  const leagueId = state.overview.league.league_id;
  const pos = $("#finder-pos").value;
  const data = await withStatus("Escaneando elencos adversários...", () =>
    api.finder(leagueId, state.myRosterId, $("#tolerance").value, pos ? [pos] : null),
  );
  if (!data || state.overview.league.league_id !== leagueId) return;

  const chips = (list, cls) => list.map((p) => `<span class="rank ${cls}">${p}</span>`).join(" ");
  $("#finder-summary").innerHTML = pos
    ? `<div class="chips"><strong>Procurando:</strong> ${posBadge(pos)} <small>trocas que melhoram seu titular nessa posição</small></div>`
    : `<div class="chips"><strong>Seu elenco:</strong>
    escassez ${chips(data.my_needs, "need")} · excesso ${chips(data.my_surplus, "surplus")}</div>`;
  renderSuggestions(data.suggestions, pos
    ? `Nenhuma troca por ${pos} que melhore seu titular com essa tolerância. Tente 25%.`
    : "Nenhuma troca viável encontrada com essa tolerância. Tente 25%.");
}

// --- Oferecer meus jogadores: marca até MAX_TARGETS do seu time -------------------
function renderOfferPicker() {
  const me = teamById(state.myRosterId);
  const players = (me?.players ?? []).filter((p) => p.value > 0);
  const full = state.offer.size >= MAX_TARGETS;
  $("#offer-list").innerHTML =
    players
      .map((p) => {
        const checked = state.offer.has(p.id);
        return `<label class="player-row" data-name="${esc(p.name.toLowerCase())}">
          <input type="checkbox" value="${esc(p.id)}" ${checked ? "checked" : ""} ${full && !checked ? "disabled" : ""}>
          ${posBadge(p.position)}<span>${playerName(p)}</span><span class="val">${fmt(p.value)}</span></label>`;
      })
      .join("") || `<p class="muted">Seu time não tem jogadores com valor de mercado.</p>`;
  filterOfferList();

  const chosen = players.filter((p) => state.offer.has(p.id));
  $("#offer-chips").innerHTML = chosen.length
    ? chosen.map((p) => `<span class="target-chip">${esc(p.name)}<button type="button" data-remove="${esc(p.id)}" aria-label="Remover ${esc(p.name)}">×</button></span>`).join("") +
      `<small>${chosen.length}/${MAX_TARGETS} · valor somado ${fmt(chosen.reduce((s, p) => s + p.value, 0))}</small>`
    : `<small class="muted">Nenhum jogador marcado.</small>`;
}

function filterOfferList() {
  const q = $("#offer-filter").value.trim().toLowerCase();
  document.querySelectorAll("#offer-list .player-row").forEach((row) => {
    row.hidden = q && !row.dataset.name.includes(q);
  });
}

function toggleOffer(pid, on) {
  if (on && state.offer.size < MAX_TARGETS) state.offer.add(pid);
  else state.offer.delete(pid);
  renderOfferPicker();
}

async function runOfferFinder() {
  if (!state.offer.size) {
    setStatus("Marque pelo menos um jogador do seu time.", "error");
    return;
  }
  const leagueId = state.overview.league.league_id;
  const pos = $("#offer-pos").value;
  const data = await withStatus("Procurando o que dá para receber...", () =>
    api.finderOffer(leagueId, state.myRosterId, [...state.offer], $("#tolerance").value, pos ? [pos] : null),
  );
  if (!data || state.overview.league.league_id !== leagueId) return;

  const names = data.offer.map((p) => `${posBadge(p.position)} ${playerName(p)}`).join(", ");
  $("#finder-summary").innerHTML = `<div class="chips"><strong>Você oferece:</strong> ${names}
    ${pos ? `<small>recebendo ${pos}</small>` : ""}</div>`;
  renderSuggestions(data.suggestions, "Nenhum time tem um pacote de valor parecido com essa tolerância. Tente 25%.");
}

// --- Buscar alvos: escolhe o time, depois marca até MAX_TARGETS jogadores ----------
const MAX_TARGETS = 3;

function setTargetTeam(rosterId) {
  state.targetTeamId = rosterId;
  state.targets = new Set();
  $("#target-team").value = String(rosterId);
  renderTargetPicker();
}

function renderTargetPicker() {
  const t = teamById(state.targetTeamId);
  const players = (t?.players ?? []).filter((p) => p.value > 0);
  const full = state.targets.size >= MAX_TARGETS;
  $("#target-list").innerHTML =
    players
      .map((p) => {
        const checked = state.targets.has(p.id);
        return `<label class="player-row">
          <input type="checkbox" value="${esc(p.id)}" ${checked ? "checked" : ""} ${full && !checked ? "disabled" : ""}>
          ${posBadge(p.position)}<span>${playerName(p)}</span><span class="val">${fmt(p.value)}</span></label>`;
      })
      .join("") || `<p class="muted">Esse time não tem jogadores com valor de mercado.</p>`;

  const chosen = players.filter((p) => state.targets.has(p.id));
  $("#target-chips").innerHTML = chosen.length
    ? chosen.map((p) => `<span class="target-chip">${esc(p.name)}<button type="button" data-remove="${esc(p.id)}" aria-label="Remover ${esc(p.name)}">×</button></span>`).join("") +
      `<small>${chosen.length}/${MAX_TARGETS} · valor somado ${fmt(chosen.reduce((s, p) => s + p.value, 0))}</small>`
    : `<small class="muted">Nenhum jogador marcado.</small>`;
}

function toggleTarget(pid, on) {
  if (on && state.targets.size < MAX_TARGETS) state.targets.add(pid);
  else state.targets.delete(pid);
  renderTargetPicker();
}

async function runTargetFinder() {
  if (!state.targets.size) {
    setStatus("Marque pelo menos um jogador do time escolhido.", "error");
    return;
  }
  const leagueId = state.overview.league.league_id;
  const data = await withStatus("Montando propostas...", () =>
    api.finderTargets(leagueId, state.myRosterId, [...state.targets], $("#tolerance").value),
  );
  if (!data || state.overview.league.league_id !== leagueId) return;

  const names = data.targets.map((t) => `${posBadge(t.position)} ${playerName(t)}`).join(", ");
  $("#finder-summary").innerHTML = `<div class="chips"><strong>Alvos:</strong> ${names}
    <small>dono: ${esc(teamName(data.partner))}</small></div>`;

  state.suggestions = [...data.fair, ...data.likely];
  const tol = Math.round(Number($("#tolerance").value) * 100);
  $("#finder-results").innerHTML = `
    <h3 class="section-title">⚖️ Pacotes justos</h3>
    <p class="muted list-note">Diferença de valor de até 5% para qualquer lado.</p>
    ${data.fair.length ? suggestionTable(data.fair, 0) : `<p class="muted">Nenhum pacote do seu elenco fica dentro de ±5%.</p>`}
    <h3 class="section-title">🤝 Mais prováveis de aceitar</h3>
    <p class="muted list-note">O outro dono sai ganhando. Você paga no máximo ${tol}% a mais (mude em "Tolerância de valor").</p>
    ${data.likely.length ? suggestionTable(data.likely, data.fair.length, { chance: true }) : `<p class="muted">Nenhum pacote em que ele saia ganhando dentro dessa tolerância. Tente 25%.</p>`}`;
}

function renderSuggestions(suggestions, emptyMessage) {
  state.suggestions = suggestions;
  $("#finder-results").innerHTML = suggestions.length ? suggestionTable(suggestions, 0) : `<p class="muted">${esc(emptyMessage)}</p>`;
}

// offset: posição da primeira linha em state.suggestions (para o botão Analisar).
function suggestionTable(suggestions, offset, { chance = false } = {}) {
  const list = (players) =>
    `<div class="suggestion-players">${players.map((p) => `<span>${posBadge(p.position)} ${playerName(p)} <small>${fmt(p.value)}</small></span>`).join("")}</div>`;
  const chanceCell = (s) => `<td><span class="chance ${s.chance}">${s.chance === "alta" ? "Alta" : "Média"}</span><br>
      <small>${s.overpay > 0 ? `você paga +${fmt(s.overpay)}` : `você ganha ${fmt(-s.overpay)}`}</small></td>`;
  const rows = suggestions
    .map(
      (s, i) => `<tr>
        <td><strong>${esc(teamName(s.partner))}</strong></td>
        ${chance ? chanceCell(s) : ""}
        <td>${list(s.give)}</td>
        <td>${list(s.get)}</td>
        <td class="num">${fmt(s.sent_value)} → ${fmt(s.received_value)}<br><small>${pctFmt(s.balance_pct)}</small></td>
        <td class="num"><span class="${deltaClass(s.my_lineup_gain)}">${signed(s.my_lineup_gain)}</span>
          / <span class="${deltaClass(s.their_lineup_gain)}">${signed(s.their_lineup_gain)}</span></td>
        <td class="reason">${esc(s.reason)}</td>
        <td><button type="button" class="ghost" data-open="${offset + i}">Analisar</button></td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table class="data"><thead><tr>
      <th>Parceiro</th>${chance ? "<th>Chance de aceite</th>" : ""}<th>Você envia</th><th>Você recebe</th><th class="num">Valor</th>
      <th class="num">Ganho titular (você / ele)</th><th>Motivo</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// --- Radar de waivers -------------------------------------------------------------
async function loadWaivers(force = false) {
  const leagueId = state.overview.league.league_id;
  const key = `${leagueId}:${state.myRosterId}`;
  if (!force && state.waiversKey === key) return;
  state.waiversKey = key;

  const data = await withStatus("Procurando jogadores livres na sua liga...", () => api.waivers(leagueId, state.myRosterId));
  if (!data) {
    state.waiversKey = null;
    return;
  }
  if (state.waiversKey !== key) return; // trocou de liga/time no meio
  state.waivers = data;
  renderWaivers();
}

// Filtro de posição: "need" = suas posições em escassez, "all" = todas, ou uma posição.
function renderWaivers() {
  const data = state.waivers;
  if (!data) return;
  const leagueId = state.overview.league.league_id;
  // K/DEF só aparecem se a liga tem essas vagas no titular.
  const streamPos = Object.keys(data.streamers?.positions ?? {});
  document.querySelectorAll("#waivers-pos button").forEach((b) => {
    if (STREAM.includes(b.dataset.pos)) b.hidden = !streamPos.includes(b.dataset.pos);
  });
  let filter = state.waiversPos || "need";
  if (STREAM.includes(filter) && !streamPos.includes(filter)) filter = "need";
  document.querySelectorAll("#waivers-pos button").forEach((b) => b.classList.toggle("active", b.dataset.pos === filter));
  const isStream = STREAM.includes(filter);
  const shownPos = filter === "need" ? data.needs : filter === "all" ? CORE : isStream ? [] : [filter];
  const shownStream = filter === "all" ? streamPos : isStream ? [filter] : [];
  $("#waivers-trending-title").hidden = isStream;
  $("#waivers-trending").hidden = isStream;
  $("#waivers-best-title").textContent =
    filter === "need" ? "Melhores livres nas suas posições em escassez" : filter === "all" ? "Melhores livres por posição" : `Melhores ${filter} livres`;
  $("#waivers-best-title").hidden = isStream;

  const chips = data.needs.map((p) => `<span class="rank need">${p}</span>`).join(" ");
  $("#waivers-summary").innerHTML = `<div class="chips"><strong>Suas posições em escassez:</strong> ${chips}
    <small>Os destacados preenchem essas posições.</small></div>`;

  // O Sleeper não tem página pública por jogador: copiamos o nome e abrimos a liga (no celular abre o app).
  const sleeperLink = (p) =>
    `<a class="sleeper-link" href="https://sleeper.com/leagues/${esc(leagueId)}" target="_blank" rel="noopener" data-copy="${esc(p.name)}">Sleeper ↗</a>`;
  const row = (p, extra) => `<tr class="${p.fills_need ? "mine" : ""}">
      <td>${posBadge(p.position)} ${playerName(p)}${p.fills_need ? `<span class="tag need">escassez</span>` : ""} ${sleeperLink(p)}</td>
      ${extra}
      <td class="num">${fmt(p.value)}</td>
      <td>${p.upgrade ? `${esc(p.upgrade.name)} <span class="pos-delta">${signed(p.upgrade.gain)}</span>` : `<span class="muted">—</span>`}</td>
      <td class="num ${deltaClass(p.lineup_gain)}">${p.lineup_gain > 0 ? signed(p.lineup_gain) : "—"}</td></tr>`;
  const table = (head, body) => `<div class="table-wrap"><table class="data"><thead><tr>${head}
      <th class="num">Valor</th><th>Substitui no seu elenco</th><th class="num">Ganho no titular</th></tr></thead><tbody>${body}</tbody></table></div>`;

  // Em alta: "Minhas escassez" mostra todos (os de escassez já vêm destacados); uma posição filtra.
  const trending = filter === "need" || filter === "all" ? data.trending : data.trending.filter((p) => p.position === filter);
  $("#waivers-trending").innerHTML = trending.length
    ? table(`<th>Jogador</th><th class="num">Adições 24h</th>`,
        trending.map((p) => row(p, `<td class="num">${fmt(p.adds)}</td>`)).join(""))
    : `<p class="muted">Nenhum dos jogadores em alta${filter === "need" || filter === "all" ? "" : ` de ${filter}`} está livre na sua liga.</p>`;

  const best = shownPos
    .map((pos) => [pos, data.best_available[pos] ?? []])
    .map(([pos, players]) => players.length
      ? `<h4>${posBadge(pos)} ${pos}</h4>${table("<th>Jogador</th>", players.map((p) => row(p, "")).join(""))}`
      : `<p class="muted">${pos}: nenhum jogador livre com valor de mercado.</p>`)
    .join("");
  const stream = shownStream.map((pos) => streamerBlock(pos, data.streamers, sleeperLink)).join("");
  $("#waivers-best").innerHTML = best + stream || `<p class="muted">Você não tem posições em escassez.</p>`;
}

// K e DEF: projeção de pontos desta semana, comparada com o seu melhor jogador da posição.
function streamerBlock(pos, streamers, sleeperLink) {
  const info = streamers.positions[pos];
  const head = `<h4>${posBadge(pos)} ${pos} <small class="muted">projeção da semana${streamers.week ? ` ${streamers.week}` : ""}</small></h4>`;
  if (!info) return `${head}<p class="muted">Não deu para buscar as projeções do Sleeper agora. Tente "Atualizar radar".</p>`;
  const vs = (p) => (p.opponent ? `vs ${esc(p.opponent)}` : `<span class="muted">bye</span>`);
  const current = info.current
    ? `<p class="muted list-note">Seu ${pos}: <strong>${playerName(info.current)}</strong> · ${vs(info.current)} · ${info.current.projection.toFixed(1)} pts</p>`
    : `<p class="muted list-note">Você não tem ${pos} no elenco.</p>`;
  if (!info.free.length) return `${head}${current}<p class="muted">Nenhum ${pos} livre com projeção nesta semana.</p>`;
  const rows = info.free
    .map((p) => `<tr class="${p.gain > 0 ? "mine" : ""}">
      <td>${posBadge(p.position)} ${playerName(p)} ${sleeperLink(p)}</td>
      <td>${vs(p)}</td>
      <td class="num">${p.projection.toFixed(1)}</td>
      <td class="num ${deltaClass(p.gain)}">${p.gain > 0 ? "+" : ""}${p.gain.toFixed(1)}</td></tr>`)
    .join("");
  return `${head}${current}<div class="table-wrap"><table class="data"><thead><tr><th>Jogador</th><th>Jogo</th>
    <th class="num">Pontos projetados</th><th class="num">vs seu ${pos}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function openSuggestion(index) {
  const s = state.suggestions[index];
  state.partnerId = s.partner.roster_id;
  $("#partner-select").value = String(s.partner.roster_id);
  state.sent = new Set(s.give.map((p) => p.id));
  state.received = new Set(s.get.map((p) => p.id));
  renderAnalyzer();
  showTab("analyzer");
  runAnalyze();
}

// --- Eventos ----------------------------------------------------------------------
function bindEvents() {
  $("#connect-form").addEventListener("submit", connect);
  $("#league-select").addEventListener("change", (e) => loadLeague(e.target.value));
  $("#refresh-btn").addEventListener("click", () => loadLeague($("#league-select").value, true));
  $("#my-team-select").addEventListener("change", (e) => setMyTeam(+e.target.value));
  $("#tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (btn) showTab(btn.dataset.tab);
  });
  $("#cmp-a").addEventListener("change", renderCompare);
  $("#cmp-b").addEventListener("change", renderCompare);

  $("#partner-select").addEventListener("change", (e) => {
    state.partnerId = +e.target.value;
    state.received.clear();
    renderAnalyzer();
    scheduleAnalyze();
  });
  $("#trade-form").addEventListener("submit", (e) => {
    e.preventDefault();
    runAnalyze();
  });
  $("#trade-form").addEventListener("change", (e) => {
    if (e.target.type !== "checkbox") return;
    const side = e.target.closest(".player-list").dataset.side;
    const set = side === "sent" ? state.sent : state.received;
    e.target.checked ? set.add(e.target.value) : set.delete(e.target.value);
    scheduleAnalyze();
  });
  $("#clear-trade").addEventListener("click", () => {
    state.sent.clear();
    state.received.clear();
    renderAnalyzer();
    $("#trade-result").hidden = true;
  });
  document.querySelectorAll(".filter").forEach((input) =>
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      document.querySelectorAll(`#${input.dataset.list} .player-row`).forEach((row) => {
        row.hidden = q && !row.dataset.name.includes(q);
      });
    }),
  );

  $("#finder-btn").addEventListener("click", runFinder);
  $("#target-btn").addEventListener("click", runTargetFinder);
  $("#target-team").addEventListener("change", (e) => setTargetTeam(+e.target.value));
  $("#target-list").addEventListener("change", (e) => {
    if (e.target.type === "checkbox") toggleTarget(e.target.value, e.target.checked);
  });
  $("#target-chips").addEventListener("click", (e) => {
    const pid = e.target.dataset.remove;
    if (pid) toggleTarget(pid, false);
  });
  $("#offer-btn").addEventListener("click", runOfferFinder);
  $("#offer-list").addEventListener("change", (e) => {
    if (e.target.type === "checkbox") toggleOffer(e.target.value, e.target.checked);
  });
  $("#offer-chips").addEventListener("click", (e) => {
    const pid = e.target.dataset.remove;
    if (pid) toggleOffer(pid, false);
  });
  $("#waivers-btn").addEventListener("click", () => loadWaivers(true));
  $("#waivers-pos").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-pos]");
    if (!btn) return;
    state.waiversPos = btn.dataset.pos;
    store.set("fta.waiversPos", state.waiversPos);
    renderWaivers();
  });
  $("#tab-waivers").addEventListener("click", (e) => {
    const link = e.target.closest(".sleeper-link");
    if (!link) return;
    const name = link.dataset.copy;
    navigator.clipboard?.writeText(name).then(
      () => setStatus(`"${name}" copiado. Cole na busca de jogadores do Sleeper.`),
      () => setStatus(`Procure "${name}" na busca de jogadores do Sleeper.`),
    );
  });
  $("#trade-result").addEventListener("click", (e) => {
    if (e.target.closest("#share-trade")) shareTrade();
  });
  $("#finder-results").addEventListener("click", (e) => {
    const idx = e.target.dataset.open;
    if (idx !== undefined) openSuggestion(+idx);
  });
}

bindEvents();
const savedUser = store.get("fta.username");
if (savedUser) $("#username").value = savedUser;
state.waiversPos = store.get("fta.waiversPos") || "need";
openTradeLink();

// Tema: Claro -> Escuro -> Automático (segue o sistema). Fica salvo no aparelho.
const THEMES = [
  { id: "light", label: "☀️ Claro", bar: "#0b1324", scheme: "only light" },
  { id: "dark", label: "🌙 Escuro", bar: "#050a16", scheme: "only dark" },
  { id: "auto", label: "🌗 Automático", bar: "#0b1324", scheme: "light dark" },
];

function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) || THEMES[0];
  document.documentElement.setAttribute("data-theme", theme.id);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme.scheme);
  $("#theme-btn").textContent = theme.label;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.bar);
  store.set("fta.theme", theme.id);
}

$("#theme-btn").addEventListener("click", () => {
  const current = THEMES.findIndex((t) => t.id === document.documentElement.getAttribute("data-theme"));
  applyTheme(THEMES[(current + 1) % THEMES.length].id);
});
applyTheme(document.documentElement.getAttribute("data-theme"));

// Torna o site instalável como app no celular (PWA).
if ("serviceWorker" in navigator) {
  // updateViaCache: "none" faz o celular buscar o sw.js novo sempre, sem esperar o cache.
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => { /* segue funcionando como site comum */ });
}
