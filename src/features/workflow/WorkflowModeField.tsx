import type {WorkflowMode} from '../../types';
import {workflowModeLabels} from './mode';

export function WorkflowModeField({value,onChange,disabled=false}:{value:WorkflowMode;onChange:(value:WorkflowMode)=>void;disabled?:boolean}){
  return <fieldset disabled={disabled} className="space-y-2">
    <legend className="label">場次模式</legend>
    {(['standard','simple'] as const).map(mode=><label key={mode} className="flex items-start gap-3 rounded-xl border p-3">
      <input type="radio" name="workflow-mode" value={mode} checked={value===mode} onChange={()=>onChange(mode)} className="mt-1 h-5 w-5"/>
      <span><b>{workflowModeLabels[mode]}</b><span className="block text-sm text-slate-500">{mode==='standard'?'使用每日排程與 A～G 分組報到。':'不使用每日排程，直接從公司大名單報到並依序取號。'}</span></span>
    </label>)}
  </fieldset>;
}
