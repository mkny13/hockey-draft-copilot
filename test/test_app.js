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
    await sleep(200);

    const doc = w.document;

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
    if (sock.onopen) sock.onopen();
    if (sock.onmessage) {
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
    }
    await sleep(100);

    // After PICK_MADE, verify again
    assert.strictEqual(historyFeed.querySelectorAll('img').length, 0, 'No img in history after PICK_MADE');
    assert.strictEqual(historyFeed.querySelectorAll('script').length, 0, 'No script in history after PICK_MADE');
    assert(historyFeed.textContent.includes(HOSTILE_NAME_2), 'Hostile name 2 rendered as literal text in history');

    w.close();
    console.log('✓ Hostile pick names render as literal text without DOM injection in board, shortlist, and history');
  }

  // 4. Comparator verdict and safe-sleeper pills escape player-derived text
  {
    const w = makeAppWindow();
    w.eval(gametheoryJs);
    w.eval(appJs);
    await sleep(200);

    const doc = w.document;

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
    await sleep(50);

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
    await sleep(200);

    const doc = w.document;
    const btnReport = doc.getElementById('btn-open-report');
    assert(btnReport, 'Draft Report button exists');

    btnReport.onclick();
    await sleep(150);

    const reportContent = doc.getElementById('report-content');
    assert(reportContent, 'Report content container exists');
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
    await sleep(200);

    const doc = w.document;
    const btnMC = doc.getElementById('btn-open-montecarlo');
    assert(btnMC, 'Monte Carlo button exists');
    btnMC.onclick();

    const targetSelect = doc.getElementById('mc-target-select');
    assert(targetSelect, 'Monte Carlo target select exists');

    // Run simulation on hostile player
    targetSelect.value = HOSTILE_NAME_2;
    const btnRun = doc.getElementById('btn-run-montecarlo');
    btnRun.onclick();
    await sleep(100);

    const mcResults = doc.getElementById('montecarlo-results');
    assert(mcResults, 'Monte Carlo results container exists');
    assert.strictEqual(mcResults.querySelectorAll('img').length, 0, 'No img injected in Monte Carlo results');
    assert.strictEqual(mcResults.querySelectorAll('script').length, 0, 'No script injected in Monte Carlo results');

    // Now test error banner escaping when GameTheory throws an error with hostile message
    w.GameTheory.roundSurvivalProbabilities = () => {
      throw new Error(HOSTILE_ERR);
    };

    btnRun.onclick();
    await sleep(100);

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
    await sleep(200);

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
    await sleep(200);

    const banner = w.document.getElementById('integrity-banner');
    assert.strictEqual(banner.style.display, 'block', 'Integrity banner is visible when pickHistoryIntegrity.ok is false');
    const text = w.document.getElementById('integrity-warning-text');
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
    await sleep(200);

    const doc = w.document;
    doc.getElementById('repair-pick-number').value = '1';
    doc.getElementById('repair-pick-name').value = 'Connor McDavid';
    doc.getElementById('repair-pick-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await sleep(100);

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
    await sleep(200);

    const doc = w.document;
    doc.getElementById('repair-pick-number').value = '1';
    doc.getElementById('repair-pick-name').value = 'Connor McDavid';
    doc.getElementById('repair-pick-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await sleep(100);

    const errorDiv = doc.getElementById('repair-pick-error');
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
    await sleep(200);

    const doc = w.document;
    const historyFeed = doc.getElementById('history-feed');
    assert(historyFeed.textContent.includes('REPAIRED'), 'Repaired entries are shown distinctly in the history feed');

    const removeButtons = historyFeed.querySelectorAll('.hist-remove-btn');
    assert(removeButtons.length >= 2, 'Every history entry has a remove control');

    // History is rendered newest-first; the last entry (#1) is the second button
    removeButtons[removeButtons.length - 1].onclick({ stopPropagation() {} });
    await sleep(100);

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
    await sleep(200);

    const link = w.document.getElementById('bookmarklet-link');
    assert(link, 'bookmarklet-link element should exist');
    assert(link.href && link.href.startsWith('javascript:'), 'bookmarklet-link href must start with javascript:');
    assert(link.href.includes('(function(){/*stub*/})();'), 'bookmarklet-link href must contain the fetched source');
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
    await sleep(200);

    const link = w.document.getElementById('bookmarklet-link');
    assert(link, 'bookmarklet-link element should exist');
    assert(!link.getAttribute('href'), 'Failed bookmarklet fetch removes active href');
    assert(link.textContent.includes('unavailable') || link.textContent.includes('Unavailable'), 'Failed bookmarklet fetch leaves short message');
    w.close();
    console.log('✓ Failed bookmarklet fetch leaves link disabled with short message without throwing');
  }

  console.log('ALL APP TESTS PASSED!');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
