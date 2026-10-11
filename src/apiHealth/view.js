'use strict';
const {escape}=require('../ui/page');

const STATUS={healthy:'Healthy',update_available:'Update Available',at_risk:'At Risk',critical:'Critical',unknown:'Unknown',not_applicable:'Not Applicable'};
const CONTRACT_STATUS={verified:'Verified',not_verified:'Not Verified',not_applicable:'Not Applicable'};
const VERSION_DOC='https://docs.valence.desire2learn.com/basic/version.html';
const OPERATIONS={
 'lp-orgstructure-list':'Org structure listing','lp-orgstructure-detail':'Org unit details','lp-courses-detail-get':'Course details','lp-reoffered-courses':'Reoffered courses','lp-course-status-put':'Update course status','lp-source-course-deploy':'Deploy Source Course','lp-source-course-create':'Create Source Course','lp-datasets-bds':'Dataset discovery','lp-versions':'LP version discovery','le-versions':'LE version discovery','versions-check':'Tenant version check','le-assignment-list':'Assignment list','le-assignment-detail-get':'Assignment details','le-assignment-detail-put':'Update assignment','le-quiz-list':'Quiz list','le-quiz-detail-get':'Quiz details','le-quiz-detail-put':'Update quiz','le-discussion-forums':'Discussion forums','le-discussion-topics':'Discussion topics','le-discussion-topic-detail-get':'Discussion topic details','le-discussion-topic-detail-put':'Update discussion topic','le-course-copy-submit':'Submit course copy','le-course-copy-status':'Course copy status','le-ccb-copy-logs':'Copy log retrieval','external-dataset-download':'External dataset download'
};
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
function supportedLabel(row,stale){return stale?'Unknown':row?.supported===true?'Supported':row?.supported===false?'Not supported':'Unknown';}
function renderComponent(code,row,versions={},stale=false,rows=[]){
 const label=code==='lp'?'Learning Platform (LP)':'Learning Environment (LE)';
 const configured=versions?.[code]?.version||row?.configuredVersion||'Not configured';
 const latest=stale?'Unavailable':row?.latestSupportedVersion||'Unavailable';
 const endpointRows=rows.filter(item=>item.endpoint.component===code);
 const health=stale?'unknown':componentStatus(row);
 const warningRisk=stale?'':endpointRows.some(item=>item.status==='critical')?'critical':endpointRows.some(item=>item.status==='at_risk')?'at_risk':'';
 const minimums=(row?.findings||[]).filter(item=>item.message).map(item=>item.message);
 const details=`<details class="api-version-extra"><summary>Additional version information</summary><dl><div><dt>Tenant API support</dt><dd>${supportedLabel(row,stale)}</dd></div><div><dt>D2L lifecycle status</dt><dd>${escape(stale?'unknown':row?.lifecycleStatus||'unknown')}</dd></div><div><dt>Configured version source</dt><dd>${escape(versions?.[code]?.source||'assessment')}</dd></div>${minimums.length?`<div class="api-version-finding"><dt>Assessment findings</dt><dd>${minimums.map(escape).join('<br>')}</dd></div>`:''}</dl></details>`;
 return `<article class="api-version-card"><div class="api-version-card-heading"><h2>${label}</h2><span class="api-status ${escape(health)}">${STATUS[health]||STATUS.unknown}</span></div><p class="api-configured-version">${escape(configured)}</p><p class="api-latest-version"><span>Latest tenant-supported version</span><strong>${escape(latest)}</strong></p>${warningRisk?`<p class="api-version-warning ${warningRisk==='critical'?'critical':''}" role="alert">${warningRisk==='critical'?'A critical API version risk needs attention.':'A deprecated API version is at risk.'}</p>`:''}${details}</article>`;
}
function render(result,{inventory,minimums={},versions,checkTicket='',ltik='',checkState=null}={}){
 const assessment=result?.assessment||null,stale=result?.state==='stale'||result?.state==='failed_since_success'||Boolean(assessment?.stale),rows=buildRows(assessment,inventory||[]);
 if(stale)for(const row of rows){if(row.status!=='not_applicable')row.status='unknown';row.explanation='The last successful endpoint result is shown for reference; current endpoint health is Unknown.';row.actions='Run a fresh check to update this status.';}
 const counts=Object.fromEntries(Object.keys(STATUS).map(key=>[key,rows.filter(row=>row.status===key).length]));
 const contractCounts=Object.fromEntries(Object.keys(CONTRACT_STATUS).map(key=>[key,rows.filter(row=>row.contractVerification===key).length]));
 const last=result?.lastSuccessfulAt||assessment?.checkedAt||null;
 const alert=stale?`<d2l-alert type="warning">The latest check did not complete successfully. This result is marked Unknown; the previous successful assessment is shown below as a reference.</d2l-alert><p class="api-stale-note">The result is stale because a newer check failed or the saved assessment exceeded its freshness window.</p>`:result?.state==='unavailable'?`<d2l-alert type="default">No successful assessment is available yet. Endpoint statuses remain Unknown until a check completes.</d2l-alert>`:'';
 const checkMessage=checkState==='running'?'<p class="api-check-feedback" role="status">Health check running. This can take up to 30 seconds.</p>':checkState==='failed'?'<p class="api-check-feedback" role="status">The health check failed. The last successful result is shown as stale.</p>':checkState==='success'?'<p class="api-check-feedback" role="status">Health check completed. Results are up to date.</p>':checkState==='cooldown'?'<p class="api-check-feedback" role="status">A recent health check was already requested. Showing the latest saved result.</p>':'';
 const summary=Object.entries(STATUS).map(([key,label])=>`<div><strong>${counts[key]}</strong><span>${label}</span></div>`).join('');
 const endpointGroups=['lp','le','external'].map(component=>{
  const group=rows.filter(row=>row.endpoint.component===component);if(!group.length)return '';
  const heading=component==='lp'?'Learning Platform (LP)':component==='le'?'Learning Environment (LE)':'External URLs';
  const endpoints=group.map(({endpoint,result:item,status:rowStatus,contractVerification,explanation,actions})=>{
   const configured=versions?.[endpoint.component]?.version||item?.configuredVersion||assessment?.configured?.[endpoint.component]||'—';
   const min=endpoint.component==='external'?'Not Applicable':endpoint.documentedMinimum||minimums[endpoint.component]?.find(value=>value.endpointId===endpoint.id)?.minimum||'Not verified';
   const docs=(endpoint.docs||[]).map(url=>`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(url)}</a>`).join('<br>')||'Not available';
   const warning=['critical','at_risk'].includes(rowStatus)?`<span class="api-endpoint-warning ${rowStatus==='critical'?'critical':''}">${rowStatus==='critical'?'Critical risk':'At risk'}</span>`:'';
   const contract=CONTRACT_STATUS[contractVerification]||CONTRACT_STATUS.not_verified;
   const contractText=contractVerification==='not_verified'?'Contract review incomplete. Version support is assessed independently.':contract;
   const behavioral=[endpoint.versionBehavior,endpoint.contractEvidence,endpoint.contract?.query&&`Query: ${endpoint.contract.query}`,endpoint.contract?.response&&`Response: ${endpoint.contract.response}`,endpoint.versionSource&&`Version source: ${endpoint.versionSource}`,endpoint.applicationMinimum&&`Application minimum: ${endpoint.applicationMinimum}`].filter(Boolean);
   return `<details class="api-endpoint"><summary><span class="api-endpoint-name">${escape(OPERATIONS[endpoint.id]||endpoint.id)}</span><code>${escape(endpoint.method)} ${escape(endpoint.pattern)}</code><span class="api-status ${escape(rowStatus)}">${escape(STATUS[rowStatus]||STATUS.unknown)}</span>${warning}</summary><div class="api-endpoint-details"><dl><div><dt>Full endpoint path</dt><dd><code>${escape(endpoint.pattern)}</code></dd></div><div><dt>Configured version</dt><dd>${escape(configured)}</dd></div><div><dt>Minimum version</dt><dd>${escape(min)}</dd></div><div><dt>Version Health</dt><dd><span class="api-status ${escape(rowStatus)}">${escape(STATUS[rowStatus]||STATUS.unknown)}</span></dd></div><div><dt>Contract Verification</dt><dd><span class="api-contract-status ${escape(contractVerification)}">${escape(contract)}</span></dd></div><div><dt>Affected tools</dt><dd>${(endpoint.features||[]).map(feature=>`<span class="api-tool-tag">${escape(feature)}</span>`).join(' ')||'—'}</dd></div><div><dt>Risk explanation</dt><dd>${escape(explanation||'—')}</dd></div><div><dt>Recommended action</dt><dd>${escape(actions)}</dd></div><div><dt>Official D2L documentation</dt><dd>${docs}</dd></div>${behavioral.length?`<div><dt>Contract and version notes</dt><dd>${behavioral.map(note=>`<p>${escape(note)}</p>`).join('')}</dd></div>`:''}</dl></div></details>`;
  }).join('');
  return `<section class="api-endpoint-group" aria-labelledby="api-group-${component}"><h3 id="api-group-${component}">${heading}</h3>${endpoints}</section>`;
 }).join('');
 const about=`<details class="panel api-about"><summary>About this assessment</summary><div><p>Tenant API support confirms whether the configured component version is supported. It does not verify route permissions, payloads, endpoint responses, feature behavior, or a user/service user's access.</p><p>Contract Verification records whether the route request and response contract was reviewed against official D2L documentation. An unverified contract does not change Version Health.</p><p>D2L lifecycle status comes from dated, source-controlled lifecycle evidence. That evidence can become stale. A stale or incomplete check marks current endpoint health Unknown while retaining the previous successful result for reference.</p><p>Latest tenant-supported versions: LP ${escape(assessment?.latestTenantSupported?.lp||'Unavailable')} · LE ${escape(assessment?.latestTenantSupported?.le||'Unavailable')} · <a href="${VERSION_DOC}" target="_blank" rel="noopener noreferrer">D2L API versioning guidance</a></p></div></details>`;
 return `<div data-api-health-content><header class="section-heading api-health-title"><div><h1>API Version Health Check</h1><p>Monitor Brightspace API compatibility.</p></div></header>${alert}<section class="panel api-health-header"><p><strong>Last successful check:</strong> ${escape(last?new Date(last).toISOString():'Not available')}</p><form method="post" action="/api-health/check" data-api-health-check><input type="hidden" name="ltik" value="${escape(ltik)}"><input type="hidden" name="ticket" value="${escape(checkTicket)}"><button type="submit" class="primary">Run Health Check</button></form></section>${checkMessage}<section class="api-version-grid" aria-label="Configured platform versions">${renderComponent('lp',assessment?.components?.lp,versions,stale,rows)}${renderComponent('le',assessment?.components?.le,versions,stale,rows)}</section><section class="api-health-summary"><div class="section-heading"><h2>Endpoint health</h2></div><div class="metrics api-health-metrics">${summary}</div><p class="api-contract-counts">${escape('{0} inventoried endpoints · {1} contracts Verified · {2} Not Verified · {3} Not Applicable'.replace('{0}',rows.length).replace('{1}',contractCounts.verified).replace('{2}',contractCounts.not_verified).replace('{3}',contractCounts.not_applicable))}</p></section><section class="api-endpoint-list"><div class="section-heading"><h2>Endpoint details</h2></div>${endpointGroups}</section>${about}</div>`;
}
module.exports={render,buildRows,toolWarning,STATUS,CONTRACT_STATUS};
