#!/usr/bin/env node
/*
 * Internal OCR quality report generator.
 *
 * Reads training examples from .data/ocr-training/*.jsonl and computes:
 * - overall example counts
 * - per-field exact-match accuracy (extracted vs corrected)
 * - confidence calibration bins using extracted.confidence
 *
 * This script is internal tooling only (not exposed via API/UI).
 */

const fs = require('fs');
const path = require('path');

const TRAINING_DIR = path.join(process.cwd(), '.data', 'ocr-training');
const REPORTS_DIR = path.join(TRAINING_DIR, 'reports');

const TRACKED_FIELDS = [
  'playerName',
  'cardYear',
  'product',
  'cardNumber',
  'parallel',
  'isAuto',
  'isPatch',
  'grade',
  'gradingCompany',
  'certNumber',
];

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    return value.trim().toLowerCase().replace(/\s+/g, ' ');
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value).trim().toLowerCase();
}

function parseJsonlFile(filePath) {
  const out = [];
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // Ignore malformed line, keep scanning remaining rows.
    }
  }
  return out;
}

function listTrainingRows() {
  const files = safeReadDir(TRAINING_DIR)
    .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
    .map((d) => path.join(TRAINING_DIR, d.name));

  const rows = [];
  for (const file of files) {
    rows.push(...parseJsonlFile(file));
  }
  return rows;
}

function buildFieldStats(rows) {
  const stats = {};
  for (const field of TRACKED_FIELDS) {
    stats[field] = { compared: 0, matched: 0, accuracy: null };
  }

  for (const row of rows) {
    const extracted = row?.extracted || {};
    const corrected = row?.corrected || {};

    for (const field of TRACKED_FIELDS) {
      const expected = corrected[field];
      if (expected === null || expected === undefined || expected === '') continue;

      stats[field].compared += 1;
      const actualNorm = normalizeValue(extracted[field]);
      const expectedNorm = normalizeValue(expected);
      if (actualNorm === expectedNorm) {
        stats[field].matched += 1;
      }
    }
  }

  for (const field of TRACKED_FIELDS) {
    const s = stats[field];
    if (s.compared > 0) {
      s.accuracy = Number((s.matched / s.compared).toFixed(4));
    }
  }

  return stats;
}

function confidenceBin(v) {
  if (!Number.isFinite(v)) return null;
  if (v < 0.2) return '0.0-0.2';
  if (v < 0.4) return '0.2-0.4';
  if (v < 0.6) return '0.4-0.6';
  if (v < 0.8) return '0.6-0.8';
  return '0.8-1.0';
}

function isPrimaryMatch(extracted, corrected) {
  // Primary "card identity" correctness check for calibration.
  const keys = ['playerName', 'cardYear', 'product'];
  let compared = 0;
  let matched = 0;

  for (const key of keys) {
    const exp = corrected?.[key];
    if (exp === null || exp === undefined || exp === '') continue;
    compared += 1;
    if (normalizeValue(extracted?.[key]) === normalizeValue(exp)) {
      matched += 1;
    }
  }

  if (compared === 0) return null;
  return matched === compared;
}

function buildCalibration(rows) {
  const bins = {
    '0.0-0.2': { total: 0, correct: 0, accuracy: null },
    '0.2-0.4': { total: 0, correct: 0, accuracy: null },
    '0.4-0.6': { total: 0, correct: 0, accuracy: null },
    '0.6-0.8': { total: 0, correct: 0, accuracy: null },
    '0.8-1.0': { total: 0, correct: 0, accuracy: null },
  };

  for (const row of rows) {
    const extracted = row?.extracted || {};
    const corrected = row?.corrected || {};

    const conf = Number(extracted?.confidence);
    const bin = confidenceBin(conf);
    if (!bin) continue;

    const correctness = isPrimaryMatch(extracted, corrected);
    if (correctness === null) continue;

    bins[bin].total += 1;
    if (correctness) bins[bin].correct += 1;
  }

  for (const key of Object.keys(bins)) {
    const b = bins[key];
    if (b.total > 0) {
      b.accuracy = Number((b.correct / b.total).toFixed(4));
    }
  }

  return bins;
}

function buildReport(rows) {
  const withCorrections = rows.filter((r) => r?.corrected && Object.keys(r.corrected || {}).length > 0);

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      rows: rows.length,
      rowsWithCorrections: withCorrections.length,
    },
    fieldAccuracy: buildFieldStats(withCorrections),
    confidenceCalibration: buildCalibration(withCorrections),
  };
}

function printSummary(report) {
  console.log('OCR Quality Report');
  console.log('==================');
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Rows: ${report.totals.rows}`);
  console.log(`Rows with corrections: ${report.totals.rowsWithCorrections}`);
  console.log('');

  console.log('Field Accuracy');
  console.log('--------------');
  for (const [field, stats] of Object.entries(report.fieldAccuracy)) {
    const compared = stats.compared;
    const matched = stats.matched;
    const accuracy = stats.accuracy === null ? 'n/a' : `${(stats.accuracy * 100).toFixed(1)}%`;
    console.log(`${field.padEnd(16)} compared=${String(compared).padEnd(4)} matched=${String(matched).padEnd(4)} accuracy=${accuracy}`);
  }
  console.log('');

  console.log('Confidence Calibration (primary fields)');
  console.log('---------------------------------------');
  for (const [bin, stats] of Object.entries(report.confidenceCalibration)) {
    const accuracy = stats.accuracy === null ? 'n/a' : `${(stats.accuracy * 100).toFixed(1)}%`;
    console.log(`${bin.padEnd(8)} total=${String(stats.total).padEnd(4)} correct=${String(stats.correct).padEnd(4)} accuracy=${accuracy}`);
  }
}

function saveReport(report) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const fileName = `ocr-quality-${stamp}.json`;
  const filePath = path.join(REPORTS_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
  return filePath;
}

function main() {
  const rows = listTrainingRows();
  if (!rows.length) {
    console.log('No OCR training data found at .data/ocr-training/*.jsonl');
    process.exit(0);
  }

  const report = buildReport(rows);
  const filePath = saveReport(report);
  printSummary(report);
  console.log('');
  console.log(`Report saved: ${filePath}`);
}

main();
