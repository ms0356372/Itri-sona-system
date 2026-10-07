import {beforeEach,describe,expect,it,vi} from 'vitest';

const remote=vi.hoisted(()=>({channel:vi.fn(),removeChannel:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>remote}));
import {subscribeExaminations,subscribeParticipants,subscribeRooms,subscribeSessions,type ChangePayload,type RealtimeStatus} from '../features/sync/realtime';

const payload=(eventType:'INSERT'|'UPDATE'|'DELETE',next:Record<string,unknown>={},old:Record<string,unknown>={})=>({eventType,new:next,old}) as ChangePayload;
function channelFixture(){
  const handlers=new Map<string,(value:ChangePayload)=>void>();let status!:(value:RealtimeStatus)=>void;
  const channel={on:vi.fn(),subscribe:vi.fn()};
  channel.on.mockImplementation((_event:string,filter:{table:string},callback:(value:ChangePayload)=>void)=>{handlers.set(filter.table,callback);return channel;});
  channel.subscribe.mockImplementation((callback:(value:RealtimeStatus)=>void)=>{status=callback;return channel;});
  remote.channel.mockReturnValue(channel);
  return{channel,emit:(table:string,value:ChangePayload)=>handlers.get(table)?.(value),status:(value:string)=>status(value as RealtimeStatus)};
}

describe('Realtime資料來源與場次隔離',()=>{
  beforeEach(()=>{remote.channel.mockReset();remote.removeChannel.mockReset();});

  it('App只訂閱participants，rooms heartbeat及examination不會重讀名單',()=>{
    const remoteChannel=channelFixture();const change=vi.fn();
    subscribeParticipants('session-a',change,{getKnownParticipantIds:()=>new Set(['person-a'])});
    expect(remoteChannel.channel.on).toHaveBeenCalledTimes(1);
    expect(remoteChannel.channel.on).toHaveBeenCalledWith('postgres_changes',{event:'*',schema:'public',table:'participants',filter:'session_id=eq.session-a'},expect.any(Function));
    for(let i=0;i<4;i++)remoteChannel.emit('rooms',payload('UPDATE',{session_id:'session-a',claim_expires_at:'later'}));
    remoteChannel.emit('examinations',payload('UPDATE',{participant_id:'person-a'}));
    expect(change).not.toHaveBeenCalled();
    remoteChannel.emit('participants',payload('UPDATE',{id:'person-a',session_id:'session-a'}));
    expect(change).toHaveBeenCalledTimes(1);
    remoteChannel.emit('participants',payload('UPDATE',{id:'person-b',session_id:'session-b'}));
    expect(change).toHaveBeenCalledTimes(1);
  });

  it('participants DELETE只有PK時只刷新已知名單，未知PK交給in-flight tombstone callback',()=>{
    const remoteChannel=channelFixture();const change=vi.fn();const onDelete=vi.fn();
    subscribeParticipants('session-a',change,{getKnownParticipantIds:()=>new Set(['person-a']),onDelete});
    remoteChannel.emit('participants',payload('DELETE',{}, {id:'person-b'}));expect(change).not.toHaveBeenCalled();
    remoteChannel.emit('participants',payload('DELETE',{}, {id:'person-a'}));expect(change).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls).toEqual([['person-b'],['person-a']]);
  });

  it('examination INSERT/UPDATE只刷新目前participant scope，getter不需重新訂閱',()=>{
    const remoteChannel=channelFixture();const change=vi.fn();let ids=new Set(['person-a']);
    subscribeExaminations({getParticipantIds:()=>ids,getKnownExaminationIds:()=>new Set()},change);
    remoteChannel.emit('examinations',payload('INSERT',{id:'exam-b',participant_id:'person-b'}));
    remoteChannel.emit('examinations',payload('UPDATE',{id:'exam-c',participant_id:'person-c'}));expect(change).not.toHaveBeenCalled();
    remoteChannel.emit('examinations',payload('UPDATE',{id:'exam-a',participant_id:'person-a'}));expect(change).toHaveBeenCalledTimes(1);
    ids=new Set(['person-b']);remoteChannel.emit('examinations',payload('INSERT',{id:'exam-b',participant_id:'person-b'}));expect(change).toHaveBeenCalledTimes(2);
  });

  it('examination DELETE只有PK，已知ID刷新而其他場次未知ID不發請求',()=>{
    const remoteChannel=channelFixture();const change=vi.fn();const onDelete=vi.fn();
    subscribeExaminations({getParticipantIds:()=>new Set(['person-a']),getKnownExaminationIds:()=>new Set(['exam-a']),onDelete},change);
    remoteChannel.emit('examinations',payload('DELETE',{}, {id:'exam-b'}));expect(change).not.toHaveBeenCalled();
    remoteChannel.emit('examinations',payload('DELETE',{}, {id:'exam-a'}));expect(change).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls).toEqual([['exam-b'],['exam-a']]);
    remoteChannel.emit('examinations',payload('DELETE'));expect(change).toHaveBeenCalledTimes(1);
  });

  it('已載入examination移出目前participant scope時仍重新查詢',()=>{
    const remoteChannel=channelFixture();const change=vi.fn();
    subscribeExaminations({getParticipantIds:()=>new Set(['person-a']),getKnownExaminationIds:()=>new Set(['exam-a'])},change);
    remoteChannel.emit('examinations',payload('UPDATE',{id:'exam-a',participant_id:'person-b'}));expect(change).toHaveBeenCalledTimes(1);
  });

  it('rooms DELETE用composite PK隔離場次，不信任缺少scope的payload',()=>{
    const remoteChannel=channelFixture();const change=vi.fn();subscribeRooms('session-a',change);
    remoteChannel.emit('rooms',payload('UPDATE',{session_id:'session-b',room_id:'診間 1'}));
    remoteChannel.emit('rooms',payload('DELETE',{}, {session_id:'session-b',room_id:'診間 1'}));
    remoteChannel.emit('rooms',payload('DELETE',{}, {room_id:'診間 1'}));expect(change).not.toHaveBeenCalled();
    remoteChannel.emit('rooms',payload('DELETE',{}, {session_id:'session-a',room_id:'診間 1'}));expect(change).toHaveBeenCalledTimes(1);
    remoteChannel.emit('rooms',payload('UPDATE',{session_id:'session-a',room_id:'診間 1',status:'away'}));expect(change).toHaveBeenCalledTimes(2);
  });

  it('caller接收SUBSCRIBED可用reuse刷新，helper不再重複觸發onChange',()=>{
    const remoteChannel=channelFixture();const change=vi.fn();const onStatus=vi.fn();
    subscribeSessions(change,onStatus);remoteChannel.status('SUBSCRIBED');remoteChannel.status('CHANNEL_ERROR');remoteChannel.status('SUBSCRIBED');
    expect(change).not.toHaveBeenCalled();expect(onStatus.mock.calls).toEqual([['SUBSCRIBED'],['CHANNEL_ERROR'],['SUBSCRIBED']]);
  });

  it('unmount後payload/status舊callback不再刷新或更新tombstones',()=>{
    const remoteChannel=channelFixture();const change=vi.fn();const onDelete=vi.fn();const status=vi.fn();
    const cleanup=subscribeExaminations({getParticipantIds:()=>new Set(['person-a']),getKnownExaminationIds:()=>new Set(['exam-a']),onDelete},change,status);
    cleanup();remoteChannel.emit('examinations',payload('UPDATE',{participant_id:'person-a'}));remoteChannel.emit('examinations',payload('DELETE',{}, {id:'exam-a'}));remoteChannel.status('SUBSCRIBED');
    expect(change).not.toHaveBeenCalled();expect(onDelete).not.toHaveBeenCalled();expect(status).not.toHaveBeenCalled();expect(remote.removeChannel).toHaveBeenCalledWith(remoteChannel.channel);
  });
});
