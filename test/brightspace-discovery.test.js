'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrightspaceClient } = require('../src/shared/client');
const { createAssignmentsClient } = require('../src/dates/activities/assignments');
const { createQuizzesClient } = require('../src/dates/activities/quizzes');
const { createDiscussionsClient } = require('../src/dates/activities/discussions');
const { createActivityDiscovery } = require('../src/dates/activityDiscovery');

// Test composition exercises the same layers wired by the application.
function createDiscoveryClient(options) {
  const client = createBrightspaceClient(options);
  const assignments = createAssignmentsClient(client);
  const quizzes = createQuizzesClient(client);
  const discussions = createDiscussionsClient(client);
  return { ...assignments, ...quizzes, ...discussions,
    ...createActivityDiscovery({ assignments, quizzes, discussions }) };
}
const fixtures = name => require(`./fixtures/${name}.json`);
const leRoot = 'https://tenant.example/d2l/api/le/1.90';
function mockClient(overrides = {}, orgUnitId = '999') {
  const calls = [];
  const responses = {
    [`${leRoot}/999/dropbox/folders/`]: fixtures('assignments'),
    [`${leRoot}/999/quizzes/`]: fixtures('quizzes'),
    [`${leRoot}/999/quizzes/?bookmark=next`]: fixtures('quizzes-page-2'),
    [`${leRoot}/999/discussions/forums/`]: fixtures('forums'),
    [`${leRoot}/999/discussions/forums/31/topics/`]: [],
    [`${leRoot}/999/discussions/forums/32/topics/`]: fixtures('discussion-topics'),
    ...overrides
  };
  Object.assign(responses, overrides);
  const client = createDiscoveryClient({ leRoot, get: async url => {
    calls.push(url);
    // Same API contracts for either org-unit context; these are synthetic mocks.
    url = url.replace(`/${orgUnitId}/`, '/999/');
    assert.ok(Object.hasOwn(responses, url), `Unexpected GET ${url}`);
    if (responses[url] instanceof Error) throw responses[url];
    const response = structuredClone(responses[url]);
    if (response?.Next) response.Next = response.Next.replace('/999/', `/${orgUnitId}/`);
    return response;
  } });
  return { client, calls };
}

test('core discovery returns all supported dated and undated activities, stable keys and no auxiliary requests', async () => {
  const { client, calls } = mockClient();
  const r = await client.discover('999');
  assert.equal(r.schemaVersion, 3); assert.equal(r.complete, true);
  assert.equal(r.activities.length, 9); assert.equal(r.counts.datedActivities, 5);
  assert.equal(r.warnings.length, 0);
  assert.equal(Object.hasOwn(r, 'contentRelationships'), false);
  assert.ok(calls.every(url => !/content|sourceCourses/.test(url)));
  assert.equal(new Set(r.activities.map(a => a.key)).size, r.activities.length);
  assert.ok(r.activities.some(a => a.type === 'quiz' && a.id === '23'));
  assert.ok(r.activities.some(a => a.type === 'discussionTopic' && a.id === '41'));
  assert.equal(Object.hasOwn(r, 'raw'), false); assert.equal(calls.length, 6);
});

test('native collection records are available only to planning callers and align to normalized keys', async () => {
  const { client } = mockClient();
  const ordinary = await client.discover('999');
  assert.equal(Object.hasOwn(ordinary, 'nativeActivities'), false);
  const planned = await client.discover('999', { includeNative: true });
  assert.equal(planned.nativeActivities.length, planned.activities.length);
  const quiz = planned.activities.find(item => item.type === 'quiz' && item.id === '21');
  const native = planned.nativeActivities.find(item => item.key === quiz.key);
  assert.equal(native.data.QuizId, 21);
  assert.equal(native.data.Password, 'raw-only-secret');
  const topic = planned.activities.find(item => item.type === 'discussionTopic' && item.id === '41');
  assert.equal(planned.nativeActivities.find(item => item.key === topic.key).data.ForumId, '32');
});


test('diagnostic raw responses are opt-in, preserve envelopes and redact secrets', async () => {
  const { client, calls } = mockClient();
  const r = await client.discover(999, { includeRaw: true });
  assert.equal(r.raw.length, calls.length);
  const q = r.raw.find(p => p.url === `${leRoot}/999/quizzes/`).data;
  assert.equal(q.Objects[0].Password, '[REDACTED]'); assert.ok(q.Next);
  assert.equal(JSON.stringify(r).includes('raw-only-secret'), false);
  for (const a of r.activities) {
    assert.equal(Object.hasOwn(a, 'startDate'), false);
    assert.equal(Object.keys(a.metadata).some(k => /^[A-Z]/.test(k)), false);
    assert.equal(Object.hasOwn(a.metadata, 'Availability'), false);
  }
});

test('pagination rejects unsafe Next URLs, cycles and malformed envelopes', async () => {
  for (const page of [{ Objects: [], Next: `${leRoot}/999/quizzes/` },
    { Objects: [], Next: 'https://evil.example/d2l/api/le/1.90/999/quizzes/' },
    { Objects: [], Next: 'http://tenant.example/d2l/api/le/1.90/999/quizzes/' },
    { Objects: [], Next: '/not-an-api' }, { Objects: [], Next: {} }, {}, { Objects: [] }]) {
    const { client, calls } = mockClient({ [`${leRoot}/999/quizzes/`]: page });
    await assert.rejects(() => client.getQuizzes(999)); assert.equal(calls.length, 1);
  }
});

test('bookmark pagination follows every page and guards repeated/missing bookmarks', async () => {
  const calls = [];
  const api = createBrightspaceClient({ leRoot, get: async url => {
    calls.push(url);
    return calls.length === 1 ? { Items: [1], PagingInfo: { HasMoreItems: true, Bookmark: 'a+b' } } :
      { Items: [2], PagingInfo: { HasMoreItems: false, Bookmark: 'last' } };
  } });
  assert.deepEqual(await api.list(`${leRoot}/999/quizzes/?pageSize=1`), [1,2]);
  assert.equal(new URL(calls[1]).searchParams.get('bookmark'), 'a+b');
  assert.equal(new URL(calls[1]).searchParams.get('pageSize'), '1');
  for (const Bookmark of [undefined, '', 'repeated']) {
    const broken = createBrightspaceClient({ leRoot, get: async () => ({ Items: [], PagingInfo: { HasMoreItems: true, Bookmark } }) });
    await assert.rejects(() => broken.list(`${leRoot}/999/quizzes/`));
  }
});

test('empty accessible course is a complete empty result', async () => {
  const { client } = mockClient({ [`${leRoot}/999/dropbox/folders/`]: [], [`${leRoot}/999/quizzes/`]: { Objects: [], Next: null },
    [`${leRoot}/999/discussions/forums/`]: [] });
  const r = await client.discover(999);
  assert.equal(r.complete, true); assert.deepEqual(r.activities, []);
});
const httpFailure = status => Object.assign(new Error('SECRET'), { response: { status, data: 'SECRET' }, config: { Authorization: 'SECRET' } });

test('one resource server failure returns partial discovery with structured sanitized warnings', async () => {
  const { client } = mockClient({ [`${leRoot}/999/quizzes/`]: httpFailure(500) });
  const r = await client.discover(999);
  assert.equal(r.complete, false); assert.equal(r.sources.quizzes.status, 'failed');
  assert.ok(r.activities.some(a => a.type === 'assignment'));
  assert.ok(!r.activities.some(a => a.type === 'quiz'));
  assert.deepEqual(r.warnings.find(w => w.source === 'quizzes'), { source: 'quizzes', code: 'API_READ_FAILED',
    message: 'Unable to read quizzes; discovery is incomplete.', details: { httpStatus: 500 } });
  assert.equal(JSON.stringify(r).includes('SECRET'), false);
});

test('forum dates are ignored when enumerating topics', async () => {
  const { client } = mockClient({ [`${leRoot}/999/discussions/forums/`]: [
    { ForumId: 32, Name: 'Forum with invalid date', StartDate: 'not-a-date' }
  ] });
  const r = await client.discover(999);
  assert.equal(r.complete, true);
  assert.ok(!r.activities.some(a => a.type === 'discussionForum'));
  assert.ok(r.activities.some(a => a.type === 'discussionTopic'));
  assert.ok(!r.warnings.some(w => w.code === 'INVALID_DATE'));
});


test('authentication, throttling, network failures, collection 404s and total denial stay top-level failures', async () => {
  for (const status of [400, 401, 403, 429, 503, 404, undefined]) {
    const { client } = mockClient({ [`${leRoot}/999/quizzes/`]: httpFailure(status) });
    await assert.rejects(() => client.discover(999), e => !e.message.includes('SECRET'));
  }
  const denied = httpFailure(403);
  const { client } = mockClient({ [`${leRoot}/999/dropbox/folders/`]: denied, [`${leRoot}/999/quizzes/`]: denied,
    [`${leRoot}/999/discussions/forums/`]: denied });
  await assert.rejects(() => client.discover(999), /Brightspace API read failed/);
});

test('incomplete quiz pagination is not returned as a complete quiz collection', async () => {
  const { client } = mockClient({ [`${leRoot}/999/quizzes/?bookmark=next`]: httpFailure(500) });
  const r = await client.discover(999);
  assert.equal(r.complete, false); assert.ok(!r.activities.some(a => a.type === 'quiz'));
});

test('invalid OrgUnitIds cannot initiate requests', async () => {
  const { client, calls } = mockClient(); await assert.rejects(() => client.discover('../123')); assert.equal(calls.length, 0);
});

for (const [kind, orgUnitId] of [['Course Offering', '9524'], ['Course Offering', '10000']]) {
  test(`${kind} synthetic fixture discovery is course-scoped and type-neutral`, async () => {
    const { client, calls } = mockClient({}, orgUnitId); const r = await client.discover(orgUnitId);
    assert.deepEqual([...new Set(r.activities.map(a => a.type))].sort(),
      ['assignment','quiz','discussionTopic'].sort());
    for (const item of r.activities) assert.equal(item.orgUnitId, orgUnitId);
    assert.ok(calls.every(url => new URL(url).pathname.startsWith(`/d2l/api/le/1.90/${orgUnitId}/`)));
  });
}


test('acceptance matrix rejects an empty successful response', () => {
  const assessment = require('../scripts/discovery-acceptance').assessDiscovery({ activities: [], complete: true, warnings: [], orgUnitId: '999' });
  assert.equal(assessment.passed, false);
});

test('LE below 1.90 is rejected before any read', () => {
  for (const version of ['1.53', '1.89']) assert.throws(() => createBrightspaceClient({
    leRoot: `https://tenant.example/d2l/api/le/${version}`, get: () => assert.fail('Unexpected read')
  }), /requires Brightspace LE 1.90/);
  for (const version of ['1.90', '1.100', '2.0']) assert.doesNotThrow(() => createBrightspaceClient({
    leRoot: `https://tenant.example/d2l/api/le/${version}`, get: async () => []
  }));
});

test('repeated native rows keep one canonical identity without a false ambiguous match', async () => {
  const a = fixtures('assignments')[0];
  const { client } = mockClient({ [`${leRoot}/999/dropbox/folders/`]: [a,a] });
  const r = await client.discover(999);
  assert.equal(r.activities.filter(a => a.type === 'assignment').length, 1);
  assert.ok(r.warnings.some(w => w.code === 'DUPLICATE_IDENTITY'));
});

test('native-only acceptance fixture passes', async () => {
  const f = fixtures('acceptance-course');
  const { client } = mockClient({ [`${leRoot}/999/dropbox/folders/`]: f.assignments,
    [`${leRoot}/999/quizzes/`]: f.quizzes, [`${leRoot}/999/quizzes/?bookmark=next`]: f.quizPage2,
    [`${leRoot}/999/discussions/forums/`]: f.forums,
    [`${leRoot}/999/discussions/forums/32/topics/`]: f.discussionTopics });
  const result = require('../scripts/discovery-acceptance').assessDiscovery(await client.discover(999));
  assert.equal(result.passed, true, JSON.stringify(result.checks));
});
test('invalid forum IDs report incomplete discovery while valid forums still yield topics', async () => {
  const { client } = mockClient({ [`${leRoot}/999/discussions/forums/`]: [{ForumId: null}, {ForumId:32}, {ForumId:32}] });
  const r = await client.discover(999);
  assert.equal(r.complete, false);
  assert.equal(r.activities.filter(a => a.type === 'discussionTopic').length, 2);
  assert.ok(r.warnings.some(w => w.source === 'discussionForums' && w.code === 'INVALID_RECORD'));
});
test('date-only filtering and invalid native dates preserve accurate completeness', async () => {
  const { client } = mockClient();
  const r = await client.discover(999, {includeUndated:false});
  assert.equal(r.activities.length, 5); assert.equal(r.counts.allActivities, 9);
  const broken = mockClient({ [`${leRoot}/999/dropbox/folders/`]: [{Id:1, DueDate:'bad'}] });
  const partial = await broken.client.discover(999);
  assert.equal(partial.complete, false);
  assert.ok(partial.warnings.some(w => w.code === 'INVALID_DATE'));
});
