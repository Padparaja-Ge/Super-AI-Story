import {useState} from 'react';
import {type StudioProps,type View} from './types';
import {Button,Field,SectionHeader} from './UI';
import {LanguageSettings,ComfySettings} from './Services';
import {NetworkSettings} from './NetworkSettings';
import {BeginnerGuideSettings} from './BeginnerGuide';
import {Diagnostics} from './Diagnostics';
import {AutosaveSettings} from './AutosaveSettings';

export function TechnicalSettings(props:StudioProps & {navigate:(view:View)=>void}){
  const {state,update,navigate}=props;
  const [section,setSection]=useState('language');
  return <div className="page settings-page"><SectionHeader title="Настройки" eyebrow="ПРИЛОЖЕНИЕ" description="Технические параметры применяются ко всей студии."/>
    <div className="tabs wide-tabs">{[['guide','Первые шаги'],['autosave','Сохранение'],['diagnostics','Журнал и диагностика'],['language','Язык и исправления'],['appearance','Цвет и размер шрифта'],['profile','Профиль'],['models','Модели и API'],['network','Веб-сервер и сеть'],['comfy','ComfyUI']].map(([id,label])=><button key={id} className={section===id?'active':''} onClick={()=>id==='models'?navigate('models'):id==='appearance'?navigate('appearance'):setSection(id)}>{label}</button>)}</div>
    <section className="panel settings-panel">{section==='guide'&&<BeginnerGuideSettings/>}{section==='autosave'&&<AutosaveSettings flush={props.flush} notify={props.notify} task={props.task}/>}{section==='diagnostics'&&<Diagnostics/>}{section==='language'&&<LanguageSettings {...props}/>}{section==='comfy'&&<ComfySettings {...props}/>}{section==='network'&&<NetworkSettings notify={props.notify}/>}
      {section==='profile'&&<><h3>Профиль</h3><Field label="Имя пользователя" hint="Общее имя профиля. Персоны для игры настраиваются отдельно."><input value={state.settings.userName} onChange={e=>update(s=>{s.settings.userName=e.target.value;})}/></Field><Button onClick={()=>navigate('personas')}>Открыть персоны</Button></>}
    </section>
  </div>;
}
