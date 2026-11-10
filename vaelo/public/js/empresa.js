// Apartado de empresa en "Mis envíos": solicitud de contrato (antes de firmar) y panel de empresa (después de firmar)
'use strict';

const CAMPOS_SOLICITUD = {
  empresa: [['empresa_nombre', 'Nombre comercial', { maxlength: 100 }], ['razon_social', 'Razón social', { maxlength: 150 }, 'Como aparece en la patente'],
    ['nit', 'NIT', { maxlength: 20 }], ['giro', '¿A qué se dedica?', { maxlength: 120, placeholder: 'Venta de ropa en línea, farmacia, repuestos…' }],
    ['paquetes_mes', 'Paquetes que envían al mes (aprox.)', { type: 'number', min: 1 }], ['sitio_web', 'Página web o redes', { maxlength: 200 }, 'Opcional'],
    ['direccion', 'Dirección de la sede', { maxlength: 300 }], ['zona', 'Zona o municipio', { maxlength: 60 }],
    ['telefono', 'Teléfono de la empresa', { type: 'tel', maxlength: 30 }], ['correo', 'Correo de la empresa', { type: 'email', maxlength: 150 }]],
  representante: [['rep_nombre', 'Nombre completo', { maxlength: 100 }], ['rep_cargo', 'Cargo', { maxlength: 80, placeholder: 'Gerente, propietario…' }],
    ['rep_dpi', 'Número de DPI', { inputmode: 'numeric', maxlength: 17, placeholder: '0000 00000 0000' }], ['rep_telefono', 'Teléfono', { type: 'tel', maxlength: 30 }],
    ['rep_correo', 'Correo', { type: 'email', maxlength: 150 }, 'Opcional']],
};

async function pintarEmpresa(caja, op = {}) {
  poner(caja, el('p', { class: 'pista', text: 'Cargando…' }));
  let r;
  try { r = await api('/api/empresa/solicitud'); } catch (e) { poner(caja, el('div', { class: 'mensaje error', text: e.message })); return; }
  if (r.es_empresa) return panelEmpresa(caja, op);
  return solicitudEmpresa(caja, r);
}

// ---------- Antes del contrato: solicitud por pasos ----------
function solicitudEmpresa(caja, r) {
  const totalReq = 12 + Object.values(r.documentos).filter(d => !d.opcional).length;
  const s = r.solicitud || { estado: 'borrador', docs: {}, falta: new Array(totalReq).fill('x') };
  const editable = ['borrador', 'rechazada'].includes(s.estado);
  const pasos = [['borrador', 'Tus datos'], ['enviada', 'Revisión'], ['cita', 'Cita para firmar'], ['aprobada', 'Contrato firmado']];
  const actual = s.estado === 'rechazada' ? 0 : pasos.findIndex(([k]) => k === s.estado);
  const pasosNodo = el('ol', { class: 'pasos-empresa' }, pasos.map(([, t], i) => el('li', { class: i < actual ? 'hecho' : i === actual ? 'actual' : '' }, el('span', { class: 'num', text: String(i + 1) }), el('span', { text: t }))));
  const intro = el('div', { class: 'empresa-intro' },
    el('div', {}, el('h2', { text: 'Vaelo para empresas' }),
      el('p', { text: 'Entrega los pedidos de tu negocio con los pilotos de Vaelo, sin contratar ni mantener tu propia flotilla de motos.' }),
      el('ul', { class: 'lista-beneficios' },
        el('li', {}, icono('piloto'), 'Pilotos verificados, con GPS en vivo y código de entrega'),
        el('li', {}, icono('dinero'), 'El envío lo puede pagar tu cliente al recibir'),
        el('li', {}, icono('sede'), 'Registra tus pedidos, tus clientes eligen día y lugar, y Vaelo arma las rutas'),
        el('li', {}, icono('grafica'), 'Analítica de tus entregas, sin costos ocultos para tu empresa'))),
    pasosNodo);
  const estadoNodo = {
    enviada: el('div', { class: 'mensaje aviso' }, el('strong', { text: 'Recibimos tu solicitud.' }), ' La estamos revisando. Te avisaremos para coordinar la cita y firmar el contrato.'),
    cita: el('div', { class: 'cita-empresa' }, icono('reloj'), el('div', {}, el('strong', { text: 'Tu cita para firmar el contrato' }),
      el('p', { text: s.cita_fecha ? new Date(s.cita_fecha + ':00-06:00').toLocaleString('es-GT', { timeZone: 'America/Guatemala', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }) : '' }),
      el('p', { class: 'pista', text: `${s.cita_lugar || ''}. Lleva el DPI del representante y la patente de comercio originales.${s.nota_admin ? ' ' + s.nota_admin : ''}` }))),
    rechazada: el('div', { class: 'mensaje error' }, el('strong', { text: 'Tu solicitud necesita cambios: ' }), s.motivo_rechazo || '', ' Corrige y vuelve a enviarla.'),
  }[s.estado] || null;
  if (!editable) { poner(caja, intro, estadoNodo || '', resumenSolicitud(s, r)); return; }

  const msg = el('div', { class: 'mensaje', role: 'alert' });
  const campos = {};
  const entrada = ([k, titulo, attrs, ayuda]) => {
    const input = el('input', { id: 'emp-' + k, ...attrs });
    input.value = k === 'rep_dpi' && s[k] ? `${s[k].slice(0, 4)} ${s[k].slice(4, 9)} ${s[k].slice(9)}` : (s[k] ?? '');
    campos[k] = input;
    return el('div', { class: 'campo' }, el('label', { for: 'emp-' + k }, titulo, ayuda ? el('span', { class: 'ayuda', text: ' ' + ayuda }) : null), input);
  };
  const progreso = el('div', { class: 'progreso-solicitud' });
  const pintarProgreso = (sol) => {
    const total = totalReq;
    const hechos = Math.max(0, total - sol.falta.length);
    poner(progreso, el('div', { class: 'progreso-barra' }, el('i', { style: `width:${Math.round((hechos / total) * 100)}%` })),
      el('small', { text: sol.falta.length ? `Llevas ${hechos} de ${total}. Te falta ${sol.falta.length}.` : 'Todo completo. Ya puedes enviar tu solicitud.' }));
    enviar.disabled = !!sol.falta.length;
  };
  const guardar = async () => {
    const body = Object.fromEntries(Object.entries(campos).map(([k, i]) => [k, i.value]));
    const res = await api('/api/empresa/solicitud', { method: 'PUT', body });
    Object.assign(s, res.solicitud); pintarProgreso(res.solicitud);
  };
  const doc = (campo) => campoDocumento({   // (se usa en el resumen) titulo: r.documentos[campo].nombre, tiene: s.docs[campo], ver: `/api/empresa/solicitud/documento/${campo}`,
    pdf: r.documentos[campo].pdf, ayuda: r.documentos[campo].opcional ? 'Opcional' : null, camara: campo.startsWith('foto_sede') ? 'environment' : null,
    subir: async (archivo) => { await guardar().catch(() => {}); await api('/api/empresa/solicitud/documento', { body: { campo, archivo } }); },
    alCambiar: async () => { const x = await api('/api/empresa/solicitud'); Object.assign(s, x.solicitud); pintarProgreso(x.solicitud); } });
  const acepto = el('input', { type: 'checkbox', id: 'emp-politica', style: 'width:auto' });
  const enviar = el('button', { class: 'boton', type: 'button', text: 'Enviar solicitud', onclick: async () => {
    if (!acepto.checked) { mostrarMensaje(msg, 'Lee y acepta las políticas para empresas.'); return; }
    enviar.disabled = true;
    try { await guardar(); await api('/api/empresa/solicitud/enviar', { body: { acepto_politica: true } }); pintarEmpresa(caja); }
    catch (e) { mostrarMensaje(msg, e.message); enviar.disabled = false; }
  } });
  const seccion = (n, titulo, texto, ...h) => el('section', { class: 'bloque seccion-paso' }, el('div', { class: 'seccion-cab' }, el('span', { class: 'num', text: n }), el('div', {}, el('h2', { text: titulo }), texto ? el('p', { class: 'pista', text: texto }) : null)), ...h);
  const form = el('form', { novalidate: true, onsubmit: (ev) => ev.preventDefault(), onchange: () => guardar().catch((e) => mostrarMensaje(msg, e.message)) },
    seccion('1', 'La empresa', 'Los datos se guardan solos mientras escribes.', el('div', { class: 'fila' }, CAMPOS_SOLICITUD.empresa.map(entrada))),
    seccion('2', 'Representante', 'La persona que firmará el contrato.', el('div', { class: 'fila' }, CAMPOS_SOLICITUD.representante.map(entrada))),
    seccion('3', 'Fotos y documentos', 'Con esto verificamos tu empresa antes de la cita. Puedes tomarlas con el celular.',
      docsEmpresa(r, s, async (campo, archivo) => { await guardar().catch(() => {}); await api('/api/empresa/solicitud/documento', { body: { campo, archivo } }); },
        async () => { const x = await api('/api/empresa/solicitud'); Object.assign(s, x.solicitud); pintarProgreso(x.solicitud); })),
    seccion('4', 'Enviar', null, progreso,
      el('label', { class: 'casilla', for: 'emp-politica' }, acepto, el('span', {}, 'Leí y acepto las ', el('a', { href: '/politicas-empresas', target: '_blank', text: 'políticas y condiciones para empresas' }),
        '. Entiendo que Vaelo presta su servicio de pilotos y que mi empresa no gana comisiones de Vaelo.')),
      msg, enviar));
  poner(caja, intro, estadoNodo || '', form);
  pintarProgreso(s);
}
// ---------- Fotos y documentos de la solicitud: por grupos, con guía de qué fotografiar ----------
const GUIA_DOCS = {
  foto_sede_frente: { grupo: 'sede', dibujo: 'fachada', ayuda: 'De frente y de día: que se vean el rótulo y el número de la casa o local.' },
  foto_sede_interior: { grupo: 'sede', dibujo: 'bodega', ayuda: 'Donde guardan los paquetes que va a recoger el piloto.' },
  foto_rep: { grupo: 'rep', dibujo: 'persona', ayuda: 'Una foto de la cara, sin lentes oscuros ni gorra.' },
  dpi_rep_frente: { grupo: 'rep', dibujo: 'dpi', ayuda: 'Completo, sin reflejos y que se lean los datos.' },
  dpi_rep_reverso: { grupo: 'rep', dibujo: 'dpi-atras', ayuda: 'La parte de atrás, con el código de barras.' },
  patente: { grupo: 'legal', dibujo: 'documento', ayuda: 'Foto o PDF de la patente de comercio vigente.' },
  rtu: { grupo: 'legal', dibujo: 'documento', ayuda: 'Constancia del RTU. Ayuda a verificar más rápido.' },
};
const GRUPOS_DOCS = [['sede', 'La sede', 'sede'], ['rep', 'El representante', 'usuario'], ['legal', 'Documentos legales', 'etiqueta']];
const dibujoDoc = (k) => dibujoDocumento(k);
function docsEmpresa(r, s, subir, alCambiar) {
  const claves = Object.keys(r.documentos);
  const requeridos = claves.filter((k) => !r.documentos[k].opcional);
  const resumen = el('div', { class: 'docs-resumen' });
  const grupos = {};
  const pintarResumen = () => {
    const listos = requeridos.filter((k) => s.docs[k]).length;
    const pct = Math.round((listos / requeridos.length) * 100);
    poner(resumen,
      el('div', { class: 'docs-anillo', style: `--pct:${pct}`, role: 'img', 'aria-label': `${listos} de ${requeridos.length} listos` }, el('strong', { text: `${listos}/${requeridos.length}` })),
      el('div', {}, el('strong', { text: listos === requeridos.length ? '¡Documentos completos!' : `Te faltan ${requeridos.length - listos} de ${requeridos.length}` }),
        el('ul', { class: 'docs-consejos' }, el('li', { text: 'Buena luz y sin reflejos' }), el('li', { text: 'Fotos o PDF de hasta 700 KB' }), el('li', { text: 'Solo los ve la administración de Vaelo' }))));
    for (const [g] of GRUPOS_DOCS) {
      const ks = claves.filter((k) => (GUIA_DOCS[k]?.grupo || 'legal') === g);
      if (grupos[g]) grupos[g].textContent = `${ks.filter((k) => s.docs[k]).length} de ${ks.length}`;
    }
  };
  const tarjeta = (k) => {
    const d = r.documentos[k], guia = GUIA_DOCS[k] || {};
    const caja = el('div', { class: 'doc-pro' });
    const estado = el('small', { class: 'doc-pro-msg', role: 'status' });
    const entradaCam = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    const entradaArch = el('input', { type: 'file', accept: d.pdf ? 'image/*,application/pdf' : 'image/*', hidden: true });
    const subirArchivo = async (f) => {
      if (!f) return;
      if (f.type === 'application/pdf' && !d.pdf) { estado.className = 'doc-pro-msg error'; estado.textContent = 'Este debe ser una foto.'; return; }
      caja.classList.add('subiendo'); estado.className = 'doc-pro-msg'; estado.textContent = 'Subiendo…';
      try {
        await subir(k, await prepararArchivo(f, d.pdf));
        s.docs[k] = true; s._v = Date.now(); pintar(); pintarResumen(); alCambiar && alCambiar();
        estado.className = 'doc-pro-msg ok'; estado.textContent = 'Guardado';
      } catch (e) { estado.className = 'doc-pro-msg error'; estado.textContent = e.message; }
      caja.classList.remove('subiendo'); entradaCam.value = ''; entradaArch.value = '';
    };
    entradaCam.addEventListener('change', () => subirArchivo(entradaCam.files[0]));
    entradaArch.addEventListener('change', () => subirArchivo(entradaArch.files[0]));
    // Arrastrar y soltar en la computadora
    caja.addEventListener('dragover', (ev) => { ev.preventDefault(); caja.classList.add('arrastrando'); });
    caja.addEventListener('dragleave', () => caja.classList.remove('arrastrando'));
    caja.addEventListener('drop', (ev) => { ev.preventDefault(); caja.classList.remove('arrastrando'); subirArchivo(ev.dataTransfer.files[0]); });
    const pintar = () => {
      const listo = !!s.docs[k];
      caja.className = 'doc-pro' + (listo ? ' listo' : '') + (d.opcional ? ' opcional' : '');
      const src = `/api/empresa/solicitud/documento/${k}?v=${s._v || 1}`;
      const vista = listo
        ? el('a', { class: 'doc-pro-vista con-archivo', href: src, target: '_blank', rel: 'noopener', title: 'Ver archivo' },
            el('img', { src, alt: d.nombre, loading: 'lazy', onerror: (ev) => ev.target.replaceWith(el('span', { class: 'doc-pro-pdf' }, dibujoDoc('documento'), el('b', { text: 'PDF' }))) }),
            el('span', { class: 'doc-pro-ver', text: 'Ver' }))
        : el('label', { class: 'doc-pro-vista' }, dibujoDoc(guia.dibujo), el('small', { class: 'doc-pro-soltar', text: 'Toca para subir o arrastra aquí' }), entradaArch);
      poner(caja,
        el('div', { class: 'doc-pro-cab' }, el('strong', { text: d.nombre }),
          el('span', { class: 'doc-pro-chip ' + (listo ? 'ok' : d.opcional ? 'opc' : 'falta'), text: listo ? '✓ Listo' : d.opcional ? 'Opcional' : 'Falta' })),
        vista,
        el('p', { class: 'doc-pro-ayuda', text: guia.ayuda || '' }),
        el('div', { class: 'doc-pro-botones' },
          el('label', { class: 'boton chico ' + (listo ? 'borde' : '') }, listo ? 'Cambiar' : (d.pdf ? 'Subir archivo' : 'Tomar foto'), d.pdf ? entradaArch : entradaCam),
          !listo && !d.pdf ? el('label', { class: 'boton borde chico' }, 'Desde galería', entradaArch) : null),
        estado);
    };
    pintar();
    return caja;
  };
  const nodos = GRUPOS_DOCS.map(([g, titulo, ic]) => {
    const ks = claves.filter((k) => (GUIA_DOCS[k]?.grupo || 'legal') === g);
    if (!ks.length) return null;
    grupos[g] = el('span', { class: 'docs-grupo-cuenta' });
    return el('div', { class: 'docs-grupo' }, el('h3', {}, icono(ic), ' ', titulo, grupos[g]), el('div', { class: 'docs-pro' }, ks.map(tarjeta)));
  });
  pintarResumen();
  return el('div', { class: 'docs-empresa' }, resumen, ...nodos,
    el('p', { class: 'docs-privado' }, icono('check'), ' Tus documentos se guardan en privado y solo los usa Vaelo para verificar tu empresa y preparar el contrato.'));
}
function resumenSolicitud(s, r) {
  return el('section', { class: 'bloque' }, el('h2', { text: s.empresa_nombre || 'Tu solicitud' }),
    el('div', { class: 'datos' },
      ...[['NIT', s.nit], ['Giro', s.giro], ['Sede', [s.direccion, s.zona].filter(Boolean).join(', ')], ['Paquetes al mes', s.paquetes_mes], ['Representante', `${s.rep_nombre || ''}, ${s.rep_cargo || ''}`], ['Teléfono', s.telefono]]
        .map(([t, v]) => el('div', {}, el('span', { text: t }), String(v ?? '')))),
    el('div', { class: 'docs' }, Object.keys(r.documentos).filter(k => s.docs[k]).map(k => campoDocumento({ titulo: r.documentos[k].nombre, tiene: true, ver: `/api/empresa/solicitud/documento/${k}`, soloVer: true }))));
}


// ---------- Después del contrato: panel de la empresa ----------
// "Mandar varios pedidos": la empresa registra sus pedidos, su cliente confirma con un enlace y, con el mínimo
// de confirmados para un día, se mandan a Vaelo. Aquí no se muestra dinero: Vaelo solo cobra el envío a quien recibe.
const DIAS_EMP = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const diaEmp = (d) => { if (!d) return ''; const f = new Date(d + 'T12:00:00Z'); return `${DIAS_EMP[f.getUTCDay()]} ${f.getUTCDate()} de ${f.toLocaleDateString('es-GT', { month: 'long', timeZone: 'UTC' })}`; };
const hoyEmp = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
const waNum = (t) => { let n = String(t || '').replace(/\D/g, ''); if (n.length === 8) n = '502' + n; return n; };
const ESTADO_PEDIDO_CLASE = { pendiente: 'etiqueta-gris', esperando: 'etiqueta-azul', confirmado: 'etiqueta-completa', en_vaelo: 'etiqueta-azul', enviado: 'etiqueta-gris', vencido: 'etiqueta-pendiente', no_puede: 'etiqueta-pendiente' };
const ESTADO_ENVIO_EMP = { pendiente: 'Por recoger', recogido: 'Recogido', en_camino: 'En camino', entregado: 'Entregado', fallido: 'No se entregó', a_sede: 'Va a la sede', en_sede: 'En la sede de Vaelo', devuelto: 'Devuelto', reenviado: 'Reenviado', cancelado: 'Cancelado' };

async function panelEmpresa(caja) {
  const yo = (await api('/api/yo')).usuario;
  let bono = null; try { bono = await api('/api/empresa/bono'); } catch { /* sin bono */ }
  const conBono = !!(bono && bono.activo);
  const pedida = new URLSearchParams(location.search).get('vista');
  let vista = pedida === 'analitica' ? 'analitica' : pedida === 'ganancias' && conBono ? 'ganancias' : 'pedidos';
  const cuerpo = el('div');
  const pest = el('div', { class: 'pestanas', role: 'tablist' });
  const pintarPest = () => poner(pest, ...[['pedidos', 'Carpetas de envíos'], ['analitica', 'Analítica'], conBono ? ['ganancias', 'Tus ganancias'] : null].filter(Boolean).map(([k, t]) =>
    el('button', { type: 'button', role: 'tab', 'aria-selected': String(vista === k), text: t, onclick: () => { vista = k; pintarPest(); abrir(); } })));
  const abrir = () => (vista === 'pedidos' ? panelPedidos(cuerpo, yo) : vista === 'ganancias' ? panelGanancias(cuerpo) : panelAnalitica(cuerpo));
  poner(caja, 
    el('div', { class: 'empresa-cabecera' }, el('div', {}, el('span', { class: 'etiqueta-completa', text: 'Contrato firmado' }), el('h2', { text: yo.empresa_nombre || yo.nombre }),
      el('p', { class: 'pista', text: 'Vaelo te presta sus pilotos: cada cliente paga su envío al recibir. Tu empresa solo paga si eliges pickup pagado por ti o si un paquete se queda en la sede.' }),
      yo.recogida_dias ? el('p', { class: 'recogida-fija' }, icono('reloj'), ` Pasamos por tus paquetes: ${yo.recogida_dias.split(',').map(d => ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][d]).join(', ')} a las ${yo.recogida_hora}.`) : null),
      el('a', { class: 'boton borde chico', href: '/politicas-empresas', target: '_blank', text: 'Políticas para empresas' })),
    conBono && bono.por_envio > 0 ? el('button', { type: 'button', class: 'bono-franja', onclick: () => { vista = 'ganancias'; pintarPest(); abrir(); } },
      el('span', { class: 'bono-franja-q', text: dinero(bono.por_envio) }),
      el('span', {}, el('strong', { text: `Ganas ${dinero(bono.por_envio)} por cada envío entregado` }), el('small', { text: `Este mes llevas ${dinero(bono.mes)} (${bono.entregas_mes} entregas). Ver tus ganancias` }))) : null,
    pest, cuerpo);
  pintarPest(); abrir();
}

// ---------- Tus ganancias: lo que gana la empresa por sus envíos entregados (solo sus cifras) ----------
async function panelGanancias(caja) {
  poner(caja, el('p', { class: 'pista', text: 'Cargando…' }));
  let b; try { b = await api('/api/empresa/bono'); } catch (e) { poner(caja, el('div', { class: 'mensaje error', text: e.message })); return; }
  const cifra = (t, v, s, fuerte) => el('div', { class: 'bono-cifra' + (fuerte ? ' fuerte' : '') }, el('span', { text: t }), el('strong', { text: v }), s ? el('small', { text: s }) : null);
  poner(caja,
    el('div', { class: 'bono-cabeza' },
      el('div', {}, el('h3', { text: 'Tus ganancias con Vaelo' }),
        el('p', { class: 'pista', text: b.por_envio > 0 ? `Por cada envío que entregamos de tu empresa ganas ${dinero(b.por_envio)}. ${b.modo === 'descuento' ? 'Lo que acumulas se descuenta de tus envíos.' : 'Lo que acumulas se te paga.'}` : 'Tu bono por envío está en pausa. Lo acumulado sigue siendo tuyo.' })),
      el('span', { class: 'etiqueta-azul', text: b.modo_texto })),
    el('div', { class: 'bono-cifras' },
      cifra('Por recibir', dinero(b.pendiente), `${b.entregas_pendientes} entregas`, true),
      cifra('Este mes', dinero(b.mes), `${b.entregas_mes} entregas`),
      cifra(b.modo === 'descuento' ? 'Ya descontado' : 'Ya recibido', dinero(b.recibido)),
      cifra('Total ganado', dinero(b.total), `${b.entregas_total} entregas`)),
    b.liquidaciones.length ? el('div', { class: 'bloque', style: 'margin-top:1rem' }, el('h3', { style: 'font-size:1.05rem', text: 'Pagos y descuentos' }),
      el('ul', { class: 'bono-lista' }, b.liquidaciones.map((l) => el('li', {}, el('span', { text: `${fecha(l.creado, false)} · ${l.entregas} entregas · ${l.modo === 'descuento' ? 'Descontado' : 'Pagado'}` }), el('strong', { text: dinero(l.monto) }))))) : null,
    b.ultimos.length ? el('div', { class: 'bloque', style: 'margin-top:1rem' }, el('h3', { style: 'font-size:1.05rem', text: 'Últimas entregas que te sumaron' }),
      el('ul', { class: 'bono-lista' }, b.ultimos.map((x) => el('li', {}, el('span', { text: `${x.guia} · ${x.destino_nombre}` }), el('strong', { text: '+' + dinero(x.monto) }))))) :
      el('p', { class: 'pista', style: 'margin-top:1rem', text: 'Cuando entreguemos tus envíos, aquí verás cada uno.' }));
}

// ---------- Carpetas de envíos ----------
// La empresa crea una carpeta con el día de entrega y adentro añade sus envíos. Cada cliente confirma con su enlace
// (horario, ubicación y quién recibe). Con el mínimo de confirmados, la carpeta se manda a Vaelo.
const textoEnlace = (p, r, dia) => `Hola ${p.cliente_nombre.split(' ')[0]}, ${r.empresa} te enviará tu pedido (${p.descripcion}) con Vaelo el ${diaEmp(dia || p.dia)}. Confirma aquí tu horario, dónde lo recibes y quién lo recibe: ${location.origin + p.enlace}`;
function progresoCarpeta(c) {
  const pct = Math.min(100, Math.round((c.confirmados / c.minimo) * 100));
  return el('div', { class: 'carpeta-progreso' },
    el('div', { class: 'progreso-barra' + (c.confirmados >= c.minimo ? ' completo' : '') }, el('i', { style: `width:${pct}%` })),
    el('small', { text: c.confirmados >= c.minimo ? `${c.confirmados} confirmados: lista para mandar` : `${c.confirmados} de ${c.minimo} confirmados para mandarla` }));
}
async function panelPedidos(caja, yo, abrirId) {
  if (abrirId) return vistaCarpeta(caja, yo, abrirId);
  poner(caja, el('p', { class: 'pista', text: 'Cargando tus carpetas…' }));
  let r;
  try { r = await api('/api/empresa/carpetas'); } catch (e) { poner(caja, el('div', { class: 'mensaje error', text: e.message })); return; }
  const abrir = (id) => vistaCarpeta(caja, yo, id);
  const nueva = el('button', { class: 'boton', type: 'button' }, icono('mas'), ' Nueva carpeta');
  nueva.addEventListener('click', () => dialogoCarpeta(null, r, (c) => abrir(c.id)));
  const tarjeta = (c) => el('button', { class: 'carpeta-tarjeta' + (c.confirmados >= c.minimo && c.estado === 'abierta' ? ' lista' : ''), type: 'button', onclick: () => abrir(c.id) },
    el('span', { class: 'carpeta-icono', 'aria-hidden': 'true' }, icono('carpeta')),
    el('span', { class: 'carpeta-datos' }, el('strong', { text: c.nombre }), el('small', { text: `Entrega: ${diaEmp(c.dia)}` }),
      c.estado === 'abierta' && c.dia < r.hoy ? el('small', { class: 'error-texto', text: 'El día ya pasó: abre la carpeta y cambia la fecha.' }) : null,
      c.estado === 'abierta' ? progresoCarpeta(c) : el('small', { class: 'carpeta-lote' }, el('b', { text: { nuevo: 'Vaelo la está preparando', en_ruta: 'En reparto', terminado: 'Terminada' }[c.lote?.estado] || 'Enviada' }),
        c.lote ? ` · ${c.lote.entregados} de ${c.total} entregados${c.lote.en_sede ? ` · ${c.lote.en_sede} en la sede` : ''}` : ''),
      c.estado === 'abierta' ? el('small', { text: [`${c.total} envío${c.total === 1 ? '' : 's'}`, c.esperando ? `${c.esperando} esperando a su cliente` : '', c.no_puede ? `${c.no_puede} no pueden ese día` : ''].filter(Boolean).join(' · ') }) : null),
    el('span', { class: 'carpeta-abrir', text: 'Abrir' }));
  const vacio = el('div', { class: 'carpetas-vacio' },
    el('h3', { text: 'Así mandas varios envíos' }),
    el('ol', { class: 'pasos-carpeta' },
      el('li', {}, el('strong', { text: 'Crea una carpeta' }), el('span', { text: 'con el día en que quieres que se entreguen.' })),
      el('li', {}, el('strong', { text: 'Añade tus envíos' }), el('span', { text: 'uno por uno. A cada cliente le mandas su enlace por WhatsApp.' })),
      el('li', {}, el('strong', { text: 'Tus clientes confirman' }), el('span', { text: 'su horario, dónde lo reciben y quién lo recibe.' })),
      el('li', {}, el('strong', { text: `Con ${r.minimo} confirmados, envíala a Vaelo` }), el('span', { text: 'y nosotros armamos las rutas.' }))));
  poner(caja, bloquePunto(r),
    el('section', { class: 'bloque' },
      el('div', { class: 'cab-bloque' }, el('div', {}, el('h2', { text: 'Tus carpetas de envíos' }), el('p', { class: 'pista', text: 'Una carpeta por día de entrega.' })), nueva),
      r.abiertas.length ? el('div', { class: 'carpetas' }, r.abiertas.map(tarjeta)) : vacio),
    r.enviadas.length ? el('section', { class: 'bloque' }, el('h2', { text: 'Enviadas a Vaelo' }), el('div', { class: 'carpetas' }, r.enviadas.map(tarjeta))) : null);
}
// Punto de recogida: donde el piloto pasa por los paquetes
function bloquePunto(r) {
  const punto = el('section', { class: 'bloque recogida-empresa' });
  const pintarPunto = (editar) => {
    if (!editar && r.punto) {
      poner(punto, icono('sede'), el('div', {}, el('strong', { text: 'Los pilotos recogen en' }), el('span', { text: r.punto.direccion })),
        el('button', { class: 'boton borde chico', type: 'button', text: 'Cambiar', onclick: () => pintarPunto(true) }));
      return;
    }
    const msg = el('div', { class: 'mensaje', role: 'alert' });
    const dir = el('input', { maxlength: 300, value: r.punto?.direccion || '', placeholder: 'Dirección de tu local o bodega' });
    const mapa = el('div');
    let p = r.punto ? { lat: r.punto.lat, lng: r.punto.lng } : null;
    poner(punto, el('div', { style: 'flex:1' }, el('h3', { text: '¿Dónde recoge el piloto tus paquetes?' }), el('p', { class: 'pista', text: 'Marca tu local o bodega. Desde aquí se arman las rutas.' }),
      mapa, el('div', { class: 'campo' }, el('label', { text: 'Dirección' }), dir), msg,
      el('div', { class: 'navegar' }, el('button', { class: 'boton chico', type: 'button', text: 'Guardar', onclick: async () => {
        try { if (!p) throw new Error('Marca el punto en el mapa.'); const x = await api('/api/empresa/punto', { method: 'PUT', body: { lat: p.lat, lng: p.lng, direccion: dir.value } }); r.punto = x.punto; pintarPunto(false); }
        catch (e) { mostrarMensaje(msg, e.message); }
      } }), r.punto ? el('button', { class: 'boton borde chico', type: 'button', text: 'Cancelar', onclick: () => pintarPunto(false) }) : null)));
    const sel = selectorPunto(mapa, { letra: 'A', clase: 'recogida', conMiUbicacion: true, alCambiar: (x) => { p = x; }, alDireccion: (t, usar) => { if (usar || !dir.value) dir.value = t; } });
    if (p) sel.poner(p.lat, p.lng);
  };
  pintarPunto(false);
  return punto;
}
// Nueva carpeta o cambiar nombre y día
function dialogoCarpeta(c, r, alGuardar) {
  const dlg = el('dialog', { class: 'dialogo' });
  const msg = el('div', { class: 'mensaje', role: 'alert' });
  const sumar = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
  let dia = c ? c.dia : sumar(r.hoy || hoyEmp(), 1);
  const otro = el('input', { type: 'date', min: r.hoy || hoyEmp(), value: dia, 'aria-label': 'Otro día' });
  const chips = el('div', { class: 'opciones' });
  const pintarDias = () => poner(chips, ...Array.from({ length: 5 }, (_, i) => sumar(r.hoy || hoyEmp(), i)).map((x, i) => el('label', { class: 'opcion' },
    el('input', { type: 'radio', name: 'dia-carpeta', value: x, checked: dia === x, onchange: () => { dia = x; otro.value = x; } }),
    el('span', {}, i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : diaEmp(x).split(' ')[0].replace(/^./, (l) => l.toUpperCase()), el('small', { text: diaEmp(x).split(' ').slice(1).join(' ') })))));
  otro.addEventListener('change', () => { dia = otro.value; pintarDias(); });
  pintarDias();
  const nombre = el('input', { maxlength: 60, value: c ? c.nombre : '', placeholder: 'Opcional, ej. Pedidos de la semana' });
  dlg.append(el('button', { class: 'cerrar', type: 'button', 'aria-label': 'Cerrar', text: '×', onclick: () => dlg.close() }),
    el('h2', { text: c ? 'Cambiar carpeta' : 'Nueva carpeta' }),
    el('div', { class: 'campo' }, el('label', { text: '¿Qué día se entregan?' }), chips, el('div', { style: 'margin-top:.6rem;max-width:220px' }, otro)),
    c && c.confirmados ? el('p', { class: 'pista', text: 'Si cambias el día, los clientes que ya confirmaron tienen que confirmar de nuevo.' }) : null,
    el('div', { class: 'campo' }, el('label', { text: 'Nombre' }), nombre), msg,
    el('button', { class: 'boton accion-principal', type: 'button', text: c ? 'Guardar' : 'Crear carpeta', onclick: async (ev) => {
      ev.target.disabled = true;
      try {
        const x = c ? await api(`/api/empresa/carpetas/${c.id}`, { method: 'PUT', body: { nombre: nombre.value, dia } }) : await api('/api/empresa/carpetas', { body: { nombre: nombre.value, dia } });
        dlg.close(); alGuardar(x.carpeta);
      } catch (e) { mostrarMensaje(msg, e.message); ev.target.disabled = false; }
    } }));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}
// Adentro de una carpeta
async function vistaCarpeta(caja, yo, id) {
  poner(caja, el('p', { class: 'pista', text: 'Abriendo la carpeta…' }));
  let r;
  try { r = await api(`/api/empresa/carpetas/${id}`); } catch (e) { poner(caja, el('div', { class: 'mensaje error', text: e.message })); return; }
  const c = r.carpeta, abierta = c.estado === 'abierta';
  const recargar = () => vistaCarpeta(caja, yo, id);
  const volver = () => panelPedidos(caja, yo);
  const listo = abierta && c.confirmados >= c.minimo;
  const anadir = el('button', { class: 'boton boton-grande', type: 'button', onclick: () => dialogoNuevoEnvio(c, r, recargar) }, icono('mas'), ' Añadir envío');
  const archivo = el('input', { type: 'file', accept: '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv', hidden: true });
  const msgArchivo = el('div', { class: 'mensaje', role: 'alert' });
  archivo.addEventListener('change', async () => {
    const f = archivo.files[0]; if (!f) return;
    try {
      const datos = await new Promise((ok, mal) => { const lector = new FileReader(); lector.onload = () => ok(lector.result); lector.onerror = mal; lector.readAsDataURL(f); });
      const res = await fetch(`/api/empresa/carpetas/${c.id}/archivo`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archivo: datos }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { mostrarMensaje(msgArchivo, d.errores ? 'Revisa el archivo: ' + d.errores.slice(0, 6).join(' · ') : (d.error || 'No se pudo leer.')); return; }
      mostrarMensaje(msgArchivo, `Listo: ${d.creados} envíos en la carpeta. Ahora manda a cada cliente su enlace.`, 'exito');
      setTimeout(recargar, 1500);
    } catch (e) { mostrarMensaje(msgArchivo, e.message); }
    archivo.value = '';
  });
  const orden = { no_puede: 0, vencido: 0, pendiente: 1, esperando: 2, confirmado: 3 };
  const pedidos = c.pedidos.slice().sort((a, b) => (orden[a.estado] ?? 4) - (orden[b.estado] ?? 4));
  const cabecera = el('div', { class: 'carpeta-cabecera' },
    el('button', { class: 'enlace-volver', type: 'button', onclick: volver, text: '← Tus carpetas' }),
    el('div', { class: 'carpeta-titulo' }, el('div', {}, el('h2', { text: c.nombre }), el('p', { class: 'pista', text: `Entrega: ${diaEmp(c.dia)}` })),
      abierta ? el('div', { class: 'navegar' },
        el('button', { class: 'boton borde chico', type: 'button', text: 'Cambiar día o nombre', onclick: () => dialogoCarpeta(c, r, recargar) }),
        el('button', { class: 'boton-icono', type: 'button', title: 'Eliminar carpeta', 'aria-label': 'Eliminar carpeta', onclick: async () => {
          if (!confirm(`¿Eliminar la carpeta «${c.nombre}» y sus ${c.total} envíos?`)) return;
          await api(`/api/empresa/carpetas/${c.id}`, { method: 'DELETE' }).catch((e) => alert(e.message)); volver();
        } }, '×')) : null));
  const estadoCaja = abierta
    ? el('section', { class: 'bloque carpeta-estado' + (listo ? ' lista' : '') },
      el('div', {}, el('strong', { class: 'carpeta-cifra', text: `${c.confirmados}` }), el('span', { text: ` de ${c.minimo} confirmados` }), progresoCarpeta(c),
        c.dia < r.hoy ? el('small', { class: 'error-texto', text: 'El día de entrega ya pasó. Toca «Cambiar día o nombre» y tus clientes confirman la nueva fecha.' }) : null,
        !r.punto ? el('small', { class: 'error-texto', text: 'Marca primero dónde recoge el piloto tus paquetes (en Tus carpetas).' }) : null,
        c.sin_foto ? el('small', { text: `Falta la foto de ${c.sin_foto} paquete(s).` }) : null),
      listo ? el('button', { class: 'boton cinta boton-grande', type: 'button', text: 'Enviar a Vaelo', onclick: () => dialogoEnviar(c, r, recargar) })
        : el('p', { class: 'pista', text: `Cuando ${c.minimo - c.confirmados === 1 ? 'falte 0' : 'tengas ' + c.minimo} confirmados aparece «Enviar a Vaelo».`.replace('falte 0', 'confirme uno más') }))
    : el('section', { class: 'bloque carpeta-estado' }, el('div', {},
      el('strong', { text: { nuevo: 'Vaelo la está preparando', en_ruta: 'En reparto', terminado: 'Terminada', cancelado: 'Cancelada' }[c.lote?.estado] || 'Enviada a Vaelo' }),
      c.lote ? el('small', { text: `${c.lote.modo_texto} · ${c.lote.entregados} de ${c.total} entregados${c.lote.en_camino ? ` · ${c.lote.en_camino} en camino` : ''}${c.lote.en_sede ? ` · ${c.lote.en_sede} en la sede de Vaelo` : ''}` }) : null),
      el('a', { class: 'boton borde chico', href: `/api/empresa/excel?dia=${c.dia}`, text: 'Excel del día' }));
  poner(caja, cabecera, estadoCaja,
    abierta ? el('div', { class: 'carpeta-acciones' }, anadir,
      el('div', { class: 'navegar' }, el('label', { class: 'boton borde chico doc-boton' }, 'Subir Excel', archivo), el('a', { class: 'boton borde chico', href: '/api/empresa/pedidos/plantilla', text: 'Plantilla' }))) : null,
    msgArchivo,
    el('section', { class: 'bloque' },
      el('div', { class: 'cab-bloque' }, el('h2', { text: `Envíos (${pedidos.length})` }),
        el('div', { class: 'navegar' },
          abierta && pedidos.some((p) => ['pendiente', 'esperando'].includes(p.estado)) ? el('button', { class: 'boton cinta chico', type: 'button', text: `Recordar a los que faltan (${pedidos.filter((p) => ['pendiente', 'esperando'].includes(p.estado)).length})`,
            onclick: () => dialogoRecordar(pedidos.filter((p) => ['pendiente', 'esperando'].includes(p.estado)), r, c) }) : null,
          pedidos.length ? el('button', { class: 'boton borde chico', type: 'button', text: 'Imprimir etiquetas', onclick: () => imprimirEtiquetas(pedidos, r.empresa) }) : null)),
      pedidos.length ? el('ul', { class: 'pedidos-lista' }, pedidos.map((p) => filaPedido(p, r, c, recargar)))
        : el('div', { class: 'carpetas-vacio' }, el('p', { text: 'La carpeta está vacía. Toca «Añadir envío» para registrar el primero.' }))));
}

function filaPedido(p, r, c, recargar) {
  const enlace = location.origin + p.enlace;
  const fotoInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: async () => {
    try { await api(`/api/empresa/pedidos/${p.id}/foto`, { body: { foto: await prepararArchivo(fotoInput.files[0], false) } }); recargar(); } catch (e) { alert(e.message); }
  } });
  const mandar = async () => { api(`/api/empresa/pedidos/${p.id}/enlace`, { body: {} }).catch(() => {}); };
  const e = p.envio;
  const editable = ['pendiente', 'esperando', 'confirmado', 'vencido', 'no_puede'].includes(p.estado) && !p.lote_id;
  const wa = `https://wa.me/${waNum(p.cliente_telefono)}?text=${encodeURIComponent(textoEnlace(p, r, c.dia))}`;
  // Una acción principal a la vista; el resto en el menú "⋯"
  const principal = !editable ? null
    : p.estado === 'confirmado' ? null
    : !p.tiene_foto ? el('label', { class: 'boton cinta chico doc-boton' }, 'Tomar foto', fotoInput)
    : el('a', { class: 'boton cinta chico', href: wa, target: '_blank', rel: 'noopener', onclick: mandar, text: p.estado === 'esperando' ? 'Recordar' : 'Mandar enlace' });
  const opciones = editable ? [
    p.tiene_foto && p.estado !== 'confirmado' ? null : el('a', { href: wa, target: '_blank', rel: 'noopener', onclick: mandar, text: p.estado === 'confirmado' ? 'Mandar enlace otra vez' : 'Mandar enlace por WhatsApp' }),
    el('button', { type: 'button', text: 'Copiar enlace', onclick: async (ev) => { mandar(); try { await navigator.clipboard.writeText(enlace); ev.target.textContent = 'Enlace copiado'; } catch { prompt('Enlace:', enlace); } } }),
    el('button', { type: 'button', text: p.estado === 'confirmado' ? 'Editar datos de entrega' : 'Llenar yo los datos', onclick: () => dialogoLlenar(p, r, c, recargar) }),
    p.tiene_foto ? el('label', { class: 'doc-boton' }, 'Cambiar foto', fotoInput) : null,
    el('button', { type: 'button', text: 'Mover a otra carpeta', onclick: () => dialogoMover(p, r, c, recargar) }),
    el('button', { type: 'button', class: 'peligro-texto', text: 'Quitar de la carpeta', onclick: async () => {
      if (!confirm(`¿Quitar el envío de ${p.cliente_nombre}?`)) return;
      await api(`/api/empresa/pedidos/${p.id}`, { method: 'DELETE' }).catch((x) => alert(x.message)); recargar();
    } })] : [];
  const menu = opciones.length ? el('details', { class: 'menu-acciones' }, el('summary', { 'aria-label': 'Más opciones', title: 'Más opciones' }, '⋯'), el('div', { class: 'menu-lista' }, opciones)) : null;
  return el('li', { class: 'pedido-fila' },
    el('div', { class: 'pedido-info' },
      el('div', {}, el('strong', { text: p.cliente_nombre }), ' ', el('span', { class: ESTADO_PEDIDO_CLASE[p.estado] || 'etiqueta-gris', text: p.estado_texto }),
        !p.tiene_foto && editable ? el('span', { class: 'etiqueta-pendiente', style: 'margin-left:.3rem', text: 'Falta foto' }) : null,
        p.avisos ? el('span', { class: 'etiqueta-azul', style: 'margin-left:.3rem', title: 'Tu cliente activó los avisos', text: 'Avisos activos' }) : null),
      el('small', { text: `${p.codigo} · ${p.descripcion} · ${p.tamano_texto}` }),
      p.estado === 'confirmado' || p.lote_id ? el('small', { text: `${p.horario_texto}${p.zona ? ' · ' + p.zona : ''}${p.direccion ? ' · ' + p.direccion : ''}` }) : null,
      p.estado === 'no_puede' ? el('small', { class: 'error-texto', text: `No puede ese día${p.no_puede_nota ? ': ' + p.no_puede_nota : ''}. Muévelo a otra carpeta desde «⋯».` }) : null,
      e ? el('small', { class: 'pedido-envio' }, el('b', { text: ESTADO_ENVIO_EMP[e.estado] || e.estado }),
        e.piloto ? ` · ${e.piloto}` : '', e.paradas > 1 ? ` · entrega ${e.parada} de ${e.paradas}` : '', e.recibio ? ` · recibió ${e.recibio}` : '',
        e.fallo ? ` · ${e.fallo}` : '', e.dias_sede ? ` · ${e.dias_sede} día(s) en la sede: pasa a recogerlo con el código` : '') : null),
    el('div', { class: 'pedido-acciones' }, principal, menu));
}
// Mover un envío a otra carpeta (otro día)
async function dialogoMover(p, r, c, recargar) {
  let lista;
  try { lista = await api('/api/empresa/carpetas'); } catch (e) { alert(e.message); return; }
  const otras = lista.abiertas.filter((x) => x.id !== c.id);
  const dlg = el('dialog', { class: 'dialogo' });
  const msg = el('div', { class: 'mensaje', role: 'alert' });
  const mover = (id) => async (ev) => {
    ev.target.disabled = true;
    try {
      const x = await api(`/api/empresa/pedidos/${p.id}/carpeta`, { method: 'PUT', body: { carpeta_id: id } });
      dlg.close(); recargar();
      if (x.reconfirmar) alert(`Listo. Mándale el enlace otra vez a ${p.cliente_nombre} para que confirme la nueva fecha.`);
    } catch (e) { mostrarMensaje(msg, e.message); ev.target.disabled = false; }
  };
  dlg.append(el('button', { class: 'cerrar', type: 'button', 'aria-label': 'Cerrar', text: '×', onclick: () => dlg.close() }),
    el('h2', { text: `Mover a ${p.cliente_nombre}` }), el('p', { class: 'pista', text: 'Elige la carpeta del día en que se va a entregar.' }), msg,
    otras.length ? el('div', { class: 'lista-mover' }, otras.map((x) => el('button', { class: 'opcion-mover', type: 'button', onclick: mover(x.id) },
      el('strong', { text: x.nombre }), el('small', { text: `Entrega ${diaEmp(x.dia)} · ${x.total} envío(s)` })))) : el('p', { text: 'No tienes otra carpeta abierta.' }),
    el('button', { class: 'boton borde', type: 'button', style: 'margin-top:1rem', text: '+ Crear carpeta nueva y mover', onclick: () => { dlg.close(); dialogoCarpeta(null, r, async (nueva) => { try { const x = await api(`/api/empresa/pedidos/${p.id}/carpeta`, { method: 'PUT', body: { carpeta_id: nueva.id } }); recargar(); if (x.reconfirmar) alert(`Listo. Mándale el enlace otra vez a ${p.cliente_nombre} para que confirme la nueva fecha.`); } catch (e) { alert(e.message); } }); } }));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}
// Recordar a todos los que no han confirmado: un botón de WhatsApp por cliente, en una sola lista
function dialogoRecordar(pedidos, r, c) {
  const dlg = el('dialog', { class: 'dialogo hoja' });
  dlg.append(el('button', { class: 'cerrar', type: 'button', 'aria-label': 'Cerrar', text: '×', onclick: () => dlg.close() }),
    el('h2', { text: 'Recordar a los que faltan' }), el('p', { class: 'pista', text: 'Toca cada uno: se abre WhatsApp con el mensaje y su enlace.' }),
    el('ul', { class: 'caja-enlaces' }, pedidos.map((p) => el('li', {}, el('span', {}, el('strong', { text: p.cliente_nombre }), el('small', { text: `${p.estado_texto} · ${p.descripcion}` })),
      el('a', { class: 'boton cinta chico', href: `https://wa.me/${waNum(p.cliente_telefono)}?text=${encodeURIComponent(textoEnlace(p, r, c.dia))}`, target: '_blank', rel: 'noopener',
        onclick: (ev) => { api(`/api/empresa/pedidos/${p.id}/enlace`, { body: {} }).catch(() => {}); ev.currentTarget.textContent = 'Enviado ✓'; ev.currentTarget.classList.replace('cinta', 'borde'); }, text: 'Mandar' })))));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}
// Pegar el mensaje de WhatsApp del cliente y sacar nombre, teléfono, dirección y zona
function leerMensajeCliente(texto) {
  const t = String(texto || '').replace(/\r/g, '');
  const out = {};
  const tel = t.match(/(?:\+?502[\s-]?)?(\d{4})[\s-]?(\d{4})/);
  if (tel) out.telefono = tel[1] + tel[2];
  const zona = t.match(/zona\s*(\d{1,2})/i);
  if (zona) out.zona = 'Zona ' + Number(zona[1]);
  const lineas = t.split(/\n|,(?=\s*[A-Za-zÁÉÍÓÚÑáéíóúñ])/).map((x) => x.replace(/^[\s\-•*]*(nombre|tel[eé]fono|cel|whats\w*|direcci[oó]n|dir)\s*[:.]?\s*/i, '').trim()).filter(Boolean);
  const dir = lineas.find((l) => /\b(calle|avenida|av\.?|ave\.?|zona|colonia|col\.?|km|lote|casa|apto|edificio|residencial|calz)\b/i.test(l) && !/^\+?\d[\d\s-]{7,}$/.test(l));
  if (dir) out.direccion = dir.slice(0, 300);
  const nombre = lineas.find((l) => l !== dir && !/\d{4}/.test(l) && /^[A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ.\s]{2,60}$/.test(l));
  if (nombre) out.nombre = nombre.replace(/\s+/g, ' ');
  return out;
}

// "Añadir envío": lo mínimo del paquete y del cliente. Después se manda el enlace o lo llena la empresa.
function dialogoNuevoEnvio(c, r, recargar) {
  const dlg = el('dialog', { class: 'dialogo hoja' });
  const msg = el('div', { class: 'mensaje', role: 'alert' });
  const desc = el('input', { id: 'np-desc', maxlength: 200, placeholder: 'Blusa talla M, factura, caja de zapatos…' });
  let tamano = 'pequeno';
  const tamanos = el('div', { class: 'opciones' }, ...Object.entries(r.tamanos).map(([k, t]) => el('label', { class: 'opcion' },
    el('input', { type: 'radio', name: 'np-tamano', value: k, checked: k === tamano, onchange: () => { tamano = k; } }), el('span', {}, t.nombre, el('small', { text: t.ayuda })))));
  const nombre = el('input', { id: 'np-nombre', maxlength: 100, autocomplete: 'off' });
  const tel = el('input', { id: 'np-tel', type: 'tel', maxlength: 30, placeholder: '5555 5555' });
  const foto = el('input', { id: 'np-foto', type: 'file', accept: 'image/*', capture: 'environment' });
  const vistaFoto = el('img', { alt: '', hidden: true });
  const vacio = el('span', { class: 'foto-paquete-vacio' }, el('strong', { text: 'Foto del paquete' }), el('small', { text: 'Tócala para tomarla' }));
  foto.addEventListener('change', () => { if (foto.files[0]) { vistaFoto.src = URL.createObjectURL(foto.files[0]); vistaFoto.hidden = false; vacio.hidden = true; } });
  const datosEntrega = camposEntrega({}, r, c);
  datosEntrega.nodo.hidden = true;
  let llenar = false;
  const modos = el('div', { class: 'opciones' }, ...[[false, 'Le mando el enlace', 'Tu cliente confirma horario, lugar y quién recibe'], [true, 'Lo lleno yo', 'Ya tengo su dirección y horario']].map(([v, t, a]) =>
    el('label', { class: 'opcion' }, el('input', { type: 'radio', name: 'np-modo', checked: llenar === v, onchange: () => { llenar = v; datosEntrega.nodo.hidden = !v; if (v) datosEntrega.refrescar(); guardar.textContent = v ? 'Guardar envío' : 'Guardar y mandar enlace'; } }),
      el('span', {}, t, el('small', { text: a })))));
  const guardar = el('button', { class: 'boton accion-principal', type: 'submit', text: 'Guardar y mandar enlace' });
  const otroChk = el('input', { type: 'checkbox', id: 'np-otro', style: 'width:auto', checked: true });
  const otro = el('label', { class: 'casilla', for: 'np-otro' }, otroChk, el('span', { text: 'Después de guardar, añadir otro' }));
  // Pegar el mensaje del cliente (nombre, teléfono, dirección) y se llenan solos los campos
  const pegado = el('textarea', { rows: 3, placeholder: 'Pega aquí lo que te mandó tu cliente por WhatsApp, ej.\nMaría López\n5555 1234\n7a avenida 10-25, zona 1' });
  const cajaPegar = el('div', { class: 'pegar-mensaje', hidden: true }, pegado, el('small', { class: 'pista', text: 'Revisa que los datos queden bien.' }));
  pegado.addEventListener('input', () => {
    const d = leerMensajeCliente(pegado.value);
    if (d.nombre) nombre.value = d.nombre;
    if (d.telefono) tel.value = d.telefono;
    if (d.direccion || d.zona) { datosEntrega.prellenar(d); if (!llenar) modos.querySelectorAll('input')[1].click(); }
  });
  const form = el('form', { novalidate: true },
    el('button', { class: 'boton borde chico', type: 'button', style: 'margin-bottom:.6rem', text: '📋 Pegar datos de WhatsApp', onclick: () => { cajaPegar.hidden = !cajaPegar.hidden; if (!cajaPegar.hidden) pegado.focus(); } }), cajaPegar,
    el('div', { class: 'campo' }, el('label', { for: 'np-desc', text: '¿Qué es el paquete?' }), desc),
    el('div', { class: 'campo' }, el('label', { text: 'Tamaño' }), tamanos),
    el('div', { class: 'foto-paquete foto-paquete-chica' }, el('label', { class: 'foto-paquete-boton', for: 'np-foto' }, vistaFoto, vacio, foto)),
    el('div', { class: 'fila' }, el('div', { class: 'campo' }, el('label', { for: 'np-nombre', text: 'Nombre de tu cliente' }), nombre), el('div', { class: 'campo' }, el('label', { for: 'np-tel', text: 'WhatsApp de tu cliente' }), tel)),
    el('div', { class: 'campo' }, el('label', { text: 'Datos de entrega' }), modos), datosEntrega.nodo, msg, otro, guardar);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    guardar.disabled = true;
    // WhatsApp se abre ya: si se abre después de esperar al servidor, el navegador lo bloquea
    const ventana = !llenar ? window.open('about:blank', '_blank') : null;
    try {
      const body = { descripcion: desc.value, tamano, cliente_nombre: nombre.value, cliente_telefono: tel.value };
      if (foto.files[0]) body.foto = await prepararArchivo(foto.files[0], false);
      if (llenar) Object.assign(body, datosEntrega.leer(), { llenar: true });
      const p = (await api(`/api/empresa/carpetas/${c.id}/pedidos`, { body })).pedido;
      if (ventana) { ventana.location.href = `https://wa.me/${waNum(p.cliente_telefono)}?text=${encodeURIComponent(textoEnlace(p, r, c.dia))}`; api(`/api/empresa/pedidos/${p.id}/enlace`, { body: {} }).catch(() => {}); }
      if (otroChk.checked) {
        desc.value = ''; nombre.value = ''; tel.value = ''; foto.value = ''; vistaFoto.hidden = true; vacio.hidden = false;
        mostrarMensaje(msg, `Listo: ${p.cliente_nombre} quedó en la carpeta. Añade el siguiente.`, 'exito'); desc.focus(); guardar.disabled = false; dlg.dataset.cambios = '1';
      } else { dlg.close(); recargar(); }
    } catch (e) { if (ventana) ventana.close(); mostrarMensaje(msg, e.message); guardar.disabled = false; }
  });
  dlg.append(el('button', { class: 'cerrar', type: 'button', 'aria-label': 'Cerrar', text: '×', onclick: () => dlg.close() }),
    el('h2', { text: 'Añadir envío' }), el('p', { class: 'pista', text: `${c.nombre} · entrega ${diaEmp(c.dia)}` }), form);
  dlg.addEventListener('close', () => { dlg.remove(); if (dlg.dataset.cambios) recargar(); });
  document.body.append(dlg); dlg.showModal(); desc.focus();
}

// Campos de entrega cuando la empresa los llena (el día es el de la carpeta)
function camposEntrega(p, r, c) {
  let horario = p.horario || 'cualquiera';
  const horarios = el('div', { class: 'opciones' }, ...Object.entries(r.horarios).map(([k, t]) => el('label', { class: 'opcion' },
    el('input', { type: 'radio', name: 'ce-horario-' + (p.id || 'n'), value: k, checked: horario === k, onchange: () => { horario = k; } }), el('span', { text: t }))));
  const zona = el('select', {}, el('option', { value: '', text: 'Elige…' }), ...(r.zonas || []).map((z) => el('option', { value: z, text: z, selected: p.zona === z })));
  const direccion = el('input', { maxlength: 300, value: p.direccion || '' });
  const referencias = el('input', { maxlength: 300, value: p.referencias || '', placeholder: 'Opcional' });
  const rn = el('input', { maxlength: 100, value: p.recibe_nombre || p.cliente_nombre || '' });
  const rt = el('input', { type: 'tel', maxlength: 30, value: p.recibe_telefono || p.cliente_telefono || '' });
  const mapa = el('div');
  let punto = p.lat != null ? { lat: p.lat, lng: p.lng } : null, sel = null;
  const nodo = el('div', { class: 'campos-entrega' },
    el('p', { class: 'pista', text: `Se entrega el ${diaEmp(c.dia)}. Quien recibe paga el envío en efectivo al piloto.` }),
    el('div', { class: 'campo' }, el('label', { text: 'Horario' }), horarios),
    mapa,
    el('div', { class: 'fila' }, el('div', { class: 'campo' }, el('label', { text: 'Zona o municipio' }), zona), el('div', { class: 'campo' }, el('label', { text: 'Dirección' }), direccion)),
    el('div', { class: 'campo' }, el('label', { text: 'Referencias' }), referencias),
    el('div', { class: 'fila' }, el('div', { class: 'campo' }, el('label', { text: 'Quién recibe' }), rn), el('div', { class: 'campo' }, el('label', { text: 'Su teléfono' }), rt)));
  const asegurarMapa = () => {
    if (sel) { sel.refrescar(); return; }
    sel = selectorPunto(mapa, { letra: 'B', clase: 'entrega', alCambiar: async (x) => {
      punto = x;
      try { const z = await api(`/api/zona?lat=${x.lat}&lng=${x.lng}`); if (z.zona) zona.value = z.zona; } catch { /* vacío */ }
    }, alDireccion: (t, usar) => { if (usar || !direccion.value) direccion.value = t; } });
    if (punto) sel.poner(punto.lat, punto.lng);
  };
  return { nodo, refrescar: asegurarMapa,
    prellenar: (d) => { if (d.direccion) direccion.value = d.direccion; if (d.zona && [...zona.options].some((o) => o.value === d.zona)) zona.value = d.zona; if (d.nombre) rn.value = d.nombre; if (d.telefono) rt.value = d.telefono; },
    leer: () => {
      if (!punto) throw new Error('Marca en el mapa dónde se entrega.');
      return { dia: c.dia, horario, lat: punto.lat, lng: punto.lng, zona: zona.value, direccion: direccion.value, referencias: referencias.value, recibe_nombre: rn.value, recibe_telefono: rt.value };
    } };
}
function dialogoLlenar(p, r, c, recargar) {
  const dlg = el('dialog', { class: 'dialogo hoja' });
  const msg = el('div', { class: 'mensaje', role: 'alert' });
  const campos = camposEntrega(p, r, c);
  dlg.append(el('button', { class: 'cerrar', type: 'button', 'aria-label': 'Cerrar', text: '×', onclick: () => dlg.close() }),
    el('h2', { text: `Envío de ${p.cliente_nombre}` }), el('p', { class: 'pista', text: `${p.codigo} · ${p.descripcion}` }), campos.nodo, msg,
    el('button', { class: 'boton', type: 'button', text: 'Guardar', onclick: async () => {
      try { await api(`/api/empresa/pedidos/${p.id}`, { method: 'PUT', body: campos.leer() }); dlg.close(); recargar(); } catch (e) { mostrarMensaje(msg, e.message); }
    } }));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal(); campos.refrescar();
}

// "Enviar a Vaelo": recomendación y las tres formas de repartir
async function dialogoEnviar(c, r, recargar) {
  const dlg = el('dialog', { class: 'dialogo hoja' });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
  dlg.append(el('p', { class: 'pista', text: 'Calculando la mejor forma de repartir…' }));
  let rec = null;
  try { rec = (await api(`/api/empresa/carpetas/${c.id}/recomendacion`)).recomendacion; } catch { /* sin recomendación */ }
  let modo = rec?.modo || 'una_moto', recogida = 'empresa', paga = 'clientes';
  const hayGrandes = c.grandes > 0;
  const OPC = [
    ['una_moto', 'Una moto para todo', ['Un solo piloto y una sola ruta', 'Ideal para sobres y paquetes pequeños', 'Cada cliente paga su envío al recibir']],
    ['motos', 'Varias motos', ['Varios pilotos a la vez, cada uno con su zona', 'Llega todo más rápido', 'Puede haber retrasos entre un piloto y otro']],
    ['pickup', 'Pickup', ['Un solo piloto para todos tus envíos', 'Para paquetes grandes o muchos bultos', 'El precio se acuerda por WhatsApp con Vaelo']],
  ];
  const msg = el('div', { class: 'mensaje', role: 'alert' });
  const extra = el('div');
  const tarjetas = el('div', { class: 'modos-envio' });
  const pintar = () => {
    poner(tarjetas, ...OPC.map(([k, t, ventajas]) => {
      const bloqueada = hayGrandes && k !== 'pickup';
      return el('label', { class: 'modo-tarjeta' + (modo === k ? ' activa' : '') + (bloqueada ? ' bloqueada' : '') },
        el('input', { type: 'radio', name: 'modo-lote', value: k, checked: modo === k, disabled: bloqueada, onchange: () => { modo = k; pintar(); } }),
        rec && rec.modo === k ? el('span', { class: 'modo-recomendado', text: 'Recomendado' }) : null,
        el('strong', { text: t }), el('ul', {}, ventajas.map((v) => el('li', { text: v }))),
        bloqueada ? el('small', { class: 'error-texto', text: 'Tienes paquetes grandes: solo van en pickup.' }) : null);
    }));
    poner(extra,
      el('h3', { text: '¿Cómo llegan los paquetes a Vaelo?' }),
      el('div', { class: 'opciones' }, ...[['empresa', 'El piloto los recoge en mi local', r.punto ? r.punto.direccion : 'Primero marca tu local en Tus carpetas'], ['sede', 'Yo los llevo a la sede de Vaelo', r.sede || 'Sede de Vaelo']].map(([k, t, a]) =>
        el('label', { class: 'opcion' }, el('input', { type: 'radio', name: 'recogida-lote', value: k, checked: recogida === k, onchange: () => { recogida = k; } }), el('span', {}, t, el('small', { text: a }))))),
      modo === 'pickup' ? [el('h3', { style: 'margin-top:1rem', text: '¿Quién paga el pickup?' }),
        el('div', { class: 'opciones' }, ...[['empresa', 'Mi empresa', 'Hablas primero con Vaelo por WhatsApp: precio y promoción. Pagas en efectivo al piloto.'], ['clientes', 'Cada cliente', 'Q35 en zonas preferenciales y Q45 fuera, en efectivo al recibir']].map(([k, t, a]) =>
          el('label', { class: 'opcion' }, el('input', { type: 'radio', name: 'paga-lote', value: k, checked: paga === k, onchange: () => { paga = k; pintar(); } }), el('span', {}, t, el('small', { text: a })))))] : null);
  };
  pintar();
  const quedan = c.total - c.confirmados;
  const boton = el('button', { class: 'boton cinta accion-principal', type: 'button', text: `Enviar ${c.confirmados} envíos a Vaelo`, onclick: async () => {
    boton.disabled = true;
    const ventana = modo === 'pickup' && paga === 'empresa' ? window.open('about:blank', '_blank') : null;
    try {
      const x = await api(`/api/empresa/carpetas/${c.id}/enviar`, { body: { modo, recogida, paga } });
      if (ventana && x.whatsapp) ventana.location.href = x.whatsapp; else if (ventana) ventana.close();
      poner(dlg, el('div', { class: 'celebra-caja' }, el('h2', { text: '¡Listo! Vaelo ya tiene tu carpeta' }),
        el('p', { text: x.whatsapp ? 'Te abrimos WhatsApp para acordar el precio del pickup. Después Vaelo asigna el piloto.' : 'Vaelo arma las rutas (primero la entrega más cercana) y te avisamos cuando cada piloto acepte.' }),
        x.pendientes ? el('p', { class: 'pista', text: `${x.pendientes} envío(s) sin confirmar quedaron en una carpeta nueva.` }) : null,
        x.whatsapp ? el('a', { class: 'boton cinta', href: x.whatsapp, target: '_blank', rel: 'noopener', text: 'Abrir WhatsApp de Vaelo' }) : null,
        el('button', { class: 'boton borde', type: 'button', style: 'margin-left:.5rem', text: 'Cerrar', onclick: () => dlg.close() })));
      recargar();
    } catch (e) { if (ventana) ventana.close(); mostrarMensaje(msg, e.message); boton.disabled = false; }
  } });
  poner(dlg, el('button', { class: 'cerrar', type: 'button', 'aria-label': 'Cerrar', text: '×', onclick: () => dlg.close() }),
    el('h2', { text: 'Enviar a Vaelo' }), el('p', { class: 'pista', text: `${c.confirmados} envíos confirmados para el ${diaEmp(c.dia)}.` }),
    quedan > 0 ? el('div', { class: 'mensaje aviso', text: `${quedan} envío(s) todavía sin confirmar no se mandan: pasan a una carpeta nueva para que los mandes después.` }) : null,
    rec ? el('div', { class: 'mensaje aviso' }, el('strong', { text: 'Te recomendamos: ' }), { una_moto: 'una moto para todo', motos: `${rec.motos} motos`, pickup: 'pickup' }[rec.modo], '. ', rec.razon) : null,
    tarjetas, extra, msg, boton);
}

// Etiquetas con código QR para pegar en cada paquete
function imprimirEtiquetas(pedidos, empresa) {
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const w = window.open('', '_blank');
  if (!w) { alert('Permite las ventanas emergentes para imprimir las etiquetas.'); return; }
  const etiquetas = pedidos.map((p) => `<div class="et"><div class="cab"><b>VAELO</b><span>${esc(empresa)}</span></div>
    <div class="cuerpo">${qrVaelo.svg(p.codigo, 120)}<div><div class="cod">${esc(p.codigo)}</div><div class="n">${esc(p.recibe_nombre || p.cliente_nombre)}</div>
    <div>${esc([p.zona, p.direccion].filter(Boolean).join(' · '))}</div><div>${esc(p.dia ? diaEmp(p.dia) : 'Fecha por confirmar')}${p.horario_texto ? ' · ' + esc(p.horario_texto) : ''}</div>
    <div class="t">${esc(p.tamano_texto)} · ${esc(p.descripcion)}</div></div></div></div>`).join('');
  w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Etiquetas Vaelo</title><style>
    body{font-family:Arial,sans-serif;margin:12px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
    .et{border:2px solid #000;border-radius:8px;break-inside:avoid;overflow:hidden}.cab{display:flex;justify-content:space-between;background:#0e2463;color:#fff;padding:6px 10px;font-size:13px}
    .cuerpo{display:flex;gap:10px;padding:8px;align-items:center;font-size:12px;line-height:1.35}.cod{font-size:20px;font-weight:bold;letter-spacing:.05em}.n{font-size:15px;font-weight:bold}.t{color:#555}
    @media print{body{margin:0}.no{display:none}}</style></head><body><p class="no"><button onclick="print()">Imprimir</button></p><div class="grid">${etiquetas}</div></body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch { /* el usuario imprime con el botón */ } }, 400);
}

// ---------- Analítica (sin dinero) ----------
async function panelAnalitica(caja) {
  let rango = 30;
  const zonaCifras = el('div'), zonaGraficas = el('div', { class: 'graficas-empresa' });
  const chips = el('div', { class: 'filtros' });
  const pintarChips = () => poner(chips, ...[[7, '7 días'], [30, '30 días'], [90, '90 días']].map(([d, t]) =>
    el('button', { class: 'chip', type: 'button', 'aria-pressed': String(d === rango), text: t, onclick: () => { rango = d; pintarChips(); cargar(); } })),
    el('a', { class: 'boton borde chico', style: 'margin-left:auto', href: `/api/empresa/excel?dia=${hoyEmp()}`, text: 'Descargar Excel de hoy' }));
  async function cargar() {
    const hoy = new Date(Date.now() - 6 * 3600e3);
    const desde = new Date(hoy - (rango - 1) * 86400e3).toISOString().slice(0, 10);
    let st;
    try { st = await api(`/api/empresa/estadisticas?desde=${desde}&hasta=${hoy.toISOString().slice(0, 10)}`); } catch (e) { poner(zonaCifras, el('div', { class: 'mensaje error', text: e.message })); return; }
    const g = st.general;
    const c = (t, v, marcar) => el('div', { class: 'celda-cifra' + (marcar ? ' marcar' : '') }, el('span', { text: t }), el('strong', { text: String(v) }));
    poner(zonaCifras, el('div', { class: 'franja-cifras' },
      c('Envíos', g.envios), c('Entregados', g.entregados), c('Éxito de entrega', g.exito != null ? g.exito + '%' : '—'), c('En curso', g.en_curso),
      c('No entregados', g.fallidos, g.fallidos > 0), c('Tiempo promedio', g.minutos != null ? `${g.minutos} min` : '—'), c('En la sede de Vaelo', st.en_sede.length, st.en_sede.length > 0)));
    const max = Math.max(1, ...st.porDia.map((d) => d.envios));
    const dias = []; for (let i = rango - 1; i >= 0; i--) dias.push(new Date(hoy - i * 86400e3).toISOString().slice(0, 10));
    const porDia = Object.fromEntries(st.porDia.map((d) => [d.dia, d]));
    const maxZ = Math.max(1, ...st.porZona.map((z) => z.envios));
    const semana = Array.from({ length: 7 }, (_, i) => st.porDiaSemana.find((x) => x.d === i)?.envios || 0);
    const maxS = Math.max(1, ...semana);
    poner(zonaGraficas, 
      el('div', { class: 'bloque' }, el('h2', { text: 'Envíos por día' }),
        el('div', { class: 'barras', role: 'img', 'aria-label': 'Envíos por día' }, dias.map((d) => {
          const x = porDia[d] || { envios: 0, entregados: 0 };
          return el('div', { class: 'barra', title: `${new Date(d + 'T12:00:00').toLocaleDateString('es-GT', { day: 'numeric', month: 'short' })}: ${x.envios} envíos, ${x.entregados || 0} entregados` },
            el('i', { style: `height:${(x.envios / max) * 100}%` }, el('b', { style: `height:${x.envios ? ((x.entregados || 0) / x.envios) * 100 : 0}%` })));
        })),
        el('div', { class: 'leyenda' }, el('span', {}, el('i', { style: 'background:#1c3faa' }), 'Entregados'), el('span', {}, el('i', { style: 'background:#c9d3f5' }), 'Otros'))),
      el('div', { class: 'bloque' }, el('h2', { text: 'Zonas con más entregas' }),
        st.porZona.length ? el('div', { class: 'barras-h' }, st.porZona.map((z) => el('div', {}, el('span', { text: z.zona }), el('i', { style: `width:${(z.envios / maxZ) * 100}%` }), el('b', { text: String(z.envios) }))))
          : el('p', { class: 'pista', text: 'Todavía no hay envíos en estas fechas.' })),
      el('div', { class: 'bloque' }, el('h2', { text: 'Días con más envíos' }),
        el('div', { class: 'barras-h' }, semana.map((n, i) => el('div', {}, el('span', { text: DIAS_EMP[i].replace(/^./, (c) => c.toUpperCase()) }), el('i', { style: `width:${(n / maxS) * 100}%` }), el('b', { text: String(n) }))))),
      el('div', { class: 'bloque' }, el('h2', { text: 'Horarios y entregas' }),
        st.porHorario.length ? el('ul', { class: 'lista-simple' }, st.porHorario.map((h) => el('li', { text: `${h.texto}: ${h.envios} pedidos, ${h.entregados || 0} entregados` }))) : el('p', { class: 'pista', text: 'Sin pedidos por enlace en estas fechas.' }),
        st.porFallo.length ? [el('h3', { style: 'margin-top:1rem', text: 'Por qué no se entregaron' }), el('ul', { class: 'lista-simple' }, st.porFallo.map((f) => el('li', { text: `${f.texto}: ${f.n}` })))] : null),
      st.en_sede.length ? el('div', { class: 'bloque' }, el('h2', { text: 'Paquetes en la sede de Vaelo' }), el('p', { class: 'pista', text: 'Manda a alguien a recogerlos con el código. La bodega se cobra por día y se coordina por WhatsApp.' }),
        el('ul', { class: 'lista-simple' }, st.en_sede.map((x) => el('li', { text: `${x.guia} · ${x.destino_nombre} · ${x.dias} día(s)` })))) : null);
  }
  poner(caja, chips, zonaCifras, zonaGraficas);
  pintarChips(); cargar();
}

// Los menús "⋯" se cierran al tocar fuera o al elegir una opción
document.addEventListener('click', (ev) => {
  document.querySelectorAll('details.menu-acciones[open]').forEach((d) => { if (!d.contains(ev.target) || ev.target.closest('.menu-lista > button, .menu-lista > a')) d.open = false; });
});
