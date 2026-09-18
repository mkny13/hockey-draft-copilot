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

console.log('ALL GAMETHEORY TESTS PASSED!');
