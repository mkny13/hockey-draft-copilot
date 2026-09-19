/**
 * Mock draft simulator: the Co-Pilot's recommended pick for one team, ESPN ADP
 * (with noise) for the other seven. Scores each team's best starting lineup.
 *
 *   node scripts/mock_draft.js --slot 5 --verbose          one draft, full log
 *   node scripts/mock_draft.js --slots 1-8 --sims 20       Monte Carlo per slot
 *
 * For every sim the same opponent noise is reused for a "pure ADP" run of our
 * slot, so the lineup-points difference isolates what the engine adds.
 */
const fs = require('fs');
const path = require('path');
const GT = require('../public/js/gametheory.js');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'draft_data.json'), 'utf8'));
const players = data.players;
const slotsCfg = data.config.league.slots;
const TEAMS = data.config.league.teams;
const ROUNDS = Object.values(slotsCfg).reduce((a, b) => a + b, 0);
const LIMITS = {
  C: slotsCfg.C, F: slotsCfg.F, D: slotsCfg.D, G: slotsCfg.G,
  UTIL: slotsCfg.UTIL || 0,
  FLEX: (slotsCfg.UTIL || 0) + (slotsCfg.BN || 0)
};
const ADP_NOISE = 7.0;

function args() {
  const a = { slot: 5, slots: null, sims: 1, verbose: false, seed: 1 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--slot') a.slot = +argv[++i];
    else if (argv[i] === '--slots') { const [lo, hi] = argv[++i].split('-').map(Number); a.slots = [lo, hi]; }
    else if (argv[i] === '--sims') a.sims = +argv[++i];
    else if (argv[i] === '--seed') a.seed = +argv[++i];
    else if (argv[i] === '--verbose') a.verbose = true;
  }
  return a;
}

function espnAdp(p) {
  const a = p.adp || {};
  return a.espn || a.average || a.yahoo || 999;
}

// Best starting lineup fantasy points: G, D, then C, F (C-eligible fill F), UTIL from leftovers
function lineupPoints(team) {
  const pool = team.slice().sort((a, b) => b.fp - a.fp);
  const used = new Set();
  let total = 0;
  const take = (pred, n) => {
    let got = 0;
    for (const p of pool) {
      if (got >= n) break;
      if (used.has(p.n) || !pred(p)) continue;
      used.add(p.n); total += p.fp; got++;
    }
  };
  take((p) => p.p.includes('G'), slotsCfg.G);
  take((p) => p.p.includes('D'), slotsCfg.D);
  take((p) => p.posLabel === 'C' || p.posLabel === 'C/F', slotsCfg.C);
  take((p) => p.p.includes('F'), slotsCfg.F);
  take((p) => !p.p.includes('G'), slotsCfg.UTIL || 0);
  return total;
}

// One drafter: noisy private ADP view, and it fills starter needs like a real team
// (no position beyond starters + flex, and forced to fill open starters at the end).
function makePicker(rng, noise) {
  const view = new Map();
  players.forEach((p) => view.set(p.n, espnAdp(p) + (noise ? GT.gaussian(rng) * noise : 0)));
  return (drafted, roster) => {
    const counts = GT.getRosterCounts(roster.map((p) => ({ isMine: true, pos: p.p })), LIMITS);
    const flexLeft = LIMITS.FLEX - GT.getFlexUsed(counts, LIMITS);
    const need = ['C', 'F', 'D', 'G'].reduce((n, g) => n + Math.max(0, LIMITS[g] - counts[g]), 0);
    const forced = need >= ROUNDS - roster.length;
    let best = null;
    for (const p of players) {
      if (drafted.has(p.n)) continue;
      const g = p.p.includes('G') ? 'G' : p.p.includes('D') ? 'D' : p.p.includes('C') && counts.C < LIMITS.C ? 'C' : 'F';
      const open = counts[g] < LIMITS[g];
      if (forced ? !open : (!open && flexLeft <= 0)) continue;
      if (!best || view.get(p.n) < view.get(best.n)) best = p;
    }
    return best;
  };
}

function runDraft(slot, seed, useEngine, verbose) {
  // Independent noisy view per opponent; our ADP baseline reads the raw ESPN list
  const pickers = Array.from({ length: TEAMS }, (_, i) => makePicker(GT.mulberry32(seed * 100 + i), i + 1 === slot ? 0 : ADP_NOISE));
  const drafted = new Set();
  const teams = Array.from({ length: TEAMS }, () => []);
  const history = [];
  const mineNames = {};
  const draftedObj = {};

  for (let pick = 1; pick <= TEAMS * ROUNDS; pick++) {
    const { ownerSlot, round } = GT.getPickDetails(pick, TEAMS);
    let chosen;
    if (ownerSlot === slot && useEngine) {
      const counts = GT.getRosterCounts(history, LIMITS);
      const res = GT.evaluateBoard(players, {
        currentPick: pick, slot, teams: TEAMS, stdDev: ADP_NOISE,
        drafted: draftedObj, mine: mineNames, rosterCounts: counts, rosterLimits: LIMITS
      });
      const best = (res.liveProtocol && res.liveProtocol.bestPick) || res.availableRows[0];
      chosen = players.find((p) => p.n === best.name);
    } else {
      chosen = pickers[ownerSlot - 1](drafted, teams[ownerSlot - 1]);
    }
    drafted.add(chosen.n);
    teams[ownerSlot - 1].push(chosen);
    const mine = ownerSlot === slot;
    if (mine) mineNames[chosen.n] = true; else draftedObj[chosen.n] = true;
    history.push({ pickNumber: pick, name: chosen.n, pos: chosen.p, isMine: mine });
    if (verbose && mine) {
      console.log(`R${String(round).padStart(2)} #${String(pick).padStart(3)}  ${chosen.n.padEnd(22)} ${chosen.posLabel.padEnd(4)} VORP ${chosen.vorp.toFixed(0).padStart(4)}  ADP ${String(espnAdp(chosen)).padStart(5)}`);
    }
  }
  const scores = teams.map(lineupPoints);
  const mineScore = scores[slot - 1];
  const others = scores.filter((_, i) => i !== slot - 1);
  const rank = 1 + others.filter((s) => s > mineScore).length;
  const mix = { C: 0, F: 0, D: 0, G: 0 };
  teams[slot - 1].forEach((p) => { mix[p.p.includes('G') ? 'G' : p.p.includes('D') ? 'D' : p.posLabel === 'C' || p.posLabel === 'C/F' ? 'C' : 'F']++; });
  const first6 = teams[slot - 1].slice(0, 6).map((p) => p.posLabel);
  return { mineScore, meanOthers: others.reduce((a, b) => a + b, 0) / others.length, rank, mix, first6, roster: teams[slot - 1] };
}

const opt = args();

if (!opt.slots) {
  console.log(`Mock draft: slot ${opt.slot}/${TEAMS}, ${ROUNDS} rounds, seed ${opt.seed}\n`);
  const eng = runDraft(opt.slot, opt.seed, true, true);
  const adp = runDraft(opt.slot, opt.seed, false, false);
  console.log(`\nEngine lineup: ${eng.mineScore.toFixed(0)} pts, rank ${eng.rank}/${TEAMS}, avg opponent ${eng.meanOthers.toFixed(0)}`);
  console.log(`Pure ADP lineup (same slot/noise): ${adp.mineScore.toFixed(0)} pts, rank ${adp.rank}/${TEAMS}`);
  console.log('Roster mix:', JSON.stringify(eng.mix));
} else {
  console.log(`Monte Carlo: ${opt.sims} sims per slot, ${TEAMS} teams, ${ROUNDS} rounds\n`);
  console.log('slot | engine pts | ADP pts | edge  | edge>0 | engine rank | ADP rank | roster mix (C/F/D/G)');
  for (let slot = opt.slots[0]; slot <= opt.slots[1]; slot++) {
    let e = 0, a = 0, wins = 0, er = 0, ar = 0;
    const mix = { C: 0, F: 0, D: 0, G: 0 };
    for (let s = 0; s < opt.sims; s++) {
      const seed = opt.seed * 1000 + s;
      const eng = runDraft(slot, seed, true, false);
      const adp = runDraft(slot, seed, false, false);
      e += eng.mineScore; a += adp.mineScore; er += eng.rank; ar += adp.rank;
      if (eng.mineScore > adp.mineScore) wins++;
      Object.keys(mix).forEach((k) => { mix[k] += eng.mix[k]; });
    }
    const n = opt.sims;
    console.log(`${String(slot).padStart(4)} | ${(e / n).toFixed(0).padStart(10)} | ${(a / n).toFixed(0).padStart(7)} | ${((e - a) / n).toFixed(0).padStart(5)} | ${(100 * wins / n).toFixed(0).padStart(5)}% | ${(er / n).toFixed(1).padStart(11)} | ${(ar / n).toFixed(1).padStart(8)} | ${['C', 'F', 'D', 'G'].map((k) => (mix[k] / n).toFixed(1)).join('/')}`);
  }
}
