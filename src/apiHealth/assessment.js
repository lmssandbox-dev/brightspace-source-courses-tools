'use strict';

const VERSION = /^\d+\.\d+$/;
const LIFECYCLE_EVIDENCE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
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
    for (const item of minimums[code] || []) if (config.version && compare(config.version, item.minimum) < 0) findings.push({ code: 'minimum_not_met', status: 'critical', endpointId: item.endpointId, message: `Configured version is below the application's ${item.minimum} minimum for ${item.tool}.` });
    if (tenant?.supported === true && tenant.latestVersion && compare(tenant.latestVersion, config.version) > 0 && !findings.some(x => x.status === 'critical' || x.status === 'at_risk')) findings.push({ code: 'update_available', status: 'update_available', message: 'Tenant supports a newer API version; current version remains supported.' });
    if (!tenant || !config.version || lifecycleStatus === 'unknown') findings.push({ code: 'evidence_incomplete', status: 'unknown', message: !tenant ? 'Tenant support could not be verified.' : 'Lifecycle status is not verified by current source-controlled evidence.' });
    components[code] = { configuredVersion: config.version || null, versionSource: config.source || null,
      supported: typeof tenant?.supported === 'boolean' ? tenant.supported : null,
      latestSupportedVersion: tenant?.latestVersion || null, lifecycleStatus,
      lifecycleEvidenceStatus: evidenceStatus,
      status: worst(findings.map(x => x.status)), findings };
  }
  const endpointFindings = endpoints.map(endpoint => {
    const component = endpoint.component;
    const componentAssessment = components[component];
    const minimum = endpoint.minimumVersion;
    const violates = minimum && configured[component]?.version && compare(configured[component].version, minimum) < 0;
    return { endpointId: endpoint.id, component, status: violates ? 'critical' : componentAssessment?.status || 'unknown',
      finding: violates ? `Configured version is below required ${minimum}.` : componentAssessment?.lifecycleStatus === 'unknown' ? 'Lifecycle evidence is unknown; tenant version check does not validate this endpoint contract.' : null,
      configuredVersion: configured[component]?.version || null, minimumVersion: minimum || null,
      versionDependentBehavior: endpoint.versionBehavior || 'Unknown', tools: endpoint.features || [],
      evidence: (endpoint.docs || []).map(url => ({ url, verifiedAt: endpoint.verifiedAt || null, contractEvidence: endpoint.contractEvidence || 'Unknown' })) };
  });
  // Dataset download URLs are not versioned Valence routes and do not affect LP/LE health.
  const statuses = [...Object.values(components).map(c => c.status), ...endpointFindings.filter(e => ['lp', 'le'].includes(e.component)).map(e => e.status)];
  const actions = [];
  if (statuses.includes('critical')) actions.push('Contact the Brightspace administrator and plan a reviewed compatibility correction; do not auto-upgrade production versions.');
  if (statuses.includes('at_risk')) actions.push('Plan migration away from the deprecated API contract with tenant-specific validation.');
  if (statuses.includes('update_available')) actions.push('Review newer tenant-supported versions and test compatibility before making a configuration change.');
  if (statuses.includes('unknown')) actions.push('Refresh tenant checks and verify lifecycle evidence; unknown evidence is not a health guarantee.');
  return { checkedAt, configured: { lp: components.lp.configuredVersion, le: components.le.configuredVersion },
    latestTenantSupported: { lp: components.lp.latestSupportedVersion, le: components.le.latestSupportedVersion },
    tenantSupport: { lp: components.lp.supported, le: components.le.supported },
    status: worst(statuses), components, endpoints: endpointFindings, affectedTools: [...new Set(endpointFindings.flatMap(e => e.tools))],
    evidence: lifecycle?.sources || [], recommendedActions: actions,
    limitations: ['Native version checks verify API component version support; they do not validate individual routes, request bodies, or JSON contracts.'] };
}
function worst(values) {
  const rank = { critical: 5, at_risk: 4, unknown: 3, update_available: 2, healthy: 1 };
  return values.reduce((a, b) => (rank[b] || 0) > (rank[a] || 0) ? b : a, 'healthy');
}
module.exports = { assess, compare, lifecycleFor, lifecycleEvidenceStatus, LIFECYCLE_EVIDENCE_MAX_AGE_MS };
