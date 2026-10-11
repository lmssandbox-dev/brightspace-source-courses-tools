'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {extractLtiIdentity}=require('../src/shared/ltiIdentity');
const {translateReport}=require('../src/ui/i18n');
const {createCreationView}=require('../src/creation/view');
const {createCopyView}=require('../src/copy/view');
const {createDeploymentView}=require('../src/replication/view');
const {report:dateReport}=require('../src/shared/routes');

test('LTI identity uses only the ltijs validated userInfo projection and bounds values',()=>{
 assert.deepEqual(extractLtiIdentity({user:'numeric-looking-sub',userInfo:{name:'Ada Lovelace',given_name:'A',family_name:'L',email:'ada@example.test'}}),{fullName:'Ada Lovelace',orgDefinedId:'',userId:''});
 assert.deepEqual(extractLtiIdentity({userInfo:{given_name:'Ada',family_name:'Lovelace'}}),{fullName:'Ada Lovelace',orgDefinedId:'',userId:''});
 assert.deepEqual(extractLtiIdentity({user:'subject-only'}),{fullName:'',orgDefinedId:'',userId:''});
 assert.equal(extractLtiIdentity({userInfo:{name:'x'.repeat(300)}}).fullName.length,256);
});

test('all four CSV reports append exactly three creator columns and repeat saved values',()=>{
 const identity={fullName:'Ada Lovelace',orgDefinedId:'ORG-7',userId:'9001'};
 const jobs=[
  [createCreationView().report,{createdBy:identity,rows:[{row:1,status:'eligible'},{row:2,status:'eligible'}],tasks:[]}],
  [createCopyView().report,{createdBy:identity,rows:[{row:1,status:'valid'},{row:2,status:'valid'}],tasks:[],components:[]}],
  [createDeploymentView({enabled:()=>true}).report,{createdBy:identity,rows:[{row:1,status:'valid'},{row:2,status:'valid'}],tasks:[]}],
  [dateReport,{createdBy:identity,dates:{},rows:[{row:1,status:'valid'},{row:2,status:'valid'}],courses:[],tasks:[]}]
 ];
 for(const [make,job] of jobs){
  const csv=make(job),lines=csv.replace(/^\uFEFF/,'').split('\r\n'),decode=line=>line.match(/"((?:[^"]|"")*)"/g).map(cell=>cell.slice(1,-1).replace(/""/g,'"'));
  assert.deepEqual(decode(lines[0]).slice(-3),['Full Name','User Org Code','User ID']);
  for(const line of lines.slice(1))assert.deepEqual(decode(line).slice(-3),['Ada Lovelace','ORG-7','9001']);
  assert.equal(decode(lines[0]).length,decode(lines[0]).slice(0,-3).length+3);
  const legacy=make({...job,createdBy:undefined}),legacyLine=legacy.replace(/^\uFEFF/,'').split('\r\n')[1];assert.deepEqual(decode(legacyLine).slice(-3),['','','']);
 }
});

test('identity CSV labels are translated in headings while values stay unchanged',()=>{
 const csv='\uFEFF"Full Name","User Org Code","User ID"\r\n"Ada","ORG","9"';
 assert.match(translateReport(csv,'es-419'),/"Nombre completo","Código de organización del usuario","ID de usuario"/);
 assert.match(translateReport(csv,'pt-BR'),/"Nome completo","Código da organização do usuário","ID do usuário"/);
 for(const language of ['es-419','pt-BR'])assert.ok(translateReport(csv,language).endsWith('"Ada","ORG","9"'));
});
