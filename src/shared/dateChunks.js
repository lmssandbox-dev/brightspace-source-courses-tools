'use strict';
const {createHash}=require('node:crypto');
const CHUNK_SIZE=10;
const DIRTY=Symbol('dateJobDirty');
const fields=['rows','courses','tasks'];
// Immutable, content-addressed chunks: a job pointer is published only after every
// changed chunk exists. A lost lease cannot corrupt a previously published plan.
async function encodeDateJob(job,collection,namespace,previous={}) {
 const {rows,courses,tasks,...metadata}=job;
 const data={...JSON.parse(JSON.stringify(metadata)),storageVersion:2,dateChunks:{}};
 const writes=[];
 for(const field of fields){
  const values=job[field]||[],refs=[];
  const dirty=job[DIRTY];
  if(dirty)refs.push(...(previous[field]||[]));
  const indices=dirty?[...new Set([...(dirty[field]||[]).map(i=>Math.floor(i/CHUNK_SIZE)),...Array.from({length:Math.max(0,Math.ceil(values.length/CHUNK_SIZE)-refs.length)},(_,i)=>refs.length+i)])]:Array.from({length:Math.ceil(values.length/CHUNK_SIZE)},(_,i)=>i);
  for(const index of indices){
   const offset=index*CHUNK_SIZE;
   const items=JSON.parse(JSON.stringify(values.slice(offset,offset+CHUNK_SIZE)));
   const hash=createHash('sha256').update(JSON.stringify(items)).digest('hex');
   const key=`${namespace}:${job._id}:${field}:${offset}:${hash}`;
   refs[index]=key;
   if(previous[field]?.[offset/CHUNK_SIZE]!==key){
    if(Buffer.byteLength(JSON.stringify(items))>8*1024*1024)throw Error('A date-job chunk exceeds 8 MB.');
    writes.push({_id:key,items});
   }
  }
  data.dateChunks[field]=refs;delete data[field];
 }
 // Capture every chunk before yielding: workers may mutate tasks during persistence.
 for(const {_id,items} of writes)await collection.updateOne({_id},{$setOnInsert:{namespace,jobId:job._id,items}},{upsert:true});
 return data;
}
async function decodeDateJob(job,collection,namespace){
 if(!job||job.storageVersion!==2)return job;
 for(const field of fields){
  const refs=job.dateChunks[field],items=[];
  // Bound each database query even for very large jobs; preserve original order.
  for(let i=0;i<refs.length;i+=100){
   const keys=refs.slice(i,i+100);
   const found=await collection.find({_id:{$in:keys},namespace,jobId:job._id}).toArray();
   const byId=new Map(found.map(chunk=>[chunk._id,chunk.items]));
   for(const key of keys){if(!byId.has(key))throw Error('Date job checkpoint is incomplete.');items.push(...byId.get(key));}
  }
  job[field]=items;
 }
 return job;
}
module.exports={encodeDateJob,decodeDateJob,CHUNK_SIZE,DIRTY};
