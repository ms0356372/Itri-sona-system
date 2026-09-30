import {beforeEach,describe,expect,it} from 'vitest';
import {clampUltrasoundUiValue,defaultUltrasoundUiSettings,exportUltrasoundUiSettings,loadUltrasoundUiSettings,saveUltrasoundUiSettings,ULTRASOUND_UI_STORAGE_KEY,ultrasoundUiPresets,validateUltrasoundUiSettings} from '../features/room/ultrasoundUiSettings';

describe('ultrasound room UI settings',()=>{
  beforeEach(()=>localStorage.clear());

  it('clamps values to each setting range and step',()=>{
    expect(clampUltrasoundUiValue('sidebarWidth',10)).toBe(120);
    expect(clampUltrasoundUiValue('sidebarWidth',263)).toBe(260);
    expect(clampUltrasoundUiValue('examButtonHeight',47)).toBe(48);
    expect(clampUltrasoundUiValue('historyTextSize',100)).toBe(34);
  });

  it('persists a complete setting set on this device',()=>{
    const settings={...defaultUltrasoundUiSettings,sidebarWidth:155,historyTextSize:27,historyCellPaddingY:9};
    saveUltrasoundUiSettings(settings);
    expect(localStorage.getItem(ULTRASOUND_UI_STORAGE_KEY)).toBeTruthy();
    expect(loadUltrasoundUiSettings()).toEqual(settings);
  });

  it('imports valid fields, clamps out-of-range values, and ignores invalid fields',()=>{
    const result=validateUltrasoundUiSettings({sidebarWidth:10,historyTextSize:27,examButtonHeight:'tiny',unknown:123});
    expect(result.settings.sidebarWidth).toBe(120);
    expect(result.settings.historyTextSize).toBe(27);
    expect(result.settings.examButtonHeight).toBe(defaultUltrasoundUiSettings.examButtonHeight);
    expect(result).toMatchObject({accepted:2,invalid:true});
  });

  it('falls back safely when saved JSON is malformed',()=>{
    localStorage.setItem(ULTRASOUND_UI_STORAGE_KEY,'{oops');
    expect(loadUltrasoundUiSettings()).toEqual(defaultUltrasoundUiSettings);
  });

  it('provides three independent presets and readable plus JSON export',()=>{
    expect(ultrasoundUiPresets.large.historyTextSize).toBeGreaterThan(ultrasoundUiPresets.standard.historyTextSize);
    expect(ultrasoundUiPresets.extraLarge.historyTextSize).toBeGreaterThan(ultrasoundUiPresets.large.historyTextSize);
    const exported=exportUltrasoundUiSettings(ultrasoundUiPresets.standard);
    expect(exported).toContain('Ultrasound Room UI Settings');
    expect(exported).toContain(`sidebarWidth=${defaultUltrasoundUiSettings.sidebarWidth}`);
    expect(exported).toContain('"historyTextSize"');
  });
});
