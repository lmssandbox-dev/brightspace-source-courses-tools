'use strict';
function resolveRuntimeVersions(env = process.env) {
  const lp = env.D2L_LP_VERSION;
  const le = env.D2L_LE_VERSION;
  return {
    lp: { version: lp || '1.53', source: lp ? 'environment' : 'application_fallback' },
    le: { version: le || null, source: le ? 'environment' : null }
  };
}
module.exports = { resolveRuntimeVersions };
