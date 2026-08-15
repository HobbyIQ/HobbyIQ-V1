const path=require("path");
const {CosmosClient}=require(path.join("C:/tmp/hiq-main/backend","node_modules/@azure/cosmos"));
const c=new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database('hobbyiq').container('card_catalog');
const APPLY=process.argv.includes('--apply');
(async()=>{
 const q="SELECT c.id,c.cardId FROM c WHERE IS_DEFINED(c.imageUrl) AND NOT IS_NULL(c.imageUrl) AND (CONTAINS(c.imageUrl,'/api/compiq/card-image/') OR CONTAINS(c.imageUrl,'tcdb.com'))";
 const it=c.items.query(q,{maxItemCount:500});
 let n=0,done=0,fail=0; const infl=new Set();
 while(it.hasMoreResults()){
  const {resources}=await it.fetchNext();
  for(const r of resources||[]){ n++;
   if(!APPLY) continue;
   while(infl.size>=12) await Promise.race([...infl]);
   const p=c.item(r.id,r.cardId).patch([{op:'set',path:'/imageUrl',value:null},{op:'add',path:'/imageClearedReason',value:'dead-host-verified-2026-08-15'}])
     .then(()=>{done++}).catch(e=>{fail++; if(fail<=3)console.warn('  fail',e.code||e.message)}).finally(()=>infl.delete(p));
   infl.add(p);
  }
  process.stderr.write('\rfound='+n+' cleared='+done);
 }
 while(infl.size) await Promise.race([...infl]);
 process.stderr.write('\n');
 console.log('  broken-image rows found: '+n);
 console.log('  cleared to null:         '+(APPLY?done+' (failed '+fail+')':'(dry-run)'));
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
