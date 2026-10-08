'use strict';
const { id } = require('../shared/id');
const { hasDates } = require('./activities/normalizers');
const { apiWarning } = require('../shared/client');
const { pool } = require('../shared/pool');

function createActivityDiscovery({ assignments, quizzes, discussions }) {
  return { async discover(orgUnitId, { includeRaw = false, includeUndated = true, includeNative = false, check = async () => {} } = {}) {
    orgUnitId = id(orgUnitId);
    const raw = includeRaw ? [] : undefined;
    const warnings = [], sources = {};
    let successfulReads = 0;
    async function attempt(source, read, collection = true) {
      try {
        const result = await read();
        successfulReads++;
        warnings.push(...result.warnings);
        sources[source] = { status: result.warnings.length ? 'partial' : 'complete' };
        return result;
      } catch (error) {
        // Authentication, throttling, transport outages and invalid org-unit
        // collection requests must not become a misleading partial success.
        if (error.code === 'JOB_CANCELLED' || error.fatal || (collection && [400, 404].includes(error.status))) throw error;
        warnings.push(apiWarning(source, error));
        sources[source] = { status: 'failed' };
        return null;
      }
    }
    const initial = await Promise.allSettled([
      attempt('assignments', () => assignments.getAssignments(orgUnitId, raw, includeNative)),
      attempt('quizzes', () => quizzes.getQuizzes(orgUnitId, raw, includeNative)),
      attempt('discussionForums', () => discussions.getDiscussionForums(orgUnitId, raw))
    ]);
    const initialFailure = initial.find(result => result.status === 'rejected');
    if (initialFailure) throw initialFailure.reason;
    const [a, q, f] = initial.map(result => result.value);
    const native = [...(a?.activities ?? []), ...(q?.activities ?? [])];
    const nativeActivities = [...(a?.nativeActivities ?? []), ...(q?.nativeActivities ?? [])];
    const topicResults = Array(f?.forumIds?.length ?? 0);
    await pool(f?.forumIds ?? [], 8, async (forumId, index) => {
      await check();
      topicResults[index] = await attempt(`discussionTopics:${forumId}`,
        () => discussions.getDiscussionTopics(orgUnitId, forumId, raw, includeNative), false);
    });
    for (const topics of topicResults) {
      native.push(...(topics?.activities ?? []));
      nativeActivities.push(...(topics?.nativeActivities ?? []));
    }
    if (!successfulReads) throw new Error('All discovery sources failed');
    const nativeByKey = new Map();
    for (const activity of native) {
      if (nativeByKey.has(activity.key)) warnings.push({ source: 'activities', code: 'DUPLICATE_IDENTITY',
        message: 'A native activity occurred more than once; the first record was retained.', details: { key: activity.key } });
      else nativeByKey.set(activity.key, activity);
    }
    const all = [...nativeByKey.values()];
    const firstNativeByKey = new Map();
    if (includeNative) for (const item of nativeActivities) {
      if (!firstNativeByKey.has(item.key)) firstNativeByKey.set(item.key, item);
    }
    const activities = includeUndated ? all : all.filter(hasDates);
    return { schemaVersion: 3, orgUnitId, complete: Object.values(sources).every(s => s.status === 'complete') &&
        !warnings.some(w => w.code === 'DUPLICATE_IDENTITY'),
      sources, activities,
      counts: { allActivities: all.length, datedActivities: all.filter(hasDates).length, returnedActivities: activities.length },
      warnings, ...(includeRaw ? { raw } : {}), ...(includeNative ? {
        nativeActivities: activities.map(activity => firstNativeByKey.get(activity.key)).filter(Boolean)
      } : {}) };
  } };
}
module.exports = { createActivityDiscovery };
