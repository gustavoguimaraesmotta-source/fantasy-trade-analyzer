// Cliente da API pública do Sleeper, chamado direto do navegador (a API libera CORS).
// Documentação: https://docs.sleeper.com/
const BASE_URL = "https://api.sleeper.app/v1";

// /players/nfl tem ~5 MB: guardamos só os campos usados, por 24h (o Sleeper pede 1 chamada/dia).
const PLAYERS_KEY = "fta.players.v2";
const PLAYERS_TTL = 24 * 3600 * 1000;
const PLAYER_FIELDS = ["full_name", "first_name", "last_name", "position", "team", "age", "injury_status", "status", "search_rank"];
try { localStorage.removeItem("fta.players.v1"); } catch { /* cache antigo, sem o campo status */ }

async function get(path) {
  let resp;
  try {
    resp = await fetch(`${BASE_URL}${path}`);
  } catch {
    throw new Error("Sem conexão com a API do Sleeper.");
  }
  if (resp.status === 404) throw new Error(`Não encontrado no Sleeper: ${path}`);
  if (!resp.ok) throw new Error(`Falha ao consultar o Sleeper (${resp.status}).`);
  const data = await resp.json();
  if (data === null) throw new Error(`Não encontrado no Sleeper: ${path}`);
  return data;
}

let memPlayers = null;
let pendingPlayers = null;

// Duas ligas carregando ao mesmo tempo compartilham o mesmo download.
function getPlayers() {
  if (!pendingPlayers) pendingPlayers = loadPlayers().finally(() => { pendingPlayers = null; });
  return pendingPlayers;
}

async function loadPlayers() {
  if (memPlayers && Date.now() - memPlayers.at < PLAYERS_TTL) return memPlayers.data;
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYERS_KEY));
    if (saved && Date.now() - saved.at < PLAYERS_TTL) {
      memPlayers = saved;
      return saved.data;
    }
  } catch { /* storage indisponível ou corrompido */ }

  const raw = await get("/players/nfl");
  const data = {};
  for (const [id, p] of Object.entries(raw)) {
    const slim = {};
    for (const f of PLAYER_FIELDS) if (p[f] != null) slim[f] = p[f];
    data[id] = slim;
  }
  memPlayers = { at: Date.now(), data };
  try {
    localStorage.setItem(PLAYERS_KEY, JSON.stringify(memPlayers));
  } catch { /* sem espaço: segue só com o cache em memória */ }
  return data;
}

export const sleeper = {
  state: () => get("/state/nfl"),
  user: (usernameOrId) => get(`/user/${encodeURIComponent(usernameOrId)}`),
  userLeagues: (userId, season) => get(`/user/${userId}/leagues/nfl/${season}`),
  league: (leagueId) => get(`/league/${leagueId}`),
  leagueUsers: (leagueId) => get(`/league/${leagueId}/users`),
  rosters: (leagueId) => get(`/league/${leagueId}/rosters`),
  players: getPlayers,
  // [{player_id, count}] dos jogadores mais adicionados no Sleeper inteiro nas últimas 24h.
  trendingAdds: (limit = 50) => get(`/players/nfl/trending/add?lookback_hours=24&limit=${limit}`),
};
