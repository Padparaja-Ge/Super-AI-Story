import {speechEdition,normalizeSpeechEdition} from './speech-edition.mjs';
export const speechDefaults={provider:speechEdition.defaultProvider,device:'cpu',language:'auto',volume:1,pauseMs:120,maxSentenceChars:240,threads:2,idleSeconds:90,customPath:'',customAdapter:'kokoro',endpoint:'http://127.0.0.1:8080',characterVoices:{},gmVoice:null,fanficVoice:null,pronunciations:[],
 kokoro:{voice:'af_heart',speed:1},'kokoro-ru':{voice:'sveta',speed:1},
 silero:{modelRu:'v3_1_ru',modelEn:'v3_en',voice:'kseniya',englishVoice:'en_0',sampleRate:24000,putAccent:true,putYo:true,speed:1},
 xtts:{voice:'female',speed:1,temperature:.65,topK:50,topP:.85,repetitionPenalty:2,lengthPenalty:1,gptCondLen:12,gptCondChunkLen:4,maxRefLen:10,soundNormRefs:false,referenceId:''},
 fish:{voice:'female',temperature:.7,topP:.7,repetitionPenalty:1.2,maxNewTokens:1024,chunkLength:200,seed:0,referenceId:''},
 custom:{voice:'af_heart',speed:1,model:'',temperature:.7,referenceId:''}};
export function speechSettings(value={}){const s={...speechDefaults,...value};if(s.language==='eng')s.language='en';for(const k of ['kokoro','kokoro-ru','silero','xtts','fish','custom'])s[k]={...speechDefaults[k],...value[k]};if(s.characterVoices&&typeof s.characterVoices==='object'&&!Array.isArray(s.characterVoices))s.characterVoices=Object.fromEntries(Object.entries(s.characterVoices).map(([id,v])=>[id,v?{...v}:null]));if(Array.isArray(s.pronunciations))s.pronunciations=s.pronunciations.map(p=>({...p}));return normalizeSpeechEdition(s);}
export function speechFor(value={}, {characterId,gameMaster=false,fanfic=false}={}){
 const s=speechSettings(value),voice=gameMaster?s.gmVoice:fanfic?s.fanficVoice:s.characterVoices?.[characterId];
 if(!voice)return s;
 if(voice.provider==='silero'){
  const en=voice.language==='en'||voice.modelId?.startsWith('v3_en'),options={...s.silero};
  if(voice.voice)options[en?'englishVoice':'voice']=voice.voice;
  if(voice.modelId)options[en?'modelEn':'modelRu']=voice.modelId;
  return speechSettings({...s,provider:'silero',language:voice.language||s.language,silero:options});
 }
 return speechSettings({...s,provider:voice.provider,language:voice.language||s.language,[voice.provider]:{...s[voice.provider],voice:voice.voice||s[voice.provider]?.voice,referenceId:voice.referenceId||''}});
}
export function speechText(text,pronunciations=[]){
 // Longest first, one pass: substitutions cannot recursively expand each other.
 const rows=pronunciations.filter(p=>p?.from?.trim()&&p?.to?.trim()).sort((a,b)=>b.from.length-a.from.length).slice(0,100);
 if(!rows.length)return text;const escaped=rows.map(p=>p.from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 return text.replace(new RegExp(escaped.join('|'),'giu'),match=>rows.find(p=>p.from.toLocaleLowerCase()===match.toLocaleLowerCase())?.to||match);
}
export function speechSentences(text,limit=240,language='ru'){
 limit=Math.max(40,Math.min(400,Number(limit)||240));
 // Remove fence markers, never their prose. Inline blocks and text after a
 // closing fence are common in locally generated fanfic episodes.
 const clean=String(text).replace(/(?:```|~~~)[ \t]*(?:text|plaintext|txt|markdown|md|json|html|xml|javascript|typescript|python|story|fiction|ru|en)[ \t]*\r?\n/gi,'').replace(/```|~~~/g,'').replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[*_`#]/g,'').trim();
 if(!clean)return [];
 const segments=[...new Intl.Segmenter(language==='auto'?'ru':language,{granularity:'sentence'}).segment(clean)].map(s=>s.segment.trim()).filter(Boolean),out=[];
 for(const sentence of segments){let rest=sentence;while(rest.length>limit){let end=rest.lastIndexOf(' ',limit);if(end<limit/3)end=limit;out.push(rest.slice(0,end).trim());rest=rest.slice(end).trim();}if(rest)out.push(rest);}
 return out;
}
