import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {sileroExecutable,sileroRuntimeCompatible,SILERO_RUNTIME_VERSION,SILERO_PYTHON_VERSION,SILERO_TORCH_VERSION} from '../server/tts/silero-engine.mjs';
const python=process.env.SAS_TTS_PYTHON||(process.platform==='win32'?'C:\\python312\\python.exe':'python3'),worker=path.resolve('server/tts/silero-worker.py');
test('Silero worker validates audio and model contracts, caches weights across voices and uses no online loader',t=>{
 const script=String.raw`
import importlib.util,sys,types,contextlib,tempfile,os,unittest,base64,io,wave
try:
 import numpy as np
except ImportError:
 sys.exit(77)
spec=importlib.util.spec_from_file_location('silero_worker',sys.argv[1]); w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
class Cases(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.file=os.path.join(self.tmp.name,'v3_1_ru.pt');open(self.file,'wb').write(b'model');self.loads=[];self.calls=[]
  owner=self
  class Model:
   speakers=['kseniya','aidar','en_0']
   def to(self,device): pass
   def apply_tts(self,**kwargs): owner.calls.append(kwargs);return np.sin(np.arange(2400)*.01).astype(np.float32)
  class Importer:
   def __init__(self,filename): owner.assertTrue(hasattr(filename,'read') and hasattr(filename,'seek'));owner.loads.append(filename)
   def load_pickle(self,package,name): owner.assertEqual((package,name),('tts_models','model'));return Model()
  self.original=sys.modules.get('torch');sys.modules['torch']=types.SimpleNamespace(set_num_threads=lambda n:None,cuda=types.SimpleNamespace(is_available=lambda:False),device=lambda d:d,package=types.SimpleNamespace(PackageImporter=Importer),inference_mode=contextlib.nullcontext)
  if w.model_file is not None:w.model_file.close()
  w.model=None;w.loaded=None;w.model_file=None
  self.request=dict(id='test',provider='silero',folder=self.tmp.name,modelFile=self.file,modelId='v3_1_ru',language='ru',voice='kseniya',device='cpu',threads=2,options=dict(sampleRate=24000,putAccent=True,putYo=True,speed=1))
 def tearDown(self):
  if w.model_file is not None:w.model_file.close();w.model_file=None
  if self.original is None:sys.modules.pop('torch',None)
  else:sys.modules['torch']=self.original
  self.tmp.cleanup()
 def test_reuse_and_pcm(self):
  self.request['text']='Дверь открылась. Щенок поднял голову.'; result=w.synthesize(self.request);self.request['voice']='aidar';w.synthesize(self.request)
  self.assertEqual(len(self.loads),1);self.assertEqual([c['speaker'] for c in self.calls],['kseniya','aidar']);self.assertEqual(self.calls[0]['put_yo'],True)
  with wave.open(io.BytesIO(base64.b64decode(result['audio'])),'rb') as f:self.assertEqual((f.getnchannels(),f.getsampwidth(),f.getframerate(),f.getnframes()),(1,2,24000,2400))
  self.assertAlmostEqual(result['duration'],.1)
 def test_no_voice_substitution(self):
  self.request.update(text='Привет.',voice='nonexistent')
  with self.assertRaisesRegex(ValueError,'отсутствует'):w.synthesize(self.request)
  self.assertEqual(self.calls,[])
 def test_language_rate_and_tempo(self):
  self.request.update(text='Hello.',language='en',modelId='v3_en',voice='en_0');self.request['options']['sampleRate']=48000;w.synthesize(self.request)
  self.assertEqual(self.calls[0]['sample_rate'],48000);self.assertNotIn('put_yo',self.calls[0]);self.assertNotIn('put_accent',self.calls[0])
  for value in [0,1.5,float('nan'),True]:
   self.request['options']['speed']=value
   with self.assertRaisesRegex(ValueError,'темпа'):w.parameters(self.request)
 def test_invalid_settings(self):
  self.request['text']='Text.'
  for change in [dict(text=' '),dict(text='x'*6001),dict(provider='xtts'),dict(modelId='v3_en'),dict(threads=True),dict(threads=1.5),dict(device='other'),dict(modelFile='relative.pt'),dict(options=dict(sampleRate=16000)),dict(options=dict(putAccent='yes'))]:
   with self.assertRaises(ValueError):w.parameters(dict(self.request,**change))
 def test_gpu_requires_cuda(self):
  self.request.update(text='Текст.',device='gpu')
  with self.assertRaisesRegex(ValueError,'CUDA'):w.synthesize(self.request)
  self.assertEqual(self.loads,[])
 def test_replaced_model_reloads(self):
  self.request['text']='Текст.';w.synthesize(self.request);open(self.file,'ab').write(b'new');w.synthesize(self.request);self.assertEqual(len(self.loads),2)
 def test_wav_rejects_invalid_output(self):
  for value in [[],[[1,2],[3,4]],[float('nan')],[float('inf')]]:
   with self.assertRaises(ValueError):w.encode_wav(value,24000)
  result=w.encode_wav([-2.,0.,2.],8000)
  with wave.open(io.BytesIO(base64.b64decode(result['audio'])),'rb') as f:self.assertEqual(np.frombuffer(f.readframes(3),dtype='<i2').tolist(),[-32767,0,32767])
unittest.main(argv=['silero-worker'],verbosity=2)
`;
 const result=spawnSync(python,['-c',script,worker],{input:'',encoding:'utf8',timeout:30000});if(result.error?.code==='ENOENT'||result.status===77){t.skip('Python/numpy not installed');return;}assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('Silero JSON-lines errors preserve request IDs without leaking a previous ID',t=>{
 const result=spawnSync(python,['-u',worker],{input:'{"id":"first","provider":"wrong"}\ninvalid json\n[]\n{"id":"last","provider":"wrong"}\n',encoding:'utf8',timeout:10000});if(result.error?.code==='ENOENT'){t.skip('Python not installed');return;}assert.equal(result.status,0,result.stderr);const output=result.stdout.trim().split('\n').map(JSON.parse);assert.deepEqual(output.map(r=>r.id),['first',null,null,'last']);assert.ok(output.every(r=>typeof r.error==='string'));
});
test('Isolated Windows Python accepts UTF-8 model paths in Russian folders even when locale encoding differs',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'sas-silero-кириллица-')),file=path.join(folder,'модель.pt');await fs.writeFile(file,'local package');t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const input=JSON.stringify({id:'russian-path',provider:'silero',modelFile:file,modelId:'v3_1_ru',language:'ru',text:'Дверь открылась.',voice:''})+'\n',result=spawnSync(python,['-I','-u',worker],{input,encoding:'utf8',timeout:10000,env:{...process.env,PYTHONIOENCODING:'cp1251'}});if(result.error?.code==='ENOENT'){t.skip('Python not installed');return;}assert.equal(result.status,0,result.stderr);assert.match(JSON.parse(result.stdout).error,/Выберите готовый голос/);
});
test('Windows Silero runtime uses relative embedded Python rather than an external venv',async()=>{
 assert.equal(SILERO_RUNTIME_VERSION,1);assert.equal(SILERO_PYTHON_VERSION,'3.11.9');assert.equal(SILERO_TORCH_VERSION,'2.5.1');assert.equal(sileroExecutable('runtime'),path.join('runtime',process.platform==='win32'?'python.exe':'bin/python'));
 const source=await fs.readFile(new URL('../server/tts/silero-engine.mjs',import.meta.url),'utf8');assert.ok(source.includes('Lib/site-packages'));assert.ok(source.includes('embed-amd64.zip'));assert.ok(source.includes("'--only-binary=:all:'"));assert.ok(!source.includes('torchaudio'));
});
test('Silero never accepts a ready runtime or bundled Python built for another OS or architecture',()=>{
 const legacy={provider:'silero',version:1,device:'cpu',portable:true},win={...legacy,platform:'win32',arch:'x64'},linux={...legacy,portable:false,platform:'linux',arch:'x64'};
 assert.equal(sileroRuntimeCompatible(legacy,'cpu',{platform:'win32',arch:'x64'}),true);assert.equal(sileroRuntimeCompatible(legacy,'cpu',{platform:'linux',arch:'x64'}),false);assert.equal(sileroRuntimeCompatible(win,'cpu',{platform:'linux',arch:'x64'}),false);assert.equal(sileroRuntimeCompatible(win,'cpu',{platform:'win32',arch:'arm64'}),false);assert.equal(sileroRuntimeCompatible(linux,'cpu',{platform:'linux',arch:'x64'}),true);assert.equal(sileroRuntimeCompatible(win,'gpu',{platform:'win32',arch:'x64'}),false);assert.equal(sileroRuntimeCompatible({...win,portable:false},'cpu',{platform:'win32',arch:'x64'}),false);
});
