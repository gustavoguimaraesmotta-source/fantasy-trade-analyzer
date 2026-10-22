// Valor de mercado dos jogadores.
// Fonte primária: FantasyCalc (já traz o sleeperId), parametrizada pelo formato da liga.
// Fallback: heurística sobre o search_rank do Sleeper + curva de idade em dynasty.
const FANTASYCALC_URL = "https://api.fantasycalc.com/values/current";
const VALUES_TTL = 6 * 3600 * 1000;

const POSITION_PEAK_AGE = { QB: 29, RB: 25, WR: 26, TE: 27 };
const LOW_VALUE_POSITIONS = { K: 0.08, DEF: 0.1 };
const VALUED_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

export function leagueProfile(league) {
  const rosterPositions = league.roster_positions || [];
  const settings = league.settings || {};
  const scoring = league.scoring_settings || {};
  const qbSlots = rosterPositions.filter((s) => s === "QB" || s === "SUPER_FLEX").length;
  return {
    is_dynasty: settings.type === 2, // 0 = redraft, 1 = keeper, 2 = dynasty
    num_qbs: qbSlots >= 2 ? 2 : 1,
    num_teams: settings.num_teams || league.total_rosters || 12,
    ppr: scoring.rec || 0,
  };
}

// Desconto por situação do jogador: [redraft, dynasty].
// Fora por muito tempo (IR, suspenso, inativo) quase zera em redraft; "Out" perde só esta semana.
const LONG_OUT = new Set(["IR", "PUP", "Sus", "NA", "COV"]);
function availabilityFactor(player, isDynasty) {
  const pick = ([redraft, dynasty]) => (isDynasty ? dynasty : redraft);
  if (LONG_OUT.has(player.injury_status) || player.status === "Inactive") return pick([0.1, 0.6]);
  if (player.injury_status === "Out") return pick([0.8, 0.95]);
  if (player.injury_status === "Doubtful") return pick([0.9, 1]);
  return 1;
}

// scale: valores do FantasyCalc em ordem decrescente. Com ele, o N-º do ranking do Sleeper recebe
// o valor do N-º da lista (mesma escala do resto do app); sem ele, usamos uma curva própria.
export function heuristicValue(player, isDynasty, scale = null) {
  const pos = player.position;
  const rank = player.search_rank || 9_999_999;
  if (!VALUED_POSITIONS.has(pos) || rank >= 9_999_999) return 0;
  let value;
  if (scale?.length) {
    value = scale[Math.min(rank, scale.length) - 1];
  } else {
    value = 10_000 * Math.exp(-rank / 90);
    if (isDynasty && POSITION_PEAK_AGE[pos] && player.age) {
      value *= Math.min(1.2, Math.max(0.6, 1 + 0.04 * (POSITION_PEAK_AGE[pos] - player.age)));
    }
  }
  value *= availabilityFactor(player, isDynasty);
  value *= LOW_VALUE_POSITIONS[pos] ?? 1;
  return Math.round(value * 10) / 10;
}

const cache = new Map();

async function fantasyCalc(profile) {
  const key = JSON.stringify(profile);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < VALUES_TTL) return cached.values;

  const params = new URLSearchParams({
    isDynasty: String(profile.is_dynasty),
    numQbs: profile.num_qbs,
    numTeams: profile.num_teams,
    ppr: profile.ppr,
  });
  const resp = await fetch(`${FANTASYCALC_URL}?${params}`);
  if (!resp.ok) throw new Error(`FantasyCalc ${resp.status}`);
  const values = {};
  for (const row of await resp.json()) {
    const sleeperId = row.player?.sleeperId;
    if (sleeperId && row.value != null) values[String(sleeperId)] = Number(row.value);
  }
  cache.set(key, { at: Date.now(), values });
  return values;
}

// Mapa completo {sleeperId: valor} do FantasyCalc para o formato da liga ({} se indisponível).
export async function marketValueMap(league) {
  try {
    return await fantasyCalc(leagueProfile(league));
  } catch {
    return {};
  }
}

export async function getValues(league, players) {
  const profile = leagueProfile(league);
  let external = {};
  let source = "heurística (search_rank)";
  try {
    external = await fantasyCalc(profile);
    source = "FantasyCalc + heurística";
  } catch {
    external = {};
  }
  // Quem não está na lista do FantasyCalc (lesionado, novato, reserva) recebe a estimativa pelo
  // ranking do Sleeper, convertida para a escala do FantasyCalc e descontada pela situação.
  const scale = Object.values(external).sort((a, b) => b - a);

  const values = {};
  for (const [pid, player] of Object.entries(players)) {
    values[pid] = external[pid] || heuristicValue(player, profile.is_dynasty, scale);
  }
  return { values, source };
}
