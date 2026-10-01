export const availableRoomHeight=(viewportHeight:number,workspaceTop:number,bottomGap:number,viewportOffsetTop=0)=>
  Math.max(0,Math.floor(viewportHeight+viewportOffsetTop-workspaceTop-bottomGap));
