import assert from 'node:assert/strict';
export async function rollingQueue(tasks,parallel,run,canStart=()=>true){
 assert(Number.isInteger(parallel)&&parallel>0);let next=0;
 await Promise.all(Array.from({length:Math.min(parallel,tasks.length)},async()=>{
  while(canStart()){const index=next++;if(index>=tasks.length)return;await run(tasks[index],index);}
 }));
}
