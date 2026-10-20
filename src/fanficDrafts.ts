export type EpisodeDraft = {projectId:string;id:string;revision:number;title:string;brief:string;content:string;season:number;number:number;dirty:boolean};
type StorageReader = Pick<Storage,'getItem'>;
type StorageWriter = Pick<Storage,'setItem'|'removeItem'>;
const volatileDrafts=new Map<string,EpisodeDraft>();

export const fanficStorageKey=(kind:string,projectId:string,episodeId='')=>'sas-fanfic-'+kind+':'+JSON.stringify([projectId,episodeId]);
export const asEpisodeDraft=(projectId:string,episode:any):EpisodeDraft=>({projectId,id:episode.id,revision:episode.revision,title:episode.title||'',brief:episode.brief||'',content:episode.content||'',season:episode.season||1,number:episode.number||1,dirty:false});
export const sameDraftScope=(draft:EpisodeDraft|null,projectId:string,episodeId:string)=>!!draft&&draft.projectId===projectId&&draft.id===episodeId;
export const draftHasChanges=(draft:EpisodeDraft,episode:any)=>['title','brief','content','season','number'].some(key=>draft[key as keyof EpisodeDraft]!==episode[key]);

export function restoreEpisodeDraft(storage:StorageReader,projectId:string,episode:any):EpisodeDraft {
  const fresh=asEpisodeDraft(projectId,episode);
  const key=fanficStorageKey('draft',projectId,episode.id),volatile=volatileDrafts.get(key);
  if(volatile)return {...volatile};
  try {
    const raw=storage.getItem(key);
    // Migrate older drafts only for this exact episode; all new keys carry the work identity.
    const candidate=JSON.parse(raw||storage.getItem('sas-fanfic-draft-'+episode.id)||'null');
    if(!candidate||candidate.id!==episode.id||candidate.projectId!==undefined&&candidate.projectId!==projectId||candidate.dirty!==true)return fresh;
    if(!Number.isInteger(candidate.revision)||candidate.revision<1||!Number.isInteger(candidate.season)||candidate.season<1||candidate.season>999||!Number.isInteger(candidate.number)||candidate.number<1||candidate.number>9999)return fresh;
    if(typeof candidate.title!=='string'||candidate.title.length>200||typeof candidate.brief!=='string'||candidate.brief.length>16000||typeof candidate.content!=='string'||candidate.content.length>2000000)return fresh;
    return {...fresh,...candidate,projectId,dirty:true};
  } catch {return fresh;}
}

export function persistEpisodeDraft(storage:StorageWriter,draft:EpisodeDraft):boolean {
  const key=fanficStorageKey('draft',draft.projectId,draft.id);
  if(draft.dirty)volatileDrafts.set(key,{...draft});else volatileDrafts.delete(key);
  try {
    if(draft.dirty)storage.setItem(key,JSON.stringify(draft));else storage.removeItem(key);
    storage.removeItem('sas-fanfic-draft-'+draft.id);
    return true;
  } catch {return false;}
}

export function draftSavePayload(draft:EpisodeDraft) {
  if(!Number.isInteger(draft.season)||draft.season<1||draft.season>999||!Number.isInteger(draft.number)||draft.number<1||draft.number>9999)throw new Error('Укажите целые номера сезона (1–999) и эпизода (1–9999).');
  return {title:draft.title,brief:draft.brief,content:draft.content,season:draft.season,number:draft.number,expectedRevision:draft.revision};
}
