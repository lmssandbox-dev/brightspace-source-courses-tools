'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseCreationCsv,createCreationJobs,HEADERS}=require('../src/creation/jobs');
const {createCreationClient}=require('../src/creation/client');
const {createCreationView}=require('../src/creation/view');
const {createOrgResolver}=require('../src/resolution/resolver');
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

test('invalid or missing Department lists and unknown duplicate lifecycle evidence fail per row',async()=>{
 const fixture=resolverFixture({matches:{UNKNOWN:{error:Object.assign(Error('Lifecycle status unknown'),{code:'CODE_STATUS_UNKNOWN'})}}}),feature=makeFeature(fixture),job={rows:parse(['Missing,MISSING,10,,,','Both,BOTH,10,,50,D1','Repeated,REPEATED,10,,50|50,','Bad ID,BADID,10,,50|x,','Unknown,UNKNOWN,10,,50,']),tasks:[],status:'planning'};
 await feature.plan(job,async()=>{});assert.equal(job.tasks.length,0);assert.ok(job.rows.every(row=>row.status==='invalid'));assert.match(job.rows[0].message,/exactly one/);assert.match(job.rows[1].message,/exactly one/);assert.match(job.rows[2].message,/unique/);assert.match(job.rows[3].message,/positive integers/);assert.match(job.rows[4].message,/Lifecycle status/);
});

test('shared duplicate-aware resolver batches unique codes and fails only codes with unknown live lifecycle',async()=>{
 let lookups=0;const cached={Identifier:'70',Code:'MIX',Name:'Old',Type:{Code:'SourceCourse'},lifecycle:'recycled'},second={Identifier:'71',Code:'MIX',Name:'Current',Type:{Code:'SourceCourse'},lifecycle:'current'};
 const store={lookup:async codes=>{lookups++;const map=new Map([['MIX',[cached,second]],['UNKNOWN',[{Identifier:'99',Code:'UNKNOWN',Type:{Code:'SourceCourse'},lifecycle:'unknown'}]]]);map.safeCodes=new Set();return map;},remember:async()=>{}};
 const apiCalls=[];const resolver=createOrgResolver({store,root:'https://tenant.example/d2l/api/lp/1.60',api:{list:async url=>{const code=new URL(url).searchParams.get('exactOrgUnitCode');apiCalls.push(code);return code==='MIX'?[{Identifier:'70',Code:'MIX',Type:{Code:'SourceCourse'}},{Identifier:'71',Code:'MIX',Type:{Code:'SourceCourse'}}]:code==='NEW'?[{Identifier:'88',Code:'NEW',Type:{Code:'CourseOffering'}}]:[{Identifier:'99',Code:'UNKNOWN',Type:{Code:'SourceCourse'}}];}}});
 const result=await resolver.lookupMatches(['MIX','MIX','NEW','UNKNOWN']);assert.equal(lookups,1);assert.deepEqual(apiCalls.sort(),['MIX','NEW','UNKNOWN']);assert.equal(result.get('MIX').length,2);assert.deepEqual(result.get('MIX').map(item=>item.lifecycle).sort(),['current','recycled']);assert.equal(result.get('NEW').error.code,'CODE_STATUS_UNKNOWN');assert.equal(result.get('UNKNOWN').error.code,'CODE_STATUS_UNKNOWN');
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

test('API client uses documented parent list/add/remove routes and numeric add payload',async()=>{
 const calls=[],client=createCreationClient({api:{read:async url=>{calls.push(['GET',url]);return url.endsWith('/parents/')?[]:{Identifier:7};},list:async()=>[]},http:async config=>{calls.push([config.method,config.url,config.data]);return {status:200,data:{OrgUnitId:123}};},oauth:{getAccessToken:async()=>'token'},baseUrl:'https://tenant.example',lpVersion:'1.60'});
 assert.deepEqual(await client.parents('10'),[]);assert.equal(await client.rootOrgUnitId(),'7');assert.deepEqual(await client.addParent('10','50'),{status:'succeeded'});assert.deepEqual(await client.removeParent('10','50'),{status:'succeeded'});
 assert.deepEqual(calls[2],['POST','https://tenant.example/d2l/api/lp/1.60/orgstructure/10/parents/',50]);assert.equal(calls[3][1],'https://tenant.example/d2l/api/lp/1.60/orgstructure/10/parents/50');
 const result=await client.create({Name:'Bio',Code:'BIO',TemplateId:'10'},async()=>{});assert.deepEqual(result,{status:'created',orgUnitId:'123',submissionAttempted:true});
});

test('lightweight status projection without rows or tasks renders, and report includes parenting fields',()=>{
 const view=createCreationView(),html=view.render({},{_id:'j',status:'completed',creationSummary:{eligible:2,skipped:1,invalid:0,created:2,total:2},totals:{created:2}}, {controls:()=>'',button:()=>'',now:()=>1});
 assert.match(html,/CSV rows/);const csv=view.report({rows:[{row:2,sourceCourseName:'A',sourceCourseCode:'A',templateId:'10',resolvedDepartmentIds:'50',resolvedDepartmentCodes:'D1'}],tasks:[{row:2,TemplateId:'10',TemplateCode:'T1',result:{status:'created',CreatedOrgUnitId:'100'}}],templateReconciliation:{'10':{status:'Updated',message:'Parent relationship updates completed successfully.'}}});
 assert.match(csv,/DepartmentIds/);assert.match(csv,/Parent relationship updates completed successfully/);assert.match(csv,/\"50\"/);
});
