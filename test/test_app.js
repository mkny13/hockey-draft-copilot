// App UI tests: runs the app in jsdom with stubbed fetch, WebSocket, and GameTheory.
// Covers (a) untrusted text escaping/XSS across player names, teams, positions, actions,
// game theory advice, comparator verdicts, reports, and Monte Carlo results, and (b) the
// pick-history integrity banner, repair-pick control, and per-entry targeted undo.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const gametheoryJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gametheory.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeout = 4000, interval = 10, message = '' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    let res = false;
    try {
      res = predicate();
    } catch (_) {}
    if (res) return res;
    await new Promise((r) => setTimeout(r, interval));
  }
  let finalRes = false;
  try {
    finalRes = predicate();
  } catch (err) {
    const desc = message || predicate.toString();
    throw new Error(`Timed out waiting for condition after ${timeout}ms: ${desc} (threw: ${err.message})`);
  }
  if (finalRes) return finalRes;
  const desc = message || predicate.toString();
  throw new Error(`Timed out waiting for condition after ${timeout}ms: ${desc}`);
}

const HOSTILE_NAME_1 = '<img src=x onerror=1>';
const HOSTILE_NAME_2 = '"><script>1</script>';
const HOSTILE_TEAM = '<b onmouseover=1>TEAM</b>';
const HOSTILE_POS = '<i onclick=1>C</i>';
const HOSTILE_ERR = '<img src=err onerror=2>';

function makeAppWindow(customPlayers, customState, customReport, customFetchResponses) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => console.error(e));

  const dom = new JSDOM(indexHtml, {
    url: 'http://localhost:3333',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole
  });

  const w = dom.window;
  w.__sockets = [];

  const defaultPlayers = [
    {
      id: 1,
      rank: 1,
      name: HOSTILE_NAME_1,
      team: HOSTILE_TEAM,
      pos: ['C', 'F'],
      rawPos: ['C'],
      posLabel: HOSTILE_POS,
      tier: 'C1',
      prnk: 'C1',
      vorp: 200,
      rawVorp: 200,
      adjVorp: 200,
      dropoff: 25,
      fp: 450,
      adp: 2.0,
      action: 'MUST REACH (Cliff)',
      survivalProb: 0.15,
      adpDelta: 5.0,
      gtTradeoff: {
        ev2: 210,
        netGain: 4.5,
        vsPlayer: HOSTILE_NAME_2,
        advice: 'Take ' + HOSTILE_NAME_1 + ' now.'
      }
    },
    {
      id: 2,
      rank: 2,
      name: HOSTILE_NAME_2,
      team: 'COL',
      pos: ['F'],
      rawPos: ['F'],
      posLabel: 'F',
      tier: 'F1',
      prnk: 'F1',
      vorp: 180,
      rawVorp: 180,
      adjVorp: 180,
      dropoff: 10,
      fp: 400,
      adp: 15.0,
      action: 'WAIT (ADP Safe)',
      survivalProb: 0.85,
      adpDelta: 10.0,
      gtTradeoff: {
        ev2: 190,
        netGain: -12.0,
        vsPlayer: HOSTILE_NAME_1,
        advice: 'Wait on ' + HOSTILE_NAME_2 + '.'
      }
    },
    {
      id: 3,
      rank: 3,
      name: 'Tim Stützle',
      team: 'OTT',
      pos: ['C', 'F'],
      rawPos: ['C'],
      posLabel: 'C/F',
      tier: 'C2',
      prnk: 'C2',
      vorp: 150,
      rawVorp: 150,
      adjVorp: 150,
      dropoff: 5,
      fp: 350,
      adp: 30.0,
      action: 'TARGET',
      survivalProb: 0.50,
      adpDelta: 2.0
    }
  ];

  const boardData = {
    meta: { season: 'sample', count: 3 },
    config: {
      league: {
        teams: 8,
        slots: { C: 2, LW: 0, RW: 0, W: 0, F: 6, D: 6, UTIL: 1, G: 2, BN: 5 }
      }
    },
    players: customPlayers || defaultPlayers
  };

  const serverState = customState || {
    currentPick: 2,
    slot: 5,
    teams: 8,
    stdDev: 7.0,
    rosterLimits: { C: 4, F: 8, D: 6, G: 2 },
    drafted: { [HOSTILE_NAME_1]: true },
    mine: {},
    pickHistory: [
      { pickNumber: 1, name: HOSTILE_NAME_1, isMine: false, round: 1, pickInRound: 1 }
    ]
  };

  const reportData = customReport || {
    success: true,
    report: {
      summary: {
        grade: 'A+',
        gradeLabel: 'Elite draft',
        totalCapturedVorp: 200,
        totalExpectedVorp: 180,
        totalSurplus: 20,
        captureRatio: 1.11,
        picksCount: 1
      },
      myPicks: [
        {
          pickNumber: 1,
          name: HOSTILE_NAME_1,
          posLabel: HOSTILE_POS,
          adp: 2.0,
          vorp: 200,
          expectedVorp: 180,
          surplus: 20
        }
      ],
      steals: [
        {
          name: HOSTILE_NAME_2,
          posLabel: 'F',
          pickNumber: 2,
          isMine: true,
          adp: 15.0,
          adpDelta: 25.0
        }
      ],
      positionalBalance: {
        slots: [
          { pos: 'C', count: 1, limit: 3, status: 'LIGHT' }
        ],
        verdict: 'Balanced draft with ' + HOSTILE_NAME_1
      }
    }
  };

  w.__posts = [];
  w.fetch = (url, opts) => {
    if (opts && opts.body) {
      try { w.__posts.push({ url: url, body: JSON.parse(opts.body) }); } catch (e) { /* not JSON */ }
    }
    if (customFetchResponses && customFetchResponses[url]) {
      return Promise.resolve(customFetchResponses[url]());
    }
    if (url === '/draft_data.json') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(boardData) });
    }
    if (url === '/js/bookmarklet.js') {
      return Promise.resolve({ ok: true, text: () => Promise.resolve('(function(){/*stub*/})();') });
    }
    if (url === '/api/state') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(serverState) });
    }
    if (url === '/api/report') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(reportData) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, state: serverState }) });
  };

  w.WebSocket = class {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      w.__sockets.push(this);
    }
    close() {}
  };
  w.WebSocket.OPEN = 1;
  w.WebSocket.CONNECTING = 0;

  w.alert = () => {};
  w.confirm = () => true;

  const origClose = w.close.bind(w);
  w.close = () => {
    if (w.__copilotSearchDebounceTimer) {
      w.clearTimeout(w.__copilotSearchDebounceTimer);
      w.__copilotSearchDebounceTimer = null;
    }
    if (w.__copilotSearchTimer) {
      w.clearTimeout(w.__copilotSearchTimer);
      w.__copilotSearchTimer = null;
    }
    return origClose();
  };

  return w;
}

(async () => {
  // 1. Content Security Policy meta tag exists in public/index.html
  {
    assert(
      indexHtml.includes('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; connect-src \'self\' ws://localhost:3333 ws://127.0.0.1:3333;">'),
      'public/index.html carries the defense-in-depth CSP meta tag'
    );
    console.log('✓ index.html carries CSP meta tag');
  }

  // 2. escapeHtml unit tests
  {
    const w = makeAppWindow();
    w.eval(gametheoryJs);
    w.eval(appJs);

    assert(typeof w.escapeHtml === 'function', 'escapeHtml must be available');
    assert.strictEqual(w.escapeHtml('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
    assert.strictEqual(w.escapeHtml('<img src="x" onerror="1">'), '&lt;img src=&quot;x&quot; onerror=&quot;1&quot;&gt;');
    assert.strictEqual(w.escapeHtml('"><script>1</script>'), '&quot;&gt;&lt;script&gt;1&lt;/script&gt;');
    assert.strictEqual(w.escapeHtml("Tom & Jerry's"), 'Tom &amp; Jerry&#39;s');
    assert.strictEqual(w.escapeHtml('Tim Stützle'), 'Tim Stützle', 'Accented names preserved without alteration');
    assert.strictEqual(w.escapeHtml(null), '');
    assert.strictEqual(w.escapeHtml(undefined), '');
    w.close();
    console.log('✓ escapeHtml helper correctly escapes HTML entities and preserves accented text');
  }

  // 3. Pick with hostile name renders as literal text in shortlist, board table, and history feed
  {
    const w = makeAppWindow();
    w.eval(gametheoryJs);
    w.eval(appJs);

    const doc = w.document;
    await waitFor(
      () => doc.getElementById('board-tbody')?.children.length > 0 &&
            doc.getElementById('shortlist-container')?.children.length > 0 &&
            doc.getElementById('history-feed')?.children.length > 0,
      { message: 'board table, shortlist, and history feed rendered' }
    );

    // Check board table: hostile name, team, pos, action must not inject tags
    const tbody = doc.getElementById('board-tbody');
    assert(tbody, 'Board table tbody exists');
    assert.strictEqual(tbody.querySelectorAll('img').length, 0, 'No img injected in board table');
    assert.strictEqual(tbody.querySelectorAll('script').length, 0, 'No script injected in board table');
    assert(tbody.textContent.includes(HOSTILE_NAME_1), 'Hostile name 1 rendered as literal text in board table');
    assert(tbody.textContent.includes(HOSTILE_NAME_2), 'Hostile name 2 rendered as literal text in board table');
    assert(tbody.textContent.includes('Tim Stützle'), 'Accented name rendered properly in board table');

    // Check pick history feed: pick recorded with hostile name
    const historyFeed = doc.getElementById('history-feed');
    assert(historyFeed, 'History feed exists');
    assert.strictEqual(historyFeed.querySelectorAll('img').length, 0, 'No img injected in history feed');
    assert.strictEqual(historyFeed.querySelectorAll('script').length, 0, 'No script injected in history feed');
    assert(historyFeed.textContent.includes(HOSTILE_NAME_1), 'Hostile name 1 rendered as literal text in history feed');

    // Check shortlist
    const shortlist = doc.getElementById('shortlist-container');
    assert(shortlist, 'Shortlist container exists');
    assert.strictEqual(shortlist.querySelectorAll('img').length, 0, 'No img injected in shortlist');
    assert.strictEqual(shortlist.querySelectorAll('script').length, 0, 'No script injected in shortlist');

    // Deliver WebSocket PICK_MADE with hostile name
    const sock = w.__sockets[0];
    assert(sock, 'WebSocket connection opened');
    assert.strictEqual(typeof sock.onopen, 'function', 'sock.onopen handler is wired');
    assert.strictEqual(typeof sock.onmessage, 'function', 'sock.onmessage handler is wired');
    sock.onopen();
    sock.onmessage({
      data: JSON.stringify({
        type: 'PICK_MADE',
        payload: { name: HOSTILE_NAME_2, isMine: true },
        state: {
          currentPick: 3,
          slot: 5,
          teams: 8,
          pickHistory: [
            { pickNumber: 1, name: HOSTILE_NAME_1, isMine: false },
            { pickNumber: 2, name: HOSTILE_NAME_2, isMine: true }
          ],
          drafted: { [HOSTILE_NAME_1]: true, [HOSTILE_NAME_2]: true },
          mine: { [HOSTILE_NAME_2]: true }
        }
      })
    });
    await waitFor(
      () => historyFeed.textContent.includes(HOSTILE_NAME_2),
      { message: 'history feed updated with hostile pick after PICK_MADE' }
    );

    // After PICK_MADE, verify again
    assert.strictEqual(historyFeed.querySelectorAll('img').length, 0, 'No img in history after PICK_MADE');
    assert.strictEqual(historyFeed.querySelectorAll('script').length, 0, 'No script in history after PICK_MADE');
    assert(historyFeed.textContent.includes(HOSTILE_NAME_2), 'Hostile name 2 rendered as literal text in history');

    w.close();
    console.log('✓ Hostile pick names render as literal text without DOM injection in board, shortlist, and history');
  }

  // 4. Comparator verdict and safe-sleeper pills escape player-derived text
  {
    const undraftedState = { currentPick: 1, slot: 5, teams: 8, stdDev: 7.0, rosterLimits: { C: 4, F: 8, D: 6, G: 2 }, drafted: {}, mine: {}, pickHistory: [] };
    const w = makeAppWindow(null, undraftedState);
    w.eval(gametheoryJs);
    w.eval(appJs);

    const doc = w.document;
    await waitFor(
      () => doc.getElementById('compare-player-a')?.options.length > 1 &&
            doc.getElementById('safe-sleepers-container')?.children.length > 0,
      { message: 'comparator dropdowns and safe sleepers rendered' }
    );

    // Test safe sleepers container
    const sleepers = doc.getElementById('safe-sleepers-container');
    assert(sleepers, 'Safe sleepers container exists');
    assert.strictEqual(sleepers.querySelectorAll('img').length, 0, 'No img in safe sleepers');
    assert.strictEqual(sleepers.querySelectorAll('script').length, 0, 'No script in safe sleepers');

    // Test comparator
    const selA = doc.getElementById('compare-player-a');
    const selB = doc.getElementById('compare-player-b');
    const verdict = doc.getElementById('comparator-verdict');
    assert(selA && selB && verdict, 'Comparator elements exist');

    selA.value = HOSTILE_NAME_1;
    selB.value = HOSTILE_NAME_2;
    selA.dispatchEvent(new w.Event('change'));
    await waitFor(
      () => verdict.textContent.includes('Option 1') && verdict.textContent.includes('Option 2'),
      { message: 'comparator verdict rendered trade-off options' }
    );

    assert.strictEqual(verdict.querySelectorAll('img').length, 0, 'No img injected in comparator verdict');
    assert.strictEqual(verdict.querySelectorAll('script').length, 0, 'No script injected in comparator verdict');

    w.close();
    console.log('✓ Comparator verdict and safe sleepers escape player-derived text');
  }

  // 5. Post-draft report escapes player-derived text and balance verdict
  {
    const w = makeAppWindow();
    w.eval(gametheoryJs);
    w.eval(appJs);

    const doc = w.document;
    await waitFor(
      () => doc.getElementById('board-tbody')?.children.length > 0,
      { message: 'board table rendered' }
    );

    const btnReport = doc.getElementById('btn-open-report');
    assert(btnReport, 'Draft Report button exists');

    btnReport.onclick();
    const reportContent = doc.getElementById('report-content');
    assert(reportContent, 'Report content container exists');
    await waitFor(
      () => reportContent.textContent.includes(HOSTILE_NAME_1) && !reportContent.textContent.includes('Loading report...'),
      { message: 'post-draft report content loaded and rendered' }
    );

    assert.strictEqual(reportContent.querySelectorAll('img').length, 0, 'No img injected in post-draft report');
    assert.strictEqual(reportContent.querySelectorAll('script').length, 0, 'No script injected in post-draft report');
    assert(reportContent.textContent.includes(HOSTILE_NAME_1), 'Hostile name 1 rendered as literal text in report');
    assert(reportContent.textContent.includes(HOSTILE_NAME_2), 'Hostile name 2 rendered as literal text in report');
    assert(reportContent.textContent.includes('Balanced draft with ' + HOSTILE_NAME_1), 'Verdict rendered as literal text in report');

    w.close();
    console.log('✓ Post-draft report escapes player names, positions, steals, and balance verdict');
  }

  // 6. Monte Carlo panel and error banners escape err.message and player names
  {
    const w = makeAppWindow();
    w.eval(gametheoryJs);
    w.eval(appJs);

    const doc = w.document;
    await waitFor(
      () => doc.getElementById('board-tbody')?.children.length > 0,
      { message: 'board table rows rendered' }
    );

    const btnMC = doc.getElementById('btn-open-montecarlo');
    assert(btnMC, 'Monte Carlo button exists');
    btnMC.onclick();

    const targetSelect = doc.getElementById('mc-target-select');
    assert(targetSelect, 'Monte Carlo target select exists');

    // Run simulation on hostile player
    targetSelect.value = HOSTILE_NAME_2;
    const btnRun = doc.getElementById('btn-run-montecarlo');
    btnRun.onclick();

    const mcResults = doc.getElementById('montecarlo-results');
    assert(mcResults, 'Monte Carlo results container exists');
    await waitFor(
      () => !btnRun.disabled && mcResults.textContent.includes('sims'),
      { message: 'Monte Carlo simulation results rendered' }
    );

    assert.strictEqual(mcResults.querySelectorAll('img').length, 0, 'No img injected in Monte Carlo results');
    assert.strictEqual(mcResults.querySelectorAll('script').length, 0, 'No script injected in Monte Carlo results');

    // Now test error banner escaping when GameTheory throws an error with hostile message
    w.GameTheory.roundSurvivalProbabilities = () => {
      throw new Error(HOSTILE_ERR);
    };

    btnRun.onclick();
    await waitFor(
      () => !btnRun.disabled && mcResults.textContent.includes('Simulation failed: ' + HOSTILE_ERR),
      { message: 'Monte Carlo error banner rendered' }
    );

    assert.strictEqual(mcResults.querySelectorAll('img').length, 0, 'No img injected in Monte Carlo error banner');
    assert.strictEqual(mcResults.querySelectorAll('script').length, 0, 'No script injected in Monte Carlo error banner');
    assert(mcResults.textContent.includes('Simulation failed: ' + HOSTILE_ERR), 'Hostile error message rendered as literal text');

    w.close();
    console.log('✓ Monte Carlo panel and error banners escape player names and err.message');
  }

  // 7. Integrity banner: hidden when ok, visible and names each affected pick number otherwise
  {
    const okState = {
      currentPick: 2, slot: 5, teams: 8, stdDev: 7.0,
      rosterLimits: { C: 4, F: 8, D: 6, G: 2 },
      drafted: {}, mine: {},
      pickHistory: [{ pickNumber: 1, name: 'Connor McDavid', isMine: false }],
      pickHistoryIntegrity: { checkedUpTo: 2, missing: [], repeated: [], duplicateNames: [], ok: true }
    };
    const w = makeAppWindow(null, okState);
    w.eval(gametheoryJs);
    w.eval(appJs);

    // Wait for initial render to complete (proved by rendered board table row count)
    await waitFor(
      () => w.document.getElementById('board-tbody')?.children.length > 0,
      { message: 'board table rows rendered' }
    );
    // Explicit short settle proving the banner remains hidden when integrity.ok is true (negative assertion)
    await sleep(25);

    const banner = w.document.getElementById('integrity-banner');
    assert.strictEqual(banner.style.display, 'none', 'Integrity banner is hidden when pickHistoryIntegrity.ok is true');
    w.close();
    console.log('✓ Integrity banner hidden when pickHistoryIntegrity.ok is true');
  }

  {
    const badState = {
      currentPick: 5, slot: 5, teams: 8, stdDev: 7.0,
      rosterLimits: { C: 4, F: 8, D: 6, G: 2 },
      drafted: {}, mine: {},
      pickHistory: [
        { pickNumber: 1, name: 'Connor McDavid', isMine: false },
        { pickNumber: 3, name: HOSTILE_NAME_1, isMine: false },
        { pickNumber: 3, name: HOSTILE_NAME_2, isMine: true }
      ],
      pickHistoryIntegrity: {
        checkedUpTo: 5,
        missing: [2, 4],
        repeated: [{ pickNumber: 3, count: 2, names: [HOSTILE_NAME_1, HOSTILE_NAME_2] }],
        duplicateNames: [{ name: HOSTILE_NAME_1, pickNumbers: [3, 4] }],
        ok: false
      }
    };
    const w = makeAppWindow(null, badState);
    w.eval(gametheoryJs);
    w.eval(appJs);

    const banner = w.document.getElementById('integrity-banner');
    const text = w.document.getElementById('integrity-warning-text');
    await waitFor(
      () => banner?.style.display === 'block' && text?.textContent.includes('#2'),
      { message: 'integrity banner visible with warning text' }
    );

    assert.strictEqual(banner.style.display, 'block', 'Integrity banner is visible when pickHistoryIntegrity.ok is false');
    assert(text.textContent.includes('#2'), 'Names missing pick #2');
    assert(text.textContent.includes('#4'), 'Names missing pick #4');
    assert(text.textContent.includes('#3'), 'Names the repeated pick number #3');
    assert(text.textContent.includes(HOSTILE_NAME_1), 'Names the duplicated player literally (textContent, never innerHTML)');
    assert.strictEqual(text.querySelectorAll('img,script').length, 0, 'No DOM injection from untrusted names in the banner');
    w.close();
    console.log('✓ Integrity banner visible and names every missing/repeated/duplicate pick');
  }

  // 8. Repair control POSTs { pickNumber, name } to /api/repair-pick and clears the form on success
  {
    const badState = {
      currentPick: 3, slot: 5, teams: 8, stdDev: 7.0,
      rosterLimits: { C: 4, F: 8, D: 6, G: 2 },
      drafted: {}, mine: {},
      pickHistory: [],
      pickHistoryIntegrity: { checkedUpTo: 3, missing: [1, 2], repeated: [], duplicateNames: [], ok: false }
    };
    const w = makeAppWindow(null, badState);
    w.eval(gametheoryJs);
    w.eval(appJs);

    const doc = w.document;
    await waitFor(
      () => doc.getElementById('repair-pick-form') !== null && doc.getElementById('integrity-banner')?.style.display === 'block',
      { message: 'repair pick form ready' }
    );

    doc.getElementById('repair-pick-number').value = '1';
    doc.getElementById('repair-pick-name').value = 'Connor McDavid';
    doc.getElementById('repair-pick-form').dispatchEvent(new w.Event('submit', { cancelable: true }));

    await waitFor(
      () => doc.getElementById('repair-pick-number').value === '' && w.__posts.some((p) => p.url === '/api/repair-pick'),
      { message: 'repair pick form submitted and cleared' }
    );
    // Explicit short settle proving error banner remains hidden on success (negative assertion)
    await sleep(15);

    const post = w.__posts.find((p) => p.url === '/api/repair-pick');
    assert(post, '/api/repair-pick was called');
    assert.deepStrictEqual(post.body, { pickNumber: 1, name: 'Connor McDavid' }, 'Repair POSTs { pickNumber, name }');
    assert.strictEqual(doc.getElementById('repair-pick-number').value, '', 'Pick number field clears on success');
    assert.strictEqual(doc.getElementById('repair-pick-name').value, '', 'Name field clears on success');
    assert.strictEqual(doc.getElementById('repair-pick-error').style.display, 'none', 'No error shown on success');
    w.close();
    console.log('✓ Repair control POSTs { pickNumber, name } to /api/repair-pick and clears on success');
  }

  // 9. A rejected repair shows the server's error text verbatim and leaves the form usable
  {
    const badState = {
      currentPick: 3, slot: 5, teams: 8, stdDev: 7.0,
      rosterLimits: { C: 4, F: 8, D: 6, G: 2 },
      drafted: {}, mine: {},
      pickHistory: [],
      pickHistoryIntegrity: { checkedUpTo: 3, missing: [1, 2], repeated: [], duplicateNames: [], ok: false }
    };
    const errorMessage = 'Pick #1 is already recorded ' + HOSTILE_ERR;
    const w = makeAppWindow(null, badState, null, {
      '/api/repair-pick': () => ({ ok: false, status: 400, json: () => Promise.resolve({ error: errorMessage }) })
    });
    w.eval(gametheoryJs);
    w.eval(appJs);

    const doc = w.document;
    await waitFor(
      () => doc.getElementById('repair-pick-form') !== null && doc.getElementById('integrity-banner')?.style.display === 'block',
      { message: 'repair pick form ready' }
    );

    doc.getElementById('repair-pick-number').value = '1';
    doc.getElementById('repair-pick-name').value = 'Connor McDavid';
    doc.getElementById('repair-pick-form').dispatchEvent(new w.Event('submit', { cancelable: true }));

    const errorDiv = doc.getElementById('repair-pick-error');
    await waitFor(
      () => errorDiv?.style.display === 'block',
      { message: 'repair pick error banner displayed' }
    );

    assert.strictEqual(errorDiv.style.display, 'block', 'Error banner is shown on a rejected repair');
    assert.strictEqual(errorDiv.textContent, errorMessage, "Server's error text is rendered verbatim");
    assert.strictEqual(errorDiv.querySelectorAll('img,script').length, 0, 'Hostile error text never parses as HTML');
    assert.strictEqual(doc.getElementById('repair-pick-number').value, '1', 'Form is left usable (not cleared) after a rejected repair');
    assert.strictEqual(doc.getElementById('repair-pick-name').value, 'Connor McDavid', 'Form is left usable (not cleared) after a rejected repair');
    w.close();
    console.log('✓ Rejected repair shows the server error verbatim and leaves the form usable');
  }

  // 10. Per-entry remove control POSTs a targeted { pickNumber } to /api/undo; repaired entries are badged
  {
    const stateWithHistory = {
      currentPick: 4, slot: 5, teams: 8, stdDev: 7.0,
      rosterLimits: { C: 4, F: 8, D: 6, G: 2 },
      drafted: { [HOSTILE_NAME_1]: true }, mine: {},
      pickHistory: [
        { pickNumber: 1, name: 'Connor McDavid', isMine: false },
        { pickNumber: 2, name: HOSTILE_NAME_1, isMine: false, repaired: true }
      ],
      pickHistoryIntegrity: { checkedUpTo: 4, missing: [3], repeated: [], duplicateNames: [], ok: false }
    };
    const w = makeAppWindow(null, stateWithHistory);
    w.eval(gametheoryJs);
    w.eval(appJs);

    const doc = w.document;
    const historyFeed = doc.getElementById('history-feed');
    await waitFor(
      () => historyFeed?.querySelectorAll('.hist-remove-btn').length >= 2,
      { message: 'history feed with remove buttons rendered' }
    );

    assert(historyFeed.textContent.includes('REPAIRED'), 'Repaired entries are shown distinctly in the history feed');

    const removeButtons = historyFeed.querySelectorAll('.hist-remove-btn');
    assert(removeButtons.length >= 2, 'Every history entry has a remove control');

    // History is rendered newest-first; the last entry (#1) is the second button
    removeButtons[removeButtons.length - 1].onclick({ stopPropagation() {} });

    await waitFor(
      () => w.__posts.some((p) => p.url === '/api/undo'),
      { message: 'targeted undo posted to /api/undo' }
    );

    const post = w.__posts.find((p) => p.url === '/api/undo');
    assert(post, '/api/undo was called for the targeted removal');
    assert.deepStrictEqual(post.body, { pickNumber: 1 }, 'Targeted undo POSTs { pickNumber } for the specific entry removed, not just the latest');
    w.close();
    console.log('✓ Per-entry remove control sends a targeted undo; repaired picks are badged in the history feed');
  }

  // 11. Bookmarklet link is populated from /js/bookmarklet.js
  {
    const w = makeAppWindow();
    w.eval(gametheoryJs);
    w.eval(appJs);

    const link = w.document.getElementById('bookmarklet-link');
    assert(link, 'bookmarklet-link element should exist');
    await waitFor(
      () => link.href && link.href.startsWith('javascript:'),
      { message: 'bookmarklet link populated with javascript: href' }
    );

    assert(link.href && link.href.startsWith('javascript:'), 'bookmarklet-link href must start with javascript:');
    assert(link.href.includes(encodeURIComponent('(function(){/*stub*/})();')), 'bookmarklet-link href must contain the encoded source');
    assert(decodeURIComponent(link.href).includes('(function(){/*stub*/})();'), 'bookmarklet-link href must decode to the fetched source');
    w.close();
    console.log('✓ Bookmarklet link is built from /js/bookmarklet.js');
  }

  // 12. Failed bookmarklet fetch leaves the link disabled with a message rather than throwing during init()
  {
    const w = makeAppWindow(null, null, null, {
      '/js/bookmarklet.js': () => ({ ok: false, status: 404, text: () => Promise.resolve('') })
    });
    w.eval(gametheoryJs);
    w.eval(appJs);

    const link = w.document.getElementById('bookmarklet-link');
    assert(link, 'bookmarklet-link element should exist');
    await waitFor(
      () => !link.getAttribute('href') && (link.textContent.includes('unavailable') || link.textContent.includes('Unavailable')),
      { message: 'bookmarklet link disabled with error message' }
    );

    assert(!link.getAttribute('href'), 'Failed bookmarklet fetch removes active href');
    assert(link.textContent.includes('unavailable') || link.textContent.includes('Unavailable'), 'Failed bookmarklet fetch leaves short message');
    w.close();
    console.log('✓ Failed bookmarklet fetch leaves link disabled with short message without throwing');
  }

  // 13. Search debounce: coalescing keystroke burst into a single table rebuild
  {
    const w = makeAppWindow();
    w.eval(gametheoryJs);
    w.eval(appJs);

    const doc = w.document;
    const tbody = doc.getElementById('board-tbody');
    const filterSearch = doc.getElementById('filter-search');

    await waitFor(() => tbody?.children.length > 0, { message: 'board table initial render' });

    let renderCount = 0;
    const origRender = w.renderBoardTable;
    w.renderBoardTable = function () {
      renderCount++;
      return origRender.apply(this, arguments);
    };

    const query = 'Tim Stüt'; // 8-character query
    assert.strictEqual(query.length, 8, 'Query is 8 characters long');

    for (let i = 0; i < query.length; i++) {
      filterSearch.value = query.slice(0, i + 1);
      filterSearch.dispatchEvent(new w.Event('input'));
    }

    // Immediately after the 8 input events, table has not been rebuilt yet
    assert.strictEqual(renderCount, 0, 'Typing burst does not trigger synchronous renders');
    assert(w.__copilotSearchDebounceTimer, 'Debounce timer handle is exposed on window');

    // Wait for the trailing debounce timer (~120ms) to fire
    await waitFor(() => renderCount === 1, { timeout: 1000, message: 'debounce timer fired once' });

    // Assert it rebuilt once, not eight times
    assert.strictEqual(renderCount, 1, 'Typing an eight-character query rebuilds the board table once, not eight times');
    assert.strictEqual(w.__copilotSearchDebounceTimer, null, 'Debounce timer handle is cleared after firing');

    // Final rendered rows match the last query typed ("Tim Stüt" -> Tim Stützle)
    assert.strictEqual(tbody.children.length, 1, 'Rendered rows match last query typed');
    assert(tbody.children[0].textContent.includes('Tim Stützle'), 'Row contains Tim Stützle');

    w.close();
    console.log('✓ Search debounce coalesces an 8-character burst into exactly one board rebuild');
  }

  // 14. Batch row attachment: renderBoardTable attaches rows through a single DocumentFragment append
  {
    const w = makeAppWindow();
    w.eval(gametheoryJs);
    w.eval(appJs);

    const doc = w.document;
    const tbody = doc.getElementById('board-tbody');

    await waitFor(() => tbody?.children.length > 0, { message: 'board table initial render' });

    let appendCalls = 0;
    let appendedNodes = [];
    const origAppendChild = tbody.appendChild.bind(tbody);
    tbody.appendChild = function (child) {
      appendCalls++;
      appendedNodes.push(child);
      return origAppendChild(child);
    };

    w.renderBoardTable();

    assert.strictEqual(appendCalls, 1, 'renderBoardTable() appends to tableTbody exactly once');
    assert.strictEqual(
      appendedNodes[0].nodeType,
      w.Node.DOCUMENT_FRAGMENT_NODE,
      'renderBoardTable() attaches rows through a DocumentFragment append'
    );
    assert.strictEqual(tbody.children.length, 3, 'All rows attached to tableTbody');

    w.close();
    console.log('✓ renderBoardTable attaches rows through a single DocumentFragment append');
  }

  // 15. Render-output parity against main fixtures across filter combinations
  {
    const fixtureFile = path.join(__dirname, 'fixtures_board_render.json');
    const fixtures = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));

    const parityPlayers = [
      {
        id: 1, rank: 1, name: HOSTILE_NAME_1, team: '<b onmouseover=1>TEAM</b>',
        pos: ['C', 'F'], rawPos: ['C'], posLabel: '<i onclick=1>C</i>',
        vorp: 200, rawVorp: 200, adjVorp: 200, dropoff: 25, fp: 450, adp: 2.0,
        action: 'MUST REACH (Cliff)', survivalProb: 0.15, adpDelta: 5.0
      },
      {
        id: 2, rank: 2, name: HOSTILE_NAME_2, team: 'COL',
        pos: ['F'], rawPos: ['F'], posLabel: 'F',
        vorp: 180, rawVorp: 180, adjVorp: 180, dropoff: 10, fp: 400, adp: 15.0,
        action: 'WAIT (ADP Safe)', survivalProb: 0.85, adpDelta: 10.0
      },
      {
        id: 3, rank: 3, name: 'Tim Stützle', team: 'OTT',
        pos: ['C', 'F'], rawPos: ['C'], posLabel: 'C/F',
        vorp: 150, rawVorp: 150, adjVorp: 150, dropoff: 5, fp: 350, adp: 30.0,
        action: 'TARGET', survivalProb: 0.50, adpDelta: 2.0
      },
      {
        id: 4, rank: 4, name: 'Cale Makar', team: 'COL',
        pos: ['D'], rawPos: ['D'], posLabel: 'D',
        vorp: 140, rawVorp: 140, adjVorp: 140, dropoff: 16, fp: 380, adp: 8.0,
        action: 'NOW OR NEVER', survivalProb: 0.05, adpDelta: -2.0
      },
      {
        id: 5, rank: 5, name: 'Connor Hellebuyck', team: 'WPG',
        pos: ['G'], rawPos: ['G'], posLabel: 'G',
        vorp: 100, rawVorp: 100, adjVorp: 100, dropoff: 0, fp: 320, adp: 40.0,
        action: 'TARGET', survivalProb: 0.90, adpDelta: 0.0
      }
    ];

    const parityState = {
      currentPick: 3,
      slot: 5,
      teams: 8,
      stdDev: 7.0,
      rosterLimits: { C: 4, F: 8, D: 6, G: 2 },
      drafted: { [HOSTILE_NAME_1]: true, 'Cale Makar': true },
      mine: { 'Cale Makar': true },
      pickHistory: [
        { pickNumber: 1, name: HOSTILE_NAME_1, isMine: false },
        { pickNumber: 2, name: 'Cale Makar', isMine: true }
      ]
    };

    const filterCases = [
      { q: '', pos: 'ALL', hide: false },
      { q: 'Stützle', pos: 'ALL', hide: false },
      { q: 'COL', pos: 'ALL', hide: false },
      { q: '', pos: 'C', hide: false },
      { q: '', pos: 'ALL', hide: true },
      { q: 'x', pos: 'F', hide: false }
    ];

    for (const c of filterCases) {
      const w = makeAppWindow(parityPlayers, parityState);
      w.eval(gametheoryJs);
      w.eval(appJs);

      const doc = w.document;
      const tbody = doc.getElementById('board-tbody');
      const filterSearch = doc.getElementById('filter-search');
      const toggleHide = doc.getElementById('toggle-hide-drafted');

      await waitFor(() => tbody?.children.length > 0, { message: 'board table initial render for parity' });

      filterSearch.value = c.q;
      filterSearch.dispatchEvent(new w.Event('input'));

      toggleHide.checked = c.hide;
      toggleHide.dispatchEvent(new w.Event('change'));

      const chip = Array.from(doc.querySelectorAll('.filter-chip')).find((el) => el.getAttribute('data-pos') === c.pos);
      if (chip) chip.click();

      // Wait for debounce timer if query was input
      if (c.q) {
        await waitFor(() => w.__copilotSearchDebounceTimer === null, { message: 'debounce timer finished' });
      }

      const key = `${c.q}|${c.pos}|${c.hide}`;
      assert.strictEqual(
        tbody.innerHTML,
        fixtures[key],
        `tableTbody.innerHTML is byte-identical to main fixture for case (${key})`
      );

      w.close();
    }
    console.log('✓ tableTbody.innerHTML is identical to main across all tested filter combinations');
  }

  // 16. Sidebar pick lookup via Map and total VORP integrity
  {
    const sidebarPlayers = [
      {
        id: 1, rank: 1, name: 'Leon Draisaitl', team: 'EDM',
        pos: ['C', 'F'], rawPos: ['C'], posLabel: 'C/F',
        vorp: 180.4, rawVorp: 180.4, adjVorp: 180.4, dropoff: 10, fp: 420, adp: 3.0,
        action: 'TARGET', survivalProb: 0.1, adpDelta: 1.0
      },
      {
        id: 2, rank: 2, name: 'Cale Makar', team: 'COL',
        pos: ['D'], rawPos: ['D'], posLabel: 'D',
        vorp: 165.2, rawVorp: 165.2, adjVorp: 165.2, dropoff: 15, fp: 410, adp: 6.0,
        action: 'TARGET', survivalProb: 0.2, adpDelta: 2.0
      }
    ];

    const stateWithPicks = {
      currentPick: 5,
      slot: 5,
      teams: 8,
      stdDev: 7.0,
      rosterLimits: { C: 4, F: 8, D: 6, G: 2 },
      drafted: { 'Leon Draisaitl': true, 'Cale Makar': true, 'Nathan MacKinnon': true, 'Ghost Player': true },
      mine: { 'Leon Draisaitl': true, 'Cale Makar': true, 'Ghost Player': true },
      pickHistory: [
        { pickNumber: 1, name: 'Leon Draisaitl', isMine: true },
        { pickNumber: 2, name: 'Nathan MacKinnon', isMine: false },
        { pickNumber: 3, name: 'Ghost Player', isMine: true }, // Absent from allRows
        { pickNumber: 4, name: 'Cale Makar', isMine: true }
      ]
    };

    const w = makeAppWindow(sidebarPlayers, stateWithPicks);
    w.eval(gametheoryJs);
    w.eval(appJs);

    const doc = w.document;
    const statTotalVorp = doc.getElementById('stat-total-vorp');
    const rosterTotalCount = doc.getElementById('roster-total-count');

    await waitFor(
      () => statTotalVorp?.textContent && statTotalVorp.textContent !== '0.0',
      { message: 'sidebar total VORP rendered' }
    );

    // Draisaitl (180.4) + Makar (165.2) = 345.6; Ghost Player is skipped rather than NaN
    const expectedTotal = (180.4 + 165.2).toFixed(1);
    assert.strictEqual(
      statTotalVorp.textContent,
      expectedTotal,
      '#stat-total-vorp shows the exact total from Map lookup (345.6)'
    );
    assert(!statTotalVorp.textContent.includes('NaN'), 'Total VORP does not contain NaN');

    // Total roster count reflects the 3 mine picks
    assert(rosterTotalCount.textContent.startsWith('3 /'), 'roster total count reflects all mine picks');

    w.close();
    console.log('✓ renderSidebar resolves picks through name Map and preserves total VORP with absent picks skipped');
  }

  console.log('ALL APP TESTS PASSED!');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
