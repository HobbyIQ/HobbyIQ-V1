#!/usr/bin/env node
/*
 * Internal OCR release-readiness scorer.
 *
 * Uses the most recent report from .data/ocr-training/reports/ocr-quality-*.json
 * and computes a weighted readiness score with gate checks.
 */

const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(process.cwd(), '.data', 'ocr-training', 'reports');

// Weights for critical OCR fields (sum = 100)
const WEIGHTS = {
  playerName: 25,
  cardYear: 15,
  product: 20,
  cardNumber: 10,
  parallel: 8,
  grade: 8,
  gradingCompany: 6,
  certNumber: 8,
};

// Minimum gate requirements before enabling user-facing rollout.
const GATES = {
  minRowsWithCorrections: 100,
  minWeightedScore: 0.88,
  minPrimaryAccuracy: {
    playerName: 0.85,
    cardYear: 0.9,
    product: 0.8,
  },
  minHighConfidenceAccuracy: 0.85, // calibration bin 0.8-1.0
};

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function pickLatestReport() {
  const files = safeReadDir(REPORTS_DIR)
    .filter((d) => d.isFile() && d.name.startsWith('ocr-quality-') && d.name.endsWith('.json'))
    .map((d) => path.join(REPORTS_DIR, d.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  return files[0] || null;
}

function loadReport(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function toAccuracy(fieldStats) {
  const v = fieldStats?.accuracy;
  return Number.isFinite(v) ? v : 0;
}

function weightedScore(fieldAccuracy) {
  let totalWeight = 0;
  let weighted = 0;

  for (const [field, weight] of Object.entries(WEIGHTS)) {
    const acc = toAccuracy(fieldAccuracy?.[field]);
    totalWeight += weight;
    weighted += acc * weight;
  }

  return totalWeight > 0 ? weighted / totalWeight : 0;
}

function evaluateGates(report, score) {
  const failures = [];
  const rowsWithCorrections = Number(report?.totals?.rowsWithCorrections || 0);

  if (rowsWithCorrections < GATES.minRowsWithCorrections) {
    failures.push(`Need >= ${GATES.minRowsWithCorrections} corrected rows (have ${rowsWithCorrections}).`);
  }

  if (score < GATES.minWeightedScore) {
    failures.push(`Weighted score ${score.toFixed(3)} below threshold ${GATES.minWeightedScore.toFixed(3)}.`);
  }

  for (const [field, minAcc] of Object.entries(GATES.minPrimaryAccuracy)) {
    const acc = toAccuracy(report?.fieldAccuracy?.[field]);
    if (acc < minAcc) {
      failures.push(`${field} accuracy ${acc.toFixed(3)} below ${minAcc.toFixed(3)}.`);
    }
  }

  const highConf = Number(report?.confidenceCalibration?.['0.8-1.0']?.accuracy ?? NaN);
  if (!Number.isFinite(highConf) || highConf < GATES.minHighConfidenceAccuracy) {
    failures.push(`High-confidence accuracy ${(Number.isFinite(highConf) ? highConf.toFixed(3) : 'n/a')} below ${GATES.minHighConfidenceAccuracy.toFixed(3)}.`);
  }

  return failures;
}

function printSummary(reportPath, report, score, failures) {
  console.log('OCR Release Readiness');
  console.log('=====================');
  console.log(`Report: ${reportPath}`);
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Rows with corrections: ${report?.totals?.rowsWithCorrections ?? 0}`);
  console.log(`Weighted readiness score: ${(score * 100).toFixed(2)}%`);

  if (failures.length === 0) {
    console.log('Recommendation: READY_FOR_PRIVATE_BETA');
  } else {
    console.log('Recommendation: HOLD_RELEASE');
    console.log('Blockers:');
    for (const f of failures) {
      console.log(`- ${f}`);
    }
  }
}

function main() {
  const reportPath = pickLatestReport();
  if (!reportPath) {
    console.log('No OCR quality reports found. Run: npm run ocr:report');
    process.exit(0);
  }

  const report = loadReport(reportPath);
  const score = weightedScore(report?.fieldAccuracy || {});
  const failures = evaluateGates(report, score);

  printSummary(reportPath, report, score, failures);
}

main();
