// Mesma interface do api.js da versão com servidor, mas tudo roda no navegador:
// os dados vêm direto do Sleeper/FantasyCalc e os cálculos ficam em engine.js.
import { sleeper } from "./sleeper.js";
import { getValues, marketValueMap } from "./values.js";
import {
  CORE_POSITIONS,
  LeagueContext,
  STREAM_POSITIONS,
  analyzeTrade,
  buildOverview,
  findTrades,
  findTradesForOffer,
  findTradesForTargets,
  streamerReport,
  waiverReport,
} from "./engine.js";

const LEAGUE_TTL = 10 * 60 * 1000;
const contexts = new Map();

async function getContext(leagueId, refresh = false) {
  const cached = contexts.get(leagueId);
  if (cached && !refresh && Date.now() - cached.loadedAt < LEAGUE_TTL) return cached;

  const [league, users, rosters, allPlayers] = await Promise.all([
    sleeper.league(leagueId),
    sleeper.leagueUsers(leagueId),
    sleeper.rosters(leagueId),
    sleeper.players(),
  ]);
  const players = {};
  for (const r of rosters) for (const pid of r.players || []) players[pid] = allPlayers[pid] || {};
  const { values, source } = await getValues(league, players);

  const ctx = new LeagueContext({
    league,
    users: Object.fromEntries(users.map((u) => [u.user_id, u])),
    rosters,
    players,
    values,
    valueSource: source,
  });
  ctx.allPlayers = allPlayers; // usado pelo radar de waivers (jogadores fora dos elencos)
  contexts.set(leagueId, ctx);
  return ctx;
}

export const api = {
  state: () => sleeper.state(),

  async leagues(username, season) {
    const user = await sleeper.user(username);
    if (!season) season = (await sleeper.state()).league_season;
    const leagues = await sleeper.userLeagues(user.user_id, season);
    return {
      user: { user_id: user.user_id, username: user.username, display_name: user.display_name, avatar: user.avatar },
      season,
      leagues: leagues.map((lg) => ({
        league_id: lg.league_id,
        name: lg.name,
        season: lg.season,
        status: lg.status,
        total_rosters: lg.total_rosters,
      })),
    };
  },

  async league(leagueId, refresh = false) {
    return buildOverview(await getContext(leagueId, refresh));
  },

  async analyze(leagueId, body) {
    const ctx = await getContext(leagueId);
    return analyzeTrade(ctx, body.sent || [], body.received || [], body.my_roster_id ?? null, body.partner_roster_id ?? null);
  },

  async finder(leagueId, rosterId, tolerance, wantPositions = null) {
    const ctx = await getContext(leagueId);
    const rid = Number(rosterId);
    if (!ctx.rostersById.has(rid)) throw new Error(`roster_id ${rid} não existe nesta liga`);
    return findTrades(ctx, rid, { tolerance: Number(tolerance), wantPositions });
  },

  async finderOffer(leagueId, rosterId, giveIds, tolerance, wantPositions = null) {
    const ctx = await getContext(leagueId);
    return findTradesForOffer(ctx, Number(rosterId), giveIds, { tolerance: Number(tolerance), wantPositions });
  },

  async finderTargets(leagueId, rosterId, targetIds, tolerance) {
    const ctx = await getContext(leagueId);
    return findTradesForTargets(ctx, Number(rosterId), targetIds, { tolerance: Number(tolerance) });
  },

  async waivers(leagueId, rosterId) {
    const ctx = await getContext(leagueId);
    const [trending, market] = await Promise.all([sleeper.trendingAdds(), marketValueMap(ctx.league)]);

    // Livres = em alta no Sleeper ou com valor no FantasyCalc, e fora de todos os elencos da liga.
    const rostered = new Set(ctx.rosters.flatMap((r) => r.players || []));
    const candidates = new Set([...trending.map((t) => t.player_id), ...Object.keys(market)]);
    const freeAgents = {};
    for (const pid of candidates) {
      const p = ctx.allPlayers[pid];
      if (p && !rostered.has(pid) && CORE_POSITIONS.includes(p.position)) freeAgents[pid] = p;
    }
    const { values } = await getValues(ctx.league, freeAgents);
    const report = waiverReport(ctx, Number(rosterId), freeAgents, values, trending);
    report.streamers = await streamers(ctx, Number(rosterId));
    return report;
  },
};

// K e DEF pela projeção da semana; se o Sleeper não responder, o resto do radar segue normal.
async function streamers(ctx, rosterId) {
  const positions = STREAM_POSITIONS.filter((p) => ctx.slots.includes(p));
  if (!positions.length) return null;
  try {
    const state = await sleeper.state();
    const week = state.season_type === "regular" ? state.week : 1;
    const projections = await sleeper.projections(ctx.league.season, week, positions);
    return streamerReport(ctx, rosterId, ctx.allPlayers, projections, week);
  } catch {
    return { error: true, positions: Object.fromEntries(positions.map((p) => [p, null])) };
  }
}
