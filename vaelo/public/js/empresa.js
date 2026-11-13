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
  if (r.es_minorista && !op.solicitud) return panelEmpresa(caja, op, r);
  solicitudEmpresa(caja, r);
  if (r.es_minorista) caja.prepend(el('button', { class: 'boton borde chico', type: 'button', style: 'margin-bottom:.8rem', text: '← Volver a mi tienda', onclick: () => pintarEmpresa(caja, { ...op, solicitud: false }) }));
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
          el('span', { class: 'doc-pro-chip ' + (listo ? 'ok' : d.opcional ? 'opc' : 'falta'), text: listo ? 'Listo' : d.opcional ? 'Opcional' : 'Falta' })),
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

// Confirmación con dos botones claros (en lugar del aviso del navegador). Devuelve true si eligió eliminar.
function confirmarEliminar({ titulo, texto, aviso, si = 'Sí, eliminar', no = 'Cancelar' }) {
  return new Promise((listo) => {
    const dlg = el('dialog', { class: 'dialogo confirmar-peligro' });
    const cerrar = (v) => { listo(v); dlg.close(); };
    dlg.append(...[el('h2', { text: titulo }), aviso ? el('div', { class: 'mensaje aviso', text: aviso }) : null, texto ? el('p', { text: texto }) : null,
      el('div', { class: 'botones-confirmar' },
        el('button', { class: 'boton borde', type: 'button', text: no, onclick: () => cerrar(false) }),
        el('button', { class: 'boton peligro', type: 'button', text: si, onclick: () => cerrar(true) }))].filter(Boolean));
    dlg.addEventListener('cancel', () => listo(false));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg); dlg.showModal();
  });
}
// App "Vaelo Tiendas": se instala desde /tienda y abre directo en la tienda (sin entrar a Google cada vez)
function bloqueAppTiendas() {
  if (typeof yaInstalada === 'function' && yaInstalada()) return null;
  if (cerradoHasta('app-tiendas')) return null;
  const caja = el('section', { class: 'app-tiendas' });
  const enTienda = location.pathname === '/tienda';
  const pista = el('small', { text: 'Si no deseas estar entrando a Google cada vez, descarga la app: queda en tu pantalla de inicio y abre directo en tu tienda. No ocupa espacio ni se baja de ninguna tienda de aplicaciones.' });
  const boton = el('button', { class: 'boton', type: 'button', text: 'Descargar Vaelo Tiendas', onclick: async () => {
    if (!enTienda) { location.href = '/tienda?instalar=1'; return; }
    if (await pedirInstalar()) { caja.remove(); return; }
    pista.textContent = esIos() ? 'En Safari toca Compartir (el cuadro con la flecha) y luego «Agregar a pantalla de inicio». Quedará como Vaelo Tiendas.'
      : 'En Chrome toca el menú de los tres puntos (arriba a la derecha) y elige «Instalar app» o «Agregar a pantalla principal». Quedará como Vaelo Tiendas.';
    pista.className = 'aviso-pasos';
  } });
  caja.append(el('img', { src: '/img/icono-tiendas-192.png', alt: '', width: 56, height: 56 }),
    el('div', {}, el('strong', { text: 'Descarga la app Vaelo Tiendas' }), pista), boton, botonCerrarAviso('app-tiendas', caja));
  if (enTienda && new URLSearchParams(location.search).get('instalar')) { caja.classList.add('resaltada'); boton.textContent = 'Instalar ahora'; }
  return caja;
}
// Lo que Vaelo hace por la tienda: la logística completa, explicada en corto
const SERVICIOS_TIENDA = [
  ['mensaje', 'Enlace exclusivo para cada cliente', 'Confirma día, horario, dirección y quién recibe. Tú no tienes que escribirle a cada uno.'],
  ['ruta', 'Ubicación en tiempo real', 'Tu cliente comparte dónde está desde su celular y el piloto llega directo, sin perderse.'],
  ['piloto', 'Rutas ordenadas', 'Juntamos tus pedidos del día y el piloto los entrega en el orden más rápido.'],
  ['etiqueta', 'Código en cada paquete', 'Cada pedido lleva su código (o la guía impresa): el piloto nunca confunde uno con otro.'],
  ['campana', 'Avisos a tu cliente', 'Le avisamos cuando su pedido sale y cuando es la próxima entrega, con su código para recibir.'],
  ['dinero', 'Cobro al entregar', 'El piloto cobra tu producto y el envío. Vaelo te entrega tu dinero y lo ves aquí.'],
];

// ---------- Ayuda: "¿Cómo hago esto?" en cada parte de la tienda ----------
const AYUDA = {
  inicio: { titulo: 'Cómo funciona tu tienda', pasos: [
    ['Di dónde recogemos', 'Una sola vez: el lugar donde el piloto pasa por tus paquetes (tu casa o tu local).'],
    ['Crea una carpeta del día', 'Una carpeta es un día de entrega. Ahí apuntas todos los pedidos de ese día.'],
    ['Apunta cada pedido', 'Nombre y WhatsApp de tu cliente, qué compró, cuánto cobrar y la foto del paquete.'],
    ['Manda el enlace a cada cliente', 'Al guardar el pedido se abre WhatsApp con su enlace. Tu cliente elige su horario y comparte su ubicación.'],
    ['Envía la carpeta a Vaelo', 'Cuando tengas los confirmados que pide tu carpeta, toca «Enviar a Vaelo». Nosotros recogemos, entregamos y cobramos.'],
  ], nota: 'Tú no tienes que pedirle la dirección a nadie: cada cliente la confirma en su enlace.' },
  punto: { titulo: 'Cómo decirnos dónde recogemos', pasos: [
    ['Busca el recuadro de recogida', 'Está en «Mi tienda», debajo de tus avisos.'],
    ['Si estás ahí, toca «Usar mi ubicación en tiempo real»', 'Tu celular comparte dónde estás y queda guardado como el lugar de recogida.'],
    ['Si los paquetes están en otro lugar, toca «Lo tengo en otro lugar»', 'Le mandas un enlace a la persona que está ahí y ella comparte su ubicación.'],
  ], nota: 'Solo se hace una vez. Si te cambias de lugar, lo puedes cambiar cuando quieras.' },
  carpetas: { titulo: 'Cómo crear una carpeta', pasos: [
    ['Toca «Nueva carpeta»', 'Arriba a la derecha de «Tus carpetas de envíos».'],
    ['Elige el día de entrega', 'Es el día en que quieres que tus clientes reciban. Puedes ponerle un nombre, ej. «Live del martes».'],
    ['Ábrela y apunta tus pedidos', 'Toca la carpeta y luego «Añadir pedido» por cada cliente.'],
  ], nota: 'Una carpeta por día. Si un día no juntas los pedidos que pide, puedes juntarla con otra carpeta.' },
  pedido: { titulo: 'Cómo añadir un pedido', pasos: [
    ['Toca «Añadir pedido»', 'Dentro de la carpeta del día.'],
    ['Escribe qué es y su tamaño', 'Ej. «Blusa negra talla M», y elige si es pequeño, mediano o grande.'],
    ['Pon el nombre y WhatsApp de tu cliente', 'A ese número le mandamos su enlace y los avisos de la entrega.'],
    ['¿Cuánto cobra el piloto?', 'Lo que tu cliente te debe por el producto. Si ya te pagó, déjalo en 0.'],
    ['Toma la foto del paquete', 'Ya empacado. Si algo pasa, con la foto lo comprobamos.'],
    ['Guarda', 'Se abre WhatsApp con el enlace de tu cliente listo para mandar.'],
  ] },
  enlace: { titulo: 'Cómo mandar el enlace a tus clientes', pasos: [
    ['Toca «Mandar enlace»', 'En el pedido de cada cliente. Se abre WhatsApp con el mensaje ya escrito.'],
    ['Envía el mensaje', 'Tu cliente abre el enlace, elige su horario y comparte su ubicación en tiempo real.'],
    ['Mira quién ya confirmó', 'El pedido cambia a «Confirmado». Si alguien no ha respondido, toca «Recordar a los que faltan».'],
  ], nota: 'Si WhatsApp no abre, usa «Copiar enlace» en el menú del pedido (⋯) y pégalo en el chat.' },
  enviar: { titulo: 'Cómo enviar tu carpeta a Vaelo', pasos: [
    ['Junta los confirmados', 'El botón «Enviar a Vaelo» aparece cuando tienes los confirmados que pide tu carpeta.'],
    ['Elige cómo repartimos', 'Una moto para todo, varias motos o pickup. Te marcamos cuál recomendamos.'],
    ['Elige cómo llegan los paquetes', 'El piloto los recoge en tu lugar, o tú los llevas a la sede de Vaelo.'],
    ['Confirma', 'Listo: Vaelo prepara la ruta. Aquí ves cuántos van en camino y cuántos se entregaron.'],
  ], nota: 'Después de enviarla ya no puedes agregar pedidos a esa carpeta: crea otra para el siguiente día.' },
  cobros: { titulo: 'Cómo funciona tu dinero', pasos: [
    ['El piloto cobra al entregar', 'Cobra tu producto (lo que pusiste en cada pedido) y el envío a tu cliente.'],
    ['Vaelo te entrega lo cobrado', 'Lo ves aquí en «Dinero de tus productos que Vaelo te tiene».'],
    ['Si tu cliente te pagó el envío a ti', 'Márcalo en su pedido. Vaelo te lo descuenta de lo que te entrega.'],
    ['Si te queda saldo por pagar', 'Págalo por transferencia y avísanos por WhatsApp. Hasta entonces no puedes enviar otra carpeta.'],
  ] },
};
function verAyuda(k) {
  const a = AYUDA[k]; if (!a) return;
  const dlg = el('dialog', { class: 'aviso-descuentos ayuda-dialogo' });
  const cerrar = () => { dlg.close(); dlg.remove(); };
  poner(dlg, el('div', { class: 'dialogo' },
    el('h2', { text: a.titulo }),
    el('ol', { class: 'ayuda-pasos' }, a.pasos.map(([t, d]) => el('li', {}, el('strong', { text: t }), el('span', { text: d })))),
    a.nota ? el('p', { class: 'ayuda-nota', text: a.nota }) : null,
    el('p', { class: 'pista' }, '¿Sigues con dudas? ', el('a', { href: 'https://wa.me/50237731793?text=' + encodeURIComponent('Hola Vaelo, necesito ayuda con mi tienda: ' + a.titulo.toLowerCase()), target: '_blank', rel: 'noopener', text: 'Escríbenos por WhatsApp' })),
    el('button', { class: 'boton', type: 'button', text: 'Entendido', onclick: cerrar })));
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); cerrar(); });
  document.body.append(dlg); dlg.showModal();
}
const botonAyuda = (k, texto = '¿Cómo hago esto?') => el('button', { class: 'boton-ayuda', type: 'button', onclick: () => verAyuda(k) }, el('span', { class: 'boton-ayuda-signo', 'aria-hidden': 'true', text: '?' }), texto);
// Guía de 4 pasos: marca en qué paso va la tienda y qué le toca hacer ahora
function guiaTienda(r, acciones) {
  const algunaConPedidos = r.abiertas.some((c) => c.total > 0);
  const lista = r.abiertas.find((c) => c.confirmados >= c.minimo);
  const pasos = [
    { t: 'Di dónde recogemos', h: 'punto', hecho: !!r.punto },
    { t: 'Crea tu carpeta y apunta tus pedidos', h: 'pedido', hecho: algunaConPedidos || !!r.enviadas.length },
    { t: `Manda el enlace (mínimo ${r.minimo} confirmados)`, h: 'enlace', hecho: !!lista || (!!r.enviadas.length && !algunaConPedidos) },
    { t: 'Envía la carpeta a Vaelo', h: 'enviar', hecho: !!r.enviadas.length && !algunaConPedidos },
  ];
  const actual = pasos.findIndex((p) => !p.hecho);
  if (actual === -1) return el('div', { class: 'guia-tienda lista' }, el('span', { text: 'Ya sabes cómo funciona: crea una carpeta nueva para tus próximos envíos.' }), botonAyuda('inicio', 'Ver cómo funciona'));
  const accion = [
    { t: 'Decir dónde recogemos', f: acciones.punto },
    { t: r.abiertas.length ? 'Abrir mi carpeta' : 'Crear mi primera carpeta', f: r.abiertas.length ? () => acciones.abrir(r.abiertas[0].id) : acciones.nueva },
    { t: 'Abrir mi carpeta', f: () => acciones.abrir((r.abiertas.find((c) => c.total > 0) || r.abiertas[0]).id) },
    { t: 'Enviar a Vaelo', f: () => acciones.abrir((lista || r.abiertas[0]).id) },
  ][actual];
  return el('section', { class: 'guia-tienda' },
    el('div', { class: 'guia-cabeza' }, el('strong', { text: `Paso ${actual + 1} de 4` }), botonAyuda('inicio', 'Cómo funciona todo')),
    el('ol', { class: 'guia-pasos' }, pasos.map((p, i) => el('li', { class: p.hecho ? 'hecho' : i === actual ? 'actual' : '' },
      el('span', { class: 'guia-num', text: p.hecho ? '✓' : String(i + 1) }), el('span', { class: 'guia-texto', text: p.t }),
      i === actual ? botonAyuda(p.h, '¿Cómo?') : null))),
    accion && accion.f ? el('button', { class: 'boton cinta boton-grande', type: 'button', text: accion.t, onclick: accion.f }) : null);
}
function bloqueServicios(clave, primeraVez = true) {
  // Abierto la primera vez (antes de su primera carpeta); después queda como la tienda lo dejó
  let abierto = primeraVez; try { const g = localStorage.getItem('servicios-' + clave); if (g !== null) abierto = g === '1'; } catch { /* sin almacenamiento */ }
  const d = el('details', { class: 'servicios-tienda', open: abierto },
    el('summary', {}, el('strong', { text: 'Lo que Vaelo hace por tu tienda' }), el('small', { text: 'Logística completa, sin costo extra' })),
    el('ul', {}, SERVICIOS_TIENDA.map(([i, t, a]) => el('li', {}, icono(i), el('div', {}, el('strong', { text: t }), el('span', { text: a }))))));
  d.addEventListener('toggle', () => { try { localStorage.setItem('servicios-' + clave, d.open ? '1' : '0'); } catch { /* sin almacenamiento */ } });
  return d;
}
async function panelEmpresa(caja, op = {}, minorista = null) {
  const yo = (await api('/api/yo')).usuario;
  let bono = null; if (!minorista) try { bono = await api('/api/empresa/bono'); } catch { /* sin bono */ }
  const conBono = !!(bono && bono.activo);
  const pedida = new URLSearchParams(location.search).get('vista');
  let vista = pedida === 'analitica' ? 'analitica' : pedida === 'ganancias' && conBono ? 'ganancias' : 'pedidos';
  const cuerpo = el('div');
  const pest = el('div', { class: 'pestanas', role: 'tablist' });
  const pintarPest = () => poner(pest, ...[['pedidos', 'Carpetas de envíos'], ['analitica', 'Analítica'], conBono ? ['ganancias', 'Tus ganancias'] : null].filter(Boolean).map(([k, t]) =>
    el('button', { type: 'button', role: 'tab', 'aria-selected': String(vista === k), text: t, onclick: () => { vista = k; pintarPest(); abrir(); } })));
  const abrir = () => (vista === 'pedidos' ? panelPedidos(cuerpo, yo) : vista === 'ganancias' ? panelGanancias(cuerpo) : panelAnalitica(cuerpo, !!minorista));
  poner(caja, 
    el('div', { class: 'empresa-cabecera' }, el('div', {}, el('span', { class: 'etiqueta-completa', text: minorista ? 'Tienda minorista' : 'Contrato firmado' }), el('h2', { text: yo.empresa_nombre || yo.nombre }),
      el('p', { class: 'pista', text: minorista
        ? 'Apunta los pedidos de tu live en una carpeta del día, mándale a cada cliente su enlace y cuando estén confirmados, envíala a Vaelo.'
        : 'Vaelo te presta sus pilotos: cada cliente paga su envío al recibir. Tu empresa solo paga si eliges pickup pagado por ti o si un paquete se queda en la sede.' }),
      yo.recogida_dias ? el('p', { class: 'recogida-fija' }, icono('reloj'), ` Pasamos por tus paquetes: ${yo.recogida_dias.split(',').map(d => ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][d]).join(', ')} a las ${yo.recogida_hora}.`) : null),
      minorista ? el('button', { class: 'boton borde chico', type: 'button', text: '¿Ya vendes mucho? Pide contrato de empresa', onclick: () => pintarEmpresa(caja, { ...op, solicitud: true }) })
        : el('a', { class: 'boton borde chico', href: '/politicas-empresas', target: '_blank', text: 'Políticas para empresas' })),
    minorista && minorista.solicitud && ['enviada', 'cita'].includes(minorista.solicitud.estado) ? el('div', { class: 'mensaje aviso', text: 'Tu solicitud de contrato de empresa está en revisión. Mientras tanto sigue usando tu tienda con normalidad.' }) : null,
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
const textoEnlace = (p, r, dia) => `Hola ${p.cliente_nombre.split(' ')[0]}, ${r.empresa} te enviará tu pedido (${p.descripcion}) con Vaelo el ${diaEmp(dia || p.dia)}.${p.cobro > 0 ? ` Al recibir pagas ${dinero(p.cobro)} de tu producto más el envío.` : ''} Confirma aquí tu horario, dónde lo recibes y quién lo recibe: ${location.origin + p.enlace}`;
function progresoCarpeta(c) {
  const pct = Math.min(100, Math.round((c.confirmados / c.minimo) * 100));
  return el('div', { class: 'carpeta-progreso' },
    el('div', { class: 'progreso-barra' + (c.confirmados >= c.minimo ? ' completo' : '') }, el('i', { style: `width:${pct}%` })),
    el('small', { text: c.confirmados >= c.minimo ? `${c.confirmados} ${c.confirmados === 1 ? 'confirmado' : 'confirmados'}: lista para mandar` : `${c.confirmados} de ${c.minimo} confirmados para mandarla` }));
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
  const cp = r.cobros_producto;
  const detalleCargos = cp && cp.cargos > 0 ? cp.cargos_detalle.map((x) => `${x.nombre.toLowerCase()} ${dinero(x.monto)}`).join(', ') : '';
  const cajaSaldo = cp && cp.saldo > 0 ? el('section', { class: 'bloque cobros-tienda saldo-tienda' + (cp.saldo_vencido ? ' vencido' : '') },
    el('div', {}, el('span', { text: cp.debe_cargos ? 'Debes a Vaelo' : 'Saldo por pagar a Vaelo' }), el('strong', { text: dinero(cp.saldo) }),
      el('small', { text: cp.debe_cargos
        ? `Por ${detalleCargos}${cp.envios_tienda > 0 ? ` y ${dinero(cp.envios_tienda)} de envíos que tus clientes te pagaron a ti` : ''}, menos lo que Vaelo te debía por tus productos. Págalo por transferencia y avísanos: hasta entonces no puedes enviar otra carpeta.`
        : `Son ${cp.n_envios_tienda} envío(s) que tus clientes te pagaron a ti (${dinero(cp.envios_tienda)}), menos lo que Vaelo te debía por tus productos. ${cp.saldo_vencido ? 'Ya venció: págalo por transferencia y avísanos para poder enviar tu próxima carpeta.' : `Págalo por transferencia antes del ${fecha(cp.saldo_limite + ' 12:00:00', false)}.`}` })),
    r.whatsapp ? el('a', { class: 'boton cinta chico', href: `https://wa.me/${String(r.whatsapp).replace(/\D/g, '').replace(/^(\d{8})$/, '502$1')}?text=${encodeURIComponent(`Hola Vaelo, soy de ${r.empresa || 'mi tienda'}. Quiero pagar mi saldo de ${dinero(cp.saldo)}.`)}`, target: '_blank', rel: 'noopener', text: 'Avisar que ya pagué' }) : null) : null;
  const cajaCobros = cp && (cp.pendiente > 0 || cp.pagado_30 > 0) ? el('section', { class: 'bloque cobros-tienda' },
    el('div', {}, el('span', { text: 'Dinero de tus productos que Vaelo te tiene' }), el('strong', { text: dinero(cp.pendiente) }),
      el('small', { text: cp.pendiente > 0 ? `De ${cp.envios} entrega(s) ya cobrada(s)${cp.comision > 0 ? `, ya descontada la comisión de ${dinero(cp.comision)}` : ''}${cp.envios_tienda > 0 ? ` y ${dinero(cp.envios_tienda)} de envíos que tus clientes te pagaron a ti` : ''}${cp.cargos > 0 ? `; también se descuentan ${detalleCargos}` : ''}. Vaelo te lo entrega y aquí queda marcado.` : 'Estás al día: ya te entregamos todo.' })),
    cp.pagado_30 > 0 ? el('div', {}, el('span', { text: 'Ya te entregamos (30 días)' }), el('strong', { text: dinero(cp.pagado_30) }), cp.ultimo_pago ? el('small', { text: 'Último: ' + fecha(cp.ultimo_pago, false) }) : null) : null) : null;
  if (cajaSaldo) cajaSaldo.append(botonAyuda('cobros'));
  if (cajaCobros) cajaCobros.append(botonAyuda('cobros'));
  const bPunto = bloquePunto(r, () => panelPedidos(caja, yo));
  const guia = guiaTienda(r, { punto: () => { bPunto.scrollIntoView({ behavior: 'smooth', block: 'center' }); bPunto.classList.add('resaltar'); setTimeout(() => bPunto.classList.remove('resaltar'), 2500); },
    nueva: () => nueva.click(), abrir });
  poner(caja, bloqueRevision(r.condiciones), guia, bloqueAppTiendas(), cajaSaldo, cajaCobros, bPunto,
    el('section', { class: 'bloque' },
      el('div', { class: 'cab-bloque' }, el('div', {}, el('h2', { text: 'Tus carpetas de envíos' }), el('p', { class: 'pista', text: 'Una carpeta por día de entrega.' }), botonAyuda('carpetas')), nueva),
      r.abiertas.length ? el('div', { class: 'carpetas' }, r.abiertas.map(tarjeta)) : vacio),
    r.enviadas.length ? el('section', { class: 'bloque' }, el('h2', { text: 'Enviadas a Vaelo' }), el('div', { class: 'carpetas' }, r.enviadas.map(tarjeta))) : null,
    bloqueCondiciones(r.condiciones), bloqueServicios(r.minorista ? 'minorista' : 'empresa', !(r.abiertas.length + r.enviadas.length)));
  // Cómo funcionan sus descuentos: la primera vez y cada vez que la oficina le cambia el plan
  if (r.condiciones && r.condiciones.estado === 'aprobada' && !r.condiciones.vista) avisoDescuentos(r.condiciones);
}
// Tienda en revisión: puede preparar todo, pero no enviar hasta que Vaelo la apruebe
function bloqueRevision(c) {
  if (!c || c.estado === 'aprobada') return null;
  if (c.estado === 'rechazada') return el('section', { class: 'bloque tienda-revision' }, el('h2', { text: 'Tu solicitud de tienda no fue aprobada' }),
    el('p', { text: (c.nota ? c.nota + ' ' : '') + 'Escríbenos por WhatsApp y la revisamos juntos.' }));
  return el('section', { class: 'bloque tienda-revision' }, el('h2', { text: 'Estamos revisando tu tienda' }),
    el('p', { text: 'Revisamos cada tienda para darte el mejor servicio y tu plan con descuentos. Mientras tanto ya puedes crear tus carpetas, apuntar tus pedidos y mandarle el enlace a tus clientes. Cuando la aprobemos te avisamos y ya puedes enviar tu carpeta a Vaelo.' }));
}
function avisoDescuentos(c, alCerrar) {
  const dlg = el('dialog', { class: 'aviso-descuentos' });
  const cerrar = async () => { try { await api('/api/empresa/condiciones/visto', { body: { firma: c.firma } }); c.vista = true; } catch { /* se vuelve a mostrar la próxima vez */ } dlg.close(); dlg.remove(); if (alCerrar) alCerrar(); };
  poner(dlg, el('div', { class: 'dialogo' },
    el('h2', { text: c.vista ? 'Cómo funcionan tus descuentos' : 'Así funcionan tus descuentos' }),
    el('p', { class: 'pista', text: c.plan ? `Tu plan: ${c.plan}. Esto es lo que Vaelo te da:` : 'Esto es lo que Vaelo te da:' }),
    el('dl', { class: 'plan-lineas' }, c.lineas.flatMap((l) => [el('dt', { text: l.titulo }), el('dd', { text: l.texto })])),
    c.foco ? el('div', { class: 'foco-estado aplica' }, el('strong', { text: 'Antes de cobrarle el envío a tu cliente, mándale su enlace' }),
      el('p', { text: `El descuento de zona foco depende de dónde reciben tus clientes: lo sabemos cuando cada uno confirma su ubicación. Mientras armas tu carpeta te mostramos si ya tiene descuento. Así le cobras el precio correcto: con descuento (${dinero(c.foco.precio)}) si tu carpeta califica, o el normal si no.` })) : null,
    el('div', { class: 'foco-estado' }, el('strong', { text: 'Si tu cliente ya te pagó el envío' }),
      el('p', { text: 'Márcalo en su pedido con «Mi cliente ya me pagó el envío». El piloto no se lo cobra y Vaelo te descuenta ese envío de lo que te entrega por tus productos. Si no alcanza, te queda un saldo para pagarnos por transferencia.' })),
    el('button', { class: 'boton', type: 'button', text: 'Entendido', onclick: cerrar })));
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); cerrar(); });
  document.body.append(dlg); dlg.showModal();
}
// Lo que Vaelo le da a esta tienda (su plan), en palabras sencillas
function bloqueCondiciones(c) {
  if (!c || !c.lineas || !c.lineas.length) return null;
  return el('details', { class: 'bloque condiciones-tienda' },
    el('summary', {}, el('strong', { text: 'Tus condiciones con Vaelo' }), el('span', { text: c.plan ? `Plan ${c.plan}` : '' })),
    el('dl', { class: 'plan-lineas' }, c.lineas.flatMap((l) => [el('dt', { text: l.titulo }), el('dd', { text: l.texto })])),
    c.vence ? el('p', { class: 'pista', text: `Tienes condiciones especiales hasta el ${fecha(c.vence + ' 12:00:00', false)}.` }) : null,
    el('button', { class: 'boton borde chico', type: 'button', text: 'Cómo funcionan mis descuentos', onclick: () => avisoDescuentos(c) }));
}
// Punto de recogida: donde el piloto pasa por los paquetes
function bloquePunto(r, alCambiar) {
  const punto = el('section', { class: 'bloque recogida-empresa' });
  const tel8 = (t) => String(t || '').replace(/\D/g, '').slice(-8);
  const leerGps = () => new Promise((ok, mal) => {
    if (!navigator.geolocation) return mal(new Error('Tu navegador no puede compartir la ubicación. Abre Vaelo en Chrome o Safari.'));
    navigator.geolocation.getCurrentPosition((x) => ok({ lat: x.coords.latitude, lng: x.coords.longitude, precision: x.coords.accuracy }),
      (e) => mal(new Error(e.code === 1 ? 'Necesitamos tu ubicación. Toca el candado junto a la dirección de la página y permite la ubicación.' : 'No pudimos leer tu ubicación. Acércate a una ventana y vuelve a intentar.')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
  const listo = () => { if (alCambiar) alCambiar(); };
  const pintar = (modo) => {
    // Ya guardado: se ve dónde y quién entrega, y siempre se puede cambiar
    if (!modo && r.punto) {
      poner(punto, icono('sede'), el('div', {}, el('strong', { text: 'Los pilotos recogen tus paquetes en' }), el('span', { text: r.punto.direccion }),
          el('small', { class: 'pista', text: `Entrega: ${r.punto.contacto}${r.punto.telefono ? ' · ' + r.punto.telefono : ''}${r.punto.fuente === 'mapa' ? '' : ' · ubicación tomada con GPS en el lugar'}` }),
          r.punto.fuente === 'mapa' ? el('small', { class: 'error-texto', text: 'Este punto se marcó en el mapa. Para que el piloto no se confunda, vuelve a tomarlo con «Cambiar» estando en el lugar.' }) : null),
        el('button', { class: 'boton borde chico', type: 'button', text: 'Cambiar', onclick: () => pintar('elegir') }));
      return;
    }
    if (!modo && r.punto_pendiente) modo = 'esperando';
    const msg = el('div', { class: 'mensaje', role: 'alert' });
    const cancelar = r.punto || r.punto_pendiente ? el('button', { class: 'boton borde chico', type: 'button', text: 'Cancelar', onclick: () => pintar(null) }) : null;
    const titulo = el('h3', { text: '¿Dónde recoge el piloto tus paquetes?' });
    if (modo === 'esperando') {
      const pe = r.punto_pendiente;
      const wa = `https://wa.me/502${tel8(pe.telefono)}?text=${encodeURIComponent(`Hola ${pe.nombre}, soy ${r.empresa}. Vaelo va a pasar por mis paquetes donde estás tú. Abre este enlace estando ahí y comparte tu ubicación: ${location.origin + pe.enlace}`)}`;
      poner(punto, el('div', { style: 'flex:1' }, titulo,
        el('div', { class: 'mensaje aviso' }, 'Esperando que ', el('strong', { text: pe.nombre }), ' abra el enlace en el lugar y comparta su ubicación.'), msg,
        el('div', { class: 'navegar' },
          el('a', { class: 'boton cinta chico', href: wa, target: '_blank', rel: 'noopener', text: 'Mandar el enlace otra vez' }),
          el('button', { class: 'boton borde chico', type: 'button', text: 'Ya lo compartió', onclick: () => listo() }),
          el('button', { class: 'boton borde chico', type: 'button', text: 'Cambiar', onclick: async () => { await api('/api/empresa/punto/enlace', { method: 'DELETE' }).catch(() => {}); r.punto_pendiente = null; pintar('elegir'); } }))));
      return;
    }
    if (modo === 'aqui') {
      const dir = el('input', { maxlength: 300, value: r.punto?.direccion || '', placeholder: 'Ej. 5a calle 3-20 zona 1, portón negro' });
      let pos = null;
      const estado = el('p', { class: 'pista', text: 'Leyendo tu ubicación…' });
      const guardar = el('button', { class: 'boton', type: 'button', text: 'Guardar este lugar', disabled: true, onclick: async () => {
        guardar.disabled = true;
        try { const x = await api('/api/empresa/punto', { method: 'PUT', body: { ...pos, direccion: dir.value } }); r.punto = x.punto; r.punto_pendiente = null; pintar(null); listo(); }
        catch (e) { mostrarMensaje(msg, e.message); guardar.disabled = false; }
      } });
      const leer = async () => {
        estado.textContent = 'Leyendo tu ubicación…'; guardar.disabled = true;
        try {
          pos = await leerGps();
          estado.textContent = pos.precision > 250 ? `La señal está débil (unos ${Math.round(pos.precision)} m de error). Acércate a una ventana y toca «Leer otra vez».` : `Ubicación tomada (unos ${Math.round(pos.precision)} m de margen).`;
          estado.className = pos.precision > 250 ? 'error-texto' : 'exito-texto';
          guardar.disabled = pos.precision > 250;
        } catch (e) { estado.textContent = e.message; estado.className = 'error-texto'; }
      };
      poner(punto, el('div', { style: 'flex:1' }, titulo,
        el('p', { class: 'pista', text: 'Estás en el lugar donde el piloto va a recoger. Tomamos la ubicación de tu celular para que llegue directo.' }), estado,
        el('div', { class: 'campo' }, el('label', { text: 'Dirección o referencia para el piloto' }), dir), msg,
        el('div', { class: 'navegar' }, guardar, el('button', { class: 'boton borde chico', type: 'button', text: 'Leer otra vez', onclick: leer }),
          el('button', { class: 'boton borde chico', type: 'button', text: 'Atrás', onclick: () => pintar('elegir') }))));
      leer();
      return;
    }
    if (modo === 'otro') {
      const nombre = el('input', { maxlength: 80, placeholder: 'Ej. Doña Marta' }), tel = el('input', { type: 'tel', maxlength: 30, placeholder: '5555 5555' });
      poner(punto, el('div', { style: 'flex:1' }, titulo,
        el('div', { class: 'mensaje aviso' }, el('strong', { text: 'En ese lugar tiene que haber una persona. ' }),
          'Le mandamos un enlace por WhatsApp: lo abre estando ahí, acepta que va a entregar los paquetes al piloto y comparte su ubicación en tiempo real. Esa ubicación queda como el lugar de recogida.'),
        el('div', { class: 'fila' }, el('div', { class: 'campo' }, el('label', { text: 'Nombre de esa persona' }), nombre), el('div', { class: 'campo' }, el('label', { text: 'Su WhatsApp' }), tel)), msg,
        el('div', { class: 'navegar' }, el('button', { class: 'boton', type: 'button', text: 'Mandar enlace por WhatsApp', onclick: async () => {
          const ventana = window.open('about:blank', '_blank');
          try {
            const x = await api('/api/empresa/punto/enlace', { body: { nombre: nombre.value, telefono: tel.value } });
            r.punto_pendiente = x.pendiente;
            const pe = x.pendiente;
            const texto = `Hola ${pe.nombre}, soy ${r.empresa}. Vaelo va a pasar por mis paquetes donde estás tú. Abre este enlace estando ahí y comparte tu ubicación: ${location.origin + pe.enlace}`;
            if (ventana) ventana.location.href = `https://wa.me/502${tel8(pe.telefono)}?text=${encodeURIComponent(texto)}`;
            pintar('esperando');
          } catch (e) { if (ventana) ventana.close(); mostrarMensaje(msg, e.message); }
        } }), el('button', { class: 'boton borde chico', type: 'button', text: 'Atrás', onclick: () => pintar('elegir') }))));
      return;
    }
    // Elegir: dos opciones rápidas
    const opcion = (t, a, fn) => el('button', { type: 'button', class: 'opcion-punto', onclick: fn }, el('strong', { text: t }), el('small', { text: a }));
    poner(punto, el('div', { style: 'flex:1' }, titulo,
      el('p', { class: 'pista', text: 'Usamos la ubicación real del celular, no un mapa: así el piloto llega directo y no se confunde.' }),
      el('div', { class: 'opciones-punto' },
        opcion('Usar mi ubicación en tiempo real', 'Estoy ahora donde están los paquetes', () => pintar('aqui')),
        opcion('Lo tengo en otro lugar', 'Le mando un enlace a la persona que está ahí', () => pintar('otro'))), msg,
      cancelar ? el('div', { class: 'navegar' }, cancelar) : null));
  };
  pintar(null);
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
  const anadir = el('button', { class: 'boton boton-grande', type: 'button', onclick: () => dialogoNuevoEnvio(c, r, recargar) }, icono('mas'), ' Añadir pedido');
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
        el('button', { class: 'boton borde chico peligro-texto', type: 'button', text: 'Eliminar carpeta', onclick: async () => {
          const ok = await confirmarEliminar(c.confirmados > 0 ? {
            titulo: '¿Eliminar esta carpeta?',
            aviso: c.confirmados === 1 ? 'Un pedido ya fue confirmado por tu cliente.' : `${c.confirmados} pedidos ya fueron confirmados por tus clientes.`,
            texto: `Si eliminas «${c.nombre}» puedes perder a ${c.confirmados === 1 ? 'ese cliente y el registro de su pedido' : 'esos clientes y el registro de sus pedidos'}. Volverás a hacer todo de nuevo: ${c.confirmados === 1 ? 'crear el pedido y mandarle' : 'crear los pedidos y mandarles'} otro enlace.` }
            : { titulo: '¿Eliminar esta carpeta?', texto: c.total ? `Se eliminan «${c.nombre}» y sus ${c.total} envío(s). Ninguno estaba confirmado todavía.` : `La carpeta «${c.nombre}» está vacía.` });
          if (!ok) return;
          await api(`/api/empresa/carpetas/${c.id}`, { method: 'DELETE' }).catch((e) => alert(e.message)); volver();
        } })) : null));
  const estadoCaja = abierta
    ? el('section', { class: 'bloque carpeta-estado' + (listo ? ' lista' : '') },
      el('div', {}, el('strong', { class: 'carpeta-cifra', text: `${c.confirmados}` }), el('span', { text: ` de ${c.minimo} confirmados` }), progresoCarpeta(c),
        c.dia < r.hoy ? el('small', { class: 'error-texto', text: 'El día de entrega ya pasó. Toca «Cambiar día o nombre» o junta estos pedidos con otra carpeta; tus clientes confirman la nueva fecha.' }) : null,
        c.total && (c.dia < r.hoy || c.confirmados < c.minimo) ? el('button', { class: 'boton borde chico', type: 'button', style: 'margin-top:.6rem', text: 'Juntar con otra carpeta', onclick: () => dialogoJuntar(c, r, recargar) }) : null,
        !r.punto ? el('small', { class: 'error-texto', text: 'Falta el lugar donde el piloto recoge tus paquetes (abajo).' }) : null,
        c.sin_foto && !listo ? el('small', { text: c.sin_foto === 1 ? 'Falta la foto de 1 paquete.' : `Falta la foto de ${c.sin_foto} paquetes.` }) : null,
        estadoFoco(c.foco, false)),
      listo && c.sin_foto ? el('div', { class: 'falta-fotos' }, el('p', {}, el('strong', { text: `Ya puedes enviarla, solo falta${c.sin_foto === 1 ? '' : 'n'} ${c.sin_foto} foto${c.sin_foto === 1 ? '' : 's'}.` }),
          ' Toma la foto de cada paquete ya empacado: así, si algo pasa, tenemos cómo comprobarlo.'),
        el('button', { class: 'boton cinta boton-grande', type: 'button', text: c.sin_foto === 1 ? 'Tomar la foto que falta' : `Tomar las ${c.sin_foto} fotos que faltan`, onclick: () => {
          const b = caja.querySelector('[data-falta-foto]'); if (b) { b.scrollIntoView({ behavior: 'smooth', block: 'center' }); b.classList.add('resaltar'); setTimeout(() => b.classList.remove('resaltar'), 2500); }
        } }))
      : listo ? el('div', {}, el('button', { class: 'boton cinta boton-grande', type: 'button', text: 'Enviar a Vaelo', onclick: () => dialogoEnviar(c, r, recargar) }), botonAyuda('enviar', '¿Cómo envío a Vaelo?'))
        : el('div', {}, el('p', { class: 'pista', text: `Cuando ${c.minimo - c.confirmados === 1 ? 'falte 0' : 'tengas ' + c.minimo} confirmados aparece «Enviar a Vaelo».`.replace('falte 0', 'confirme uno más') }), botonAyuda('enlace', '¿Cómo hago que confirmen?')))
    : el('section', { class: 'bloque carpeta-estado' }, el('div', {},
      el('strong', { text: { nuevo: 'Vaelo la está preparando', en_ruta: 'En reparto', terminado: 'Terminada', cancelado: 'Cancelada' }[c.lote?.estado] || 'Enviada a Vaelo' }),
      c.lote ? el('small', { text: `${c.lote.modo_texto} · ${c.lote.entregados} de ${c.total} entregados${c.lote.en_camino ? ` · ${c.lote.en_camino} en camino` : ''}${c.lote.en_sede ? ` · ${c.lote.en_sede} en la sede de Vaelo` : ''}` }) : null,
      estadoFoco(c.foco, true)),
      r.minorista ? null : el('a', { class: 'boton borde chico', href: `/api/empresa/excel?dia=${c.dia}`, text: 'Excel del día' }));
  poner(caja, cabecera, estadoCaja, abierta && !r.punto ? bloquePunto(r, recargar) : null,
    abierta ? el('div', { class: 'carpeta-acciones' }, anadir, botonAyuda('pedido', '¿Cómo añado un pedido?'),
      r.minorista ? null : el('div', { class: 'navegar' }, el('label', { class: 'boton borde chico doc-boton' }, 'Subir Excel', archivo), el('a', { class: 'boton borde chico', href: '/api/empresa/pedidos/plantilla', text: 'Plantilla' }))) : null,
    msgArchivo,
    el('section', { class: 'bloque' },
      el('div', { class: 'cab-bloque' }, el('div', {}, el('h2', { text: `Envíos (${pedidos.length})` }), abierta ? botonAyuda('enlace', '¿Cómo mando el enlace?') : null),
        el('div', { class: 'navegar' },
          abierta && pedidos.some((p) => ['pendiente', 'esperando'].includes(p.estado)) ? el('button', { class: 'boton cinta chico', type: 'button', text: `Recordar a los que faltan (${pedidos.filter((p) => ['pendiente', 'esperando'].includes(p.estado)).length})`,
            onclick: () => dialogoRecordar(pedidos.filter((p) => ['pendiente', 'esperando'].includes(p.estado)), r, c) }) : null,
          pedidos.length ? el('button', { class: 'boton borde chico', type: 'button', text: 'Imprimir etiquetas', onclick: () => imprimirEtiquetas(pedidos, r.empresa) }) : null)),
      pedidos.length ? bloqueMarcado(c, abierta, pedidos, recargar) : null,
      pedidos.length ? el('ul', { class: 'pedidos-lista' }, pedidos.map((p) => filaPedido(p, r, c, recargar)))
        : el('div', { class: 'carpetas-vacio' }, el('p', { text: 'La carpeta está vacía. Toca «Añadir pedido» para apuntar el primero.' }))));
}

// Zona foco: si la carpeta califica para el descuento (en vivo mientras se arma; fijo cuando ya se envió)
function estadoFoco(f, enviada) {
  if (!f) return null;
  const titulo = f.aplica ? (enviada ? `Con descuento de zona foco (${f.zona})` : `Tu carpeta tiene descuento de zona foco (${f.zona})`) : (enviada ? `Sin descuento de zona foco (${f.zona})` : `Todavía no tiene descuento de zona foco (${f.zona})`);
  const precio = f.aplica && f.precio != null ? ` ${f.con_descuento === 1 ? 'Ese envío queda' : `Esos ${f.con_descuento} envíos quedan`} en ${dinero(f.precio)}.` : '';
  return el('div', { class: 'foco-estado' + (f.aplica ? ' aplica' : '') }, el('strong', { text: titulo }), el('p', { text: f.texto + precio + (f.falta && !enviada ? ' ' + f.falta : '') }));
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
    : !p.tiene_foto ? el('label', { class: 'boton cinta chico doc-boton', 'data-falta-foto': '1' }, 'Tomar foto', fotoInput)
    : p.estado === 'confirmado' ? null
    : el('a', { class: 'boton cinta chico', href: wa, target: '_blank', rel: 'noopener', onclick: mandar, text: p.estado === 'esperando' ? 'Recordar' : 'Mandar enlace' });
  const opciones = editable ? [
    p.tiene_foto && p.estado !== 'confirmado' ? null : el('a', { href: wa, target: '_blank', rel: 'noopener', onclick: mandar, text: p.estado === 'confirmado' ? 'Mandar enlace otra vez' : 'Mandar enlace por WhatsApp' }),
    el('button', { type: 'button', text: 'Copiar enlace', onclick: async (ev) => { mandar(); try { await navigator.clipboard.writeText(enlace); ev.target.textContent = 'Enlace copiado'; } catch { prompt('Enlace:', enlace); } } }),
    p.tiene_foto ? el('label', { class: 'doc-boton' }, 'Cambiar foto', fotoInput) : null,
    el('button', { type: 'button', text: p.envio_pagado ? 'Mi cliente no me ha pagado el envío' : 'Mi cliente ya me pagó el envío', onclick: async () => {
      if (!p.envio_pagado && !confirm(`¿${p.cliente_nombre} ya te pagó el envío? El piloto no se lo cobra y Vaelo te descuenta ese envío de lo que te entrega por tus productos.`)) return;
      try { await api(`/api/empresa/pedidos/${p.id}`, { method: 'PUT', body: { envio_pagado: !p.envio_pagado } }); recargar(); } catch (e) { alert(e.message); }
    } }),
    el('button', { type: 'button', text: p.cobro > 0 ? 'Cambiar lo que se cobra' : 'Cobrar el producto al entregar', onclick: async () => {
      const v = prompt(`¿Cuánto cobra el piloto a ${p.cliente_nombre} por tu producto? (Q, sin contar el envío; 0 si ya te pagó)`, p.cobro || '');
      if (v === null) return;
      try { await api(`/api/empresa/pedidos/${p.id}`, { method: 'PUT', body: { cobro: v.replace(/[^\d.]/g, '') || 0 } }); recargar(); } catch (x) { alert(x.message); }
    } }),
    el('button', { type: 'button', text: 'Mover a otra carpeta', onclick: () => dialogoMover(p, r, c, recargar) }),
    el('button', { type: 'button', class: 'peligro-texto', text: 'Quitar de la carpeta', onclick: async () => {
      const ok = await confirmarEliminar(p.estado === 'confirmado' ? { titulo: `¿Quitar el pedido de ${p.cliente_nombre}?`, aviso: 'Este pedido ya fue confirmado por tu cliente.',
        texto: 'Si lo quitas puedes perder a este cliente y el registro de su pedido. Volverás a hacer todo de nuevo: crear el pedido y mandarle otro enlace.', si: 'Sí, quitar' }
        : { titulo: `¿Quitar el pedido de ${p.cliente_nombre}?`, si: 'Sí, quitar' });
      if (!ok) return;
      await api(`/api/empresa/pedidos/${p.id}`, { method: 'DELETE' }).catch((x) => alert(x.message)); recargar();
    } })] : [];
  // Pedido ya en manos de Vaelo o entregado: se puede reportar un problema (llegó dañado, incompleto, se perdió)
  if (!editable && e && ['recogido', 'en_camino', 'entregado', 'fallido', 'a_sede', 'en_sede'].includes(e.estado)) {
    opciones.push(el('button', { type: 'button', text: 'Reportar un problema', onclick: () => dialogoReclamo(p, e, recargar) }));
  }
  const menu = opciones.length ? el('details', { class: 'menu-acciones' }, el('summary', { 'aria-label': 'Más opciones', title: 'Más opciones' }, '⋯'), el('div', { class: 'menu-lista' }, opciones)) : null;
  return el('li', { class: 'pedido-fila' },
    el('div', { class: 'pedido-info' },
      el('div', {}, p.codigo_corto && p.estado !== 'cancelado' ? el('span', { class: 'codigo-paquete', title: 'Escribe este código en el paquete con marcador', text: p.codigo_corto }) : null,
        el('strong', { text: p.cliente_nombre }), ' ', e ? el('span', { class: e.estado === 'entregado' ? 'etiqueta-completa' : ['fallido', 'a_sede', 'en_sede', 'devuelto', 'cancelado'].includes(e.estado) ? 'etiqueta-pendiente' : 'etiqueta-azul', text: ESTADO_ENVIO_EMP[e.estado] || p.estado_texto })
          : el('span', { class: ESTADO_PEDIDO_CLASE[p.estado] || 'etiqueta-gris', text: p.estado_texto }),
        !p.tiene_foto && editable ? el('span', { class: 'etiqueta-pendiente', style: 'margin-left:.3rem', text: 'Falta foto' }) : null,
        p.envio_pagado ? el('span', { class: 'etiqueta-azul', style: 'margin-left:.3rem', title: 'Tu cliente ya te pagó el envío: el piloto no se lo cobra', text: 'Envío ya pagado' }) : null,
        p.avisos ? el('span', { class: 'etiqueta-azul', style: 'margin-left:.3rem', title: 'Tu cliente activó los avisos', text: 'Avisos activos' }) : null),
      el('small', { text: `${p.codigo} · ${p.descripcion} · ${p.tamano_texto}${p.cobro > 0 ? ` · cobrar ${dinero(p.cobro)}` : ''}` }),
      p.estado === 'confirmado' || p.lote_id ? el('small', { text: `${p.horario_texto}${p.zona ? ' · ' + p.zona : ''}${p.direccion ? ' · ' + p.direccion : ''}` }) : null,
      p.estado === 'no_puede' ? el('small', { class: 'error-texto', text: `No puede ese día${p.no_puede_nota ? ': ' + p.no_puede_nota : ''}. Muévelo a otra carpeta desde «⋯».` }) : null,
      e ? el('small', { class: 'pedido-envio' }, el('b', { text: ESTADO_ENVIO_EMP[e.estado] || e.estado }),
        e.piloto ? ` · ${e.piloto}` : '', e.paradas > 1 ? ` · entrega ${e.parada} de ${e.paradas}` : '', e.recibio ? ` · recibió ${e.recibio}` : '',
        e.llega ? ` · llega aprox. ${e.llega}` : '', e.fallo ? ` · ${e.fallo}` : '', e.dias_sede ? ` · ${e.dias_sede} día(s) en la sede: pasa a recogerlo con el código` : '') : null),
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
// Juntar: los pedidos de esta carpeta (pocos o de un día que pasó) se van a otra carpeta abierta
async function dialogoJuntar(c, r, recargar) {
  let lista;
  try { lista = await api('/api/empresa/carpetas'); } catch (e) { alert(e.message); return; }
  const otras = lista.abiertas.filter((x) => x.id !== c.id && x.dia >= r.hoy);
  const dlg = el('dialog', { class: 'dialogo' });
  const msg = el('div', { class: 'mensaje', role: 'alert' });
  const juntar = (x) => async (ev) => {
    ev.target.disabled = true;
    try {
      const res = await api(`/api/empresa/carpetas/${c.id}/juntar`, { method: 'POST', body: { carpeta_id: x.id } });
      dlg.close();
      if (res.reconfirmar.length) alert(`Listo: ${res.movidos} pedido(s) pasaron a «${x.nombre}». Mándales el enlace otra vez para que confirmen la nueva fecha: ${res.reconfirmar.join(', ')}.`);
      recargar();
    } catch (e) { mostrarMensaje(msg, e.message); ev.target.disabled = false; }
  };
  dlg.append(el('button', { class: 'cerrar', type: 'button', 'aria-label': 'Cerrar', text: '×', onclick: () => dlg.close() }),
    el('h2', { text: 'Juntar con otra carpeta' }), el('p', { class: 'pista', text: `Los ${c.total} pedido(s) de «${c.nombre}» pasan a la carpeta que elijas y esta se cierra.` }), msg,
    otras.length ? el('div', { class: 'lista-mover' }, otras.map((x) => el('button', { class: 'opcion-mover', type: 'button', onclick: juntar(x) },
      el('strong', { text: x.nombre }), el('small', { text: `Entrega ${diaEmp(x.dia)} · ${x.total} envío(s)` })))) : el('p', { text: 'No tienes otra carpeta abierta de hoy en adelante. Crea la de tu próximo live y vuelve aquí.' }));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}
// Cómo marca la empresa sus paquetes: así el piloto sabe qué buscar (sin código no se recoge)
const MARCADO_TXT = {
  etiqueta: ['Guía impresa', 'Imprimes las guías con «Imprimir etiquetas» y pegas cada una en su paquete.', 'Recomendado'],
  codigo: ['Código escrito', 'Escribes con marcador, grande, el código amarillo de cada envío (TB-01, TB-02…) y debajo el nombre del cliente.', 'Si no tienes impresora'],
};
function bloqueMarcado(c, abierta, pedidos, recargar) {
  const m = c.marcado || 'codigo';
  const ejemplo = m === 'codigo' ? el('span', { class: 'codigo-paquete', text: pedidos.find((p) => p.codigo_corto)?.codigo_corto || 'TB-01' }) : null;
  return el('div', { class: 'bloque-marcado' },
    el('p', { class: 'aviso-codigos' }, ejemplo, el('span', {}, el('strong', { text: 'Cada paquete debe ir marcado. ' }), MARCADO_TXT[m][1].replace('TB-01, TB-02', pedidos.map((p) => p.codigo_corto).filter(Boolean).slice(0, 2).join(', ') || 'TB-01, TB-02'), ' Sin marca no se recoge: el piloto no sabría cuál es cuál.')),
    abierta ? el('div', { class: 'marcado-opciones', role: 'radiogroup', 'aria-label': '¿Cómo vas a marcar los paquetes?' },
      el('span', { class: 'etiqueta-campo', text: '¿Cómo vas a marcar los paquetes?' }),
      el('p', { class: 'marcado-recomienda' }, el('strong', { text: 'Recomendado: usar la guía impresa. ' }), 'Si no tienes impresora, usa «Código escrito»: escribes con marcador el código amarillo de cada envío y debajo el nombre del cliente.'),
      Object.entries(MARCADO_TXT).map(([k, [t, , nota]]) => el('button', { type: 'button', class: 'chip marcado-chip' + (k === 'etiqueta' ? ' recomendado' : ''), role: 'radio', 'aria-checked': String(k === m), 'aria-pressed': String(k === m),
        onclick: async () => { if (k === m) return; try { await api(`/api/empresa/carpetas/${c.id}`, { method: 'PUT', body: { marcado: k } }); recargar(); } catch (e) { alert(e.message); } } },
        el('span', { text: t }), el('small', { text: nota }))))
      : el('p', { class: 'pista', text: 'Marcados con: ' + MARCADO_TXT[m][0].toLowerCase() + '.' }));
}
// Reportar un problema con un pedido (queja): la oficina lo evalúa y, si fue culpa del piloto, se le descuenta y se compensa
const TIPOS_RECLAMO_EMP = { danado: 'Llegó dañado', incompleto: 'Llegó incompleto', perdido: 'El paquete se perdió', otro: 'Otro problema (trato, retraso, etc.)' };
async function dialogoReclamo(p, e, recargar) {
  let previos = { reclamos: [] };
  try { previos = await api(`/api/envios/${e.id}/reclamos`); } catch { /* sin historial */ }
  const dlg = el('dialog', { class: 'dialogo' });
  const msg = el('div', { class: 'mensaje', role: 'alert' });
  const abierto = previos.reclamos.find((r) => r.estado === 'abierto');
  const historial = previos.reclamos.map((r) => el('div', { class: 'mensaje ' + (r.estado === 'abierto' ? 'aviso' : r.estado === 'aprobado' ? 'exito' : 'error') },
    el('strong', { text: `${r.tipo_texto}: ` }), r.estado === 'abierto' ? 'lo estamos evaluando. Te contactaremos.' : r.resolucion || '',
    r.monto_cliente > 0 ? ` Devolución: Q${Number(r.monto_cliente).toFixed(2)}.` : '', r.cupon_monto > 0 ? ` Descuento de Q${Number(r.cupon_monto).toFixed(2)} en tu próximo envío.` : ''));
  const tipo = el('select', {}, Object.entries(TIPOS_RECLAMO_EMP).map(([k, t]) => el('option', { value: k, text: t })));
  const desc = el('textarea', { rows: 4, maxlength: 1000, placeholder: 'Qué pasó y qué llevaba el paquete (por ejemplo: la camisa llegó manchada; el cliente la devolvió)' });
  const foto = el('input', { type: 'file', accept: 'image/*' });
  const enviar = el('button', { class: 'boton', type: 'button', text: 'Enviar reporte', onclick: async () => {
    enviar.disabled = true; enviar.textContent = 'Enviando…';
    try {
      await api(`/api/envios/${e.id}/reclamo`, { body: { tipo: tipo.value, descripcion: desc.value, foto: foto.files[0] ? await prepararArchivo(foto.files[0], false) : '' } });
      dlg.close(); recargar(); alert('Recibimos tu reporte. La administración lo revisa y te avisamos la resolución.');
    } catch (err) { mostrarMensaje(msg, err.message); enviar.disabled = false; enviar.textContent = 'Enviar reporte'; }
  } });
  dlg.append(el('button', { class: 'cerrar', type: 'button', 'aria-label': 'Cerrar', text: '×', onclick: () => dlg.close() }),
    el('h2', { text: 'Reportar un problema' }),
    el('p', { class: 'pista', text: `Pedido ${p.codigo} de ${p.cliente_nombre}. Revisamos cada caso con la foto del paquete y la foto de entrega. Si fue culpa del piloto, se le descuenta y te compensamos.` }),
    ...historial, msg,
    ...(abierto ? [el('p', { class: 'pista', text: 'Ya tienes un reporte abierto para este pedido.' })] : [
      el('div', { class: 'campo' }, el('label', { text: '¿Qué pasó?' }), tipo),
      el('div', { class: 'campo' }, el('label', { text: 'Detalle' }), desc),
      el('div', { class: 'campo' }, el('label', { text: 'Foto del problema (opcional)' }), foto), enviar]));
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
        onclick: (ev) => { api(`/api/empresa/pedidos/${p.id}/enlace`, { body: {} }).catch(() => {}); ev.currentTarget.textContent = 'Enviado'; ev.currentTarget.classList.replace('cinta', 'borde'); }, text: 'Mandar' })))));
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
  const desc = el('input', { id: 'np-desc', maxlength: 200, placeholder: 'Ej. Blusa negra talla M' });
  let tamano = 'pequeno';
  const tamanos = el('div', { class: 'opciones opciones-tamano' }, ...Object.entries(r.tamanos).map(([k, t]) => el('label', { class: 'opcion' },
    el('input', { type: 'radio', name: 'np-tamano', value: k, checked: k === tamano, onchange: () => { tamano = k; } }), el('span', {}, t.nombre, el('small', { text: t.ayuda })))));
  const nombre = el('input', { id: 'np-nombre', maxlength: 100, autocomplete: 'off' });
  const tel = el('input', { id: 'np-tel', type: 'tel', maxlength: 30, placeholder: '5555 5555' });
  const cobro = el('input', { id: 'np-cobro', type: 'number', min: 0, max: 50000, step: '0.01', inputmode: 'decimal', placeholder: 'Ej. 150' });
  const pagadoChk = el('input', { type: 'checkbox', id: 'np-pagado', style: 'width:auto' });
  const pagado = el('div', { class: 'campo' }, el('label', { class: 'casilla', for: 'np-pagado' }, pagadoChk, el('span', { text: 'Mi cliente ya me pagó el envío' })),
    el('small', { class: 'pista', text: r.condiciones && r.condiciones.foco
      ? 'Antes de cobrarle el envío, mándale su enlace: cuando confirme sabrás su zona y si tu carpeta tiene descuento de zona foco. Si ya te pagó, Vaelo te descuenta este envío de lo que te entrega.'
      : 'El piloto no se lo cobra y Vaelo te descuenta este envío de lo que te entrega por tus productos.' }));
  const foto = el('input', { id: 'np-foto', type: 'file', accept: 'image/*', capture: 'environment' });
  const vistaFoto = el('img', { alt: '', hidden: true });
  const vacio = el('span', { class: 'foto-paquete-vacio' }, el('strong', { text: 'Foto del paquete' }), el('small', { text: 'Tócala para tomarla' }));
  foto.addEventListener('change', () => { if (foto.files[0]) { vistaFoto.src = URL.createObjectURL(foto.files[0]); vistaFoto.hidden = false; vacio.hidden = true; } });
  // Siempre con enlace exclusivo: la clienta confirma con su ubicación en tiempo real (la tienda ya no marca el lugar a mano)
  const llenar = false;
  const recomendacion = el('p', { class: 'recomendacion' }, el('strong', { text: 'Al guardar se abre WhatsApp con su enlace exclusivo. ' }),
    'Tu cliente confirma el horario, quién recibe y su ubicación en tiempo real, y el piloto llega directo.');
  const guardar = el('button', { class: 'boton accion-principal', type: 'submit', text: 'Guardar y mandar enlace' });
  const otroChk = el('input', { type: 'checkbox', id: 'np-otro', style: 'width:auto', checked: true });
  const otro = el('label', { class: 'casilla', for: 'np-otro' }, otroChk, el('span', { text: 'Después de guardar, añadir otro' }));
  // Pegar el mensaje del cliente (nombre, teléfono, dirección) y se llenan solos los campos
  const pegado = el('textarea', { rows: 3, placeholder: 'Pega aquí lo que te mandó tu cliente por WhatsApp, ej.\nMaría López\n5555 1234' });
  const cajaPegar = el('div', { class: 'pegar-mensaje', hidden: true }, pegado, el('small', { class: 'pista', text: 'Revisa que los datos queden bien.' }));
  pegado.addEventListener('input', () => {
    const d = leerMensajeCliente(pegado.value);
    if (d.nombre) nombre.value = d.nombre;
    if (d.telefono) tel.value = d.telefono;
  });
  const form = el('form', { novalidate: true },
    el('button', { class: 'boton borde chico', type: 'button', style: 'margin-bottom:.6rem', text: 'Pegar datos de WhatsApp', onclick: () => { cajaPegar.hidden = !cajaPegar.hidden; if (!cajaPegar.hidden) pegado.focus(); } }), cajaPegar,
    el('div', { class: 'fila' }, el('div', { class: 'campo' }, el('label', { for: 'np-nombre', text: '¿Quién te compró?' }), nombre), el('div', { class: 'campo' }, el('label', { for: 'np-tel', text: 'Su WhatsApp' }), tel)),
    el('div', { class: 'campo' }, el('label', { for: 'np-desc', text: '¿Qué compró?' }), desc),
    el('div', { class: 'campo', hidden: r.condiciones && r.condiciones.cobro_permitido === false }, el('label', { for: 'np-cobro' }, '¿Cuánto le cobramos por el producto? (Q)', el('span', { class: 'ayuda', text: r.condiciones && r.condiciones.cobro_tope ? ` Opcional, hasta ${dinero(r.condiciones.cobro_tope)}` : ' Opcional' })), cobro,
      el('small', { class: 'pista', text: 'Sin contar el envío. Déjalo vacío si ya te pagó. El piloto lo cobra y Vaelo te entrega ese dinero.' })),
    pagado,
    el('div', { class: 'campo' }, el('label', { text: 'Tamaño' }), tamanos),
    el('div', { class: 'campo' }, el('label', { for: 'np-foto' }, 'Foto del paquete', el('span', { class: 'ayuda', text: ' Puedes tomarla después, al empacar' })),
      el('div', { class: 'foto-paquete foto-paquete-chica' }, el('label', { class: 'foto-paquete-boton', for: 'np-foto' }, vistaFoto, vacio, foto))),
    recomendacion, msg, otro, guardar);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    guardar.disabled = true;
    // WhatsApp se abre ya: si se abre después de esperar al servidor, el navegador lo bloquea
    const ventana = !llenar ? window.open('about:blank', '_blank') : null;
    try {
      const body = { descripcion: desc.value, tamano, cliente_nombre: nombre.value, cliente_telefono: tel.value, cobro: cobro.value, envio_pagado: pagadoChk.checked };
      if (foto.files[0]) body.foto = await prepararArchivo(foto.files[0], false);
      const p = (await api(`/api/empresa/carpetas/${c.id}/pedidos`, { body })).pedido;
      if (ventana) { ventana.location.href = `https://wa.me/${waNum(p.cliente_telefono)}?text=${encodeURIComponent(textoEnlace(p, r, c.dia))}`; api(`/api/empresa/pedidos/${p.id}/enlace`, { body: {} }).catch(() => {}); }
      if (otroChk.checked) {
        desc.value = ''; nombre.value = ''; tel.value = ''; cobro.value = ''; pagadoChk.checked = false; foto.value = ''; vistaFoto.hidden = true; vacio.hidden = false;
        mostrarMensaje(msg, `Listo: ${p.cliente_nombre} quedó en la carpeta. Añade el siguiente.`, 'exito'); nombre.focus(); guardar.disabled = false; dlg.dataset.cambios = '1';
      } else { dlg.close(); recargar(); }
      window.avisoHecho?.('Pedido añadido', p.cliente_nombre);
    } catch (e) { if (ventana) ventana.close(); mostrarMensaje(msg, e.message); guardar.disabled = false; }
  });
  dlg.append(el('button', { class: 'cerrar', type: 'button', 'aria-label': 'Cerrar', text: '×', onclick: () => dlg.close() }),
    el('h2', { text: 'Nuevo pedido' }), el('p', { class: 'pista', text: `Se entrega el ${diaEmp(c.dia)}` }), form);
  dlg.addEventListener('close', () => { dlg.remove(); if (dlg.dataset.cambios) recargar(); });
  document.body.append(dlg); dlg.showModal(); nombre.focus();
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
      el('div', { class: 'opciones' }, ...[['empresa', 'El piloto los recoge en mi local', r.punto ? r.punto.direccion : 'Primero di dónde recoge el piloto (en Tus carpetas)'], ['sede', 'Yo los llevo a la sede de Vaelo', r.sede || 'Sede de Vaelo']].map(([k, t, a]) =>
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
      poner(dlg, el('div', { class: 'celebra-caja' }, window.checkAnimado ? checkAnimado() : null, el('h2', { text: '¡Listo! Vaelo ya tiene tu carpeta' }),
        el('p', { text: x.whatsapp ? 'Te abrimos WhatsApp para acordar el precio del pickup. Después Vaelo asigna el piloto.' : 'Vaelo arma las rutas (primero la entrega más cercana) y te avisamos cuando cada piloto acepte.' }),
        x.pendientes ? el('p', { class: 'pista', text: `${x.pendientes} envío(s) sin confirmar quedaron en una carpeta nueva.` }) : null,
        x.foco && x.foco.aplica ? el('p', { class: 'foco-estado aplica' }, el('strong', { text: `Tu carpeta tiene descuento de zona foco` }), `${x.foco.con_descuento} envío(s) a ${x.foco.zona} quedan en ${dinero(x.foco.precio)}.`) : null,
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
    <div class="cuerpo">${qrVaelo.svg(p.codigo, 120)}<div>${p.codigo_corto ? `<div class="corto">${esc(p.codigo_corto)}</div>` : ''}<div class="cod">${esc(p.codigo.slice(0, -4))}<u>${esc(p.codigo.slice(-4))}</u></div><div class="n">${esc(p.recibe_nombre || p.cliente_nombre)}</div>
    <div>${esc([p.zona, p.direccion].filter(Boolean).join(' · '))}</div><div>${esc(p.dia ? diaEmp(p.dia) : 'Fecha por confirmar')}${p.horario_texto ? ' · ' + esc(p.horario_texto) : ''}</div>
    <div class="t">${esc(p.tamano_texto)} · ${esc(p.descripcion)}</div></div></div></div>`).join('');
  w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Etiquetas Vaelo</title><style>
    body{font-family:Arial,sans-serif;margin:12px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
    .et{border:2px solid #000;border-radius:8px;break-inside:avoid;overflow:hidden}.cab{display:flex;justify-content:space-between;background:#0e2463;color:#fff;padding:6px 10px;font-size:13px}
    .cuerpo{display:flex;gap:10px;padding:8px;align-items:center;font-size:12px;line-height:1.35}.cod{font-size:20px;font-weight:bold;letter-spacing:.05em}.cod u{font-size:26px;text-decoration-thickness:3px}.n{font-size:15px;font-weight:bold}.corto{font-size:30px;font-weight:900;letter-spacing:.06em;border:3px solid #000;border-radius:6px;display:inline-block;padding:0 8px;margin-bottom:4px}.t{color:#555}
    @media print{body{margin:0}.no{display:none}}</style></head><body><p class="no"><button onclick="print()">Imprimir</button></p><div class="grid">${etiquetas}</div></body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch { /* el usuario imprime con el botón */ } }, 400);
}

// ---------- Analítica (sin dinero) ----------
async function panelAnalitica(caja, minorista = false) {
  let rango = 30;
  const zonaCifras = el('div'), zonaGraficas = el('div', { class: 'graficas-empresa' });
  const chips = el('div', { class: 'filtros' });
  const pintarChips = () => poner(chips, ...[[7, '7 días'], [30, '30 días'], [90, '90 días']].map(([d, t]) =>
    el('button', { class: 'chip', type: 'button', 'aria-pressed': String(d === rango), text: t, onclick: () => { rango = d; pintarChips(); cargar(); } })),
    minorista ? null : el('a', { class: 'boton borde chico', style: 'margin-left:auto', href: `/api/empresa/excel?dia=${hoyEmp()}`, text: 'Descargar Excel de hoy' }));
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
