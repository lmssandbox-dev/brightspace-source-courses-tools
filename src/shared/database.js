'use strict';


function databaseConfig(uri) {
  // Inspect only the database path; never include credentials in an error.
  const match = typeof uri === 'string' && uri.match(/^mongodb(?:\+srv)?:\/\/[^/?#]+\/([^?#]*)(?:\?[^#]*)?$/);
  if (!match || !/^[A-Za-z0-9_-]{1,63}$/.test(match[1]) || ['admin', 'local', 'config'].includes(match[1].toLowerCase())) {
    throw new Error('MONGODB_URL must explicitly select an application database before any ? options. Use 1–63 letters, digits, underscores or hyphens; admin, local and config are reserved.');
  }
  const query = new URLSearchParams(uri.split('?')[1] || '');
  for (const name of query.keys()) {
    if (name.toLowerCase() === 'dbname') throw new Error('Remove dbName from MONGODB_URL query options; use the database path.');
  }
  return { url: uri };
}

module.exports = { databaseConfig };
