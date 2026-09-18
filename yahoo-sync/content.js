(function() {
  const SYNC_URL = 'http://localhost:3333/api/pick';
  console.log('[Yahoo Draft Extension] Extension injected and monitoring picks.');

  const sent = new Set();

  function pushPick(name, isMine) {
    if (!name || sent.has(name)) return;
    sent.add(name);

    fetch(SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, isMine: isMine })
    }).catch(e => console.warn('[Yahoo Sync Extension] Sync offline:', e));
  }

  function check() {
    const rows = document.querySelectorAll('.draft-results-table tr, .table-draft-results tbody tr, #draft-tables tbody tr, .Grid-table tr');
    rows.forEach(row => {
      const nameEl = row.querySelector('.name, .player, [data-tst="player-name"], a.F-link');
      if (nameEl) {
        const name = nameEl.textContent.trim();
        const isMine = row.classList.contains('my-team') || row.classList.contains('user-pick');
        pushPick(name, isMine);
      }
    });
  }

  setInterval(check, 1500);
})();
