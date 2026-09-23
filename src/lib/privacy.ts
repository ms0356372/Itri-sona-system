export const normalizeNationalId=(value:unknown)=>String(value??'').trim().toUpperCase();
export const maskNationalId=(id:string)=>id.length<5?'***':`${id.slice(0,2)}*****${id.slice(-2)}`;
