#!/usr/bin/env node
// stdio MCP wiring only. The logic lives in lib/. This is the only file that imports the SDK.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { createFetcher } = require('./lib/fetch');
const tools = require('./lib/tools');

const fetcher = createFetcher();
const deps = { fetchText: fetcher.fetchText, fetchJson: fetcher.fetchJson, now: () => Date.now() };

const season = z.number().int().optional().describe('Start year of the season (2025 = 2025-26). Default: current season. Any season MoneyPuck covers (2008 on).');
const situation = z.enum(['all', '5on5', '4on5', '5on4', 'other']).optional().describe('Game situation (default all)');
const team = z.string().optional().describe('Team abbreviation, e.g. EDM (aliases like TB accepted)');
const fields = z.array(z.string()).optional().describe('Source column names to return (MoneyPuck or NHL names, computed fields like gsax). Prefix mp. or nhl. to force a source. Default: a sensible set.');
const sort = z.string().optional().describe('Any numeric column to sort by (returned or not)');
const order = z.enum(['asc', 'desc']).optional().describe('Sort order (default desc)');
const limit = z.number().int().optional().describe('Rows to return (default 25, max 200)');
const minGp = z.number().int().optional().describe('Minimum games played (default 1)');

const SPECS = {
  goalie_stats: ['Goalie stats: MoneyPuck xG data joined with NHL official stats. Computed: gsax (xGoals - goals), gsax60, per-danger-band gsax/gsax60.',
    { season, situation, team, min_gp: minGp, sort, order, limit, fields }],
  skater_stats: ['Skater stats: MoneyPuck xG data joined with NHL official stats (hits, blocks, TOI). Computed: g_minus_ixg, sh_pct, g_per_ixg (goals/ixG), onice_xgf_pct.',
    { season, situation, team, position: z.enum(['C', 'L', 'R', 'F', 'D']).optional().describe('Position (F = C, L and R)'), min_gp: minGp, sort, order, limit, fields }],
  team_stats: ['Team stats: MoneyPuck team xG joined with NHL team summary and standings. Computed: xgf60, xga60, xgf_pct, hd_xga60.',
    { season, situation, team, min_gp: minGp, sort, order, limit, fields }],
  player_game_log: ['Per-game log for one player from the NHL API. include_xg=true also fetches MoneyPuck per-game data (ixg, hits, blocks for skaters; xga, gsax for goalies).',
    { player: z.union([z.string(), z.number()]).describe('NHL playerId or a name'), season, last_n: z.number().int().optional().describe('Most recent games (default 10)'), include_xg: z.boolean().optional(), fields }],
  player_lookup: ['Find NHL players by name (accent-insensitive, nicknames, last name). Returns playerId, team, position.',
    { query: z.string(), team, season, limit: z.number().int().optional() }],
  schedule: ['NHL schedule: games on a date, for a team, or both.',
    { date: z.string().optional().describe('YYYY-MM-DD (default today when no team given)'), team, season, sort, order, limit, fields }],
  standings: ['NHL standings now, or as of a date or season.',
    { date: z.string().optional().describe('YYYY-MM-DD'), season, team, sort, order, limit, fields }],
};

async function main() {
  const server = new McpServer({ name: 'nhl-stats', version: '1.0.0' });
  for (const [name, [description, shape]] of Object.entries(SPECS)) {
    server.tool(name, description, shape, async (args) => {
      try {
        const out = await tools[name](args, deps);
        return { content: [{ type: 'text', text: JSON.stringify(out) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: String(err.message || err) }] };
      }
    });
  }
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
