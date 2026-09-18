const assert = require('assert');
const GT = require('../public/js/gametheory.js');

console.log('Testing GameTheory Module...');

// 1. Test normalCDF
const cdfMean = GT.normalCDF(20, 20, 7.0);
assert(Math.abs(cdfMean - 0.5) < 0.001, `CDF at mean should be 0.5, got ${cdfMean}`);

// Test pSurvive
// If target pick is 12 and player ADP is 49.5 (Fox), survival should be > 0.99
const foxSurv = GT.pSurvive(12, 49.5, 7.0);
assert(foxSurv > 0.99, `Fox survival to 12 should be > 99%, got ${foxSurv}`);

// If target pick is 12 and player ADP is 6, survival should be ~ 0.20-0.25
const earlySurv = GT.pSurvive(12, 6, 7.0);
assert(earlySurv > 0.15 && earlySurv < 0.35, `Early pick survival should be ~24%, got ${earlySurv}`);
console.log('✓ Normal CDF & Survival probability calculations pass');

// 2. Test Snake Turn Schedule
// 8 teams, slot 5:
// Round 1: pick 5
// Round 2 (snake backwards 8..1): slot 5 is pick 2*8 - (5-1) = 12
// Round 3 (snake forwards 1..8): slot 5 is 2*8 + 5 = 21
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

// 6. Test Head to Head Comparator
const pA = { name: 'Adam Fox', rawVorp: 65, adjVorp: 65, dropoff: 3, adp: 50 };
const pB = { name: 'Cale Makar', rawVorp: 70, adjVorp: 70, dropoff: 25, adp: 10 };
const cmp = GT.comparePlayersGameTheory(pA, pB, null, null, 12, 7.0);
console.log('Comparator verdict sample:', cmp.verdict);
assert(cmp !== null);
assert(typeof cmp.deltaEV === 'number');

console.log('ALL GAMETHEORY TESTS PASSED!');
