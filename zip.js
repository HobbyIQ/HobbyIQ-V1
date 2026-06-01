// zip.js — CF-DEPLOY-STAMP-HARDENING (2026-06-01)
//
// Owns the build. Single source of truth for "what's in this zip matches
// git HEAD at zip time." Closes the 5th deploy mode (pre-commit build
// stamps stale dist/build-info.json SHA into the immutable zip) by making
// no window exist between "stamp HEAD" and "package dist" where a commit
// could shift HEAD.
//
// Invariants enforced before archiving:
//   1. backend/ working tree is clean (no uncommitted/untracked changes).
//      Refuses outright if dirty — deploy must reflect a committed HEAD;
//      the immutable build-info.json baked into the zip would otherwise
//      lie about what code is being deployed.
//   2. npm run build runs from backend/ HERE, immediately before archiving.
//      Single builder; replaces any external `npm run build` step.
//   3. Post-build sanity: dist/build-info.json.sha must equal current HEAD
//      (catches a broken write-build-info.cjs / env-var-drift edge).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const archiver = require('archiver');

const projectRoot = __dirname;
const backendPath = path.join(projectRoot, 'backend');
const outputPath = path.join(projectRoot, 'deploy.zip');

// ─── 1. Dirty-tree refusal (scoped to paths that affect dist/) ──────────
// Why this scope: tsc reads backend/src/ + backend/tsconfig.json; the
// package files affect node_modules/ which is also baked into the zip.
// Other backend/ paths (.data/, .tmp-*, tests/, scripts/) don't change
// what gets compiled — refusing on them would block every deploy because
// the repo carries long-tail workspace drift in those locations
// (runtime data, scratch probes, etc.).
const DIRTY_CHECK_PATHS = [
  'backend/src',
  'backend/package.json',
  'backend/package-lock.json',
  'backend/tsconfig.json',
];
console.log('[zip] checking dist-affecting paths are clean...');
let dirtyOutput;
try {
  dirtyOutput = execSync(
    `git status --porcelain -- ${DIRTY_CHECK_PATHS.join(' ')}`,
    { encoding: 'utf8', cwd: projectRoot },
  ).trim();
} catch (e) {
  console.error('[zip] git status failed:', e.message);
  process.exit(1);
}
if (dirtyOutput.length > 0) {
  console.error('[zip] REFUSED: uncommitted changes in dist-affecting paths.');
  console.error('[zip] Deploy must reflect a committed HEAD; the immutable');
  console.error('[zip] build-info.json baked into the zip would otherwise lie');
  console.error('[zip] about what code is being deployed (5th deploy mode).');
  console.error('[zip] Dirty files:');
  console.error(dirtyOutput.split('\n').map(l => '    ' + l).join('\n'));
  console.error('[zip] Commit (or stash) the changes, then re-run node zip.js.');
  process.exit(1);
}
console.log('[zip] dist-affecting paths clean');

// ─── 2. Build immediately before package ─────────────────────────────────
// zip.js owns the build. The previous workflow's separate `npm run build`
// step is dropped — running it externally is now redundant (and wasteful
// — it would compile twice).
console.log('[zip] running npm run build in backend/...');
try {
  execSync('npm run build', { cwd: backendPath, stdio: 'inherit' });
} catch (e) {
  console.error('[zip] npm run build failed; not packaging stale dist');
  process.exit(1);
}

// ─── 3. Post-build sanity ────────────────────────────────────────────────
const buildInfoPath = path.join(backendPath, 'dist', 'build-info.json');
let buildInfo;
try {
  buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
} catch (e) {
  console.error('[zip] dist/build-info.json missing or unparseable after build:', e.message);
  process.exit(1);
}
const currentHead = execSync('git rev-parse HEAD', {
  encoding: 'utf8',
  cwd: projectRoot,
}).trim();
if (buildInfo.sha !== currentHead) {
  console.error(`[zip] post-build stamp mismatch: dist/build-info.json.sha=${buildInfo.sha} but HEAD=${currentHead}.`);
  console.error('[zip] write-build-info.cjs may have read a stale GIT_SHA env var.');
  process.exit(1);
}
console.log(`[zip] dist/build-info.json sha=${buildInfo.shaShort} matches HEAD`);

// ─── 4. Archive ──────────────────────────────────────────────────────────
console.log('[zip] archiving...');
const output = fs.createWriteStream(outputPath);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`deploy.zip created at ${outputPath} (${archive.pointer()} total bytes)`);
});

archive.on('error', err => { throw err; });

archive.pipe(output);

archive.file(path.join(backendPath, 'package.json'), { name: 'package.json' });
archive.file(path.join(backendPath, 'package-lock.json'), { name: 'package-lock.json' });
archive.directory(path.join(backendPath, 'dist'), 'dist');
archive.directory(path.join(backendPath, 'node_modules'), 'node_modules');

archive.finalize();
