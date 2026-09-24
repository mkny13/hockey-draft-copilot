const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const serverJs = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
const readmeMd = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const agentsMd = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

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
// and every one is present in the test script in package.json.
const testDir = path.join(repoRoot, 'test');
const testFiles = fs.readdirSync(testDir)
  .filter((file) => /^test_.*\.js$/.test(file))
  .sort();

const testScript = (pkgJson.scripts && pkgJson.scripts.test) || '';

for (const file of testFiles) {
  assert(
    readmeMd.includes(file),
    `README.md is missing test file "${file}"`
  );
  assert(
    agentsMd.includes(file),
    `AGENTS.md is missing test file "${file}"`
  );
  assert(
    testScript.includes(file),
    `package.json test script is missing test file "${file}"`
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
}

console.log('✓ Docs surface matches server routes, test files, and environment variables');
console.log('ALL DOCS TESTS PASSED!');
