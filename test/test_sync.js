// Draft-room sync tests: runs the real extension content script and both bookmarklets in jsdom
// against ESPN-like DOM fixtures.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const SYNC = path.join(__dirname, '..', 'yahoo-sync');
const playersData = fs.readFileSync(path.join(SYNC, 'players_data.js'), 'utf8');
const contentJs = fs.readFileSync(path.join(SYNC, 'content.js'), 'utf8');
const bookmarkletFile = fs.readFileSync(path.join(SYNC, 'bookmarklet.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The wrapper holds BOTH the Available Players list and the pick toast: the layout that used to
// record the top available player (Slafkovsky) as the last pick.
const WRAPPER_WITH_LIST = `
<div id="app"><div class="wrap">
  <div class="list"><div class="row">Juraj Slafkovsky / MTL, F</div><div class="row">Connor McDavid / EDM, C</div></div>
  <div class="toast"><div>Nathan MacKinnon / COL, F</div><div>R1, P2 - Some Team</div></div>
</div></div>`;

function makeWindow(html) {
  // Page console output is expected noise (the scripts log every pick); real jsdom errors still show
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => console.error(e));
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: 'https://fantasy.espn.com/hockey/draft', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window;
  w.__posts = [];
  w.__sockets = [];
  w.__fetchMode = 'ok';
  w.alert = () => {};
  w.confirm = () => true;
  w.fetch = (u, o) => {
    if (o && o.body) w.__posts.push(JSON.parse(o.body));
    if (typeof w.__fetchMode === 'function' ? w.__fetchMode() === 'fail' : w.__fetchMode === 'fail') return Promise.reject(new Error('offline'));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  w.WebSocket = class { constructor(url) { this.url = url; this.readyState = 0; w.__sockets.push(this); } close() {} };
  w.WebSocket.OPEN = 1; w.WebSocket.CONNECTING = 0;
  w.chrome = {
    storage: { local: { get: (k, cb) => cb({}), set() {} }, onChanged: { addListener() {} } },
    runtime: { onMessage: { addListener() {} }, sendMessage() {} }
  };
  return w;
}

function runExtension(html) {
  const w = makeWindow(html);
  w.eval(playersData);
  w.eval(contentJs);
  return w;
}

const names = (w) => w.__posts.map((p) => p.name);

(async () => {
  // 1. Wrapper + available list + toast: only the toast's player, with round/pick, and no ownership guess
  {
    const w = runExtension(WRAPPER_WITH_LIST);
    await sleep(1400);
    assert.deepStrictEqual(names(w), ['Nathan MacKinnon'], 'Only the toast player is recorded, never the Available Players list');
    assert.strictEqual(w.__posts[0].round, 1);
    assert.strictEqual(w.__posts[0].pickInRound, 2);
    assert.strictEqual('isMine' in w.__posts[0], false, 'The extension no longer guesses ownership');
    w.close();
    console.log('✓ Extension: wrapper containing the available list records only the toast pick');
  }

  // 2. A toast-shaped element inside the player pool is ignored
  {
    const w = runExtension(`<div class="playerPool"><div>Juraj Slafkovsky / MTL, F</div><div>R1, P9</div></div>`);
    await sleep(1400);
    assert.deepStrictEqual(names(w), [], 'Anything inside the Available Players table is ignored');
    w.close();
    console.log('✓ Extension: player-pool elements ignored');
  }

  // 3. Marker before the name is not a pick
  {
    const w = runExtension(`<div class="toast"><div>R1, P4 - Team X</div><div>Nikita Kucherov / TBL, F</div></div>`);
    await sleep(1400);
    assert.deepStrictEqual(names(w), [], 'The picked player must precede the round/pick marker');
    w.close();
    console.log('✓ Extension: name-after-marker layout ignored');
  }

  // 4. A toast added later is picked up by the observer/poll
  {
    const w = runExtension('<div class="wrap"></div>');
    await sleep(400);
    const t = w.document.createElement('div');
    t.innerHTML = '<div>Connor McDavid / EDM, C</div><div>R1, P1 - Other Team</div>';
    w.document.querySelector('.wrap').appendChild(t);
    await sleep(1400);
    assert.deepStrictEqual(names(w), ['Connor McDavid']);
    w.close();
    console.log('✓ Extension: dynamically added toast is recorded');
  }

  // 5. A failed post is retried on the next scan
  {
    const w = makeWindow(WRAPPER_WITH_LIST);
    let calls = 0;
    w.__fetchMode = () => (++calls === 1 ? 'fail' : 'ok');
    w.eval(playersData);
    w.eval(contentJs);
    await sleep(2600);
    assert(w.__posts.length >= 2, 'The pick is re-sent after a network failure');
    assert(w.__posts.every((p) => p.name === 'Nathan MacKinnon'));
    w.close();
    console.log('✓ Extension: failed post is retried');
  }

  // 6. HUD renders the server evaluation; badge follows the socket state
  {
    const w = runExtension('<div></div>');
    await sleep(300);
    assert(w.document.getElementById('copilot-hud-card').classList.contains('espn-layout'), 'On ESPN the HUD docks over the Picks sidebar');
    const sock = w.__sockets[0];
    assert(sock, 'The content script opens a WebSocket to the server');
    sock.onopen();
    assert.strictEqual(w.document.getElementById('copilot-yahoo-badge').className, 'connected');
    assert(!/\(\d+ms\)/.test(w.document.querySelector('.badge-title').textContent), 'No invented latency');
    sock.onmessage({ data: JSON.stringify({
      type: 'INIT_STATE',
      state: { pickHistory: [{ name: 'Connor McDavid' }] },
      evaluation: {
        headline: 'GAME THEORY PICK: Draft Zach Werenski (D)', subtext: 'Locks in the D cliff.', alertType: 'turn', targetTurn: 12,
        shortlist: [
          { name: 'Zach Werenski', pos: 'D', team: 'CBJ', action: 'TARGET', survivalProb: 0.47, adjVorp: 178.4 },
          { name: 'Jason Robertson', pos: 'F', team: 'DAL', action: 'TARGET', survivalProb: 0.9, adjVorp: 140.1 }
        ],
        tradeoff: 'LOCK IN VALUE: Draft Zach Werenski now.'
      }
    }) });
    const d = w.document;
    assert.strictEqual(d.getElementById('hud-headline').textContent, 'GAME THEORY PICK: Draft Zach Werenski (D)');
    assert.strictEqual(d.getElementById('hud-shortlist').children.length, 2);
    assert(d.getElementById('hud-shortlist').textContent.includes('47%'));
    assert.strictEqual(d.getElementById('hud-tradeoff').textContent, 'LOCK IN VALUE: Draft Zach Werenski now.');
    assert.strictEqual(d.getElementById('hud-count').textContent, '1 synced');
    sock.onclose();
    assert.strictEqual(d.getElementById('copilot-yahoo-badge').className, 'disconnected', 'Badge goes offline when the socket closes');
    w.close();
    console.log('✓ Extension: HUD renders headline, short list and trade-off; badge follows the socket');
  }

  // 6b. End of draft: the final pick's toast (R22, P8) is recorded even though no
  // scan ever follows it, and the roster-complete evaluation that comes back stops
  // all recommendations instead of advertising a next turn (issue #13).
  {
    const w = runExtension(`<div id="app"><div class="wrap">
      <div class="toast"><div>Andrei Vasilevskiy / TBL, G</div><div>R22, P8 - Draft Champion</div></div>
    </div></div>`);
    await sleep(1400);
    assert.deepStrictEqual(names(w), ['Andrei Vasilevskiy'], 'The final pick is recorded from its toast');
    assert.strictEqual(w.__posts[0].round, 22);
    assert.strictEqual(w.__posts[0].pickInRound, 8);
    const sock = w.__sockets[0];
    sock.onopen();
    sock.onmessage({ data: JSON.stringify({
      type: 'INIT_STATE',
      state: { pickHistory: [{ name: 'Andrei Vasilevskiy', isMine: true }] },
      evaluation: {
        headline: '✅ Your roster is complete',
        subtext: 'All 22 of your roster slots are filled. The remaining picks belong to your opponents — no action needed.',
        alertType: 'info', targetTurn: null,
        shortlist: [],
        tradeoff: ''
      }
    }) });
    const d = w.document;
    assert.strictEqual(d.getElementById('hud-headline').textContent, '✅ Your roster is complete');
    assert.strictEqual(d.getElementById('hud-shortlist').children.length, 0, 'No recommended players once the roster is full');
    assert.strictEqual(d.getElementById('hud-tradeoff').textContent, 'No trade-off flagged.', 'No trade-off advice after the roster fills');
    assert.strictEqual(d.getElementById('hud-count').textContent, '1 synced', 'The final pick is counted');
    await sleep(1500); // several scan cycles: a trailing scan would misfire here
    assert.deepStrictEqual(names(w), ['Andrei Vasilevskiy'], 'No spurious pick POSTs after the final pick');
    w.close();
    console.log('✓ Extension: final pick with no trailing scan records once and the HUD stops recommending');
  }

  // 6c. Hostile stored sync URL cannot inject an element into the HUD and falls back to http://localhost:3333
  {
    const w = makeWindow('<div></div>');
    let storageChangedCallback = null;
    w.chrome.storage.local.get = (keys, cb) => {
      cb({ syncUrl: '<img src=x onerror=alert(1)>' });
    };
    w.chrome.storage.onChanged.addListener = (fn) => {
      storageChangedCallback = fn;
    };
    w.eval(playersData);
    w.eval(contentJs);
    await sleep(300);

    const hudCard = w.document.getElementById('copilot-hud-card');
    assert(hudCard, 'HUD card should exist');
    assert.strictEqual(hudCard.querySelectorAll('img').length, 0, 'Hostile syncUrl must not inject img element');
    const srv = w.document.getElementById('hud-server');
    assert.strictEqual(srv.textContent, 'http://localhost:3333', 'Invalid syncUrl must fall back to default http://localhost:3333');

    // Also test dynamically changed hostile URL
    if (storageChangedCallback) {
      storageChangedCallback({ syncUrl: { newValue: '"><script>alert(1)</script>' } }, 'local');
      assert.strictEqual(hudCard.querySelectorAll('script').length, 0, 'Dynamically changed hostile syncUrl must not inject script');
      assert.strictEqual(srv.textContent, 'http://localhost:3333', 'Dynamically changed invalid syncUrl falls back to default');

      storageChangedCallback({ syncUrl: { newValue: 'http://127.0.0.1:4444' } }, 'local');
      assert.strictEqual(srv.textContent, 'http://127.0.0.1:4444', 'Valid http syncUrl is accepted');
    }

    w.close();
    console.log('✓ Extension: hostile stored sync URL cannot inject an element into the HUD');
  }

  // 5b. A pick posted while __fetchMode is 'fail' is re-sent after the mode flips to 'ok'
  // even though its toast element has been removed from the DOM
  {
    const w = makeWindow('<div class="wrap"><div class="toast"><div>Leon Draisaitl / EDM, F</div><div>R1, P3 - Team C</div></div></div>');
    w.__fetchMode = 'fail';
    w.eval(playersData);
    w.eval(contentJs);
    await sleep(1400);
    assert(w.__posts.length >= 1, 'Initial attempt was sent');
    assert.strictEqual(w.__posts[0].name, 'Leon Draisaitl');
    const countBefore = w.__posts.length;

    // Remove the toast element from the DOM completely
    const toast = w.document.querySelector('.toast');
    toast.remove();
    assert.strictEqual(w.document.querySelectorAll('.toast').length, 0, 'Toast is gone from DOM');

    // Counters reflect pending
    const hudCount = w.document.getElementById('hud-count');
    assert(hudCount.textContent.includes('pending'), 'Pending retry is visible in HUD counter');

    // Server comes back up
    w.__fetchMode = 'ok';

    // Wait for queue flush retry
    await sleep(1500);
    assert(w.__posts.length > countBefore, 'Pick was re-sent after server returned even though toast element was removed');
    assert.strictEqual(w.__posts[w.__posts.length - 1].name, 'Leon Draisaitl');
    assert(hudCount.textContent.includes('1 synced'), 'Pick is marked synced after retry');
    assert(!hudCount.textContent.includes('pending'), 'No pending picks remain');
    w.close();
    console.log('✓ Extension: pick whose POST fails is re-sent after server is back, even after toast element is gone');
  }

  // 5c. Recovery never produces a duplicate POST for a pick the server already recorded
  {
    const w = makeWindow('<div class="wrap"><div class="toast"><div>Cale Makar / COL, D</div><div>R1, P4 - Team D</div></div></div>');
    w.__fetchMode = 'fail';
    w.eval(playersData);
    w.eval(contentJs);
    await sleep(1400);
    assert(w.__posts.length >= 1, 'Initial attempt was sent');
    const countBefore = w.__posts.length;

    // Server reports that Cale Makar was already recorded via PICK_MADE
    const sock = w.__sockets[0];
    assert(sock, 'WebSocket is present');
    sock.onopen();
    sock.onmessage({ data: JSON.stringify({
      type: 'PICK_MADE',
      payload: { name: 'Cale Makar' },
      state: { pickHistory: [{ name: 'Cale Makar' }] }
    }) });

    // Mode flips to 'ok'
    w.__fetchMode = 'ok';
    await sleep(1500);

    // No duplicate POST is sent
    assert.strictEqual(w.__posts.length, countBefore, 'No second POST made for pick server already recorded');
    w.close();
    console.log('✓ Extension: no second POST made for a pick the server subsequently reports via PICK_MADE');
  }

  // 6d. HUD warning row renders from an INIT_STATE evaluation carrying missing/repeated pick numbers and clears when integrity is ok
  {
    const w = runExtension('<div></div>');
    await sleep(300);
    const sock = w.__sockets[0];
    sock.onopen();

    // Server sends evaluation with integrity errors
    sock.onmessage({ data: JSON.stringify({
      type: 'INIT_STATE',
      state: { pickHistory: [{ name: 'Connor McDavid', pickNumber: 1 }] },
      evaluation: {
        headline: 'Pick in progress', alertType: 'turn', shortlist: [], tradeoff: '',
        pickHistoryIntegrity: {
          checkedUpTo: 5,
          missing: [2, 3],
          repeated: [{ pickNumber: 4, count: 2, names: ['Player X', 'Player Y'] }],
          duplicateNames: [{ name: 'Player X', pickNumbers: [1, 4] }],
          ok: false
        }
      }
    }) });

    const warnRow = w.document.getElementById('hud-integrity-row');
    assert(warnRow, 'HUD integrity row exists');
    assert.strictEqual(warnRow.style.display, 'block', 'Integrity row is displayed when ok is false');
    assert(warnRow.textContent.includes('Missing pick(s): #2, #3'), 'Missing picks listed');
    assert(warnRow.textContent.includes('Repeated pick(s): #4'), 'Repeated picks listed');
    assert(warnRow.textContent.includes('Duplicate player(s): Player X'), 'Duplicate players listed');

    // Clear integrity warning when ok is true
    sock.onmessage({ data: JSON.stringify({
      type: 'INIT_STATE',
      state: { pickHistory: [{ name: 'Connor McDavid', pickNumber: 1 }] },
      evaluation: {
        headline: 'Pick in progress', alertType: 'turn', shortlist: [], tradeoff: '',
        pickHistoryIntegrity: {
          checkedUpTo: 5,
          missing: [],
          repeated: [],
          duplicateNames: [],
          ok: true
        }
      }
    }) });

    assert.strictEqual(warnRow.style.display, 'none', 'Integrity row is hidden when ok is true');
    assert.strictEqual(warnRow.textContent, '', 'Integrity text is cleared when ok is true');
    w.close();
    console.log('✓ Extension: HUD integrity warning row renders issues and clears when integrity is ok');
  }

  // 6e. Deep Scan reconciles: compares room players against last INIT_STATE pickHistory and reports missing players in HUD status line
  {
    const html = `
      <div id="app">
        <div class="draft-results-table">
          <table>
            <tr><td class="name">Connor McDavid</td></tr>
            <tr><td class="name">Leon Draisaitl</td></tr>
          </table>
        </div>
      </div>
    `;
    const w = runExtension(html);
    await sleep(300);
    const sock = w.__sockets[0];
    sock.onopen();

    // Server state only has Connor McDavid; Leon Draisaitl is missing from server history
    sock.onmessage({ data: JSON.stringify({
      type: 'INIT_STATE',
      state: { pickHistory: [{ name: 'Connor McDavid' }] }
    }) });

    const historyBtn = w.document.getElementById('copilot-btn-history');
    assert(historyBtn, 'Deep Scan button exists');
    historyBtn.click();
    await sleep(300);

    const msgEl = w.document.getElementById('hud-status-msg');
    assert(msgEl, 'HUD status line element exists');
    assert(msgEl.textContent.includes('Leon Draisaitl'), 'Missing draft-room player Leon Draisaitl is reported');
    assert(msgEl.textContent.toLowerCase().includes('missing from server history'), 'Reconciliation status line indicates missing from server history');
    w.close();
    console.log('✓ Extension: Deep Scan reports draft-room players that are missing from server history');
  }

  // 6f. flushPendingQueue must not discard an unrelated pending pick when the in-flight
  // item is dropped mid-await (e.g. recorded via the app's own "+Mine" button while the
  // extension is retrying it). A positional shift() would remove whatever now sits at
  // index 0 instead of the item that was actually being sent.
  {
    const w = makeWindow('<div></div>');
    w.eval(playersData);
    w.eval(contentJs);
    await sleep(300);
    const sock = w.__sockets[0];
    assert(sock, 'WebSocket is present');

    // Both picks fail their first POST attempt, landing both in the pending queue in order.
    w.__fetchMode = 'fail';
    const input = w.document.getElementById('copilot-quick-input');
    const send = w.document.getElementById('copilot-quick-send');
    input.value = 'Race Player A';
    send.click();
    input.value = 'Race Player B';
    send.click();
    await sleep(50);

    const hudCount = w.document.getElementById('hud-count');
    assert(hudCount.textContent.includes('2 pending'), 'Both picks are queued as pending');

    // Now trap the retry POST for Race Player A in-flight so we can inject the race.
    let resolveA;
    const trapped = new Promise((res) => { resolveA = res; });
    w.fetch = (u, o) => {
      const body = JSON.parse(o.body);
      w.__posts.push(body);
      if (body.name === 'Race Player A') {
        return trapped.then(() => ({ ok: true, json: () => Promise.resolve({}) }));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };

    // Wait for the automatic backoff retry to start the in-flight fetch for Race Player A.
    await sleep(1300);

    // While Race Player A's retry is still awaiting, the server reports it was recorded
    // through another path (e.g. "+Mine"). This reassigns pendingQueue mid-await.
    sock.onmessage({ data: JSON.stringify({
      type: 'PICK_MADE',
      payload: { name: 'Race Player A' },
      state: { pickHistory: [{ name: 'Race Player A' }] }
    }) });

    // Now let Race Player A's trapped fetch resolve successfully.
    resolveA();
    await sleep(300);

    assert(hudCount.textContent.includes('2 synced'), 'Both picks end up synced, not silently dropped');
    assert(!hudCount.textContent.includes('pending'), 'No pending picks remain');
    w.close();
    console.log('✓ Extension: an unrelated pending pick survives a mid-await queue mutation during retry');
  }

  // 6g. lastInitStatePickHistory (used by Deep Scan reconciliation) must stay current across
  // ordinary PICK_MADE broadcasts, not just the one-time INIT_STATE sent at connect
  {
    const html = `
      <div id="app">
        <div class="draft-results-table">
          <table>
            <tr><td class="name">Connor McDavid</td></tr>
            <tr><td class="name">Leon Draisaitl</td></tr>
          </table>
        </div>
      </div>
    `;
    const w = runExtension(html);
    await sleep(300);
    const sock = w.__sockets[0];
    sock.onopen();

    // Connect-time snapshot is empty (draft just started)
    sock.onmessage({ data: JSON.stringify({ type: 'INIT_STATE', state: { pickHistory: [] } }) });

    // Both room players get recorded via ordinary live-draft PICK_MADE broadcasts afterwards
    sock.onmessage({ data: JSON.stringify({
      type: 'PICK_MADE',
      payload: { name: 'Connor McDavid' },
      state: { pickHistory: [{ name: 'Connor McDavid' }] }
    }) });
    sock.onmessage({ data: JSON.stringify({
      type: 'PICK_MADE',
      payload: { name: 'Leon Draisaitl' },
      state: { pickHistory: [{ name: 'Connor McDavid' }, { name: 'Leon Draisaitl' }] }
    }) });

    const historyBtn = w.document.getElementById('copilot-btn-history');
    const msgEl = w.document.getElementById('hud-status-msg');
    historyBtn.click();
    await sleep(300);

    assert(!msgEl.textContent.toLowerCase().includes('missing from server history'), 'Players recorded via later PICK_MADE broadcasts are not false-flagged as missing');
    assert(msgEl.textContent.includes('Deep scan complete'), 'Reconciliation succeeds once the snapshot reflects later broadcasts');
    w.close();
    console.log('✓ Extension: Deep Scan reconciliation snapshot stays current across PICK_MADE broadcasts, not just INIT_STATE');
  }

  // 7. Bookmarklet file and the bookmarklet generated by the app: same wrapper fixture
  {
    const generated = (() => {
      const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
      const tpl = app.match(/var bmCode = `([\s\S]*?)`;\n/)[1];
      return eval('`' + tpl + '`').replace(/^javascript:/, '');
    })();
    for (const [label, code] of [['bookmarklet.js', bookmarkletFile], ['generated bookmarklet', generated]]) {
      const w = makeWindow(WRAPPER_WITH_LIST);
      w.eval(code);
      await sleep(300);
      assert.deepStrictEqual(names(w), ['Nathan MacKinnon'], `${label}: only the toast pick is recorded`);
      assert.strictEqual(w.__posts[0].round, 1);
      assert.strictEqual(w.__posts[0].pickInRound, 2);
      // (window left open: its observer would otherwise fire after teardown; the run exits below)
      console.log(`✓ ${label}: parses and records only the toast pick`);
    }
  }

  // 8. The extension manifest is valid and ships nothing dead
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(SYNC, 'manifest.json'), 'utf8'));
    const files = manifest.content_scripts.flatMap((c) => c.js.concat(c.css || []));
    files.concat([manifest.background.service_worker, manifest.action.default_popup]).forEach((f) => {
      assert(fs.existsSync(path.join(SYNC, f)), `manifest references missing file ${f}`);
    });
    console.log('✓ Manifest references only files that exist');
  }

  // 9. The manifest's permission surface is narrowed to the fantasy draft hosts: no bare
  // espn.com wildcard that would run the scraper on ESPN news/video/account pages.
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(SYNC, 'manifest.json'), 'utf8'));
    const isBareEspnWildcard = (p) => p === 'https://*.espn.com/*' || p === 'https://espn.com/*';

    assert(!manifest.host_permissions.some(isBareEspnWildcard), 'host_permissions must not grant a bare *.espn.com/espn.com wildcard');
    assert(!manifest.content_scripts.some((c) => c.matches.some(isBareEspnWildcard)), 'content_scripts.matches must not grant a bare *.espn.com/espn.com wildcard');

    assert(manifest.host_permissions.includes('https://fantasy.espn.com/*'), 'host_permissions must still cover the ESPN draft host');
    assert(manifest.host_permissions.includes('https://*.fantasysports.yahoo.com/*'), 'host_permissions must still cover the Yahoo fantasy hosts');
    assert(manifest.host_permissions.includes('http://localhost:3333/*'), 'host_permissions must still cover the local server health check');

    assert(manifest.content_scripts.some((c) => c.matches.includes('https://fantasy.espn.com/*')), 'content_scripts must still match the ESPN draft host');
    assert(manifest.content_scripts.some((c) => c.matches.includes('https://*.fantasysports.yahoo.com/*')), 'content_scripts must still match the Yahoo fantasy hosts');
    console.log('✓ Manifest permission surface is narrowed to the fantasy draft hosts');
  }

  console.log('ALL SYNC TESTS PASSED!');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
