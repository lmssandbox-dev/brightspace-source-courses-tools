const { test } = require('node:test');
const assert = require('node:assert/strict');
const { databaseConfig } = require('../src/shared/database');

test('accepts the existing database and preserves connection options', () => {
  const uri = 'mongodb+srv://user:password@cluster.example/brightspace_source_courses_tools?retryWrites=true&w=majority&authSource=admin';
  assert.deepEqual(databaseConfig(uri), { url: uri });
});

test('rejects invalid databases, implicit defaults and query overrides without leaking credentials', () => {
  for (const path of ['admin', 'local', 'config', 'ADMIN', 'has space', 'a/b', 'a.b', '%61dmin', 'x'.repeat(64), '', 'brightspace_source_courses_tools?dbName=lti-db']) {
    assert.throws(() => databaseConfig(`mongodb+srv://user:SECRET@cluster.example/${path}`), error => {
      assert.ok(!error.message.includes('SECRET'));
      return true;
    });
  }
  assert.throws(() => databaseConfig('mongodb+srv://user:SECRET@cluster.example'));
});

test('accepts independent prospect databases with either MongoDB URI scheme', () => {
 for (const scheme of ['mongodb','mongodb+srv']) {
  const uri = `${scheme}://user:password@cluster.example/prospect_demo-1?authSource=admin`;
  assert.deepEqual(databaseConfig(uri), {url:uri});
 }
});
