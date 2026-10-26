# Текст на картинке игры: где он, что написано, как нарисован (цвет, обводка, размер, жирность, сколько места
# справа и слева) и как его стереть. Перевод рисует сама игра (rpg-fixes.js, relabel) — отсюда только разметка
# и «заплатка»: какие пиксели картинки заменить, чтобы надписи не стало.
#
# Найти и прочитать — PaddleOCR v6 (RapidOCR, ONNX). Короткие подписи читает ещё и manga-ocr: маленькую кану и
# игровые шрифты он читает лучше. Ответы сверяются (choose): тот же набор знаков в другом порядке — порядок
# Paddle (он читает слева направо и знаки не переставляет); близкие — manga-ocr; разные — «проверь» (unsure).
# Подпись из одного знака не берём: в рисунке PaddleOCR то и дело «видит» иероглиф («口», «人»).
#
# Заплатка — картинка вдвое выше места надписи: сверху новые пиксели, снизу маска (непрозрачно — заменить).
# Заменяются только пиксели самой надписи, поэтому соседние заплатки друг другу не мешают
import base64
import io
import re
import unicodedata
from collections import Counter
from difflib import SequenceMatcher

import cv2
import numpy as np
from PIL import Image

VERSION = 5                     # растёт, когда меняется разбор: сервер библиотеки пересчитает старые картинки
CJK = re.compile(r'[぀-ヿ㐀-鿿ｦ-ﾟ]')
LATIN_WORD = re.compile(r'[A-Za-z]{2,}')
PUNCT = re.compile(r'[\s\W_]+', re.UNICODE)
GRAY = 110                      # фон под прозрачной картинкой для поиска: на сером видны и белые, и чёрные буквы
MAX_ANGLE = 8                   # наклонённую надпись (анимация, «влетающий» заголовок) не трогаем
SHORT = 12                      # до стольких знаков — «короткая подпись»: её читает и manga-ocr


def nf(s):
    return unicodedata.normalize('NFKC', s or '').strip()


def core(s):
    return PUNCT.sub('', nf(s))


MAX_PIXELS = 25_000_000           # больше — не разбираем: в памяти картинка занимает в разы больше файла


class BadImage(Exception):
    """Не картинка, испорчена или слишком большая — разбирать нечего (а не сбой самой службы)."""


def decode(data):
    try:
        im = Image.open(io.BytesIO(data))
        if im.size[0] * im.size[1] > MAX_PIXELS:
            raise BadImage('picture too large')
        im.load()
        return np.array(im.convert('RGBA'))
    except BadImage:
        raise
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as e:
        raise BadImage(f'{type(e).__name__}: {e}') from e


def on_gray(rgba):
    a = rgba[:, :, 3:4].astype(np.float32) / 255
    return (rgba[:, :, :3].astype(np.float32) * a + GRAY * (1 - a)).astype(np.uint8)


def png_b64(arr):
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format='PNG', optimize=True)
    return base64.b64encode(buf.getvalue()).decode('ascii')


def hex_color(c):
    return '#%02x%02x%02x' % tuple(int(round(v)) for v in c[:3])


def lum(c):
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def agreement(a, b):
    """Доля общих знаков двух ответов (0…1)."""
    a, b = nf(a).replace(' ', ''), nf(b).replace(' ', '')
    if not a or not b:
        return 0.0
    return sum((Counter(a) & Counter(b)).values()) / max(len(a), len(b))


# Маленькая и большая кана, китайское и японское начертание — то, что Paddle путает, а manga-ocr читает верно
FOLD = str.maketrans({**dict(zip('ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ', 'あいうえおつやゆよわアイウエオツヤユヨワカケ')),
                      **dict(zip('擊戰鬥體經驗圖劍惡氣狀數裝賣單擇畫聲戀亂絕對應號從來關', '撃戦闘体経験図剣悪気状数装売単択画声恋乱絶対応号従来関'))})


# Только для сравнения ответов: знаки, которые распознавание путает между собой (катакана и хирагана, катакана и
# иероглиф одного вида), — один знак. В текст подписи эта замена не попадает
LOOKALIKE = str.maketrans({'リ': 'り', 'ヘ': 'へ', 'ベ': 'べ', 'ペ': 'ぺ', '口': 'ロ', '工': 'エ', '二': 'ニ', '一': 'ー', '夕': 'タ',
                           '卜': 'ト', '八': 'ハ', '力': 'カ'})
# При слиянии manga-ocr может поправить только кану (リ/り): иероглиф или катакану вида «力/カ», «口/ロ» — нет, там
# прав бывает и Paddle («魔力»)
KANA_LOOK = str.maketrans({'リ': 'り', 'ヘ': 'へ', 'ベ': 'べ', 'ペ': 'ぺ'})


def same(a, b):
    """Ответы совпадают с точностью до размера каны, начертания, похожих знаков и пробелов."""
    key = lambda s: nf(s).replace(' ', '').translate(FOLD).translate(LOOKALIKE).rstrip('。.!！')
    return bool(a) and bool(b) and key(a) == key(b)


def japanese(c):
    """Знак есть в японской кодировке: «为» (китайское упрощённое) — нет."""
    try:
        c.encode('cp932')
        return True
    except UnicodeEncodeError:
        return False


def confusable(x, y):
    """Знак Paddle x против знака manga-ocr y — из тех путаниц, где прав manga-ocr."""
    return (x == y or x.translate(FOLD) == y.translate(FOLD) or x.translate(KANA_LOOK) == y.translate(KANA_LOOK)
            or bool(CJK.match(x) and not japanese(x)))


def choose(paddle, manga, short=True):
    """Текст подписи из двух ответов → (текст, сомнение, согласие). Основа — Paddle: он читает слева направо и
    знаки не выдумывает, а manga-ocr на рисунке «дочитывает» лишнее («アミシュ» вместо «オミシュ», «、» в начале).
    От manga-ocr берём только то, в чём он сильнее: маленькую кану («きっぷ»), японское начертание («攻撃»),
    японский знак вместо китайского («ね» вместо «为») и знак, пропущенный Paddle в середине («ユー[キ]に»)."""
    p, m = nf(paddle), nf(manga)
    if not m:
        return p, False, 1.0
    if not p:
        return m, True, 0.0
    share = agreement(p, m)
    out = []
    for tag, i1, i2, j1, j2 in SequenceMatcher(None, p, m, autojunk=False).get_opcodes():
        if tag == 'equal' or tag == 'delete':
            out.append(p[i1:i2])
        elif tag == 'replace':
            # Знак за знаком: известная путаница — знак manga-ocr, остальное — Paddle («おわリ!» + «おわり。» → «おわり!»)
            if i2 - i1 == j2 - j1:
                out.append(''.join(y if confusable(x, y) else x for x, y in zip(p[i1:i2], m[j1:j2])))
            else:
                out.append(p[i1:i2])
        elif tag == 'insert' and 0 < i1 < len(p) and j2 - j1 <= 2 and not re.search(r'[\d年月日]', m[j1:j2]):
            # Пропущенный Paddle знак — но не цифру: цифры пиксельных шрифтов manga-ocr читает хуже («2012日年»)
            out.append(m[j1:j2])
    return ''.join(out), share < 0.75, share


# Даты пиксельных шрифтов: Paddle читает «1» как «7» и последний «日» как «8», manga-ocr — «9» и «0» как «日».
# Каждый ответ даёт варианты с этими заменами; из правдоподобных дат берём ту, за которую больше ответов
DATE_ONLY = re.compile(r'[\d年月日]+')
DATE = re.compile(r'(?:(\d{1,4})年)?(?:(\d{1,2})月)?(?:(\d{1,2})日)?')


def plausible_date(t):
    m = DATE.fullmatch(t)
    if not m or not any(m.groups()):
        return False
    y, mo, d = m.groups()
    return (not y or 1 <= int(y) <= 9999) and (not mo or 1 <= int(mo) <= 12) and (not d or 1 <= int(d) <= 31)


def date_variants(text, limit=3):
    """(вариант, число замен): «7»→«1», «日» внутри числа → «9» или «0», «8» в конце после цифры → «日»."""
    t = nf(text).replace(' ', '')
    spots = []
    for i, c in enumerate(t):
        if c == '7':
            spots.append((i, ['1']))
        elif c == '日' and i + 1 < len(t) and (t[i + 1].isdigit() or t[i + 1] in '年月日'):
            spots.append((i, ['9', '0']))
        elif c == '8' and i == len(t) - 1 and i > 0 and t[i - 1].isdigit():
            spots.append((i, ['日']))
    out = {t: 0}
    def walk(k, cur, cost):
        if cost > limit or k == len(spots):
            if cost <= limit:
                v = ''.join(cur)
                out[v] = min(out.get(v, cost), cost)
            return
        walk(k + 1, cur, cost)
        i, opts = spots[k]
        for o in opts:
            nxt = list(cur)
            nxt[i] = o
            walk(k + 1, nxt, cost + 1)
    if len(spots) <= 8:
        walk(0, list(t), 0)
    return out


def resolve(paddle, score, manga, judge, merged):
    """Текст подписи по трём ответам: Paddle, manga-ocr и третий судья (PP-OCRv5 server). → (текст, сомнение).
    merged — слияние первых двух (choose): его берём, когда судья не помог."""
    readings = [(x, who) for x, who in ((paddle, 'p'), (manga, 'm'), (judge, 'j')) if x]
    if any(DATE_ONLY.fullmatch(nf(x).replace(' ', '')) and re.search(r'\d', x) and re.search('[年月]', x) for x, _ in readings):
        votes = {}
        for text, who in readings:
            for v, cost in date_variants(text).items():
                if plausible_date(v):
                    slot = votes.setdefault(v, [set(), 0])
                    if who not in slot[0]:
                        slot[0].add(who)
                        slot[1] += cost
        # Судья читает цифры надёжнее всех (проба: из его правдоподобных дат неверных не было). Его правдоподобная дата
        # — решающая: кто-то прочитал так же буквально или она победила в голосовании — уверенно; иначе его ответ,
        # но «проверь» (реальная «7» против двух «1»)
        j = nf(judge).replace(' ', '') if judge else ''
        best = max(votes.items(), key=lambda kv: (len(kv[1][0]), -kv[1][1]))[0] if votes else None
        if j and plausible_date(j):
            literal = {nf(x).replace(' ', '') for x, who in readings if who != 'j'}
            return j, not (j in literal or j == best)
        if best and len(votes[best][0]) >= 2:
            return best, False
        return merged, True
    # Двое из трёх ответили буквально одно и то же — это и есть надпись
    for a, b in ((judge, paddle), (manga, paddle), (judge, manga)):
        if a and b and nf(a).replace(' ', '') == nf(b).replace(' ', ''):
            return nf(a), False
    # Совпали с точностью до похожих знаков — слияние, если оно с ними сходится, иначе ответ manga-ocr (японские
    # знаки он читает точнее)
    for a, b, pick in ((judge, manga, manga), (judge, paddle, paddle), (manga, paddle, manga)):
        if same(a, b):
            return (merged if same(merged, a) else nf(pick)), False
    # Paddle уверен почти наверняка — manga-ocr на рисунке дописывает своё («通さないと、今通す»)
    if score >= 0.97 and paddle:
        return merged, False
    # Paddle почти совпал с судьёй (разница в знак) и уверен — его ответ
    if paddle and judge and agreement(paddle, judge) >= 0.85 and score >= 0.85:
        return merged if same(merged, paddle) else nf(paddle), False
    return merged, True


def angle(poly):
    (x0, y0), (x1, y1) = poly[0], poly[1]
    return float(np.degrees(np.arctan2(y1 - y0, x1 - x0)))


def clip_box(x0, y0, x1, y1, W, H):
    return max(0, int(x0)), max(0, int(y0)), min(W, int(x1)), min(H, int(y1))


def ring(rgba, box, others, inner, band):
    """Пиксели вокруг надписи (полоса шириной band за отступом inner), без других надписей."""
    H, W = rgba.shape[:2]
    x, y, w, h = box
    X0, Y0, X1, Y1 = clip_box(x - inner - band, y - inner - band, x + w + inner + band, y + h + inner + band, W, H)
    keep = np.ones((Y1 - Y0, X1 - X0), bool)
    ix0, iy0, ix1, iy1 = clip_box(x - inner, y - inner, x + w + inner, y + h + inner, W, H)
    keep[iy0 - Y0:iy1 - Y0, ix0 - X0:ix1 - X0] = False
    for ox, oy, ow, oh in others:
        a0, b0, a1, b1 = clip_box(ox - 2, oy - 2, ox + ow + 2, oy + oh + 2, W, H)
        a0, b0, a1, b1 = max(a0, X0), max(b0, Y0), min(a1, X1), min(b1, Y1)
        if a1 > a0 and b1 > b0:
            keep[b0 - Y0:b1 - Y0, a0 - X0:a1 - X0] = False
    return rgba[Y0:Y1, X0:X1][keep]


def centers_of(colors, k=3):
    colors = colors.astype(np.float32)
    k = max(1, min(k, len(colors)))
    if len(colors) < 2:
        return colors if len(colors) else np.array([[GRAY, GRAY, GRAY]], np.float32)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    _, _, c = cv2.kmeans(colors, k, None, crit, 2, cv2.KMEANS_PP_CENTERS)
    return c


def dist_to(px, centers):
    """Расстояние каждого пикселя (N×3) до ближайшего цвета фона — сумма по каналам."""
    return np.abs(px[:, None, :3].astype(np.float32) - centers[None]).sum(axis=2).min(axis=1)


class Background:
    """Фон вокруг надписи: прозрачный (надпись на отдельном слое) или цвета (k-средних по кольцу)."""

    def __init__(self, rgba, box, others):
        h = box[3]
        self.inner = max(2, h // 8)
        px = ring(rgba, box, others, self.inner + 1, max(4, h // 4))
        if len(px) < 8:
            px = ring(rgba, box, [], self.inner + 1, max(4, h // 4))
        self.transparent = len(px) > 0 and float((px[:, 3] < 16).mean()) >= 0.5
        opaque = px[px[:, 3] >= 16] if len(px) else px
        self.alpha = int(np.median(opaque[:, 3])) if len(opaque) else 255
        self.centers = centers_of(opaque[:, :3]) if len(opaque) else np.array([[GRAY] * 3], np.float32)
        spread = dist_to(opaque[:, :3], self.centers) if len(opaque) else np.zeros(1)
        self.spread = float(spread.mean()) if len(spread) else 0.0
        self.threshold = max(60.0, self.spread * 3)
        # Подложка прямо под надписью (подсвеченная строка меню, плашка на прозрачной картинке) другая, чем фон
        # вокруг, — тогда фон она: края рамки надписи (в отступе букв нет)
        H, W = rgba.shape[:2]
        x, y, w, h = box
        x0, y0, x1, y1 = clip_box(x - self.inner, y - self.inner, x + w + self.inner, y + h + self.inner, W, H)
        region = rgba[y0:y1, x0:x1]
        if region.shape[0] >= 3 and region.shape[1] >= 3:
            edge = np.concatenate([region[0], region[-1], region[1:-1, 0], region[1:-1, -1]])
            solid_edge = edge[edge[:, 3] >= 16]
            if len(solid_edge) >= 0.6 * len(edge) and len(solid_edge) >= 8:
                far = dist_to(solid_edge[:, :3], self.centers) > self.threshold if len(opaque) else np.ones(len(solid_edge), bool)
                if self.transparent or float(far.mean()) > 0.6:
                    opaque = solid_edge
                    self.transparent = False
                    self.alpha = int(np.median(opaque[:, 3]))
                    self.centers = centers_of(opaque[:, :3])
                    spread = dist_to(opaque[:, :3], self.centers)
                    self.spread = float(spread.mean())
                    self.threshold = max(60.0, self.spread * 3)
        # Главный цвет фона — самый частый из центров
        if len(opaque):
            near = np.abs(opaque[:, None, :3].astype(np.float32) - self.centers[None]).sum(axis=2).argmin(axis=1)
            self.main = self.centers[np.bincount(near, minlength=len(self.centers)).argmax()]
        else:
            self.main = self.centers[0]

    def text(self, region):
        """Пиксели надписи в куске картинки: заливка и обводка, без фона."""
        if self.transparent:
            return region[:, :, 3] > 16
        d = np.abs(region[:, :, None, :3].astype(np.float32) - self.centers[None, None]).sum(axis=3).min(axis=2)
        return (d > self.threshold) & (region[:, :, 3] > 16)


def clean(mask, inner_box):
    """Без соринок: пятна меньше трёх пикселей и пятна только в отступе, не в самой рамке надписи."""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    x0, y0, x1, y1 = inner_box
    keep = np.zeros(n, bool)
    for i in range(1, n):
        sx, sy, sw, sh, area = stats[i]
        if area >= 3 and sx < x1 and sx + sw > x0 and sy < y1 and sy + sh > y0:
            keep[i] = True
    return keep[lab]


def style(region, mask, bg):
    """Цвет заливки и обводки, толщина обводки, жирность, размер шрифта — по пикселям надписи."""
    ys, xs = np.nonzero(mask)
    gy0, gy1, gx0, gx1 = int(ys.min()), int(ys.max()) + 1, int(xs.min()), int(xs.max()) + 1
    gh = gy1 - gy0
    m8 = mask.astype(np.uint8)
    dt = cv2.distanceTransform(m8, cv2.DIST_L2, 3)
    solid = mask & (region[:, :, 3] >= 200)
    if solid.sum() < 5:
        solid = mask
    px = region[:, :, :3][solid].astype(np.float32)
    out = {'outline': None, 'outlineWidth': 0}
    fill_mask = solid
    if len(px) >= 12:
        crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
        _, labels, centers = cv2.kmeans(px, 2, None, crit, 2, cv2.KMEANS_PP_CENTERS)
        labels = labels.ravel()
        dts = dt[solid]
        mean_dt = [float(dts[labels == i].mean()) if (labels == i).any() else 0.0 for i in (0, 1)]
        fi = 0 if mean_dt[0] >= mean_dt[1] else 1
        fill, edge = centers[fi], centers[1 - fi]
        edge_share = float((labels == 1 - fi).mean())
        # Обводка — другой цвет снаружи заливки. У мелких букв она почти той же толщины, что и штрих, поэтому
        # «снаружи» — просто ближе к краю в среднем
        outline = abs(lum(fill) - lum(edge)) >= 60 and 0.1 <= edge_share <= 0.9 and mean_dt[1 - fi] < mean_dt[fi]
        if outline and not bg.transparent:
            # Сглаживание края на однотонном фоне — смесь буквы и фона, а не обводка: цвет лежит между ними
            a, b = fill, bg.main
            t = np.clip(np.dot(edge - a, b - a) / max(1.0, float(np.dot(b - a, b - a))), 0, 1)
            if np.abs(a + t * (b - a) - edge).sum() < 45:
                outline = False
        if outline:
            fill_mask = np.zeros_like(mask)
            fill_mask[solid] = labels == fi
            # Толщина обводки — от края заливки до края непрозрачной части (мягкая тень снаружи не считается).
            # У движка обводка рисуется по краю буквы — наполовину внутрь, поэтому его outlineWidth вдвое больше
            sdt = cv2.distanceTransform(solid.astype(np.uint8), cv2.DIST_L2, 3)
            inner = fill_mask & ~cv2.erode(fill_mask.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
            width = float(np.median(sdt[inner])) if inner.any() else 1.5
            out['outline'] = hex_color(edge)
            out['outlineWidth'] = int(min(10, max(2, round(width * 2))))
        else:
            fill = centers[0] if (labels == 0).mean() >= 0.5 else centers[1]
    else:
        fill = np.median(px, axis=0) if len(px) else np.array([255, 255, 255])
    out['color'] = hex_color(fill)
    # Толщина штриха заливки к высоте букв: у жирного японского шрифта ≈ 0.12–0.16, у обычного ≈ 0.07–0.09
    fdt = cv2.distanceTransform(fill_mask.astype(np.uint8), cv2.DIST_L2, 3)
    stroke = 2 * float(np.percentile(fdt[fill_mask], 90)) if fill_mask.any() else 0.0
    out['bold'] = gh > 0 and stroke / gh > 0.12
    # Японская буква занимает ≈ 0.88 высоты шрифта. Высота — по непрозрачной части, без тени; обводку снаружи
    # (половина outlineWidth с каждой стороны) не считаем
    sy = np.nonzero(solid.any(axis=1))[0]
    sh = int(sy.max() - sy.min() + 1) if len(sy) else gh
    out['size'] = int(max(8, round((sh - out['outlineWidth']) / 0.88)))
    return out, (gx0, gy0, gx1, gy1)


def colorfulness(region, mask):
    """Насколько пёстрые пиксели надписи: средний разброс каналов (серое — 0, яркий цвет — 100 и больше)."""
    px = region[:, :, :3][mask & (region[:, :, 3] >= 200)].astype(np.int16)
    if len(px) < 5:
        return 0.0
    return float((px.max(axis=1) - px.min(axis=1)).mean())


def free_space(rgba, bg, glyph, others):
    """Свободное место слева и справа от надписи на её строке (пикселей): туда можно писать перевод длиннее."""
    H, W = rgba.shape[:2]
    gx0, gy0, gx1, gy1 = glyph
    band = rgba[gy0:gy1]
    if bg.transparent:
        blocked = (band[:, :, 3] > 16).any(axis=0)
    else:
        d = np.abs(band[:, :, None, :3].astype(np.float32) - bg.centers[None, None]).sum(axis=3).min(axis=2)
        blocked = ((d > bg.threshold) & (band[:, :, 3] > 16)).any(axis=0)
    for ox, oy, ow, oh in others:
        if oy < gy1 and oy + oh > gy0:
            blocked[max(0, ox - 2):min(W, ox + ow + 2)] = True
    right = 0
    for x in range(gx1, W):
        if blocked[x]:
            break
        right += 1
    left = 0
    for x in range(gx0 - 1, -1, -1):
        if blocked[x]:
            break
        left += 1
    return left, right


def layout(left, right, gw, W, glyph):
    """Выравнивание и наибольшая ширина перевода."""
    gx0, _, gx1, _ = glyph
    edge_l, edge_r = left >= gx0, right >= W - gx1          # свободно до самого края картинки
    big = max(left, right, 1)
    centered = (left >= 0.3 * gw and right >= 0.3 * gw and abs(left - right) <= 0.3 * big + 4 and not (edge_l and edge_r))
    if centered:
        return 'center', int(min(gw * 3, gw + 2 * min(left, right) - 12))
    return 'left', int(max(gw, min(gw * 3, gw + right - 6)))


def patch(region, mask, bg, outline):
    """Заплатка: сверху — новые пиксели, снизу — где заменить."""
    md = cv2.dilate(mask.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=2 if outline else 1)
    sel = md.astype(bool)
    new = region.copy()
    if bg.transparent:
        new[sel] = 0
    elif bg.spread < 8:
        new[sel, :3] = np.clip(bg.main, 0, 255).astype(np.uint8)
        new[sel, 3] = bg.alpha
    else:
        bgr = np.ascontiguousarray(region[:, :, 2::-1])
        painted = cv2.inpaint(bgr, md, 5, cv2.INPAINT_TELEA)[:, :, ::-1]
        new[sel, :3] = painted[sel]
        new[sel, 3] = bg.alpha
    marks = np.zeros_like(region)
    marks[sel] = 255
    return png_b64(np.concatenate([new, marks], axis=0))


def gaps(mask, min_gap):
    """Части строки, разделённые пустыми столбцами шире min_gap: две подписи, которые поиск слил в одну."""
    cols = mask.any(axis=0)
    xs = np.nonzero(cols)[0]
    if len(xs) == 0:
        return []
    parts, start, last = [], xs[0], xs[0]
    for x in xs[1:]:
        if x - last - 1 >= min_gap:
            parts.append((start, last + 1))
            start = x
        last = x
    parts.append((start, last + 1))
    return parts


def label_of(rgba, box, others, engine, paddle=None, score=1.0, manual=False, fixed_text=None):
    """Одна подпись: текст, стиль, место, заплатка. None — надписи нет."""
    H, W = rgba.shape[:2]
    x, y, w, h = box
    bg = Background(rgba, box, others)
    x0, y0, x1, y1 = clip_box(x - bg.inner, y - bg.inner, x + w + bg.inner, y + h + bg.inner, W, H)
    region = rgba[y0:y1, x0:x1]
    mask = clean(bg.text(region), (x - x0, y - y0, x - x0 + w, y - y0 + h))
    if mask.sum() < 5:
        return None
    st, (gx0, gy0, gx1, gy1) = style(region, mask, bg)
    glyph = (x0 + gx0, y0 + gy0, x0 + gx1, y0 + gy1)
    gw, gh = glyph[2] - glyph[0], glyph[3] - glyph[1]
    rgb = on_gray(rgba)
    crop = rgb[max(0, glyph[1] - 4):glyph[3] + 4, max(0, glyph[0] - 4):glyph[2] + 4]
    vertical = gh > gw * 1.6
    judge = ''
    if fixed_text is not None:
        # Склеенные столбцы вертикальной надписи: текст уже прочитан по столбцам
        p, m, text, unsure, share = fixed_text, '', fixed_text, False, 1.0
    else:
        if paddle is None:
            paddle, score = engine.rec(crop)
        p = nf(paddle)
        # Paddle видит один «знак» — это пятно рисунка («足», «心» на арте), а manga-ocr дописал бы к нему частое слово
        if not manual and len(core(p)) < 2:
            return None
        short = len(core(p)) <= SHORT and (gw <= gh * 14 or vertical)
        m = engine.manga(crop) if short and engine.has_manga else ''
        text, unsure, share = choose(p, m, short)
        if not manual:
            if len(core(text)) < 2 or not CJK.search(text):
                return None
            # Ответы не сходятся, а Paddle не уверен или «надпись» пёстрая — это рисунок, а не текст: у надписей
            # игр одна-две краски (заливка и обводка), у арта — много цветов
            colorful = colorfulness(region, mask) > 60
            if share < 0.75 and (score < 0.7 or colorful):
                return None
        # Спорное — к третьему судье (PP-OCRv5 server) и голосованию: двое не сошлись, Paddle не уверен, или это
        # число с датой (цифры пиксельных шрифтов путают все по-своему)
        # Вертикальную — всегда и судье (с поворотом): Paddle читает её как есть, второго мнения без судьи нет
        disputed = (vertical or unsure or score < 0.85 or (m and not same(p, m))
                    or bool(re.search(r'\d', p) and re.search('[年月日]', p)))
        has_judge = getattr(engine, 'has_judge', False)
        if disputed and has_judge:
            judge = nf(engine.judge(np.ascontiguousarray(np.rot90(crop)) if vertical else crop))
            text, unsure = resolve(p, score, m, judge, text)
        elif not manual:
            unsure = unsure or score < 0.85
        # Вертикальную без судьи не проверить второй раз (Paddle читает её без поворота) — на проверку
        if vertical and not has_judge and not manual:
            unsure = True
    vertical = vertical and len(core(text)) >= 2
    left, right = free_space(rgba, bg, glyph, others)
    align, max_w = layout(left, right, gw, W, glyph)
    if vertical:
        # Вертикальная надпись: перевод рисуется повёрнутым, вдоль столбца — размер по ширине столбца
        st['size'] = int(max(8, round((gw - st['outlineWidth']) / 0.88)))
        align, max_w = 'center', gh
    return {
        'text': text, 'paddle': p, 'manga': m, 'judge': judge, 'score': round(float(score), 3), 'agree': round(float(share), 2),
        'unsure': bool(unsure), 'vertical': bool(vertical),
        'box': [int(x), int(y), int(w), int(h)],
        'x': glyph[0], 'y': glyph[1], 'w': gw, 'h': gh, 'maxW': max_w, 'align': align, **st,
        'patchBox': [x0, y0, x1 - x0, y1 - y0], 'patch': patch(region, mask, bg, st['outline']),
    }


def merge_columns(rgba, labels, engine):
    """Вертикальная надпись в несколько столбцов («トイレはキレイに / 使いましょう»): поиск находит столбцы по отдельности,
    а переводить надо фразу целиком. Соседние столбцы одной высоты — одна подпись; японский столбцы читает справа
    налево"""
    cols = sorted([lab for lab in labels if lab['vertical']], key=lambda lab: -lab['x'])
    groups = []
    for lab in cols:
        g = groups[-1] if groups else None
        if g:
            prev = g[-1]
            top, bottom = max(prev['y'], lab['y']), min(prev['y'] + prev['h'], lab['y'] + lab['h'])
            near = prev['x'] - (lab['x'] + lab['w']) <= 1.5 * max(prev['w'], lab['w'])
            if near and bottom - top >= 0.5 * min(prev['h'], lab['h']):
                g.append(lab)
                continue
        groups.append([lab])
    out = [lab for lab in labels if not lab['vertical']]
    rest = [lab['box'] for lab in out]
    for g in groups:
        if len(g) == 1:
            out.append(g[0])
            continue
        x0 = min(lab['box'][0] for lab in g)
        y0 = min(lab['box'][1] for lab in g)
        x1 = max(lab['box'][0] + lab['box'][2] for lab in g)
        y1 = max(lab['box'][1] + lab['box'][3] for lab in g)
        merged = label_of(rgba, [x0, y0, x1 - x0, y1 - y0], rest, engine, fixed_text=''.join(lab['text'] for lab in g))
        if not merged:
            out.extend(g)
            continue
        merged.update(vertical=True, unsure=any(lab['unsure'] for lab in g), score=min(lab['score'] for lab in g),
                      paddle=''.join(lab['paddle'] for lab in g), manga=''.join(lab['manga'] for lab in g))
        # Размер — по одному столбцу, не по всей ширине склейки; перевод — вдоль столбцов, по центру
        col_w = min(lab['w'] for lab in g)
        merged['size'] = int(max(8, round((col_w - merged['outlineWidth']) / 0.88)))
        merged['align'], merged['maxW'] = 'center', merged['h']
        out.append(merged)
    return out


def harmonize(labels):
    """Подписи одного вида (тот же цвет и обводка) на картинке — одной жирности: штрих мелких букв меряется
    грубо, и без этого «Атака» вышла бы жирной, а «Защита» рядом — нет."""
    def tone(h):
        return None if not h else round(lum([int(h[i:i + 2], 16) for i in (1, 3, 5)]) / 48)
    groups = {}
    for lab in labels:
        groups.setdefault((tone(lab['color']), tone(lab['outline'])), []).append(lab)
    for group in groups.values():
        if len(group) >= 3:
            bold = sum(1 for lab in group if lab['bold']) * 2 >= len(group)
            for lab in group:
                lab['bold'] = bold


def analyze(engine, data):
    rgba = decode(data)
    H, W = rgba.shape[:2]
    lines = engine.detect(on_gray(rgba))
    latin = cjk_lines = 0
    found = []
    for poly, text, score in lines:
        t = nf(text)
        if not CJK.search(t):
            if len(LATIN_WORD.findall(t)) >= 2:
                latin += 1
            continue
        cjk_lines += 1
        if abs(angle(poly)) > MAX_ANGLE or score < 0.5:
            continue
        xs, ys = [p[0] for p in poly], [p[1] for p in poly]
        bx0, by0, bx1, by1 = clip_box(min(xs), min(ys), max(xs), max(ys), W, H)
        if bx1 - bx0 < 4 or by1 - by0 < 4:
            continue
        found.append(([bx0, by0, bx1 - bx0, by1 - by0], t, float(score)))
    boxes = [b for b, _, _ in found]
    labels = []
    for i, (box, text, score) in enumerate(found):
        others = boxes[:i] + boxes[i + 1:]
        # Две подписи в одной рамке («リナ　攻撃力：» — поиск ставит между ними пробел): режем по пустому
        # промежутку и читаем каждую заново. Строку без пробела не режем: в длинной фразе бывают просветы
        if not re.search(r'\s', text.strip()):
            lab = label_of(rgba, box, others, engine, text, score)
            if lab:
                labels.append(lab)
            continue
        bg = Background(rgba, box, others)
        x, y, w, h = box
        x0, y0, x1, y1 = clip_box(x - bg.inner, y - bg.inner, x + w + bg.inner, y + h + bg.inner, W, H)
        mask = clean(bg.text(rgba[y0:y1, x0:x1]), (x - x0, y - y0, x - x0 + w, y - y0 + h))
        rows = np.nonzero(mask.any(axis=1))[0]
        parts = gaps(mask, max(10, int((rows.max() - rows.min() + 1) * 0.9))) if len(rows) else []
        if len(parts) > 1:
            pieces = [[x0 + a, y, b - a, h] for a, b in parts]
            for j, piece in enumerate(pieces):
                lab = label_of(rgba, piece, others + pieces[:j] + pieces[j + 1:], engine)
                if lab:
                    labels.append(lab)
            continue
        lab = label_of(rgba, box, others, engine, text, score)
        if lab:
            labels.append(lab)
    labels = merge_columns(rgba, labels, engine)
    harmonize(labels)
    # На картинке уже есть перевод рядом с оригиналом (английская строка под японской) — её не трогаем
    bilingual = latin >= 2 and latin >= cjk_lines * 0.5
    return {'version': VERSION, 'w': W, 'h': H, 'latin': latin, 'bilingual': bilingual, 'labels': labels}


def read_boxes(engine, data, boxes):
    """Подписи в рамках, обведённых рукой (экран «Картинки»): прочитать, понять стиль, приготовить заплатку."""
    rgba = decode(data)
    H, W = rgba.shape[:2]
    out = []
    norm = []
    for b in boxes:
        x0, y0, x1, y1 = clip_box(b[0], b[1], b[0] + b[2], b[1] + b[3], W, H)
        if x1 - x0 >= 4 and y1 - y0 >= 4:
            norm.append([x0, y0, x1 - x0, y1 - y0])
    for i, box in enumerate(norm):
        out.append(label_of(rgba, box, norm[:i] + norm[i + 1:], engine, manual=True))
    return {'version': VERSION, 'w': W, 'h': H, 'labels': out}
