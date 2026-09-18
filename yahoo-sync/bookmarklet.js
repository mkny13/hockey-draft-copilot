/**
 * Yahoo Draft Live Sync Bookmarklet
 * 
 * Instructions:
 * 1. Create a new bookmark in Chrome/Safari/Brave with name "Sync Yahoo Draft"
 * 2. Paste this entire javascript: code as the URL.
 * 3. When inside your live Yahoo Draft room, click the bookmarklet!
 */
javascript:(function(){
  const SYNC_URL = 'http://localhost:3333/api/pick';
  console.log('[Yahoo Draft Sync] Initializing live observer...');
  
  const sentPlayers = new Set();
  
  function notifySync(name, team, pos, isMine) {
    if (!name || sentPlayers.has(name)) return;
    sentPlayers.add(name);
    
    fetch(SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, team: team, pos: pos, isMine: isMine })
    })
    .then(r => r.json())
    .then(data => {
      console.log('[Yahoo Draft Sync] Synced pick: ' + name + (isMine ? ' (MY TEAM)' : ''));
    })
    .catch(err => console.error('[Yahoo Draft Sync] Failed to sync ' + name + ':', err));
  }

  function scanDraftBoard() {
    // Strategy A: Yahoo live draft recent picks ticker & draft history table
    const rows = document.querySelectorAll('.draft-results-table tr, .table-draft-results tbody tr, #draft-tables tbody tr, .Grid-table tr');
    rows.forEach(row => {
      const nameEl = row.querySelector('.name, .player, [data-tst="player-name"], a.F-link');
      if (nameEl) {
        const name = nameEl.textContent.trim();
        const isMine = row.classList.contains('my-team') || row.classList.contains('user-pick') || !!row.querySelector('.is-user');
        notifySync(name, '', [], isMine);
      }
    });

    // Strategy B: Chat/ticker notifications (e.g. "Team X drafted Player Y")
    const tickerItems = document.querySelectorAll('.ticker-item, .draft-activity-item, .chat-message');
    tickerItems.forEach(item => {
      const text = item.textContent || '';
      const match = text.match(/drafted\s+([A-Z][a-zA-Z\.\'\-\s]+?)(?:\s+\(|\s+with|\s+as|$)/i);
      if (match && match[1]) {
        notifySync(match[1].trim(), '', [], false);
      }
    });
  }

  // Initial scan
  scanDraftBoard();

  // Set up live DOM mutation observer
  const observer = new MutationObserver(scanDraftBoard);
  observer.observe(document.body, { childList: true, subtree: true });

  // Backup poll every 2 seconds
  setInterval(scanDraftBoard, 2000);

  alert('🏒 Yahoo Draft Live Sync Activated!\nPicks will automatically stream to your Co-Pilot at localhost:3333.');
})();
