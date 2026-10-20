import {cleanAssistantOutput} from './services/structuredCompletion.js';

// Delimiters are scoped to literary scene requests; ordinary RP stays intact.
export const fanficStops=['[SAS_SCENE_END]','\nСцена завершена.','\n\n---\n\nThis text','\n\nThis text is a continuation'];
export function cleanFanficProse(value){
  let text=cleanAssistantOutput(value);
  for(const marker of ['[SAS_SCENE_END]',...fanficStops.slice(1)]){
    const index=text.indexOf(marker);if(index>=0)text=text.slice(0,index);
  }
  // Some OpenAI adapters ignore stop sequences; remove only explicit standalone
  // editorial postscripts, never a character's dialogue or an ordinary divider.
  text=text.replace(/\n(?:\s*---\s*\n)?\s*(?:This (?:text|narrative) is (?:a continuation|written|intended)|The narrative is intentionally|Сцена завершена\.|Комментарий (?:автора|редактора):)[\s\S]*$/i,'');
  return text.trim();
}
