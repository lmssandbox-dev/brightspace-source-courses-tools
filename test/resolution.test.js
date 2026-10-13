'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const {mkdtemp,writeFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os'),path=require('node:path'),{crc32}=require('node:zlib');
const {createOrgResolver}=require('../src/resolution/resolver');
const {createResolutionStore,mergeMatches,namespaceFor}=require('../src/resolution/store');
const {createDirectorySync,nextNight,selectExtracts}=require('../src/resolution/sync');
const {normalize,readZip,createExtractReader}=require('../src/resolution/extract');
const {parseDepartmentTypeId}=require('../src/resolution/runtime');
const {createResolutionRuntime}=require('../src/resolution/runtime');
const {createCopyResolver}=require('../src/copy/resolver');
const {createCoursesClient}=require('../src/shared/courses');
const {createDeploymentJobs}=require('../src/replication/jobs');
const root='https://tenant.example/d2l/api/lp/1.63';
const record=(Identifier,Code,observedAt=1,deleted=false)=>({Identifier,Code,Name:'Course',Type:{Code:'CourseOffering'},observedAt,lifecycle:deleted?'deleted':'current',deleted});
const cached=(entries,safe=[])=>{const result=new Map(entries);result.safeCodes=new Set(safe);return result;};
const noApi={async list(){assert.fail('unexpected API lookup');},async read(){assert.fail('unexpected API read');}};
const datasetRow=row=>({OrgUnitTypeId:{'Course Offering':'3','Source Course':'2','Course Template':'4'}[String(row.Type||'').trim()]||(['Department','Departamento','Unidade Departamental'].includes(String(row.Type||'').trim())?'170':'250'),DeletedDate:'',RecycledDate:'',...row});
test('shared warm cache resolves codes once and IDs-only preparation does not touch Mongo',async()=>{
 let reads=0;const resolver=createOrgResolver({store:{async lookup(codes){reads++;assert.deepEqual(codes,['A']);return cached([['A',[record('1','A')]],],['A']);}},api:noApi,root});
 await resolver.prepare([]);assert.equal(reads,0);const session=await resolver.prepare(['A','A']);assert.equal((await session.resolve('A')).Identifier,'1');await session.resolve('A');assert.equal(reads,1);
});
test('externally created Source Course resolves by code from one complete live result and caches lower-assurance evidence',async()=>{
 let calls=0,writes=0,saved;
 const resolver=createOrgResolver({root,store:{lookup:async()=>cached(new Map()),async remember(code,matches,verifiedAt){writes++;saved={code,matches,verifiedAt};}},api:{async list(url,raw,options){calls++;assert.equal(new URL(url).searchParams.get('exactOrgUnitCode'),'source_date_manager_test');assert.equal(options.maxPages,100);return [{Identifier:'71286',Code:'source_date_manager_test',Name:'Test Source',Type:{Id:8,Code:'SourceCourse'}}];}}});
 const session=await resolver.prepare(['source_date_manager_test']);const result=await Promise.all(Array.from({length:8},()=>session.resolve('source_date_manager_test')));
 assert.ok(result.every(row=>row.Identifier==='71286'&&row.lifecycle==='live-verified'));assert.equal(calls,1);assert.equal(writes,1);assert.equal(saved.code,'source_date_manager_test');assert.equal(saved.matches[0].provenance,'live-verified');assert.ok(Number.isFinite(saved.verifiedAt));
});
test('ambiguous cache is checked live; missing and genuinely ambiguous API results remain errors',async()=>{
 let calls=0;const resolver=createOrgResolver({root,store:{lookup:async()=>cached([['A',[record('1','A'),record('2','A')]]]),remember:async()=>{}},api:{list:async url=>{calls++;return new URL(url).searchParams.get('exactOrgUnitCode')==='A'?[record('1','A'),record('2','A')]:[];}}});
 const session=await resolver.prepare(['A','missing']);await assert.rejects(session.resolve('A'),{code:'CODE_NOT_UNIQUE'});await assert.rejects(session.resolve('missing'),{code:'CODE_NOT_FOUND'});assert.equal(calls,2);
});
test('unique filtered cache sees a competing organizational-unit type and rejects the duplicate code',async()=>{
 let calls=0;const resolver=createOrgResolver({root,store:{lookup:async()=>new Map([['A',[record('1','A')]]]),remember:async()=>{}},api:{list:async()=>{calls++;return [record('1','A'),{Identifier:'99',Code:'A',Name:'Template',Type:{Code:'Course Template'}}];}}});
 await assert.rejects((await resolver.prepare(['A'])).resolve('A'),{code:'CODE_NOT_UNIQUE'});assert.equal(calls,1);
});
test('live code and ID pair checks identity while ID-only resolution bypasses the code service',async()=>{
 let calls=0;const resolver=createOrgResolver({root,store:{lookup:async()=>cached(new Map()),remember:async()=>{}},api:{list:async()=>{calls++;return [{Identifier:'71286',Code:'EXT',Name:'External',Type:{Id:8}}];}}});
 const client=createCoursesClient({baseUrl:'https://tenant.example',lpVersion:'1.63',orgResolver:resolver,api:noApi}),session=await client.prepare([{orgUnitCode:'EXT'}]);
 assert.equal((await client.resolve({orgUnitId:'71286',orgUnitCode:'EXT'},{resolver:session})).orgUnitId,'71286');
 await assert.rejects(client.resolve({orgUnitId:'71287',orgUnitCode:'EXT'},{resolver:session}),{code:'ID_CODE_MISMATCH'});
 assert.equal((await client.resolve({orgUnitId:'71286',orgUnitCode:''})).orgUnitId,'71286');assert.equal(calls,1);
});
test('empty archived results, known recycled evidence, malformed pages, and API failures fail safely',async()=>{
 const make=async(list,known=[])=>{const resolver=createOrgResolver({root,store:{lookup:async()=>cached(known.length?[['A',known]]:new Map()),remember:async()=>{}},api:{list}});return resolver.prepare(['A']);};
 await assert.rejects((await make(async()=>[])).resolve('A'),{code:'CODE_NOT_FOUND'});
 await assert.rejects((await make(async()=>[record('1','A')],[{...record('1','A',1,true),lifecycle:'recycled'}])).resolve('A'),{code:'CODE_STATUS_UNKNOWN'});
 await assert.rejects((await make(async()=>[{Identifier:'1',Code:'A',Name:'A'}])).resolve('A'),{code:'LIVE_LOOKUP_INCOMPLETE'});
 await assert.rejects((await make(async()=>{throw Object.assign(Error('secret'),{status:403});})).resolve('A'),{code:'LIVE_LOOKUP_FAILED',status:403});
 await assert.rejects((await make(async()=>{throw Error('Missing pagination bookmark');})).resolve('A'),{code:'LIVE_LOOKUP_INCOMPLETE'});
});
test('unique live evidence may resolve an unknown dataset lifecycle, but deleted evidence remains blocked',async()=>{
 const unknown={...record('1','A'),lifecycle:'unknown'};
 const resolveWith=async evidence=>{const resolver=createOrgResolver({root,store:{lookup:async()=>cached([['A',[evidence]]]),remember:async()=>{}},api:{list:async()=>[{Identifier:'1',Code:'A',Name:'Current',Type:{Id:3,Code:'CourseOffering'}}]}});return (await resolver.prepare(['A'])).resolve('A');};
 const verified=await resolveWith(unknown);assert.equal(verified.Identifier,'1');assert.equal(verified.lifecycle,'live-verified');
 await assert.rejects(resolveWith({...unknown,lifecycle:'deleted',deleted:true}),{code:'CODE_STATUS_UNKNOWN'});
});
test('unique live answer replaces ambiguous cache and concurrent rows share the lookup',async()=>{
 let calls=0,saved,verified=false;const cache=new Map([['A',[record('1','A'),record('2','A')]]]);
 const resolver=createOrgResolver({root,store:{lookup:async()=>cached(cache,verified?cache.keys():[]),remember:async(code,records)=>{saved=records;cache.set(code,records);verified=true;}},api:{list:async()=>{calls++;return [record('2','A')];}}});
 const session=await resolver.prepare(['A']);const rows=await Promise.all(Array.from({length:8},()=>session.resolve('A')));assert.ok(rows.every(r=>r.Identifier==='2'));assert.equal(calls,1);assert.equal(saved[0].Identifier,'2');assert.equal(saved[0].lifecycle,'current');
 await (await resolver.prepare(['A'])).resolve('A');assert.equal(calls,1);
});

test('fresh live mappings survive old fulls; newer full/differentials invalidate renames/deletions',()=>{
 const old=record('1','A',100),overlay={verifiedAt:200,matches:[old]};
 assert.deepEqual(mergeMatches('A',[],overlay,new Map(),100),[old]);
 assert.deepEqual(mergeMatches('A',[],overlay,new Map(),300),[]);
 const renamed=record('1','B',300);assert.deepEqual(mergeMatches('A',[],overlay,new Map([['1',renamed]]),100),[]);
 const deleted=record('1','A',300,true);assert.deepEqual(mergeMatches('A',[deleted],overlay,new Map([['1',deleted]]),100),[deleted]);
 const duplicate=record('2','A',300);assert.equal(mergeMatches('A',[duplicate],overlay,new Map([['2',duplicate]]),100).length,2);
 assert.notEqual(namespaceFor('https://one.example','client'),namespaceFor('https://two.example','client'));
 assert.notEqual(namespaceFor('https://one.example','client'),namespaceFor('https://one.example','other'));
});
test('Course Copy cached ID+code mismatch is rejected and IDs use no API',async()=>{
 const orgResolver=createOrgResolver({root,api:noApi,store:{lookup:async()=>cached([['A',[record('1','A')]]],['A'])}});
 const resolve=await createCopyResolver({api:noApi,root,orgResolver})([{originCode:'A'}],async()=>{},async()=>{},{direct:true});
 await assert.rejects(resolve({originCode:'A',originId:'9'},'origin'),/different/);
 assert.equal((await resolve({originId:'8'},'origin')).orgUnitId,'8');
});
test('Date Manager uses shared code directory without course-detail requests',async()=>{
 let gets=0;const orgResolver=createOrgResolver({root,api:noApi,store:{lookup:async()=>cached([['A',[record('1','A')]]],['A'])}});
 const client=createCoursesClient({baseUrl:'https://tenant.example',lpVersion:'1.63',orgResolver,api:{...noApi,async read(){gets++;return record('1','A');}}});
 const resolver=await client.prepare([{orgUnitCode:'A'}]);
 await assert.rejects(client.resolve({orgUnitCode:'A',orgUnitId:'2'},{resolver}),{code:'ID_CODE_MISMATCH'});assert.equal(gets,0);
 assert.equal((await client.resolve({orgUnitCode:'A'},{resolver})).orgUnitId,'1');assert.equal(gets,0);
});
test('Source Deployer uses cached pairs and excludes mismatches',async()=>{
 const orgResolver=createOrgResolver({root,api:noApi,store:{lookup:async()=>cached([['A',[record('1','A')]],['B',[record('2','B')]]],['A','B'])}});
 const jobs=createDeploymentJobs({orgResolver,client:{},enabled:()=>true});const rows=jobs.parse('SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n1,A,2,B\n9,A,3,');
 const job={rows,tasks:[],courses:[]};await jobs.plan(job,async()=>{});assert.equal(rows[0].status,'valid');assert.equal(rows[1].status,'invalid');
});
function fixture({broken=false}={}){
 const staged=new Map();let state={generation:'old',asOf:0},publishes=0,finished;
 const extract=(BdsType,at)=>({SchemaId:'schema',BdsType,QueuedForProcessingDate:new Date(at).toISOString(),Version:'11',DownloadLink:root+'/'+at});
 const extracts=[extract('Differential',3000),extract('Full',1000),extract('Differential',2000),extract('Full',500)];
 const store={claim:async()=> 'lease',renew:async()=>{},status:async()=>state,stage:async(g,rows)=>{for(const row of rows)staged.set(row.Identifier,row);},remove:async(g,ids)=>{for(const id of ids)staged.delete(id);},publish:async(t,g,fullAt,asOf,summary)=>{publishes++;state={generation:g,fullAt,asOf,...summary};},finish:async(t,next,error)=>{finished={next,error};},cleanup:async()=>{},discard:async()=>{staged.clear();}};
 const api={list:async url=>url.endsWith('/datasets/bds')?[{SchemaId:'schema',Full:{Name:'Organizational Units'},ExtractsLink:root+'/extracts'}]:extracts};
 const readExtract=async(e,consume)=>{if(broken&&e.at===3000)throw Object.assign(Error('bad archive'),{code:'BAD_ZIP'});await consume(datasetRow({OrgUnitId:'1',Code:e.at>=2000?'B':'A',Name:'n',Type:'Source Course',IsDeleted:e.at===3000?'1':'0'}));};
 return {store,api,readExtract,staged,get state(){return state;},get publishes(){return publishes;},get finished(){return finished;}};
}
test('nightly full plus ordered differentials publish lifecycle evidence atomically',async()=>{
 const f=fixture();const sync=createDirectorySync({...f,root,now:()=>10000});await sync.run();assert.equal(f.publishes,1);assert.equal(f.state.asOf,3000);assert.equal(f.staged.get('1').lifecycle,'deleted');
 await sync.run();assert.equal(f.publishes,1);
});
test('failed differential preserves previous published snapshot and schedules retry',async()=>{
 const f=fixture({broken:true});await assert.rejects(createDirectorySync({...f,root,now:()=>10000}).run(),{code:'BAD_ZIP'});assert.equal(f.state.generation,'old');assert.equal(f.publishes,0);assert.equal(f.staged.size,0);assert.equal(f.finished.next,3610000);
});
test('no lease prevents download; no full prevents publishing',async()=>{
 const f=fixture();f.store.claim=async()=>null;assert.equal((await createDirectorySync({...f,root}).run()).skipped,'not_due_or_running');assert.equal(f.publishes,0);
 assert.throws(()=>selectExtracts([],'schema'),{code:'DATASET_FULL_MISSING'});
 assert.equal(new Date(nextNight(Date.parse('2026-10-06T07:00:00Z'),6)).toISOString(),'2026-10-07T06:00:00.000Z');
});
test('normalization preserves Source Course type and excludes deletion timestamps despite false flag',()=>{
 const row=datasetRow({OrgUnitId:'12',Code:' a ',Name:'N',Type:'Source Course',IsDeleted:'false',DeletedDate:'old'});
 const value=normalize(row,1);assert.equal(value.Code,' a ');assert.equal(value.Type.Code,'Source Course');assert.equal(value.Type.Name,'Source Course');assert.equal(value.Type.Id,2);assert.equal(value.deleted,true);
 assert.throws(()=>normalize({...row,IsDeleted:'maybe'},1));
});
// Minimal stored ZIP fixture with a valid CRC; no extra test dependency.
function zipCsv(text){
 const name=Buffer.from('OrganizationalUnits.csv'),data=Buffer.from(text),crc=crc32(data),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
 local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
 central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
 end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+data.length,16);
 return Buffer.concat([local,name,data,central,name,end]);
}
const csv='OrgUnitId,OrgUnitTypeId,Code,Name,Type,IsDeleted\n1,3,ABC,Example,Course Offering,0\n';
test('ZIP CSV streams rows and rejects bad schema or corruption',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'resolution-test-')),file=path.join(dir,'test.zip');
 try{await writeFile(file,zipCsv(csv));const rows=[];await readZip(file,async r=>rows.push(r));assert.equal(rows[0].Code,'ABC');
 await writeFile(file,zipCsv('Bad,Headers\n1,2'));await assert.rejects(readZip(file,async()=>{}),{code:'DATASET_HEADERS'});
 const corrupt=zipCsv(csv);corrupt[60]^=1;await writeFile(file,corrupt);await assert.rejects(readZip(file,async()=>{}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('download follows signed HTTPS redirect without forwarding OAuth token',async()=>{
 let external=false;const reader=createExtractReader({baseUrl:'https://tenant.example',oauth:{getAccessToken:async()=> 'secret'},http:async cfg=>{assert.equal(cfg.headers.Authorization,'Bearer secret');return {status:302,headers:{location:'https://downloads.example/signed'},data:Readable.from([])};},downloadHttp:async cfg=>{external=true;assert.deepEqual(cfg.headers,{});assert.equal(cfg.maxRedirects,0);return {status:200,data:Readable.from([zipCsv(csv)])};}});
 const rows=[];await reader({DownloadLink:root+'/download'},async r=>rows.push(r));assert.ok(external);assert.equal(rows.length,1);
 await assert.rejects(reader({DownloadLink:'https://other.example/steal'},async()=>{}),{code:'DATASET_DOWNLOAD_URL'});
});
test('Mongo cache lookup uses 500-code batches with four concurrent batches and preserves tenant snapshot results',async()=>{
 const {createResolutionStore}=require('../src/resolution/store');const calls=[];let active=0,peak=0;
 const collection=name=>({
  createIndex:async()=>{},findOne:async()=>({generation:'g',fullAt:1}),
  find:filter=>({toArray:async()=>{
   calls.push({name,filter});
   if(name==='org_resolution_live'){peak=Math.max(peak,++active);await new Promise(resolve=>setImmediate(resolve));active--;return [];}
   if(name==='org_resolution_created')return [];
   return filter.$or[0].Code.$in.map(code=>record(`id-${code}`,code));
  }})
 });
 const store=createResolutionStore({uri:'mongodb://localhost/app',namespace:'tenant-client',mongoClient:{connect:async()=>{},db:()=>({collection})}});
 const codes=Array.from({length:5000},(_,i)=>'C'+i),found=await store.lookup(codes);assert.equal(calls.length,30);assert.equal(peak,4);assert.equal(found.size,5000);
 assert.deepEqual([...found.keys()],codes);assert.deepEqual(found.get('C2500'),[record('id-C2500','C2500')]);
 for(const c of calls){assert.equal(c.filter.namespace,'tenant-client');if(c.name==='org_resolution_live')assert.equal(c.filter._id.$in.length,500);if(c.name==='org_resolution_units'){assert.equal(c.filter.generation,'g');assert.equal(c.filter.$or[0].Code.$in.length,500);}}
});
test('Mongo publish/renew are fenced, caches treat dollar-prefixed codes literally',async()=>{
 const {createResolutionStore}=require('../src/resolution/store');const calls=[];
 const collection=name=>({createIndex:async()=>{},findOne:async()=>null,updateOne:async(filter,update)=>{calls.push({name,filter,update});return {matchedCount:0};}});
 const store=createResolutionStore({uri:'mongodb://localhost/app',namespace:'n',now:()=>100,mongoClient:{connect:async()=>{},db:()=>({collection})}});
 await assert.rejects(store.publish('lease','new',10,20,{}),{code:'RESOLUTION_PUBLISH_REJECTED'});
 assert.equal(calls[0].filter.token,'lease');assert.equal(calls[0].filter.leaseUntil.$gt,100);
 await assert.rejects(store.renew('lease'),{code:'RESOLUTION_LEASE_LOST'});
 await store.remember('$code',[record('1','$code')],200);assert.deepEqual(calls.at(-1).update[0].$set.code,{$literal:'$code'});
});
test('published Org Library status tracks only asOf, refreshes after publication, and reuses recent metadata',async()=>{
 const {createResolutionStore}=require('../src/resolution/store');let now=1000,reads=0,state={_id:'n',namespace:'n',token:'lease',leaseUntil:5000,generation:'g1',asOf:100};
 const collection=name=>({createIndex:async()=>{},findOne:async filter=>{if(name==='org_resolution_state'){if(!filter?.token)reads++;return {...state};}return null;},updateOne:async(_filter,update)=>{state={...state,...update.$set};return {matchedCount:1};},find:()=>({batchSize(){return this;},async *[Symbol.asyncIterator](){}})});
 const store=createResolutionStore({uri:'mongodb://localhost/app',namespace:'n',now:()=>now,mongoClient:{connect:async()=>{},db:()=>({collection})}});
 assert.equal((await store.status()).asOf,100);assert.equal(store.cachedAsOf(),100);await store.refreshStatusIfStale();assert.equal(reads,1);
 now+=10;await store.publish('lease','g2',200,300,{syncMode:'differential'});assert.equal(store.cachedAsOf(),300);
 now+=10;await store.finish('lease',20000);assert.equal(store.cachedAsOf(),300);
 state.asOf=400;now+=60001;await store.refreshStatusIfStale();assert.equal(store.cachedAsOf(),400);assert.equal(reads,2);
});
test('live Mongo evidence is reused only while fresh and newer dataset publication supersedes it',async()=>{
 const {createResolutionStore}=require('../src/resolution/store');let now=1000,fullAt=100;
 const live={_id:'n:hash',namespace:'n',code:'A',verifiedAt:500,matches:[{Identifier:'9',Code:'A',Name:'External',Type:{Id:8,Code:'SourceCourse'},lifecycle:'live-verified',provenance:'live-verified'}]};
 const collection=name=>({createIndex:async()=>{},findOne:async()=>({generation:'g',fullAt}),find:filter=>({toArray:async()=>name==='org_resolution_live'?[live]:[]})});
 const store=createResolutionStore({uri:'mongodb://localhost/app',namespace:'n',now:()=>now,mongoClient:{connect:async()=>{},db:()=>({collection})}});
 const fresh=await store.lookup(['A']);assert.equal(fresh.safeCodes.has('A'),true);assert.equal(fresh.get('A')[0].provenance,'live-verified');
 now=500+15*60*1000+1;const expired=await store.lookup(['A']);assert.equal(expired.safeCodes.has('A'),false);
 now=1000;fullAt=600;const superseded=await store.lookup(['A']);assert.equal(superseded.safeCodes.has('A'),false);assert.equal(superseded.has('A'),false);
});
test('Mongo ID lookup returns the persisted Department Type.Id and Type.Name without rewriting the record',async()=>{
 const department={Identifier:'71238',Code:'dept',Name:'Department Name',Type:{Id:170,Name:'A renamed type'}};
 const collection=name=>({createIndex:async()=>{},findOne:async()=>({generation:'g'}),find:filter=>({toArray:async()=>{assert.equal(name,'org_resolution_units');assert.deepEqual(filter.Identifier,{$in:['71238']});return [department];}})});
 const store=createResolutionStore({uri:'mongodb://localhost/app',namespace:'n',mongoClient:{connect:async()=>{},db:()=>({collection})}});
 const found=await store.lookupByIds(['71238']);assert.deepEqual(found.get('71238'),department);
});
test('failed or expired sync cannot publish a partial snapshot; duplicate IDs rejected',async()=>{
 const f=fixture();f.store.renew=async()=>{throw Object.assign(Error('lost'),{code:'RESOLUTION_LEASE_LOST'});};
 await assert.rejects(createDirectorySync({...f,root}).run(),{code:'RESOLUTION_LEASE_LOST'});assert.equal(f.publishes,0);
 const duplicate=fixture();duplicate.readExtract=async(e,consume)=>{const row=datasetRow({OrgUnitId:'1',Code:'A',Name:'n',Type:'Course Offering',IsDeleted:'0'});await consume(row);await consume(row);};
 await assert.rejects(createDirectorySync({...duplicate,root}).run(),{code:'DATASET_DUPLICATE_ID'});assert.equal(duplicate.publishes,0);
});

test('replacement retains old published generation for in-flight readers even if imported a week ago',async()=>{
 const {createResolutionStore}=require('../src/resolution/store');const calls=[];
 const meta={generation:'new',retired:[{generation:'old-but-reading',retiredAt:200000000},{generation:'expired',retiredAt:1}]};
 const collection=name=>({createIndex:async()=>{},findOne:async()=>meta,deleteMany:async filter=>calls.push({name,filter}),updateOne:async()=>({matchedCount:1})});
 const store=createResolutionStore({uri:'mongodb://localhost/app',namespace:'n',now:()=>200000001,mongoClient:{connect:async()=>{},db:()=>({collection})}});
 await store.cleanup('new',1000);const excluded=calls.find(c=>c.name==='org_resolution_units').filter.generation.$nin;
 assert.ok(excluded.includes('old-but-reading'));assert.ok(excluded.includes('new'));assert.ok(!excluded.includes('expired'));
});

test('schema discovery accepts compact/display names but not related org-unit datasets',()=>{
 const {selectSchema,datasetSummary}=require('../src/resolution/sync');
 const schema=name=>({SchemaId:'ABC',Full:{Name:name},ExtractsLink:'https://tenant.example/private-link'});
 for(const name of ['Organizational Units','OrganizationalUnits',' Organizational Units (Full) ','Organisational Units'])assert.equal(selectSchema([schema(name)]).SchemaId,'ABC');
 assert.throws(()=>selectSchema([schema('Organizational Unit Ancestors')]),{code:'DATASET_SCHEMA_NOT_FOUND'});
 assert.throws(()=>selectSchema([schema('Organizational Units'),schema('OrganizationalUnits')]),{code:'DATASET_SCHEMA_AMBIGUOUS'});
 assert.equal(selectSchema([schema('Unidade organizacional')],' abc ').SchemaId,'ABC');
 assert.throws(()=>selectSchema([{SchemaId:'ABC',Full:null}],'ABC'),{code:'DATASET_FULL_UNAVAILABLE'});
 assert.ok(!JSON.stringify(datasetSummary([schema('Organizational Units')])).includes('private-link'));
});

test('dataset rows permit empty descriptive types and nullable name/code without changing codes',()=>{
 const row={OrgUnitId:'1',OrgUnitTypeId:'250',Code:' a ',Name:'',Type:'',IsDeleted:' FALSE '};
 assert.equal(normalize(row,1).Type.Name,'');assert.equal(normalize(row,1).Type.Code,undefined);assert.equal(normalize(row,1).Code,' a ');
 assert.equal(normalize({...row,Code:null,Name:null},1).Code,'');
 assert.throws(()=>normalize({...row,IsDeleted:'unexpected'},1),e=>e.code==='DATASET_ROW_INVALID'&&e.datasetField==='IsDeleted'&&e.datasetReason==='unsupported_boolean');
 assert.throws(()=>normalize({...row,OrgUnitId:'bad'},1),e=>e.datasetField==='OrgUnitId');
});
test('invalid import logs only field/reason/record position, never raw course data',async()=>{
 const f=fixture();f.readExtract=async(e,consume)=>consume({OrgUnitId:'1',OrgUnitTypeId:'250',Code:'SECRET_COURSE_CODE',Name:'PRIVATE_NAME',Type:'Course',IsDeleted:'SECRET_BAD_VALUE'});
 const output=[],previous=console.error;console.error=value=>output.push(value);
 try{await assert.rejects(createDirectorySync({...f,root}).run(),{code:'DATASET_ROW_INVALID'});}finally{console.error=previous;}
 const event=JSON.parse(output[0]);assert.equal(event.datasetField,'IsDeleted');assert.equal(event.datasetRecord,1);assert.equal(event.datasetExtract,'Full');assert.equal(event.datasetReason,'unsupported_boolean');assert.ok(!output.join('').includes('SECRET'));assert.ok(!output.join('').includes('PRIVATE'));assert.equal(f.publishes,0);
});
function incrementalFixture(){
 let state=null,failAt=null;const generations=new Map(),downloads=[];
 const e=(type,day)=>({SchemaId:'schema',PluginId:type,CreatedDate:new Date(day*86400000+100).toISOString(),QueuedForProcessingDate:new Date(day*86400000).toISOString(),Version:'11',BdsType:type,DownloadLink:root+'/'+day});
 const available=[e('Full',1),e('Differential',4),e('Differential',7)];
 const store={claim:async()=> 'lease',renew:async()=>{},status:async()=>state,finish:async()=>{},cleanup:async()=>{},discard:async g=>generations.delete(g),stage:async(g,rows)=>{if(!generations.has(g))generations.set(g,new Map());for(const r of rows)generations.get(g).set(r.Identifier,r);},remove:async(g,ids)=>{for(const id of ids)generations.get(g)?.delete(id);},clone:async(s,g)=>generations.set(g,new Map(generations.get(s))),publish:async(t,g,fullAt,asOf,summary)=>{state={generation:g,fullAt,asOf,...summary};}};
 const api={list:async url=>url.endsWith('/datasets/bds')?[{SchemaId:'schema',Full:{Name:'Organizational Units'},ExtractsLink:root+'/extracts'}]:available};
 const readExtract=async(e,consume)=>{const day=e.at/86400000;downloads.push(day);await consume(datasetRow({OrgUnitId:'1',Code:'C'+day,Type:'Source Course',Name:'',IsDeleted:day===10?'true':'false'}));if(failAt===day)throw Error('Failed download');if(e.BdsType==='Full')await consume(datasetRow({OrgUnitId:'2',Code:'unchanged',Name:'',Type:'Course Offering',IsDeleted:'false'}));};
 return {store,api,readExtract,available,e,downloads,generations,get state(){return state;},set failAt(value){failAt=value;}};
}
test('initial full ignores calendar gaps; subsequent runs download only new differentials',async()=>{
 const f=incrementalFixture(),sync=createDirectorySync({...f,root});
 assert.equal((await sync.run()).mode,'full');assert.deepEqual(f.downloads,[1,4,7]);
 assert.equal((await sync.run()).skipped,'already_current');assert.equal(f.downloads.length,3);
 f.available.push(f.e('Differential',10));assert.equal((await sync.run()).mode,'differential');assert.deepEqual(f.downloads,[1,4,7,10]);
 const records=f.generations.get(f.state.generation);assert.equal(records.get('1').lifecycle,'deleted');assert.equal(records.get('2').Code,'unchanged');
 assert.equal(f.state.fullAt,86400000);assert.equal(f.state.appliedExtracts.length,4);
 f.available.push(f.e('Full',11),f.e('Differential',12));assert.equal((await sync.run()).mode,'full');assert.deepEqual(f.downloads,[1,4,7,10,11,12]);assert.equal(f.state.appliedExtracts.length,2);
});
test('failed incremental import preserves committed directory and ledger; retry applies it once',async()=>{
 const f=incrementalFixture();await createDirectorySync({...f,root}).run();const previous=f.state;
 f.available.push(f.e('Differential',10));f.failAt=10;
 await assert.rejects(createDirectorySync({...f,root}).run());assert.deepEqual(f.state,previous);assert.equal(f.generations.get(previous.generation).get('1').Code,'C7');
 f.failAt=null;await createDirectorySync({...f,root}).run();assert.equal(f.state.appliedExtracts.length,4);assert.equal(f.state.asOf,10*86400000);
});
test('lost history stops updates; a fresh full recovers without guessing the customer cadence',async()=>{
 const f=incrementalFixture();await createDirectorySync({...f,root}).run();const previous=f.state;
 f.available.splice(0,f.available.length,f.e('Differential',20));
 await assert.rejects(createDirectorySync({...f,root}).run(),{code:'DATASET_HISTORY_UNAVAILABLE'});assert.equal(f.state,previous);
 f.available.push(f.e('Full',19));assert.equal((await createDirectorySync({...f,root}).run()).mode,'full');assert.equal(f.state.fullAt,19*86400000);
});
test('saved baseline supports differential-only listing; signed URL changes do not replay extracts',async()=>{
 const f=incrementalFixture();await createDirectorySync({...f,root}).run();
 const publishedAsOf=f.state.asOf;
 for(const e of f.available)e.DownloadLink+='?changed=signature';
 assert.equal((await createDirectorySync({...f,root}).run()).skipped,'already_current');assert.equal(f.state.asOf,publishedAsOf);
 f.available.splice(0,1);f.available.push(f.e('Differential',10));assert.equal((await createDirectorySync({...f,root}).run()).mode,'differential');
 assert.equal(f.state.asOf,10*86400000);assert.ok(f.state.asOf>publishedAsOf);
});
test('Mongo staging clone is bounded and never writes to the published generation',async()=>{
 const {createResolutionStore}=require('../src/resolution/store');let closed=false;const writes=[];
 const collection={createIndex:async()=>{},find:filter=>{assert.equal(filter.generation,'old');return {batchSize:size=>{assert.equal(size,500);return {async *[Symbol.asyncIterator](){for(let i=1;i<=1001;i++)yield {_id:i,namespace:'n',generation:'old',Identifier:String(i),Code:'C'+i};},close:async()=>{closed=true;}};}};},bulkWrite:async operations=>writes.push(operations)};
 const store=createResolutionStore({uri:'mongodb://localhost/app',namespace:'n',mongoClient:{connect:async()=>{},db:()=>({collection:()=>collection})}});
 await store.clone('old','new');assert.deepEqual(writes.map(w=>w.length),[500,500,1]);assert.ok(writes.flat().every(w=>w.updateOne.filter.generation==='new'&&!Object.hasOwn(w.updateOne.update.$set,'_id')));assert.ok(closed);
});

test('reported five historical org units yield only the unrecycled destination',()=>{
 const ids=['44814','44815','49825','54824','59831'];
 const rows=ids.map((OrgUnitId,i)=>normalize(datasetRow({OrgUnitId,Code:'oferta_origem_0001',Name:'Oferta Origem 0001',Type:i===3?'Course Offering':'Source Course',IsDeleted:'FALSE',DeletedDate:'',RecycledDate:i<4?'2026-10-05T15:22:19.627Z':'',IsActive:'TRUE'}),1));
 assert.deepEqual(mergeMatches('oferta_origem_0001',rows,null,new Map(),1).map(r=>r.Identifier),ids);assert.equal(rows.filter(r=>r.lifecycle==='current').length,1);
 const base={OrgUnitId:'1',OrgUnitTypeId:'250',Code:'A',Name:'',Type:'',IsDeleted:'FALSE',IsActive:'FALSE'};
 assert.equal(normalize(base,1).lifecycle,'unknown');assert.equal(normalize(base,1).deleted,true);
 assert.equal(normalize({...base,IsDeleted:'TRUE'},1).deleted,true);
 assert.equal(normalize({...base,DeletedDate:'2026-01-01'},1).deleted,true);
});
test('version 6 directory requires a full rebuild for lifecycle evidence even when extract timestamps have not changed',async()=>{
 const f=incrementalFixture();await createDirectorySync({...f,root}).run();f.state.syncVersion=6;
 assert.equal((await createDirectorySync({...f,root}).run()).mode,'full');assert.equal(f.state.syncVersion,7);assert.ok(f.state.liveInvalidBefore>0);assert.deepEqual(f.downloads,[1,4,7,1,4,7]);
});

test('changing the configured Department type ID forces a full rebuild and updates the published ID',async()=>{
 const f=incrementalFixture();await createDirectorySync({...f,root,departmentTypeId:170}).run();assert.equal(f.state.departmentTypeId,170);
 assert.equal((await createDirectorySync({...f,root,departmentTypeId:250}).run()).mode,'full');assert.equal(f.state.departmentTypeId,250);
});

test('version 6 without its persisted Department type ID is rebuilt before use',async()=>{
 const f=incrementalFixture();await createDirectorySync({...f,root}).run();delete f.state.departmentTypeId;
 assert.equal((await createDirectorySync({...f,root}).run()).mode,'full');assert.equal(Object.hasOwn(f.state,'departmentTypeId'),true);assert.deepEqual(f.downloads,[1,4,7,1,4,7]);
});

test('full import stages supported org-unit types including Departments while validating all rows',async()=>{
 const f=incrementalFixture();f.readExtract=async(e,consume)=>{
  for(const row of [
   {OrgUnitId:'1',OrgUnitTypeId:'3',Code:'offering',Type:' Course Offering ',IsDeleted:'false',IsActive:'false'},
   {OrgUnitId:'2',OrgUnitTypeId:'2',Code:'source',Type:'Source Course',IsDeleted:'false'},
   {OrgUnitId:'3',OrgUnitTypeId:'4',Code:'template',Type:'Course Template',IsDeleted:'false'},
   {OrgUnitId:'4',OrgUnitTypeId:'170',Code:'department',Type:'Department',IsDeleted:'false',IsActive:'false'},
   {OrgUnitId:'5',OrgUnitTypeId:'170',Code:'department-pt',Type:' Departamento ',IsDeleted:'false'},
   {OrgUnitId:'6',OrgUnitTypeId:'170',Code:'deleted',Type:'Unidade Departamental',IsDeleted:'true'},
   {OrgUnitId:'7',OrgUnitTypeId:'170',Code:'recycled',Type:'Other renamed label',IsDeleted:'false',RecycledDate:'2026-01-01'},
   {OrgUnitId:'8',OrgUnitTypeId:'250',Code:'unrelated',Type:'Department',IsDeleted:'false'},
   {OrgUnitId:'9',OrgUnitTypeId:'170',Code:'renamed-dept',Type:'A tenant-specific renamed type',IsDeleted:'false'},
  ])await consume({...row,Name:''});
 };
 await createDirectorySync({...f,root,departmentTypeId:170}).run();const saved=f.generations.get(f.state.generation);
 assert.deepEqual([...saved.keys()].sort(),['1','2','3','4','5','6','7','9']);assert.equal(saved.get('4').Type.Id,170);assert.equal(saved.get('4').Type.Name,'Department');assert.equal(Object.hasOwn(saved.get('4').Type,'Code'),false);assert.equal(saved.get('5').Type.Name,' Departamento ');assert.equal(Object.hasOwn(saved.get('5').Type,'Code'),false);assert.equal(saved.get('6').lifecycle,'deleted');assert.equal(saved.get('7').lifecycle,'recycled');assert.equal(saved.get('9').Type.Name,'A tenant-specific renamed type');assert.equal(Object.hasOwn(saved.get('9').Type,'Code'),false);assert.equal(f.state.fullRows,9);
 const duplicate=incrementalFixture();duplicate.readExtract=async(e,consume)=>{for(const type of ['Course Template','Other'])await consume(datasetRow({OrgUnitId:'8',Code:'x',Name:'',Type:type,IsDeleted:'false'}));};
 await assert.rejects(createDirectorySync({...duplicate,root}).run(),{code:'DATASET_DUPLICATE_ID'});assert.equal(duplicate.state,null);
});

test('Department code lookup returns its ID and Department collisions stay ambiguous',async()=>{
 const department={...record('41','dept-code'),Type:{Id:170,Name:'Departamento'}};
 const resolver=createOrgResolver({root,departmentTypeId:170,store:{lookup:async()=>cached([['dept-code',[department]]],['dept-code'])},api:noApi});
 const found=await (await resolver.prepare(['dept-code'])).resolve('dept-code');
 assert.equal(found.Identifier,'41');assert.equal(found.Type.Id,170);assert.equal(resolver.isStandardDepartment(found),true);
 const sharedDepartment={...department,Code:'shared'};
 const ambiguous=createOrgResolver({root,store:{lookup:async()=>cached([['shared',[sharedDepartment,{...record('42','shared'),Type:{Code:'Course Template'}}]]],['shared']),remember:async()=>{}},api:{list:async()=>[sharedDepartment,{...record('42','shared'),Type:{Code:'Course Template'}}]}});
 await assert.rejects((await ambiguous.prepare(['shared'])).resolve('shared'),{code:'CODE_NOT_UNIQUE'});
});

test('all four Org Library types resolve from Mongo evidence and mixed-type codes stay globally ambiguous',async()=>{
 const types=[
  {Identifier:'11',Code:'offer',Name:'Offering',Type:{Id:3,Code:'Course Offering',Name:'Course Offering'},lifecycle:'current'},
  {Identifier:'12',Code:'source',Name:'Source',Type:{Id:2,Code:'Source Course',Name:'Source Course'},lifecycle:'current'},
  {Identifier:'13',Code:'template',Name:'Template',Type:{Id:4,Code:'Course Template',Name:'Course Template'},lifecycle:'current'},
  {Identifier:'14',Code:'department',Name:'Department',Type:{Id:170,Name:'Renamed department type'},lifecycle:'current'},
 ];
 const rows=new Map(types.map(record=>[record.Code,[record]]));rows.set('offering-source',[types[0],{...types[1],Code:'offering-source'}]);rows.set('department-template',[{...types[3],Code:'department-template'},{...types[2],Code:'department-template'}]);
 rows.set('source-history',[types[1],{...types[1],Identifier:'15',Code:'source-history',lifecycle:'recycled',deleted:true}]);rows.set('source-duplicates',[{...types[1],Code:'source-duplicates'},{...types[1],Identifier:'16',Code:'source-duplicates'}]);
 const codes=[...rows.keys()];let discovered;const resolver=createOrgResolver({root,departmentTypeId:170,store:{lookup:async requested=>{discovered=requested;return cached(rows,codes);},lookupByIds:async ids=>new Map(types.filter(record=>ids.includes(record.Identifier)).map(record=>[record.Identifier,record]))},api:noApi});
 const session=await resolver.prepare(codes);
 for(const code of ['offer','source','template','department'])assert.equal((await session.resolve(code)).Identifier,types.find(record=>record.Code===code).Identifier);
 await assert.rejects(session.resolve('offering-source'),{code:'CODE_NOT_UNIQUE'});await assert.rejects(session.resolve('department-template'),{code:'CODE_NOT_UNIQUE'});
 await assert.rejects(session.resolve('source-history'),{code:'CODE_STATUS_UNKNOWN'});await assert.rejects(session.resolve('source-duplicates'),{code:'CODE_NOT_UNIQUE'});
 const evidence=await resolver.discover(['offering-source','offering-source']);assert.deepEqual(discovered,['offering-source']);assert.equal(evidence.get('offering-source').length,2);
 assert.equal((await resolver.lookupById('14')).Type.Id,170);
});

test('recycled, deleted, unknown and inactive lifecycle evidence is distinguished for every supported type',async()=>{
 for(const [name,Type] of [['Course Offering',{Id:3,Code:'Course Offering'}],['Source Course',{Id:2,Code:'Source Course'}],['Course Template',{Id:4,Code:'Course Template'}],['Department',{Id:170,Name:'Renamed'}]]){
  const row={OrgUnitId:'8',OrgUnitTypeId:String(Type.Id),Code:name,Name:'',Type:name,IsDeleted:'false',DeletedDate:'',RecycledDate:'',IsActive:'false'};
  assert.equal(normalize(row,1).lifecycle,'current',name);
  assert.equal(normalize({...row,RecycledDate:'2026-01-01'},1).lifecycle,'recycled',name);
  assert.equal(normalize({...row,DeletedDate:'2026-01-01'},1).lifecycle,'deleted',name);
  assert.equal(normalize({...row,DeletedDate:undefined},1).lifecycle,'unknown',name);
 }
});

test('Department IDs are preserved in Mongo lookups and live API type IDs identify renamed Departments',async()=>{
 const stored={Identifier:'71238',Code:'dept',Name:'Department',Type:{Id:170,Name:'Unidade Departamental'}};
 const resolver=createOrgResolver({root,departmentTypeId:170,store:{lookupByIds:async ids=>new Map(ids.filter(identifier=>identifier===stored.Identifier).map(identifier=>[identifier,stored]))},api:noApi});
 assert.equal((await resolver.lookupDepartmentById('71238')).Type.Id,170);assert.equal(await resolver.lookupDepartmentById('9'),null);
 assert.equal(resolver.isStandardDepartment({...stored,Type:{Id:250,Name:'Department'}}),false);
 let observed;
 const liveEvidence={Identifier:'71238',Code:'dept',Name:'Department',Type:{Id:170,Name:'Unidade Departamental'},lifecycle:'current'};
 const liveResolver=createOrgResolver({root,departmentTypeId:170,store:{lookup:async()=>cached([['dept',[liveEvidence]]]),remember:async(_code,rows)=>{observed=rows;}},api:{list:async()=>[{Identifier:'71238',Code:'dept',Name:'Department',Type:{Id:'170',Code:'custom-type',Name:'Renamed label'}}]}});
 const live=await (await liveResolver.prepare(['dept'])).resolve('dept');assert.equal(live.Type.Id,170);assert.equal(liveResolver.isStandardDepartment(live),true);assert.equal(live.Type.Name,'Renamed label');
});

test('missing and invalid Department configuration stays optional for other tools and fails clearly for Department use',async()=>{
 assert.deepEqual(parseDepartmentTypeId('170'),{value:170,error:null});assert.equal(parseDepartmentTypeId(undefined).value,null);
 for(const value of ['0','-1','1.5','9007199254740992','abc'])assert.equal(parseDepartmentTypeId(value).value,null);
 const resolver=createOrgResolver({root,store:{lookup:async()=>new Map()},api:noApi,departmentConfigurationError:parseDepartmentTypeId(undefined).error});
 assert.throws(()=>resolver.isStandardDepartment({Type:{Id:170}}),{code:'DEPARTMENT_TYPE_UNCONFIGURED'});await resolver.prepare([]);
 for(const value of [undefined,'not-an-id']){
  const runtime=createResolutionRuntime({api:noApi,http:async()=>{},downloadHttp:async()=>{},oauth:{},baseUrl:'https://tenant.example',lpVersion:'1.63',uri:'mongodb://localhost/app',clientId:'client',env:{BS_STD_DEPARTMENT_TYPE_ID:value}});
  assert.equal(runtime.departmentTypeId,null);assert.throws(()=>runtime.resolver.isStandardDepartment({Type:{Id:170}}),{code:'DEPARTMENT_TYPE_UNCONFIGURED'});
 }
});

test('differentials update and rename, insert, remove deletions and type transitions',async()=>{
 const f=incrementalFixture();f.available.splice(2);f.readExtract=async(e,consume)=>{
  const day=e.at/86400000;
  const rows=day===1?[
   {OrgUnitId:'1',Code:'old',Type:'Source Course'},
   {OrgUnitId:'5',Code:'template',Type:'Course Template'},
   {OrgUnitId:'6',OrgUnitTypeId:'170',Code:'department',Type:'Departamento'},
  ]:day===4?[
   {OrgUnitId:'1',Code:'renamed',Type:'Course Offering'},
   {OrgUnitId:'3',Code:'new',Type:'Course Offering'},
   {OrgUnitId:'6',OrgUnitTypeId:'170',Code:'department',Type:'A renamed tenant type'},
  ]:[
   {OrgUnitId:'1',Code:'renamed',Type:'Course Template'},
   {OrgUnitId:'5',Code:'became-course',Type:'Source Course'},
   {OrgUnitId:'3',Code:'new',Type:'Source Course',IsDeleted:'true'},
   {OrgUnitId:'6',OrgUnitTypeId:'250',Code:'department',Type:'Department'},
  ];
  for(const row of rows)await consume(datasetRow({Name:'',IsDeleted:'false',...row}));
 };
 await createDirectorySync({...f,root,departmentTypeId:170}).run();const renamed=f.generations.get(f.state.generation);
 assert.equal(renamed.get('1').Code,'renamed');assert.equal(renamed.get('3').Code,'new');assert.equal(renamed.get('6').Type.Name,'A renamed tenant type');
 f.available.push(f.e('Differential',7));await createDirectorySync({...f,root,departmentTypeId:170}).run();const records=f.generations.get(f.state.generation);
 assert.equal(records.has('1'),true);assert.equal(records.get('3').lifecycle,'deleted');assert.equal(records.get('5').Code,'became-course');assert.equal(records.has('6'),false);
 f.readExtract=async(e,consume)=>{if(e.at/86400000===10)await consume(datasetRow({OrgUnitId:'3',Code:'restored',Name:'',Type:'Source Course',IsDeleted:'false'}));};
 f.available.push(f.e('Differential',10));await createDirectorySync({...f,root,departmentTypeId:170}).run();const restored=f.generations.get(f.state.generation).get('3');assert.equal(restored.Code,'restored');assert.equal(restored.lifecycle,'current');
});

test('failed filtered full rebuild preserves the old published generation',async()=>{
 const f=fixture({broken:true});f.readExtract=async(e,consume)=>{if(e.BdsType==='Full')throw Object.assign(Error('bad full'),{code:'BAD_ZIP'});};
 await assert.rejects(createDirectorySync({...f,root}).run(),{code:'BAD_ZIP'});assert.equal(f.state.generation,'old');assert.equal(f.publishes,0);
});

test('5,000 cached date identifiers resolve without course-detail API requests',async()=>{
 const records=Array.from({length:5000},(_,i)=>record(String(i+1),'C'+i));
 const orgResolver=createOrgResolver({root,api:noApi,store:{lookup:async()=>cached(records.map(r=>[r.Code,[r]]),records.map(r=>r.Code))}});
 const client=createCoursesClient({baseUrl:'https://tenant.example',lpVersion:'1.63',orgResolver,api:noApi});
 const rows=records.map(r=>({orgUnitCode:r.Code,orgUnitId:r.Identifier}));
 const resolver=await client.prepare(rows);
 const resolved=await Promise.all(rows.map(row=>client.resolve(row,{resolver})));
 assert.equal(resolved.length,5000);assert.equal(resolved[4999].orgUnitId,'5000');
});
