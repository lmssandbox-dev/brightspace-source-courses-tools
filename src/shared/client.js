'use strict';

class ApiReadError extends Error {
  constructor(status, fatal = false) {
    super('Brightspace API read failed');
    this.code = 'API_READ_FAILED';
    this.status = Number.isInteger(status) ? status : null;
    this.fatal = fatal || status === 401 || status === 403 || status === 429 || status === 503 || status == null;
  }
}
function apiWarning(source, error, details = {}) {
  return { source, code: 'API_READ_FAILED', message: `Unable to read ${source}; discovery is incomplete.`,
    details: { ...details, ...(Number.isInteger(error.status) ? { httpStatus: error.status } : {}) } };
}


const MINIMUM_LE_VERSION = '1.90';
function atLeast(version, minimum = MINIMUM_LE_VERSION) {
  if (!/^\d+\.\d+$/.test(version)) return false;
  const [major, minor] = version.split('.').map(Number);
  const [requiredMajor, requiredMinor] = minimum.split('.').map(Number);
  return major > requiredMajor || (major === requiredMajor && minor >= requiredMinor);
}
function validateLeRoot(root) {
  const match = new URL(root).pathname.match(/^\/d2l\/api\/le\/(\d+\.\d+)$/);
  if (!match || !atLeast(match[1])) throw new Error(`Discovery requires Brightspace LE ${MINIMUM_LE_VERSION} or later`);
  return match[1];
}


const { id } = require('./id');

// Shared read-only API transport, pagination and URL validation.
function createBrightspaceClient({ get, leRoot }) {
  const version = validateLeRoot(leRoot);
  const origin = new URL(leRoot).origin;
  function safeUrl(path, base = leRoot) {
    const url = new URL(path, base);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password ||
        !url.pathname.startsWith('/d2l/api/')) throw new Error('Invalid Brightspace API URL');
    return url.href;
  }
  async function read(path, raw) {
    const url = safeUrl(path);
    try {
      const data = await get(url);
      if (raw) raw.push({ url, data: redactDiagnostic(data) });
      return data;
    } catch (error) {
      if (error instanceof ApiReadError) throw error;
      throw new ApiReadError(error.response?.status);
    }
  }
  async function list(path, raw, {check=async()=>{},maxPages=10000,maxItems=1000000}={}) {
    let next = safeUrl(path);
    const seen = new Set();
    const result = [];
    while (next) {
      await check();
      if(seen.size>=maxPages || result.length>=maxItems) throw new Error('Brightspace list exceeds its limit');
      if (seen.has(next)) throw new Error('Brightspace pagination cycle detected');
      seen.add(next);
      const page = await read(next, raw);
      if (Array.isArray(page)) {if(result.length+page.length>maxItems)throw new Error('Brightspace list exceeds its limit');return result.concat(page);}
      if (page && Array.isArray(page.Items) && page.PagingInfo) {
        if (typeof page.PagingInfo.HasMoreItems !== 'boolean') throw new Error('Invalid paging metadata');
        if(result.length+page.Items.length>maxItems)throw new Error('Brightspace list exceeds its limit');
        result.push(...page.Items);
        if (!page.PagingInfo.HasMoreItems) return result;
        const bookmark = page.PagingInfo.Bookmark;
        if ((typeof bookmark !== 'string' && typeof bookmark !== 'number') || String(bookmark) === '') {
          throw new Error('Missing pagination bookmark');
        }
        const url = new URL(next);
        url.searchParams.set('bookmark', String(bookmark));
        next = url.href;
        continue;
      }
      if (!page || !Array.isArray(page.Objects) || !Object.hasOwn(page, 'Next')) {
        throw new Error('Invalid Brightspace list response');
      }
      if(result.length+page.Objects.length>maxItems)throw new Error('Brightspace list exceeds its limit');
      result.push(...page.Objects);
      if (page.Next != null && (typeof page.Next !== 'string' || !page.Next)) {
        throw new Error('Invalid Brightspace pagination link');
      }
      next = page.Next == null ? null : safeUrl(page.Next, next);
    }
    return result;
  }
  const coursePath = (orgUnitId, suffix) => `${leRoot}/${id(orgUnitId)}/${suffix}`;
  const supportsLeVersion = minimum => atLeast(version, minimum);
  return { read, list, coursePath, supportsLeVersion };
}

// Keep the existing service-account token exchange and request safeguards.
function createBrightspaceGet({ http, oauth, baseUrl, retries = 0, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  return async function get(path) {
    const url = new URL(path, baseUrl);
    if (url.origin !== new URL(baseUrl).origin || url.protocol !== 'https:') {
      throw new Error('API URL must belong to the configured Brightspace HTTPS origin');
    }
    let token;
    try { token = await oauth.getAccessToken(); }
    catch { throw new ApiReadError(401, true); }
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await http({
          timeout: 15000, maxRedirects: 0, method: 'GET', url: url.href,
          headers: { Authorization: `Bearer ${token}` }
        });
        return response.data;
      } catch (error) {
        const status = error.response?.status;
        if (attempt >= Math.min(retries, 2) || !(status == null || status === 429 || status >= 500)) throw error;
        const retryAfter = error.response?.headers?.['retry-after'];
        const wait = retryAfter == null ? 500 * 2 ** attempt + Math.floor(Math.random()*200)
          : /^\d+(\.\d+)?$/.test(String(retryAfter)) ? Number(retryAfter)*1000 : Date.parse(retryAfter)-Date.now();
        // Stop instead of retrying earlier than a long Retry-After asks us to.
        if (!Number.isFinite(wait) || wait > 5000) throw error;
        await delay(Math.max(0, wait));
      }
    }
  };
}

// Debug data is separate from the domain contract and omits known secrets/PII.
function redactDiagnostic(value) {
  if (Array.isArray(value)) return value.map(redactDiagnostic);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /password|token|secret|assertion|private.?key|authorization|notificationemail|userinfo/i.test(key)
      ? '[REDACTED]' : redactDiagnostic(item)]));
}
module.exports = { createBrightspaceClient, createBrightspaceGet };

Object.assign(module.exports, { MINIMUM_LE_VERSION, atLeast, validateLeRoot, ApiReadError, apiWarning });

// Deliberately limited to Assignment detail PUTs; diagnostics still use GET only.
function createAssignmentPut(options) { return createActivityPut({ ...options, type: 'assignment' }); }
function createActivityPut({ http, oauth, leRoot, type }) {
  const routes = {
    assignment: /^\/[1-9]\d*\/dropbox\/folders\/[1-9]\d*$/,
    quiz: /^\/[1-9]\d*\/quizzes\/[1-9]\d*$/,
    discussionTopic: /^\/[1-9]\d*\/discussions\/forums\/[1-9]\d*\/topics\/[1-9]\d*$/
  };
  if (!Object.hasOwn(routes, type)) throw new Error('Unsupported activity type');
  validateLeRoot(leRoot);
  const root = new URL(leRoot);
  if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash) throw new Error('Invalid API root');
  return async (path, data) => {
    const url = new URL(path);
    const suffix = url.pathname.slice(root.pathname.length);
    if (url.origin !== root.origin || url.username || url.password || url.search || url.hash ||
        !url.pathname.startsWith(root.pathname) || !routes[type].test(suffix)) {
      throw new Error('Only configured native activity detail URLs can be updated');
    }
    let token;
    try { token = await oauth.getAccessToken(); }
    catch { throw new ApiReadError(401, true); }
    try {
      const response = await http({ method: 'PUT', url: url.href, data, timeout: 15000, maxRedirects: 0,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
      return response.data;
    } catch (error) {
      const safe = new Error('Activity API update failed');
      safe.status = Number.isInteger(error.response?.status) ? error.response.status : null;
      if (safe.status === 400) safe.validation = validationDetails(error.response?.data, data, token);
      throw safe;
    }
  };
}
module.exports.createAssignmentPut = createAssignmentPut;

// Local configuration check; Brightspace still enforces granted scopes and user permissions.
// Resource-group names must match: core:*:* is not treated as a universal grant.
function hasScope(scopes, required) {
  if (typeof scopes !== 'string' || typeof required !== 'string') return false;
  const target = required.split(':');
  if (target.length !== 3 || target.some(part => !/^[A-Za-z][A-Za-z0-9]*$/.test(part))) return false;
  return scopes.trim().split(/\s+/).some(scope => {
    const parts = scope.split(':');
    if (parts.length !== 3 || parts[0] !== target[0]) return false;
    if (parts[1] !== '*' && parts[1] !== target[1]) return false;
    if (parts[2] === '*') return true;
    const actions = parts[2].split(',');
    return actions.every(action => /^[A-Za-z][A-Za-z0-9]*$/.test(action)) && actions.includes(target[2]);
  });
}
module.exports.hasScope = hasScope;

module.exports.createActivityPut = createActivityPut;

// Expose only selected validation fields, never Axios config/headers or raw payloads.
function validationDetails(body, payload, token) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const secrets = [token];
  function collect(value, sensitive = false) {
    if (typeof value === 'string' && sensitive && value) secrets.push(value);
    else if (value && typeof value === 'object') for (const [key,item] of Object.entries(value)) {
      collect(item, sensitive || /password|token|secret|assertion|email|instructions|description|header|footer/i.test(key));
    }
  }
  collect(payload);
  const clean = value => {
    let text = String(value);
    for (const secret of secrets.filter(s => typeof s === 'string' && s.length).sort((a,b)=>b.length-a.length)) text=text.split(secret).join('[REDACTED]');
    return text.replace(/Bearer\s+[^\s"<>]+/gi,'Bearer [REDACTED]')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,'[REDACTED EMAIL]')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[REDACTED TOKEN]')
      .replace(/[\x00-\x1f]/g,' ').slice(0,500);
  };
  const messages=[];
  const read = object => {
    if (!object || typeof object !== 'object') return;
    for (const key of ['Message','message','Detail','detail','Title','title','ErrorCode','errorCode']) {
      if (typeof object[key] === 'string' || typeof object[key] === 'number') messages.push(clean(object[key]));
    }
  };
  read(body);
  for (const key of ['Errors','errors']) {
    const errors=body[key];
    if (Array.isArray(errors)) for (const error of errors.slice(0,10)) {
      if (typeof error === 'string') messages.push(clean(error)); else read(error);
    }
  }
  return [...new Set(messages)].filter(Boolean).slice(0,10);
}
