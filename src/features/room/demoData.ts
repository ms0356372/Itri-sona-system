export const ultrasoundItems=['腹部超音波','甲狀腺超音波','婦科超音波','前列腺超音波','乳房超音波'] as const;
export type UltrasoundItem=typeof ultrasoundItems[number];
export interface HistoryVisit{date:string;result:string;details?:Record<string,string>;labs?:Record<string,string>}

export const demoHistory:Record<UltrasoundItem,HistoryVisit[]>={
  腹部超音波:[
    {date:'2025/09/10',result:'輕度脂肪肝',details:{肝臟:'輕度脂肪肝',膽囊:'未見明顯異常',胰臟:'未見明顯異常',脾臟:'未見明顯異常',腎臟:'左腎囊腫 0.8 cm',其他:'無'},labs:{HBsAg:'陰性', 'Anti-HBs':'陽性 126.4 mIU/mL','Anti-HCV':'陰性'}},
    {date:'2025/03/15',result:'脂肪肝',details:{肝臟:'脂肪肝',膽囊:'膽囊息肉 0.4 cm',胰臟:'未見明顯異常',脾臟:'未見明顯異常',腎臟:'未見明顯異常',其他:'無'},labs:{HBsAg:'陰性','Anti-HBs':'陽性 118.0 mIU/mL','Anti-HCV':'陰性'}},
    {date:'2024/08/20',result:'未見明顯異常',details:{肝臟:'未見明顯異常',膽囊:'未見明顯異常',胰臟:'未見明顯異常',脾臟:'未見明顯異常',腎臟:'未見明顯異常',其他:'無'},labs:{HBsAg:'陰性','Anti-HBs':'陽性 102.7 mIU/mL','Anti-HCV':'陰性'}},
  ],
  甲狀腺超音波:[{date:'2025/11/02',result:'右葉低回音結節 0.5 cm'},{date:'2025/02/18',result:'雙側甲狀腺結節'},{date:'2023/07/12',result:'未見明顯異常'}],
  婦科超音波:[],
  前列腺超音波:[{date:'2024/09/01',result:'前列腺體積 28 mL'},{date:'2023/08/22',result:'未見明顯異常'}],
  乳房超音波:[{date:'2025/06/18',result:'左側：囊腫；右側：未見明顯異常'},{date:'2024/12/02',result:'雙側纖維囊腫變化'},{date:'2024/04/11',result:'右側低回音結節 0.6 cm'}],
};
