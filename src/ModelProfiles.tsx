import {useState} from 'react';
import {modelProfiles,applyModelProfile} from '../shared/model-profiles.mjs';
import {Button,Field} from './UI';
export function ModelProfiles({settings,model,disabled,onApply}:any){
 const recommended=modelProfiles.find(p=>p.match.test(model||'')),[selected,setSelected]=useState('');const profile=modelProfiles.find(p=>p.id===(selected||recommended?.id||'careful'));
 return <details className="panel model-profiles"><summary>Готовые настройки моделей</summary><Field label="Профиль"><select disabled={disabled} value={profile.id} onChange={e=>setSelected(e.target.value)}>{modelProfiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field><p className="muted small">{profile.note} Все параметры после применения можно изменять вручную. Профиль не скачивает и не выбирает веса, не меняет персоны и память.</p><Button disabled={disabled} onClick={()=>onApply(applyModelProfile(settings,profile.id))}>Применить профиль</Button></details>;
}
