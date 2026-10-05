#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
stt_service.py — локальный STT-сервис AVC-Anime на faster-whisper.

РЕФЕРЕНС (верифицирован из исходников Mantella v0.14, main @ c0c1ae6db01f,
см. MANTELLA_STT_RESEARCH.md): faster-whisper + ВНЕШНИЙ Silero-VAD;
transcribe(language=<язык>, beam_size=5, vad_filter=False); CPU → compute_type
"float32"; CUDA → compute_type не передаётся; device из конфига, дефолт cpu.

КОД Mantella (AGPL-3.0) НЕ копируется — реализован независимый сервис с тем же
поведенческим контрактом поверх MIT-зависимостей (faster-whisper, CTranslate2,
silero_vad.onnx, onnxruntime).

ПРОТОКОЛ (JSON-lines по stdio, одна строка = одно сообщение):
  запросы (stdin):
    {"id":N,"type":"feed","audio":"<b64 int16le 16kHz mono>"}
    {"id":N,"type":"flush"}
    {"id":N,"type":"capture-mode","on":true|false}
    {"id":N,"type":"decode","audio":"<b64 float32le>","sampleRate":16000}
    {"id":N,"type":"ping"}
    {"id":N,"type":"reset"}
    {"id":N,"type":"shutdown"}
  события (stdout):
    {"event":"status","state":"loading-model|ready|failed|error",...}
    {"event":"partial","utteranceId":N,"text":str,"ms":N}
    {"event":"final","utteranceId":N,"text":str,"reason":"endpoint|flush|timeout|capture|error","ms":N}
    {"event":"log","level":"info|warn|error","message":str}
  ответы: {"id":N,...,"ok":true,"result":{...}} | {"id":N,...,"ok":false,"error":str}

Selftest (CI/локально):
  stt_service.py --model DIR --vad PATH --wav FILE [--expect ТЕКСТ]
  печатает JSON-результат, exit 0 (PASS) / 2 (FAIL).
"""

import argparse
import base64
import json
import sys
import threading
import time
import queue

import numpy as np

# --- глобальное состояние -------------------------------------------------------

ARGS = None
OUT_LOCK = threading.Lock()
VAD_LOCK = threading.Lock()          # VAD-состояние (h/c) и pre-roll
INFER_LOCK = threading.Lock()        # сериализация инференса (одна модель)
JOB_QUEUE = queue.Queue(maxsize=8)

WHISPER_MODEL = None                 # faster_whisper.WhisperModel
VAD_SESSION = None
VAD_KIND = None                      # 'v4' (h,c) | 'v5' (state)
UTTERANCE_SEQ = 0
DEVICE_USED = None
COMPUTE_USED = None
MODEL_LOAD_MS = None

# Минимальная анти-галлюцинационная политика на тишине (аналог ignore-list Mantella;
# список общий для ru/en — классические фразы Whisper на паузах/шуме)
HALLUCINATION_IGNORE = {
    "thank you.", "thanks for watching!", "thanks for watching",
    "thank you for watching", "subscribe", "подпишитесь", "спасибо за просмотр",
    "спасибо, что посмотрели", "продолжение следует", "до свидания",
    "перевод и озвучка", "смотрите далее",
    # Наблюдения v1.0.27 (issue #3): Whisper на музыке/шуме из колонок выдаёт
    # «ДИНАМИЧНАЯ МУЗЫКА», «СИГНАЛЬНАЯ ЗАСТАВКА» и т.п.; парсер превращал их
    # в поиск аниме -> открывалось чужое аниме поверх играющего (наложение аудио).
    "динамичная музыка", "музыка", "музыка стихает", "музыка затихает",
    "музыка играет", "сигнальная заставка", "заставка", "титры", "реклама",
    "аплодисменты", "смех в студии", "звенит будильник", "нет субтитров",
    "субтитры", "приятного просмотра", "всем приятного просмотра",
    "смотрите в следующей серии", "конец серии",
    "осталось меньше минуты", "продолжайте смотреть", "вы смотрите",
    "перевод", "озвучка",
}

# Гейт качества сегмента Whisper (галлюцинации на музыке/шуме):
# no_speech_prob - собственная оценка Whisper «речи тут нет»;
# avg_logprob - средняя лог-вероятность токенов (у мусора сильно отрицательная).
SEGMENT_NO_SPEECH_DROP = 0.65
SEGMENT_LOGPROB_DROP = -1.0


_IGNORE_NORM = None


def _ignore_norm():
    global _IGNORE_NORM
    if _IGNORE_NORM is None:
        _IGNORE_NORM = {h.strip(".!? ,").lower() for h in HALLUCINATION_IGNORE}
    return _IGNORE_NORM


def emit(obj):
    """Единственная точка записи в stdout (сериализована локом)."""
    data = json.dumps(obj, ensure_ascii=False)
    with OUT_LOCK:
        sys.stdout.write(data + "\n")
        sys.stdout.flush()


def emit_log(level, message):
    emit({"event": "log", "level": level, "message": str(message)[:500]})


def emit_status(state, **extra):
    payload = {"event": "status", "state": state}
    payload.update(extra)
    emit(payload)


# --- Silero VAD (внешний, как в Mantella) ---------------------------------------

def vad_load(path):
    """Загрузить silero_vad.onnx через onnxruntime; определить вариант модели.
    Поддерживаются: v4-канонический (input,h,c,sr), v5 (input,state,sr) и
    sherpa-onnx-экспорт (x,h,c — 16 кГц зашит, состояние (2,1,64))."""
    import onnxruntime as ort
    global VAD_SESSION, VAD_KIND
    opts = ort.SessionOptions()
    opts.inter_op_num_threads = 1
    opts.intra_op_num_threads = 1
    opts.log_severity_level = 3
    VAD_SESSION = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
    names = {i.name for i in VAD_SESSION.get_inputs()}
    if {"input", "h", "c", "sr"}.issubset(names):
        VAD_KIND = "v4"
    elif {"input", "state", "sr"}.issubset(names):
        VAD_KIND = "v5"
    elif {"x", "h", "c"}.issubset(names):
        VAD_KIND = "sherpa"
    else:
        raise RuntimeError(f"Неизвестный формат silero_vad.onnx, входы: {sorted(names)}")


class VadStream:
    """Потоковый Silero-VAD с состоянием (как Mantella: 16кГц, окно 512)."""

    def __init__(self, threshold, preroll_windows):
        self.threshold = threshold
        self.preroll_windows = preroll_windows
        self.reset()

    def reset(self):
        self.h = np.zeros((1, 128), dtype=np.float32)
        self.c = np.zeros((1, 128), dtype=np.float32)
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.h_sherpa = np.zeros((2, 1, 64), dtype=np.float32)
        self.c_sherpa = np.zeros((2, 1, 64), dtype=np.float32)
        self.ring = []          # pre-roll: последние N окон (float32 512)
        self.in_speech = False
        self.speech_windows = 0
        self.silence_windows = 0

    def prob(self, window):
        """window: np.float32[512] → вероятность речи [0..1]."""
        if VAD_KIND == "v4":
            out, self.h, self.c = VAD_SESSION.run(
                None,
                {"input": window.reshape(1, 512), "h": self.h, "c": self.c,
                 "sr": np.array(16000, dtype=np.int64)})
        elif VAD_KIND == "v5":
            out, self.state = VAD_SESSION.run(
                None,
                {"input": window.reshape(1, 512), "state": self.state,
                 "sr": np.array(16000, dtype=np.int64)})
        else:  # sherpa-onnx export
            out, self.h_sherpa, self.c_sherpa = VAD_SESSION.run(
                None,
                {"x": window.reshape(1, 512), "h": self.h_sherpa, "c": self.c_sherpa})
        return float(np.clip(out[0][0], 0.0, 1.0))

    def feed_window(self, window):
        """Одно окно → dict: {speech_started, speech, speech_ended, prob}."""
        p = self.prob(window)
        is_speech = p >= self.threshold
        ev = {"speech_started": False, "speech": False, "speech_ended": False, "prob": p}
        if not self.in_speech:
            self.ring.append(window.copy())
            if len(self.ring) > self.preroll_windows:
                self.ring.pop(0)
            if is_speech:
                self.in_speech = True
                self.speech_windows = 0
                self.silence_windows = 0
                ev["speech_started"] = True
                ev["speech"] = True
        else:
            ev["speech"] = True
            if is_speech:
                self.speech_windows += 1
                self.silence_windows = 0
            else:
                self.silence_windows += 1
                # Mantella pause_threshold: конец речи после паузы (окна по 32 мс)
                if self.silence_windows >= int(round(ARGS.pause_ms / 32.0)):
                    self.in_speech = False
                    ev["speech_ended"] = True
        return ev


# --- инференс (faster-whisper) ---------------------------------------------------

def whisper_load():
    """Загрузить модель ОДИН раз (путь локальный — HF не вызывается)."""
    global WHISPER_MODEL, DEVICE_USED, COMPUTE_USED, MODEL_LOAD_MS
    from faster_whisper import WhisperModel
    t0 = time.time()
    kwargs = {"device": ARGS.device}
    if ARGS.device == "cpu":
        kwargs["compute_type"] = ARGS.compute_type  # Mantella: CPU → float32 явно
    # CUDA: compute_type не передаётся (дефолт faster-whisper "default") — как в Mantella
    WHISPER_MODEL = WhisperModel(ARGS.model, **kwargs)
    DEVICE_USED = ARGS.device
    COMPUTE_USED = kwargs.get("compute_type", "default")
    MODEL_LOAD_MS = int((time.time() - t0) * 1000)


def transcribe_samples(samples_f32, beam_size):
    """Декодировать float32 16кГц -> (текст, уверенность 0..1).

    Параметры Mantella: beam 5, vad_filter=False (VAD внешний - наш).
    Уверенность = exp(взвешенного по длине avg_logprob) - честная метка качества;
    рендерер в always-listening не исполняет команды с низкой уверенностью.
    """
    if samples_f32.size == 0:
        return "", 0.0
    rms = float(np.sqrt(np.mean(np.square(samples_f32))))
    if rms < 1e-4:
        return "", 0.0  # быстрая тишина без дорогого вызова
    segments, _info = WHISPER_MODEL.transcribe(
        samples_f32,
        language=ARGS.language,
        task="transcribe",
        beam_size=beam_size,
        vad_filter=False,  # VAD внешний (наш), как в Mantella
    )
    ign = _ignore_norm()
    parts = []
    logprob_sum = 0.0
    weight_sum = 0.0
    for seg in segments:
        t = (seg.text or "").strip()
        if not t:
            continue
        if t.lower().strip(".!? ,") in ign:
            continue  # известная галлюцинация на тишине - сегмент отбрасывается
        # Гейт качества: сегмент-фантом на музыке/шуме отбрасываем целиком.
        nsp = float(getattr(seg, "no_speech_prob", 0.0) or 0.0)
        alp = float(getattr(seg, "avg_logprob", 0.0) or 0.0)
        if nsp > SEGMENT_NO_SPEECH_DROP or alp < SEGMENT_LOGPROB_DROP:
            emit_log("info", f"сегмент отброшен гейтом качества: {t[:60]!r} (no_speech={nsp:.2f}, logprob={alp:.2f})")
            continue
        parts.append(t)
        try:
            w = max(1, len(getattr(seg, "tokens", None) or []))
        except Exception:  # noqa: BLE001
            w = max(1, len(t))
        logprob_sum += alp * w
        weight_sum += w
    text = " ".join(parts).strip()
    if not text or weight_sum <= 0:
        return "", 0.0
    confidence = float(np.clip(np.exp(logprob_sum / weight_sum), 0.0, 1.0))
    return text, confidence





# --- поток инференса --------------------------------------------------------------

def inference_worker():
    """Один поток инференса: partial (beam 1) и final (beam 5) — строго по очереди."""
    while True:
        job = JOB_QUEUE.get()
        if job is None:
            return
        kind, samples, utterance_id = job[0], job[1], job[2]
        started_ms = job[3] if len(job) > 3 else 0
        reason = job[4] if len(job) > 4 else "endpoint"
        try:
            t0 = time.time()
            text, confidence = transcribe_samples(samples, beam_size=(1 if kind == "partial" else 5))
            ms = int((time.time() - t0) * 1000)
            if kind == "partial":
                if text:
                    emit({"event": "partial", "utteranceId": utterance_id, "text": text, "ms": ms,
                          "confidence": round(confidence, 3)})
            else:
                emit({"event": "final", "utteranceId": utterance_id, "text": text,
                      "reason": reason, "ms": int((time.time() * 1000) - started_ms),
                      "confidence": round(confidence, 3)})
        except Exception as e:  # noqa: BLE001 — ошибка инференса не должна убивать сервис
            if kind == "final":
                emit({"event": "final", "utteranceId": utterance_id, "text": "",
                      "reason": "error", "ms": 0})
            emit_log("error", f"inference {kind}: {type(e).__name__}: {e}")


# --- сессия распознавания (VAD → накопление → очередь) ----------------------------

class Session:
    """Потоковая сессия: окна 512 → VAD → буфер фразы → final/partial."""

    def __init__(self):
        self.vad = VadStream(ARGS.threshold, ARGS.preroll_windows)
        self.buffer = []            # список np.float32[512]
        self.buffer_len = 0
        self.utterance_id = 0
        self.utterance_started_ms = None
        self.speech_ms = 0
        self.last_partial_ms = 0.0
        self.last_partial_len = 0
        self.capture_mode = False

    def _take_buffer(self):
        samples = np.concatenate(self.buffer) if self.buffer else np.zeros(0, dtype=np.float32)
        self.buffer = []
        self.buffer_len = 0
        return samples

    def feed(self, int16_np):
        """int16_np: np.int16 16кГц mono (произвольная длина; режем на окна 512)."""
        global UTTERANCE_SEQ
        f32 = int16_np.astype(np.float32) / 32768.0
        pos = 0
        n = f32.size
        while pos + 512 <= n:
            window = f32[pos:pos + 512]
            pos += 512

            if self.capture_mode:
                # режим рации: VAD обходится, всё аудио — речь
                if self.utterance_started_ms is None:
                    UTTERANCE_SEQ += 1
                    self.utterance_id = UTTERANCE_SEQ
                    self.utterance_started_ms = time.time() * 1000.0
                    self.speech_ms = 0
                self.buffer.append(window)
                self.buffer_len += 512
                # кап рации: при зажатой/залипшей кнопке буфер не растёт бесконечно
                if self.buffer_len >= ARGS.listen_timeout * 16000:
                    self._finalize("timeout")
                continue

            ended = False
            with VAD_LOCK:
                ev = self.vad.feed_window(window)
                if ev["speech_started"]:
                    self.buffer.extend(self.vad.ring)  # pre-roll: не терять начало слова
                    self.buffer_len += 512 * len(self.vad.ring)
                    self.vad.ring = []
                    UTTERANCE_SEQ += 1
                    self.utterance_id = UTTERANCE_SEQ
                    self.utterance_started_ms = time.time() * 1000.0
                    self.speech_ms = 0
                    self.last_partial_ms = 0.0
                    self.last_partial_len = 0
                if ev["speech"]:
                    if self.utterance_started_ms is not None:
                        self.buffer.append(window)
                        self.buffer_len += 512
                        self.speech_ms += 32
                if ev.get("speech_ended"):
                    ended = True

            if self.utterance_started_ms is None:
                continue

            # кап непрерывной фразы (Mantella listen_timeout) → финал
            if self.speech_ms >= ARGS.listen_timeout * 1000:
                self._finalize("timeout")
                continue
            # partial-эмуляция для UI (задокументированное отклонение, план §4):
            # лёгкий декод (beam 1) не чаще partial_interval_ms и при росте буфера
            now_ms = time.time() * 1000.0
            if (self.buffer_len >= 16000 * 0.8
                    and (now_ms - self.last_partial_ms) >= ARGS.partial_interval_ms
                    and (self.buffer_len - self.last_partial_len) >= 8000
                    and JOB_QUEUE.empty()):
                self.last_partial_ms = now_ms
                self.last_partial_len = self.buffer_len
                self._enqueue_partial()
            if ended:
                self._finalize("endpoint")

    def _enqueue_partial(self):
        snapshot = np.concatenate(self.buffer).copy()
        try:
            JOB_QUEUE.put_nowait(("partial", snapshot, self.utterance_id))
        except queue.Full:
            pass  # partial не критичен — пропускаем

    def _finalize(self, reason):
        if self.utterance_started_ms is None:
            return
        samples = self._take_buffer()
        duration_s = samples.size / 16000.0
        started = self.utterance_started_ms
        uid = self.utterance_id
        self.utterance_started_ms = None
        self.speech_ms = 0
        self.last_partial_ms = 0.0
        self.last_partial_len = 0
        with VAD_LOCK:
            self.vad.reset()
        if duration_s < (ARGS.min_speech_ms / 1000.0):
            emit_log("info", f"utterance #{uid} отброшена ({duration_s:.2f} с < {ARGS.min_speech_ms} мс)")
            return
        JOB_QUEUE.put(("final", samples, uid, started, reason))

    def flush(self):
        if self.capture_mode:
            self._finalize("capture")
        else:
            # УРОК из T-One: flush без активной VAD-фразы не должен молча терять аудио
            self._finalize("flush")

    def reset(self):
        self.buffer = []
        self.buffer_len = 0
        self.utterance_started_ms = None
        self.speech_ms = 0
        self.last_partial_ms = 0.0
        self.last_partial_len = 0
        with VAD_LOCK:
            self.vad.reset()


SESSION = None


# --- обработчики запросов ----------------------------------------------------------

def handle_request(msg):
    mtype = msg.get("type")
    try:
        if mtype == "ping":
            return {"ok": True, "result": {
                "ready": WHISPER_MODEL is not None and SESSION is not None,
                "device": DEVICE_USED, "computeType": COMPUTE_USED,
                "modelLoadMs": MODEL_LOAD_MS, "vad": VAD_KIND,
                "language": ARGS.language, "model": ARGS.model,
                "queue": JOB_QUEUE.qsize(),
            }}
        if SESSION is None:
            return {"ok": False, "error": "Сервис не готов (ошибка загрузки модели/VAD)"}
        if mtype == "feed":
            raw = base64.b64decode(msg.get("audio", ""))
            int16 = np.frombuffer(raw, dtype=np.int16)
            SESSION.feed(int16)
            return {"ok": True, "result": {"queued": JOB_QUEUE.qsize()}}
        if mtype == "flush":
            SESSION.flush()
            return {"ok": True}
        if mtype == "capture-mode":
            on = bool(msg.get("on"))
            if on and not SESSION.capture_mode:
                # Урок v1.0.27 (issue #3): до нажатия рации VAD мог уже набирать
                # «фразу» из окружающего шума/музыки из колонок. Без сброса она
                # смешалась бы с речью пользователя в один final («нарууу-рутуол»).
                SESSION.reset()
                SESSION.capture_mode = True
            if not on and SESSION.capture_mode:
                SESSION.capture_mode = False
                # выключение рации завершает фразу с честной причиной 'capture'
                SESSION._finalize("capture")
            return {"ok": True}
        if mtype == "set-vad-threshold":
            th = float(msg.get("threshold", ARGS.threshold))
            th = min(0.9, max(0.1, th))
            SESSION.vad.threshold = th
            return {"ok": True, "result": {"threshold": th}}
        if mtype == "decode":
            raw = base64.b64decode(msg.get("audio", ""))
            sr = int(msg.get("sampleRate", 16000))
            if sr != 16000:
                raise ValueError(f"Поддерживается только 16 кГц, получено {sr}")
            f32 = np.frombuffer(raw, dtype=np.float32)
            t0 = time.time()
            text, confidence = transcribe_samples(f32, beam_size=5)
            return {"ok": True, "result": {"text": text, "ms": int((time.time() - t0) * 1000),
                                           "confidence": round(confidence, 3)}}
        if mtype == "reset":
            SESSION.reset()
            return {"ok": True}
        if mtype == "shutdown":
            return {"ok": True}
        return {"ok": False, "error": f"Неизвестный тип запроса: {mtype}"}
    except Exception as e:  # noqa: BLE001
        emit_log("error", f"handler {mtype}: {type(e).__name__}: {e}")
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# --- WAV/selftest -------------------------------------------------------------------

def read_wav_f32(path):
    """Минимальный WAV-ридер (PCM16 mono/stereo) → float32 16кГц mono."""
    import wave
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        width = w.getsampwidth()
        frames = w.readframes(w.getnframes())
    if width != 2:
        raise ValueError(f"Ожидается PCM16, получена разрядность {width * 8}")
    x = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    if sr != 16000:
        n_out = int(round(x.size * 16000.0 / sr))
        idx = np.clip((np.arange(n_out) * (sr / 16000.0)).astype(np.int32), 0, x.size - 1)
        x = x[idx]
    return x


def run_selftest(args):
    """Загрузить модель, транскрибировать WAV, сверить --expect, exit 0/2."""
    result = {"wav": args.wav, "model": args.model, "device": ARGS.device,
              "computeType": ARGS.compute_type, "language": ARGS.language}
    t0 = time.time()
    whisper_load()
    result["modelLoadMs"] = int((time.time() - t0) * 1000)
    samples = read_wav_f32(args.wav)
    result["audioMs"] = int(samples.size / 16000 * 1000)
    t1 = time.time()
    text, confidence = transcribe_samples(samples, beam_size=5)
    result["transcribeMs"] = int((time.time() - t1) * 1000)
    result["text"] = text
    result["confidence"] = round(confidence, 3)
    if args.expect:
        norm = lambda s: "".join(c for c in s.lower() if c.isalnum() or c.isspace())  # noqa: E731
        result["expect"] = args.expect
        # мульти-варианты через |: достаточно ЛЮБОГО (например «наруто|нарута|рута»)
        variants = [v.strip() for v in args.expect.split('|') if v.strip()]
        result["pass"] = any(norm(v) in norm(text) for v in variants)
    else:
        result["pass"] = len(text) > 0
    print(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()
    return 0 if result["pass"] else 2


def main():
    global ARGS, SESSION
    # Windows-консоли (cp1252/cp866) нельзя доверять: JSON с кириллицей обязан
    # уходить в stdout как UTF-8 всегда (Node-адаптер тоже ставит PYTHONUTF8,
    # но сервис не должен зависеть от окружения)
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 — старые пайтон-обёртки без reconfigure
        pass
    p = argparse.ArgumentParser(description="AVC-Anime faster-whisper STT service")
    p.add_argument("--model", required=True, help="Каталог CTranslate2-модели (local dir)")
    p.add_argument("--vad", help="Путь к silero_vad.onnx (не нужен для --wav selftest)")
    p.add_argument("--language", default="ru")
    p.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    p.add_argument("--compute-type", dest="compute_type", default="float32")
    p.add_argument("--threshold", type=float, default=0.4)
    p.add_argument("--pause-ms", dest="pause_ms", type=int, default=250)
    p.add_argument("--listen-timeout", dest="listen_timeout", type=int, default=30)
    p.add_argument("--min-speech-ms", dest="min_speech_ms", type=int, default=300)
    p.add_argument("--partial-interval-ms", dest="partial_interval_ms", type=int, default=1000)
    p.add_argument("--preroll-windows", dest="preroll_windows", type=int, default=12)  # Mantella=5; отклонение: 12 (384 мс) — бенчмарк показал срез начал слов при 5
    p.add_argument("--wav", help="selftest: WAV-файл для транскрибации")
    p.add_argument("--expect", help="selftest: ожидаемая подстрока")
    ARGS = p.parse_args()

    if ARGS.wav:
        sys.exit(run_selftest(ARGS))

    # stdio-режим
    if not ARGS.vad:
        sys.stdout.write(json.dumps({"error": "--vad обязателен в stdio-режиме"}) + "\n")
        sys.stdout.flush()
        sys.exit(2)
    load_error = None
    try:
        vad_load(ARGS.vad)
        emit_status("loading-model", model=ARGS.model, device=ARGS.device)
        whisper_load()
    except Exception as e:  # noqa: BLE001 — честный отказ вместо смерти процесса
        load_error = f"{type(e).__name__}: {e}"
        emit_log("error", f"load: {load_error}")

    if load_error:
        # НЕТ честного «ready» после неудачи: статус failed, ping отвечает ready:false,
        # Node-движок падает с ошибкой; перезапуск — через restart-worker
        emit_status("failed", error=load_error)
        SESSION = None
    else:
        SESSION = Session()
        emit_status("ready", model=ARGS.model, device=DEVICE_USED or ARGS.device,
                    computeType=COMPUTE_USED, modelLoadMs=MODEL_LOAD_MS,
                    language=ARGS.language, vad=VAD_KIND)

    t = threading.Thread(target=inference_worker, daemon=True)
    t.start()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            with OUT_LOCK:
                sys.stdout.write(json.dumps({"ok": False, "error": f"bad json: {e}"}) + "\n")
                sys.stdout.flush()
            continue
        resp = handle_request(msg)
        if resp is not None and msg.get("id") is not None:
            resp_out = {"id": msg["id"]}
            resp_out.update(resp)
            emit(resp_out)
        if msg.get("type") == "shutdown":
            break


if __name__ == "__main__":
    main()
