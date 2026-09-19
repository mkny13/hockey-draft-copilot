// Strategy regression: the engine must keep beating a pure-ADP drafter and end with a full lineup.
const assert = require('assert');
const { runDraft } = require('../scripts/mock_draft.js');

for (const [slot, seed] of [[5, 1], [2, 7]]) {
  const eng = runDraft(slot, seed, true, false);
  const adp = runDraft(slot, seed, false, false);

  assert.strictEqual(eng.roster.length, 22, 'a full 22-man roster');
  assert(eng.mix.G >= 2, `slot ${slot}: engine must draft its 2 starting goalies, got ${eng.mix.G}`);
  assert(eng.mix.C + eng.mix.F >= 9, `slot ${slot}: engine must fill 2C + 6F + UTIL`);
  assert(eng.mineScore > adp.mineScore + 100, `slot ${slot}: engine (${eng.mineScore.toFixed(0)}) should beat pure ADP (${adp.mineScore.toFixed(0)}) by a clear margin`);
  assert(eng.rank <= 2, `slot ${slot}: engine should finish top 2, got ${eng.rank}`);

  const again = runDraft(slot, seed, true, false);
  assert.strictEqual(again.mineScore, eng.mineScore, 'seeded drafts are deterministic');
  console.log(`✓ Mock draft slot ${slot}: engine ${eng.mineScore.toFixed(0)} pts (rank ${eng.rank}) vs ADP ${adp.mineScore.toFixed(0)}, ${eng.mix.G} G`);
}
console.log('ALL MOCK DRAFT TESTS PASSED!');
