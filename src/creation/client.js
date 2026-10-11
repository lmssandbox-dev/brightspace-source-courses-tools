'use strict';
const {id}=require('../shared/id');
const {atLeast}=require('../shared/client');
function createCreationClient({api,http,oauth,baseUrl,lpVersion}){
 const root=new URL(baseUrl).origin+`/d2l/api/lp/${lpVersion}`;
 const configured=()=>{if(!/^\d+\.\d+$/.test(lpVersion||'')||!atLeast(lpVersion,'1.60'))throw Object.assign(Error('Bulk Source Course Creator requires LP API 1.60 or later.'),{code:'LP_VERSION_UNSUPPORTED'});};
 return {
  async orgUnit(value){configured();return api.read(`${root}/orgstructure/${id(value)}`);},
  async exactCode(code){configured();const url=new URL(`${root}/orgstructure/`);url.searchParams.set('exactOrgUnitCode',code);const rows=await api.list(url.href,undefined,{maxPages:100,maxItems:5000});return rows.filter(r=>r.Code===code).map(r=>({Identifier:id(r.Identifier),Code:r.Code,Name:r.Name,Type:r.Type}));},
  async create(task,beforeSend){configured();let token;try{token=await oauth.getAccessToken();}catch{return {status:'failed',systemic:true,message:'Authentication failed; creation was not sent.'};}await beforeSend();
   try{const response=await http({method:'POST',url:`${root}/sourceCourses/`,timeout:30000,maxRedirects:0,headers:{Authorization:`Bearer ${token}`},data:{Name:task.Name,Code:task.Code,TemplateId:Number(id(task.TemplateId))}});if(response.status!==200)throw Error('Unexpected Source Course creation response');const value=response.data?.OrgUnitId??response.data?.orgUnitId??response.data?.Identifier;const orgUnitId=id(value);if(!Number.isSafeInteger(Number(orgUnitId)))throw Error('Invalid returned Source Course ID');return {status:'created',orgUnitId};}
   catch(error){const status=error.response?.status??error.status;const rejected=[400,401,403,404,429].includes(status);return {status:rejected?'failed':'uncertain',systemic:[401,403,429].includes(status)||!rejected,httpStatus:Number.isInteger(status)?status:null,message:rejected?'Brightspace rejected Source Course creation. Review the Service User permissions and saved result.':'Creation outcome is unconfirmed. Inspect Brightspace; the request will not be repeated.'};}
  }
 };
}
module.exports={createCreationClient};
