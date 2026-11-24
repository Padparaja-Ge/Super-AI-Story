import {useState} from 'react';
import {BookOpen, CircuitBoard, Compass, ImagePlus, Plus, Sparkles, Swords} from 'lucide-react';
import {fanficStarters,fanficTemplatePortrait} from '../shared/fanfic-starter-catalog.mjs';
import {isFanficStarterLorebook} from '../shared/fanfic-lore-localization.mjs';
import {Button, Field, Modal} from './UI';
import {t} from './i18n';

type LoreLanguage = 'ru'|'en';
function LoreLanguageField({value,disabled,onChange,editing=false}:{value:LoreLanguage;disabled:boolean;onChange:(language:LoreLanguage)=>void;editing?:boolean}) {
  return <Field label={t('Язык лорбука')} hint={editing?t('Язык встроенных записей обновится после сохранения. Ваши правки сохранятся.'):undefined}>
    <select disabled={disabled} value={value} onChange={event=>onChange(event.target.value==='en'?'en':'ru')}>
      <option value="ru">Русский</option>
      <option value="en">English</option>
    </select>
  </Field>;
}

const icons = {jujutsu: Sparkles, edgerunners: CircuitBoard, vinland: Compass, sao: Swords};

export function FanficStarterDialog({personas, disabled, onClose, onCreate}: {
  personas: {id:string;name:string}[];
  disabled: boolean;
  onClose: () => void;
  onCreate: (starterId:string,startId:string,options:{originalPersona?:unknown;canonCharacter?:string;loreLanguage:LoreLanguage}) => void;
}) {
  const [starterId, setStarterId] = useState(fanficStarters[0].id);
  const [startId, setStartId] = useState(fanficStarters[0].starts[0].id);
  const [loreLanguage, setLoreLanguage] = useState<LoreLanguage>('ru');
  const [viewpoint, setViewpoint] = useState('');
  const starter = fanficStarters.find(item => item.id === starterId)!;
  const start = starter.starts.find(item => item.id === startId)!;
  const castOption=(id:string)=><option key={id} value={'canon:'+starter.id+'-'+id}>{starter.cast[id].name}</option>;
  const selectedSupport=viewpoint.startsWith('canon:')?start.support[viewpoint.slice(('canon:'+starter.id+'-').length)]:undefined;
  const create = () => {
    const originalPersona = personas.find(persona => 'original:' + persona.id === viewpoint);
    const canonCharacter = viewpoint.startsWith('canon:') ? viewpoint.slice(6) : undefined;
    onCreate(starter.id, start.id, {originalPersona,canonCharacter,loreLanguage});
  };
  return <Modal title={t('Стартовые проекты фанфика')} className="fanfic-starter-modal" onClose={onClose}>
    <div className="fanfic-starter-dialog">
      <p className="muted">{t('Выберите мир и точку старта. SAS создаст произведение с карточками, лорбуком и заданием для первого эпизода.')}</p>
      <div className="fanfic-starter-grid" role="group" aria-label={t('Мир фанфика')}>
        {fanficStarters.map(item => {
          const Icon = icons[item.id as keyof typeof icons] || BookOpen;
          return <button type="button" key={item.id} className="fanfic-starter-card" data-tone={item.tone} aria-pressed={item.id === starterId}
            disabled={disabled} onClick={() => {setStarterId(item.id);setStartId(item.starts[0].id);setViewpoint('');}}>
            <img className="fanfic-starter-cover" src={'/fanfic-templates/'+item.id+'-cover.webp'} alt="" width={800} height={340}/>
            <span className="fanfic-starter-card-title"><Icon size={17} aria-hidden/><span><strong>{t(item.title)}</strong><small>{t(item.label)}</small></span></span>
          </button>;
        })}
      </div>
      <Field label={t('Точка старта')}><select value={start.id} disabled={disabled} onChange={event => {setStartId(event.target.value);setViewpoint('');}}>
        {starter.starts.map(item => <option key={item.id} value={item.id}>{t(item.label)}</option>)}
      </select></Field>
      <LoreLanguageField value={loreLanguage} disabled={disabled} onChange={setLoreLanguage}/>
      <Field label={t('Чей взгляд ведёт историю')}><select value={viewpoint} aria-label={t('Чей взгляд ведёт историю')} aria-describedby={selectedSupport?'fanfic-starter-support-note':undefined} disabled={disabled} onChange={event => setViewpoint(event.target.value)}>
        <option value="">{t('Ансамбль персонажей')}</option>
        <optgroup label={t('Канонические герои')}>{start.cast.filter(id=>!start.support[id]).map(castOption)}</optgroup>
        <optgroup label={t('Второстепенные персонажи')}>{Object.keys(start.support).map(castOption)}</optgroup>
        {!!personas.length && <optgroup label={t('Мои персоны')}>{personas.map(persona => <option key={persona.id} value={'original:' + persona.id}>{persona.name}</option>)}</optgroup>}
      </select>{selectedSupport&&<span id="fanfic-starter-support-note" className="muted small">{selectedSupport}</span>}</Field>
      <section className="fanfic-starter-scene">
        <h3>{t('Развилка истории')}</h3><p>{start.setup}</p><p>{start.pivot}</p>
        <ul className="fanfic-starter-cast" aria-label={t('Канонические герои')}>
          {start.cast.map(id=><li key={id}><img src={fanficTemplatePortrait(starter.id+'-'+id,start.id)} alt="" width={26} height={26}/>{starter.cast[id].name}</li>)}
        </ul>
      </section>
    </div>
    <div className="fanfic-toolbar fanfic-starter-footer">
      <a href={start.source ?? starter.source} target="_blank" rel="noreferrer">{t('Официальные материалы')}</a>
      <Button primary disabled={disabled} onClick={create}><Plus size={16}/>{t('Создать произведение')}</Button>
    </div>
  </Modal>;
}

const emptyEntry = () => ({id:crypto.randomUUID(),name:'',content:'',keys:[],secondaryKeys:[],priority:0,enabled:true,constant:false,vectorized:false,vectorWhenMemory:false,selective:false,caseSensitive:false});

export function FanficLoreDialog({book, disabled, onClose, onSave}: {
  book?: any;
  disabled:boolean;
  onClose:()=>void;
  onSave:(book:any)=>void;
}) {
  const [draft,setDraft] = useState(() => book ? structuredClone(book) : {name:'',description:'',entries:[emptyEntry()]});
  const [openEntry,setOpenEntry] = useState(draft.entries[0]?.id);
  const patchEntry = (id:string, changes:Record<string,unknown>) => setDraft((current:any) => ({
    ...current,entries:current.entries.map((entry:any) => entry.id === id ? {...entry,...changes} : entry)
  }));
  const splitKeys = (value:string) => value.split(',').map(key => key.trim()).filter(Boolean).slice(0,30);
  return <Modal title={t('Лорбук произведения')} onClose={onClose}>
    <form className="fanfic-lore-form" onSubmit={event => {event.preventDefault();if(!disabled)onSave(draft);}}>
      <p className="muted small">{t('Эти записи действуют только в произведении. Постоянные факты входят в контекст всегда в пределах бюджета. Для остальных укажите имена, места или предметы.')}</p>
      <Field label={t('Название')}><input required maxLength={200} value={draft.name} onChange={event => setDraft({...draft,name:event.target.value})}/></Field>
      {isFanficStarterLorebook(draft.id)&&<LoreLanguageField value={draft.language==='en'?'en':'ru'} disabled={disabled} editing onChange={language=>setDraft({...draft,language})}/>}
      {draft.entries.map((entry:any) => <details key={entry.id} open={entry.id===openEntry} className="fanfic-lore-entry">
        <summary>{entry.name || t('Новая запись')}</summary>
        <Field label={t('Название')}><input required maxLength={200} value={entry.name} onChange={event => patchEntry(entry.id,{name:event.target.value})}/></Field>
        <Field label={t('Факт или правило')}><textarea required rows={4} maxLength={8000} value={entry.content} onChange={event => patchEntry(entry.id,{content:event.target.value})}/></Field>
        <div className="form-grid">
          <Field label={t('Ключи через запятую')}><input key={entry.id+'-keys'} defaultValue={entry.keys?.join(', ')} onChange={event => patchEntry(entry.id,{keys:splitKeys(event.target.value)})}/></Field>
          <Field label={t('Приоритет')}><input type="number" min={-100} max={100} value={entry.priority||0} onChange={event => patchEntry(entry.id,{priority:Number(event.target.value)})}/></Field>
        </div>
        <div className="fanfic-lore-flags">
          {[['enabled', 'Запись активна'], ['constant', 'Постоянный факт']].map(([key,label]) =>
            <label key={key}><input type="checkbox" checked={entry[key]===true} onChange={event => patchEntry(entry.id,{[key]:event.target.checked})}/>{t(label)}</label>)}
        </div>
        <Field label={t('Поиск записи')}>
          <select value={entry.vectorized ? 'always' : entry.vectorWhenMemory ? 'memory' : 'keys'} onChange={event => patchEntry(entry.id, {vectorized:event.target.value==='always',vectorWhenMemory:event.target.value==='memory'})}>
            <option value="keys">{t('По ключам')}</option>
            <option value="memory">{t('С векторной памятью')}</option>
            <option value="always">{t('Векторный поиск всегда')}</option>
          </select>
        </Field>
        <Button danger disabled={disabled} onClick={() => setDraft({...draft,entries:draft.entries.filter((item:any) => item.id!==entry.id)})}>{t('Удалить запись')}</Button>
      </details>)}
      <div className="fanfic-toolbar">
        <Button disabled={disabled || draft.entries.length>=300} onClick={() => {const entry=emptyEntry();setDraft({...draft,entries:[...draft.entries,entry]});setOpenEntry(entry.id);}}><Plus size={16}/>{t('Добавить запись')}</Button>
        <Button primary type="submit" disabled={disabled || !draft.name.trim() || draft.entries.some((entry:any) => !entry.name.trim() || !entry.content.trim())}>{t('Сохранить')}</Button>
      </div>
    </form>
  </Modal>;
}

export function FanficPortraitPicker({disabled,onChange,onError}: {
  disabled:boolean;onChange:(avatar:string)=>void;onError:(error:string)=>void;
}) {
  const read = async (file:File) => {
    if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size>8*1024*1024) throw new Error(t('Выберите PNG, JPEG или WebP до 8 МБ.'));
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1,256/Math.max(bitmap.width,bitmap.height));
      canvas.width = Math.max(1,Math.round(bitmap.width*scale));
      canvas.height = Math.max(1,Math.round(bitmap.height*scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error(t('Не удалось обработать портрет.'));
      context.drawImage(bitmap,0,0,canvas.width,canvas.height);
      let portrait = canvas.toDataURL('image/jpeg',0.82);
      if (portrait.length>64000) portrait = canvas.toDataURL('image/jpeg',0.55);
      if (portrait.length>64000) throw new Error(t('Не удалось обработать портрет.'));
      onChange(portrait);
    } finally {
      bitmap.close();
    }
  };
  return <label className="btn fanfic-portrait-picker">
    <ImagePlus size={16}/>{t('Загрузить портрет')}
    <input aria-label={t('Загрузить портрет')} type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={event => {
      const file = event.target.files?.[0];
      event.target.value='';
      if (file) void read(file).catch(error => onError(error.message));
    }}/>
  </label>;
}
