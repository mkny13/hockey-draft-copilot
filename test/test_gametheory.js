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
const rawData = JSON.parse(fs.readFileSync(path.join(__dirname, '../draft_data.json'), 'utf8'));

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
assert(pick5Best.gtTradeoff.netGain > 30.0, `Draisaitl net EV gain over Hughes should be > 30, got ${pick5Best.gtTradeoff.netGain}`);
assert(pick5Best.gtTradeoff.advice.includes('Quinn Hughes'), 'Advice must reference waiting on Quinn Hughes');
console.log('✓ Automated multi-candidate trade-off identifies Draisaitl as 2-round EV optimal pick at Pick 5');

// 9. Test Top Matchup for Comparator
assert(resPick5.topMatchup, 'Top matchup must be generated');
assert.strictEqual(resPick5.topMatchup.playerA.name, 'Quinn Hughes', 'Top matchup player A should be Quinn Hughes (sleeper anchor)');
assert.strictEqual(resPick5.topMatchup.playerB.name, 'Leon Draisaitl', 'Top matchup player B should be Leon Draisaitl (GT challenger)');
assert(resPick5.topMatchup.cmp.deltaEV > 30.0, 'Top matchup deltaEV should be > 30 pts');
console.log('✓ Top Matchup automatically identifies Hughes vs Draisaitl dilemma');

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
console.log('✓ Pick 1 board integrity verified: McDavid strictly dominant at #1');

console.log('ALL GAMETHEORY TESTS PASSED!');
