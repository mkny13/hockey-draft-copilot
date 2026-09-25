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
  const activeTimeouts = new Set();
  const activeIntervals = new Set();
  const origSetTimeout = w.setTimeout.bind(w);
  const origClearTimeout = w.clearTimeout.bind(w);
  const origSetInterval = w.setInterval.bind(w);
  const origClearInterval = w.clearInterval.bind(w);
  w.setTimeout = (fn, delay, ...args) => {
    let id;
    id = origSetTimeout((...a) => {
      activeTimeouts.delete(id);
      return fn(...a);
    }, delay, ...args);
    activeTimeouts.add(id);
    return id;
  };
  w.clearTimeout = (id) => {
    activeTimeouts.delete(id);
    return origClearTimeout(id);
  };
  w.setInterval = (fn, delay, ...args) => {
    const id = origSetInterval(fn, delay, ...args);
    activeIntervals.add(id);
    return id;
  };
  w.clearInterval = (id) => {
    activeIntervals.delete(id);
    return origClearInterval(id);
  };
  const origClose = w.close.bind(w);
  w.close = () => {
    if (w.__copilotScanInterval) {
      origClearInterval(w.__copilotScanInterval);
      w.__copilotScanInterval = null;
    }
    if (w.__copilotWsReconnectTimer) {
      origClearTimeout(w.__copilotWsReconnectTimer);
      w.__copilotWsReconnectTimer = null;
    }
    if (w.__copilotScanTimer) {
      origClearTimeout(w.__copilotScanTimer);
      w.__copilotScanTimer = null;
    }
    if (w.__copilotObserver) {
      w.__copilotObserver.disconnect();
      w.__copilotObserver = null;
    }
    for (const id of activeTimeouts) origClearTimeout(id);
    for (const id of activeIntervals) origClearInterval(id);
    activeTimeouts.clear();
    activeIntervals.clear();
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
    assert.strictEqual(w.__copilotScanTimer, null, 'Closing window clears mutation scan timer');
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
    assert(w.__copilotWsReconnectTimer, 'Socket close schedules a reconnect timer');
    w.close();
    assert.strictEqual(w.__copilotWsReconnectTimer, null, 'Closing window clears reconnect timer');
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
      if (w.__copilotWsReconnectTimer) w.clearTimeout(w.__copilotWsReconnectTimer);
      if (w.__copilotScanTimer) w.clearTimeout(w.__copilotScanTimer);
      if (w.__copilotObserver) w.__copilotObserver.disconnect();
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

  // 11. Coalesced scan: A burst of draft-room DOM mutations inside one 300ms window triggers
  // exactly one scanAndSyncAllPicks sweep (not N and not N+interval ticks).
  {
    const w = makeWindow('<div class="wrap"></div>');
    w.__COPILOT_SCAN_MS = 25;
    w.eval(playersData);
    w.eval(contentJs);
    await waitFor(() => w.document.getElementById('copilot-yahoo-badge'));

    // Wait until the initial heartbeat scan has executed and settled
    await waitFor(() => (w.__copilotScanCount || 0) >= 1);
    const initialScans = w.__copilotScanCount || 0;
    const initialPosts = w.__posts.length;

    // Fire a burst of 10 DOM mutations inside the wrap element within a few ms
    const wrap = w.document.querySelector('.wrap');
    for (let i = 0; i < 10; i++) {
      const el = w.document.createElement('div');
      el.className = 'timer-clock';
      el.textContent = `00:${String(i).padStart(2, '0')}`;
      wrap.appendChild(el);
    }
    // Also add one toast element representing a pick
    const toast = w.document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = '<div>Cale Makar / COL, D</div><div>R1, P3 - Team Denver</div>';
    wrap.appendChild(toast);

    // Wait for the debounced scan to trigger after 300ms
    await waitFor(() => (w.__copilotScanCount || 0) > initialScans);
    // Settle across multiple 25ms interval cycles to ensure no trailing ticks fire
    await settle(4, 25);

    assert.strictEqual(
      (w.__copilotScanCount || 0) - initialScans,
      1,
      'A burst of 10+ DOM mutations inside the 300ms window triggers exactly one scan sweep'
    );
    assert.strictEqual(
      w.__posts.length - initialPosts,
      1,
      'Exactly one pick POST is recorded from the burst'
    );
    assert.strictEqual(w.__posts[w.__posts.length - 1].name, 'Cale Makar');
    w.close();
    console.log('✓ Extension: burst of DOM mutations coalesces into exactly one scan sweep');
  }

  // 12. No-mutation heartbeat: a draft page with no DOM mutations is still scanned at the
  // heartbeat cadence so that picks appearing without MutationObserver-visible changes are caught.
  {
    const w = makeWindow('<div class="wrap"></div>');
    w.__COPILOT_SCAN_MS = 30;
    w.eval(playersData);
    w.eval(contentJs);
    await waitFor(() => (w.__copilotScanCount || 0) >= 1);

    // Disconnect the mutation observer to simulate an unobserved DOM change
    assert(w.__copilotObserver, 'Observer exists');
    w.__copilotObserver.disconnect();

    // Directly insert a pick toast into the DOM; since observer is disconnected,
    // only the heartbeat interval can detect it.
    const toast = w.document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = '<div>Auston Matthews / TOR, C</div><div>R1, P4 - Leaf Nation</div>';
    w.document.body.appendChild(toast);

    const start = Date.now();
    await waitFor(() => w.__posts.some((p) => p.name === 'Auston Matthews'), { timeout: 500 });
    const elapsed = Date.now() - start;

    assert(
      elapsed <= 150,
      `Heartbeat scan caught the unobserved pick within ~2-3x scan interval (took ${elapsed}ms)`
    );
    assert(
      w.__posts.some((p) => p.name === 'Auston Matthews'),
      'Pick was synced via heartbeat floor without any DOM mutations'
    );
    w.close();
    console.log('✓ Extension: draft page with no DOM mutations is scanned at heartbeat cadence');
  }

  // 13. Background health check: gates network calls on draft tab presence, omits currentPick from
  // tab messages, and refreshes server status when popup requests it with no draft tab.
  {
    const vm = require('vm');
    const bgJs = fs.readFileSync(path.join(SYNC, 'background.js'), 'utf8');

    function createBackgroundHarness({ queryTabs = [], storedStatus = null, fetchResponse = null } = {}) {
      let fetchCalls = [];
      let tabMessages = [];
      let runtimeMessages = [];
      let storage = { syncUrl: 'http://localhost:3333' };
      if (storedStatus) storage.status = storedStatus;
      let messageListeners = [];

      const fakeFetch = async (url, options) => {
        fetchCalls.push({ url, options });
        if (fetchResponse) return fetchResponse(url, options);
        return {
          ok: true,
          status: 200,
          json: async () => ({ currentPick: 7 })
        };
      };

      const fakeChrome = {
        storage: {
          local: {
            get: async (keys) => {
              if (typeof keys === 'string') return { [keys]: storage[keys] };
              if (Array.isArray(keys)) {
                const res = {};
                keys.forEach((k) => { if (k in storage) res[k] = storage[k]; });
                return res;
              }
              return { ...storage };
            },
            set: async (items) => {
              Object.assign(storage, items);
            }
          }
        },
        runtime: {
          onInstalled: { addListener() {} },
          onStartup: { addListener() {} },
          onMessage: {
            addListener(fn) {
              messageListeners.push(fn);
            }
          },
          sendMessage: async (msg) => {
            runtimeMessages.push(msg);
          }
        },
        tabs: {
          query: async (queryInfo) => {
            return typeof queryTabs === 'function' ? queryTabs(queryInfo) : queryTabs;
          },
          sendMessage: async (tabId, msg) => {
            tabMessages.push({ tabId, msg });
          }
        }
      };

      const sandbox = {
        chrome: fakeChrome,
        fetch: fakeFetch,
        setInterval: () => 12345,
        clearInterval: () => {},
        setTimeout,
        clearTimeout,
        AbortController,
        URL,
        Date,
        console: { log() {}, warn() {}, error() {} }
      };

      vm.createContext(sandbox);
      vm.runInContext(bgJs, sandbox);

      return {
        sandbox,
        fakeChrome,
        getFetchCalls: () => fetchCalls,
        clearFetchCalls: () => { fetchCalls = []; },
        getTabMessages: () => tabMessages,
        clearTabMessages: () => { tabMessages = []; },
        getRuntimeMessages: () => runtimeMessages,
        getStorage: () => storage,
        setQueryTabs: (tabs) => { queryTabs = tabs; },
        sendMessage: async (msg) => {
          let response = null;
          for (const fn of messageListeners) {
            const res = fn(msg, {}, (r) => { response = r; });
            if (res === true) {
              await waitFor(() => response !== null);
            }
          }
          return response;
        }
      };
    }

    // 13a: tabs.query -> [] produces 0 fetch calls and 0 tabs.sendMessage calls
    let activeTabs = [];
    const harness = createBackgroundHarness({ queryTabs: () => activeTabs });
    await settle(1, 20);

    const noTabStatus = await harness.sandbox.checkHealth();
    assert.strictEqual(harness.getFetchCalls().length, 0, 'No fetch calls when no draft tab open');
    assert.strictEqual(harness.getTabMessages().length, 0, 'No tab messages when no draft tab open');
    assert.strictEqual(noTabStatus.connected, false);
    assert.strictEqual(noTabStatus.error, 'No draft tab open');
    assert.strictEqual(harness.getStorage().status.error, 'No draft tab open');

    // 13b: tabs.query -> 1 tab produces exactly 1 fetch to /api/state and tab message omits currentPick
    activeTabs = [{ id: 101, url: 'https://fantasy.espn.com/hockey/draft' }];
    harness.clearFetchCalls();
    harness.clearTabMessages();

    const oneTabStatus = await harness.sandbox.checkHealth();
    assert.strictEqual(harness.getFetchCalls().length, 1, 'Exactly one fetch to /api/state when 1 draft tab open');
    assert(harness.getFetchCalls()[0].url.endsWith('/api/state'));
    assert.strictEqual(harness.getTabMessages().length, 1, 'Exactly one message to open draft tab');
    assert.strictEqual(harness.getTabMessages()[0].tabId, 101);

    const sentTabStatus = harness.getTabMessages()[0].msg.status;
    assert.strictEqual(sentTabStatus.connected, true);
    assert.strictEqual('currentPick' in sentTabStatus, false, 'currentPick omitted from draft-tab message');
    assert.strictEqual(oneTabStatus.currentPick, 7, 'currentPick present in returned status');
    assert.strictEqual(harness.getStorage().status.currentPick, 7, 'currentPick stored in chrome.storage.local');

    // 13c: popup getStatus stale-status refresh path retrieves accurate server status even with no draft tabs
    activeTabs = [];
    harness.clearFetchCalls();
    harness.getStorage().status = { connected: false, error: 'No draft tab open', lastChecked: Date.now() - 15000 };

    const popupStatus = await harness.sendMessage({ type: 'getStatus' });
    assert.strictEqual(harness.getFetchCalls().length, 1, 'Stale refresh path issues fetch for popup');
    assert.strictEqual(popupStatus.connected, true, 'Popup receives connected status');
    assert.strictEqual(popupStatus.currentPick, 7, 'Popup receives currentPick');
    assert(typeof popupStatus.latency === 'number', 'Popup receives latency number');

    // 13d: popup getStatus with fresh "No draft tab open" stored status still forces fresh checkHealth
    harness.clearFetchCalls();
    harness.getStorage().status = { connected: false, error: 'No draft tab open', lastChecked: Date.now() };

    const popupRecentStatus = await harness.sendMessage({ type: 'getStatus' });
    assert.strictEqual(harness.getFetchCalls().length, 1, 'Fresh "No draft tab open" triggers server fetch for popup');
    assert.strictEqual(popupRecentStatus.connected, true);
    assert.strictEqual(popupRecentStatus.currentPick, 7);

    console.log('✓ Background: health check gates on draft tabs, omits currentPick from tab fan-out, and refreshes for popup');
  }

  console.log('ALL SYNC TESTS PASSED!');
})().catch((err) => { console.error(err); process.exit(1); });
