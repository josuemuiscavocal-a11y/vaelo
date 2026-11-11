// Movimiento suave en todas las pantallas. Solo apariencia: no pide ni guarda datos.
(() => {
  'use strict';
  // Pasada la primera carga, los bloques ya no se animan (las actualizaciones automáticas no deben parpadear)
  const listo = () => setTimeout(() => document.documentElement.classList.add('sv-listo'), 1600);
  if (document.readyState === 'complete') listo(); else window.addEventListener('load', listo, { once: true });

  // Palomita que se dibuja (la misma del aviso de pedido recibido)
  window.checkAnimado = () => {
    const caja = document.createElement('div');
    caja.innerHTML = `<svg class="celebra-check" viewBox="0 0 120 120" aria-hidden="true">
      <circle class="celebra-circulo" cx="60" cy="60" r="52" fill="none" stroke-width="7"/>
      <path class="celebra-palomita" d="M38 62 l15 15 l30 -32" fill="none" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    return caja.firstElementChild;
  };

  // Aviso corto de "hecho": no tapa nada, no hay que cerrarlo y se va solo
  window.avisoHecho = (titulo, detalle) => {
    try {
      document.querySelectorAll('.sv-hecho').forEach((x) => x.remove());
      const capa = document.createElement('div'); capa.className = 'sv-hecho'; capa.setAttribute('role', 'status'); capa.setAttribute('aria-live', 'polite');
      const caja = document.createElement('div'); caja.className = 'sv-hecho-caja';
      const t = document.createElement('strong'); t.textContent = titulo;
      caja.append(window.checkAnimado(), t);
      if (detalle) { const d = document.createElement('span'); d.textContent = detalle; caja.append(d); }
      capa.append(caja);
      // Dentro de la ventana abierta (si hay una) para que se vea encima de ella
      (document.querySelector('dialog[open]') || document.body).append(capa);
      setTimeout(() => { capa.classList.add('saliendo'); setTimeout(() => capa.remove(), 320); }, 1700);
      if (navigator.vibrate) navigator.vibrate(40);
    } catch { /* el aviso es solo un adorno: si falla, no pasa nada */ }
  };
})();
