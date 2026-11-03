import {t} from './i18n';
import {useState} from 'react';
import {type StudioProps,type View} from './types';
import {Button,Field,SectionHeader} from './UI';
import {LanguageSettings,ComfySettings} from './Services';
import {NetworkSettings} from './NetworkSettings';
import {BeginnerGuideSettings} from './BeginnerGuide';
import {Diagnostics} from './Diagnostics';
import {AutosaveSettings} from './AutosaveSettings';
import {InterfaceLanguage} from './InterfaceLanguage';

export function TechnicalSettings(props:StudioProps & {navigate:(view:View)=>void}){
  const {state,update,navigate}=props;
  const [section,setSection]=useState('language');
  return <div className="page settings-page"><SectionHeader title={t("Настройки")} eyebrow={t("ПРИЛОЖЕНИЕ")} description={t("Технические параметры применяются ко всей студии.")}/>
    <div className="tabs wide-tabs">{[['guide','Первые шаги'],['autosave','Сохранение'],['diagnostics','Журнал и диагностика'],['language','Язык и исправления'],['appearance','Цвет и размер шрифта'],['profile','Профиль'],['models','Модели и API'],['network','Веб-сервер и сеть'],['comfy','ComfyUI']].map(([id,label])=><button key={id} className={section===id?'active':''} onClick={()=>id==='models'?navigate('models'):id==='appearance'?navigate('appearance'):setSection(id)}>{t(label)}</button>)}</div>
    <section className="panel settings-panel">{section==='guide'&&<BeginnerGuideSettings/>}{section==='autosave'&&<AutosaveSettings flush={props.flush} notify={props.notify} task={props.task}/>}{section==='diagnostics'&&<Diagnostics/>}{section==='language'&&<><InterfaceLanguage/><LanguageSettings {...props}/></>}{section==='comfy'&&<ComfySettings {...props}/>}{section==='network'&&<NetworkSettings notify={props.notify}/>}
      {section==='profile'&&<><h3>{t("Профиль")}</h3><Field label={t("Имя пользователя")} hint={t("Общее имя профиля. Персоны для игры настраиваются отдельно.")}><input value={state.settings.userName} onChange={e=>update(s=>{s.settings.userName=e.target.value;})}/></Field><Button onClick={()=>navigate('personas')}>{t("Открыть персоны")}</Button></>}
    </section>
  </div>;
}
