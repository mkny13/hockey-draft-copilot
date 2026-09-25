#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEST_FILES = [
  'test_gametheory.js',
  'test_data.js',
  'test_server.js',
  'test_sync.js',
  'test_app.js',
  'test_mock_draft.js',
  'test_docs.js',
];

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_SLOW_MS = 10000;

function resolveTestFile(file, repoRoot) {
  if (path.isAbsolute(file) && fs.existsSync(file)) {
    return file;
  }
  const fromCwd = path.resolve(process.cwd(), file);
  if (fs.existsSync(fromCwd)) {
    return fromCwd;
  }
  const fromRepo = path.resolve(repoRoot, file);
  if (fs.existsSync(fromRepo)) {
    return fromRepo;
  }
  const inTest = path.resolve(repoRoot, 'test', path.basename(file));
  if (fs.existsSync(inTest)) {
    return inTest;
  }
  return path.resolve(repoRoot, 'test', file);
}

function runTestFile(file, repoRoot, timeoutMs, slowMs) {
  return new Promise((resolve) => {
    const filePath = resolveTestFile(file, repoRoot);
    const fileLabel = path.basename(file);
    const startTime = Date.now();
    let timedOut = false;
    let timer = null;
    let forceKillTimer = null;
    let settled = false;

    const child = spawn(process.execPath, [filePath], {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
    });

    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
    });

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch (_) {}

      forceKillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (_) {}
      }, 1000);
      forceKillTimer.unref();

      const hardCloseTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          const elapsedMs = Date.now() - startTime;
          console.error(`\nTIMEOUT: ${fileLabel} exceeded ${timeoutMs}ms limit`);
          resolve({
            file: fileLabel,
            outcome: 'timeout',
            elapsedMs,
            isSlow: elapsedMs > slowMs,
          });
        }
      }, 3000);
      hardCloseTimer.unref();
    }, timeoutMs);

    function cleanup() {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    }

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();

      const elapsedMs = Date.now() - startTime;
      let outcome;
      if (timedOut) {
        outcome = 'timeout';
        console.error(`\nTIMEOUT: ${fileLabel} exceeded ${timeoutMs}ms limit`);
      } else if (code === 0) {
        outcome = 'pass';
      } else {
        outcome = 'fail';
      }

      resolve({
        file: fileLabel,
        outcome,
        elapsedMs,
        isSlow: elapsedMs > slowMs,
      });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();

      const elapsedMs = Date.now() - startTime;
      console.error(`Failed to start ${fileLabel}: ${err.message}`);
      resolve({
        file: fileLabel,
        outcome: 'fail',
        elapsedMs,
        isSlow: elapsedMs > slowMs,
      });
    });
  });
}

async function runTests(files) {
  const repoRoot = path.resolve(__dirname, '..');
  const timeoutMs = (process.env.TEST_TIMEOUT_MS && parseInt(process.env.TEST_TIMEOUT_MS, 10) > 0)
    ? parseInt(process.env.TEST_TIMEOUT_MS, 10)
    : DEFAULT_TIMEOUT_MS;
  const slowMs = (process.env.TEST_SLOW_MS && parseInt(process.env.TEST_SLOW_MS, 10) > 0)
    ? parseInt(process.env.TEST_SLOW_MS, 10)
    : DEFAULT_SLOW_MS;

  const targetFiles = (files && files.length > 0) ? files : TEST_FILES;
  const totalStartTime = Date.now();
  const results = [];

  for (const file of targetFiles) {
    const res = await runTestFile(file, repoRoot, timeoutMs, slowMs);
    results.push(res);
  }

  const totalElapsedMs = Date.now() - totalStartTime;

  console.log('\n--- Test Summary ---');
  for (const res of results) {
    const slowMarker = res.isSlow ? '  SLOW' : '';
    console.log(`${res.outcome.padEnd(8)} ${res.file.padEnd(22)} ${String(res.elapsedMs).padStart(6)}ms${slowMarker}`);
  }
  console.log(`Total: ${totalElapsedMs}ms`);

  const allPassed = results.length > 0 && results.every((r) => r.outcome === 'pass');
  return { allPassed, results, totalElapsedMs };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const filesToRun = args.length > 0 ? args.map((a) => path.basename(a)) : TEST_FILES;
  runTests(filesToRun)
    .then(({ allPassed }) => {
      process.exitCode = allPassed ? 0 : 1;
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = {
  TEST_FILES,
  runTests,
  runTestFile,
};
