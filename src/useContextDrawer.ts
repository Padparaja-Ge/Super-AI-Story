import {useEffect,useRef,useState,type TouchEvent} from 'react';
import {contextSwipe} from '../shared/context-swipe.mjs';

export function useContextDrawer(){
  const [compact,setCompact]=useState(()=>window.matchMedia('(max-width:1150px)').matches);
  const [desktopOpen,setDesktopOpen]=useState(true),[mobileOpen,setMobileOpen]=useState(false);
  const start=useRef<{x:number;y:number}|null>(null);
  const open=compact?mobileOpen:desktopOpen;
  const close=()=>compact?setMobileOpen(false):setDesktopOpen(false);
  useEffect(()=>{const media=window.matchMedia('(max-width:1150px)'),change=()=>{setCompact(media.matches);setMobileOpen(false);};media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
  useEffect(()=>{if(!compact||!mobileOpen)return;const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')setMobileOpen(false);};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[compact,mobileOpen]);
  const onTouchStart=(event:TouchEvent)=>{
    start.current=null;
    if(!compact||event.touches.length!==1||(event.target as Element).closest('input,textarea,select,button,a,[contenteditable=true]'))return;
    start.current={x:event.touches[0].clientX,y:event.touches[0].clientY};
  };
  const onTouchEnd=(event:TouchEvent)=>{
    const origin=start.current;start.current=null;if(!origin||event.changedTouches.length!==1)return;
    const end=event.changedTouches[0],action=contextSwipe({startX:origin.x,startY:origin.y,endX:end.clientX,endY:end.clientY,width:window.innerWidth,open:mobileOpen});
    if(action)setMobileOpen(action==='open');
  };
  return {open,compact,close,toggle:()=>compact?setMobileOpen(v=>!v):setDesktopOpen(v=>!v),gestures:{onTouchStart,onTouchEnd,onTouchCancel:()=>{start.current=null;}}};
}
