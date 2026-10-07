'use strict';
const { normalizeAssignment, normalizeRows } = require('./normalizers');
// Scope: dropbox:folders:read
function createAssignmentsClient({ list, coursePath }) {
  return { async getAssignments(orgUnitId, raw, includeNative = false) {
    return normalizeRows(await list(coursePath(orgUnitId, 'dropbox/folders/'), raw), normalizeAssignment,
      orgUnitId, 'assignments', row => row.Id, includeNative);
  } };
}
module.exports = { createAssignmentsClient };
