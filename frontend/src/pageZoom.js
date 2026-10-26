// Масштаб широкого экрана (styles/base.css, --zoom). Координаты getBoundingClientRect, мыши и innerWidth — в точках
// экрана, а стили, offsetWidth и clientWidth — в точках вёрстки: при масштабе первое делится на него
export const pageZoom = () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
