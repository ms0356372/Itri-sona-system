import {useEffect,useState} from 'react';
import {Clipboard,Download,Minus,Plus,RotateCcw,SlidersHorizontal,X} from 'lucide-react';
import {clampUltrasoundUiValue,exportUltrasoundUiSettings,ultrasoundUiPresets,ultrasoundUiSettingGroups,validateUltrasoundUiSettings,type UltrasoundUiPreset,type UltrasoundUiSettingKey,type UltrasoundUiSettings} from './ultrasoundUiSettings';

interface Diagnostics {width:number;height:number;dpr:number;sidebarOverflow:boolean;historyOverflow:boolean;pageOverflow:boolean}
const overflowing=(selector:string)=>{const element=document.querySelector<HTMLElement>(selector);return Boolean(element&&element.scrollWidth>element.clientWidth+1);};

export function UltrasoundUiSettingsPanel({settings,onChange,onReset,onClose}:{settings:UltrasoundUiSettings;onChange:(settings:UltrasoundUiSettings)=>void;onReset:()=>void;onClose:()=>void}){
  const[diagnostics,setDiagnostics]=useState<Diagnostics>({width:window.innerWidth,height:window.innerHeight,dpr:window.devicePixelRatio,sidebarOverflow:false,historyOverflow:false,pageOverflow:false});
  const[importOpen,setImportOpen]=useState(false);const[importText,setImportText]=useState('');const[notice,setNotice]=useState('');
  useEffect(()=>{const update=()=>requestAnimationFrame(()=>setDiagnostics({width:window.innerWidth,height:window.innerHeight,dpr:window.devicePixelRatio,sidebarOverflow:overflowing('.room-controls'),historyOverflow:overflowing('.room-history'),pageOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1}));update();window.addEventListener('resize',update);return()=>window.removeEventListener('resize',update);},[settings]);
  const setValue=(key:UltrasoundUiSettingKey,value:number)=>onChange({...settings,[key]:clampUltrasoundUiValue(key,value)});
  const copy=async()=>{try{await navigator.clipboard.writeText(exportUltrasoundUiSettings(settings));setNotice('目前設定已複製到剪貼簿。');}catch{setNotice('無法存取剪貼簿，請確認瀏覽器權限。');}};
  const applyImport=()=>{try{const result=validateUltrasoundUiSettings(JSON.parse(importText),settings);if(!result.accepted){setNotice('設定格式不正確，未匯入任何設定。');return;}onChange(result.settings);setNotice(result.invalid?'部分設定格式不正確，已略過。':'設定已匯入並立即套用。');setImportOpen(false);}catch{setNotice('設定格式不正確，請貼入有效的 JSON。');}};
  const hasOverflow=diagnostics.sidebarOverflow||diagnostics.historyOverflow||diagnostics.pageOverflow;
  return <aside className="room-ui-settings" role="dialog" aria-modal="false" aria-label="超音波診間 UI 調整">
    <header className="room-ui-settings-header"><div><h3><SlidersHorizontal size={20}/>UI 即時調整</h3><p>僅儲存在此設備，不影響檢查資料。</p></div><button className="room-settings-icon" aria-label="關閉 UI 調整" onClick={onClose}><X/></button></header>
    <div className="room-settings-body">
      <section><h4>快速模式</h4><div className="room-preset-grid">{([['standard','標準'],['large','大字'],['extraLarge','超大字']] as [UltrasoundUiPreset,string][]).map(([key,label])=><button key={key} onClick={()=>{onChange({...ultrasoundUiPresets[key]});setNotice(`已套用「${label}」模式，可繼續微調。`);}}>{label}</button>)}</div><p className="room-settings-hint">標準適合桌面；大字適合診間平板；超大字適合較遠距離閱讀。</p></section>
      <section className="room-diagnostics"><h4>目前畫面</h4><dl><dt>Viewport</dt><dd>{diagnostics.width} × {diagnostics.height}</dd><dt>Orientation</dt><dd>{diagnostics.width>=diagnostics.height?'Landscape':'Portrait'}</dd><dt>Device Pixel Ratio</dt><dd>{diagnostics.dpr}</dd><dt>左側水平捲動</dt><dd>{diagnostics.sidebarOverflow?'是':'否'}</dd><dt>歷年資料水平捲動</dt><dd>{diagnostics.historyOverflow?'是':'否'}</dd><dt>整頁水平捲動</dt><dd>{diagnostics.pageOverflow?'是':'否'}</dd></dl>{hasOverflow&&<p className="room-overflow-warning">目前版面發生水平溢出</p>}</section>
      {ultrasoundUiSettingGroups.map(group=><section key={group.title}><h4>{group.title}</h4><div className="room-setting-list">{group.settings.map(setting=><label key={setting.key} className="room-setting-control"><span><b>{setting.label}</b><output>{settings[setting.key]} px</output></span><div><button type="button" aria-label={`縮小${setting.label}`} onClick={()=>setValue(setting.key,settings[setting.key]-setting.step)}><Minus/></button><input aria-label={setting.label} type="range" min={setting.min} max={setting.max} step={setting.step} value={settings[setting.key]} onChange={event=>setValue(setting.key,event.currentTarget.valueAsNumber)}/><button type="button" aria-label={`放大${setting.label}`} onClick={()=>setValue(setting.key,settings[setting.key]+setting.step)}><Plus/></button></div></label>)}</div></section>)}
      <section><h4>匯出／匯入</h4><div className="room-settings-actions"><button onClick={()=>void copy()}><Clipboard/>複製目前設定</button><button onClick={()=>setImportOpen(value=>!value)}><Download/>匯入設定</button></div>{importOpen&&<div className="room-settings-import"><label htmlFor="room-settings-json">貼入 JSON 設定</label><textarea id="room-settings-json" value={importText} onChange={event=>setImportText(event.target.value)} placeholder={'{\n  "sidebarWidth": 155,\n  "historyTextSize": 27\n}'}/><button onClick={applyImport}>確認匯入</button></div>}</section>
      {notice&&<p className="room-settings-notice" role="status">{notice}</p>}
      <button className="room-settings-reset" onClick={()=>{if(confirm('確定恢復超音波診間預設版面？')){onReset();setNotice('已恢復系統預設版面。');}}}><RotateCcw/>恢復預設值</button>
    </div>
  </aside>;
}
