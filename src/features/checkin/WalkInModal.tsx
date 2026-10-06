import {useEffect, useRef, useState} from 'react';
import {X} from 'lucide-react';
import {normalizeCompanyName} from '../../lib/company';
import {formatError} from '../../lib/errors';
import {normalizeNationalId} from '../../lib/privacy';
import type {Participant, Session} from '../../types';
import {getPreparedSchedule} from '../roster/db';
import {makePreparedFromMaster} from '../roster/match';
import type {MasterPerson, PreparedPerson} from '../roster/types';
import {SLOT_GROUP} from '../schedule/rules';
import {registerAndCheckIn, WalkInRegistrationError} from './walkin';

export type WalkInCandidate = {
  nationalId: string;
  master?: MasterPerson;
  prepared?: PreparedPerson;
};

type Props = {
  session: Session;
  candidate: WalkInCandidate;
  onClose: () => void;
  onComplete: (participant: Participant) => void;
};

export function WalkInModal({session, candidate, onClose, onComplete}: Props) {
  const existing = candidate.master ?? candidate.prepared;
  const title = existing ? '加入今日排程' : '新增受檢者';
  const [person, setPerson] = useState<MasterPerson>(() => ({
    companyName: session.companyName,
    companyKey: normalizeCompanyName(session.companyName),
    employeeNo: existing?.employeeNo ?? '',
    name: existing?.name ?? '',
    nationalId: normalizeNationalId(candidate.nationalId),
    gender: existing?.gender ?? '',
    originalActivity: existing?.originalActivity ?? '',
    item: existing?.item ?? '',
    extension: existing?.extension ?? '',
    updatedAt: new Date().toISOString(),
  }));
  const [slot, setSlot] = useState(candidate.prepared?.slot ?? Object.keys(SLOT_GROUP)[0]);
  const [addToMaster, setAddToMaster] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retained, setRetained] = useState(candidate.prepared);
  const submitting = useRef(false);
  const mounted = useRef(true);
  // Keep one local identity across deliberate retries after partial network failures.
  const localId = useRef(candidate.prepared?.localId ?? crypto.randomUUID());
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const complete = [person.employeeNo, person.name, person.nationalId, person.gender, person.item, slot]
    .every(value => value.trim());

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current || !complete) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const source = {...person, originalActivity: person.originalActivity || person.item};
      const row = retained ?? {
        ...makePreparedFromMaster(source, session.sessionDate, slot, 1),
        localId: localId.current,
      };
      const participant = await registerAndCheckIn(session, row, !existing && addToMaster);
      if (mounted.current) onComplete(participant);
    } catch (reason) {
      if (!mounted.current) return;
      setError(formatError(reason));
      const retain = (saved: PreparedPerson) => {
        if (!mounted.current) return;
        setRetained(saved);
        setPerson(previous => ({...previous, ...saved}));
        setSlot(saved.slot);
      };
      if (reason instanceof WalkInRegistrationError) {
        retain(reason.retained);
        return;
      }
      // Once a local row exists, retry exactly those saved fields. Letting the
      // operator change the slot would misrepresent the existing A–G group.
      try {
        const rows = await getPreparedSchedule(session.id);
        const saved = rows.find(row => row.employeeNo === person.employeeNo.trim()
          && normalizeNationalId(row.nationalId) === person.nationalId && row.name.trim() === person.name.trim());
        if (saved) retain(saved);
      } catch { /* The original failure remains visible; no new writes occur. */ }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const field = (key: 'employeeNo'|'name'|'gender'|'item'|'extension', label: string, required = true) => (
    <label key={key}>
      <span className="label">{label}</span>
      <input className="input" value={person[key]} required={required} disabled={busy}
        onChange={event => setPerson(previous => ({...previous, [key]: event.target.value}))}/>
    </label>
  );

  return <div className="fixed inset-0 z-50 grid bg-slate-950/60 p-3" role="dialog" aria-modal="true" aria-label={title}>
    <section className="m-auto max-h-full w-full max-w-xl overflow-auto rounded-2xl bg-white shadow-2xl">
      <header className="flex items-center justify-between border-b p-5">
        <h2 className="text-xl font-black">{title}</h2>
        <button type="button" className="secondary min-h-10 px-3" aria-label="關閉新增視窗" disabled={busy} onClick={onClose}><X/></button>
      </header>
      <form className="space-y-5 p-5" onSubmit={event => void submit(event)}>
        {retained && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          本機排程已保留，請重試雲端同步與報到；已保存的人員資料與排程時段會沿用。
        </p>}
        {existing || retained ? <dl className="grid grid-cols-[6rem_1fr] gap-2 rounded-xl bg-slate-50 p-4">
          <dt>姓名</dt><dd className="font-bold">{person.name}</dd>
          <dt>工號</dt><dd>{person.employeeNo}</dd>
          <dt>性別</dt><dd>{person.gender}</dd>
          <dt>身分證</dt><dd>{person.nationalId}</dd>
          <dt>項目</dt><dd>{person.item}</dd>
          <dt>院內分機</dt><dd>{person.extension || '未填寫'}</dd>
        </dl> : <div className="grid gap-3 sm:grid-cols-2">
          <label><span className="label">身分證</span><input className="input" value={person.nationalId} readOnly required/></label>
          {field('name', '姓名')}{field('employeeNo', '工號')}
          {field('gender', '性別')}{field('item', '項目')}
          {field('extension', '院內分機（選填）', false)}
        </div>}
        <div className="grid gap-3 sm:grid-cols-2">
          <label><span className="label">排程日期</span><input className="input" type="date" value={session.sessionDate} readOnly/></label>
          <label><span className="label">排程時段</span>
            <select className="input" value={slot} required disabled={busy || Boolean(retained)} onChange={event => setSlot(event.target.value)}>
              {Object.keys(SLOT_GROUP).map(value => <option key={value} value={value}>{value.replace('~', '～')}</option>)}
            </select>
          </label>
        </div>
        {!existing && <label className="flex items-center gap-2 font-bold">
          <input type="checkbox" checked={addToMaster} disabled={busy || Boolean(retained)} onChange={event => setAddToMaster(event.target.checked)}/>
          同時加入公司大名單
        </label>}
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-700">{error}</p>}
        <footer className="flex justify-end gap-3">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className="primary disabled:opacity-40" disabled={busy || !complete}>
            {busy ? '處理中……' : existing ? '加入今日排程並報到' : '新增並報到'}
          </button>
        </footer>
      </form>
    </section>
  </div>;
}
