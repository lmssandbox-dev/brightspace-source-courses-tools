'use strict';
// Stop scheduling on failure, but drain in-flight work before releasing the job lease.
async function pool(items,limit,run){
 let cursor=0,failure;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(!failure){const index=cursor++;if(index>=items.length)return;try{await run(items[index],index,()=>Boolean(failure));}catch(e){failure ||= e;}}
 }));
 if(failure)throw failure;
}
module.exports={pool};
