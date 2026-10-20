import {resolveFanficStageProfile, type FanficProfileStage} from '../shared/fanfic-profiles.mjs';
export type FanficPanel = 'series' | 'text' | 'canon';
export const fanficPanels: {id: FanficPanel; label: string}[] = [{id:'series',label:'Серии'},{id:'text',label:'Текст'},{id:'canon',label:'Канон'}];
export const factLabels: Record<string,string> = {event:'Событие',relationship:'Отношения',promise:'Обещание',item:'Предмет',injury:'Травма',secret:'Тайна',location:'Место',knowledge:'Знание'};
export const stageLabels: Record<string,string> = {writing:'Художественный текст',planning:'Планирование',memory:'Память',review:'Проверка связности',rewrite:'Редактура'};
export function proposalState(episode: any, content: string, dirty = false) {
 const proposal = episode?.editProposal;
 if(!proposal) return {proposal:null,canApply:false,reason:''};
 if(dirty) return {proposal,canApply:false,reason:'Сначала сохраните или сбросьте ручные правки. Предложение относится к сохранённому тексту.'};
 if(proposal.sourceRevision!==episode.revision) return {proposal,canApply:false,reason:'Текст изменился после подготовки правки. Запросите новое предложение.'};
 const {selectionStart:start,selectionEnd:end,original,replacement}=proposal;
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>content.length||typeof original!=='string'||typeof replacement!=='string'||!replacement.trim()||content.slice(start,end)!==original) return {proposal,canApply:false,reason:'Предложение не соответствует выбранному фрагменту текущего текста.'};
 return {proposal,canApply:true,reason:''};
}
export function episodeFactRecords(episodes: any[], current: any) {
 if(!current) return [];
 return [...episodes].filter(episode=>episode.season<current.season||episode.season===current.season&&episode.number<=current.number).sort((a,b)=>a.season-b.season||a.number-b.number).flatMap(episode=>(episode.memory?.chunks?.length?episode.memory.chunks:episode.memory?[episode.memory]:[]).flatMap((part:any,chunkIndex:number)=>(part.facts||[]).filter((fact:any)=>fact.projectId===current.projectId&&fact.episodeId===episode.id).map((fact:any)=>({fact,episode,chunkIndex,eligible:episode.id!==current.id&&episode.status==='approved'&&!episode.needsReview}))));
}
export function reviewIsCurrent(episode:any, dirty=false) {
 return !dirty&&!!episode?.continuityReview&&episode.continuityReview.sourceRevision===episode.revision;
}
export function editableFact(fact:any) {
 return {...fact,type:fact.type||'event',subject:String(fact.subject||''),predicate:String(fact.predicate||''),value:String(fact.value||''),aliases:Array.isArray(fact.aliases)?[...fact.aliases]:[]};
}
export function factSavePayload(facts:any[]) {
 return facts.map(fact=>({...fact,aliases:typeof fact.aliases==='string'?fact.aliases.split('\n').map((line:string)=>line.trim()).filter(Boolean):fact.aliases}));
}
export function stageDisplay(settings:any,stage:string,contextWindow=8192) {
 return resolveFanficStageProfile(settings,stage as FanficProfileStage,{contextWindow});
}
export const calibrationCheckLabels: Record<string,string> = {nonEmpty:'Есть ответ',prose:'Художественный текст',notJson:'Ответ написан прозой',minimumLength:'Достаточная длина',requestedFacts:'Сохранены заданные факты',noForbiddenFacts:'Нет посторонних фактов',validJson:'Корректный формат',validShape:'Правильная структура',factsPreserved:'Сохранены факты',validOutline:'План соответствует заданию',foundContradiction:'Противоречие замечено',onlySelection:'Изменён только фрагмент',outsideUnchanged:'Остальной текст сохранён',exactValue:'Точное значение',passed:'Проверка пройдена',format:'Корректный формат',password:'Точный пароль',hero:'Имя персонажа',keyMaterial:'Материал ключа',closedDoor:'Закрытая дверь',noWrongPassword:'Нет подмены пароля',complete:'Завершённый ответ',twoScenes:'Две сцены в плане',keyHolder:'Владелец ключа',doorState:'Состояние двери',knowledge:'Знания персонажа',knownCodes:'Допустимые типы противоречий'};
export function profileUpdatePayload(project:any, generationProfiles:any) {
 return {settings:{...project.settings,generationProfiles}};
}
export function rebaseMetadataDraft(draft:any,projectId:string,before:any,after:any) {
 if(!draft||draft.projectId!==projectId||draft.id!==before?.id||after?.id!==before?.id||draft.revision!==before.revision)return draft;
 if(['content','title','brief','season','number'].some(key=>before[key]!==after[key]))return draft;
 return {...draft,revision:after.revision};
}
export function resumableEpisode(episode:any) {
 if(!episode?.generation||['running','generating'].includes(episode.status))return false;
 return ['stopped','error'].includes(episode.status)||episode.generation.preview===true||episode.generation.action==='review';
}
