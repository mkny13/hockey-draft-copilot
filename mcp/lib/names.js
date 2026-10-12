// Name, team and id helpers. Players are keyed on the NHL playerId everywhere;
// names are only used for free-text lookup.

const NICKNAMES = [
  ['alex', 'alexander'], ['matt', 'matthew'], ['mitch', 'mitchell'], ['zach', 'zachary'],
  ['nick', 'nicholas'], ['mike', 'michael'], ['josh', 'joshua'], ['sam', 'samuel'],
];

const TEAM_ALIASES = {
  TB: 'TBL', 'T.B': 'TBL', LA: 'LAK', 'L.A': 'LAK', NJ: 'NJD', 'N.J': 'NJD', SJ: 'SJS', 'S.J': 'SJS',
  UTAH: 'UTA', UTH: 'UTA', MON: 'MTL', WAS: 'WSH', CLS: 'CBJ', NAS: 'NSH',
};

function normalize(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTeam(t) {
  if (t == null || t === '') return null;
  const u = String(t).trim().toUpperCase().replace(/\.$/, '');
  return TEAM_ALIASES[u] || u;
}

// NHL teamAbbrevs is comma-joined for mid-season trades; the current team is last.
function lastTeam(abbrevs) {
  if (!abbrevs) return null;
  const parts = String(abbrevs).split(',');
  return normalizeTeam(parts[parts.length - 1]);
}

function firstNameVariants(first) {
  const out = new Set([first]);
  for (const [a, b] of NICKNAMES) {
    if (first === a) out.add(b);
    if (first === b) out.add(a);
  }
  return [...out];
}

// players: [{ playerId, name, team, pos, lastName? }]
function buildIndex(players) {
  return players.map((p) => {
    const full = normalize(p.name);
    const last = p.lastName ? normalize(p.lastName) : full.split(' ').slice(1).join(' ');
    return { ...p, _full: full, _last: last };
  });
}

function scoreCandidate(c, q) {
  if (c._full === q) return 1.0;
  const parts = q.split(' ');
  if (parts.length > 1) {
    const rest = parts.slice(1).join(' ');
    for (const v of firstNameVariants(parts[0])) {
      if (v !== parts[0] && `${v} ${rest}` === c._full) return 0.8;
    }
  }
  if (c._last === q) return 0.6;
  if (c._full.includes(q)) return 0.4;
  return 0;
}

function lookup(index, query, { team, limit = 5 } = {}) {
  const q = normalize(query);
  const t = normalizeTeam(team);
  const warnings = [];
  if (!q) return { matches: [], warnings: ['empty query'] };
  const scored = [];
  for (const c of index) {
    if (t && c.team !== t) continue;
    const score = scoreCandidate(c, q);
    if (score > 0) scored.push({ ...c, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.gp || 0) - (a.gp || 0) || a.name.localeCompare(b.name));
  const matches = scored.slice(0, limit).map(({ _full, _last, ...rest }) => rest);
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    warnings.push(`ambiguous: ${scored.filter((s) => s.score === scored[0].score).length} players tie at score ${scored[0].score}; candidates returned, not guessed`);
  }
  return { matches, warnings, ambiguous: warnings.length > 0 };
}

module.exports = { normalize, normalizeTeam, lastTeam, buildIndex, lookup, TEAM_ALIASES, NICKNAMES };
