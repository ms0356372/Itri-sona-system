import {beforeEach,describe,expect,it,vi} from 'vitest';
import {registerAndCheckIn,WalkInRegistrationError} from '../features/checkin/walkin';
import {getCompanyMaster,getPreparedSchedule,isCompanyMasterLocked,replaceCompanyMaster,replacePreparedSchedule,rosterDb} from '../features/roster/db';
import {makePreparedFromMaster} from '../features/roster/match';
import type {MasterPerson,PreparedPerson} from '../features/roster/types';
import {preparedCloudRow,upsertPreparedParticipant} from '../features/schedule/service';
import {requireSupabase} from '../lib/supabase';
import type {Session,WorkStatus} from '../types';

vi.mock('../lib/supabase',()=>({requireSupabase:vi.fn()}));

const session:Session={id:'session-1',sessionDate:'2026-10-06',companyName:' Itri ',status:'active'};
const prepared=(changes:Partial<PreparedPerson>={}):PreparedPerson=>({localId:crypto.randomUUID(),sequence:0,employeeNo:'00125',name:'王小明',nationalId:'A123456789',gender:'男',scheduleDate:session.sessionDate,slot:'07:30~08:00',item:'一般',originalActivity:'',dailyActivity:'一般',extension:'1234',issues:[],confirmed:true,...changes});
const master=(changes:Partial<MasterPerson>={}):MasterPerson=>({companyName:'ITRI',companyKey:'ITRI',employeeNo:'00125',name:'王小明',nationalId:'A123456789',gender:'男',originalActivity:'員工一般健檢A',item:'一般',extension:'1234',updatedAt:'2026-10-06T00:00:00Z',...changes});

type CloudPayload=ReturnType<typeof preparedCloudRow>;
type CloudRow=CloudPayload&{id:string;checkin_no:string|null;status:WorkStatus;checked_in_at:string|null;called_at:string|null;updated_at:string};
const cloudRow=(changes:Partial<CloudRow>={}):CloudRow=>({...preparedCloudRow(session.id,prepared({sequence:1}),0),id:'cloud-existing',checkin_no:null,status:'未報到',checked_in_at:null,called_at:null,updated_at:'2026-10-06T00:00:00Z',...changes});

/** A stateful remote fake exercises the real cloud service and real IndexedDB. */
function remote(){
  const state={rows:[] as CloudRow[],payloads:[] as CloudPayload[],insertError:null as unknown,race:null as CloudRow|null,rpcError:null as unknown,commitBeforeRpcError:false,selectError:null as unknown,failSelectAt:0,selectCalls:0,assignments:0,postCheckinStatus:'等候中' as WorkStatus};
  const client={
    from:vi.fn((table:string)=>{
      if(table!=='participants')throw new Error('unexpected table');
      return{
        select:vi.fn(()=>{
          const filters=new Map<string,string>();
          const query={
            eq:vi.fn((field:string,value:string)=>{filters.set(field,value);return query;}),
            maybeSingle:vi.fn(async()=>{
              state.selectCalls++;
              if(state.selectError||(state.failSelectAt&&state.selectCalls===state.failSelectAt))return{data:null,error:state.selectError??{message:'network disconnected'}};
              const rows=state.rows.filter(row=>row.session_id===filters.get('session_id')&&row.employee_no===filters.get('employee_no'));
              return rows.length>1?{data:null,error:{message:'multiple cloud identities'}}:{data:rows[0]?{...rows[0]}:null,error:null};
            }),
          };
          return query;
        }),
        insert:vi.fn((payload:CloudPayload)=>{
          state.payloads.push(payload);
          return{select:vi.fn(()=>({single:vi.fn(async()=>{
            if(state.race){state.rows.push(state.race);state.race=null;return{data:null,error:{code:'23505',message:'duplicate key'}};}
            if(state.insertError)return{data:null,error:state.insertError};
            const row:CloudRow={...payload,id:`cloud-${state.rows.length+1}`,checkin_no:null,status:'未報到',checked_in_at:null,called_at:null,updated_at:'2026-10-06T00:00:00Z'};
            state.rows.push(row);
            return{data:{...row},error:null};
          })}))};
        }),
        update:vi.fn(()=>{throw new Error('Existing participant must never be updated');}),
        upsert:vi.fn(()=>{throw new Error('Existing participant must never be overwritten');}),
        delete:vi.fn(()=>{throw new Error('A checked-in participant must never be rolled back');}),
      };
    }),
    rpc:vi.fn((name:string,args:{p_participant_id:string})=>({single:vi.fn(async()=>{
      if(name!=='check_in_participant')throw new Error('unexpected RPC');
      const row=state.rows.find(candidate=>candidate.id===args.p_participant_id);
      if(!row)return{data:null,error:{message:'not_found'}};
      if(!state.rpcError||state.commitBeforeRpcError){
        if(!row.checkin_no&&!row.checked_in_at){state.assignments++;row.checkin_no=`${row.group_code}${state.assignments}`;row.checked_in_at='2026-10-06T00:01:00Z';row.status=state.postCheckinStatus;}
      }
      return{data:state.rpcError?null:{checkin_no:row.checkin_no,status:row.status},error:state.rpcError};
    })})),
  };
  vi.mocked(requireSupabase).mockReturnValue(client as unknown as ReturnType<typeof requireSupabase>);
  return{state,client};
}

describe('現場單筆新增並報到',()=>{
  beforeEach(async()=>{
    vi.clearAllMocks();
    await rosterDb.preparedPeople.clear();await rosterDb.masterPeople.clear();await rosterDb.companySettings.clear();
  });

  it('從大名單帶入資料，append 最大 sequence + 1，保留原排程並沿用 A～G RPC',async()=>{
    const{state,client}=remote();
    await replaceCompanyMaster('ITRI',[master()]);
    const old=prepared({sequence:151,employeeNo:'00001',nationalId:'B123456789',name:'既有人員'});
    await replacePreparedSchedule(session.id,[old]);
    const result=await registerAndCheckIn(session,makePreparedFromMaster(master(),session.sessionDate,'07:30～08:00',0),false);
    const local=await getPreparedSchedule(session.id);
    expect(local).toHaveLength(2);expect(local[0]).toEqual(old);expect(local[1]).toMatchObject({employeeNo:'00125',sequence:152,nationalId:'A123456789'});
    expect(state.rows).toHaveLength(1);expect(state.payloads).toHaveLength(1);expect(state.payloads[0]).toMatchObject({employee_no:'00125',sequence_no:152,group_code:'A',note:'院內分機：1234'});
    expect(JSON.stringify(state.payloads)).not.toContain('A123456789');expect(state.payloads[0]).not.toHaveProperty('nationalId');expect(state.payloads[0]).not.toHaveProperty('national_id');
    expect(client.rpc).toHaveBeenCalledWith('check_in_participant',{p_participant_id:'cloud-1'});
    expect(result).toMatchObject({checkinNo:'A1',status:'等候中',employeeNo:'00125'});expect(await isCompanyMasterLocked('itri')).toBe(true);
  });

  it('全新人員預設只加入今日排程，前導 0 保留且不同於 125',async()=>{
    const{state}=remote();
    await replacePreparedSchedule(session.id,[prepared({employeeNo:'125',name:'另一人',nationalId:'B123456789',sequence:3})]);
    const result=await registerAndCheckIn(session,prepared(),false);
    expect(result.employeeNo).toBe('00125');expect(state.rows).toHaveLength(1);expect(await getCompanyMaster('ITRI')).toEqual([]);expect(await getPreparedSchedule(session.id)).toHaveLength(2);
  });

  it('勾選同時加入公司大名單會補 originalActivity 並維持鎖定',async()=>{
    remote();await replaceCompanyMaster('ITRI',[master({employeeNo:'other',nationalId:'B123456789',name:'原人員'})]);
    await registerAndCheckIn(session,prepared(),true);
    expect(await getCompanyMaster('ＩＴＲＩ')).toEqual(expect.arrayContaining([expect.objectContaining({employeeNo:'00125',originalActivity:'一般',nationalId:'A123456789'})]));
    expect(await isCompanyMasterLocked('ITRI')).toBe(true);
  });

  it.each([
    {employeeNo:'00125',nationalId:'B123456789',name:'另一人'},
    {employeeNo:'99999',nationalId:'A123456789',name:'另一人'},
  ])('本機工號或身分證衝突時保留原資料並阻止雲端及 RPC %#',async changes=>{
    const{state,client}=remote();const old=prepared({...changes,sequence:8});await replacePreparedSchedule(session.id,[old]);
    await expect(registerAndCheckIn(session,prepared(),false)).rejects.toThrow(/本機排程新增失敗/);
    expect(await getPreparedSchedule(session.id)).toEqual([old]);expect(state.payloads).toEqual([]);expect(client.rpc).not.toHaveBeenCalled();
  });

  it('同時加入大名單遇到同工號不同身分證，交易不寫入今日排程且鎖定不變',async()=>{
    const{state,client}=remote();await replaceCompanyMaster('ITRI',[master({nationalId:'B123456789'})]);
    await expect(registerAndCheckIn(session,prepared(),true)).rejects.toThrow(/工號/);
    expect(await getPreparedSchedule(session.id)).toEqual([]);expect((await getCompanyMaster('ITRI'))[0].nationalId).toBe('B123456789');expect(await isCompanyMasterLocked('ITRI')).toBe(true);expect(state.rows).toEqual([]);expect(client.rpc).not.toHaveBeenCalled();
  });

  it('insert unique 競爭後取得既有同人 participant，再正常報到',async()=>{
    const{state}=remote();state.race=cloudRow({id:'other-device',sequence_no:25});
    const result=await registerAndCheckIn(session,prepared(),false);
    expect(state.rows).toHaveLength(1);expect(result).toMatchObject({id:'other-device',sequence:25,checkinNo:'A1',status:'等候中'});expect(state.assignments).toBe(1);
  });

  it('unique 競爭對象姓名不同時阻止報到，保留另一人的雲端資料',async()=>{
    const{state,client}=remote();state.race=cloudRow({full_name:'另一人',checkin_no:'A17',status:'檢查中'});
    await expect(registerAndCheckIn(session,prepared(),false)).rejects.toThrow(/人員資料不同/);
    expect(state.rows[0]).toMatchObject({full_name:'另一人',checkin_no:'A17',status:'檢查中'});expect(client.rpc).not.toHaveBeenCalled();
  });

  it('unique 競爭遇到已報到同人，沿用現有編號及狀態並跳過 RPC',async()=>{
    const{state,client}=remote();state.race=cloudRow({checkin_no:'A17',checked_in_at:'2026-10-06T00:01:00Z',status:'檢查中'});
    const result=await registerAndCheckIn(session,prepared(),false);
    expect(result).toMatchObject({checkinNo:'A17',status:'檢查中'});expect(state.rows).toHaveLength(1);expect(state.assignments).toBe(0);expect(client.rpc).not.toHaveBeenCalled();
  });

  it('unique 衝突後讀不到同工號 participant，不猜測成功也不呼叫 RPC',async()=>{
    const{state,client}=remote();state.insertError={code:'23505',message:'duplicate key'};
    await expect(registerAndCheckIn(session,prepared(),false)).rejects.toThrow(/衝突後仍無法取得/);
    expect(client.rpc).not.toHaveBeenCalled();expect(await getPreparedSchedule(session.id)).toHaveLength(1);
  });

  it('已存在 participant 只檢查身分並保留原時段、項目、編號和實際狀態',async()=>{
    const{state,client}=remote();state.rows.push(cloudRow({schedule_slot:'08:00~08:30',group_code:'B',planned_items:['原項目'],checkin_no:'B12',checked_in_at:'2026-10-06T00:01:00Z',status:'檢查中'}));
    const result=await registerAndCheckIn(session,prepared(),false);
    expect(result).toMatchObject({slot:'08:00~08:30',plannedItems:['原項目'],checkinNo:'B12',status:'檢查中'});expect(state.payloads).toEqual([]);expect(client.rpc).not.toHaveBeenCalled();
  });

  it('雲端失敗不執行 RPC，本機保留以安全重試，錯誤不洩漏身分證',async()=>{
    const{state,client}=remote();state.insertError={message:'network failure A123456789'};
    const person=prepared();const error=await registerAndCheckIn(session,person,true).catch(error=>error as Error);
    expect(error).toBeInstanceOf(Error);expect((error as Error).message).toContain('尚未執行報到');expect((error as Error).message).not.toContain('A123456789');expect((error as Error).message).not.toContain('[object Object]');
    expect(client.rpc).not.toHaveBeenCalled();expect(await getPreparedSchedule(session.id)).toHaveLength(1);expect(await getCompanyMaster('ITRI')).toHaveLength(1);
    state.insertError=null;await registerAndCheckIn(session,person,true);
    expect(await getPreparedSchedule(session.id)).toHaveLength(1);expect(await getCompanyMaster('ITRI')).toHaveLength(1);expect(state.rows).toHaveLength(1);
  });

  it.each(['cloud','rpc','refresh'] as const)('%s 失敗透過具名 Error 帶回已保存的完整排程與原錯誤訊息',async stage=>{
    const{state}=remote();
    if(stage==='cloud')state.insertError={message:'temporary connection failure'};
    if(stage==='rpc')state.rpcError={message:'temporary connection failure'};
    if(stage==='refresh')state.failSelectAt=2;
    const person=prepared({sequence:999,slot:'08:00～08:30',nationalId:'a123456789'});
    const error:unknown=await registerAndCheckIn(session,person,false).catch(reason=>reason);
    expect(error).toBeInstanceOf(Error);expect(error).toBeInstanceOf(WalkInRegistrationError);
    if(!(error instanceof WalkInRegistrationError))throw new Error('Expected a retained registration error');
    expect(error.name).toBe('WalkInRegistrationError');
    expect(error.retained).toEqual((await getPreparedSchedule(session.id))[0]);
    expect(error.retained).toMatchObject({localId:person.localId,sequence:1,slot:'08:00~08:30',nationalId:'A123456789'});
    const expected={
      cloud:'本機排程已保留，但雲端新增未完成，尚未執行報到。請確認後重試：受檢者雲端同步失敗:temporary connection failure',
      rpc:'今日排程已保留，但尚無法確認報到結果。請重試，系統會沿用既有報到編號：temporary connection failure',
      refresh:'尚無法確認最新報到資料；今日排程已保留，請重試，系統會沿用既有編號與狀態：network disconnected',
    };
    expect(error.message).toBe(expected[stage]);
  });

  it('RPC 失敗後重試沿用本機與雲端 participant，僅分配一次號碼',async()=>{
    const{state,client}=remote();state.rpcError={message:'network disconnected'};const person=prepared();
    await expect(registerAndCheckIn(session,person,false)).rejects.toThrow(/尚無法確認報到/);
    expect(state.rows).toHaveLength(1);state.rpcError=null;
    const result=await registerAndCheckIn(session,person,false);
    expect(result.checkinNo).toBe('A1');expect(state.payloads).toHaveLength(1);expect(await getPreparedSchedule(session.id)).toHaveLength(1);expect(state.assignments).toBe(1);expect(client.rpc).toHaveBeenCalledTimes(2);
  });

  it('RPC 已提交但回應斷線，重試不再 RPC 且保留原號碼與狀態',async()=>{
    const{state,client}=remote();state.rpcError={message:'network disconnected'};state.commitBeforeRpcError=true;state.postCheckinStatus='已叫號';const person=prepared();
    await expect(registerAndCheckIn(session,person,false)).rejects.toThrow(/尚無法確認報到/);
    state.rpcError=null;const result=await registerAndCheckIn(session,person,false);
    expect(result).toMatchObject({checkinNo:'A1',status:'已叫號'});expect(client.rpc).toHaveBeenCalledTimes(1);expect(state.assignments).toBe(1);expect(state.rows).toHaveLength(1);
  });

  it('RPC 結構化錯誤中的分隔或全形身分證會遮蔽且保留可重試狀態',async()=>{
    const{state}=remote();state.rpcError={message:'network error Ａ１２３－４５６７８９'};
    const error=await registerAndCheckIn(session,prepared(),false).catch(error=>error as Error);
    expect((error as Error).message).toContain('[身分證已隱藏]');expect((error as Error).message).not.toContain('Ａ１２３');expect((error as Error).message).not.toContain('A123');expect(state.rows).toHaveLength(1);
  });

  it('報到後 refresh 失敗不宣告成功、不回滾，重試取得已完成的最新狀態',async()=>{
    const{state,client}=remote();state.failSelectAt=2;const person=prepared();
    await expect(registerAndCheckIn(session,person,false)).rejects.toThrow(/尚無法確認最新報到資料/);
    expect(state.rows[0]).toMatchObject({checkin_no:'A1',status:'等候中'});state.rows[0].status='已完成';
    const result=await registerAndCheckIn(session,person,false);
    expect(result).toMatchObject({checkinNo:'A1',status:'已完成'});expect(client.rpc).toHaveBeenCalledTimes(1);expect(state.assignments).toBe(1);
  });

  it.each([
    {scheduleDate:'2026-10-07'},
    {name:''},
    {employeeNo:''},
    {gender:''},
    {item:''},
    {slot:'11:00~11:30'},
    {nationalId:'A123'},
  ])('驗證必要欄位、完整身分證與固定場次日期在所有寫入前完成 %#',async changes=>{
    const{state,client}=remote();await expect(registerAndCheckIn(session,prepared(changes),false)).rejects.toThrow();
    expect(await getPreparedSchedule(session.id)).toEqual([]);expect(state.payloads).toEqual([]);expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each(['name','employeeNo','item','extension','gender'] as const)('阻止身分證從 %s 文字欄位洩漏到 Supabase',async field=>{
    const{state,client}=remote();await expect(registerAndCheckIn(session,prepared({[field]:'含 A123456789 的文字'}),false)).rejects.toThrow(/上傳欄位不可包含完整身分證/);
    expect(await getPreparedSchedule(session.id)).toEqual([]);expect(state.payloads).toEqual([]);expect(client.from).not.toHaveBeenCalled();
  });

  it('privacy allowlist 保留本機完整身分證並阻擋全形或分隔字元的文字洩漏',()=>{
    const person=prepared();expect(preparedCloudRow(session.id,person,0)).not.toHaveProperty('nationalId');expect(person.nationalId).toBe('A123456789');
    expect(()=>preparedCloudRow(session.id,prepared({item:'Ａ１２３４５６７８９'}),0)).toThrow(/身分證/);
    expect(()=>preparedCloudRow(session.id,prepared({extension:'A123-456789'}),0)).toThrow(/身分證/);
  });

  it('雲端既有工號性別不同時 service 不會覆寫或進行報到',async()=>{
    const{state}=remote();state.rows.push(cloudRow({gender:'女'}));
    await expect(upsertPreparedParticipant(session.id,prepared())).rejects.toThrow(/人員資料不同/);expect(state.payloads).toEqual([]);
  });
});
