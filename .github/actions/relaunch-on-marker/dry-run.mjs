/**
 * SYNTHETIC DRY RUN of the composite's shell.
 *
 * Renders one real step's `uses:` call the way Actions would — substituting the
 * `with:` values into the composite's `run:` block — and EXECUTES the result
 * under `bash -eo pipefail` against the seven fixture logs. This is the check
 * that the extraction preserved BEHAVIOUR and not merely shape: the pins read
 * the YAML, this runs it.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const RUNNER = fs.readFileSync(new URL('../../workflows/backfill-runner.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const ACTION = fs.readFileSync(new URL('./action.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The composite's single `run:` block, dedented. */
function compositeRun() {
  const at = ACTION.indexOf('      run: |');
  const body = ACTION.slice(at + '      run: |\n'.length);
  return body.split('\n').map((l) => l.replace(/^ {8}/, '')).join('\n');
}

/** Parse one step's `with:` map out of the workflow (block scalars + scalars). */
function withMapFor(stepName) {
  const at = RUNNER.indexOf(`- name: ${stepName}`);
  if (at < 0) throw new Error('no such step: ' + stepName);
  let block = RUNNER.slice(at);
  const next = block.indexOf('\n      - name:');
  if (next > 0) block = block.slice(0, next);
  const withAt = block.indexOf('\n        with:\n');
  const args = block.slice(withAt + '\n        with:\n'.length);
  const map = {};
  const lines = args.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {10}([a-z-]+): (\|)?(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, key, isBlock, rest] = m;
    if (isBlock) {
      const buf = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') { buf.push(''); continue; }
        if (!lines[j].startsWith('            ')) { i = j - 1; break; }
        buf.push(lines[j].slice(12));
        i = j;
      }
      map[key] = buf.join('\n').replace(/\n+$/, '');
    } else {
      map[key] = rest.trim().replace(/^"(.*)"$/, '$1');
    }
  }
  return map;
}

/** Substitute the `with:` values into the composite run, as Actions does. */
function render(map, ctx) {
  let out = compositeRun();
  out = out.replace(/\$\{\{ inputs\.([a-z-]+) \}\}/g, (_, k) => map[k] ?? '');
  // Workflow-level ${{ inputs.x }} / ${{ steps.* }} inside the lane's own
  // fragments are expanded by the WORKFLOW before the composite ever sees
  // them, so the harness resolves them from the dispatch context.
  out = out.replace(/\$\{\{ steps\.backfill\.outcome \}\}/g, ctx.outcome);
  out = out.replace(/\$\{\{ inputs\.([a-z_]+) \}\}/g, (_, k) => ctx.inputs[k] ?? '');
  return out;
}

/** Env the composite reads; the workflow expands these before Actions runs it. */
function envFor(map, ctx) {
  const ex = (v) => String(v ?? '')
    .replace(/\$\{\{ steps\.backfill\.outcome \}\}/g, ctx.outcome)
    .replace(/\$\{\{ inputs\.([a-z_]+) \}\}/g, (_, k) => ctx.inputs[k] ?? '');
  return {
    RELAUNCH_LOG: ex(map.log || '/tmp/backfill.log'),
    RELAUNCH_OUTCOME: ex(map.outcome),
    RELAUNCH_SCRIPT: ex(map.script),
    RELAUNCH_STARTUP_PREFIX: ex(map['startup-marker-prefix']),
    RELAUNCH_STARTUP_BANNER: ex(map['startup-banner-regex']),
  };
}

// ── THE SEVEN FIXTURES ───────────────────────────────────────────────────────
// (a) budget marker; (b) clean code 0; (c) witness-less kill; (d) the BACKOFF
// verdict of run 34135736122; plus the three startup sub-outcomes #1963 added.
const FIXTURES = [
  { id: 'a-budget', outcome: 'success', log: 'working...\nstopped at the 140-minute budget\n  re-keyed 1,234\n', want: 'REDISPATCH' },
  { id: 'b-finished', outcome: 'success', log: 'all done\nfinishLane: exiting code 0\n', want: 'FINISHED' },
  // The banner line is the ERE `^rematch-sold-comps  MODE=` MATCHED, i.e. the
  // real banner text at the start of a line — not the pattern typed literally.
  // A lane past its banner with no witness in the log is the genuine
  // 150-minute kill this branch was written for.
  { id: 'c-killed', outcome: 'failure', log: 'rematch-sold-comps: STARTUP ok\nrematch-sold-comps  MODE=apply-improve\nworking...\n', want: 'KILLED' },
  {
    id: 'd-verdict',
    outcome: 'failure',
    log: '  SYSTEMIC ABORT      the control page did not serve either — the host is refusing this client; retry after 30 minutes\nfinishLane: exiting code 5\n',
    want: 'VERDICT',
  },
  { id: 'e-startup-refused', outcome: 'failure', log: 'rematch-sold-comps: STARTUP ok\nrematch-sold-comps: STARTUP REFUSED at phase=scope\nFATAL [phase=scope] scope is required\n', want: 'STARTUP REFUSED' },
  { id: 'f-empty-log', outcome: 'failure', log: '', want: 'EMPTY LOG' },
  { id: 'g-died-startup', outcome: 'failure', log: 'rematch-sold-comps: STARTUP ok\n', want: 'DIED DURING STARTUP' },
];

/** Classify on the step's own VERDICT lines only.
 *
 *  Deliberately not a substring search over the whole of stdout: every arm
 *  echoes the last 20 lines of the log, so a fixture log that merely CONTAINS
 *  the words "STARTUP REFUSED" would otherwise be read as that verdict even
 *  when the step correctly announced a generic KILLED. The verdict is what the
 *  step says about the log, never what the log says. */
function classify(stdout, code, dispatched) {
  if (dispatched) return 'REDISPATCH';
  const verdicts = stdout.split('\n').filter((l) => /::(error|notice|warning)::/.test(l)).join('\n');
  if (/::error::STARTUP REFUSED/.test(verdicts)) return 'STARTUP REFUSED';
  if (/::error::EMPTY LOG/.test(verdicts)) return 'EMPTY LOG';
  if (/::error::DIED DURING STARTUP/.test(verdicts)) return 'DIED DURING STARTUP';
  if (/::error::FINISHED WITH VERDICT code/.test(verdicts)) return 'VERDICT';
  if (/::error::KILLED before finish/.test(verdicts)) return 'KILLED';
  if (/finished within budget/.test(verdicts)) return 'FINISHED';
  return `?(code=${code})`;
}

const STEP = process.argv[2] || 'Self-relaunch rematch-sold-comps until the shard is finished';
const map = withMapFor(STEP);
const ctx = {
  outcome: 'PLACEHOLDER',
  inputs: {
    script: 'rematch-sold-comps', apply: 'false', mode: 'apply-improve', concurrency: '4',
    slot: '3', slots: '32', years: '2019', limit: '0', scope: 'flagship', sports: 'baseball',
    setkey_like: '', sources: '', parents_only: '', dry_run: '',
  },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-'));
let failures = 0;
console.log(`STEP: ${STEP}\n`);

for (const f of FIXTURES) {
  const logPath = path.join(tmp, `${f.id}.log`);
  fs.writeFileSync(logPath, f.log);
  const c = { ...ctx, outcome: f.outcome };
  let script = render(map, c);
  const env = envFor(map, c);
  env.RELAUNCH_LOG = logPath;
  // Neutralize the real dispatch: record the call instead of firing it.
  script = script.replace(/gh workflow run/g, 'echo DISPATCHED gh workflow run');
  // The lane fragments grep the hard-coded log path; point them at the fixture.
  script = script.split('/tmp/backfill.log').join(logPath);

  const sh = path.join(tmp, `${f.id}.sh`);
  fs.writeFileSync(sh, script);
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync('bash', ['-eo', 'pipefail', sh], {
      env: { ...process.env, ...env, GITHUB_REPOSITORY: 'HobbyIQ/HobbyIQ-V1' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    stdout = (e.stdout || '') + (e.stderr || '');
    code = e.status ?? 1;
  }
  const dispatched = /DISPATCHED gh workflow run/.test(stdout);
  const got = classify(stdout, code, dispatched);
  // The three startup sub-outcomes exist only for a lane that NARRATES its
  // startup. For every other lane the correct answer to those same logs is the
  // single generic KILLED — that is the pre-#1963 contract, deliberately
  // unchanged here, not a regression.
  const narrates = !!map['startup-marker-prefix'];
  f.expect = !narrates && ['STARTUP REFUSED', 'EMPTY LOG', 'DIED DURING STARTUP'].includes(f.want)
    ? 'KILLED'
    : f.want;
  const wantExit = f.expect === 'REDISPATCH' || f.expect === 'FINISHED' ? 0 : 1;
  const okClass = got === f.expect;
  const okExit = code === wantExit;
  if (!okClass || !okExit) failures++;
  console.log(`${okClass && okExit ? 'PASS' : 'FAIL'}  ${f.id.padEnd(20)} -> ${got.padEnd(20)} exit=${code} (want ${f.expect}, exit ${wantExit})`);
  if (!okClass || !okExit) console.log(stdout.split('\n').slice(0, 12).map((l) => '      ' + l).join('\n'));
}

console.log(failures ? `\n${failures} FIXTURE(S) FAILED` : '\nall seven fixtures behave as contracted');
process.exit(failures ? 1 : 0);
