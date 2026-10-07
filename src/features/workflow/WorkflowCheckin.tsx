import type {Participant,Session} from '../../types';
import {Checkin} from '../checkin/Checkin';
import {SimpleCheckin} from '../checkin/SimpleCheckin';
import {isSimpleSession} from './mode';

export function WorkflowCheckin(props:{current:Session|null;participants:Participant[];onSuccess:()=>Promise<void>;setNotice:(message:string)=>void}){
  return isSimpleSession(props.current)?<SimpleCheckin {...props}/>:<Checkin {...props}/>;
}
