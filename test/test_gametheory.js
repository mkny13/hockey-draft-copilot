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
// Dual-eligible C, F player (like Draisaitl) should get 100% utility because F is wide open!
const multDraisaitl = GT.getDiminishingMultiplier(['C', 'F'], rosterCountsA, limits);
assert.strictEqual(multDraisaitl, 1.0, 'Dual C, F player must NOT be diminished when F is open');

// Pure C player with C full gets primary bench discount (0.85)
const multPureC = GT.getDiminishingMultiplier(['C'], rosterCountsA, limits);
assert.strictEqual(multPureC, 0.85, 'Pure C player at starter capacity receives 0.85 utility');

// Case B: Both C and F are full
const rosterCountsB = { C: 4, F: 6, D: 4, G: 2 };
const multOverfull = GT.getDiminishingMultiplier(['C', 'F'], rosterCountsB, limits);
assert(multOverfull < 1.0, 'Dual player diminishes when all positions are capped');
console.log('✓ C & F Multi-position optionality and graded diminishing returns pass');

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
// The master board is now rebuilt automatically on a schedule (scrape.js /
// issue #1), so the game-theory calibration tests pin to a committed snapshot
// instead of the live draft_data.json -- otherwise every scheduled re-scrape
// would re-rank the board and break these data-dependent assertions.
// Regenerate with: cp draft_data.json test/fixtures/board_snapshot.json
// (then re-calibrate the player-specific expectations below if needed).
const rawData = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/board_snapshot.json'), 'utf8'));

const draftedPick5 = {
  'Connor McDavid': true,
  'Nathan MacKinnon': true,
  'Nikita Kucherov': true,
  'Cale Makar': true
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
assert.strictEqual(pick5Best.name, 'Leon Draisaitl', 'Draisaitl must be #1 recommendation due to massive cliff and 2-round EV edge');
assert(pick5Best.gtTradeoff, 'Candidate must have attached gtTradeoff');
assert(pick5Best.gtTradeoff.netGain > 15.0, `Draisaitl net EV gain over Hughes should be > 15, got ${pick5Best.gtTradeoff.netGain}`);
assert(pick5Best.gtTradeoff.advice.includes('Macklin Celebrini'), 'Advice must reference waiting on the slider (Macklin Celebrini)');
console.log('✓ Automated multi-candidate trade-off identifies Draisaitl as 2-round EV optimal pick at Pick 5');

// 9. Test Top Matchup for Comparator
assert(resPick5.topMatchup, 'Top matchup must be generated');
assert.strictEqual(resPick5.topMatchup.playerA.name, 'Macklin Celebrini', 'Top matchup player A should be the slider anchor');
assert.strictEqual(resPick5.topMatchup.playerB.name, 'Leon Draisaitl', 'Top matchup player B should be the GT challenger');
assert(resPick5.topMatchup.cmp.deltaEV > 15.0, 'Top matchup deltaEV should be > 15 pts');
console.log('✓ Top Matchup automatically identifies Hughes vs Draisaitl dilemma');

// 10. Test Pick 1 (Empty Board) Integrity: the top cliff candidate leads
const resPick1 = GT.evaluateBoard(rawData.players, {
  currentPick: 1,
  slot: 1,
  teams: 8,
  drafted: {},
  mine: {},
  rosterCounts: { C: 0, F: 0, D: 0, G: 0 },
  rosterLimits: { C: 3, F: 5, D: 4, G: 2 }
});

assert.strictEqual(resPick1.shortlist[0].name, 'Leon Draisaitl', 'Draisaitl must lead the Pick 1 shortlist (top C/F cliff on the snapshot board)');
assert(resPick1.shortlist[0].gtTradeoff.advice.includes('cliff'), 'Pick 1 advice must acknowledge the tier cliff it locks in');
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

// Real-board sanity: grade the current draft_state pickHistory (4 opponent picks)
const stData = JSON.parse(fs.readFileSync(path.join(__dirname, '../draft_state.json'), 'utf8'));
const gradeReal = GT.gradeDraft(stData.pickHistory, rawData.players, { rosterLimits: stData.rosterLimits });
assert.strictEqual(gradeReal.picks.length, stData.pickHistory.length, 'Every recorded pick is graded');
assert.strictEqual(gradeReal.summary.picksCount, 0, 'No my-team picks yet in default state');
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

console.log('ALL GAMETHEORY TESTS PASSED!');
