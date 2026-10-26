# Служба распознавания текста на картинках игр (Mimikin, «Перевести картинки»). Только внутренняя сеть Docker:
# сервер библиотеки (api/src/services/pictures.js) присылает картинку — уже расшифрованный PNG, папок игр служба
# не видит — и получает разметку подписей (pipeline.py). Одна картинка за раз: на сервере без видеокарты
# параллельные запросы только мешали бы друг другу и игре.
#   GET  /health   — жива ли, версия разбора
#   POST /analyze  — тело: PNG → { w, h, latin, bilingual, labels: [...] }
#   POST /boxes    — JSON { png: base64, boxes: [[x, y, w, h], …] } → подписи в рамках, обведённых рукой
import base64
import binascii
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image

import pipeline

MODELS = os.environ.get('OCR_MODELS', '/models')
THREADS = int(os.environ.get('OCR_THREADS', '2'))
MAX_BODY = 40 * 1024 * 1024
LOCK = threading.Lock()


class Engine:
    def __init__(self, models, threads):
        from rapidocr import RapidOCR
        from rapidocr.utils.typings import LangDet, LangRec, ModelType, OCRVersion
        self.ocr = RapidOCR(params={
            'Global.log_level': 'error', 'Global.use_cls': False,
            'Det.ocr_version': OCRVersion.PPOCRV6, 'Det.model_type': ModelType.SMALL, 'Det.lang_type': LangDet.CH,
            'Det.model_path': f'{models}/paddle/det.onnx',
            'Rec.ocr_version': OCRVersion.PPOCRV6, 'Rec.model_type': ModelType.SMALL, 'Rec.lang_type': LangRec.JAPAN,
            'Rec.model_path': f'{models}/paddle/rec.onnx',
            'EngineConfig.onnxruntime.intra_op_num_threads': threads,
            'EngineConfig.onnxruntime.inter_op_num_threads': 1,
        })
        # Третий судья (pipeline.resolve) — только распознавание строки, без поиска
        self.has_judge = os.path.exists(f'{models}/paddle/judge.onnx')
        if self.has_judge:
            self.judge_ocr = RapidOCR(params={
                'Global.log_level': 'error', 'Global.use_cls': False,
                'Det.ocr_version': OCRVersion.PPOCRV6, 'Det.model_type': ModelType.SMALL, 'Det.lang_type': LangDet.CH,
                'Det.model_path': f'{models}/paddle/det.onnx',
                'Rec.ocr_version': OCRVersion.PPOCRV5, 'Rec.model_type': ModelType.SERVER, 'Rec.lang_type': LangRec.CH,
                'Rec.model_path': f'{models}/paddle/judge.onnx',
                'EngineConfig.onnxruntime.intra_op_num_threads': threads,
                'EngineConfig.onnxruntime.inter_op_num_threads': 1,
            })
        self.has_manga = os.path.exists(f'{models}/manga/encoder.onnx')
        if self.has_manga:
            from manga import MangaOcr
            self._manga = MangaOcr(f'{models}/manga', threads)

    def detect(self, rgb):
        r = self.ocr(np.ascontiguousarray(rgb[:, :, ::-1]))
        # Ничего не нашлось — RapidOCR отвечает другим видом ответа, без рамок
        if getattr(r, 'boxes', None) is None:
            return []
        return [(np.asarray(b).tolist(), t, float(s)) for b, t, s in zip(r.boxes, r.txts, r.scores)]

    def rec(self, rgb):
        if rgb.size == 0:
            return '', 0.0
        r = self.ocr(np.ascontiguousarray(rgb[:, :, ::-1]), use_det=False, use_cls=False, use_rec=True)
        txts, scores = getattr(r, 'txts', None), getattr(r, 'scores', None)
        return (txts[0], float(scores[0])) if txts else ('', 0.0)

    def judge(self, rgb):
        if not self.has_judge or rgb.size == 0:
            return ''
        r = self.judge_ocr(np.ascontiguousarray(rgb[:, :, ::-1]), use_det=False, use_cls=False, use_rec=True)
        txts = getattr(r, 'txts', None)
        return txts[0] if txts else ''

    def manga(self, rgb):
        return self._manga(Image.fromarray(rgb)) if self.has_manga and rgb.size else ''


ENGINE = None


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BODY:
            raise ValueError('size')
        return self.rfile.read(n)

    def do_GET(self):
        if self.path == '/health':
            return self.reply(200, {'ok': True, 'version': pipeline.VERSION, 'busy': LOCK.locked(), 'manga': ENGINE.has_manga, 'judge': ENGINE.has_judge})
        self.reply(404, {'error': 'not found'})

    def do_POST(self):
        if self.path not in ('/analyze', '/boxes'):
            return self.reply(404, {'error': 'not found'})
        # Сначала — сам запрос: не тот — 422
        try:
            data = self.body()
            if self.path == '/boxes':
                req = json.loads(data)
                boxes = [[int(v) for v in b[:4]] for b in req.get('boxes', [])][:50]
                data = base64.b64decode(req['png'])
        except (ValueError, binascii.Error, KeyError, TypeError) as e:
            return self.reply(422, {'error': 'bad-request', 'message': f'{type(e).__name__}: {str(e)[:200]}'})
        started = time.time()
        try:
            with LOCK:
                out = pipeline.analyze(ENGINE, data) if self.path == '/analyze' else pipeline.read_boxes(ENGINE, data, boxes)
        except pipeline.BadImage as e:
            # Не картинка, испорчена, слишком большая — 422: сервер запомнит «текста нет»
            return self.reply(422, {'error': 'bad-image', 'message': str(e)[:200]})
        except Exception as e:     # сбой самой службы (память, модель, ошибка разбора) — 500: картинку разберут в следующий раз
            return self.reply(500, {'error': type(e).__name__, 'message': str(e)[:200]})
        out['ms'] = int((time.time() - started) * 1000)
        self.reply(200, out)

    def log_message(self, fmt, *args):
        pass


def main():
    global ENGINE
    ENGINE = Engine(MODELS, THREADS)
    port = int(os.environ.get('OCR_PORT', '8000'))
    print(f'[OCR] готова: порт {port}, потоков {THREADS}, manga-ocr {"есть" if ENGINE.has_manga else "нет"}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()


if __name__ == '__main__':
    main()
