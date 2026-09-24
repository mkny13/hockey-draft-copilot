const assert = require('assert');
const GT = require('../public/js/gametheory.js');

console.log('Testing GameTheory Module (Enhanced C & F Edition)...');

// 1. Test normalCDF
const cdfMean = GT.normalCDF(20, 20, 7.0);
assert(Math.abs(cdfMean - 0.5) < 0.001, `CDF at mean should be 0.5, got ${cdfMean}`);

// Test pSurvive
const foxSurv = GT.pSurvive(12, 49.5, 7.0);
assert(foxSurv > 0.99, `Fox survival to 12 should be > 99%, got ${foxSurv}`);

const earlySurv = GT.pSurvive(12, 6, 7.0);
assert(earlySurv > 0.15 && earlySurv < 0.35, `Early pick survival should be ~24%, got ${earlySurv}`);
console.log('✓ Normal CDF & Survival probability calculations pass');

// 2. Test Snake Turn Schedule
assert.strictEqual(GT.getNextSnakePick(1, 5, 8), 5);
assert.strictEqual(GT.getNextSnakePick(4, 5, 8), 5);
assert.strictEqual(GT.getNextSnakePick(5, 5, 8), 12);
assert.strictEqual(GT.getNextSnakePick(6, 5, 8), 12);
assert.strictEqual(GT.getNextSnakePick(11, 5, 8), 12);
assert.strictEqual(GT.getNextSnakePick(12, 5, 8), 21);
assert.strictEqual(GT.getNextSnakePick(13, 5, 8), 21);
console.log('✓ Snake Draft Turn Schedule calculations pass');

// 3. Test isMyTurn
assert.strictEqual(GT.isMyTurn(5, 5, 8), true);
assert.strictEqual(GT.isMyTurn(6, 5, 8), false);
assert.strictEqual(GT.isMyTurn(12, 5, 8), true);
assert.strictEqual(GT.isMyTurn(21, 5, 8), true);
console.log('✓ Turn detector passes');

// 4. Test Cliff Alerts
assert.strictEqual(GT.getCliffAlert(25), 'CRITICAL CLIFF');
assert.strictEqual(GT.getCliffAlert(15), 'Tier Drop');
assert.strictEqual(GT.getCliffAlert(5), 'Flat');
console.log('✓ Cliff Alert classifications pass');

// 5. Test Game Theory Action Flags
assert.strictEqual(GT.classifyAction(true, false, 0.1, 20), 'DRAFTED');
assert.strictEqual(GT.classifyAction(false, true, 0.1, 20), 'MY TEAM');
assert.strictEqual(GT.classifyAction(false, false, 0.85, 5), 'WAIT (ADP Safe)');
assert.strictEqual(GT.classifyAction(false, false, 0.25, 18), 'MUST REACH (Cliff)');
assert.strictEqual(GT.classifyAction(false, false, 0.15, 8), 'NOW OR NEVER');
assert.strictEqual(GT.classifyAction(false, false, 0.50, 8), 'TARGET');
console.log('✓ Game Theory Action Flags pass');

// 6. Test C & F Multi-Position Optionality & Graded Diminishing Returns
const limits = { C: 3, F: 5, D: 4, G: 2 };
// Case A: 3 Centers drafted (C is full), 0 Forwards drafted
const rosterCountsA = { C: 3, F: 0, D: 0, G: 0 };
// Any Center (whether dual C/F or pure C) flexes into open F starting slots and receives 100% utility!
const multDraisaitl = GT.getDiminishingMultiplier(['C', 'F'], rosterCountsA, limits);
assert.strictEqual(multDraisaitl, 1.0, 'Dual C, F player must NOT be diminished when F is open');

const multPureC = GT.getDiminishingMultiplier(['C'], rosterCountsA, limits);
assert.strictEqual(multPureC, 1.0, 'Center player flexes into Forward (F) starting slot at 100% utility');

// Case B: Both C and F starters are full (3 Centers + 5 Forwards = 8 starters)
const rosterCountsFullStarters = { C: 3, F: 5, D: 0, G: 0 };
const multNinthForward = GT.getDiminishingMultiplier(['C'], rosterCountsFullStarters, limits);
assert.strictEqual(multNinthForward, 0.85, 'Center receives 0.85 primary bench discount once both C and F slots are full');

// Case C: Overfilled bench
const rosterCountsOverfull = { C: 4, F: 6, D: 4, G: 2 };
const multOverfull = GT.getDiminishingMultiplier(['C', 'F'], rosterCountsOverfull, limits);
assert(multOverfull < 0.85, 'Dual player diminishes further when bench is deep');
console.log('✓ C & F Multi-position optionality and graded diminishing returns pass (C counts as F)');

// 7. Test Generalized EVONA Comparator
const pA = { name: 'Adam Fox', rawVorp: 129.68, adjVorp: 129.68, dropoff: 3.95, adp: 49.5 };
const pB = { name: 'Cale Makar', rawVorp: 205.75, adjVorp: 205.75, dropoff: 15.80, adp: 7.5 };
const cmp = GT.comparePlayersGameTheory(pA, pB, null, null, 5, 7.0);
console.log('Comparator verdict sample:', cmp.verdict);
assert(cmp !== null);
assert(typeof cmp.deltaEV === 'number');
assert.strictEqual(cmp.waitOnA, true, 'At pick 5 with target pick 5, Adam Fox (ADP 49.5) should be waited on');
console.log('✓ Generalized EVONA Trade-off evaluator passes');

// 8. Test Automated Multi-Candidate Trade-Offs (Pick 5 scenario)
const fs = require('fs');
const path = require('path');
const rawData = JSON.parse(fs.readFileSync(path.join(__dirname, '../draft_data.json'), 'utf8'));

const draftedPick5 = {
  'Connor McDavid': true,
  'Nathan MacKinnon': true,
  'Nikita Kucherov': true,
  'Macklin Celebrini': true
};

const resPick5 = GT.evaluateBoard(rawData.players, {
  currentPick: 5,
  slot: 5,
  teams: 8,
  drafted: draftedPick5,
  mine: {},
  rosterCounts: { C: 0, F: 0, D: 0, G: 0 },
  rosterLimits: { C: 3, F: 5, D: 4, G: 2 }
});

assert(resPick5.shortlist.length > 0, 'Shortlist must not be empty');
const pick5Best = resPick5.shortlist[0];
console.log(`Pick 5 Top Shortlist Recommendation: ${pick5Best.name} (${pick5Best.posLabel})`);
assert(pick5Best.gtTradeoff, 'Candidate must have attached gtTradeoff');
assert(pick5Best.gtTradeoff.netGain > 10.0, `Top pick net EV gain should be > 10, got ${pick5Best.gtTradeoff.netGain}`);
assert(pick5Best.gtTradeoff.advice.startsWith(pick5Best.name), 'Advice must name the recommended player');
assert(resPick5.shortlist.slice(1).every((c) => c.gtTradeoff.netGain <= pick5Best.gtTradeoff.netGain), 'Top pick must hold the largest 2-round EV edge');
console.log('✓ Automated multi-candidate trade-off identifies the 2-round EV optimal pick at Pick 5');

// 9. Test Top Matchup for Comparator
assert(resPick5.topMatchup, 'Top matchup must be generated');
assert(resPick5.topMatchup.playerA && resPick5.topMatchup.playerB, 'Top matchup must name both players');
assert(Number.isFinite(resPick5.topMatchup.cmp.deltaEV), 'Top matchup must carry a numeric deltaEV');
console.log('✓ Top Matchup automatically identifies board dilemma');

// 10. Test Pick 1 (Empty Board) Integrity: McDavid must be #1
const resPick1 = GT.evaluateBoard(rawData.players, {
  currentPick: 1,
  slot: 1,
  teams: 8,
  drafted: {},
  mine: {},
  rosterCounts: { C: 0, F: 0, D: 0, G: 0 },
  rosterLimits: { C: 3, F: 5, D: 4, G: 2 }
});

assert.strictEqual(resPick1.shortlist[0].name, 'Connor McDavid', 'Connor McDavid must be strictly #1 at Pick 1');
assert(resPick1.shortlist[0].gtTradeoff.advice.includes('dominant overall board value'), 'McDavid advice must acknowledge dominant board value');
assert(resPick1.shortlist.every((c) => c.gtTradeoff.advice.startsWith(c.name)), 'Every trade-off advice line must name its player');
// Fallback logic: never the other side of the matchup, and weighted by survival
const altPool = [
  { name: 'C1', pos: ['C', 'F'], adjVorp: 200, survivalProb: 0.0 },
  { name: 'C2', pos: ['C', 'F'], adjVorp: 190, survivalProb: 0.0 },
  { name: 'C3', pos: ['C', 'F'], adjVorp: 150, survivalProb: 1.0 },
  { name: 'W1', pos: ['F'], adjVorp: 300, survivalProb: 1.0 }
];
const altForC1 = GT.findNextAlt(altPool, altPool[0], ['C2']);
assert.strictEqual(altForC1.adjVorp, 150, 'Fallback skips the matchup partner and players who will be gone, and ignores other positions');
assert.strictEqual(GT.findNextAlt([altPool[0]], altPool[0], []), null, 'No fallback when nobody else is left');
console.log('✓ findNextAlt fallback passes');

// Pick 1 on the clock at slot 1: order follows VORP through the top of the board
const top3ByVorp = rawData.players.slice().sort((a, b) => b.vorp - a.vorp).slice(0, 3).map((p) => p.n);
assert.deepStrictEqual(resPick1.shortlist.slice(0, 3).map((c) => c.name), top3ByVorp, 'Pick 1 shortlist follows board value');
// Shortlist order must not depend on the order rows arrive in (strict total order)
const orderOpts = { currentPick: 1, slot: 5, teams: 8, drafted: {}, mine: {}, rosterCounts: { C: 0, F: 0, D: 0, G: 0 }, rosterLimits: { C: 2, F: 6, D: 6, G: 2 } };
const shuffled = rawData.players.slice().sort((a, b) => ((a.id * 7919) % 101) - ((b.id * 7919) % 101));
const orderA = GT.evaluateBoard(rawData.players, orderOpts).shortlist.map((c) => c.name);
const orderB = GT.evaluateBoard(shuffled, orderOpts).shortlist.map((c) => c.name);
assert.deepStrictEqual(orderA, orderB, 'Shortlist must be identical for any input row order');
console.log('✓ Shortlist order is input-order independent');

console.log('✓ Pick 1 board integrity verified: McDavid strictly dominant at #1');

// 11. Test Post-Draft Roster Grader (VORP surplus, ADP Delta steals, positional balance)
const synthPlayers = [
  { name: 'Alpha', vorp: 200, adp: { average: 1 }, pos: ['C'] },
  { name: 'Bravo', vorp: 150, adp: { average: 2 }, pos: ['F'] },
  { name: 'Charlie', vorp: 120, adp: { average: 3 }, pos: ['D'] },
  { name: 'Delta', vorp: 100, adp: { average: 4 }, pos: ['G'] },
  { name: 'Echo', vorp: 80, adp: { average: 5 }, pos: ['C', 'F'] },
  { name: 'Foxtrot', vorp: 60, adp: { average: 6 }, pos: ['D'] },
  { name: 'Golf', vorp: 40, adp: { average: 7 }, pos: ['F'] },
  { name: 'Hotel', vorp: 20, adp: { average: 8 }, pos: ['G'] }
];

const synthHistory = [
  { pickNumber: 1, name: 'Alpha', pos: ['C'], isMine: true },
  { pickNumber: 2, name: 'Echo', pos: ['C', 'F'], isMine: true },
  { pickNumber: 3, name: 'Foxtrot', pos: ['D'], isMine: true },
  { pickNumber: 4, name: 'Golf', pos: ['F'], isMine: false }
];

const grade1 = GT.gradeDraft(synthHistory, synthPlayers, { rosterLimits: { C: 3, F: 5, D: 4, G: 2 } });

assert.strictEqual(grade1.graded, true, 'Draft with my picks must be graded');
assert.strictEqual(grade1.summary.picksCount, 3, 'Only my picks count toward the grade');
// Expected VORP per slot = VORP of the Nth player on the ADP-ordered board
assert.strictEqual(grade1.myPicks[0].expectedVorp, 200, 'Pick 1 expected VORP = Alpha (ADP 1)');
assert.strictEqual(grade1.myPicks[1].expectedVorp, 150, 'Pick 2 expected VORP = Bravo (ADP 2)');
assert.strictEqual(grade1.myPicks[2].expectedVorp, 120, 'Pick 3 expected VORP = Charlie (ADP 3)');
// Surplus = captured - expected
assert.strictEqual(grade1.myPicks[0].surplus, 0, 'Alpha at pick 1 is ADP-fair (0 surplus)');
assert.strictEqual(grade1.myPicks[1].surplus, -70, 'Echo at pick 2 is a 70 VORP reach');
assert.strictEqual(grade1.myPicks[2].surplus, -60, 'Foxtrot at pick 3 is a 60 VORP reach');
assert.strictEqual(grade1.summary.totalCapturedVorp, 340, 'Total captured VORP = 200+80+60');
assert.strictEqual(grade1.summary.totalExpectedVorp, 470, 'Total expected VORP = 200+150+120');
assert.strictEqual(grade1.summary.totalSurplus, -130, 'Total surplus = -130');
// ADP Delta = ADP - pickNumber
assert.strictEqual(grade1.myPicks[1].adpDelta, 3, 'Echo ADP 5 at pick 2 = +3 delta');
assert.strictEqual(grade1.myPicks[0].adpDelta, 0, 'Alpha ADP 1 at pick 1 = 0 delta');
console.log('✓ Post-draft grading computes VORP surplus vs expected value per slot');

// Steals ranked by ADP Delta across the entire draft (ties broken by VORP)
assert.strictEqual(grade1.steals[0].name, 'Echo', 'Echo (+3, VORP 80) ranks above Foxtrot (+3, VORP 60)');
assert.strictEqual(grade1.steals[1].name, 'Foxtrot', 'Foxtrot (+3 delta) is second steal');
assert(grade1.steals.every(s => s.adpDelta > 0), 'Steals list must only contain positive ADP Delta picks');
console.log('✓ ADP Delta steal ranking passes');

// Positional balance: C-only and dual C,F fill C first, then flex to F
const bal1 = grade1.positionalBalance;
assert.strictEqual(bal1.counts.C, 2, 'Alpha (C) + Echo (dual C,F) fill C slots first');
assert.strictEqual(bal1.counts.F, 0, 'No F slots used while C is open');
assert.strictEqual(bal1.counts.D, 1, 'Foxtrot fills one D slot');
assert.strictEqual(bal1.counts.G, 0, 'No goalies drafted');
assert.strictEqual(bal1.slots.find(s => s.pos === 'G').status, 'EMPTY (critical)', 'Empty G position flagged critical');
assert.strictEqual(bal1.slots.find(s => s.pos === 'D').status, 'LIGHT', 'Under-limit D position flagged LIGHT');
console.log('✓ Positional balance counting and C/F flex logic passes');

// Filled-roster balance verdict
const filledHistory = [
  { pickNumber: 1, name: 'Alpha', pos: ['C'], isMine: true },
  { pickNumber: 2, name: 'Bravo', pos: ['F'], isMine: true },
  { pickNumber: 3, name: 'Charlie', pos: ['D'], isMine: true },
  { pickNumber: 4, name: 'Delta', pos: ['G'], isMine: true }
];
// limits C:1 F:1 D:1 G:1 -> everything filled
const grade2 = GT.gradeDraft(filledHistory, synthPlayers, { rosterLimits: { C: 1, F: 1, D: 1, G: 1 } });
assert.strictEqual(grade2.positionalBalance.slots.every(s => s.status === 'FILLED'), true, 'All slots FILLED');
assert(grade2.positionalBalance.verdict.indexOf('Balanced') === 0, 'Verdict reports balanced roster');
console.log('✓ Balanced roster verdict passes');

// Empty draft history degrades gracefully
const gradeEmpty = GT.gradeDraft([], synthPlayers, { rosterLimits: { C: 3, F: 5, D: 4, G: 2 } });
assert.strictEqual(gradeEmpty.graded, false, 'Empty history must not be graded');
assert.strictEqual(gradeEmpty.summary.grade, null, 'Empty history has no letter grade');
assert.strictEqual(gradeEmpty.summary.totalCapturedVorp, 0, 'Empty history captures nothing');
console.log('✓ Empty draft history handled gracefully');

// Real-board sanity: grade a fixed 4-pick history (never the live draft_state.json, which changes during a draft)
const fixedHistory = [
  { pickNumber: 1, name: 'Connor McDavid', team: 'EDM', pos: ['C', 'F'], isMine: false },
  { pickNumber: 2, name: 'Nathan MacKinnon', team: 'COL', pos: ['C', 'F'], isMine: false },
  { pickNumber: 3, name: 'Nikita Kucherov', team: 'TBL', pos: ['F'], isMine: false },
  { pickNumber: 4, name: 'Cale Makar', team: 'COL', pos: ['D'], isMine: false }
];
const gradeReal = GT.gradeDraft(fixedHistory, rawData.players, { rosterLimits: { C: 2, F: 6, D: 6, G: 2 } });
assert.strictEqual(gradeReal.picks.length, fixedHistory.length, 'Every recorded pick is graded');
assert.strictEqual(gradeReal.summary.picksCount, 0, 'None of the fixed picks are mine');
console.log('✓ Real draft board grading sanity passes');

// 12. Monte Carlo: seeded gaussian noise follows N(0, 1)
const rngNoise = GT.mulberry32(42);
const noiseSamples = [];
for (let ns = 0; ns < 20000; ns++) noiseSamples.push(GT.gaussian(rngNoise));
const noiseMean = noiseSamples.reduce((a, b) => a + b, 0) / noiseSamples.length;
const noiseStd = Math.sqrt(
  noiseSamples.reduce((a, b) => a + (b - noiseMean) * (b - noiseMean), 0) / noiseSamples.length
);
assert(Math.abs(noiseMean) < 0.05, `Gaussian sample mean should be ~0, got ${noiseMean}`);
assert(Math.abs(noiseStd - 1) < 0.05, `Gaussian sample std should be ~1, got ${noiseStd}`);

// Noisy ADP observations: N(mean, std^2)
const rngAdp = GT.mulberry32(1234);
const adpObs = [];
for (let ao = 0; ao < 20000; ao++) adpObs.push(GT.sampleNormalNoise(50, 7, rngAdp));
const adpMean = adpObs.reduce((a, b) => a + b, 0) / adpObs.length;
const adpStd = Math.sqrt(
  adpObs.reduce((a, b) => a + (b - adpMean) * (b - adpMean), 0) / adpObs.length
);
assert(Math.abs(adpMean - 50) < 0.4, `Noisy ADP mean should be ~50, got ${adpMean}`);
assert(Math.abs(adpStd - 7) < 0.35, `Noisy ADP std should be ~7, got ${adpStd}`);
console.log('✓ Monte Carlo normal-distribution ADP noise passes');

// 13. Monte Carlo simulation: determinism, extremes, convergence, monotonicity
const mcPlayers = [];
for (let mp = 0; mp < 100; mp++) {
  mcPlayers.push({
    id: mp,
    name: 'SimP' + (mp + 1),
    n: 'SimP' + (mp + 1),
    vorp: 200 - mp * 2,
    rawVorp: 200 - mp * 2,
    pos: ['F'],
    adp: { average: mp + 1 }
  });
}

// Determinism: identical seeds produce identical results
const runA = GT.runMonteCarlo(mcPlayers, { teams: 8, slot: 5, currentPick: 1, seed: 7, targets: ['SimP25'] }, 5, 300);
const runB = GT.runMonteCarlo(mcPlayers, { teams: 8, slot: 5, currentPick: 1, seed: 7, targets: ['SimP25'] }, 5, 300);
assert.deepStrictEqual(runA.targets[0].roundSurvival, runB.targets[0].roundSurvival, 'Same seed must reproduce identical survival probabilities');
console.log('✓ Monte Carlo seeded determinism passes');

// Early target (ADP 1) never survives to round 3 (my pick #21 in an 8-team draft)
const mcEarly = GT.runMonteCarlo(mcPlayers, { teams: 8, slot: 5, currentPick: 1, seed: 11, targets: ['SimP1'] }, 5, 500);
assert(mcEarly.targets[0].roundSurvival[3] < 0.05, `ADP-1 target survival to round 3 must be ~0, got ${mcEarly.targets[0].roundSurvival[3]}`);
console.log('✓ Monte Carlo early-target extinction passes');

// Deep sleeper (ADP 100) always survives to round 3
const mcDeep = GT.runMonteCarlo(mcPlayers, { teams: 8, slot: 5, currentPick: 1, seed: 11, targets: ['SimP100'] }, 5, 500);
assert(mcDeep.targets[0].roundSurvival[3] > 0.98, `ADP-100 sleeper must survive to round 3, got ${mcDeep.targets[0].roundSurvival[3]}`);
console.log('✓ Monte Carlo deep-sleeper survival passes');

// Mid target: monotone non-increasing survival across rounds 3 → 4 → 5
const mcMid = GT.runMonteCarlo(mcPlayers, { teams: 8, slot: 5, currentPick: 1, seed: 21, targets: ['SimP25'] }, 5, 500);
const p3 = mcMid.targets[0].roundSurvival[3];
const p4 = mcMid.targets[0].roundSurvival[4];
const p5 = mcMid.targets[0].roundSurvival[5];
assert(p3 >= p4 && p4 >= p5, `Round survival must be non-increasing (r3 ${p3} >= r4 ${p4} >= r5 ${p5})`);
assert(p3 > 0.05 && p3 < 0.95, `Mid-ADP target round-3 survival should be interior, got ${p3}`);
console.log('✓ Monte Carlo round monotonicity passes');

// Convergence: independent seeds converge toward the same estimate
const convA = GT.runMonteCarlo(mcPlayers, { teams: 8, slot: 5, currentPick: 1, seed: 101, targets: ['SimP25'] }, 5, 2000);
const convB = GT.runMonteCarlo(mcPlayers, { teams: 8, slot: 5, currentPick: 1, seed: 202, targets: ['SimP25'] }, 5, 2000);
const convDelta = Math.abs(convA.targets[0].roundSurvival[3] - convB.targets[0].roundSurvival[3]);
assert(convDelta < 0.06, `Independent 2000-sim runs must converge (Δ=${convDelta})`);
console.log(`✓ Monte Carlo convergence passes (independent estimates Δ=${convDelta.toFixed(3)})`);

// Noise application: larger ADP noise must decrease round-3 survival of a mid target
const mcTight = GT.runMonteCarlo(mcPlayers, { teams: 8, slot: 5, currentPick: 1, seed: 33, noiseStd: 1, targets: ['SimP25'] }, 5, 500);
const mcLoose = GT.runMonteCarlo(mcPlayers, { teams: 8, slot: 5, currentPick: 1, seed: 33, noiseStd: 40, targets: ['SimP25'] }, 5, 500);
assert(
  mcLoose.targets[0].roundSurvival[3] < mcTight.targets[0].roundSurvival[3] - 0.15,
  `Wider noise must erode round-3 survival (tight ${mcTight.targets[0].roundSurvival[3]} vs loose ${mcLoose.targets[0].roundSurvival[3]})`
);
console.log('✓ Monte Carlo ADP noise application passes');

// Mid-draft start: only upcoming rounds are tracked, past rounds are null
const mcMidDraft = GT.runMonteCarlo(mcPlayers, { teams: 8, slot: 5, currentPick: 12, seed: 7, targets: ['SimP25'] }, 5, 200);
assert(mcMidDraft.myPicks[1] === undefined, 'Round 1 pick is in the past and must not be scheduled');
assert.strictEqual(mcMidDraft.targets[0].roundSurvival[1], null, 'Past round survival must be null');
assert(typeof mcMidDraft.targets[0].roundSurvival[3] === 'number', 'Upcoming round 3 must have a probability');
assert.strictEqual(mcMidDraft.myPicks[3], 21, 'My round-3 pick in an 8-team slot-5 draft is overall pick #21');
console.log('✓ Monte Carlo mid-draft scheduling passes');

// 14. roundSurvivalProbabilities wrapper (per-round sleeper estimates)
const rsHughes = GT.roundSurvivalProbabilities('Quinn Hughes', [3, 4, 5], 500, {
  players: rawData.players,
  teams: 8,
  slot: 5,
  currentPick: 1,
  seed: 7
});
assert(rsHughes !== null, 'roundSurvivalProbabilities must resolve the target by name');
assert.strictEqual(rsHughes.name, 'Quinn Hughes');
assert(rsHughes.adp > 0, 'Target ADP must be resolved');
for (const rt of [3, 4, 5]) {
  const prob = rsHughes.rounds[rt];
  assert(typeof prob === 'number' && prob >= 0 && prob <= 1, `Round ${rt} probability must be in [0,1], got ${prob}`);
}
assert(
  rsHughes.rounds[3] >= rsHughes.rounds[4] && rsHughes.rounds[4] >= rsHughes.rounds[5],
  'Round survival must not increase with deeper rounds'
);
assert.strictEqual(rsHughes.myPicks[3], 21, 'myPicks must map round 3 to overall pick #21 (8 teams, slot 5)');

// Resolves by master row id as well as by name
const hughesRow = rawData.players.find(p => p.n === 'Quinn Hughes');
const rsById = GT.roundSurvivalProbabilities(hughesRow.id, [3], 200, {
  players: rawData.players, teams: 8, slot: 5, currentPick: 1, seed: 7
});
assert.strictEqual(rsById.name, 'Quinn Hughes', 'roundSurvivalProbabilities must resolve targets by row id');
console.log('✓ roundSurvivalProbabilities per-round sleeper estimates pass');

// Already-drafted targets report 0% survival everywhere
const rsDrafted = GT.roundSurvivalProbabilities('Quinn Hughes', [3, 4, 5], 200, {
  players: rawData.players,
  teams: 8,
  slot: 5,
  currentPick: 1,
  drafted: { 'Quinn Hughes': true },
  seed: 7
});
assert.strictEqual(rsDrafted.drafted, true, 'Drafted target must be flagged');
assert.strictEqual(rsDrafted.rounds[3], 0, 'Drafted target has 0% survival in every round');
console.log('✓ Drafted-target edge case passes');

// Real-board sanity: 500-sim run on the full 800+ player board stays in bounds
const tMcStart = Date.now();
const mcReal = GT.runMonteCarlo(rawData.players, {
  teams: 8, slot: 5, currentPick: 1, seed: 99,
  targets: ['Quinn Hughes', 'Leon Draisaitl', 'Connor McDavid']
}, 5, 500);
const mcRealElapsed = Date.now() - tMcStart;
assert.strictEqual(mcReal.simulations, 500);
assert.strictEqual(mcReal.targets.length, 3, 'All requested targets must be reported');
for (const tgt of mcReal.targets) {
  for (const rr of [3, 4, 5]) {
    const prob = tgt.roundSurvival[rr];
    assert(typeof prob === 'number' && prob >= 0 && prob <= 1, `${tgt.name} round ${rr} probability out of bounds: ${prob}`);
  }
}
// McDavid (ADP 1.6) must be gone by round 3; Draisaitl (early ADP) rarely survives either
assert(mcReal.targets[2].roundSurvival[3] < 0.05, 'McDavid cannot survive to round 3');
assert(mcReal.targets[1].roundSurvival[3] < 0.35, 'Draisaitl (early first-round ADP) rarely survives to round 3');
console.log(`✓ Real-board Monte Carlo sanity passes (${mcRealElapsed}ms for 500 sims)`);

// Overflow beyond starter slots: UTIL (one skater, full value), then bench (discounted), then nothing
const flexLimits = { C: 2, F: 6, D: 6, G: 2, UTIL: 1, FLEX: 6 };
assert.strictEqual(GT.getFlexUsed({ C: 2, F: 6, D: 8, G: 2 }, flexLimits), 2);
assert.strictEqual(GT.getDiminishingMultiplier(['D'], { C: 2, F: 6, D: 6, G: 2 }, flexLimits), 1.0, 'First overflow skater takes the UTIL slot at full value');
assert.strictEqual(GT.getDiminishingMultiplier(['G'], { C: 2, F: 6, D: 6, G: 2 }, flexLimits), 0.3, 'A goalie cannot use UTIL: bench value');
assert.strictEqual(GT.getDiminishingMultiplier(['D'], { C: 2, F: 6, D: 7, G: 2 }, flexLimits), 0.3, 'Once UTIL is used, extra skaters are bench depth');
assert.strictEqual(GT.getDiminishingMultiplier(['D'], { C: 2, F: 6, D: 12, G: 2 }, flexLimits), 0.35, 'Nothing left in the roster: value collapses');
assert.strictEqual(GT.getDiminishingMultiplier(['D'], { C: 2, F: 6, D: 3, G: 2 }, flexLimits), 1.0, 'Open starter slot: full value');
console.log('✓ Flex (UTIL + bench) pool passes');

// Must-fill: with as many picks left as open starter slots, only those groups matter
assert.strictEqual(GT.getMustFillGroups({ C: 2, F: 6, D: 6, G: 0, total: 19 }, flexLimits), null, 'Slack remains (3 picks, 2 open slots): no forcing');
assert.deepStrictEqual(GT.getMustFillGroups({ C: 2, F: 6, D: 6, G: 1, total: 21 }, flexLimits), ['G'], 'One pick left, one open G slot: forced');
assert.strictEqual(GT.getMustFillGroups({ C: 2, F: 6, D: 6, G: 2, total: 16 }, flexLimits), null, 'All starters filled');
const forced = GT.evaluateBoard(rawData.players, {
  currentPick: 169, slot: 5, teams: 8, drafted: {}, mine: {},
  rosterCounts: { C: 2, F: 6, D: 6, G: 1, total: 21 }, rosterLimits: flexLimits
});
assert(forced.shortlist[0].pos.includes('G'), 'With one pick left and an open G starter slot the top recommendation is a goalie');
console.log('✓ Must-fill starter logic passes');

// A discount must never make a negative-VORP player look better
const negRows = [
  { id: 1, name: 'Neg D', pos: ['D'], vorp: -8, dropoff: 0, rank: 1, adp: 100 },
  { id: 2, name: 'Pos G', pos: ['G'], vorp: 60, dropoff: 0, rank: 2, adp: 100 }
];
const negEval = GT.evaluateBoard(negRows, { currentPick: 100, slot: 4, teams: 8, drafted: {}, mine: {}, rosterCounts: { C: 2, F: 6, D: 9, G: 0, total: 17 }, rosterLimits: flexLimits });
const negD = negEval.allRows.find((r) => r.name === 'Neg D');
assert.strictEqual(negD.adjVorp, -8, 'Discounting a negative VORP must not raise it');

// Safe (high-survival) players are still recommended when worth more than every urgent option
assert.strictEqual(negEval.shortlist[0].name, 'Pos G', 'A safe goalie beats a replacement-level defenseman when nothing urgent is worth more');
console.log('✓ Negative-VORP discount and safe-star shortlist pass');

// Draft end: 8 teams x 22 rounds = 176 picks; nothing is "on the clock" afterwards
const doneOpts = { slot: 5, teams: 8, drafted: {}, mine: {}, rosterCounts: { C: 0, F: 0, D: 0, G: 0 }, rosterLimits: flexLimits };
const lastPick = GT.evaluateBoard(rawData.players, Object.assign({ currentPick: 176 }, doneOpts));
assert.strictEqual(lastPick.draftComplete, false, 'Pick 176 is still part of the draft');
const afterEnd = GT.evaluateBoard(rawData.players, Object.assign({ currentPick: 181 }, doneOpts));
assert.strictEqual(afterEnd.draftComplete, true);
assert.strictEqual(afterEnd.onTheClock, false, 'Nobody is on the clock once the draft is over');
assert(afterEnd.liveProtocol.headline.includes('Draft complete'));
console.log('✓ Draft-complete state passes');

// Roster complete: my 22 picks fill the 22-slot roster even though the room's
// counter never reached the end (the missing final pick must not matter)
const fullMine = {};
for (let i = 1; i <= 22; i++) fullMine['Roster Filler ' + i] = true;
const rosterDone = GT.evaluateBoard(rawData.players, {
  currentPick: 170, slot: 5, teams: 8,
  drafted: {}, mine: fullMine,
  rosterCounts: { C: 2, F: 6, D: 6, G: 2, total: 22 }, rosterLimits: flexLimits
});
assert.strictEqual(rosterDone.rosterComplete, true, '22 of my picks fill the 22-slot roster');
assert.strictEqual(rosterDone.draftComplete, false, 'Pick 170 is still inside the draft');
assert.strictEqual(rosterDone.onTheClock, false, 'A full roster is never on the clock');
assert.deepStrictEqual(rosterDone.shortlist, [], 'No recommendations once my roster is full');
assert.deepStrictEqual(rosterDone.redAlerts, [], 'No cliff alerts once my roster is full');
assert.deepStrictEqual(rosterDone.waitSafePlayers, [], 'No sleeper picks once my roster is full');
assert.strictEqual(rosterDone.picksUntilTurn, 0, 'No next turn to wait for');
assert.strictEqual(rosterDone.targetTurn, null, 'No next turn once my roster is full');
assert.strictEqual(rosterDone.liveProtocol.bestPick, null, 'No best pick once my roster is full');
assert(rosterDone.liveProtocol.headline.includes('roster is complete'));
console.log('✓ Roster-complete state passes');

// One slot short: recommendations continue exactly as before
const almostMine = {};
for (let i = 1; i <= 21; i++) almostMine['Roster Filler ' + i] = true;
const almostDone = GT.evaluateBoard(rawData.players, {
  currentPick: 170, slot: 5, teams: 8,
  drafted: {}, mine: almostMine,
  rosterCounts: { C: 2, F: 6, D: 6, G: 1, total: 21 }, rosterLimits: flexLimits
});
assert.strictEqual(almostDone.rosterComplete, false, '21 of 22 slots still leaves work to do');
assert(almostDone.shortlist.length > 0, 'Still recommending with a roster spot open');
console.log('✓ Near-complete roster keeps recommending');


// Roster counts: only my picks count; C spills to F once C slots are full
const rcLimits = { C: 1, F: 5, D: 4, G: 2 };
const rc = GT.getRosterCounts([
  { isMine: true, pos: ['C', 'F'] },
  { isMine: true, pos: ['C'] },
  { isMine: true, pos: ['D'] },
  { isMine: false, pos: ['G'] }
], rcLimits);
assert.deepStrictEqual(rc, { C: 1, F: 1, D: 1, G: 0, total: 3 }, 'Roster counts must ignore opponents and spill C into F');
assert.deepStrictEqual(GT.getRosterCounts([], rcLimits), { C: 0, F: 0, D: 0, G: 0, total: 0 });
console.log('✓ getRosterCounts passes');

// 15. Golden-snapshot tests: liveProtocol and shortlist order
const goldenLimits = { C: 2, F: 6, D: 6, G: 2, UTIL: 1, FLEX: 6 };
const goldenBoard = rawData.players.slice(0, 25);

// Branch 1: On the clock
const goldenClock = GT.evaluateBoard(goldenBoard, {
  currentPick: 5,
  slot: 5,
  teams: 8,
  drafted: {
    'Connor McDavid': true,
    'Nathan MacKinnon': true,
    'Nikita Kucherov': true,
    'Auston Matthews': true
  },
  mine: {},
  rosterCounts: { C: 0, F: 0, D: 0, G: 0 },
  rosterLimits: goldenLimits
});

assert.strictEqual(goldenClock.liveProtocol.headline, '🎯 GAME THEORY PICK: Draft Macklin Celebrini (C)');
assert.strictEqual(
  goldenClock.liveProtocol.subtext,
  'Macklin Celebrini (C): Locks in dominant overall board value (265.1 VORP). Miss him now and he will not survive to Turn #12.'
);
assert.strictEqual(goldenClock.liveProtocol.alertType, 'turn');
assert.strictEqual(goldenClock.liveProtocol.step, 3);
assert.deepStrictEqual(
  goldenClock.shortlist.slice(0, 5).map((p) => p.name),
  ['Macklin Celebrini', 'Leon Draisaitl', 'David Pastrnak', 'Jason Robertson', 'Matt Boldy']
);
assert.strictEqual(goldenClock.targetTurn, 12);
assert.strictEqual(goldenClock.picksUntilTurn, 0);
assert.strictEqual(goldenClock.draftComplete, false);
assert.strictEqual(goldenClock.rosterComplete, false);
assert.strictEqual('_decisive' in goldenClock.shortlist[0], false, 'Row must not have _decisive');
assert.strictEqual('_score' in goldenClock.shortlist[0], false, 'Row must not have _score');

// Branch 2: Waiting
const goldenWait = GT.evaluateBoard(goldenBoard, {
  currentPick: 1,
  slot: 5,
  teams: 8,
  drafted: {},
  mine: {},
  rosterCounts: { C: 0, F: 0, D: 0, G: 0 },
  rosterLimits: goldenLimits
});

assert.strictEqual(goldenWait.liveProtocol.headline, '⏱️ Drafting in 4 picks (Turn #5)');
assert.strictEqual(
  goldenWait.liveProtocol.subtext,
  'Game Theory Target: Connor McDavid (C) holds +14.3 EV advantage over field.'
);
assert.strictEqual(goldenWait.liveProtocol.alertType, 'waiting');
assert.strictEqual(goldenWait.liveProtocol.step, 1);
assert.deepStrictEqual(
  goldenWait.shortlist.slice(0, 5).map((p) => p.name),
  ['Connor McDavid', 'Nathan MacKinnon', 'Macklin Celebrini', 'Nikita Kucherov', 'David Pastrnak']
);
assert.strictEqual(goldenWait.targetTurn, 5);
assert.strictEqual(goldenWait.picksUntilTurn, 4);
assert.strictEqual(goldenWait.draftComplete, false);
assert.strictEqual(goldenWait.rosterComplete, false);

// Branch 3: Roster complete
const goldenFullMine = {};
for (let i = 1; i <= 22; i++) goldenFullMine['Filler Player ' + i] = true;
const goldenDone = GT.evaluateBoard(goldenBoard, {
  currentPick: 170,
  slot: 5,
  teams: 8,
  drafted: {},
  mine: goldenFullMine,
  rosterCounts: { C: 2, F: 6, D: 6, G: 2, total: 22 },
  rosterLimits: goldenLimits
});

assert.strictEqual(goldenDone.liveProtocol.headline, '✅ Your roster is complete');
assert.strictEqual(
  goldenDone.liveProtocol.subtext,
  'All 22 of your roster slots are filled. The remaining picks belong to your opponents — no action needed.'
);
assert.strictEqual(goldenDone.liveProtocol.alertType, 'info');
assert.strictEqual(goldenDone.liveProtocol.step, 4);
assert.deepStrictEqual(goldenDone.shortlist.slice(0, 5).map((p) => p.name), []);
assert.strictEqual(goldenDone.targetTurn, null);
assert.strictEqual(goldenDone.picksUntilTurn, 0);
assert.strictEqual(goldenDone.draftComplete, false);
assert.strictEqual(goldenDone.rosterComplete, true);
console.log('✓ Golden-snapshot evaluation assertions pass (on-the-clock, waiting, roster-complete)');

// 16. Direct coverage for computeDynamicCliffs, computeTargetTradeoffs, getTopMatchup
const cliffBoard = [
  { name: 'C1', pos: ['C'], vorp: 100 },
  { name: 'C2', pos: ['C'], vorp: 80 },
  { name: 'C3', pos: ['C'], vorp: 20 },
  { name: 'F1', pos: ['F'], vorp: 100 },
  { name: 'F2', pos: ['F'], vorp: 92 },
  { name: 'F3', pos: ['F'], vorp: 50 },
  { name: 'D1', pos: ['D'], vorp: 90 }
];
const cliffMap = GT.computeDynamicCliffs(cliffBoard);
assert.strictEqual(cliffMap.C1, 20, 'C1 cliff = gap to next-best Center (100-80)');
assert.strictEqual(cliffMap.C2, 60, 'C2 cliff = gap to next-best Center (80-20)');
assert.strictEqual(cliffMap.C3, 20, 'C3 has no next Center, so cliff falls back to its own VORP');
assert.strictEqual(cliffMap.F2, 42, 'F2 cliff = gap to next-best Forward (92-50)');
assert.strictEqual(cliffMap.D1, 90, 'D1 is the only Defenseman, cliff falls back to its own VORP');
// F1's direct drop to F2 is only 8 (< 15), but F2 -> F3 is a 42-point tier drop,
// so the tier-skip cliff (F1 -> F3 = 50) must win over the shallow direct drop.
assert.strictEqual(cliffMap.F1, 50, 'Tier-skip cliff must be used when the direct drop is shallow but the next tier is not');
console.log('✓ computeDynamicCliffs matches the VORP gaps in a hand-built fixture');

const gtRows = [
  { name: 'Star', pos: ['C'], posLabel: 'C', adjVorp: 200, dropoff: 20, survivalProb: 0.1, adp: 3, action: 'TARGET' },
  { name: 'Rival', pos: ['D'], posLabel: 'D', adjVorp: 150, dropoff: 30, survivalProb: 0.2, adp: 5, action: 'TARGET' },
  { name: 'Filler', pos: ['F'], posLabel: 'F', adjVorp: 50, dropoff: 5, survivalProb: 0.9, adp: 80, action: 'TARGET' }
];
const targetTradeoffs = GT.computeTargetTradeoffs(gtRows, 5, 7.0);
assert.strictEqual(Object.keys(targetTradeoffs.tradeoffs).length, gtRows.length, 'One trade-off row per eligible target');
assert.strictEqual(targetTradeoffs.pTop.name, 'Star', 'Highest adjVorp candidate anchors the board');
Object.keys(targetTradeoffs.tradeoffs).forEach((name) => {
  const row = targetTradeoffs.tradeoffs[name];
  assert.notStrictEqual(row.vsPlayer, name, `${name}'s fallback matchup must never be itself`);
  if (row.cmp) {
    assert(row.cmp.pSurviveA >= 0 && row.cmp.pSurviveA <= 1, 'pSurviveA must be a probability in [0, 1]');
    assert(row.cmp.pSurviveB >= 0 && row.cmp.pSurviveB <= 1, 'pSurviveB must be a probability in [0, 1]');
  }
});
console.log('✓ computeTargetTradeoffs produces one bounded, non-self-referential row per target');

const topMatch = GT.getTopMatchup(gtRows, 5, 7.0);
assert(topMatch, 'Top matchup must be found for a non-empty board');
assert.strictEqual(topMatch.playerA.name, targetTradeoffs.pTop.name, 'Top matchup player A is the board anchor');
assert.notStrictEqual(topMatch.playerB.name, topMatch.playerA.name, 'Top matchup must never pit a player against themself');
assert.strictEqual(GT.getTopMatchup([], 5, 7.0), null, 'Top matchup must be null-safe on an empty board');
console.log('✓ getTopMatchup surfaces the board anchor matchup and is empty-safe');

// 17. evaluateBoard() with no rosterCounts/rosterLimits must default to the FLEX roster
// shape (C2 F6 D6 UTIL1 G2 BN5), not the legacy pre-flex curve.
const dHeavyCounts = { C: 0, F: 0, D: 4, G: 0, total: 4 };
const resNoRosterOpts = GT.evaluateBoard(rawData.players, {
  currentPick: 40, slot: 5, teams: 8, drafted: {}, mine: {}, rosterCounts: dHeavyCounts
});
const resLegacyRosterOpts = GT.evaluateBoard(rawData.players, {
  currentPick: 40, slot: 5, teams: 8, drafted: {}, mine: {}, rosterCounts: dHeavyCounts,
  rosterLimits: { C: 3, F: 5, D: 4, G: 2 }
});

assert(resNoRosterOpts.shortlist.length > 0, 'Shortlist must not be empty with no roster options');
assert(resNoRosterOpts.availableRows.every((p) => !Number.isNaN(p.adjVorp)), 'No adjVorp may be NaN with no roster options');

const makarNoOpts = resNoRosterOpts.availableRows.find((p) => p.name === 'Cale Makar');
const makarLegacyOpts = resLegacyRosterOpts.availableRows.find((p) => p.name === 'Cale Makar');
// D:4 already meets the legacy D limit (4), so the pre-flex curve diminishes him (0.85x).
// The same D:4 is still under the FLEX-shaped D limit (6), so the default path must not.
assert.strictEqual(makarNoOpts.isDiminished, false, 'With no roster options, D:4 must sit under the FLEX D limit (6) and stay undiminished');
assert.strictEqual(makarLegacyOpts.isDiminished, true, 'The legacy D limit (4) would have diminished the same roster shape');
assert.strictEqual(makarNoOpts.adjVorp, makarNoOpts.rawVorp, 'FLEX path leaves an under-limit player at full value');
console.log('✓ evaluateBoard() with no roster options takes the FLEX multiplier path, not the legacy curve');

console.log('ALL GAMETHEORY TESTS PASSED!');
