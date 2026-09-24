import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {elapsedSeconds} from '../lib/time';

const migration=readFileSync('supabase/migrations/202609240004_harden_examination_workflow.sql','utf8');

describe('formal examination contract',()=>{
  it('uses server timestamps and never accepts device start/completion times',()=>{
    expect(migration).toContain('clock_timestamp()');
    expect(migration).not.toMatch(/create or replace function public\.start_examination\([^)]*p_started_at/);
    expect(migration).not.toMatch(/create or replace function public\.complete_examination\([^)]*p_completed_at/);
  });
  it('requires check-in and an active Taiwan-today session',()=>{
    expect(migration).toContain("raise exception 'not_checked_in'");
    expect(migration).toContain("time zone 'Asia/Taipei'");
  });
  it('locks rows and rejects another room without replacing start time',()=>{
    expect(migration).toContain('for update');
    expect(migration).toContain("raise exception 'examination_in_other_room:%'");
    expect(migration).not.toMatch(/update public\.examinations set room_id/);
  });
  it('counts only confirmed ultrasound items and prevents a negative duration',()=>{
    expect(migration).toContain('item_count=cardinality(p_actual_items)');
    expect(migration).toContain('duration_seconds=greatest(0');
    expect(elapsedSeconds('2026-09-24T08:38:40Z','2026-09-24T08:30:15Z')).toBe(0);
  });
  it('keeps completion idempotent and RPCs authenticated only',()=>{
    expect(migration).toContain("if examination.status='completed' then return examination");
    expect(migration).toContain('to authenticated');
    expect(migration).toContain('from public,anon');
  });
});
