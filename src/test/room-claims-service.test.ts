import {beforeEach,describe,expect,it,vi} from 'vitest';

const remote=vi.hoisted(()=>({rpc:vi.fn(),identity:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({rpc:remote.rpc})}));
vi.mock('../features/room/device',()=>({getDeviceIdentity:remote.identity}));

import {claimRoom,formatRoomClaimError,getRoomClaims,heartbeatRoomClaim,releaseRoomClaim,switchRoomClaim} from '../features/room/claims';

const identity={deviceId:'11111111-1111-4111-8111-111111111111',claimSecret:'a'.repeat(64)};
const row={session_id:'session-1',room_id:'room_2',is_mine:true,is_claimed:true,claimed_at:'2026-10-07T02:00:00Z',claim_expires_at:'2026-10-07T02:03:00Z',server_now:'2026-10-07T02:00:00Z'};
const mapped={sessionId:'session-1',roomId:'診間 2',isMine:true,isClaimed:true,claimedAt:row.claimed_at,claimExpiresAt:row.claim_expires_at,serverNow:row.server_now};

describe('診間裝置租約 RPC 邊界',()=>{
  beforeEach(()=>{remote.rpc.mockReset();remote.identity.mockReset();remote.identity.mockReturnValue(identity);});

  it('查詢使用場次與裝置密鑰，回傳 canonical 房號與伺服器租約時間',async()=>{
    remote.rpc.mockResolvedValue({data:[row,{...row,room_id:'診間3',is_mine:false,is_claimed:false,claimed_at:null,claim_expires_at:null}],error:null});
    expect(await getRoomClaims('session-1')).toEqual([mapped,{...mapped,roomId:'診間 3',isMine:false,isClaimed:false,claimedAt:null,claimExpiresAt:null}]);
    expect(remote.rpc).toHaveBeenCalledWith('list_room_claims',{p_session_id:'session-1',p_device_id:identity.deviceId,p_device_secret:identity.claimSecret});
  });

  it.each([
    {operation:'claim',run:()=>claimRoom('session-1','room_2'),rpc:'claim_room'},
    {operation:'heartbeat',run:()=>heartbeatRoomClaim('session-1','診間2'),rpc:'heartbeat_room_claim'},
  ])('$operation 帶本人裝置密鑰，canonical 房號與雲端結果',async({run,rpc})=>{
    remote.rpc.mockResolvedValue({data:row,error:null});
    expect(await run()).toEqual(mapped);
    expect(remote.rpc).toHaveBeenCalledWith(rpc,{p_session_id:'session-1',p_room_id:'診間 2',p_device_id:identity.deviceId,p_device_secret:identity.claimSecret});
  });

  it('切換以單一 RPC 同時帶來源與目的診間，不能先釋放來源再認領',async()=>{
    remote.rpc.mockResolvedValue({data:{...row,room_id:'room_3'},error:null});
    expect(await switchRoomClaim('session-1','room_2','診間3')).toEqual({...mapped,roomId:'診間 3'});
    expect(remote.rpc).toHaveBeenCalledTimes(1);
    expect(remote.rpc).toHaveBeenCalledWith('switch_room_claim',{p_session_id:'session-1',p_from_room_id:'診間 2',p_to_room_id:'診間 3',p_device_id:identity.deviceId,p_device_secret:identity.claimSecret});
  });

  it('釋放僅使用本人裝置密鑰，既有 RPC 拒絕完整往上傳',async()=>{
    remote.rpc.mockResolvedValueOnce({data:{...row,is_mine:false,is_claimed:false,claimed_at:null,claim_expires_at:null},error:null});
    await releaseRoomClaim('session-1','room_2');
    expect(remote.rpc).toHaveBeenCalledWith('release_room_claim',{p_session_id:'session-1',p_room_id:'診間 2',p_device_id:identity.deviceId,p_device_secret:identity.claimSecret});
    const error={code:'P0001',message:'room_claim_lost'};
    remote.rpc.mockResolvedValueOnce({data:null,error});
    await expect(releaseRoomClaim('session-1','room_2')).rejects.toEqual(error);
  });

  it('釋放可携帶已確認 claimed_at fence，晚到舊請求不能釋放後來的新租約',async()=>{
    remote.rpc.mockResolvedValue({data:{...row,is_mine:false,is_claimed:false,claimed_at:null,claim_expires_at:null},error:null});
    await releaseRoomClaim('session-1','room_2',row.claimed_at);
    expect(remote.rpc).toHaveBeenCalledWith('release_room_claim',{p_session_id:'session-1',p_room_id:'診間 2',p_device_id:identity.deviceId,p_device_secret:identity.claimSecret,p_expected_claimed_at:row.claimed_at});
  });

  it.each([
    {run:()=>getRoomClaims('session-1')},
    {run:()=>claimRoom('session-1','診間 2')},
    {run:()=>switchRoomClaim('session-1','診間 1','診間 2')},
    {run:()=>heartbeatRoomClaim('session-1','診間 2')},
  ])('雲端 permission denied 不會被轉成假的有效租約',async({run})=>{
    const error={code:'42501',message:'permission denied'};remote.rpc.mockResolvedValue({data:null,error});
    await expect(run()).rejects.toEqual(error);
  });

  it.each([
    {data:null},
    {data:{...row,session_id:'other-session'}},
    {data:{...row,is_mine:'true'}},
    {data:{...row,is_mine:true,is_claimed:false}},
    {data:{...row,claim_expires_at:'not-a-date'}},
    {data:{...row,server_now:'not-a-date'}},
  ])('不完整或不可信的 claim 回應不能成為本人有效租約',async({data})=>{
    remote.rpc.mockResolvedValue({data,error:null});
    await expect(claimRoom('session-1','診間 2')).rejects.toThrow('invalid_room_claim');
  });

  it('租約列表必須是陣列，含錯場次列時整批拒絕避免跨場次授權',async()=>{
    remote.rpc.mockResolvedValueOnce({data:row,error:null});
    await expect(getRoomClaims('session-1')).rejects.toThrow('invalid_room_claim');
    remote.rpc.mockResolvedValueOnce({data:[row,{...row,session_id:'other-session'}],error:null});
    await expect(getRoomClaims('session-1')).rejects.toThrow('invalid_room_claim');
  });

  it.each([
    {key:'room_claimed',text:'此診間目前正在其他設備使用中。'},
    {key:'room_claim_lost',text:'本機已失去此診間的使用權，請重新選擇診間。'},
    {key:'room_claim_in_progress',text:'此診間正在檢查中，請先完成檢查後再切換或釋放診間。'},
    {key:'room_claim_switch_required',text:'此裝置已占用其他診間，請使用診間選擇器切換。'},
    {key:'invalid_room',text:'此場次沒有這個診間。'},
    {key:'permission_denied',text:'此帳號沒有使用超音波診間的權限。'},
    {key:'network unavailable',text:'診間連線暫時異常，系統將自動重試。'},
  ])('拒絕 $key 會顯示指定中文',({key,text})=>{
    expect(formatRoomClaimError(new Error(key))).toBe(text);
  });

  it('RLS SQLSTATE 42501 也回傳診間用途的權限訊息',()=>{
    expect(formatRoomClaimError({code:'42501',message:'arbitrary detail'})).toBe('此帳號沒有使用超音波診間的權限。');
  });

});
