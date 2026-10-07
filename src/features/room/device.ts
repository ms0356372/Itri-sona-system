export type DeviceIdentity={deviceId:string;claimSecret:string};
const deviceKey='itri-device-id';
const secretKey='itri-device-claim-secret';
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getDeviceIdentity():DeviceIdentity{
  try{
    let deviceId=localStorage.getItem(deviceKey);
    let claimSecret=localStorage.getItem(secretKey);
    if(!deviceId||!uuidPattern.test(deviceId)){
      deviceId=crypto.randomUUID();
      localStorage.setItem(deviceKey,deviceId);
    }
    if(!claimSecret||!/^[0-9a-f]{64}$/.test(claimSecret)){
      const bytes=crypto.getRandomValues(new Uint8Array(32));
      claimSecret=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
      localStorage.setItem(secretKey,claimSecret);
    }
    return{deviceId,claimSecret};
  }catch{
    throw new Error('無法建立診間裝置識別，請確認瀏覽器允許本機儲存並使用安全連線。');
  }
}
