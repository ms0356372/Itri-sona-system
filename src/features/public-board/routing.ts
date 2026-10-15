export const isPublicBoardToken=(token:unknown):token is string=>typeof token==='string'&&/^[0-9a-f]{64}$/.test(token);

/** Hash routes load the existing GitHub Pages index even after a reload. */
export function getPublicBoardRoute(hash:string):{token:string}|null{
  if(hash!=='#/board'&&!hash.startsWith('#/board/'))return null;
  const token=hash.slice('#/board/'.length);
  return {token:isPublicBoardToken(token)?token:''};
}

export function getPublicBoardUrl(token:string,origin=window.location.origin):string{
  if(!isPublicBoardToken(token))throw new Error('看板連結無效。');
  const url=new URL(import.meta.env.BASE_URL,origin);
  url.hash=`/board/${token}`;
  return url.href;
}
