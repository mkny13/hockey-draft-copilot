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
// appears verbatim in README.md and in AGENTS.md.
const routeRegex = /app\.(get|post|put|delete)\('(\/[^']*)'/g;
const routes = [];
let routeMatch;
while ((routeMatch = routeRegex.exec(serverJs)) !== null) {
  const route = routeMatch[2];
  if (!routes.includes(route)) {
    routes.push(route);
  }
}

for (const route of routes) {
  assert(
    readmeMd.includes(route),
    `README.md is missing route "${route}" from server.js`
  );
  assert(
    agentsMd.includes(route),
    `AGENTS.md is missing route "${route}" from server.js`
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

// 3. Every process.env.X name read by server.js appears in README.md.
const envRegex = /process\.env\.([A-Z0-9_]+)/g;
const envVars = [];
let envMatch;
while ((envMatch = envRegex.exec(serverJs)) !== null) {
  const envVar = envMatch[1];
  if (!envVars.includes(envVar)) {
    envVars.push(envVar);
  }
}

for (const envVar of envVars) {
  assert(
    readmeMd.includes(envVar),
    `README.md is missing environment variable "${envVar}" read by server.js`
  );
  assert(
    agentsMd.includes(envVar),
    `AGENTS.md is missing environment variable "${envVar}" read by server.js`
  );
}

console.log('✓ Docs surface matches server routes, test files, and environment variables');

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
console.log('ALL DOCS TESTS PASSED!');
