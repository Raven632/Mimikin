# Разбор картинки (pipeline.py) без моделей: синтетические «надписи» и распознаватели понарошку.
# Запуск: python -m unittest discover -s ocr -p 'test_*.py' (нужны numpy, pillow, opencv-python-headless)
import base64
import io
import unittest

import cv2
import numpy as np
from PIL import Image

import pipeline as P


def png(arr):
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format='PNG')
    return buf.getvalue()


def letters(w=220, h=60, xs=(20, 50, 80), fill=(255, 255, 255), outline=(30, 30, 30), bg=None):
    """«Буквы»: тёмная обводка, внутри — светлая заливка. bg — непрозрачный фон, иначе прозрачный."""
    img = np.zeros((h, w, 4), np.uint8)
    if bg is not None:
        img[:, :] = (*bg, 255)
    for x in xs:
        cv2.rectangle(img, (x, 15), (x + 18, 45), (*outline, 255), -1)
        cv2.rectangle(img, (x + 4, 19), (x + 14, 41), (*fill, 255), -1)
    return img


def quad(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


class Engine:
    has_manga = True

    def __init__(self, lines, rec=('', 0.0), manga=''):
        self.lines, self._rec, self._manga = lines, rec, manga

    def detect(self, rgb):
        return self.lines

    def rec(self, rgb):
        return self._rec

    def manga(self, rgb):
        return self._manga


def unpatch(label):
    """Заплатка → (новые пиксели, маска «где заменить»)."""
    arr = np.array(Image.open(io.BytesIO(base64.b64decode(label['patch']))).convert('RGBA'))
    h = arr.shape[0] // 2
    return arr[:h], arr[h:, :, 3] > 127


class Choose(unittest.TestCase):
    def test_paddle_is_the_base_manga_fixes_known_confusions(self):
        self.assertEqual(P.choose('きつぷ', 'きっぷ')[0], 'きっぷ')          # маленькая кана
        self.assertEqual(P.choose('攻擊力:', '攻撃力:')[0], '攻撃力:')            # японское начертание
        self.assertEqual(P.choose('为らえ!', 'ねらえ!')[0], 'ねらえ!')            # китайский знак у Paddle
        self.assertEqual(P.choose('ユーに対する', 'ユーキに対する')[0], 'ユーキに対する')  # пропущенный знак в середине
        self.assertEqual(P.choose('オミシュ領', 'アミシュ領')[0], 'オミシュ領')      # прочее — как у Paddle
        self.assertEqual(P.choose('水をあげる', '、水をあげる')[0], '水をあげる')     # лишнее по краям — нет
        self.assertEqual(P.choose('身長', '長身')[0], '身長')                      # знаки не переставляем

    def test_three_readers_vote(self):
        # Даты пиксельного шрифта: у каждого распознавателя свои путаницы, голосование их снимает
        self.assertEqual(P.resolve('1987年10月728', 0.9, '1日87年10月12日', '1987年10月72日', 'x'), ('1987年10月12日', False))
        self.assertEqual(P.resolve('2026年2月258', 0.97, '2012日年2月25日', '2026年2月25日', 'x'), ('2026年2月25日', False))
        self.assertEqual(P.resolve('3000年72月318', 0.9, '3000年12月31日', '3000年12月31日', 'x'), ('3000年12月31日', False))
        # Не сошлись — правдоподобная дата судьи; неправдоподобная — «проверь»
        self.assertEqual(P.resolve('2026年7月715日', 0.9, '2012日年7月15日', '2026年7月15日', 'x'), ('2026年7月15日', False))
        self.assertEqual(P.resolve('2026年7月715日', 0.9, '', '2026年7月715日', 'x'), ('x', True))
        # Двое из трёх совпали (с точностью до похожих знаков) — это и есть надпись
        self.assertEqual(P.resolve('おま8', 0.75, 'おまんこ', 'おまんこ', 'おま8'), ('おまんこ', False))
        self.assertEqual(P.resolve('おわリ!', 0.87, 'おわり。', 'おわり!', 'おわり!'), ('おわり!', False))
        self.assertEqual(P.resolve('マテ', 0.75, 'マテ', 'マデ', 'マテ'), ('マテ', False))
        # Paddle уверен почти наверняка или почти совпал с судьёй — его ответ
        self.assertEqual(P.resolve('通さない←→通す', 0.999, '通さないと、今通す', '通さ通す', '通さない←→通す'), ('通さない←→通す', False))
        self.assertEqual(P.resolve('らすとすぱーと!', 0.9, 'ダすそすばーと!', 'りすとすぱーと!', 'らすとすぱーと!'), ('らすとすぱーと!', False))
        # Все трое разные — «проверь»
        self.assertTrue(P.resolve('媚薬', 0.9, '糞蟷', '媚葉', '媚薬')[1])
        # Paddle и судья буквально совпали — manga-ocr с похожей катаканой их не перебивает
        self.assertEqual(P.resolve('魔力', 0.9, '魔カ', '魔力', P.choose('魔力', '魔カ')[0]), ('魔力', False))
        self.assertEqual(P.choose('入口', '入ロ')[0], '入口')
        # manga-ocr и судья буквально совпали — их ответ, а не Paddle
        self.assertEqual(P.resolve('魔カ', 0.9, '魔力', '魔力', '魔カ'), ('魔力', False))
        # Трое разные, но Paddle уверен почти наверняка — его (manga-ocr на рисунке дописывает своё)
        self.assertEqual(P.resolve('通さないと', 0.98, '通さないと、今通す', '通さなレ', '通さないと'), ('通さないと', False))
        # Настоящая «7»: судья читает «7» — уверенно «7»; судья против голосования — его ответ, но «проверь»
        self.assertEqual(P.resolve('2026年7月5日', 0.9, '2026年1月5日', '2026年7月5日', 'x'), ('2026年7月5日', False))
        self.assertEqual(P.resolve('1892年8月5日', 0.95, '1日目2年8月5日', '1992年8月5日', 'x'), ('1992年8月5日', True))
        self.assertEqual(P.resolve('2026年1月5日', 0.9, '2026年1月5日', '2026年7月5日', 'x'), ('2026年7月5日', True))
        # Не даты: «3年», «10月» — даты; «1年目» — нет
        self.assertTrue(P.plausible_date('3年') and P.plausible_date('10月'))
        self.assertEqual(P.resolve('1年目', 0.9, '1年目', '', 'x'), ('1年目', False))

    def test_merge_does_not_take_digits_from_manga(self):
        self.assertEqual(P.choose('2026年2月258', '2012日年2月25日')[0][:5], '2026年')

    def test_disagreement_is_unsure(self):
        text, unsure, share = P.choose('足', 'それは、')
        self.assertTrue(unsure)
        self.assertEqual(share, 0.0)
        self.assertEqual(P.choose('ラベル', '')[1:], (False, 1.0))


class Analyze(unittest.TestCase):
    def test_outlined_label_on_transparent_layer(self):
        img = letters()
        out = P.analyze(Engine([(quad(16, 12, 104, 48), 'ラベル', 0.98)], manga='ラベル'), png(img))
        self.assertEqual(len(out['labels']), 1)
        lab = out['labels'][0]
        self.assertEqual(lab['text'], 'ラベル')
        self.assertFalse(lab['unsure'])
        self.assertGreater(P.lum([int(lab['color'][i:i + 2], 16) for i in (1, 3, 5)]), 200)
        self.assertIsNotNone(lab['outline'])
        self.assertLess(P.lum([int(lab['outline'][i:i + 2], 16) for i in (1, 3, 5)]), 100)
        self.assertGreaterEqual(lab['outlineWidth'], 2)
        self.assertTrue(lab['bold'])
        # Заплатка стирает буквы (прозрачно) — и только их
        new, marks = unpatch(lab)
        px, py, pw, ph = lab['patchBox']
        letter = img[py:py + ph, px:px + pw, 3] > 0
        self.assertTrue(marks[letter].all())
        self.assertTrue((new[marks][:, 3] == 0).all())

    def test_flat_background_is_filled_with_its_colour(self):
        img = letters(bg=(20, 30, 90))
        lab = P.analyze(Engine([(quad(16, 12, 104, 48), 'ラベル', 0.98)], manga='ラベル'), png(img))['labels'][0]
        new, marks = unpatch(lab)
        self.assertTrue(np.abs(new[marks][:, :3].astype(int) - [20, 30, 90]).max() <= 2)
        self.assertTrue((new[marks][:, 3] == 255).all())

    def test_blobs_of_art_are_not_labels(self):
        img = letters()
        # Paddle видит один «знак» — пятно рисунка
        self.assertEqual(P.analyze(Engine([(quad(16, 12, 104, 48), '足', 0.9)], manga='それは、'), png(img))['labels'], [])
        # Ответы не сходятся, а «надпись» пёстрая — рисунок
        art = np.zeros((60, 220, 4), np.uint8)
        art[10:50, 10:110] = np.random.default_rng(1).integers(0, 255, (40, 100, 4), dtype=np.uint8) | np.array([0, 0, 0, 255], np.uint8)
        self.assertEqual(P.analyze(Engine([(quad(10, 10, 110, 50), '日酒', 0.95)], manga='この'), png(art))['labels'], [])
        # Наклонённая надпись (анимация) — тоже нет
        tilted = [[16, 12], [104, 30], [100, 60], [12, 42]]
        self.assertEqual(P.analyze(Engine([(tilted, 'ラベル', 0.99)], manga='ラベル'), png(img))['labels'], [])

    def test_translated_picture_is_bilingual(self):
        img = letters()
        lines = [(quad(16, 12, 104, 48), 'ラベル', 0.98), (quad(16, 12, 104, 48), 'This is a label', 0.98),
                 (quad(16, 12, 104, 48), 'Another line here', 0.98)]
        self.assertTrue(P.analyze(Engine(lines, manga='ラベル'), png(img))['bilingual'])

    def test_two_labels_in_one_box_are_split(self):
        img = letters(w=320, xs=(20, 50, 200, 230))
        out = P.analyze(Engine([(quad(16, 12, 252, 48), 'リナ　攻撃', 0.95)], rec=('リナ', 0.99), manga='リナ'), png(img))
        self.assertEqual(len(out['labels']), 2)
        self.assertLess(out['labels'][0]['x'] + out['labels'][0]['w'], out['labels'][1]['x'])

    def test_box_drawn_by_hand_is_read_even_if_short(self):
        img = letters()
        out = P.read_boxes(Engine([], rec=('ラ', 0.6), manga='ラ'), png(img), [[16, 12, 30, 36], [500, 500, 10, 10]])
        self.assertEqual(len(out['labels']), 1, 'рамка за пределами картинки — мимо')
        self.assertEqual(out['labels'][0]['text'], 'ラ')

    def test_huge_or_broken_picture_is_bad_image(self):
        with self.assertRaises(P.BadImage):
            P.decode(png(np.zeros((6000, 5000, 4), np.uint8)))
        with self.assertRaises(P.BadImage):
            P.decode(b'not a picture')
        with self.assertRaises(P.BadImage):
            P.decode(png(letters())[:200])          # обрезанный PNG

    def test_vertical_columns_are_one_label(self):
        img = np.zeros((220, 200, 4), np.uint8)
        for x in (120, 70):                        # два столбца «букв»: правый читается первым
            for y in range(20, 180, 32):
                cv2.rectangle(img, (x, y), (x + 24, y + 24), (30, 30, 30, 255), -1)
                cv2.rectangle(img, (x + 4, y + 4), (x + 20, y + 20), (255, 255, 255, 255), -1)
        eng = Engine([(quad(116, 16, 148, 184), 'トイレは', 0.97), (quad(66, 16, 98, 184), 'キレイに', 0.97)])
        eng.has_manga = False
        labels = P.analyze(eng, png(img))['labels']
        self.assertEqual([lab['text'] for lab in labels], ['トイレはキレイに'])
        lab = labels[0]
        self.assertTrue(lab['vertical'])
        self.assertTrue(lab['unsure'], 'без третьего судьи вертикаль — на проверку')
        eng.has_judge = True
        shapes = []
        eng.judge = lambda rgb: shapes.append(rgb.shape) or ''
        self.assertFalse(P.analyze(eng, png(img))['labels'][0]['unsure'], 'с судьёй — уверенно')
        self.assertTrue(shapes and all(w > h for h, w, *_ in shapes), f'судье — повёрнутый столбец: {shapes}')
        self.assertEqual(lab['align'], 'center')
        self.assertLess(lab['size'], 40, 'размер — по одному столбцу')

    def test_labels_of_one_kind_share_boldness(self):
        labels = [{'color': '#ffffff', 'outline': '#202020', 'bold': b} for b in (True, True, False)]
        P.harmonize(labels)
        self.assertEqual([lab['bold'] for lab in labels], [True, True, True])


if __name__ == '__main__':
    unittest.main()
