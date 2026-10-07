// Viewing local history must not load the Excel parser.
export const isNormalUltrasoundResult=(value:string)=>['無明顯異樣','未見明顯異常','無明顯異常','無異樣'].includes(value.trim());
export const displayUltrasoundResult=(value:string)=>isNormalUltrasoundResult(value)?'':value;
