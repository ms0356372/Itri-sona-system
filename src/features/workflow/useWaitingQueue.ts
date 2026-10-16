import {useMemo} from 'react';
import type {Participant,Session} from '../../types';
import {isSimpleSession} from './mode';
import {buildWaitingQueue} from './waitingQueue';
import {useStandardWaitingQueue} from './useStandardWaitingQueue';

/** Shared internal reader: standard uses canonical SQL; simple uses ticket order. */
export function useWaitingQueue(current:Session|null,participants:Participant[],enabled=true){
  const queue=useStandardWaitingQueue(enabled?current?.id??null:null,isSimpleSession(current),participants);
  const ordered=useMemo(()=>buildWaitingQueue(current,participants,queue.ranks),[current,participants,queue.ranks]);
  return {...queue,participants:ordered};
}
