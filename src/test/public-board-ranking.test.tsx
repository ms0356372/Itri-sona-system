import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {PublicBoard} from '../features/public-board/PublicBoard';
import {fetchPublicBoard,type PublicBoardData,type PublicBoardPerson} from '../features/public-board/service';

vi.mock('../features/public-board/service',()=>({fetchPublicBoard:vi.fn()}));
vi.mock('qrcode.react',()=>({QRCodeSVG:()=>null}));

const eligibleLabel='可進入超音波等候區';
const waiting:PublicBoardPerson[]=[
  {employeeNo:'900005',maskedName:'王○明'},
  {employeeNo:'120080',maskedName:'林○華'},
  {employeeNo:'700010',maskedName:'陳○志'},
  {employeeNo:'000210',maskedName:'張○婷'},
  {employeeNo:'500007',maskedName:'李○華'},
];
const data=(people:PublicBoardPerson[]):PublicBoardData=>({companyName:'ITRI',sessionDate:'2026-10-16',people});
const read=vi.mocked(fetchPublicBoard);
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
let container:HTMLDivElement;
let root:Root;

async function flush(){for(let i=0;i<8;i++)await Promise.resolve();}
async function mount(){await act(async()=>{root.render(<PublicBoard token="public-token"/>);await flush();});}
async function poll(people:PublicBoardPerson[]){
  read.mockResolvedValueOnce(data(people));
  await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
}
const rows=()=>Array.from(container.querySelectorAll('ol[aria-label="等候受檢者"] > li'));
const ranks=()=>rows().map(row=>row.querySelector('[aria-label^="看板順位 "]')?.textContent);
function expectPeople(people:PublicBoardPerson[]){
  expect(rows()).toHaveLength(people.length);
  rows().forEach((row,index)=>{
    expect(row.textContent).toContain(people[index].employeeNo);
    expect(row.textContent).toContain(people[index].maskedName);
    expect(row.querySelector(`[aria-label="看板順位 ${index+1}"]`)?.textContent).toBe(String(index+1));
  });
}
function expectEligibility(){
  rows().forEach((row,index)=>{
    expect(row.textContent?.includes(eligibleLabel)).toBe(index<3);
  });
  expect(rows().filter(row=>row.textContent?.includes(eligibleLabel))).toHaveLength(Math.min(rows().length,3));
}

describe('公開看板即時順位與前三名遞補',()=>{
  beforeEach(()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T03:36:00Z'));
    vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
    read.mockReset();
    read.mockResolvedValue(data(waiting));
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{
    await act(async()=>{root.unmount();});
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;
  });

  it('五位等候者依伺服器 queue 順序顯示看板順位 1 至 5',async()=>{
    await mount();
    expectPeople(waiting);
    expect(ranks()).toEqual(['1','2','3','4','5']);
    expect(container.textContent).not.toContain('checkinNo');
  });

  it('僅前三名顯示可進入等候區 badge、淺綠底，其餘維持白底且沒有其他狀態文字',async()=>{
    await mount();
    expectEligibility();
    rows().forEach((row,index)=>{
      if(index<3){
        expect(row.classList.contains('bg-emerald-50')).toBe(true);
        const badge=Array.from(row.querySelectorAll('*')).find(element=>element.textContent===eligibleLabel);
        expect(badge?.classList.contains('bg-emerald-100')).toBe(true);
      }else{
        expect(row.classList.contains('bg-white')).toBe(true);
        expect(row.textContent).toBe(`${index+1}${waiting[index].employeeNo}${waiting[index].maskedName}`);
      }
      expect(row.className).not.toMatch(/(?:bg|text|border)-(?:red|amber)-/);
    });
  });

  it.each([0,1,2])('%i 位等候者時僅對實際存在的前三名標示，不建立空白順位',async count=>{
    read.mockResolvedValueOnce(data(waiting.slice(0,count)));
    await mount();
    expectPeople(waiting.slice(0,count));
    expect(ranks()).toEqual(Array.from({length:count},(_,index)=>String(index+1)));
    expectEligibility();
    if(count===0)expect(container.textContent).toContain('目前無受檢者等候超音波檢查');
  });

  it('第一名被叫號離開後，下一次十秒更新將原 2、3、4 名依序遞補為 1、2、3',async()=>{
    await mount();
    await poll(waiting.slice(1));
    expectPeople(waiting.slice(1));
    expect(ranks()).toEqual(['1','2','3','4']);
    expect(container.textContent).not.toContain(waiting[0].employeeNo);
    expectEligibility();
    expect(rows()[2].textContent).toContain(waiting[3].employeeNo);
    expect(rows()[2].textContent).toContain(eligibleLabel);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('前兩人離開名單後，原第五名自動成為第三名並取得進入等候區提示',async()=>{
    await mount();
    await poll(waiting.slice(2));
    expectPeople(waiting.slice(2));
    expect(ranks()).toEqual(['1','2','3']);
    expect(rows()[2].textContent).toContain(waiting[4].employeeNo);
    expect(rows()[2].textContent).toContain(eligibleLabel);
    expectEligibility();
  });

  it('重新加入等候名單者回到既有 queue 順位，重新編號並更新前三名',async()=>{
    read.mockResolvedValueOnce(data(waiting.slice(1)));
    await mount();
    expectPeople(waiting.slice(1));
    expect(rows()[2].textContent).toContain(waiting[3].employeeNo);
    expect(rows()[2].textContent).toContain(eligibleLabel);
    await poll(waiting);
    expectPeople(waiting);
    expect(ranks()).toEqual(['1','2','3','4','5']);
    expectEligibility();
    expect(rows()[3].textContent).toContain(waiting[3].employeeNo);
    expect(rows()[3].textContent).not.toContain(eligibleLabel);
  });

  it.each([
    {mode:'standard',sourceQueue:['A1','A2','A10','B1'],people:[waiting[2],waiting[0],waiting[3],waiting[1]]},
    {mode:'simple',sourceQueue:['1','2','3','10'],people:[waiting[4],waiting[2],waiting[1],waiting[0]]},
  ])('$mode 依既有 RPC 的 $sourceQueue 排序結果產生序號，不以工號或姓名重新排序',async({people,sourceQueue})=>{
    // Queue labels document the server-side fixture order; they are never public response fields.
    read.mockResolvedValueOnce(data(people));
    await mount();
    expectPeople(people);
    expect(ranks()).toEqual(['1','2','3','4']);
    expectEligibility();
    expect(people.map(person=>person.employeeNo)).not.toEqual(people.map(person=>person.employeeNo).sort());
    for(const queue of sourceQueue.filter(value=>value.startsWith('A')||value.startsWith('B'))){
      expect(container.textContent).not.toContain(queue);
    }
  });

  it('看板順位僅於前端產生，不修改公開回應、加上敏感欄位或改變讀取參數',async()=>{
    const payload=data(waiting.map(person=>({...person})));
    const original=structuredClone(payload);
    payload.people.forEach(person=>Object.freeze(person));
    Object.freeze(payload.people);Object.freeze(payload);
    read.mockResolvedValue(payload);
    await mount();
    await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
    expectPeople(original.people);
    expect(ranks()).toEqual(['1','2','3','4','5']);
    expect(payload).toEqual(original);
    expect(Object.keys(payload).sort()).toEqual(['companyName','people','sessionDate']);
    for(const person of payload.people){
      expect(Object.keys(person).sort()).toEqual(['employeeNo','maskedName']);
    }
    expect(read).toHaveBeenCalledTimes(2);
    for(const args of read.mock.calls){
      expect(args).toEqual(['public-token',expect.any(AbortSignal)]);
    }
    for(const forbidden of ['checkinNo','queueNumber','A1','B1','姓名','身分證','性別','檢查項目','診間','medical']){
      expect(container.textContent).not.toContain(forbidden);
    }
  });
});
