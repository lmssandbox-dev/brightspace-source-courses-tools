'use strict';
const {createResolutionStore,namespaceFor}=require('../src/resolution/store');
function printable(state){
 const time=value=>Number.isFinite(value)&&value>0?new Date(value).toISOString():'not recorded';
 return {status:state?.status||'not initialized',syncMode:state?.syncMode||'legacy',snapshotAvailable:Boolean(state?.generation),asOf:time(state?.asOf),fullAsOf:time(state?.fullAt),fullRows:state?.fullRows??0,importedRows:state?.importedRows??0,extracts:state?.extracts??0,lastFinished:time(state?.finishedAt),nextRun:time(state?.nextRunAt),errorCode:state?.lastError?.code||'',httpStatus:state?.lastError?.status??''};
}
async function main(){
 require('dotenv').config();const env=process.env;
 const store=createResolutionStore({uri:env.MONGODB_URL,namespace:namespaceFor(env.BS_URL,env.D2L_OAUTH2_CLIENT_ID)});
 try{console.table([printable(await store.status())]);console.log('Server-only directory status. Snapshot dates describe dataset freshness, not live course permissions.');}finally{await store.close();}
}
if(require.main===module)main().catch(error=>{require('../src/shared/diagnostics').logFailure('org_directory_report_failed',error);process.exitCode=1;});
module.exports={printable};
