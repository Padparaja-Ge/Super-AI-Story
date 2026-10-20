export function contextSwipe({startX,startY,endX,endY,width,open}){
  const dx=endX-startX,dy=endY-startY;
  if(Math.abs(dx)<56||Math.abs(dx)<Math.abs(dy)*1.5)return null;
  if(open&&dx>0)return 'close';
  if(!open&&startX>=width-48&&dx<0)return 'open';
  return null;
}
