// Значки меню одним стилем: тонкая линия, цвет берётся от текста (currentColor),
// поэтому при наведении они золотеют вместе с подписью. Эмодзи так не умеют —
// у каждого свои цвета, и в тёмно-золотой теме они выглядели чужими.
const Icon = ({ children }) => (
  <svg
    viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
  >
    {children}
  </svg>
);

export const IconStats = () => (
  <Icon>
    <path d="M4 20h16" />
    <path d="M7 16v-5" />
    <path d="M12 16V6" />
    <path d="M17 16v-8" />
  </Icon>
);

export const IconAudit = () => (
  <Icon>
    <rect x="5" y="4.5" width="14" height="16" rx="2" />
    <path d="M9 3h6v3H9z" />
    <path d="M9 13l2.2 2.2L15.5 11" />
  </Icon>
);

export const IconLogout = () => (
  <Icon>
    <path d="M14 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H14" />
    <path d="M11 12h9" />
    <path d="M17 9l3 3-3 3" />
  </Icon>
);

export const IconEdit = () => (
  <Icon>
    <path d="M4 20h4L19 9l-4-4L4 16v4z" />
    <path d="M13.5 6.5l4 4" />
  </Icon>
);

// Бэкап сейвов — скачать к себе, импорт — загрузить обратно
export const IconDownload = () => (
  <Icon>
    <path d="M12 4v11" />
    <path d="M8 11l4 4 4-4" />
    <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
  </Icon>
);

export const IconUpload = () => (
  <Icon>
    <path d="M12 15V4" />
    <path d="M8 8l4-4 4 4" />
    <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
  </Icon>
);

export const IconTrash = () => (
  <Icon>
    <path d="M4 7h16" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7" />
    <path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />
  </Icon>
);

export const IconSearch = () => (
  <Icon>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15l5 5" />
  </Icon>
);

// Новинки игр: свиток со звёздочкой
export const IconNews = () => (
  <Icon>
    <path d="M5 4.5h10.5a1.5 1.5 0 0 1 1.5 1.5v13.5l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5V6A1.5 1.5 0 0 1 5 4.5z" transform="translate(1 0)" />
    <path d="M9 9h6M9 12.5h4" />
    <path d="M19.5 3.5v3M18 5h3" />
  </Icon>
);

// Проверить обновления: круговая стрелка
export const IconRefresh = () => (
  <Icon>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.5 4v4h-4" />
  </Icon>
);

// Галерея: картинка с горами
export const IconImage = () => (
  <Icon>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M4 17l5-5 4 4 3-3 4 4" />
  </Icon>
);

// Во что поиграть: игральная кость
export const IconDice = () => (
  <Icon>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <circle cx="9" cy="9" r="1" />
    <circle cx="15" cy="15" r="1" />
    <circle cx="15" cy="9" r="1" />
    <circle cx="9" cy="15" r="1" />
  </Icon>
);

// Telegram: бумажный самолётик
export const IconSend = () => (
  <Icon>
    <path d="M20.5 3.5L3.5 10.5l6.5 2.5 2.5 6.5z" />
    <path d="M20.5 3.5L10 13" />
  </Icon>
);

// История сейвов: часы со стрелкой назад
export const IconHistory = () => (
  <Icon>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
    <path d="M4.5 4v4h4" />
    <path d="M12 8v4.5l3 1.8" />
  </Icon>
);

// Не начата: пунктирный круг — «ещё не», внутри ▶ — «поиграть»
export const IconNotStarted = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" strokeDasharray="3.1 2.6" />
    <path d="M10.3 8.9v6.2l4.9-3.1z" />
  </Icon>
);

// Вышло обновление: стрелка вверх в круге — та же «↑», что у новой версии на карточке
export const IconUpdate = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 16.2V8" />
    <path d="M8.6 11.3L12 7.9l3.4 3.4" />
  </Icon>
);

// Недавно добавлена: сундук — тот же мимик, что в логотипе («положили в библиотеку»). Не звёздочки-«искры»:
// это значок ИИ-функций, в библиотеке игр он читается чужим
export const IconChest = () => (
  <Icon>
    <path d="M4 10V8.5A2.5 2.5 0 0 1 6.5 6h11A2.5 2.5 0 0 1 20 8.5V10" />
    <rect x="4" y="10" width="16" height="9" rx="1" />
    <path d="M10.5 10v3h3v-3" />
  </Icon>
);

// Прохождение: раскрытая книга
export const IconBook = () => (
  <Icon>
    <path d="M12 6.5c-1.8-1.4-4.6-2-7.5-1.8V18c2.9-.2 5.7.4 7.5 1.8 1.8-1.4 4.6-2 7.5-1.8V4.7c-2.9-.2-5.7.4-7.5 1.8z" />
    <path d="M12 6.5v13.3" />
  </Icon>
);

// Хочу поиграть: звезда. Закрашивается стилем (.on), когда игра в списке
// «Избранное» в меню — сердце тем же контуром, что и остальные пункты
export const IconFavorites = () => (
  <Icon>
    <path d="M12 20s-7-4.3-8.4-9C2.7 7.8 4.7 5 7.6 5c1.8 0 3.3 1 4.4 2.6C13.1 6 14.6 5 16.4 5c2.9 0 4.9 2.8 4 6-1.4 4.7-8.4 9-8.4 9z" />
  </Icon>
);

export const IconStar = () => (
  <Icon>
    <path d="M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6L12 16.6l-5 2.6.9-5.6-4-3.9 5.6-.8z" />
  </Icon>
);

export const IconSettings = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Icon>
);

// Значки внутри текста и маленьких кнопок: размер — от шрифта (1em), толщина линии — та же, что у
// значков меню. Раньше здесь стояли символы ★ × ‹ › ← ↗ и эмодзи ⏱ ⏳ 📷 🔗: эмодзи цветные и у
// каждой системы свои, а ★ и ✓ рисовал запасной шрифт — другой толщины, чем всё вокруг
const Glyph = ({ children, filled = false }) => (
  <svg
    viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false"
    fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'}
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="glyph"
  >
    {children}
  </svg>
);

export const IconClose = () => <Glyph><path d="M6 6l12 12M18 6L6 18" /></Glyph>;
export const IconChevronLeft = () => <Glyph><path d="M15 5l-7 7 7 7" /></Glyph>;
export const IconChevronRight = () => <Glyph><path d="M9 5l7 7-7 7" /></Glyph>;
export const IconChevronUp = () => <Glyph><path d="M5 15l7-7 7 7" /></Glyph>;
export const IconChevronDown = () => <Glyph><path d="M5 9l7 7 7-7" /></Glyph>;
export const IconMinus = () => <Glyph><path d="M5 12h14" /></Glyph>;
export const IconPlus = () => <Glyph><path d="M12 5v14M5 12h14" /></Glyph>;
export const IconLock = () => <Glyph><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" /></Glyph>;
export const IconArrowLeft = () => <Glyph><path d="M19 12H5M11 6l-6 6 6 6" /></Glyph>;
export const IconGrid = () => <Glyph><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" /></Glyph>;
export const IconRows = () => <Glyph><path d="M4 5h4v4H4zM11 7h9M4 15h4v4H4zM11 17h9" /></Glyph>;
export const IconArrowRight = () => <Glyph><path d="M5 12h14M13 6l6 6-6 6" /></Glyph>;
export const IconExternal = () => <Glyph><path d="M8 16L16 8M10 8h6v6" /></Glyph>;
export const IconCheck = () => <Glyph><path d="M5 12.5l4.5 4.5L19 7.5" /></Glyph>;
export const IconHeart = () => <Glyph filled><path d="M12 20.5s-7.5-4.6-9-9.6C2 7.4 4.2 4.5 7.3 4.5c2 0 3.6 1.1 4.7 2.8 1.1-1.7 2.7-2.8 4.7-2.8 3.1 0 5.3 2.9 4.3 6.4-1.5 5-9 9.6-9 9.6z" /></Glyph>;
export const IconPin = () => <Glyph><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></Glyph>;
export const IconClock = () => <Glyph><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Glyph>;
export const IconHourglass = () => <Glyph><path d="M7 4h10M7 20h10M8 4c0 4.5 8 5.5 8 8s-8 3.5-8 8M16 4c0 4.5-8 5.5-8 8s8 3.5 8 8" /></Glyph>;
export const IconCamera = () => <Glyph><path d="M4 8h3.5L9 6h6l1.5 2H20v11H4z" /><circle cx="12" cy="13" r="3.5" /></Glyph>;
export const IconLink = () => <Glyph><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></Glyph>;
export const IconStarSolid = () => <Glyph filled><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" /></Glyph>;
// Глаз, ползунки фильтров и «⋯» — линейные, как остальные: раньше стояли залитые Google Material
export const IconEye = () => <Glyph><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Glyph>;
export const IconEyeOff = () => <Glyph><path d="M9.5 6a10 10 0 0 1 2.5-.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3 3.8M6.2 7.9A17 17 0 0 0 2 12s3.6 6.5 10 6.5c1.5 0 2.8-.3 4-.8M3 3l18 18M10 10a3 3 0 0 0 4 4" /></Glyph>;
export const IconSliders = () => <Glyph><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></Glyph>;
export const IconMore = () => <Glyph filled><circle cx="5.5" cy="12" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="18.5" cy="12" r="1.9" /></Glyph>;
// Вместо текстовых ↑ ▲ ▼: версия обновления и место в таблице (треугольники — залитые, мелкие)
export const IconArrowUpSmall = () => <Glyph><path d="M12 19V5M6 11l6-6 6 6" /></Glyph>;
export const IconTriangleUp = () => <Glyph filled><path d="M12 6l7 11H5z" /></Glyph>;
export const IconTriangleDown = () => <Glyph filled><path d="M12 18L5 7h14z" /></Glyph>;
export const IconPlay = () => <Glyph filled><path d="M8 5.5v13l11-6.5z" /></Glyph>;
export const IconBookmark = () => <Glyph><path d="M6.5 4h11v16l-5.5-4-5.5 4z" /></Glyph>;
export const IconHeartLine = () => <Glyph><path d="M12 20.5s-7.5-4.6-9-9.6C2 7.4 4.2 4.5 7.3 4.5c2 0 3.6 1.1 4.7 2.8 1.1-1.7 2.7-2.8 4.7-2.8 3.1 0 5.3 2.9 4.3 6.4-1.5 5-9 9.6-9 9.6z" /></Glyph>;
export const IconPause = () => <Glyph filled><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /></Glyph>;
export const IconSkip = () => <Glyph filled><path d="M3.5 6v12l8-6zM12.5 6v12l8-6z" /></Glyph>;
export const IconExpand = () => <Glyph><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Glyph>;
export const IconSound = () => <Glyph><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></Glyph>;
export const IconMute = () => <Glyph><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4zM16 9.5l5 5M21 9.5l-5 5" /></Glyph>;
export const IconTalk = () => <Glyph><path d="M5 5h14v10H10l-4 4v-4H5z" /></Glyph>;
export const IconShuffle = () => <Glyph><path d="M4 7h3.5c2.5 0 3.5 1.5 5 5s2.5 5 5 5H20M17 4l3 3-3 3M4 17h3.5c1.3 0 2.2-.4 3-1.3M17 14l3 3-3 3M13.5 8.3c.8-.9 1.7-1.3 3-1.3H20" /></Glyph>;
// Значки плитки галереи: ролик (плёнка — ▶ в галерее значит только «смотреть сцену»), анимация (петля), выбор (развилка)
export const IconFilm = () => <Glyph><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M8 5v14M16 5v14M3.5 12H8M16 12h4.5" /></Glyph>;
export const IconLoop = () => <Glyph><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5" /></Glyph>;
export const IconFork = () => <Glyph><path d="M12 21v-7M12 14L6.5 5.5M12 14l5.5-8.5M6 10V5h5M18 10V5h-5" /></Glyph>;
