// Готовая таблица демо: роутер со всеми обработчиками из handlers/index.js. Страница, запись и проверки берут её отсюда
import { createRouter } from './router.js';
import handlers from './handlers/index.js';

export const router = createRouter(handlers);
export const { routes, match, dispatch } = router;
