// Draft-room sync tests: runs the real extension content script and the bookmarklet in jsdom
// against ESPN-like DOM fixtures.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const SYNC = path.join(__dirname, '..', 'yahoo-sync');
const playersData = fs.readFileSync(path.join(SYNC, 'players_data.js'), 'utf8');
const contentJs = fs.readFileSync(path.join(SYNC, 'content.js'), 'utf8');
const SCAN_INTERVAL_MS = 25;

async function waitFor(predicate, { timeout = 4000, interval = 10, message } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await predicate();
      if (res) return res;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, interval));
  }
  const desc = message || (typeof predicate === 'function' ? predicate.toString() : 'predicate');
  throw new Error(`Timed out after ${timeout}ms waiting for: ${desc}`);
}

const settle = (cycles = 3, intervalMs = SCAN_INTERVAL_MS) =>
  new Promise((r) => setTimeout(r, cycles * intervalMs));

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
  w.__COPILOT_SCAN_MS = SCAN_INTERVAL_MS;
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
  const origClose = w.close.bind(w);
  w.close = () => {
    if (w.__copilotScanInterval) {
      w.clearInterval(w.__copilotScanInterval);
    }
    origClose();
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
    await waitFor(() => w.__posts.length >= 1);
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
    await settle(3);
    assert.deepStrictEqual(names(w), [], 'Anything inside the Available Players table is ignored');
    w.close();
    console.log('✓ Extension: player-pool elements ignored');
  }

  // 3. Marker before the name is not a pick
  {
    const w = runExtension(`<div class="toast"><div>R1, P4 - Team X</div><div>Nikita Kucherov / TBL, F</div></div>`);
    await settle(3);
    assert.deepStrictEqual(names(w), [], 'The picked player must precede the round/pick marker');
    w.close();
    console.log('✓ Extension: name-after-marker layout ignored');
  }

  // 4. A toast added later is picked up by the observer/poll
  {
    const w = runExtension('<div class="wrap"></div>');
    await waitFor(() => w.document.getElementById('copilot-yahoo-badge'));
    const t = w.document.createElement('div');
    t.innerHTML = '<div>Connor McDavid / EDM, C</div><div>R1, P1 - Other Team</div>';
    w.document.querySelector('.wrap').appendChild(t);
    await waitFor(() => w.__posts.length >= 1);
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
    await waitFor(() => w.__posts.length >= 2);
    assert(w.__posts.length >= 2, 'The pick is re-sent after a network failure');
    assert(w.__posts.every((p) => p.name === 'Nathan MacKinnon'));
    w.close();
    console.log('✓ Extension: failed post is retried');
  }

  // 6. HUD renders the server evaluation; badge follows the socket state
  {
    const w = runExtension('<div></div>');
    await waitFor(() => w.document.getElementById('copilot-hud-card') && w.__sockets.length >= 1);
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
    await waitFor(() => w.__posts.length >= 1 && w.__sockets.length >= 1);
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
    await settle(4); // 4 scan cycles: a trailing scan would misfire here
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
    await waitFor(() => w.document.getElementById('copilot-hud-card'));

    const hudCard = w.document.getElementById('copilot-hud-card');
    assert(hudCard, 'HUD card should exist');
    assert.strictEqual(hudCard.querySelectorAll('img').length, 0, 'Hostile syncUrl must not inject img element');
    const srv = w.document.getElementById('hud-server');
    assert.strictEqual(srv.textContent, 'http://localhost:3333', 'Invalid syncUrl must fall back to default http://localhost:3333');

    // Also test dynamically changed hostile URL
    assert.strictEqual(typeof storageChangedCallback, 'function', 'chrome.storage.onChanged listener must be registered');
    storageChangedCallback({ syncUrl: { newValue: '"><script>alert(1)</script>' } }, 'local');
    assert.strictEqual(hudCard.querySelectorAll('script').length, 0, 'Dynamically changed hostile syncUrl must not inject script');
    assert.strictEqual(srv.textContent, 'http://localhost:3333', 'Dynamically changed invalid syncUrl falls back to default');

    storageChangedCallback({ syncUrl: { newValue: 'http://127.0.0.1:4444' } }, 'local');
    assert.strictEqual(srv.textContent, 'http://127.0.0.1:4444', 'Valid http syncUrl is accepted');

    w.close();
    console.log('✓ Extension: hostile stored sync URL cannot inject an element into the HUD');
  }

  // 7. Served bookmarklet: runs against the wrapper fixture and records only the toast pick
  {
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    assert(!/querySelectorAll\(\s*["']div,\s*li/i.test(appSource), 'app.js must not inline the draft-page scanner');

    const bookmarkletJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'bookmarklet.js'), 'utf8');
    const nonUrlLines = bookmarkletJs.split('\n').filter(l => !l.includes('http://') && !l.includes('https://'));
    assert(!nonUrlLines.some(l => /^\s*\/\//.test(l)), 'bookmarklet.js must not contain single-line // comments');

    const w = makeWindow(WRAPPER_WITH_LIST);
    w.eval(bookmarkletJs);
    await waitFor(() => w.__posts.length >= 1);
    assert.deepStrictEqual(names(w), ['Nathan MacKinnon'], 'bookmarklet.js: only the toast pick is recorded');
    assert.strictEqual(w.__posts[0].round, 1);
    assert.strictEqual(w.__posts[0].pickInRound, 2);
    w.clearInterval(w.__copilotScanInterval);
    w.close();
    console.log('✓ bookmarklet.js: parses and records only the toast pick');
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
  // espn.com/yahoo.com wildcard that would run the scraper on ESPN news/video/account pages,
  // and no redundant entries beyond the exact pinned boundary.
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(SYNC, 'manifest.json'), 'utf8'));
    const isBareWildcard = (p) =>
      p === 'https://*.espn.com/*' ||
      p === 'https://espn.com/*' ||
      p === 'https://*.yahoo.com/*' ||
      p === 'https://yahoo.com/*';

    assert(!manifest.host_permissions.some(isBareWildcard), 'host_permissions must not grant a bare espn.com/yahoo.com wildcard');
    assert(!manifest.content_scripts.some((c) => c.matches.some(isBareWildcard)), 'content_scripts.matches must not grant a bare espn.com/yahoo.com wildcard');

    assert.deepStrictEqual(
      manifest.host_permissions,
      ['https://fantasy.espn.com/*', 'https://*.fantasysports.yahoo.com/*', 'http://localhost:3333/*'],
      'host_permissions must be exactly the pinned draft-host + localhost boundary'
    );
    assert.deepStrictEqual(
      manifest.permissions,
      ['storage'],
      'permissions must be exactly ["storage"]'
    );
    manifest.content_scripts.forEach((c) => {
      assert.deepStrictEqual(
        c.matches,
        ['https://fantasy.espn.com/*', 'https://*.fantasysports.yahoo.com/*'],
        'content_scripts.matches must be exactly the pinned draft-host boundary'
      );
    });
    console.log('✓ Manifest permission surface is pinned to the exact fantasy draft host boundary');
  }

  // 10. Scan interval seam: content.js and bookmarklet.js default to 1000ms when window.__COPILOT_SCAN_MS
  // is unset, zero, negative, or non-numeric, and adopt positive numeric values.
  {
    const bookmarkletJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'bookmarklet.js'), 'utf8');

    function checkIntervalChoice(script, scanMsVal) {
      const virtualConsole = new VirtualConsole();
      const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://fantasy.espn.com/hockey/draft', runScripts: 'outside-only', virtualConsole });
      const w = dom.window;
      if (scanMsVal !== undefined) {
        w.__COPILOT_SCAN_MS = scanMsVal;
      }
      let capturedDelay = null;
      const origSetInterval = w.setInterval;
      w.setInterval = (fn, delay, ...args) => {
        if (capturedDelay === null) capturedDelay = delay;
        return origSetInterval.call(w, fn, delay, ...args);
      };
      w.alert = () => {};
      w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      w.WebSocket = class { constructor() { this.readyState = 0; } close() {} };
      w.chrome = {
        storage: { local: { get: (k, cb) => cb({}), set() {} }, onChanged: { addListener() {} } },
        runtime: { onMessage: { addListener() {} }, sendMessage() {} }
      };
      w.eval(playersData);
      w.eval(script);
      if (w.__copilotScanInterval) w.clearInterval(w.__copilotScanInterval);
      w.close();
      return capturedDelay;
    }

    const testValues = [
      { val: undefined, expected: 1000, label: 'unset' },
      { val: 0, expected: 1000, label: 'zero' },
      { val: -1, expected: 1000, label: 'negative' },
      { val: 'abc', expected: 1000, label: 'string "abc"' },
      { val: NaN, expected: 1000, label: 'NaN' },
      { val: Infinity, expected: 1000, label: 'Infinity' },
      { val: 25, expected: 25, label: 'valid 25ms' },
    ];

    for (const { val, expected, label } of testValues) {
      assert.strictEqual(
        checkIntervalChoice(contentJs, val),
        expected,
        `content.js scan interval with ${label} should be ${expected}`
      );
      assert.strictEqual(
        checkIntervalChoice(bookmarkletJs, val),
        expected,
        `bookmarklet.js scan interval with ${label} should be ${expected}`
      );
    }
    console.log('✓ content.js and bookmarklet.js scan interval seam defaults to 1000ms unless a positive finite number is given');
  }

  console.log('ALL SYNC TESTS PASSED!');
})().catch((err) => { console.error(err); process.exit(1); });
