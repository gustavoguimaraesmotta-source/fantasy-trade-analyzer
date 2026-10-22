// Mesma interface do api.js da versão com servidor, mas tudo roda no navegador:
// os dados vêm direto do Sleeper/FantasyCalc e os cálculos ficam em engine.js.
import { sleeper } from "./sleeper.js";
import { getValues } from "./values.js";
import { LeagueContext, analyzeTrade, buildOverview, findTrades } from "./engine.js";

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

  async finder(leagueId, rosterId, tolerance) {
    const ctx = await getContext(leagueId);
    const rid = Number(rosterId);
    if (!ctx.rostersById.has(rid)) throw new Error(`roster_id ${rid} não existe nesta liga`);
    return findTrades(ctx, rid, { tolerance: Number(tolerance) });
  },
};
