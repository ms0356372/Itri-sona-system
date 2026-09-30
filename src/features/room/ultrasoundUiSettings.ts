export const ULTRASOUND_UI_STORAGE_KEY='itri-ultrasound-ui-settings';

export interface UltrasoundUiSettings {
  sidebarWidth:number; columnGap:number; toolbarPadding:number; historyTopSpacing:number;
  patientNumberSize:number; patientNameSize:number; patientDetailSize:number; patientCardPadding:number;
  examButtonHeight:number; examButtonFontSize:number; examButtonGap:number;
  historyMainTitleSize:number; historySectionTitleSize:number; historyDateSize:number; historyLabelSize:number; historyTextSize:number;
  bcTitleSize:number; bcTextSize:number; historyCellPaddingY:number; historyCellPaddingX:number; historyPanelGap:number;
  controlButtonHeight:number; controlButtonFontSize:number; bottomBarPadding:number;
}

export type UltrasoundUiSettingKey=keyof UltrasoundUiSettings;
export type UltrasoundUiPreset='standard'|'large'|'extraLarge';
export interface SettingDefinition {key:UltrasoundUiSettingKey;label:string;min:number;max:number;step:number}
export interface SettingGroup {title:string;settings:SettingDefinition[]}

export const defaultUltrasoundUiSettings:UltrasoundUiSettings={
  sidebarWidth:176,columnGap:12,toolbarPadding:10,historyTopSpacing:0,
  patientNumberSize:24,patientNameSize:24,patientDetailSize:13,patientCardPadding:8,
  examButtonHeight:46,examButtonFontSize:16,examButtonGap:4,
  historyMainTitleSize:14,historySectionTitleSize:24,historyDateSize:22,historyLabelSize:22,historyTextSize:20,
  bcTitleSize:22,bcTextSize:20,historyCellPaddingY:4,historyCellPaddingX:7,historyPanelGap:8,
  controlButtonHeight:44,controlButtonFontSize:14,bottomBarPadding:10,
};

export const ultrasoundUiPresets:Record<UltrasoundUiPreset,UltrasoundUiSettings>={
  standard:{...defaultUltrasoundUiSettings},
  large:{...defaultUltrasoundUiSettings,historyDateSize:24,historyLabelSize:24,historyTextSize:22,bcTitleSize:24,bcTextSize:22},
  extraLarge:{...defaultUltrasoundUiSettings,historyDateSize:26,historyLabelSize:26,historyTextSize:24,bcTitleSize:26,bcTextSize:24},
};

const setting=(key:UltrasoundUiSettingKey,label:string,min:number,max:number,step:number):SettingDefinition=>({key,label,min,max,step});
export const ultrasoundUiSettingGroups:SettingGroup[]=[
  {title:'版面',settings:[setting('sidebarWidth','左側操作欄寬度',120,260,5),setting('columnGap','左右區塊間距',0,24,1),setting('toolbarPadding','上方工具列 padding',2,20,1),setting('historyTopSpacing','歷年資料頂部間距',0,24,1)]},
  {title:'受檢者資訊',settings:[setting('patientNumberSize','報到號碼字體',18,40,1),setting('patientNameSize','姓名字體',18,40,1),setting('patientDetailSize','工號／時段／狀態字體',12,28,1),setting('patientCardPadding','受檢者卡片 padding',2,20,1)]},
  {title:'本次超音波按鈕',settings:[setting('examButtonHeight','超音波按鈕高度',36,72,2),setting('examButtonFontSize','超音波按鈕字體',14,26,1),setting('examButtonGap','超音波按鈕間距',2,16,1)]},
  {title:'歷年資料',settings:[setting('historyMainTitleSize','「歷年超音波資料」字體',12,32,1),setting('historySectionTitleSize','項目標題字體',18,36,1),setting('historyDateSize','日期表頭字體',16,36,1),setting('historyLabelSize','部位名稱字體',16,36,1),setting('historyTextSize','歷年結果內容字體',16,34,1),setting('bcTitleSize','B、C 肝標題字體',16,32,1),setting('bcTextSize','B、C 肝內容字體',16,32,1),setting('historyCellPaddingY','表格 cell 上下 padding',0,16,1),setting('historyCellPaddingX','表格 cell 左右 padding',2,20,1),setting('historyPanelGap','歷年資料區塊間距',0,24,1)]},
  {title:'開始／完成檢查',settings:[setting('controlButtonHeight','操作按鈕高度',36,72,2),setting('controlButtonFontSize','操作按鈕字體',14,26,1),setting('bottomBarPadding','底部操作列 padding',2,20,1)]},
];

const definitions=new Map(ultrasoundUiSettingGroups.flatMap(group=>group.settings).map(setting=>[setting.key,setting]));
export function clampUltrasoundUiValue(key:UltrasoundUiSettingKey,value:number){const definition=definitions.get(key)!;const clamped=Math.min(definition.max,Math.max(definition.min,value));return Math.round(clamped/definition.step)*definition.step;}
export function validateUltrasoundUiSettings(input:unknown,base=defaultUltrasoundUiSettings){
  const settings={...base};let invalid=false;
  if(!input||typeof input!=='object'||Array.isArray(input))return{settings,invalid:true,accepted:0};
  let accepted=0;
  for(const[key,value]of Object.entries(input)){if(!definitions.has(key as UltrasoundUiSettingKey)||typeof value!=='number'||!Number.isFinite(value)){invalid=true;continue;}const typedKey=key as UltrasoundUiSettingKey;settings[typedKey]=clampUltrasoundUiValue(typedKey,value);accepted++;}
  return{settings,invalid,accepted};
}
export function loadUltrasoundUiSettings(){try{const stored=localStorage.getItem(ULTRASOUND_UI_STORAGE_KEY);return stored?validateUltrasoundUiSettings(JSON.parse(stored)).settings:{...defaultUltrasoundUiSettings};}catch{return{...defaultUltrasoundUiSettings};}}
export function saveUltrasoundUiSettings(settings:UltrasoundUiSettings){localStorage.setItem(ULTRASOUND_UI_STORAGE_KEY,JSON.stringify(settings));}
export function exportUltrasoundUiSettings(settings:UltrasoundUiSettings){const readable=Object.entries(settings).map(([key,value])=>`${key}=${value}`).join('\n');return`Ultrasound Room UI Settings\n\n${readable}\n\nJSON\n${JSON.stringify(settings,null,2)}`;}

export const ultrasoundUiCssVariables:Record<UltrasoundUiSettingKey,`--${string}`>={
  sidebarWidth:'--room-sidebar-width',columnGap:'--room-column-gap',toolbarPadding:'--room-toolbar-padding',historyTopSpacing:'--room-history-top-spacing',patientNumberSize:'--patient-number-size',patientNameSize:'--patient-name-size',patientDetailSize:'--patient-detail-size',patientCardPadding:'--patient-card-padding',examButtonHeight:'--exam-button-height',examButtonFontSize:'--exam-button-font-size',examButtonGap:'--exam-button-gap',historyMainTitleSize:'--history-main-title-size',historySectionTitleSize:'--history-section-title-size',historyDateSize:'--history-date-size',historyLabelSize:'--history-label-size',historyTextSize:'--history-text-size',bcTitleSize:'--bc-title-size',bcTextSize:'--bc-text-size',historyCellPaddingY:'--history-cell-padding-y',historyCellPaddingX:'--history-cell-padding-x',historyPanelGap:'--history-panel-gap',controlButtonHeight:'--room-control-button-height',controlButtonFontSize:'--room-control-button-font-size',bottomBarPadding:'--room-bottom-bar-padding',
};
