'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const inventory=require('../src/apiHealth/endpoints.json').endpoints;
const view=require('../src/apiHealth/view');
const {assess}=require('../src/apiHealth/assessment');
const {createApiHealthRoutes}=require('../src/apiHealth/routes');
const {workspace,page}=require('../src/ui/page');
const {translate}=require('../src/ui/i18n');

function sampleAssessment({status='healthy',version='1.90',failure=false}={}){
 const components={lp:{configuredVersion:version,latestSupportedVersion:'1.99',supported:true,lifecycleStatus:'supported',status,findings:[]},le:{configuredVersion:'1.90',latestSupportedVersion:'1.99',supported:true,lifecycleStatus:'supported',status,findings:[]}};
 return {checkedAt:'2026-10-11T10:00:00.000Z',configured:{lp:version,le:'1.90'},latestTenantSupported:{lp:'1.99',le:'1.99'},status,components,
  endpoints:inventory.map(endpoint=>({endpointId:endpoint.id,component:endpoint.component,versionHealth:endpoint.component==='external'?'not_applicable':'healthy',contractVerification:endpoint.contractVerification?.status||'not_verified',configuredVersion:version,minimumVersion:endpoint.minimumVersion||null,tools:endpoint.features,evidence:(endpoint.docs||[]).map(url=>({url}))}))};
}
const trustedMinimums={lp:[{minimum:'1.53',endpointId:'lp-versions',tool:'API Version Health Check'}],le:[{minimum:'1.90',endpointId:'le-assignment-list',tool:'Date Manager'}]};

test('API health navigation is fifth and Creator remains the default',()=>{
 const html=workspace({creation:'create',copy:'copy',dates:'dates',replication:'deploy',apiHealth:'health',history:'history'});
 const ids=[...html.matchAll(/data-section="([^"]+)"/g)].map(item=>item[1]);
 assert.deepEqual(ids,['creation','copy','dates','replication','apiHealth','history']);
 assert.match(html,/data-section="creation" aria-current="page"/);
 assert.match(page('<h1>Health</h1>',{ltik:'session'}),/name="section" value="apiHealth"/);
});

test('health page renders a two-card dashboard with versions together and collapsed table details',()=>{
 const assessment=sampleAssessment();
 const verifiedIds=['lp-orgstructure-list','lp-orgstructure-detail','lp-versions','le-versions','versions-check'];
 const stateById=new Map(verifiedIds.map((id,index)=>[id,['healthy','update_available','at_risk','critical','unknown'][index]]));
 assessment.endpoints=assessment.endpoints.map(row=>({...row,versionHealth:stateById.get(row.endpointId)||row.versionHealth}));
 assessment.components.lp.findings=[{code:'minimum_not_met',status:'critical',endpointId:'lp-versions',message:'Configured version is below the application minimum.'}];
 const html=view.render({state:'success',assessment,lastSuccessfulAt:assessment.checkedAt},{inventory,minimums:trustedMinimums,checkTicket:'signed',ltik:'lti-session'});
 for(const label of ['Learning Platform (LP)','Learning Environment (LE)','1.90','1.99','Healthy','Update Available','At Risk','Critical','Unknown','Not Applicable','Not Verified','Version Health','Contract Verification','Run Health Check','inventoried endpoints','Monitor Brightspace API compatibility.'])assert.ok(html.includes(label),label);
 assert.match(html,/action="\/api-health\/check"/);assert.match(html,/name="ticket" value="signed"/);assert.match(html,/data-api-health-content/);
 assert.doesNotMatch(html,/<span class="eyebrow">/);assert.match(html,/<section class="api-dashboard" aria-label="API health dashboard">/);
 assert.match(html,/<article class="panel api-dashboard-card api-version-dashboard"><h2>LP\/LE versions<\/h2>/);assert.equal((html.match(/class="api-version-component"/g)||[]).length,2);
 assert.doesNotMatch(html,/Additional version information|Tenant API support|Configured version source|D2L lifecycle status/);
 assert.match(html,/<details class="panel api-endpoint-disclosure"><summary>Endpoint details<\/summary>/);assert.doesNotMatch(html,/<details class="panel api-endpoint-disclosure" open/);
 assert.doesNotMatch(html,/About this assessment|api-about/);
 assert.match(html,/<span class="api-endpoint-warning critical">Critical risk<\/span>/);assert.match(html,/A critical API version risk needs attention\./);
 assert.match(html,/11 Oct 2026.*10:00 UTC/);assert.doesNotMatch(html,/>2026-10-11T10:00:00/);
 assert.match(html,/<span class="api-status critical">Critical<\/span>/);
});

test('unverified endpoint contracts do not override supported version health',()=>{
 const assessment=sampleAssessment();
 const html=view.render({state:'success',assessment},{inventory,minimums:{}});
 const rows=view.buildRows(assessment,inventory);
 assert.equal(rows.find(row=>row.endpoint.id==='lp-reoffered-courses').status,'healthy');
 assert.equal(rows.find(row=>row.endpoint.id==='lp-reoffered-courses').contractVerification,'not_verified');
 assert.match(html,/Contract review incomplete/);
 assert.match(html,/13 contracts Verified · 16 Not Verified · 1 Not Applicable/);
});

test('endpoint summaries use the assessment engine classifications and include external Not Applicable',()=>{
 const configured={lp:{version:'1.60',source:'environment'},le:{version:'1.99',source:'environment'}};
 const checks={components:{lp:{supported:true,latestVersion:'1.65'},le:{supported:true,latestVersion:'1.99'}}};
 const result=assess({configured,checks,endpoints:inventory,lifecycle:require('../src/apiHealth/lifecycle.json'),minimums:trustedMinimums,checkedAt:'2026-10-11T10:00:00Z'});
 const counts=result.endpoints.reduce((acc,row)=>(acc[row.versionHealth]=(acc[row.versionHealth]||0)+1,acc),{});
 assert.deepEqual(result.summary,counts);
 assert.equal(result.endpoints.find(row=>row.endpointId==='external-dataset-download').versionHealth,'not_applicable');
 assert.equal(result.endpoints.find(row=>row.endpointId==='lp-courses-detail-get').contractVerification,'verified');
 const html=view.render({state:'success',assessment:result},{inventory,minimums:trustedMinimums});
 const displayedCounts=[...html.matchAll(/class="api-health-count ([^"]+)"><strong>(\d+)<\/strong><span>([^<]+)<\/span>/g)].map(match=>[match[1],Number(match[2]),match[3]]);
 for(const key of ['healthy','update_available','at_risk','critical','unknown'])assert.ok(displayedCounts.some(([shown,count,label])=>shown===key&&count===(counts[key]||0)&&label===view.STATUS[key]),`${key} summary count`);
 assert.match(html,/30 inventoried endpoints · 1 Not Applicable/);
});

test('critical verified application minimum risks produce a red sidebar indicator and tool warning',()=>{
 const assessment=sampleAssessment({version:'1.80',status:'critical'});
 assessment.components.le.findings=[{code:'minimum_not_met',status:'critical',endpointId:'le-assignment-list',message:'Configured version is below the application minimum.'}];
 const row=assessment.endpoints.find(row=>row.endpointId==='le-assignment-list');row.versionHealth='critical';row.finding='Configured version is below the application minimum.';
 const result={state:'success',assessment};
 const warning=view.toolWarning(result,{inventory,minimums:trustedMinimums},'Date Manager');
 assert.match(warning,/Verified critical API risk/);assert.match(warning,/href="#apiHealth"/);
 const workspaceHtml=workspace({apiHealth:'health',apiHealthRisk:'critical'});
 assert.match(workspaceHtml,/api-risk-dot critical/);
 assert.doesNotMatch(view.toolWarning({state:'success',assessment:sampleAssessment()},{inventory,minimums:trustedMinimums},'Date Manager'),/d2l-alert/);
});

test('stale and failed checks keep last successful result visible but mark health Unknown',()=>{
 const assessment=sampleAssessment();
 const html=view.render({state:'failed_since_success',assessment:{...assessment,status:'unknown',stale:true},lastSuccessfulAt:assessment.checkedAt},{inventory,minimums:{}});
 assert.match(html,/result is marked Unknown/);assert.match(html,/result is stale because a newer check failed/);assert.match(html,/api-status unknown/);assert.doesNotMatch(html,/api-status healthy/);assert.match(html,/<strong>29<\/strong><span>Unknown<\/span>/);assert.match(html,/30 inventoried endpoints · 1 Not Applicable/);
 const unavailable=view.render({state:'unavailable',assessment:null},{inventory,minimums:{},versions:{lp:{version:'1.53'},le:{version:'1.97'}}});
 assert.match(unavailable,/<p class="api-configured-version">1\.53<\/p>/);assert.match(unavailable,/<p class="api-configured-version">1\.97<\/p>/);assert.match(unavailable,/No successful assessment is available yet/);
});

test('health rendering escapes runtime and endpoint values',()=>{
 const assessment=sampleAssessment({version:'<script>alert(1)</script>'});
 const rows=inventory.map(endpoint=>({...endpoint}));rows[0]={...rows[0],pattern:'</code><script>bad()</script>'};
 const html=view.render({state:'success',assessment},{inventory:rows,minimums:{}});
 assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.match(html,/&lt;\/code&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
});

test('health labels and summary classifications translate in all supported languages',()=>{
 assert.equal(translate('Version Health','en'),'Version Health');
 assert.equal(translate('Version Health','pt-BR'),'Integridade da versão');
 assert.equal(translate('Contract Verification','es-419'),'Verificación del contrato');
 assert.equal(translate('Not Verified','pt-BR'),'Não verificado');
 assert.equal(translate('25 inventoried endpoints · 7 contracts Verified · 17 Not Verified · 1 Not Applicable','es-419'),'25 endpoints inventariados · 7 contratos verificados · 17 sin verificar · 1 no aplican');
 assert.equal(translate('Monitor Brightspace API compatibility.','pt-BR'),'Monitorar a compatibilidade da API Brightspace.');
 assert.equal(translate('Assignment list','es-419'),'Lista de tareas');
 assert.equal(translate('LP/LE versions','es-419'),'Versiones LP/LE');
 assert.equal(translate('Last successful check','pt-BR'),'Última verificação bem-sucedida');
 assert.equal(translate('25 inventoried endpoints · 1 Not Applicable','pt-BR'),'25 endpoints inventariados · 1 não aplicáveis');
});

test('collapsed endpoint details preserve the full previous table and technical information',()=>{
 const assessment=sampleAssessment();
 const row=assessment.endpoints.find(item=>item.endpointId==='lp-orgstructure-list');row.finding='Version risk detail';row.versionHealth='critical';
 const html=view.render({state:'success',assessment},{inventory,minimums:trustedMinimums});
 for(const field of ['API component','HTTP method','Endpoint pattern','Configured version','Minimum required version','Version Health','Contract Verification','Affected tools','Risk explanation and recommended action','Official D2L documentation'])assert.ok(html.includes(`<th>${field}</th>`),field);
 for(const field of ['Query: exactOrgUnitCode (when code lookup)','Response: paged org-structure records; consumed fields Identifier, Code, Name, Type','Application minimum: 1.53 for Source Course Deployer; 1.60 for Source Course Creator','Review the verified minimum or incompatibility and plan a tested correction.'])assert.ok(html.includes(field),field);
 assert.match(html,/https:\/\/docs\.valence\.desire2learn\.com\/res\/orgunit\.html/);
 assert.match(html,/role="alert"/);
 assert.match(html,/<details class="panel api-endpoint-disclosure"><summary>Endpoint details<\/summary><div class="api-endpoint-disclosure-body"><div class="table-scroll api-health-table" tabindex="0" role="region"/);
 assert.match(html,/<td>LP<\/td><td>GET<\/td><td><code>\/d2l\/api\/lp\/\{LP\}\/orgstructure\/<\/code>/);
 const styles=fs.readFileSync(require.resolve('../src/ui/app.css'),'utf8');assert.match(styles,/\.api-dashboard\{display:grid;grid-template-columns:repeat\(2/);assert.match(styles,/@media\(max-width:760px\)\{\.api-dashboard\{grid-template-columns:1fr\}/);assert.match(styles,/\.api-health-table\{overflow:auto/);assert.match(styles,/\.api-endpoint-disclosure\[open\]>summary::after/);
});

test('manual check route is LTI-bound, signed, cooldown protected, and returns refreshed assessment',async()=>{
 let now=1000,calls=0;const assessment=sampleAssessment();
 const service={getLatest:async()=>({state:'success',assessment,lastSuccessfulAt:assessment.checkedAt}),checkNow:async()=>{calls++;return {state:'success'};}};
 const routes=createApiHealthRoutes({service,view,secret:'test-secret',deploymentId:'deployment',inventory,minimums:trustedMinimums,now:()=>now,cooldownMs:300000});
 const res={locals:{ltik:'session-token',token:{user:'operator',deploymentId:'deployment'}},headers:{},set(key,value){this.headers[key]=value;return this;},status(code){this.code=code;return this;},json(value){this.body=value;return this;},send(value){this.body=value;return this;}};
 const req={body:{ticket:routes.ticket(res),ltik:'session-token'}};
 await routes.check(req,res);assert.equal(res.code,200);assert.equal(res.body.state,'success');assert.match(res.body.html,/Health check completed/);assert.equal(calls,1);
 await routes.check(req,res);assert.equal(res.code,429);assert.equal(res.body.state,'cooldown');assert.equal(calls,1);
 now+=300001;res.locals.token.deploymentId='other';await routes.check(req,res);assert.equal(res.code,403);assert.equal(calls,1);
});

test('manual check supports a regular HTML form submission when JavaScript is unavailable',async()=>{
 const assessment=sampleAssessment(),service={getLatest:async()=>({state:'success',assessment}),checkNow:async()=>({state:'success'})};
 const routes=createApiHealthRoutes({service,view,secret:'test-secret',deploymentId:'deployment',inventory,minimums:trustedMinimums,now:()=>1_800_000_000_000});
 const res={locals:{ltik:'session-token',token:{user:'operator',deploymentId:'deployment'}},set(){return this;},status(code){this.code=code;return this;},json(value){this.body=value;return this;},send(value){this.body=value;return this;}};
 await routes.check({body:{ticket:routes.ticket(res)},get:name=>name==='accept'?'text/html':''},res);
 assert.equal(res.code,200);assert.match(res.body,/data-api-health-content/);assert.doesNotMatch(res.body,/"state":"success"/);
});
