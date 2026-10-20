import sys, json, io, base64, os, contextlib
# Keep stdout a machine-readable channel; library diagnostics stay on stderr.
protocol = sys.stdout
loaded = None
model = None
engine = None
conditioning = {}

def xtts_parameters(settings):
    # JSON has one number type: `2` arrives as int. Transformers insists on
    # real floats for penalties even though 2 and 2.0 have the same value.
    return dict(temperature=float(settings['temperature']), top_k=int(settings['topK']),
                top_p=float(settings['topP']), repetition_penalty=float(settings['repetitionPenalty']),
                length_penalty=float(settings['lengthPenalty']), speed=float(settings['speed']))

def synthesize(r):
    global loaded, model, engine
    import torch, soundfile as sf
    torch.set_num_threads(r.get('threads', 2))
    device = 'cuda' if r['device'] == 'gpu' else 'cpu'
    if device == 'cuda' and not torch.cuda.is_available():
        raise ValueError('CUDA недоступна. Установите GPU-движок озвучки либо выберите CPU.')
    key = (r['provider'], r['folder'], device)
    settings = r['options']
    if loaded != key:
        conditioning.clear()
        if r['provider'] == 'xtts':
            from TTS.tts.configs.xtts_config import XttsConfig
            from TTS.tts.models.xtts import Xtts
            config = XttsConfig(); config.load_json(os.path.join(r['folder'], 'config.json'))
            model = Xtts.init_from_config(config)
            model.load_checkpoint(config, checkpoint_dir=r['folder'], eval=True, use_deepspeed=False)
            model.to(device)
        else:
            sys.path.insert(0, r['source'])
            from fish_speech.inference_engine import TTSInferenceEngine
            from fish_speech.models.text2semantic.inference import launch_thread_safe_queue
            from fish_speech.models.vqgan.inference import load_model
            precision = torch.float32 if device == 'cpu' else torch.float16
            q = launch_thread_safe_queue(checkpoint_path=r['folder'], device=device, precision=precision, compile=False)
            decoder = load_model(config_name='firefly_gan_vq', checkpoint_path=os.path.join(r['folder'], 'firefly-gan-vq-fsq-8x1024-21hz-generator.pth'), device=device)
            engine = TTSInferenceEngine(llama_queue=q, decoder_model=decoder, precision=precision, compile=False)
        loaded = key
    if r['provider'] == 'xtts':
        if r.get('referencePath'):
            ref_key = (r['referencePath'], os.stat(r['referencePath']).st_mtime_ns, settings['gptCondLen'], settings['gptCondChunkLen'], settings['maxRefLen'], settings['soundNormRefs'])
            if ref_key not in conditioning:
                if len(conditioning) >= 32: conditioning.pop(next(iter(conditioning)))
                conditioning[ref_key] = model.get_conditioning_latents(audio_path=[r['referencePath']], gpt_cond_len=int(settings['gptCondLen']), gpt_cond_chunk_len=int(settings['gptCondChunkLen']), max_ref_length=int(settings['maxRefLen']), sound_norm_refs=bool(settings['soundNormRefs']))
            latent, embedding = conditioning[ref_key]
        else:
            speaker = 'Ana Florence' if settings['voice'] == 'female' else 'Craig Gutsy'
            speakers = model.speaker_manager.speakers
            match = next((s for s in speakers if s.replace(' ', '').lower() == speaker.replace(' ', '').lower()), None)
            if not match: raise ValueError('Предустановленный голос XTTS не найден; загрузите образец голоса.')
            latent = speakers[match]['gpt_cond_latent']; embedding = speakers[match]['speaker_embedding']
        with torch.inference_mode():
            # SAS already chunks by language and tokenizer's character limit.
            # No language-specific Spacy model download during offline inference.
            result = model.inference(r['text'], r['language'], latent, embedding, **xtts_parameters(settings), enable_text_splitting=False)
        samples, rate = result['wav'], 24000
    else:
        from fish_speech.utils.schema import ServeTTSRequest, ServeReferenceAudio
        references = []
        if r.get('referencePath'):
            references = [ServeReferenceAudio(audio=open(r['referencePath'], 'rb').read(), text=r.get('referenceText', ''))]
        req = ServeTTSRequest(text=r['text'], references=references, reference_id=None, max_new_tokens=settings['maxNewTokens'], chunk_length=settings['chunkLength'], top_p=float(settings['topP']), temperature=float(settings['temperature']), repetition_penalty=float(settings['repetitionPenalty']), seed=settings['seed'] or None, use_memory_cache='on', streaming=False)
        result = None
        for part in engine.inference(req):
            if part.code == 'error': raise RuntimeError(str(part.error))
            if part.code == 'final': result = part.audio
        if result is None: raise RuntimeError('Fish Speech не вернул звук.')
        rate, samples = result
    buf = io.BytesIO(); sf.write(buf, samples, rate, format='WAV', subtype='PCM_16')
    return {'audio': base64.b64encode(buf.getvalue()).decode(), 'duration': len(samples)/rate}
for line in sys.stdin:
    try:
        r=json.loads(line)
        with contextlib.redirect_stdout(sys.stderr): result=synthesize(r)
        response={'id':r['id'], **result}
    except Exception as e: response={'id':r.get('id'), 'error':str(e)}
    protocol.write(json.dumps(response, ensure_ascii=True)+'\n'); protocol.flush()
