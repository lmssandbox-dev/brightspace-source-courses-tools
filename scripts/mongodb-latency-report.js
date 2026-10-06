'use strict';
const {performance}=require('node:perf_hooks');
async function measure(client,{samples=8,clock=()=>performance.now()}={}){
 const start=clock();await client.connect();const connectMs=Math.round(clock()-start),times=[];
 for(let i=0;i<samples;i++){const before=clock();await client.db().command({ping:1});times.push(clock()-before);}
 const sorted=[...times].sort((a,b)=>a-b),n=sorted.length;
 return {samples:n,connectMs,minPingMs:Math.round(sorted[0]),medianPingMs:Math.round((sorted[Math.floor((n-1)/2)]+sorted[Math.floor(n/2)])/2),maxPingMs:Math.round(sorted[n-1])};
}
async function main(){
 require('dotenv').config();
 const {MongoClient}=require('mongodb'),{databaseConfig}=require('../src/shared/database');
 const uri=process.env.MONGODB_URL;databaseConfig(uri);
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:10000,socketTimeoutMS:15000});
 try{console.table([await measure(client)]);console.log('Read-only ping timings from this server. No database writes or Brightspace requests. Check Render and Atlas region settings separately; latency alone does not establish their locations.');}
 finally{await client.close();}
}
if(require.main===module)main().catch(()=>{console.error('Could not measure MongoDB latency. Check database access and server configuration.');process.exitCode=1;});
module.exports={measure};
