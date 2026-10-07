'use strict';
// Stop scheduling on failure, but drain in-flight work before releasing the job lease.
async function pool(items,limit,run,shouldStart=async()=>true){
 let cursor=0,failure;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(!failure){try{if(!await shouldStart())return;const index=cursor++;if(index>=items.length)return;await run(items[index],index,()=>Boolean(failure));}catch(e){failure ||= e;}}
 }));
 if(failure)throw failure;
}
module.exports={pool};
