// Motor de análise (porte do backend Python): lineup ótimo, mercado por posição,
// Trade Analyzer e Trade Finder. Tudo roda no navegador.
import { leagueProfile } from "./values.js";

export const CORE_POSITIONS = ["QB", "RB", "WR", "TE"];

export const SLOT_ELIGIBILITY = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K"],
  DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};

const AVATAR_URL = "https://sleepercdn.com/avatars/thumbs/";
const r1 = (x) => Math.round(x * 10) / 10;

// --- Lineup ------------------------------------------------------------------

// Remove BN, IR, TAXI e slots IDP não suportados.
export function starterSlots(rosterPositions) {
  return rosterPositions.filter((slot) => slot in SLOT_ELIGIBILITY);
}

// Preenche os slots mais restritivos primeiro com o jogador de maior valor elegível.
export function optimalLineup(playerIds, slots, positions, values) {
  const pool = playerIds.filter((pid) => positions[pid]).sort((a, b) => (values[b] || 0) - (values[a] || 0));
  const used = new Set();
  const lineup = new Array(slots.length);
  const order = slots.map((_, i) => i).sort((a, b) => SLOT_ELIGIBILITY[slots[a]].length - SLOT_ELIGIBILITY[slots[b]].length);
  for (const i of order) {
    const eligible = SLOT_ELIGIBILITY[slots[i]];
    const pick = pool.find((pid) => !used.has(pid) && eligible.includes(positions[pid])) ?? null;
    if (pick) used.add(pick);
    lineup[i] = { slot: slots[i], player_id: pick, value: pick ? values[pick] || 0 : 0 };
  }
  return { total: lineup.reduce((sum, e) => sum + e.value, 0), lineup };
}

// --- Contexto da liga --------------------------------------------------------

export class LeagueContext {
  constructor({ league, users, rosters, players, values, valueSource }) {
    Object.assign(this, { league, users, rosters, players, values, valueSource });
    this.loadedAt = Date.now();
    this.slots = starterSlots(league.roster_positions || []);
    this.profile = leagueProfile(league);
    this.positions = Object.fromEntries(Object.entries(players).map(([pid, p]) => [pid, p.position]));
    this.rostersById = new Map(rosters.map((r) => [r.roster_id, r]));
  }

  rosterPlayerIds(rosterId) {
    const roster = this.rostersById.get(rosterId);
    if (!roster) throw new Error(`roster_id ${rosterId} não existe nesta liga`);
    return [...(roster.players || [])];
  }

  lineup(playerIds) {
    return optimalLineup(playerIds, this.slots, this.positions, this.values);
  }

  playerCard(pid) {
    const p = this.players[pid] || {};
    const name = p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim() || pid;
    return {
      id: pid,
      name,
      position: p.position ?? null,
      team: p.team ?? null,
      age: p.age ?? null,
      injury_status: p.injury_status ?? null,
      value: r1(this.values[pid] || 0),
    };
  }

  teamMeta(rosterId) {
    const roster = this.rostersById.get(rosterId);
    const ownerId = roster.owner_id;
    const user = this.users[ownerId] || {};
    return {
      roster_id: rosterId,
      owner_id: ownerId,
      co_owners: roster.co_owners || [],
      display_name: user.display_name || `Time ${rosterId}`,
      team_name: user.metadata?.team_name || null,
      avatar: user.avatar ? AVATAR_URL + user.avatar : null,
    };
  }
}

// --- Mercado: escassez x excesso por posição --------------------------------

const NEED_BELOW = 90; //      índice de força < 90% da média da liga  -> escassez
const SURPLUS_ABOVE = 115; //  índice de força >= 115% da média          -> excesso
const DEPTH_SURPLUS = 130; //  ou banco >= 130% da profundidade média    -> excesso
const DEPTH_SIZE = 2; //       nº de reservas considerados na profundidade

// Quantos titulares cada posição ocupa, repartindo os FLEX entre as elegíveis.
export function positionDemand(slots) {
  const demand = Object.fromEntries(CORE_POSITIONS.map((p) => [p, 0]));
  for (const slot of slots) {
    if (slot === "SUPER_FLEX") {
      demand.QB += 1; // na prática é ocupado por QB
      continue;
    }
    const eligible = CORE_POSITIONS.filter((p) => SLOT_ELIGIBILITY[slot].includes(p));
    for (const p of eligible) demand[p] += 1 / eligible.length;
  }
  return demand;
}

export function analyzePositions(ctx) {
  const demand = positionDemand(ctx.slots);
  const stats = {};

  for (const roster of ctx.rosters) {
    const rid = roster.roster_id;
    const byPos = Object.fromEntries(CORE_POSITIONS.map((p) => [p, []]));
    for (const pid of ctx.rosterPlayerIds(rid)) {
      const pos = ctx.positions[pid];
      if (byPos[pos]) byPos[pos].push(ctx.values[pid] || 0);
    }
    stats[rid] = {};
    for (const [pos, vals] of Object.entries(byPos)) {
      vals.sort((a, b) => b - a);
      const n = Math.max(1, Math.round(demand[pos]));
      const sum = (arr) => arr.reduce((s, v) => s + v, 0);
      stats[rid][pos] = {
        starters: n,
        count: vals.length,
        strength: r1(sum(vals.slice(0, n))),
        depth: r1(sum(vals.slice(n, n + DEPTH_SIZE))),
      };
    }
  }

  const teams = Object.keys(stats);
  for (const pos of CORE_POSITIONS) {
    const meanStrength = teams.reduce((s, r) => s + stats[r][pos].strength, 0) / teams.length || 1;
    const meanDepth = teams.reduce((s, r) => s + stats[r][pos].depth, 0) / teams.length || 1;
    const ranking = [...teams].sort((a, b) => stats[b][pos].strength - stats[a][pos].strength);
    ranking.forEach((rid, i) => {
      const s = stats[rid][pos];
      s.rank = i + 1;
      s.strength_index = Math.round((100 * s.strength) / meanStrength);
      s.depth_index = Math.round((100 * s.depth) / meanDepth);
      if (s.strength_index < NEED_BELOW) s.status = "need";
      else if (s.strength_index >= SURPLUS_ABOVE || s.depth_index >= DEPTH_SURPLUS) s.status = "surplus";
      else s.status = "balanced";
    });
  }
  return stats;
}

// --- Trade Analyzer ----------------------------------------------------------

// Pacotes com mais jogadores valem menos que a soma (o "craque" vale mais que 2 peças médias):
// cada jogador adicional do pacote, em ordem de valor, pesa DECAY^i (mínimo MIN_WEIGHT).
const DECAY = 0.85;
const MIN_WEIGHT = 0.4;
const FAIR_PCT = 0.05;
const SLIGHT_PCT = 0.15;

export function packageValue(values) {
  return [...values].sort((a, b) => b - a).reduce((s, v, i) => s + v * Math.max(MIN_WEIGHT, DECAY ** i), 0);
}

// pct > 0 significa que você recebe mais valor do que envia.
export function verdict(pct) {
  const side = pct > 0 ? "você" : "o parceiro";
  if (Math.abs(pct) <= FAIR_PCT) return { code: "fair", label: "Troca justa" };
  if (Math.abs(pct) <= SLIGHT_PCT) return { code: pct > 0 ? "slight_win" : "slight_loss", label: `Levemente favorável para ${side}` };
  return { code: pct > 0 ? "win" : "loss", label: `Muito favorável para ${side}` };
}

export function lineupDelta(ctx, rosterId, remove, add) {
  const beforeIds = ctx.rosterPlayerIds(rosterId);
  const removed = new Set(remove);
  const afterIds = beforeIds.filter((p) => !removed.has(p)).concat(add.filter((p) => !beforeIds.includes(p)));
  const before = ctx.lineup(beforeIds).total;
  const after = ctx.lineup(afterIds).total;
  return { before: r1(before), after: r1(after), delta: r1(after - before) };
}

function side(ctx, ids) {
  const cards = ids.map((pid) => ctx.playerCard(pid));
  return {
    players: cards,
    raw_total: r1(cards.reduce((s, c) => s + c.value, 0)),
    adjusted_total: r1(packageValue(cards.map((c) => c.value))),
  };
}

export function analyzeTrade(ctx, sent, received, myRosterId = null, partnerRosterId = null) {
  if (!sent.length && !received.length) throw new Error("Informe ao menos um jogador enviado ou recebido.");
  if (sent.some((p) => received.includes(p))) throw new Error("O mesmo jogador não pode estar dos dois lados da troca.");
  if (myRosterId != null) {
    const mine = new Set(ctx.rosterPlayerIds(myRosterId));
    if (sent.some((p) => !mine.has(p))) throw new Error("Há jogadores enviados que não estão no seu elenco.");
  }
  if (partnerRosterId != null) {
    const theirs = new Set(ctx.rosterPlayerIds(partnerRosterId));
    if (received.some((p) => !theirs.has(p))) throw new Error("Há jogadores recebidos que não estão no elenco do parceiro.");
  }

  const sentSide = side(ctx, sent);
  const receivedSide = side(ctx, received);
  const balance = receivedSide.adjusted_total - sentSide.adjusted_total;
  const pct = balance / Math.max(sentSide.adjusted_total, receivedSide.adjusted_total, 1);

  const result = {
    sent: sentSide,
    received: receivedSide,
    balance: r1(balance),
    balance_pct: Math.round(pct * 10000) / 10000,
    verdict: verdict(pct),
    lineup_impact: null,
  };
  if (myRosterId != null) {
    result.lineup_impact = { me: lineupDelta(ctx, myRosterId, sent, received) };
    if (partnerRosterId != null) result.lineup_impact.partner = lineupDelta(ctx, partnerRosterId, received, sent);
  }
  return result;
}

// --- Trade Finder ------------------------------------------------------------
// 1. Classifica cada posição de cada time (escassez / equilíbrio / excesso).
// 2. Para cada adversário, oferece jogadores das posições onde você sobra (ou onde ele precisa)
//    em troca de jogadores das posições onde você precisa.
// 3. Testa pacotes 1x1, 2x1 e 1x2 e mantém só os que respeitam a tolerância de valor,
//    melhoram o SEU lineup titular e não pioram o do adversário.

const PACKAGE_SHAPES = [[1, 1], [2, 1], [1, 2]];

function combinations(arr, k, start = 0) {
  if (k === 0) return [[]];
  const out = [];
  for (let i = start; i <= arr.length - k; i++) {
    for (const rest of combinations(arr, k - 1, i + 1)) out.push([arr[i], ...rest]);
  }
  return out;
}

function topPlayers(ctx, ids, positions, limit) {
  return ids
    .filter((pid) => positions.has(ctx.positions[pid]) && (ctx.values[pid] || 0) > 0)
    .sort((a, b) => ctx.values[b] - ctx.values[a])
    .slice(0, limit);
}

function needsAndSurplus(team) {
  let needs = CORE_POSITIONS.filter((p) => team[p].status === "need");
  if (!needs.length) needs = [CORE_POSITIONS.reduce((a, b) => (team[b].rank > team[a].rank ? b : a))];
  let surplus = CORE_POSITIONS.filter((p) => team[p].status === "surplus" && !needs.includes(p));
  if (!surplus.length) {
    const rest = CORE_POSITIONS.filter((p) => !needs.includes(p));
    surplus = [rest.reduce((a, b) => (team[b].rank < team[a].rank ? b : a))];
  }
  return [needs, surplus];
}

// wantPositions: em vez das suas posições em escassez, procura só jogadores dessas posições.
export function findTrades(ctx, myRosterId, { tolerance = 0.15, poolSize = 6, perPartner = 3, maxResults = 25, wantPositions = null } = {}) {
  const analysis = analyzePositions(ctx);
  let [myNeeds, mySurplus] = needsAndSurplus(analysis[myRosterId]);
  if (wantPositions?.length) {
    myNeeds = wantPositions;
    mySurplus = CORE_POSITIONS.filter((p) => !wantPositions.includes(p));
    poolSize = Math.max(poolSize, 10); // uma posição só: dá para olhar mais nomes de cada lado
  }
  const myIds = ctx.rosterPlayerIds(myRosterId);
  const myBefore = ctx.lineup(myIds).total;
  const value = (pid) => ctx.values[pid];

  const suggestions = [];
  for (const roster of ctx.rosters) {
    const rid = roster.roster_id;
    if (rid === myRosterId) continue;
    const theirs = analysis[rid];
    const theirIds = ctx.rosterPlayerIds(rid);
    const theirBefore = ctx.lineup(theirIds).total;
    const theirNeeds = new Set(CORE_POSITIONS.filter((p) => theirs[p].status === "need"));

    const offerPositions = new Set([...mySurplus, ...[...theirNeeds].filter((p) => !myNeeds.includes(p))]);
    const givePool = topPlayers(ctx, myIds, offerPositions, poolSize);
    const getPool = topPlayers(ctx, theirIds, new Set(myNeeds), poolSize);
    if (!givePool.length || !getPool.length) continue;

    const found = [];
    for (const [giveN, getN] of PACKAGE_SHAPES) {
      for (const give of combinations(givePool, giveN)) {
        const sentAdj = packageValue(give.map(value));
        for (const get of combinations(getPool, getN)) {
          const recvAdj = packageValue(get.map(value));
          const pct = (recvAdj - sentAdj) / Math.max(sentAdj, recvAdj);
          if (Math.abs(pct) > tolerance) continue;

          const myGain = ctx.lineup(myIds.filter((p) => !give.includes(p)).concat(get)).total - myBefore;
          if (myGain <= 0) continue;
          const theirGain = ctx.lineup(theirIds.filter((p) => !get.includes(p)).concat(give)).total - theirBefore;
          if (theirGain < 0) continue;

          const score = myGain + 0.5 * theirGain - 0.5 * Math.abs(recvAdj - sentAdj);
          found.push({ give, get, sentAdj, recvAdj, pct, myGain, theirGain, score });
        }
      }
    }

    found.sort((a, b) => b.score - a.score);
    const partner = ctx.teamMeta(rid);
    const seenTargets = new Set(); // evita várias sugestões em torno do mesmo alvo
    for (const s of found) {
      if (seenTargets.size >= perPartner) break;
      if (seenTargets.has(s.get[0])) continue;
      seenTargets.add(s.get[0]);
      suggestions.push(formatSuggestion(ctx, s, partner, theirNeeds));
    }
  }

  suggestions.sort((a, b) => b.score - a.score);
  return {
    my_roster_id: myRosterId,
    my_needs: myNeeds,
    my_surplus: mySurplus,
    positions: analysis,
    suggestions: suggestions.slice(0, maxResults),
  };
}

function formatSuggestion(ctx, s, partner, theirNeeds) {
  const posOf = (ids) => [...new Set(ids.map((p) => ctx.positions[p]))].sort();
  const getPos = posOf(s.get);
  const givePos = posOf(s.give);
  let reason = `Você reforça ${getPos.join("/")} cedendo ${givePos.join("/")}`;
  const helped = givePos.filter((p) => theirNeeds.has(p));
  if (helped.length) reason += `; ${partner.team_name || partner.display_name} tem escassez em ${helped.join("/")}`;
  return suggestionPayload(ctx, s, partner, reason + ".");
}

function suggestionPayload(ctx, s, partner, reason) {
  return {
    partner,
    give: s.give.map((p) => ctx.playerCard(p)),
    get: s.get.map((p) => ctx.playerCard(p)),
    sent_value: r1(s.sentAdj),
    received_value: r1(s.recvAdj),
    balance_pct: Math.round(s.pct * 10000) / 10000,
    my_lineup_gain: r1(s.myGain),
    their_lineup_gain: r1(s.theirGain),
    score: r1(s.score),
    reason,
  };
}

// --- Oferecer meus jogadores --------------------------------------------------
// Você marca de 1 a 3 jogadores do seu time; para cada adversário testamos pacotes de 1 ou 2
// jogadores dele com valor parecido (dentro da tolerância). Não exige que seu titular melhore,
// já que a ideia pode ser vender, mas descarta pacotes que derrubam o titular do outro dono.

export function findTradesForOffer(ctx, myRosterId, giveIds, { tolerance = 0.15, wantPositions = null, poolSize = 10, perPartner = 2, maxResults = 25 } = {}) {
  if (!giveIds.length) throw new Error("Marque pelo menos um jogador seu.");
  if (giveIds.length > MAX_TARGETS) throw new Error(`Escolha no máximo ${MAX_TARGETS} jogadores.`);
  const myIds = ctx.rosterPlayerIds(myRosterId);
  if (giveIds.some((pid) => !myIds.includes(pid))) throw new Error("Algum jogador marcado não está mais no seu time.");

  const value = (pid) => ctx.values[pid] || 0;
  const sentAdj = packageValue(giveIds.map(value));
  if (sentAdj <= 0) throw new Error("Os jogadores marcados não têm valor de mercado para comparar.");
  const analysis = analyzePositions(ctx);
  const myBefore = ctx.lineup(myIds).total;
  const myAfterBase = myIds.filter((p) => !giveIds.includes(p));
  const positions = new Set(wantPositions?.length ? wantPositions : CORE_POSITIONS);

  const suggestions = [];
  for (const roster of ctx.rosters) {
    const rid = roster.roster_id;
    if (rid === myRosterId) continue;
    const theirIds = ctx.rosterPlayerIds(rid);
    const theirBefore = ctx.lineup(theirIds).total;
    const theirNeeds = new Set(CORE_POSITIONS.filter((p) => analysis[rid][p].status === "need"));
    const getPool = theirIds
      .filter((pid) => positions.has(ctx.positions[pid]) && value(pid) > 0 && value(pid) <= sentAdj * (1 + tolerance))
      .sort((a, b) => value(b) - value(a))
      .slice(0, poolSize);

    const found = [];
    for (const getN of [1, 2]) {
      for (const get of combinations(getPool, getN)) {
        const recvAdj = packageValue(get.map(value));
        const pct = (recvAdj - sentAdj) / Math.max(sentAdj, recvAdj);
        if (Math.abs(pct) > tolerance) continue;
        const theirGain = ctx.lineup(theirIds.filter((p) => !get.includes(p)).concat(giveIds)).total - theirBefore;
        if (theirGain < -MAX_LINEUP_LOSS * theirBefore) continue;
        const myGain = ctx.lineup(myAfterBase.concat(get)).total - myBefore;
        const score = myGain + 0.5 * theirGain - 0.5 * Math.abs(recvAdj - sentAdj);
        found.push({ give: giveIds, get, sentAdj, recvAdj, pct, myGain, theirGain, score });
      }
    }

    found.sort((a, b) => b.score - a.score);
    const partner = ctx.teamMeta(rid);
    const seenTargets = new Set();
    for (const s of found) {
      if (seenTargets.size >= perPartner) break;
      if (seenTargets.has(s.get[0])) continue;
      seenTargets.add(s.get[0]);
      suggestions.push(formatSuggestion(ctx, s, partner, theirNeeds));
    }
  }

  suggestions.sort((a, b) => b.score - a.score);
  return { offer: giveIds.map((pid) => ctx.playerCard(pid)), suggestions: suggestions.slice(0, maxResults) };
}

// --- Trade Finder com alvos ----------------------------------------------------
// Você marca de 1 a 3 jogadores de um mesmo time adversário; testamos pacotes de 1 a 4
// jogadores seus e separamos o resultado em duas listas:
//   justos   -> diferença de valor até ±FAIR_PCT (a faixa "Troca justa" do Analyzer);
//   prováveis -> o outro dono sai ganhando (recebe mais valor e/ou o titular dele melhora),
//                com o quanto você paga a mais limitado pela tolerância escolhida.

export const MAX_TARGETS = 3;
const MAX_GIVE = 4;
const CHANCE_RANK = { alta: 0, media: 1 };
const SPOT_PENALTY = 500; // cada vaga que o outro dono precisa liberar pesa contra o pacote
const MAX_LINEUP_LOSS = 0.05; // "ganha valor" só conta se o titular dele cair no máximo 5%

// Evita sugestões quase iguais: dois pacotes que só trocam a peça de menor valor contam como um.
function pickDiverse(sorted, n, value) {
  const seen = new Set();
  const out = [];
  for (const c of sorted) {
    const core = c.give.length > 1 ? [...c.give].sort((a, b) => value(b) - value(a)).slice(0, -1) : c.give;
    const key = [...core].sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

export function findTradesForTargets(ctx, myRosterId, targetIds, { tolerance = 0.15, poolSize = 12, perList = 5 } = {}) {
  if (!targetIds.length) throw new Error("Marque pelo menos um jogador.");
  if (targetIds.length > MAX_TARGETS) throw new Error(`Escolha no máximo ${MAX_TARGETS} jogadores.`);
  const owners = new Set(targetIds.map((pid) => ctx.rosters.find((r) => (r.players || []).includes(pid))?.roster_id));
  if (owners.has(undefined)) throw new Error("Algum jogador escolhido não está em nenhum elenco da liga.");
  if (owners.size > 1) throw new Error("Os jogadores escolhidos precisam ser do mesmo time.");
  const rid = [...owners][0];
  if (rid === myRosterId) throw new Error("Esses jogadores já estão no seu time.");

  const value = (pid) => ctx.values[pid] || 0;
  const recvAdj = packageValue(targetIds.map(value));
  if (recvAdj <= 0) throw new Error("Os jogadores escolhidos não têm valor de mercado para comparar.");

  const myIds = ctx.rosterPlayerIds(myRosterId);
  const theirIds = ctx.rosterPlayerIds(rid);
  const myBefore = ctx.lineup(myIds).total;
  const theirBefore = ctx.lineup(theirIds).total;
  const theirAfterBase = theirIds.filter((p) => !targetIds.includes(p));
  const pool = myIds.filter((p) => value(p) > 0).sort((a, b) => value(b) - value(a)).slice(0, poolSize);

  const candidates = [];
  for (let k = 1; k <= MAX_GIVE; k++) {
    for (const give of combinations(pool, k)) {
      const sentAdj = packageValue(give.map(value));
      const pct = (recvAdj - sentAdj) / Math.max(sentAdj, recvAdj); // > 0: você ganha valor
      if (pct > FAIR_PCT || pct < -tolerance) continue; // você ganha demais, ou paga demais
      const theirGain = ctx.lineup(theirAfterBase.concat(give)).total - theirBefore;
      const myGain = ctx.lineup(myIds.filter((p) => !give.includes(p)).concat(targetIds)).total - myBefore;
      const theyGainValue = pct <= 0 && theirGain >= -MAX_LINEUP_LOSS * theirBefore;
      const theyImprove = theirGain > 0;
      const chance = pct <= 0 && theyImprove ? "alta" : theyGainValue || theyImprove ? "media" : null;
      const spots = Math.max(0, give.length - targetIds.length);
      candidates.push({
        give, get: targetIds, sentAdj, recvAdj, pct, myGain, theirGain, chance, spots,
        fair: Math.abs(pct) <= FAIR_PCT,
        overpay: sentAdj - recvAdj,
        score: myGain,
      });
    }
  }

  // Justos: primeiro o melhor pacote de cada tamanho (menor primeiro), depois completa pelo ranking.
  const fairRanked = pickDiverse(
    candidates
      .filter((c) => c.fair)
      .sort((a, b) => b.myGain - SPOT_PENALTY * b.spots - (a.myGain - SPOT_PENALTY * a.spots) || Math.abs(a.pct) - Math.abs(b.pct)),
    Infinity,
    value,
  );
  const bestPerSize = [];
  for (let k = 1; k <= MAX_GIVE; k++) {
    const best = fairRanked.find((c) => c.give.length === k);
    if (best) bestPerSize.push(best);
  }
  const fair = [...bestPerSize, ...fairRanked.filter((c) => !bestPerSize.includes(c))].slice(0, perList);
  const shown = new Set(fair);
  const likely = pickDiverse(
    candidates
      .filter((c) => c.chance && !shown.has(c))
      .sort(
        (a, b) =>
          CHANCE_RANK[a.chance] - CHANCE_RANK[b.chance] ||
          a.overpay + SPOT_PENALTY * a.spots - (b.overpay + SPOT_PENALTY * b.spots) ||
          b.theirGain - a.theirGain,
      ),
    perList,
    value,
  );

  const partner = ctx.teamMeta(rid);
  const partnerName = partner.team_name || partner.display_name;
  const describe = (s, mode) => {
    const parts = [];
    if (mode === "fair") parts.push(`Valor equilibrado (diferença de ${(Math.abs(s.pct) * 100).toFixed(1)}%)`);
    if (s.pct <= 0 && mode === "likely") parts.push(`${partnerName} recebe mais valor de mercado`);
    if (s.theirGain > 0) parts.push(`o lineup titular de ${partnerName} melhora`);
    if (s.myGain < 0) parts.push("seu titular perde um pouco agora, em troca de jogadores melhores");
    const spots = s.give.length - s.get.length;
    if (spots > 0) parts.push(`${partnerName} precisa liberar ${spots} ${spots === 1 ? "vaga" : "vagas"} no elenco`);
    return parts.join("; ").replace(/^./, (c) => c.toUpperCase()) + ".";
  };
  const payload = (s, mode) => ({
    ...suggestionPayload(ctx, s, partner, describe(s, mode)),
    chance: s.chance,
    overpay: r1(s.overpay),
    spots_needed: s.spots,
  });

  return {
    targets: targetIds.map((pid) => ctx.playerCard(pid)),
    partner,
    fair: fair.map((s) => payload(s, "fair")),
    likely: likely.map((s) => payload(s, "likely")),
  };
}

// --- Radar de waivers ----------------------------------------------------------
// Recebe os jogadores livres da liga (já com valor) e mostra quanto cada um
// melhoraria o seu lineup titular, destacando quem cobre suas posições em escassez.

export function waiverReport(ctx, myRosterId, freeAgents, faValues, trending) {
  const [needs] = needsAndSurplus(analyzePositions(ctx)[myRosterId]);
  const positions = { ...ctx.positions };
  const values = { ...ctx.values };
  for (const [pid, p] of Object.entries(freeAgents)) {
    positions[pid] = p.position;
    values[pid] = faValues[pid] || 0;
  }
  const myIds = ctx.rosterPlayerIds(myRosterId);
  const before = optimalLineup(myIds, ctx.slots, positions, values).total;

  // Seu jogador mais fraco em cada posição: candidato a ser dispensado pelo agente livre.
  const weakest = {};
  for (const pid of myIds) {
    const pos = positions[pid];
    if (!weakest[pos] || values[pid] < values[weakest[pos]]) weakest[pos] = pid;
  }

  const card = (pid) => {
    const p = freeAgents[pid];
    const w = weakest[p.position];
    const upgrade = w && values[pid] > values[w] ? { name: ctx.playerCard(w).name, gain: r1(values[pid] - values[w]) } : null;
    return {
      upgrade,
      id: pid,
      name: p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim() || pid,
      position: p.position,
      team: p.team ?? null,
      age: p.age ?? null,
      injury_status: p.injury_status ?? null,
      value: r1(values[pid]),
      lineup_gain: r1(optimalLineup(myIds.concat(pid), ctx.slots, positions, values).total - before),
      fills_need: needs.includes(p.position),
    };
  };

  const trendingCards = trending.filter((t) => freeAgents[t.player_id]).map((t) => ({ ...card(t.player_id), adds: t.count }));
  const bestAvailable = {};
  for (const pos of CORE_POSITIONS) {
    bestAvailable[pos] = Object.keys(freeAgents)
      .filter((pid) => freeAgents[pid].position === pos && values[pid] > 0)
      .sort((a, b) => values[b] - values[a])
      .slice(0, 8)
      .map(card);
  }
  return { needs, trending: trendingCards, best_available: bestAvailable };
}

// --- Panorama da liga ----------------------------------------------------------

export function buildOverview(ctx) {
  const analysis = analyzePositions(ctx);
  const teams = ctx.rosters.map((roster) => {
    const rid = roster.roster_id;
    const playerIds = ctx.rosterPlayerIds(rid);
    const { total, lineup } = ctx.lineup(playerIds);
    const slotByPlayer = Object.fromEntries(lineup.filter((e) => e.player_id).map((e) => [e.player_id, e.slot]));
    const taxi = new Set(roster.taxi || []);
    const reserve = new Set(roster.reserve || []);

    const cards = playerIds
      .map((pid) => ({ ...ctx.playerCard(pid), lineup_slot: slotByPlayer[pid] ?? null, taxi: taxi.has(pid), reserve: reserve.has(pid) }))
      .sort((a, b) => b.value - a.value);

    const s = roster.settings || {};
    return {
      ...ctx.teamMeta(rid),
      record: {
        wins: s.wins || 0,
        losses: s.losses || 0,
        ties: s.ties || 0,
        fpts: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
      },
      lineup_value: r1(total),
      total_value: r1(cards.reduce((sum, c) => sum + c.value, 0)),
      positions: analysis[rid],
      players: cards,
    };
  });

  const { league, profile } = ctx;
  const ppr = profile.ppr;
  return {
    league: {
      league_id: league.league_id,
      name: league.name,
      season: league.season,
      status: league.status,
      total_rosters: league.total_rosters,
      roster_positions: league.roster_positions,
      scoring: ppr === 1 ? "PPR" : ppr === 0.5 ? "Half-PPR" : ppr === 0 ? "Standard" : `${ppr} PPR`,
      format: (profile.is_dynasty ? "Dynasty" : "Redraft") + (profile.num_qbs === 2 ? " · Superflex" : " · 1QB"),
      value_source: ctx.valueSource,
    },
    slots: ctx.slots,
    teams,
  };
}
