'use strict';
const { id } = require('../../shared/id');
const { normalizeDiscussionTopic, normalizeRows } = require('./normalizers');
// Scopes: discussions:forums:readonly, discussions:topics:readonly.
// Topic DueDate is available from LE 1.90; absent fields remain null.
function createDiscussionsClient({ list, coursePath }) {
  return {
    async getDiscussionForums(orgUnitId, raw) {
      const rows = await list(coursePath(orgUnitId, 'discussions/forums/'), raw);
      const forumIds = [], warnings = [];
      for (const row of rows) {
        try { forumIds.push(id(row?.ForumId)); }
        catch { warnings.push({ source: 'discussionForums', code: 'INVALID_RECORD',
          message: 'Invalid forum ID; its topics could not be discovered.', details: {} }); }
      }
      return { forumIds: [...new Set(forumIds)], warnings };
    },
    async getDiscussionTopics(orgUnitId, forumId, raw, includeNative = false) {
      const rows = await list(coursePath(orgUnitId, `discussions/forums/${id(forumId)}/topics/`), raw);
      const result = normalizeRows(rows, row => normalizeDiscussionTopic({ ...row, ForumId: forumId }, orgUnitId),
        orgUnitId, 'discussionTopics', row => row.TopicId, includeNative);
      if (includeNative) result.nativeActivities = result.nativeActivities.map(item => ({
        ...item, data: { ...item.data, ForumId: forumId }
      }));
      return result;
    }
  };
}
module.exports = { createDiscussionsClient };
