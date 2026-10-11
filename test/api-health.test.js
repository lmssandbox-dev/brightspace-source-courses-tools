'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const endpoints = require('../src/apiHealth/endpoints.json').endpoints;
const lifecycle = require('../src/apiHealth/lifecycle.json');
const { assess } = require('../src/apiHealth/assessment');
const { resolveRuntimeVersions } = require('../src/apiHealth/runtimeVersions');
const { createApiHealthService, STALE_MS } = require('../src/apiHealth/service');
const { execFileSync } = require('node:child_process');

test('inventory covers registered source call sites and has unique documented IDs', () => {
  assert.match(execFileSync(process.execPath, ['scripts/validate-api-endpoints.js'], { encoding: 'utf8' }), /Validated \d+ endpoints/);
  assert.equal(new Set(endpoints.map(row => row.id)).size, endpoints.length);
  assert.ok(endpoints.some(row => row.method === 'PUT'));
  assert.ok(endpoints.some(row => row.component === 'external'));
});
test('runtime versions preserve the existing LP fallback and environment source', () => {
  assert.deepEqual(resolveRuntimeVersions({}), { lp: { version: '1.53', source: 'application_fallback' }, le: { version: null, source: null } });
  assert.deepEqual(resolveRuntimeVersions({ D2L_LP_VERSION: '1.62', D2L_LE_VERSION: '1.99' }), { lp: { version: '1.62', source: 'environment' }, le: { version: '1.99', source: 'environment' } });
});
const base = { configured: { lp: { version: '1.60', source: 'environment' }, le: { version: '1.99', source: 'environment' } }, checks: { components: { lp: { supported: true, latestVersion: '1.65' }, le: { supported: true, latestVersion: '1.99' } } }, lifecycle, endpoints, minimums: { lp: [], le: [] } };
test('assessment distinguishes supported from latest and reports tenant unsupported versions', () => {
  assert.equal(assess(base).components.lp.status, 'update_available');
  const unsupported = structuredClone(base); unsupported.checks.components.lp.supported = false;
  assert.equal(assess(unsupported).components.lp.status, 'critical');
});
test('assessment flags app minimum violations and verified lifecycle bands; unknown evidence stays unknown', () => {
  const minimum = structuredClone(base); minimum.configured.le.version = '1.96'; minimum.minimums.le = [{ minimum: '1.97', endpointId: 'le-course-copy-submit', tool: 'Bulk Course Copy' }];
  assert.equal(assess(minimum).status, 'critical');
  const deprecated = structuredClone(base); deprecated.configured.lp.version = '1.48'; deprecated.checks.components.lp = { supported: true, latestVersion: '1.65' };
  assert.equal(assess(deprecated).components.lp.status, 'at_risk');
  const obsolete = structuredClone(base); obsolete.configured.lp.version = '1.45'; obsolete.checks.components.lp = { supported: true, latestVersion: '1.65' };
  assert.equal(assess(obsolete).components.lp.status, 'critical');
  const eol = structuredClone(base); eol.configured.lp.version = '1.55'; eol.checks.components.lp = { supported: true, latestVersion: '1.65' };
  eol.lifecycle.components.lp.ranges.unshift({ status: 'eol', max: '1.56' });
  assert.equal(assess(eol).components.lp.status, 'critical');
  const unknown = assess({ ...base, lifecycle: { sources: [], components: {} } });
  assert.equal(unknown.status, 'unknown');
  const staleEvidence = assess({ ...base, checkedAt: '2028-01-01T00:00:00.000Z' });
  assert.equal(staleEvidence.components.lp.lifecycleEvidenceStatus, 'stale');
  assert.equal(staleEvidence.components.lp.lifecycleStatus, 'unknown');
});

function fakeMongo() {
  let row = null;
  const matches = filter => !filter || filter.namespace === row?.namespace &&
    (!filter.lockUntil || (row?.lockUntil || 0) <= filter.lockUntil.$lte);
  const collection = {
    async createIndex() {},
    async findOne(filter) { return matches(filter) ? structuredClone(row) : null; },
    async findOneAndUpdate(filter, update) {
      if (!row || !matches(filter)) return { value: null };
      row = { ...row, ...update.$set }; return { value: structuredClone(row) };
    },
    async updateOne(filter, update, options = {}) {
      if (!row && options.upsert) row = { namespace: filter.namespace, lockUntil: 0 };
      if (row?.namespace !== filter.namespace) return { matchedCount: 0 };
      if (update.$setOnInsert) row = { ...update.$setOnInsert, ...row };
      if (update.$set) row = { ...row, ...update.$set };
      if (update.$push?.history) row.history = [...(row.history || []), ...update.$push.history.$each].slice(update.$push.history.$slice);
      return { matchedCount: 1 };
    }
  };
  return { client: { async connect() {}, db() { return { collection() { return collection; } }; } }, get row() { return row; } };
}
function healthService({ responseFailure = false, malformed = false, current = Date.parse('2026-10-11T00:00:00Z'), namespace = 'tenant-A' } = {}) {
  let fail = responseFailure, time = current;
  const calls = [], fake = fakeMongo();
  const service = createApiHealthService({ http: async config => { calls.push(config); if (fail) throw Object.assign(Error('private'), { response: { status: 503 } });
    if (config.method === 'POST') return { data: { Supported: true, Versions: [{ ProductCode: 'lp', Version: '1.60', Supported: true, LatestVersion: '1.65' }, { ProductCode: 'le', Version: '1.99', Supported: true, LatestVersion: '1.99' }] } };
    if (malformed) return { data: { unexpected: true } };
    const code = new URL(config.url).pathname.includes('/lp/') ? 'lp' : 'le'; return { data: { ProductCode: code, LatestVersion: code === 'lp' ? '1.65' : '1.99', SupportedVersions: [code === 'lp' ? '1.60' : '1.99'] } };
  }, baseUrl: 'https://tenant.example', versions: { lp: { version: '1.60', source: 'environment' }, le: { version: '1.99', source: 'environment' } }, uri: 'mongodb://localhost/health_test', namespace, endpoints, lifecycle, now: () => time, mongoClient: fake.client });
  return { service, calls, fake, setFailure: value => { fail = value; }, setTime: value => { time = value; } };
}
test('service uses only tenant GET version discovery and the documented two-component version-check POST', async () => {
  const { service, calls } = healthService(); const result = await service.checkNow();
  assert.equal(result.state, 'success'); assert.deepEqual(calls.map(c => c.method), ['GET', 'GET', 'POST']);
  assert.deepEqual(calls[2].data, [{ ProductCode: 'lp', Version: '1.60' }, { ProductCode: 'le', Version: '1.99' }]);
  assert.ok(calls.every(c => new URL(c.url).origin === 'https://tenant.example' && c.timeout <= 10000 && c.maxRedirects === 0));
  assert.equal((await service.getLatest()).state, 'success');
});
test('failed checks retain last success and stale results cannot be presented as healthy', async () => {
  const harness = healthService(); await harness.service.checkNow();
  harness.setFailure(true);
  assert.equal((await harness.service.checkNow()).state, 'failed');
  const afterFailure = await harness.service.getLatest();
  assert.equal(afterFailure.state, 'failed_since_success'); assert.equal(afterFailure.assessment.status, 'unknown');
  assert.equal(afterFailure.lastSuccessfulAssessment.status, 'update_available');
  const staleTime = Date.parse('2026-10-11T00:00:00Z');
  const stale = healthService({ current: staleTime }); await stale.service.checkNow(); stale.setTime(staleTime + STALE_MS + 1);
  const latest = await stale.service.getLatest();
  assert.equal(latest.state, 'stale'); assert.equal(latest.assessment.status, 'unknown');
});
test('tenant namespace is applied to cache reads and background failures are contained', async () => {
  const a = healthService({ namespace: 'tenant-A' }), b = healthService({ namespace: 'tenant-B' });
  await a.service.checkNow(); assert.equal((await b.service.getLatest()).state, 'unavailable');
  const failure = healthService({ responseFailure: true }); assert.equal((await failure.service.tick()).state, 'failed');
});
test('malformed tenant version responses are rejected and persisted history remains bounded', async () => {
  const malformed = healthService({ malformed: true });
  assert.equal((await malformed.service.checkNow()).state, 'failed');
  const history = healthService();
  for (let i = 0; i < 22; i++) await history.service.checkNow();
  assert.equal(history.fake.row.history.length, 20);
});
