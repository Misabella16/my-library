// Conservative ISBN-13 handling for EPUB package identifiers.
// Rejects arbitrary OPF UUIDs, legacy ISBN-10, bad checksums, and mixed strings.
export function extractIsbn13(identifier){
 const value=String(identifier||'').trim();
 const labeled=/^(?:urn:isbn:|isbn(?:-13)?[:\s-]*)([0-9\s-]+)$/i.exec(value);
 const plain=/^[0-9\s-]+$/.test(value)?value:null;
 const digits=String(labeled?.[1]||plain||'').replace(/[\s-]/g,'');
 if(!/^(978|979)\d{10}$/.test(digits))return '';
 const sum=[...digits.slice(0,12)].reduce((n,v,i)=>n+Number(v)*(i%2?3:1),0);
 return (10-sum%10)%10===Number(digits[12])?digits:'';
}
