import {useCallback, useEffect, useRef, useState} from 'react';
import {formatError} from '../../lib/errors';
import {normalizeNationalId} from '../../lib/privacy';
import type {Participant, Session} from '../../types';
import {getCompanyMaster, getPreparedSchedule} from '../roster/db';
import {assertPreparedParticipantIdentity, findParticipant} from '../schedule/service';
import {findScheduledEmployee, isAlreadyCheckedIn, isCompleteNationalId, repeatCheckinMessage} from './lookup';
import {SupabaseCheckinService} from './service';
import {WalkInModal, type WalkInCandidate} from './WalkInModal';

type Props = {
  current: Session|null;
  participants: Participant[];
  onSuccess: () => Promise<void>;
  setNotice: (message: string) => void;
};

const readableError = (error: unknown) => {
  const message = formatError(error);
  return /failed to fetch|network/i.test(message) ? '無法連線至雲端，請檢查網路後重試。' : message;
};

export function Checkin({current, participants, onSuccess, setNotice}: Props) {
  const [mode, setMode] = useState<'nationalId'|'list'>('nationalId');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Participant|null>(null);
  const [candidate, setCandidate] = useState<WalkInCandidate|null>(null);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);

  const reset = useCallback(() => {
    requestRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    setQuery('');
    setSelected(null);
    setCandidate(null);
    setSearching(false);
    setMode('nationalId');
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    reset();
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [current?.id, reset]);
  useEffect(() => {if (!candidate && mode === 'nationalId') inputRef.current?.focus();}, [candidate, mode]);

  const search = useCallback(async (raw: string) => {
    if (!current || submittingRef.current) return;
    const nationalId = normalizeNationalId(raw);
    if (!isCompleteNationalId(nationalId)) return;
    const request = ++requestRef.current;
    setSearching(true);
    setSelected(null);
    setCandidate(null);
    try {
      const schedule = await getPreparedSchedule(current.id);
      const local = findScheduledEmployee(schedule, nationalId);
      if (request !== requestRef.current) return;
      if (local.kind === 'duplicate') {
        setNotice('同一身分證對應多筆今日資料，請工作人員確認排程。');
        return;
      }
      if (local.kind === 'not_scheduled') {
        const master = await getCompanyMaster(current.companyName);
        if (request !== requestRef.current) return;
        const matches = master.filter(person => normalizeNationalId(person.nationalId) === nationalId);
        if (matches.length > 1) {
          setNotice('公司大名單中此身分證對應多筆人員，請至名單管理確認。');
          return;
        }
        setCandidate({nationalId, master: matches[0]});
        return;
      }
      const prepared = schedule.find(person => normalizeNationalId(person.nationalId) === nationalId)!;
      if (schedule.filter(person => person.employeeNo === prepared.employeeNo).length > 1) {
        setNotice('此工號在今日排程中對應多筆人員，請至名單管理確認。');
        return;
      }
      const participant = await findParticipant(current.id, local.employeeNo);
      if (request !== requestRef.current) return;
      if (!participant) {
        // A prior interrupted upload can resume without appending another local row.
        setCandidate({nationalId, prepared});
        return;
      }
      assertPreparedParticipantIdentity(participant, current.id, prepared);
      setSelected(participant);
      setNotice(repeatCheckinMessage(participant) ?? '已找到受檢者，請確認資料後報到。');
    } catch (error) {
      if (request === requestRef.current) setNotice(`查詢失敗：${readableError(error)}`);
    } finally {
      if (request === requestRef.current) setSearching(false);
    }
  }, [current, setNotice]);

  const changeQuery = (value: string) => {
    const normalized = normalizeNationalId(value);
    setQuery(normalized);
    setSelected(null);
    setCandidate(null);
    requestRef.current += 1;
    setSearching(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (isCompleteNationalId(normalized)) timerRef.current = setTimeout(() => void search(normalized), 400);
  };

  const enter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (timerRef.current) clearTimeout(timerRef.current);
    void search(event.currentTarget.value);
  };

  const finishWalkIn = (participant: Participant) => {
    if (!mountedRef.current) return;
    requestRef.current += 1;
    setCandidate(null);
    setSelected(participant);
    setNotice(participant.checkinNo ? `報到完成，編號 ${participant.checkinNo}。` : '此受檢者已有報到紀錄。');
    const request = requestRef.current;
    void onSuccess().catch(error => {
      if (mountedRef.current && request === requestRef.current) setNotice(`報到已完成，但名單重新整理失敗：${readableError(error)}`);
    });
  };

  const confirmCheckin = async () => {
    if (!current || !selected || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    const request = requestRef.current;
    try {
      await new SupabaseCheckinService().checkIn(selected.id);
      const fresh = await findParticipant(current.id, selected.employeeNo);
      if (!fresh || fresh.id !== selected.id || !isAlreadyCheckedIn(fresh)) throw new Error('無法確認報到結果，請重新查詢後再試。');
      if (request !== requestRef.current) return;
      setSelected(fresh);
      setNotice(fresh.checkinNo ? `報到完成，編號 ${fresh.checkinNo}。可按「掃描下一位」繼續。` : '此受檢者已有報到紀錄。');
      try { await onSuccess(); }
      catch (error) {
        if (mountedRef.current && request === requestRef.current) setNotice(`報到已完成，但名單重新整理失敗：${readableError(error)}`);
      }
    } catch (error) {
      if (request === requestRef.current) setNotice(`報到結果尚未確認：${readableError(error)}`);
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  };

  const alreadyCheckedIn = selected ? isAlreadyCheckedIn(selected) : false;
  return <div className="rounded-2xl bg-white p-5 shadow-sm">
    <h3 className="mb-3 font-bold">手動報到</h3>
    {!current ? <div className="grid min-h-36 place-items-center text-slate-400">請先建立或選擇健檢場次。</div> : <>
      <div className="mb-3 flex gap-2">
        {([['nationalId', '身分證'], ['list', '今日排程']] as const).map(([id, label]) => (
          <button type="button" key={id} disabled={busy || Boolean(candidate)}
            className={mode === id ? 'primary flex-1 px-2' : 'secondary flex-1 px-2'}
            onClick={() => {reset(); setMode(id);}}>{label}</button>
        ))}
      </div>
      {mode === 'list' ? <select className="input" aria-label="今日排程受檢者" value={selected?.id ?? ''} disabled={busy}
        onChange={event => setSelected(participants.find(person => person.id === event.target.value) ?? null)}>
        <option value="">{participants.length ? '選擇受檢者' : '尚無今日排程，可掃描身分證新增'}</option>
        {participants.map(person => <option key={person.id} value={person.id}>{person.sequence}. {person.name}（{person.employeeNo}）</option>)}
      </select> : <>
        <label className="label" htmlFor="national-id-query">身分證</label>
        <input id="national-id-query" ref={inputRef} autoFocus className="input" value={query}
          disabled={busy || Boolean(candidate)} autoComplete="off" autoCapitalize="characters"
          placeholder="請掃描或輸入身分證" onChange={event => changeQuery(event.target.value)} onKeyDown={enter}/>
        {searching && <p role="status" className="mt-2 text-sm font-bold text-teal-700">查詢中……</p>}
      </>}
      {selected && <div className="mt-4 rounded-xl border p-4">
        <b className="text-lg">{selected.name}</b>
        <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-1 text-sm">
          <dt>工號</dt><dd>{selected.employeeNo}</dd><dt>排程時段</dt><dd>{selected.slot}</dd>
          <dt>項目</dt><dd>{selected.plannedItems.join('、') || '無'}</dd>
          <dt>報到編號</dt><dd>{selected.checkinNo ?? '尚未編號'}</dd><dt>目前狀態</dt><dd>{selected.status}</dd>
        </dl>
        {repeatCheckinMessage(selected) && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm font-bold text-amber-900">{repeatCheckinMessage(selected)}</p>}
        {alreadyCheckedIn ? <>
          <button type="button" disabled className="primary mt-3 w-full opacity-40">{selected.checkinNo ? `已報到 ${selected.checkinNo}` : '已報到'}</button>
          <button type="button" className="secondary mt-2 w-full" onClick={reset}>掃描下一位</button>
        </> : <button type="button" disabled={busy} className="primary mt-3 w-full disabled:opacity-40" onClick={() => void confirmCheckin()}>
          {busy ? '報到中…' : '確認報到'}
        </button>}
      </div>}
      {candidate && <WalkInModal session={current} candidate={candidate} onClose={reset} onComplete={finishWalkIn}/>}
    </>}
  </div>;
}
