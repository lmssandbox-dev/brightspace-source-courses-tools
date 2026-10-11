'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const inventory=require('../src/apiHealth/endpoints.json').endpoints;
const view=require('../src/apiHealth/view');
const {createApiHealthRoutes}=require('../src/apiHealth/routes');
const {workspace,page}=require('../src/ui/page');

function sampleAssessment({status='healthy',version='1.90',failure=false}={}){
 const components={lp:{configuredVersion:version,latestSupportedVersion:'1.99',supported:true,lifecycleStatus:'supported',status,findings:[]},le:{configuredVersion:'1.90',latestSupportedVersion:'1.99',supported:true,lifecycleStatus:'supported',status,findings:[]}};
 return {checkedAt:'2026-10-11T10:00:00.000Z',configured:{lp:version,le:'1.90'},latestTenantSupported:{lp:'1.99',le:'1.99'},status,components,
  endpoints:inventory.map(endpoint=>({endpointId:endpoint.id,component:endpoint.component,status:'healthy',configuredVersion:version,minimumVersion:null,tools:endpoint.features,evidence:(endpoint.docs||[]).map(url=>({url}))}))};
}
const trustedMinimums={lp:[{minimum:'1.53',endpointId:'lp-versions',tool:'API Version Health Check'}],le:[{minimum:'1.90',endpointId:'le-assignment-list',tool:'Date Manager'}]};

test('API health navigation is fifth and Creator remains the default',()=>{
 const html=workspace({creation:'create',copy:'copy',dates:'dates',replication:'deploy',apiHealth:'health',history:'history'});
 const ids=[...html.matchAll(/data-section="([^"]+)"/g)].map(item=>item[1]);
 assert.deepEqual(ids,['creation','copy','dates','replication','apiHealth','history']);
 assert.match(html,/data-section="creation" aria-current="page"/);
 assert.match(page('<h1>Health</h1>',{ltik:'session'}),/name="section" value="apiHealth"/);
});

test('health page shows configured versions, endpoint inventory, and all five health states',()=>{
 const assessment=sampleAssessment();
 const verifiedIds=['lp-orgstructure-list','lp-orgstructure-detail','lp-versions','le-versions','versions-check'];
 const stateById=new Map(verifiedIds.map((id,index)=>[id,['healthy','update_available','at_risk','critical','unknown'][index]]));
 assessment.endpoints=assessment.endpoints.map(row=>({...row,status:stateById.get(row.endpointId)||'healthy'}));
 assessment.components.lp.findings=[{code:'minimum_not_met',status:'critical',endpointId:'lp-versions',message:'Configured version is below the application minimum.'}];
 const html=view.render({state:'success',assessment,lastSuccessfulAt:assessment.checkedAt},{inventory,minimums:trustedMinimums,checkTicket:'signed',ltik:'lti-session'});
 for(const label of ['Learning Platform (LP)','Learning Environment (LE)','1.90','1.99','Healthy','Update Available','At Risk','Critical','Unknown','Run Health Check','inventoried endpoints'])assert.ok(html.includes(label),label);
 assert.match(html,/action="\/api-health\/check"/);assert.match(html,/name="ticket" value="signed"/);assert.match(html,/data-api-health-content/);
});

test('unverified lifecycle or endpoint contracts are Unknown even with tenant support',()=>{
 const assessment=sampleAssessment();
 const html=view.render({state:'success',assessment},{inventory,minimums:{}});
 const unknownRows=view.buildRows(assessment,inventory,{});
 assert.equal(unknownRows.find(row=>row.endpoint.id==='lp-courses-detail-get').status,'unknown');
 assert.equal(unknownRows.find(row=>row.endpoint.id==='lp-orgstructure-list').status,'healthy');
 assert.match(html,/contract has not been verified against official D2L documentation/);
});

test('critical verified application minimum risks produce a red sidebar indicator and tool warning',()=>{
 const assessment=sampleAssessment({version:'1.80',status:'critical'});
 assessment.components.le.findings=[{code:'minimum_not_met',status:'critical',endpointId:'le-assignment-list',message:'Configured version is below the application minimum.'}];
 assessment.endpoints.find(row=>row.endpointId==='le-assignment-list').status='critical';
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
 assert.match(html,/result is marked Unknown/);assert.match(html,/result is stale because a newer check failed/);assert.match(html,/api-status unknown/);assert.doesNotMatch(html,/api-status healthy/);assert.match(html,/<strong>25<\/strong><span>Unknown<\/span>/);
 const unavailable=view.render({state:'unavailable',assessment:null},{inventory,minimums:{},versions:{lp:{version:'1.53'},le:{version:'1.97'}}});
 assert.match(unavailable,/<dd>1\.53<\/dd>/);assert.match(unavailable,/<dd>1\.97<\/dd>/);assert.match(unavailable,/No successful assessment is available yet/);
});

test('health rendering escapes runtime and endpoint values',()=>{
 const assessment=sampleAssessment({version:'<script>alert(1)</script>'});
 const rows=inventory.map(endpoint=>({...endpoint}));rows[0]={...rows[0],pattern:'</code><script>bad()</script>'};
 const html=view.render({state:'success',assessment},{inventory:rows,minimums:{}});
 assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.match(html,/&lt;\/code&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
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
