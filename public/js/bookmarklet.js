(function(){
  const SYNC_URL = 'http://localhost:3333/api/pick';
  const RESET_URL = 'http://localhost:3333/api/reset';
  const isEspn = window.location.hostname.includes('espn.com');
  const platform = isEspn ? 'ESPN' : 'Yahoo';
  console.log('[' + platform + ' Draft Sync Bookmarklet] Initializing safe live observer...');
  
  const sentPlayers = new Set();
  let pickCount = 0;

  // In-room mini HUD badge
  let badge = document.getElementById('copilot-bm-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'copilot-bm-badge';
    badge.style.cssText = 'position:fixed; top:12px; right:12px; z-index:2147483647; background:#0d1117; color:#3fb950; border:1.5px solid #238636; padding:6px 12px; border-radius:20px; font-family:-apple-system,sans-serif; font-size:11px; font-weight:bold; box-shadow:0 4px 14px rgba(0,0,0,0.6); display:flex; gap:8px; align-items:center; cursor:pointer;';
    badge.innerHTML = '<span>● 🏒 ' + platform + ' Co-Pilot: Live</span><span id="copilot-bm-count" style="background:rgba(255,255,255,0.12); color:#fff; padding:2px 6px; border-radius:10px; font-size:10px;">0 synced</span><button id="copilot-bm-scan" style="background:#21262d; border:1px solid #30363d; color:#58a6ff; font-size:10px; padding:2px 6px; border-radius:4px; cursor:pointer;">Scan</button><button id="copilot-bm-reset" style="background:#da3633; border:none; color:#fff; font-size:10px; padding:2px 6px; border-radius:4px; cursor:pointer; margin-left:4px;">Reset</button>';
    (document.body || document.documentElement).appendChild(badge);
    
    document.getElementById('copilot-bm-scan').addEventListener('click', function(e) {
      e.stopPropagation();
      scanDraftBoard();
      alert('⚡ Scanned board: ' + pickCount + ' picks recorded.');
    });

    document.getElementById('copilot-bm-reset').addEventListener('click', function(e) {
      e.stopPropagation();
      if (confirm('Reset draft board on server and clear picks?')) {
        sentPlayers.clear();
        pickCount = 0;
        document.getElementById('copilot-bm-count').textContent = '0 synced';
        fetch(RESET_URL, { method: 'POST' });
      }
    });
  }

  function isAvailablePlayer(elem) {
    if (!elem) return false;
    if (elem.closest('[class*="playerPool"],[class*="PlayerPool"],[class*="players-table"],[class*="player-table"],[aria-label*="Players"],#playertable')) return true;
    const row = elem.closest('tr,[role="row"],li');
    if (row) {
      const btns = row.querySelectorAll('button,a,[role="button"]');
      for (let i = 0; i < btns.length; i++) {
        const txt = (btns[i].textContent || '').trim().toLowerCase();
        if (txt === 'draft' || txt === 'claim' || txt === 'queue' || txt === '+') return true;
      }
    }
    return false;
  }

  function cleanName(text) {
    if (!text) return '';
    let clean = text.replace(/\s+/g, ' ').trim();
    clean = clean.replace(/^(?:pick\s*\d+[:\.\s]*|round\s*\d+[:\.\s]*|\d+[\.\:\s]+)/i, '');
    clean = clean.split(/ - | \(|\s*,\s*[A-Z]{2,3}\b|\n/)[0].trim();
    clean = clean.replace(/\s+(?:IR|IR-LT|DTD|OUT|O|SSPD|NA|C|LW|RW|F|D|G)$/i, '').trim();
    return clean;
  }

  function notifySync(name, isMine, round, pickInRound) {
    const clean = cleanName(name);
    if (!clean || clean.length < 3 || clean.match(/^(?:round|pick|player|team|empty|none|draft)$/i)) return;
    if (sentPlayers.has(clean.toLowerCase())) return;
    sentPlayers.add(clean.toLowerCase());
    pickCount++;

    const cnt = document.getElementById('copilot-bm-count');
    if (cnt) cnt.textContent = pickCount + ' synced';
    
    fetch(SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: clean, isMine: isMine, round: round, pickInRound: pickInRound })
    })
    .then(r => r.json())
    .then(data => {
      console.log('[' + platform + ' Draft Sync] ✓ Synced pick #' + pickCount + ': ' + clean);
    })
    .catch(err => console.error('[' + platform + ' Draft Sync] Failed to sync ' + clean + ':', err));
  }

  function scanDraftBoard() {
    // 1. Toast Notification cards in bottom-right corner (ESPN)
    // Innermost small element holding both "Name / TEAM" and "R#, P#" (a page-wide
    // wrapper would also contain the Available Players list)
    const toastCandidates = Array.from(document.querySelectorAll("div, li, p, [role='alert'], [role='status']")).filter(el => {
      const t = el.textContent || '';
      return t.length < 300 && /R\d+,\s*P\d+/i.test(t) && /\/\s*[A-Z]{2,3}/.test(t);
    });
    toastCandidates.filter(el => !toastCandidates.some(o => o !== el && el.contains(o))).forEach(card => {
      if (isAvailablePlayer(card)) return;
      const txt = card.textContent || '';
      const rm = txt.match(/R(\d+),\s*P(\d+)/i);
      const pMatch = txt.match(/([A-Z][a-zA-Z\.\'\-\s]+?)\s*\/\s*([A-Z]{2,3})/i);
      if (pMatch && rm && pMatch.index <= rm.index) {
        notifySync(pMatch[1], false, parseInt(rm[1], 10), parseInt(rm[2], 10));
      }
    });

    // 2. Board tiles & cells strictly inside Draft Board
    const cells = document.querySelectorAll([
      '[class*="DraftBoard"] [class*="cell"]', '[class*="draftBoard"] [class*="cell"]',
      '[class*="draft-board"] [class*="cell"]', '[class*="DraftBoard"] [class*="tile"]',
      '[class*="DraftCell"]', '[class*="draftCell"]', '[class*="pickTile"]',
      '[class*="DraftPick"]', '.DraftBoard__pick'
    ].join(', '));

    cells.forEach(c => {
      if (isAvailablePlayer(c)) return;
      const link = c.querySelector('a[href*="player"], a[href*="athlete"], [data-player-id]');
      const raw = link ? (link.getAttribute('title') || link.textContent) : c.textContent;
      const isMine = c.classList.contains('my-team') || c.classList.contains('user-pick') || c.classList.contains('is-user');
      notifySync(raw, isMine);
    });

    // 3. Pick history & ticker announcements
    const items = document.querySelectorAll([
      '[class*="draftHistory"] tr', '[class*="DraftHistory"] tr', '[class*="DraftHistory"] div[class*="row"]',
      '[class*="pickHistory"] li', '[class*="activity"] li', '.ticker-item', '.draft-activity-item',
      '.chat-message', 'div[class*="feedItem"]', '.draft-results-table tr'
    ].join(', '));

    items.forEach(item => {
      if (isAvailablePlayer(item)) return;
      const txt = item.textContent || '';
      const m1 = txt.match(/(?:drafted|selected)\s+([A-Z][a-zA-Z\.\'\-\s]+?)(?:\s*,|\s*\(|\s+with|\s+as|\s+by|$)/i);
      if (m1 && m1[1]) notifySync(m1[1], false);
      const m2 = txt.match(/([A-Z][a-zA-Z\.\'\-\s]+?)\s+(?:was\s+drafted|drafted|selected)\s+by/i);
      if (m2 && m2[1]) notifySync(m2[1], false);
      if (/(?:drafted|selected|pick\s*#?\d+)/i.test(txt)) {
        const link = item.querySelector('a[href*="player"], a[href*="athlete"], [data-player-id], a.F-link');
        if (link) notifySync(link.getAttribute('title') || link.textContent, false);
      }
    });

    // 4. Top Banner
    const banners = document.querySelectorAll('[class*="lastPick"], [class*="recentPick"], [class*="onTheClock"], [class*="draftBanner"]');
    banners.forEach(b => {
      if (isAvailablePlayer(b)) return;
      const txt = b.textContent || '';
      const m = txt.match(/(?:selected|drafted|last pick[:\s]*|recent pick[:\s]*|pick\s*#?\d+[:\s]*)\s*([A-Z][a-zA-Z\.\'\-\s]+?)(?:\s*,|\s*\(|$)/i);
      if (m && m[1]) notifySync(m[1], false);
    });
  }

  scanDraftBoard();
  const obs = new MutationObserver(scanDraftBoard);
  obs.observe(document.body, { childList: true, subtree: true });
  setInterval(scanDraftBoard, 1000);

  alert('🏒 ' + platform + ' Draft Live Sync Activated!\nPicks will automatically stream to localhost:3333.');
})();
