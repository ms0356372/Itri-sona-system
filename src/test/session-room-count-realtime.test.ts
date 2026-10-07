import {beforeEach,describe,expect,it,vi} from 'vitest';

const remote=vi.hoisted(()=>({channel:vi.fn(),removeChannel:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>remote}));

import {subscribeSessions} from '../features/sync/realtime';

describe('場次設定Realtime訂閱',()=>{
  beforeEach(()=>{remote.channel.mockReset();remote.removeChannel.mockReset();});

  it('訂閱health_sessions變更，連線和重新連線均重新讀取避免遺漏數量事件',()=>{
    let change!:()=>void;let status!:(value:string)=>void;
    const channel={on:vi.fn(),subscribe:vi.fn()};
    channel.on.mockImplementation((_event:string,_filter:Record<string,string>,callback:()=>void)=>{change=callback;return channel;});
    channel.subscribe.mockImplementation((callback:(value:string)=>void)=>{status=callback;return channel;});
    remote.channel.mockReturnValue(channel);
    const onChange=vi.fn();const cleanup=subscribeSessions(onChange);
    expect(channel.on).toHaveBeenCalledWith('postgres_changes',{event:'*',schema:'public',table:'health_sessions'},expect.any(Function));
    change();status('SUBSCRIBED');status('CHANNEL_ERROR');status('SUBSCRIBED');
    expect(onChange).toHaveBeenCalledTimes(3);
    cleanup();expect(remote.removeChannel).toHaveBeenCalledWith(channel);
  });
});
