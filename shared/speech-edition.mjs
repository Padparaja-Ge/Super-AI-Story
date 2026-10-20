// Developer edition keeps every speech engine. The public packager replaces
// only this module in its isolated build directory, never in the working tree.
export const speechEdition={defaultProvider:'kokoro-ru',disabledProviders:[]};
export const speechProviderEnabled=id=>!speechEdition.disabledProviders.includes(id);
export function normalizeSpeechEdition(settings){
 if(!speechEdition.disabledProviders.length)return settings;
 const s={...settings};
 if(!speechProviderEnabled(s.provider)||s.provider==='custom'&&!speechProviderEnabled(s.customAdapter)){
  s.provider=speechEdition.defaultProvider;
  if(!['auto','ru','en'].includes(s.language))s.language=s.language==='en-gb'?'en':'auto';
 }
 if(!speechProviderEnabled(s.customAdapter))s.customAdapter='endpoint';
 const normalize=voice=>voice&&!speechProviderEnabled(voice.provider)?voice.provider==='kokoro'?{provider:'silero',language:'en',modelId:s.silero.modelEn,voice:s.silero.englishVoice}:{provider:'silero',language:'ru',modelId:s.silero.modelRu,voice:s.silero.voice}:voice;
 s.gmVoice=normalize(s.gmVoice);s.fanficVoice=normalize(s.fanficVoice);
 s.characterVoices=Object.fromEntries(Object.entries(s.characterVoices||{}).map(([id,voice])=>[id,normalize(voice)]));
 return s;
}
