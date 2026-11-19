// Shared within a Worker instance. Cache hits do not call this fetcher.
export function createPacedFetch(fetcher, {
 interval=1100, now=()=>Date.now(),
 sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
}={}) {
 let queue=Promise.resolve(),nextStart=0;
 return (...args)=>{
  const task=queue.then(async()=>{
   const delay=Math.max(0,nextStart-now());
   if(delay)await sleep(delay);
   nextStart=now()+interval;
   return fetcher(...args);
  });
  queue=task.catch(()=>{});
  return task;
 };
}
