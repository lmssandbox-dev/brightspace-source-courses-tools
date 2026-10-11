'use strict';
const {escape}=require('../ui/page');
const {compare}=require('./assessment');

const STATUS={healthy:'Healthy',update_available:'Update Available',at_risk:'At Risk',critical:'Critical',unknown:'Unknown'};
const VERSION_DOC='https://docs.valence.desire2learn.com/basic/version.html';
function componentStatus(row){return row?.status||'unknown';}
function currentStatus(result){return result?.assessment?.status||'unknown';}
function buildRows(assessment,inventory,minimums){
 const components=assessment?.components||{},endpointResults=new Map((assessment?.endpoints||[]).map(row=>[row.endpointId,row]));
 const minimumFindings=Object.values(components).flatMap(component=>component.findings||[]).filter(f=>f.code==='minimum_not_met');
 return inventory.map(endpoint=>{
  const result=endpointResults.get(endpoint.id),component=components[endpoint.component],finding=minimumFindings.find(f=>f.endpointId===endpoint.id);
  const minimum=(minimums[endpoint.component]||[]).find(item=>item.endpointId===endpoint.id);
  const componentCritical=(component?.findings||[]).some(item=>item.status==='critical'&&item.code!=='minimum_not_met');
  let status=result?.status||'unknown', explanation='';
  if(status==='critical'&&!finding&&!componentCritical){status=component?.supported===true&&component?.lifecycleStatus==='supported'?(component.latestSupportedVersion&&component.configuredVersion&&compare(component.latestSupportedVersion,component.configuredVersion)>0?'update_available':'healthy'):'unknown';}
  if(finding){status='critical';explanation=finding.message;}
  else if(componentCritical||componentStatus(component)==='at_risk'||componentStatus(component)==='update_available'){status=componentCritical?'critical':component.status;explanation=(component.findings||[]).filter(item=>item.code!=='minimum_not_met').map(item=>item.message).filter(Boolean).join(' ');}
  const contractVerified=String(endpoint.contractEvidence||'').startsWith('Official D2L')&&Boolean(endpoint.verifiedAt);
  if(!finding&&!componentCritical&&componentStatus(component)!=='at_risk'&&(!contractVerified||component?.lifecycleStatus==='unknown'||component?.lifecycleStatus==='unavailable'||component?.lifecycleStatus==='stale')){
   status='unknown';
   explanation=!contractVerified?'Endpoint request and response contract has not been verified against official D2L documentation.':'D2L lifecycle evidence is unavailable, stale, or unverified.';
  }
  if(endpoint.component==='external'){status='unknown';explanation='This dataset-provided download URL is not a versioned Valence API route.';}
  if(!explanation)explanation=status==='healthy'?'Tenant support, lifecycle evidence, and the documented endpoint contract are verified.':status==='update_available'?'A newer version is supported by the tenant; the configured version remains supported.':status==='at_risk'?'The configured API version is in a documented deprecated lifecycle range.':status==='critical'?'The configured version does not meet an application requirement.':'Endpoint compatibility is not fully verified.';
  const actions=status==='critical'?'Review the application minimum and plan a tested configuration correction.':status==='at_risk'?'Plan and test a migration away from the deprecated version.':status==='update_available'?'Review the newer tenant-supported version and test it before changing configuration.':status==='unknown'?'Review the linked D2L documentation and verify this endpoint before treating it as compatible.':'No version change is indicated by this assessment.';
  return {endpoint,result,component,minimum,status,explanation,actions};
 });
}
function toolWarning(result,{inventory,minimums},tool){
 if(result?.state!=='success'||result?.assessment?.stale)return '';
 const risks=buildRows(result?.assessment,inventory||[],minimums||{}).filter(row=>row.status==='critical'&&(row.minimum||(row.component?.findings||[]).some(f=>f.code==='unsupported'||f.code==='obsolete'||f.code==='eol'))&&(row.endpoint.features||[]).includes(tool));
 if(!risks.length)return '';
 return `<d2l-alert type="warning"><strong>Verified critical API risk</strong>${risks.map(row=>`<p><strong>${escape(row.endpoint.component.toUpperCase())} · ${escape(row.endpoint.pattern)}</strong>: ${escape(row.explanation)}</p>`).join('')}<a href="#apiHealth" data-section="apiHealth">Review API Version Health Check</a></d2l-alert>`;
}
function renderComponent(code,row,versions={},stale=false){
 const label=code==='lp'?'Learning Platform (LP)':'Learning Environment (LE)';
 const supported=stale?'Unknown':row?.supported===true?'Supported':row?.supported===false?'Not supported':'Unknown';
 const configured=versions?.[code]?.version||row?.configuredVersion||'Not configured';
 const latest=row?.latestSupportedVersion||'Unavailable';
 const lifecycle=row?.lifecycleStatus||'unknown';
 return `<article class="api-version-card"><h3>${label}</h3><dl><div><dt>Configured runtime version</dt><dd>${escape(configured)}</dd></div><div><dt>Latest version supported by tenant</dt><dd>${escape(stale?'Unavailable':latest)}</dd></div><div><dt>Tenant API support</dt><dd>${supported}</dd></div><div><dt>D2L lifecycle status</dt><dd>${escape(stale?'unknown':lifecycle)}</dd></div><div><dt>Application assessment</dt><dd>${escape(stale?'Unknown':STATUS[componentStatus(row)]||'Unknown')}</dd></div></dl></article>`;
}
function render(result,{inventory,minimums,versions,checkTicket='',ltik='',checkState=null}={}){
 const assessment=result?.assessment||null,stale=result?.state==='stale'||result?.state==='failed_since_success'||Boolean(assessment?.stale),rows=buildRows(assessment,inventory||[],minimums||{});
 if(stale)for(const row of rows){row.status='unknown';row.explanation='The last successful endpoint result is shown for reference; current endpoint health is Unknown.';row.actions='Run a fresh check to update this status.';}
 const counts=Object.fromEntries(Object.keys(STATUS).map(key=>[key,rows.filter(row=>row.status===key).length]));
 const status=currentStatus(result),last=result?.lastSuccessfulAt||assessment?.checkedAt||null;
 const alert=stale?`<d2l-alert type="warning">The latest check did not complete successfully. This result is marked Unknown; the previous successful assessment is shown below as a reference.</d2l-alert>`:result?.state==='unavailable'?`<d2l-alert type="default">No successful assessment is available yet. Endpoint statuses remain Unknown until a check completes.</d2l-alert>`:'';
 const checkMessage=checkState==='running'?'<p class="api-check-feedback" role="status">Health check running. This can take up to 30 seconds.</p>':checkState==='failed'?'<p class="api-check-feedback" role="status">The health check failed. The last successful result is shown as stale.</p>':checkState==='success'?'<p class="api-check-feedback" role="status">Health check completed. Results are up to date.</p>':checkState==='cooldown'?'<p class="api-check-feedback" role="status">A recent health check was already requested. Showing the latest saved result.</p>':'';
 const summary=Object.entries(STATUS).map(([key,label])=>`<div><strong>${counts[key]}</strong><span>${label}</span></div>`).join('');
 const endpointRows=rows.map(({endpoint,result:item,minimum,status:rowStatus,explanation,actions})=>{
  const configured=versions?.[endpoint.component]?.version||item?.configuredVersion||assessment?.configured?.[endpoint.component]||'—';
  const min=minimum?.minimum||item?.minimumVersion||'Not verified';
  const docs=(endpoint.docs||[]).map(url=>`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">D2L documentation</a>`).join('<br>')||'Not available';
  return `<tr><td>${escape(endpoint.component.toUpperCase())}</td><td>${escape(endpoint.method)}</td><td><code>${escape(endpoint.pattern)}</code></td><td>${escape(configured)}</td><td>${escape(min)}</td><td><span class="api-status ${escape(rowStatus)}">${escape(STATUS[rowStatus]||STATUS.unknown)}</span></td><td>${(endpoint.features||[]).map(feature=>`<span>${escape(feature)}</span>`).join(', ')||'—'}</td><td>${escape(explanation)}<small>${escape(actions)}</small></td><td>${docs}</td></tr>`;
 }).join('');
 const rowsByRisk=rows.filter(row=>row.status==='critical'&&row.minimum);
 return `<div data-api-health-content><div class="section-heading"><div><span class="eyebrow">API Version Health Check</span><h1>API Version Health Check</h1><p>Review tenant API version support, application minimums, D2L lifecycle evidence and endpoint contract limitations.</p></div><span class="api-status ${escape(status)}">${escape(STATUS[status]||STATUS.unknown)}</span></div>
 ${alert}<section class="panel api-health-header"><div><h2>Current assessment</h2><p><strong>Last successful check:</strong> ${escape(last?new Date(last).toISOString():'Not available')}</p><p><strong>Assessment status:</strong> <span class="api-status ${escape(status)}">${escape(STATUS[status]||STATUS.unknown)}</span></p>${stale?'<p class="muted">The result is stale because a newer check failed or the saved assessment exceeded its freshness window.</p>':''}</div><form method="post" action="/api-health/check" data-api-health-check><input type="hidden" name="ltik" value="${escape(ltik)}"><input type="hidden" name="ticket" value="${escape(checkTicket)}"><button type="submit" class="primary">Run Health Check</button></form></section>
 ${checkMessage}<section><div class="section-heading"><div><h2>Configured Versions</h2><p>Tenant support, application compatibility and D2L lifecycle are assessed separately.</p></div></div><div class="api-version-grid">${renderComponent('lp',assessment?.components?.lp,versions,stale)}${renderComponent('le',assessment?.components?.le,versions,stale)}</div></section>
 <section><div class="section-heading"><div><h2>Health Summary</h2><p>${rows.length} inventoried endpoints</p></div></div><div class="api-health-metrics">${summary}</div></section>
 ${rowsByRisk.length?`<section class="panel warning-confirmation"><h2>Verified application minimum risks</h2>${rowsByRisk.map(row=>`<p><strong>${escape(row.endpoint.component.toUpperCase())} · ${escape(row.endpoint.pattern)}</strong> — ${escape(row.explanation)}</p>`).join('')}</section>`:''}
 <section><div class="section-heading"><div><h2>Endpoint Details</h2><p>Unknown means the available evidence does not establish endpoint compatibility.</p></div></div><div class="table-scroll api-health-table" tabindex="0" role="region" aria-label="API endpoint health details"><table><thead><tr><th>API component</th><th>HTTP method</th><th>Endpoint pattern</th><th>Configured version</th><th>Minimum required version</th><th>Health status</th><th>Affected tools</th><th>Risk explanation and recommended action</th><th>Official D2L documentation</th></tr></thead><tbody>${endpointRows}</tbody></table></div></section>
 <section class="panel api-limitations"><h2>Assessment limitations</h2><p>Tenant API support confirms whether the configured component version is supported. It does not verify route permissions, payloads, endpoint responses, or feature behavior.</p><p>D2L lifecycle status comes from the checked-in lifecycle evidence and can become stale. Endpoint contract status is Unknown unless official contract evidence is recorded in the inventory.</p><p>Latest tenant version: LP ${escape(assessment?.latestTenantSupported?.lp||'Unavailable')} · LE ${escape(assessment?.latestTenantSupported?.le||'Unavailable')} · <a href="${VERSION_DOC}" target="_blank" rel="noopener noreferrer">D2L API versioning guidance</a></p></section></div>`;
}
module.exports={render,buildRows,toolWarning,STATUS};
