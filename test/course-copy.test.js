'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseCopyCsv,selection,COMPONENTS,HEADERS,createCopyJobs}=require('../src/copy/jobs');
const {createCopyClient}=require('../src/copy/client');
const {createCopyView}=require('../src/copy/view');
const {interruptJob,createBulkJobs}=require('../src/shared/jobs');
const csv=rows=>HEADERS.join(',')+'\n'+rows;
const client=extra=>({resolveCode:async code=>({A:'1',B:'2',C:'3'}[code]||Promise.reject(Error('Ambiguous code'))),origin:async id=>({name:'Offering '+id}),destination:async id=>({name:'Destination '+id}),...extra});
const job=rows=>({kind:'courseCopy',rows:parseCopyCsv(csv(rows)),tasks:[],components:null});
test('copy CSV requires four columns and identifiers on both sides; choices are allowlisted',()=>{
 assert.equal(COMPONENTS.length,35);assert.equal(parseCopyCsv(csv('1,,2,')).length,1);
 assert.throws(()=>parseCopyCsv('SourceOrgUnitId,ReplicaOrgUnitId\n1,2'));
 assert.equal(parseCopyCsv(csv(',,,')).at(0).status,'invalid');
 assert.throws(()=>selection('selected',[]));assert.throws(()=>selection('selected',['Other']));assert.throws(()=>selection('bad',[]));
 assert.equal(selection('all',['Other']),null);assert.deepEqual(selection('selected',['Content','Content','Quizzes']),['Content','Quizzes']);
});
test('preview resolves exact aliases, deduplicates, and blocks mismatches, self-copy, conflicts and chains',async()=>{
 const worker=createCopyJobs({client:client()});const good=job('1,,2,\n,A,,B');await worker.plan(good,async()=>{});assert.equal(good.status,'ready');assert.equal(good.tasks.length,1);assert.equal(good.rows[1].status,'duplicate');
 for(const rows of ['1,B,2,','1,,1,','1,,3,\n2,,3,','1,,2,\n2,,3,',',unknown,2,']){const j=job(rows);await worker.plan(j,async()=>{});assert.equal(j.status,'failed');}
});
test('origin must be an offering; destination falls back only on explicit 404',async()=>{
 const c=createCopyClient({leRoot:'https://tenant/d2l/api/le/1.99',sourceClient:{target:async()=>{throw {httpStatus:404};},source:async id=>({name:'source',orgUnitId:id})}});
 await assert.rejects(()=>c.origin('1'));assert.equal((await c.destination('2')).name,'source');
 const forbidden=createCopyClient({leRoot:'https://tenant/d2l/api/le/1.99',sourceClient:{target:async()=>{throw {httpStatus:403};},source:async()=>assert.fail('must not fall back')}});await assert.rejects(()=>forbidden.destination('2'));
 const old=createCopyClient({leRoot:'https://tenant/d2l/api/le/1.96'});await assert.rejects(()=>old.origin('1'),/1.97/);
});
test('native copy uses only POST with selection/null and status GET with token; no reset or activation',async()=>{
 const requests=[],reads=[];let barriers=0;
 const c=createCopyClient({leRoot:'https://tenant/d2l/api/le/1.99',oauth:{getAccessToken:async()=>'secret'},http:async r=>{requests.push(r);return {status:202,data:{JobToken:'token123'}};},api:{read:async url=>{reads.push(url);return {Status:'COMPLETE_WITH_ERRORS'};}}});
 for(const components of [null,['Content','Quizzes']])assert.equal((await c.copy('1','2',components,async()=>{barriers++;})).status,'PENDING');
 assert.equal(barriers,2);assert.equal(requests[0].method,'POST');assert.deepEqual(requests[0].data,{SourceOrgUnitId:1,Components:null,CallbackUrl:null});assert.deepEqual(requests[1].data.Components,['Content','Quizzes']);assert.equal(requests[0].maxRedirects,0);
 assert.equal(await c.check('2','token123'),'COMPLETE_WITH_ERRORS');assert.equal(reads[0],'https://tenant/d2l/api/le/1.99/import/2/copy/token123');
});
test('ambiguous responses and transport failures are uncertain without retry; definite rejections are failed',async()=>{
 for(const response of [null,400,403,429,500]){
  let calls=0;const c=createCopyClient({leRoot:'https://tenant/d2l/api/le/1.99',oauth:{getAccessToken:async()=>'secret'},http:async()=>{calls++;throw {response:{status:response}};}});
  const r=await c.copy('1','2',null,async()=>{});assert.equal(calls,1);assert.equal(r.status,[400,403,429].includes(response)?'failed':'uncertain');
 }
});
test('durable pre-POST checkpoint, systemic stop, and restart never replay a copy',async()=>{
 const j=job('1,,2,\n1,,3,');let calls=0,saves=0;
 const worker=createCopyJobs({client:client({copy:async()=>{assert.ok(saves>0);calls++;return {status:'uncertain'};}})});
 await worker.plan(j,async()=>{});await worker.execute(j,async()=>{saves++;},async()=>{});assert.equal(calls,1);assert.equal(j.tasks[1].result.status,'notAttempted');
 interruptJob(j);await worker.execute(j,async()=>{},async()=>{});assert.equal(calls,1);assert.equal(j.tasks[0].result.status,'uncertain');
});
test('status checks skip terminal results and retain tokens/status when checking fails',async()=>{
 const j=job('1,,2,\n1,,3,');const checked=[];const worker=createCopyJobs({client:client({check:async dest=>{checked.push(dest);throw Error();}})});await worker.plan(j,async()=>{});
 j.operation='check';j.tasks[0].result={status:'COMPLETE',jobToken:'saved'};j.tasks[1].result={status:'PROCESSING',jobToken:'pending'};
 await worker.execute(j,async()=>{},async()=>{});assert.deepEqual(checked,['3']);assert.equal(j.tasks[0].result.status,'COMPLETE');assert.equal(j.tasks[1].result.status,'PROCESSING');assert.equal(j.status,'copiesInProcess');
 const done=createCopyJobs({client:client({check:async()=>'COMPLETE'})});await done.execute(j,async()=>{},async()=>{});assert.equal(j.status,'copiesConcluded');
});
test('worker dispatches copy planning and execution without touching date writers',async()=>{
 let stored,locked=false;
 const store={insert:async j=>{stored=structuredClone(j);},acquire:async()=>{locked=true;return true;},renew:async()=>{assert.ok(locked);},release:async()=>{locked=false;},claim:async()=>{stored.status=stored.status==='validating'?'planning':'running';return structuredClone(stored);},save:async j=>{stored=structuredClone(j);}};
 const service=createBulkJobs({store,courseCopy:createCopyJobs({client:client({copy:async()=>({status:'PENDING',jobToken:'t'})})})});
 await service.create({owner:'owner',kind:'courseCopy',csv:csv('1,,2,'),copyMode:'selected',components:['Quizzes']});await service.tick();assert.equal(stored.status,'ready');stored.status='queued';await service.tick();assert.equal(stored.status,'copiesInProcess');assert.equal(stored.tasks[0].result.jobToken,'t');
});
test('report includes every row and saved cumulative statuses, quotes formulas; compact view keeps per-course details in report',()=>{
 const j=job('1,,2,');j.rows[0].originName='=formula';j.tasks=[{row:2,originId:'1',destinationId:'2',result:{status:'COMPLETE',jobToken:'t'}}];j.status='copiesConcluded';const view=createCopyView();assert.match(view.report(j),/'=formula/);assert.match(view.report(j),/COMPLETE/);
 const html=view.render({},j,{button:()=>'',controls:()=>'',now:Date.now});assert.match(html,/Courses Copied Successfully/);assert.doesNotMatch(html,/<table/);
});

test('cancelling validation stops before the next mapping without any copy submissions',async()=>{
 const j=job('1,,2,\n1,,3,');let checked=0,reads=0;
 const worker=createCopyJobs({client:client({origin:async()=>{reads++;return {name:'Origin'};},copy:async()=>assert.fail('validation must never copy')})});
 await assert.rejects(()=>worker.plan(j,async()=>{},async()=>{if(++checked===2)throw Object.assign(Error('cancelled'),{code:'JOB_CANCELLED'});}),{code:'JOB_CANCELLED'});
 assert.equal(reads,1);assert.equal(j.tasks.length,1);assert.equal(j.rows[1].status,'pending');
 const html=createCopyView().render({}, {...j,status:'planning'}, {controls:()=>'',button:(_r,action)=>action==='cancel'?'CANCEL_VISIBLE':'',now:Date.now});assert.match(html,/CANCEL_VISIBLE/);
});
