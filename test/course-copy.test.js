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
 const j=job(Array.from({length:16},(_,i)=>`1,,${i+2},`).join('\n'));let calls=0,saves=0;
 const worker=createCopyJobs({client:client({copy:async()=>{assert.ok(saves>0);calls++;return {status:'uncertain'};}})});
 await worker.plan(j,async()=>{});await worker.execute(j,async()=>{saves++;},async()=>{});assert.equal(calls,8);assert.equal(j.tasks[8].result.status,'notAttempted');
 interruptJob(j);await worker.execute(j,async()=>{},async()=>{});assert.equal(calls,8);assert.equal(j.tasks[0].result.status,'uncertain');
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
 assert.equal(reads,0);assert.equal(j.tasks.length,1);assert.equal(j.rows[1].status,'pending');
 const html=createCopyView().render({}, {...j,status:'planning'}, {controls:()=>'',button:(_r,action)=>action==='cancel'?'CANCEL_VISIBLE':'',now:Date.now});assert.match(html,/CANCEL_VISIBLE/);
});

test('5,000 copies submit with at most eight workers and checkpoint each intent and response',async()=>{
 const j=job(Array.from({length:5000},(_,i)=>`1,,${i+2},`).join('\n'));let active=0,max=0,calls=0;const durable=new Map();
 const worker=createCopyJobs({client:client({copy:async(_origin,destination)=>{assert.equal(durable.get(destination),'uncertain');active++;max=Math.max(max,active);await new Promise(resolve=>setImmediate(resolve));active--;calls++;return {status:'PENDING',jobToken:'t'+destination};}})});
 await worker.plan(j,async()=>{});
 await worker.execute(j,async(job,dirty)=>{assert.equal(dirty.tasks.length,1);const t=job.tasks[dirty.tasks[0]];durable.set(t.destinationId,t.result.status);},async()=>{});
 assert.equal(max,8);assert.equal(active,0);assert.equal(calls,5000);assert.equal(j.status,'copiesInProcess');assert.ok([...durable.values()].every(s=>s==='PENDING'));
});
test('checkpoint failure drains active workers and never sends the uncheckpointed copy',async()=>{
 const j=job(Array.from({length:12},(_,i)=>`1,,${i+2},`).join('\n'));const sent=[];
 const worker=createCopyJobs({client:client({copy:async(_o,d)=>{await new Promise(r=>setImmediate(r));sent.push(d);return {status:'PENDING',jobToken:d};}})});await worker.plan(j,async()=>{});
 await assert.rejects(()=>worker.execute(j,async(_j,dirty)=>{if(dirty.tasks[0]===0)throw Error('storage');},async()=>{}),/storage/);
 assert.equal(sent.includes('2'),false);assert.equal(sent.includes('10'),false);const done=sent.length;await new Promise(r=>setImmediate(r));assert.equal(sent.length,done);
});

test('automatic copy mapping resolves only codes and excludes mismatches while valid rows submit',async()=>{
 const sent=[],resolved=[];const j=job('1,,2,\n1,A,3,C\n9,A,4,');j.validationMode='verified';
 const worker=createCopyJobs({client:client({origin:async()=>assert.fail('No detail reads'),destination:async()=>assert.fail('No detail reads'),resolveCode:async code=>{resolved.push(code);return {A:'1',C:'3'}[code];},copy:async(o,d)=>{sent.push(d);return {status:'PENDING',jobToken:d};}})});
 await worker.plan(j,async()=>{});assert.equal(j.status,'ready');assert.equal(j.rows[2].status,'invalid');assert.equal(j.tasks.length,2);
 await worker.execute(j,async()=>{},async()=>{});assert.deepEqual(sent.sort(),['2','3']);assert.match(createCopyView().report(j),/different org units/);
 const html=createCopyView().form({locals:{}},{controls:()=>''});assert.doesNotMatch(html,/name="validationMode"/);assert.match(html,/If both are provided, they must identify the same course/);
});

test('native result checks overlap up to eight workers',async()=>{
 const j=job(Array.from({length:24},(_,i)=>`1,,${i+2},`).join('\n'));let active=0,peak=0;
 const worker=createCopyJobs({client:client({check:async()=>{peak=Math.max(peak,++active);await new Promise(r=>setImmediate(r));active--;return 'COMPLETE';}})});
 await worker.plan(j,async()=>{});j.operation='check';for(const t of j.tasks)t.result={status:'PENDING',jobToken:'token'};
 await worker.execute(j,async()=>{},async()=>{});assert.equal(peak,8);assert.equal(active,0);assert.equal(j.status,'copiesConcluded');
});
