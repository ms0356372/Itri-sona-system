import type {Participant,Session,WorkflowMode} from '../../types';

export const isValidWorkflowMode=(value:unknown):value is WorkflowMode=>value==='standard'||value==='simple';
// Missing mode belongs to the existing workflow, including pre-migration data.
export const getWorkflowMode=(session:Pick<Session,'workflowMode'>|null|undefined):WorkflowMode=>session?.workflowMode==='simple'?'simple':'standard';
export const isSimpleSession=(session:Pick<Session,'workflowMode'>|null|undefined)=>getWorkflowMode(session)==='simple';
export const isStandardSession=(session:Pick<Session,'workflowMode'>|null|undefined)=>getWorkflowMode(session)==='standard';
export const workflowModeLabels:Record<WorkflowMode,string>={standard:'標準模式',simple:'簡易模式'};
export function getQueueNumber(person:Pick<Participant,'queueNumber'|'checkinNo'>):number|null{
  const explicit=person.queueNumber;
  if(typeof explicit==='number'&&Number.isSafeInteger(explicit)&&explicit>0)return explicit;
  if(!person.checkinNo||!/^[1-9]\d*$/.test(person.checkinNo))return null;
  const value=Number(person.checkinNo);
  return Number.isSafeInteger(value)?value:null;
}
export const compareQueueNumbers=(left:Participant,right:Participant)=>(getQueueNumber(left)??Number.MAX_SAFE_INTEGER)-(getQueueNumber(right)??Number.MAX_SAFE_INTEGER)||left.sequence-right.sequence;
