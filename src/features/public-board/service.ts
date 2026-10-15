import {getPublicBoardClient} from './publicClient';
import {isPublicBoardToken} from './routing';

export type PublicBoardPerson={employeeNo:string;maskedName:string};
export type PublicBoardData={companyName:string;sessionDate:string;people:PublicBoardPerson[]};

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const REQUEST_TIMEOUT_MS=8_000;

export async function fetchPublicBoard(token:string,signal?:AbortSignal):Promise<PublicBoardData|null>{
  if(!isPublicBoardToken(token))return null;
  if(signal?.aborted)throw new Error('public_board_unavailable');
  const controller=new AbortController();
  const abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  // Leave time before the next ten-second poll when a network request stalls.
  const timeout=setTimeout(abort,REQUEST_TIMEOUT_MS);
  try{
    const {data,error}=await getPublicBoardClient().rpc('get_public_waiting_board',{p_token:token}).abortSignal(controller.signal);
    if(error||controller.signal.aborted)throw new Error('public_board_unavailable');
    if(data===null)return null;
    if(!record(data)||typeof data.companyName!=='string'||typeof data.sessionDate!=='string'||!Array.isArray(data.people))throw new Error('public_board_unavailable');
    const people=data.people.map((person:unknown)=>{
      if(!record(person)||typeof person.employeeNo!=='string'||typeof person.maskedName!=='string')throw new Error('public_board_unavailable');
      return {employeeNo:person.employeeNo,maskedName:person.maskedName};
    });
    return {companyName:data.companyName,sessionDate:data.sessionDate,people};
  }finally{
    clearTimeout(timeout);
    signal?.removeEventListener('abort',abort);
  }
}
