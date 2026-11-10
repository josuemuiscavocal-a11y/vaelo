// Tema de Navidad: nieve suave, saludo en el inicio y botón para apagar la nieve (se recuerda en este navegador).
(function () {
  const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const leer = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const quieto = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Saludo solo en la página de inicio
  if (location.pathname === '/' && leer('vaelo_nav_saludo') !== String(new Date().getFullYear())) {
    const f = document.createElement('div');
    f.className = 'nav-saludo';
    f.innerHTML = '<span>🎄 ¡Felices fiestas! Vaelo lleva tus regalos a toda la ciudad esta Navidad 🎁</span><button type="button" aria-label="Cerrar saludo">×</button>';
    f.querySelector('button').onclick = () => { f.remove(); guardar('vaelo_nav_saludo', String(new Date().getFullYear())); };
    document.body.prepend(f);
  }

  // Nieve: canvas liviano, se pausa cuando la pestaña no se ve
  const lienzo = document.createElement('canvas');
  lienzo.className = 'nav-nieve'; lienzo.setAttribute('aria-hidden', 'true');
  const ctx = lienzo.getContext('2d');
  let copos = [], activo = false, cuadro = 0, ancho = 0, alto = 0;
  const medir = () => {
    const r = Math.min(window.devicePixelRatio || 1, 2);
    ancho = innerWidth; alto = innerHeight; lienzo.width = ancho * r; lienzo.height = alto * r; ctx.setTransform(r, 0, 0, r, 0, 0);
    const n = Math.round(Math.min(70, ancho / 18));
    copos = Array.from({ length: n }, () => ({ x: Math.random() * ancho, y: Math.random() * alto, r: 1 + Math.random() * 2.6, v: .3 + Math.random() * .8, o: Math.random() * 6.28, a: .45 + Math.random() * .45 }));
  };
  const dibujar = () => {
    ctx.clearRect(0, 0, ancho, alto);
    for (const c of copos) {
      c.y += c.v; c.o += .012; c.x += Math.sin(c.o) * .4;
      if (c.y > alto + 4) { c.y = -4; c.x = Math.random() * ancho; }
      ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, 6.283); ctx.fillStyle = `rgba(255,255,255,${c.a})`;
      ctx.shadowColor = 'rgba(120,140,180,.6)'; ctx.shadowBlur = 2; ctx.fill();
    }
    cuadro = requestAnimationFrame(dibujar);
  };
  const encender = (si) => {
    activo = si; boton.setAttribute('aria-pressed', String(si)); boton.title = si ? 'Apagar la nieve' : 'Encender la nieve';
    cancelAnimationFrame(cuadro);
    if (si) { if (!lienzo.isConnected) document.body.append(lienzo); medir(); dibujar(); } else lienzo.remove();
  };
  const boton = document.createElement('button');
  boton.type = 'button'; boton.className = 'nav-boton-nieve'; boton.textContent = '❄'; boton.setAttribute('aria-label', 'Nieve de Navidad');
  boton.onclick = () => { encender(!activo); guardar('vaelo_nieve', activo ? '1' : '0'); };
  document.body.append(boton);
  addEventListener('resize', () => { if (activo) medir(); });
  document.addEventListener('visibilitychange', () => { if (!activo) return; cancelAnimationFrame(cuadro); if (!document.hidden) dibujar(); });
  encender(!quieto && leer('vaelo_nieve') !== '0');
})();
