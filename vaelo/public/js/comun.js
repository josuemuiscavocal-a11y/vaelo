// Funciones compartidas por todas las páginas de Vaelo
'use strict';

const ESTADOS = {
  pendiente: 'Pendiente de recoger',
  recogido: 'Recogido',
  en_camino: 'En camino',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};
const PAGOS = { efectivo: 'Efectivo', transferencia: 'Transferencia' };
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
const hayMapa = () => typeof window.maplibregl !== 'undefined';
const esTactil = () => window.matchMedia('(pointer: coarse)').matches;

class Mapa {
  constructor(contenedor, centro, zoom, { cooperativo = true } = {}) {
    this.lineas = new Map();
    this.cuenta = 0;
    this.estiloListo = false;
    this.mapa = new maplibregl.Map({
      container: contenedor, style: window.VAELO_ESTILO_MAPA || ESTILO_MAPA,
      center: [centro[1], centro[0]], zoom, maxZoom: 19, minZoom: 6,
      cooperativeGestures: cooperativo && esTactil(),   // en el celular se mueve con dos dedos, así la página sigue bajando con uno
      dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: { compact: true },
      locale: { 'CooperativeGesturesHandler.MobileHelpText': 'Usa dos dedos para mover el mapa', 'CooperativeGesturesHandler.WindowsHelpText': 'Usa Ctrl + rueda para acercar el mapa',
        'CooperativeGesturesHandler.MacHelpText': 'Usa ⌘ + rueda para acercar el mapa', 'NavigationControl.ZoomIn': 'Acercar', 'NavigationControl.ZoomOut': 'Alejar',
        'GeolocateControl.FindMyLocation': 'Mi ubicación', 'FullscreenControl.Enter': 'Pantalla completa', 'FullscreenControl.Exit': 'Salir de pantalla completa' },
    });
    this.mapa.touchZoomRotate.disableRotation();
    this.mapa.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.mapa.addControl(new maplibregl.FullscreenControl(), 'top-right');
    this.mapa.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, showAccuracyCircle: false }), 'top-right');
    this.mapa.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
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
    const m = new maplibregl.Marker({ element: elemento, anchor: op.ancla || 'bottom', draggable: !!op.arrastrable }).setLngLat([lng, lat]).addTo(this.mapa);
    if (op.popup) m.setPopup(new maplibregl.Popup({ offset: op.ancla === 'center' ? 18 : 38, maxWidth: '260px' }).setDOMContent(op.popup instanceof Node ? op.popup : el('div', { text: op.popup })));
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
    const b = new maplibregl.LngLatBounds([p[0][1], p[0][0]], [p[0][1], p[0][0]]);
    p.forEach(([la, ln]) => b.extend([ln, la]));
    this.mapa.fitBounds(b, { padding: margen, maxZoom, duration: 0 });
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
  if (puntos.length === 2) mapa.linea(puntos, { color: '#1c3faa', ancho: 3, punteada: true, opacidad: 0.7 });
  if (e.mensajero_lat != null) {
    mapa.marcador(e.mensajero_lat, e.mensajero_lng, { html: htmlPiloto(), ancla: 'center', popup: `${e.mensajero_nombre || 'Piloto'}. Actualizado ${fecha(e.mensajero_ubic_fecha)}` });
    puntos.push([e.mensajero_lat, e.mensajero_lng]);
  }
  mapa.encuadrar(puntos);
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
async function buscarDireccion(q) {
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

// ---------- Instalar como app (celular y computadora) ----------
let eventoInstalar = null;
const yaInstalada = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); eventoInstalar = ev; document.dispatchEvent(new Event('vaelo-instalable')); });
function bloqueInstalar(nombreApp) {
  const caja = el('div', { class: 'instalar', hidden: true });
  const esIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const mostrar = () => {
    if (yaInstalada()) { caja.hidden = true; return; }
    if (eventoInstalar) {
      caja.replaceChildren(el('div', {}, el('strong', { text: `Instala ${nombreApp}` }), el('small', { text: 'Ábrela desde tu pantalla de inicio o escritorio, como cualquier app.' })),
        el('button', { class: 'boton chico', type: 'button', text: 'Instalar', onclick: async () => { eventoInstalar.prompt(); await eventoInstalar.userChoice; eventoInstalar = null; caja.hidden = true; } }));
      caja.hidden = false;
    } else if (esIos) {
      caja.replaceChildren(el('div', {}, el('strong', { text: `Instala ${nombreApp} en tu iPhone` }),
        el('small', { text: 'En Safari toca el botón Compartir (el cuadro con la flecha) y luego "Agregar a pantalla de inicio".' })));
      caja.hidden = false;
    }
  };
  document.addEventListener('vaelo-instalable', mostrar);
  setTimeout(mostrar, 0);
  return caja;
}

// ---------- App instalable ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
