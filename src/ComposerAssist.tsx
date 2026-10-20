import {useEffect,useState,useRef} from 'react';
import {WandSparkles,ImagePlus,Languages} from 'lucide-react';
import {type StudioProps,type Chat} from './types';
import {Button,Field,Modal,Spinner} from './UI';
import {api} from './api';
type Match={offset:number;length:number;message:string;replacements:string[]};
export function ComposerAssist({state,task,flush,refresh,notify,chat,input,onInput}:StudioProps & {chat:Chat;input:string;onInput:(value:string)=>void}){
  const [matches,setMatches]=useState<Match[]>([]),[checked,setChecked]=useState(''),[grammarError,setGrammarError]=useState(''),[checking,setChecking]=useState(false);
  const [rewrite,setRewrite]=useState<string|null>(null),[busy,setBusy]=useState(''),[imageOpen,setImageOpen]=useState(false),[imagePrompt,setImagePrompt]=useState(''),[instructions,setInstructions]=useState('');
  const [rewriteError,setRewriteError]=useState(''),[rewriteSource,setRewriteSource]=useState('');
  const currentChat=useRef(chat.id);currentChat.current=chat.id;
  useEffect(()=>{setRewrite(null);setRewriteError('');},[chat.id]);
  const improve=async()=>{
    const chatId=chat.id,draft=input;
    setRewrite('');setRewriteSource(draft);setRewriteError('');setBusy('rewrite');
    try{
      await flush();
      const result=await api<{text:string}>(`/chats/${chatId}/rewrite`,{text:draft});
      if(typeof result.text!=='string'||!result.text.trim())throw new Error('Модель не вернула улучшенный текст.');
      if(currentChat.current===chatId)setRewrite(current=>current===null?null:result.text);
    }catch(e:any){if(currentChat.current===chatId)setRewriteError(e.message);}
    finally{setBusy('');}
  };
  const locked=task?.status==='running'||!!busy;
  useEffect(()=>{
    setMatches([]);setGrammarError('');setChecking(false);
    if(!state.settings.grammar.enabled||!input.trim()||input.length>20000)return;
    let cancelled=false;
    const timer=setTimeout(async()=>{setChecking(true);try{await flush();const result=await api('/grammar',{text:input});if(!cancelled){setMatches(result.matches);setChecked(input);}}catch(e:any){if(!cancelled)setGrammarError(e.message);}finally{if(!cancelled)setChecking(false);}},1100);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[input,state.settings.grammar]);
  const visible=checked===input?matches:[];
  const operation=async(name:string,fn:()=>Promise<void>)=>{setBusy(name);try{await flush();await fn();}catch(e:any){notify(e.message,true);}finally{setBusy('');}};
  const applyAll=()=>{let next=input;let boundary=input.length;for(const m of [...visible].sort((a,b)=>b.offset-a.offset)){if(m.replacements.length&&m.offset+m.length<=boundary){next=next.slice(0,m.offset)+m.replacements[0]+next.slice(m.offset+m.length);boundary=m.offset;}}onInput(next);};
  let cursor=0;const highlights:React.ReactNode[]=[];for(const m of [...visible].sort((a,b)=>a.offset-b.offset)){if(m.offset<cursor)continue;highlights.push(input.slice(cursor,m.offset));highlights.push(<mark key={m.offset} title={m.message}>{input.slice(m.offset,m.offset+m.length)}</mark>);cursor=m.offset+m.length;}highlights.push(input.slice(cursor));
  return <><div className="assist-toolbar"><Button disabled={!input.trim()||locked} onClick={improve}>{busy==='rewrite'?<Spinner/>:<WandSparkles size={15}/>}Улучшить текст</Button><Button disabled={locked} onClick={()=>setImageOpen(true)}><ImagePlus size={15}/>Изображение сцены</Button>{state.settings.translation.enabled&&<span className="badge"><Languages size={13}/>{state.settings.translation.provider} · {state.settings.translation.modelLanguage} ↔ {state.settings.translation.displayLanguage}</span>}{checking&&<span className="muted small"><Spinner/>Проверка текста</span>}</div>{grammarError&&<div className="grammar-feedback error-text">{grammarError}</div>}{visible.length>0&&<div className="grammar-feedback"><div className="grammar-preview">{highlights}</div><div className="row"><strong>Возможные ошибки: {visible.length}</strong><Button onClick={applyAll}>Исправить все</Button></div>{visible.map((m,i)=><div className="grammar-suggestion" key={i}><span><mark>{input.slice(m.offset,m.offset+m.length)||'Пробел'}</mark> — {m.message}</span><div>{m.replacements.map(value=><button key={value} onClick={()=>onInput(input.slice(0,m.offset)+value+input.slice(m.offset+m.length))}>{value||'Удалить'}</button>)}</div></div>)}</div>}{rewrite!==null&&<Modal title="AI-редактирование черновика" onClose={()=>setRewrite(null)}><Field label="Исходный черновик"><p className="translation-preview">{rewriteSource}</p></Field>{busy==='rewrite'?<p role="status"><Spinner/>Модель разворачивает текст для ролевой игры…</p>:rewriteError?<p className="error-text" role="alert">{rewriteError}</p>:<Field label="Предложенный вариант"><textarea rows={10} value={rewrite} onChange={e=>setRewrite(e.target.value)}/></Field>}{input!==rewriteSource&&<p className="muted small">Черновик в поле сообщения уже изменился. Скопируйте нужный фрагмент из предложенного варианта.</p>}<div className="row"><Button primary disabled={busy==='rewrite'||!!rewriteError||!rewrite.trim()||input!==rewriteSource} onClick={()=>{onInput(rewrite);setRewrite(null);}}>Вставить в поле сообщения</Button><Button disabled={locked||!input.trim()} onClick={improve}>Другой вариант</Button><Button onClick={()=>setRewrite(null)}>Закрыть</Button></div></Modal>}{imageOpen&&<Modal title="Изображение текущей сцены · ComfyUI" onClose={()=>setImageOpen(false)}><p className="muted">Модель использует внешность {state.characters.find(c=>c.id===chat.characterId)?.name}, состояние сцены и последние 12 сообщений. Workflow: {state.settings.comfy.workflowName||'сначала загрузите в настройках ComfyUI'}.</p><Field label="Пожелания к изображению (необязательно)"><input value={instructions} onChange={e=>setInstructions(e.target.value)}/></Field><Button disabled={locked} onClick={()=>operation('image-prompt',async()=>setImagePrompt((await api(`/chats/${chat.id}/image-prompt`,{instructions})).prompt))}>{busy==='image-prompt'?<Spinner/>:<WandSparkles size={16}/>}Составить промпт по истории</Button><Field label="Промпт для ComfyUI"><textarea rows={9} value={imagePrompt} onChange={e=>setImagePrompt(e.target.value)}/></Field><Button primary disabled={locked||!imagePrompt.trim()} onClick={()=>operation('image',async()=>{await api(`/chats/${chat.id}/images`,{prompt:imagePrompt});await refresh();setImageOpen(false);notify('Workflow отправлен в ComfyUI. Изображение появится в этой истории.');})}>{busy==='image'?<Spinner/>:<ImagePlus size={16}/>}Запустить workflow</Button></Modal>}</>;
}
