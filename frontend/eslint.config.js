import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'dist-demo', 'demo-data']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  // Конфиги сборки читают окружение
  { files: ['vite*.config.js'], languageOptions: { globals: globals.node } },
  // Адреса картинок, звуков и видео с сервера строит один модуль (apiUrl.js): в демо-сборке у страницы нет сервера, и
  // каждый такой адрес там заменяется файлом. Новый адрес в стороне от него в демо просто не откроется
  {
    files: ['src/**/*.{js,jsx}'],
    ignores: ['src/apiUrl.js'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: 'TemplateElement[value.raw=/\\?f=/]', message: 'Адрес файла альбома — galleryUrl из apiUrl.js' },
        { selector: 'TemplateElement[value.raw=/^\\/api\\/(avatars|saves\\/shot)\\//]', message: 'Адрес картинки с сервера строится в apiUrl.js' },
        { selector: 'TemplateElement[value.raw=/\\/(thumb|shot|image|audio|video)$/]', message: 'Адрес картинки или звука с сервера строится в apiUrl.js' },
      ],
    },
  },
])
