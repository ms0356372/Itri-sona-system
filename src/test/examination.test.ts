import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {elapsedSeconds} from '../lib/time';

const legacyMigration=readFileSync('supabase/migrations/202609240004_harden_examination_workflow.sql','utf8');
const migration=readFileSync('supabase/migrations/202610010001_multiple_examination_rounds.sql','utf8');

describe('formal examination contract',()=>{
  it('uses server timestamps and never accepts device start/completion times',()=>{
    expect(migration).toContain('clock_timestamp()');
    expect(legacyMigration+ migration).not.toMatch(/create or replace function public\.start_examination\([^)]*p_started_at/);
    expect(legacyMigration+ migration).not.toMatch(/create or replace function public\.complete_examination\([^)]*p_completed_at/);
  });
  it('requires check-in and an active Taiwan-today session',()=>{
    expect(migration).toContain("raise exception 'not_checked_in'");
    expect(migration).toContain("time zone 'Asia/Taipei'");
  });
  it('locks rows and rejects another room without replacing start time',()=>{
    expect(migration).toContain('for update');
    expect(migration).toContain("raise exception 'examination_in_other_room:%'");
    expect(migration).toContain("status='waiting'");
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

describe('multiple examination rounds migration',()=>{
  it('migrates existing rows to round one without touching clinical fields',()=>{
    expect(migration).toContain('update public.examinations set round_no=1 where round_no is null');
    expect(migration).toContain('unique(participant_id,round_no)');
    expect(migration.slice(0,migration.indexOf('create or replace function'))).not.toMatch(/update public\.examinations set (started_at|completed_at|actual_items)/);
  });
  it('uses database locks and partial indexes for concurrent actions',()=>{
    expect(migration).toContain('where id=p_participant_id for update');
    expect(migration).toContain("where status='waiting'");
    expect(migration).toContain("where status='in_progress'");
    expect(migration).toContain('coalesce(max(round_no),0)+1');
  });
  it('persists a waiting round and does not invoke check-in numbering',()=>{
    const enqueue=migration.slice(migration.indexOf('enqueue_additional_examination'),migration.indexOf('create or replace function public.start_examination'));
    expect(enqueue).toContain("status='等候中'");
    expect(enqueue).not.toContain('check_in_participant');
    expect(enqueue).not.toContain('group_counters');
    expect(enqueue).not.toMatch(/set .*checkin_no|set .*checked_in_at/);
  });
  it('starts a waiting round and completes only by examination id',()=>{
    expect(migration).toContain("status='waiting' for update");
    expect(migration).toContain("status='in_progress'");
    expect(migration).toContain('p_examination_id uuid');
    expect(migration).toContain('where id=p_examination_id for update');
  });
  it('keeps cascade deletion from the original participant foreign key',()=>{
    expect(readFileSync('supabase/migrations/202609230001_initial.sql','utf8')).toContain('references public.participants (id) on delete cascade');
  });
});
