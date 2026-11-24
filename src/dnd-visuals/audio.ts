// DiceAudio + CinematicAudio: every sound is synthesized with Web Audio, so
// there are no third-party samples to license and nothing to preload.
let ctx:AudioContext|null=null,reverb:AudioBuffer|null=null;

function context(){
 if(!ctx){const C=window.AudioContext||(window as any).webkitAudioContext;if(!C)return null;ctx=new C();}
 if(ctx.state==='suspended')void ctx.resume().catch(()=>{});
 return ctx;
}
function noiseBuffer(ac:AudioContext,seconds:number){const b=ac.createBuffer(1,Math.max(1,Math.floor(ac.sampleRate*seconds)),ac.sampleRate),d=b.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;return b;}
function reverbNode(ac:AudioContext){
 if(!reverb||reverb.sampleRate!==ac.sampleRate){
  const len=Math.floor(ac.sampleRate*3.2),buffer=ac.createBuffer(2,len,ac.sampleRate);
  for(let ch=0;ch<2;ch++){
   const data=buffer.getChannelData(ch);
   for(let i=0;i<len;i++)data[i]=(Math.random()*2-1)*Math.pow(1-i/len,3.2);
  }
  reverb=buffer;
 }
 // Share the impulse data, not the connected audio node. Concurrent dice and
 // cinematic buses must keep their volume and output routing independent.
 const node=ac.createConvolver();node.buffer=reverb;return node;
}

export class SoundBus{
 readonly ac:AudioContext;readonly out:GainNode;readonly wet:GainNode;private reverb:ConvolverNode;private nodes=new Set<AudioScheduledSourceNode>();private closed=false;
 constructor(ac:AudioContext,volume:number,wetLevel=.25){
  this.ac=ac;this.out=ac.createGain();this.out.gain.value=volume;this.out.connect(ac.destination);
  this.wet=ac.createGain();this.wet.gain.value=wetLevel;this.reverb=reverbNode(ac);this.wet.connect(this.reverb);this.reverb.connect(this.out);
 }
 static create(volume:number,wet?:number){const ac=volume>0?context():null;return ac?new SoundBus(ac,volume,wet):null;}
 track<T extends AudioScheduledSourceNode>(node:T){this.nodes.add(node);node.onended=()=>this.nodes.delete(node);return node;}
 /** destination that also feeds the reverb */
 send(node:AudioNode,dry=1){const g=this.ac.createGain();g.gain.value=dry;node.connect(g);g.connect(this.out);node.connect(this.wet);return g;}
 stop(fade=.25){
  if(this.closed)return;this.closed=true;const t=this.ac.currentTime;
  this.out.gain.cancelScheduledValues(t);this.out.gain.setValueAtTime(this.out.gain.value,t);this.out.gain.linearRampToValueAtTime(0,t+fade);
  setTimeout(()=>{for(const n of this.nodes){try{n.stop();}catch{}}this.nodes.clear();try{this.out.disconnect();this.wet.disconnect();this.reverb.disconnect();}catch{}},fade*1000+60);
 }
 // ---- primitives -------------------------------------------------------
 noise(at:number,dur:number,{type='bandpass',freq=2000,q=1,gain=.5,attack=.002,freqEnd=0,reverb=.2}:{type?:BiquadFilterType;freq?:number;q?:number;gain?:number;attack?:number;freqEnd?:number;reverb?:number}={}){
  const ac=this.ac,src=this.track(ac.createBufferSource()),f=ac.createBiquadFilter(),g=ac.createGain();
  src.buffer=noiseBuffer(ac,dur+.05);f.type=type;f.frequency.setValueAtTime(freq,at);f.Q.value=q;if(freqEnd)f.frequency.exponentialRampToValueAtTime(freqEnd,at+dur);
  g.gain.setValueAtTime(0,at);g.gain.linearRampToValueAtTime(gain,at+attack);g.gain.exponentialRampToValueAtTime(.0001,at+dur);
  src.connect(f);f.connect(g);g.connect(this.out);if(reverb){const w=ac.createGain();w.gain.value=reverb;g.connect(w);w.connect(this.wet);}
  src.start(at);src.stop(at+dur+.05);
 }
 tone(at:number,dur:number,{freq=440,freqEnd=0,type='sine',gain=.2,attack=.01,release=0,reverb=.3,detune=0}:{freq?:number;freqEnd?:number;type?:OscillatorType;gain?:number;attack?:number;release?:number;reverb?:number;detune?:number}={}){
  const ac=this.ac,o=this.track(ac.createOscillator()),g=ac.createGain();
  o.type=type;o.frequency.setValueAtTime(freq,at);o.detune.value=detune;if(freqEnd)o.frequency.exponentialRampToValueAtTime(freqEnd,at+dur);
  g.gain.setValueAtTime(0,at);g.gain.linearRampToValueAtTime(gain,at+attack);
  if(release){g.gain.setValueAtTime(gain,at+Math.max(attack,dur-release));g.gain.linearRampToValueAtTime(0,at+dur);}else g.gain.exponentialRampToValueAtTime(.0001,at+dur);
  o.connect(g);g.connect(this.out);if(reverb){const w=ac.createGain();w.gain.value=reverb;g.connect(w);w.connect(this.wet);}
  o.start(at);o.stop(at+dur+.05);
 }
 pad(at:number,dur:number,freqs:number[],{gain=.06,attack=1.2,release=1.4,type='sawtooth',cutoff=1400,reverb=.8}:{gain?:number;attack?:number;release?:number;type?:OscillatorType;cutoff?:number;reverb?:number}={}){
  const ac=this.ac,f=ac.createBiquadFilter(),g=ac.createGain();f.type='lowpass';f.frequency.value=cutoff;f.Q.value=.6;
  g.gain.setValueAtTime(0,at);g.gain.linearRampToValueAtTime(gain,at+attack);g.gain.setValueAtTime(gain,at+dur-release);g.gain.linearRampToValueAtTime(0,at+dur);
  for(const fr of freqs)for(const det of [-7,0,7]){const o=this.track(ac.createOscillator());o.type=type;o.frequency.value=fr;o.detune.value=det+(Math.random()*4-2);o.connect(f);o.start(at);o.stop(at+dur+.05);}
  f.connect(g);g.connect(this.out);const w=ac.createGain();w.gain.value=reverb;g.connect(w);w.connect(this.wet);
 }
}

// ---- dice ------------------------------------------------------------------
export function diceClack(bus:SoundBus|null,strength:number,withDie:boolean,delay=0){
 if(!bus)return;const t=bus.ac.currentTime+delay,s=.25+.75*strength;
 if(withDie){bus.noise(t,.035,{freq:3800+Math.random()*1600,q:2.2,gain:.32*s,reverb:.08});bus.tone(t,.06,{freq:2300+Math.random()*900,gain:.07*s,reverb:.05});}
 else{bus.noise(t,.05,{freq:1700+Math.random()*900,q:1.3,gain:.38*s,reverb:.1});bus.tone(t,.09,{freq:210+Math.random()*60,freqEnd:120,gain:.22*s,reverb:.05});bus.tone(t,.05,{freq:1500+Math.random()*700,gain:.05*s,reverb:.05});}
}
export function resultChime(bus:SoundBus|null,good:boolean|null){
 if(!bus)return;const t=bus.ac.currentTime+.02;
 const notes=good===false?[220,207.65]:good?[659.25,987.77]:[523.25,783.99];
 notes.forEach((f,i)=>bus.tone(t+i*.07,1.1,{freq:f,gain:.05,attack:.005,reverb:.6}));
}

// ---- cinematics -------------------------------------------------------------
/** DIVINE BLESSING score; t0 = start of the scene (seconds on bus clock). */
export function scoreDivineBlessing(bus:SoundBus,t0:number){
 const D=146.83,A=220,D4=293.66,Fs=369.99,A4=440,D5=587.33;
 bus.tone(t0,3.2,{freq:73.42,gain:.16,attack:.6,release:1.4,reverb:.5});                       // noble low swell
 bus.pad(t0+.1,5.6,[D,A,D4,Fs],{gain:.035,attack:1.6,release:1.8,cutoff:1100});
 [D5,A4*2,Fs*2,D5*2,A4*3].forEach((f,i)=>bus.tone(t0+.25+i*.16,2.4,{freq:f,gain:.035,attack:.004,reverb:.9}));  // shimmer
 bus.noise(t0+1.2,1.6,{type:'bandpass',freq:300,freqEnd:4200,q:.8,gain:.14,attack:.8,reverb:.7}); // portal opening
 bus.pad(t0+1.5,4.2,[D4,Fs,A4,D5],{gain:.03,attack:.9,release:1.6,type:'triangle',cutoff:3200});  // choir
 for(let i=0;i<14;i++)bus.tone(t0+2.4+i*.11+Math.random()*.05,1.8,{freq:[D5,Fs*2,A4*2,D5*2][i%4]*(1+(Math.random()-.5)*.004),gain:.025,attack:.003,reverb:1});
 [D,A,D4,Fs,A4].forEach(f=>bus.tone(t0+3.25,2.6,{freq:f,type:'triangle',gain:.06,attack:.02,release:1.6,reverb:.9})); // climax chord
 bus.tone(t0+3.25,3,{freq:D5*2,gain:.05,attack:.002,reverb:1});
}
/** DEATH'S JUDGMENT score; strikeAt = seconds after t0 when the scythe hits. */
export function scoreDeathsJudgment(bus:SoundBus,t0:number,strikeAt:number){
 bus.tone(t0,5.5,{freq:41.2,type:'sawtooth',gain:.09,attack:.8,release:1.2,reverb:.3});
 bus.tone(t0,5.5,{freq:55,gain:.18,attack:.6,release:1.5,reverb:.2});
 bus.pad(t0+.2,5,[61.74,65.41,92.5,98],{gain:.03,attack:1.2,release:1.5,cutoff:500,reverb:.6});      // dissonant cluster
 bus.noise(t0,4.8,{type:'lowpass',freq:600,q:.3,gain:.08,attack:1.4,reverb:.5});                     // black mist
 const s=t0+strikeAt;
 bus.noise(s-.42,.42,{type:'bandpass',freq:500,freqEnd:5200,q:1.4,gain:.22,attack:.32,reverb:.3});   // swing whoosh
 bus.tone(s,1.6,{freq:120,freqEnd:32,gain:.5,attack:.002,reverb:.4});                                  // impact boom
 for(const f of [2793,3517,4186,5274,6271])bus.tone(s,1.1,{freq:f*(1+(Math.random()-.5)*.02),gain:.035,attack:.001,reverb:.5}); // metallic slash ring
 bus.noise(s,.09,{type:'highpass',freq:3000,gain:.5,attack:.001,reverb:.3});
 for(let i=0;i<34;i++){const at=s+.03+Math.pow(Math.random(),1.8)*.75;bus.noise(at,.03+Math.random()*.06,{freq:2500+Math.random()*7000,q:6,gain:.12+Math.random()*.12,reverb:.25});if(i%3===0)bus.tone(at,.25,{freq:3000+Math.random()*5000,gain:.025,attack:.001,reverb:.4});}
 bus.pad(s+.5,2.6,[73.42,77.78,110],{gain:.03,attack:.3,release:1.8,cutoff:420,reverb:.8});
}
