# manga-ocr (kha-white/manga-ocr-base, Apache-2.0) в ONNX — без PyTorch: кодировщик картинки и декодер знаков,
# декодер идёт по одному знаку (жадно). Японский читает лучше PaddleOCR: маленькая кана («っ», «ェ»), стилизованные
# шрифты игр. Но на длинной строке он начинает выдумывать — поэтому только для коротких подписей (pipeline.py)
import re
import unicodedata

import numpy as np
import onnxruntime as ort
from PIL import Image

START, END, SPECIAL = 2, 3, 4      # [CLS] — начало, [SEP] — конец; до 4 — служебные ([PAD], [UNK], [MASK])


class MangaOcr:
    def __init__(self, folder, threads=2):
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        self.enc = ort.InferenceSession(f'{folder}/encoder.onnx', so, providers=['CPUExecutionProvider'])
        self.dec = ort.InferenceSession(f'{folder}/decoder.onnx', so, providers=['CPUExecutionProvider'])
        self.enc_input = self.enc.get_inputs()[0].name
        self.dec_inputs = {i.name for i in self.dec.get_inputs()}
        with open(f'{folder}/vocab.txt', encoding='utf-8') as f:
            self.vocab = [line.rstrip('\n') for line in f]

    def __call__(self, img, max_len=48):
        # Как у manga-ocr: серый, 224×224, значения в [-1, 1]
        x = img.convert('L').convert('RGB').resize((224, 224), Image.BILINEAR)
        a = ((np.asarray(x, dtype=np.float32) / 255.0 - 0.5) / 0.5).transpose(2, 0, 1)[None]
        hidden = self.enc.run(None, {self.enc_input: a})[0]
        ids = [START]
        for _ in range(max_len):
            feed = {'input_ids': np.array([ids], dtype=np.int64), 'encoder_hidden_states': hidden}
            if 'encoder_attention_mask' in self.dec_inputs:
                feed['encoder_attention_mask'] = np.ones(hidden.shape[:2], dtype=np.int64)
            logits = self.dec.run(None, feed)[0][0, -1]
            # no_repeat_ngram_size=3, как в настройках модели: тройка знаков не повторяется — без зацикливания
            if len(ids) >= 3:
                tail = tuple(ids[-2:])
                for i in range(len(ids) - 2):
                    if tuple(ids[i:i + 2]) == tail:
                        logits[ids[i + 2]] = -1e9
            nxt = int(np.argmax(logits))
            if nxt == END:
                break
            ids.append(nxt)
        text = ''.join(self.vocab[i] for i in ids[1:] if i > SPECIAL).replace('##', '')
        text = re.sub('[・.]{2,}', lambda m: '.' * (m.end() - m.start()), text.replace('…', '...'))
        return unicodedata.normalize('NFKC', text)
