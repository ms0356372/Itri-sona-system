import type {Participant,Session} from '../../types';
import {compareQueueNumbers,getQueueNumber,isSimpleSession} from './mode';

export type WaitingQueueOrder={simple:boolean;standardWaitingRanks?:ReadonlyMap<string,number>};

/** Standard order is supplied by the same SQL queue used by the public board. */
export function compareWaitingParticipants(left:Participant,right:Participant,order:WaitingQueueOrder):number{
  if(order.simple){
    const leftNumber=getQueueNumber(left);const rightNumber=getQueueNumber(right);
    if(leftNumber===null||rightNumber===null){
      if(leftNumber!==rightNumber)return leftNumber===null?1:-1;
    }else if(leftNumber!==rightNumber)return compareQueueNumbers(left,right);
    return left.sequence-right.sequence||(left.id===right.id?0:left.id<right.id?-1:1);
  }
  const leftRank=order.standardWaitingRanks?.get(left.id);const rightRank=order.standardWaitingRanks?.get(right.id);
  if(leftRank===undefined||rightRank===undefined)return leftRank===rightRank?0:leftRank===undefined?1:-1;
  return leftRank-rightRank;
}

/** Order an existing selection without changing which participants it contains.
 * Non-waiting positions remain intact in standard mode. Only waiting slots are
 * replaced, so their relative order matches the server/public queue exactly.
 * Undefined means that order is not yet confirmed; never invent a local one.
 */
export function buildWaitingQueue(session:Pick<Session,'workflowMode'>|null,participants:readonly Participant[],standardWaitingRanks?:ReadonlyMap<string,number>):Participant[]|undefined{
  const simple=isSimpleSession(session);
  const order={simple,standardWaitingRanks};
  if(simple)return [...participants].sort((left,right)=>compareWaitingParticipants(left,right,order));
  const waiting=participants.filter(person=>person.status==='等候中');
  if(!waiting.length)return [...participants];
  if(!standardWaitingRanks||waiting.some(person=>!standardWaitingRanks.has(person.id)))return undefined;
  waiting.sort((left,right)=>compareWaitingParticipants(left,right,order));
  let index=0;
  return participants.map(person=>person.status==='等候中'?waiting[index++]:person);
}
