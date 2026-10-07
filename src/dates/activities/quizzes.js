'use strict';
const { normalizeQuiz, normalizeRows } = require('./normalizers');
// Scope: quizzing:quizzes:read. Pagination is handled by the shared adapter.
function createQuizzesClient({ list, coursePath }) {
  return { async getQuizzes(orgUnitId, raw, includeNative = false) {
    return normalizeRows(await list(coursePath(orgUnitId, 'quizzes/'), raw), normalizeQuiz,
      orgUnitId, 'quizzes', row => row.QuizId, includeNative);
  } };
}
module.exports = { createQuizzesClient };
