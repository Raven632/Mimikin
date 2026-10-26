# Модели для службы распознавания — при сборке образа, с проверкой SHA256 (подменённый файл сборку остановит).
# PaddleOCR v6 small (поиск и чтение строк, Apache-2.0) — те же файлы и хэши, что в rapidocr 3.10.0.
# manga-ocr (kha-white/manga-ocr-base, Apache-2.0) в ONNX — mayocream/manga-ocr-onnx на закреплённой версии;
# сжимаем в int8: 440 МБ → 111 МБ, а читает так же (19 из 19 подписей эталона в пробе 2026-10-08)
import hashlib
import http.client
import os
import sys
import time
import urllib.request

PADDLE = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6'
MANGA = 'https://huggingface.co/mayocream/manga-ocr-onnx/resolve/24b12778d85800835e2ca409236de281b8ab7b9f'
FILES = [
    (f'{PADDLE}/det/PP-OCRv6_det_small.onnx', 'paddle/det.onnx', '090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f'),
    (f'{PADDLE}/rec/PP-OCRv6_rec_small.onnx', 'paddle/rec.onnx', '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884'),
    # «Третий судья» для спорных подписей: PP-OCRv5 server читает цифры пиксельных шрифтов лучше всех (проба 2026-10-08:
    # 72 даты из 77 на карточках персонажей — сам, остальные сходятся голосованием), но медленнее — зовём его только
    # там, где двое первых не сошлись
    (f'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_server.onnx', 'paddle/judge.onnx',
     'e09385400eaaaef34ceff54aeb7c4f0f1fe014c27fa8b9905d4709b65746562a'),
    (f'{MANGA}/encoder_model.onnx', 'manga/encoder.fp32.onnx', '15fa8155fe9bc1a7d25d9bb353debaa4def033d0174e907dbd2dd6d995def85f'),
    (f'{MANGA}/decoder_model.onnx', 'manga/decoder.fp32.onnx', 'ef7765261e9d1cdc34d89356986c2bbc2a082897f753a89605ae80fdfa61f5e8'),
    (f'{MANGA}/vocab.txt', 'manga/vocab.txt', '5cb5c5586d98a2f331d9f8828e4586479b0611bfba5d8c3b6dadffc84d6a36a3'),
]


def fetch(url, dest, sha):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    h = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=120) as r, open(dest + '.part', 'wb') as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            f.write(chunk)
    if h.hexdigest() != sha:
        os.remove(dest + '.part')
        sys.exit(f'{url}: SHA256 {h.hexdigest()} ≠ {sha}')
    os.replace(dest + '.part', dest)


# Сайт моделей рвёт соединение (RemoteDisconnected 2026-10-20 — выкатка откатилась целиком): ещё попытки с паузой.
# Неверный хэш не повторяем — sys.exit выходит сразу
def fetch_retry(url, dest, sha, tries=4):
    for n in range(1, tries + 1):
        try:
            return fetch(url, dest, sha)
        # Обрыв посреди файла — IncompleteRead (HTTPException), а не OSError
        except (OSError, http.client.HTTPException) as e:
            if n == tries:
                raise
            print(f'retry {n} {url}: {e}', flush=True)
            time.sleep(10 * n)


def main(root):
    for url, name, sha in FILES:
        fetch_retry(url, os.path.join(root, name), sha)
        print('ok', name, flush=True)
    from onnxruntime.quantization import QuantType, quantize_dynamic
    for part in ('encoder', 'decoder'):
        src = os.path.join(root, 'manga', f'{part}.fp32.onnx')
        quantize_dynamic(src, os.path.join(root, 'manga', f'{part}.onnx'), weight_type=QuantType.QUInt8)
        os.remove(src)
        print('int8', part, flush=True)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '/models')
