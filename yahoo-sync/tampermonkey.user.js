// ==UserScript==
// @name         ESPN & Yahoo Fantasy Hockey Draft Sync
// @namespace    http://localhost:3333/
// @version      1.2
// @description  Automatically streams live ESPN and Yahoo Fantasy Hockey draft picks to your Game Theory Co-Pilot
// @author       Antigravity
// @match        https://fantasy.espn.com/*
// @match        https://hockey.fantasysports.yahoo.com/*
// @match        https://draft.fantasysports.yahoo.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

(function() {
    'use strict';
    const SYNC_URL = 'http://localhost:3333/api/pick';
    const isEspn = window.location.hostname.includes('espn.com');
    console.log(`[${isEspn ? 'ESPN' : 'Yahoo'} Draft Sync UserScript] Watching draft board...`);

    const sentPlayers = new Set();

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
        clean = clean.replace(/^(?:pick\s*\d+[:\.\s]*|\d+[\.\:\s]+)/i, '');
        clean = clean.split(/ - | \(|\s*,\s*[A-Z]{2,3}\b/)[0].trim();
        clean = clean.replace(/\s+(?:IR|IR-LT|DTD|OUT|O|SSPD|NA)$/i, '').trim();
        return clean;
    }

    function sendPick(name, isMine) {
        const clean = cleanName(name);
        if (!clean || clean.length < 3 || clean.match(/^(?:round|pick|player|team|empty|none)$/i)) return;
        if (sentPlayers.has(clean.toLowerCase())) return;
        sentPlayers.add(clean.toLowerCase());

        GM_xmlhttpRequest({
            method: 'POST',
            url: SYNC_URL,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ name: clean, isMine: isMine }),
            onload: function(response) {
                console.log('[Draft Sync] Pick recorded:', clean, isMine ? '(MY TEAM)' : '');
            },
            onerror: function(err) {
                console.warn('[Draft Sync] Error syncing:', err);
            }
        });
    }

    function checkPicks() {
        const rows = document.querySelectorAll([
            'div[class*="draftHistory"] tr', 'div[class*="DraftHistory"] tr', 'div[class*="DraftHistory"] div[class*="row"]',
            'div[class*="draftPick"]', 'div[class*="DraftPick"]', '.DraftBoard__pick',
            '.draft-results-table tr', '.table-draft-results tbody tr', '#draft-tables tbody tr'
        ].join(', '));

        rows.forEach(row => {
            if (isAvailablePlayer(row)) return;
            const nameEl = row.querySelector([
                'a[href*="/hockey/player/_/id/"]', 'a[href*="/player/"]', 'a[href*="/athlete/"]',
                '.player-column__athlete', '[data-player-id]', '.name', '.player', '[data-tst="player-name"]', 'a.F-link'
            ].join(', '));

            if (nameEl) {
                const rawName = nameEl.getAttribute('title') || nameEl.textContent;
                const isMine = row.classList.contains('my-team') ||
                               row.classList.contains('user-pick') ||
                               row.classList.contains('is-user') ||
                               !!row.querySelector('.my-team, [data-tst="user-team"], [class*="myTeam"], [class*="userPick"]');
                sendPick(rawName, isMine);
            }
        });

        const tickerItems = document.querySelectorAll('.ticker-item, .draft-activity-item, .chat-message, div[class*="ticker"], div[class*="activity"]');
        tickerItems.forEach(item => {
            if (isAvailablePlayer(item)) return;
            const text = item.textContent || '';
            const m1 = text.match(/(?:drafted|selected)\s+([A-Z][a-zA-Z\.\'\-\s]+?)(?:\s*,|\s*\(|\s+with|\s+as|\s+by|$)/i);
            if (m1 && m1[1]) sendPick(m1[1], false);
            const m2 = text.match(/([A-Z][a-zA-Z\.\'\-\s]+?)\s+(?:was\s+drafted|drafted|selected)\s+by/i);
            if (m2 && m2[1]) sendPick(m2[1], false);
        });
    }

    setInterval(checkPicks, 1200);
})();
