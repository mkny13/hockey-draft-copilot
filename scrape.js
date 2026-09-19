#!/usr/bin/env node
/*
 * Automated projection scraper for the draft co-pilot (issue #1).
 *
 * Pulls the four projection feeds the owner pointed at:
 *
 *   DtZ  - "Free Version DtZ 2026-2027 NHL Fantasy Projections" Google Sheet
 *          (public CSV export; Skater Projections + Goalie Projections tabs)
 *   DFO  - Daily Faceoff's projections engine (dailyfaceoff.com/projections
 *          embeds 5v5hockey.com/projections-embedded/, which ships the whole
 *          skater and goalie projection table inline in the page source)
 *   AGN  - Apples & Ginos 2026-27 skater projections, Nate's tab
 *   AGB  - Apples & Ginos 2026-27 skater projections, Blake's tab
 *
 * and re-blends them into draft_data.json through the *same* isomorphic
 * valuation engine the browser runs (public/js/valuation.js). There is no
 * second copy of the blending math here: scrape.js only assembles the raw
 * per-source rows into the payload createModel() consumes, and serializes the
 * compute() result back into the existing board schema.
 *
 * Every fetch failure is contained: a source that cannot be reached simply
 * drops out of the blend (weightedMean ignores absent sources), and the board
 * is rewritten only when the full pipeline succeeded -- a failed run always
 * leaves the previous draft_data.json byte-identical on disk.
 *
 * Usage: node scrape.js   (rewrites draft_data.json + public/draft_data.json)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Valuation = require('./public/js/valuation.js');

/* ------------------------------------------------------------------ config */

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'draft_data.json');
const PUBLIC_DATA_FILE = path.join(ROOT, 'public', 'draft_data.json');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 45000;

// DtZ free projections workbook; owner-provided link (issue #1).
const DTZ_SHEET_ID = '1hlwGkHQiC9PNg1bs5jHRK-pgyaI9QMbVRe0pMhOVuqU';
const DTZ_SKATER_SHEET = 'Skater Projections';
const DTZ_GOALIE_SHEET = 'Goalie Projections';

// Apples & Ginos skater projections workbook; owner-provided gids
// (gid 0 = Nate's Projections, gid 1667609370 = Blake's Projections).
const AG_SHEET_ID = '17XHuu3nWDYMGGz-xUtEVt8QJTjTEoQEp4-qZJnnVJq0';
const AG_TABS = [
  { id: 'AGN', label: "Apples & Ginos - Nate's Projections", gid: 0 },
  { id: 'AGB', label: "Apples & Ginos - Blake's Projections", gid: 1667609370 }
];

// Daily Faceoff projections: the /projections page is a shell that embeds
// 5v5hockey.com, whose page source carries the full skater/goalie tables.
const DFO_URL = 'https://5v5hockey.com/projections-embedded/';

/* Blended stat columns. One shared list for skaters and goalies; every
 * player's per-source line is an array aligned to this order with nulls for
 * stats a source does not publish. GP is shared (skater games / goalie starts
 * -- Daily Faceoff publishes goalie starts, which the valuation engine maps
 * straight onto GP). */
const STATS = [
  'GP', 'G', 'A', 'PTS', 'PPP', 'SHP', 'SOG', 'HIT', 'BLK', 'PIM', 'FOW', '+/-',
  'W', 'L', 'GA', 'SA', 'SV', 'SV%', 'SO', 'GAA'
];
const COUNTING_STATS = ['G', 'A', 'PTS', 'PPP', 'SHP', 'SOG', 'HIT', 'BLK', 'PIM', 'FOW', 'W', 'L', 'GA', 'SA', 'SV', 'SO'];
const RATE_STATS = ['SV%', 'GAA'];

/* Sources and blend weights. Apples & Ginos publishes two projectionists, so
 * each carries half a weight -- together they count as one full source against
 * DtZ and DFO, the same "three sources" the hand-built board blended. */
const SOURCES = [
  { id: 'DTZ', name: 'DtZ 2026-27 projections' },
  { id: 'DFO', name: 'Daily Faceoff / 5v5 projections' },
  { id: 'AGN', name: 'Apples & Ginos (Nate)' },
  { id: 'AGB', name: 'Apples & Ginos (Blake)' }
];
const SOURCE_WEIGHTS = { DTZ: 1, DFO: 1, AGN: 0.5, AGB: 0.5 };

/* League scoring. SOURCE_WEIGHTS is the blend; this is the fantasy-point
 * translation applied after blending, chosen to sit on the same scale the
 * hand-built board used (elite forward ~476 FP, elite goalie ~256) so the
 * game-theory cliff thresholds stay calibrated. Skater weights mirror the
 * owner's own Apples & Ginos sheet defaults (G 5 / A 3.75 / PPP .5 / SOG .5 /
 * HIT .3 / BLK .6) rescaled onto that board. Tune here and re-run. */
const SCORING = {
  G: 3.0, A: 2.25, PTS: 0, PPP: 0.3, SHP: 0.6, SOG: 0.3, HIT: 0.2,
  BLK: 0.35, PIM: 0, FOW: 0.06, '+/-': 0.3, DPT: 0,
  W: 3.5, L: 0, GA: -1, SA: 0, SV: 0.2, 'SV%': 0, SO: 3, GAA: 0, GS: 0
};

const DEFAULT_CONFIG = {
  league: { teams: 8, slots: { C: 3, F: 5, D: 4, G: 2, BN: 4 } },
  model: { adp_source: 'average', eligibility: 'yahoo' }
};

/* Daily Faceoff (5v5) publishes full team names; every other source uses
 * tricodes. Normalize onto the tricodes the rest of the app stores. */
const DFO_TEAM_CODES = {
  'Avalanche': 'COL', 'Blackhawks': 'CHI', 'Blue Jackets': 'CBJ', 'Bruins': 'BOS',
  'Canadiens': 'MTL', 'Canucks': 'VAN', 'Capitals': 'WSH', 'Devils': 'NJD',
  'Ducks': 'ANA', 'Flames': 'CGY', 'Flyers': 'PHI', 'Hurricanes': 'CAR',
  'Islanders': 'NYI', 'Jets': 'WPG', 'Kings': 'LAK', 'Knights': 'VGK',
  'Kraken': 'SEA', 'Lightning': 'TBL', 'Maple Leafs': 'TOR', 'Oilers': 'EDM',
  'Panthers': 'FLA', 'Penguins': 'PIT', 'Predators': 'NSH', 'Rangers': 'NYR',
  'Red Wings': 'DET', 'Sabres': 'BUF', 'Senators': 'OTT', 'Sharks': 'SJS',
  'Stars': 'DAL', 'Utah': 'UTA', 'Wild': 'MIN'
};

const POSITION_ORDER = ['C', 'LW', 'RW', 'D', 'G'];

/* ------------------------------------------------------------ small helpers */

function nameKey(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');                       // periods, spaces, jr.
}

function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '' || s === '-' || s === '\u2014') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function round(v, places) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = Math.pow(10, places);
  return Math.round(v * f) / f;
}

function normalizePositions(raw) {
  if (!raw) return [];
  const out = [];
  for (const piece of String(raw).split(/[,\/]/)) {
    const p = piece.trim().toUpperCase();
    if (POSITION_ORDER.indexOf(p) !== -1 && out.indexOf(p) === -1) out.push(p);
  }
  return POSITION_ORDER.filter(function (p) { return out.indexOf(p) !== -1; });
}

function isTricode(team) {
  return /^[A-Za-z]{2,4}$/.test(String(team || '').trim());
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow'
  });
  if (!res.ok) {
    throw new Error('HTTP ' + res.status + ' fetching ' + url);
  }
  return await res.text();
}

/* Minimal RFC-4180 CSV reader: quotes, escaped quotes, embedded newlines and
 * commas inside quotes. Google's CSV export is well-behaved but quoted commas
 * in the DtZ preamble are real. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (ch === '\r') {
      // ignore
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/* Public CSV export of a published Google Sheet. gviz accepts a gid or a
 * tab name and follows the same redirect dance the browser export does. */
async function fetchSheetCsv(sheetId, opts) {
  let qs;
  if (opts && typeof opts.gid === 'number') qs = 'gid=' + opts.gid;
  else qs = 'sheet=' + encodeURIComponent(opts.sheet);
  const url = 'https://docs.google.com/spreadsheets/d/' + sheetId +
    '/gviz/tq?tqx=out:csv&' + qs;
  return parseCsv(await fetchText(url));
}

/* -------------------------------------------------------- DtZ adapters */

function parseDtzSkaters(rows) {
  const head = rows[0].map(function (h) { return h.trim(); });
  const col = {};
  head.forEach(function (h, i) { if (h) col[h] = i; });
  const need = ['Player', 'Pos', 'Team', 'ADP', 'GP', 'Goals', 'Assists', 'Points',
    'PP Points', 'SHP', 'Hit', 'BLK', 'PIM', 'FOW', 'SOG', '+/-'];
  for (const k of need) {
    if (col[k] === undefined) throw new Error('DtZ skater layout changed; missing column "' + k + '"');
  }
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r];
    const name = (c[col.Player] || '').trim();
    if (!name) continue;
    const gp = num(c[col.GP]);
    if (gp === null) continue;
    out.push({
      name: name,
      team: (c[col.Team] || '').trim(),
      pos: normalizePositions(c[col.Pos]),
      adp: num(c[col.ADP]),
      gp: gp,
      stats: {
        GP: gp,
        G: num(c[col.Goals]), A: num(c[col.Assists]), PTS: num(c[col.Points]),
        PPP: num(c[col['PP Points']]), SHP: num(c[col.SHP]),
        SOG: num(c[col.SOG]), HIT: num(c[col.Hit]), BLK: num(c[col.BLK]),
        PIM: num(c[col.PIM]), FOW: num(c[col.FOW]), '+/-': num(c[col['+/-']])
      }
    });
  }
  return out;
}

function parseDtzGoalies(rows) {
  const head = rows[0].map(function (h) { return h.trim(); });
  const col = {};
  head.forEach(function (h, i) { if (h) col[h] = i; });
  const need = ['Player', 'Team', 'Pos', 'ADP', 'GP', 'W', 'L', 'GA', 'SA', 'SV', 'SV%', 'GAA'];
  for (const k of need) {
    if (col[k] === undefined) throw new Error('DtZ goalie layout changed; missing column "' + k + '"');
  }
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r];
    const name = (c[col.Player] || '').trim();
    if (!name) continue;
    const gp = num(c[col.GP]);
    if (gp === null) continue;
    out.push({
      name: name,
      team: (c[col.Team] || '').trim(),
      pos: normalizePositions(c[col.Pos]),
      adp: num(c[col.ADP]),
      gp: gp,
      stats: {
        GP: gp,
        W: num(c[col.W]), L: num(c[col.L]), GA: num(c[col.GA]), SA: num(c[col.SA]),
        SV: num(c[col.SV]), 'SV%': num(c[col['SV%']]), GAA: num(c[col.GAA])
      }
    });
  }
  return out;
}

/* ------------------------------------------------- Apples & Ginos adapter */

/* A&G layout (gviz drops fully-empty spacer columns, so the columns are
 * positional): 0 Name, 1 Team, 2 Y! Pos, 3 Proj, 4 GP, 5 G, 6 A, 7 PTS,
 * 8 PPP, 9 SOG, 10 HIT, 11 BLK, 12 PIM, 13 S%, 14 ATOI, then the weighted
 * FP block. Data starts on row 7 (rows 0-6 are instructions/weights/headers).
 * The G+A-vs-PTS guard makes a layout shift loud instead of silent. */
function parseAgSkaters(rows) {
  const out = [];
  for (let r = 7; r < rows.length; r++) {
    const c = rows[r];
    const name = (c[0] || '').trim();
    if (!name) continue;
    const gp = num(c[4]);
    if (gp === null) continue;
    const g = num(c[5]), a = num(c[6]), pts = num(c[7]);
    if (g !== null && a !== null && pts !== null && Math.abs(g + a - pts) > 2.5) {
      throw new Error('Apples & Ginos layout shifted: "' + name + '" G+A=' + (g + a) + ' vs PTS=' + pts);
    }
    out.push({
      name: name,
      team: (c[1] || '').trim(),
      pos: normalizePositions(c[2]),
      adp: null,
      gp: gp,
      stats: {
        GP: gp, G: g, A: a, PTS: pts, PPP: num(c[8]), SOG: num(c[9]),
        HIT: num(c[10]), BLK: num(c[11]), PIM: num(c[12])
      }
    });
  }
  return out;
}

/* ------------------------------------------------- Daily Faceoff adapter */

/* The 5v5 embedded page carries its tables as inline JS object literals.
 * Extract records by splitting the `const data = [...]` arrays between the
 * column-def anchors, then pick fields with anchored regexes so stray
 * formatting cannot mis-map a column. */
function extractDfoSegment(html, startAnchor, endAnchor) {
  const start = html.indexOf(startAnchor);
  if (start === -1) throw new Error('Daily Faceoff page layout changed: missing "' + startAnchor + '"');
  const dataStart = html.indexOf('const data = [', start);
  const end = html.indexOf(endAnchor, start);
  if (dataStart === -1 || end === -1) {
    throw new Error('Daily Faceoff page layout changed: data array not found');
  }
  return html.slice(dataStart, end);
}

function parseDfoRecords(segment) {
  const records = segment.split(/},\s*\n\s*\{/);
  const out = [];
  for (const rec of records) {
    const name = /player: \{'logo': '[^']*', 'name': '([^']+)'\}/.exec(rec);
    const team = /team: \{'logo': '[^']*', 'name': '([^']+)'\}/.exec(rec);
    if (!name || !team) continue;
    const field = function (key) {
      const m = new RegExp('(?:^|[\\n\\r])\\s*' + key + ': (-?[\\d.,]+)', 'm').exec(rec);
      return num(m ? m[1] : null);
    };
    const pos = /(?:^|[\n\r])\s*Pos: "([^"]+)"/m.exec(rec);
    const altPos = /(?:^|[\n\r])\s*alt_pos: "([^"]+)"/m.exec(rec);
    const adpRaw = /(?:^|[\n\r])\s*adp: "([^"]*)"/m.exec(rec);
    const stats = {
      GP: field('GP'),
      G: field('G'), A: field('A'), PTS: field('PTS'), PPP: field('PPP'),
      '+/-': field('plus_minus'), PIM: field('PIM'), SOG: field('SOG'),
      HIT: field('HIT'), BLK: field('BLK'), FOW: field('FOW'),
      W: field('W'), L: field('L'), GA: field('GA'), SA: field('SA'),
      SV: field('SV'), 'SV%': field('Save_perc'), SO: field('SO'), GAA: field('GAA')
    };
    // Goalie rows key games as GS (starts); skaters use GP.
    if (stats.GP === null) stats.GP = field('GS');
    if (stats.GP === null) continue;
    // The page rounds Save_perc to one decimal (0.9); rebuild it from SV/SA.
    if (stats['SV%'] !== null && stats.SV !== null && stats.SA) {
      const precise = stats.SV / stats.SA;
      if (Math.abs(precise - stats['SV%']) < 0.051) stats['SV%'] = precise;
    }
    out.push({
      name: name[1].trim(),
      team: team[1].trim(),
      pos: normalizePositions((pos ? pos[1] : '') + ',' + (altPos ? altPos[1] : '')),
      adp: adpRaw ? num(adpRaw[1]) : null,
      gp: stats.GP,
      stats: stats
    });
  }
  return out;
}

/* ------------------------------------------------- pluggable fetch stage */

/* Fetch every source and hand back normalized rows per source id. Each source
 * is isolated: one failure only removes that voice from the blend. Returns
 * { rows: { sourceId: [row, ...] }, errors: { sourceId: message } }. */
async function fetchSourceRows() {
  const rows = {};
  const errors = {};

  const jobs = [
    // DtZ: skaters + goalies travel together -- if either tab moved, drop both.
    ['DTZ', async function () {
      const skaters = parseDtzSkaters(await fetchSheetCsv(DTZ_SHEET_ID, { sheet: DTZ_SKATER_SHEET }));
      const goalies = parseDtzGoalies(await fetchSheetCsv(DTZ_SHEET_ID, { sheet: DTZ_GOALIE_SHEET }));
      return skaters.concat(goalies);
    }],
    ['DFO', async function () {
      const html = await fetchText(DFO_URL);
      const skaters = parseDfoRecords(extractDfoSegment(html, 'skatersCatColumnDefs', 'goaliesCatColumnDefs'));
      const goalies = parseDfoRecords(extractDfoSegment(html, 'goaliesCatColumnDefs', 'allCatColumnDefs'));
      if (skaters.length < 300) throw new Error('DFO skater table looks truncated (' + skaters.length + ' rows)');
      if (goalies.length < 30) throw new Error('DFO goalie table looks truncated (' + goalies.length + ' rows)');
      return skaters.concat(goalies);
    }]
  ];
  for (const tab of AG_TABS) {
    jobs.push([tab.id, async function () {
      const csv = await fetchSheetCsv(AG_SHEET_ID, { gid: tab.gid });
      const parsed = parseAgSkaters(csv);
      if (parsed.length < 300) throw new Error('Apples & Ginos "' + tab.label + '" looks truncated (' + parsed.length + ' rows)');
      return parsed;
    }]);
  }

  await Promise.all(jobs.map(async function (job) {
    try {
      rows[job[0]] = await job[1]();
    } catch (err) {
      errors[job[0]] = err.message;
    }
  }));

  return { rows: rows, errors: errors };
}

/* ------------------------------------------------------- payload assembly */

/* Merge the normalized per-source rows into the payload shape
 * public/js/valuation.js createModel() consumes:
 *   { stats, counting_stats, rate_stats, sources, players: [{n, t, p, adp, s}] }
 * where s maps source id -> a value array aligned to STATS. */
function buildPayload(sourceRows, season) {
  const merged = new Map();

  for (const src of SOURCES) {
    const list = (sourceRows || {})[src.id] || [];
    for (const row of list) {
      const key = nameKey(row.name);
      if (!key) continue;
      let player = merged.get(key);
      if (!player) {
        player = { n: row.name.trim(), teamVotes: {}, pos: [], adps: [], s: {} };
        merged.set(key, player);
      }
      if (!player.s[src.id]) player.s[src.id] = row;

      // Team: tally every source's (tricode-mapped) opinion; the most-voted
      // value wins. DtZ and A&G already publish tricodes; DFO's full names
      // are mapped through DFO_TEAM_CODES first.
      let team = (row.team || '').trim();
      if (DFO_TEAM_CODES[team]) team = DFO_TEAM_CODES[team];
      if (team) player.teamVotes[team] = (player.teamVotes[team] || 0) + 1;

      for (const p of row.pos || []) {
        if (player.pos.indexOf(p) === -1) player.pos.push(p);
      }
      if (row.adp !== null && row.adp !== undefined) player.adps.push(row.adp);
    }
  }

  const players = [];
  for (const player of merged.values()) {
    const lines = player.s;
    const s = {};
    for (const sid in lines) {
      if (!Object.prototype.hasOwnProperty.call(lines, sid)) continue;
      const row = lines[sid];
      const arr = new Array(STATS.length).fill(null);
      for (let i = 0; i < STATS.length; i++) {
        const v = row.stats[STATS[i]];
        arr[i] = v === undefined ? null : v;
      }
      s[sid] = arr;
    }
    if (Object.keys(s).length === 0) continue;

    let bestTeam = '';
    let bestVotes = 0;
    for (const team in player.teamVotes) {
      if (player.teamVotes[team] > bestVotes) { bestVotes = player.teamVotes[team]; bestTeam = team; }
    }

    // ADP: average the sources that publish one (DtZ, DFO), rounded to 0.1;
    // sources without ADP (A&G) drop out of the mean rather than pull it.
    let adp = null;
    if (player.adps.length) {
      const mean = player.adps.reduce(function (a, b) { return a + b; }, 0) / player.adps.length;
      const rounded = round(mean, 1);
      adp = { average: rounded, yahoo: rounded };
    }

    players.push({
      n: player.n,
      t: bestTeam,
      p: player.pos,
      adp: adp,
      s: s
    });
  }

  return {
    stats: STATS.slice(),
    counting_stats: COUNTING_STATS.slice(),
    rate_stats: RATE_STATS.slice(),
    sources: SOURCES.map(function (s) { return { id: s.id, name: s.name }; }),
    players: players,
    meta: { season: season || null }
  };
}

/* ---------------------------------------------------- compute + serialize */

function computeBoard(payload, config) {
  const model = Valuation.createModel(payload);
  const settings = {
    scoring: SCORING,
    weights: SOURCE_WEIGHTS,
    slots: (config.league && config.league.slots) || DEFAULT_CONFIG.league.slots,
    teams: (config.league && config.league.teams) || DEFAULT_CONFIG.league.teams,
    adpSource: (config.model && config.model.adp_source) || 'average',
    eligibility: (config.model && config.model.eligibility) || null,
    gpModel: 'totals',
    replacementMethod: 'draft',
    countBench: true,
    tierK: 1.0,
    minGP: 0,
    drafted: {},
    dynamic: false
  };
  return Valuation.compute(model, settings);
}

/* Source positions (C/LW/RW/D/G) -> the board's C/F buckets. Wingers become
 * Forward; dual C/W stays ["C","F"], per the repo's C/F league convention. */
function toLeaguePositions(pos) {
  const out = [];
  for (const p of pos || []) {
    const mapped = (p === 'LW' || p === 'RW') ? 'F' : p;
    if (mapped === 'F' || mapped === 'C' || mapped === 'D' || mapped === 'G') {
      if (out.indexOf(mapped) === -1) out.push(mapped);
    }
  }
  return out;
}

function currentSeason(now) {
  const d = now || new Date();
  const year = d.getFullYear();
  const start = d.getMonth() >= 6 ? year : year - 1; // July onwards = new season
  return start + '-' + String((start + 1) % 100).padStart(2, '0');
}

function serializeBoard(payload, result, config, marks, sourceLabel) {
  const byName = {};
  for (const p of payload.players) byName[nameKey(p.n)] = p;

  const players = result.rows.map(function (row) {
    const payloadPlayer = byName[nameKey(row.name)] || {};
    const leaguePos = toLeaguePositions(payloadPlayer.p || []);
    return {
      id: row.id,
      rank: row.rank,
      n: row.name,
      t: row.team || '',
      p: leaguePos,
      rawPos: (payloadPlayer.p || []).slice(),
      posLabel: leaguePos.join('/'),
      tier: (row.bestPos || '') + (row.tier || 1),
      prnk: row.prnk || '',
      vorp: round(row.vorp, 2),
      rawVorp: round(row.vorp, 2),
      adjVorp: round(row.vorp, 2),
      dropoff: round(row.dropoff || 0, 2),
      fp: round(row.fp, 2),
      fpg: round(row.gp ? row.fp / row.gp : 0, 3),
      gp: round(row.gp, 1),
      adp: payloadPlayer.adp || null,
      mark: (marks && marks[nameKey(row.name)]) || ''
    };
  });

  return {
    meta: {
      season: payload.meta.season || currentSeason(),
      source: sourceLabel,
      count: players.length
    },
    config: config,
    players: players
  };
}

/* ------------------------------------------------------------------- write */

/* Write the refreshed board to both copies only after the whole JSON string
 * exists, and swap each file in atomically (tmp + rename). If anything throws
 * before this point the previous board is untouched on disk. */
function writeBoard(board, dataFile, publicFile) {
  const text = JSON.stringify(board, null, 2);
  const targets = [dataFile, publicFile || dataFile];
  for (const target of targets) {
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, target);
  }
  return text.length;
}

/* -------------------------------------------------------------- pipeline */

const SOURCE_LABEL = 'Automated scrape: DtZ + Daily Faceoff (5v5) + Apples & Ginos (Nate, Blake) — C and F league';

/* Rebuild the board end to end. `options.fetchSources` and `options.readFile`
 * are injectable so tests can exercise the pipeline offline. */
async function runRefresh(options) {
  const opts = options || {};
  const fetchSources = opts.fetchSources || fetchSourceRows;
  const readFile = opts.readFile || function (file) { return fs.readFileSync(file, 'utf8'); };

  // Previous board: config, season, and the owner's hand-entered marks
  // ('watch' / 'avoid') all survive a re-scrape.
  let previous = null;
  try {
    previous = JSON.parse(readFile(DATA_FILE));
  } catch (err) {
    previous = null;
  }
  const config = (previous && previous.config) || DEFAULT_CONFIG;
  const season = (previous && previous.meta && previous.meta.season) || currentSeason();
  const marks = {};
  if (previous && previous.players) {
    for (const p of previous.players) {
      if (p.mark) marks[nameKey(p.n)] = p.mark;
    }
  }

  const fetched = await fetchSources();
  const fetchedIds = Object.keys(fetched.rows).filter(function (id) {
    return fetched.rows[id] && fetched.rows[id].length > 0;
  });
  if (!fetchedIds.length) {
    const detail = Object.keys(fetched.errors).map(function (id) {
      return id + ': ' + fetched.errors[id];
    }).join('; ') || 'no sources fetched';
    throw new Error('Refresh aborted - every source failed (' + detail + ')');
  }

  const payload = buildPayload(fetched.rows, season);
  if (!payload.players.length) {
    throw new Error('Refresh aborted - no usable player rows after parsing');
  }
  const result = computeBoard(payload, config);
  const board = serializeBoard(payload, result, config, marks, SOURCE_LABEL);

  // Either the tests' writeFile hook or the real atomic dual-write.
  const bytes = opts.writeFile !== undefined
    ? opts.writeFile(board)
    : writeBoard(board, DATA_FILE, PUBLIC_DATA_FILE);

  return {
    meta: board.meta,
    config: board.config,
    players: board.players,
    sourcesUsed: fetchedIds,
    sourceErrors: fetched.errors,
    bytes: bytes
  };
}

module.exports = {
  STATS: STATS,
  COUNTING_STATS: COUNTING_STATS,
  RATE_STATS: RATE_STATS,
  SOURCES: SOURCES,
  SOURCE_WEIGHTS: SOURCE_WEIGHTS,
  SCORING: SCORING,
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  DATA_FILE: DATA_FILE,
  PUBLIC_DATA_FILE: PUBLIC_DATA_FILE,
  nameKey: nameKey,
  num: num,
  round: round,
  normalizePositions: normalizePositions,
  parseCsv: parseCsv,
  parseDtzSkaters: parseDtzSkaters,
  parseDtzGoalies: parseDtzGoalies,
  parseAgSkaters: parseAgSkaters,
  parseDfoRecords: parseDfoRecords,
  extractDfoSegment: extractDfoSegment,
  buildPayload: buildPayload,
  computeBoard: computeBoard,
  serializeBoard: serializeBoard,
  toLeaguePositions: toLeaguePositions,
  writeBoard: writeBoard,
  fetchSourceRows: fetchSourceRows,
  runRefresh: runRefresh,
  currentSeason: currentSeason
};

/* -------------------------------------------------------------------- CLI */

if (require.main === module) {
  const t0 = Date.now();
  runRefresh()
    .then(function (result) {
      const used = result.sourcesUsed.join(', ');
      const warned = Object.keys(result.sourceErrors);
      console.log('[scrape] refreshed board: ' + result.meta.count + ' players from ' + used);
      console.log('[scrape] meta: ' + JSON.stringify(result.meta));
      if (warned.length) {
        console.warn('[scrape] source warnings: ' + warned.map(function (id) {
          return id + ' (' + result.sourceErrors[id] + ')';
        }).join('; '));
      }
      console.log('[scrape] wrote ' + result.bytes + ' bytes to draft_data.json and public/draft_data.json in ' + (Date.now() - t0) + 'ms');
    })
    .catch(function (err) {
      console.error('[scrape] FAILED - previous board left untouched:', err && err.message);
      process.exit(1);
    });
}
