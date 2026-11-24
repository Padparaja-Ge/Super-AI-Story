import {useState} from 'react';
import {BookOpen, Compass, Flag, Plus, Waypoints} from 'lucide-react';
import {campaignDeathPolicies, gmProfiles, normalizeGmSettings, type GmSettings} from '../shared/gm-profile.mjs';
import {Button, Field, Modal} from './UI';
import {t} from './i18n';
import type {Persona} from './types';
import './gm-campaign.css';

export function GmProfileSettings({value, disabled, deathLocked, onChange}: {
  value?: GmSettings;
  disabled?: boolean;
  deathLocked?: boolean;
  onChange: (value: GmSettings) => void;
}) {
  const settings = normalizeGmSettings(value);
  const profile = gmProfiles[settings.profile];
  return <section className="gm-profile-settings">
    <Field label={t('Поведение ведущего')} hint={t(profile.description)}>
      <select value={settings.profile} disabled={disabled}
        onChange={event => onChange({...settings, profile: event.target.value as GmSettings['profile']})}>
        {Object.entries(gmProfiles).map(([id, profile]) => <option key={id} value={id}>{t(profile.name)}</option>)}
      </select>
    </Field>
    <Field label={t('Гибель героя')} hint={t('Ноль HP выводит героя из боя. Гибель подтверждает хост.')}>
      <select value={settings.deathPolicy} disabled={disabled || deathLocked}
        onChange={event => onChange({...settings, deathPolicy: event.target.value as GmSettings['deathPolicy']})}>
        {Object.entries(campaignDeathPolicies).map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}
      </select>
    </Field>
  </section>;
}

type QuestStatus = 'offered' | 'active' | 'declined' | 'completed';
type Quest = {id: string; title: string; hook: string; goal: string; progress: string[]; status: QuestStatus};
type Plan = {id: string; objective: string; twists: string[]; alternatives: string[]; npcTies: string[]};
type Actor = {id: string; personaId?: string; name: string; hp: number; player: boolean; campaignDead?: boolean};
type Campaign = {phase: 'story' | 'downtime' | 'ended'; quests: Quest[]; deaths: {name: string; round: number}[]};
type CampaignAction = {action: string; questId?: string; actorId?: string; personaId?: string; note?: string};

const questNames: Record<QuestStatus, string> = {
  offered: 'Зацепка',
  active: 'В работе',
  declined: 'Отклонено',
  completed: 'Завершено'
};

export function CampaignJournal({campaign, plans, personas, deadPersonaIds, actors, inCombat, gmSettings, host, disabled, pending, submit}: {
  campaign: Campaign;
  plans: Plan[];
  personas: Persona[];
  deadPersonaIds: string[];
  actors: Actor[];
  inCombat: boolean;
  gmSettings: GmSettings;
  host: boolean;
  disabled: boolean;
  pending: boolean;
  submit: (action: CampaignAction) => Promise<boolean>;
}) {
  const [confirmation, setConfirmation] = useState<Actor | null>(null);
  const [replacement, setReplacement] = useState<Actor | null>(null);
  const [replacementId, setReplacementId] = useState('');
  const [progress, setProgress] = useState<{questId:string; note:string} | null>(null);
  const ended = campaign.phase === 'ended';
  const downtime = campaign.phase === 'downtime';
  const blocked = disabled || ended;
  const unresolved = campaign.quests.filter(quest => ['offered', 'active'].includes(quest.status));
  const archived = campaign.quests.filter(quest => ['completed', 'declined'].includes(quest.status));
  const canOffer = !unresolved.some(quest => quest.status === 'offered') && unresolved.length < 3;
  const defeated = actors.filter(actor => actor.player && actor.hp === 0);
  const available = personas.filter(persona => persona.kind === 'srp' && !deadPersonaIds.includes(persona.id) && !actors.some(actor => actor.personaId === persona.id));
  return <>
    <details className="panel gm-campaign">
      <summary><BookOpen size={17} aria-hidden="true"/><strong>{t('Журнал кампании')}</strong>
        {ended ? <span className="gm-campaign-state">{t('Кампания завершена')}</span>
          : downtime ? <span className="gm-campaign-state">{t('Передышка')}</span>
          : unresolved.length ? <span className="gm-campaign-state">{t('Открыто: {0}', [unresolved.length])}</span> : null}
      </summary>
      <div className="gm-campaign-body">
        {ended && <p role="status">{t('Кампания завершена после гибели героя.')}</p>}
        {host && !ended && <div className="gm-campaign-actions">
          <Button primary disabled={blocked || inCombat || downtime || !canOffer} onClick={() => void submit({action: 'offer'})}><Plus size={15}/>{t('Подготовить зацепку')}</Button>
          <Button disabled={blocked || (!downtime && inCombat)} onClick={() => void submit({action: downtime ? 'resume' : 'downtime'})}>
            <Compass size={15}/>{downtime ? t('Продолжить сюжет') : t('Дать группе передышку')}
          </Button>
        </div>}
        {pending && <p role="status" className="muted small">{t('Мастер готовит задание…')}</p>}
        {unresolved.length === 0 && archived.length === 0 && <p className="muted small">{t('Зацепок пока нет. Между заданиями группа может свободно играть сцену.')}</p>}
        {unresolved.map(quest => {
          const plan = host ? plans.find(item => item.id === quest.id) : undefined;
          return <article className="gm-quest" key={quest.id}>
            <header><strong>{quest.title}</strong><span className="gm-quest-status">{t(questNames[quest.status])}</span></header>
            <p>{quest.status === 'offered' ? quest.hook : quest.goal}</p>
            {quest.status === 'offered' && <p className="muted small">{quest.goal}</p>}
            {host && quest.status === 'offered' && <div className="gm-campaign-actions">
              <Button primary disabled={blocked || downtime} onClick={() => void submit({action:'accept', questId:quest.id})}>{t('Группа приняла · спланировать')}</Button>
              <Button disabled={blocked} onClick={() => void submit({action:'decline', questId:quest.id})}>{t('Группа отказалась')}</Button>
            </div>}
            {!!quest.progress?.length && <ul>{quest.progress.map((note,index)=><li key={index}>{note}</li>)}</ul>}
            {plan && <details className="gm-private-plan">
              <summary><Waypoints size={15} aria-hidden="true"/>{t('План только для хоста')}</summary>
              <p>{plan.objective}</p>
              {[[t('Возможные повороты'), plan.twists], [t('Альтернативные пути'), plan.alternatives], [t('Связи с NPC'), plan.npcTies]].map(([label, entries]) => (
                Array.isArray(entries) && entries.length > 0 && <div key={String(label)}><strong>{label}</strong><ul>{entries.map((line, index) => <li key={index}>{line}</li>)}</ul></div>
              ))}
            </details>}
            {host && quest.status === 'active' && <div className="gm-campaign-actions">
              <Button disabled={blocked} onClick={() => setProgress({questId:quest.id,note:''})}>{t('Записать продвижение')}</Button>
              <Button disabled={blocked} onClick={() => void submit({action:'complete', questId:quest.id})}><Flag size={15}/>{t('Завершить задание')}</Button>
            </div>}
          </article>;
        })}
        {archived.length > 0 && <details className="gm-quest-archive"><summary>{t('Архив заданий · {0}', [archived.length])}</summary>
          <ul>{archived.map(quest => <li key={quest.id}>{quest.title} · {t(questNames[quest.status])}</li>)}</ul>
        </details>}
        {campaign.deaths.length > 0 && <div><strong>{t('Погибшие герои')}</strong>
          <ul>{campaign.deaths.map((entry, index) => <li key={index}>{entry.name} · {t('Раунд')} {entry.round}</li>)}</ul>
        </div>}
        {host && !ended && gmSettings.deathPolicy !== 'classic' && defeated.map(actor => <div className="gm-campaign-actions" key={actor.id}>
          <strong>{actor.name}</strong>
          {actor.campaignDead ? <Button disabled={blocked || inCombat || !available.length} onClick={() => {setReplacement(actor);setReplacementId('');}}>{t('Заменить героя')}</Button>
            : <Button danger disabled={blocked} onClick={() => setConfirmation(actor)}>{t('Подтвердить гибель')}</Button>}
        </div>)}
      </div>
    </details>
    {progress && <Modal title={t('Записать продвижение')} onClose={() => setProgress(null)}>
      <Field label={t('Что уже произошло?')}>
        <textarea rows={3} maxLength={360} value={progress.note} onChange={event=>setProgress({...progress,note:event.target.value})}/>
      </Field>
      <Button primary disabled={blocked||!progress.note.trim()} onClick={()=>void submit({action:'progress',questId:progress.questId,note:progress.note}).then(ok=>{if(ok)setProgress(null);})}>{t('Сохранить')}</Button>
    </Modal>}
    {confirmation && <Modal title={t('Подтвердить гибель')} onClose={() => setConfirmation(null)}>
      <p>{t('Подтвердить гибель героя «{0}»?', [confirmation.name])}</p>
      <p className="muted small">{gmSettings.deathPolicy === 'end' ? t('Подтверждение завершит всю кампанию.') : t('После боя можно ввести нового героя из списка персон.')}</p>
      <Button danger disabled={blocked} onClick={() => void submit({action:'death', actorId:confirmation.id}).then(ok => {if (ok) setConfirmation(null);})}>{t('Подтвердить гибель')}</Button>
    </Modal>}
    {replacement && <Modal title={t('Заменить героя')} onClose={() => setReplacement(null)}>
      <Field label={t('Новый герой')}>
        <select value={replacementId} onChange={event => setReplacementId(event.target.value)}>
          <option value="">{t('Выберите персону')}</option>
          {available.map(persona => <option key={persona.id} value={persona.id}>{persona.name}</option>)}
        </select>
      </Field>
      <Button primary disabled={blocked || !replacementId || inCombat} onClick={() => void submit({action:'replace', actorId:replacement.id, personaId:replacementId}).then(ok => {if (ok) setReplacement(null);})}>{t('Ввести героя в кампанию')}</Button>
    </Modal>}
  </>;
}
