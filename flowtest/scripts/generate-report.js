#!/usr/bin/env node

const { readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

const reportDir = process.argv[2];

if (!reportDir) {
  console.error('Usage: node scripts/generate-report.js <report-dir>');
  process.exit(1);
}

const resultsPath = join(reportDir, 'results.json');
const templatePath = join(__dirname, '..', 'templates', 'viewer.html');
const outputPath = join(reportDir, 'viewer.html');

let resultsJson;
try {
  resultsJson = readFileSync(resultsPath, 'utf-8');
} catch (e) {
  console.error(`Error: Cannot read ${resultsPath}`);
  console.error(e.message);
  process.exit(1);
}

// Validate JSON parses correctly
try {
  JSON.parse(resultsJson);
} catch (e) {
  console.error(`Error: Invalid JSON in ${resultsPath}`);
  console.error(e.message);
  process.exit(1);
}

let template;
try {
  template = readFileSync(templatePath, 'utf-8');
} catch (e) {
  console.error(`Error: Cannot read template at ${templatePath}`);
  console.error(e.message);
  process.exit(1);
}

const html = template.replace('{{DATA}}', resultsJson);
writeFileSync(outputPath, html, 'utf-8');
console.log(`Report generated: ${outputPath}`);
