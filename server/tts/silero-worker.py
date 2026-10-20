"""Offline Silero package inference; stdout is the SAS JSON-lines protocol.

The installer supplies a verified local package.  This worker never calls Torch
Hub or downloads models.  A different speaker reuses the same loaded weights.
"""
import base64
import contextlib
import io
import json
import math
import os
import sys
import wave

protocol = sys.stdout
loaded = None
model = None
model_file = None


def integer(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(name + ': требуется целое число.')
    if not math.isfinite(value) or int(value) != value or not minimum <= value <= maximum:
        raise ValueError(name + ': недопустимое значение.')
    return int(value)


def parameters(request):
    if not isinstance(request, dict) or request.get('provider') != 'silero':
        raise ValueError('Неверный движок озвучки Silero.')
    text = request.get('text')
    if not isinstance(text, str) or not text.strip() or len(text) > 6000:
        raise ValueError('Silero: требуется непустая фраза длиной до 6000 символов.')
    options = request.get('options', {})
    if not isinstance(options, dict):
        raise ValueError('Silero: неверные настройки.')
    rate = integer(options.get('sampleRate', 24000), 'Частота Silero', 8000, 48000)
    if rate not in (8000, 24000, 48000):
        raise ValueError('Silero поддерживает частоту 8000, 24000 или 48000 Гц.')
    # apply_tts has no tempo argument. Resampling just to change the tempo would
    # also change voice pitch, so do not silently distort the selected speaker.
    speed = options.get('speed', 1)
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not math.isfinite(speed) or speed != 1:
        raise ValueError('Silero: изменение темпа не поддерживается; используйте скорость 1.')
    for key in ('putAccent', 'putYo'):
        if key in options and not isinstance(options[key], bool):
            raise ValueError('Silero: ' + key + ' должен быть логическим значением.')
    device = request.get('device', 'cpu')
    if device not in ('cpu', 'gpu'):
        raise ValueError('Silero: выберите CPU или GPU.')
    language = request.get('language', 'ru')
    language = 'en' if language == 'eng' else language
    if language not in ('ru', 'en'):
        raise ValueError('Silero: поддерживаются русский и английский языки.')
    model_id = request.get('modelId')
    if not isinstance(model_id, str) or not model_id.endswith('_' + language):
        raise ValueError('Выбранная модель Silero не соответствует языку озвучки.')
    filename = request.get('modelFile')
    if not isinstance(filename, str) or not os.path.isabs(filename) or not filename.lower().endswith('.pt') or not os.path.isfile(filename):
        raise ValueError('Локальный пакет модели Silero (.pt) не найден.')
    speaker = request.get('voice')
    if not isinstance(speaker, str) or not speaker:
        raise ValueError('Выберите готовый голос Silero.')
    return dict(text=text.strip(), options=options, rate=rate,
                threads=integer(request.get('threads', 2), 'Потоки Silero', 1, 64),
                device='cuda' if device == 'gpu' else 'cpu', language=language,
                filename=os.path.realpath(filename), speaker=speaker)


def encode_wav(samples, rate):
    import numpy as np
    if hasattr(samples, 'detach'):
        samples = samples.detach().cpu().numpy()
    samples = np.asarray(samples, dtype=np.float32).squeeze()
    if samples.ndim != 1 or not samples.size or samples.size > rate * 180 or not np.isfinite(samples).all():
        raise ValueError('Silero не вернул корректный монофонический звук.')
    pcm = (np.clip(samples, -1, 1) * 32767).astype('<i2')
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm.tobytes())
    return dict(audio=base64.b64encode(buffer.getvalue()).decode('ascii'), duration=int(samples.size) / rate)


def synthesize(request):
    global loaded, model, model_file
    settings = parameters(request)
    import torch
    torch.set_num_threads(settings['threads'])
    if settings['device'] == 'cuda' and not torch.cuda.is_available():
        raise ValueError('CUDA недоступна для Silero. Выберите CPU либо установите GPU-движок озвучки.')
    stat = os.stat(settings['filename'])
    key = (settings['filename'], stat.st_mtime_ns, stat.st_size, settings['device'])
    if key != loaded:
        # Drop previous weights before loading another package, to keep the
        # worker from retaining two speech models in RAM/VRAM at once.
        loaded, model = None, None
        if model_file is not None:
            model_file.close()
            model_file = None
        # PyTorch's C++ filename reader on Windows cannot reliably open paths
        # containing Cyrillic. Python's Unicode-aware open + supported binary
        # file interface avoids moving/copying the model to another directory.
        file = open(settings['filename'], 'rb')
        try:
            package = torch.package.PackageImporter(file).load_pickle('tts_models', 'model')
            package.to(torch.device(settings['device']))
            if callable(getattr(package, 'eval', None)):
                package.eval()
        except Exception:
            file.close()
            raise
        model_file = file
        model, loaded = package, key
    speakers = getattr(model, 'speakers', None)
    if not isinstance(speakers, (list, tuple, set, dict)) or not speakers:
        raise ValueError('Пакет Silero не содержит список готовых голосов.')
    if settings['speaker'] not in speakers:
        raise ValueError('Голос ' + settings['speaker'] + ' отсутствует в выбранной модели Silero. Выберите другой голос.')
    arguments = dict(text=settings['text'], speaker=settings['speaker'], sample_rate=settings['rate'])
    if settings['language'] == 'ru':
        arguments.update(put_accent=settings['options'].get('putAccent', True),
                         put_yo=settings['options'].get('putYo', True))
    with torch.inference_mode():
        samples = model.apply_tts(**arguments)
    return encode_wav(samples, settings['rate'])


def main():
    # -I intentionally ignores PYTHONIOENCODING on Windows. The parent writes
    # UTF-8 JSON, including Cyrillic text and user-selected model directories.
    # Configure the protocol explicitly instead of relying on the console ACP.
    for stream in (sys.stdin, protocol):
        if callable(getattr(stream, 'reconfigure', None)):
            stream.reconfigure(encoding='utf-8', errors='strict')
    if callable(getattr(sys.stderr, 'reconfigure', None)):
        sys.stderr.reconfigure(encoding='utf-8', errors='backslashreplace')
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                result = synthesize(request)
            response = dict(id=request.get('id'), **result)
        except Exception as error:
            response = dict(id=request.get('id') if isinstance(request, dict) else None, error=str(error))
        protocol.write(json.dumps(response, ensure_ascii=True) + '\n')
        protocol.flush()


if __name__ == '__main__':
    main()
