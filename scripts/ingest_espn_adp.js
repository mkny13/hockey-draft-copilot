const fs = require('fs');
const path = require('path');

const DRAFT_DATA_PATH = path.join(__dirname, '..', 'draft_data.json');
const PUBLIC_DRAFT_DATA_PATH = path.join(__dirname, '..', 'public', 'draft_data.json');

// Saved HTML of the Hashtag Hockey ADP page: node scripts/ingest_espn_adp.js <file.html>
const HASHTAG_PATH = process.argv[2] || process.env.HASHTAG_HTML || '';

function normalizeName(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') // strip punctuation and spaces
    .trim();
}

function parseHashtagHockey(html) {
  const map = new Map();
  // Matching <tr data-madp='...' data-yadp='...' data-eadp='...'> ... <span class="d-none d-sm-inline">Connor McDavid</span>
  const reg = /<tr data-madp=[\x27\x22]([^\x27\x22]*)[\x27\x22] data-yadp=[\x27\x22]([^\x27\x22]*)[\x27\x22] data-eadp=[\x27\x22]([^\x27\x22]*)[\x27\x22]>[\s\S]*?<span class="d-none d-sm-inline">([^<]+)<\/span>/g;
  let m;
  while ((m = reg.exec(html))) {
    const rawName = m[4].trim();
    const eadp = parseFloat(m[3]);
    const yadp = parseFloat(m[2]);
    const madp = parseFloat(m[1]);
    const norm = normalizeName(rawName);

    map.set(norm, {
      name: rawName,
      espn: !isNaN(eadp) && eadp > 0 ? eadp : null,
      yahoo: !isNaN(yadp) && yadp > 0 ? yadp : null,
      blend: !isNaN(madp) && madp > 0 ? madp : null
    });
  }
  return map;
}

// ADP values from the source are plain numbers with at most one decimal place; anything
// else is a mis-split parse and must not reach the board.
function cleanAdp(v) {
  return v !== null && v !== undefined && Math.abs(Math.round(v * 10) / 10 - v) < 1e-9 ? v : null;
}

function run() {
  console.log('--- Ingesting ESPN ADP Data ---');
  if (!fs.existsSync(DRAFT_DATA_PATH)) {
    console.error('draft_data.json not found at', DRAFT_DATA_PATH);
    process.exit(1);
  }

  const draftData = JSON.parse(fs.readFileSync(DRAFT_DATA_PATH, 'utf8'));

  let hashtagMap = new Map();
  if (HASHTAG_PATH && fs.existsSync(HASHTAG_PATH)) {
    console.log('Parsing Hashtag Hockey data...');
    const htHtml = fs.readFileSync(HASHTAG_PATH, 'utf8');
    hashtagMap = parseHashtagHockey(htHtml);
    console.log(`Found ${hashtagMap.size} players in Hashtag Hockey dataset.`);
  }

  // Update draftData players
  let matchedCount = 0;
  let espnCount = 0;

  for (const player of draftData.players) {
    const norm = normalizeName(player.n);
    const ht = hashtagMap.get(norm);

    const espnAdp = ht ? cleanAdp(ht.espn) : null;

    // Keep the board's own Yahoo ADP unless it is corrupt, then fall back to Hashtag Hockey
    let yahooAdp = cleanAdp(player.adp ? (player.adp.yahoo || null) : null);
    if (!yahooAdp && ht) yahooAdp = cleanAdp(ht.yahoo);

    let avgAdp = player.adp ? (player.adp.average || null) : null;
    if (ht && ht.blend) avgAdp = ht.blend;

    // Build updated adp object (stale ESPN values from earlier ingests are replaced)
    if (!player.adp) player.adp = {};
    delete player.adp.espn;
    delete player.adp.yahoo;
    if (espnAdp !== null) {
      player.adp.espn = espnAdp;
      espnCount++;
    }
    if (yahooAdp !== null) {
      player.adp.yahoo = yahooAdp;
    }
    if (avgAdp !== null) {
      player.adp.average = avgAdp;
    }

    if (espnAdp !== null || ht) {
      matchedCount++;
    }
  }

  // Update model config in draftData
  if (!draftData.config) draftData.config = {};
  if (!draftData.config.model) draftData.config.model = {};
  draftData.config.model.adp_source = 'espn';

  console.log(`Matched ${matchedCount} total players. Assigned ESPN ADP to ${espnCount} players.`);

  // Write back to draft_data.json and public/draft_data.json
  const updatedJson = JSON.stringify(draftData, null, 2);
  fs.writeFileSync(DRAFT_DATA_PATH, updatedJson, 'utf8');
  fs.writeFileSync(PUBLIC_DRAFT_DATA_PATH, updatedJson, 'utf8');
  console.log('✓ Successfully wrote updated draft_data.json and public/draft_data.json');
}

run();
