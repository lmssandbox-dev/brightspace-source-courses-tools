'use strict';
const {escape}=require('../ui/page');

const STATUS={healthy:'Healthy',update_available:'Update Available',at_risk:'At Risk',critical:'Critical',unknown:'Unknown',not_applicable:'Not Applicable'};
const CONTRACT_STATUS={verified:'Verified',not_verified:'Not Verified',not_applicable:'Not Applicable'};

function componentStatus(row){return row?.status||'unknown';}
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
function formatCheckTime(value){
 if(!value)return 'Not available';
 const date=new Date(value);
 if(!Number.isFinite(date.getTime()))return 'Not available';
 return new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'UTC',timeZoneName:'short'}).format(date);
}
function renderComponent(code,row,versions={},stale=false,rows=[]){
 const label=code==='lp'?'Learning Platform (LP)':'Learning Environment (LE)';
 const configured=versions?.[code]?.version||row?.configuredVersion||'Not configured';
 const latest=stale?'Unavailable':row?.latestSupportedVersion||'Unavailable';
 const health=stale?'unknown':componentStatus(row);
 const endpointRows=rows.filter(item=>item.endpoint.component===code);
 const warningRisk=stale?'':endpointRows.some(item=>item.status==='critical')?'critical':endpointRows.some(item=>item.status==='at_risk')?'at_risk':'';
 return `<section class="api-version-component"><div class="api-version-card-heading"><h3>${label}</h3><span class="api-status ${escape(health)}">${STATUS[health]||STATUS.unknown}</span></div><p class="api-configured-version">${escape(configured)}</p><p class="api-latest-version"><span>Latest tenant-supported version</span><strong>${escape(latest)}</strong></p>${warningRisk?`<p class="api-version-warning ${warningRisk==='critical'?'critical':''}" role="alert">${warningRisk==='critical'?'A critical API version risk needs attention.':'A deprecated API version is at risk.'}</p>`:''}</section>`;
}
function render(result,{inventory,minimums={},versions,checkTicket='',ltik='',checkState=null}={}){
 const assessment=result?.assessment||null,stale=result?.state==='stale'||result?.state==='failed_since_success'||Boolean(assessment?.stale),rows=buildRows(assessment,inventory||[]);
 if(stale)for(const row of rows){if(row.status!=='not_applicable')row.status='unknown';row.explanation='The last successful endpoint result is shown for reference; current endpoint health is Unknown.';row.actions='Run a fresh check to update this status.';}
 const counts=Object.fromEntries(Object.keys(STATUS).map(key=>[key,rows.filter(row=>row.status===key).length]));
 const last=result?.lastSuccessfulAt||assessment?.checkedAt||null;
 const alert=stale?`<d2l-alert type="warning">The latest check did not complete successfully. This result is marked Unknown; the previous successful assessment is shown below as a reference.</d2l-alert><p class="api-stale-note">The result is stale because a newer check failed or the saved assessment exceeded its freshness window.</p>`:result?.state==='unavailable'?`<d2l-alert type="default">No successful assessment is available yet. Endpoint statuses remain Unknown until a check completes.</d2l-alert>`:'';
 const checkMessage=checkState==='running'?'<p class="api-check-feedback" role="status">Health check running. This can take up to 30 seconds.</p>':checkState==='failed'?'<p class="api-check-feedback" role="status">The health check failed. The last successful result is shown as stale.</p>':checkState==='success'?'<p class="api-check-feedback" role="status">Health check completed. Results are up to date.</p>':checkState==='cooldown'?'<p class="api-check-feedback" role="status">A recent health check was already requested. Showing the latest saved result.</p>':'';
 const statusKeys=['healthy','update_available','at_risk','critical','unknown'];
 const summary=statusKeys.map(key=>`<div class="api-health-count ${key}"><strong>${counts[key]}</strong><span>${STATUS[key]}</span></div>`).join('');
 const contractCounts=Object.fromEntries(Object.keys(CONTRACT_STATUS).map(key=>[key,rows.filter(row=>row.contractVerification===key).length]));
 const endpointRows=rows.map(({endpoint,result:item,status:rowStatus,contractVerification,explanation,actions})=>{
  const configured=versions?.[endpoint.component]?.version||item?.configuredVersion||assessment?.configured?.[endpoint.component]||'—';
  const min=endpoint.component==='external'?'Not Applicable':endpoint.documentedMinimum||minimums[endpoint.component]?.find(value=>value.endpointId===endpoint.id)?.minimum||'Not verified';
  const docUrls=[...(endpoint.docs||[]),...(endpoint.contractVerification?.sources||[]),...(endpoint.contract?.sources||[]),...(item?.evidence||[]).map(evidence=>evidence.url)].filter((url,index,all)=>url&&all.indexOf(url)===index);
  const docs=docUrls.map(url=>`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(url)}</a>`).join('<br>')||'Not available';
  const findings=[explanation,actions].filter(Boolean).map(text=>`<p>${escape(text)}</p>`).join('');
  const contract=CONTRACT_STATUS[contractVerification]||CONTRACT_STATUS.not_verified;
  const contractInfo=[endpoint.contractVerification?.summary,endpoint.contractEvidence].filter(Boolean);
  const behavioral=[endpoint.versionBehavior,endpoint.contract?.query&&`Query: ${endpoint.contract.query}`,endpoint.contract?.response&&`Response: ${endpoint.contract.response}`,endpoint.versionSource&&`Version source: ${endpoint.versionSource}`,endpoint.applicationMinimum&&`Application minimum: ${endpoint.applicationMinimum}`].filter(Boolean);
  const notes=behavioral.map(text=>`<p>${escape(text)}</p>`).join('');
  const tools=(endpoint.features||[]).map(feature=>`<span class="api-tool-tag">${escape(feature)}</span>`).join(' ')||'—';
  const finding=rowStatus==='critical'||rowStatus==='at_risk'?`<span class="api-endpoint-warning ${rowStatus==='critical'?'critical':''}">${rowStatus==='critical'?'Critical risk':'At risk'}</span>`:'';
  return `<tr><td>${escape(endpoint.component.toUpperCase())}</td><td>${escape(endpoint.method)}</td><td><code>${escape(endpoint.pattern)}</code></td><td>${escape(configured)}${versions?.[endpoint.component]?.source?`<small>${escape(versions[endpoint.component].source)}</small>`:''}</td><td>${escape(min)}</td><td><span class="api-status ${escape(rowStatus)}">${escape(STATUS[rowStatus]||STATUS.unknown)}</span>${finding}${item?.finding?`<small>${escape(item.finding)}</small>`:''}</td><td><span class="api-contract-status ${escape(contractVerification)}">${escape(contract)}</span>${contractInfo.map(text=>`<small>${escape(text)}</small>`).join('')}</td><td>${tools}</td><td>${findings}${notes}</td><td>${docs}</td></tr>`;
 }).join('');
 const table=`<div class="table-scroll api-health-table" tabindex="0" role="region" aria-label="API endpoint health details"><table><thead><tr><th>API component</th><th>HTTP method</th><th>Endpoint pattern</th><th>Configured version</th><th>Minimum required version</th><th>Version Health</th><th>Contract Verification</th><th>Affected tools</th><th>Risk explanation and recommended action</th><th>Official D2L documentation</th></tr></thead><tbody>${endpointRows}</tbody></table></div>`;
 const notApplicable=counts.not_applicable||0;
 return `<div data-api-health-content><header class="section-heading api-health-title"><div><h1>API Version Health Check</h1><p>Monitor Brightspace API compatibility.</p></div></header>${alert}<section class="api-dashboard" aria-label="API health dashboard"><article class="panel api-dashboard-card api-endpoint-health"><h2>Endpoint health</h2><div class="api-health-metrics">${summary}</div><p class="api-inventory-count">${escape('{0} inventoried endpoints · {1} Not Applicable'.replace('{0}',rows.length).replace('{1}',notApplicable))}</p>${counts.critical>0?`<p class="api-critical-summary" role="alert">${counts.critical} critical endpoint ${counts.critical===1?'risk requires':'risks require'} attention.</p>`:''}<div class="api-health-action"><div><strong>Last successful check</strong><time datetime="${escape(last||'')}">${escape(formatCheckTime(last))}</time></div><form method="post" action="/api-health/check" data-api-health-check><input type="hidden" name="ltik" value="${escape(ltik)}"><input type="hidden" name="ticket" value="${escape(checkTicket)}"><button type="submit" class="primary">Run Health Check</button></form></div>${checkMessage}</article><article class="panel api-dashboard-card api-version-dashboard"><h2>LP/LE versions</h2>${renderComponent('lp',assessment?.components?.lp,versions,stale,rows)}${renderComponent('le',assessment?.components?.le,versions,stale,rows)}</article></section><section class="api-endpoint-list"><details class="panel api-endpoint-disclosure"><summary>Endpoint details</summary><div class="api-endpoint-disclosure-body">${table}<p class="api-contract-counts">${escape('{0} contracts Verified · {1} Not Verified · {2} Not Applicable'.replace('{0}',contractCounts.verified).replace('{1}',contractCounts.not_verified).replace('{2}',contractCounts.not_applicable))}</p></div></details></section></div>`;
}
module.exports={render,buildRows,toolWarning,STATUS,CONTRACT_STATUS};
