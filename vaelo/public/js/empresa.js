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
  caja.replaceChildren(el('p', { class: 'pista', text: 'Cargando…' }));
  let r;
  try { r = await api('/api/empresa/solicitud'); } catch (e) { caja.replaceChildren(el('div', { class: 'mensaje error', text: e.message })); return; }
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
        el('li', {}, icono('sede'), 'Manda 10 paquetes o más a nuestra sede y nosotros repartimos'),
        el('li', {}, icono('grafica'), 'Estadísticas de tus entregas y cobros contra entrega'))),
    pasosNodo);
  const estadoNodo = {
    enviada: el('div', { class: 'mensaje aviso' }, el('strong', { text: 'Recibimos tu solicitud.' }), ' La estamos revisando. Te avisaremos para coordinar la cita y firmar el contrato.'),
    cita: el('div', { class: 'cita-empresa' }, icono('reloj'), el('div', {}, el('strong', { text: 'Tu cita para firmar el contrato' }),
      el('p', { text: s.cita_fecha ? new Date(s.cita_fecha + ':00-06:00').toLocaleString('es-GT', { timeZone: 'America/Guatemala', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }) : '' }),
      el('p', { class: 'pista', text: `${s.cita_lugar || ''}. Lleva el DPI del representante y la patente de comercio originales.${s.nota_admin ? ' ' + s.nota_admin : ''}` }))),
    rechazada: el('div', { class: 'mensaje error' }, el('strong', { text: 'Tu solicitud necesita cambios: ' }), s.motivo_rechazo || '', ' Corrige y vuelve a enviarla.'),
  }[s.estado] || null;
  if (!editable) { caja.replaceChildren(intro, estadoNodo || '', resumenSolicitud(s, r)); return; }

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
    progreso.replaceChildren(el('div', { class: 'progreso-barra' }, el('i', { style: `width:${Math.round((hechos / total) * 100)}%` })),
      el('small', { text: sol.falta.length ? `Llevas ${hechos} de ${total}. Te falta ${sol.falta.length}.` : 'Todo completo. Ya puedes enviar tu solicitud.' }));
    enviar.disabled = !!sol.falta.length;
  };
  const guardar = async () => {
    const body = Object.fromEntries(Object.entries(campos).map(([k, i]) => [k, i.value]));
    const res = await api('/api/empresa/solicitud', { method: 'PUT', body });
    Object.assign(s, res.solicitud); pintarProgreso(res.solicitud);
  };
  const doc = (campo) => campoDocumento({ titulo: r.documentos[campo].nombre, tiene: s.docs[campo], ver: `/api/empresa/solicitud/documento/${campo}`,
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
    seccion('3', 'Fotos y documentos', 'Fotos claras de la sede y documentos legibles. Fotos o PDF de máximo 700 KB.',
      el('div', { class: 'docs' }, Object.keys(r.documentos).map(doc))),
    seccion('4', 'Enviar', null, progreso,
      el('label', { class: 'casilla', for: 'emp-politica' }, acepto, el('span', {}, 'Leí y acepto las ', el('a', { href: '/politicas-empresas', target: '_blank', text: 'políticas y condiciones para empresas' }),
        '. Entiendo que Vaelo presta su servicio de pilotos y que mi empresa no gana comisiones de Vaelo.')),
      msg, enviar));
  caja.replaceChildren(intro, estadoNodo || '', form);
  pintarProgreso(s);
}
function resumenSolicitud(s, r) {
  return el('section', { class: 'bloque' }, el('h2', { text: s.empresa_nombre || 'Tu solicitud' }),
    el('div', { class: 'datos' },
      ...[['NIT', s.nit], ['Giro', s.giro], ['Sede', [s.direccion, s.zona].filter(Boolean).join(', ')], ['Paquetes al mes', s.paquetes_mes], ['Representante', `${s.rep_nombre || ''}, ${s.rep_cargo || ''}`], ['Teléfono', s.telefono]]
        .map(([t, v]) => el('div', {}, el('span', { text: t }), String(v ?? '')))),
    el('div', { class: 'docs' }, Object.keys(r.documentos).filter(k => s.docs[k]).map(k => campoDocumento({ titulo: r.documentos[k].nombre, tiene: true, ver: `/api/empresa/solicitud/documento/${k}`, soloVer: true }))));
}

// ---------- Después del contrato: panel de la empresa ----------
async function panelEmpresa(caja, op) {
  const yo = (await api('/api/yo')).usuario;
  let rango = 30;
  const zonaCifras = el('div'), zonaGraficas = el('div', { class: 'graficas-empresa' });
  const chips = el('div', { class: 'filtros' });
  const pintarChips = () => chips.replaceChildren(...[[7, '7 días'], [30, '30 días'], [90, '90 días']].map(([d, t]) =>
    el('button', { class: 'chip', type: 'button', 'aria-pressed': String(d === rango), text: t, onclick: () => { rango = d; pintarChips(); cargar(); } })));
  async function cargar() {
    const hoy = new Date(Date.now() - 6 * 3600e3);
    const desde = new Date(hoy - (rango - 1) * 86400e3).toISOString().slice(0, 10);
    let st;
    try { st = await api(`/api/empresa/estadisticas?desde=${desde}&hasta=${hoy.toISOString().slice(0, 10)}`); } catch (e) { zonaCifras.replaceChildren(el('div', { class: 'mensaje error', text: e.message })); return; }
    const g = st.general;
    const c = (t, v, marcar) => el('div', { class: 'celda-cifra' + (marcar ? ' marcar' : '') }, el('span', { text: t }), el('strong', { text: String(v) }));
    zonaCifras.replaceChildren(el('div', { class: 'franja-cifras' },
      c('Envíos', g.envios), c('Paquetes', g.paquetes), c('Entregados', g.entregados), c('Éxito de entrega', g.exito != null ? g.exito + '%' : '—'),
      c('En curso', g.en_curso), c('Tiempo promedio', g.minutos != null ? `${g.minutos} min` : '—'),
      c('Cobrado contra entrega', dinero(g.cobrado)), c('Vaelo te debe entregar', dinero(st.cobros_por_recibir), st.cobros_por_recibir > 0),
      c('Paquetes en la sede', st.en_sede, st.en_sede > 0), c('Bodega acumulada hoy', dinero(st.costo_sede_hoy)), c('Cargos pendientes', dinero(st.cargos_pendientes), st.cargos_pendientes > 0)));
    const max = Math.max(1, ...st.porDia.map(d => d.envios));
    const dias = []; for (let i = rango - 1; i >= 0; i--) dias.push(new Date(hoy - i * 86400e3).toISOString().slice(0, 10));
    const porDia = Object.fromEntries(st.porDia.map(d => [d.dia, d]));
    const maxZ = Math.max(1, ...st.porZona.map(z => z.envios));
    zonaGraficas.replaceChildren(
      el('div', { class: 'bloque' }, el('h2', { text: 'Envíos por día' }),
        el('div', { class: 'barras', role: 'img', 'aria-label': 'Envíos por día' }, dias.map(d => {
          const x = porDia[d] || { envios: 0, entregados: 0 };
          return el('div', { class: 'barra', title: `${new Date(d + 'T12:00:00').toLocaleDateString('es-GT', { day: 'numeric', month: 'short' })}: ${x.envios} envíos, ${x.entregados || 0} entregados` },
            el('i', { style: `height:${(x.envios / max) * 100}%` }, el('b', { style: `height:${x.envios ? ((x.entregados || 0) / x.envios) * 100 : 0}%` })));
        })),
        el('div', { class: 'leyenda' }, el('span', {}, el('i', { style: 'background:#1c3faa' }), 'Entregados'), el('span', {}, el('i', { style: 'background:#c9d3f5' }), 'Otros'))),
      el('div', { class: 'bloque' }, el('h2', { text: 'Zonas con más entregas' }),
        st.porZona.length ? el('div', { class: 'barras-h' }, st.porZona.map(z => el('div', {}, el('span', { text: z.zona }), el('i', { style: `width:${(z.envios / maxZ) * 100}%` }), el('b', { text: String(z.envios) }))))
          : el('p', { class: 'pista', text: 'Todavía no hay envíos en estas fechas.' }),
        st.porFallo.length ? [el('h3', { style: 'margin-top:1rem', text: 'Por qué no se entregaron' }), el('ul', { class: 'lista-simple' }, st.porFallo.map(f => el('li', { text: `${f.texto}: ${f.n}` })))] : null));
  }
  const zonaLotes = el('div');
  async function cargarLotes() {
    const r = await api('/api/empresa/lotes');
    const EST = { esperando: ['Esperando que lleguen', 'etiqueta-azul'], recibido: ['En la sede', 'etiqueta-completa'], cancelado: ['Cancelado', 'etiqueta-gris'] };
    zonaLotes.replaceChildren(r.lotes.length ? el('ul', { class: 'movimientos' }, r.lotes.map(l => el('li', {},
      el('span', {}, el('strong', { text: `${l.paquetes} paquetes · ${fecha(l.creado, false)}` }), ' ', el('span', { class: EST[l.estado][1], text: EST[l.estado][0] }),
        el('small', { text: `${l.entregas} entregas · ${l.entregados} entregadas${l.en_sede ? ` · ${l.en_sede} en la sede` : ''}${l.entregar_desde ? ' · repartir desde ' + l.entregar_desde : ''}` })),
      el('span', { class: 'monto', text: l.costo_hoy ? `${dinero(l.costo_hoy)} de bodega` : l.estado === 'recibido' && l.en_sede ? 'Sin costo si salen hoy' : '' }))))
      : el('p', { class: 'pista', text: 'Todavía no has mandado paquetes a la sede.' }));
    return r;
  }
  const lotesInfo = await cargarLotes().catch(() => ({ tarifa: 10, minimo: 10, sede: '' }));
  // Envío a la sede desde un archivo CSV
  const COLS = ['destino_nombre', 'destino_telefono', 'destino_direccion', 'destino_zona', 'paquetes', 'peso', 'descripcion', 'cobro_destinatario', 'notas'];
  const TITS = ['Nombre de quien recibe', 'Teléfono', 'Dirección', 'Zona', 'Paquetes', 'Peso (lb)', 'Contenido', 'Cobrar al recibir (Q)', 'Indicaciones'];
  let filas = [];
  const msg = el('div', { class: 'mensaje', role: 'alert' });
  const vista = el('div');
  const archivo = el('input', { type: 'file', accept: '.csv,text/csv' });
  const fechaRep = el('input', { type: 'date', min: new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10) });
  const metodo = el('select', {}, el('option', { value: 'recibe', text: 'Paga quien recibe' }), el('option', { value: 'efectivo', text: 'La empresa paga en efectivo' }),
    yo.credito_permitido ? el('option', { value: 'credito', text: 'A fin de mes (crédito)' }) : null);
  const totalPaq = () => filas.reduce((t, f) => t + Math.max(1, Math.round(Number(f.paquetes)) || 1), 0);
  const pintarVista = () => vista.replaceChildren(filas.length ? [
    el('p', {}, el('strong', { text: `${filas.length} entregas, ${totalPaq()} paquetes` }), totalPaq() < lotesInfo.minimo ? el('span', { class: 'error-texto', text: ` · faltan ${lotesInfo.minimo - totalPaq()} paquetes para el mínimo` }) : ''),
    el('div', { class: 'tabla-envoltura' }, el('table', {}, el('thead', {}, el('tr', {}, TITS.slice(0, 5).map(t => el('th', { text: t })))),
      el('tbody', {}, filas.slice(0, 60).map(f => el('tr', {}, COLS.slice(0, 5).map(k => el('td', { text: f[k] || '' }))))))) ] : '');
  archivo.addEventListener('change', async () => {
    const f = archivo.files[0]; if (!f) return;
    const crudo = leerCsv(await f.text());
    const datos = /nombre/i.test(crudo[0]?.[0] || '') ? crudo.slice(1) : crudo;
    filas = datos.map(c => Object.fromEntries(COLS.map((k, i) => [k, c[i] || ''])));
    mostrarMensaje(msg, ''); pintarVista();
  });
  const resultado = el('div');
  const formLote = el('div', { class: 'bloque' },
    el('div', { class: 'seccion-cab' }, el('span', { class: 'num' }, icono('sede')), el('div', {}, el('h2', { text: 'Mandar paquetes a la sede de Vaelo' }),
      el('p', { class: 'pista', text: `Mínimo ${lotesInfo.minimo} paquetes. Los llevas a la sede${lotesInfo.sede ? ' (' + lotesInfo.sede + ')' : ''} y nosotros los repartimos. Si salen el mismo día que llegan, no pagas bodega; si se quedan, cuesta ${dinero(lotesInfo.tarifa)} por paquete por día.` }))),
    el('div', { class: 'navegar' },
      el('button', { class: 'boton borde chico', type: 'button', text: 'Descargar plantilla', onclick: () => {
        const ej = [TITS, ['Ana López', '5555-0000', '5a avenida 3-20', 'Zona 10', '2', '3', 'Ropa', '150', 'Llamar al llegar']];
        const csv = '﻿' + ej.map(f => f.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
        const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'plantilla-sede-vaelo.csv' }); document.body.append(a); a.click(); a.remove();
      } }),
      el('label', { class: 'boton chico doc-boton' }, 'Subir lista (CSV)', archivo)),
    el('div', { class: 'fila', style: 'margin-top:.75rem' },
      el('div', { class: 'campo' }, el('label', { text: 'Repartir a partir de' }, el('span', { class: 'ayuda', text: ' Vacío = en cuanto lleguen' })), fechaRep),
      el('div', { class: 'campo' }, el('label', { text: '¿Quién paga los envíos?' }), metodo)),
    vista, msg,
    el('button', { class: 'boton', type: 'button', text: 'Crear envío a la sede', onclick: async (ev) => {
      if (!filas.length) { mostrarMensaje(msg, 'Sube la lista de entregas.'); return; }
      ev.target.disabled = true;
      try {
        const r = await fetch('/api/empresa/lote-sede', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filas, entregar_desde: fechaRep.value, metodo_pago: metodo.value }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (d.errores) mostrarMensaje(msg, 'Corrige la lista: ' + d.errores.slice(0, 6).join(' · '));
          else mostrarMensaje(msg, d.error || 'No se pudo crear.');
          ev.target.disabled = false; return;
        }
        filas = []; archivo.value = ''; pintarVista();
        resultado.replaceChildren(el('div', { class: 'mensaje exito' }, el('strong', { text: `Listo: ${d.paquetes} paquetes en ${d.envios} entregas.` }),
          ' Lleva los paquetes a la sede con la guía de cada uno escrita en la caja. Manda a cada persona su enlace para que comparta su ubicación (también los tienes en Mis envíos).'),
          el('ul', { class: 'movimientos' }, d.enlaces.map(x => el('li', {}, el('strong', { text: x.guia }),
            el('button', { class: 'boton borde chico', type: 'button', text: 'Copiar enlace', onclick: async (e2) => { try { await navigator.clipboard.writeText(location.origin + x.enlace); e2.target.textContent = 'Copiado'; } catch { prompt('Enlace:', location.origin + x.enlace); } } })))));
        ev.target.disabled = false; cargarLotes(); cargar();
      } catch (e) { mostrarMensaje(msg, e.message); ev.target.disabled = false; }
    } }), resultado);

  caja.replaceChildren(
    el('div', { class: 'empresa-cabecera' }, el('div', {}, el('span', { class: 'etiqueta-completa', text: 'Contrato firmado' }), el('h2', { text: yo.empresa_nombre || yo.nombre }),
      el('p', { class: 'pista', text: 'Los envíos que hagas en "Enviar paquete" salen con los pilotos de Vaelo. Vaelo toma Q5 de cada envío y el resto es para el piloto.' })),
      el('a', { class: 'boton borde chico', href: '/politicas-empresas', target: '_blank', text: 'Políticas para empresas' })),
    chips, zonaCifras, zonaGraficas, formLote,
    el('section', { class: 'bloque' }, el('h2', { text: 'Tus envíos a la sede' }), zonaLotes));
  pintarChips(); cargar();
}
