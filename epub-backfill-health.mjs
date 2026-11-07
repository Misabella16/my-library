// Pure summarizer for an explicit, bounded saved-EPUB health check.
export function summarizeEpubHealth(rows){
 const list=Array.isArray(rows)?rows:[];
 return {
  checked:list.length,
  missingSynopsis:list.filter(x=>!!x.synopsis).length,
  missingCover:list.filter(x=>x.cover_missing===true).length,
  unavailableCover:list.filter(x=>x.cover_unavailable===true).length,
  missingSubjects:list.filter(x=>Array.isArray(x.subjects)&&x.subjects.length>0).length,
  ready:list.filter(x=>!x.synopsis&&!x.cover_missing&&!x.cover_unavailable&&!(x.subjects?.length)).length
 };
}
