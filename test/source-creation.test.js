'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const axios=require('axios');
const {parseCreationCsv,createCreationJobs,HEADERS}=require('../src/creation/jobs');
const {createCreationClient}=require('../src/creation/client');
const {createCreationView}=require('../src/creation/view');
const {formatBrightspaceDate}=require('../src/ui/page');
const creationProgress=require('../src/creation/progress');
const {createOrgResolver}=require('../src/resolution/resolver');
const {createBulkJobs}=require('../src/shared/jobs');
const header=HEADERS.join(',');
const record=(Identifier,Code,Type='CourseTemplate',lifecycle='current',typeId)=>({Identifier,Code,Name:Code,Type:{Code:Type,...(typeId?{Id:typeId,Name:'Renamed department type'}:{})},lifecycle});
function resolverFixture({matches={}}={}){
 const all=new Map([['10',record('10','T1')],['11',record('11','T2')],['20',record('20','TC')],['50',record('50','D1','', 'current',7)],['51',record('51','D2','', 'current',7)],['52',record('52','D3','', 'current',7)]]),calls={prepare:[],lookupMatches:[]};
 return {calls,resolver:{isStandardDepartment:r=>r?.Type?.Id===7,lookupByIds:async ids=>new Map(ids.filter(value=>all.has(value)).map(value=>[value,all.get(value)])),prepare:async codes=>{calls.prepare.push([...codes]);return {resolve:async code=>{const r=[...all.values()].find(value=>value.Code===code);if(!r)throw Object.assign(Error('Course code was not found as a current org unit.'),{code:'CODE_NOT_FOUND'});return r;}};},lookupMatches:async codes=>{calls.lookupMatches.push([...codes]);return new Map(codes.map(code=>[code,matches[code]||[]]));}}};
}
const makeFeature=(fixture,overrides={})=>createCreationJobs({client:{orgUnit:async value=>{throw Error(`unexpected live ID lookup ${value}`);},exactCode:async()=>[],create:async()=>({status:'created',orgUnitId:'999'}),parents:async()=>[],rootOrgUnitId:async()=>1,addParent:async()=>({status:'succeeded'}),removeParent:async()=>({status:'succeeded'}),...overrides},orgResolver:fixture.resolver,store:{registerCreated:async()=>{}},now:(()=>{let time=1000;return()=>++time;})()});
const parse=lines=>parseCreationCsv([header,...lines].join('\n'));

test('CSV accepts six columns and enforces row, size, identifier-list, and duplicate rules',()=>{
 const row=parse(['Bio,BIO,10,,50,']);assert.equal(row[0].row,2);assert.deepEqual(row[0].departmentIdsInput,'50');
 assert.equal(parse(['Bio,BIO,10,,,"D1|D2"'])[0].departmentCodes,'D1|D2');
 assert.throws(()=>parseCreationCsv('SourceCourseName,SourceCourseCode,TemplateId,TemplateCode\nBio,BIO,10,'),{code:'INVALID_CSV'});
 assert.equal(parse([ 'Bio,BIO,10,,50|50,'])[0].departmentIds,'50|50');
 assert.equal(parse([ 'Bio,BIO,10,,50|,'])[0].departmentIds,'50|');
 assert.throws(()=>parseCreationCsv(`${header}\n`+Array.from({length:10001},(_,i)=>`N${i},C${i},10,,50,`).join('\n')),{code:'INVALID_CSV'});
 assert.throws(()=>parseCreationCsv('x'.repeat(5*1024*1024+1)),{code:'INVALID_CSV'});
});

test('Creator recheck setting defaults off, persists with validation, and is included in the report',async()=>{
 const inserted=[],jobs=createBulkJobs({store:{insert:async job=>inserted.push(structuredClone(job))},sourceCreation:{parse:parseCreationCsv}});
 const off=await jobs.create({owner:'owner',csv:`${header}\nA,A,10,,50,`,kind:'sourceCreation'}),on=await jobs.create({owner:'owner',csv:`${header}\nB,B,10,,50,`,kind:'sourceCreation',liveSourceCourseRecheck:'yes'});
 assert.equal(off.liveSourceCourseRecheck.enabled,false);assert.equal(off.validationMetadata.liveSourceCourseRecheck,false);assert.equal(on.liveSourceCourseRecheck.enabled,true);assert.equal(on.validationMetadata.liveSourceCourseRecheck,true);assert.equal(inserted[1].liveSourceCourseRecheck.enabled,true);
 const view=createCreationView(),html=view.form({locals:{orgLibraryAsOf:Date.UTC(2026,9,13,14,5)}},{controls:()=>''});assert.match(html,/name="liveSourceCourseRecheck" value="yes"/);assert.doesNotMatch(html,/name="liveSourceCourseRecheck" value="yes" checked/);assert.match(html,/Source Course information is current through 13 Oct 2026, 14:05 UTC\./);assert.doesNotMatch(html,/>Recent changes in Brightspace\?</);assert.match(html,/Check Brightspace for recent changes \(may take a little longer\)\./);assert.match(html,/If you created or changed Source Courses in Brightspace after this time, select the option below\./);assert.doesNotMatch(html,/May take a little longer\.<\/p>/);
 const restored=view.form({locals:{dateForm:{liveSourceCourseRecheck:'yes'}}},{controls:()=>''});assert.match(restored,/name="liveSourceCourseRecheck" value="yes" checked/);
 const unavailable=view.form({locals:{}},{controls:()=>''});assert.match(unavailable,/Update date unavailable\./);assert.equal(formatBrightspaceDate(undefined),null);assert.equal(formatBrightspaceDate('invalid'),null);
 const csv=view.report({...on,rows:[{row:2,sourceCourseName:'B',sourceCourseCode:'B',status:'eligible'}],tasks:[]});assert.match(csv,/LiveSourceCourseRecheck/);assert.match(csv,/Enabled/);
});

test('planning resolves template and Department ID/code, applies duplicate lifecycle policy, and keeps partial-valid rows',async()=>{
 const fixture=resolverFixture({matches:{
  EXIST:[record('70','EXIST','SourceCourse','current'),record('71','EXIST','SourceCourse','recycled')],
  MULTI:[record('72','MULTI','SourceCourse'),record('73','MULTI','SourceCourse')],
  OTHER:[record('74','OTHER','Department')],RECYCLED:[record('75','RECYCLED','SourceCourse','recycled')]
 }}),feature=makeFeature(fixture);
 const job={rows:parse(['By ID,BIO,10,,50,','By code,CHEM,,TC,,D1','Existing,EXIST,10,,50,','Multiple,MULTI,10,,50,','Cross type,OTHER,10,,50,','Recycled only,RECYCLED,10,,50,','Duplicate,DUP,10,,50,','Duplicate again,DUP,10,,50,']),tasks:[],status:'planning'};
 await feature.plan(job,async()=>{});
 assert.equal(job.status,'ready');assert.deepEqual(job.tasks.map(task=>task.row),[2,3,7]);
 assert.equal(job.rows.find(row=>row.row===4).status,'skipped');assert.match(job.rows.find(row=>row.row===4).message,/70/);assert.doesNotMatch(job.rows.find(row=>row.row===4).message,/71/);
 assert.equal(job.rows.find(row=>row.row===5).status,'skipped');assert.equal(job.rows.find(row=>row.row===6).status,'invalid');
 assert.equal(job.rows.find(row=>row.row===7).status,'eligible');assert.equal(job.rows.find(row=>row.row===8).status,'invalid');assert.equal(job.rows.find(row=>row.row===9).status,'invalid');
 assert.equal(job.templateReconciliationPlan[1].departmentIds[0],'50');assert.equal(job.templateReconciliationPlan[1].departmentCodes[0],'D1');assert.equal(job.templateReconciliationPlan.length,2);
 assert.equal(fixture.calls.lookupMatches.length,1);assert.equal(fixture.calls.lookupMatches[0].length,6);
});

test('optional live recheck replaces stale Source Course evidence while preserving current and cross-type decisions',async()=>{
 const fixture=resolverFixture({matches:{CURRENT:[record('70','CURRENT','SourceCourse')],ARCHIVED:[{...record('71','ARCHIVED','SourceCourse'),provenance:'creation'}],DELETED:[record('72','DELETED','SourceCourse')],RESTORED:[record('73','RESTORED','SourceCourse')],MULTI:[record('74','MULTI','SourceCourse'),record('75','MULTI','SourceCourse')],CROSS:[record('76','CROSS','SourceCourse'),record('77','CROSS','Department')]}}),lookups=[];
 const feature=makeFeature(fixture,{sourceCourseTypeId:async()=>8,recheckSourceCourseCode:async(code,typeId)=>{lookups.push([code,typeId]);return ({CURRENT:[record('70','CURRENT','SourceCourse')],ARCHIVED:[],DELETED:[],RESTORED:[record('73','RESTORED','SourceCourse')],MULTI:[record('74','MULTI','SourceCourse'),record('75','MULTI','SourceCourse')]})[code]||[];}});
 const job={rows:parse(['Current,CURRENT,10,,50,','Archived,ARCHIVED,10,,50,','Deleted,DELETED,10,,50,','Restored,RESTORED,10,,50,','Multiple,MULTI,10,,50,','Cross type,CROSS,10,,50,']),tasks:[],status:'planning',liveSourceCourseRecheck:{enabled:true}};
 await feature.plan(job,async()=>{});
 assert.deepEqual(lookups.sort(([a],[b])=>a.localeCompare(b)),[['ARCHIVED',8],['CURRENT',8],['DELETED',8],['MULTI',8],['RESTORED',8]]);
 for(const code of ['CURRENT','RESTORED','MULTI'])assert.equal(job.rows.find(row=>row.sourceCourseCode===code).status,'skipped');
 for(const code of ['ARCHIVED','DELETED'])assert.equal(job.rows.find(row=>row.sourceCourseCode===code).status,'eligible');
 assert.equal(job.rows.find(row=>row.sourceCourseCode==='CROSS').status,'invalid');
 assert.deepEqual(job.tasks.map(task=>task.Code),['ARCHIVED','DELETED']);
});

test('opt-in recheck deduplicates repeated codes, rejects unsafe live failures, and is absent when disabled',async()=>{
 const fixture=resolverFixture({matches:{OLD:[record('70','OLD','SourceCourse')],DUP:[record('71','DUP','SourceCourse')],BAD:[record('72','BAD','SourceCourse')],FORBIDDEN:[record('73','FORBIDDEN','SourceCourse')],RATE:[record('74','RATE','SourceCourse')],SERVER:[record('75','SERVER','SourceCourse')]}});let calls=0;
 const feature=makeFeature(fixture,{sourceCourseTypeId:async()=>8,recheckSourceCourseCode:async(code)=>{calls++;if(code==='BAD')throw Error('timeout');if(code==='FORBIDDEN')throw Object.assign(Error('forbidden'),{status:403});if(code==='RATE')throw Object.assign(Error('rate limit'),{status:429});if(code==='SERVER')throw Object.assign(Error('server error'),{status:503});return code==='OLD'?[]:[record('71',code,'SourceCourse')];}});
 const job={rows:parse(['Old,OLD,10,,50,','Old duplicate input,OLD,10,,50,','Duplicate CSV,DUP,10,,50,','Timeout,BAD,10,,50,','Forbidden,FORBIDDEN,10,,50,','Rate limit,RATE,10,,50,','Server error,SERVER,10,,50,']),tasks:[],status:'planning',liveSourceCourseRecheck:{enabled:true}};
 await feature.plan(job,async()=>{});assert.equal(calls,5);assert.equal(job.rows[0].status,'invalid');assert.match(job.rows[0].message,/Duplicate Source Course code/);assert.equal(job.rows[1].status,'invalid');assert.equal(job.rows[2].status,'skipped');assert.equal(job.rows[3].status,'invalid');assert.match(job.rows[3].message,/verification failed/);assert.equal(job.rows[4].status,'invalid');assert.match(job.rows[4].message,/visibility/);assert.equal(job.rows[5].status,'invalid');assert.match(job.rows[5].message,/rate-limited/);assert.equal(job.rows[6].status,'invalid');assert.match(job.rows[6].message,/incomplete/);
 const offFixture=resolverFixture({matches:{OLD:[record('70','OLD','SourceCourse')]}}),off=makeFeature(offFixture,{recheckSourceCourseCode:async()=>{throw Error('must not call');}}),offJob={rows:parse(['Old,OLD,10,,50,']),tasks:[],status:'planning'};
 await off.plan(offJob,async()=>{});assert.equal(offFixture.calls.lookupMatches.length,1);assert.equal(offJob.rows[0].status,'skipped');assert.equal(offJob.liveSourceCourseRecheck.enabled,false);assert.equal(offJob.liveSourceCourseRecheck.status,'disabled');
});

test('unavailable Source Course type visibility fails every candidate safely',async()=>{
 const fixture=resolverFixture({matches:{A:[record('70','A','SourceCourse')],B:[record('71','B','SourceCourse')]}}),feature=makeFeature(fixture,{sourceCourseTypeId:async()=>{throw Object.assign(Error('forbidden'),{status:403});},recheckSourceCourseCode:async()=>assert.fail('type visibility must be resolved before code lookups')}),job={rows:parse(['A,A,10,,50,','B,B,10,,50,']),tasks:[],status:'planning',liveSourceCourseRecheck:{enabled:true}};
 await feature.plan(job,async()=>{});assert.ok(job.rows.every(row=>row.status==='invalid'));assert.ok(job.rows.every(row=>/organizations:organizationtypes:read/.test(row.message)));assert.equal(job.liveSourceCourseRecheck.status,'failed');assert.equal(job.tasks.length,0);
});

test('5,000 unique candidate codes use at most eight concurrent checks and metadata progress',async()=>{
 const codes=Array.from({length:5000},(_,i)=>`SC${i}`),matches=Object.fromEntries(codes.map((code,i)=>[code,[record(String(10000+i),code,'SourceCourse')]])),fixture=resolverFixture({matches});let active=0,peak=0,calls=0;const progress=[];
 const feature=makeFeature(fixture,{sourceCourseTypeId:async()=>8,recheckSourceCourseCode:async()=>{active++;peak=Math.max(peak,active);calls++;await Promise.resolve();active--;return [];}}),job={rows:parse(codes.map((code,i)=>`Course ${i},${code},10,,50,`)),tasks:[],status:'planning',liveSourceCourseRecheck:{enabled:true}};
 await feature.plan(job,async()=>{},async()=>{},async(_job,fields)=>{progress.push(fields.liveSourceCourseRecheck.checkedCount);return true;});
 assert.equal(calls,5000);assert.ok(peak<=8&&peak>1);assert.equal(job.tasks.length,5000);assert.equal(job.liveSourceCourseRecheck.checkedCount,5000);assert.ok(progress.length<=3);assert.equal(job.status,'ready');
});

test('cancellation during live verification leaves validation unconfirmable',async()=>{
 const fixture=resolverFixture({matches:{A:[record('70','A','SourceCourse')],B:[record('71','B','SourceCourse')],C:[record('72','C','SourceCourse')]}});let cancelled=false;
 const feature=makeFeature(fixture,{sourceCourseTypeId:async()=>8,recheckSourceCourseCode:async(_code,_type,check)=>{cancelled=true;await check();return [];}}),job={_id:'j',rows:parse(['A,A,10,,50,','B,B,10,,50,','C,C,10,,50,']),tasks:[],status:'planning',liveSourceCourseRecheck:{enabled:true}};
 await assert.rejects(feature.plan(job,async()=>{},async()=>{if(cancelled)throw Object.assign(Error('cancel'),{code:'JOB_CANCELLED'});}));assert.notEqual(job.status,'ready');assert.equal(job.confirmedAt,undefined);
});

test('invalid or missing Department lists and unknown duplicate lifecycle evidence fail per row',async()=>{
 const fixture=resolverFixture({matches:{UNKNOWN:{error:Object.assign(Error('Lifecycle status unknown'),{code:'CODE_STATUS_UNKNOWN'})}}}),feature=makeFeature(fixture),job={rows:parse(['Missing,MISSING,10,,,','Both,BOTH,10,,50,D1','Repeated,REPEATED,10,,50|50,','Bad ID,BADID,10,,50|x,','Unknown,UNKNOWN,10,,50,']),tasks:[],status:'planning'};
 await feature.plan(job,async()=>{});assert.equal(job.tasks.length,0);assert.ok(job.rows.every(row=>row.status==='invalid'));assert.match(job.rows[0].message,/exactly one/);assert.match(job.rows[1].message,/exactly one/);assert.match(job.rows[2].message,/unique/);assert.match(job.rows[3].message,/positive integers/);assert.match(job.rows[4].message,/Lifecycle status/);
});

test('shared duplicate-aware resolver batches unique codes and marks uncatalogued live results lower assurance',async()=>{
 let lookups=0;const cached={Identifier:'70',Code:'MIX',Name:'Old',Type:{Code:'SourceCourse'},lifecycle:'recycled'},second={Identifier:'71',Code:'MIX',Name:'Current',Type:{Code:'SourceCourse'},lifecycle:'current'};
 const store={lookup:async codes=>{lookups++;const map=new Map([['MIX',[cached,second]],['UNKNOWN',[{Identifier:'99',Code:'UNKNOWN',Type:{Code:'SourceCourse'},lifecycle:'unknown'}]]]);map.safeCodes=new Set();return map;},remember:async()=>{}};
 const apiCalls=[];const resolver=createOrgResolver({store,root:'https://tenant.example/d2l/api/lp/1.60',api:{list:async url=>{const code=new URL(url).searchParams.get('exactOrgUnitCode');apiCalls.push(code);return code==='MIX'?[{Identifier:'70',Code:'MIX',Type:{Code:'SourceCourse'}},{Identifier:'71',Code:'MIX',Type:{Code:'SourceCourse'}}]:code==='NEW'?[{Identifier:'88',Code:'NEW',Type:{Code:'CourseOffering'}}]:[{Identifier:'99',Code:'UNKNOWN',Type:{Code:'SourceCourse'}}];}}});
 const result=await resolver.lookupMatches(['MIX','MIX','NEW','UNKNOWN']);assert.equal(lookups,1);assert.deepEqual(apiCalls.sort(),['MIX','NEW','UNKNOWN']);assert.equal(result.get('MIX').length,2);assert.deepEqual(result.get('MIX').map(item=>item.lifecycle).sort(),['current','recycled']);assert.equal(result.get('NEW')[0].lifecycle,'live-verified');assert.equal(result.get('UNKNOWN')[0].lifecycle,'live-verified');
});

test('all rows for a template are invalid when equivalent-resolved parent sets conflict',async()=>{
 const fixture=resolverFixture(),feature=makeFeature(fixture),job={rows:parse(['A,A,10,,50|51,','B,B,10,,51|50,','C,C,10,,52,']),tasks:[],status:'planning'};
 await feature.plan(job,async()=>{});assert.equal(job.tasks.length,0);assert.equal(job.status,'completed');assert.match(job.message,/no eligible rows/i);
 assert.equal(job.templateReconciliationPlan.length,0);assert.ok(job.rows.every(row=>row.status==='invalid'));assert.ok(job.rows.every(row=>row.message.includes('conflicting')));
});

test('shared templates and Department identifiers are resolved once across thousands of rows',async()=>{
 const fixture=resolverFixture(),feature=makeFeature(fixture),job={rows:parse(Array.from({length:1200},(_,i)=>`Course ${i},C${i},10,,50|51,`).join('\n').split('\n')),tasks:[],status:'planning'};
 await feature.plan(job,async()=>{});assert.equal(job.tasks.length,1200);assert.equal(job.templateReconciliationPlan.length,1);
 assert.equal(fixture.calls.prepare.length,1);assert.deepEqual(fixture.calls.prepare[0],[]);assert.equal(fixture.calls.lookupMatches[0].length,1200);
});

test('creation uses eight workers, checkpoints confirmed IDs, and only retries Org Library registration',async()=>{
 let posts=0,registrations=0,parentReads=0;const fixture=resolverFixture(),feature=makeFeature(fixture,{create:async()=>{posts++;return {status:'created',orgUnitId:'101'};},parents:async()=>{parentReads++;return [];}});
 feature.register=async(task,job,save,index)=>{if(++registrations===1)throw Object.assign(Error('Mongo unavailable'),{registrationFailure:true});task.result.registration='ready';await save(job,{tasks:[index]});};
 const job={_id:'j',owner:'o',status:'running',tasks:[{row:2,Name:'Bio',Code:'BIO',TemplateId:'10',TemplateCode:'T1',DepartmentIds:['50'],result:null}],rows:[],templateReconciliationPlan:[{templateId:'10',departmentIds:['50'],departmentCodes:['D1']}],step3StartedAt:1000};let saves=0;
 await feature.execute(job,async()=>{saves++;},async()=>{},async()=>false);assert.equal(posts,1);assert.equal(job.tasks[0].result.CreatedOrgUnitId,'101');assert.equal(job.tasks[0].result.registration,'pending');assert.equal(job.status,'queued');assert.equal(parentReads,0);assert.equal(job.templateReconciliation['10'].status,'Updated');
 feature.register=async(task,job,save,index)=>{registrations++;task.result.registration='ready';await save(job,{tasks:[index]});};job.status='running';await feature.execute(job,async()=>{},async()=>{},async()=>false);
 assert.equal(posts,1);assert.equal(job.tasks[0].result.registration,'ready');assert.equal(parentReads,0);assert.equal(job.status,'completed');assert.ok(saves>=1);
});

test('write-first reconciliation runs once per distinct template after creation workers finish',async()=>{
 const state={parents:[{Identifier:'1'},{Identifier:'900'}]},calls=[],checkpoints=[];let rootReads=0;const fixture=resolverFixture(),feature=makeFeature(fixture,{
  parents:async template=>{calls.push(['GET',template]);return state.parents;},rootOrgUnitId:async()=>{rootReads++;return 1;},
  addParent:async(template,parent)=>{calls.push(['POST',template,parent]);state.parents.push({Identifier:parent});return {status:'succeeded'};},
  removeParent:async(template,parent)=>{calls.push(['DELETE',template,parent]);state.parents=state.parents.filter(p=>p.Identifier!==parent);return {status:'succeeded'};}
 });
 const plans=['10','20'].map(templateId=>({templateId,departmentIds:['50','51'],departmentCodes:['D1','D2']})),tasks=Array.from({length:100},(_,i)=>({row:i+2,Code:`C${i}`,TemplateId:i===99?'20':'10',result:{status:'created',registration:'ready',CreatedOrgUnitId:String(i+100)}}));
 const job={_id:'j',owner:'o',status:'running',tasks,rows:[],templateReconciliationPlan:plans,step3StartedAt:1};await feature.execute(job,async(_job,dirty)=>checkpoints.push(dirty),async()=>{},async()=>false);
 assert.equal(calls.filter(call=>call[0]==='GET').length,0);assert.equal(calls.filter(call=>call[0]==='POST').length,4);assert.equal(calls.filter(call=>call[0]==='DELETE').length,2);assert.equal(rootReads,1);
 for(const template of ['10','20'])assert.deepEqual(calls.filter(call=>call[1]===template).map(call=>call[0]),['POST','POST','DELETE']);assert.ok(checkpoints.every(dirty=>dirty&&Object.keys(dirty).length===0));assert.equal(job.templateReconciliation['10'].status,'Updated');assert.equal(job.templateReconciliation['20'].status,'Updated');assert.equal(job.status,'completed');
});

test('write-first reconciliation posts Departments and removes Root without routine parent GETs',async()=>{
 const calls=[],fixture=resolverFixture(),feature=makeFeature(fixture,{parents:async()=>{calls.push('GET');return [{Identifier:'50'},{Identifier:'51'}];},rootOrgUnitId:async()=>{calls.push('ROOT');return 1;},addParent:async(_template,parent)=>{calls.push(`POST:${parent}`);return {status:'succeeded'};},removeParent:async(_template,parent)=>{calls.push(`DELETE:${parent}`);return {status:'succeeded'};}});
 const job={_id:'j',owner:'o',status:'running',tasks:[{row:2,TemplateId:'10',result:{status:'created',registration:'ready'}}],rows:[],templateReconciliationPlan:[{templateId:'10',departmentIds:['50','51'],departmentCodes:['D1','D2']}],step3StartedAt:1};await feature.execute(job,async()=>{},async()=>{},async()=>false);
 assert.deepEqual(calls,['ROOT','POST:50','POST:51','DELETE:1']);assert.equal(job.templateReconciliation['10'].status,'Updated');
});

test('uncertain parent additions are read before retry and recovery does not repeat a confirmed write',async()=>{
 let parents=[{Identifier:'1'}],posts=0,gets=0;const fixture=resolverFixture(),feature=makeFeature(fixture,{parents:async()=>{gets++;return parents;},rootOrgUnitId:async()=>1,addParent:async(_template,parent)=>{posts++;parents.push({Identifier:parent});return {status:'uncertain'};},removeParent:async()=>({status:'succeeded'})});
 const job={_id:'j',owner:'o',status:'running',tasks:[{row:2,TemplateId:'10',result:{status:'created',registration:'ready'}}],rows:[],templateReconciliationPlan:[{templateId:'10',departmentIds:['50'],departmentCodes:['D1']}],step3StartedAt:1};await feature.execute(job,async()=>{},async()=>{},async()=>false);
 assert.equal(job.templateReconciliation['10'].status,'Uncertain');assert.equal(posts,1);assert.equal(gets,0);job.status='running';await feature.execute(job,async()=>{},async()=>{},async()=>false);
 assert.equal(posts,1);assert.equal(gets,1);assert.equal(job.templateReconciliation['10'].status,'Updated');
});

test('uncertain Root deletion is read before deciding whether to repeat it',async()=>{
 let parents=[{Identifier:'1'}],adds=0,deletes=0,gets=0;const fixture=resolverFixture(),feature=makeFeature(fixture,{parents:async()=>{gets++;return parents;},rootOrgUnitId:async()=>1,addParent:async(_template,parent)=>{adds++;parents.push({Identifier:parent});return {status:'succeeded'};},removeParent:async()=>{deletes++;parents=parents.filter(parent=>parent.Identifier!=='1');return {status:'uncertain'};}});
 const job={_id:'j',owner:'o',status:'running',tasks:[{row:2,TemplateId:'10',result:{status:'created',registration:'ready'}}],rows:[],templateReconciliationPlan:[{templateId:'10',departmentIds:['50'],departmentCodes:['D1']}],step3StartedAt:1};await feature.execute(job,async()=>{},async()=>{},async()=>false);
 assert.equal(job.templateReconciliation['10'].status,'Uncertain');assert.equal(gets,0);job.status='running';await feature.execute(job,async()=>{},async()=>{},async()=>false);assert.equal(gets,1);assert.equal(adds,1);assert.equal(deletes,1);assert.equal(job.templateReconciliation['10'].status,'Updated');
});

test('cancellation drains creation then write-first reconciles its affected template',async()=>{
 let cancelled=false,gets=0,adds=0,deletes=0;const fixture=resolverFixture(),feature=makeFeature(fixture,{create:async()=>{cancelled=true;return {status:'created',orgUnitId:'101'};},parents:async()=>{gets++;return [];},addParent:async()=>{adds++;return {status:'succeeded'};},removeParent:async()=>{deletes++;return {status:'succeeded'};}});
 const job={_id:'j',owner:'o',status:'running',tasks:[{row:2,Name:'Bio',Code:'BIO',TemplateId:'10',TemplateCode:'T1',result:null}],rows:[],templateReconciliationPlan:[{templateId:'10',departmentIds:['50'],departmentCodes:['D1']}],step3StartedAt:1};await feature.execute(job,async()=>{},async()=>{},async()=>cancelled);
 assert.equal(job.status,'cancelled');assert.equal(job.tasks[0].result.status,'created');assert.equal(job.templateReconciliation['10'].status,'Updated');assert.equal(gets,0);assert.equal(adds,1);assert.equal(deletes,1);
});

test('failed Department parent addition preserves Root Organization and records completedWithErrors',async()=>{
 let deleted=0;const fixture=resolverFixture(),feature=makeFeature(fixture,{parents:async()=>[{Identifier:'1'}],rootOrgUnitId:async()=>1,addParent:async()=>({status:'failed'}),removeParent:async()=>{deleted++;return {status:'succeeded'};}});
 const job={_id:'j',owner:'o',status:'running',tasks:[{row:2,TemplateId:'10',result:{status:'created',registration:'ready',CreatedOrgUnitId:'100'}}],rows:[],templateReconciliationPlan:[{templateId:'10',departmentIds:['50'],departmentCodes:['D1']}],step3StartedAt:1};await feature.execute(job,async()=>{},async()=>{},async()=>false);
 assert.equal(job.tasks[0].result.status,'created');assert.equal(job.templateReconciliation['10'].status,'Failed');assert.equal(deleted,0);assert.equal(job.status,'completedWithErrors');
});

test('Root deletion failure and root-identification failure stay separate from creation outcomes',async()=>{
 const fixture=resolverFixture(),base={_id:'j',owner:'o',status:'running',tasks:[{row:2,TemplateId:'10',result:{status:'created',registration:'ready',CreatedOrgUnitId:'100'}}],rows:[],templateReconciliationPlan:[{templateId:'10',departmentIds:['50'],departmentCodes:['D1']}],step3StartedAt:1};
 const deletion=makeFeature(fixture,{rootOrgUnitId:async()=>1,addParent:async()=>({status:'succeeded'}),removeParent:async()=>({status:'failed'})}),job1=structuredClone(base);await deletion.execute(job1,async()=>{},async()=>{},async()=>false);assert.equal(job1.tasks[0].result.status,'created');assert.equal(job1.templateReconciliation['10'].status,'Failed');assert.equal(job1.status,'completedWithErrors');
 const unresolved=makeFeature(fixture,{rootOrgUnitId:async()=>null,addParent:async()=>{throw Error('must not add');}}),job2=structuredClone(base);await unresolved.execute(job2,async()=>{},async()=>{},async()=>false);assert.equal(job2.templateReconciliation['10'].status,'Failed');assert.equal(job2.templateReconciliation['10'].message,'Unable to identify the Root Organization safely.');assert.equal(job2.status,'completedWithErrors');
});

test('a submitted rejected creation still triggers write-first template reconciliation',async()=>{
 let reads=0,adds=0,deletes=0;const fixture=resolverFixture(),feature=makeFeature(fixture,{create:async()=>({status:'failed',submissionAttempted:true,message:'Rejected'}),parents:async()=>{reads++;return [{Identifier:'50'}];},rootOrgUnitId:async()=>1,addParent:async()=>{adds++;return {status:'succeeded'};},removeParent:async()=>{deletes++;return {status:'succeeded'};}});
 const task={row:2,Name:'Bio',Code:'BIO',TemplateId:'10',DepartmentIds:['50'],DepartmentCodes:['D1'],result:null},job={_id:'j',owner:'o',status:'running',tasks:[task],rows:[],templateReconciliationPlan:[{templateId:'10',departmentIds:['50'],departmentCodes:['D1']}],step3StartedAt:1};
 await feature.execute(job,async()=>{},async()=>{},async()=>false);assert.equal(reads,0);assert.equal(adds,1);assert.equal(deletes,1);assert.equal(job.templateReconciliation['10'].status,'Updated');assert.equal(job.status,'completedWithErrors');
});

test('API client uses documented parent routes, JSON-number POST, and bearer authorization',async()=>{
 const calls=[],client=createCreationClient({api:{read:async url=>{calls.push(['GET',url]);return url.endsWith('/parents/')?[]:{Identifier:7};},list:async()=>[]},http:async config=>{calls.push([config.method,config.url,config.data,config.headers]);return {status:200,data:{OrgUnitId:123}};},oauth:{getAccessToken:async()=>'token'},baseUrl:'https://tenant.example',lpVersion:'1.60'});
 assert.deepEqual(await client.parents('10'),[]);assert.equal(await client.rootOrgUnitId(),'7');assert.equal((await client.addParent('10','50')).status,'succeeded');assert.equal((await client.removeParent('10','50')).status,'succeeded');
 assert.deepEqual(calls[2].slice(0,3),['POST','https://tenant.example/d2l/api/lp/1.60/orgstructure/10/parents/',50]);assert.equal(calls[2][3].Authorization,'Bearer token');assert.equal(calls[2][3]['Content-Type'],'application/json');
 const serialized=axios.defaults.transformRequest[0](calls[2][2],new axios.AxiosHeaders(calls[2][3]));assert.equal(serialized,'50');assert.equal(calls[3][1],'https://tenant.example/d2l/api/lp/1.60/orgstructure/10/parents/50');
 const result=await client.create({Name:'Bio',Code:'BIO',TemplateId:'10'},async()=>{});assert.deepEqual(result,{status:'created',orgUnitId:'123',submissionAttempted:true});
});

test('live exact-code client resolves a tenant type ID and sends both filters through paged transport',async()=>{
 const urls=[],client=createCreationClient({api:{list:async(url,_raw,options)=>{urls.push([url,options]);if(url.endsWith('/outypes/'))return [{Id:8,Code:'SourceCourse',Name:'Source Course'}];return [{Identifier:'99',Code:'BIO-OLD',Name:'Bio',Type:{Id:8,Code:'SourceCourse'}}];}},http:async()=>({status:200,data:{}}),oauth:{getAccessToken:async()=>'token'},baseUrl:'https://tenant.example',lpVersion:'1.63'});
 assert.equal(await client.sourceCourseTypeId(),8);const rows=await client.recheckSourceCourseCode('BIO-OLD',8);const query=new URL(urls[1][0]).searchParams;
 assert.equal(query.get('orgUnitType'),'8');assert.equal(query.get('exactOrgUnitCode'),'BIO-OLD');assert.equal(urls[1][1].maxPages,100);assert.equal(rows.length,1);assert.equal(rows[0].lifecycle,'current');
 const invalid=createCreationClient({api:{list:async()=>[{Identifier:'10',Code:'BIO-OLD',Type:{Code:'SourceCourse'}}]},http:async()=>({}),oauth:{getAccessToken:async()=>'token'},baseUrl:'https://tenant.example',lpVersion:'1.63'});
 await assert.rejects(invalid.recheckSourceCourseCode('BIO-OLD',8),{code:'SOURCE_COURSE_RECHECK_INCOMPLETE'});
});

test('parent mutation classifies HTTP responses and sanitizes stored diagnostics',async()=>{
 const outcomes=[
  [{status:200,data:{}},'succeeded',200],
  [{status:400,data:{ErrorCode:'InvalidParent',Message:'<b>Rejected</b> https://tenant.example/?token=secret'}},'failed',400],
  [{status:403,data:{Message:'No permission'}},'failed',403],
  [{status:429,data:{ErrorCode:'RateLimit'}},'failed',429],
  [{status:503,data:{Message:'Unavailable'}},'uncertain',503]
 ];
 for(const [response,status,httpStatus] of outcomes){
  let config;const client=createCreationClient({api:{},http:async value=>{config=value;return response;},oauth:{getAccessToken:async()=>'secret-token'},baseUrl:'https://tenant.example',lpVersion:'1.63'});
  const result=await client.addParent('44803','71238');assert.equal(result.status,status);assert.equal(result.diagnostics.httpStatus,httpStatus);assert.equal(result.diagnostics.operation,'addParent');assert.equal(result.diagnostics.httpMethod,'POST');assert.equal(result.diagnostics.endpointPattern,'/d2l/api/lp/{LP}/orgstructure/{templateId}/parents/');assert.equal(result.diagnostics.templateId,'44803');assert.equal(result.diagnostics.parentOrgUnitId,'71238');assert.equal(result.diagnostics.requestDispatched,true);assert.equal(result.diagnostics.responseReceived,true);assert.equal(result.diagnostics.responseConfirmedSuccess,status==='succeeded');assert.equal(config.headers.Authorization,'Bearer secret-token');assert.equal(JSON.stringify(result).includes('secret-token'),false);
  if(httpStatus===400){assert.equal(result.diagnostics.apiErrorCode,'InvalidParent');assert.doesNotMatch(result.diagnostics.apiMessage,/https|secret/);}
 }
});

test('parent mutation treats timeouts and transport failures as uncertain, but pre-dispatch failures as failed',async()=>{
 for(const [error,classification,dispatched] of [[Object.assign(Error('timeout'),{code:'ETIMEDOUT',request:{}}),'timeout',true],[Object.assign(Error('socket closed'),{code:'ECONNRESET',request:{}}),'transport',true],[Object.assign(Error('adapter rejected data'),{code:'ERR_BAD_REQUEST'}),'pre_dispatch_failure',false]]){
  const client=createCreationClient({api:{},http:async()=>{throw error;},oauth:{getAccessToken:async()=>'token'},baseUrl:'https://tenant.example',lpVersion:'1.63'}),result=await client.addParent('10','50');
  assert.equal(result.status,dispatched?'uncertain':'failed');assert.equal(result.diagnostics.failureClassification,classification);assert.equal(result.diagnostics.requestDispatched,dispatched);assert.equal(result.diagnostics.responseReceived,false);assert.equal(result.diagnostics.responseConfirmedSuccess,false);
 }
 const client=createCreationClient({api:{},http:async()=>{throw Object.assign(Error('API gate completion failed'),{requestDispatched:true,responseReceived:true,httpStatus:200,responseConfirmedSuccess:true});},oauth:{getAccessToken:async()=>'token'},baseUrl:'https://tenant.example',lpVersion:'1.63'}),confirmed=await client.addParent('10','50');
 assert.equal(confirmed.status,'succeeded');assert.equal(confirmed.diagnostics.responseConfirmedSuccess,true);assert.equal(confirmed.diagnostics.httpStatus,200);
});

test('parenting-only recovery reads saved parents and never creates or registers Source Courses',async()=>{
 for(const [name,initialParents,initialOps,expectedCalls] of [
  ['Department absent',[{Identifier:'1'}],{'add:50':{kind:'add',parentId:'50',status:'uncertain'}},['GET','POST:50','DELETE:1']],
  ['Department present',[{Identifier:'1'},{Identifier:'50'}],{'add:50':{kind:'add',parentId:'50',status:'uncertain'}},['GET','DELETE:1']],
  ['Root delete already applied',[{Identifier:'50'}],{'add:50':{kind:'add',parentId:'50',status:'succeeded'},'remove:1':{kind:'remove',parentId:'1',status:'uncertain'}},['GET']]
 ]){
  let parents=initialParents.map(parent=>({...parent})),creates=0,registrations=0;const calls=[],fixture=resolverFixture(),feature=makeFeature(fixture,{
   parents:async()=>{calls.push('GET');return parents;},addParent:async(_template,parent)=>{calls.push(`POST:${parent}`);parents.push({Identifier:parent});return {status:'succeeded'};},removeParent:async(_template,parent)=>{calls.push(`DELETE:${parent}`);parents=parents.filter(item=>item.Identifier!==parent);return {status:'succeeded'};},create:async()=>{creates++;return {status:'created',orgUnitId:'999'};}
  });
  feature.register=async()=>{registrations++;};
  const job={_id:'j',owner:'owner',kind:'sourceCreation',status:'running',operation:'templateReconciliation',templateReconciliationTemplateIds:['10'],templateReconciliationRootOrgUnitId:'1',tasks:[{row:2,Name:'Bio',Code:'BIO',TemplateId:'10',result:{status:'created',CreatedOrgUnitId:'100',submissionAttempted:true,registration:'ready'}}],rows:[],templateReconciliationPlan:[{templateId:'10',departmentIds:['50'],departmentCodes:['D1']}],templateReconciliation:{'10':{templateId:'10',status:'Uncertain',operations:structuredClone(initialOps)}}};
  await feature.execute(job,async()=>{},async()=>{},async()=>false);assert.deepEqual(calls,expectedCalls,name);assert.equal(creates,0,name);assert.equal(registrations,0,name);assert.equal(job.tasks[0].result.CreatedOrgUnitId,'100',name);assert.equal(job.templateReconciliation['10'].status,'Updated',name);assert.equal(job.status,'completed',name);
 }
});

test('parent operation checkpoints carry compact diagnostics before and after HTTP dispatch',async()=>{
 const snapshots=[],fixture=resolverFixture(),feature=makeFeature(fixture,{rootOrgUnitId:async()=>1,addParent:async(template,parent)=>({status:'succeeded',diagnostics:{operation:'addParent',httpMethod:'POST',endpointPattern:'/d2l/api/lp/{LP}/orgstructure/{templateId}/parents/',templateId:template,parentOrgUnitId:parent,requestDispatched:true,responseReceived:true,responseConfirmedSuccess:true,httpStatus:200}}),removeParent:async()=>({status:'succeeded'})});
 const job={_id:'j',owner:'owner',status:'running',templateReconciliationRootOrgUnitId:'1',tasks:[{row:2,TemplateId:'10',result:{status:'created',CreatedOrgUnitId:'100',submissionAttempted:true}}],rows:[],templateReconciliationPlan:[{templateId:'10',departmentIds:['50'],departmentCodes:['D1']}]};
 await feature.execute(job,async value=>{const operation=value.templateReconciliation?.['10']?.operations?.['add:50'];if(operation)snapshots.push(structuredClone(operation));},async()=>{},async()=>false);
 assert.equal(snapshots[0].status,'intent');assert.equal(snapshots[0].diagnostics.requestDispatched,null);assert.equal(snapshots.at(-1).status,'succeeded');assert.equal(snapshots.at(-1).diagnostics.responseConfirmedSuccess,true);assert.equal(snapshots.at(-1).diagnostics.httpStatus,200);
});

test('lightweight status projection without rows or tasks renders, and report includes parenting fields',()=>{
 const view=createCreationView(),html=view.render({},{_id:'j',status:'completed',creationSummary:{eligible:2,skipped:1,invalid:0,created:2,total:2},totals:{created:2}}, {controls:()=>'',button:()=>'',now:()=>1});
 assert.match(html,/CSV rows/);const csv=view.report({rows:[{row:2,sourceCourseName:'A',sourceCourseCode:'A',templateId:'10',resolvedDepartmentIds:'50',resolvedDepartmentCodes:'D1'}],tasks:[{row:2,TemplateId:'10',TemplateCode:'T1',result:{status:'created',CreatedOrgUnitId:'100'}}],templateReconciliation:{'10':{status:'Updated',message:'Parent relationship updates completed successfully.'}}});
 assert.match(csv,/DepartmentIds/);assert.match(csv,/Parent relationship updates completed successfully/);assert.match(csv,/\"50\"/);
});

test('Creator validation progress shows saved counters, completion percentage, timing, and confirmation controls',()=>{
 const view=createCreationView(),helpers={controls:()=>'<input name="ticket">',button:(_res,action,_job,label,attrs='')=>`<button ${attrs}>${label}</button>`,now:()=>15000};
 const active=view.render({}, {_id:'validating',status:'planning',rows:[],progress:{phase:'templates',processed:40,total:100},creationSummary:{eligible:15,skipped:5,invalid:20},step2StartedAt:0,step2ProgressAt:15000},{...helpers,now:()=>15000});
 assert.match(active,/Source Course Validation Progress/);assert.match(active,/Validating Source Courses and Course Templates/);assert.match(active,/40%/);assert.match(active,/40<\/strong> \/ 100/);assert.match(active,/<progress max="100" value="40"/);for(const label of ['Eligible','Skipped','Invalid','Pending'])assert.match(active,new RegExp(label));assert.match(active,/Calculating ETA…/);assert.match(active,/id="create-refresh"/);assert.match(active,/setTimeout\(\(\)=>document\.getElementById\("create-refresh"\)\.requestSubmit\(\),10000\)/);
 const ready=view.render({}, {_id:'ready',status:'ready',rows:[],progress:{phase:'validated',processed:8,total:8},creationSummary:{eligible:3,skipped:2,invalid:3},step2ElapsedMs:42000,expiresAt:50000},{...helpers,now:()=>15000});
 assert.match(ready,/100%/);assert.match(ready,/Final elapsed: 42s/);assert.match(ready,/name="confirmCreation"/);assert.match(ready,/Download results CSV/);
 assert.equal(creationProgress.step2({status:'planning',rows:[],progress:{processed:0,total:0}},15000).percent,0);assert.equal(creationProgress.step2({status:'planning',rows:[],progress:{processed:0,total:0}},15000).estimate,'Calculating ETA…');assert.equal(creationProgress.step2({status:'completed',rows:[],progress:{processed:0,total:0}},15000).percent,100);
 const cancelled=creationProgress.step2({status:'cancelled',rows:[{status:'eligible'},{status:'pending'}],progress:{processed:1,total:2},creationSummary:{eligible:1,skipped:0,invalid:0}},15000);assert.equal(cancelled.percent,50);assert.equal(cancelled.estimate,'');
 const interrupted=creationProgress.step2({status:'interrupted',rows:[],progress:{processed:1,total:2}},15000);assert.equal(interrupted.estimate,'Progress paused — ETA unavailable');
});

test('live recheck progress shows unique-code count, percentage, elapsed time and an evidence-based ETA',()=>{
 const view=createCreationView(),html=view.render({}, {_id:'recheck',status:'planning',rows:[],progress:{phase:'Rechecking existing Source Courses',processed:5000,total:5000},creationSummary:{eligible:20,skipped:4000,invalid:10},step2StartedAt:0,step2ProgressAt:20000,liveSourceCourseRecheck:{enabled:true,status:'running',candidateCount:5000,checkedCount:1000,elapsedMs:20000,ratePerMs:.1}}, {controls:()=>'',button:()=>'',now:()=>20000});
 assert.match(html,/Rechecking existing Source Courses/);assert.match(html,/5000 unique codes require live checks; 1000 checked/);assert.match(html,/20%/);assert.match(html,/Elapsed: 20s/);assert.match(html,/Approximate remaining time: 40s/);assert.doesNotMatch(html,/name="confirmCreation"/);
});

test('Creator creation progress separates source outcomes from template reconciliation and handles terminal edge states',()=>{
 const view=createCreationView(),helpers={controls:()=>'',button:(_res,action)=>`<button>${action}</button>`,now:()=>30000};
 const base={_id:'creating',status:'running',confirmedAt:1,creationSummary:{total:10,created:3,registrationPending:1,skipped:1,failed:0,uncertain:0,notAttempted:0},totals:{created:3,skipped:1},tasks:[],step3StartedAt:0,step3ProgressAt:30000};
 const active=view.render({},base,helpers);assert.match(active,/Source Course Creation Progress/);assert.match(active,/Creating Source Courses/);assert.match(active,/40%/);assert.match(active,/4<\/strong> \/ 10/);assert.match(active,/Registration pending/);assert.match(active,/Approximate remaining time: 45s/);
 const recon=view.render({}, {...base,creationSummary:{...base.creationSummary,created:9},totals:{created:9,skipped:1},templateReconciliationPlan:[{templateId:'10'}]},{...helpers,now:()=>60000});assert.match(recon,/Reconciling template parents/);assert.match(recon,/100%/);assert.match(recon,/Source Course creation is complete\. Template parent reconciliation is still in progress\./);assert.doesNotMatch(recon,/Approximate remaining time:|ETA: \d/);
 const completed=view.render({}, {...base,status:'completed',creationSummary:{total:2,created:2},totals:{created:2},step3StartedAt:null,step3ElapsedMs:5000},{...helpers,now:()=>60000});assert.match(completed,/100%/);assert.match(completed,/Final elapsed: 5s/);assert.match(completed,/Creation and template reconciliation complete/);
 const cancelled=view.render({}, {...base,status:'cancelled',creationSummary:{total:2,created:1,notAttempted:1},totals:{created:1,notAttempted:1},step3StartedAt:null,step3ElapsedMs:5000},{...helpers,now:()=>60000});assert.match(cancelled,/50%/);assert.match(cancelled,/Creation cancelled/);assert.match(cancelled,/Not attempted/);
 const interrupted=creationProgress.step3({...base,status:'interrupted',step3StartedAt:null,step3ElapsedMs:9000},60000);assert.equal(interrupted.percent,40);assert.equal(interrupted.estimate,'Progress paused — ETA unavailable');
 assert.equal(creationProgress.step3({status:'queued',tasks:[],creationSummary:{total:0}},1000).percent,0);assert.equal(creationProgress.step3({status:'completed',tasks:[],creationSummary:{total:0}},1000).percent,100);
});
