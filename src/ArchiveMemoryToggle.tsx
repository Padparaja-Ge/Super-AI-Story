import {t} from './i18n';
import {Field} from './UI';

export function ArchiveMemoryToggle({enabled, version, disabled, onChange}: {
 enabled: boolean;
 version?: 1|2;
 disabled?: boolean;
 onChange: (enabled:boolean,version:1|2) => void;
}) {
 return <div className="archive-memory-option">
   <Field label={t('Поиск по полному архиву')} hint={enabled&&version===2
     ?t('До трёх этапов поиска. Модель получает короткие цитаты со статусом источника. При противоречии память отмечает неопределённость.')
     :t('Модель получает краткий контекст. Если в нём не хватает деталей, SAS ищет в архиве этой истории и добавляет до трёх коротких выдержек.')}>
     <select disabled={disabled} value={enabled?(version===2?'2':'1'):'off'} onChange={event=>{
       const value=event.target.value;
       onChange(value!=='off',value==='2'?2:1);
     }}>
       <option value="off">{t('Выключено')}</option>
       <option value="1">{t('Бета 1 · обычный поиск')}</option>
       <option value="2">{t('Бета 2 · проверка источников')}</option>
     </select>
   </Field>
 </div>;
}

