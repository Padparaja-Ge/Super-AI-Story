import {type StoryImage as ImageRecord} from './types';
import {api} from './api';
import {Button,Spinner} from './UI';
export function StoryImageCard({image:i,refresh,notify}:{image:ImageRecord;refresh:()=>Promise<void>;notify:(text:string,error?:boolean)=>void}){
  return <figure className="story-image">{i.status==='done'?i.files.map((_,index)=><a key={index} href={`/api/images/${i.id}/${index}`} target="_blank" rel="noreferrer"><img src={`/api/images/${i.id}/${index}`} alt="Изображение сцены" loading="lazy"/></a>):<div className="loading-row">{i.status==='queued'&&<Spinner/>}{i.status==='queued'?'ComfyUI создаёт изображение…':i.status==='cancelled'?'Отслеживание остановлено':'Ошибка изображения'}</div>}<figcaption><details><summary>{i.workflowName||'ComfyUI'} · промпт изображения</summary><p>{i.prompt}</p></details>{i.error&&<p className="error-text">{i.error}</p>}{i.status==='queued'&&<Button onClick={()=>api(`/images/${i.id}/cancel`,{}).then(refresh).catch(e=>notify(e.message,true))}>Отменить ожидание</Button>}</figcaption></figure>;
}
