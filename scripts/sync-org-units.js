'use strict';
// Refreshes only the app's MongoDB directory; never copies courses or changes Brightspace.
async function main(){
 const args=process.argv.slice(2);
 if(args.some(arg=>arg!=='--list-datasets'))throw Object.assign(Error('Use no arguments or --list-datasets'),{code:'INVALID_ARGUMENT'});
 require('dotenv').config();const env=process.env,http=require('axios');
 const {createBrightspaceAuth}=require('../src/shared/auth');
 const {createBrightspaceClient,createBrightspaceGet}=require('../src/shared/client');
 const {createRateLimitedHttp,createMongoGate,rateLimitKey}=require('../src/shared/rateLimit');
 const oauth=createBrightspaceAuth({clientId:env.D2L_OAUTH2_CLIENT_ID,scope:env.D2L_OAUTH2_SCOPES,kid:env.D2L_OAUTH2_KEY_ID,privateKeyPem:env.D2L_OAUTH2_PRIVATE_KEY,tokenEndpoint:env.D2L_OAUTH2_TOKEN_ENDPOINT,http});
 const gate=createMongoGate({uri:env.MONGODB_URL,key:rateLimitKey(env.BS_URL,env.D2L_OAUTH2_CLIENT_ID)});
 const apiHttp=createRateLimitedHttp({http,gate,baseUrl:env.BS_URL});
 const api=createBrightspaceClient({get:createBrightspaceGet({http:apiHttp,oauth,baseUrl:env.BS_URL,retries:2}),leRoot:env.BS_URL+'/d2l/api/le/'+env.D2L_LE_VERSION});
 if(args.includes('--list-datasets')){
  try{
   const version=env.D2L_LP_VERSION||'1.53';if(!/^\d+\.\d+$/.test(version))throw Error('Invalid LP version');
   const rows=await api.list(new URL(env.BS_URL).origin+'/d2l/api/lp/'+version+'/datasets/bds',undefined,{maxPages:100,maxItems:10000});
   console.table(require('../src/resolution/sync').datasetSummary(rows));
   console.log(`${rows.length} schemas returned. This command lists metadata only; it does not import datasets. Download URLs and credentials are omitted.`);
   console.log('Choose the Organizational Units SchemaId (not Ancestors/Descendants or a PluginId) for ORG_UNIT_DATASET_SCHEMA_ID if automatic discovery fails.');
  }finally{await gate.close?.();}
  return;
 }
 const runtime=require('../src/resolution/runtime').createResolutionRuntime({api,http:apiHttp,downloadHttp:http,oauth,baseUrl:env.BS_URL,lpVersion:env.D2L_LP_VERSION||'1.53',uri:env.MONGODB_URL,clientId:env.D2L_OAUTH2_CLIENT_ID});
 try{console.log(await runtime.sync.run({force:true}));}finally{await runtime.store.close();await gate.close?.();}
}
if(require.main===module)main().catch(error=>{require('../src/shared/diagnostics').logFailure('org_directory_manual_sync_failed',error);process.exitCode=1;});
