'use strict';
const fs = require('node:fs');
const path = require('node:path');
const inventory = require('../src/apiHealth/endpoints.json');
const required = [
  ['lp-source-course-create', 'src/creation/client.js'], ['lp-source-course-deploy', 'src/replication/client.js'],
  ['lp-course-status-put', 'src/replication/client.js'], ['lp-orgstructure-list', 'src/resolution/resolver.js'],
  ['lp-datasets-bds', 'src/resolution/sync.js'], ['le-assignment-list', 'src/dates/activities/assignments.js'],
  ['le-quiz-list', 'src/dates/activities/quizzes.js'], ['le-discussion-forums', 'src/dates/activities/discussions.js'],
  ['le-course-copy-submit', 'src/copy/client.js'], ['le-course-copy-status', 'src/copy/client.js'],
  ['le-ccb-copy-logs', 'src/replication/monitor.js'], ['versions-check', 'src/apiHealth/service.js']
];
const ids = new Set();
for (const endpoint of inventory.endpoints) {
  if (!endpoint.id || ids.has(endpoint.id)) throw Error(`Missing or duplicate endpoint id: ${endpoint.id}`);
  ids.add(endpoint.id);
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(endpoint.method)) throw Error(`Invalid method: ${endpoint.id}`);
  if (!endpoint.pattern || !endpoint.component || !Array.isArray(endpoint.sourceFiles) || !endpoint.sourceFiles.length) throw Error(`Incomplete endpoint: ${endpoint.id}`);
  if (endpoint.documentedMinimum === undefined || endpoint.applicationMinimum === undefined || endpoint.docs === undefined || !endpoint.verifiedAt || !endpoint.contractEvidence) throw Error(`Missing evidence fields: ${endpoint.id}`);
  for (const file of endpoint.sourceFiles) if (!fs.existsSync(path.join(__dirname, '..', file))) throw Error(`Missing source file for ${endpoint.id}: ${file}`);
}
for (const [id, file] of required) if (!ids.has(id) || !inventory.endpoints.find(e => e.id === id).sourceFiles.includes(file)) throw Error(`Known API call site is missing from inventory: ${id} (${file})`);
const markdown = fs.readFileSync(path.join(__dirname, '..', 'API_ENDPOINTS.md'), 'utf8');
for (const endpoint of inventory.endpoints) if (!markdown.includes(`| ${endpoint.id} |`)) throw Error(`API_ENDPOINTS.md is missing ${endpoint.id}`);
console.log(`Validated ${inventory.endpoints.length} endpoints.`);
