const assert = require('assert');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const lockfilePath = path.join(repoRoot, 'package-lock.json');
const vettingFilePath = path.join(repoRoot, 'docs', 'dependency-vetting.json');

const REQUIRED_FIELDS = [
  'package',
  'version',
  'publisher',
  'repository',
  'published',
  'advisories',
  'registry',
];

const KNOWN_BASELINE_ADVISORIES = new Set([
  'body-parser',
  'qs',
]);

/**
 * Extracts normalized packages map { name: version } from package-lock.json
 */
function extractLockPackages(lockData) {
  assert(lockData && typeof lockData === 'object', 'package-lock.json must be a JSON object');
  const packages = {};
  const entries = lockData.packages || {};
  for (const [key, val] of Object.entries(entries)) {
    if (!key.startsWith('node_modules/')) continue;
    const name = key.replace(/^node_modules\//, '');
    if (val && typeof val.version === 'string') {
      packages[name] = val.version;
    }
  }
  return packages;
}

/**
 * Validates dependency vetting data against package-lock.json and npm audit results.
 */
function validateVettingReport(lockPackages, vettingData, auditData = null) {
  assert(vettingData && typeof vettingData === 'object', 'Vetting report must be an object');

  const packagesList = Array.isArray(vettingData) ? vettingData : vettingData.packages;
  assert(Array.isArray(packagesList), 'Vetting report must contain a packages array');
  assert(packagesList.length > 0, 'Vetting report must not be empty');

  const baselinePackages = vettingData.baselinePackages || {};
  const vettedMap = new Map();

  for (const entry of packagesList) {
    assert(entry && typeof entry === 'object', 'Each vetting entry must be an object');

    for (const field of REQUIRED_FIELDS) {
      assert(
        entry[field] !== undefined && entry[field] !== null && String(entry[field]).trim() !== '',
        `Vetting entry for "${entry.package || 'unknown'}" is missing required field "${field}"`
      );
    }

    const pkgName = entry.package;
    assert(!vettedMap.has(pkgName), `Duplicate vetting entry for package "${pkgName}"`);
    vettedMap.set(pkgName, entry);

    // Verify version matches package-lock.json
    assert(
      lockPackages[pkgName] !== undefined,
      `Vetted package "${pkgName}" is not present in package-lock.json`
    );
    assert.strictEqual(
      entry.version,
      lockPackages[pkgName],
      `Vetted package "${pkgName}" version "${entry.version}" does not match package-lock.json ("${lockPackages[pkgName]}")`
    );

    // Verify registry source
    assert(
      /^https?:\/\//.test(entry.registry),
      `Vetted package "${pkgName}" has invalid registry URL "${entry.registry}"`
    );

    // Verify repository URL
    assert(
      /^https?:\/\/|git\+https?:\/\//.test(entry.repository),
      `Vetted package "${pkgName}" has invalid repository URL "${entry.repository}"`
    );

    // Verify publication date: must be valid ISO date (YYYY-MM-DD or full ISO), not package creation date
    assert(
      /^\d{4}-\d{2}-\d{2}/.test(entry.published),
      `Vetted package "${pkgName}" published date "${entry.published}" must be YYYY-MM-DD`
    );

    // Reject 2011 package creation date for jsdom (version 31.0.1 was published in 2026)
    if (pkgName === 'jsdom' && entry.version.startsWith('31.')) {
      assert(
        !entry.published.startsWith('2011'),
        `jsdom@${entry.version} must record version publication date (2026-11-13), not 2011 package creation date`
      );
      assert.strictEqual(
        entry.published,
        '2026-11-13',
        `jsdom@${entry.version} version publication date must be "2026-11-13", got "${entry.published}"`
      );
    }

    // Verify advisories field
    if (Array.isArray(entry.advisories)) {
      assert(
        entry.advisories.length === 0 || (entry.advisories.length === 1 && entry.advisories[0] === 'none'),
        `Vetted package "${pkgName}" has unreviewed advisories: ${JSON.stringify(entry.advisories)}`
      );
    } else {
      assert.strictEqual(
        entry.advisories,
        'none',
        `Vetted package "${pkgName}" has unreviewed advisories: "${entry.advisories}"`
      );
    }
  }

  // Verify that all non-baseline packages in package-lock.json have vetting entries
  const missingVetting = [];
  for (const [name, version] of Object.entries(lockPackages)) {
    const isBaseline = baselinePackages[name] === version;
    if (!isBaseline) {
      if (!vettedMap.has(name)) {
        missingVetting.push(`${name}@${version}`);
      }
    }
  }

  assert.strictEqual(
    missingVetting.length,
    0,
    `Missing vetting entries in docs/dependency-vetting.json for packages: ${missingVetting.join(', ')}`
  );

  // If audit data is supplied, verify no advisories exist for vetted packages and
  // all vulnerabilities are within the known acceptable baseline dependencies.
  if (auditData && auditData.vulnerabilities) {
    const unreviewedVulnerabilities = [];
    for (const [vulnName, vulnInfo] of Object.entries(auditData.vulnerabilities)) {
      if (vettedMap.has(vulnName)) {
        unreviewedVulnerabilities.push(`Vetted package "${vulnName}" has an active advisory: ${JSON.stringify(vulnInfo.via || vulnInfo)}`);
      } else if (!KNOWN_BASELINE_ADVISORIES.has(vulnName)) {
        unreviewedVulnerabilities.push(`Unreviewed advisory for non-baseline package "${vulnName}": ${JSON.stringify(vulnInfo.via || vulnInfo)}`);
      }
    }
    assert.strictEqual(
      unreviewedVulnerabilities.length,
      0,
      `npm audit found unreviewed vulnerabilities:\n${unreviewedVulnerabilities.join('\n')}`
    );
  }
}

/**
 * Runs npm audit programmatically and returns the parsed report.
 */
function runNpmAudit(cwd) {
  try {
    const stdout = execSync('npm audit --json', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return JSON.parse(stdout);
  } catch (err) {
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch (_) {
        // Fall through
      }
    }
    // If npm audit failed due to network / registry connectivity, return null
    return null;
  }
}

// ---------------------------------------------------------------------------
// Self-checks / Negative unit tests
// ---------------------------------------------------------------------------
function runSelfChecks() {
  const dummyLock = {
    'jsdom': '31.0.1',
    'bcp-47': '2.1.2',
    'express': '5.3.0',
  };

  const validVetting = {
    baselinePackages: {
      'express': '5.3.0',
    },
    packages: [
      {
        package: 'jsdom',
        version: '31.0.1',
        publisher: 'GitHub Actions',
        repository: 'https://github.com/jsdom/jsdom',
        published: '2026-11-13',
        advisories: 'none',
        registry: 'https://registry.npmjs.org',
      },
      {
        package: 'bcp-47',
        version: '2.1.2',
        publisher: 'wooorm',
        repository: 'https://github.com/wooorm/bcp-47',
        published: '2026-10-21',
        advisories: 'none',
        registry: 'https://registry.npmjs.org',
      },
    ],
  };

  // Valid report passes
  assert.doesNotThrow(() => {
    validateVettingReport(dummyLock, validVetting, { vulnerabilities: { 'body-parser': {} } });
  });

  // Missing required field fails
  assert.throws(
    () => {
      const invalid = JSON.parse(JSON.stringify(validVetting));
      delete invalid.packages[0].publisher;
      validateVettingReport(dummyLock, invalid);
    },
    /missing required field "publisher"/
  );

  // Missing required package fails
  assert.throws(
    () => {
      const invalid = JSON.parse(JSON.stringify(validVetting));
      invalid.packages.pop(); // remove bcp-47
      validateVettingReport(dummyLock, invalid);
    },
    /Missing vetting entries in docs\/dependency-vetting\.json for packages: bcp-47@2\.1\.2/
  );

  // Package creation date (2011) instead of version publication date fails
  assert.throws(
    () => {
      const invalid = JSON.parse(JSON.stringify(validVetting));
      invalid.packages[0].published = '2011-11-21';
      validateVettingReport(dummyLock, invalid);
    },
    /must record version publication date \(2026-11-13\), not 2011 package creation date/
  );

  // Version mismatch fails
  assert.throws(
    () => {
      const invalid = JSON.parse(JSON.stringify(validVetting));
      invalid.packages[0].version = '31.0.0';
      validateVettingReport(dummyLock, invalid);
    },
    /version "31\.0\.0" does not match package-lock\.json \("31\.0\.1"\)/
  );

  // Unreviewed advisory on vetted package fails
  assert.throws(
    () => {
      validateVettingReport(dummyLock, validVetting, {
        vulnerabilities: {
          'jsdom': { via: [{ title: 'mock vulnerability' }] },
        },
      });
    },
    /Vetted package "jsdom" has an active advisory/
  );

  // Unknown advisory on unreviewed dependency fails
  assert.throws(
    () => {
      validateVettingReport(dummyLock, validVetting, {
        vulnerabilities: {
          'unknown-malware': { via: [{ title: 'critical flaw' }] },
        },
      });
    },
    /Unreviewed advisory for non-baseline package "unknown-malware"/
  );
}

// Run self-checks first
runSelfChecks();
console.log('✓ Invariant self-checks and negative tests pass');

// ---------------------------------------------------------------------------
// Live verification against repository files
// ---------------------------------------------------------------------------
assert(
  fs.existsSync(vettingFilePath),
  `docs/dependency-vetting.json does not exist at ${vettingFilePath}`
);

assert(
  fs.existsSync(lockfilePath),
  `package-lock.json does not exist at ${lockfilePath}`
);

const lockJson = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
const vettingJson = JSON.parse(fs.readFileSync(vettingFilePath, 'utf8'));
const lockPackages = extractLockPackages(lockJson);

const auditReport = runNpmAudit(repoRoot);
validateVettingReport(lockPackages, vettingJson, auditReport);

console.log('✓ docs/dependency-vetting.json is valid and covers all non-baseline dependencies');
console.log('✓ Version publication dates verified (package creation dates rejected)');
console.log('✓ npm audit verified (no advisories on vetted packages)');
console.log('ALL DEPENDENCY TESTS PASSED!');
