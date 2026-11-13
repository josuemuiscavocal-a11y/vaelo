// Funciones compartidas por todas las páginas de Vaelo
'use strict';

const ESTADOS = {
  pendiente: 'Pendiente de recoger',
  recogido: 'Recogido',
  en_camino: 'En camino',
  entregado: 'Entregado',
  fallido: 'No se pudo entregar',
  devolviendo: 'Devolviéndose',
  devuelto: 'Devuelto',
  a_sede: 'Va a la sede',
  en_sede: 'En la sede',
  reenviado: 'Enviado de nuevo',
  cancelado: 'Cancelado',
};
const MOTIVOS_FALLO = { no_contesta: 'Quien recibe no contesta', no_esta: 'No había nadie en el lugar', direccion: 'Dirección o ubicación incorrecta',
  rechazo: 'Quien recibe no aceptó el paquete', sin_cobro: 'Quien recibe no pagó el cobro', otro: 'Otro motivo' };
const TIPOS_CARGO = { cancelacion: 'Cancelación con el piloto en camino', devolucion: 'Devolución del paquete', bodega: 'Días en la sede', reentrega: 'Nueva entrega desde la sede', bodega_empresa: 'Paquetes de empresa guardados en la sede' };
// Tiempo que falta hasta una fecha ISO: "1 h 25 min"
function faltaPara(iso) {
  const min = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}
// Íconos de línea (dibujos propios). Uso: icono('paquete')
const ICONOS = {
  telefono: '<path d="M6.6 3.5h2.6l1.4 4-2 1.3a11 11 0 0 0 6.6 6.6l1.3-2 4 1.4v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z"/>',
  mensaje: '<path d="M20 11.5a8 8 0 0 1-11.8 7l-4.2 1.2 1.2-4A8 8 0 1 1 20 11.5z"/><path d="M8.5 10.5h7M8.5 13.5h4.5"/>',
  carpeta: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  mas: '<path d="M12 5v14M5 12h14"/>',
  paquete: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  piloto: '<circle cx="5.5" cy="17" r="2.5"/><circle cx="18.5" cy="17" r="2.5"/><path d="M5.5 17h5l3-6h3l2 6"/><path d="M14 6.5h2.5l1.5 4.5"/>',
  clientes: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M15.5 4.8a3.4 3.4 0 0 1 0 6.4M18 14.8c2 .7 3.2 2.4 3.5 5.2"/>',
  caja: '<rect x="2.5" y="6" width="19" height="13" rx="2"/><path d="M2.5 10h19"/><path d="M6.5 15h4"/>',
  etiqueta: '<path d="M3 12.5V4h8.5L21 13.5 13.5 21z"/><circle cx="7.5" cy="8.5" r="1.4"/>',
  grafica: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  ajustes: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M2.5 12h3M18.5 12h3M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1"/>',
  alerta: '<path d="M12 3 2 20h20z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  campana: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  sonido: '<path d="M4 9.5h4l5-4v13l-5-4H4z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>',
  recargar: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4.5h-4.5"/>',
  salir: '<path d="M14 4h5v16h-5"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
  reloj: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  ruta: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5"/>',
  sede: '<path d="M3 21V9l9-5 9 5v12"/><path d="M9 21v-6h6v6"/>',
  devolver: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  dinero: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.8"/><path d="M6 9.5v.01M18 14.5v.01"/>',
  menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  tienda: '<path d="M4 9.5 5.5 4h13L20 9.5"/><path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0"/><path d="M5 11.5V20h14v-8.5"/>',
  usuario: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.2 4-6.5 8-6.5s7.2 2.3 8 6.5"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>',
  estrella: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
};
function icono(nombre, clase = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'icono-l ' + clase);
  s.innerHTML = ICONOS[nombre] || '';
  return s;
}
// Pasos del envío para la barra de progreso (los fallidos muestran su propio camino)
function pasosEnvio(estado) {
  const normal = [['pendiente', 'Pedido'], ['recogido', 'Recogido'], ['en_camino', 'En camino'], ['entregado', 'Entregado']];
  if (['fallido', 'devolviendo', 'devuelto'].includes(estado)) return [['recogido', 'Recogido'], ['fallido', 'No entregado'], ['devolviendo', 'De vuelta'], ['devuelto', 'Devuelto']];
  if (['a_sede', 'en_sede', 'reenviado'].includes(estado)) return [['recogido', 'Recogido'], ['fallido', 'No entregado'], ['a_sede', 'A la sede'], ['en_sede', 'En la sede']];
  return normal;
}
function barraPasos(estado) {
  const pasos = pasosEnvio(estado);
  let i = pasos.findIndex(([k]) => k === estado);
  if (estado === 'reenviado') i = pasos.length - 1;
  if (estado === 'entregado' && i < 0) i = pasos.length - 1;
  return el('ol', { class: 'pasos-envio' + (estado === 'cancelado' ? ' cancelado' : '') + (['fallido', 'devolviendo', 'devuelto', 'a_sede', 'en_sede', 'reenviado'].includes(estado) ? ' desvio' : '') },
    ...pasos.map(([k, t], j) => el('li', { class: j < i ? 'hecho' : j === i ? 'actual' : '' }, el('span', { text: t }))));
}
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
  } else if (init.method !== 'GET' && init.method !== 'HEAD') {
    // El servidor solo acepta cambios en formato JSON (protección contra otros sitios): borrar sin datos también lo lleva
    init.headers['Content-Type'] = 'application/json';
    init.body = '{}';
  }
  let res;
  try { res = await fetch(ruta, init); }
  catch { throw new Error('No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.'); }
  let data = {};
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Algo salió mal. Inténtalo de nuevo.');
    err.status = res.status;
    err.datos = data;
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

// Reemplaza el contenido de un nodo ignorando vacíos (null, false) y aplanando listas
function poner(nodo, ...hijos) { nodo.replaceChildren(...hijos.flat(Infinity).filter((h) => h != null && h !== false)); }

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
  const negocio = usuario && usuario.rol === 'cliente' && ['empresa', 'minorista'].includes(usuario.tipo_cuenta);
  if (!usuario || (usuario.rol === 'cliente' && !negocio)) nav.append(el('a', { href: '/tiendas', text: 'Tiendas' }), el('a', { href: '/empresas', text: 'Empresas' }));
  if (usuario) {
    if (usuario.rol === 'admin') nav.append(el('a', { href: '/familiatecun', text: 'Panel' }));
    if (usuario.rol === 'mensajero') nav.append(el('a', { href: '/modomensajero', text: 'Mis entregas' }));
    if (negocio) nav.append(el('a', { href: '/tienda', text: usuario.tipo_cuenta === 'empresa' ? 'Mi empresa' : 'Mi tienda' }));
    else if (usuario.rol !== 'mensajero') nav.append(el('a', { href: '/mi-cuenta', text: 'Mis envíos' }));
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
    e.codigo_corto ? el('div', { class: 'guia-codigo-corto' }, el('span', { text: 'Código del paquete' }), el('strong', { text: e.codigo_corto })) : null,
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
  // Área rellena [[lat, lng], ...] (zonas dibujadas). op: color, opacidad
  poligono(puntos, op = {}) {
    const id = 'area-' + (++this.cuenta);
    const pintar = () => {
      if (!this.estiloListo) return;
      const anillo = puntos.length >= 3 ? [...puntos, puntos[0]] : puntos;
      const datos = { type: 'Feature', geometry: puntos.length >= 3 ? { type: 'Polygon', coordinates: [anillo.map(([la, ln]) => [ln, la])] } : { type: 'LineString', coordinates: anillo.map(([la, ln]) => [ln, la]) } };
      const f = this.mapa.getSource(id);
      if (f) { f.setData(datos); return; }
      this.mapa.addSource(id, { type: 'geojson', data: datos });
      this.mapa.addLayer({ id: id + '-relleno', type: 'fill', source: id, paint: { 'fill-color': op.color || '#1c3faa', 'fill-opacity': op.opacidad ?? 0.18 }, filter: ['==', '$type', 'Polygon'] });
      this.mapa.addLayer({ id: id + '-borde', type: 'line', source: id, paint: { 'line-color': op.color || '#1c3faa', 'line-width': 2.5 } });
    };
    if (this.estiloListo) pintar(); else this.mapa.once('style.load', pintar);
    const quitar = () => { for (const c of [id + '-relleno', id + '-borde']) if (this.mapa.getLayer(c)) this.mapa.removeLayer(c); if (this.mapa.getSource(id)) this.mapa.removeSource(id); };
    return { quitar, actualizar: (p) => { puntos = p; pintar(); } };
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
  const fijar = (lat, lng, centrar, origen = 'mano') => {
    punto = { lat, lng };
    if (mapa) {
      if (marcador) marcador.mover(lat, lng);
      else marcador = mapa.marcador(lat, lng, { html: htmlPin(letra, clase), arrastrable: true, alMover: (la, ln) => { punto = { lat: la, lng: ln }; alCambiar && alCambiar(punto, 'mano'); pintarDireccion(la, ln); } });
      if (centrar) mapa.centrar(lat, lng, 17);
    }
    estado.textContent = origen === 'gps' ? 'Listo: usamos tu ubicación en tiempo real.' : 'Punto marcado. Puedes arrastrar el pin para ajustarlo.';
    estado.classList.add('ok');
    alCambiar && alCambiar(punto, origen);
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
        (p) => fijar(p.coords.latitude, p.coords.longitude, true, 'gps'),
        () => { estado.textContent = 'No pudimos obtener tu ubicación. Busca el lugar o toca el mapa.'; },
        { enableHighAccuracy: true, timeout: 10000 });
    } }));
  }
  contenedor.replaceChildren(controles, resultados, caja, estado, direccion);
  const mapa = crearMapa(caja, { cooperativo: true });
  if (mapa) mapa.alTocar((lat, lng) => fijar(lat, lng, false));
  return {
    obtener: () => punto,
    poner: (lat, lng, origen = 'guardado') => fijar(lat, lng, true, origen),
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
// ---------- Tarjeta de documento o foto: guía de qué fotografiar, estado, vista previa, cámara o galería y arrastrar y soltar ----------
const DIBUJOS_DOC = {
  fachada: '<path d="M8 30h48v26H8z"/><path d="M4 30 12 14h40l8 16"/><path d="M26 56V40h12v16"/><path d="M14 38h7v7h-7zM43 38h7v7h-7z"/><path d="M22 20h20"/>',
  bodega: '<path d="M6 26 32 12l26 14v30H6z"/><path d="M14 56V34h36v22"/><path d="M18 44h12v12H18zM34 46h10v10H34zM24 36h10v8H24z"/>',
  persona: '<circle cx="32" cy="24" r="10"/><path d="M14 54c2-10 9-15 18-15s16 5 18 15"/><path d="M8 8h10M8 8v10M56 8H46M56 8v10M8 56h10M8 56V46M56 56H46M56 56V46"/>',
  dpi: '<rect x="6" y="14" width="52" height="36" rx="5"/><rect x="12" y="22" width="14" height="18" rx="2"/><path d="M32 24h20M32 30h16M32 36h20M12 44h40"/>',
  'dpi-atras': '<rect x="6" y="14" width="52" height="36" rx="5"/><path d="M12 22h40M12 28h28"/><path d="M14 36v8M17 36v8M21 36v8M23 36v8M27 36v8M31 36v8M33 36v8M37 36v8M41 36v8M44 36v8M48 36v8"/>',
  documento: '<path d="M16 6h22l12 12v40H16z"/><path d="M38 6v12h12"/><path d="M22 28h22M22 34h22M22 40h16M22 48h10"/><circle cx="42" cy="48" r="4"/>',
  sello: '<path d="M16 6h22l12 12v40H16z"/><path d="M38 6v12h12"/><path d="M22 26h20M22 32h14"/><circle cx="36" cy="46" r="7"/><path d="m33 46 2 2 4-4"/>',
  moto: '<circle cx="15" cy="44" r="9"/><circle cx="49" cy="44" r="9"/><path d="M15 44h14l8-14h8l4 14"/><path d="M29 44 23 30h-8M37 30l-3-8h-6M45 30h5"/>',
  placa: '<rect x="6" y="18" width="52" height="28" rx="4"/><path d="M12 24h40"/><path d="M14 38V30h4a3 3 0 0 1 0 6h-4M24 30h6M27 30v8M34 38l4-8 4 8M44 30h6l-6 8h6"/>',
  recibo: '<path d="M16 6h32v52l-5-4-5 4-6-4-6 4-5-4-5 4z"/><path d="M22 18h20M22 26h20M22 34h12"/><path d="M36 44h6"/>',
};
// Según el nombre del documento: qué dibujo mostrar y una guía corta de cómo tomarlo
function guiaDocumento(titulo, pdf) {
  const t = String(titulo || '').toLowerCase();
  if (/fachada/.test(t)) return ['fachada', 'De frente y de día: que se vean el rótulo y el número.'];
  if (/interior|bodega/.test(t)) return ['bodega', 'Donde se guardan los paquetes.'];
  if (/^(tu )?foto|foto de la persona|foto del representante/.test(t) && !/dpi/.test(t)) return ['persona', 'Una foto de la cara, sin lentes oscuros ni gorra.'];
  if (/(dpi|licencia).*(reverso|atrás)/.test(t)) return ['dpi-atras', 'La parte de atrás completa, sin reflejos.'];
  if (/dpi|licencia/.test(t)) return ['dpi', 'Completo, sin reflejos y que se lean los datos.'];
  if (/tarjeta de circulaci/.test(t)) return ['dpi', 'Que se lean la placa y el nombre del dueño.'];
  if (/placa/.test(t)) return ['placa', 'De cerca, que se lea bien el número.'];
  if (/veh[ií]culo|moto/.test(t)) return ['moto', /lado/.test(t) ? 'El vehículo completo, de lado.' : 'El vehículo completo, de frente.'];
  if (/recibo/.test(t)) return ['recibo', 'Reciente, con la dirección visible.'];
  if (/antecedentes|patente|rtu|carta/.test(t)) return ['sello', pdf ? 'Foto clara o el PDF que te dieron.' : 'Foto clara y completa.'];
  return ['documento', pdf ? 'Foto clara o PDF.' : 'Foto clara y completa.'];
}
function dibujoDocumento(clave) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  n.setAttribute('viewBox', '0 0 64 64'); n.setAttribute('aria-hidden', 'true');
  n.innerHTML = DIBUJOS_DOC[clave] || DIBUJOS_DOC.documento;
  return n;
}
function campoDocumento({ titulo, tiene, ver, subir, pdf, ayuda, camara, soloVer, alCambiar }) {
  const [dibujo, guia] = guiaDocumento(titulo, pdf);
  const opcional = /^opcional/i.test(ayuda || '');
  const recomendada = /^recomendad/i.test(ayuda || '');
  const siAplica = /^solo si/i.test(ayuda || '');
  const nota = ayuda && !/^(opcional|recomendada)\.?$/i.test(ayuda) ? ayuda.replace(/^(opcional|recomendada)\.\s*/i, '') : guia;
  const caja = el('div', { class: 'doc-pro' });
  const estado = el('small', { class: 'doc-pro-msg', role: 'status' });
  let listo = !!tiene, version = 1;
  const entradaCam = el('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-label': 'Tomar foto: ' + titulo });
  if (camara) entradaCam.setAttribute('capture', camara);
  const entradaArch = el('input', { type: 'file', accept: pdf ? 'image/*,application/pdf' : 'image/*', hidden: true, 'aria-label': 'Elegir archivo: ' + titulo });
  const subirArchivo = async (f) => {
    if (!f || soloVer) return;
    if (f.type === 'application/pdf' && !pdf) { estado.className = 'doc-pro-msg error'; estado.textContent = 'Este debe ser una foto.'; return; }
    caja.classList.add('subiendo'); estado.className = 'doc-pro-msg'; estado.textContent = 'Subiendo…';
    try {
      await subir(await prepararArchivo(f, pdf));
      listo = true; version = Date.now(); pintar();
      estado.className = 'doc-pro-msg ok'; estado.textContent = 'Guardado';
      alCambiar && alCambiar();
    } catch (e) { estado.className = 'doc-pro-msg error'; estado.textContent = e.message; }
    caja.classList.remove('subiendo'); entradaCam.value = ''; entradaArch.value = '';
  };
  entradaCam.addEventListener('change', () => subirArchivo(entradaCam.files[0]));
  entradaArch.addEventListener('change', () => subirArchivo(entradaArch.files[0]));
  if (!soloVer) {
    caja.addEventListener('dragover', (ev) => { ev.preventDefault(); caja.classList.add('arrastrando'); });
    caja.addEventListener('dragleave', () => caja.classList.remove('arrastrando'));
    caja.addEventListener('drop', (ev) => { ev.preventDefault(); caja.classList.remove('arrastrando'); subirArchivo(ev.dataTransfer.files[0]); });
  }
  function pintar() {
    caja.className = 'doc-pro' + (listo ? ' listo' : '') + (soloVer ? ' solo-ver' : '');
    const src = ver + (ver.includes('?') ? '&' : '?') + 'v=' + version;
    const vista = listo
      ? el('a', { class: 'doc-pro-vista con-archivo', href: src, target: '_blank', rel: 'noopener', title: 'Ver ' + titulo },
          el('img', { src, alt: titulo, loading: 'lazy', onerror: (ev) => ev.target.replaceWith(el('span', { class: 'doc-pro-pdf' }, dibujoDocumento('documento'), el('b', { text: 'PDF' }))) }),
          el('span', { class: 'doc-pro-ver', text: 'Ver' }))
      : soloVer ? el('div', { class: 'doc-pro-vista' }, dibujoDocumento(dibujo), el('small', { class: 'doc-pro-soltar', text: 'Sin archivo' }))
      : el('label', { class: 'doc-pro-vista' }, dibujoDocumento(dibujo), el('small', { class: 'doc-pro-soltar', text: 'Toca para subir o arrastra aquí' }), entradaArch);
    const chip = soloVer ? null : el('span', { class: 'doc-pro-chip ' + (listo ? 'ok' : opcional || recomendada || siAplica ? 'opc' : 'falta'),
      text: listo ? 'Listo' : opcional ? 'Opcional' : recomendada ? 'Recomendada' : siAplica ? 'Si aplica' : 'Falta' });
    const foto = !pdf;
    poner(caja,
      el('div', { class: 'doc-pro-cab' }, el('strong', { text: titulo }), chip),
      vista,
      soloVer ? null : el('p', { class: 'doc-pro-ayuda', text: nota }),
      soloVer ? null : el('div', { class: 'doc-pro-botones' },
        el('label', { class: 'boton chico ' + (listo ? 'borde' : '') }, listo ? 'Cambiar' : foto ? 'Tomar foto' : 'Subir archivo', listo || !foto ? entradaArch : entradaCam),
        !listo && foto ? el('label', { class: 'boton borde chico' }, 'Desde galería', entradaArch) : null),
      estado);
  }
  pintar();
  return caja;
}

// ---------- Animación al confirmar un pedido ----------
// Pantalla de "¡Pedido recibido!": se dibuja un círculo con palomita, un paquete avanza por la ruta y aparece la guía.
// Sigue sola a los 3.5 segundos o al tocar el botón.
function celebrarPedido(guia, precio, codigo, exigeReceptor, codigoCorto) {
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
    // Pantalla simple: listo, el total y lo único que falta hacer (el código del paquete solo si tiene varios envíos)
    caja.append(el('h2', { text: '¡Listo, envío pedido!' }),
      precio != null ? el('p', { class: 'celebra-precio', text: `Total ${dinero(precio)}` }) : '',
      codigoCorto ? el('div', { class: 'codigo-paquete-aviso' }, el('span', { text: 'Escribe en el paquete' }), el('strong', { text: codigoCorto }),
        el('small', { text: 'Con marcador, grande, y debajo el nombre de quien recibe. Si no tienes, el piloto lo escribe al recoger.' })) : '',
      el('div', { class: 'celebra-ruta-lugar' }),
      el('p', { class: 'celebra-pista', text: exigeReceptor ? 'Solo falta una cosa: manda el enlace a quien recibe para que comparta su ubicación.' : 'Estamos buscando al piloto más cercano.' }),
      el('button', { class: 'boton cinta boton-grande', type: 'button', text: exigeReceptor ? 'Mandar enlace a quien recibe' : 'Ver mi envío', onclick: cerrar }));
    caja.querySelector('.celebra-ruta-lugar').outerHTML = ruta;
    capa.append(caja);
    document.body.append(capa);
    const reloj = setTimeout(cerrar, exigeReceptor || codigoCorto ? 7000 : 3500);
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

// ---------- Avisos al celular aunque Vaelo esté cerrado (notificaciones push) ----------
const pushDisponible = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
async function suscripcionPush() {
  if (!pushDisponible()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
async function activarPush() {
  if (!pushDisponible()) throw new Error(esIos() && !yaInstalada() ? 'En iPhone primero instala Vaelo en tu pantalla de inicio y ábrelo desde ahí.' : 'Este navegador no permite avisos. Usa Chrome.');
  const permiso = await Notification.requestPermission();
  if (permiso !== 'granted') throw new Error('No diste permiso para los avisos. Puedes activarlo en los ajustes del navegador (candado junto a la dirección).');
  const reg = await navigator.serviceWorker.ready;
  const { clave } = await api('/api/push/clave');
  const bytes = Uint8Array.from(atob(clave.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
  await api('/api/push/suscribir', { body: { suscripcion: sub.toJSON() } });
  return sub;
}
// Avisos que se pueden cerrar: no vuelven a salir en 7 días
const cerradoHasta = (k) => { try { return Number(localStorage.getItem('cerrado-' + k) || 0) > Date.now(); } catch { return false; } };
const botonCerrarAviso = (k, caja) => el('button', { class: 'cerrar-aviso', type: 'button', 'aria-label': 'Cerrar este aviso', title: 'Ocultar por una semana', text: '×',
  onclick: () => { try { localStorage.setItem('cerrado-' + k, String(Date.now() + 7 * 86400e3)); } catch { /* sin almacenamiento */ } caja.hidden = true; } });
// Tarjeta para activar los avisos. texto: qué avisos recibirá
function bloqueAvisos(texto) {
  const caja = el('div', { class: 'avisos-push', hidden: true });
  const pintar = async () => {
    if ((!pushDisponible() && !(esIos() && !yaInstalada())) || cerradoHasta('avisos')) { caja.hidden = true; return; }
    let sub = null;
    try { sub = await suscripcionPush(); } catch { /* sin servicio */ }
    if (sub && Notification.permission === 'granted') {
      api('/api/push/suscribir', { body: { suscripcion: sub.toJSON() } }).catch(() => {});   // por si cambió de cuenta
      caja.hidden = true; return;
    }
    const msg = el('small', { class: 'avisos-error' });
    caja.replaceChildren(icono('campana'), el('div', {}, el('strong', { text: 'Activa los avisos' }), el('small', { text: texto }), msg),
      el('button', { class: 'boton chico', type: 'button', text: 'Activar', onclick: async (ev) => {
        ev.target.disabled = true;
        try { await activarPush(); await api('/api/push/probar', { body: {} }).catch(() => {}); caja.hidden = true; }
        catch (e) { msg.textContent = e.message; ev.target.disabled = false; }
      } }), botonCerrarAviso('avisos', caja));
    caja.hidden = false;
  };
  setTimeout(pintar, 0);
  return caja;
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
    if (yaInstalada() || cerradoHasta('instalar')) { caja.hidden = true; return; }
    if (eventoInstalar) {
      caja.replaceChildren(el('div', {}, el('strong', { text: `Instala ${nombreApp} en tu celular` }), el('small', { text: 'Queda en tu pantalla de inicio y se abre como cualquier app, sin descargar archivos.' })),
        el('button', { class: 'boton chico', type: 'button', text: 'Instalar', onclick: async () => { await pedirInstalar(); mostrar(); } }), botonCerrarAviso('instalar', caja));
      caja.hidden = false;
    } else if (esCelular()) {
      caja.replaceChildren(el('div', {}, el('strong', { text: `Instala ${nombreApp} en tu celular` }), el('small', { text: pasosInstalar() })), botonCerrarAviso('instalar', caja));
      caja.hidden = false;
    } else caja.hidden = true;
  };
  document.addEventListener('vaelo-instalable', mostrar);
  document.addEventListener('vaelo-instalada', () => { caja.hidden = true; });
  setTimeout(mostrar, 0);
  return caja;
}

// ---------- Escáner de códigos QR (etiquetas de los paquetes) ----------
// alLeer(texto) se llama con cada código leído; en modo continuo sigue leyendo hasta que alLeer devuelva false o se cierre.
async function escanearQR(alLeer, { continuo = false, titulo = 'Escanea el código QR del paquete' } = {}) {
  const dlg = el('dialog', { class: 'dialogo escaner' });
  const video = el('video', { playsinline: true, muted: true, autoplay: true });
  const estado = el('p', { class: 'pista', text: 'Apunta la cámara a la etiqueta.' });
  const manual = el('input', { placeholder: 'O escribe el código, ej. VA-7K3M9QX2', autocomplete: 'off', 'aria-label': 'Código del paquete' });
  let stream = null, activo = true;
  const apagar = () => { activo = false; if (stream) stream.getTracks().forEach((t) => t.stop()); };
  const cerrar = () => { apagar(); if (dlg.open) dlg.close(); };
  const recibir = (v) => {
    const seguir = alLeer(String(v || '').trim());
    if (!continuo || seguir === false) { cerrar(); return; }
    estado.textContent = 'Leído: ' + v;
  };
  dlg.append(el('button', { class: 'cerrar', type: 'button', 'aria-label': 'Cerrar', text: '×', onclick: cerrar }), el('h2', { text: titulo }), video, estado,
    el('form', { class: 'escaner-manual', onsubmit: (ev) => { ev.preventDefault(); if (manual.value.trim()) { recibir(manual.value.trim().toUpperCase()); manual.value = ''; } } },
      manual, el('button', { class: 'boton chico', type: 'submit', text: 'Usar' })),
    continuo ? el('button', { class: 'boton borde', type: 'button', style: 'margin-top:.75rem', text: 'Listo', onclick: cerrar }) : null);
  dlg.addEventListener('close', () => { apagar(); dlg.remove(); });
  document.body.append(dlg); dlg.showModal();
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices) { estado.textContent = 'Este navegador no lee códigos con la cámara (usa Chrome en Android). Escribe el código.'; video.hidden = true; manual.focus(); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream; await video.play();
  } catch { estado.textContent = 'No se pudo abrir la cámara. Da permiso a la cámara o escribe el código.'; video.hidden = true; return; }
  let detector;
  try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { estado.textContent = 'Este navegador no lee códigos QR. Escribe el código.'; return; }
  const leidos = new Set();
  const leer = async () => {
    if (!activo) return;
    try {
      for (const c of await detector.detect(video)) {
        if (leidos.has(c.rawValue)) continue;
        leidos.add(c.rawValue);
        if (navigator.vibrate) navigator.vibrate(80);
        recibir(c.rawValue);
        if (!activo) return;
      }
    } catch { /* cuadro sin código */ }
    setTimeout(leer, 250);
  };
  leer();
}

// ---------- App instalable ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
