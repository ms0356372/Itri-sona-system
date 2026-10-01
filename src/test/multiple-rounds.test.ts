import {describe,expect,it} from 'vitest';
import {completedItems,remainingPlannedItems} from '../features/examination/service';
import type {Examination} from '../types';
const round=(roundNo:number,status:Examination['status'],actualItems:Examination['actualItems']):Examination=>({id:`e${roundNo}`,participantId:'p',roundNo,roomId:status==='waiting'?null:'診間 1',startedAt:status==='waiting'?null:'2026-10-01T00:00:00Z',completedAt:status==='completed'?'2026-10-01T00:01:00Z':null,durationSeconds:status==='completed'?60:null,selectedItems:actualItems,actualItems,itemCount:actualItems.length,status});
describe('追加檢查項目',()=>{
  it('彙整所有 completed rounds 並去重',()=>expect(completedItems([round(1,'completed',['腹部超音波']),round(2,'completed',['甲狀腺超音波']),round(3,'completed',['腹部超音波'])])).toEqual(['腹部超音波','甲狀腺超音波']));
  it('剩餘項目只扣除已完成輪次，忽略 waiting',()=>expect(remainingPlannedItems(['腹部超音波','甲狀腺超音波'],[round(1,'completed',['腹部超音波']),round(2,'waiting',['甲狀腺超音波'])])).toEqual(['甲狀腺超音波']));
});
