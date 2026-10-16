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
 * All waiting participants form the first block in public/server queue order.
 * Everyone else follows in their original relative order, in either mode.
 * Undefined means that order is not yet confirmed; never invent a local one.
 */
export function buildWaitingQueue(session:Pick<Session,'workflowMode'>|null,participants:readonly Participant[],standardWaitingRanks?:ReadonlyMap<string,number>):Participant[]|undefined{
  const simple=isSimpleSession(session);
  const order={simple,standardWaitingRanks};
  const waiting=participants.filter(person=>person.status==='等候中');
  const others=participants.filter(person=>person.status!=='等候中');
  if(!simple&&waiting.length&&(!standardWaitingRanks||waiting.some(person=>!standardWaitingRanks.has(person.id))))return undefined;
  waiting.sort((left,right)=>compareWaitingParticipants(left,right,order));
  return [...waiting,...others];
}
