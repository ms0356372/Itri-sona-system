import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {SLOT_GROUP} from '../features/schedule/rules';

it('Database 共用候檢時段定義與前端既有 SLOT_GROUP 完全一致',()=>{
  const migration=readFileSync('supabase/migrations/202610160001_standard_waiting_queue.sql','utf8');
  const scheduleBody=migration.match(/create\s+function\s+public\.standard_queue_schedule\(\)[\s\S]*?\bas\s+\$\$([\s\S]*?)\$\$\s*;/i)?.[1];
  expect(scheduleBody).toBeDefined();
  const databaseSchedule=Array.from(scheduleBody!.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g),match=>({
    slot:match[1],group:match[2],startMinute:Number(match[3]),rank:Number(match[4]),
  }));
  const sharedSchedule=Object.entries(SLOT_GROUP).map(([slot,group])=>{
    const [hour,minute]=slot.split('~')[0].split(':').map(Number);
    return {slot,group,startMinute:hour*60+minute};
  }).sort((left,right)=>left.startMinute-right.startMinute).map((schedule,rank)=>({...schedule,rank}));
  expect(databaseSchedule).toEqual(sharedSchedule);
});
