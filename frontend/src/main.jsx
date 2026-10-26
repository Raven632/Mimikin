import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import App from './App.jsx'
import { loadLocale, savedLang } from './locales'

// Тексты выбранного языка — до первой отрисовки: без них App нечего показать
loadLocale(savedLang()).then(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
