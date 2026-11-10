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
  poner(caja, intro, estadoNodo || '', form);
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
// "Mandar varios pedidos": la empresa registra sus pedidos, su cliente confirma con un enlace y, con el mínimo
// de confirmados para un día, se mandan a Vaelo. Aquí no se muestra dinero: Vaelo solo cobra el envío a quien recibe.
const DIAS_EMP = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const diaEmp = (d) => { if (!d) return ''; const f = new Date(d + 'T12:00:00Z'); return `${DIAS_EMP[f.getUTCDay()]} ${f.getUTCDate()} de ${f.toLocaleDateString('es-GT', { month: 'long', timeZone: 'UTC' })}`; };
const hoyEmp = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
const waNum = (t) => { let n = String(t || '').replace(/\D/g, ''); if (n.length === 8) n = '502' + n; return n; };
const ESTADO_PEDIDO_CLASE = { pendiente: 'etiqueta-pendiente', esperando: 'etiqueta-azul', confirmado: 'etiqueta-completa', en_vaelo: 'etiqueta-azul', enviado: 'etiqueta-gris', vencido: 'etiqueta-pendiente' };
const ESTADO_ENVIO_EMP = { pendiente: 'Por recoger', recogido: 'Recogido', en_camino: 'En camino', entregado: 'Entregado', fallido: 'No se entregó', a_sede: 'Va a la sede', en_sede: 'En la sede de Vaelo', devuelto: 'Devuelto', reenviado: 'Reenviado', cancelado: 'Cancelado' };

async function panelEmpresa(caja) {
  const yo = (await api('/api/yo')).usuario;
  let vista = new URLSearchParams(location.search).get('vista') === 'analitica' ? 'analitica' : 'pedidos';
  const cuerpo = el('div');
  const pest = el('div', { class: 'pestanas', role: 'tablist' });
  const pintarPest = () => poner(pest, ...[['pedidos', 'Mandar varios pedidos'], ['analitica', 'Analítica']].map(([k, t]) =>
    el('button', { type: 'button', role: 'tab', 'aria-selected': String(vista === k), text: t, onclick: () => { vista = k; pintarPest(); abrir(); } })));
  const abrir = () => (vista === 'pedidos' ? panelPedidos(cuerpo, yo) : panelAnalitica(cuerpo));
  poner(caja, 
    el('div', { class: 'empresa-cabecera' }, el('div', {}, el('span', { class: 'etiqueta-completa', text: 'Contrato firmado' }), el('h2', { text: yo.empresa_nombre || yo.nombre }),
      el('p', { class: 'pista', text: 'Vaelo te presta sus pilotos: cada cliente paga su envío al recibir. Tu empresa solo paga si eliges pickup pagado por ti o si un paquete se queda en la sede.' })),
      el('a', { class: 'boton borde chico', href: '/politicas-empresas', target: '_blank', text: 'Políticas para empresas' })),
    pest, cuerpo);
  pintarPest(); abrir();
}

// ---------- Pedidos ----------
async function panelPedidos(caja, yo) {
  poner(caja, el('p', { class: 'pista', text: 'Cargando tus pedidos…' }));
  let r;
  try { r = await api('/api/empresa/pedidos'); } catch (e) { poner(caja, el('div', { class: 'mensaje error', text: e.message })); return; }
  const recargar = () => panelPedidos(caja, yo);
  let filtro = 'activos';
  const seleccion = new Set();

  // 1) Punto de recogida (donde el piloto pasa por los paquetes)
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
    poner(punto, el('h3', { text: '¿Dónde recoge el piloto tus paquetes?' }), el('p', { class: 'pista', text: 'Marca tu local o bodega. Desde aquí se arman las rutas: primero la entrega más cercana.' }),
      mapa, el('div', { class: 'campo' }, el('label', { text: 'Dirección' }), dir), msg,
      el('div', { class: 'navegar' }, el('button', { class: 'boton chico', type: 'button', text: 'Guardar', onclick: async () => {
        try { if (!p) throw new Error('Marca el punto en el mapa.'); const x = await api('/api/empresa/punto', { method: 'PUT', body: { lat: p.lat, lng: p.lng, direccion: dir.value } }); r.punto = x.punto; pintarPunto(false); }
        catch (e) { mostrarMensaje(msg, e.message); }
      } }), r.punto ? el('button', { class: 'boton borde chico', type: 'button', text: 'Cancelar', onclick: () => pintarPunto(false) }) : null));
    const sel = selectorPunto(mapa, { letra: 'A', clase: 'recogida', conMiUbicacion: true, alCambiar: (x) => { p = x; }, alDireccion: (t, usar) => { if (usar || !dir.value) dir.value = t; } });
    if (p) sel.poner(p.lat, p.lng);
  };
  pintarPunto(false);

  // 2) "Enviar a Vaelo": un recuadro por día con pedidos confirmados
  const enviar = el('div', { class: 'dias-envio' });
  for (const d of r.dias) {
    const listo = d.confirmados >= r.minimo;
    enviar.append(el('div', { class: 'dia-envio' + (listo ? ' listo' : '') },
      el('div', {}, el('span', { class: 'dia-nombre', text: diaEmp(d.dia) }), el('strong', { text: `${d.confirmados} confirmado${d.confirmados === 1 ? '' : 's'}` }),
        el('div', { class: 'progreso-barra' }, el('i', { style: `width:${Math.min(100, Math.round((d.confirmados / r.minimo) * 100))}%` })),
        el('small', { text: listo ? (d.sin_foto ? `Falta la foto de ${d.sin_foto} paquete(s).` : 'Listo para mandar a Vaelo.') : `Faltan ${r.minimo - d.confirmados} para mandarlos (mínimo ${r.minimo}).` })),
      listo ? el('button', { class: 'boton cinta', type: 'button', text: 'Enviar a Vaelo', onclick: () => dialogoEnviar(d, r, recargar) }) : null));
  }
  const lotes = r.lotes.filter((l) => l.estado !== 'cancelado');
  const bloqueEnviar = el('section', { class: 'bloque' }, el('h2', { text: 'Enviar a Vaelo' }),
    r.dias.length ? enviar : el('p', { class: 'pista', text: `Cuando tengas ${r.minimo} pedidos confirmados para el mismo día, aquí aparece el botón para mandarlos a Vaelo.` }),
    lotes.length ? el('ul', { class: 'movimientos', style: 'margin-top:1rem' }, lotes.map((l) => el('li', {},
      el('span', {}, el('strong', { text: `${diaEmp(l.dia)} · ${l.pedidos} pedidos · ${l.modo_texto}` }), ' ',
        el('span', { class: { nuevo: 'etiqueta-azul', en_ruta: 'etiqueta-completa', terminado: 'etiqueta-gris' }[l.estado], text: { nuevo: 'Vaelo lo está preparando', en_ruta: 'En ruta', terminado: 'Terminado' }[l.estado] }),
        el('small', { text: `${l.entregados} entregados${l.recogida === 'sede' ? (l.recibido_en ? ' · paquetes recibidos en la sede' : ' · llévalos a la sede de Vaelo') : ' · Vaelo recoge en tu local'}` })),
      l.estado === 'nuevo' ? el('button', { class: 'boton borde chico', type: 'button', text: 'Cancelar', onclick: async () => { if (!confirm('¿Cancelar este envío a Vaelo? Los pedidos quedan confirmados.')) return; await api(`/api/empresa/lotes/${l.id}/cancelar`, { body: {} }).catch((e) => alert(e.message)); recargar(); } }) : null))) : null);

  // 3) Nuevo pedido
  const nuevo = formNuevoPedido(r, recargar);

  // 4) Lista de pedidos
  const lista = el('div');
  const chips = el('div', { class: 'filtros' });
  const FILTROS = [['activos', 'Por enviar'], ['pendiente', 'Falta información'], ['esperando', 'Esperando cliente'], ['confirmado', 'Confirmados'], ['en_vaelo', 'Enviados a Vaelo'], ['enviado', 'En reparto'], ['vencido', 'Vencidos']];
  const porEnviar = (p) => !['enviado', 'en_vaelo'].includes(p.estado);
  const cuenta = (k) => k === 'activos' ? r.pedidos.filter(porEnviar).length : r.pedidos.filter((p) => p.estado === k).length;
  const acciones = el('div', { class: 'navegar' });
  const pintarAcciones = () => poner(acciones, 
    el('button', { class: 'boton borde chico', type: 'button', disabled: !seleccion.size, text: seleccion.size ? `Imprimir ${seleccion.size} etiqueta(s)` : 'Elige pedidos para imprimir etiquetas',
      onclick: () => imprimirEtiquetas(r.pedidos.filter((p) => seleccion.has(p.id)), r.empresa) }),
    el('a', { class: 'boton borde chico', href: `/api/empresa/excel?dia=${hoyEmp()}`, text: 'Excel de hoy' }));
  const pintarLista = () => {
    poner(chips, ...FILTROS.filter(([k]) => k === 'activos' || cuenta(k)).map(([k, t]) => el('button', { class: 'chip', type: 'button', 'aria-pressed': String(filtro === k), text: `${t} (${cuenta(k)})`, onclick: () => { filtro = k; pintarLista(); } })));
    const ver = r.pedidos.filter((p) => filtro === 'activos' ? porEnviar(p) : p.estado === filtro);
    poner(lista, ver.length ? el('ul', { class: 'pedidos-lista' }, ver.map((p) => filaPedido(p, r, seleccion, () => { pintarAcciones(); }, recargar)))
      : el('p', { class: 'pista', text: filtro === 'activos' ? 'Todavía no tienes pedidos por enviar. Agrega uno arriba o sube tu Excel.' : 'No hay pedidos aquí.' }));
    pintarAcciones();
  };
  pintarLista();
  poner(caja, punto, bloqueEnviar, nuevo,
    el('section', { class: 'bloque' }, el('div', { class: 'cab-bloque' }, el('h2', { text: 'Tus pedidos' }), acciones), chips, lista));
}

function filaPedido(p, r, seleccion, alElegir, recargar) {
  const enlace = location.origin + p.enlace;
  const texto = `Hola ${p.cliente_nombre.split(' ')[0]}, ${r.empresa} te enviará tu pedido (${p.descripcion}) con Vaelo. Elige aquí el día, el horario y el lugar para recibirlo: ${enlace}`;
  const fotoInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: async () => {
    try { await api(`/api/empresa/pedidos/${p.id}/foto`, { body: { foto: await prepararArchivo(fotoInput.files[0], false) } }); recargar(); } catch (e) { alert(e.message); }
  } });
  const mandar = async () => { api(`/api/empresa/pedidos/${p.id}/enlace`, { body: {} }).catch(() => {}); };
  const e = p.envio;
  const editable = ['pendiente', 'esperando', 'confirmado', 'vencido'].includes(p.estado) && !p.lote_id;
  const casilla = el('input', { type: 'checkbox', 'aria-label': 'Elegir para etiqueta ' + p.codigo, checked: seleccion.has(p.id), onchange: (ev) => { if (ev.target.checked) seleccion.add(p.id); else seleccion.delete(p.id); alElegir(); } });
  return el('li', { class: 'pedido-fila' },
    casilla,
    el('div', { class: 'pedido-info' },
      el('div', {}, el('strong', { text: p.cliente_nombre }), ' ', el('span', { class: ESTADO_PEDIDO_CLASE[p.estado] || 'etiqueta-gris', text: p.estado_texto }),
        !p.tiene_foto && editable ? el('span', { class: 'etiqueta-pendiente', style: 'margin-left:.3rem', text: 'Falta foto' }) : null,
        p.avisos ? el('span', { class: 'etiqueta-azul', style: 'margin-left:.3rem', title: 'Tu cliente activó los avisos', text: 'Avisos activos' }) : null),
      el('small', { text: `${p.codigo} · ${p.descripcion} · ${p.tamano_texto}` }),
      p.dia ? el('small', { text: `${diaEmp(p.dia)} · ${p.horario_texto}${p.zona ? ' · ' + p.zona : ''}${p.confirmado_por === 'cliente' ? ' · lo confirmó tu cliente' : ''}` }) : null,
      e ? el('small', { class: 'pedido-envio' }, el('b', { text: ESTADO_ENVIO_EMP[e.estado] || e.estado }),
        e.piloto ? ` · ${e.piloto}` : '', e.paradas > 1 ? ` · entrega ${e.parada} de ${e.paradas}` : '', e.recibio ? ` · recibió ${e.recibio}` : '',
        e.fallo ? ` · ${e.fallo}` : '', e.dias_sede ? ` · ${e.dias_sede} día(s) en la sede: pasa a recogerlo con el código` : '') : null),
    el('div', { class: 'pedido-acciones' },
      editable && p.estado !== 'confirmado' ? el('a', { class: 'boton cinta chico', href: `https://wa.me/${waNum(p.cliente_telefono)}?text=${encodeURIComponent(texto)}`, target: '_blank', rel: 'noopener', onclick: mandar,
        text: p.estado === 'esperando' ? 'Reenviar enlace' : 'Mandar enlace' }) : null,
      editable ? el('button', { class: 'boton borde chico', type: 'button', text: 'Copiar enlace', onclick: async (ev) => { mandar(); try { await navigator.clipboard.writeText(enlace); ev.target.textContent = 'Copiado'; } catch { prompt('Enlace:', enlace); } } }) : null,
      editable && !p.tiene_foto ? el('label', { class: 'boton borde chico doc-boton' }, 'Tomar foto', fotoInput) : null,
      editable ? el('button', { class: 'boton borde chico', type: 'button', text: p.estado === 'confirmado' ? 'Editar' : 'Llenar yo', onclick: () => dialogoLlenar(p, r, recargar) }) : null,
      editable ? el('button', { class: 'boton-icono', type: 'button', 'aria-label': 'Cancelar pedido ' + p.codigo, title: 'Cancelar pedido', onclick: async () => {
        if (!confirm(`¿Cancelar el pedido de ${p.cliente_nombre}?`)) return;
        await api(`/api/empresa/pedidos/${p.id}`, { method: 'DELETE' }).catch((x) => alert(x.message)); recargar();
      } }, '×') : null));
}

// Formulario de pedido nuevo: lo mínimo, y opcionalmente los datos de entrega (si la empresa los llena)
function formNuevoPedido(r, recargar) {
  const msg = el('div', { class: 'mensaje', role: 'alert' });
  const desc = el('input', { id: 'np-desc', maxlength: 200, placeholder: 'Blusa talla M, factura, caja de zapatos…' });
  let tamano = 'pequeno';
  const tamanos = el('div', { class: 'opciones' }, ...Object.entries(r.tamanos).map(([k, t]) => el('label', { class: 'opcion' },
    el('input', { type: 'radio', name: 'np-tamano', value: k, checked: k === tamano, onchange: () => { tamano = k; } }), el('span', {}, t.nombre, el('small', { text: t.ayuda })))));
  const nombre = el('input', { id: 'np-nombre', maxlength: 100, autocomplete: 'off' });
  const tel = el('input', { id: 'np-tel', type: 'tel', maxlength: 30, placeholder: '5555 5555' });
  const foto = el('input', { id: 'np-foto', type: 'file', accept: 'image/*', capture: 'environment' });
  const vistaFoto = el('img', { alt: '', hidden: true });
  const vacio = el('span', { class: 'foto-paquete-vacio' }, el('strong', { text: 'Foto del paquete' }), el('small', { text: 'Se necesita antes de mandarlo a Vaelo' }));
  foto.addEventListener('change', () => { if (foto.files[0]) { vistaFoto.src = URL.createObjectURL(foto.files[0]); vistaFoto.hidden = false; vacio.hidden = true; } });
  const datosEntrega = camposEntrega({}, r);
  datosEntrega.nodo.hidden = true;
  const llenarYo = el('input', { type: 'checkbox', id: 'np-llenar', style: 'width:auto', onchange: () => { datosEntrega.nodo.hidden = !llenarYo.checked; if (llenarYo.checked) datosEntrega.refrescar(); guardar.textContent = llenarYo.checked ? 'Guardar pedido' : 'Guardar y mandar enlace por WhatsApp'; } });
  const resultado = el('div');
  const guardar = el('button', { class: 'boton', type: 'submit', text: 'Guardar y mandar enlace por WhatsApp' });
  const limpiar = () => { desc.value = ''; nombre.value = ''; tel.value = ''; foto.value = ''; vistaFoto.hidden = true; vacio.hidden = false; };
  const form = el('form', { novalidate: true },
    el('div', { class: 'fila' }, el('div', { class: 'campo' }, el('label', { for: 'np-desc', text: '¿Qué es el paquete?' }), desc),
      el('div', { class: 'campo' }, el('label', { for: 'np-nombre', text: 'Nombre de tu cliente' }), nombre), el('div', { class: 'campo' }, el('label', { for: 'np-tel', text: 'WhatsApp de tu cliente' }), tel)),
    el('div', { class: 'campo' }, el('label', { text: 'Tamaño' }), tamanos),
    el('div', { class: 'foto-paquete foto-paquete-chica' }, el('label', { class: 'foto-paquete-boton', for: 'np-foto' }, vistaFoto, vacio, foto)),
    el('label', { class: 'casilla', for: 'np-llenar' }, llenarYo, el('span', { text: 'Ya tengo los datos de entrega: los lleno yo (día, horario, lugar y quién recibe)' })),
    datosEntrega.nodo, msg, guardar, resultado);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    guardar.disabled = true;
    // La ventana de WhatsApp se abre ya (si se abre después de esperar al servidor, el navegador la bloquea)
    const ventana = !llenarYo.checked ? window.open('about:blank', '_blank') : null;
    try {
      const body = { descripcion: desc.value, tamano, cliente_nombre: nombre.value, cliente_telefono: tel.value };
      if (foto.files[0]) body.foto = await prepararArchivo(foto.files[0], false);
      if (llenarYo.checked) Object.assign(body, datosEntrega.leer(), { llenar: true });
      const x = await api('/api/empresa/pedidos', { body });
      const p = x.pedido;
      if (ventana) {
        const texto = `Hola ${p.cliente_nombre.split(' ')[0]}, ${r.empresa} te enviará tu pedido (${p.descripcion}) con Vaelo. Elige aquí el día, el horario y el lugar para recibirlo: ${location.origin + p.enlace}`;
        ventana.location.href = `https://wa.me/${waNum(p.cliente_telefono)}?text=${encodeURIComponent(texto)}`;
        api(`/api/empresa/pedidos/${p.id}/enlace`, { body: {} }).catch(() => {});
      }
      limpiar();
      poner(resultado, el('div', { class: 'mensaje exito', text: p.estado === 'confirmado' ? `Pedido ${p.codigo} confirmado.` : `Pedido ${p.codigo} guardado. Cuando tu cliente llene su enlace, queda confirmado.` }));
      setTimeout(recargar, 1200);
    } catch (e) { if (ventana) ventana.close(); mostrarMensaje(msg, e.message); }
    guardar.disabled = false;
  });
  // Excel con muchos pedidos
  const archivo = el('input', { type: 'file', accept: '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv', hidden: true });
  const msgArchivo = el('div', { class: 'mensaje', role: 'alert' });
  archivo.addEventListener('change', async () => {
    const f = archivo.files[0]; if (!f) return;
    try {
      const datos = await new Promise((ok, mal) => { const lector = new FileReader(); lector.onload = () => ok(lector.result); lector.onerror = mal; lector.readAsDataURL(f); });
      const res = await fetch('/api/empresa/pedidos/archivo', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archivo: datos }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { mostrarMensaje(msgArchivo, d.errores ? 'Revisa el archivo: ' + d.errores.slice(0, 6).join(' · ') : (d.error || 'No se pudo leer.')); return; }
      mostrarMensaje(msgArchivo, `Listo: ${d.creados} pedidos. Ahora manda a cada cliente su enlace desde la lista.`, 'exito');
      setTimeout(recargar, 1500);
    } catch (e) { mostrarMensaje(msgArchivo, e.message); }
    archivo.value = '';
  });
  return el('section', { class: 'bloque' },
    el('div', { class: 'cab-bloque' }, el('div', {}, el('h2', { text: 'Nuevo pedido' }), el('p', { class: 'pista', text: 'Registra el pedido y mándale el enlace a tu cliente: él elige el día, el horario y marca su ubicación.' })),
      el('div', { class: 'navegar' }, el('a', { class: 'boton borde chico', href: '/api/empresa/pedidos/plantilla', text: 'Plantilla de Excel' }), el('label', { class: 'boton borde chico doc-boton' }, 'Subir Excel', archivo))),
    msgArchivo, form);
}

// Campos de entrega (día, horario, mapa, zona, dirección, quién recibe y pago) para cuando la empresa los llena
function camposEntrega(p, r) {
  const hoy = hoyEmp();
  const dia = el('input', { type: 'date', min: hoy, value: p.dia && p.dia >= hoy ? p.dia : '' });
  let horario = p.horario || 'cualquiera';
  const horarios = el('div', { class: 'opciones' }, ...Object.entries(r.horarios).map(([k, t]) => el('label', { class: 'opcion' },
    el('input', { type: 'radio', name: 'ce-horario-' + (p.id || 'n'), value: k, checked: horario === k, onchange: () => { horario = k; } }), el('span', { text: t }))));
  const zona = el('select', {}, el('option', { value: '', text: 'Elige…' }), ...(r.zonas || []).map((z) => el('option', { value: z, text: z, selected: p.zona === z })));
  const direccion = el('input', { maxlength: 300, value: p.direccion || '' });
  const referencias = el('input', { maxlength: 300, value: p.referencias || '', placeholder: 'Opcional' });
  const rn = el('input', { maxlength: 100, value: p.recibe_nombre || p.cliente_nombre || '' });
  const rt = el('input', { type: 'tel', maxlength: 30, value: p.recibe_telefono || p.cliente_telefono || '' });
  const pago = el('select', {}, el('option', { value: 'efectivo', text: 'Paga al recibir (efectivo)', selected: p.metodo_pago !== 'transferencia' }), el('option', { value: 'transferencia', text: 'Transferencia a Vaelo', selected: p.metodo_pago === 'transferencia' }));
  const mapa = el('div');
  let punto = p.lat != null ? { lat: p.lat, lng: p.lng } : null, sel = null;
  const nodo = el('div', { class: 'campos-entrega' },
    el('div', { class: 'fila' }, el('div', { class: 'campo' }, el('label', { text: 'Día de entrega' }), dia), el('div', { class: 'campo' }, el('label', { text: 'Horario' }), horarios)),
    mapa,
    el('div', { class: 'fila' }, el('div', { class: 'campo' }, el('label', { text: 'Zona o municipio' }), zona), el('div', { class: 'campo' }, el('label', { text: 'Dirección' }), direccion),
      el('div', { class: 'campo' }, el('label', { text: 'Referencias' }), referencias)),
    el('div', { class: 'fila' }, el('div', { class: 'campo' }, el('label', { text: 'Quién recibe' }), rn), el('div', { class: 'campo' }, el('label', { text: 'Su teléfono' }), rt),
      el('div', { class: 'campo' }, el('label', { text: 'El envío se paga' }), pago)));
  const asegurarMapa = () => {
    if (sel) { sel.refrescar(); return; }
    sel = selectorPunto(mapa, { letra: 'B', clase: 'entrega', alCambiar: async (x) => {
      punto = x;
      try { const z = await api(`/api/zona?lat=${x.lat}&lng=${x.lng}`); if (z.zona) zona.value = z.zona; } catch { /* vacío */ }
    }, alDireccion: (t, usar) => { if (usar || !direccion.value) direccion.value = t; } });
    if (punto) sel.poner(punto.lat, punto.lng);
  };
  return { nodo, refrescar: asegurarMapa,
    leer: () => {
      if (!punto) throw new Error('Marca en el mapa dónde se entrega.');
      return { dia: dia.value, horario, lat: punto.lat, lng: punto.lng, zona: zona.value, direccion: direccion.value, referencias: referencias.value, recibe_nombre: rn.value, recibe_telefono: rt.value, metodo_pago: pago.value };
    } };
}
function dialogoLlenar(p, r, recargar) {
  const dlg = el('dialog', { class: 'dialogo hoja' });
  const msg = el('div', { class: 'mensaje', role: 'alert' });
  const campos = camposEntrega(p, r);
  dlg.append(el('button', { class: 'cerrar', type: 'button', 'aria-label': 'Cerrar', text: '×', onclick: () => dlg.close() }),
    el('h2', { text: `Pedido de ${p.cliente_nombre}` }), el('p', { class: 'pista', text: `${p.codigo} · ${p.descripcion}` }), campos.nodo, msg,
    el('button', { class: 'boton', type: 'button', text: 'Guardar', onclick: async () => {
      try { await api(`/api/empresa/pedidos/${p.id}`, { method: 'PUT', body: campos.leer() }); dlg.close(); recargar(); } catch (e) { mostrarMensaje(msg, e.message); }
    } }));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal(); campos.refrescar();
}

// "Enviar a Vaelo": recomendación y las tres formas de repartir
async function dialogoEnviar(d, r, recargar) {
  const dlg = el('dialog', { class: 'dialogo hoja' });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
  dlg.append(el('p', { class: 'pista', text: 'Calculando la mejor forma de repartir…' }));
  let rec = null;
  try { rec = (await api(`/api/empresa/recomendacion?dia=${d.dia}`)).recomendacion; } catch { /* sin recomendación */ }
  let modo = rec?.modo || 'una_moto', recogida = 'empresa', paga = 'clientes';
  const hayGrandes = d.grandes > 0;
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
      el('div', { class: 'opciones' }, ...[['empresa', 'El piloto los recoge en mi local', r.punto ? r.punto.direccion : 'Primero marca tu local arriba'], ['sede', 'Yo los llevo a la sede de Vaelo', r.sede || 'Sede de Vaelo']].map(([k, t, a]) =>
        el('label', { class: 'opcion' }, el('input', { type: 'radio', name: 'recogida-lote', value: k, checked: recogida === k, onchange: () => { recogida = k; } }), el('span', {}, t, el('small', { text: a }))))),
      modo === 'pickup' ? [el('h3', { style: 'margin-top:1rem', text: '¿Quién paga el pickup?' }),
        el('div', { class: 'opciones' }, ...[['empresa', 'Mi empresa', 'Hablas primero con Vaelo por WhatsApp: precio y promoción'], ['clientes', 'Cada cliente', 'Q35 en zonas preferenciales y Q45 fuera, al recibir o por transferencia']].map(([k, t, a]) =>
          el('label', { class: 'opcion' }, el('input', { type: 'radio', name: 'paga-lote', value: k, checked: paga === k, onchange: () => { paga = k; pintar(); } }), el('span', {}, t, el('small', { text: a })))))] : null,
      recogida === 'sede' ? el('p', { class: 'pista', text: 'Si los paquetes salen el mismo día que llegan a la sede no hay costo de bodega.' }) : null);
  };
  pintar();
  const boton = el('button', { class: 'boton cinta accion-principal', type: 'button', text: `Enviar ${d.confirmados} pedidos a Vaelo`, onclick: async () => {
    boton.disabled = true;
    const ventana = modo === 'pickup' && paga === 'empresa' ? window.open('about:blank', '_blank') : null;
    try {
      const x = await api('/api/empresa/enviar', { body: { dia: d.dia, modo, recogida, paga } });
      if (ventana && x.whatsapp) ventana.location.href = x.whatsapp; else if (ventana) ventana.close();
      poner(dlg, el('div', { class: 'celebra-caja' }, el('h2', { text: '¡Listo! Vaelo ya tiene tus pedidos' }),
        el('p', { text: x.whatsapp ? 'Te abrimos WhatsApp para acordar el precio del pickup. Cuando se confirme el pago, Vaelo asigna el piloto.' : 'Vaelo arma las rutas (primero la entrega más cercana) y te avisamos cuando cada piloto acepte.' }),
        x.whatsapp ? el('a', { class: 'boton cinta', href: x.whatsapp, target: '_blank', rel: 'noopener', text: 'Abrir WhatsApp de Vaelo' }) : null,
        el('button', { class: 'boton borde', type: 'button', style: 'margin-left:.5rem', text: 'Cerrar', onclick: () => dlg.close() })));
      recargar();
    } catch (e) { if (ventana) ventana.close(); mostrarMensaje(msg, e.message); boton.disabled = false; }
  } });
  poner(dlg, el('button', { class: 'cerrar', type: 'button', 'aria-label': 'Cerrar', text: '×', onclick: () => dlg.close() }),
    el('h2', { text: 'Enviar a Vaelo' }), el('p', { class: 'pista', text: `${d.confirmados} pedidos para el ${diaEmp(d.dia)}.` }),
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
