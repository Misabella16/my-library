// Safe Cloudflare D1 failure classification. Never return raw SQL, private
// records, tokens, credentials, query args or the exception's message.
function errorMessages(error) {
  const parts=[];
  let current=error;
  for(let i=0;i<4&&current;i++){
    if(typeof current==='string')parts.push(current);
    else if(typeof current.message==='string')parts.push(current.message);
    current=typeof current==='object'?current.cause:null;
  }
  return parts.join(' ').toLowerCase();
}
function resetTimeUtc(){
  const reset=new Date();
  reset.setUTCHours(24,0,0,0);
  return reset.toISOString();
}
export function classifyDatabaseError(error){
  const message=errorMessages(error);
  // Cloudflare's September 2026 D1 quota enforcement includes "free tier
  // daily row read limit" and "free tier daily row write limit" in errors.
  const rowRead=/(?:daily|free tier)[\s\S]{0,80}row read limit|d1[\s\S]{0,80}rows? read[\s\S]{0,25}limit/.test(message);
  const rowWrite=/(?:daily|free tier)[\s\S]{0,80}row write limit|d1[\s\S]{0,80}rows? written?[\s\S]{0,25}limit/.test(message);
  if(rowRead||rowWrite){
    return {
      error:'Cloudflare D1 daily '+(rowRead?'read':'write')+
        ' allowance reached. Your saved library data is preserved. Database requests can resume after midnight UTC.',
      code:rowRead?'database_read_quota':'database_write_quota',
      reset_utc:resetTimeUtc(),
      retryable:false
    };
  }
  if(/exceeded maximum db size|maximum account storage limit/.test(message)){
    return {
      error:'Cloudflare database storage limit reached. Existing books are preserved; storage usage needs review before importing more.',
      code:'database_storage_limit',
      retryable:false
    };
  }
  if(/overloaded|queued for too long|transient issue|db reset|database is locked|storage operation exceeded timeout/.test(message)){
    return {
      error:'Cloudflare D1 is temporarily unavailable or overloaded. Your saved books are preserved. Retry after a short break.',
      code:'database_temporarily_unavailable',
      retryable:true
    };
  }
  return null;
}
