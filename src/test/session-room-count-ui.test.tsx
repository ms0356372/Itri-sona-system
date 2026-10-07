import {act,useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {DEFAULT_ROOM_COUNT} from '../features/room/status';
import {RoomCountField} from '../features/sessions/RoomCountField';
import {SessionRoomCountEditor} from '../features/sessions/SessionRoomCountEditor';
import type {Session} from '../types';

const remote=vi.hoisted(()=>({update:vi.fn()}));
vi.mock('../features/sessions/service',()=>({updateSessionRoomCount:remote.update}));

const session:Session={id:'room-count-session',companyName:'ITRI',sessionDate:'2026-10-07',status:'active',roomCount:4};
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
let root:Root;
let container:HTMLDivElement;
let onSaved:ReturnType<typeof vi.fn>;

function Field(){
  const[count,setCount]=useState(DEFAULT_ROOM_COUNT);
  return <RoomCountField value={count} onChange={setCount}/>;
}
function button(label:string){
  const result=Array.from(container.querySelectorAll('button')).find(element=>element.textContent===label||element.getAttribute('aria-label')===label);
  if(!result)throw new Error(`找不到按鈕：${label}`);
  return result;
}
const countInput=()=>container.querySelector<HTMLInputElement>('input[type="number"]')!;
const preview=()=>Array.from(container.querySelectorAll('li')).map(element=>element.textContent);
async function click(element:HTMLElement){await act(async()=>{element.click();});}
async function input(value:string){
  const setValue=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
  await act(async()=>{setValue.call(countInput(),value);countInput().dispatchEvent(new Event('input',{bubbles:true}));});
}
async function render(current:Session=session){await act(async()=>{root.render(<SessionRoomCountEditor session={current} onSaved={onSaved}/>);});}

describe('場次診間數量 UI',()=>{
  beforeEach(()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-07T04:00:00Z'));
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    remote.update.mockReset();
    remote.update.mockImplementation(async(id:string,roomCount:number)=>({...session,id,roomCount}));
    onSaved=vi.fn(async()=>{});
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{await act(async()=>{root.unmount();});container.remove();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;vi.useRealTimers();});

  it('新增欄位預設四間，增加與減少會即時更新啟用預覽',async()=>{
    await act(async()=>{root.render(<Field/>);});
    expect(countInput().value).toBe('4');
    expect(preview()).toEqual(['診間1','診間2','診間3','診間4']);
    expect(container.textContent).toContain('超音波診間數量');
    await click(button('增加超音波診間數量'));
    expect(countInput().value).toBe('5');expect(preview()).toHaveLength(5);
    await click(button('減少超音波診間數量'));
    expect(countInput().value).toBe('4');expect(preview()).toHaveLength(4);
  });

  it.each([2,8])('設定 %i 間可儲存，保存後才通知場次刷新',async count=>{
    await render();await input(String(count));
    expect(preview()).toHaveLength(count);
    await click(button('儲存診間數量'));
    expect(remote.update).toHaveBeenCalledExactlyOnceWith(session.id,count);
    expect(onSaved).toHaveBeenCalledWith({...session,roomCount:count});
    expect(container.querySelector('[role="status"]')?.textContent).toContain('診間數量已儲存');
  });

  it.each(['9','0','2.5',''])('非法數量「%s」不顯示啟用預覽且禁止儲存',async value=>{
    await render();await input(value);
    expect(countInput().getAttribute('aria-invalid')).toBe('true');
    expect(preview()).toHaveLength(0);
    expect(button('儲存診間數量').disabled).toBe(true);
    await click(button('儲存診間數量'));
    await act(async()=>{container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(remote.update).not.toHaveBeenCalled();expect(onSaved).not.toHaveBeenCalled();
  });

  it('上下限按鈕停在一間及八間',async()=>{
    await act(async()=>{root.render(<Field/>);});
    await input('1');
    expect(button('減少超音波診間數量').disabled).toBe(true);
    await click(button('減少超音波診間數量'));expect(countInput().value).toBe('1');
    await input('8');
    expect(button('增加超音波診間數量').disabled).toBe(true);
    await click(button('增加超音波診間數量'));expect(countInput().value).toBe('8');
  });

  it.each(['closed','closing'] as const)('%s 場次保留原診間數量且唯讀',async status=>{
    await render({...session,status,roomCount:6});
    expect(countInput().value).toBe('6');expect(preview()).toHaveLength(6);
    expect(container.textContent).toContain('超音波診間：6間');
    expect(countInput().disabled).toBe(true);
    expect(button('增加超音波診間數量').disabled).toBe(true);
    expect(button('儲存診間數量').disabled).toBe(true);
    await click(button('儲存診間數量'));expect(remote.update).not.toHaveBeenCalled();
  });

  it('歷史日期的 active 場次仍保留六間且唯讀，未來場次可編輯',async()=>{
    await render({...session,sessionDate:'2026-10-06',roomCount:6});
    expect(countInput().value).toBe('6');expect(preview()).toHaveLength(6);
    expect(countInput().disabled).toBe(true);expect(button('儲存診間數量').disabled).toBe(true);
    await click(button('儲存診間數量'));expect(remote.update).not.toHaveBeenCalled();
    await render({...session,sessionDate:'2026-10-08',roomCount:6});
    expect(countInput().disabled).toBe(false);expect(button('儲存診間數量').disabled).toBe(false);
    await input('7');await click(button('儲存診間數量'));
    expect(remote.update).toHaveBeenCalledExactlyOnceWith(session.id,7);
  });

  it('歷史唯讀判斷採台北日期，UTC 尚未換日時前一天場次已唯讀',async()=>{
    vi.setSystemTime(new Date('2026-10-06T16:30:00Z'));
    await render({...session,sessionDate:'2026-10-06',roomCount:6});
    expect(countInput().value).toBe('6');expect(button('儲存診間數量').disabled).toBe(true);
    await render({...session,sessionDate:'2026-10-07',roomCount:6});
    expect(button('儲存診間數量').disabled).toBe(false);
  });

  it.each([
    ['room_count_in_progress:診間 5','無法減少診間數量：診間5目前檢查中。'],
    ['room_count_away:診間 5','無法減少診間數量：診間5目前暫時離開。'],
    ['room_count_unfinished:room_5','無法減少診間數量：診間5有尚未完成的受檢者資料。'],
  ])('安全檢查失敗 %s 時顯示清楚原因並保留輸入及原場次',async(error,message)=>{
    remote.update.mockRejectedValueOnce({message:error});
    await render({...session,roomCount:6});await input('4');
    await click(button('儲存診間數量'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(countInput().value).toBe('4');
    expect(container.textContent).toContain('超音波診間：6間');
    expect(onSaved).not.toHaveBeenCalled();
    expect(button('儲存診間數量').disabled).toBe(false);
  });

  it('雲端已保存但刷新失敗時明確告知保存結果',async()=>{
    onSaved.mockRejectedValueOnce(new Error('網路中斷'));
    await render();await input('6');await click(button('儲存診間數量'));
    expect(remote.update).toHaveBeenCalledExactlyOnceWith(session.id,6);
    expect(onSaved).toHaveBeenCalledWith({...session,roomCount:6});
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('診間數量已儲存至雲端，但場次重新載入失敗：網路中斷');
    expect(countInput().value).toBe('6');
  });

  it('保存處理中禁止重複提交，成功前不更新場次',async()=>{
    let resolve!:(value:Session)=>void;
    remote.update.mockImplementationOnce(()=>new Promise<Session>(done=>{resolve=done;}));
    await render();await input('6');
    await act(async()=>{button('儲存診間數量').click();button('儲存診間數量').click();});
    expect(remote.update).toHaveBeenCalledTimes(1);expect(onSaved).not.toHaveBeenCalled();
    expect(countInput().disabled).toBe(true);
    await act(async()=>{resolve({...session,roomCount:6});});
    expect(onSaved).toHaveBeenCalledTimes(1);expect(countInput().disabled).toBe(false);
  });

  it('切換場次或收到同場次更新時重新載入各自診間數量',async()=>{
    await render({...session,roomCount:3});
    expect(preview()).toEqual(['診間1','診間2','診間3']);
    await input('5');
    await render({...session,id:'other-session',roomCount:2});
    expect(countInput().value).toBe('2');expect(preview()).toHaveLength(2);
    await render({...session,id:'other-session',roomCount:8});
    expect(countInput().value).toBe('8');expect(preview()).toHaveLength(8);
    expect(remote.update).not.toHaveBeenCalled();
  });

  it('舊場次未帶診間數量時仍顯示預設四間',async()=>{
    await render({...session,roomCount:undefined});
    expect(countInput().value).toBe('4');expect(preview()).toHaveLength(4);
    expect(container.textContent).toContain('超音波診間：4間');
  });
});
