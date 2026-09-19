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

  console.log('ALL SYNC TESTS PASSED!');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
