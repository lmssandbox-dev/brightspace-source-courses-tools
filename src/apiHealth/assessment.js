'use strict';

const VERSION = /^\d+\.\d+$/;
const LIFECYCLE_EVIDENCE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const HEALTH = new Set(['healthy', 'update_available', 'at_risk', 'critical', 'unknown']);

function compare(a, b) {
  const left = String(a).split('.').map(Number), right = String(b).split('.').map(Number);
  return left[0] - right[0] || left[1] - right[1];
}
function lifecycleEvidenceStatus(component, evidence, now = Date.now()) {
  const row = evidence?.components?.[component];
  const verified = Date.parse(`${row?.verifiedAt || ''}T00:00:00Z`);
  if (!row || !Number.isFinite(verified) || !Array.isArray(row.ranges)) return 'unavailable';
  return now - verified > LIFECYCLE_EVIDENCE_MAX_AGE_MS ? 'stale' : 'verified';
}
function lifecycleFor(component, version, evidence, now = Date.now()) {
  if (!version || !VERSION.test(version)) return 'unknown';
  const row = evidence?.components?.[component];
  if (lifecycleEvidenceStatus(component, evidence, now) !== 'verified') return 'unknown';
  const match = row.ranges.find(item => item.status !== 'supported' && item.max && compare(version, item.max) <= 0);
  return match?.status || 'supported';
}
function worst(values) {
  const rank = { critical: 5, at_risk: 4, update_available: 3, healthy: 2, unknown: 1 };
  if (values.length && values.every(value => value === 'unknown')) return 'unknown';
  return values.reduce((a, b) => (rank[b] || 0) > (rank[a] || 0) ? b : a, 'healthy');
}
function contractStatus(endpoint) {
  const status = endpoint.contractVerification?.status;
  return ['verified', 'not_verified', 'not_applicable'].includes(status) ? status : 'not_verified';
}
function endpointVersionHealth({ endpoint, configured, checks, componentAssessment, minimums = {}, lifecycle }) {
  if (endpoint.component === 'external') return { status: 'not_applicable', finding: 'External dataset download URL; no Valence API version applies.' };

  const component = endpoint.component;
  const version = configured?.[component]?.version;
  const tenant = checks?.components?.[component];
  const appMinimum = (minimums[component] || []).find(item => item.endpointId === endpoint.id);
  const routeRisks = Array.isArray(endpoint.versionRisks) ? endpoint.versionRisks : [];
  const findings = [];
  if (tenant?.supported === false) findings.push({ status: 'critical', code: 'unsupported', message: 'Tenant does not support the configured API version.' });
  if (endpoint.minimumVersion && version && VERSION.test(version) && compare(version, endpoint.minimumVersion) < 0) {
    findings.push({ status: 'critical', code: 'endpoint_minimum_not_met', message: `Configured version is below the documented endpoint minimum ${endpoint.minimumVersion}.` });
  }
  if (appMinimum && version && VERSION.test(version) && compare(version, appMinimum.minimum) < 0) {
    findings.push({ status: 'critical', code: 'application_minimum_not_met', message: `Configured version is below the application minimum ${appMinimum.minimum} for ${appMinimum.tool}.` });
  }
  for (const risk of routeRisks) {
    if (!version || !VERSION.test(version)) continue;
    const matches = Boolean(risk.min || risk.max) && (!risk.min || compare(version, risk.min) >= 0) && (!risk.max || compare(version, risk.max) <= 0);
    if (matches && HEALTH.has(risk.status) && risk.status !== 'healthy' && risk.status !== 'unknown') findings.push({ status: risk.status, code: risk.code || 'endpoint_version_risk', message: risk.message || 'D2L documents a route-specific version risk.' });
  }

  const lifecycleStatus = componentAssessment?.lifecycleStatus || 'unknown';
  if (lifecycleStatus === 'deprecated') findings.push({ status: 'at_risk', code: 'deprecated', message: 'Configured API version is in a D2L-documented deprecated lifecycle range.' });
  if (['obsolete', 'eol'].includes(lifecycleStatus)) findings.push({ status: 'critical', code: lifecycleStatus, message: `Configured API version is in a D2L-documented ${lifecycleStatus.toUpperCase()} lifecycle range.` });
  if (findings.length) return { status: worst(findings.map(item => item.status)), finding: findings.map(item => item.message).join(' ') };

  if (!version || !VERSION.test(version) || !tenant || typeof tenant.supported !== 'boolean' || lifecycleStatus === 'unknown' || lifecycleStatus === 'unavailable' || lifecycleStatus === 'stale') {
    const reason = !version ? 'Configured API version is unavailable.' : !tenant || typeof tenant.supported !== 'boolean' ? 'Tenant support could not be verified.' : 'Current D2L lifecycle evidence is unavailable or stale.';
    return { status: 'unknown', finding: reason };
  }
  if (tenant.supported === true && tenant.latestVersion && VERSION.test(tenant.latestVersion) && compare(tenant.latestVersion, version) > 0) {
    return { status: 'update_available', finding: 'A newer version is supported by the tenant; the configured version remains supported.' };
  }
  if (tenant.supported === true && lifecycleStatus === 'supported') return { status: 'healthy', finding: null };
  return { status: 'unknown', finding: 'Available version evidence does not establish compatibility.' };
}
function assess({ configured, checks, endpoints = [], lifecycle, minimums = {}, checkedAt = new Date().toISOString() }) {
  const components = {};
  const assessmentTime = Date.parse(checkedAt) || Date.now();
  for (const code of ['lp', 'le']) {
    const config = configured[code] || {};
    const tenant = checks?.components?.[code];
    const findings = [];
    const evidenceStatus = lifecycleEvidenceStatus(code, lifecycle, assessmentTime);
    const lifecycleStatus = lifecycleFor(code, config.version, lifecycle, assessmentTime);
    if (tenant?.supported === false) findings.push({ code: 'unsupported', status: 'critical', message: 'Tenant does not support the configured API version.' });
    if (lifecycleStatus === 'deprecated') findings.push({ code: 'deprecated', status: 'at_risk', message: 'Configured API version is in a D2L-documented deprecated lifecycle range.' });
    if (['obsolete', 'eol'].includes(lifecycleStatus)) findings.push({ code: lifecycleStatus, status: 'critical', message: `Configured API version is in a D2L-documented ${lifecycleStatus.toUpperCase()} lifecycle range.` });
    for (const item of minimums[code] || []) if (config.version && VERSION.test(config.version) && compare(config.version, item.minimum) < 0) findings.push({ code: 'minimum_not_met', status: 'critical', endpointId: item.endpointId, message: `Configured version is below the application's ${item.minimum} minimum for ${item.tool}.` });
    if (tenant?.supported === true && lifecycleStatus === 'supported' && tenant.latestVersion && VERSION.test(tenant.latestVersion) && VERSION.test(config.version) && compare(tenant.latestVersion, config.version) > 0 && !findings.some(x => x.status === 'critical' || x.status === 'at_risk')) findings.push({ code: 'update_available', status: 'update_available', message: 'Tenant supports a newer API version; current version remains supported.' });
    if (!tenant || typeof tenant.supported !== 'boolean' || !config.version || lifecycleStatus === 'unknown') findings.push({ code: 'evidence_incomplete', status: 'unknown', message: !tenant ? 'Tenant support could not be verified.' : 'Lifecycle status is not verified by current source-controlled evidence.' });
    components[code] = { configuredVersion: config.version || null, versionSource: config.source || null,
      supported: typeof tenant?.supported === 'boolean' ? tenant.supported : null,
      latestSupportedVersion: tenant?.latestVersion || null, lifecycleStatus,
      lifecycleEvidenceStatus: evidenceStatus, status: worst(findings.map(x => x.status)), findings };
  }
  const endpointFindings = endpoints.map(endpoint => {
    const componentAssessment = components[endpoint.component];
    const health = endpointVersionHealth({ endpoint, configured, checks, componentAssessment, minimums, lifecycle });
    return { endpointId: endpoint.id, component: endpoint.component, versionHealth: health.status,
      contractVerification: contractStatus(endpoint), finding: health.finding,
      configuredVersion: configured[endpoint.component]?.version || null, minimumVersion: endpoint.minimumVersion || null,
      versionDependentBehavior: endpoint.versionBehavior || 'Unknown', tools: endpoint.features || [],
      evidence: (endpoint.docs || []).map(url => ({ url, verifiedAt: endpoint.contractVerification?.verifiedAt || endpoint.verifiedAt || null })) };
  });
  const statuses = [...Object.values(components).map(c => c.status), ...endpointFindings.map(e => e.versionHealth).filter(status => HEALTH.has(status))];
  const actions = [];
  if (statuses.includes('critical')) actions.push('Contact the Brightspace administrator and plan a reviewed compatibility correction; do not auto-upgrade production versions.');
  if (statuses.includes('at_risk')) actions.push('Plan migration away from the deprecated API contract with tenant-specific validation.');
  if (statuses.includes('update_available')) actions.push('Review newer tenant-supported versions and test compatibility before making a configuration change.');
  if (statuses.includes('unknown')) actions.push('Refresh tenant checks and verify lifecycle evidence; unknown evidence is not a health guarantee.');
  return { checkedAt, configured: { lp: components.lp.configuredVersion, le: components.le.configuredVersion },
    latestTenantSupported: { lp: components.lp.latestSupportedVersion, le: components.le.latestSupportedVersion },
    tenantSupport: { lp: components.lp.supported, le: components.le.supported },
    status: worst(statuses), components, endpoints: endpointFindings, affectedTools: [...new Set(endpointFindings.flatMap(e => e.tools))],
    summary: endpointFindings.reduce((counts, endpoint) => { counts[endpoint.versionHealth] = (counts[endpoint.versionHealth] || 0) + 1; return counts; }, {}),
    evidence: lifecycle?.sources || [], recommendedActions: actions,
    limitations: ['Native version checks verify API component version support; they do not validate individual routes, request bodies, or JSON contracts.'] };
}

module.exports = { assess, compare, lifecycleFor, lifecycleEvidenceStatus, endpointVersionHealth, LIFECYCLE_EVIDENCE_MAX_AGE_MS };
