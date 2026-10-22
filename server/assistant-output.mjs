// Keep model reasoning out of visible text, including markers split over SSE
// chunks. This never edits prompts, stored history, or reasoning API fields.
const markers=[
 ['<think>','hide'],['</think>','show'],['<analysis>','hide'],['</analysis>','show'],
 ...['<|channel>','<|channel|>'].flatMap(prefix=>[
  ...['analysis','thought','reasoning'].map(name=>[prefix+name,'hide']),
  [prefix+'final','show'],
 ]),
 ['<|message|>','skip'],
 // Gemma 4 closes its thought channel with the reversed channel token.
 ['<channel|>','show'],
];
export function createAssistantOutputFilter(){
 let pending='',hidden=false,previous='';
 const boundary=(text,index)=>index?/[\s>]/u.test(text[index-1]):!previous||/[\s>]/u.test(previous);
 function drain(final){
  let output='';
  while(pending){
   let found;
   for(let i=0;i<pending.length;i++){
    if(pending[i]!=='<'||(!hidden&&!boundary(pending,i)))continue;
    const tail=pending.slice(i).toLowerCase();
    const marker=markers.find(([token])=>tail.startsWith(token));
    if(marker){found={i,marker};break;}
    if(!final&&markers.some(([token])=>token.startsWith(tail))){found={i,partial:true};break;}
   }
   if(!found){if(!hidden)output+=pending;previous=pending.at(-1);pending='';break;}
   const prefix=pending.slice(0,found.i);if(!hidden)output+=prefix;
   if(prefix)previous=prefix.at(-1);
   pending=pending.slice(found.i);
   if(found.partial)break;
   const [token,action]=found.marker;pending=pending.slice(token.length);previous='>';
   if(action==='hide')hidden=true;else if(action==='show')hidden=false;
  }
  return output;
 }
 return {push(text){pending+=text;return drain(false);},flush(){return drain(true);}};
}
