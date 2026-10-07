import {beforeEach,describe,expect,it,vi} from 'vitest';
import {getDeviceIdentity} from '../features/room/device';

const DEVICE_KEY='itri-device-id';
const SECRET_KEY='itri-device-claim-secret';
const uuid='11111111-1111-4111-8111-111111111111';
const secret='b'.repeat(64);

describe('每個瀏覽器持久化的診間裝置身份',()=>{
  beforeEach(()=>{localStorage.clear();vi.restoreAllMocks();});

  it('首次產生可持久化的裝置 UUID 與 32 bytes 不公開密鑰',()=>{
    const result=getDeviceIdentity();
    expect(result.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.claimSecret).toMatch(/^[0-9a-f]{64}$/i);
    expect(localStorage.getItem(DEVICE_KEY)).toBe(result.deviceId);
    expect(localStorage.getItem(SECRET_KEY)).toBe(result.claimSecret);
    expect(getDeviceIdentity()).toEqual(result);
  });

  it('重新載入沿用完整儲存身份，不能生成另一個裝置搶自己的診間',()=>{
    localStorage.setItem(DEVICE_KEY,uuid);localStorage.setItem(SECRET_KEY,secret);
    expect(getDeviceIdentity()).toEqual({deviceId:uuid,claimSecret:secret});
  });

  it('舊版只有裝置 ID 時補產密鑰並保留原 ID',()=>{
    localStorage.setItem(DEVICE_KEY,uuid);
    const result=getDeviceIdentity();
    expect(result.deviceId).toBe(uuid);expect(result.claimSecret).toMatch(/^[0-9a-f]{64}$/i);
    expect(localStorage.getItem(SECRET_KEY)).toBe(result.claimSecret);
  });

  it('不同瀏覽器沒有儲存身份時產生不同 ID 與密鑰',()=>{
    const first=getDeviceIdentity();localStorage.clear();const second=getDeviceIdentity();
    expect(second.deviceId).not.toBe(first.deviceId);expect(second.claimSecret).not.toBe(first.claimSecret);
  });

  it('破損身份或短密鑰必須重新產生有效格式',()=>{
    localStorage.setItem(DEVICE_KEY,'invalid-id');localStorage.setItem(SECRET_KEY,'short-secret');
    const result=getDeviceIdentity();
    expect(result.deviceId).not.toBe('invalid-id');expect(result.claimSecret).toMatch(/^[0-9a-f]{64}$/i);
  });

  it('本機儲存被禁止時拒絕操作，不能臨時建立不持久化的第二裝置',()=>{
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('storage denied');});
    expect(()=>getDeviceIdentity()).toThrow('無法建立診間裝置識別');
  });

  it('密鑰採 crypto 隨機來源，不能由公開裝置 ID 推導',()=>{
    const random=vi.spyOn(crypto,'getRandomValues');
    getDeviceIdentity();
    expect(random).toHaveBeenCalled();
    expect(random.mock.calls.some(([buffer])=>buffer?.byteLength===32)).toBe(true);
  });
});
