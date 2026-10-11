'use strict';
const { MongoClient } = require('mongodb');
const { databaseConfig } = require('../shared/database');
const { assess } = require('./assessment');
const HISTORY_LIMIT = 20, DAILY_MS = 86400000, STALE_MS = 36 * 60 * 60 * 1000;
function validVersion(value) { return typeof value === 'string' && /^\d+\.\d+$/.test(value); }
function createApiHealthService({ http, baseUrl, versions, uri, namespace, endpoints, lifecycle, minimums = {}, buildVersion = 'unknown', now = Date.now, mongoClient }) {
  databaseConfig(uri);
  const client = mongoClient || new MongoClient(uri, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 30000 });
  let databasePromise, running = false;
  async function collection() {
    databasePromise ||= (async () => { await client.connect(); const c = client.db().collection('api_health'); await c.createIndex({ namespace: 1 }, { unique: true }); return c; })().catch(e => { databasePromise = null; throw e; });
    return databasePromise;
  }
  async function request(method, path, data) {
    const url = new URL(path, baseUrl);
    if (url.origin !== new URL(baseUrl).origin || url.protocol !== 'https:') throw Error('Invalid tenant health-check URL');
    const response = await http({ method, url: url.href, ...(data === undefined ? {} : { data }), timeout: 10000, maxRedirects: 0, headers: data === undefined ? {} : { 'Content-Type': 'application/json' } });
    return response?.data;
  }
  async function doCheck() {
    const started = now();
    const lock = await claim(started);
    if (!lock) return { state: 'already_running', assessment: await getLatest() };
    try {
      if (!validVersion(versions.lp.version) || !validVersion(versions.le.version)) throw Object.assign(Error('Runtime API versions are invalid or unavailable'), { code: 'INVALID_CONFIG' });
      const [lp, le] = await Promise.all([request('GET', '/d2l/api/lp/versions/'), request('GET', '/d2l/api/le/versions/')]);
      validateProductVersions(lp, 'lp'); validateProductVersions(le, 'le');
      const checkData = await request('POST', '/d2l/api/versions/check', [
        { ProductCode: 'lp', Version: versions.lp.version }, { ProductCode: 'le', Version: versions.le.version }
      ]);
      const components = parseCheck(checkData, versions);
      const assessment = assess({ configured: versions, checks: { components }, endpoints, lifecycle, minimums, checkedAt: new Date(started).toISOString() });
      assessment.buildVersion = buildVersion;
      const c = await collection();
      await c.updateOne({ namespace }, { $set: { namespace, latestSuccessful: assessment, lastSuccessfulAt: assessment.checkedAt, lastAttemptAt: assessment.checkedAt, failure: null, lockUntil: 0 }, $push: { history: { $each: [assessment], $slice: -HISTORY_LIMIT } } });
      return { state: 'success', assessment };
    } catch (error) {
      const c = await collection();
      await c.updateOne({ namespace }, { $set: { namespace, lastAttemptAt: new Date(started).toISOString(), failure: { at: new Date(started).toISOString(), code: safeCode(error.code), status: Number.isInteger(error.response?.status) ? error.response.status : null }, lockUntil: 0 } }, { upsert: true });
      return { state: 'failed', error: { code: safeCode(error.code), status: Number.isInteger(error.response?.status) ? error.response.status : null }, assessment: await getLatest() };
    } finally { running = false; }
  }
  async function claim(at) {
    if (running) return false;
    const c = await collection();
    const result = await c.findOneAndUpdate({ namespace, lockUntil: { $lte: at } }, { $set: { lockUntil: at + 120000 } }, { returnDocument: 'after' });
    if (result.value) { running = true; return true; }
    try { await c.updateOne({ namespace }, { $setOnInsert: { namespace, lockUntil: at + 120000 } }, { upsert: true }); } catch (e) { if (e.code !== 11000) throw e; }
    const retry = await c.findOneAndUpdate({ namespace, lockUntil: { $lte: at } }, { $set: { lockUntil: at + 120000 } }, { returnDocument: 'after' });
    if (!retry.value) return false;
    running = true; return true;
  }
  async function getLatest() {
    const row = await (await collection()).findOne({ namespace }, { projection: { latestSuccessful: 1, lastSuccessfulAt: 1, lastAttemptAt: 1, failure: 1 } });
    if (!row?.latestSuccessful) return { state: 'unavailable', assessment: null, lastSuccessfulAt: null, failure: row?.failure || null };
    const stale = now() - Date.parse(row.lastSuccessfulAt) > STALE_MS;
    const uncertain = stale || Boolean(row.failure);
    const assessment = uncertain ? { ...row.latestSuccessful, status: 'unknown', stale,
      lastSuccessfulStatus: row.latestSuccessful.status,
      recommendedActions: [...(row.latestSuccessful.recommendedActions || []), stale ? 'Run a fresh API health check; the last successful result is stale.' : 'The most recent check failed; current health is unknown until a check succeeds.'] } : row.latestSuccessful;
    return { state: stale ? 'stale' : row.failure ? 'failed_since_success' : 'success', assessment,
      lastSuccessfulAssessment: row.latestSuccessful,
      lastSuccessfulAt: row.lastSuccessfulAt, lastAttemptAt: row.lastAttemptAt || null, failure: row.failure || null };
  }
  async function tick() {
    try { const c = await collection(), row = await c.findOne({ namespace }, { projection: { lastAttemptAt: 1, lockUntil: 1 } });
      if (!row?.lastAttemptAt || now() - Date.parse(row.lastAttemptAt) >= DAILY_MS) return await doCheck();
      return { state: 'not_due' };
    } catch { return { state: 'failed' }; }
  }
  return { checkNow: doCheck, getLatest, tick };
}
function validateProductVersions(value, code) { if (!value || value.ProductCode !== code || !Array.isArray(value.SupportedVersions) || !value.SupportedVersions.every(validVersion) || !validVersion(value.LatestVersion)) throw Object.assign(Error('Malformed Brightspace product versions response'), { code: 'INVALID_RESPONSE' }); }
function parseCheck(value, versions) {
  if (!value || typeof value.Supported !== 'boolean' || !Array.isArray(value.Versions)) throw Object.assign(Error('Malformed Brightspace version-check response'), { code: 'INVALID_RESPONSE' });
  const output = {};
  for (const code of ['lp', 'le']) {
    const row = value.Versions.find(item => item?.ProductCode === code && item?.Version === versions[code].version);
    if (!row || typeof row.Supported !== 'boolean' || !validVersion(row.LatestVersion)) throw Object.assign(Error('Incomplete Brightspace version-check response'), { code: 'INVALID_RESPONSE' });
    output[code] = { supported: row.Supported, latestVersion: row.LatestVersion };
  }
  return output;
}
function safeCode(value) { return /^[A-Z0-9_:-]{1,80}$/.test(String(value || '')) ? String(value) : 'CHECK_FAILED'; }
module.exports = { createApiHealthService, validateProductVersions, parseCheck, HISTORY_LIMIT, STALE_MS };
