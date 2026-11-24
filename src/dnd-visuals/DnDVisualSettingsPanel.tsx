// DnDVisualSettings UI: lives in the room settings column of D&D/НРИ rooms.
import {useEffect,useState} from 'react';
import {t} from '../i18n';
import {Field} from '../UI';
import {useVisualSettings,setVisualSettings,type DiceQuality} from './settings';
import {lastCinematic,onLastCinematicChange,replayLastCinematic} from './replay';

export function DnDVisualSettingsPanel(){
 const s=useVisualSettings(),[last,setLast]=useState(lastCinematic());
 useEffect(()=>onLastCinematicChange(()=>setLast(lastCinematic())),[]);
 return <details className="panel room-settings-card dnd-visual-settings"><summary>{t("Кубики и кинематографика")}</summary>
  <label className="checkbox-row"><input type="checkbox" checked={s.dice3d} onChange={e=>setVisualSettings({dice3d:e.target.checked})}/>{t("3D-кубики при бросках")}</label>
  <label className="checkbox-row"><input type="checkbox" checked={s.cinematics} onChange={e=>setVisualSettings({cinematics:e.target.checked})}/>{t("Кинематографические сцены критических результатов")}</label>
  <label className="checkbox-row"><input type="checkbox" checked={s.autoSkipCinematics} disabled={!s.cinematics} onChange={e=>setVisualSettings({autoSkipCinematics:e.target.checked})}/>{t("Всегда пропускать сцены (показывать только итог)")}</label>
  <Field label={t("Громкость эффектов · {0}%",[Math.round(s.volume*100)])}><input type="range" min={0} max={1} step={.05} value={s.volume} onChange={e=>setVisualSettings({volume:Number(e.target.value)})}/></Field>
  <Field label={t("Качество графики")}><select value={s.quality} onChange={e=>setVisualSettings({quality:e.target.value as DiceQuality})}><option value="low">{t("Низкое · без теней и преломления")}</option><option value="medium">{t("Среднее")}</option><option value="high">{t("Высокое")}</option><option value="ultra">{t("Ультра")}</option></select></Field>
  <Field label={t("Уменьшение движения")}><select value={s.reduceMotion} onChange={e=>setVisualSettings({reduceMotion:e.target.value as any})}><option value="system">{t("Как в системе")}</option><option value="on">{t("Включено · без полёта кубиков и сцен")}</option><option value="off">{t("Выключено")}</option></select></Field>
  <Field label={t("Итог броска на экране · {0} с",[s.resultHold.toFixed(1)])}><input type="range" min={.8} max={6} step={.2} value={s.resultHold} onChange={e=>setVisualSettings({resultHold:Number(e.target.value)})}/></Field>
  <button type="button" className="btn" disabled={!last} onClick={replayLastCinematic}>{t("Повторить последнюю сцену")}</button>
  <p className="muted small">{t("Результат броска рассчитывает игровой движок; анимация только показывает его. Повтор сцены не изменяет игру.")}</p>
 </details>;
}
