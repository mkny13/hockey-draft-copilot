const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const serverJs = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
const readmeMd = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const agentsMd = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

const runnerJs = fs.readFileSync(path.join(repoRoot, 'scripts', 'run_tests.js'), 'utf8');
const { TEST_FILES: runnerTestFiles } = require(path.join(repoRoot, 'scripts', 'run_tests.js'));

// 1. Every route literal matched by /app\.(get|post|put|delete)\('(\/[^']*)'/g in server.js
// appears verbatim in README.md and in AGENTS.md, and all endpoints mentioned in AGENTS.md
// match registered routes in server.js bidirectionally.
const routeRegex = /app\.(get|post|put|delete)\('(\/[^']*)'/g;
const routes = [];
let routeMatch;
while ((routeMatch = routeRegex.exec(serverJs)) !== null) {
  const route = routeMatch[2];
  if (!routes.includes(route)) {
    routes.push(route);
  }
}

// Locate the AGENTS.md code-map bullet for server.js. Tolerates `-` or `*` bullets and a `:`, `—`
// or `-` separator, so rewording the sentence after it does not break the checks.
function findServerEntry(agentsSource) {
  return agentsSource.split('\n').find((line) => /^\s*[-*]\s+`server\.js`\s*[:—–-]/.test(line));
}

// Every backticked path token (`/api/...`, `/draft_data.json`) in the server.js entry, wherever it
// sits in the sentence. URLs (`https://...`) and non-path tokens are ignored.
function extractAgentsServerEntryRoutes(agentsSource) {
  const entry = findServerEntry(agentsSource);
  if (!entry) return [];
  return [...new Set([...entry.matchAll(/`(\/[a-zA-Z0-9_./-]+)`/g)].map((m) => m[1]))];
}

function extractAgentsEndpoints(agentsSource) {
  const endpoints = new Set(extractAgentsServerEntryRoutes(agentsSource));

  const methodRouteRegex = /\b(?:GET|POST|PUT|DELETE|PATCH)\s+`?(\/[a-zA-Z0-9_./-]+)`?/g;
  let m;
  while ((m = methodRouteRegex.exec(agentsSource)) !== null) {
    endpoints.add(m[1].replace(/[`'"]+/g, ''));
  }

  const apiRouteRegex = /(?:^|[\s`("'<])(\/(?:api\/[a-zA-Z0-9_/-]+(?:\.[a-z]+)?|draft_data\.json))(?=[`)"'\s,.<]|$)/g;
  while ((m = apiRouteRegex.exec(agentsSource)) !== null) {
    endpoints.add(m[1].replace(/[.,;:!]+$/, '').replace(/[`'"]+/g, ''));
  }

  return [...endpoints];
}

assert(findServerEntry(agentsMd), 'AGENTS.md is missing the "- `server.js`:" code-map entry');
const agentsServerEntryRoutes = extractAgentsServerEntryRoutes(agentsMd);

for (const route of routes) {
  assert(
    readmeMd.includes(route),
    `README.md is missing route "${route}" from server.js`
  );
  assert(
    agentsMd.includes(route),
    `AGENTS.md is missing route "${route}" from server.js`
  );
  assert(
    agentsServerEntryRoutes.includes(route),
    `AGENTS.md server.js endpoints list is missing route "${route}"`
  );
}

// Bidirectional check: every endpoint mentioned in AGENTS.md must be a registered route in server.js.
const agentsEndpoints = extractAgentsEndpoints(agentsMd);
for (const endpoint of agentsEndpoints) {
  assert(
    routes.includes(endpoint),
    `AGENTS.md mentions endpoint "${endpoint}" which is not registered in server.js`
  );
}

// Bidirectional check: every endpoint mentioned in README.md must be a registered route in server.js.
const readmeApiRouteRegex = /(?:^|[\s`("'<])(\/(?:api\/[a-zA-Z0-9_/-]+(?:\.[a-z]+)?|draft_data\.json))(?=[`)"'\s,.<]|$)/g;
let rm;
while ((rm = readmeApiRouteRegex.exec(readmeMd)) !== null) {
  const endpoint = rm[1].replace(/[.,;:!]+$/, '').replace(/[`'"]+/g, '');
  assert(
    routes.includes(endpoint),
    `README.md mentions endpoint "${endpoint}" which is not registered in server.js`
  );
}

// 2. Every test/test_*.js filename on disk appears in README.md and in AGENTS.md,
// and every one is present in the runner's TEST_FILES list in scripts/run_tests.js.
const testDir = path.join(repoRoot, 'test');
const testFiles = fs.readdirSync(testDir)
  .filter((file) => /^test_.*\.js$/.test(file))
  .sort();

for (const file of testFiles) {
  assert(
    runnerTestFiles.includes(file) && runnerJs.includes(file),
    `scripts/run_tests.js is missing test file "${file}"`
  );
  assert(
    readmeMd.includes(file),
    `README.md is missing test file "${file}"`
  );
  assert(
    agentsMd.includes(file),
    `AGENTS.md is missing test file "${file}"`
  );
}

// 3. Every process.env.X name read by server.js appears in README.md and AGENTS.md,
// and all env-var default values mentioned in AGENTS.md match server.js bidirectionally.
const envRegex = /process\.env\.([A-Z0-9_]+)/g;
const envVars = [];
let envMatch;
while ((envMatch = envRegex.exec(serverJs)) !== null) {
  const envVar = envMatch[1];
  if (!envVars.includes(envVar)) {
    envVars.push(envVar);
  }
}

// Reads the fallback for each process.env.X in server.js. Supported forms, after `||` or `??` on the
// same statement: a number/string literal, or path.join(..., 'file') (reported as 'file').
// Anything else lands in `unparsed`, which the checks below fail on with a pointer here.
function extractServerEnvDefaults(serverSource, vars) {
  const defaults = {};
  const unparsed = [];
  for (const name of vars) {
    const re = new RegExp(
      `process\\.env\\.${name}\\b[^;\\n]*?(?:\\|\\||\\?\\?)\\s*` +
      `(?:path\\.join\\([^)]*?['"]([^'"]+)['"]\\s*\\)|['"]([^'"]*)['"]|(-?\\d+(?:\\.\\d+)?)\\b)`
    );
    const m = serverSource.match(re);
    if (m) {
      defaults[name] = m[1] ?? m[2] ?? m[3];
    } else {
      unparsed.push(name);
    }
  }
  return { defaults, unparsed };
}

function extractAgentsEnvDefaults(agentsSource) {
  const defaults = {};
  // Anywhere in the server.js entry: `X` (default `v`) or X (default v).
  const sLine = findServerEntry(agentsSource);
  if (sLine) {
    const re = /`?([A-Z0-9_]+)`?\s*\(default\s*`?([^\s,`)]+)`?/g;
    let m;
    while ((m = re.exec(sLine)) !== null) {
      defaults[m[1]] = m[2];
    }
  }

  const globalDefaultRegex = /`([A-Z0-9_]+)`\s*\(default\s*`([^`]+)`/g;
  let gm;
  while ((gm = globalDefaultRegex.exec(agentsSource)) !== null) {
    defaults[gm[1]] = gm[2];
  }
  return defaults;
}

const { defaults: serverEnvDefaults, unparsed: unparsedServerEnv } = extractServerEnvDefaults(serverJs, envVars);
const agentsEnvDefaults = extractAgentsEnvDefaults(agentsMd);

assert.deepStrictEqual(
  unparsedServerEnv,
  [],
  `test_docs.js could not read the default for ${unparsedServerEnv.join(', ')} in server.js; ` +
  'write it as `process.env.X || <literal>` / `?? <literal>` / `|| path.join(..., \'file\')`, ' +
  'or extend extractServerEnvDefaults in test/test_docs.js'
);

for (const envVar of envVars) {
  assert(
    readmeMd.includes(envVar),
    `README.md is missing environment variable "${envVar}" read by server.js`
  );
  assert(
    agentsMd.includes(envVar),
    `AGENTS.md is missing environment variable "${envVar}" read by server.js`
  );
  assert(
    agentsEnvDefaults[envVar] !== undefined,
    `AGENTS.md is missing documented default value for environment variable "${envVar}"`
  );
  assert.strictEqual(
    agentsEnvDefaults[envVar],
    serverEnvDefaults[envVar],
    `Default value for "${envVar}" in AGENTS.md ("${agentsEnvDefaults[envVar]}") does not match server.js ("${serverEnvDefaults[envVar]}")`
  );
}

for (const envVar of Object.keys(agentsEnvDefaults)) {
  assert(
    envVars.includes(envVar),
    `AGENTS.md documents default for environment variable "${envVar}" which is not read by server.js`
  );
}

// Invariant self-checks: verify that guard assertions catch unregistered endpoints or inaccurate defaults
assert.throws(
  () => {
    const tamperedEndpoints = extractAgentsEndpoints(agentsMd.replace('endpoints `/api/pick`', 'endpoints `/api/unregistered_endpoint`, `/api/pick`'));
    for (const ep of tamperedEndpoints) {
      assert(routes.includes(ep), `AGENTS.md mentions endpoint "${ep}" which is not registered in server.js`);
    }
  },
  /AGENTS\.md mentions endpoint "\/api\/unregistered_endpoint" which is not registered in server\.js/
);

assert.throws(
  () => {
    const tamperedDefaults = extractAgentsEnvDefaults(agentsMd.replace('default `3333`', 'default `9999`'));
    for (const v of envVars) {
      assert.strictEqual(tamperedDefaults[v], serverEnvDefaults[v]);
    }
  },
  /AssertionError/
);

assert.throws(
  () => {
    const tamperedDefaults = extractAgentsEnvDefaults(agentsMd.replace('`PORT` (default `3333`)', '`PORT` (default `3333`), `UNREGISTERED_ENV` (default `123`)'));
    for (const v of Object.keys(tamperedDefaults)) {
      assert(envVars.includes(v), `AGENTS.md documents default for environment variable "${v}" which is not read by server.js`);
    }
  },
  /AGENTS\.md documents default for environment variable "UNREGISTERED_ENV" which is not read by server\.js/
);

// Parser robustness self-checks: rewording the AGENTS.md server.js entry must not break the
// endpoint/default extraction, and a server.js default the parser cannot read must be reported
// rather than silently skipped.
{
  const reworded = agentsMd
    .replace('- `server.js`:', '* `server.js` —')
    .replace('Reads env vars', 'Environment:')
    .replace('. Manages', '. It keeps')
    .replace('endpoints `/api/pick`', 'routes `/api/pick`')
    .replace(', and live WS broadcast', ', plus a live WS broadcast');
  assert.notStrictEqual(reworded, agentsMd, 'reworded fixture must differ from AGENTS.md');
  assert.deepStrictEqual(
    [...extractAgentsServerEntryRoutes(reworded)].sort(),
    [...extractAgentsServerEntryRoutes(agentsMd)].sort(),
    'rewording the AGENTS.md server.js entry changed the extracted endpoint list'
  );
  for (const route of routes) {
    assert(extractAgentsServerEntryRoutes(reworded).includes(route), `reworded entry lost route ${route}`);
  }
  assert.deepStrictEqual(extractAgentsEnvDefaults(reworded), extractAgentsEnvDefaults(agentsMd));

  const fakeServer = [
    "const A = process.env.A_VAR || 3333;",
    "const B = process.env.B_VAR ?? 'x.json';",
    "const C = Number(process.env.C_VAR ?? 42);",
    "const D = process.env.D_VAR || path.join(__dirname, 'd.json');",
    "const E = process.env.E_VAR ? 1 : 2;",
  ].join('\n');
  const parsed = extractServerEnvDefaults(fakeServer, ['A_VAR', 'B_VAR', 'C_VAR', 'D_VAR', 'E_VAR']);
  assert.deepStrictEqual(parsed.defaults, { A_VAR: '3333', B_VAR: 'x.json', C_VAR: '42', D_VAR: 'd.json' });
  assert.deepStrictEqual(parsed.unparsed, ['E_VAR']);
}

console.log('✓ Docs surface matches server routes, test files, and environment variables');

// 1b. No machine-specific absolute paths (e.g. /Volumes/... or /Users/...) may leak into
// tracked docs or AGENTS.md; the README's `claude mcp add` command must use a repo-relative
// path so it works from any checkout.
const absPathRegex = /(\/(?:Volumes|Users|home|tmp|var|private|opt|srv|mnt|media)\/[^\s`"'<>]+)/g;
for (const doc of [readmeMd, agentsMd]) {
  let absMatch;
  while ((absMatch = absPathRegex.exec(doc)) !== null) {
    assert(
      false,
      `docs contain a machine-specific absolute path: "${absMatch[1]}"`
    );
  }
}
console.log('✓ Docs contain no machine-specific absolute paths');

// 4. Every repo path named in backticks in AGENTS.md that looks like a file path exists on
// disk somewhere in the repo (exact relative-path match, or by basename for a bare filename
// like `background.js` that is documented under a preceding `yahoo-sync/` bullet).
const PATH_ALLOWLIST = new Set(['draft_state.json', 'draft_data.local.json']);

function listRepoFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listRepoFiles(full, out);
    } else {
      out.push(path.relative(repoRoot, full));
    }
  }
  return out;
}

const repoFiles = listRepoFiles(repoRoot, []);
const repoFileSet = new Set(repoFiles);
const repoBasenames = new Set(repoFiles.map((f) => path.basename(f)));

const pathRegex = /^[\w./-]+\.(js|json|md|sh|css|html)$/;
const backtickRegex = /`([^`]+)`/g;
const candidatePaths = [];
// Fenced ```code blocks``` contain an odd number of backtick characters clustered together
// (the 3-backtick fence), which flips open/close parity for every inline `backtick` span
// that follows; strip fences first so the rest of the file re-syncs correctly.
const agentsMdProse = agentsMd.replace(/```[\s\S]*?```/g, '');
let backtickMatch;
while ((backtickMatch = backtickRegex.exec(agentsMdProse)) !== null) {
  const candidate = backtickMatch[1];
  if (pathRegex.test(candidate) && !candidatePaths.includes(candidate)) {
    candidatePaths.push(candidate);
  }
}

for (const candidate of candidatePaths) {
  if (PATH_ALLOWLIST.has(candidate)) continue;
  const stripped = candidate.replace(/^\//, '');
  const existsExact = repoFileSet.has(stripped);
  const existsByBasename = !stripped.includes('/') && repoBasenames.has(stripped);
  if (existsExact || existsByBasename) continue;
  // A bare *.html filename with no directory is treated as an example argument to the
  // ingest command (e.g. a saved ADP page), not a real repo path.
  if (/\.html$/.test(candidate) && !candidate.includes('/')) continue;
  assert(
    false,
    `AGENTS.md names a repo path that does not exist on disk: "${candidate}"`
  );
}

console.log('✓ AGENTS.md file references resolve to real repo paths');

// 5. Every `npm <script>` invocation in AGENTS.md names a script defined in package.json.
const scripts = pkgJson.scripts || {};

const npmRunRegex = /npm run ([\w:-]+)/g;
let npmRunMatch;
while ((npmRunMatch = npmRunRegex.exec(agentsMd)) !== null) {
  const scriptName = npmRunMatch[1];
  assert(
    Object.prototype.hasOwnProperty.call(scripts, scriptName),
    `AGENTS.md runs "npm run ${scriptName}" but package.json has no such script`
  );
}

for (const alias of ['test', 'start']) {
  const aliasRegex = new RegExp(`npm ${alias}\\b`);
  if (aliasRegex.test(agentsMd)) {
    assert(
      Object.prototype.hasOwnProperty.call(scripts, alias),
      `AGENTS.md runs "npm ${alias}" but package.json has no "${alias}" script`
    );
  }
}

console.log('✓ AGENTS.md npm invocations name real package.json scripts');

// 6. CLAUDE.md stays a pure pointer to AGENTS.md so rules never fork into a second file.
const claudeMd = fs.readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
assert(
  claudeMd.trim() === '@AGENTS.md',
  'CLAUDE.md must contain only the "@AGENTS.md" pointer; move any new rules into AGENTS.md instead'
);

console.log('✓ CLAUDE.md remains a pure @AGENTS.md pointer');
// 7. The verification, test-seam, finishing and extension rules stay present, and every seam
// identifier and script path they name still exists where AGENTS.md says it does.
for (const heading of ['## Verifying a change', '## Test seams', '## Finishing a run']) {
  assert(
    agentsMd.includes(`\n${heading}\n`),
    `AGENTS.md is missing the section heading "${heading}"`
  );
}
assert(
  /\*\*Extension changes:\*\*/.test(agentsMd) && agentsMd.includes('yahoo-sync/manifest.json'),
  'AGENTS.md is missing the "Extension changes" convention naming yahoo-sync/manifest.json'
);

const seamSources = {
  DRAFT_STATE_FILE: 'server.js',
  __COPILOT_SCAN_MS: 'yahoo-sync/content.js',
  __copilotScanInterval: 'yahoo-sync/content.js',
  __fetchMode: 'test/test_sync.js',
  TEST_TIMEOUT_MS: 'scripts/run_tests.js',
  TEST_SLOW_MS: 'scripts/run_tests.js'
};
const seamsSection = (agentsMd.split('\n## Test seams\n')[1] || '').split('\n## ')[0];
for (const [seam, file] of Object.entries(seamSources)) {
  assert(
    seamsSection.includes(seam) && seamsSection.includes(`\`${file}\``),
    `AGENTS.md "Test seams" must name ${seam} and its home file ${file}`
  );
  assert(
    fs.readFileSync(path.join(repoRoot, file), 'utf8').includes(seam),
    `Test seam "${seam}" no longer appears in ${file}, where AGENTS.md says it lives`
  );
}

const mockDraftMatch = agentsMd.match(/node (scripts\/mock_draft\.js)/);
assert(mockDraftMatch, 'AGENTS.md must show the "node scripts/mock_draft.js" strategy check command');
assert(
  fs.existsSync(path.join(repoRoot, mockDraftMatch[1])),
  `AGENTS.md mock-draft command names a script that does not exist: ${mockDraftMatch[1]}`
);

console.log('✓ AGENTS.md workflow sections, test seams, and mock-draft path are present and real');
// 4. README's stated Node versions match package.json engines.node.
const enginesRange = (pkgJson.engines || {}).node || '';
const enginesFloors = [...enginesRange.matchAll(/(?:\^|>=)\s*(\d+)\.(\d+)/g)].map((m) => m[1] + '.' + m[2]);
assert(enginesFloors.length, 'package.json must declare engines.node as a range of "^X.Y.Z" / ">=X.Y.Z" terms');
const readmeNode = readmeMd.match(/Node\.js\]\([^)]*\)\s*([^(]+?)\s*\(/);
assert(readmeNode, 'README.md must state the Node.js versions as "<major>.<minor>+" terms before a parenthesis');
const readmeFloors = [...readmeNode[1].matchAll(/(\d+\.\d+|\d+)\+/g)].map((m) => (m[1].includes('.') ? m[1] : m[1] + '.0'));
assert.deepStrictEqual(readmeFloors, enginesFloors, 'README Node versions must match package.json engines.node');

// 5. Every relative link/image in README resolves on disk; every #anchor matches a heading slug.
const slug = (h) => h.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-');
const slugs = new Set(readmeMd.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => slug(l.replace(/^#+\s+/, ''))));
const targets = [...readmeMd.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1])
  .concat([...readmeMd.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]));
for (const t of targets) {
  if (/^[a-z]+:/i.test(t)) continue;
  if (t.startsWith('#')) {
    assert(slugs.has(t.slice(1)), `README.md anchor ${t} matches no heading`);
  } else {
    assert(fs.existsSync(path.join(repoRoot, t.split('#')[0])), `README.md links to a missing file: ${t}`);
  }
}

// 6. Every --flag scripts/mock_draft.js parses appears in README.md.
const mockSrc = fs.readFileSync(path.join(repoRoot, 'scripts', 'mock_draft.js'), 'utf8');
const mockFlags = [...new Set([...mockSrc.matchAll(/argv\[i\] === '(--[a-z]+)'/g)].map((m) => m[1]))];
assert(mockFlags.length >= 5, 'expected to find the mock_draft.js flags');
for (const flag of mockFlags) {
  assert(new RegExp(`${flag}\\b`).test(readmeMd), `README.md is missing mock_draft.js flag ${flag}`);
}

console.log('✓ README Node floor, links, anchors, and mock_draft flags match the repo');
// 7. Every directory holding a package.json (outside node_modules) has a Dependabot npm entry.
const dependabotYml = fs.readFileSync(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
const dependabotNpmDirs = new Set();
for (const block of dependabotYml.split(/\n\s*-\s+(?=package-ecosystem:)/).slice(1)) {
  const eco = block.match(/package-ecosystem:\s*["']?([\w-]+)/);
  const dir = block.match(/directory:\s*["']?([^"'\s]+)/);
  if (eco && dir && eco[1] === 'npm') dependabotNpmDirs.add(dir[1].replace(/(.)\/$/, '$1'));
}
const packageDirs = repoFiles
  .filter((f) => path.basename(f) === 'package.json')
  .map((f) => '/' + path.dirname(f).split(path.sep).join('/'))
  .map((d) => (d === '/.' ? '/' : d));
assert(packageDirs.includes('/') && packageDirs.includes('/mcp'), 'expected package.json at / and /mcp');
for (const dir of packageDirs) {
  assert(dependabotNpmDirs.has(dir), `.github/dependabot.yml has no npm entry for ${dir} (holds a package.json)`);
}
console.log('✓ Dependabot npm entries cover every package.json directory');

console.log('ALL DOCS TESTS PASSED!');
