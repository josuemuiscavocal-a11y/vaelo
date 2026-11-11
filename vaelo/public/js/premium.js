// Acabado visual: apariciones al bajar por la página y pequeños detalles. No toca datos ni formularios.
(() => {
  'use strict';
  const quieto = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Sombra del encabezado cuando la página ya bajó
  const barra = document.getElementById('barra');
  if (barra) {
    const marcar = () => barra.classList.toggle('con-sombra', window.scrollY > 8);
    window.addEventListener('scroll', marcar, { passive: true }); marcar();
  }

  // El precio del cotizador hace un pequeño salto cuando cambia
  const precio = document.getElementById('cot-precio');
  if (precio && !quieto && 'MutationObserver' in window) {
    new MutationObserver(() => { precio.classList.remove('cambio'); void precio.offsetWidth; precio.classList.add('cambio'); })
      .observe(precio, { childList: true, characterData: true, subtree: true });
  }

  // Apariciones: cada grupo entra en orden cuando llega a la pantalla
  if (quieto || !('IntersectionObserver' in window)) return;
  const GRUPOS = ['.cotizador > *', '.seccion-lives .contenedor > :not(ol)', '.pasos-lives li', '.seccion.gris h2', '.pasos li', '.llamado-apps h2', '.app-tarjeta'];
  const vista = new IntersectionObserver((entradas) => {
    for (const e of entradas) if (e.isIntersecting) { e.target.classList.add('visto'); vista.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  for (const sel of GRUPOS) {
    document.querySelectorAll(sel).forEach((nodo, i) => {
      // Lo que ya está a la vista al cargar no se esconde (evita parpadeos)
      if (nodo.getBoundingClientRect().top < window.innerHeight * 0.9) return;
      nodo.classList.add('ver'); nodo.style.setProperty('--i', i % 4); vista.observe(nodo);
    });
  }
  document.documentElement.classList.add('anim');
})();
