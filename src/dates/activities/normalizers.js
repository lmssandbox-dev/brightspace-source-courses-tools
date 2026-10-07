'use strict';

// Shared activity shape and UTC timestamp rules.
function normalizeInstant(value, field) {
  if (value == null) return null;
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/);
  const fail = () => { const error = new Error('Invalid timezone-aware timestamp'); error.code = 'INVALID_DATE'; error.field = field; throw error; };
  if (!match) return fail();
  const [, y, m, d, h, min, sec, fraction, zone] = match;
  const days = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
  if (+m < 1 || +m > 12 || +d < 1 || +d > days || +h > 23 || +min > 59 || +sec > 59 ||
      (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))) return fail();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return fail();
  const utc = new Date(timestamp).toISOString();
  return fraction?.length > 3 ? utc.replace(/\.\d{3}Z$/, `.${fraction}Z`) : utc;
}

function normalizeActivity({ type, id, parentId = null, name, orgUnitId, dates = {},
  availability, identity = { activityId: null }, metadata = {} }) {
  return { key: `${type}:${orgUnitId}:${id}`, type, id, parentId, name, orgUnitId,
    dates: { start: normalizeInstant(dates.start, 'start'), due: normalizeInstant(dates.due, 'due'),
      end: normalizeInstant(dates.end, 'end') }, availability, identity, metadata };
}
const hasDates = activity => Object.values(activity.dates).some(value => value !== null);

function recordWarning(source, error, itemId) {
  return { source, code: error.code === 'INVALID_DATE' ? 'INVALID_DATE' : 'INVALID_RECORD',
    message: error.code === 'INVALID_DATE' ? 'An activity has an invalid timestamp and was excluded.' : 'An invalid activity record was excluded.',
    details: { ...(itemId != null ? { id: String(itemId) } : {}), ...(error.field ? { field: error.field } : {}) } };
}
function normalizeRows(rows, normalize, orgUnitId, source, getId, includeNative = false) {
  const activities = [], warnings = [], nativeActivities = includeNative ? [] : undefined;
  for (const row of rows) {
    try {
      const normalized = normalize(row, orgUnitId);
      activities.push(normalized);
      if (nativeActivities) nativeActivities.push({ key: normalized.key, data: row });
    }
    catch (error) { warnings.push(recordWarning(source, error, row && getId(row))); }
  }
  return { activities, warnings, ...(nativeActivities ? { nativeActivities } : {}) };
}


// AVAILABILITY_T: https://docs.valence.desire2learn.com/res/apiprop.html
// These describe restrictions outside an availability boundary, not dates or
// the current visibility of an item. Never infer a type from a date or IsHidden.
const types = Object.freeze({
  0: { name: 'AccessRestricted', label: 'Access restricted' },
  1: { name: 'SubmissionRestricted', label: 'Submission restricted' },
  2: { name: 'Hidden', label: 'Hidden' }
});

function describeAvailabilityType(raw, present = true) {
  if (!present) return { value: null, name: null, label: 'Not provided', state: 'missing' };
  if (raw == null) return { value: null, name: null, label: 'Not specified', state: 'unspecified' };
  // Accept the documented numeric/string representations without coercing
  // booleans, empty strings or unexpected values into a known restriction.
  const known = (typeof raw === 'number' || typeof raw === 'string') &&
    Object.hasOwn(types, raw) ? types[raw] : null;
  return known ? { value: raw, ...known, state: 'known' } :
    { value: structuredClone(raw), name: null, label: 'Unknown availability type', state: 'unknown' };
}


const { id } = require('../../shared/id');

function availability(row) {
  const field = key => describeAvailabilityType(row?.[key], row != null && Object.hasOwn(row, key));
  return { startType: field('StartDateAvailabilityType'), endType: field('EndDateAvailabilityType') };
}
function metadata(row) {
  const result = {};
  for (const key of ['IsHidden', 'IsActive', 'IsLocked', 'IsBroken', 'DisplayInCalendar']) {
    if (Object.hasOwn(row, key)) result[key[0].toLowerCase() + key.slice(1)] = row[key];
  }
  return result;
}
function activity(type, row, orgUnitId, itemId, parentId = null, dates = row, types = row) {
  return normalizeActivity({ type, id: id(itemId), parentId: parentId == null ? null : id(parentId),
    name: row.Name ?? row.Title ?? '', orgUnitId: id(orgUnitId),
    dates: { start: dates.StartDate, due: dates.DueDate, end: dates.EndDate },
    availability: availability(types), identity: { activityId: row.ActivityId ?? null }, metadata: metadata(row) });
}
function normalizeAssignment(row, orgUnitId) {
  return activity('assignment', row, orgUnitId, row.Id, row.CategoryId,
    { StartDate: row.Availability?.StartDate, EndDate: row.Availability?.EndDate, DueDate: row.DueDate }, row.Availability);
}
const normalizeQuiz = (row, orgUnitId) => activity('quiz', row, orgUnitId, row.QuizId, row.CategoryId);
const normalizeDiscussionTopic = (row, orgUnitId) => activity('discussionTopic', row, orgUnitId, row.TopicId, row.ForumId);

module.exports = { normalizeAssignment, normalizeQuiz, normalizeDiscussionTopic, describeAvailabilityType, normalizeRows, recordWarning, normalizeActivity, normalizeInstant, hasDates };
