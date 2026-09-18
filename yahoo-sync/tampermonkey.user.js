// ==UserScript==
// @name         Yahoo Fantasy Hockey Draft Sync
// @namespace    http://localhost:3333/
// @version      1.0
// @description  Automatically streams live Yahoo Fantasy Hockey draft picks to your Game Theory Co-Pilot
// @author       Antigravity
// @match        https://hockey.fantasysports.yahoo.com/*
// @match        https://draft.fantasysports.yahoo.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

(function() {
    'use strict';
    const SYNC_URL = 'http://localhost:3333/api/pick';
    console.log('[Yahoo Draft Sync UserScript] Watching draft board...');

    const sentPlayers = new Set();

    function sendPick(name, isMine) {
        if (!name || sentPlayers.has(name)) return;
        sentPlayers.add(name);

        GM_xmlhttpRequest({
            method: 'POST',
            url: SYNC_URL,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ name: name, isMine: isMine }),
            onload: function(response) {
                console.log('[Yahoo Sync] Pick recorded:', name);
            },
            onerror: function(err) {
                console.warn('[Yahoo Sync] Error syncing:', err);
            }
        });
    }

    function checkPicks() {
        const rows = document.querySelectorAll('.draft-results-table tr, .table-draft-results tbody tr, #draft-tables tbody tr, .Grid-table tr');
        rows.forEach(row => {
            const nameEl = row.querySelector('.name, .player, [data-tst="player-name"], a.F-link');
            if (nameEl) {
                const name = nameEl.textContent.trim();
                const isMine = row.classList.contains('my-team') || row.classList.contains('user-pick') || !!row.querySelector('.is-user');
                sendPick(name, isMine);
            }
        });

        const tickerItems = document.querySelectorAll('.ticker-item, .draft-activity-item, .chat-message');
        tickerItems.forEach(item => {
            const text = item.textContent || '';
            const match = text.match(/drafted\s+([A-Z][a-zA-Z\.\'\-\s]+?)(?:\s+\(|\s+with|\s+as|$)/i);
            if (match && match[1]) {
                sendPick(match[1].trim(), false);
            }
        });
    }

    setInterval(checkPicks, 1500);
})();
