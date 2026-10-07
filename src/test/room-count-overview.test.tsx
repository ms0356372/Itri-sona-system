import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {RoomStatusOverview} from '../features/room/RoomStatusOverview';
import {getRoomIds} from '../features/room/status';
import {useRoomStates} from '../features/room/useRoomStates';

vi.mock('../features/room/useRoomStates',()=>({useRoomStates:vi.fn()}));

const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
let root:Root;
let container:HTMLDivElement;

describe('報到站與場次監控診間狀態',()=>{
  beforeEach(()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    vi.mocked(useRoomStates).mockReturnValue({rooms:getRoomIds(8).map((roomId,index)=>({sessionId:'session',roomId,status:index===1?'away':'idle',updatedAt:null})),loading:false,error:'',refresh:vi.fn(async()=>{}),acceptRoom:vi.fn()});
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{
    await act(async()=>{root.unmount();});container.remove();vi.restoreAllMocks();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;
  });
  const render=async(roomCount?:number|null)=>{await act(async()=>{root.render(<RoomStatusOverview sessionId="session" roomCount={roomCount}/>);});};
  const labels=()=>Array.from(container.querySelectorAll('[role="group"] > span > span:first-child')).map(value=>value.textContent);

  it.each([2,3,8])('設定%s間時不採用舊room row擴大有效診間，away黃燈照常顯示',async roomCount=>{
    await render(roomCount);
    expect(labels()).toEqual(getRoomIds(roomCount));
    expect(container.textContent).toContain('暫時離開');
    expect(container.querySelector('.bg-yellow-400')).not.toBeNull();
    expect(useRoomStates).toHaveBeenCalledWith('session',roomCount);
  });
  it.each([undefined,null])('舊場次診間數量為%s時使用預設4間',async roomCount=>{
    await render(roomCount);expect(labels()).toEqual(getRoomIds(4));
  });
  it('另一台平板的場次Realtime已將數量減為1時立即只顯示診間1',async()=>{
    const refresh=vi.fn(async()=>{});
    vi.mocked(useRoomStates).mockReturnValue({rooms:getRoomIds(8).map(roomId=>({sessionId:'session',roomId,status:'idle',updatedAt:null})),roomCount:1,loading:false,error:'',refresh,acceptRoom:vi.fn()});
    await render(8);expect(labels()).toEqual(['診間 1']);
  });
});
