'use strict';
const {escape}=require('../ui/page');

const STATUS={healthy:'Healthy',update_available:'Update Available',at_risk:'At Risk',critical:'Critical',unknown:'Unknown',not_applicable:'Not Applicable'};
const CONTRACT_STATUS={verified:'Verified',not_verified:'Not Verified',not_applicable:'Not Applicable'};
const VERSION_DOC='https://docs.valence.desire2learn.com/basic/version.html';
function componentStatus(row){return row?.status||'unknown';}
function currentStatus(result){return result?.assessment?.status||'unknown';}
function buildRows(assessment,inventory){
 const endpointResults=new Map((assessment?.endpoints||[]).map(row=>[row.endpointId,row]));
 return inventory.map(endpoint=>{
  const result=endpointResults.get(endpoint.id),status=result?.versionHealth||(endpoint.component==='external'?'not_applicable':'unknown');
  const contractVerification=result?.contractVerification||endpoint.contractVerification?.status||'not_verified';
  const finding=result?.finding||'';
  const explanation=finding||(contractVerification==='not_verified'?'Contract review incomplete. Version support is assessed independently.':'');
  const actions=status==='critical'?'Review the verified minimum or incompatibility and plan a tested correction.':status==='at_risk'?'Plan and test a migration away from the documented deprecated version.':status==='update_available'?'Review the newer tenant-supported version and test before changing configuration.':status==='unknown'?'Refresh missing version or lifecycle evidence before treating this endpoint as compatible.':status==='not_applicable'?'No Valence API version assessment applies to this external URL.':'No version change is indicated by this assessment.';
  return {endpoint,result,status,contractVerification,explanation,actions};
 });
}
function toolWarning(result,{inventory},tool){
 if(result?.state!=='success'||result?.assessment?.stale)return '';
 const risks=buildRows(result?.assessment,inventory||[]).filter(row=>row.status==='critical'&&(row.result?.finding||'').length&&(row.endpoint.features||[]).includes(tool));
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
function render(result,{inventory,minimums={},versions,checkTicket='',ltik='',checkState=null}={}){
 const assessment=result?.assessment||null,stale=result?.state==='stale'||result?.state==='failed_since_success'||Boolean(assessment?.stale),rows=buildRows(assessment,inventory||[]);
 if(stale)for(const row of rows){if(row.status!=='not_applicable')row.status='unknown';row.explanation='The last successful endpoint result is shown for reference; current endpoint health is Unknown.';row.actions='Run a fresh check to update this status.';}
 const counts=Object.fromEntries(Object.keys(STATUS).map(key=>[key,rows.filter(row=>row.status===key).length]));
 const contractCounts=Object.fromEntries(Object.keys(CONTRACT_STATUS).map(key=>[key,rows.filter(row=>row.contractVerification===key).length]));
 const status=currentStatus(result),last=result?.lastSuccessfulAt||assessment?.checkedAt||null;
 const alert=stale?`<d2l-alert type="warning">The latest check did not complete successfully. This result is marked Unknown; the previous successful assessment is shown below as a reference.</d2l-alert>`:result?.state==='unavailable'?`<d2l-alert type="default">No successful assessment is available yet. Endpoint statuses remain Unknown until a check completes.</d2l-alert>`:'';
 const checkMessage=checkState==='running'?'<p class="api-check-feedback" role="status">Health check running. This can take up to 30 seconds.</p>':checkState==='failed'?'<p class="api-check-feedback" role="status">The health check failed. The last successful result is shown as stale.</p>':checkState==='success'?'<p class="api-check-feedback" role="status">Health check completed. Results are up to date.</p>':checkState==='cooldown'?'<p class="api-check-feedback" role="status">A recent health check was already requested. Showing the latest saved result.</p>':'';
 const summary=Object.entries(STATUS).map(([key,label])=>`<div><strong>${counts[key]}</strong><span>${label}</span></div>`).join('');
 const endpointRows=rows.map(({endpoint,result:item,status:rowStatus,contractVerification,explanation,actions})=>{
  const configured=versions?.[endpoint.component]?.version||item?.configuredVersion||assessment?.configured?.[endpoint.component]||'—';
  const min=endpoint.component==='external'?'Not Applicable':endpoint.documentedMinimum||minimums[endpoint.component]?.find(value=>value.endpointId===endpoint.id)?.minimum||'Not verified';
  const docs=(endpoint.docs||[]).map(url=>`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">D2L documentation</a>`).join('<br>')||'Not available';
  return `<tr><td>${escape(endpoint.component.toUpperCase())}</td><td>${escape(endpoint.method)}</td><td><code>${escape(endpoint.pattern)}</code></td><td>${escape(configured)}</td><td>${escape(min)}</td><td><span class="api-status ${escape(rowStatus)}">${escape(STATUS[rowStatus]||STATUS.unknown)}</span></td><td><span class="api-contract-status ${escape(contractVerification)}">${escape(CONTRACT_STATUS[contractVerification]||CONTRACT_STATUS.not_verified)}</span></td><td>${(endpoint.features||[]).map(feature=>`<span>${escape(feature)}</span>`).join(', ')||'—'}</td><td>${escape(explanation||'—')}<small>${escape(actions)}</small></td><td>${docs}</td></tr>`;
 }).join('');
 return `<div data-api-health-content><div class="section-heading"><div><span class="eyebrow">API Version Health Check</span><h1>API Version Health Check</h1><p>Review tenant API version support, application minimums, D2L lifecycle evidence and endpoint contract limitations.</p></div></div>
 ${alert}<section class="panel api-health-header"><div><h2>Current assessment</h2><p><strong>Last successful check:</strong> ${escape(last?new Date(last).toISOString():'Not available')}</p><p><strong>Assessment status:</strong> <span class="api-status ${escape(status)}">${escape(STATUS[status]||STATUS.unknown)}</span></p>${stale?'<p class="muted">The result is stale because a newer check failed or the saved assessment exceeded its freshness window.</p>':''}</div><form method="post" action="/api-health/check" data-api-health-check><input type="hidden" name="ltik" value="${escape(ltik)}"><input type="hidden" name="ticket" value="${escape(checkTicket)}"><button type="submit" class="primary">Run Health Check</button></form></section>
 ${checkMessage}<section><div class="section-heading"><div><h2>Configured Versions</h2><p>Tenant support, application compatibility and D2L lifecycle are assessed separately.</p></div></div><div class="api-version-grid">${renderComponent('lp',assessment?.components?.lp,versions,stale)}${renderComponent('le',assessment?.components?.le,versions,stale)}</div></section>
 <section><div class="section-heading"><div><h2>Health Summary</h2><p>${escape('{0} inventoried endpoints · {1} contracts Verified · {2} Not Verified · {3} Not Applicable'.replace('{0}',rows.length).replace('{1}',contractCounts.verified).replace('{2}',contractCounts.not_verified).replace('{3}',contractCounts.not_applicable))}</p></div></div><div class="api-health-metrics">${summary}</div></section>
 <section><div class="section-heading"><div><h2>Endpoint Details</h2><p>Version Health and Contract Verification report separate evidence.</p></div></div><div class="table-scroll api-health-table" tabindex="0" role="region" aria-label="API endpoint health details"><table><thead><tr><th>API component</th><th>HTTP method</th><th>Endpoint pattern</th><th>Configured version</th><th>Minimum required version</th><th>Version Health</th><th>Contract Verification</th><th>Affected tools</th><th>Risk explanation and recommended action</th><th>Official D2L documentation</th></tr></thead><tbody>${endpointRows}</tbody></table></div></section>
 <section class="panel api-limitations"><h2>Assessment limitations</h2><p>Tenant API support confirms whether the configured component version is supported. It does not verify route permissions, payloads, endpoint responses, or feature behavior.</p><p>D2L lifecycle status comes from the checked-in lifecycle evidence and can become stale. Contract Verification records whether the route request and response contract was reviewed against official D2L documentation.</p><p>Latest tenant version: LP ${escape(assessment?.latestTenantSupported?.lp||'Unavailable')} · LE ${escape(assessment?.latestTenantSupported?.le||'Unavailable')} · <a href="${VERSION_DOC}" target="_blank" rel="noopener noreferrer">D2L API versioning guidance</a></p></section></div>`;
}
module.exports={render,buildRows,toolWarning,STATUS,CONTRACT_STATUS};
