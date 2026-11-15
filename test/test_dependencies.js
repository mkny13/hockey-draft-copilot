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

const KNOWN_BASELINE_ADVISORIES = {
  'body-parser': ['GHSA-27r3-jxmh-p828'],
  'qs': ['GHSA-6pq8-jhm2-2vcw'],
};

/**
 * Extracts parsed GHSA IDs from a vulnerability entry's `via` list.
 * Only object entries with advisory URLs are considered; string dependency names are ignored.
 */
function extractGhsaIds(vulnInfo) {
  if (!vulnInfo || !Array.isArray(vulnInfo.via)) return [];
  const ghsas = [];
  for (const item of vulnInfo.via) {
    if (item && typeof item === 'object' && typeof item.url === 'string') {
      const match = item.url.match(/github\.com\/advisories\/(GHSA-[a-z0-9-]+)/i);
      if (match) {
        ghsas.push(match[1]);
      }
    }
  }
  return [...new Set(ghsas)];
}

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
function validateVettingReport(lockPackages, vettingData, auditData) {
  assert(vettingData && typeof vettingData === 'object', 'Vetting report must be an object');
  assert(
    auditData && typeof auditData === 'object' && auditData.vulnerabilities && typeof auditData.vulnerabilities === 'object',
    'auditData with a vulnerabilities object is required to verify dependencies'
  );

  const packagesList = Array.isArray(vettingData) ? vettingData : vettingData.packages;
  assert(Array.isArray(packagesList), 'Vetting report must contain a packages array');
  assert(packagesList.length > 0, 'Vetting report must not be empty');

  const baselinePackages = vettingData.baselinePackages || {};

  // Verify that all known baseline advisory packages are present in baselinePackages and package-lock.json at matching versions
  for (const [pkgName, acceptedAdvisories] of Object.entries(KNOWN_BASELINE_ADVISORIES)) {
    assert(
      baselinePackages[pkgName] !== undefined,
      `Known baseline advisory package "${pkgName}" is not present in docs/dependency-vetting.json baselinePackages`
    );
    assert(
      lockPackages[pkgName] !== undefined,
      `Known baseline advisory package "${pkgName}" is not present in package-lock.json`
    );
    assert.strictEqual(
      lockPackages[pkgName],
      baselinePackages[pkgName],
      `Known baseline advisory package "${pkgName}" version in package-lock.json ("${lockPackages[pkgName]}") does not match baselinePackages ("${baselinePackages[pkgName]}")`
    );
    assert(
      Array.isArray(acceptedAdvisories) && acceptedAdvisories.length > 0,
      `Known baseline advisory package "${pkgName}" must have a non-empty list of accepted advisories`
    );
  }

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
        `jsdom@${entry.version} must record its version publication date, not the 2011 package creation date`
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

  // Verify no advisories exist for vetted packages and all vulnerabilities
  // are within the known acceptable baseline dependencies.
  const unreviewedVulnerabilities = [];
  for (const [vulnName, vulnInfo] of Object.entries(auditData.vulnerabilities)) {
    if (vettedMap.has(vulnName)) {
      unreviewedVulnerabilities.push(`Vetted package "${vulnName}" has an active advisory: ${JSON.stringify(vulnInfo.via || vulnInfo)}`);
    } else if (Object.prototype.hasOwnProperty.call(KNOWN_BASELINE_ADVISORIES, vulnName)) {
      const acceptedList = KNOWN_BASELINE_ADVISORIES[vulnName] || [];
      const ghsaIds = extractGhsaIds(vulnInfo);
      if (acceptedList.length === 0) {
        unreviewedVulnerabilities.push(
          `Unreviewed advisory for baseline package "${vulnName}": no accepted advisories configured`
        );
      } else if (ghsaIds.length === 0) {
        unreviewedVulnerabilities.push(
          `Unreviewed advisory for baseline package "${vulnName}": no parseable advisory URL in via: ${JSON.stringify(vulnInfo.via || vulnInfo)}`
        );
      } else {
        const unaccepted = [...new Set(ghsaIds.filter((id) => !acceptedList.includes(id)))];
        if (unaccepted.length > 0) {
          unreviewedVulnerabilities.push(
            `Unreviewed advisory for baseline package "${vulnName}": ${unaccepted.join(', ')}`
          );
        }
      }
    } else {
      unreviewedVulnerabilities.push(`Unreviewed advisory for non-baseline package "${vulnName}": ${JSON.stringify(vulnInfo.via || vulnInfo)}`);
    }
  }
  assert.strictEqual(
    unreviewedVulnerabilities.length,
    0,
    `npm audit found unreviewed vulnerabilities:\n${unreviewedVulnerabilities.join('\n')}`
  );
}

/**
 * Runs npm audit programmatically and returns the parsed report.
 */
function runNpmAudit(cwd, exec = execSync) {
  let stdout;
  try {
    stdout = exec('npm audit --json', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
  } catch (err) {
    if (err.stdout && String(err.stdout).trim()) {
      stdout = String(err.stdout);
    } else {
      const exitInfo = err.status !== undefined && err.status !== null ? `exit code ${err.status}` : (err.signal ? `signal ${err.signal}` : 'failure without exit code');
      throw new Error(`npm audit execution failed without parseable stdout (${exitInfo}): ${err.message}${err.stderr ? `\n${err.stderr}` : ''}`);
    }
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch (parseErr) {
    throw new Error(`Failed to parse npm audit output as JSON: ${parseErr.message}\nRaw output: ${stdout}`);
  }

  if (report && report.error) {
    throw new Error(`npm audit reported error: ${report.error.summary || report.error.detail || JSON.stringify(report.error)}`);
  }

  assert(
    report && typeof report === 'object' && report.vulnerabilities && typeof report.vulnerabilities === 'object',
    'npm audit report missing vulnerabilities object'
  );

  return report;
}

// ---------------------------------------------------------------------------
// Self-checks / Negative unit tests
// ---------------------------------------------------------------------------
function runSelfChecks() {
  const dummyLock = {
    'jsdom': '31.0.1',
    'bcp-47': '2.1.2',
    'express': '5.3.0',
    'body-parser': '2.3.0',
    'qs': '6.16.0',
  };

  const validVetting = {
    baselinePackages: {
      'express': '5.3.0',
      'body-parser': '2.3.0',
      'qs': '6.16.0',
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

  const cleanAudit = {
    vulnerabilities: {
      'body-parser': {
        via: [
          {
            url: 'https://github.com/advisories/GHSA-27r3-jxmh-p828',
          },
        ],
      },
    },
  };

  // Valid report passes
  assert.doesNotThrow(() => {
    validateVettingReport(dummyLock, validVetting, cleanAudit);
  });

  // A later jsdom 31.x patch may have a different version publication date.
  const futurePatchLock = { ...dummyLock, jsdom: '31.0.2' };
  const futurePatchVetting = JSON.parse(JSON.stringify(validVetting));
  futurePatchVetting.packages[0].version = '31.0.2';
  futurePatchVetting.packages[0].published = '2026-12-01';
  assert.doesNotThrow(() => {
    validateVettingReport(futurePatchLock, futurePatchVetting, cleanAudit);
  });

  // Missing required field fails
  assert.throws(
    () => {
      const invalid = JSON.parse(JSON.stringify(validVetting));
      delete invalid.packages[0].publisher;
      validateVettingReport(dummyLock, invalid, cleanAudit);
    },
    /missing required field "publisher"/
  );

  // Missing required package fails
  assert.throws(
    () => {
      const invalid = JSON.parse(JSON.stringify(validVetting));
      invalid.packages.pop(); // remove bcp-47
      validateVettingReport(dummyLock, invalid, cleanAudit);
    },
    /Missing vetting entries in docs\/dependency-vetting\.json for packages: bcp-47@2\.1\.2/
  );

  // Package creation date (2011) instead of version publication date fails
  assert.throws(
    () => {
      const invalid = JSON.parse(JSON.stringify(futurePatchVetting));
      invalid.packages[0].published = '2011-11-21';
      validateVettingReport(futurePatchLock, invalid, cleanAudit);
    },
    /must record its version publication date, not the 2011 package creation date/
  );

  // Version mismatch fails
  assert.throws(
    () => {
      const invalid = JSON.parse(JSON.stringify(validVetting));
      invalid.packages[0].version = '31.0.0';
      validateVettingReport(dummyLock, invalid, cleanAudit);
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

  // Accepted qs advisory passes
  assert.doesNotThrow(() => {
    validateVettingReport(dummyLock, validVetting, {
      vulnerabilities: {
        'qs': {
          via: [{ url: 'https://github.com/advisories/GHSA-6pq8-jhm2-2vcw' }],
        },
      },
    });
  });

  // body-parser with accepted GHSA plus unknown extra GHSA fails
  assert.throws(
    () => {
      validateVettingReport(dummyLock, validVetting, {
        vulnerabilities: {
          'body-parser': {
            via: [
              { url: 'https://github.com/advisories/GHSA-27r3-jxmh-p828' },
              { url: 'https://github.com/advisories/GHSA-xxxx-xxxx-xxxx' },
            ],
          },
        },
      });
    },
    /Unreviewed advisory for baseline package "body-parser": GHSA-xxxx-xxxx-xxxx/
  );

  // body-parser whose only advisory is an unknown GHSA fails
  assert.throws(
    () => {
      validateVettingReport(dummyLock, validVetting, {
        vulnerabilities: {
          'body-parser': {
            via: [{ url: 'https://github.com/advisories/GHSA-9999-9999-9999' }],
          },
        },
      });
    },
    /Unreviewed advisory for baseline package "body-parser": GHSA-9999-9999-9999/
  );

  // body-parser with a via list that has no parseable advisory URL fails
  assert.throws(
    () => {
      validateVettingReport(dummyLock, validVetting, {
        vulnerabilities: {
          'body-parser': {
            via: [{ title: 'no parseable url' }],
          },
        },
      });
    },
    /Unreviewed advisory for baseline package "body-parser"/
  );

  // qs with a different GHSA fails
  assert.throws(
    () => {
      validateVettingReport(dummyLock, validVetting, {
        vulnerabilities: {
          'qs': {
            via: [{ url: 'https://github.com/advisories/GHSA-yyyy-yyyy-yyyy' }],
          },
        },
      });
    },
    /Unreviewed advisory for baseline package "qs": GHSA-yyyy-yyyy-yyyy/
  );

  // Missing or typo'd known baseline package in baselinePackages fails
  assert.throws(
    () => {
      const invalid = JSON.parse(JSON.stringify(validVetting));
      delete invalid.baselinePackages['body-parser'];
      validateVettingReport(dummyLock, invalid, cleanAudit);
    },
    /Known baseline advisory package "body-parser" is not present in docs\/dependency-vetting\.json baselinePackages/
  );

  // Mismatched version between package-lock.json and baselinePackages fails
  assert.throws(
    () => {
      const invalid = JSON.parse(JSON.stringify(validVetting));
      invalid.baselinePackages['body-parser'] = '2.4.0';
      validateVettingReport(dummyLock, invalid, cleanAudit);
    },
    /Known baseline advisory package "body-parser" version in package-lock\.json \("2\.3\.0"\) does not match baselinePackages \("2\.4\.0"\)/
  );

  // Missing or null audit data must throw, not skip advisory verification
  assert.throws(
    () => {
      validateVettingReport(dummyLock, validVetting, null);
    },
    /auditData with a vulnerabilities object is required/i
  );

  // auditData missing vulnerabilities property must throw
  assert.throws(
    () => {
      validateVettingReport(dummyLock, validVetting, {});
    },
    /auditData with a vulnerabilities object is required/i
  );

  // Failing npm execution without parseable stdout must throw, not return null
  assert.throws(
    () => {
      runNpmAudit(repoRoot, () => {
        const err = new Error('Command failed: npm audit --json');
        err.status = 1;
        throw err;
      });
    },
    /npm audit execution failed without parseable stdout/i
  );

  // Failing npm execution with empty/whitespace stdout must throw, not return null
  assert.throws(
    () => {
      runNpmAudit(repoRoot, () => {
        const err = new Error('Command failed: npm audit --json');
        err.status = 1;
        err.stdout = '   \n';
        throw err;
      });
    },
    /npm audit execution failed without parseable stdout/i
  );

  // Unparseable stdout from failing npm execution must throw, not return null
  assert.throws(
    () => {
      runNpmAudit(repoRoot, () => {
        const err = new Error('Command failed: npm audit --json');
        err.status = 1;
        err.stdout = 'npm ERR! code ENOTFOUND\n';
        throw err;
      });
    },
    /Failed to parse npm audit output as JSON/i
  );

  // npm audit output with error object must throw
  assert.throws(
    () => {
      runNpmAudit(repoRoot, () => {
        return JSON.stringify({ error: { code: 'ENOTFOUND', summary: 'network error' } });
      });
    },
    /npm audit reported error/i
  );

  // npm audit output missing vulnerabilities property must throw
  assert.throws(
    () => {
      runNpmAudit(repoRoot, () => {
        return JSON.stringify({ metadata: {} });
      });
    },
    /npm audit report missing vulnerabilities object/i
  );

  // Valid audit JSON from exec returns parsed object
  const parsedGood = runNpmAudit(repoRoot, () => {
    return JSON.stringify({ vulnerabilities: {} });
  });
  assert.deepStrictEqual(parsedGood, { vulnerabilities: {} });

  // Valid audit JSON from non-zero exit code (advisories present) returns parsed object
  const parsedWithVulns = runNpmAudit(repoRoot, () => {
    const err = new Error('Command failed');
    err.status = 1;
    err.stdout = JSON.stringify({ vulnerabilities: { 'body-parser': {} } });
    throw err;
  });
  assert.deepStrictEqual(parsedWithVulns, { vulnerabilities: { 'body-parser': {} } });
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
