import {QRCodeSVG} from 'qrcode.react';

export function BoardQrCode({value,size=152}:{value:string;size?:number}){
  return <QRCodeSVG value={value} size={size} level="M" marginSize={4} role="img" title="公開等候看板 QR Code" className="max-w-full rounded-lg bg-white"/>;
}
