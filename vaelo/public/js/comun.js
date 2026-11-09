// Funciones compartidas por todas las páginas de Vaelo
'use strict';

const ESTADOS = {
  pendiente: 'Pendiente de recoger',
  recogido: 'Recogido',
  en_camino: 'En camino',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};
const PAGOS = { efectivo: 'Efectivo', transferencia: 'Transferencia', credito: 'A fin de mes (crédito)' };
// Fecha y hora en Guatemala de un texto UTC de la base, para mostrar envíos programados
const fechaProgramada = (t) => t ? new Date(t.replace(' ', 'T') + 'Z').toLocaleString('es-GT', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
// Texto de una promoción: "15% de descuento", "Q10 de descuento", "envío gratis"
const textoPromo = (p) => p.tipo === 'gratis' ? 'envío gratis' : p.tipo === 'porcentaje' ? `${p.valor}% de descuento` : `${dinero(p.valor)} de descuento`;
function bannerPromo(p) {
  if (!p) return '';
  const hasta = new Date(p.hasta + 'T12:00:00').toLocaleDateString('es-GT', { day: 'numeric', month: 'long' });
  return el('div', { class: 'promo-banner' }, el('strong', { text: p.nombre }), el('span', { text: ` ${textoPromo(p)} en tus envíos hasta el ${hasta}.` }));
}
const CENTRO_GUATE = [14.6349, -90.5069];

async function api(ruta, opciones = {}) {
  const init = { method: opciones.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opciones.body !== undefined) {
    init.method = opciones.method || 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opciones.body);
  }
  let res;
  try { res = await fetch(ruta, init); }
  catch { throw new Error('No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.'); }
  let data = {};
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Algo salió mal. Inténtalo de nuevo.');
    err.status = res.status;
    throw err;
  }
  return data;
}

const dinero = (n) => 'Q' + Number(n || 0).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Las fechas se guardan en hora UTC; aquí se muestran en la hora local del teléfono o computadora
function fecha(texto, conHora = true) {
  if (!texto) return '';
  const d = new Date(texto.replace(' ', 'T') + 'Z');
  const op = conHora ? { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return d.toLocaleString('es-GT', op);
}

function el(etiqueta, atributos = {}, ...hijos) {
  const nodo = document.createElement(etiqueta);
  for (const [k, v] of Object.entries(atributos)) {
    if (v == null || v === false) continue;
    if (k === 'class') nodo.className = v;
    else if (k === 'text') nodo.textContent = v;
    else if (k.startsWith('on')) nodo.addEventListener(k.slice(2), v);
    else nodo.setAttribute(k, v === true ? '' : v);
  }
  for (const h of hijos.flat()) if (h != null && h !== false) nodo.append(h instanceof Node ? h : document.createTextNode(String(h)));
  return nodo;
}

const chipEstado = (estado) => el('span', { class: `estado ${estado}`, text: ESTADOS[estado] || estado });

function mostrarMensaje(nodo, texto, tipo = 'error') {
  nodo.className = `mensaje ${tipo}`;
  nodo.textContent = texto || '';
  if (texto) nodo.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

const telLink = (t) => el('a', { href: 'tel:' + String(t || '').replace(/[^\d+]/g, ''), text: t });

// Si el logo no carga, se muestra el nombre escrito para que la barra nunca quede vacía
function logoRespaldo(img) {
  const oscuro = /negro/.test(img.getAttribute('src') || '');
  img.replaceWith(el('span', { class: 'marca-texto' + (oscuro ? ' oscuro' : ''), text: 'Vaelo' }));
}
document.addEventListener('error', (ev) => {
  const t = ev.target;
  if (t && t.tagName === 'IMG' && /\/img\/logo-/.test(t.getAttribute('src') || '') && !t.dataset.respaldo) { t.dataset.respaldo = '1'; logoRespaldo(t); }
}, true);
// Logos que ya fallaron antes de que este archivo cargara
document.querySelectorAll('img[src*="/img/logo-"]').forEach((i) => { if (i.complete && !i.naturalWidth && !i.dataset.respaldo) { i.dataset.respaldo = '1'; logoRespaldo(i); } });

// Barra superior: cambia según quién inició sesión
async function pintarBarra() {
  const barra = document.getElementById('barra');
  if (!barra) return null;
  let usuario = null;
  try { usuario = (await api('/api/yo')).usuario; } catch { /* sin sesión */ }
  const nav = el('nav', { class: 'nav', 'aria-label': 'Principal' });
  if (!usuario || usuario.rol !== 'mensajero') nav.append(el('a', { href: '/rastreo', text: 'Rastrear' }));
  if (usuario) {
    if (usuario.rol === 'admin') nav.append(el('a', { href: '/familiatecun', text: 'Panel' }));
    if (usuario.rol === 'mensajero') nav.append(el('a', { href: '/modomensajero', text: 'Mis entregas' }));
    if (usuario.rol !== 'mensajero') nav.append(el('a', { href: '/mi-cuenta', text: 'Mis envíos' }));
    nav.append(el('button', { class: 'enlace', type: 'button', text: 'Salir', onclick: salir }));
  } else {
    nav.append(el('a', { href: '/entrar', text: 'Entrar' }));
    nav.append(el('a', { href: '/registro', class: 'boton cinta chico', text: 'Crear cuenta' }));
  }
  const logo = el('img', { src: '/img/logo-blanco.png', alt: 'Vaelo', width: 139, height: 40 });
  logo.addEventListener('error', () => logoRespaldo(logo));
  const marca = el('a', { href: '/', class: 'marca' }, logo);
  barra.replaceChildren(el('div', { class: 'contenedor' }, marca, nav));
  return usuario;
}

async function salir() {
  try { await api('/api/logout', { body: {} }); } catch { /* igual salimos */ }
  location.href = '/';
}

const codigoBarras = () => el('div', { class: 'codigo-barras', 'aria-hidden': 'true' });

// Guía imprimible para pegar en el paquete
function guiaImprimible(e) {
  return el('div', { class: 'guia-imprimible' },
    el('div', { class: 'franja' }, el('img', { src: '/img/logo-negro.png', alt: 'Vaelo', height: 24 }), el('span', { text: `${e.vehiculo || ''} · ${e.peso} lb` })),
    el('div', { class: 'numero', text: e.guia }),
    e.fragil ? el('div', { class: 'guia-fragil', text: 'FRÁGIL · MANEJAR CON CUIDADO' }) : null,
    codigoBarras(),
    el('div', { class: 'partes' },
      el('div', {}, el('span', { text: 'Envía' }), e.cliente_nombre || '', el('br'), e.origen_telefono || '', el('br'), e.origen_zona || ''),
      el('div', {}, el('span', { text: 'Recibe' }), el('strong', { text: e.destino_nombre }), el('br'), e.destino_telefono, el('br'), e.destino_direccion, el('br'), e.destino_zona || '')),
    el('div', { class: 'partes' },
      Number(e.cobro_destinatario) > 0
        ? el('div', {}, el('span', { text: 'Cobrar al recibir' }), el('strong', { text: dinero(e.cobro_destinatario) }))
        : el('div', {}, el('span', { text: 'Fecha' }), fecha(e.creado, false)),
      el('div', {}, el('span', { text: 'Contenido' }), e.descripcion || 'Sin descripción')));
}

// ---------- Mapas (MapLibre: mapa vectorial, suave al tacto) ----------
// La librería se sirve desde nuestro propio servidor (/vendor/maplibre). El mapa base es OpenFreeMap (gratis, sin llave);
// si no carga, se cambia solo a CARTO. Funciona con dos dedos en el celular y tiene botón de pantalla completa.
const ESTILO_MAPA = 'https://tiles.openfreemap.org/styles/liberty';
const ESTILO_RESPALDO = {
  version: 8,
  sources: { carto: { type: 'raster', tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap © CARTO',
    tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png`) } },
  layers: [{ id: 'carto', type: 'raster', source: 'carto' }],
};
// Con clave de Mapbox se usa Mapbox (mapa más completo y moderno); si no carga, MapLibre con el mapa gratis
const usaMapbox = () => !!(window.VAELO_MAPBOX && window.mapboxgl);
const motorMapa = () => (usaMapbox() ? window.mapboxgl : window.maplibregl);
const hayMapa = () => !!motorMapa();
const sinAnimacion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const esTactil = () => window.matchMedia('(pointer: coarse)').matches;

class Mapa {
  constructor(contenedor, centro, zoom, { cooperativo = true } = {}) {
    this.lineas = new Map();
    this.cuenta = 0;
    this.estiloListo = false;
    const gl = this.gl = motorMapa();
    const mapbox = this.mapbox = usaMapbox();
    if (mapbox) gl.accessToken = window.VAELO_MAPBOX;
    this.mapa = new gl.Map({
      container: contenedor,
      style: window.VAELO_ESTILO_MAPA || (mapbox ? 'mapbox://styles/mapbox/standard' : ESTILO_MAPA),
      ...(mapbox ? { config: { basemap: { lightPreset: 'day', showPointOfInterestLabels: true, showTransitLabels: false } }, language: 'es' } : {}),
      center: [centro[1], centro[0]], zoom, maxZoom: 19, minZoom: 6,
      cooperativeGestures: cooperativo && esTactil(),   // en el celular se mueve con dos dedos, así la página sigue bajando con uno
      dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: mapbox ? true : { compact: true },
      locale: { 'CooperativeGesturesHandler.MobileHelpText': 'Usa dos dedos para mover el mapa', 'CooperativeGesturesHandler.WindowsHelpText': 'Usa Ctrl + rueda para acercar el mapa',
        'CooperativeGesturesHandler.MacHelpText': 'Usa ⌘ + rueda para acercar el mapa', 'NavigationControl.ZoomIn': 'Acercar', 'NavigationControl.ZoomOut': 'Alejar',
        'GeolocateControl.FindMyLocation': 'Mi ubicación', 'FullscreenControl.Enter': 'Pantalla completa', 'FullscreenControl.Exit': 'Salir de pantalla completa' },
    });
    this.mapa.touchZoomRotate.disableRotation();
    this.mapa.addControl(new gl.NavigationControl({ showCompass: false }), 'top-right');
    this.mapa.addControl(new gl.FullscreenControl(), 'top-right');
    this.mapa.addControl(new gl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, showAccuracyCircle: false }), 'top-right');
    this.mapa.addControl(new gl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    // Si el mapa base no carga, se cambia al de respaldo
    let respaldo = false, mosaicos = 0, errores = 0;
    const usarRespaldo = () => { if (respaldo || window.VAELO_ESTILO_MAPA) return; respaldo = true; this.estiloListo = false; this.mapa.setStyle(ESTILO_RESPALDO); };
    this.mapa.on('error', (ev) => { if (!this.estiloListo) usarRespaldo(); else if (ev && ev.sourceId && ++errores >= 6 && !mosaicos) usarRespaldo(); });
    this.mapa.on('sourcedata', (ev) => { if (ev.tile) mosaicos++; });
    setTimeout(() => { if (!this.estiloListo) usarRespaldo(); }, 8000);
    this.mapa.on('style.load', () => { this.estiloListo = true; for (const id of this.lineas.keys()) this._pintarLinea(id); });
    if ('ResizeObserver' in window) new ResizeObserver(() => this.mapa.resize()).observe(contenedor);
  }
  // Marcador con HTML propio. op: html, ancla ('bottom' o 'center'), popup (nodo o texto), arrastrable, alMover(lat, lng)
  marcador(lat, lng, op = {}) {
    const elemento = document.createElement('div');
    elemento.innerHTML = op.html || '';
    const m = new this.gl.Marker({ element: elemento, anchor: op.ancla || 'bottom', draggable: !!op.arrastrable }).setLngLat([lng, lat]).addTo(this.mapa);
    if (op.popup) m.setPopup(new this.gl.Popup({ offset: op.ancla === 'center' ? 18 : 38, maxWidth: '260px' }).setDOMContent(op.popup instanceof Node ? op.popup : el('div', { text: op.popup })));
    if (op.alMover) m.on('dragend', () => { const p = m.getLngLat(); op.alMover(p.lat, p.lng); });
    return { mover: (la, ln) => m.setLngLat([ln, la]), quitar: () => m.remove(), abrir: () => m.togglePopup() };
  }
  // Línea entre puntos [[lat, lng], ...]. op: color, ancho, punteada, opacidad
  linea(puntos, op = {}) {
    const id = 'linea-' + (++this.cuenta);
    this.lineas.set(id, { puntos, op });
    this._pintarLinea(id);
    return { quitar: () => this._quitarLinea(id), actualizar: (p) => { this.lineas.get(id).puntos = p; this._pintarLinea(id); } };
  }
  _pintarLinea(id) {
    const d = this.lineas.get(id);
    if (!d || !this.estiloListo) return;
    const datos = { type: 'Feature', geometry: { type: 'LineString', coordinates: d.puntos.map(([la, ln]) => [ln, la]) } };
    const fuente = this.mapa.getSource(id);
    if (fuente) return fuente.setData(datos);
    this.mapa.addSource(id, { type: 'geojson', data: datos });
    this.mapa.addLayer({ id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': d.op.color || '#1c3faa', 'line-width': d.op.ancho || 4, 'line-opacity': d.op.opacidad ?? 0.85, ...(d.op.punteada ? { 'line-dasharray': [1.5, 2] } : {}) } });
  }
  _quitarLinea(id) {
    this.lineas.delete(id);
    if (!this.estiloListo) return;
    if (this.mapa.getLayer(id)) this.mapa.removeLayer(id);
    if (this.mapa.getSource(id)) this.mapa.removeSource(id);
  }
  // Grupo de marcadores y líneas que se borran juntos (para el mapa de la flota que se actualiza)
  grupo() {
    const cosas = [];
    return {
      marcador: (...a) => { const x = this.marcador(...a); cosas.push(x); return x; },
      linea: (...a) => { const x = this.linea(...a); cosas.push(x); return x; },
      limpiar: () => { cosas.splice(0).forEach((x) => x.quitar()); },
    };
  }
  encuadrar(puntos, { margen = 50, maxZoom = 15 } = {}) {
    const p = puntos.filter((x) => x && x[0] != null && x[1] != null);
    if (!p.length) return;
    if (p.length === 1) { this.mapa.jumpTo({ center: [p[0][1], p[0][0]], zoom: Math.min(maxZoom, 15) }); return; }
    const b = new this.gl.LngLatBounds([p[0][1], p[0][0]], [p[0][1], p[0][0]]);
    p.forEach(([la, ln]) => b.extend([ln, la]));
    this.mapa.fitBounds(b, { padding: margen, maxZoom, duration: sinAnimacion() ? 0 : 900 });
  }
  centrar(lat, lng, zoom) { this.mapa.easeTo({ center: [lng, lat], zoom: zoom ?? this.mapa.getZoom(), duration: 400 }); }
  alTocar(fn) { this.mapa.on('click', (ev) => fn(ev.lngLat.lat, ev.lngLat.lng)); }
  refrescar() { this.mapa.resize(); }
}

function crearMapa(contenedor, op = {}) {
  if (!hayMapa()) {
    contenedor.replaceChildren(el('div', { class: 'mapa-error', text: 'No se pudo cargar el mapa. Revisa tu conexión y recarga la página.' }));
    return null;
  }
  try { return new Mapa(contenedor, op.centro || CENTRO_GUATE, op.zoom || 12, op); }
  catch {
    contenedor.replaceChildren(el('div', { class: 'mapa-error', text: 'Este navegador no puede mostrar el mapa. Prueba con Chrome actualizado.' }));
    return null;
  }
}

const htmlPin = (letra, clase) => `<div class="pin-envoltura"><div class="pin ${clase}"><span>${letra}</span></div></div>`;
const htmlReceptor = () => '<div class="pin-receptor" title="Quien recibe"><span></span></div>';
const htmlPiloto = (clase = '') => `<div class="pin-mensajero ${clase}" title="Piloto"><span></span></div>`;

// Dibuja recogida (A), entrega (B), la línea entre ambos y la posición del piloto
function dibujarEnvio(mapa, e) {
  if (!mapa) return;
  const puntos = [];
  if (e.origen_lat != null) { mapa.marcador(e.origen_lat, e.origen_lng, { html: htmlPin('A', 'recogida'), popup: 'Recogida: ' + (e.origen_direccion || '') }); puntos.push([e.origen_lat, e.origen_lng]); }
  if (e.destino_lat != null) {
    mapa.marcador(e.destino_lat, e.destino_lng, { html: htmlPin('B', e.estado === 'entregado' ? 'entregado' : 'entrega'), popup: (e.estado === 'entregado' ? 'Entregado aquí: ' : 'Entrega: ') + (e.destino_direccion || '') });
    puntos.push([e.destino_lat, e.destino_lng]);
  }
  if (puntos.length === 2) animarRuta(mapa, puntos[0], puntos[1], { color: '#1c3faa', ancho: 4, punteada: true, opacidad: 0.8 });
  if (e.mensajero_lat != null) {
    mapa.marcador(e.mensajero_lat, e.mensajero_lng, { html: htmlPiloto(), ancla: 'center', popup: `${e.mensajero_nombre || 'Piloto'}. Actualizado ${fecha(e.mensajero_ubic_fecha)}` });
    puntos.push([e.mensajero_lat, e.mensajero_lng]);
  }
  mapa.encuadrar(puntos);
}

// La línea de A a B se dibuja poco a poco
function animarRuta(mapa, a, b, op) {
  if (sinAnimacion()) return mapa.linea([a, b], op);
  const linea = mapa.linea([a, a], op);
  const inicio = performance.now(), duracion = 1100;
  const paso = (t) => {
    const k = Math.min(1, (t - inicio) / duracion), e = 1 - Math.pow(1 - k, 3);
    linea.actualizar([a, [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e]]);
    if (k < 1) requestAnimationFrame(paso);
  };
  setTimeout(() => requestAnimationFrame(paso), 350);
  return linea;
}

// ---------- Direcciones (búsqueda con sugerencias y dirección de un punto) ----------
// Photon (de OpenStreetMap) sugiere lugares mientras escribes; si no responde se usa Nominatim. Solo dentro de Guatemala.
function nombreLugar(p) {
  const calle = [p.street, p.housenumber].filter(Boolean).join(' ');
  const principal = p.name && p.name !== calle ? p.name : (calle || p.name || '');
  const zona = [p.name && calle && p.name !== calle ? calle : '', p.district || p.locality || p.suburb, p.city || p.county, p.state]
    .filter((x, i, a) => x && a.indexOf(x) === i && x !== principal);
  return { nombre: principal || zona.shift() || 'Lugar sin nombre', detalle: zona.join(', ') };
}
// Con Mapbox: busca direcciones en Mapbox y negocios en Photon al mismo tiempo, y junta los resultados
async function buscarMapbox(q) {
  const url = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}&country=gt&language=es&limit=5&autocomplete=true&proximity=-90.51,14.63&access_token=${window.VAELO_MAPBOX}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) return [];
  return (await r.json()).features.map((f) => ({ nombre: f.properties.name, detalle: f.properties.place_formatted || '',
    lat: f.properties.coordinates?.latitude ?? f.geometry.coordinates[1], lng: f.properties.coordinates?.longitude ?? f.geometry.coordinates[0] }));
}
async function buscarDireccion(q) {
  if (window.VAELO_MAPBOX) {
    const [mb, ph] = await Promise.all([buscarMapbox(q).catch(() => []), buscarPhoton(q).catch(() => [])]);
    const juntos = [];
    for (const x of [...ph.slice(0, 3), ...mb, ...ph.slice(3)]) {
      if (!juntos.some((y) => Math.abs(y.lat - x.lat) < 0.0005 && Math.abs(y.lng - x.lng) < 0.0005)) juntos.push(x);
    }
    if (juntos.length) return juntos.slice(0, 7);
  }
  return buscarPhoton(q);
}
async function buscarPhoton(q) {
  try {
    const url = 'https://photon.komoot.io/api/?limit=6&lat=14.63&lon=-90.51&bbox=-92.3,13.7,-88.2,17.9&q=' + encodeURIComponent(q);
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const lista = (await r.json()).features.filter((f) => f.properties.countrycode === 'GT' || !f.properties.countrycode)
        .map((f) => ({ ...nombreLugar(f.properties), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
      if (lista.length) return lista;
    }
  } catch { /* se prueba con el otro buscador */ }
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=gt&accept-language=es&q=' + encodeURIComponent(q);
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('El buscador de direcciones no respondió. Marca el punto tocando el mapa.');
  return (await r.json()).map((x) => {
    const partes = x.display_name.split(', ');
    return { nombre: partes.slice(0, 2).join(', '), detalle: partes.slice(2, -1).join(', '), lat: Number(x.lat), lng: Number(x.lon) };
  });
}
async function direccionDe(lat, lng) {
  if (window.VAELO_MAPBOX) {
    try {
      const r = await fetch(`https://api.mapbox.com/search/geocode/v6/reverse?longitude=${lng}&latitude=${lat}&language=es&limit=1&access_token=${window.VAELO_MAPBOX}`, { signal: AbortSignal.timeout(6000) });
      if (r.ok) { const f = (await r.json()).features[0]; if (f) return f.properties.full_address || [f.properties.name, f.properties.place_formatted].filter(Boolean).join(', '); }
    } catch { /* se prueba con el otro */ }
  }
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`, { signal: AbortSignal.timeout(6000) });
    if (r.ok) { const f = (await r.json()).features[0]; if (f) { const n = nombreLugar(f.properties); return [n.nombre, n.detalle].filter(Boolean).join(', '); } }
  } catch { /* se prueba con el otro */ }
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&accept-language=es&lat=${lat}&lon=${lng}`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) { const j = await r.json(); return (j.display_name || '').split(', ').slice(0, -2).join(', '); }
  } catch { /* sin dirección */ }
  return '';
}

// Mapa para marcar un punto: buscar con sugerencias, tocar el mapa, arrastrar el pin o usar la ubicación actual.
// alDireccion(texto) recibe la dirección aproximada del punto para llenar el campo de dirección.
function selectorPunto(contenedor, { letra, clase, alCambiar, alDireccion, conMiUbicacion }) {
  let marcador = null, punto = null, turno = 0, temporizador = null;
  const caja = el('div', { class: 'mapa mapa-selector' });
  const buscar = el('input', { type: 'search', placeholder: 'Escribe un lugar o dirección, ej. Centro Comercial Miraflores', 'aria-label': 'Buscar lugar en el mapa', autocomplete: 'off' });
  const resultados = el('div', { class: 'resultados-busqueda', role: 'listbox' });
  const estado = el('p', { class: 'pista', text: 'Busca el lugar o toca el mapa para marcar el punto exacto.' });
  const direccion = el('div', { class: 'direccion-punto', hidden: true });
  const pintarDireccion = async (lat, lng) => {
    const mio = ++turno;
    direccion.hidden = false;
    direccion.replaceChildren(el('small', { text: 'Buscando la dirección de este punto…' }));
    const texto = await direccionDe(lat, lng);
    if (mio !== turno) return;
    if (!texto) { direccion.hidden = true; return; }
    direccion.replaceChildren(el('span', {}, el('small', { text: 'Dirección aproximada del punto' }), el('strong', { text: texto })),
      alDireccion ? el('button', { class: 'boton borde chico', type: 'button', text: 'Usar esta dirección', onclick: () => alDireccion(texto, true) }) : null);
    if (alDireccion) alDireccion(texto, false);
  };
  const fijar = (lat, lng, centrar) => {
    punto = { lat, lng };
    if (mapa) {
      if (marcador) marcador.mover(lat, lng);
      else marcador = mapa.marcador(lat, lng, { html: htmlPin(letra, clase), arrastrable: true, alMover: (la, ln) => { punto = { lat: la, lng: ln }; alCambiar && alCambiar(punto); pintarDireccion(la, ln); } });
      if (centrar) mapa.centrar(lat, lng, 17);
    }
    estado.textContent = 'Punto marcado. Puedes arrastrar el pin para ajustarlo.';
    estado.classList.add('ok');
    alCambiar && alCambiar(punto);
    pintarDireccion(lat, lng);
  };
  const mostrarResultados = (lista) => {
    if (!lista.length) { resultados.replaceChildren(el('p', { class: 'pista', text: 'No encontramos ese lugar. Prueba con otro nombre o toca el mapa.' })); return; }
    resultados.replaceChildren(...lista.map((x) => el('button', { type: 'button', class: 'resultado', role: 'option',
      onclick: () => { fijar(x.lat, x.lng, true); resultados.replaceChildren(); buscar.value = x.nombre; } },
      el('strong', { text: x.nombre }), x.detalle ? el('small', { text: x.detalle }) : null)));
  };
  const hacerBusqueda = async () => {
    const q = buscar.value.trim();
    if (q.length < 3) { resultados.replaceChildren(); return; }
    const mio = ++turno;
    resultados.replaceChildren(el('p', { class: 'pista', text: 'Buscando…' }));
    try { const lista = await buscarDireccion(q); if (mio === turno) mostrarResultados(lista); }
    catch (e) { if (mio === turno) resultados.replaceChildren(el('p', { class: 'pista', text: e.message })); }
  };
  // Sugerencias mientras escribes
  buscar.addEventListener('input', () => { clearTimeout(temporizador); temporizador = setTimeout(hacerBusqueda, 450); });
  buscar.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); clearTimeout(temporizador); hacerBusqueda(); } });
  const controles = el('div', { class: 'mapa-controles' }, buscar);
  if (conMiUbicacion && navigator.geolocation) {
    controles.append(el('button', { class: 'boton borde chico', type: 'button', text: 'Usar mi ubicación', onclick: () => {
      estado.textContent = 'Obteniendo tu ubicación…';
      navigator.geolocation.getCurrentPosition(
        (p) => fijar(p.coords.latitude, p.coords.longitude, true),
        () => { estado.textContent = 'No pudimos obtener tu ubicación. Busca el lugar o toca el mapa.'; },
        { enableHighAccuracy: true, timeout: 10000 });
    } }));
  }
  contenedor.replaceChildren(controles, resultados, caja, estado, direccion);
  const mapa = crearMapa(caja, { cooperativo: true });
  if (mapa) mapa.alTocar((lat, lng) => fijar(lat, lng, false));
  return {
    obtener: () => punto,
    poner: (lat, lng) => fijar(lat, lng, true),
    limpiar: () => { punto = null; if (marcador) { marcador.quitar(); marcador = null; } buscar.value = ''; direccion.hidden = true; estado.textContent = 'Busca el lugar o toca el mapa para marcar el punto exacto.'; estado.classList.remove('ok'); },
    refrescar: () => mapa && mapa.refrescar(),
  };
}

// ---------- Documentos: fotos y PDF ----------
// Achica las fotos en el navegador antes de subirlas (las del celular pesan mucho). Los PDF se suben tal cual (máx. 700 KB).
async function prepararArchivo(archivo, permitePdf) {
  if (!archivo) throw new Error('Elige un archivo.');
  if (archivo.type === 'application/pdf') {
    if (!permitePdf) throw new Error('Este documento tiene que ser una foto.');
    if (archivo.size > 700_000) throw new Error('El PDF pesa más de 700 KB. Toma una foto del documento en su lugar.');
    return new Promise((ok, mal) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => mal(new Error('No se pudo leer el archivo.')); r.readAsDataURL(archivo); });
  }
  if (!archivo.type.startsWith('image/')) throw new Error(permitePdf ? 'Sube una foto o un PDF.' : 'Sube una foto.');
  const url = URL.createObjectURL(archivo);
  try {
    const img = await new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => mal(new Error('No se pudo leer la foto. Prueba con otra.')); i.src = url; });
    const escala = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const lienzo = document.createElement('canvas');
    lienzo.width = Math.round(img.naturalWidth * escala); lienzo.height = Math.round(img.naturalHeight * escala);
    const ctx = lienzo.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, lienzo.width, lienzo.height);
    ctx.drawImage(img, 0, 0, lienzo.width, lienzo.height);
    for (const calidad of [0.85, 0.75, 0.65, 0.55, 0.45]) {
      const datos = lienzo.toDataURL('image/jpeg', calidad);
      if (datos.length * 0.75 < 600_000) return datos;
    }
    throw new Error('La foto es demasiado grande. Toma una más cercana al documento.');
  } finally { URL.revokeObjectURL(url); }
}

// Casilla para ver y subir un documento. opciones: titulo, tiene, ver (url), subir(dataUrl), pdf, ayuda, camara ('user' o 'environment'), soloVer
function campoDocumento({ titulo, tiene, ver, subir, pdf, ayuda, camara, soloVer, alCambiar }) {
  const estado = el('small', { class: 'doc-estado' });
  const vista = el('div', { class: 'doc-vista' });
  const pintar = (hay, version) => {
    if (!hay) { vista.replaceChildren(el('div', { class: 'sin-foto', text: 'Sin archivo' })); return; }
    const src = ver + (ver.includes('?') ? '&' : '?') + 'v=' + (version || Date.now());
    const img = el('img', { src, alt: titulo, loading: 'lazy', onclick: () => window.open(src, '_blank') });
    img.addEventListener('error', () => vista.replaceChildren(el('a', { class: 'doc-pdf', href: src, target: '_blank', rel: 'noopener', text: 'Ver PDF' })), { once: true });
    vista.replaceChildren(img);
  };
  pintar(tiene, 1);
  const caja = el('div', { class: 'doc' + (tiene ? ' listo' : '') }, el('span', { class: 'doc-titulo', text: titulo }), vista);
  if (ayuda) caja.append(el('small', { class: 'doc-ayuda', text: ayuda }));
  if (!soloVer) {
    const entrada = el('input', { type: 'file', accept: pdf ? 'image/*,application/pdf' : 'image/*', 'aria-label': (tiene ? 'Cambiar ' : 'Subir ') + titulo.toLowerCase() });
    if (camara) entrada.setAttribute('capture', camara);
    entrada.addEventListener('change', async () => {
      const f = entrada.files[0];
      if (!f) return;
      entrada.disabled = true; estado.className = 'doc-estado'; estado.textContent = 'Subiendo…';
      try {
        await subir(await prepararArchivo(f, pdf));
        estado.className = 'doc-estado ok'; estado.textContent = 'Guardado';
        caja.classList.add('listo'); pintar(true);
        alCambiar && alCambiar();
      } catch (e) { estado.className = 'doc-estado error'; estado.textContent = e.message; }
      entrada.disabled = false; entrada.value = '';
    });
    caja.append(el('label', { class: 'boton borde chico doc-boton' }, tiene ? 'Cambiar' : 'Subir', entrada));
  }
  caja.append(estado);
  return caja;
}

// ---------- Animación al confirmar un pedido ----------
// Pantalla de "¡Pedido recibido!": se dibuja un círculo con palomita, un paquete avanza por la ruta y aparece la guía.
// Sigue sola a los 3.5 segundos o al tocar el botón.
function celebrarPedido(guia, precio, codigo, exigeReceptor) {
  return new Promise((listo) => {
    const svg = `<svg class="celebra-check" viewBox="0 0 120 120" aria-hidden="true">
      <circle class="celebra-circulo" cx="60" cy="60" r="52" fill="none" stroke-width="7"/>
      <path class="celebra-palomita" d="M38 62 l15 15 l30 -32" fill="none" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const ruta = `<div class="celebra-ruta" aria-hidden="true"><span class="celebra-punto a">A</span><i></i><span class="celebra-paquete">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/></svg></span><span class="celebra-punto b">B</span></div>`;
    const capa = el('div', { class: 'celebra', role: 'status', 'aria-live': 'polite' });
    const cerrar = () => { capa.classList.add('saliendo'); setTimeout(() => { capa.remove(); listo(); }, sinAnimacion() ? 0 : 300); clearTimeout(reloj); };
    const caja = el('div', { class: 'celebra-caja' });
    caja.innerHTML = svg;
    caja.append(el('h2', { text: '¡Pedido recibido!' }),
      el('p', {}, 'Tu número de guía es ', el('strong', { class: 'celebra-guia', text: guia })),
      precio != null ? el('p', { class: 'celebra-precio', text: `Total ${dinero(precio)}` }) : '',
      codigo ? el('p', { class: 'celebra-codigo' }, 'Código de entrega ', el('strong', { text: codigo }), el('br'), el('small', { text: 'Quien recibe lo verá en su enlace. El piloto se lo pedirá para entregar.' })) : '',
      el('div', { class: 'celebra-ruta-lugar' }),
      el('p', { class: 'celebra-pista', text: exigeReceptor ? 'Ahora envía el enlace a quien recibe. Cuando comparta su ubicación, buscamos al piloto más cercano.' : 'Estamos buscando al piloto más cercano.' }),
      el('button', { class: 'boton cinta', type: 'button', text: exigeReceptor ? 'Enviar los enlaces' : 'Ver mi envío', onclick: cerrar }));
    caja.querySelector('.celebra-ruta-lugar').outerHTML = ruta;
    capa.append(caja);
    document.body.append(capa);
    const reloj = setTimeout(cerrar, exigeReceptor ? 6000 : 3500);
    if (navigator.vibrate) navigator.vibrate(60);
  });
}

// ---------- Sonido de aviso ----------
let audioAviso = null;
function prepararAudioAviso() {
  try {
    if (!audioAviso) audioAviso = new (window.AudioContext || window.webkitAudioContext)();
    if (audioAviso.state === 'suspended') audioAviso.resume();
  } catch { audioAviso = null; }
}
document.addEventListener('pointerdown', prepararAudioAviso);
function sonarAviso(veces = 2) {
  if (!audioAviso || audioAviso.state !== 'running') return;
  const t = audioAviso.currentTime;
  for (let i = 0; i < veces; i++) {
    [[880, 0], [1175, 0.18]].forEach(([frecuencia, inicio]) => {
      const o = audioAviso.createOscillator(), g = audioAviso.createGain();
      const t0 = t + i * 0.5 + inicio;
      o.type = 'sine'; o.frequency.value = frecuencia;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      o.connect(g).connect(audioAviso.destination);
      o.start(t0); o.stop(t0 + 0.18);
    });
  }
}
async function notificacionSistema(titulo, cuerpo, url, etiqueta) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const op = { body: cuerpo, icon: '/img/icono-192.png', badge: '/img/icono-192.png', tag: etiqueta || 'vaelo', renotify: true, vibrate: [300, 100, 300, 100, 300], data: { url } };
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.showNotification(titulo, op); else new Notification(titulo, op);
  } catch { try { new Notification(titulo, op); } catch { /* sin notificación */ } }
}

// ---------- Instalar como app desde Chrome (celular y computadora, sin .apk ni Play Store) ----------
let eventoInstalar = null;
const yaInstalada = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const esIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const esCelular = () => /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
const pasosInstalar = () => esIos()
  ? 'En Safari toca el botón Compartir (el cuadro con la flecha) y luego "Agregar a pantalla de inicio".'
  : 'En Chrome toca el menú ⋮ (arriba a la derecha) y elige "Instalar app" o "Agregar a pantalla principal".';
window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); eventoInstalar = ev; document.dispatchEvent(new Event('vaelo-instalable')); });
window.addEventListener('appinstalled', () => { eventoInstalar = null; document.dispatchEvent(new Event('vaelo-instalada')); });
// Abre la ventana de Chrome para instalar. Devuelve false si el navegador no la ofrece (entonces se muestran los pasos).
async function pedirInstalar() {
  if (!eventoInstalar) return false;
  const ev = eventoInstalar; eventoInstalar = null;
  ev.prompt();
  try { await ev.userChoice; } catch { /* sin respuesta */ }
  return true;
}
function bloqueInstalar(nombreApp) {
  const caja = el('div', { class: 'instalar', hidden: true });
  const mostrar = () => {
    if (yaInstalada()) { caja.hidden = true; return; }
    if (eventoInstalar) {
      caja.replaceChildren(el('div', {}, el('strong', { text: `Instala ${nombreApp} en tu celular` }), el('small', { text: 'Queda en tu pantalla de inicio y se abre como cualquier app, sin descargar archivos.' })),
        el('button', { class: 'boton chico', type: 'button', text: 'Instalar', onclick: async () => { await pedirInstalar(); mostrar(); } }));
      caja.hidden = false;
    } else if (esCelular()) {
      caja.replaceChildren(el('div', {}, el('strong', { text: `Instala ${nombreApp} en tu celular` }), el('small', { text: pasosInstalar() })));
      caja.hidden = false;
    } else caja.hidden = true;
  };
  document.addEventListener('vaelo-instalable', mostrar);
  document.addEventListener('vaelo-instalada', () => { caja.hidden = true; });
  setTimeout(mostrar, 0);
  return caja;
}

// ---------- App instalable ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
