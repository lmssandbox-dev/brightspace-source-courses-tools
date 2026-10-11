'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseCreationCsv,createCreationJobs}=require('../src/creation/jobs');
const {createOrgResolver}=require('../src/resolution/resolver');
const {createCreationClient}=require('../src/creation/client');
const {createBulkJobs}=require('../src/shared/jobs');
const {createBulkDates}=require('../src/shared/routes');
const {createCreationView}=require('../src/creation/view');
const row=(Identifier,Code,Type='CourseTemplate',Name='Template')=>({Identifier,Code,Type:{Code:Type},Name});
test('Source Course CSV enforces the agreed headers, fields and row/byte limits',()=>{
 assert.deepEqual(parseCreationCsv('SourceCourseName,SourceCourseCode,TemplateId,TemplateCode\nBio,BIO,123,').map(r=>r.row),[2]);
 const spaced=parseCreationCsv('SourceCourseName,SourceCourseCode,TemplateId,TemplateCode\n" Bio "," BIO ",123,');assert.equal(spaced[0].sourceCourseName,'Bio');assert.equal(spaced[0].sourceCourseNameInput,' Bio ');assert.equal(spaced[0].sourceCourseCodeInput,' BIO ');
 assert.deepEqual(parseCreationCsv('SourceCourseName,SourceCourseCode,TemplateId,TemplateCode\nBio,BIO,123,\n\n"Multi\nline",MULTI,123,').map(r=>r.row),[2,4]);
 assert.throws(()=>parseCreationCsv('Name,Code,TemplateId,TemplateCode\nBio,BIO,1,'),{code:'INVALID_CSV'});
 assert.throws(()=>parseCreationCsv('SourceCourseName,SourceCourseCode,TemplateId,TemplateCode\n'+Array.from({length:10001},(_,i)=>`N${i},C${i},1,`).join('\n')),{code:'INVALID_CSV'});
 assert.throws(()=>parseCreationCsv('x'.repeat(5*1024*1024+1)),{code:'INVALID_CSV'});
});
test('planning validates templates by ID/code, rejects duplicates and conflicts, and keeps partial-valid rows',async()=>{
 const templates=new Map([['10',row('10','T-ID')],['20',row('20','T-CODE')]]),byCode=new Map([...templates.values()].map(t=>[t.Code,t])),existing=new Map([['EXIST',[row('30','EXIST','SourceCourse')]],['OTHER',[row('31','OTHER','Department')]]]);
 const api={read:async url=>templates.get(url.split('/').at(-1)),list:async url=>{const code=new URL(url).searchParams.get('exactOrgUnitCode');return byCode.has(code)?[byCode.get(code)]:existing.get(code)||[];}};
 const orgResolver=createOrgResolver({store:{lookup:async()=>{const m=new Map();m.safeCodes=new Set();return m;},remember:async()=>{}},api,root:'https://tenant.example/d2l/api/lp/1.60'});
 const client={orgUnit:async v=>templates.get(v),exactCode:async code=>existing.get(code)||[]};const feature=createCreationJobs({client,orgResolver,store:{registerCreated:async()=>{}},now:()=>1000});
 const csv='SourceCourseName,SourceCourseCode,TemplateId,TemplateCode\nBio,BIO,10,\nChem,CHEM,,T-CODE\nDuplicate,DUP,10,\nDuplicate again,DUP,10,\nExists,EXIST,10,\nConflict,OTHER,10,\nWrong type,WRONG,10,';
 const job={rows:parseCreationCsv(csv),tasks:[],status:'planning'};await feature.plan(job,async()=>{});
 assert.equal(job.status,'ready');assert.deepEqual(job.tasks.map(t=>[t.row,t.TemplateId]),[[2,'10'],[3,'20'],[8,'10']]);assert.equal(job.rows.find(r=>r.row===4).status,'invalid');assert.equal(job.rows.find(r=>r.row===5).status,'invalid');assert.equal(job.rows.find(r=>r.row===6).status,'skipped');assert.equal(job.rows.find(r=>r.row===7).status,'invalid');assert.equal(job.rows.find(r=>r.row===8).status,'eligible');
 assert.equal(job.tasks.length,3);
});
test('creation saves confirmed Org Unit ID before registration and registration retries never POST again',async()=>{
 let posts=0,registrations=0;const feature=createCreationJobs({client:{exactCode:async()=>[],create:async task=>{posts++;return {status:'created',orgUnitId:'101'};}},orgResolver:{prepare:async()=>({resolve:async()=>row('10','T','CourseTemplate')})},store:{registerCreated:async()=>{if(++registrations===1)throw Error('temporary Mongo failure');}},now:()=>2000});
 const job={_id:'j',owner:'o',status:'running',tasks:[{row:2,Name:'Bio',Code:'BIO',TemplateId:'10',TemplateCode:'T'}],rows:[],step3StartedAt:1000};let saves=0;const save=async()=>{saves++;};await assert.rejects(feature.execute(job,save,async()=>{},async()=>false));
 assert.equal(job.tasks[0].result.status,'created');assert.equal(job.tasks[0].result.CreatedOrgUnitId,'101');assert.equal(job.tasks[0].result.registration,'pending');
 // Recovery starts with a confirmed result and performs only the idempotent database registration.
 job.status='running';await feature.execute(job,save,async()=>{},async()=>false);assert.equal(posts,1);assert.equal(registrations,2);assert.equal(job.tasks[0].result.registration,'ready');assert.ok(saves>=3);
});
test('a cancellation stops later dispatches and uncertain submissions are never replayed',async()=>{
 let posts=0,checks=0;const feature=createCreationJobs({client:{exactCode:async()=>{checks++;return [];},create:async()=>{posts++;return {status:'uncertain',message:'unknown'};}},orgResolver:{},store:{registerCreated:async()=>{}}});
 const job={_id:'j',owner:'o',status:'running',tasks:[{row:2,Name:'A',Code:'A',TemplateId:'1'},{row:3,Name:'B',Code:'B',TemplateId:'1'}],rows:[],step3StartedAt:1};let save=async()=>{};await feature.execute(job,save,async()=>{},async()=>true);assert.equal(posts,0);assert.equal(checks,0);assert.ok(job.tasks.every(t=>t.result.status==='notAttempted'));
});
test('creation runs at most eight requests at once and cancellation drains them before stopping dispatch',async()=>{
 let active=0,maxActive=0,posts=0,cancelled=false,release;const gate=new Promise(resolve=>{release=resolve;});let reachedEight;const eight=new Promise(resolve=>{reachedEight=resolve;});
 const feature=createCreationJobs({client:{exactCode:async()=>[],create:async task=>{posts++;active++;maxActive=Math.max(maxActive,active);if(active===8)reachedEight();await gate;active--;return {status:'created',orgUnitId:String(100+Number(task.Code.slice(1)))};}},orgResolver:{},store:{registerCreated:async()=>{}},now:()=>10});
 const job={_id:'parallel',owner:'o',status:'running',tasks:Array.from({length:9},(_,i)=>({row:i+2,Name:`Course ${i}`,Code:`C${i}`,TemplateId:'1'})),rows:[],step3StartedAt:1};
 const execution=feature.execute(job,async()=>{},async()=>{},async()=>cancelled);
 let timeout;const reached=await Promise.race([eight.then(()=>true),new Promise(resolve=>{timeout=setTimeout(()=>resolve(false),1000);})]);clearTimeout(timeout);cancelled=true;release();await execution;
 assert.equal(reached,true);assert.equal(maxActive,8);assert.equal(posts,8);assert.equal(active,0);assert.equal(job.status,'cancelled');assert.equal(job.tasks.filter(task=>task.result?.status==='created').length,8);assert.equal(job.tasks.filter(task=>task.result?.status==='notAttempted').length,1);
});
test('an uncertain creation outcome stays inspectable and is never replayed after recovery',async()=>{
 let posts=0;const feature=createCreationJobs({client:{exactCode:async()=>[],create:async()=>{posts++;return {status:'uncertain',message:'Creation outcome is unconfirmed.'};}},orgResolver:{},store:{registerCreated:async()=>{}}});
 const job={_id:'uncertain',owner:'o',status:'running',tasks:[{row:2,Name:'Biology',Code:'BIO',TemplateId:'10'}],rows:[],step3StartedAt:1};await feature.execute(job,async()=>{},async()=>{},async()=>false);assert.equal(job.tasks[0].result.status,'uncertain');
 job.status='running';await feature.execute(job,async()=>{},async()=>{},async()=>false);assert.equal(posts,1);assert.equal(job.tasks[0].result.status,'uncertain');
});
test('Brightspace Source Course client uses LP 1.60 endpoint, scope-ready contract and returned ID',async()=>{
 let config;const client=createCreationClient({api:{read:async()=>({}),list:async()=>[]},http:async c=>{config=c;return {status:200,data:{OrgUnitId:123}};},oauth:{getAccessToken:async()=>'token'},baseUrl:'https://tenant.example',lpVersion:'1.60'});
 const result=await client.create({Name:'Biology',Code:'BIO',TemplateId:'10'},async()=>{});assert.deepEqual(result,{status:'created',orgUnitId:'123'});assert.equal(config.url,'https://tenant.example/d2l/api/lp/1.60/sourceCourses/');assert.deepEqual(config.data,{Name:'Biology',Code:'BIO',TemplateId:10});
 const old=createCreationClient({api:{},http:async()=>{},oauth:{},baseUrl:'https://tenant.example',lpVersion:'1.59'});await assert.rejects(old.create({Name:'A',Code:'A',TemplateId:'1'},async()=>{}),{code:'LP_VERSION_UNSUPPORTED'});
});
test('creation overlay is included in resolver lookup while live exact-code results still detect collisions',async()=>{
 const created={Identifier:'101',Code:'BIO',Name:'Biology',Type:{Code:'Source Course'},provenance:'creation'};let live=[{Identifier:'101',Code:'BIO',Name:'Biology',Type:{Code:'Source Course'}}];
 const resolver=createOrgResolver({root:'https://tenant.example/d2l/api/lp/1.60',store:{lookup:async()=>{const m=new Map([['BIO',[created]]]);m.safeCodes=new Set();return m;},remember:async()=>{}},api:{list:async()=>live}});
 assert.equal((await (await resolver.prepare(['BIO'])).resolve('BIO')).Identifier,'101');live=[...live,{Identifier:'202',Code:'BIO',Name:'Other',Type:{Code:'CourseOffering'}}];
 await assert.rejects((await resolver.prepare(['BIO'])).resolve('BIO'),{code:'CODE_NOT_UNIQUE'});
});
test('sourceCreation uses the shared saved-plan confirmation, owner-scoped route and Job History kind',async()=>{
 const docs=new Map();let held=false,posts=0;const store={insert:async j=>docs.set(j._id,structuredClone(j)),get:async(id,owner)=>docs.get(id)?.owner===owner?structuredClone(docs.get(id)):null,getStatus:async(id,owner)=>docs.get(id)?.owner===owner?{...docs.get(id),rows:undefined,tasks:undefined}:null,list:async(owner,kind)=>[...docs.values()].filter(j=>j.owner===owner&&j.kind===kind),acquire:async()=>{if(held)return false;held=true;return true;},release:async()=>{held=false;},renew:async()=>{},claim:async()=>{const j=[...docs.values()].find(x=>['validating','queued'].includes(x.status));if(!j)return null;j.status=j.status==='validating'?'planning':'running';docs.set(j._id,structuredClone(j));return structuredClone(j);},save:async j=>docs.set(j._id,structuredClone(j)),confirm:async(id,owner)=>{const j=docs.get(id);if(!j||j.owner!==owner||j.status!=='ready')return false;j.status='queued';return true;},cancel:async()=>false,isCancelled:async()=>false};
 const feature={parse:()=>[{row:2,sourceCourseName:'Bio',sourceCourseCode:'BIO',status:'pending'}],plan:async(job)=>{job.rows[0].status='eligible';job.tasks=[{row:2,Code:'BIO',result:null}];job.status='ready';job.expiresAt=99999;},execute:async(job,save)=>{posts++;job.tasks[0].result={status:'created',CreatedOrgUnitId:'101'};job.status='completed';await save(job,{tasks:[0]});}};
 const token={iss:'issuer',deploymentId:'d',user:'u'},owner=require('node:crypto').createHash('sha256').update(JSON.stringify([token.iss,token.deploymentId,token.user])).digest('hex');
 const jobs=createBulkJobs({store,sourceCreation:feature,now:()=>1,courses:{},discovery:{},writers:{},writeEnabled:()=>true});const job=await jobs.create({owner,kind:'sourceCreation',csv:'ignored'});assert.equal(job.kind,'sourceCreation');await jobs.tick();assert.equal((await jobs.get(job._id,owner)).status,'ready');assert.equal(posts,0);assert.equal(await jobs.list(owner,'sourceCreation').then(a=>a.length),1);
 const routes=createBulkDates({jobs,deploymentId:'d',secret:'s',kind:'sourceCreation',now:()=>1,view:createCreationView({canApply:()=>true})});const formRes={locals:{ltik:'session',token}},data=Buffer.from(JSON.stringify({kind:'sourceCreation',action:'apply',id:job._id,session:require('node:crypto').createHash('sha256').update('session').digest('hex'),expires:1800001})).toString('base64url'),ticket=data+'.'+require('node:crypto').createHmac('sha256','s').update(data).digest('hex');const res={locals:formRes.locals,set(){return this;},status(n){this.code=n;return this;},send(body){this.body=body;return this;}};
 await routes.apply({body:{ltik:'session',ticket,jobId:job._id,confirmCreation:'yes'},headers:{}},res);assert.notEqual(res.code,403);assert.equal(posts,0);await jobs.tick();assert.equal(posts,1);
});
