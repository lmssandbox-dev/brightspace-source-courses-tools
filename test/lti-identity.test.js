'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {extractLtiIdentity}=require('../src/shared/ltiIdentity');
const {translateReport}=require('../src/ui/i18n');
const {createCreationView}=require('../src/creation/view');
const {createCopyView}=require('../src/copy/view');
const {createDeploymentView}=require('../src/replication/view');
const {report:dateReport}=require('../src/shared/routes');

test('LTI identity uses only the ltijs validated userInfo projection and bounds values',()=>{
 assert.deepEqual(extractLtiIdentity({user:'numeric-looking-sub',userInfo:{name:'Ada Lovelace',given_name:'A',family_name:'L',email:'ada@example.test'}}),{fullName:'Ada Lovelace',orgDefinedId:'',email:'ada@example.test'});
 assert.deepEqual(extractLtiIdentity({userInfo:{given_name:'Ada',family_name:'Lovelace'}}),{fullName:'Ada Lovelace',orgDefinedId:'',email:''});
 assert.deepEqual(extractLtiIdentity({user:'subject-only',userInfo:{email:'a@example.test',org_defined_id:'unsafe'}}),{fullName:'',orgDefinedId:'',email:'a@example.test'});
 assert.equal(extractLtiIdentity({userInfo:{name:'x'.repeat(300)}}).fullName.length,256);
});

test('all four CSV reports append exactly three creator columns and repeat saved values',()=>{
 const identity={fullName:'Ada Lovelace',orgDefinedId:'',email:'ada@example.test'};
 const jobs=[
  [createCreationView().report,{createdBy:identity,rows:[{row:1,status:'eligible',sourceCourseName:'Created',sourceCourseCode:'NEW',templateId:'10',resolvedTemplateCode:'T',resolvedTemplateName:'Template'}],tasks:[{row:1,result:{status:'created',CreatedOrgUnitId:'100'},TemplateId:'10',TemplateCode:'T',TemplateName:'Template',Name:'Created',Code:'NEW'}]}],
  [createCopyView().report,{createdBy:identity,rows:[{row:1,status:'valid',originId:'1',originCode:'O',originName:'Origin',destinationId:'2',destinationCode:'D',destinationName:'Destination'}],tasks:[],components:[]}],
  [createDeploymentView({enabled:()=>true}).report,{createdBy:identity,rows:[{row:1,status:'valid',sourceId:'1',sourceCode:'S',sourceName:'Source',targetId:'2',targetCode:'R',targetName:'Replica'}],tasks:[]}],
  [dateReport,{createdBy:identity,dates:{},rows:[{row:1,status:'valid',resolvedId:'1',orgUnitCode:'DATE'}],courses:[{orgUnitId:'1',code:'DATE',name:'Dates'}],tasks:[]}]
 ];
 for(const [make,job] of jobs){
  const csv=make(job),lines=csv.replace(/^\uFEFF/,'').split('\r\n'),decode=line=>line.match(/"((?:[^"]|"")*)"/g).map(cell=>cell.slice(1,-1).replace(/""/g,'"'));
  assert.deepEqual(decode(lines[0]).slice(-3),['User Full Name','User Org Defined ID','User Email']);
  for(const line of lines.slice(1))assert.deepEqual(decode(line).slice(-3),['Ada Lovelace','','ada@example.test']);
  assert.equal(decode(lines[0]).length,decode(lines[0]).slice(0,-3).length+3);
  const legacy=make({...job,createdBy:undefined}),legacyLine=legacy.replace(/^\uFEFF/,'').split('\r\n')[1];assert.deepEqual(decode(legacyLine).slice(-3),['','','']);
 }
 const creationCsv=createCreationView().report(jobs[0][1]);assert.match(creationCsv,/"Created Source Course ID","Created Source Course Code","Created Source Course Name","Course Template ID","Course Template Code","Course Template Name"/);assert.match(creationCsv,/"100","NEW","Created","10","T","Template"/);
 const copyCsv=createCopyView().report(jobs[1][1]);assert.match(copyCsv,/"Origin ID","Origin Code","Origin Name","Destination ID","Destination Code","Destination Name"/);assert.match(copyCsv,/"1","O","Origin","2","D","Destination"/);
 const deploymentCsv=createDeploymentView({enabled:()=>true}).report(jobs[2][1]);assert.match(deploymentCsv,/"Source ID","Source Code","Source Name","Replica\/Destination ID","Replica\/Destination Code","Replica\/Destination Name"/);assert.match(deploymentCsv,/"1","S","Source","2","R","Replica"/);
 const datesCsv=dateReport(jobs[3][1]);assert.match(datesCsv,/"Source Course ID","Source Course Code","Source Course Name"/);assert.match(datesCsv,/"CSV","1","1","DATE","Dates"/);
});

test('identity CSV labels are translated in headings while values stay unchanged',()=>{
 const csv='\uFEFF"User Full Name","User Org Defined ID","User Email"\r\n"Ada","ORG","a@example.test"';
 assert.match(translateReport(csv,'es-419'),/"Nombre completo del usuario","ID definido por la organización del usuario","Correo electrónico del usuario"/);
 assert.match(translateReport(csv,'pt-BR'),/"Nome completo do usuário","ID definido pela organização do usuário","E-mail do usuário"/);
 for(const language of ['es-419','pt-BR'])assert.ok(translateReport(csv,language).endsWith('"Ada","ORG","a@example.test"'));
});
