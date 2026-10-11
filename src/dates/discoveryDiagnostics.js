'use strict';

const { id } = require('../shared/id');
const { deploymentGuard } = require('../shared/deploymentGuard');
const escapeHtml = value => String(value).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function diagnosticForm(ltik, orgUnitId = '') {
  return `<h1>Bulk Activity Date Manager — Discovery</h1>
    <p>Read-only discovery of Assignments, Quizzes and Discussion Topics.</p>
    <form method="get" action="/diagnostics/activities">
      <input type="hidden" name="ltik" value="${escapeHtml(ltik ?? '')}">
      <label>OrgUnitId <input name="orgUnitId" pattern="[1-9][0-9]*" required value="${escapeHtml(orgUnitId)}"></label>
      <label><input type="checkbox" name="includeUndated" value="1"> Include undated activities</label>
      <label><input type="checkbox" name="raw" value="1"> Include raw API responses</label>
      <label><input type="checkbox" name="format" value="json"> JSON response</label>
      <button type="submit">Read activities</button>
    </form>`;
}

function createDiagnostics({ client, deploymentId, activityForm = () => '', workspace = false }) {
  const authorizeDeployment = deploymentGuard(deploymentId);
  function authorize(token, req, res) {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    // Brightspace controls launch access through its LTI installation.
    // This token must come from ltijs validation, never request parameters.
    return authorizeDeployment(token, req, res);
  }
  return {
    launch(token, req, res) {
      if (!authorize(token, req, res)) return;
      // Do not assume the LTI context ID is a Brightspace OrgUnitId.
      const prefix=workspace?'':diagnosticForm(res.locals.ltik),form=activityForm(res);
      return form&&typeof form.then==='function'?form.then(content=>res.send(prefix+content)):res.send(prefix+form);
    },
    async activities(req, res) {
      if (!authorize(res.locals.token, req, res)) return;
      let orgUnitId;
      try { orgUnitId = id(req.query.orgUnitId); }
      catch { return res.status(400).json({ error: 'orgUnitId must be a positive decimal ID.' }); }
      try {
        const result = await client.discover(orgUnitId, { includeRaw: req.query.raw === '1', includeUndated: req.query.includeUndated === '1' });
        if (req.query.format === 'json') return res.json(result);
        res.send(`${diagnosticForm(res.locals.ltik, orgUnitId)}${await activityForm(res, orgUnitId)}
          <h2>Org Unit</h2><p>${escapeHtml(result.orgUnitId)} — ${result.complete ? 'Complete discovery' : 'Partial discovery'}</p>
          <pre>${escapeHtml(JSON.stringify(result.counts, null, 2))}</pre>
          <h2>Normalized activities (${result.activities.length})</h2>
          <pre>${escapeHtml(JSON.stringify(result.activities, null, 2))}</pre>
          <h2>Warnings</h2><pre>${escapeHtml(JSON.stringify(result.warnings, null, 2))}</pre>
          ${result.raw ? `<h2>Raw API responses</h2><pre>${escapeHtml(JSON.stringify(result.raw, null, 2))}</pre>` : ''}`);
      } catch {
        // Never serialize upstream errors/configs (which may include credentials).
        res.status(502).json({ error: 'Discovery failed; no complete result is available. Check API versions, service-user permissions and scopes, and retry.' });
      }
    }
  };
}

module.exports = { createDiagnostics, diagnosticForm };
