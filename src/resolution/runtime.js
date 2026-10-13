'use strict';
const {createResolutionStore,namespaceFor}=require('./store');
const {createOrgResolver}=require('./resolver');
const {createExtractReader}=require('./extract');
const {createDirectorySync}=require('./sync');
function parseDepartmentTypeId(value){
 if(value==null||String(value).trim()==='')return {value:null,error:'Set BS_STD_DEPARTMENT_TYPE_ID to the tenant standard Department Org Unit Type ID to use Department resolution.'};
 const text=String(value).trim();
 if(!/^\d+$/.test(text)||!Number.isSafeInteger(Number(text))||Number(text)<=0)return {value:null,error:'BS_STD_DEPARTMENT_TYPE_ID must be a positive safe integer.'};
 return {value:Number(text),error:null};
}
function createResolutionRuntime({api,http,downloadHttp,oauth,baseUrl,lpVersion,uri,clientId,env=process.env}){
 if(!/^\d+\.\d+$/.test(lpVersion))throw Error('Invalid LP version');
 const hour=Number(env.ORG_UNIT_DATASET_SYNC_HOUR_UTC??6);
 if(!Number.isInteger(hour)||hour<0||hour>23)throw Error('ORG_UNIT_DATASET_SYNC_HOUR_UTC must be 0–23');
 if(env.ORG_UNIT_DATASET_SYNC_ENABLED!=null&&!['true','false'].includes(env.ORG_UNIT_DATASET_SYNC_ENABLED))throw Error('ORG_UNIT_DATASET_SYNC_ENABLED must be true or false');
 const department=parseDepartmentTypeId(env.BS_STD_DEPARTMENT_TYPE_ID);
 const store=createResolutionStore({uri,namespace:namespaceFor(baseUrl,clientId)}),root=new URL(baseUrl).origin+'/d2l/api/lp/'+lpVersion;
 return {store,departmentTypeId:department.value,resolver:createOrgResolver({store,api,root,departmentTypeId:department.value,departmentConfigurationError:department.error}),sync:createDirectorySync({store,api,root,readExtract:createExtractReader({http,downloadHttp,oauth,baseUrl}),schemaId:env.ORG_UNIT_DATASET_SCHEMA_ID||'',hour,enabled:env.ORG_UNIT_DATASET_SYNC_ENABLED!=='false',departmentTypeId:department.value})};
}
module.exports={createResolutionRuntime,parseDepartmentTypeId};
