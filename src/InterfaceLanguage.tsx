import {useState} from 'react';
import {interfaceLanguages,setInterfaceLanguage,useInterfaceLanguage,t} from './i18n';
import {Field} from './UI';
export function InterfaceLanguage({compact=false}:{compact?:boolean}){
 const language=useInterfaceLanguage(),[error,setError]=useState(''),[saving,setSaving]=useState(false);
 return <section className={`interface-language ${compact?'compact':''}`}>{!compact&&<h3>{t('Язык интерфейса')}</h3>}<Field label={compact?'Язык / Language / 言語 / 语言 / 언어':t('Язык интерфейса')} hint={compact?undefined:t('Язык меню и подсказок. Истории, карточки, промпты и настройки перевода диалогов не изменяются.')}><select name="interfaceLanguage" value={language} disabled={saving} onChange={async event=>{setSaving(true);setError('');try{await setInterfaceLanguage(event.target.value as typeof language);}catch{setError(t('Не удалось сохранить язык. Проверьте соединение и выберите язык повторно.'));}finally{setSaving(false);}}}>{interfaceLanguages.map(item=><option value={item.id} key={item.id} lang={item.id}>{item.label}</option>)}</select></Field>{error&&<p role="alert" className="error-text">{error}</p>}{!compact&&<hr/>}</section>;
}
