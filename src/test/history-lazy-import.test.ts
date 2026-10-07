import {describe,expect,it,vi} from 'vitest';
import {displayUltrasoundResult,isNormalUltrasoundResult} from '../features/history/display';
import {parseHistoryFile} from '../features/history/import';
import type {ParsedHistoryFile,ParseProgress} from '../features/history/excel';

const parser=vi.hoisted(()=>({loaded:vi.fn(),parse:vi.fn()}));
vi.mock('../features/history/excel',()=>{
  parser.loaded();return{parseHistoryFile:parser.parse};
});

describe('歷年資料顯示與按需 Excel 解析',()=>{
  it('顯示歷年結果或載入解析入口都不會預先載入 Excel 模組，選檔才載入',async()=>{
    expect(parser.loaded).not.toHaveBeenCalled();
    expect(displayUltrasoundResult('輕度脂肪肝')).toBe('輕度脂肪肝');
    expect(parser.loaded).not.toHaveBeenCalled();
    const file=new File(['Excel'],'local-history.xlsx');
    const parsed:ParsedHistoryFile={records:[],missing:[],failed:0,rowErrors:[],headers:[],sheetName:'歷年',sourceRows:0};
    const progress=vi.fn<ParseProgress>();
    parser.parse.mockImplementationOnce(async(_file:File,onProgress?:ParseProgress)=>{
      onProgress?.({stage:'reading',processed:0,total:0});return parsed;
    });
    await expect(parseHistoryFile(file,progress)).resolves.toBe(parsed);
    expect(parser.loaded).toHaveBeenCalledOnce();expect(parser.parse).toHaveBeenCalledExactlyOnceWith(file,progress);
    expect(progress).toHaveBeenCalledExactlyOnceWith({stage:'reading',processed:0,total:0});
  });

  it('動態載入後仍傳遞原始解析錯誤，不將匯入失敗當成成功',async()=>{
    const error=new Error('Excel 沒有可讀取的工作表。');parser.parse.mockRejectedValueOnce(error);
    await expect(parseHistoryFile(new File(['bad'],'bad.xlsx'))).rejects.toBe(error);
  });

  it('顯示規則保持精確正常詞與數字零、異常描述的既有行為',()=>{
    for(const value of ['無明顯異樣','未見明顯異常','無明顯異常','無異樣']){
      expect(isNormalUltrasoundResult(` ${value} `)).toBe(true);expect(displayUltrasoundResult(` ${value} `)).toBe('');
    }
    for(const value of ['0','未見明顯異常，建議追蹤','輕度脂肪肝，其餘未見明顯異常','']){
      expect(displayUltrasoundResult(value)).toBe(value);
    }
  });
});
