import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import App from './App.jsx'
import { loadLocale, savedLang } from './locales'
import { loadMe } from './me'

// Тексты выбранного языка и ответ «кто вошёл» — до первой отрисовки: без первых App нечего показать, а без вторых человек
// на миг увидел бы кнопки владельца
Promise.all([loadLocale(savedLang()), loadMe()]).then(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
