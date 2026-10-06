'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const {mkdtemp,writeFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os'),path=require('node:path'),{crc32}=require('node:zlib');
const {createOrgResolver}=require('../src/resolution/resolver');
const {mergeMatches,namespaceFor}=require('../src/resolution/store');
const {createDirectorySync,nextNight,selectExtracts}=require('../src/resolution/sync');
const {normalize,readZip,createExtractReader}=require('../src/resolution/extract');
const {createCopyResolver}=require('../src/copy/resolver');
const {createCoursesClient}=require('../src/shared/courses');
const {createDeploymentJobs}=require('../src/replication/jobs');
const root='https://tenant.example/d2l/api/lp/1.63';
const record=(Identifier,Code,observedAt=1,deleted=false)=>({Identifier,Code,Name:'Course',Type:{Code:'CourseOffering'},observedAt,deleted});
const noApi={async list(){assert.fail('unexpected API lookup');},async read(){assert.fail('unexpected API read');}};
test('shared warm cache resolves codes once and IDs-only preparation does not touch Mongo',async()=>{
 let reads=0;const resolver=createOrgResolver({store:{async lookup(codes){reads++;assert.deepEqual(codes,['A']);return new Map([['A',[record('1','A')]]]);}},api:noApi,root});
 await resolver.prepare([]);assert.equal(reads,0);const session=await resolver.prepare(['A','A']);assert.equal((await session.resolve('A')).Identifier,'1');await session.resolve('A');assert.equal(reads,1);
});
test('cold lookup is deduplicated, exact, persisted, then reused by another job',async()=>{
 const cache=new Map();let calls=0,writes=0;
 const resolver=createOrgResolver({root,store:{lookup:async()=>new Map(cache),async remember(code,rows){writes++;cache.set(code,rows);}},api:{async list(url,raw,options){calls++;assert.equal(new URL(url).searchParams.get('exactOrgUnitCode'),'a/b ?');assert.equal(options.maxPages,100);return [record('1','a/b ?')];}}});
 const session=await resolver.prepare(['a/b ?']);await Promise.all(Array.from({length:8},()=>session.resolve('a/b ?')));assert.equal(calls,1);assert.equal(writes,1);
 await (await resolver.prepare(['a/b ?'])).resolve('a/b ?');assert.equal(calls,1);
});
test('ambiguous cached codes fail without live lookup; misses do not become negative entries',async()=>{
 const resolver=createOrgResolver({root,store:{lookup:async()=>new Map([['A',[record('1','A'),record('2','A')]]]),remember:async()=>{}},api:{list:async()=>[]}});
 const session=await resolver.prepare(['A','missing']);await assert.rejects(session.resolve('A'),{code:'CODE_NOT_UNIQUE'});await assert.rejects(session.resolve('missing'),{code:'CODE_NOT_UNIQUE'});
});
test('fresh live mappings survive old fulls; newer full/differentials invalidate renames/deletions',()=>{
 const old=record('1','A',100),overlay={verifiedAt:200,matches:[old]};
 assert.deepEqual(mergeMatches('A',[],overlay,new Map(),100),[old]);
 assert.deepEqual(mergeMatches('A',[],overlay,new Map(),300),[]);
 const renamed=record('1','B',300);assert.deepEqual(mergeMatches('A',[],overlay,new Map([['1',renamed]]),100),[]);
 const deleted=record('1','A',300,true);assert.deepEqual(mergeMatches('A',[deleted],overlay,new Map([['1',deleted]]),100),[]);
 const duplicate=record('2','A',300);assert.equal(mergeMatches('A',[duplicate],overlay,new Map([['2',duplicate]]),100).length,2);
 assert.notEqual(namespaceFor('https://one.example','client'),namespaceFor('https://two.example','client'));
 assert.notEqual(namespaceFor('https://one.example','client'),namespaceFor('https://one.example','other'));
});
test('Course Copy cached ID+code mismatch is rejected and IDs use no API',async()=>{
 const orgResolver=createOrgResolver({root,api:noApi,store:{lookup:async()=>new Map([['A',[record('1','A')]]])}});
 const resolve=await createCopyResolver({api:noApi,root,orgResolver})([{originCode:'A'}],async()=>{},async()=>{},{direct:true});
 await assert.rejects(resolve({originCode:'A',originId:'9'},'origin'),/different/);
 assert.equal((await resolve({originId:'8'},'origin')).orgUnitId,'8');
});
test('Date Manager uses shared code directory but still reads current course details',async()=>{
 let gets=0;const orgResolver=createOrgResolver({root,api:noApi,store:{lookup:async()=>new Map([['A',[record('1','A')]]])}});
 const client=createCoursesClient({baseUrl:'https://tenant.example',lpVersion:'1.63',orgResolver,api:{...noApi,async read(){gets++;return record('1','A');}}});
 const resolver=await client.prepare([{orgUnitCode:'A'}]);
 await assert.rejects(client.resolve({orgUnitCode:'A',orgUnitId:'2'},{resolver}),{code:'ID_CODE_MISMATCH'});assert.equal(gets,0);
 assert.equal((await client.resolve({orgUnitCode:'A'},{resolver})).orgUnitId,'1');assert.equal(gets,1);
});
test('Source Deployer uses cached pairs and excludes mismatches',async()=>{
 const orgResolver=createOrgResolver({root,api:noApi,store:{lookup:async()=>new Map([['A',[record('1','A')]],['B',[record('2','B')]]])}});
 const jobs=createDeploymentJobs({orgResolver,client:{},enabled:()=>true});const rows=jobs.parse('SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n1,A,2,B\n9,A,3,');
 const job={rows,tasks:[],courses:[]};await jobs.plan(job,async()=>{});assert.equal(rows[0].status,'valid');assert.equal(rows[1].status,'invalid');
});
function fixture({broken=false}={}){
 const staged=new Map();let state={generation:'old',asOf:0},publishes=0,finished;
 const extract=(BdsType,at)=>({SchemaId:'schema',BdsType,QueuedForProcessingDate:new Date(at).toISOString(),Version:'11',DownloadLink:root+'/'+at});
 const extracts=[extract('Differential',3000),extract('Full',1000),extract('Differential',2000),extract('Full',500)];
 const store={claim:async()=> 'lease',renew:async()=>{},status:async()=>state,stage:async(g,rows)=>{for(const row of rows)staged.set(row.Identifier,row);},publish:async(t,g,fullAt,asOf,summary)=>{publishes++;state={generation:g,fullAt,asOf,...summary};},finish:async(t,next,error)=>{finished={next,error};},cleanup:async()=>{},discard:async()=>{staged.clear();}};
 const api={list:async url=>url.endsWith('/datasets/bds')?[{SchemaId:'schema',Full:{Name:'Organizational Units'},ExtractsLink:root+'/extracts'}]:extracts};
 const readExtract=async(e,consume)=>{if(broken&&e.at===3000)throw Object.assign(Error('bad archive'),{code:'BAD_ZIP'});await consume({OrgUnitId:'1',Code:e.at>=2000?'B':'A',Name:'n',Type:'Source Course',IsDeleted:e.at===3000?'1':'0'});};
 return {store,api,readExtract,staged,get state(){return state;},get publishes(){return publishes;},get finished(){return finished;}};
}
test('nightly full plus ordered differentials publish atomically, including deletion',async()=>{
 const f=fixture();const sync=createDirectorySync({...f,root,now:()=>10000});await sync.run();assert.equal(f.publishes,1);assert.equal(f.state.asOf,3000);assert.equal(f.staged.get('1').Code,'B');assert.equal(f.staged.get('1').deleted,true);
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
test('normalization preserves Source Course type, exact codes and restored units',()=>{
 const row={OrgUnitId:'12',Code:' a ',Name:'N',Type:'Source Course',IsDeleted:'false',DeletedDate:'old'};
 const value=normalize(row,1);assert.equal(value.Code,' a ');assert.equal(value.Type.Code,'Source Course');assert.equal(value.deleted,false);
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
const csv='OrgUnitId,Code,Name,Type,IsDeleted\n1,ABC,Example,Course Offering,0\n';
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
test('Mongo cache queries are batched, tenant-scoped and use one snapshot generation',async()=>{
 const {createResolutionStore}=require('../src/resolution/store');const calls=[];
 const collection=name=>({createIndex:async()=>{},findOne:async()=>({generation:'g',fullAt:1}),find:filter=>({toArray:async()=>{calls.push({name,filter});return [];}})});
 const store=createResolutionStore({uri:'mongodb://localhost/app',namespace:'tenant-client',mongoClient:{connect:async()=>{},db:()=>({collection})}});
 await store.lookup(Array.from({length:5000},(_,i)=>'C'+i));assert.equal(calls.length,20);
 for(const c of calls){assert.equal(c.filter.namespace,'tenant-client');if(c.name==='org_resolution_units'){assert.equal(c.filter.generation,'g');assert.equal(c.filter.$or[0].Code.$in.length,500);}}
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
test('failed or expired sync cannot publish a partial snapshot; duplicate IDs rejected',async()=>{
 const f=fixture();f.store.renew=async()=>{throw Object.assign(Error('lost'),{code:'RESOLUTION_LEASE_LOST'});};
 await assert.rejects(createDirectorySync({...f,root}).run(),{code:'RESOLUTION_LEASE_LOST'});assert.equal(f.publishes,0);
 const duplicate=fixture();duplicate.readExtract=async(e,consume)=>{const row={OrgUnitId:'1',Code:'A',Name:'n',Type:'Course Offering',IsDeleted:'0'};await consume(row);await consume(row);};
 await assert.rejects(createDirectorySync({...duplicate,root}).run(),{code:'DATASET_DUPLICATE_ID'});assert.equal(duplicate.publishes,0);
});
test('missing differential day is rejected; scheduling failure never changes an existing directory',()=>{
 const full={SchemaId:'s',BdsType:'Full',QueuedForProcessingDate:'2026-10-01T00:00:00Z',Version:'11',DownloadLink:'https://example.com/full'};
 assert.throws(()=>selectExtracts([full,{...full,BdsType:'Differential',QueuedForProcessingDate:'2026-10-04T00:00:00Z',DownloadLink:'https://example.com/diff'}],'s'),{code:'DATASET_DIFFERENTIAL_GAP'});
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
