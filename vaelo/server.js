// Servidor de Vaelo Mensajería (Guatemala)
// Funciona solo con Node.js 22 (sin paquetes extra). Inicia con: node server.js
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR } = require('./db');
const { crearPush } = require('./push');
const { crearExcel, leerExcel, leerCsv } = require('./lib/xlsx');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PRIVADO_DIR = path.join(__dirname, 'privado');   // páginas que solo se entregan con permiso (panel de administración)
const SESION_DIAS = 30;
const SESION_ADMIN_HORAS = 16;                         // la sesión del administrador vence más rápido
// Único correo con permiso para entrar al panel. La contraseña NO va en el código: se crea en el servidor
// con deploy/actualizar.sh (la pide la primera vez) o con herramientas/crear-admin.js
const ADMIN_EMAIL = String(process.env.VAELO_ADMIN_EMAIL_UNICO || 'administracionvaelo@vaelomensajeria.com').toLowerCase();
const RUTA_ADMIN = '/familiatecun';
const DOCS_DIR = path.join(DATA_DIR, 'documentos');   // fotos de identificación de los empleados (no son públicas)
// Servicio de rutas para medir kilómetros reales por calle. Si falla, se usa la distancia en línea recta × 1.4
const OSRM_URL = process.env.VAELO_OSRM === 'no' ? '' : (process.env.VAELO_OSRM || 'https://router.project-osrm.org');

// Estados del envío. Si falla la entrega: fallido -> (el cliente elige) devolviendo -> devuelto, o a_sede -> en_sede -> entregado (retirado) o reenviado
const ESTADOS = ['pendiente', 'recogido', 'en_camino', 'entregado', 'fallido', 'devolviendo', 'devuelto', 'a_sede', 'en_sede', 'reenviado', 'cancelado'];
const ESTADOS_CERRADOS = ['entregado', 'devuelto', 'reenviado', 'cancelado'];
// Estados en los que el piloto todavía lleva el paquete (o va por él)
const ESTADOS_PILOTO_ACTIVO = ['pendiente', 'recogido', 'en_camino', 'fallido', 'devolviendo', 'a_sede'];
const SQL_PILOTO_ACTIVO = `('pendiente','recogido','en_camino','fallido','devolviendo','a_sede')`;
const ESTADOS_MENSAJERO = ['recogido', 'en_camino', 'entregado', 'devuelto', 'en_sede'];
// El viaje se hizo (se cobra el envío): todo lo que ya no está activo ni cancelado
const SQL_VIAJE_HECHO = `e.estado NOT IN ('pendiente','recogido','en_camino','cancelado')`;
// Solo efectivo: en la recogida o paga quien recibe al entregar. Transferencia y crédito ya no se ofrecen (los envíos viejos se siguen mostrando).
const METODOS_PAGO = ['efectivo', 'recibe'];   // recibe: paga quien recibe
const POLITICA_PILOTO_VERSION = 1;   // si cambia la política, los pilotos la vuelven a aceptar antes de trabajar
const OTRA_ZONA = 'Otra zona o municipio';

// ---------- Utilidades ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verificarPassword(password, guardado) {
  const [alg, saltHex, hashHex] = String(guardado).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const esperado = Buffer.from(hashHex, 'hex');
  return esperado.length === hash.length && crypto.timingSafeEqual(hash, esperado);
}

const ALFABETO_GUIA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function nuevaGuia() {
  for (;;) {
    let s = '';
    for (const b of crypto.randomBytes(8)) s += ALFABETO_GUIA[b % ALFABETO_GUIA.length];
    const guia = `VA-${s}`;
    if (!db.prepare('SELECT 1 FROM envios WHERE guia = ?').get(guia) && !db.prepare('SELECT 1 FROM pedidos_empresa WHERE codigo = ?').get(guia)) return guia;
  }
}

const texto = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const numero = (v) => { const n = Number(v); return v === '' || v == null ? NaN : (Number.isFinite(n) ? n : NaN); };
const redondear = (n) => Math.round(n * 100) / 100;

// Fecha de nacimiento de un empleado: AAAA-MM-DD y mayor de 18 años
function validarNacimiento(v) {
  const t = texto(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t + 'T00:00:00Z'))) falla(400, 'Escribe la fecha de nacimiento.');
  const n = new Date(t + 'T00:00:00Z'), hoy = new Date();
  let edad = hoy.getUTCFullYear() - n.getUTCFullYear();
  if (hoy.getUTCMonth() < n.getUTCMonth() || (hoy.getUTCMonth() === n.getUTCMonth() && hoy.getUTCDate() < n.getUTCDate())) edad--;
  if (edad < 18) falla(400, 'El empleado debe ser mayor de 18 años.');
  if (edad > 90) falla(400, 'Revisa la fecha de nacimiento.');
  return t;
}
// DPI de Guatemala: 13 dígitos (se guarda sin espacios)
function validarDpi(v, idPropio = 0) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length !== 13) falla(400, 'El número de DPI debe tener 13 dígitos.');
  if (db.prepare("SELECT 1 FROM usuarios WHERE dpi = ? AND id != ?").get(d, idPropio)) falla(409, 'Ya hay un empleado registrado con ese DPI.');
  return d;
}

// Coordenadas dentro de Guatemala (con margen)
function coordenada(lat, lng) {
  const la = numero(lat), ln = numero(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (la < 13.4 || la > 18.1 || ln < -92.6 || ln > -88.0) return null;
  return { lat: la, lng: ln };
}

function getAjustes() {
  const out = {};
  for (const r of db.prepare('SELECT clave, valor FROM ajustes').all()) out[r.clave] = r.valor;
  return out;
}
// Un envío se puede mandar al piloto cuando el pago por transferencia ya se confirmó y, si es de un envío de empresa
// a la sede, cuando los paquetes ya llegaron a la sede
function listoParaPiloto(e) {
  if (e.flete && !e.flete_configurado_en) return false;
  if (e.metodo_pago === 'transferencia' && e.pago_estado !== 'verificado') return false;
  if (e.lote_sede_id && db.prepare('SELECT estado FROM lotes_sede WHERE id = ?').get(e.lote_sede_id)?.estado !== 'recibido') return false;
  return true;
}
const motivoNoListo = (e) => e.flete && !e.flete_configurado_en ? 'El cliente todavía no completa los datos del flete con su enlace.'
  : e.metodo_pago === 'transferencia' && e.pago_estado !== 'verificado'
  ? 'Falta confirmar la transferencia: el cliente manda el comprobante al WhatsApp de Vaelo y la oficina lo marca recibido.'
  : 'Los paquetes de este envío todavía no llegan a la sede de Vaelo.';
const zonasFijas = () => db.prepare('SELECT id, nombre FROM zonas_fijas WHERE activa = 1 ORDER BY id').all();

function distanciaRecta(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const cacheRutas = new Map();
async function kilometros(a, b) {
  const clave = [a.lat, a.lng, b.lat, b.lng].map((n) => n.toFixed(5)).join(',');
  if (cacheRutas.has(clave)) return cacheRutas.get(clave);
  let km = null, fuente = 'calle';
  // Con clave de Mapbox se usa su servicio de rutas (más confiable); si no, el servidor público de OSRM
  const tokenMapbox = getAjustes().mapbox_token || process.env.MAPBOX_TOKEN || '';
  if (tokenMapbox) {
    try {
      const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false&access_token=${encodeURIComponent(tokenMapbox)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      if (j.routes && j.routes[0]) km = j.routes[0].distance / 1000;
    } catch { /* se intenta con OSRM */ }
  }
  if (km == null && OSRM_URL) {
    try {
      const url = `${OSRM_URL}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Vaelo-Mensajeria/1.0' } });
      const j = await r.json();
      if (j.code === 'Ok' && j.routes && j.routes[0]) km = j.routes[0].distance / 1000;
    } catch { /* se usa la estimación */ }
  }
  if (km == null) { km = distanciaRecta(a, b) * 1.4; fuente = 'estimado'; }
  const out = { km: Math.max(0.1, Math.round(km * 10) / 10), fuente };
  if (cacheRutas.size > 2000) cacheRutas.clear();
  cacheRutas.set(clave, out);
  return out;
}

// ---------- Zonas con tarifa fija ----------
// Cada zona puede tener su forma dibujada en el mapa (panel > Tarifas). Si hay formas, la tarifa fija solo vale cuando
// la recogida y la entrega caen dentro de alguna; si no hay ninguna dibujada, vale mientras la distancia no pase del máximo.
function zonasConForma() {
  return db.prepare('SELECT id, nombre, poligono FROM zonas_fijas WHERE activa = 1 AND poligono IS NOT NULL').all()
    .map((z) => { try { return { ...z, puntos: JSON.parse(z.poligono) }; } catch { return null; } }).filter((z) => z && z.puntos.length >= 3);
}
function dentroDe(p, puntos) {   // puntos: [[lng, lat], ...]
  let dentro = false;
  for (let i = 0, j = puntos.length - 1; i < puntos.length; j = i++) {
    const [xi, yi] = puntos[i], [xj, yj] = puntos[j];
    if ((yi > p.lat) !== (yj > p.lat) && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}
// Las zonas se dibujan a mano y sus bordes no coinciden exacto: entre dos vecinas quedan franjas de unos metros.
// Un punto a menos de MARGEN_ZONA metros del borde de una zona cuenta como dentro (así la calle límite no cobra fuera de zona).
const MARGEN_ZONA = 30;
function metrosAlBorde(p, puntos) {
  const kx = 111320 * Math.cos((p.lat * Math.PI) / 180), ky = 110540;
  let min = Infinity;
  for (let i = 0, j = puntos.length - 1; i < puntos.length; j = i++) {
    const ax = (puntos[j][0] - p.lng) * kx, ay = (puntos[j][1] - p.lat) * ky, bx = (puntos[i][0] - p.lng) * kx, by = (puntos[i][1] - p.lat) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    min = Math.min(min, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return min;
}
function zonaDeFormas(p, formas) {
  if (!p || p.lat == null || p.lng == null) return null;
  const dentro = formas.find((z) => dentroDe(p, z.puntos));
  if (dentro) return dentro.nombre;
  let mejor = null, dist = MARGEN_ZONA;
  for (const z of formas) { const d = metrosAlBorde(p, z.puntos); if (d <= dist) { dist = d; mejor = z.nombre; } }
  return mejor;
}
const zonaDePunto = (p) => zonaDeFormas(p, zonasConForma());
const kmMaxFija = () => Number(getAjustes().km_max_tarifa_fija) || 15;
// ¿Se puede cobrar tarifa fija? (null en un punto = todavía no se conoce)
function aplicaTarifaFija(oz, dz, origen, destino, km) {
  if (oz === OTRA_ZONA || dz === OTRA_ZONA) return false;
  const formas = zonasConForma();
  if (formas.length) {
    for (const p of [origen, destino]) if (p && !zonaDeFormas(p, formas)) return false;
    return true;
  }
  return km == null || km <= kmMaxFija();
}

// Precio fijo: tarifa de zona preferencial (ej. Q35) si recogida y entrega están en zonas cubiertas; si no, tarifa de fuera (ej. Q45).
// Ya no se cobra por kilómetro. En la base, tarifa_base guarda la tarifa de fuera de las zonas.
const tarifaFuera = (v) => redondear(Math.max(v.tarifa_zona, v.tarifa_base || 0));
async function cotizar(body) {
  const vehiculo = db.prepare('SELECT * FROM vehiculos WHERE id = ? AND activo = 1').get(numero(body.vehiculo_id));
  if (!vehiculo) falla(400, 'Elige el vehículo para tu envío.');
  if (vehiculo.solo_oficina) falla(400, `El ${vehiculo.nombre.toLowerCase()} es solo para fletes: escríbenos por WhatsApp para coordinar qué llevas y el precio.`);
  const peso = numero(body.peso);
  if (!(peso > 0)) falla(400, 'Escribe el peso aproximado del paquete en libras.');
  if (peso > vehiculo.peso_max) falla(400, `Ese peso supera lo que lleva una ${vehiculo.nombre.toLowerCase()} (máximo ${vehiculo.peso_max} lb). Elige otro vehículo.`);
  const nombresZonas = zonasFijas().map((z) => z.nombre);
  const origen = coordenada(body.origen_lat, body.origen_lng);
  const destino = coordenada(body.destino_lat, body.destino_lng);
  // Si no eligieron zona pero hay ubicación, se toma la del mapa
  let oz = texto(body.origen_zona, 60), dz = texto(body.destino_zona, 60);
  if (!oz && origen) oz = zonaDePunto(origen) || OTRA_ZONA;
  if (!dz && destino) dz = zonaDePunto(destino) || OTRA_ZONA;
  for (const z of [oz, dz]) if (z !== OTRA_ZONA && !nombresZonas.includes(z)) falla(400, 'Elige la zona de recogida y la de entrega.');
  const km = origen && destino ? Math.round(distanciaRecta(origen, destino) * 1.3 * 10) / 10 : null;
  if (aplicaTarifaFija(oz, dz, origen, destino, km)) {
    return conExtras({ tipo: 'zona', km, precio: redondear(vehiculo.tarifa_zona), vehiculo, peso,
      detalle: `Zona preferencial (${vehiculo.nombre})` }, body);
  }
  return conExtras({ tipo: 'fuera', km, precio: tarifaFuera(vehiculo), vehiculo, peso,
    detalle: `Fuera de las zonas preferenciales (${vehiculo.nombre})` }, body);
}
// Paquete frágil (recargo de Tarifas y ajustes)
function conExtras(c, body) {
  const aj = getAjustes();
  const fragil = body.fragil === true || body.fragil === 'si' || body.fragil === 1;
  const recargo = fragil ? redondear(Number(aj.recargo_fragil) || 0) : 0;
  // Ya no se pide el valor del contenido: si pasa algo, la administración lo evalúa con la foto del paquete
  const valor = 0, seguro = 0;
  let detalle = c.detalle + (recargo ? ` + Q${recargo.toFixed(2)} por frágil` : '') + (seguro ? ` + Q${seguro.toFixed(2)} de seguro` : '');
  return { ...c, fragil, recargo_fragil: recargo, valor_declarado: redondear(valor), seguro, precio: redondear(c.precio + recargo + seguro), detalle };
}

// Límite simple de intentos (por IP) para registro y otros envíos de formularios
const intentos = new Map();
// Intentos fallidos de contraseña: se cuentan por internet y por correo. Los correctos no cuentan, así varias
// personas que comparten el mismo internet (por ejemplo, datos móviles) no se bloquean entre sí.
function revisarFallos(req, grupo, email, { porIp = 30, porCorreo = 8, ventanaMs = 900_000 } = {}) {
  const ahora = Date.now();
  const kIp = `${grupo}:ip:${ipDe(req)}`, kCorreo = `${grupo}:correo:${email}`;
  const fIp = (intentos.get(kIp) || []).filter((t) => ahora - t < ventanaMs);
  const fCorreo = (intentos.get(kCorreo) || []).filter((t) => ahora - t < ventanaMs);
  if (fIp.length >= porIp || (email && fCorreo.length >= porCorreo)) falla(429, `Demasiados intentos. Espera ${Math.round(ventanaMs / 60_000)} minutos e inténtalo de nuevo.`);
  return {
    fallo() { intentos.set(kIp, [...fIp, ahora]); if (email) intentos.set(kCorreo, [...fCorreo, ahora]); },
    exito() { if (email) intentos.delete(kCorreo); },
  };
}
function limitar(ip, clave, max, ventanaMs) {
  const k = `${clave}:${ip}`;
  const ahora = Date.now();
  const lista = (intentos.get(k) || []).filter((t) => ahora - t < ventanaMs);
  lista.push(ahora);
  intentos.set(k, lista);
  return lista.length > max;
}
setInterval(() => {
  const ahora = Date.now();
  for (const [k, lista] of intentos) if (lista.every((t) => ahora - t > 3600_000)) intentos.delete(k);
  db.prepare('DELETE FROM sesiones WHERE expira < ?').run(ahora);
  db.prepare('DELETE FROM tokens_correo WHERE expira < ?').run(ahora);
  db.prepare("DELETE FROM ubicaciones WHERE creado < datetime('now', '-30 days')").run();
  // La ubicación de quien recibe se guarda 30 días después de cerrar el envío, igual que el recorrido del piloto
  db.prepare(`UPDATE envios SET receptor_lat = NULL, receptor_lng = NULL, receptor_precision = NULL, origen_lat = NULL, origen_lng = NULL, destino_lat = NULL, destino_lng = NULL
    WHERE (receptor_lat IS NOT NULL OR origen_lat IS NOT NULL) AND estado IN ('entregado','cancelado') AND actualizado < datetime('now', '-30 days')`).run();
  // Si un piloto dejó de mandar ubicación hace más de 10 minutos, queda fuera de línea
  db.prepare("UPDATE usuarios SET en_linea = 0 WHERE en_linea = 1 AND (ubic_fecha IS NULL OR ubic_fecha < datetime('now', '-10 minutes'))").run();
}, 600_000).unref();

// ---------- Respuestas ----------
const CABECERAS_SEGURIDAD = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
};
function json(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CABECERAS_SEGURIDAD, ...extra });
  res.end(JSON.stringify(data));
}
class ErrorHttp extends Error { constructor(status, mensaje) { super(mensaje); this.status = status; } }
function falla(status, mensaje) { throw new ErrorHttp(status, mensaje); }

function leerJson(req, limite = 100_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limite) { reject(new ErrorHttp(413, 'Los datos enviados son demasiado grandes.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new ErrorHttp(400, 'Formato de datos inválido.')); }
    });
    req.on('error', reject);
  });
}
function leerCookies(req) {
  const out = {};
  for (const parte of (req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0) out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return out;
}
const esHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(req.headers['cf-visitor'] || '');
// Una sesión aparte para cada parte de Vaelo: clientes y tiendas, el panel (administración y oficina) y los pilotos.
// Así se pueden tener abiertas a la vez en el mismo navegador sin que una saque a la otra.
const COOKIES_SESION = { cliente: 'vaelo_sesion', panel: 'vaelo_panel', piloto: 'vaelo_piloto' };
const areaDeRol = (rol) => (rol === 'mensajero' ? 'piloto' : rol === 'admin' || rol === 'operador' ? 'panel' : 'cliente');
const cookieSesion = (req, token, maxAge, area = 'cliente') => `${COOKIES_SESION[area] || COOKIES_SESION.cliente}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${esHttps(req) ? '; Secure' : ''}`;
// De qué parte viene la petición: las páginas por su dirección; las consultas (/api) por la página que las hizo
function areaDePeticion(req) {
  const deRuta = (p) => (p.startsWith(RUTA_ADMIN) ? 'panel' : p.startsWith(RUTA_PILOTO) ? 'piloto' : 'cliente');
  const ruta = String(req.url || '').split('?')[0];
  if (!ruta.startsWith('/api/')) return deRuta(ruta);
  // Las consultas propias del panel y de los pilotos usan siempre su sesión (también si se abren escribiendo la dirección)
  if (ruta.startsWith('/api/admin/')) return 'panel';
  if (ruta.startsWith('/api/piloto/')) return 'piloto';
  try { const ref = req.headers.referer; if (ref) return deRuta(new URL(ref).pathname); } catch { /* sin referencia */ }
  return null;   // sin página de origen (pruebas, herramientas): vale cualquier sesión
}
// La IP real la pone Nginx en X-Real-IP (con Cloudflare, Nginx la toma de CF-Connecting-IP solo si la petición viene de Cloudflare).
// No se lee CF-Connecting-IP directo porque cualquiera puede inventarla si entra sin pasar por Cloudflare.
const ipDe = (req) => {
  const directa = req.socket.remoteAddress || '';
  const local = directa === '127.0.0.1' || directa === '::1' || directa === '::ffff:127.0.0.1';
  return (local && req.headers['x-real-ip']) || directa;
};

function usuarioActual(req) {
  if (req._usuario !== undefined) return req._usuario;
  const cookies = leerCookies(req);
  const area = areaDePeticion(req);
  // Primero la sesión de esta parte; la antigua (vaelo_sesion) sirve mientras tanto en el panel y con los pilotos.
  // En la parte de clientes la administración también puede entrar con su sesión del panel.
  const orden = area === 'panel' ? ['panel', 'cliente'] : area === 'piloto' ? ['piloto', 'cliente'] : area === 'cliente' ? ['cliente', 'panel'] : ['cliente', 'panel', 'piloto'];
  let respaldo = null;
  for (const a of orden) {
    const token = cookies[COOKIES_SESION[a]];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) continue;
    const u = db.prepare(`
      SELECT u.id, u.nombre, u.email, u.telefono, u.rol, u.vehiculo_id, u.estado_piloto, u.email_verificado, u.verificacion, u.permisos FROM sesiones s
      JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.token = ? AND s.expira > ? AND u.activo = 1`).get(token, Date.now());
    if (!u) continue;
    // La sesión antigua solo vale en la parte que le corresponde a su rol (si no hay otra, se usa para responder "sin permiso")
    if (a === 'cliente' && area && area !== 'cliente' && areaDeRol(u.rol) !== area) { respaldo = respaldo || { u, token, a }; continue; }
    req._token = token; req._cookieArea = a; req._usuario = u;
    return u;
  }
  if (respaldo && /^\/api\/(admin|piloto)\//.test(String(req.url || ''))) { req._token = respaldo.token; req._cookieArea = respaldo.a; req._usuario = respaldo.u; return respaldo.u; }
  req._usuario = null;
  return null;
}
function requiereUsuario(req) { const u = usuarioActual(req); if (!u) falla(401, 'Inicia sesión para continuar.'); return u; }
function requiereRol(req, ...roles) {
  const u = requiereUsuario(req);
  if (!roles.includes(u.rol)) falla(403, 'No tienes permiso para esta sección.');
  if (u.rol === 'admin' && u.email !== ADMIN_EMAIL) falla(403, 'No tienes permiso para esta sección.');
  return u;
}
const esAdmin = (u) => !!u && u.rol === 'admin' && u.email === ADMIN_EMAIL;
const esOperador = (u) => !!u && u.rol === 'operador';
// Administración o empleado de oficina (operador): ven y asignan envíos, pero no la caja, reportes, descuentos ni tarifas
// Áreas del panel que se le pueden dar a cada empleado
const AREAS_PANEL = { envios: 'Envíos', pilotos: 'Pilotos', clientes: 'Clientes', empresas: 'Empresas' };
const permisosDe = (u) => { const l = String(u?.permisos || '').split(',').filter((x) => AREAS_PANEL[x]); return u?.permisos == null || u.permisos === '' ? Object.keys(AREAS_PANEL) : l; };
function areaDeRuta(url) {
  const p = String(url || '').split('?')[0];
  if (/^\/api\/admin\/(resumen|nuevos)$/.test(p)) return null;   // lo usan todos para los avisos
  if (/^\/api\/admin\/(mensajeros|flota|sueldos)|^\/api\/admin\/usuarios\/\d+\/documento/.test(p)) return 'pilotos';
  if (/^\/api\/admin\/(clientes|influencers)/.test(p)) return 'clientes';
  if (/^\/api\/admin\/(empresas|lotes-empresa|lotes-sede|pedidos|bonos|planes|tiendas)/.test(p)) return 'empresas';
  if (/^\/api\/admin\/(envios|fletes|buscar|alertas|reclamos)/.test(p)) return 'envios';
  return null;
}
function requiereStaff(req) {
  const u = requiereUsuario(req);
  if (!esAdmin(u) && !esOperador(u)) falla(403, 'No tienes permiso para esta sección.');
  if (esOperador(u)) { const area = areaDeRuta(req.url); if (area && u.permisos != null && u.permisos !== '' && !permisosDe(u).includes(area)) falla(403, `No tienes permiso para «${AREAS_PANEL[area]}». Pídeselo a la administración.`); }
  return u;
}
function crearSesion(req, usuarioId, maxAge = SESION_DIAS * 86400) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sesiones (token, usuario_id, expira) VALUES (?, ?, ?)').run(token, usuarioId, Date.now() + maxAge * 1000);
  const rol = db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(usuarioId)?.rol;
  return cookieSesion(req, token, maxAge, areaDeRol(rol));
}

// ---------- Consultas de envíos ----------
const SQL_ENVIO = `
  SELECT e.*, v.nombre AS vehiculo, u.nombre AS cliente_nombre, u.email AS cliente_email, u.telefono AS cliente_telefono,
         m.nombre AS mensajero_nombre, m.telefono AS mensajero_telefono,
         m.ubic_lat AS mensajero_lat, m.ubic_lng AS mensajero_lng, m.ubic_fecha AS mensajero_ubic_fecha
  FROM envios e
  JOIN vehiculos v ON v.id = e.vehiculo_id
  JOIN usuarios u ON u.id = e.usuario_id
  LEFT JOIN usuarios m ON m.id = e.mensajero_id`;

function envioSalida(e) {
  const out = { ...e };
  // Envíos de antes (sin código corto) que siguen en curso: se les asigna al mostrarlos
  if (!out.codigo_corto && ['pendiente', 'recogido', 'en_camino'].includes(e.estado) && !e.flete && (!e.marcado || e.marcado === 'codigo')) out.codigo_corto = codigoCortoEnvio(e.id);
  // La empresa marcó con etiqueta impresa o con el nombre del cliente: el código no se usa ni se muestra
  if (e.marcado && e.marcado !== 'codigo') out.codigo_corto = null;
  if (e.marcado) out.marcado_texto = MARCADOS[e.marcado] || '';
  // La ubicación del mensajero solo se muestra mientras lleva el paquete y si es reciente (2 horas)
  const reciente = e.mensajero_ubic_fecha && (Date.now() - new Date(e.mensajero_ubic_fecha.replace(' ', 'T') + 'Z').getTime()) < 2 * 3600_000;
  if (!['recogido', 'en_camino', 'pendiente'].includes(e.estado) || !reciente) {
    out.mensajero_lat = null; out.mensajero_lng = null; out.mensajero_ubic_fecha = null;
  }
  return out;
}
const eventosDe = (id) => db.prepare('SELECT estado, nota, lat, lng, creado FROM eventos WHERE envio_id = ? ORDER BY id').all(id);

function cambiarEstado(envioId, estado, nota, lat, lng) {
  const c = coordenada(lat, lng);
  const antes = db.prepare('SELECT * FROM envios WHERE id = ?').get(envioId);
  db.prepare("UPDATE envios SET estado = ?, actualizado = datetime('now') WHERE id = ?").run(estado, envioId);
  if (estado === 'entregado') db.prepare("UPDATE envios SET entregado_en = COALESCE(entregado_en, datetime('now')) WHERE id = ?").run(envioId);
  // El piloto terminó su parte (entregó, devolvió o dejó en la sede): se calcula lo que gana
  if (['entregado', 'devuelto', 'en_sede'].includes(estado) && antes.mensajero_id && !antes.piloto_cerro_en) {
    let gana = antes.ganancia_piloto ?? antes.ganancia_acordada ?? gananciaPiloto(antes.precio);
    if (estado === 'devuelto') gana = redondear(gana + gananciaPiloto(Number(getAjustes().cargo_devolucion) || 0));
    db.prepare("UPDATE envios SET piloto_cerro_en = datetime('now'), ganancia_piloto = ? WHERE id = ?").run(gana, envioId);
  }
  // Cancelado: los cargos pendientes que iban a cobrarse con este envío vuelven a quedar pendientes
  if (estado === 'cancelado') liberarCargos(envioId);
  // Paquete de empresa guardado en la sede: al salir (o cancelarse) se cobran los días en la sede. El mismo día no se cobra.
  if (antes.lote_sede_id && ['recogido', 'cancelado'].includes(estado) && antes.estado === 'pendiente') cobrarBodegaEmpresa(antes);
  db.prepare('INSERT INTO eventos (envio_id, estado, nota, lat, lng) VALUES (?, ?, ?, ?, ?)')
    .run(envioId, estado, nota, c ? c.lat : null, c ? c.lng : null);
  if (antes.estado !== estado) avisarEnvio(envioId, estado);
  // Bono de la empresa: se suma al entregar; si el envío deja de estar entregado y no se ha pagado, se quita
  if (estado === 'entregado' && antes.estado !== 'entregado') registrarBono(antes);
  if (antes.estado === 'entregado' && estado !== 'entregado') db.prepare('DELETE FROM bonos_empresa WHERE envio_id = ? AND liquidacion_id IS NULL').run(envioId);
}

// ---------- Bono para empresas por envío entregado ----------
const TOPE_BONO = 5;   // nunca más de lo que se queda Vaelo por envío
// Solo ganan bono las empresas a las que la administración se lo activó
function bonoDe(u) {
  if (!u || u.tipo_cuenta !== 'empresa' || !u.bono_activo) return 0;
  const m = u.bono_envio != null ? Number(u.bono_envio) : Number(getAjustes().bono_empresa) || 0;
  return redondear(Math.max(0, Math.min(TOPE_BONO, m || 0)));
}
function registrarBono(e) {
  const u = db.prepare('SELECT tipo_cuenta, bono_envio, bono_activo FROM usuarios WHERE id = ?').get(e.usuario_id);
  const monto = bonoDe(u);
  if (monto > 0) db.prepare('INSERT OR IGNORE INTO bonos_empresa (usuario_id, envio_id, monto) VALUES (?, ?, ?)').run(e.usuario_id, e.id, monto);
}
const MODOS_BONO = { pago: 'Se te paga', descuento: 'Se descuenta de tus envíos' };
function resumenBono(uid) {
  const u = db.prepare('SELECT tipo_cuenta, bono_envio, bono_modo, bono_activo FROM usuarios WHERE id = ?').get(uid);
  const mes = hoyGT().slice(0, 7);
  const g = (sql, ...a) => db.prepare(sql).get(uid, ...a);
  const pend = g('SELECT COUNT(*) AS n, COALESCE(SUM(monto), 0) AS total FROM bonos_empresa WHERE usuario_id = ? AND liquidacion_id IS NULL');
  const delMes = g("SELECT COUNT(*) AS n, COALESCE(SUM(monto), 0) AS total FROM bonos_empresa WHERE usuario_id = ? AND strftime('%Y-%m', creado, '-6 hours') = ?", mes);
  const todo = g('SELECT COUNT(*) AS n, COALESCE(SUM(monto), 0) AS total FROM bonos_empresa WHERE usuario_id = ?');
  return { activo: !!u?.bono_activo, por_envio: bonoDe(u), modo: u?.bono_modo || 'pago', modo_texto: MODOS_BONO[u?.bono_modo] || MODOS_BONO.pago,
    pendiente: redondear(pend.total), entregas_pendientes: pend.n, mes: redondear(delMes.total), entregas_mes: delMes.n,
    total: redondear(todo.total), entregas_total: todo.n, recibido: redondear(todo.total - pend.total),
    liquidaciones: db.prepare('SELECT id, monto, entregas, modo, nota, creado FROM liquidaciones_bono WHERE usuario_id = ? ORDER BY id DESC LIMIT 24').all(uid) };
}

// ---------- Historial de acciones del personal ----------
const ACCIONES = [
  [/^\/api\/admin\/envios\/:id\/estado$/, (b) => `Cambió a mano el estado a «${ESTADO_TEXTO[b.estado] || b.estado}»${b.nota ? ': ' + b.nota : ''}`],
  [/^\/api\/admin\/envios\/:id\/asignar-cercano$/, () => 'Asignó al piloto más cercano'],
  [/^\/api\/admin\/envios\/:id\/asignar$/, (b) => b.mensajero_id ? `Asignó el envío a ${nombreUsuario(b.mensajero_id)}` : 'Quitó el piloto del envío'],
  [/^\/api\/admin\/envios\/:id\/fallido$/, (b) => `Decidió qué hacer con un envío no entregado${b.accion ? ': ' + b.accion : ''}`],
  [/^\/api\/admin\/envios\/:id\/receptor$/, () => 'Cambió los datos de quien recibe'],
  [/^\/api\/admin\/fletes$/, (b) => `Creó un flete${b.precio ? ' de Q' + b.precio : ''}`],
  [/^\/api\/admin\/usuarios\/:id\/eliminar$/, () => 'ELIMINÓ una cuenta'],
  [/^\/api\/admin\/clientes\/:id\/activo$/, (b) => b.activo ? 'Desbloqueó una cuenta' : 'Bloqueó una cuenta'],
  [/^\/api\/admin\/clientes\/:id\/empresa$/, (b) => `Cambió la cuenta a ${b.tipo_cuenta === 'empresa' ? 'empresa' : 'personal'}${b.descuento_empresa ? ` con ${b.descuento_empresa}% de descuento` : ''}`],
  [/^\/api\/admin\/mensajeros$/, (b) => `Creó la cuenta de piloto de ${b.nombre || ''}`],
  [/^\/api\/admin\/mensajeros\/:id\/estado$/, (b) => `Cambió el estado del piloto a «${ESTADOS_PILOTO[b.estado] || b.estado}»`],
  [/^\/api\/admin\/mensajeros\/:id\/borrar-documentos$/, () => 'Borró los documentos de un piloto'],
  [/^\/api\/admin\/mensajeros\/:id\/renovacion$/, (b) => `Revisó una renovación de documentos${b.decision ? ': ' + b.decision : ''}`],
  [/^\/api\/admin\/mensajeros\/:id$/, () => 'Editó los datos de un piloto'],
  [/^\/api\/admin\/usuarios\/:id\/documento$/, (b) => `Subió un documento (${b.tipo || b.campo || ''})`],
  [/^\/api\/admin\/caja\/pagar-piloto$/, (b) => `Marcó como pagado a un piloto${b.monto ? ' Q' + b.monto : ''}`],
  [/^\/api\/admin\/caja\/liquidar$/, (b) => `Recibió efectivo de un piloto${b.recibido ? ' Q' + b.recibido : ''}`],
  [/^\/api\/admin\/caja\/pagar-cobros$/, () => 'Marcó como pagados los cobros de un cliente'],
  [/^\/api\/admin\/sueldos\/:id\/pagado$/, () => 'Marcó «Ya fue pagado» el sueldo de un piloto'],
  [/^\/api\/admin\/cierres$/, () => 'Cerró el día'],
  [/^\/api\/admin\/bonos\/:id\/liquidar$/, () => 'Marcó como pagado o descontado el bono de una empresa'],
  [/^\/api\/admin\/bonos\/:id$/, (b) => `${b.bono_activo ? 'Activó' : 'Apagó'} el bono de una empresa${b.bono_envio !== '' && b.bono_envio != null ? ` (Q${b.bono_envio} por envío)` : ''}`],
  [/^\/api\/admin\/ajustes$/, (b) => `Cambió ajustes: ${Object.entries(b).filter(([k]) => !/token|clave|password|zonas/i.test(k)).map(([k, v]) => `${k.replace(/_/g, ' ')} → ${typeof v === 'object' ? '…' : String(v).slice(0, 40)}`).join(', ')}`],
  [/^\/api\/admin\/vehiculos\/:id$/, (b) => `Cambió tarifas de ${b.nombre || 'un vehículo'}: zona Q${b.tarifa_zona}, fuera Q${b.tarifa_base}`],
  [/^\/api\/admin\/zonas/, () => 'Cambió las zonas del mapa'],
  [/^\/api\/admin\/promociones/, (b) => `Creó o cambió la promoción ${b.nombre || ''}`],
  [/^\/api\/admin\/operadores/, (b) => `Creó o cambió la cuenta de empleado ${b.nombre || b.email || ''}`],
  [/^\/api\/admin\/cargos\/:id$/, (b) => `${b.anular ? 'Anuló' : 'Cambió'} un cargo a cliente`],
  [/^\/api\/admin\/reclamos\/:id$/, () => 'Resolvió un reclamo'],
  [/^\/api\/admin\/influencers\/solicitudes\/:id\/aprobar$/, (b) => `Creó el código ${String(b.codigo || '').toUpperCase()} para un influencer`],
  [/^\/api\/admin\/influencers\/solicitudes\/:id\/rechazar$/, (b) => `Rechazó una solicitud de influencer${b.nota ? `: ${b.nota}` : ''}`],
  [/^\/api\/admin\/influencers\/:id$/, (b) => (b.activo === false ? 'Pausó un código de influencer' : b.activo === true ? 'Reactivó un código de influencer' : `Cambió un código de influencer${b.codigo ? ` a ${String(b.codigo).toUpperCase()}` : ''}`)],
  [/^\/api\/admin\/influencers\/:id\/puntos$/, (b) => `Ajustó ${b.puntos} puntos a un influencer: ${b.nota || ''}`],
  [/^\/api\/admin\/influencers\/:id\/regalos\/:regalo\/entregado$/, () => 'Entregó un regalo a un influencer'],
  [/^\/api\/admin\/influencers-regalos$/, (b) => `Cambió los regalos de influencers (${b.puntos_por_uso} puntos por cliente): ${(b.regalos || []).map((r) => `${r.regalo} ${r.puntos}`).join(', ')}`],
  [/^\/api\/admin\/tiendas\/:id\/aprobar$/, (b) => `Aprobó una tienda minorista${b.foco_zona ? ` con zona foco ${b.foco_zona}` : ''}`],
  [/^\/api\/admin\/tiendas\/:id\/rechazar$/, (b) => `Rechazó una solicitud de tienda${b.nota ? `: ${b.nota}` : ''}`],
  [/^\/api\/admin\/planes$/, (b) => `Creó el plan «${b.nombre || ''}»: ${condicionesEnTexto(b.condiciones || {})}`],
  [/^\/api\/admin\/planes\/:id$/, (b) => (b.nombre ? `Cambió el plan «${b.nombre}»: ${condicionesEnTexto(b.condiciones || {})}` : 'Borró un plan de tiendas')],
  [/^\/api\/admin\/empresas\/:id\/condiciones$/, (b) => `Cambió las condiciones de una tienda: ${Object.keys(b.propias || {}).length ? 'excepciones: ' + condicionesEnTexto(b.propias) + (b.vence ? ` (vencen el ${b.vence})` : ' (sin vencimiento)') : 'sin excepciones'}`],
  [/^\/api\/admin\/empresas\/:id$/, (b) => `Cambió una solicitud de empresa${b.estado ? ' a ' + b.estado : ''}`],
  [/^\/api\/admin\/lotes-/, () => 'Trabajó un lote de empresa (ruta, recibido o confirmación)'],
  [/^\/api\/admin\/alertas\/:id\/atender$/, () => 'Marcó atendida una emergencia de piloto'],
];
const nombreUsuario = (id) => db.prepare('SELECT COALESCE(empresa_nombre, nombre) AS n FROM usuarios WHERE id = ?').get(Number(id))?.n || `#${id}`;
// Se lee antes de la acción (por ejemplo, el nombre de una cuenta que se va a eliminar)
function contextoAccion(patron, params) {
  if (!params.id) return '';
  if (/\/envios\/:id/.test(patron)) { const e = db.prepare('SELECT guia FROM envios WHERE id = ?').get(Number(params.id)); return e ? `Envío ${e.guia}` : ''; }
  if (/\/influencers\/:id/.test(patron)) { const i = db.prepare('SELECT i.codigo, u.nombre FROM influencers i JOIN usuarios u ON u.id = i.usuario_id WHERE i.id = ?').get(Number(params.id)); return i ? `${i.nombre} (${i.codigo})` : ''; }
  if (/\/influencers\/solicitudes\/:id/.test(patron)) { const x = db.prepare('SELECT nombre, redes FROM influencer_solicitudes WHERE id = ?').get(Number(params.id)); return x ? `${x.nombre} (${x.redes})` : ''; }
  if (/\/tiendas\/:id\//.test(patron)) { const u = db.prepare('SELECT nombre, empresa_nombre FROM usuarios WHERE id = ?').get(Number(params.id)); return u ? `${u.empresa_nombre || ''} (${u.nombre})` : ''; }
  if (/\/planes\/:id$/.test(patron)) { const p = db.prepare('SELECT nombre, condiciones FROM planes WHERE id = ?').get(Number(params.id)); return p ? `Plan «${p.nombre}». Antes: ${condicionesEnTexto(jsonSeguro(p.condiciones))}` : ''; }
  if (/\/empresas\/:id\/condiciones$/.test(patron)) { const u = db.prepare('SELECT nombre, empresa_nombre, condiciones_propias, condiciones_vence, plan_id FROM usuarios WHERE id = ?').get(Number(params.id));
    return u ? `${u.empresa_nombre || u.nombre}. Antes: ${condicionesEnTexto(jsonSeguro(u.condiciones_propias))}${u.condiciones_vence ? ` (vencían el ${u.condiciones_vence})` : ''}` : ''; }
  if (/\/(usuarios|clientes|mensajeros|bonos)\/:id/.test(patron)) { const u = db.prepare('SELECT nombre, empresa_nombre, email FROM usuarios WHERE id = ?').get(Number(params.id)); return u ? `${u.empresa_nombre || u.nombre} (${u.email})` : ''; }
  return '';
}
function guardarHistorial(actor, patron, params, body, previo) {
  const def = ACCIONES.find(([re]) => re.test(patron));
  let accion = def ? def[1](body || {}) : `Acción en ${patron.replace('/api/admin/', '')}`;
  accion = String(accion).slice(0, 300);
  db.prepare('INSERT INTO historial (usuario_id, nombre, rol, accion, detalle, ruta) VALUES (?, ?, ?, ?, ?, ?)')
    .run(actor.id, actor.nombre, esAdmin(actor) ? 'admin' : 'operador', accion, previo || null, patron);
}

// ---------- Rutas de la API ----------
const rutas = [];
function ruta(metodo, patron, fn, opciones = {}) {
  const claves = [];
  const re = new RegExp('^' + patron.replace(/:(\w+)/g, (_, k) => { claves.push(k); return '([^/]+)'; }) + '$');
  rutas.push({ metodo, re, claves, fn, limite: opciones.limite, patron });
}

// Público
ruta('GET', '/api/config', () => {
  const aj = getAjustes();
  return {
    vehiculos: db.prepare('SELECT id, nombre, descripcion, peso_max, tarifa_zona, tarifa_base, precio_km FROM vehiculos WHERE activo = 1 AND solo_oficina = 0 ORDER BY orden, id').all(),
    fletes: db.prepare('SELECT nombre FROM vehiculos WHERE activo = 1 AND solo_oficina = 1 ORDER BY orden, id').all().map((v) => v.nombre),
    whatsapp_pagos: aj.whatsapp_pagos || '50237731793',
    zonas: zonasFijas().map((z) => z.nombre),
    otraZona: OTRA_ZONA,
    whatsapp: aj.whatsapp || '',
    horario: aj.horario || '',
    recargo_fragil: Number(aj.recargo_fragil) || 0,
    promocion: promocionAnunciada(),
    seguro: { pct: Number(aj.seguro_pct) || 0, minimo: Number(aj.seguro_minimo) || 0, responsabilidad_max: Number(aj.responsabilidad_max) || 0 },
    datos_transferencia: aj.datos_transferencia || '',
    vaelo_por_envio: aj.comision_tipo === 'vaelo_fijo' ? Number(aj.comision_valor) || 0 : null, dias_liquidar: Number(aj.dias_liquidar) || 3,
    cargo_bodega_empresa: Number(aj.cargo_bodega_empresa) || 0, min_paquetes_sede: Number(aj.min_paquetes_sede) || 10, dias_reclamo: Number(aj.dias_reclamo) || 3,
    cargos: { devolucion: Number(aj.cargo_devolucion) || 0, bodega_dia: Number(aj.cargo_bodega_dia) || 0, reentrega: Number(aj.cargo_reentrega) || 0,
      cancelacion: Number(aj.cargo_cancelacion) || 0, horas_decidir: Number(aj.horas_decidir_fallido) || 2 },
  };
});

ruta('POST', '/api/cotizar', async ({ req, body }) => {
  const c = await cotizar(body);
  const u = usuarioActual(req);
  const desc = mejorDescuento(c.precio, u ? u.id : null, body.cupon);
  const pendientes = u ? redondear(cargosPendientes(u.id).filter((x) => x.tipo !== 'bodega_empresa').reduce((t, x) => t + x.monto, 0)) : 0;
  return { tipo: c.tipo, km: c.km, precio_base: c.precio, precio: desc.precio, descuento: desc.descuento, promocion: desc.promocion,
    error_cupon: desc.errorCupon, detalle: c.detalle, recargo_fragil: c.recargo_fragil, seguro: c.seguro, cargos_pendientes: pendientes,
    por_confirmar: !!c.por_confirmar };
});

// Datos de entrega fallida, sede, cargos y pago que ven el cliente y el panel
const CAMPOS_INTERNOS = ['foto_paquete', 'foto_entrega', 'firma_entrega', 'liquidado_id', 'pago_piloto_id', 'ganancia_piloto', 'ganancia_acordada', 'excluidos', 'intentos_codigo', 'fallo_foto', 'comprobante',
  'calif_cliente', 'calif_cliente_comentario', 'precio_o_lat', 'precio_o_lng', 'precio_d_lat', 'precio_d_lng'];
function infoExtra(e) {
  const aj = getAjustes();
  const out = { tiene_comprobante: !!e.comprobante, tiene_foto_paquete: !!e.foto_paquete };
  if ((e.paquetes || 1) > 1 && !e.pedido_id) { const x = paquetesExtra(e.id); if (x.length) { out.paquetes_extra = x; out.peso_paquete1 = redondear(e.peso - x.reduce((t, p) => t + (p.peso || 0), 0)); } }
  if (e.fallo_en) {
    out.fallo = { motivo: e.fallo_motivo, motivo_texto: MOTIVOS_FALLO[e.fallo_motivo] || '', nota: e.fallo_nota, en: e.fallo_en, tiene_foto: !!e.fallo_foto,
      decision: e.fallo_decision, decidido_por: e.fallo_decidido_por,
      decidir_antes: e.estado === 'fallido' ? new Date(fechaMs(e.fallo_en) + horasDecidir() * 3600_000).toISOString() : null,
      cargo_devolucion: Number(aj.cargo_devolucion) || 0, cargo_bodega_dia: Number(aj.cargo_bodega_dia) || 0, cargo_reentrega: Number(aj.cargo_reentrega) || 0 };
  }
  if (e.sede_llegada) out.sede = { llegada: e.sede_llegada, salida: e.sede_salida, dias: diasEnSede(e), cargo: cargoBodega(e), direccion: aj.sede_direccion || '' };
  if (e.reentrega_de) out.reentrega_de = db.prepare('SELECT guia FROM envios WHERE id = ?').get(e.reentrega_de)?.guia || null;
  if (e.estado === 'reenviado') out.reenviado_como = db.prepare('SELECT id, guia FROM envios WHERE reentrega_de = ? ORDER BY id DESC LIMIT 1').get(e.id) || null;
  return out;
}


// Cuentas
ruta('POST', '/api/registro', async ({ req, body }) => {
  if (limitar(ipDe(req), 'registro', 10, 3600_000)) falla(429, 'Demasiados intentos. Espera un momento e inténtalo de nuevo.');
  const nombre = texto(body.nombre, 100);
  const email = texto(body.email, 150).toLowerCase();
  const telefono = texto(body.telefono, 30);
  const password = typeof body.password === 'string' ? body.password : '';
  if (nombre.length < 2) falla(400, 'Escribe tu nombre completo.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) falla(400, 'Escribe un correo válido.');
  if (telefono.replace(/\D/g, '').length < 8) falla(400, 'Escribe un teléfono de 8 dígitos.');
  if (password.length < 8) falla(400, 'La contraseña debe tener al menos 8 caracteres.');
  // Quien vende en lives o redes pide su cuenta de tienda: la oficina la revisa y le asigna su plan
  const tienda = body.tienda === undefined ? null : texto(String(body.tienda), 60);
  if (tienda !== null && tienda.length < 2) falla(400, 'Escribe el nombre de tu tienda (el que ven tus clientes en tus lives).');
  const solicitud = tienda !== null ? leerSolicitudTienda(body) : null;
  if (body.acepto_terminos !== true) falla(400, 'Para crear tu cuenta acepta los términos y el aviso de privacidad.');
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) falla(409, 'Ya existe una cuenta con ese correo. Inicia sesión.');
  const r = db.prepare("INSERT INTO usuarios (nombre, email, telefono, password_hash, email_verificado, terminos_aceptados, tipo_cuenta, empresa_nombre) VALUES (?, ?, ?, ?, 0, datetime('now'), ?, ?)")
    .run(nombre, email, telefono, hashPassword(password), tienda ? 'minorista' : 'personal', tienda);
  const id = Number(r.lastInsertRowid);
  if (tienda) guardarSolicitudTienda(id, nombre, tienda, solicitud);
  const enviado = await enviarConfirmacion({ id, nombre, email });
  return { _status: 201, _headers: { 'Set-Cookie': crearSesion(req, id) }, ok: true, rol: 'cliente', correo_enviado: enviado };
});

ruta('POST', '/api/login', ({ req, body }) => {
  const email = texto(body.email, 150).toLowerCase();
  const control = revisarFallos(req, 'login', email);
  const password = typeof body.password === 'string' ? body.password : '';
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
  // La administración, los pilotos y la oficina entran por su propia página; aquí responde igual que una contraseña equivocada
  if (!u || u.rol !== 'cliente' || !verificarPassword(password, u.password_hash)) { control.fallo(); falla(401, 'Correo o contraseña incorrectos.'); }
  control.exito();
  if (!u.activo) falla(403, 'Esta cuenta está desactivada. Comunícate con Vaelo.');
  return { _headers: { 'Set-Cookie': crearSesion(req, u.id) }, ok: true, rol: u.rol, tipo_cuenta: u.tipo_cuenta || 'personal' };
});

// Acceso de administración (solo desde /familiatecun y solo con el correo permitido)
ruta('POST', '/api/acceso-familia', ({ req, body }) => {
  // Solo cuentan los intentos fallidos: 5 errores bloquean ese internet (o ese correo) por 30 minutos
  const email = texto(body.email, 150).toLowerCase();
  const control = revisarFallos(req, 'acceso-familia', email, { porIp: 5, porCorreo: 5, ventanaMs: 1800_000 });
  const password = typeof body.password === 'string' ? body.password : '';
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
  const ok = u && u.activo && ((email === ADMIN_EMAIL && u.rol === 'admin') || u.rol === 'operador') && verificarPassword(password, u.password_hash);
  if (!ok) { control.fallo(); falla(401, 'Datos incorrectos.'); }
  control.exito();
  // Se permiten dos dispositivos a la vez (por ejemplo la computadora y el celular): se cierran las sesiones más viejas
  db.prepare('DELETE FROM sesiones WHERE usuario_id = ? AND token NOT IN (SELECT token FROM sesiones WHERE usuario_id = ? ORDER BY expira DESC LIMIT 1)').run(u.id, u.id);
  return { _headers: { 'Set-Cookie': crearSesion(req, u.id, SESION_ADMIN_HORAS * 3600) }, ok: true };
});

ruta('POST', '/api/logout', ({ req }) => {
  // Se cierra solo la sesión de la parte desde donde se sale (las demás pestañas siguen abiertas)
  usuarioActual(req);
  if (req._token) db.prepare('DELETE FROM sesiones WHERE token = ?').run(req._token);
  return { _headers: { 'Set-Cookie': cookieSesion(req, '', 0, req._cookieArea || areaDePeticion(req) || 'cliente') }, ok: true };
});

// Errores de pantalla: el navegador del cliente avisa cuando una página se rompe
ruta('POST', '/api/error-pantalla', ({ req, body }) => {
  if (limitar(ipDe(req), 'error-pantalla', 20, 3600_000)) return { ok: true };
  let quien = ''; try { const u = usuarioActual(req); if (u) quien = `${u.nombre || ''} (${u.email || u.rol || ''})`; } catch { /* sin sesión */ }
  const err = { message: texto(body.mensaje, 400), stack: texto(body.detalle, 1500) };
  avisarError('pantalla de ' + (texto(body.pagina, 80) || 'Vaelo'), err, { ruta: texto(body.pagina, 120), 'Usuario': quien, 'Navegador': texto(req.headers['user-agent'], 160) });
  return { ok: true };
});
ruta('GET', '/api/yo', ({ req }) => {
  const u = usuarioActual(req);
  if (!u) return { usuario: null };
  if (u.rol !== 'cliente') return { usuario: u };
  const fila = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.id);
  return { usuario: { ...u, ...datosCliente(fila) }, correo_activo: correoActivo() };
});

ruta('PUT', '/api/yo', ({ req, body }) => {
  const u = requiereUsuario(req);
  const nombre = texto(body.nombre, 100), telefono = texto(body.telefono, 30);
  if (nombre.length < 2) falla(400, 'Escribe tu nombre completo.');
  if (telefono.replace(/\D/g, '').length < 8) falla(400, 'Escribe un teléfono de 8 dígitos.');
  const fila = db.prepare('SELECT verificacion FROM usuarios WHERE id = ?').get(u.id);
  // Ya verificado, el nombre y el DPI no se pueden cambiar desde aquí
  if (fila.verificacion === 'verificado') {
    db.prepare('UPDATE usuarios SET telefono = ? WHERE id = ?').run(telefono, u.id);
    if (body.direccion !== undefined) db.prepare('UPDATE usuarios SET direccion = ? WHERE id = ?').run(texto(body.direccion, 300) || null, u.id);
    return { ok: true };
  }
  db.prepare('UPDATE usuarios SET nombre = ?, telefono = ? WHERE id = ?').run(nombre, telefono, u.id);
  if (u.rol === 'cliente') {
    if (body.dpi !== undefined) {
      const dpi = String(body.dpi || '').replace(/\D/g, '');
      if (dpi && dpi.length !== 13) falla(400, 'El número de DPI debe tener 13 dígitos.');
      if (dpi && db.prepare('SELECT 1 FROM usuarios WHERE dpi = ? AND id != ?').get(dpi, u.id)) falla(409, 'Ese DPI ya está registrado en otra cuenta. Escríbenos si es un error.');
      db.prepare('UPDATE usuarios SET dpi = ? WHERE id = ?').run(dpi || null, u.id);
    }
    if (body.direccion !== undefined) db.prepare('UPDATE usuarios SET direccion = ? WHERE id = ?').run(texto(body.direccion, 300) || null, u.id);
    actualizarVerificacionCliente(u.id);
  }
  return { ok: true };
});

ruta('POST', '/api/cambiar-password', ({ req, body }) => {
  const u = requiereUsuario(req);
  const fila = db.prepare('SELECT password_hash FROM usuarios WHERE id = ?').get(u.id);
  if (!verificarPassword(String(body.actual || ''), fila.password_hash)) falla(400, 'La contraseña actual no es correcta.');
  const nueva = String(body.nueva || '');
  if (nueva.length < 8) falla(400, 'La nueva contraseña debe tener al menos 8 caracteres.');
  db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(hashPassword(nueva), u.id);
  // Se cierran las demás sesiones abiertas (otros teléfonos o computadoras); esta sigue abierta
  db.prepare('DELETE FROM sesiones WHERE usuario_id = ? AND token != ?').run(u.id, req._token || '');
  return { ok: true };
});

// Cliente: envíos
ruta('GET', '/api/envios', ({ req }) => {
  const u = requiereUsuario(req);
  return { envios: db.prepare(`${SQL_ENVIO} WHERE e.usuario_id = ? AND e.pedido_id IS NULL ORDER BY e.id DESC LIMIT 200`).all(u.id).map((e) => {
    const out = sinCamposReceptor(envioSalida(e));
    out.receptor_confirmado = !!e.receptor_confirmado_en; out.receptor_listo = receptorListo(e);
    out.destino_lat = null; out.destino_lng = null;   // quien envía no ve dónde está quien recibe
    Object.assign(out, infoExtra(e));
    for (const k of CAMPOS_INTERNOS) delete out[k];
    return out;
  }), datos_transferencia: getAjustes().datos_transferencia || '',
  // Empresas: sus pedidos van en carpetas, pero cuentan en el resumen de arriba (en curso y entregados)
  pedidos: esNegocio(db.prepare('SELECT tipo_cuenta FROM usuarios WHERE id = ?').get(u.id)) ? db.prepare(`SELECT SUM(estado IN ('pendiente','recogido','en_camino','fallido','devolviendo','a_sede','en_sede')) AS curso,
    SUM(estado = 'entregado') AS entregados FROM envios WHERE usuario_id = ? AND pedido_id IS NOT NULL`).get(u.id) : null };
});

ruta('GET', '/api/envios/:id', ({ req, params }) => {
  const u = requiereUsuario(req);
  const e = db.prepare(`${SQL_ENVIO} WHERE e.id = ? AND e.usuario_id = ?`).get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
  const out = envioSalida(e);
  // El cliente ve al piloto solo cuando ya aceptó el envío
  const aceptado = e.asignacion === 'aceptado' && e.mensajero_id;
  if (!aceptado) { out.mensajero_nombre = null; out.mensajero_telefono = null; out.mensajero_lat = null; out.mensajero_lng = null; }
  out.tiene_foto_entrega = !!e.foto_entrega; out.tiene_firma_entrega = !!e.firma_entrega;
  out.tiene_foto_fallo = !!e.fallo_foto;
  Object.assign(out, infoExtra(e));
  for (const k of CAMPOS_INTERNOS) delete out[k];
  // Quien envía ve si quien recibe ya confirmó, pero no su ubicación
  const r = datosReceptor(e);
  out.receptor = { confirmado: r.confirmado, omitido: !!r.omitido, listo: r.listo, exigido: r.exigido, en_vivo: r.en_vivo, nombre: r.nombre,
    enlace: ESTADOS_ACTIVOS.includes(e.estado) ? '/recibe/' + tokenReceptor(e) : null };
  const o = datosOrigen(e);
  out.origen = { quien: o.quien, nombre: o.nombre, confirmado: o.confirmado, en_vivo: o.en_vivo,
    enlace: e.origen_quien === 'tercero' && e.estado === 'pendiente' && e.origen_token ? '/entrega/' + e.origen_token : null };
  // Quien envía no ve dónde está quien recibe
  out.destino_lat = null; out.destino_lng = null;
  sinCamposReceptor(out);
  const aj = getAjustes();
  return { envio: out, eventos: eventosDe(e.id), piloto: aceptado ? pilotoParaCliente(e.mensajero_id) : null, datos_transferencia: aj.datos_transferencia || '',
    whatsapp_pagos: aj.whatsapp_pagos || '50237731793', dias_reclamo: Number(aj.dias_reclamo) || 3,
    reclamos: reclamosDe(e.id).map(({ monto_piloto, piloto, piloto_id, descontado_pago_id, ...r }) => r) };
});


ruta('POST', '/api/envios/:id/cancelar', ({ req, params, body }) => {
  const u = requiereUsuario(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND usuario_id = ?').get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
  if (e.estado !== 'pendiente') falla(400, 'Solo puedes cancelar envíos que todavía no hemos recogido.');
  // Si el piloto ya aceptó y va en camino a recoger, cancelar tiene un cargo (una parte es para el piloto)
  const cargo = e.mensajero_id && e.asignacion === 'aceptado' ? redondear(Number(getAjustes().cargo_cancelacion) || 0) : 0;
  if (cargo > 0 && body.aceptar_cargo !== true) {
    return { _status: 409, requiere_cargo: true, cargo, error: `El piloto ya va en camino a recoger. Si cancelas ahora se cobra ${'Q' + cargo.toFixed(2)} en tu próximo envío.` };
  }
  db.exec('BEGIN');
  try {
    cambiarEstado(e.id, 'cancelado', cargo > 0 ? `Cancelado por el cliente con el piloto en camino. Cargo: Q${cargo.toFixed(2)}` : 'Cancelado por el cliente');
    if (cargo > 0) {
      crearCargo(u.id, e.id, 'cancelacion', cargo, 'Cancelación con el piloto en camino');
      const gana = redondear((cargo * (Number(getAjustes().pct_piloto_cancelacion) || 0)) / 100);
      db.prepare("UPDATE envios SET piloto_cerro_en = datetime('now'), ganancia_piloto = ? WHERE id = ?").run(gana, e.id);
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { ok: true, cargo };
});

// ---------- Documentos privados (fotos y PDF) ----------
// Se guardan fuera de la carpeta pública. Cada tipo dice en qué columna va, si acepta PDF y si un cliente lo puede subir.
const DOCUMENTOS = {
  foto:             { col: 'foto_perfil', nombre: 'Foto de la persona', cliente: true },
  dpi_frente:       { col: 'doc_frente', nombre: 'DPI (frente)', cliente: true },
  dpi_reverso:      { col: 'doc_reverso', nombre: 'DPI (reverso)' },
  recibo:           { col: 'doc_recibo', nombre: 'Recibo de luz o agua', pdf: true, renovable: true },
  penales:          { col: 'penales_doc', nombre: 'Antecedentes penales', pdf: true, renovable: true },
  policiacos:       { col: 'policiacos_doc', nombre: 'Antecedentes policiacos', pdf: true, renovable: true },
  licencia_frente:  { col: 'licencia_frente', nombre: 'Licencia (frente)', renovable: true },
  licencia_reverso: { col: 'licencia_reverso', nombre: 'Licencia (reverso)', renovable: true },
  tarjeta:          { col: 'veh_tarjeta', nombre: 'Tarjeta de circulación' },
  veh_frente:       { col: 'veh_foto_frente', nombre: 'Vehículo (frente)' },
  veh_lado:         { col: 'veh_foto_lado', nombre: 'Vehículo (lado)' },
  veh_placa:        { col: 'veh_foto_placa', nombre: 'Placa del vehículo' },
  carta:            { col: 'veh_carta', nombre: 'Carta del dueño del vehículo', pdf: true },
};
const FIRMAS = { jpg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47], webp: [0x52, 0x49, 0x46, 0x46], pdf: [0x25, 0x50, 0x44, 0x46] };

function guardarDocumento(usuarioId, tipo, dataUrl) {
  const d = DOCUMENTOS[tipo];
  if (!d) falla(400, 'Tipo de documento no válido.');
  const m = /^data:(image\/(jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) falla(400, d.pdf ? 'Sube una foto (JPG o PNG) o un PDF.' : 'Sube una foto en formato JPG o PNG.');
  const esPdf = m[1] === 'application/pdf';
  if (esPdf && !d.pdf) falla(400, `${d.nombre}: tiene que ser una foto.`);
  const datos = Buffer.from(m[3], 'base64');
  if (datos.length < 1500) falla(400, 'El archivo está vacío o es demasiado pequeño.');
  if (datos.length > 700_000) falla(413, 'El archivo es demasiado grande (máximo 700 KB).');
  const ext = esPdf ? 'pdf' : (m[2] === 'jpeg' ? 'jpg' : m[2]);
  if (!FIRMAS[ext].every((b, i) => datos[i] === b)) falla(400, 'El archivo no es válido.');
  const anterior = db.prepare(`SELECT ${d.col} AS a FROM usuarios WHERE id = ?`).get(usuarioId)?.a;
  fs.mkdirSync(DOCS_DIR, { recursive: true, mode: 0o750 });
  const nombre = `${usuarioId}-${tipo}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(DOCS_DIR, nombre), datos, { mode: 0o640 });
  db.prepare(`UPDATE usuarios SET ${d.col} = ? WHERE id = ?`).run(nombre, usuarioId);
  if (anterior) fs.rm(path.join(DOCS_DIR, path.basename(anterior)), () => {});
}

function enviarDocumento(res, usuarioId, tipo) {
  const d = DOCUMENTOS[tipo];
  const fila = d && db.prepare(`SELECT ${d.col} AS a FROM usuarios WHERE id = ?`).get(usuarioId);
  if (!fila || !fila.a) falla(404, 'No hay archivo.');
  const archivo = path.join(DOCS_DIR, path.basename(fila.a));
  let datos;
  try { datos = fs.readFileSync(archivo); } catch { falla(404, 'No hay archivo.'); }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream', 'Content-Length': datos.length,
    'Cache-Control': 'private, no-store', 'Content-Security-Policy': 'sandbox', ...CABECERAS_SEGURIDAD });
  res.end(datos);
  return { _enviado: true };
}

function borrarDocumentos(usuarioId) {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(usuarioId);
  if (!u) return;
  for (const d of Object.values(DOCUMENTOS)) {
    if (u[d.col]) fs.rm(path.join(DOCS_DIR, path.basename(u[d.col])), () => {});
    db.prepare(`UPDATE usuarios SET ${d.col} = NULL WHERE id = ?`).run(usuarioId);
  }
}
const docsDe = (u) => Object.fromEntries(Object.entries(DOCUMENTOS).map(([k, d]) => [k, !!u[d.col]]));

// ---------- Fechas ----------
const fechaMs = (t) => new Date(String(t).replace(' ', 'T') + (String(t).length > 10 ? 'Z' : 'T00:00:00Z')).getTime();
const hoyGT = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);   // fecha de hoy en Guatemala
function sumarDias(fecha, dias) { const d = new Date(fecha + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10); }
function sumarMeses(fecha, meses) { const d = new Date(fecha + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + meses); return d.toISOString().slice(0, 10); }
function fechaCampo(v, nombre, { pasada, futura } = {}) {
  const t = texto(v, 10);
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t + 'T00:00:00Z'))) falla(400, `Revisa la fecha: ${nombre}.`);
  if (pasada && t > hoyGT()) falla(400, `${nombre}: la fecha no puede ser en el futuro.`);
  if (futura === false && t < '1990-01-01') falla(400, `Revisa la fecha: ${nombre}.`);
  return t;
}

// ---------- Pilotos ----------
const ESTADOS_PILOTO = { en_revision: 'En revisión', aprobado: 'Aprobado', suspendido: 'Suspendido', baja: 'Dado de baja' };
const TIPOS_LICENCIA = ['A', 'B', 'C', 'M'];
const EQUIPO = { casco: 'Casco', chaleco: 'Chaleco', caja: 'Caja o mochila', uniforme: 'Uniforme' };
const SESION_PILOTO_HORAS = 16;
const RUTA_PILOTO = '/modomensajero';
const MIN_UBIC_VIVA = 3;   // minutos sin recibir ubicación para considerar al piloto desconectado

// Lee del formulario solo los campos que vienen y los valida
function leerDatosPiloto(body, idPropio, permitidos) {
  const out = {};
  const hay = (k) => body[k] !== undefined && (!permitidos || permitidos.includes(k));
  if (hay('nombre')) { out.nombre = texto(body.nombre, 100); if (out.nombre.length < 5) falla(400, 'Escribe el nombre completo.'); }
  if (hay('telefono')) { out.telefono = texto(body.telefono, 30); if (out.telefono.replace(/\D/g, '').length < 8) falla(400, 'Escribe un teléfono de 8 dígitos.'); }
  if (hay('fecha_nacimiento')) out.fecha_nacimiento = body.fecha_nacimiento ? validarNacimiento(body.fecha_nacimiento) : null;
  if (hay('dpi')) out.dpi = body.dpi ? validarDpi(body.dpi, idPropio) : null;
  if (hay('direccion')) out.direccion = texto(body.direccion, 300) || null;
  if (hay('emergencia_nombre')) out.emergencia_nombre = texto(body.emergencia_nombre, 100) || null;
  if (hay('emergencia_parentesco')) out.emergencia_parentesco = texto(body.emergencia_parentesco, 50) || null;
  if (hay('emergencia_telefono')) {
    out.emergencia_telefono = texto(body.emergencia_telefono, 30) || null;
    if (out.emergencia_telefono && out.emergencia_telefono.replace(/\D/g, '').length < 8) falla(400, 'El teléfono de emergencia debe tener 8 dígitos.');
  }
  if (hay('nit')) out.nit = texto(body.nit, 20).toUpperCase().replace(/\s/g, '') || null;
  if (hay('referencias')) out.referencias = texto(body.referencias, 800) || null;
  if (hay('penales_fecha')) out.penales_fecha = fechaCampo(body.penales_fecha, 'emisión de antecedentes penales', { pasada: true });
  if (hay('policiacos_fecha')) out.policiacos_fecha = fechaCampo(body.policiacos_fecha, 'emisión de antecedentes policiacos', { pasada: true });
  if (hay('licencia_numero')) out.licencia_numero = texto(body.licencia_numero, 30).replace(/\s/g, '') || null;
  if (hay('licencia_tipo')) {
    out.licencia_tipo = texto(body.licencia_tipo, 2).toUpperCase() || null;
    if (out.licencia_tipo && !TIPOS_LICENCIA.includes(out.licencia_tipo)) falla(400, 'Tipo de licencia no válido.');
  }
  if (hay('licencia_vence')) out.licencia_vence = fechaCampo(body.licencia_vence, 'vencimiento de la licencia');
  if (hay('vehiculo_id')) {
    const v = numero(body.vehiculo_id);
    if (body.vehiculo_id !== '' && body.vehiculo_id != null && !db.prepare('SELECT 1 FROM vehiculos WHERE id = ?').get(v)) falla(400, 'Elige el tipo de vehículo.');
    out.vehiculo_id = Number.isFinite(v) ? v : null;
  }
  if (hay('veh_placa')) {
    out.veh_placa = texto(body.veh_placa, 12).toUpperCase().replace(/\s/g, '') || null;
    if (out.veh_placa && !/^[A-Z]{1,3}-?[0-9A-Z]{3,8}$/.test(out.veh_placa)) falla(400, 'Revisa el número de placa. Ejemplo: M-123ABC o P-123ABC.');
  }
  if (hay('veh_marca')) out.veh_marca = texto(body.veh_marca, 40) || null;
  if (hay('veh_modelo')) out.veh_modelo = texto(body.veh_modelo, 40) || null;
  if (hay('veh_anio')) {
    out.veh_anio = body.veh_anio === '' || body.veh_anio == null ? null : numero(body.veh_anio);
    if (out.veh_anio != null && !(Number.isInteger(out.veh_anio) && out.veh_anio >= 1980 && out.veh_anio <= new Date().getFullYear() + 1)) falla(400, 'Revisa el año del vehículo.');
  }
  if (hay('veh_color')) out.veh_color = texto(body.veh_color, 30) || null;
  if (hay('veh_propio')) out.veh_propio = body.veh_propio === true || body.veh_propio === 'si' || body.veh_propio === 1 || body.veh_propio === '1' ? 1 : 0;
  if (hay('seguro_aseguradora')) out.seguro_aseguradora = texto(body.seguro_aseguradora, 60) || null;
  if (hay('seguro_vence')) out.seguro_vence = fechaCampo(body.seguro_vence, 'vencimiento del seguro');
  return out;
}
function guardarCampos(id, datos) {
  const claves = Object.keys(datos);
  if (!claves.length) return;
  db.prepare(`UPDATE usuarios SET ${claves.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...claves.map((k) => datos[k]), id);
}

// Revisa qué le falta al piloto, qué está vencido y qué vence pronto
function revisarPiloto(u) {
  const faltan = [], vencidos = [], porVencer = [], avisos = [];
  const req = [
    [u.foto_perfil, 'Foto del piloto'], [u.fecha_nacimiento, 'Fecha de nacimiento'], [u.dpi, 'Número de DPI'],
    [u.doc_frente, 'Foto del DPI (frente)'], [u.doc_reverso, 'Foto del DPI (reverso)'], [u.direccion, 'Dirección de vivienda'],
    [u.emergencia_nombre && u.emergencia_telefono, 'Contacto de emergencia'],
    [u.penales_doc && u.penales_fecha, 'Antecedentes penales'], [u.policiacos_doc && u.policiacos_fecha, 'Antecedentes policiacos'],
    [u.licencia_numero && u.licencia_tipo && u.licencia_vence, 'Datos de la licencia'], [u.licencia_frente, 'Foto de la licencia (frente)'],
    [u.vehiculo_id, 'Tipo de vehículo'], [u.veh_placa, 'Placa'], [u.veh_marca && u.veh_modelo && u.veh_color, 'Marca, modelo y color del vehículo'],
    [u.veh_tarjeta, 'Foto de la tarjeta de circulación'], [u.veh_foto_frente, 'Foto del vehículo'],
    [u.veh_propio || u.veh_carta, 'Carta del dueño del vehículo'], [u.reglas_aceptadas, 'Aceptar las reglas de Vaelo'],
  ];
  for (const [ok, nombre] of req) if (!ok) faltan.push(nombre);
  const hoy = hoyGT(), en30 = sumarDias(hoy, 30);
  const meses = Number(getAjustes().vigencia_antecedentes) || 6;
  const revisar = (fechaVence, nombre, bloquea) => {
    if (!fechaVence) return;
    if (fechaVence < hoy) (bloquea ? vencidos : avisos).push(`${nombre} vencido (${fechaVence})`);
    else if (fechaVence <= en30) porVencer.push(`${nombre} vence el ${fechaVence}`);
  };
  revisar(u.licencia_vence, 'Licencia', true);
  if (u.penales_fecha) revisar(sumarMeses(u.penales_fecha, meses), 'Antecedentes penales', true);
  if (u.policiacos_fecha) revisar(sumarMeses(u.policiacos_fecha, meses), 'Antecedentes policiacos', true);
  revisar(u.seguro_vence, 'Seguro', false);
  const veh = (u.vehiculo || '').toLowerCase();
  if (u.licencia_tipo && veh.includes('moto') && u.licencia_tipo !== 'M') avisos.push(`Licencia tipo ${u.licencia_tipo}: para moto normalmente se usa la tipo M`);
  if (u.licencia_tipo === 'M' && veh && !veh.includes('moto')) avisos.push(`Licencia tipo M: no es para ${u.vehiculo.toLowerCase()}`);
  return { faltan, vencidos, porVencer, avisos };
}
// Avisa al piloto 15, 7 y 1 día antes de que venza su licencia, antecedentes o seguro, y el día que vence (a la oficina también)
const HITOS_VENCE = [15, 7, 1, 0];
function avisarVencimientos() {
  const hoy = hoyGT();
  const meses = Number(getAjustes().vigencia_antecedentes) || 6;
  const pilotos = db.prepare("SELECT * FROM usuarios WHERE rol = 'mensajero' AND estado_piloto = 'aprobado' AND activo = 1").all();
  const marcar = db.prepare('INSERT OR IGNORE INTO avisos_vencimiento (piloto_id, doc, vence, hito) VALUES (?, ?, ?, ?)');
  let enviados = 0;
  for (const u of pilotos) {
    const docs = [['licencia', 'Tu licencia', u.licencia_vence, true], ['penales', 'Tus antecedentes penales', u.penales_fecha ? sumarMeses(u.penales_fecha, meses) : null, true],
      ['policiacos', 'Tus antecedentes policiacos', u.policiacos_fecha ? sumarMeses(u.policiacos_fecha, meses) : null, true], ['seguro', 'Tu seguro', u.seguro_vence, false]];
    for (const [doc, nombre, vence, bloquea] of docs) {
      if (!vence) continue;
      const dias = Math.round((Date.parse(vence + 'T12:00:00Z') - Date.parse(hoy + 'T12:00:00Z')) / 86400_000);
      const hito = HITOS_VENCE.find((h) => dias <= h && dias >= (h === 0 ? -1 : HITOS_VENCE[HITOS_VENCE.indexOf(h) + 1] + 1));
      if (hito === undefined) continue;
      if (!marcar.run(u.id, doc, vence, hito).changes) continue;   // ya se avisó
      enviados++;
      const cuando = dias <= 0 ? 'venció' : dias === 1 ? 'vence mañana' : `vence en ${dias} días`;
      const consecuencia = bloquea ? (dias <= 0 ? 'No podrás recibir envíos hasta renovarlo.' : 'Si vence, no podrás recibir envíos.') : '';
      avisar(u.id, { titulo: dias <= 0 ? `${nombre.replace('Tu ', '').replace('Tus ', '')} venció` : 'Documento por vencer', cuerpo: `${nombre} ${cuando} (${vence}). Renuévalo en Mi perfil. ${consecuencia}`.trim(),
        url: RUTA_PILOTO, etiqueta: 'vence-' + doc, urgente: dias <= 1 });
      correoA(u.id, `${nombre} ${cuando}`, 'Documento por vencer', [`${nombre} ${cuando} (${vence}).`, `Sube el documento nuevo en Mi perfil del modo mensajero. ${consecuencia}`.trim()], { texto: 'Ir a mi perfil', url: RUTA_PILOTO });
      if (dias <= 0 && bloquea) avisarStaff({ titulo: 'Documento vencido de un piloto', cuerpo: `${u.nombre}: ${nombre.replace('Tu ', '').replace('Tus ', '').toLowerCase()} venció (${vence}).`, url: RUTA_ADMIN, etiqueta: 'vence-' + u.id });
    }
  }
  return enviados;
}
if (require.main === module) setInterval(() => { try { avisarVencimientos(); } catch (err) { console.error('Vencimientos:', err.message); } }, 3600_000).unref();
const enLineaReal = (u) => !!u.en_linea && !!u.ubic_fecha && Date.now() - fechaMs(u.ubic_fecha) < MIN_UBIC_VIVA * 60_000;
// ---------- Renovaciones de licencia y antecedentes por revisar ----------
const CAMPOS_RENOVACION = ['licencia_numero', 'licencia_tipo', 'licencia_vence', 'penales_fecha', 'policiacos_fecha'];
function renovacionDe(u) {
  try { const r = JSON.parse(u.renovacion_pendiente || 'null'); if (r) return { campos: r.campos || {}, docs: r.docs || [], desde: r.desde }; } catch { /* vacío */ }
  return { campos: {}, docs: [] };
}
function guardarRenovacion(u, r) {
  const hay = Object.keys(r.campos).length || r.docs.length;
  const nuevo = hay ? JSON.stringify({ ...r, desde: r.desde || new Date().toISOString().slice(0, 19).replace('T', ' ') }) : null;
  if (nuevo === (u.renovacion_pendiente || null)) return;
  db.prepare('UPDATE usuarios SET renovacion_pendiente = ? WHERE id = ?').run(nuevo, u.id);
  if (hay && !u.renovacion_pendiente) avisarStaff({ titulo: 'Renovación de documentos', cuerpo: `${u.nombre} renovó su licencia o antecedentes. Revisa que coincidan con la foto.`, url: RUTA_ADMIN, etiqueta: 'renov-' + u.id });
}
const politicaAlDia = (u) => (u.politica_piloto_version || 0) >= POLITICA_PILOTO_VERSION;
// Efectivo que el piloto no ha entregado en la sede después del plazo (Tarifas y ajustes > días para liquidar)
function deudaVencida(pilotoId) {
  const dias = Number(getAjustes().dias_liquidar) || 3;
  const r = db.prepare(`SELECT COALESCE(SUM(${SQL_EFECTIVO}), 0) AS monto, MIN(e.piloto_cerro_en) AS desde FROM envios e
    WHERE e.mensajero_id = ? AND e.piloto_cerro_en IS NOT NULL AND e.liquidado_id IS NULL AND ${SQL_EFECTIVO} > 0`).get(pilotoId);
  if (!(r.monto > 0) || fechaMs(r.desde) > Date.now() - dias * 86400_000) return null;
  // Si lo que Vaelo le debe (sus ganancias sin pagar) cubre el efectivo, no hay deuda: puede juntar su pago por semana o quincena
  const debe = db.prepare('SELECT COALESCE(SUM(ganancia_piloto), 0) AS t FROM envios WHERE mensajero_id = ? AND piloto_cerro_en IS NOT NULL AND pago_piloto_id IS NULL').get(pilotoId).t
    - descuentosPiloto(pilotoId).reduce((t, x) => t + x.monto_piloto, 0);
  const neto = redondear(r.monto - debe);
  if (neto <= 0) return null;
  return { monto: neto, desde: r.desde, dias };
}
// Efectivo de Vaelo que el piloto trae en la mano (envíos cobrados y productos de tiendas) y hasta cuándo puede entregarlo.
// Si ya es bastante (Tarifas y ajustes > avisar desde), la alerta sube de nivel según la hora: verde en la mañana,
// naranja en la tarde y roja las últimas 3 horas antes de que cierre Vaelo.
const horaCierre = () => { const h = Math.round(Number(getAjustes().hora_cierre_efectivo)); return h >= 12 && h <= 23 ? h : 22; };
const horaTexto = (h) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'a. m.' : 'p. m.'}`;
function efectivoEnMano(pilotoId, ahora = new Date()) {
  const aj = getAjustes(), dias = Number(aj.dias_liquidar) || 3;
  const r = db.prepare(`SELECT COALESCE(SUM(${SQL_EFECTIVO}), 0) AS monto, COUNT(*) AS envios, MIN(e.piloto_cerro_en) AS desde FROM envios e
    WHERE e.mensajero_id = ? AND e.piloto_cerro_en IS NOT NULL AND e.liquidado_id IS NULL AND ${SQL_EFECTIVO} > 0`).get(pilotoId);
  if (!(r.monto > 0)) return null;
  const limiteMs = fechaMs(r.desde) + dias * 86400_000;
  const tope = Number(aj.efectivo_aviso_monto);
  const mucho = tope > 0 && r.monto >= tope;
  const gt = new Date(ahora.getTime() - 6 * 3600_000), hora = gt.getUTCHours(), cierre = horaCierre();
  const deAyer = new Date(fechaMs(r.desde) - 6 * 3600_000).toISOString().slice(0, 10) < gt.toISOString().slice(0, 10);
  const nivel = !mucho ? null : hora >= cierre - 3 || hora < 5 ? 'rojo' : hora >= 12 || deAyer ? 'naranja' : 'verde';
  return { monto: redondear(r.monto), envios: r.envios, desde: r.desde, dias, limite: new Date(limiteMs - 6 * 3600_000).toISOString().slice(0, 10),
    horas: Math.round((limiteMs - ahora.getTime()) / 3600_000), vencido: !!deudaVencida(pilotoId), mucho, nivel, cierre: horaTexto(cierre),
    sede: aj.sede_direccion || '', sede_lat: Number(aj.sede_lat) || null, sede_lng: Number(aj.sede_lng) || null };
}
// Recordatorios al celular del piloto.
// 1) Por nivel, cuando trae bastante efectivo: verde una vez en la mañana, naranja cada hora y rojo cada 15 minutos, hasta que cierra Vaelo.
// 2) Por plazo: un día antes de que venza y al vencer, una sola vez por cada tanda de efectivo.
const CADA_NIVEL = { verde: 24 * 60, naranja: 60, rojo: 15 };   // minutos entre avisos
function recordarEfectivo(ahora = new Date()) {
  const gt = new Date(ahora.getTime() - 6 * 3600_000), hora = gt.getUTCHours(), hoy = gt.toISOString().slice(0, 10);
  if (hora < 7 || hora >= horaCierre()) return 0;   // de noche y con la sede cerrada no se avisa
  let enviados = 0;
  const pilotos = db.prepare(`SELECT DISTINCT e.mensajero_id AS id FROM envios e WHERE e.mensajero_id IS NOT NULL AND e.piloto_cerro_en IS NOT NULL AND e.liquidado_id IS NULL AND ${SQL_EFECTIVO} > 0`).all();
  for (const { id } of pilotos) {
    const m = efectivoEnMano(id, ahora);
    if (!m) continue;
    const u = db.prepare('SELECT efectivo_aviso, efectivo_nivel, efectivo_nivel_en FROM usuarios WHERE id = ?').get(id);
    const q = `Q${m.monto.toFixed(2)}`, donde = m.sede ? ` (${m.sede})` : '';
    if (m.nivel) {
      const mismo = u.efectivo_nivel === `${hoy}|${m.nivel}`;
      const pasaron = u.efectivo_nivel_en ? (ahora.getTime() - Number(u.efectivo_nivel_en)) / 60_000 : Infinity;
      if (!mismo || pasaron >= CADA_NIVEL[m.nivel] - 0.5) {
        db.prepare('UPDATE usuarios SET efectivo_nivel = ?, efectivo_nivel_en = ? WHERE id = ?').run(`${hoy}|${m.nivel}`, String(ahora.getTime()), id);
        avisar(id, m.nivel === 'rojo' ? { titulo: 'Es hora de entregar el dinero', cuerpo: `Tienes ${q} de Vaelo. Entrégalo en la sede${donde} antes de las ${m.cierre}. Si no, tu cuenta puede ser suspendida y Vaelo puede proceder legalmente.`, url: RUTA_PILOTO, etiqueta: 'efectivo', urgente: true }
          : m.nivel === 'naranja' ? { titulo: 'Aún tienes dinero de Vaelo', cuerpo: `Traes ${q} y es arriesgado llevarlo encima. Vaelo cierra a las ${m.cierre}: pasa a la sede${donde}.`, url: RUTA_PILOTO, etiqueta: 'efectivo', urgente: true }
          : { titulo: 'Tienes dinero de Vaelo', cuerpo: `Traes ${q}. Entrégalo en la sede${donde} por tu seguridad y por las políticas de Vaelo.`, url: RUTA_PILOTO, etiqueta: 'efectivo' });
        if (m.nivel === 'rojo' && !mismo) avisarStaff({ titulo: 'Piloto con efectivo sin entregar', cuerpo: `${nombreUsuario(id)} trae ${q} y faltan menos de 3 horas para cerrar.`, url: RUTA_ADMIN, etiqueta: 'efectivo-' + id });
        enviados++;
      }
    }
    const previos = String(u?.efectivo_aviso || '').startsWith(m.desde + '|') ? u.efectivo_aviso.split('|').slice(1) : [];
    const tipo = m.vencido ? 'vencido' : m.horas <= 24 ? 'manana' : null;
    if (!tipo || previos.includes(tipo)) continue;
    db.prepare('UPDATE usuarios SET efectivo_aviso = ? WHERE id = ?').run([m.desde, ...previos, tipo].join('|'), id);
    if (m.nivel) continue;   // ya recibe los avisos por nivel: no se le duplica
    avisar(id, tipo === 'vencido' ? { titulo: 'Entrega el efectivo de Vaelo', cuerpo: `Tienes ${q} sin entregar y ya pasó el plazo. Pasa a la sede${donde}: hasta entonces no puedes conectarte.`, url: RUTA_PILOTO, etiqueta: 'efectivo', urgente: true }
      : { titulo: 'Mañana vence tu plazo', cuerpo: `Tienes ${q} de Vaelo en efectivo. Entrégalo en la sede${donde} para seguir recibiendo envíos.`, url: RUTA_PILOTO, etiqueta: 'efectivo', urgente: true });
    if (tipo === 'vencido') avisarStaff({ titulo: 'Piloto con efectivo fuera de plazo', cuerpo: `${nombreUsuario(id)} tiene ${q} sin entregar.`, url: RUTA_ADMIN, etiqueta: 'efectivo-' + id });
    enviados++;
  }
  return enviados;
}
if (require.main === module) setInterval(() => { try { recordarEfectivo(); } catch (err) { console.error('Efectivo:', err.message); } }, 300_000).unref();
// Por qué un piloto no puede trabajar (para que el panel diga exactamente qué falta)
function porQueNoTrabaja(u, r = revisarPiloto(u)) {
  if (u.estado_piloto !== 'aprobado') return 'todavía no está aprobado';
  if (!u.activo) return 'su cuenta está bloqueada';
  if (r.vencidos.length) return 'tiene vencido: ' + r.vencidos.join(', ');
  if (!politicaAlDia(u)) return 'no ha aceptado la política de pilotos en su app';
  if (deudaVencida(u.id)) return 'tiene efectivo sin liquidar fuera de plazo';
  return '';
}
const puedeTrabajar = (u, r = revisarPiloto(u)) => u.rol === 'mensajero' && u.estado_piloto === 'aprobado' && !!u.activo && !r.vencidos.length && politicaAlDia(u) && !deudaVencida(u.id);
const SQL_PILOTO = `SELECT u.*, v.nombre AS vehiculo,
    (SELECT ROUND(AVG(x), 1) FROM (SELECT calificacion AS x FROM envios WHERE mensajero_id = u.id AND calificacion IS NOT NULL
      UNION ALL SELECT calif_receptor FROM envios WHERE mensajero_id = u.id AND calif_receptor IS NOT NULL)) AS calificacion,
    ((SELECT COUNT(*) FROM envios WHERE mensajero_id = u.id AND calificacion IS NOT NULL) + (SELECT COUNT(*) FROM envios WHERE mensajero_id = u.id AND calif_receptor IS NOT NULL)) AS calificaciones,
    (SELECT COUNT(*) FROM envios WHERE mensajero_id = u.id AND estado = 'entregado') AS entregados,
    (SELECT COUNT(*) FROM envios WHERE mensajero_id = u.id AND estado IN ${SQL_PILOTO_ACTIVO}) AS activos
  FROM usuarios u LEFT JOIN vehiculos v ON v.id = u.vehiculo_id`;
const pilotoPorId = (id) => db.prepare(`${SQL_PILOTO} WHERE u.id = ? AND u.rol = 'mensajero'`).get(id);

function pilotoSalida(u) {
  const out = {};
  for (const [k, v] of Object.entries(u)) if (k !== 'password_hash' && !Object.values(DOCUMENTOS).some((d) => d.col === k)) out[k] = v;
  let equipo = {};
  try { equipo = JSON.parse(u.equipo || '{}') || {}; } catch { /* vacío */ }
  const r = revisarPiloto(u);
  return { ...out, equipo, docs: docsDe(u), revision: r, puede_trabajar: puedeTrabajar(u, r), en_linea_real: enLineaReal(u),
    politica_al_dia: politicaAlDia(u), deuda: deudaVencida(u.id), efectivo: efectivoEnMano(u.id), renovacion: u.renovacion_pendiente ? renovacionDe(u) : null };
}

// Datos del piloto que ve el cliente (solo cuando ya aceptó su envío)
function pilotoParaCliente(id) {
  const p = pilotoPorId(id);
  if (!p) return null;
  return { nombre: p.nombre, telefono: p.telefono, vehiculo: p.vehiculo, marca: p.veh_marca, modelo: p.veh_modelo, color: p.veh_color,
    placa: p.veh_placa, calificacion: p.calificacion, calificaciones: p.calificaciones, entregados: p.entregados, tiene_foto: !!p.foto_perfil };
}

// ---------- Correo automático (confirmar la cuenta) ----------
// Se envía con Resend (resend.com) por internet normal, porque DigitalOcean bloquea el envío de correo directo.
// Se configura en /etc/vaelo.env con RESEND_API_KEY=... (ver README).
const CORREO_API = process.env.RESEND_API_KEY || '';
const CORREO_DE = process.env.VAELO_CORREO_REMITENTE || 'Vaelo Mensajería <no-responder@vaelomensajeria.com>';
const URL_SITIO = (process.env.VAELO_URL || 'https://vaelomensajeria.com').replace(/\/+$/, '');
const correoActivo = () => !!CORREO_API;

// ---------- Avisos de errores por correo ----------
// Cuando algo falla en el servidor (o en la pantalla de un cliente), Vaelo manda un correo a la administración.
// El mismo error se avisa una vez por hora y como máximo 30 correos al día, para no llenar la bandeja.
const CORREO_ALERTAS = process.env.VAELO_CORREO_ALERTAS || 'vaelomensajeria@gmail.com';
const alertasEnviadas = new Map();
let alertasDia = { dia: '', n: 0 };
function avisarError(origen, err, contexto = {}) {
  try {
    const mensaje = String(err && err.message || err || 'Error desconocido').slice(0, 500);
    const pila = String(err && err.stack || '').split('\n').slice(0, 8).join('\n');
    const firma = origen + '|' + mensaje.slice(0, 120) + '|' + (contexto.ruta || '');
    const ahora = Date.now(), hoy = new Date(ahora - 6 * 3600e3).toISOString().slice(0, 10);
    if (alertasDia.dia !== hoy) alertasDia = { dia: hoy, n: 0 };
    if ((alertasEnviadas.get(firma) || 0) > ahora - 3600e3 || alertasDia.n >= 30) return;
    alertasEnviadas.set(firma, ahora); alertasDia.n++;
    if (alertasEnviadas.size > 500) for (const [k, t] of alertasEnviadas) if (t < ahora - 3600e3) alertasEnviadas.delete(k);
    const filas = Object.entries({ 'Dónde': origen, 'Error': mensaje, ...contexto, 'Hora (Guatemala)': new Date(ahora - 6 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) })
      .filter(([, v]) => v != null && v !== '');
    const plano = filas.map(([k, v]) => `${k}: ${v}`).join('\n') + (pila ? `\n\nDetalle técnico:\n${pila}` : '');
    const html = `<div style="font-family:Arial,sans-serif;max-width:620px;color:#15171c"><h2 style="margin:0 0 12px">Algo falló en Vaelo</h2>
      <table style="border-collapse:collapse">${filas.map(([k, v]) => `<tr><td style="padding:4px 10px 4px 0;color:#5a6072;vertical-align:top">${escaparHtml(k)}</td><td style="padding:4px 0"><strong>${escaparHtml(String(v))}</strong></td></tr>`).join('')}</table>
      ${pila ? `<p style="color:#5a6072;margin-top:16px">Detalle técnico (para arreglarlo):</p><pre style="background:#f1f2f6;padding:10px;border-radius:8px;white-space:pre-wrap;font-size:12px">${escaparHtml(pila)}</pre>` : ''}
      <p style="color:#5a6072;font-size:13px">Copia este correo en tu chat con Claude para arreglarlo.</p></div>`;
    enviarCorreo(CORREO_ALERTAS, `Vaelo: falló algo en ${origen}`, html, plano).catch(() => {});
  } catch { /* el aviso nunca debe tumbar el servidor */ }
}
process.on('unhandledRejection', (err) => { console.error('Promesa sin atrapar:', err); avisarError('servidor (tarea en segundo plano)', err); });
process.on('uncaughtException', (err) => {
  console.error('Error sin atrapar:', err); avisarError('servidor (se reinició)', err);
  setTimeout(() => process.exit(1), 2000);   // el servicio vuelve a arrancar solo
});
async function enviarCorreo(para, asunto, html, plano) {
  if (!CORREO_API) { console.log(`[correo sin configurar] Para ${para}: ${asunto}\n${plano}`); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${CORREO_API}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: CORREO_DE, to: [para], subject: asunto, html, text: plano }),
    });
    if (!r.ok) { console.error('No se pudo enviar el correo:', r.status, await r.text()); return false; }
    return true;
  } catch (err) { console.error('No se pudo enviar el correo:', err.message); return false; }
}
const escaparHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function enviarConfirmacion(usuario) {
  const token = crypto.randomBytes(32).toString('hex');
  // Los enlaces de correos anteriores siguen sirviendo hasta que vencen: así no falla si el cliente abre un correo viejo
  db.prepare('DELETE FROM tokens_correo WHERE usuario_id = ? AND expira < ?').run(usuario.id, Date.now());
  db.prepare('INSERT INTO tokens_correo (token, usuario_id, expira) VALUES (?, ?, ?)').run(token, usuario.id, Date.now() + 48 * 3600_000);
  const enlace = `${URL_SITIO}/confirmar-correo?t=${token}`;
  const nombre = escaparHtml(usuario.nombre.split(' ')[0]);
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#15171c">
    <div style="background:#0e2463;padding:20px 24px;border-radius:10px 10px 0 0"><img src="${URL_SITIO}/img/logo-blanco.png" alt="Vaelo" height="32"></div>
    <div style="border:1px solid #d9dce5;border-top:0;padding:24px;border-radius:0 0 10px 10px">
      <h2 style="margin:0 0 12px">Confirma tu correo, ${nombre}</h2>
      <p>Gracias por crear tu cuenta en Vaelo Mensajería. Toca el botón para confirmar que este correo es tuyo.</p>
      <p style="margin:24px 0"><a href="${enlace}" style="background:#1c3faa;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Confirmar mi correo</a></p>
      <p style="color:#5a6072;font-size:13px">El enlace vence en 48 horas. Si no creaste esta cuenta, ignora este mensaje.</p>
    </div></div>`;
  return enviarCorreo(usuario.email, 'Confirma tu correo en Vaelo', html,
    `Hola ${usuario.nombre.split(' ')[0]}, confirma tu correo en Vaelo abriendo este enlace: ${enlace} (vence en 48 horas).`);
}

// ---------- Revisión de identidad del cliente ----------
// Al tener DPI, foto del DPI, foto de la persona y dirección, pasa a "por revisar" para que la administración compare los datos
function actualizarVerificacionCliente(id) {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  if (!u || u.rol !== 'cliente') return;
  const completo = u.dpi && u.doc_frente && u.foto_perfil && u.direccion;
  if (completo && ['sin_datos', 'rechazado'].includes(u.verificacion)) db.prepare("UPDATE usuarios SET verificacion = 'por_revisar' WHERE id = ?").run(id);
  if (!completo && u.verificacion === 'por_revisar') db.prepare("UPDATE usuarios SET verificacion = 'sin_datos' WHERE id = ?").run(id);
}
// Promedio de las calificaciones que los pilotos le dieron al cliente
const califCliente = (id) => db.prepare('SELECT ROUND(AVG(calif_cliente), 1) AS calif_cliente, COUNT(calif_cliente) AS calif_cliente_n FROM envios WHERE usuario_id = ?').get(id);
function datosCliente(u) {
  return { id: u.id, nombre: u.nombre, email: u.email, telefono: u.telefono, dpi: u.dpi, direccion: u.direccion,
    email_verificado: !!u.email_verificado, verificacion: u.verificacion, verificacion_nota: u.verificacion_nota,
    tiene_foto: !!u.foto_perfil, tiene_dpi_frente: !!u.doc_frente, creado: u.creado, activo: !!u.activo,
    tipo_cuenta: u.tipo_cuenta, empresa_nombre: u.empresa_nombre, descuento_empresa: u.descuento_empresa, credito_permitido: !!u.credito_permitido,
    recogida_dias: u.recogida_dias || '', recogida_hora: u.recogida_hora || '', fact_nit: u.fact_nit || '', fact_nombre: u.fact_nombre || '', fact_direccion: u.fact_direccion || '' };
}

// ---------- GPS: estados automáticos según por dónde va el piloto ----------
const ultimoRegistroGps = new Map();
function registrarUbicacion(piloto, c, precision, forzar = false) {
  db.prepare("UPDATE usuarios SET ubic_lat = ?, ubic_lng = ?, ubic_fecha = datetime('now') WHERE id = ?").run(c.lat, c.lng, piloto.id);
  const activo = db.prepare(`SELECT id FROM envios WHERE mensajero_id = ? AND asignacion = 'aceptado' AND estado IN ${SQL_PILOTO_ACTIVO} ORDER BY id LIMIT 1`).get(piloto.id);
  // Recorrido guardado: como máximo un punto cada 10 segundos
  if ((activo || piloto.en_linea) && (forzar || Date.now() - (ultimoRegistroGps.get(piloto.id) || 0) > 10_000)) {
    ultimoRegistroGps.set(piloto.id, Date.now());
    db.prepare('INSERT INTO ubicaciones (usuario_id, envio_id, lat, lng, precision_m) VALUES (?, ?, ?, ?, ?)')
      .run(piloto.id, activo ? activo.id : null, c.lat, c.lng, Number.isFinite(precision) ? Math.round(precision) : null);
  }
  if (!(precision > 200)) automatizarEnvios(piloto.id, c);   // con una lectura muy imprecisa no se cambia nada
}
// Avisos para que el piloto escanee los paquetes de la tienda (una vez por ruta y por momento)
const avisosEscanear = new Set();
function avisoEscanear(pilotoId, grupo, momento) {
  const k = `${pilotoId}|${grupo}|${momento}`;
  if (avisosEscanear.has(k)) return false;
  avisosEscanear.add(k);
  if (avisosEscanear.size > 5000) avisosEscanear.clear();
  avisar(pilotoId, momento === 'llego'
    ? { titulo: 'Escanea antes de salir', cuerpo: 'Escanea cada paquete de la ruta antes de irte. Si olvidas uno, puedes perderlo y se descuenta de tu saldo.', url: RUTA_PILOTO, etiqueta: 'escanear-' + grupo }
    : { titulo: 'Saliste sin escanear los paquetes', cuerpo: 'Regresa o escanéalos ahora. Un paquete perdido se descuenta de tu saldo.', url: RUTA_PILOTO, etiqueta: 'escanear-' + grupo });
  return true;
}
function automatizarEnvios(pilotoId, c) {
  const envios = db.prepare("SELECT * FROM envios WHERE mensajero_id = ? AND asignacion = 'aceptado' AND estado IN ('pendiente','recogido','en_camino')").all(pilotoId);
  for (const e of envios) {
    const o = e.origen_lat != null ? { lat: e.origen_lat, lng: e.origen_lng } : null;
    const d = e.destino_lat != null ? { lat: e.destino_lat, lng: e.destino_lng } : null;
    let estado = e.estado;
    if (estado === 'pendiente' && o) {
      const km = distanciaRecta(c, o);
      const rutaTienda = !!(e.grupo && e.pedido_id);
      if (!e.llego_origen && km <= 0.12) {
        db.prepare('UPDATE envios SET llego_origen = 1 WHERE id = ?').run(e.id);
        db.prepare('INSERT INTO eventos (envio_id, estado, nota, lat, lng) VALUES (?, ?, ?, ?, ?)').run(e.id, 'pendiente', 'El piloto llegó al punto de recogida', c.lat, c.lng);
        if (rutaTienda) avisoEscanear(pilotoId, e.grupo, 'llego');
      } else if (rutaTienda && e.llego_origen && km >= 0.3) {
        // Ruta de tienda: no se da por recogida sola; el piloto tiene que escanear cada paquete
        if (avisoEscanear(pilotoId, e.grupo, 'salio')) db.prepare('INSERT INTO eventos (envio_id, estado, nota, lat, lng) VALUES (?, ?, ?, ?, ?)').run(e.id, 'pendiente', 'El piloto salió del punto de recogida sin escanear los paquetes', c.lat, c.lng);
      } else if (e.llego_origen && km >= 0.3 && receptorListo(e)) {
        cambiarEstado(e.id, 'recogido', 'Paquete recogido (detectado por GPS)', c.lat, c.lng);
        estado = 'recogido';
      }
    }
    if (estado === 'recogido' && (!o || distanciaRecta(c, o) >= 0.3)) {
      cambiarEstado(e.id, 'en_camino', 'Va en camino a entregar (detectado por GPS)', c.lat, c.lng);
      estado = 'en_camino';
    }
    if (estado === 'en_camino' && d && !e.llegando_destino && distanciaRecta(c, d) <= 0.15) {
      db.prepare('UPDATE envios SET llegando_destino = 1 WHERE id = ?').run(e.id);
      db.prepare('INSERT INTO eventos (envio_id, estado, nota, lat, lng) VALUES (?, ?, ?, ?, ?)').run(e.id, 'en_camino', 'El piloto está llegando al destino', c.lat, c.lng);
      avisarEnvio(e.id, 'llegando');
    }
  }
}

function requierePiloto(req) {
  const u = requiereRol(req, 'mensajero');
  const p = pilotoPorId(u.id);
  if (!p || p.estado_piloto === 'baja') falla(403, 'Tu cuenta de piloto no está activa.');
  return p;
}
function requierePilotoTrabajando(req) {
  const p = requierePiloto(req);
  const r = revisarPiloto(p);
  if (p.estado_piloto !== 'aprobado') falla(403, 'Tu cuenta todavía no está aprobada.');
  if (r.vencidos.length) falla(403, `No puedes trabajar: ${r.vencidos.join(', ')}. Renueva el documento en tu perfil.`);
  if (!politicaAlDia(p)) falla(403, 'Antes de trabajar, lee y acepta la política para pilotos de Vaelo.');
  const deuda = deudaVencida(p.id);
  if (deuda) falla(403, `Tienes Q${deuda.monto.toFixed(2)} en efectivo sin entregar desde hace más de ${deuda.dias} días. Pasa a la sede a liquidar para seguir trabajando.`);
  return p;
}
function leerPosicion(body, obligatoria) {
  const c = coordenada(body.lat, body.lng);
  if (!c && obligatoria) falla(400, 'Necesitamos tu ubicación. Activa la ubicación (GPS) del teléfono y permite que Vaelo la use.');
  return c;
}

// ---------- Rutas del piloto (/modomensajero) ----------
ruta('POST', '/api/piloto/registro', ({ req, body }) => {
  if (limitar(ipDe(req), 'registro', 10, 3600_000)) falla(429, 'Demasiados intentos. Espera un momento e inténtalo de nuevo.');
  const email = texto(body.email, 150).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const datos = leerDatosPiloto({ nombre: body.nombre, telefono: body.telefono }, 0);
  if (!datos.nombre || !datos.telefono) falla(400, 'Escribe tu nombre completo y tu teléfono.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) falla(400, 'Escribe un correo válido.');
  if (password.length < 8) falla(400, 'La contraseña debe tener al menos 8 caracteres.');
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) falla(409, 'Ya existe una cuenta con ese correo.');
  const r = db.prepare(`INSERT INTO usuarios (nombre, email, telefono, password_hash, rol, estado_piloto, email_verificado, verificacion)
    VALUES (?, ?, ?, ?, 'mensajero', 'en_revision', 1, 'verificado')`).run(datos.nombre, email, datos.telefono, hashPassword(password));
  return { _status: 201, _headers: { 'Set-Cookie': crearSesion(req, Number(r.lastInsertRowid), SESION_PILOTO_HORAS * 3600) }, ok: true };
});

ruta('POST', '/api/piloto/entrar', ({ req, body }) => {
  const email = texto(body.email, 150).toLowerCase();
  const control = revisarFallos(req, 'piloto', email);
  const password = typeof body.password === 'string' ? body.password : '';
  const u = db.prepare("SELECT * FROM usuarios WHERE email = ? AND rol = 'mensajero'").get(email);
  if (!u || !verificarPassword(password, u.password_hash)) { control.fallo(); falla(401, 'Correo o contraseña incorrectos.'); }
  if (u.estado_piloto === 'baja' || !u.activo) falla(403, 'Esta cuenta ya no está activa. Comunícate con Vaelo.');
  control.exito();
  return { _headers: { 'Set-Cookie': crearSesion(req, u.id, SESION_PILOTO_HORAS * 3600) }, ok: true };
});

ruta('GET', '/api/piloto/yo', ({ req }) => {
  const p = requierePiloto(req);
  return { piloto: pilotoSalida(p), vehiculos: db.prepare('SELECT id, nombre FROM vehiculos WHERE activo = 1 ORDER BY orden, id').all(),
    estados: ESTADOS_PILOTO, vigencia_antecedentes: Number(getAjustes().vigencia_antecedentes) || 6 };
});

// Mientras está en revisión puede llenar todo; ya aprobado solo actualiza contacto y renovaciones (lo demás lo cambia la administración)
const CAMPOS_PILOTO_APROBADO = ['telefono', 'direccion', 'emergencia_nombre', 'emergencia_parentesco', 'emergencia_telefono', 'nit',
  'penales_fecha', 'policiacos_fecha', 'licencia_numero', 'licencia_tipo', 'licencia_vence', 'seguro_aseguradora', 'seguro_vence'];
ruta('PUT', '/api/piloto/perfil', ({ req, body }) => {
  const p = requierePiloto(req);
  const libre = p.estado_piloto === 'en_revision';
  const datos = leerDatosPiloto(body, p.id, libre ? null : CAMPOS_PILOTO_APROBADO);
  // Piloto ya aprobado que renueva licencia o antecedentes: las fechas nuevas quedan por revisar hasta que la oficina
  // confirme que coinciden con la foto. Mientras tanto sigue valiendo lo anterior.
  if (!libre) {
    const pend = renovacionDe(p);
    for (const k of CAMPOS_RENOVACION) if (datos[k] !== undefined) {
      if (String(datos[k] ?? '') !== String(p[k] ?? '')) pend.campos[k] = datos[k]; else delete pend.campos[k];
      delete datos[k];
    }
    guardarRenovacion(p, pend);
  }
  if (body.acepto_reglas === true && !p.reglas_aceptadas) datos.reglas_aceptadas = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (body.acepto_politica === true) { datos.politica_piloto = new Date().toISOString().slice(0, 19).replace('T', ' '); datos.politica_piloto_version = POLITICA_PILOTO_VERSION; }
  guardarCampos(p.id, datos);
  return { ok: true, piloto: pilotoSalida(pilotoPorId(p.id)) };
});

ruta('POST', '/api/piloto/documento', ({ req, body }) => {
  const p = requierePiloto(req);
  const d = DOCUMENTOS[body.tipo];
  if (!d) falla(400, 'Tipo de documento no válido.');
  if (p.estado_piloto !== 'en_revision' && !d.renovable) falla(403, 'Este documento solo lo puede cambiar la administración de Vaelo.');
  guardarDocumento(p.id, body.tipo, body.archivo);
  if (p.estado_piloto !== 'en_revision') { const pend = renovacionDe(p); if (!pend.docs.includes(body.tipo)) pend.docs.push(body.tipo); guardarRenovacion(p, pend); }
  return { ok: true };
}, { limite: 1_000_000 });

ruta('GET', '/api/piloto/documento/:tipo', ({ req, res, params }) => enviarDocumento(res, requierePiloto(req).id, params.tipo));

ruta('POST', '/api/piloto/en-linea', ({ req, body }) => {
  if (body.en_linea) {
    const p = requierePilotoTrabajando(req);
    const c = leerPosicion(body, true);
    db.prepare('UPDATE usuarios SET en_linea = 1 WHERE id = ?').run(p.id);
    registrarUbicacion({ ...p, en_linea: 1 }, c, numero(body.precision));
    return { ok: true, en_linea: true };
  }
  const p = requierePiloto(req);
  const activos = db.prepare(`SELECT COUNT(*) AS n FROM envios WHERE mensajero_id = ? AND asignacion = 'aceptado' AND estado IN ${SQL_PILOTO_ACTIVO}`).get(p.id).n;
  if (activos) falla(400, 'Tienes entregas en curso. Termínalas antes de desconectarte: tu ubicación debe seguir activa.');
  // Con bastante efectivo de Vaelo encima no termina el día sin más: solo puede dejar de recibir envíos para ir a la sede
  const ef = efectivoEnMano(p.id);
  if (ef && ef.nivel && body.voy_a_sede !== true) falla(409, `Tienes Q${ef.monto.toFixed(2)} de Vaelo en efectivo. Antes de terminar tu día entrégalo en la sede.`);
  db.prepare('UPDATE usuarios SET en_linea = 0 WHERE id = ?').run(p.id);
  return { ok: true, en_linea: false };
});

ruta('POST', '/api/piloto/ubicacion', ({ req, body }) => {
  const p = requierePiloto(req);
  const c = leerPosicion(body, true);
  registrarUbicacion(p, c, numero(body.precision));
  return { ok: true };
});

// Ver ruta antes de aceptar: piloto → recoger → entregar (o todas las paradas de una ruta de empresa), por calles
const cacheTrazos = new Map();
async function trazarRuta(puntos) {
  const coords = puntos.map((x) => `${x.lng.toFixed(5)},${x.lat.toFixed(5)}`).join(';');
  if (cacheTrazos.has(coords)) return cacheTrazos.get(coords);
  const leer = (r) => r && r.routes && r.routes[0] ? { linea: r.routes[0].geometry.coordinates.map(([ln, la]) => [la, ln]),
    tramos: r.routes[0].legs.map((l) => ({ km: Math.round(l.distance / 100) / 10, min: Math.max(1, Math.round(l.duration / 60)) })) } : null;
  let out = null, fuente = 'calle';
  const token = getAjustes().mapbox_token || process.env.MAPBOX_TOKEN || '';
  if (token && puntos.length <= 25) {
    try {
      const r = await fetch(`https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}?geometries=geojson&overview=full&language=es&access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(7000) });
      out = leer(await r.json());
    } catch { /* se intenta con OSRM */ }
  }
  if (!out && OSRM_URL) {
    try {
      const r = await fetch(`${OSRM_URL}/route/v1/driving/${coords}?geometries=geojson&overview=full`, { signal: AbortSignal.timeout(7000), headers: { 'User-Agent': 'Vaelo-Mensajeria/1.0' } });
      const j = await r.json(); if (j.code === 'Ok') out = leer(j);
    } catch { /* línea recta */ }
  }
  if (!out) {
    fuente = 'estimado';
    out = { linea: puntos.map((x) => [x.lat, x.lng]), tramos: puntos.slice(1).map((x, i) => { const km = Math.round(distanciaRecta(puntos[i], x) * 1.4 * 10) / 10; return { km, min: Math.max(1, Math.round(km * 3)) }; }) };
  }
  out = { ...out, fuente };
  if (cacheTrazos.size > 500) cacheTrazos.clear();
  cacheTrazos.set(coords, out);
  return out;
}
ruta('GET', '/api/piloto/envios/:id/ruta', async ({ req, params, query }) => {
  const p = requierePiloto(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND mensajero_id = ?').get(Number(params.id), p.id);
  if (!e) falla(404, 'Ese envío ya no está asignado a ti.');
  const paradas = [];
  const yo = coordenada(query.get('lat'), query.get('lng'));
  if (yo) paradas.push({ tipo: 'yo', etiqueta: 'Tú', lat: yo.lat, lng: yo.lng });
  const lista = e.grupo ? db.prepare("SELECT * FROM envios WHERE grupo = ? AND mensajero_id = ? AND estado IN ('pendiente','recogido','en_camino') ORDER BY COALESCE(parada, 999), id").all(e.grupo, p.id) : [e];
  const recoger = lista.find((x) => x.estado === 'pendiente' && x.origen_lat != null);
  if (recoger) paradas.push({ tipo: 'recoger', etiqueta: 'A', nombre: 'Recoger', zona: recoger.origen_zona, lat: recoger.origen_lat, lng: recoger.origen_lng });
  const sinUbicacion = [];
  lista.forEach((x, i) => {
    const n = lista.length > 1 ? String(x.parada || i + 1) : 'B';
    if (x.destino_lat != null) paradas.push({ tipo: 'entregar', etiqueta: n, nombre: lista.length > 1 ? `Entrega ${n}` : 'Entregar', zona: x.destino_zona, lat: x.destino_lat, lng: x.destino_lng });
    else sinUbicacion.push(`${lista.length > 1 ? 'Entrega ' + n : 'Entrega'} en ${x.destino_zona}: todavía sin ubicación exacta`);
  });
  if (paradas.length < 2) return { paradas, tramos: [], linea: paradas.map((x) => [x.lat, x.lng]), sin_ubicacion: sinUbicacion, fuente: 'estimado' };
  const t = await trazarRuta(paradas.slice(0, 25));
  return { paradas, ...t, sin_ubicacion: sinUbicacion };
});

ruta('GET', '/api/piloto/envios', ({ req }) => {
  const p = requierePiloto(req);
  const filas = db.prepare(`${SQL_ENVIO} WHERE e.mensajero_id = ?
    AND (e.estado IN ${SQL_PILOTO_ACTIVO} OR (e.piloto_cerro_en IS NOT NULL AND e.piloto_cerro_en >= datetime('now','-1 day'))
      OR (e.estado = 'entregado' AND e.devolver_cobro = 1 AND e.cobro_devuelto_en IS NULL AND e.cobro_destinatario > 0 AND e.sede_llegada IS NULL))
    ORDER BY CASE WHEN e.asignacion = 'por_aceptar' THEN 0 WHEN e.estado IN ('fallido','devolviendo','a_sede') THEN 1 WHEN e.estado = 'en_camino' THEN 2 WHEN e.estado = 'recogido' THEN 3 WHEN e.estado = 'pendiente' THEN 4 ELSE 5 END, e.id`).all(p.id);
  return { envios: filas.map((e) => {
    const out = envioSalida(e);
    const extra = infoExtra(e);
    if (extra.fallo) out.fallo = extra.fallo;
    if (e.estado === 'a_sede') { const sede = sedeUbicacion(); out.sede = { lat: sede?.lat ?? null, lng: sede?.lng ?? null, direccion: getAjustes().sede_direccion || '' }; }
    out.ya_califique_cliente = !!e.calif_cliente;
    out.tiene_foto_paquete = !!e.foto_paquete;
    if (extra.paquetes_extra) { out.paquetes_extra = extra.paquetes_extra; out.peso_paquete1 = extra.peso_paquete1; }
    out.flete_pendiente = !!e.flete && !e.flete_configurado_en;
    if (e.flete && e.ayudantes) out.ayudantes = e.ayudantes;
    if (e.pedido_id) {
      const ped = db.prepare('SELECT id, cliente_nombre FROM pedidos_empresa WHERE id = ?').get(e.pedido_id);
      out.empresa = nombreEmpresa(e.usuario_id);
      out.avisos_cliente = ped ? db.prepare('SELECT COUNT(*) AS n FROM push_pedidos WHERE pedido_id = ?').get(ped.id).n > 0 : false;
      out.cobro_en_recogida = e.cobro_en_recogida;
    }
    for (const k of ['codigo_entrega', 'intentos_codigo', 'foto_entrega', 'firma_entrega', 'precio_base', 'descuento', 'promocion_id', 'liquidado_id', 'pago_piloto_id', 'excluidos', ...CAMPOS_INTERNOS]) delete out[k];
    out.ganancia_piloto = e.ganancia_piloto ?? (['pendiente', 'recogido', 'en_camino'].includes(e.estado) ? (e.ganancia_acordada ?? gananciaPiloto(e.precio)) : null);   // en curso: lo que ganaría
    out.grupo_total = e.grupo ? db.prepare('SELECT COUNT(*) AS n FROM envios WHERE grupo = ? AND mensajero_id = ?').get(e.grupo, p.id).n : 1;
    const c = db.prepare('SELECT verificacion, foto_perfil FROM usuarios WHERE id = ?').get(e.usuario_id) || {};
    Object.assign(out, califCliente(e.usuario_id));
    out.cliente_verificado = c.verificacion === 'verificado';
    out.cliente_tiene_foto = !!c.foto_perfil;
    out.receptor = e.asignacion === 'aceptado' ? datosReceptor(e) : { listo: receptorListo(e), confirmado: !!e.receptor_confirmado_en };
    out.origen = e.asignacion === 'aceptado' ? datosOrigen(e) : { confirmado: origenListo(e) };
    return sinCamposReceptor(out);
  }), en_linea: enLineaReal(p) || !!p.en_linea };
});

ruta('POST', '/api/piloto/envios/:id/aceptar', ({ req, params, body }) => {
  const p = requierePilotoTrabajando(req);
  const c = leerPosicion(body, true);
  const e = db.prepare("SELECT * FROM envios WHERE id = ? AND mensajero_id = ? AND asignacion = 'por_aceptar'").get(Number(params.id), p.id);
  if (!e) falla(404, 'Este envío ya no está esperando tu respuesta.');
  if (e.estado === 'cancelado') falla(400, 'El cliente canceló este envío.');
  if (!listoParaPiloto(e)) falla(400, motivoNoListo(e));
  // Varias entregas en un solo viaje: se aceptan todas las del grupo
  const lista = e.grupo ? db.prepare("SELECT * FROM envios WHERE grupo = ? AND mensajero_id = ? AND asignacion = 'por_aceptar' AND estado = 'pendiente'").all(e.grupo, p.id) : [e];
  for (const x of lista) {
    db.prepare("UPDATE envios SET asignacion = 'aceptado', actualizado = datetime('now') WHERE id = ?").run(x.id);
    db.prepare('INSERT INTO eventos (envio_id, estado, nota, lat, lng) VALUES (?, ?, ?, ?, ?)')
      .run(x.id, x.estado, `${p.nombre.split(' ')[0]} aceptó el envío y va hacia la recogida`, c.lat, c.lng);
    avisarEnvio(x.id, 'aceptado');
  }
  db.prepare('UPDATE usuarios SET en_linea = 1 WHERE id = ?').run(p.id);
  registrarUbicacion({ ...p, en_linea: 1 }, c, numero(body.precision), true);
  return { ok: true, aceptados: lista.length };
});

ruta('POST', '/api/piloto/envios/:id/rechazar', ({ req, params, body }) => {
  const p = requierePiloto(req);
  const e = db.prepare("SELECT * FROM envios WHERE id = ? AND mensajero_id = ? AND asignacion = 'por_aceptar'").get(Number(params.id), p.id);
  if (!e) falla(404, 'Este envío ya no está esperando tu respuesta.');
  const motivo = texto(body.motivo, 200);
  const lista = e.grupo ? db.prepare("SELECT * FROM envios WHERE grupo = ? AND mensajero_id = ? AND asignacion = 'por_aceptar'").all(e.grupo, p.id) : [e];
  for (const x of lista) {
    // No se le vuelve a ofrecer a este piloto en la asignación automática
    let fuera = []; try { fuera = JSON.parse(x.excluidos || '[]'); } catch { /* vacío */ }
    db.prepare("UPDATE envios SET mensajero_id = NULL, asignacion = NULL, rechazado_en = datetime('now'), excluidos = ? WHERE id = ?").run(JSON.stringify([...new Set([...fuera, p.id])]), x.id);
    db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(x.id, x.estado, `${p.nombre.split(' ')[0]} no aceptó el envío${motivo ? ': ' + motivo : ''}. Buscando otro piloto`);
  }
  return { ok: true };
});

ruta('POST', '/api/piloto/envios/:id/estado', ({ req, params, body }) => {
  const p = requierePiloto(req);
  const e = db.prepare("SELECT * FROM envios WHERE id = ? AND mensajero_id = ? AND asignacion = 'aceptado'").get(Number(params.id), p.id);
  if (!e) falla(404, 'Este envío no está asignado a ti.');
  const estado = texto(body.estado, 20);
  if (!ESTADOS_MENSAJERO.includes(estado)) falla(400, 'Estado no válido.');
  if (!ESTADOS_PILOTO_ACTIVO.includes(e.estado)) falla(400, 'Este envío ya está cerrado.');
  const c = leerPosicion(body, true);
  let nota = texto(body.nota, 300);
  // Devolución y sede: solo después de la decisión del cliente
  if (estado === 'devuelto' || estado === 'en_sede') {
    if (estado === 'devuelto' && e.estado !== 'devolviendo') falla(400, 'Este paquete no está en devolución.');
    if (estado === 'en_sede' && e.estado !== 'a_sede') falla(400, 'Este paquete no va para la sede.');
    const destinoVuelta = estado === 'devuelto' ? (e.origen_lat != null ? { lat: e.origen_lat, lng: e.origen_lng } : null) : sedeUbicacion();
    if (destinoVuelta) {
      const km = distanciaRecta(c, destinoVuelta);
      if (km > 0.5) falla(400, `Estás a ${km.toFixed(1)} km ${estado === 'devuelto' ? 'del punto de recogida' : 'de la sede'}. Márcalo cuando estés en el lugar.`);
    }
    if (estado === 'devuelto') {
      const recibio = texto(body.recibio, 100);
      if (recibio.length < 2) falla(400, 'Escribe el nombre de quien recibió el paquete de vuelta.');
      guardarArchivoEnvio(e.id, 'foto', body.foto);
      db.prepare("UPDATE envios SET devuelto_en = datetime('now'), devuelto_a = ? WHERE id = ?").run(recibio, e.id);
      nota = `Devuelto a ${recibio}${nota ? '. ' + nota : ''}`;
    } else {
      db.prepare("UPDATE envios SET sede_llegada = datetime('now') WHERE id = ?").run(e.id);
      nota = `Paquete guardado en la sede${nota ? '. ' + nota : ''}`;
    }
    registrarUbicacion(p, c, numero(body.precision), true);
    cambiarEstado(e.id, estado, nota, c.lat, c.lng);
    return { ok: true };
  }
  if (!['pendiente', 'recogido', 'en_camino'].includes(e.estado)) falla(400, 'Este envío está en devolución o va para la sede.');
  if (e.estado === 'pendiente' && !receptorListo(e)) falla(403, 'No recojas el paquete todavía: falta que quien entrega o quien recibe comparta su ubicación. Espera unos minutos o llama a la administración.');
  if (estado === 'entregado') {
    if (e.destino_lat != null) {
      const km = distanciaRecta(c, { lat: e.destino_lat, lng: e.destino_lng });
      if (km > 0.5) falla(400, `Estás a ${km.toFixed(1)} km del punto de entrega. Márcalo como entregado cuando estés en el lugar. Si el punto del mapa está mal, avisa a la administración.`);
    }
    // Código de 4 números que el cliente le dio a quien recibe
    if (e.codigo_entrega) {
      if (e.intentos_codigo >= 5) falla(403, 'Se bloqueó la entrega por demasiados códigos equivocados. Llama a la administración.');
      if (String(body.codigo || '').replace(/\D/g, '') !== e.codigo_entrega) {
        db.prepare('UPDATE envios SET intentos_codigo = intentos_codigo + 1 WHERE id = ?').run(e.id);
        const quedan = 4 - e.intentos_codigo;
        falla(400, quedan > 0 ? `Código de entrega incorrecto. Te quedan ${quedan} intentos. Pídelo a quien recibe.` : 'Código incorrecto. Se bloqueó la entrega: llama a la administración.');
      }
    }
    const recibio = texto(body.recibio, 100);
    if (recibio.length < 2) falla(400, 'Escribe el nombre de quien recibió el paquete.');
    guardarArchivoEnvio(e.id, 'foto', body.foto);
    if (body.firma) guardarArchivoEnvio(e.id, 'firma', body.firma);
    db.prepare('UPDATE envios SET recibio = ? WHERE id = ?').run(recibio, e.id);
    nota = `Recibió: ${recibio}${nota ? '. ' + nota : ''}`;
  }
  if (estado === 'entregado' && e.estado === 'pendiente') cambiarEstado(e.id, 'recogido', 'Paquete recogido', c.lat, c.lng);
  // El punto se guarda antes de cerrar el envío, para que quede en su recorrido
  registrarUbicacion(p, c, numero(body.precision), true);
  cambiarEstado(e.id, estado, nota, c.lat, c.lng);
  return { ok: true };
}, { limite: 1_500_000 });

// El piloto no pudo entregar: queda "fallido" y el cliente elige devolver o guardar en la sede
const MOTIVOS_FALLO = { no_contesta: 'Quien recibe no contesta', no_esta: 'No había nadie en el lugar', direccion: 'Dirección o ubicación incorrecta',
  rechazo: 'Quien recibe no aceptó el paquete', sin_cobro: 'Quien recibe no pagó el cobro', otro: 'Otro motivo' };
ruta('POST', '/api/piloto/envios/:id/no-entregado', ({ req, params, body }) => {
  const p = requierePiloto(req);
  const e = db.prepare("SELECT * FROM envios WHERE id = ? AND mensajero_id = ? AND asignacion = 'aceptado'").get(Number(params.id), p.id);
  if (!e) falla(404, 'Este envío no está asignado a ti.');
  if (!['recogido', 'en_camino'].includes(e.estado)) falla(400, 'Solo puedes reportarlo cuando ya llevas el paquete.');
  const motivo = MOTIVOS_FALLO[body.motivo] ? body.motivo : falla(400, 'Elige por qué no se pudo entregar.');
  const nota = texto(body.nota, 300);
  if (motivo === 'otro' && nota.length < 4) falla(400, 'Explica qué pasó.');
  const c = leerPosicion(body, true);
  if (e.destino_lat != null) {
    const km = distanciaRecta(c, { lat: e.destino_lat, lng: e.destino_lng });
    if (km > 0.5 && motivo !== 'direccion') falla(400, `Estás a ${km.toFixed(1)} km del punto de entrega. Repórtalo cuando hayas llegado al lugar.`);
  }
  if (body.foto) guardarArchivoEnvio(e.id, 'fallo', body.foto);
  db.prepare("UPDATE envios SET fallo_motivo = ?, fallo_nota = ?, fallo_en = datetime('now') WHERE id = ?").run(motivo, nota || null, e.id);
  registrarUbicacion(p, c, numero(body.precision), true);
  cambiarEstado(e.id, 'fallido', `No se pudo entregar: ${MOTIVOS_FALLO[motivo]}${nota ? '. ' + nota : ''}`, c.lat, c.lng);
  // Pedido de empresa: no hay devolución, el paquete se guarda en la sede y la empresa lo recoge ahí
  if (e.pedido_id) {
    // El intento lo paga la tienda: el piloto fue y gastó gasolina
    crearCargo(e.usuario_id, e.id, 'intento_fallido', Number(e.precio) || 0, `${e.codigo_corto || e.guia}: ${MOTIVOS_FALLO[motivo].toLowerCase()}`);
    decidirFallido(db.prepare('SELECT * FROM envios WHERE id = ?').get(e.id), 'sede', 'automático (pedido de empresa)');
    return { ok: true, sede: true };
  }
  return { ok: true, horas: horasDecidir() };
}, { limite: 1_500_000 });

// El piloto califica al cliente (después de terminar su parte)
ruta('POST', '/api/piloto/envios/:id/calificar-cliente', ({ req, params, body }) => {
  const p = requierePiloto(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND mensajero_id = ?').get(Number(params.id), p.id);
  if (!e) falla(404, 'Este envío no está asignado a ti.');
  if (!e.piloto_cerro_en) falla(400, 'Puedes calificar al cliente cuando termines el envío.');
  if (e.calif_cliente) falla(400, 'Ya calificaste a este cliente.');
  const estrellas = numero(body.estrellas);
  if (![1, 2, 3, 4, 5].includes(estrellas)) falla(400, 'Elige de 1 a 5 estrellas.');
  db.prepare('UPDATE envios SET calif_cliente = ?, calif_cliente_comentario = ? WHERE id = ?').run(estrellas, texto(body.comentario, 300) || null, e.id);
  return { ok: true };
});

// Lo que gana el piloto: por cobrar, efectivo que debe entregar, totales y pagos anteriores
// El piloto ya le llevó el dinero cobrado a quien mandó el paquete
ruta('POST', '/api/piloto/envios/:id/cobro-devuelto', ({ req, params }) => {
  const p = requierePiloto(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND mensajero_id = ?').get(Number(params.id), p.id) || falla(404, 'No encontramos ese envío.');
  if (e.estado !== 'entregado' || !e.devolver_cobro || !(e.cobro_destinatario > 0) || e.sede_llegada) falla(400, 'Este envío no tiene dinero para llevar al cliente.');
  if (e.cobro_devuelto_en) return { ok: true };
  db.prepare("UPDATE envios SET cobro_devuelto_en = datetime('now'), cobro_pagado_en = COALESCE(cobro_pagado_en, datetime('now')) WHERE id = ?").run(e.id);
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, 'entregado', `El piloto entregó ${qtz(e.cobro_destinatario)} del cobro a quien mandó el paquete`);
  avisar(e.usuario_id, { titulo: 'Te entregaron tu dinero', cuerpo: `El piloto te entregó ${qtz(e.cobro_destinatario)} que cobró por tu envío ${e.guia}.`, url: '/mi-cuenta?envio=' + e.id, etiqueta: 'cobro-' + e.id });
  return { ok: true };
});
ruta('GET', '/api/piloto/ganancias', ({ req }) => {
  const p = requierePiloto(req);
  const suma = (cond) => redondear(db.prepare(`SELECT COALESCE(SUM(e.ganancia_piloto), 0) AS t FROM envios e WHERE e.mensajero_id = ? AND e.piloto_cerro_en IS NOT NULL AND ${cond}`).get(p.id).t);
  const efectivo = db.prepare(`SELECT COALESCE(SUM(${SQL_EFECTIVO}), 0) AS t, COUNT(*) AS n FROM envios e WHERE e.mensajero_id = ? AND e.piloto_cerro_en IS NOT NULL AND e.liquidado_id IS NULL AND ${SQL_EFECTIVO} > 0`).get(p.id);
  const hoy = hoyGT();
  return {
    estrellas: (({ promedio, total, dist, ultimas }) => ({ promedio, total, dist, ultimas: ultimas.slice(0, 8).map(({ guia, ...x }) => x) }))(estrellasPiloto(p.id)),
    por_cobrar: redondear(Math.max(0, suma('e.pago_piloto_id IS NULL') - descuentosPiloto(p.id).reduce((t, x) => t + x.monto_piloto, 0))),
    descuentos: descuentosPiloto(p.id), deuda: deudaVencida(p.id), dias_liquidar: Number(getAjustes().dias_liquidar) || 3,
    efectivo_por_entregar: redondear(efectivo.t), envios_efectivo: efectivo.n,
    hoy: suma(`date(e.piloto_cerro_en, '-6 hours') = '${hoy}'`),
    semana: suma(`date(e.piloto_cerro_en, '-6 hours') >= '${sumarDias(hoy, -6)}'`),
    mes: suma(`strftime('%Y-%m', e.piloto_cerro_en, '-6 hours') = '${hoy.slice(0, 7)}'`),
    entregas_mes: db.prepare(`SELECT COUNT(*) AS n FROM envios e WHERE e.mensajero_id = ? AND e.estado = 'entregado' AND strftime('%Y-%m', e.piloto_cerro_en, '-6 hours') = ?`).get(p.id, hoy.slice(0, 7)).n,
    comision: { tipo: getAjustes().comision_tipo, valor: Number(getAjustes().comision_valor) || 0 },
    ultimas: db.prepare(`SELECT e.id, e.guia, e.estado, e.destino_zona, e.piloto_cerro_en, e.ganancia_piloto, e.metodo_pago, e.pago_piloto_id, ${SQL_EFECTIVO} AS efectivo
      FROM envios e WHERE e.mensajero_id = ? AND e.piloto_cerro_en IS NOT NULL ORDER BY e.piloto_cerro_en DESC LIMIT 40`).all(p.id),
    pagos: db.prepare('SELECT id, monto, envios, nota, creado FROM pagos_piloto WHERE piloto_id = ? ORDER BY id DESC LIMIT 12').all(p.id),
    liquidaciones: db.prepare('SELECT id, esperado, recibido, envios, nota, creado FROM liquidaciones WHERE piloto_id = ? ORDER BY id DESC LIMIT 12').all(p.id),
    cuenta: (() => { const c = cuentaPiloto(p.id); delete c.detalle; return c; })(), frecuencias: FRECUENCIAS,
    cuentas: db.prepare('SELECT id, envios, ganancia, descuentos, efectivo, neto, creado FROM cuentas_piloto WHERE piloto_id = ? ORDER BY id DESC LIMIT 20').all(p.id),
  };
});

ruta('GET', '/api/piloto/envios/:id/foto-paquete', ({ req, res, params }) => {
  const p = requierePiloto(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND mensajero_id = ?').get(Number(params.id), p.id);
  if (!e) falla(404, 'No hay foto.');
  return enviarArchivoEnvio(res, e, 'paquete');
});
ruta('GET', '/api/piloto/envios/:id/paquete/:n', ({ req, res, params }) => {
  const p = requierePiloto(req);
  const e = db.prepare('SELECT id FROM envios WHERE id = ? AND mensajero_id = ?').get(Number(params.id), p.id);
  if (!e) falla(404, 'No hay foto.');
  return enviarFotoExtra(res, e.id, params.n);
});
ruta('GET', '/api/piloto/envios/:id/foto-cliente', ({ req, res, params }) => {
  const p = requierePiloto(req);
  const e = db.prepare(`SELECT usuario_id FROM envios WHERE id = ? AND mensajero_id = ? AND estado IN ${SQL_PILOTO_ACTIVO}`).get(Number(params.id), p.id);
  if (!e) falla(404, 'No hay foto.');
  return enviarDocumento(res, e.usuario_id, 'foto');
});

// ---------- Cliente: identidad y correo ----------
ruta('POST', '/api/yo/documento', ({ req, body }) => {
  const u = requiereRol(req, 'cliente');
  const d = DOCUMENTOS[body.tipo];
  if (!d || !d.cliente) falla(400, 'Tipo de documento no válido.');
  const actual = db.prepare('SELECT verificacion FROM usuarios WHERE id = ?').get(u.id);
  if (actual.verificacion === 'verificado') falla(403, 'Tu identidad ya fue verificada. Si necesitas cambiar algo, escríbenos.');
  guardarDocumento(u.id, body.tipo, body.archivo);
  actualizarVerificacionCliente(u.id);
  return { ok: true };
}, { limite: 1_000_000 });

ruta('GET', '/api/yo/documento/:tipo', ({ req, res, params }) => {
  const u = requiereUsuario(req);
  if (!DOCUMENTOS[params.tipo]?.cliente) falla(404, 'No hay archivo.');
  return enviarDocumento(res, u.id, params.tipo);
});

ruta('POST', '/api/yo/reenviar-correo', async ({ req }) => {
  const u = requiereRol(req, 'cliente');
  if (limitar(String(u.id), 'reenviar-correo', 3, 3600_000)) falla(429, 'Ya te enviamos varios correos. Revisa tu bandeja de spam o espera una hora.');
  const fila = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.id);
  if (fila.email_verificado) return { ok: true, ya: true };
  if (!correoActivo()) falla(503, 'El envío de correos todavía no está configurado. Escríbenos por WhatsApp.');
  if (!(await enviarConfirmacion(fila))) falla(502, 'No pudimos enviar el correo. Inténtalo más tarde.');
  return { ok: true };
});

ruta('GET', '/api/envios/:id/foto-piloto', ({ req, res, params }) => {
  const u = requiereUsuario(req);
  const e = db.prepare("SELECT mensajero_id FROM envios WHERE id = ? AND usuario_id = ? AND asignacion = 'aceptado'").get(Number(params.id), u.id);
  if (!e || !e.mensajero_id) falla(404, 'No hay foto.');
  return enviarDocumento(res, e.mensajero_id, 'foto');
});

// Historial de estrellas de un piloto: de quien envía y de quien recibe
function estrellasPiloto(id) {
  const filas = db.prepare(`SELECT guia, calificacion AS estrellas, calificacion_comentario AS comentario, 'Quien envió' AS de, COALESCE(entregado_en, actualizado) AS cuando
      FROM envios WHERE mensajero_id = ? AND calificacion IS NOT NULL
    UNION ALL SELECT guia, calif_receptor, calif_receptor_comentario, 'Quien recibió', COALESCE(entregado_en, actualizado)
      FROM envios WHERE mensajero_id = ? AND calif_receptor IS NOT NULL ORDER BY cuando DESC`).all(id, id);
  const dist = [5, 4, 3, 2, 1].map((n) => ({ estrellas: n, n: filas.filter((f) => f.estrellas === n).length }));
  const promedio = filas.length ? redondear(filas.reduce((t, f) => t + f.estrellas, 0) / filas.length) : null;
  return { promedio, total: filas.length, dist, ultimas: filas.slice(0, 20), bajo: promedio != null && promedio < 4 && filas.length >= 3 };
}
// Quien recibe califica al piloto desde su enlace, una vez entregado
ruta('POST', '/api/recibe/:token/calificar', ({ params, body }) => {
  const e = envioPorToken(params.token);
  if (e._rol === 'entrega') falla(400, 'Este enlace no es para calificar.');
  if (e.estado !== 'entregado' || !e.mensajero_id) falla(400, 'Puedes calificar cuando recibas tu paquete.');
  if (e.calif_receptor) falla(400, 'Ya calificaste esta entrega. ¡Gracias!');
  const estrellas = numero(body.estrellas);
  if (![1, 2, 3, 4, 5].includes(estrellas)) falla(400, 'Elige de 1 a 5 estrellas.');
  db.prepare('UPDATE envios SET calif_receptor = ?, calif_receptor_comentario = ? WHERE id = ?').run(estrellas, texto(body.comentario, 300) || null, e.id);
  return { ok: true };
});
ruta('POST', '/api/envios/:id/calificar', ({ req, params, body }) => {
  const u = requiereUsuario(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND usuario_id = ?').get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
  if (e.estado !== 'entregado' || !e.mensajero_id) falla(400, 'Puedes calificar cuando el envío esté entregado.');
  if (e.calificacion) falla(400, 'Ya calificaste este envío. ¡Gracias!');
  const estrellas = numero(body.estrellas);
  if (![1, 2, 3, 4, 5].includes(estrellas)) falla(400, 'Elige de 1 a 5 estrellas.');
  db.prepare('UPDATE envios SET calificacion = ?, calificacion_comentario = ? WHERE id = ?').run(estrellas, texto(body.comentario, 300), e.id);
  return { ok: true };
});

// ---------- Administración: pilotos ----------
ruta('GET', '/api/admin/mensajeros', ({ req }) => {
  const quien = requiereStaff(req);
  const filas = db.prepare(`${SQL_PILOTO} WHERE u.rol = 'mensajero'
    ORDER BY CASE u.estado_piloto WHEN 'en_revision' THEN 0 WHEN 'aprobado' THEN 1 WHEN 'suspendido' THEN 2 ELSE 3 END, u.nombre`).all();
  return { mensajeros: filas.map((p) => ({ ...pilotoSalida(p), carga: cargaPiloto(p.id) })), estados: ESTADOS_PILOTO };
});

ruta('GET', '/api/admin/mensajeros/:id', ({ req, params }) => {
  requiereRol(req, 'admin');
  const p = pilotoPorId(Number(params.id));
  if (!p) falla(404, 'No encontramos ese piloto.');
  const ultimos = db.prepare(`SELECT id, guia, estado, creado, calificacion, calificacion_comentario FROM envios WHERE mensajero_id = ? ORDER BY id DESC LIMIT 10`).all(p.id);
  return { piloto: pilotoSalida(p), envios: ultimos, estrellas: estrellasPiloto(p.id), estados: ESTADOS_PILOTO, equipo: EQUIPO, documentos: Object.fromEntries(Object.entries(DOCUMENTOS).map(([k, d]) => [k, d.nombre])),
    vehiculos: db.prepare('SELECT id, nombre FROM vehiculos ORDER BY orden, id').all(), tipos_licencia: TIPOS_LICENCIA };
});

ruta('POST', '/api/admin/mensajeros', ({ req, body }) => {
  requiereRol(req, 'admin');
  const email = texto(body.email, 150).toLowerCase();
  const password = String(body.password || '');
  const datos = leerDatosPiloto({ nombre: body.nombre, telefono: body.telefono, vehiculo_id: body.vehiculo_id }, 0);
  if (!datos.nombre) falla(400, 'Escribe el nombre del piloto.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) falla(400, 'Escribe un correo válido para el piloto.');
  if (password.length < 8) falla(400, 'La contraseña debe tener al menos 8 caracteres.');
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) falla(409, 'Ya existe una cuenta con ese correo.');
  const r = db.prepare(`INSERT INTO usuarios (nombre, email, telefono, password_hash, rol, vehiculo_id, estado_piloto, email_verificado, verificacion)
    VALUES (?, ?, ?, ?, 'mensajero', ?, 'en_revision', 1, 'verificado')`).run(datos.nombre, email, datos.telefono || '', hashPassword(password), datos.vehiculo_id ?? null);
  return { _status: 201, ok: true, id: Number(r.lastInsertRowid) };
});

ruta('PUT', '/api/admin/mensajeros/:id', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const p = pilotoPorId(Number(params.id));
  if (!p) falla(404, 'No encontramos ese piloto.');
  const datos = leerDatosPiloto(body, p.id);
  if (body.nota_admin !== undefined) datos.nota_admin = texto(body.nota_admin, 1000) || null;
  if (body.equipo !== undefined) {
    const eq = {};
    for (const k of Object.keys(EQUIPO)) { const f = body.equipo?.[k]; if (f) eq[k] = fechaCampo(f, EQUIPO[k], { pasada: true }); }
    datos.equipo = JSON.stringify(eq);
  }
  if (body.reglas_aceptadas === false) datos.reglas_aceptadas = null;
  if (body.reglas_aceptadas === true && !p.reglas_aceptadas) datos.reglas_aceptadas = new Date().toISOString().slice(0, 19).replace('T', ' ');
  guardarCampos(p.id, datos);
  if (body.password) {
    if (String(body.password).length < 8) falla(400, 'La contraseña debe tener al menos 8 caracteres.');
    db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(hashPassword(String(body.password)), p.id);
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(p.id);
  }
  return { ok: true };
});

ruta('POST', '/api/admin/mensajeros/:id/estado', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const p = pilotoPorId(Number(params.id));
  if (!p) falla(404, 'No encontramos ese piloto.');
  const estado = texto(body.estado, 20);
  if (!ESTADOS_PILOTO[estado]) falla(400, 'Estado no válido.');
  if (estado === 'aprobado') {
    const r = revisarPiloto(p);
    // La administración puede aprobar aunque falte algo (lo confirma en el panel); con documentos vencidos no
    if (r.faltan.length && body.forzar !== true) falla(400, `Todavía falta: ${r.faltan.join(', ')}.`);
    if (r.vencidos.length) falla(400, `No se puede aprobar: ${r.vencidos.join(', ')}.`);
  }
  if (estado !== 'aprobado' && p.activos) falla(400, 'Este piloto tiene envíos en curso. Reasígnalos antes de cambiar su estado.');
  db.prepare('UPDATE usuarios SET estado_piloto = ?, activo = ? WHERE id = ?').run(estado, estado === 'baja' ? 0 : 1, p.id);
  if (estado !== 'aprobado') {
    db.prepare('UPDATE usuarios SET en_linea = 0 WHERE id = ?').run(p.id);
    if (estado !== 'en_revision') db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(p.id);
  }
  if (estado === 'aprobado' && body.forzar === true) {
    const faltan = revisarPiloto(p).faltan;
    if (faltan.length) db.prepare("UPDATE usuarios SET nota_admin = TRIM(COALESCE(nota_admin, '') || char(10) || ?) WHERE id = ?").run(`${hoyGT()}: aprobado sin: ${faltan.join(', ')}`, p.id);
  }
  if (body.nota) db.prepare("UPDATE usuarios SET nota_admin = TRIM(COALESCE(nota_admin, '') || char(10) || ?) WHERE id = ?").run(`${hoyGT()}: ${ESTADOS_PILOTO[estado]}. ${texto(body.nota, 300)}`, p.id);
  return { ok: true };
});

ruta('POST', '/api/admin/mensajeros/:id/renovacion', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const p = pilotoPorId(Number(params.id));
  if (!p) falla(404, 'No encontramos ese piloto.');
  const r = renovacionDe(p);
  if (!Object.keys(r.campos).length && !r.docs.length) falla(400, 'Este piloto no tiene renovaciones por revisar.');
  if (body.accion === 'aprobar') {
    const datos = leerDatosPiloto(r.campos, p.id, CAMPOS_RENOVACION);
    guardarCampos(p.id, datos);
    db.prepare('UPDATE usuarios SET renovacion_pendiente = NULL WHERE id = ?').run(p.id);
    avisar(p.id, { titulo: 'Renovación aprobada', cuerpo: 'Tus documentos nuevos ya quedaron confirmados.', url: RUTA_PILOTO });
  } else if (body.accion === 'rechazar') {
    const nota = texto(body.nota, 300);
    if (nota.length < 4) falla(400, 'Escribe qué tiene que corregir el piloto.');
    db.prepare('UPDATE usuarios SET renovacion_pendiente = NULL WHERE id = ?').run(p.id);
    db.prepare("UPDATE usuarios SET nota_admin = TRIM(COALESCE(nota_admin, '') || char(10) || ?) WHERE id = ?").run(`${hoyGT()}: renovación rechazada. ${nota}`, p.id);
    avisar(p.id, { titulo: 'Revisa tu renovación', cuerpo: nota, url: RUTA_PILOTO });
  } else falla(400, 'Acción no válida.');
  return { ok: true };
});
ruta('POST', '/api/admin/mensajeros/:id/borrar-documentos', ({ req, params }) => {
  requiereRol(req, 'admin');
  const p = pilotoPorId(Number(params.id));
  if (!p) falla(404, 'No encontramos ese piloto.');
  if (p.estado_piloto !== 'baja') falla(400, 'Primero da de baja al piloto.');
  borrarDocumentos(p.id);
  return { ok: true };
});

// Documentos de cualquier cuenta (pilotos y clientes), solo para la administración
ruta('POST', '/api/admin/usuarios/:id/documento', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const u = db.prepare("SELECT id, rol FROM usuarios WHERE id = ? AND rol IN ('mensajero','cliente')").get(Number(params.id));
  if (!u) falla(404, 'No encontramos esa cuenta.');
  guardarDocumento(u.id, body.tipo, body.archivo);
  if (u.rol === 'cliente') actualizarVerificacionCliente(u.id);
  return { ok: true };
}, { limite: 1_000_000 });

ruta('GET', '/api/admin/usuarios/:id/documento/:tipo', ({ req, res, params }) => {
  const quien = requiereStaff(req);
  if (esOperador(quien) && db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(Number(params.id))?.rol !== 'cliente') falla(403, 'Solo la administración ve los documentos de los pilotos.');
  return enviarDocumento(res, Number(params.id), params.tipo);
});

ruta('GET', '/api/admin/envios/:id/paquete/:n', ({ req, res, params }) => {
  requiereStaff(req);
  return enviarFotoExtra(res, Number(params.id), params.n);
});
ruta('GET', '/api/admin/envios/:id/entrega/:tipo', ({ req, res, params }) => {
  requiereStaff(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  return enviarArchivoEnvio(res, e, params.tipo);
});

// Mapa en vivo de la flota
ruta('GET', '/api/admin/flota', ({ req }) => {
  const quien = requiereStaff(req);
  const pilotos = db.prepare(`${SQL_PILOTO} WHERE u.rol = 'mensajero' AND u.estado_piloto = 'aprobado' AND u.activo = 1`).all();
  return { pilotos: pilotos.map((p) => {
    const activo = db.prepare(`SELECT id, guia, estado, asignacion, origen_lat, origen_lng, destino_lat, destino_lng, destino_zona FROM envios
      WHERE mensajero_id = ? AND estado IN ${SQL_PILOTO_ACTIVO} ORDER BY CASE WHEN asignacion = 'aceptado' THEN 0 ELSE 1 END, id LIMIT 1`).get(p.id);
    const vivo = enLineaReal(p);
    const minutos = p.ubic_fecha ? Math.round((Date.now() - fechaMs(p.ubic_fecha)) / 60_000) : null;
    return { id: p.id, nombre: p.nombre, telefono: p.telefono, vehiculo: p.vehiculo, placa: p.veh_placa, en_linea: vivo,
      sin_senal: !vivo && !!activo && activo.asignacion === 'aceptado', lat: p.ubic_lat, lng: p.ubic_lng, ubic_fecha: p.ubic_fecha, minutos,
      activos: p.activos, envio: activo || null, carga: cargaPiloto(p.id) };
  }) };
});

// Qué lleva ahora cada piloto: si está en una ruta de empresa o con varios envíos de un mismo cliente, asignarle
// más envíos sueltos lo puede distraer. El panel lo muestra debajo del nombre y pide confirmar.
function cargaPiloto(pilotoId) {
  const filas = db.prepare(`SELECT usuario_id, pedido_id, grupo FROM envios WHERE mensajero_id = ? AND estado IN ('pendiente','recogido','en_camino')
    AND asignacion IN ('aceptado','por_aceptar')`).all(pilotoId);
  if (!filas.length) return null;
  const deEmpresa = filas.filter((f) => f.pedido_id);
  if (deEmpresa.length) {
    const nombres = [...new Set(deEmpresa.map((f) => nombreEmpresa(f.usuario_id)))];
    return { tipo: 'empresa', n: deEmpresa.length, texto: `En envíos de empresa · ${nombres.join(', ')} (${deEmpresa.length} por entregar)`, distrae: true };
  }
  const porGrupo = {};
  for (const f of filas) if (f.grupo) porGrupo[f.grupo] = (porGrupo[f.grupo] || 0) + 1;
  const mayor = Math.max(0, ...Object.values(porGrupo));
  if (mayor >= 3) return { tipo: 'cliente', n: mayor, texto: `Llevando ${mayor} envíos de un mismo cliente`, distrae: true };
  if (filas.length >= 3) return { tipo: 'varios', n: filas.length, texto: `Con ${filas.length} envíos en curso`, distrae: true };
  return { tipo: 'pocos', n: filas.length, texto: `Con ${filas.length} envío${filas.length === 1 ? '' : 's'} en curso`, distrae: false };
}

// Pilotos ordenados por cercanía al punto de recogida de un envío
ruta('GET', '/api/admin/envios/:id/cercanos', ({ req, params }) => {
  const quien = requiereStaff(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  const o = e.origen_lat != null ? { lat: e.origen_lat, lng: e.origen_lng } : null;
  const lista = db.prepare(`${SQL_PILOTO} WHERE u.rol = 'mensajero' AND u.estado_piloto = 'aprobado' AND u.activo = 1`).all()
    .filter((p) => puedeTrabajar(p))
    .map((p) => ({ id: p.id, nombre: p.nombre, vehiculo: p.vehiculo, vehiculo_id: p.vehiculo_id, placa: p.veh_placa, activos: p.activos,
      calificacion: p.calificacion, en_linea: enLineaReal(p), carga: cargaPiloto(p.id),
      km: o && p.ubic_lat != null && enLineaReal(p) ? Math.round(distanciaRecta(o, { lat: p.ubic_lat, lng: p.ubic_lng }) * 10) / 10 : null }));
  // Primero los que están en línea y libres (los que van en ruta de empresa o con muchos envíos, abajo); luego estrellas y cercanía
  const nivel = (p) => Math.round((p.calificacion ?? 4) * 2) / 2;
  const ocupado = (p) => (p.carga && p.carga.distrae ? 1 : 0);
  lista.sort((a, b) => (b.en_linea - a.en_linea) || (ocupado(a) - ocupado(b)) || (nivel(b) - nivel(a)) || ((a.km ?? 9999) - (b.km ?? 9999)) || (a.activos - b.activos));
  return { pilotos: lista, con_ubicacion: !!o };
});

// Un toque: asignar al piloto en línea más cercano con el vehículo correcto
ruta('POST', '/api/admin/envios/:id/asignar-cercano', ({ req, params }) => {
  const quien = requiereStaff(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  if (e.mensajero_id && e.asignacion) falla(400, 'Este envío ya tiene piloto.');
  if (!listoParaPiloto(e)) falla(400, motivoNoListo(e));
  const o = e.origen_lat != null ? { lat: e.origen_lat, lng: e.origen_lng } : null;
  const lista = db.prepare(`${SQL_PILOTO} WHERE u.rol = 'mensajero' AND u.estado_piloto = 'aprobado' AND u.activo = 1 AND u.vehiculo_id = ?`).all(e.vehiculo_id)
    .filter((p) => puedeTrabajar(p) && enLineaReal(p) && !cargaPiloto(p.id)?.distrae)   // no se le carga a quien va en ruta de empresa o con muchos envíos
    .map((p) => ({ p, km: o && p.ubic_lat != null ? distanciaRecta(o, { lat: p.ubic_lat, lng: p.ubic_lng }) : 999 }))
    .sort((a, b) => (a.p.activos - b.p.activos) * 2 + (a.km - b.km));
  if (!lista.length) falla(400, 'No hay pilotos libres en línea con ese vehículo (los demás van en ruta de empresa o con varios envíos). Elige uno de la lista o espera a que alguien se desocupe.');
  const m = lista[0].p;
  db.prepare(`UPDATE envios SET mensajero_id = ?, asignacion = 'por_aceptar', asignado_en = datetime('now'), llego_origen = 0, llegando_destino = 0,
    actualizado = datetime('now') WHERE id = ?`).run(m.id, e.id);
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, `Asignado a ${m.nombre.split(' ')[0]} (el más cercano), esperando que acepte`);
  avisarEnvio(e.id, 'asignado');
  return { ok: true, piloto: m.nombre.split(' ')[0], km: Math.round(lista[0].km * 10) / 10 };
});

ruta('GET', '/api/admin/envios/:id/recorrido', ({ req, params }) => {
  const quien = requiereStaff(req);
  return { puntos: db.prepare('SELECT lat, lng, creado FROM ubicaciones WHERE envio_id = ? ORDER BY id').all(Number(params.id)) };
});

// ---------- Administración: clientes ----------
// La administración confirma a mano el correo de un cliente (por ejemplo, si no le llega el correo)
ruta('POST', '/api/admin/clientes/:id/confirmar-correo', ({ req, params }) => {
  requiereRol(req, 'admin');
  const u = db.prepare("SELECT id, email_verificado FROM usuarios WHERE id = ? AND rol = 'cliente'").get(Number(params.id)) || falla(404, 'No encontramos ese cliente.');
  if (!u.email_verificado) {
    db.prepare('UPDATE usuarios SET email_verificado = 1 WHERE id = ?').run(u.id);
    db.prepare('DELETE FROM tokens_correo WHERE usuario_id = ?').run(u.id);
  }
  return { ok: true };
});
ruta('GET', '/api/admin/clientes', ({ req }) => {
  const quien = requiereStaff(req);
  return { clientes: db.prepare(`
    SELECT u.*, (SELECT COUNT(*) FROM envios e WHERE e.usuario_id = u.id) AS envios,
      (SELECT ROUND(AVG(e.calif_cliente), 1) FROM envios e WHERE e.usuario_id = u.id) AS calif_cliente,
      (SELECT COALESCE(SUM(c.monto), 0) FROM cargos c WHERE c.usuario_id = u.id AND c.pagado_en IS NULL AND c.anulado_en IS NULL AND c.cobrado_envio_id IS NULL) AS cargos_pendientes
    FROM usuarios u WHERE u.rol = 'cliente'
    ORDER BY CASE u.verificacion WHEN 'por_revisar' THEN 0 ELSE 1 END, u.id DESC LIMIT 500`).all().map((u) => ({ ...datosCliente(u), envios: u.envios, calif_cliente: u.calif_cliente, cargos_pendientes: redondear(u.cargos_pendientes) })),
  correo_activo: correoActivo() };
});

ruta('POST', '/api/admin/clientes/:id/verificacion', ({ req, params, body }) => {
  const quien = requiereStaff(req);
  const u = db.prepare("SELECT * FROM usuarios WHERE id = ? AND rol = 'cliente'").get(Number(params.id));
  if (!u) falla(404, 'No encontramos ese cliente.');
  const estado = texto(body.estado, 20);
  if (!['verificado', 'rechazado', 'por_revisar'].includes(estado)) falla(400, 'Estado no válido.');
  const nota = texto(body.nota, 300);
  if (estado === 'rechazado' && nota.length < 5) falla(400, 'Escribe el motivo para que el cliente sepa qué corregir.');
  db.prepare('UPDATE usuarios SET verificacion = ?, verificacion_nota = ? WHERE id = ?').run(estado, estado === 'rechazado' ? nota : null, u.id);
  return { ok: true };
});

// ---------- Eliminar una cuenta por completo (para limpiar cuentas de prueba) ----------
// Borra la cuenta y lo suyo: así el correo y el teléfono quedan libres para registrarse otra vez.
// Si era piloto, sus envíos de clientes no se borran: los que estaban en curso vuelven a buscar piloto.
function resumenBorrado(id) {
  const u = db.prepare('SELECT id, nombre, email, telefono, rol FROM usuarios WHERE id = ?').get(id);
  if (!u) falla(404, 'No encontramos esa cuenta.');
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  const enCurso = ESTADOS.filter((x) => !ESTADOS_CERRADOS.includes(x)).map((x) => `'${x}'`).join(',');
  return { ...u,
    envios: n('SELECT COUNT(*) n FROM envios WHERE usuario_id = ?', id),
    envios_en_curso: n(`SELECT COUNT(*) n FROM envios WHERE usuario_id = ? AND estado IN (${enCurso})`, id),
    pedidos_empresa: n('SELECT COUNT(*) n FROM pedidos_empresa WHERE usuario_id = ?', id),
    como_piloto: n('SELECT COUNT(*) n FROM envios WHERE mensajero_id = ?', id),
    como_piloto_en_curso: n(`SELECT COUNT(*) n FROM envios WHERE mensajero_id = ? AND estado IN (${enCurso})`, id) };
}
function borrarArchivosDe(filas) {
  for (const f of filas) for (const v of Object.values(f || {})) {
    if (typeof v !== 'string' || !/^[\w.-]+\.(jpe?g|png|webp|pdf)$/i.test(v)) continue;
    try { fs.unlinkSync(path.join(DOCS_DIR, path.basename(v))); } catch {}
  }
}
function eliminarCuenta(id) {
  const enCurso = ESTADOS.filter((x) => !ESTADOS_CERRADOS.includes(x)).map((x) => `'${x}'`).join(',');
  const archivos = [];
  db.exec('BEGIN');
  try {
    const ids = db.prepare('SELECT id FROM envios WHERE usuario_id = ?').all(id).map((x) => x.id);
    const lista = ids.length ? ids.join(',') : '0';
    archivos.push(...db.prepare(`SELECT * FROM envios WHERE id IN (${lista})`).all(), ...db.prepare(`SELECT foto FROM paquetes_envio WHERE envio_id IN (${lista})`).all(),
      ...db.prepare(`SELECT foto FROM reclamos WHERE envio_id IN (${lista}) OR usuario_id = ?`).all(id), ...db.prepare('SELECT foto FROM pedidos_empresa WHERE usuario_id = ?').all(id),
      ...db.prepare('SELECT * FROM solicitudes_empresa WHERE usuario_id = ?').all(id), ...db.prepare('SELECT * FROM usuarios WHERE id = ?').all(id));
    // Lo que cuelga de sus envíos
    for (const t of ['eventos', 'alertas', 'ubicaciones', 'paquetes_envio', 'reclamos']) db.prepare(`DELETE FROM ${t} WHERE envio_id IN (${lista})`).run();
    db.prepare(`DELETE FROM cargos WHERE envio_id IN (${lista}) OR usuario_id = ?`).run(id);
    db.prepare(`UPDATE cargos SET cobrado_envio_id = NULL WHERE cobrado_envio_id IN (${lista})`).run();
    db.prepare('DELETE FROM reclamos WHERE usuario_id = ?').run(id);
    db.prepare('DELETE FROM push_pedidos WHERE pedido_id IN (SELECT id FROM pedidos_empresa WHERE usuario_id = ?)').run(id);
    db.prepare(`UPDATE pedidos_empresa SET envio_id = NULL WHERE envio_id IN (${lista})`).run();
    db.prepare(`DELETE FROM envios WHERE id IN (${lista})`).run();
    for (const t of ['pedidos_empresa', 'carpetas_empresa', 'lotes_empresa', 'lotes_sede']) db.prepare(`DELETE FROM ${t} WHERE usuario_id = ?`).run(id);
    // Si era piloto: sus envíos en curso vuelven a buscar piloto; los terminados se quedan sin piloto
    const vuelven = db.prepare(`SELECT id FROM envios WHERE mensajero_id = ? AND estado IN (${enCurso})`).all(id);
    for (const e of vuelven) {
      db.prepare("UPDATE envios SET mensajero_id = NULL, estado = CASE WHEN estado IN ('pendiente', 'recogido', 'en_camino') THEN 'pendiente' ELSE estado END WHERE id = ?").run(e.id);
      db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, (SELECT estado FROM envios WHERE id = ?), ?)').run(e.id, e.id, 'Se eliminó la cuenta del piloto: el envío vuelve a buscar piloto');
    }
    db.prepare('UPDATE envios SET mensajero_id = NULL, pago_piloto_id = NULL WHERE mensajero_id = ?').run(id);
    db.prepare('UPDATE reclamos SET piloto_id = NULL WHERE piloto_id = ?').run(id);
    for (const t of ['alertas', 'liquidaciones', 'pagos_piloto', 'cuentas_piloto']) db.prepare(`DELETE FROM ${t} WHERE piloto_id = ?`).run(id);
    db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);   // sesiones, direcciones, avisos, solicitud, etc. se borran solos
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  borrarArchivosDe(archivos);
}
ruta('GET', '/api/admin/usuarios/:id/eliminar', ({ req, params }) => {
  requiereRol(req, 'admin');
  return resumenBorrado(Number(params.id));
});
ruta('POST', '/api/admin/usuarios/:id/eliminar', ({ req, params, body }) => {
  const yo = requiereRol(req, 'admin');
  const r = resumenBorrado(Number(params.id));
  if (r.id === yo.id) falla(400, 'No puedes eliminar tu propia cuenta.');
  if (r.rol === 'admin' && db.prepare("SELECT COUNT(*) n FROM usuarios WHERE rol = 'admin'").get().n <= 1) falla(400, 'Es la única cuenta de administración: no se puede eliminar.');
  if (String(body.confirmar || '').trim().toLowerCase() !== String(r.email).toLowerCase()) falla(400, 'Para confirmar, escribe el correo de la cuenta tal como aparece.');
  eliminarCuenta(r.id);
  return { ok: true, eliminada: r.nombre };
});

ruta('POST', '/api/admin/clientes/:id/activo', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const u = db.prepare("SELECT id FROM usuarios WHERE id = ? AND rol = 'cliente'").get(Number(params.id));
  if (!u) falla(404, 'No encontramos ese cliente.');
  db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(body.activo ? 1 : 0, u.id);
  if (!body.activo) db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(u.id);
  return { ok: true };
});

// =====================================================================
// Funciones de negocio: entrega segura, descuentos, empresas, direcciones,
// caja y pagos, reportes, asignación automática, operadores y emergencias
// =====================================================================

// ---------- Entrega segura: foto y firma ----------
const ARCHIVOS_ENTREGA = { foto: 'foto_entrega', firma: 'firma_entrega', receptor: 'receptor_foto', origen: 'origen_foto', fallo: 'fallo_foto', comprobante: 'comprobante', paquete: 'foto_paquete' };
const FALTA_ARCHIVO = { foto: 'Toma la foto del paquete.', firma: 'La firma no es válida.', receptor: 'La foto no es válida. Elige otra.', origen: 'La foto no es válida. Elige otra.', fallo: 'La foto no es válida.', comprobante: 'Sube una foto o PDF del comprobante.', paquete: 'La foto del paquete no es válida. Toma otra.' };
function guardarArchivoEnvio(envioId, tipo, dataUrl) {
  const col = ARCHIVOS_ENTREGA[tipo];
  const m = /^data:(?:image\/(jpeg|png|webp)|application\/(pdf));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m || (m[2] && tipo !== 'comprobante')) falla(400, FALTA_ARCHIVO[tipo]);
  const datos = Buffer.from(m[3], 'base64');
  if (datos.length < 300) falla(400, tipo === 'firma' ? 'La firma está vacía.' : 'La foto está vacía.');
  if (datos.length > 700_000) falla(413, 'El archivo es demasiado grande (máximo 700 KB).');
  const ext = m[2] ? 'pdf' : m[1] === 'jpeg' ? 'jpg' : m[1];
  if (!FIRMAS[ext].every((b, i) => datos[i] === b)) falla(400, 'El archivo no es válido.');
  fs.mkdirSync(DOCS_DIR, { recursive: true, mode: 0o750 });
  const nombre = `envio-${envioId}-${tipo}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(DOCS_DIR, nombre), datos, { mode: 0o640 });
  const anterior = db.prepare(`SELECT ${col} AS a FROM envios WHERE id = ?`).get(envioId)?.a;
  db.prepare(`UPDATE envios SET ${col} = ? WHERE id = ?`).run(nombre, envioId);
  if (anterior && anterior !== nombre) fs.rm(path.join(DOCS_DIR, path.basename(anterior)), () => {});
}
function enviarArchivoEnvio(res, envio, tipo) {
  const col = ARCHIVOS_ENTREGA[tipo];
  if (!col || !envio[col]) falla(404, 'No hay archivo.');
  let datos;
  const archivo = path.join(DOCS_DIR, path.basename(envio[col]));
  try { datos = fs.readFileSync(archivo); } catch { falla(404, 'No hay archivo.'); }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream', 'Content-Length': datos.length,
    'Cache-Control': 'private, no-store', 'Content-Security-Policy': 'sandbox', ...CABECERAS_SEGURIDAD });
  res.end(datos);
  return { _enviado: true };
}
// ---------- Varios paquetes en un envío (hasta 3, misma dirección, mismo precio) ----------
const MAX_PAQUETES_ENVIO = 3;
// Revisa los paquetes 2 y 3 y suma su peso al del primero (el precio se calcula con el peso total)
function prepararExtras(body) {
  const lista = Array.isArray(body.extras) ? body.extras : [];
  if (lista.length > MAX_PAQUETES_ENVIO - 1) falla(400, `Un envío lleva hasta ${MAX_PAQUETES_ENVIO} paquetes.`);
  const extras = lista.map((x, i) => {
    const peso = numero(x && x.peso);
    if (!Number.isFinite(peso) || peso <= 0) falla(400, `Escribe el peso del paquete ${i + 2}.`);
    if (!x.foto) falla(400, `Toma la foto del paquete ${i + 2}.`);
    return { n: i + 2, peso: redondear(peso), descripcion: texto(x.descripcion, 200) || null, foto: x.foto };
  });
  if (extras.length) {
    const base = numero(body.peso);
    body.peso = redondear((Number.isFinite(base) ? base : 0) + extras.reduce((t, x) => t + x.peso, 0));
    body.peso_paquete1 = Number.isFinite(base) ? redondear(base) : null;
  }
  return extras;
}
function guardarExtras(envioId, extras) {
  for (const x of extras) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(x.foto || ''));
    if (!m) falla(400, `La foto del paquete ${x.n} no es válida.`);
    const datos = Buffer.from(m[2], 'base64');
    if (datos.length < 300) falla(400, `La foto del paquete ${x.n} está vacía.`);
    if (datos.length > 700_000) falla(413, `La foto del paquete ${x.n} es demasiado grande (máximo 700 KB).`);
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    if (!FIRMAS[ext].every((b, i) => datos[i] === b)) falla(400, `La foto del paquete ${x.n} no es válida.`);
    fs.mkdirSync(DOCS_DIR, { recursive: true, mode: 0o750 });
    const nombre = `envio-${envioId}-paquete${x.n}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(DOCS_DIR, nombre), datos, { mode: 0o640 });
    db.prepare('INSERT INTO paquetes_envio (envio_id, n, peso, descripcion, foto) VALUES (?, ?, ?, ?, ?)').run(envioId, x.n, x.peso, x.descripcion, nombre);
  }
}
const paquetesExtra = (envioId) => db.prepare('SELECT n, peso, descripcion, foto IS NOT NULL AS tiene_foto FROM paquetes_envio WHERE envio_id = ? ORDER BY n').all(envioId)
  .map((x) => ({ n: x.n, peso: x.peso, descripcion: x.descripcion, tiene_foto: !!x.tiene_foto }));
function enviarFotoExtra(res, envioId, n) {
  const f = db.prepare('SELECT foto FROM paquetes_envio WHERE envio_id = ? AND n = ?').get(envioId, Number(n));
  if (!f || !f.foto) falla(404, 'No hay foto.');
  let datos; const archivo = path.join(DOCS_DIR, path.basename(f.foto));
  try { datos = fs.readFileSync(archivo); } catch { falla(404, 'No hay foto.'); }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream', 'Content-Length': datos.length,
    'Cache-Control': 'private, no-store', 'Content-Security-Policy': 'sandbox', ...CABECERAS_SEGURIDAD });
  res.end(datos);
  return { _enviado: true };
}

// Lo que gana el piloto por envío: porcentaje, monto fijo, o el precio menos lo que cobra Vaelo (Q5 por envío)
const gananciaPiloto = (precio) => {
  const a = getAjustes(), v = Number(a.comision_valor) || 0;
  if (a.comision_tipo === 'vaelo_fijo') return redondear(Math.max(0, precio - v));
  return redondear(a.comision_tipo === 'fijo' ? v : (precio * v) / 100);
};

// ---------- Descuentos y promociones ----------
// Fecha y hora de Guatemala "AAAA-MM-DD HH:MM" (las promociones pueden durar horas: inicio y fin con hora)
const ahoraGT = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
const inicioPromo = (p) => `${p.desde} ${p.desde_hora || '00:00'}`, finPromo = (p) => `${p.hasta} ${p.hasta_hora || '23:59'}`;
const promocionesVigentes = () => { const ahora = ahoraGT(); return db.prepare('SELECT * FROM promociones WHERE activa = 1 ORDER BY id').all().filter((p) => inicioPromo(p) <= ahora && finPromo(p) >= ahora); };
function montoPromo(p, precio) {
  if (p.tipo === 'gratis') return precio;
  if (p.tipo === 'porcentaje') return redondear((precio * Math.min(100, p.valor)) / 100);
  return redondear(Math.min(precio, p.valor));
}
// Elige el mejor descuento para este envío (no se suman): promociones automáticas, el cupón escrito y el precio de empresa
function mejorDescuento(precio, usuarioId, cupon) {
  const u = usuarioId ? db.prepare('SELECT * FROM usuarios WHERE id = ?').get(usuarioId) : null;
  const codigo = texto(cupon, 30).toUpperCase();
  const opciones = [];
  let cuponValido = !codigo, motivoCupon = '';
  // Código de influencer: una sola vez por cuenta y por teléfono, para siempre
  const inf = codigo ? descuentoInfluencer(precio, u, codigo) : null;
  if (inf) { if (inf.motivo) motivoCupon = inf.motivo; else { cuponValido = true; opciones.push(inf); } }
  for (const p of promocionesVigentes()) {
    if (p.usuario_id && p.usuario_id !== u?.id) continue;   // cupón personal (compensación de un reclamo): solo para ese cliente
    const conCodigo = !!p.codigo;
    if (conCodigo && p.codigo.toUpperCase() !== codigo) continue;
    const motivo = (() => {
      if (p.minimo && precio < p.minimo) return `aplica en envíos desde ${'Q' + p.minimo.toFixed(2)}`;
      if (p.usos_max && db.prepare("SELECT COUNT(*) n FROM envios WHERE promocion_id = ? AND estado != 'cancelado'").get(p.id).n >= p.usos_max) return 'ya se agotó';
      if (p.solo_primer_envio || p.usos_por_cliente) {
        if (!u) return 'inicia sesión para usarlo';
        if (p.solo_primer_envio && db.prepare("SELECT COUNT(*) n FROM envios WHERE usuario_id = ? AND estado != 'cancelado'").get(u.id).n > 0) return 'es solo para tu primer envío';
        if (p.usos_por_cliente && db.prepare("SELECT COUNT(*) n FROM envios WHERE usuario_id = ? AND promocion_id = ? AND estado != 'cancelado'").get(u.id, p.id).n >= p.usos_por_cliente) return 'ya lo usaste';
      }
      return '';
    })();
    if (conCodigo) { if (motivo) motivoCupon = motivo; else cuponValido = true; }
    if (!motivo) opciones.push({ id: p.id, nombre: p.nombre, monto: montoPromo(p, precio) });
  }
  if (u && u.tipo_cuenta === 'empresa' && u.descuento_empresa > 0) opciones.push({ id: null, nombre: `Precio de empresa (${u.descuento_empresa}%)`, monto: redondear((precio * Math.min(100, u.descuento_empresa)) / 100) });
  opciones.sort((a, b) => b.monto - a.monto);
  const mejor = opciones[0] && opciones[0].monto > 0 ? opciones[0] : null;
  const errorCupon = codigo && !cuponValido ? (motivoCupon ? `${inf ? 'Ese código' : 'Ese cupón'} ${motivoCupon}.` : 'Ese cupón no existe o ya venció.') : '';
  return { descuento: mejor ? mejor.monto : 0, promocion_id: mejor ? mejor.id : null, influencer_id: mejor ? mejor.influencer_id || null : null, promocion: mejor ? mejor.nombre : '', precio: redondear(precio - (mejor ? mejor.monto : 0)), errorCupon };
}
// Promoción automática que se anuncia en la página (la de mayor beneficio entre las que no piden código)
function promocionAnunciada() {
  const p = promocionesVigentes().filter((x) => !x.codigo && !x.solo_primer_envio && !x.usuario_id)
    .sort((a, b) => (b.tipo === 'gratis') - (a.tipo === 'gratis') || b.valor - a.valor)[0];
  return p ? { nombre: p.nombre, tipo: p.tipo, valor: p.valor, hasta: p.hasta } : null;
}

// ---------- Influencers Vaelo ----------
// Un influencer promociona a Vaelo con su código. Cada cliente puede usar un código de influencer una sola vez en su vida
// (por cuenta y por teléfono). El influencer suma puntos cuando ese envío se entrega, y con los puntos gana regalos.
const telefono8 = (t) => digitos(t).slice(-8);
const SQL_TEL8 = "substr(replace(replace(replace(replace(COALESCE(u.telefono, ''), '-', ''), ' ', ''), '+', ''), '(', ''), -8)";
const puntosPorUso = () => Math.max(0, Math.round(ajNum('influencer_puntos_uso', 10)));
const influencerPorCodigo = (codigo) => (codigo ? db.prepare('SELECT * FROM influencers WHERE upper(codigo) = upper(?)').get(codigo) : null);
const textoBeneficio = (i) => (i.beneficio_tipo === 'precio' ? `su envío a Q${Number(i.beneficio_valor).toFixed(2)}` : `Q${Number(i.beneficio_valor).toFixed(2)} de descuento en su envío`);
// ¿Este cliente ya usó un código de influencer? (cualquiera, con su cuenta o con su teléfono)
function yaUsoInfluencer(u) {
  return !!db.prepare(`SELECT 1 FROM envios e JOIN usuarios u ON u.id = e.usuario_id WHERE e.influencer_id IS NOT NULL AND e.estado != 'cancelado'
    AND (u.id = ? OR (${SQL_TEL8} = ? AND length(?) = 8)) LIMIT 1`).get(u.id, telefono8(u.telefono), telefono8(u.telefono));
}
// Descuento de un código de influencer para este cliente (o el motivo por el que no aplica)
function descuentoInfluencer(precio, u, codigo) {
  const i = influencerPorCodigo(codigo);
  if (!i) return null;
  if (!i.activo) return { motivo: 'está pausado por ahora' };
  if (!u) return { motivo: 'necesita que inicies sesión' };
  const duenio = db.prepare('SELECT id, telefono FROM usuarios WHERE id = ?').get(i.usuario_id);
  if (u.id === i.usuario_id || (telefono8(u.telefono).length === 8 && telefono8(u.telefono) === telefono8(duenio?.telefono))) return { motivo: 'es tuyo: compártelo con tus seguidores' };
  if (yaUsoInfluencer(u)) return { motivo: 'no aplica: los códigos de influencer se usan una sola vez por cuenta' };
  const monto = i.beneficio_tipo === 'precio' ? Math.max(0, redondear(precio - i.beneficio_valor)) : redondear(Math.min(precio, i.beneficio_valor));
  return { id: null, influencer_id: i.id, nombre: `Código ${i.codigo}`, monto };
}
function puntosInfluencer(id) {
  const entregados = db.prepare("SELECT COALESCE(SUM(influencer_puntos), 0) AS p, COUNT(*) AS n FROM envios WHERE influencer_id = ? AND estado = 'entregado'").get(id);
  const enCamino = db.prepare("SELECT COUNT(*) AS n FROM envios WHERE influencer_id = ? AND estado NOT IN ('entregado','cancelado','devuelto')").get(id).n;
  const ajustes = db.prepare('SELECT COALESCE(SUM(puntos), 0) AS p FROM influencer_ajustes WHERE influencer_id = ?').get(id).p;
  return { puntos: Math.max(0, entregados.p + ajustes), usos: entregados.n, en_camino: enCamino, ajustes };
}
function metasInfluencer(inf, puntos) {
  const hechas = new Map(db.prepare('SELECT * FROM influencer_metas WHERE influencer_id = ?').all(inf.id).map((m) => [m.regalo_id, m]));
  return db.prepare('SELECT * FROM influencer_regalos WHERE activo = 1 ORDER BY puntos, id').all().map((r) => {
    const m = hechas.get(r.id);
    return { id: r.id, regalo: r.regalo, puntos: r.puntos, alcanzado: puntos >= r.puntos, faltan: Math.max(0, r.puntos - puntos), pedido_en: m?.pedido_en || null, entregado_en: m?.entregado_en || null };
  });
}
function influencerSalida(inf, conDetalle = false) {
  const u = db.prepare('SELECT nombre, email, telefono FROM usuarios WHERE id = ?').get(inf.usuario_id) || {};
  const p = puntosInfluencer(inf.id);
  const out = { id: inf.id, usuario_id: inf.usuario_id, nombre: u.nombre, email: u.email, telefono: u.telefono, codigo: inf.codigo, beneficio_tipo: inf.beneficio_tipo, beneficio_valor: inf.beneficio_valor,
    beneficio: textoBeneficio(inf), activo: !!inf.activo, creado: inf.creado, ...p, metas: metasInfluencer(inf, p.puntos) };
  if (conDetalle) {
    out.historial = db.prepare(`SELECT e.guia, e.estado, e.creado, e.entregado_en, e.influencer_puntos, u.nombre AS cliente FROM envios e JOIN usuarios u ON u.id = e.usuario_id
      WHERE e.influencer_id = ? ORDER BY e.id DESC LIMIT 100`).all(inf.id).map((x) => ({ ...x, cliente: x.cliente.split(' ')[0] }));
    out.ajustes_lista = db.prepare('SELECT puntos, nota, creado FROM influencer_ajustes WHERE influencer_id = ? ORDER BY id DESC LIMIT 50').all(inf.id);
    const s = inf.solicitud_id ? db.prepare('SELECT redes, seguidores FROM influencer_solicitudes WHERE id = ?').get(inf.solicitud_id) : null;
    out.redes = s?.redes || ''; out.seguidores = s?.seguidores || '';
  }
  return out;
}
// Solicitud pública: no necesita cuenta
ruta('POST', '/api/influencers/solicitud', ({ req, body }) => {
  if (limitar(ipDe(req), 'influencer-solicitud', 5, 3600_000)) falla(429, 'Ya mandaste varias solicitudes. Espera una hora.');
  const nombre = texto(body.nombre, 100), email = texto(body.email, 150).toLowerCase(), telefono = texto(body.telefono, 30);
  const redes = texto(body.redes, 500), seguidores = texto(body.seguidores, 60), mensaje = texto(body.mensaje, 600);
  if (nombre.length < 2) falla(400, 'Escribe tu nombre.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) falla(400, 'Escribe un correo válido.');
  if (digitos(telefono).length < 8) falla(400, 'Escribe tu teléfono o WhatsApp de 8 dígitos.');
  if (redes.length < 4) falla(400, 'Escribe tus redes sociales (por ejemplo, tu usuario de TikTok o Instagram).');
  if (body.acepto !== true) falla(400, 'Para enviar tu solicitud acepta las condiciones del programa.');
  if (db.prepare("SELECT 1 FROM influencer_solicitudes WHERE email = ? AND estado = 'nueva'").get(email)) falla(409, 'Ya tenemos tu solicitud. Te escribimos cuando la revisemos.');
  const u = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (u && db.prepare('SELECT 1 FROM influencers WHERE usuario_id = ?').get(u.id)) falla(409, 'Ya eres influencer Vaelo: entra a tu cuenta para ver tu código.');
  db.prepare('INSERT INTO influencer_solicitudes (nombre, email, telefono, redes, seguidores, mensaje) VALUES (?, ?, ?, ?, ?, ?)').run(nombre, email, telefono, redes, seguidores, mensaje);
  avisarStaff({ titulo: 'Nueva solicitud de influencer', cuerpo: `${nombre} (${redes.slice(0, 60)}) quiere ser influencer Vaelo.`, url: RUTA_ADMIN, etiqueta: 'influencer-solicitud' });
  return { _status: 201, ok: true };
});
// El influencer en su cuenta
ruta('GET', '/api/influencer/yo', ({ req }) => {
  const u = requiereRol(req, 'cliente');
  const inf = db.prepare('SELECT * FROM influencers WHERE usuario_id = ?').get(u.id);
  if (!inf) return { influencer: null };
  const out = influencerSalida(inf, true);
  delete out.ajustes_lista;
  out.puntos_por_uso = puntosPorUso();
  return { influencer: out };
});
ruta('POST', '/api/influencer/regalos/:id/pedir', ({ req, params }) => {
  const u = requiereRol(req, 'cliente');
  const inf = db.prepare('SELECT * FROM influencers WHERE usuario_id = ?').get(u.id) || falla(403, 'Esta sección es para influencers Vaelo.');
  const meta = metasInfluencer(inf, puntosInfluencer(inf.id).puntos).find((m) => m.id === Number(params.id)) || falla(404, 'Ese regalo ya no está disponible.');
  if (!meta.alcanzado) falla(400, `Te faltan ${meta.faltan} puntos para este regalo.`);
  if (meta.pedido_en) falla(400, 'Ya pediste este regalo. Te escribimos para entregártelo.');
  db.prepare("INSERT INTO influencer_metas (influencer_id, regalo_id, pedido_en) VALUES (?, ?, datetime('now')) ON CONFLICT(influencer_id, regalo_id) DO UPDATE SET pedido_en = datetime('now')").run(inf.id, meta.id);
  avisarStaff({ titulo: 'Un influencer pidió su regalo', cuerpo: `${u.nombre} (${inf.codigo}) llegó a ${meta.puntos} puntos: ${meta.regalo}.`, url: RUTA_ADMIN, etiqueta: 'influencer-regalo-' + inf.id, urgente: true });
  return { ok: true };
});
// ---------- Zona influencers (panel) ----------
function leerBeneficio(b) {
  const tipo = b.beneficio_tipo === 'monto' ? 'monto' : b.beneficio_tipo === 'precio' ? 'precio' : falla(400, 'Elige qué le da el código al cliente.');
  const valor = redondear(numero(b.beneficio_valor));
  if (!(valor >= 0 && valor <= 500)) falla(400, 'Revisa el monto del beneficio.');
  if (tipo === 'monto' && !(valor > 0)) falla(400, 'Escribe de cuánto es el descuento.');
  return { tipo, valor };
}
function leerCodigo(c, excepto = null) {
  const codigo = texto(c, 24).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9-]{4,24}$/.test(codigo)) falla(400, 'El código lleva de 4 a 24 letras, números o guiones, sin espacios. Ej. VAELO-MARIA');
  if (db.prepare('SELECT 1 FROM influencers WHERE upper(codigo) = ? AND id IS NOT ?').get(codigo, excepto)) falla(409, 'Ese código ya es de otro influencer.');
  if (db.prepare('SELECT 1 FROM promociones WHERE upper(codigo) = ?').get(codigo)) falla(409, 'Ese código ya lo usa una promoción.');
  return codigo;
}
ruta('GET', '/api/admin/influencers', ({ req }) => {
  const quien = requiereStaff(req);
  const lista = db.prepare('SELECT * FROM influencers ORDER BY activo DESC, id DESC').all().map((i) => influencerSalida(i));
  const porEntregar = [];
  for (const i of lista) for (const m of i.metas) if (m.alcanzado && !m.entregado_en) porEntregar.push({ influencer_id: i.id, nombre: i.nombre, codigo: i.codigo, telefono: i.telefono, regalo_id: m.id, regalo: m.regalo, puntos: m.puntos, pedido_en: m.pedido_en });
  return { solicitudes: db.prepare("SELECT * FROM influencer_solicitudes WHERE estado = 'nueva' ORDER BY id").all(), influencers: lista,
    regalos: db.prepare('SELECT * FROM influencer_regalos ORDER BY activo DESC, puntos, id').all(), por_entregar: porEntregar, puntos_por_uso: puntosPorUso(), puede_editar: esAdmin(quien),
    tarifa_zona: vehiculoMoto()?.tarifa_zona ?? 35, piloto_zona: gananciaPiloto(vehiculoMoto()?.tarifa_zona ?? 35) };
});
ruta('GET', '/api/admin/influencers/:id', ({ req, params }) => {
  requiereStaff(req);
  const i = db.prepare('SELECT * FROM influencers WHERE id = ?').get(Number(params.id)) || falla(404, 'No encontramos ese influencer.');
  return { influencer: influencerSalida(i, true) };
});
// «Crearle un código a este influencer»: crea su cuenta (o usa la que ya tiene con ese correo) y le manda un correo para entrar
ruta('POST', '/api/admin/influencers/solicitudes/:id/aprobar', async ({ req, params, body }) => {
  const quien = requiereRol(req, 'admin');
  const s = db.prepare("SELECT * FROM influencer_solicitudes WHERE id = ? AND estado = 'nueva'").get(Number(params.id)) || falla(404, 'No encontramos esa solicitud.');
  const codigo = leerCodigo(body.codigo);
  const ben = leerBeneficio(body);
  let u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(s.email);
  if (u && u.rol !== 'cliente') falla(400, 'Ese correo es de una cuenta del equipo o de un piloto. Pídele otro correo.');
  if (u && db.prepare('SELECT 1 FROM influencers WHERE usuario_id = ?').get(u.id)) falla(409, 'Esa cuenta ya es de un influencer.');
  let nueva = false, token = null;
  db.exec('BEGIN');
  try {
    if (!u) {
      const id = Number(db.prepare("INSERT INTO usuarios (nombre, email, telefono, password_hash, email_verificado, terminos_aceptados, tipo_cuenta) VALUES (?, ?, ?, ?, 0, datetime('now'), 'personal')")
        .run(s.nombre, s.email, s.telefono, hashPassword(crypto.randomBytes(24).toString('hex'))).lastInsertRowid);
      u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id); nueva = true;
      token = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO tokens_clave (token, usuario_id, expira) VALUES (?, ?, ?)').run(token, u.id, Date.now() + 7 * 86400_000);
    }
    db.prepare('INSERT INTO influencers (usuario_id, codigo, beneficio_tipo, beneficio_valor, solicitud_id) VALUES (?, ?, ?, ?, ?)').run(u.id, codigo, ben.tipo, ben.valor, s.id);
    db.prepare("UPDATE influencer_solicitudes SET estado = 'aprobada', usuario_id = ?, revisado_en = datetime('now'), nota = ? WHERE id = ?").run(u.id, `Aprobada por ${quien.nombre.split(' ')[0]}`, s.id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  const parrafos = [`Ya eres influencer Vaelo. Tu código es ${codigo}: quien lo use en su envío recibe ${textoBeneficio({ beneficio_tipo: ben.tipo, beneficio_valor: ben.valor })}.`,
    'Cada vez que un cliente nuevo use tu código y su envío se entregue, sumas puntos. Con tus puntos ganas regalos de Vaelo.'];
  if (nueva) await enviarCorreo(u.email, 'Ya eres influencer Vaelo', correoVaelo(`Hola, ${u.nombre.split(' ')[0]}`, [...parrafos, 'Crea tu contraseña para entrar a tu cuenta y ver tus puntos (el enlace dura 7 días).'],
    { texto: 'Crear mi contraseña', url: `/recuperar?t=${token}` }), `Ya eres influencer Vaelo. Tu código: ${codigo}. Crea tu contraseña: ${URL_SITIO}/recuperar?t=${token}`).catch(() => {});
  else enviarCorreo(u.email, 'Ya eres influencer Vaelo', correoVaelo(`Hola, ${u.nombre.split(' ')[0]}`, [...parrafos, 'Entra a tu cuenta de Vaelo para ver tus puntos.'], { texto: 'Ver mi cuenta', url: '/mi-cuenta?influencer=1' }),
    `Ya eres influencer Vaelo. Tu código: ${codigo}. ${URL_SITIO}/mi-cuenta?influencer=1`).catch(() => {});
  avisar(u.id, { titulo: 'Ya eres influencer Vaelo', cuerpo: `Tu código es ${codigo}. Mira tus puntos en tu cuenta.`, url: '/mi-cuenta?influencer=1', etiqueta: 'influencer' });
  return { _status: 201, ok: true, cuenta_nueva: nueva, codigo };
});
ruta('POST', '/api/admin/influencers/solicitudes/:id/rechazar', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const s = db.prepare("SELECT * FROM influencer_solicitudes WHERE id = ? AND estado = 'nueva'").get(Number(params.id)) || falla(404, 'No encontramos esa solicitud.');
  db.prepare("UPDATE influencer_solicitudes SET estado = 'rechazada', revisado_en = datetime('now'), nota = ? WHERE id = ?").run(texto(body.nota, 300) || null, s.id);
  return { ok: true };
});
ruta('PUT', '/api/admin/influencers/:id', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const i = db.prepare('SELECT * FROM influencers WHERE id = ?').get(Number(params.id)) || falla(404, 'No encontramos ese influencer.');
  const codigo = body.codigo !== undefined ? leerCodigo(body.codigo, i.id) : i.codigo;
  const ben = body.beneficio_tipo !== undefined ? leerBeneficio(body) : { tipo: i.beneficio_tipo, valor: i.beneficio_valor };
  const activo = body.activo === undefined ? i.activo : body.activo ? 1 : 0;
  db.prepare('UPDATE influencers SET codigo = ?, beneficio_tipo = ?, beneficio_valor = ?, activo = ? WHERE id = ?').run(codigo, ben.tipo, ben.valor, activo, i.id);
  return { ok: true, influencer: influencerSalida(db.prepare('SELECT * FROM influencers WHERE id = ?').get(i.id)) };
});
ruta('POST', '/api/admin/influencers/:id/puntos', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const i = db.prepare('SELECT * FROM influencers WHERE id = ?').get(Number(params.id)) || falla(404, 'No encontramos ese influencer.');
  const puntos = Math.round(numero(body.puntos)), nota = texto(body.nota, 200);
  if (!Number.isFinite(puntos) || puntos === 0 || Math.abs(puntos) > 100000) falla(400, 'Escribe cuántos puntos sumar (o restar con un signo menos).');
  if (nota.length < 3) falla(400, 'Escribe el motivo del ajuste.');
  db.prepare('INSERT INTO influencer_ajustes (influencer_id, puntos, nota) VALUES (?, ?, ?)').run(i.id, puntos, nota);
  return { ok: true, ...puntosInfluencer(i.id) };
});
ruta('POST', '/api/admin/influencers/:id/regalos/:regalo/entregado', ({ req, params }) => {
  const quien = requiereRol(req, 'admin');
  const i = db.prepare('SELECT * FROM influencers WHERE id = ?').get(Number(params.id)) || falla(404, 'No encontramos ese influencer.');
  const meta = metasInfluencer(i, puntosInfluencer(i.id).puntos).find((m) => m.id === Number(params.regalo)) || falla(404, 'Ese regalo ya no existe.');
  if (!meta.alcanzado) falla(400, 'Todavía no llega a los puntos de este regalo.');
  db.prepare(`INSERT INTO influencer_metas (influencer_id, regalo_id, entregado_en, entregado_por) VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(influencer_id, regalo_id) DO UPDATE SET entregado_en = datetime('now'), entregado_por = excluded.entregado_por`).run(i.id, meta.id, quien.nombre.split(' ')[0]);
  avisar(i.usuario_id, { titulo: 'Tu regalo de Vaelo va en camino', cuerpo: `${meta.regalo}: gracias por recomendarnos.`, url: '/mi-cuenta?influencer=1', etiqueta: 'influencer-regalo' });
  return { ok: true };
});
// Regalos y puntos por uso
ruta('PUT', '/api/admin/influencers-regalos', ({ req, body }) => {
  requiereRol(req, 'admin');
  const lista = Array.isArray(body.regalos) ? body.regalos : falla(400, 'Faltan los regalos.');
  if (lista.length > 30) falla(400, 'Son demasiados regalos.');
  const ppu = Math.round(numero(body.puntos_por_uso));
  if (!(ppu >= 1 && ppu <= 1000)) falla(400, 'Los puntos por cada cliente van de 1 a 1000.');
  const limpios = lista.map((r) => {
    const regalo = texto(r.regalo, 80), puntos = Math.round(numero(r.puntos));
    if (regalo.length < 2) falla(400, 'Escribe el nombre de cada regalo.');
    if (!(puntos >= 1 && puntos <= 1000000)) falla(400, `Revisa los puntos de «${regalo}».`);
    return { id: Number(r.id) || null, regalo, puntos, activo: r.activo === false ? 0 : 1 };
  });
  db.exec('BEGIN');
  try {
    // Los regalos que ya alguien ganó no se borran (se apagan) para no perder su historial
    const ids = new Set(limpios.filter((r) => r.id).map((r) => r.id));
    for (const r of db.prepare('SELECT id FROM influencer_regalos').all()) {
      if (ids.has(r.id)) continue;
      if (db.prepare('SELECT 1 FROM influencer_metas WHERE regalo_id = ?').get(r.id)) db.prepare('UPDATE influencer_regalos SET activo = 0 WHERE id = ?').run(r.id);
      else db.prepare('DELETE FROM influencer_regalos WHERE id = ?').run(r.id);
    }
    for (const r of limpios) {
      if (r.id && db.prepare('SELECT 1 FROM influencer_regalos WHERE id = ?').get(r.id)) db.prepare('UPDATE influencer_regalos SET regalo = ?, puntos = ?, activo = ? WHERE id = ?').run(r.regalo, r.puntos, r.activo, r.id);
      else db.prepare('INSERT INTO influencer_regalos (regalo, puntos, activo) VALUES (?, ?, ?)').run(r.regalo, r.puntos, r.activo);
    }
    db.prepare("INSERT INTO ajustes (clave, valor) VALUES ('influencer_puntos_uso', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor").run(String(ppu));
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { ok: true };
});

// ---------- Crear envíos (uno o por archivo) ----------
// fecha y hora de Guatemala "AAAA-MM-DDTHH:MM" -> texto UTC de la base
function programadoUtc(v) {
  const t = texto(v, 16);
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t)) falla(400, 'Revisa la fecha y hora programadas.');
  const ms = Date.parse(t + ':00Z') + 6 * 3600_000;
  if (!Number.isFinite(ms)) falla(400, 'Revisa la fecha y hora programadas.');
  if (ms < Date.now() + 20 * 60_000) falla(400, 'Programa el envío con al menos 30 minutos de anticipación.');
  if (ms > Date.now() + 14 * 86400_000) falla(400, 'Solo se puede programar hasta 14 días adelante.');
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}
function validarPedido(u, body) {
  const d = {
    origen_direccion: texto(body.origen_direccion, 300), origen_telefono: texto(body.origen_telefono, 30) || u.telefono,
    destino_nombre: texto(body.destino_nombre, 100), destino_telefono: texto(body.destino_telefono, 30), destino_direccion: texto(body.destino_direccion, 300),
    descripcion: texto(body.descripcion, 200), notas: texto(body.notas, 300), metodo_pago: texto(body.metodo_pago, 20) || 'efectivo',
    cobro_destinatario: body.cobro_destinatario === '' || body.cobro_destinatario == null ? 0 : numero(body.cobro_destinatario),
  };
  d.origen_quien = body.origen_quien === 'tercero' ? 'tercero' : body.origen_quien === 'sede' && body._lote_sede_id ? 'sede' : 'cliente';
  d.origen_nombre = d.origen_quien === 'tercero' ? texto(body.origen_nombre, 100) : null;
  if (d.origen_quien === 'tercero' && d.origen_nombre.length < 2) falla(400, 'Escribe el nombre de quien entrega el paquete al piloto.');
  if (d.origen_telefono.replace(/\D/g, '').length < 8) falla(400, d.origen_quien === 'tercero' ? 'Escribe el teléfono de quien entrega el paquete (8 dígitos).' : 'Escribe un teléfono de contacto para la recogida.');
  if (d.destino_nombre.length < 2) falla(400, 'Escribe el nombre de quien recibe.');
  if (d.destino_telefono.replace(/\D/g, '').length < 8) falla(400, 'Escribe el teléfono de quien recibe (8 dígitos).');
  if (!METODOS_PAGO.includes(d.metodo_pago)) falla(400, 'Elige cómo vas a pagar el envío.');
  const cuenta = db.prepare('SELECT credito_permitido, tipo_cuenta FROM usuarios WHERE id = ?').get(u.id) || {};
  // Varios paquetes a la misma dirección (empresas): mismo precio
  d.paquetes = cuenta.tipo_cuenta === 'empresa' ? Math.min(30, Math.max(1, Math.round(numero(body.paquetes)) || 1)) : 1;
  if (Array.isArray(body.extras) && body.extras.length) d.paquetes = Math.max(d.paquetes, 1 + Math.min(body.extras.length, MAX_PAQUETES_ENVIO - 1));
  if (!Number.isFinite(d.cobro_destinatario) || d.cobro_destinatario < 0 || d.cobro_destinatario > 50000) falla(400, 'El monto a cobrar a quien recibe no es válido.');
  return d;
}
function insertarEnvio(u, body, d, c, desc, programado, grupo = null) {
  // La recogida es donde está quien pide (su ubicación al enviar) o, si entrega otra persona, donde ella comparta la suya.
  // La entrega es donde comparta su ubicación quien recibe: al crear el envío todavía no hay punto.
  const o = d.origen_quien === 'cliente' ? coordenada(body.origen_lat, body.origen_lng) : d.origen_quien === 'sede' ? sedeUbicacion() : null, de = null;
  if (d.origen_quien === 'sede' && !o) falla(400, 'Falta la ubicación de la sede de Vaelo. Avísanos para configurarla.');
  if (d.origen_quien === 'cliente' && !o) falla(400, 'Necesitamos tu ubicación actual: el piloto llega a recoger a donde estás. Activa la ubicación (GPS) y permite que Vaelo la use.');
  const guia = nuevaGuia();
  const codigo = String(crypto.randomInt(1000, 10000));
  const token = nuevoTokenReceptor();
  const tokenEntrega = d.origen_quien === 'tercero' ? nuevoTokenReceptor() : null;
  const r = db.prepare(`INSERT INTO envios
    (guia, usuario_id, vehiculo_id, peso, descripcion, origen_direccion, origen_zona, origen_telefono, origen_lat, origen_lng,
     destino_nombre, destino_telefono, destino_direccion, destino_zona, destino_lat, destino_lng,
     tipo_tarifa, km, precio, metodo_pago, cobro_destinatario, notas, fragil, recargo_fragil,
     precio_base, descuento, promocion_id, codigo_entrega, programado_para, receptor_token,
     origen_quien, origen_nombre, origen_token, origen_ubic_fecha, origen_precision, precio_por_confirmar,
     valor_declarado, seguro, grupo, precio_o_lat, precio_o_lng, pago_estado, paquetes, lote_sede_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${o ? "datetime('now')" : 'NULL'}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    guia, u.id, c.vehiculo.id, c.peso, d.descripcion, d.origen_direccion, texto(body.origen_zona, 60), d.origen_telefono,
    o ? o.lat : null, o ? o.lng : null, d.destino_nombre, d.destino_telefono, d.destino_direccion, texto(body.destino_zona, 60),
    de ? de.lat : null, de ? de.lng : null, c.tipo === 'zona' ? 'zona' : 'km', c.km, desc.precio, d.metodo_pago, redondear(d.cobro_destinatario), d.notas,
    c.fragil ? 1 : 0, c.recargo_fragil, c.precio, desc.descuento, desc.promocion_id, codigo, programado, token,
    d.origen_quien, d.origen_nombre, tokenEntrega, o ? (Number.isFinite(numero(body.origen_precision)) ? Math.round(numero(body.origen_precision)) : null) : null, c.por_confirmar ? 1 : 0,
    c.valor_declarado || 0, c.seguro || 0, grupo, o ? o.lat : null, o ? o.lng : null, d.metodo_pago === 'transferencia' ? 'sin_comprobante' : null,
    d.paquetes || 1, body._lote_sede_id || null);
  // Foto del paquete que tomó el cliente: muestra qué lleva desde antes de recogerlo
  if (body.foto_paquete) guardarArchivoEnvio(Number(r.lastInsertRowid), 'paquete', body.foto_paquete);
  const id = Number(r.lastInsertRowid);
  // Código de influencer: suma puntos cuando se entregue; el piloto gana lo de un envío sin descuento
  if (desc.influencer_id) db.prepare('UPDATE envios SET influencer_id = ?, influencer_puntos = ?, ganancia_acordada = ? WHERE id = ?').run(desc.influencer_id, puntosPorUso(), gananciaPiloto(c.precio), id);
  // Si con este ya son 2 o más en curso, primero reciben código los que ya estaban (en orden) y luego este
  for (const o of db.prepare("SELECT id FROM envios WHERE usuario_id = ? AND id != ? AND pedido_id IS NULL AND codigo_corto IS NULL AND estado = 'pendiente' ORDER BY id").all(u.id, id)) codigoCortoEnvio(o.id);
  const codigoCorto = codigoCortoEnvio(id);
  // Envío suelto con cobro: si quien manda lo pide, el piloto le lleva el dinero cobrado a donde recogió el paquete
  if (body.devolver_cobro === true && !body._lote_sede_id && Number(d.cobro_destinatario) > 0) db.prepare('UPDATE envios SET devolver_cobro = 1 WHERE id = ?').run(id);
  if (body._extras && body._extras.length) guardarExtras(id, body._extras);
  // Los cargos pendientes del cliente (cancelación, devolución, sede) se cobran junto con este envío
  const extra = sumarCargosPendientes(u.id, id);
  const nota = programado ? 'Solicitud recibida (programada)' : 'Solicitud recibida';
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(id, 'pendiente', nota + (desc.promocion ? `. Descuento: ${desc.promocion}` : ''));
  return { id, guia, codigo_corto: codigoCorto, precio: desc.precio, descuento: desc.descuento, cargos_extra: extra, codigo_entrega: codigo, enlace_receptor: '/recibe/' + token,
    enlace_entrega: tokenEntrega ? '/entrega/' + tokenEntrega : null, exige_receptor: exigeReceptor(), precio_por_confirmar: !!c.por_confirmar };
}
function guardarDireccion(usuarioId, nombre, datos) {
  const n = texto(nombre, 40);
  if (!n) return;
  if (db.prepare('SELECT COUNT(*) n FROM direcciones WHERE usuario_id = ?').get(usuarioId).n >= 30) return;
  db.prepare('INSERT INTO direcciones (usuario_id, nombre, direccion, zona, telefono, contacto, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(usuarioId, n, datos.direccion, datos.zona, datos.telefono || null, datos.contacto || null, datos.lat ?? null, datos.lng ?? null);
}
function revisarClienteParaEnviar(u) {
  if (u.rol !== 'cliente') return;
  const f = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.id);
  if (correoActivo() && !f.email_verificado) falla(403, 'Confirma tu correo antes de enviar. Te mandamos un enlace a ' + f.email + '.');
}

ruta('POST', '/api/envios', async ({ req, body }) => {
  delete body._lote_sede_id;
  const u = requiereUsuario(req);
  revisarClienteParaEnviar(u);
  body._extras = prepararExtras(body);
  const d = validarPedido(u, body);
  if (!body.foto_paquete) falla(400, 'Toma una foto del paquete: así queda registrado qué lleva antes de recogerlo.');
  const programado = programadoUtc(body.programado_para);
  const c = await cotizar(body);
  const desc = mejorDescuento(c.precio, u.id, body.cupon);
  if (desc.errorCupon) falla(400, desc.errorCupon);
  db.exec('BEGIN');
  try {
    const out = insertarEnvio(u, body, d, c, desc, programado);
    if (body.guardar_destino) guardarDireccion(u.id, body.guardar_destino, { direccion: d.destino_direccion, zona: texto(body.destino_zona, 60), telefono: d.destino_telefono, contacto: d.destino_nombre });
    db.exec('COMMIT');
    avisarEnvio(out.id, 'nuevo');
    return { _status: 201, ...out };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}, { limite: 1_200_000 });

// Caja de envíos: varios destinatarios desde el mismo punto de recogida, en un solo viaje.
// Cada uno lleva su foto del paquete y su enlace para que quien recibe comparta su ubicación y sus datos.
const MAX_CAJA = 10;
ruta('POST', '/api/envios/caja', async ({ req, body }) => {
  const u = requiereUsuario(req);
  revisarClienteParaEnviar(u);
  const lista = Array.isArray(body.envios) ? body.envios : [];
  if (lista.length < 1) falla(400, 'Agrega al menos un envío a la caja.');
  if (lista.length > MAX_CAJA) falla(400, `La caja lleva hasta ${MAX_CAJA} envíos. Manda estos y arma otra.`);
  const programado = programadoUtc(body.programado_para);
  const comun = { vehiculo_id: body.vehiculo_id, metodo_pago: body.metodo_pago, origen_quien: body.origen_quien, origen_nombre: body.origen_nombre, origen_telefono: body.origen_telefono,
    origen_zona: body.origen_zona, origen_direccion: body.origen_direccion, origen_lat: body.origen_lat, origen_lng: body.origen_lng, origen_precision: body.origen_precision, cupon: body.cupon };
  const preparados = [], errores = [];
  for (const [i, x] of lista.entries()) {
    const b = { ...comun, peso: x.peso, descripcion: x.descripcion, fragil: x.fragil, paquetes: x.paquetes, foto_paquete: x.foto_paquete, extras: x.extras,
      destino_nombre: x.destino_nombre, destino_telefono: x.destino_telefono, destino_zona: x.destino_zona, destino_direccion: x.destino_direccion,
      cobro_destinatario: x.cobro_destinatario, notas: x.notas };
    try {
      if (!b.foto_paquete) falla(400, 'falta la foto del paquete');
      b._extras = prepararExtras(b);
      const d = validarPedido(u, b);
      const c = await cotizar(b);
      const desc = mejorDescuento(c.precio, u.id, i === 0 ? body.cupon : null);
      if (desc.errorCupon) falla(400, desc.errorCupon);
      preparados.push({ b, d, c, desc });
    } catch (err) { errores.push(`Envío ${i + 1} (${texto(x.destino_nombre, 40) || 'sin nombre'}): ${err.message}`); }
  }
  if (errores.length) return { _status: 400, ok: false, error: errores[0], errores };
  db.exec('BEGIN');
  let creados;
  try {
    // Todos salen del mismo lugar: la asignación automática los ofrece juntos al mismo piloto
    const grupo = preparados.length > 1 ? 'G' + crypto.randomBytes(6).toString('hex') : null;
    creados = preparados.map((x) => ({ ...insertarEnvio(u, x.b, x.d, x.c, x.desc, programado, grupo), destino_nombre: x.d.destino_nombre, destino_telefono: x.d.destino_telefono }));
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  for (const x of creados) avisarEnvio(x.id, 'nuevo');
  return { _status: 201, ok: true, envios: creados, total: redondear(creados.reduce((t, x) => t + x.precio, 0)) };
}, { limite: 9_000_000 });

ruta('GET', '/api/envios/:id/paquete/:n', ({ req, res, params }) => {
  const u = requiereUsuario(req);
  const e = db.prepare('SELECT id FROM envios WHERE id = ? AND usuario_id = ?').get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
  return enviarFotoExtra(res, e.id, params.n);
});
ruta('GET', '/api/envios/:id/entrega/:tipo', ({ req, res, params }) => {
  const u = requiereUsuario(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND usuario_id = ?').get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
  if (!['foto', 'firma', 'fallo', 'comprobante', 'paquete'].includes(params.tipo)) falla(404, 'No hay archivo.');
  return enviarArchivoEnvio(res, e, params.tipo);
});

// ---------- Direcciones guardadas ----------
ruta('GET', '/api/direcciones', ({ req }) => ({ direcciones: db.prepare('SELECT * FROM direcciones WHERE usuario_id = ? ORDER BY nombre').all(requiereUsuario(req).id) }));
ruta('POST', '/api/direcciones', ({ req, body }) => {
  const u = requiereUsuario(req);
  const nombre = texto(body.nombre, 40), direccion = texto(body.direccion, 300), zona = texto(body.zona, 60);
  if (nombre.length < 2) falla(400, 'Ponle un nombre, por ejemplo Casa u Oficina.');
  if (direccion.length < 5) falla(400, 'Escribe la dirección.');
  if (!zona) falla(400, 'Elige la zona.');
  const c = coordenada(body.lat, body.lng);
  guardarDireccion(u.id, nombre, { direccion, zona, telefono: texto(body.telefono, 30), contacto: texto(body.contacto, 100), lat: c?.lat, lng: c?.lng });
  return { _status: 201, ok: true };
});
ruta('DELETE', '/api/direcciones/:id', ({ req, params }) => {
  const u = requiereUsuario(req);
  db.prepare('DELETE FROM direcciones WHERE id = ? AND usuario_id = ?').run(Number(params.id), u.id);
  return { ok: true };
});


// ---------- Ubicaciones en vivo: quien entrega el paquete y quien recibe ----------
// Recogida: donde está quien pide (comparte su ubicación desde su cuenta) u otra persona con su enlace (/entrega/<clave>).
// Entrega: donde está quien recibe (enlace /recibe/<clave>). Los puntos de recogida y entrega del envío se mueven con
// esas ubicaciones hasta que se recoge y se entrega. La foto es opcional. Mientras falte alguna ubicación, el paquete
// no se recoge (el panel puede autorizar una excepción, y se puede apagar en Tarifas y ajustes).
const ESTADOS_ACTIVOS = ['pendiente', 'recogido', 'en_camino'];
const nuevoTokenReceptor = () => crypto.randomBytes(16).toString('hex');
const exigeReceptor = () => getAjustes().exigir_receptor !== '0';
const origenListo = (e) => e.origen_quien === 'tercero' ? !!e.origen_confirmado_en : e.origen_lat != null;
const destinoListo = (e) => !!e.receptor_confirmado_en;
const receptorListo = (e) => !!e.receptor_omitido || !exigeReceptor() || (origenListo(e) && destinoListo(e));
const segundosDesde = (t) => t ? Math.round((Date.now() - fechaMs(t)) / 1000) : null;
function tokenReceptor(e) {
  if (e.receptor_token) return e.receptor_token;
  db.prepare('UPDATE envios SET receptor_token = ? WHERE id = ? AND receptor_token IS NULL').run(nuevoTokenReceptor(), e.id);
  return db.prepare('SELECT receptor_token FROM envios WHERE id = ?').get(e.id).receptor_token;
}
// Lo que ven el piloto y el panel de quien recibe. "historial" (solo panel) deja ver el último punto aunque esté cerrado.
function datosReceptor(e, historial = false) {
  const activo = ESTADOS_ACTIVOS.includes(e.estado);
  const verPunto = e.receptor_lat != null && (activo || historial);
  const segundos = segundosDesde(e.receptor_ubic_fecha);
  return {
    confirmado: !!e.receptor_confirmado_en, confirmado_en: e.receptor_confirmado_en, omitido: e.receptor_omitido || null,
    listo: receptorListo(e), exigido: exigeReceptor(), nombre: e.receptor_nombre || e.destino_nombre, tiene_foto: !!e.receptor_foto,
    lat: verPunto ? e.receptor_lat : null, lng: verPunto ? e.receptor_lng : null, precision: verPunto ? e.receptor_precision : null,
    actualizado: verPunto ? e.receptor_ubic_fecha : null, segundos: verPunto ? segundos : null,
    en_vivo: activo && segundos != null && segundos < 120,
  };
}
// Quien entrega el paquete al piloto (el cliente o la persona del enlace)
function datosOrigen(e, historial = false) {
  const activo = e.estado === 'pendiente';
  const verPunto = e.origen_lat != null && (activo || historial);
  const segundos = segundosDesde(e.origen_ubic_fecha);
  const cliente = e.origen_quien !== 'tercero';
  const fotoCliente = cliente ? !!db.prepare('SELECT foto_perfil FROM usuarios WHERE id = ?').get(e.usuario_id)?.foto_perfil : false;
  return {
    quien: cliente ? 'cliente' : 'tercero', nombre: cliente ? (e.cliente_nombre || null) : e.origen_nombre, telefono: e.origen_telefono,
    confirmado: origenListo(e), tiene_foto: cliente ? fotoCliente : !!e.origen_foto,
    lat: verPunto ? e.origen_lat : null, lng: verPunto ? e.origen_lng : null, actualizado: verPunto ? e.origen_ubic_fecha : null,
    segundos: verPunto ? segundos : null, en_vivo: activo && segundos != null && segundos < 120,
  };
}
const CAMPOS_RECEPTOR = ['flete_token', 'receptor_token', 'receptor_foto', 'receptor_lat', 'receptor_lng', 'receptor_precision', 'receptor_ubic_fecha', 'receptor_nombre', 'receptor_confirmado_en', 'receptor_omitido',
  'origen_token', 'origen_foto', 'origen_precision', 'origen_ubic_fecha', 'origen_confirmado_en'];
const sinCamposReceptor = (out) => { for (const k of CAMPOS_RECEPTOR) delete out[k]; return out; };

// El enlace puede ser de quien recibe (rol "recibe") o de quien entrega el paquete (rol "entrega")
function envioPorToken(token) {
  const malo = 'Este enlace no es válido. Pide a quien te envía el paquete que te lo mande de nuevo.';
  if (!/^[a-f0-9]{32}$/.test(String(token || ''))) falla(404, malo);
  const e = db.prepare(`SELECT e.*, v.nombre AS vehiculo, u.nombre AS remitente, u.tipo_cuenta, u.empresa_nombre
    FROM envios e JOIN vehiculos v ON v.id = e.vehiculo_id JOIN usuarios u ON u.id = e.usuario_id WHERE e.receptor_token = ? OR e.origen_token = ?`).get(token, token);
  if (!e) falla(404, malo);
  e._rol = e.receptor_token === token ? 'recibe' : 'entrega';
  return e;
}
const precisionDe = (v) => { const n = numero(v); return Number.isFinite(n) ? Math.round(n) : null; };
// Quien recibe: su ubicación es el punto de entrega mientras el envío está activo
function guardarPosicionReceptor(e, c, precision) {
  db.prepare(`UPDATE envios SET receptor_lat = ?, receptor_lng = ?, receptor_precision = ?, receptor_ubic_fecha = datetime('now'),
    destino_lat = ?, destino_lng = ? WHERE id = ?`).run(c.lat, c.lng, precisionDe(precision), c.lat, c.lng, e.id);
}
// Quien entrega: su ubicación es el punto de recogida mientras no se recoja
function guardarPosicionOrigen(id, c, precision) {
  db.prepare("UPDATE envios SET origen_lat = ?, origen_lng = ?, origen_precision = ?, origen_ubic_fecha = datetime('now') WHERE id = ? AND estado = 'pendiente'")
    .run(c.lat, c.lng, precisionDe(precision), id);
}
// Precio con los puntos reales: al conocerse las dos ubicaciones se confirma (tarifa fija solo si caen dentro de las zonas
// cubiertas; si no, por km). Si después la recogida o la entrega se mueven más de 1 km, se vuelve a calcular.
// Zona real: con las zonas dibujadas, el nombre de la zona se corrige con la ubicación que comparten (recogida mientras no se
// recoja; entrega siempre). Así el piloto ve la zona verdadera aunque el cliente haya elegido otra.
function corregirZonas(id) {
  const formas = zonasConForma();
  if (!formas.length) return;
  const e = db.prepare('SELECT id, estado, origen_zona, destino_zona, origen_lat, origen_lng, destino_lat, destino_lng FROM envios WHERE id = ?').get(id);
  if (!e || !ESTADOS_ACTIVOS.includes(e.estado)) return;
  const real = (lat, lng) => zonaDeFormas({ lat, lng }, formas) || OTRA_ZONA;
  const cambios = [];
  if (e.estado === 'pendiente' && e.origen_lat != null) {
    const z = real(e.origen_lat, e.origen_lng);
    if (z !== e.origen_zona) { db.prepare('UPDATE envios SET origen_zona = ? WHERE id = ?').run(z, id); cambios.push(`recogida: eligieron ${e.origen_zona}, la ubicación real es ${z}`); }
  }
  if (e.destino_lat != null) {
    const z = real(e.destino_lat, e.destino_lng);
    if (z !== e.destino_zona) { db.prepare('UPDATE envios SET destino_zona = ? WHERE id = ?').run(z, id); cambios.push(`entrega: eligieron ${e.destino_zona}, la ubicación real es ${z}`); }
  }
  if (cambios.length) db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(id, e.estado, 'Zona corregida con la ubicación real (' + cambios.join('; ') + ')');
}
async function revisarPrecio(id) {
  corregirZonas(id);
  const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(id);
  // Los fletes tienen el precio que acordó la oficina: no se recalcula
  if (!e || e.flete || !['pendiente', 'recogido', 'en_camino'].includes(e.estado) || e.origen_lat == null || e.destino_lat == null) return;
  const o = { lat: e.origen_lat, lng: e.origen_lng }, d = { lat: e.destino_lat, lng: e.destino_lng };
  const movido = (lat, lng, p) => lat == null || distanciaRecta({ lat, lng }, p) > 1;
  if (!e.precio_por_confirmar && !movido(e.precio_o_lat, e.precio_o_lng, o) && !movido(e.precio_d_lat, e.precio_d_lng, d)) return;
  const v = db.prepare('SELECT * FROM vehiculos WHERE id = ?').get(e.vehiculo_id);
  const km = Math.round(distanciaRecta(o, d) * 1.3 * 10) / 10;
  const fija = aplicaTarifaFija(e.origen_zona, e.destino_zona, o, d, km);
  const viaje = fija ? v.tarifa_zona : tarifaFuera(v);
  const base = redondear(viaje + (e.recargo_fragil || 0) + (e.seguro || 0));
  let descuento = 0;
  const p = e.promocion_id ? db.prepare('SELECT * FROM promociones WHERE id = ?').get(e.promocion_id) : null;
  const infl = e.influencer_id ? db.prepare('SELECT * FROM influencers WHERE id = ?').get(e.influencer_id) : null;
  if (p) descuento = montoPromo(p, base);
  else if (infl) descuento = infl.beneficio_tipo === 'precio' ? Math.max(0, redondear(base - infl.beneficio_valor)) : redondear(Math.min(base, infl.beneficio_valor));
  else if (e.descuento > 0) {
    const u = db.prepare('SELECT tipo_cuenta, descuento_empresa FROM usuarios WHERE id = ?').get(e.usuario_id);
    if (u && u.tipo_cuenta === 'empresa' && u.descuento_empresa > 0) descuento = redondear((base * Math.min(100, u.descuento_empresa)) / 100);
  }
  const precio = redondear(base - descuento);
  const r = db.prepare(`UPDATE envios SET tipo_tarifa = ?, km = ?, precio_base = ?, descuento = ?, precio = ?, precio_por_confirmar = 0,
      precio_o_lat = ?, precio_o_lng = ?, precio_d_lat = ?, precio_d_lng = ? WHERE id = ? AND estado IN ('pendiente','recogido','en_camino')`)
    .run(fija ? 'zona' : 'km', km, base, descuento, precio, o.lat, o.lng, d.lat, d.lng, id);
  if (r.changes && infl) db.prepare('UPDATE envios SET ganancia_acordada = ? WHERE id = ?').run(gananciaPiloto(base), id);
  if (!r.changes || Math.abs(precio - e.precio) < 0.01) return;
  const razon = e.tipo_tarifa === 'zona' && !fija ? 'La entrega queda fuera de las zonas preferenciales' : fija && e.tipo_tarifa !== 'zona' ? 'La entrega está en una zona preferencial' : 'Cambió el punto de recogida o de entrega';
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(id, e.estado, `${razon}: ${'Q' + precio.toFixed(2)}`);
  avisarEnvio(id, 'precio', { precio, razon });
}

ruta('GET', '/api/recibe/:token', ({ params }) => {
  const e = envioPorToken(params.token);
  const entrega = e._rol === 'entrega';
  // Para quien entrega, el enlace sirve hasta que el piloto recoge el paquete
  const activo = entrega ? e.estado === 'pendiente' : ESTADOS_ACTIVOS.includes(e.estado);
  let piloto = null;
  if (activo && e.mensajero_id && e.asignacion === 'aceptado') {
    const p = pilotoPorId(e.mensajero_id);
    const vivo = p && p.ubic_fecha && Date.now() - fechaMs(p.ubic_fecha) < 10 * 60_000;
    if (p) piloto = { nombre: p.nombre.split(' ')[0], vehiculo: p.vehiculo, color: p.veh_color, placa: p.veh_placa, tiene_foto: !!p.foto_perfil, telefono: p.telefono,
      lat: vivo ? p.ubic_lat : null, lng: vivo ? p.ubic_lng : null, actualizado: vivo ? p.ubic_fecha : null };
  }
  const confirmado = entrega ? !!e.origen_confirmado_en : !!e.receptor_confirmado_en;
  return {
    rol: e._rol, guia: e.guia, estado: e.estado, activo, vehiculo: e.vehiculo, fragil: !!e.fragil, descripcion: e.descripcion,
    remitente: e.flete ? (e.flete_cliente || 'Vaelo').split(/\s+/)[0] : esNegocio(e) && e.empresa_nombre ? e.empresa_nombre : (e.remitente || '').split(/\s+/)[0],
    destinatario: e.destino_nombre, destino_zona: e.destino_zona, referencias: entrega ? e.origen_direccion : e.destino_direccion,
    nombre_sugerido: entrega ? e.origen_nombre : e.destino_nombre, origen_zona: e.origen_zona,
    // Lo que paga quien recibe al tener el paquete: el envío si "paga quien recibe" y lo que pidió cobrar quien envía
    cobro: entrega ? 0 : redondear((Number(e.cobro_destinatario) || 0) + (e.metodo_pago === 'recibe' ? (Number(e.precio) || 0) : 0)),
    paga_envio: !entrega && e.metodo_pago === 'recibe', precio_envio: !entrega && e.metodo_pago === 'recibe' ? Number(e.precio) || 0 : 0, programado_para: e.programado_para,
    confirmado, omitido: !!e.receptor_omitido, exigido: exigeReceptor(),
    // El código solo lo ve quien recibe y cuando ya confirmó: lo da al piloto al tener el paquete en la mano
    codigo_entrega: !entrega && activo && (confirmado || e.receptor_omitido) ? e.codigo_entrega : null,
    piloto, recibio: entrega ? null : e.recibio, entregado_en: entrega ? null : e.entregado_en,
    puede_calificar: !entrega && e.estado === 'entregado' && !!e.mensajero_id && !e.calif_receptor, calificacion: entrega ? null : e.calif_receptor || null,
    piloto_nombre: !entrega && e.estado === 'entregado' && e.mensajero_id ? (db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(e.mensajero_id)?.nombre || '').split(' ')[0] : null,
  };
});

ruta('GET', '/api/recibe/:token/foto-piloto', ({ res, params }) => {
  const e = envioPorToken(params.token);
  const activo = e._rol === 'entrega' ? e.estado === 'pendiente' : ESTADOS_ACTIVOS.includes(e.estado);
  if (!e.mensajero_id || e.asignacion !== 'aceptado' || !activo) falla(404, 'No hay foto.');
  return enviarDocumento(res, e.mensajero_id, 'foto');
});

ruta('POST', '/api/recibe/:token/confirmar', async ({ req, params, body }) => {
  if (limitar(ipDe(req), 'recibe-confirmar', 20, 3600_000)) falla(429, 'Demasiados intentos. Espera un momento.');
  const e = envioPorToken(params.token);
  const entrega = e._rol === 'entrega';
  if (entrega && e.estado !== 'pendiente') falla(400, e.estado === 'cancelado' ? 'Este envío fue cancelado.' : 'El piloto ya recogió este paquete.');
  if (!ESTADOS_ACTIVOS.includes(e.estado)) falla(400, e.estado === 'entregado' ? 'Este paquete ya fue entregado.' : 'Este envío fue cancelado.');
  const nombre = texto(body.nombre, 100);
  if (nombre.length < 3) falla(400, 'Escribe tu nombre completo.');
  const c = coordenada(body.lat, body.lng);
  if (!c) falla(400, 'Necesitamos tu ubicación. Activa la ubicación (GPS) del teléfono y permite que esta página la use.');
  // La foto es opcional
  if (body.foto) guardarArchivoEnvio(e.id, entrega ? 'origen' : 'receptor', body.foto);
  if (entrega) {
    const primera = !e.origen_confirmado_en;
    db.prepare("UPDATE envios SET origen_nombre = ?, origen_confirmado_en = COALESCE(origen_confirmado_en, datetime('now')) WHERE id = ?").run(nombre, e.id);
    guardarPosicionOrigen(e.id, c, body.precision);
    if (primera) db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, `${nombre.split(' ')[0]} compartió su ubicación para entregar el paquete al piloto`);
  } else {
    const primera = !e.receptor_confirmado_en;
    db.prepare("UPDATE envios SET receptor_nombre = ?, receptor_confirmado_en = COALESCE(receptor_confirmado_en, datetime('now')) WHERE id = ?").run(nombre, e.id);
    guardarPosicionReceptor(e, c, body.precision);
    if (primera) db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, `${nombre.split(' ')[0]} confirmó que recibe y comparte su ubicación`);
  }
  await revisarPrecio(e.id);
  return { ok: true };
}, { limite: 1_500_000 });

ruta('POST', '/api/recibe/:token/ubicacion', async ({ params, body }) => {
  const e = envioPorToken(params.token);
  const entrega = e._rol === 'entrega';
  if (entrega ? e.estado !== 'pendiente' : !ESTADOS_ACTIVOS.includes(e.estado)) return { ok: true, terminado: true };
  if (!(entrega ? e.origen_confirmado_en : e.receptor_confirmado_en)) falla(400, 'Primero confirma tu nombre y tu ubicación.');
  if (limitar(params.token, 'recibe-ubicacion', 30, 60_000)) return { ok: true };
  const c = coordenada(body.lat, body.lng);
  if (!c) falla(400, 'Ubicación no válida.');
  if (entrega) guardarPosicionOrigen(e.id, c, body.precision); else guardarPosicionReceptor(e, c, body.precision);
  await revisarPrecio(e.id);
  return { ok: true };
});

// Quien pide comparte su ubicación desde su cuenta mientras esperan que recojan sus paquetes
ruta('POST', '/api/yo/ubicacion', async ({ req, body }) => {
  const u = requiereUsuario(req);
  if (limitar(String(u.id), 'cliente-ubicacion', 30, 60_000)) return { ok: true };
  const c = coordenada(body.lat, body.lng);
  if (!c) falla(400, 'Ubicación no válida.');
  const ids = db.prepare("SELECT id FROM envios WHERE usuario_id = ? AND origen_quien = 'cliente' AND estado = 'pendiente'").all(u.id).map((x) => x.id);
  for (const id of ids) { guardarPosicionOrigen(id, c, body.precision); await revisarPrecio(id); }
  return { ok: true, envios: ids.length };
});

// Piloto: fotos de quien entrega y de quien recibe (solo mientras lleva el envío)
ruta('GET', '/api/piloto/envios/:id/foto-receptor', ({ req, res, params }) => {
  const p = requierePiloto(req);
  const e = db.prepare("SELECT * FROM envios WHERE id = ? AND mensajero_id = ? AND asignacion = 'aceptado' AND estado IN ('pendiente','recogido','en_camino')").get(Number(params.id), p.id);
  if (!e) falla(404, 'No hay foto.');
  return enviarArchivoEnvio(res, e, 'receptor');
});
ruta('GET', '/api/piloto/envios/:id/foto-entrega', ({ req, res, params }) => {
  const p = requierePiloto(req);
  const e = db.prepare("SELECT * FROM envios WHERE id = ? AND mensajero_id = ? AND asignacion = 'aceptado' AND estado = 'pendiente'").get(Number(params.id), p.id);
  if (!e) falla(404, 'No hay foto.');
  if (e.origen_quien !== 'tercero') return enviarDocumento(res, e.usuario_id, 'foto');
  return enviarArchivoEnvio(res, e, 'origen');
});

// Panel: autorizar sin las ubicaciones en vivo (por ejemplo, alguien sin internet) o volver a pedirlas
ruta('POST', '/api/admin/envios/:id/receptor', ({ req, params, body }) => {
  const quien = requiereStaff(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  if (!ESTADOS_ACTIVOS.includes(e.estado)) falla(400, 'Este envío ya está cerrado.');
  if (body.omitir) {
    const motivo = texto(body.motivo, 200);
    if (motivo.length < 4) falla(400, 'Escribe por qué se autoriza (por ejemplo: confirmó por llamada, no tiene internet).');
    db.prepare('UPDATE envios SET receptor_omitido = ? WHERE id = ?').run(`${motivo} (${quien.nombre.split(' ')[0]})`, e.id);
    db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, `Vaelo autorizó el envío sin las ubicaciones en vivo: ${motivo}`);
  } else {
    db.prepare('UPDATE envios SET receptor_omitido = NULL WHERE id = ?').run(e.id);
  }
  return { ok: true };
});


// ---------- Rastreo público con el piloto en vivo ----------
ruta('GET', '/api/rastreo/:guia', ({ params }) => {
  const guia = decodeURIComponent(params.guia).toUpperCase().replace(/\s+/g, '');
  const e = db.prepare(`SELECT e.*, v.nombre AS vehiculo FROM envios e JOIN vehiculos v ON v.id = e.vehiculo_id WHERE e.guia = ?`).get(guia);
  if (!e) falla(404, 'No encontramos un envío con esa guía. Revisa que esté bien escrita, por ejemplo VA-7K3M9QX2.');
  let piloto = null;
  if (e.mensajero_id && e.asignacion === 'aceptado' && ['pendiente', 'recogido', 'en_camino'].includes(e.estado)) {
    const p = pilotoPorId(e.mensajero_id);
    const vivo = p && p.ubic_fecha && Date.now() - fechaMs(p.ubic_fecha) < 10 * 60_000;
    if (p) piloto = { nombre: p.nombre.split(' ')[0], vehiculo: p.vehiculo, color: p.veh_color, placa: p.veh_placa,
      lat: vivo ? p.ubic_lat : null, lng: vivo ? p.ubic_lng : null, actualizado: vivo ? p.ubic_fecha : null };
  }
  return {
    guia: e.guia, estado: e.estado, creado: e.creado, vehiculo: e.vehiculo, origen_zona: e.origen_zona, destino_zona: e.destino_zona,
    destinatario: (e.destino_nombre || '').split(/\s+/)[0], programado_para: e.programado_para,
    piloto,
    eventos: eventosDe(e.id).map(({ estado, nota, creado }) => ({ estado, nota, creado })),
  };
});

// ---------- Botón de emergencia del piloto ----------
const TIPOS_EMERGENCIA = { accidente: 'Accidente', asalto: 'Asalto o robo', salud: 'Problema de salud', otro: 'Otra emergencia' };
ruta('POST', '/api/piloto/emergencia', ({ req, body }) => {
  const p = requierePiloto(req);
  const tipo = TIPOS_EMERGENCIA[body.tipo] ? body.tipo : 'otro';
  const c = coordenada(body.lat, body.lng) || (p.ubic_lat != null ? { lat: p.ubic_lat, lng: p.ubic_lng } : null);
  const activo = db.prepare(`SELECT id FROM envios WHERE mensajero_id = ? AND estado IN ${SQL_PILOTO_ACTIVO} ORDER BY id LIMIT 1`).get(p.id);
  // No repetir la misma alerta abierta en el último minuto
  if (!db.prepare("SELECT 1 FROM alertas WHERE piloto_id = ? AND atendida_en IS NULL AND creado > datetime('now','-1 minute')").get(p.id)) {
    db.prepare('INSERT INTO alertas (piloto_id, tipo, lat, lng, envio_id) VALUES (?, ?, ?, ?, ?)').run(p.id, tipo, c?.lat ?? null, c?.lng ?? null, activo?.id ?? null);
  }
  if (c) registrarUbicacion(p, c, numero(body.precision), true);
  return { ok: true };
});
const alertasAbiertas = () => db.prepare(`SELECT a.*, u.nombre AS piloto, u.telefono, u.emergencia_nombre, u.emergencia_telefono, u.veh_placa, e.guia
  FROM alertas a JOIN usuarios u ON u.id = a.piloto_id LEFT JOIN envios e ON e.id = a.envio_id WHERE a.atendida_en IS NULL ORDER BY a.id DESC`).all()
  .map((a) => ({ ...a, tipo_texto: TIPOS_EMERGENCIA[a.tipo] }));
ruta('POST', '/api/admin/alertas/:id/atender', ({ req, params }) => {
  const u = requiereStaff(req);
  db.prepare("UPDATE alertas SET atendida_en = datetime('now'), atendida_por = ? WHERE id = ?").run(u.nombre, Number(params.id));
  return { ok: true };
});
ruta('GET', '/api/admin/alertas', ({ req }) => { requiereStaff(req); return { alertas: alertasAbiertas() }; });

// ---------- Caja: efectivo de pilotos, pagos a pilotos, cobros a devolver y crédito de empresas (solo administración) ----------
// Efectivo que tiene el piloto por un envío: el pago del envío (y cargos pendientes que se cobraron con él) si fue en efectivo,
// más el cobro a quien recibe cuando él lo entregó (si se retiró en la sede, lo cobró la oficina)
const SQL_EFECTIVO = `(CASE WHEN e.estado != 'cancelado' AND e.metodo_pago = 'efectivo' THEN e.precio + e.cargos_extra ELSE 0 END
  + CASE WHEN e.estado = 'entregado' AND e.sede_llegada IS NULL AND e.metodo_pago = 'recibe' THEN e.precio ELSE 0 END
  + CASE WHEN e.estado = 'entregado' AND e.sede_llegada IS NULL AND e.cobro_devuelto_en IS NULL THEN e.cobro_destinatario ELSE 0 END)`;
ruta('GET', '/api/admin/caja', ({ req }) => {
  requiereRol(req, 'admin');
  const pilotos = db.prepare(`SELECT u.id, u.nombre, u.telefono,
      (SELECT COALESCE(SUM(${SQL_EFECTIVO}), 0) FROM envios e WHERE e.mensajero_id = u.id AND e.piloto_cerro_en IS NOT NULL AND e.liquidado_id IS NULL) AS efectivo,
      (SELECT COUNT(*) FROM envios e WHERE e.mensajero_id = u.id AND e.piloto_cerro_en IS NOT NULL AND e.liquidado_id IS NULL AND ${SQL_EFECTIVO} > 0) AS envios_efectivo,
      (SELECT COALESCE(SUM(e.ganancia_piloto), 0) FROM envios e WHERE e.mensajero_id = u.id AND e.piloto_cerro_en IS NOT NULL AND e.pago_piloto_id IS NULL) AS ganancia,
      (SELECT COUNT(*) FROM envios e WHERE e.mensajero_id = u.id AND e.piloto_cerro_en IS NOT NULL AND e.pago_piloto_id IS NULL AND e.ganancia_piloto > 0) AS envios_ganancia
    FROM usuarios u WHERE u.rol = 'mensajero' ORDER BY u.nombre`).all().filter((p) => p.efectivo > 0 || p.ganancia > 0);
  const detalle = (id) => db.prepare(`SELECT e.id, e.guia, e.entregado_en, e.precio, e.metodo_pago, e.cobro_destinatario, ${SQL_EFECTIVO} AS efectivo
    FROM envios e WHERE e.mensajero_id = ? AND e.piloto_cerro_en IS NOT NULL AND e.liquidado_id IS NULL AND ${SQL_EFECTIVO} > 0 ORDER BY e.id`).all(id);
  const conCuenta = db.prepare(`SELECT DISTINCT e.usuario_id AS id FROM envios e WHERE ${SQL_CUENTA_TIENDA} AND e.cobro_pagado_en IS NULL
    UNION SELECT DISTINCT c.usuario_id FROM cargos c JOIN usuarios u ON u.id = c.usuario_id WHERE u.tipo_cuenta = 'minorista' AND ${SQL_CARGO_TIENDA}`).all();
  const cobros = conCuenta.map(({ id }) => {
    const u = db.prepare('SELECT id, nombre, telefono, empresa_nombre FROM usuarios WHERE id = ?').get(id); const cp = cobrosProducto(id);
    return { ...u, envios: cp.envios, monto: redondear(cp.pendiente - cp.saldo), comision: cp.comision, envios_tienda: cp.envios_tienda, cargos: cp.cargos, cargos_detalle: cp.cargos_detalle, debe_cargos: cp.debe_cargos };
  }).filter((x) => x.monto !== 0 || x.envios || x.cargos).sort((a, b) => b.monto - a.monto);
  const credito = db.prepare(`SELECT u.id, u.nombre, u.empresa_nombre, COUNT(*) AS envios, SUM(e.precio + e.cargos_extra) AS monto, MIN(e.creado) AS desde
    FROM envios e JOIN usuarios u ON u.id = e.usuario_id WHERE e.metodo_pago = 'credito' AND ${SQL_VIAJE_HECHO} AND e.credito_pagado_en IS NULL
    GROUP BY u.id ORDER BY monto DESC`).all();
  const historial = db.prepare(`SELECT 'liquidacion' AS tipo, l.id AS id, l.creado AS creado, u.nombre AS nombre, l.esperado AS esperado, l.recibido AS monto, l.envios AS envios, l.nota AS nota FROM liquidaciones l JOIN usuarios u ON u.id = l.piloto_id
    UNION ALL SELECT 'pago' AS tipo, p.id, p.creado, u.nombre, NULL, p.monto, p.envios, p.nota FROM pagos_piloto p JOIN usuarios u ON u.id = p.piloto_id
    ORDER BY creado DESC LIMIT 40`).all();
  const reembolsos = db.prepare(`SELECT r.id, r.monto_cliente, r.resolucion, r.resuelto_en, e.guia, e.id AS envio_id, u.nombre AS cliente, u.telefono FROM reclamos r JOIN envios e ON e.id = r.envio_id
    JOIN usuarios u ON u.id = r.usuario_id WHERE r.estado = 'aprobado' AND r.monto_cliente > 0 AND r.devuelto_en IS NULL ORDER BY r.id`).all();
  return { reembolsos, pilotos: pilotos.map((p) => { const desc = descuentosPiloto(p.id); const d = redondear(desc.reduce((t, x) => t + x.monto_piloto, 0));
      return { ...p, efectivo: redondear(p.efectivo), ganancia: redondear(p.ganancia), descuentos: d, descuentos_detalle: desc, a_pagar: redondear(Math.max(0, p.ganancia - d)), detalle: detalle(p.id),
        deuda_vencida: deudaVencida(p.id) }; }),
    cobros, credito: credito.map((c) => ({ ...c, monto: redondear(c.monto) })), historial };
});
ruta('POST', '/api/admin/caja/liquidar', ({ req, body }) => {
  requiereRol(req, 'admin');
  const id = numero(body.piloto_id), recibido = numero(body.recibido);
  if (!(recibido >= 0)) falla(400, 'Escribe cuánto efectivo entregó el piloto.');
  const envios = db.prepare(`SELECT e.id, ${SQL_EFECTIVO} AS efectivo FROM envios e WHERE e.mensajero_id = ? AND e.piloto_cerro_en IS NOT NULL AND e.liquidado_id IS NULL AND ${SQL_EFECTIVO} > 0`).all(id);
  if (!envios.length) falla(400, 'Este piloto no tiene efectivo pendiente.');
  const esperado = redondear(envios.reduce((s, x) => s + x.efectivo, 0));
  db.exec('BEGIN');
  try {
    const r = db.prepare('INSERT INTO liquidaciones (piloto_id, esperado, recibido, envios, nota) VALUES (?, ?, ?, ?, ?)').run(id, esperado, redondear(recibido), envios.length, texto(body.nota, 300));
    const marcar = db.prepare('UPDATE envios SET liquidado_id = ? WHERE id = ?');
    for (const x of envios) marcar.run(Number(r.lastInsertRowid), x.id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { ok: true, esperado, diferencia: redondear(recibido - esperado) };
});
ruta('POST', '/api/admin/caja/pagar-piloto', ({ req, body }) => {
  requiereRol(req, 'admin');
  const id = numero(body.piloto_id);
  const envios = db.prepare("SELECT id, ganancia_piloto FROM envios WHERE mensajero_id = ? AND piloto_cerro_en IS NOT NULL AND pago_piloto_id IS NULL AND ganancia_piloto > 0").all(id);
  if (!envios.length) falla(400, 'No hay entregas pendientes de pago para este piloto.');
  // Se descuentan los reclamos aprobados en los que el piloto fue responsable
  const desc = descuentosPiloto(id);
  const bruto = redondear(envios.reduce((s, x) => s + (x.ganancia_piloto || 0), 0));
  const descuento = redondear(desc.reduce((t, x) => t + x.monto_piloto, 0));
  const monto = redondear(Math.max(0, bruto - descuento));
  db.exec('BEGIN');
  try {
    const nota = [texto(body.nota, 300), descuento ? `Descuento por reclamos: Q${descuento.toFixed(2)} (${desc.map((x) => x.guia).join(', ')})` : ''].filter(Boolean).join('. ');
    const r = db.prepare('INSERT INTO pagos_piloto (piloto_id, monto, envios, nota) VALUES (?, ?, ?, ?)').run(id, monto, envios.length, nota);
    const marcar = db.prepare('UPDATE envios SET pago_piloto_id = ? WHERE id = ?');
    for (const x of envios) marcar.run(Number(r.lastInsertRowid), x.id);
    for (const x of desc) db.prepare('UPDATE reclamos SET descontado_pago_id = ? WHERE id = ?').run(Number(r.lastInsertRowid), x.id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { ok: true, monto, descuento };
});
ruta('POST', '/api/admin/caja/pagar-cobros', ({ req, body }) => {
  requiereRol(req, 'admin');
  const id = numero(body.cliente_id);
  db.exec('BEGIN');
  try {
    const r = db.prepare(`UPDATE envios AS e SET cobro_pagado_en = datetime('now') WHERE e.usuario_id = ? AND ${SQL_CUENTA_TIENDA} AND e.cobro_pagado_en IS NULL`).run(id);
    const c = db.prepare(`UPDATE cargos AS c SET pagado_en = datetime('now'), pagado_como = 'cuenta de tienda' WHERE c.usuario_id = ? AND ${SQL_CARGO_TIENDA}
      AND (SELECT tipo_cuenta FROM usuarios WHERE id = c.usuario_id) = 'minorista'`).run(id);
    db.exec('COMMIT');
    return { ok: true, envios: Number(r.changes), cargos: Number(c.changes) };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
});
ruta('POST', '/api/admin/caja/cobrar-credito', ({ req, body }) => {
  requiereRol(req, 'admin');
  const r = db.prepare("UPDATE envios SET credito_pagado_en = datetime('now') WHERE usuario_id = ? AND metodo_pago = 'credito' AND estado NOT IN ('pendiente','recogido','en_camino','cancelado') AND credito_pagado_en IS NULL").run(numero(body.cliente_id));
  return { ok: true, envios: Number(r.changes) };
});

// ---------- Promociones (panel) ----------
function leerPromocion(body) {
  const nombre = texto(body.nombre, 80);
  if (nombre.length < 3) falla(400, 'Ponle un nombre a la promoción, por ejemplo "Navidad 2026".');
  const tipo = ['porcentaje', 'monto', 'gratis'].includes(body.tipo) ? body.tipo : falla(400, 'Elige el tipo de descuento.');
  const valor = tipo === 'gratis' ? 0 : numero(body.valor);
  if (tipo === 'porcentaje' && !(valor > 0 && valor <= 100)) falla(400, 'El porcentaje debe ser de 1 a 100.');
  if (tipo === 'monto' && !(valor > 0 && valor <= 5000)) falla(400, 'Escribe el monto del descuento en quetzales.');
  const desde = fechaCampo(body.desde, 'inicio') || falla(400, 'Elige la fecha de inicio.');
  const hasta = fechaCampo(body.hasta, 'fin') || falla(400, 'Elige la fecha de fin.');
  if (hasta < desde) falla(400, 'La fecha de fin debe ser después del inicio.');
  const codigo = texto(body.codigo, 30).toUpperCase().replace(/\s/g, '') || null;
  if (codigo && !/^[A-Z0-9-]{3,30}$/.test(codigo)) falla(400, 'El cupón solo puede tener letras, números y guiones (mínimo 3).');
  const entero = (v) => (v === '' || v == null ? null : Math.max(1, Math.round(numero(v))) || null);
  const hora = (v) => { const t = texto(v, 5); if (!t) return null; if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) falla(400, 'Revisa la hora (formato 24 h, por ejemplo 18:00).'); return t; };
  const desde_hora = hora(body.desde_hora), hasta_hora = hora(body.hasta_hora);
  if (`${hasta} ${hasta_hora || '23:59'}` <= `${desde} ${desde_hora || '00:00'}`) falla(400, 'El fin debe ser después del inicio.');
  return { nombre, tipo, valor, desde, hasta, desde_hora, hasta_hora, codigo, solo_primer_envio: body.solo_primer_envio ? 1 : 0,
    usos_max: entero(body.usos_max), usos_por_cliente: entero(body.usos_por_cliente), minimo: body.minimo ? numero(body.minimo) || null : null };
}
ruta('GET', '/api/admin/promociones', ({ req }) => {
  requiereRol(req, 'admin');
  const hoy = hoyGT();
  return { hoy, promociones: db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM envios e WHERE e.promocion_id = p.id AND e.estado != 'cancelado') AS usos,
    (SELECT COALESCE(SUM(e.descuento), 0) FROM envios e WHERE e.promocion_id = p.id AND e.estado != 'cancelado') AS total_descontado
    FROM promociones p ORDER BY p.hasta DESC, p.id DESC`).all().map((p) => { const ahora = ahoraGT(); return { ...p,
      cliente: p.usuario_id ? db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(p.usuario_id)?.nombre || null : null,
      estado: !p.activa ? 'pausada' : finPromo(p) < ahora ? 'terminada' : inicioPromo(p) > ahora ? 'programada' : 'activa' }; }) };
});
ruta('POST', '/api/admin/promociones', ({ req, body }) => {
  requiereRol(req, 'admin');
  const p = leerPromocion(body);
  if (p.codigo && db.prepare('SELECT 1 FROM promociones WHERE codigo = ?').get(p.codigo)) falla(409, 'Ya existe una promoción con ese cupón.');
  db.prepare(`INSERT INTO promociones (nombre, codigo, tipo, valor, desde, hasta, desde_hora, hasta_hora, solo_primer_envio, usos_max, usos_por_cliente, minimo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.nombre, p.codigo, p.tipo, p.valor, p.desde, p.hasta, p.desde_hora, p.hasta_hora, p.solo_primer_envio, p.usos_max, p.usos_por_cliente, p.minimo);
  return { _status: 201, ok: true };
});
ruta('PUT', '/api/admin/promociones/:id', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const actual = db.prepare('SELECT * FROM promociones WHERE id = ?').get(Number(params.id));
  if (!actual) falla(404, 'No encontramos esa promoción.');
  if (body.activa !== undefined && Object.keys(body).length === 1) { db.prepare('UPDATE promociones SET activa = ? WHERE id = ?').run(body.activa ? 1 : 0, actual.id); return { ok: true }; }
  const p = leerPromocion(body);
  if (p.codigo && db.prepare('SELECT 1 FROM promociones WHERE codigo = ? AND id != ?').get(p.codigo, actual.id)) falla(409, 'Ya existe una promoción con ese cupón.');
  db.prepare(`UPDATE promociones SET nombre = ?, codigo = ?, tipo = ?, valor = ?, desde = ?, hasta = ?, desde_hora = ?, hasta_hora = ?, solo_primer_envio = ?, usos_max = ?, usos_por_cliente = ?, minimo = ? WHERE id = ?`)
    .run(p.nombre, p.codigo, p.tipo, p.valor, p.desde, p.hasta, p.desde_hora, p.hasta_hora, p.solo_primer_envio, p.usos_max, p.usos_por_cliente, p.minimo, actual.id);
  return { ok: true };
});

// ---------- Cuentas de empresa (panel) ----------
ruta('PUT', '/api/admin/clientes/:id/empresa', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const u = db.prepare("SELECT id FROM usuarios WHERE id = ? AND rol = 'cliente'").get(Number(params.id));
  if (!u) falla(404, 'No encontramos ese cliente.');
  const empresa = body.tipo_cuenta === 'empresa', minorista = body.tipo_cuenta === 'minorista';
  const desc = empresa ? numero(body.descuento_empresa || 0) : 0;
  if (!(desc >= 0 && desc <= 90)) falla(400, 'El descuento de empresa debe ser de 0 a 90%.');
  if (!empresa && !minorista) revisarSinPedidosAbiertos(u.id);
  db.prepare('UPDATE usuarios SET tipo_cuenta = ?, empresa_nombre = ?, descuento_empresa = ?, credito_permitido = ? WHERE id = ?')
    .run(empresa ? 'empresa' : minorista ? 'minorista' : 'personal', empresa || minorista ? texto(body.empresa_nombre, 100) || null : null, desc, 0, u.id);
  if (empresa && body.recogida_dias !== undefined) {
    const dias = String(body.recogida_dias || '').split(',').map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    const hora = /^([01]\d|2[0-3]):[0-5]\d$/.test(body.recogida_hora || '') ? body.recogida_hora : null;
    if (dias.length && !hora) falla(400, 'Pon la hora de la recogida fija.');
    db.prepare('UPDATE usuarios SET recogida_dias = ?, recogida_hora = ? WHERE id = ?').run(dias.length ? [...new Set(dias)].sort().join(',') : null, dias.length ? hora : null, u.id);
  }
  if (empresa && body.fact_nit !== undefined) {
    const nit = String(body.fact_nit || '').toUpperCase().replace(/[^0-9K]/g, '');
    if (nit && nit !== 'CF' && nit.length < 2) falla(400, 'Revisa el NIT.');
    db.prepare('UPDATE usuarios SET fact_nit = ?, fact_nombre = ?, fact_direccion = ? WHERE id = ?')
      .run(String(body.fact_nit || '').trim().toUpperCase() === 'CF' ? 'CF' : nit || null, texto(body.fact_nombre, 150) || null, texto(body.fact_direccion, 200) || null, u.id);
  }
  return { ok: true };
});

// ---------- Reportes (solo administración) ----------
function rangoReporte(query) {
  const hoy = hoyGT();
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(query.get('desde') || '') ? query.get('desde') : hoy.slice(0, 8) + '01';
  const hasta = /^\d{4}-\d{2}-\d{2}$/.test(query.get('hasta') || '') ? query.get('hasta') : hoy;
  return { desde, hasta };
}
const FILTRO_RANGO = "date(e.creado, '-6 hours') BETWEEN ? AND ?";
ruta('GET', '/api/admin/reportes', ({ req, query }) => {
  requiereRol(req, 'admin');
  const { desde, hasta } = rangoReporte(query);
  const g = db.prepare(`SELECT COUNT(*) AS envios,
      SUM(e.estado = 'entregado') AS entregados, SUM(e.estado = 'cancelado') AS cancelados, SUM(e.fallo_en IS NOT NULL) AS fallidos,
      COALESCE(SUM(CASE WHEN ${SQL_VIAJE_HECHO} THEN e.precio END), 0) AS ingresos,
      COALESCE(SUM(CASE WHEN ${SQL_VIAJE_HECHO} THEN e.descuento END), 0) AS descuentos,
      COALESCE(SUM(e.ganancia_piloto), 0) AS pagos_pilotos,
      AVG(CASE WHEN e.estado = 'entregado' AND e.entregado_en IS NOT NULL THEN (julianday(e.entregado_en) - julianday(COALESCE(e.programado_para, e.creado))) * 1440 END) AS minutos,
      COUNT(DISTINCT e.usuario_id) AS clientes
    FROM envios e WHERE ${FILTRO_RANGO}`).get(desde, hasta);
  const porDia = db.prepare(`SELECT date(e.creado, '-6 hours') AS dia, COUNT(*) AS envios, COALESCE(SUM(CASE WHEN ${SQL_VIAJE_HECHO} THEN e.precio END), 0) AS ingresos
    FROM envios e WHERE ${FILTRO_RANGO} GROUP BY dia ORDER BY dia`).all(desde, hasta);
  const porZona = db.prepare(`SELECT e.destino_zona AS zona, COUNT(*) AS envios FROM envios e WHERE ${FILTRO_RANGO} AND e.estado != 'cancelado' GROUP BY zona ORDER BY envios DESC LIMIT 12`).all(desde, hasta);
  const porHora = db.prepare(`SELECT CAST(strftime('%H', e.creado, '-6 hours') AS INTEGER) AS hora, COUNT(*) AS envios FROM envios e WHERE ${FILTRO_RANGO} GROUP BY hora ORDER BY hora`).all(desde, hasta);
  const pilotos = db.prepare(`SELECT u.nombre, COUNT(*) AS entregas, ROUND(AVG(e.calificacion), 1) AS calificacion,
      ROUND(AVG((julianday(e.entregado_en) - julianday(COALESCE(e.programado_para, e.creado))) * 1440)) AS minutos, COALESCE(SUM(e.ganancia_piloto), 0) AS ganancia
    FROM envios e JOIN usuarios u ON u.id = e.mensajero_id WHERE ${FILTRO_RANGO} AND e.estado = 'entregado' GROUP BY u.id ORDER BY entregas DESC`).all(desde, hasta);
  const promos = db.prepare(`SELECT p.nombre, COUNT(*) AS usos, SUM(e.descuento) AS descontado FROM envios e JOIN promociones p ON p.id = e.promocion_id
    WHERE ${FILTRO_RANGO} AND e.estado != 'cancelado' GROUP BY p.id ORDER BY usos DESC`).all(desde, hasta);
  const bonos = db.prepare(`SELECT COALESCE(SUM(b.monto), 0) AS t FROM bonos_empresa b JOIN envios e ON e.id = b.envio_id WHERE ${FILTRO_RANGO}`).get(desde, hasta).t;
  // Cargos a clientes (cancelación tardía, devoluciones, días en la sede y nuevas entregas)
  const cargos = db.prepare(`SELECT c.tipo, COUNT(*) AS n, SUM(c.monto) AS monto FROM cargos c
    WHERE c.anulado_en IS NULL AND date(c.creado, '-6 hours') BETWEEN ? AND ? GROUP BY c.tipo`).all(desde, hasta);
  return { desde, hasta, cargos, general: { ...g, fallidos: g.fallidos || 0, ingresos: redondear(g.ingresos), descuentos: redondear(g.descuentos), pagos_pilotos: redondear(g.pagos_pilotos),
    bonos_empresas: redondear(bonos), para_vaelo: redondear(g.ingresos - g.pagos_pilotos - bonos),
    entregados: g.entregados || 0, cancelados: g.cancelados || 0, minutos: g.minutos ? Math.round(g.minutos) : null,
    ticket: g.entregados ? redondear(g.ingresos / g.entregados) : 0 }, porDia, porZona, porHora, pilotos, promos };
});
// Descarga de envíos para Excel (CSV con tildes bien puestas)
ruta('GET', '/api/admin/reportes/csv', ({ req, res, query }) => {
  requiereRol(req, 'admin');
  const { desde, hasta } = rangoReporte(query);
  const filas = db.prepare(`SELECT e.guia, datetime(e.creado, '-6 hours') AS fecha, u.nombre AS cliente, u.empresa_nombre AS empresa, e.origen_zona, e.destino_zona,
      e.destino_nombre, v.nombre AS vehiculo, e.peso, e.precio_base, e.descuento, e.precio, e.metodo_pago, e.cobro_destinatario, e.estado,
      m.nombre AS piloto, datetime(e.entregado_en, '-6 hours') AS entregado, e.recibio, e.calificacion, e.ganancia_piloto
    FROM envios e JOIN usuarios u ON u.id = e.usuario_id JOIN vehiculos v ON v.id = e.vehiculo_id LEFT JOIN usuarios m ON m.id = e.mensajero_id
    WHERE ${FILTRO_RANGO} ORDER BY e.id`).all(desde, hasta);
  const cols = ['Guía', 'Fecha', 'Cliente', 'Empresa', 'Zona recogida', 'Zona entrega', 'Recibe', 'Vehículo', 'Peso (lb)', 'Precio sin descuento', 'Descuento', 'Precio',
    'Pago', 'Cobro al recibir', 'Estado', 'Piloto', 'Entregado', 'Recibió', 'Calificación', 'Ganancia piloto'];
  const celda = (v) => { const t = v == null ? '' : String(v); return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const csv = '﻿' + [cols.join(','), ...filas.map((f) => Object.values(f).map(celda).join(','))].join('\r\n');
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="vaelo-envios-${desde}-a-${hasta}.csv"`, 'Cache-Control': 'no-store', ...CABECERAS_SEGURIDAD });
  res.end(csv);
  return { _enviado: true };
});

// ---------- Equipo de oficina (operadores) ----------
ruta('GET', '/api/admin/operadores', ({ req }) => {
  requiereRol(req, 'admin');
  return { areas: AREAS_PANEL, operadores: db.prepare("SELECT id, nombre, email, activo, creado, permisos FROM usuarios WHERE rol = 'operador' ORDER BY nombre").all().map((o) => ({ ...o, permisos: permisosDe(o) })) };
});
ruta('POST', '/api/admin/operadores', ({ req, body }) => {
  requiereRol(req, 'admin');
  const nombre = texto(body.nombre, 100), email = texto(body.email, 150).toLowerCase(), password = String(body.password || '');
  if (nombre.length < 3) falla(400, 'Escribe el nombre del empleado.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) falla(400, 'Escribe un correo válido.');
  if (password.length < 10) falla(400, 'La contraseña del empleado debe tener al menos 10 caracteres.');
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) falla(409, 'Ya existe una cuenta con ese correo.');
  db.prepare("INSERT INTO usuarios (nombre, email, telefono, password_hash, rol, email_verificado, verificacion) VALUES (?, ?, '', ?, 'operador', 1, 'verificado')").run(nombre, email, hashPassword(password));
  return { _status: 201, ok: true };
});
ruta('PUT', '/api/admin/operadores/:id', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const o = db.prepare("SELECT id FROM usuarios WHERE id = ? AND rol = 'operador'").get(Number(params.id));
  if (!o) falla(404, 'No encontramos ese empleado.');
  if (body.activo !== undefined) {
    db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(body.activo ? 1 : 0, o.id);
    if (!body.activo) db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(o.id);
  }
  if (Array.isArray(body.permisos)) {
    const l = body.permisos.filter((x) => AREAS_PANEL[x]);
    if (!l.length) falla(400, 'Dale al menos un área al empleado (o desactívalo).');
    db.prepare('UPDATE usuarios SET permisos = ? WHERE id = ?').run(l.join(','), o.id);
  }
  if (body.password) {
    if (String(body.password).length < 10) falla(400, 'La contraseña debe tener al menos 10 caracteres.');
    db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(hashPassword(String(body.password)), o.id);
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(o.id);
  }
  return { ok: true };
});


// =====================================================================
// Versión 3: avisos, cargos, entregas fallidas y sede, contraseña olvidada,
// comprobantes de transferencia, conexión para tiendas y salud del servidor
// =====================================================================

// ---------- Avisos al celular (push) y por correo ----------
const push = crearPush({ dataDir: DATA_DIR, contacto: `mailto:${ADMIN_EMAIL}` });
async function avisarUsuario(usuarioId, datos) {
  const subs = db.prepare('SELECT * FROM push_suscripciones WHERE usuario_id = ?').all(usuarioId);
  for (const sub of subs) {
    if ((await push.enviar(sub, datos)) === 'vencida') db.prepare('DELETE FROM push_suscripciones WHERE id = ?').run(sub.id);
  }
}
const avisar = (usuarioId, datos) => { if (usuarioId) avisarUsuario(usuarioId, datos).catch(() => {}); };
function avisarStaff(datos) {
  for (const u of db.prepare("SELECT id FROM usuarios WHERE activo = 1 AND ((rol = 'admin' AND email = ?) OR rol = 'operador')").all(ADMIN_EMAIL)) avisar(u.id, datos);
}
// Correo con el diseño de Vaelo: título, párrafos y un botón
function correoVaelo(titulo, parrafos, boton) {
  const p = parrafos.map((t) => `<p style="margin:0 0 12px">${escaparHtml(t)}</p>`).join('');
  const b = boton ? `<p style="margin:22px 0"><a href="${URL_SITIO}${boton.url}" style="background:#1c3faa;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escaparHtml(boton.texto)}</a></p>` : '';
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#15171c">
    <div style="background:#0e2463;padding:20px 24px;border-radius:10px 10px 0 0"><img src="${URL_SITIO}/img/logo-blanco.png" alt="Vaelo" height="32"></div>
    <div style="border:1px solid #d9dce5;border-top:0;padding:24px;border-radius:0 0 10px 10px"><h2 style="margin:0 0 14px">${escaparHtml(titulo)}</h2>${p}${b}
    <p style="color:#5a6072;font-size:12px;margin-top:20px">Vaelo Mensajería · Guatemala</p></div></div>`;
}
function correoA(usuarioId, asunto, titulo, parrafos, boton) {
  const u = db.prepare('SELECT email, nombre FROM usuarios WHERE id = ?').get(usuarioId);
  if (!u || u.email.endsWith('.interno')) return;
  enviarCorreo(u.email, asunto, correoVaelo(titulo, parrafos, boton), [titulo, ...parrafos, boton ? URL_SITIO + boton.url : ''].join('\n')).catch(() => {});
}
// Qué se avisa en cada momento del envío (al cliente, al piloto y a la oficina) y a la tienda conectada
function avisarEnvio(envioId, tipo, extra = {}) {
  try {
    const e = db.prepare(`${SQL_ENVIO} WHERE e.id = ?`).get(envioId);
    if (!e) return;
    if (e.pedido_id && ['aceptado', 'llegando', 'recogido', 'entregado', 'fallido', 'devolviendo', 'a_sede', 'en_sede', 'devuelto', 'precio', 'hora', 'atraso'].includes(tipo)) return avisarPedido(e, tipo);
    const url = `/mi-cuenta?envio=${e.id}`, guia = e.guia, piloto = (e.mensajero_nombre || 'El piloto').split(' ')[0];
    const cli = (titulo, cuerpo, conCorreo, parrafos, urgente) => {
      avisar(e.usuario_id, { titulo, cuerpo, url, etiqueta: 'envio-' + e.id, urgente });
      if (conCorreo) correoA(e.usuario_id, `${titulo} · ${guia}`, titulo, parrafos || [cuerpo], { texto: 'Ver mi envío', url });
    };
    const pil = (titulo, cuerpo, urgente = true) => e.mensajero_id && avisar(e.mensajero_id, { titulo, cuerpo, url: RUTA_PILOTO, etiqueta: 'piloto-' + e.id, urgente });
    switch (tipo) {
      case 'nuevo': avisarStaff({ titulo: 'Pedido nuevo', cuerpo: `${guia} · ${e.cliente_nombre} · ${e.origen_zona} → ${e.destino_zona} · Q${e.precio.toFixed(2)}`, url: RUTA_ADMIN, etiqueta: 'nuevo' }); break;
      case 'aceptado': cli('Tu piloto va en camino', `${piloto} aceptó tu envío ${guia} y va a recoger el paquete.`); break;
      case 'llegando': cli('Tu paquete está por llegar', `${piloto} está llegando al punto de entrega del envío ${guia}.`); break;
      case 'recogido': cli('Paquete recogido', `${piloto} ya tiene tu paquete ${guia}.`); break;
      case 'entregado': cli('Paquete entregado', `Tu envío ${guia} fue entregado${e.recibio ? ' a ' + e.recibio : ''}.`, true,
        [`Tu envío ${guia} fue entregado${e.recibio ? ' a ' + e.recibio : ''}.`, 'En tu cuenta puedes ver la foto de la entrega y calificar al piloto.']); break;
      case 'fallido': {
        const aj = getAjustes(), horas = horasDecidir();
        const parrafos = [`${piloto} no pudo entregar tu envío ${guia}: ${MOTIVOS_FALLO[e.fallo_motivo] || 'motivo no indicado'}.`,
          `Elige qué hacemos con el paquete: devolvértelo (Q${Number(aj.cargo_devolucion).toFixed(2)}) o guardarlo en nuestra sede (Q${Number(aj.cargo_bodega_dia).toFixed(2)} por día hasta que se entregue).`,
          `Si no eliges en ${horas === 1 ? '1 hora' : horas + ' horas'}, lo llevamos a la sede.`];
        cli('No pudimos entregar tu paquete', parrafos[0] + ' Elige qué hacemos con él.', true, parrafos, true);
        avisarStaff({ titulo: 'Entrega fallida', cuerpo: `${guia}: ${MOTIVOS_FALLO[e.fallo_motivo] || ''}`, url: RUTA_ADMIN, etiqueta: 'fallido-' + e.id });
        break;
      }
      case 'devolviendo': pil('Devuelve el paquete', `${guia}: el cliente pidió que se lo devuelvas al punto de recogida.`); cli('Devolución en camino', `${piloto} te devolverá el paquete ${guia}.`); break;
      case 'a_sede': extra.auto = e.fallo_decidido_por === 'automático'; pil('Lleva el paquete a la sede', `${guia}: déjalo en la sede de Vaelo.`); cli('Tu paquete va a la sede', `Guardaremos tu paquete ${guia} en la sede. Desde tu cuenta puedes pedir que se entregue de nuevo.`, extra.auto,
        [`Guardaremos tu paquete ${guia} en la sede de Vaelo${extra.auto ? ' porque no recibimos tu elección a tiempo' : ''}.`, `Cuesta Q${Number(getAjustes().cargo_bodega_dia).toFixed(2)} por día hasta que se entregue. Desde tu cuenta puedes pedir que lo llevemos de nuevo.`]); break;
      case 'devuelto': cli('Paquete devuelto', `Tu paquete ${guia} fue devuelto${e.devuelto_a ? ' a ' + e.devuelto_a : ''}.`, true); break;
      case 'en_sede': cli('Tu paquete está en la sede', `El paquete ${guia} ya está guardado en la sede de Vaelo.`); break;
      case 'cancelado': if (e.asignacion) pil('Envío cancelado', `${guia} fue cancelado. Ya no tienes que recogerlo.`); break;
      case 'asignado': {
        const n = e.grupo ? db.prepare('SELECT COUNT(*) AS n FROM envios WHERE grupo = ? AND mensajero_id = ?').get(e.grupo, e.mensajero_id).n : 1;
        if (e.pedido_id && n > 1) pil('Nueva ruta de empresa', `${nombreEmpresa(e.usuario_id)}: ${n} entregas. Ábrela para aceptarla.`);
        else pil('Nuevo envío para ti', `${e.origen_zona} → ${e.destino_zona} · ${e.vehiculo}. Tienes ${Math.max(20, Number(getAjustes().segundos_aceptar) || 60)} segundos para aceptar.`);
        break;
      }
      case 'precio': cli('Precio de tu envío actualizado', `${guia}: ${extra.razon}. Total Q${Number(extra.precio).toFixed(2)}.`, true); break;
      case 'comprobante': avisarStaff({ titulo: 'Comprobante de transferencia', cuerpo: `${guia} · ${e.cliente_nombre} · Q${(e.precio + e.cargos_extra).toFixed(2)}`, url: RUTA_ADMIN, etiqueta: 'pago-' + e.id }); break;
    }
  } catch (err) { console.error('Aviso de envío:', err.message); }
}

// ---------- Suscripciones push ----------
ruta('GET', '/api/push/clave', () => ({ clave: push.clavePublica }));
ruta('POST', '/api/push/suscribir', ({ req, body }) => {
  const u = requiereUsuario(req);
  const sub = body.suscripcion || {};
  const endpoint = texto(sub.endpoint, 1000), p256dh = texto(sub.keys?.p256dh, 200), auth = texto(sub.keys?.auth, 100);
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) falla(400, 'Suscripción no válida.');
  db.prepare(`INSERT INTO push_suscripciones (usuario_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET usuario_id = excluded.usuario_id, p256dh = excluded.p256dh, auth = excluded.auth`).run(u.id, endpoint, p256dh, auth);
  return { ok: true };
});
ruta('POST', '/api/push/quitar', ({ req, body }) => {
  const u = requiereUsuario(req);
  db.prepare('DELETE FROM push_suscripciones WHERE usuario_id = ? AND endpoint = ?').run(u.id, texto(body.endpoint, 1000));
  return { ok: true };
});
ruta('POST', '/api/push/probar', async ({ req }) => {
  const u = requiereUsuario(req);
  if (limitar(String(u.id), 'push-probar', 5, 600_000)) falla(429, 'Espera unos minutos.');
  await avisarUsuario(u.id, { titulo: 'Avisos activados', cuerpo: 'Así te llegarán los avisos de Vaelo.', url: '/' });
  return { ok: true };
});

// ---------- Cargos al cliente ----------
const TIPOS_CARGO = { cancelacion: 'Cancelación con el piloto en camino', devolucion: 'Devolución del paquete', bodega: 'Días en la sede', reentrega: 'Nueva entrega desde la sede', bodega_empresa: 'Paquetes guardados en la sede', intento_fallido: 'Entrega fallida' };
function crearCargo(usuarioId, envioId, tipo, monto, nota) {
  if (!(monto > 0)) return;
  db.prepare('INSERT INTO cargos (usuario_id, envio_id, tipo, monto, nota) VALUES (?, ?, ?, ?, ?)').run(usuarioId, envioId, tipo, redondear(monto), nota || TIPOS_CARGO[tipo]);
}
// Al crear un envío, los cargos pendientes se cobran con él
function sumarCargosPendientes(usuarioId, envioId) {
  const r = db.prepare(`UPDATE cargos SET cobrado_envio_id = ? WHERE usuario_id = ? AND cobrado_envio_id IS NULL AND pagado_en IS NULL AND anulado_en IS NULL AND tipo NOT IN ('bodega_empresa','intento_fallido')
    AND (envio_id IS NULL OR envio_id NOT IN (SELECT id FROM envios WHERE pedido_id IS NOT NULL))`).run(envioId, usuarioId);
  if (!r.changes) return 0;
  const total = redondear(db.prepare('SELECT COALESCE(SUM(monto), 0) AS t FROM cargos WHERE cobrado_envio_id = ?').get(envioId).t);
  db.prepare('UPDATE envios SET cargos_extra = ? WHERE id = ?').run(total, envioId);
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(envioId, 'pendiente', `Incluye Q${total.toFixed(2)} de cargos pendientes`);
  return total;
}
function liberarCargos(envioId) {
  db.prepare('UPDATE cargos SET cobrado_envio_id = NULL WHERE cobrado_envio_id = ?').run(envioId);
  db.prepare('UPDATE envios SET cargos_extra = 0 WHERE id = ?').run(envioId);
}
const cargosPendientes = (usuarioId) => db.prepare(`SELECT c.*, e.guia FROM cargos c LEFT JOIN envios e ON e.id = c.envio_id
  WHERE c.usuario_id = ? AND c.pagado_en IS NULL AND c.anulado_en IS NULL AND c.cobrado_envio_id IS NULL ORDER BY c.id`).all(usuarioId);
ruta('GET', '/api/yo/cargos', ({ req }) => {
  const u = requiereUsuario(req);
  // La bodega de las empresas se cobra por WhatsApp: no aparece en su cuenta
  const pendientes = cargosPendientes(u.id).filter((c) => c.tipo !== 'bodega_empresa');
  const historial = db.prepare(`SELECT c.*, e.guia, ec.guia AS cobrado_guia FROM cargos c LEFT JOIN envios e ON e.id = c.envio_id LEFT JOIN envios ec ON ec.id = c.cobrado_envio_id
    WHERE c.usuario_id = ? AND c.tipo != 'bodega_empresa' ORDER BY c.id DESC LIMIT 50`).all(u.id);
  return { pendientes, total: redondear(pendientes.reduce((t, c) => t + c.monto, 0)), historial, tipos: TIPOS_CARGO };
});

// ---------- Entrega fallida: decisión, devolución y sede ----------
const horasDecidir = () => Math.max(0.25, Number(getAjustes().horas_decidir_fallido) || 2);
function sedeUbicacion() {
  const a = getAjustes();
  return coordenada(a.sede_lat, a.sede_lng);
}
// Días en la sede (cada día o fracción cuenta), hasta hoy o hasta que salió
function diasEnSede(e) {
  if (!e.sede_llegada) return 0;
  const fin = e.sede_salida ? fechaMs(e.sede_salida) : Date.now();
  return Math.max(1, Math.ceil((fin - fechaMs(e.sede_llegada)) / 86400_000));
}
const cargoBodega = (e) => (e.pedido_id ? cargoSedePedido(e, Number(getAjustes().cargo_bodega_empresa) || 0) : redondear(diasEnSede(e) * (Number(getAjustes().cargo_bodega_dia) || 0)));
function decidirFallido(e, decision, por) {
  if (e.estado !== 'fallido') falla(400, 'Este envío ya no está esperando una decisión.');
  if (!['devolver', 'sede'].includes(decision)) falla(400, 'Elige devolver el paquete o guardarlo en la sede.');
  if (e.pedido_id && decision === 'devolver') falla(400, 'Los pedidos de empresa no se devuelven: quedan en la sede y la empresa los recoge ahí.');
  const aj = getAjustes();
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE envios SET fallo_decision = ?, fallo_decidido_en = datetime('now'), fallo_decidido_por = ? WHERE id = ?").run(decision, por, e.id);
    if (decision === 'devolver') {
      crearCargo(e.usuario_id, e.id, 'devolucion', Number(aj.cargo_devolucion) || 0);
      cambiarEstado(e.id, 'devolviendo', `Se devolverá a quien lo envió (decidió: ${por}). Cargo: Q${(Number(aj.cargo_devolucion) || 0).toFixed(2)}`);
    } else {
      cambiarEstado(e.id, 'a_sede', e.pedido_id ? 'Se guardará en la sede: la empresa lo recoge ahí' : `Se guardará en la sede (decidió: ${por}). Q${(Number(aj.cargo_bodega_dia) || 0).toFixed(2)} por día`);
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
ruta('POST', '/api/envios/:id/decidir', ({ req, params, body }) => {
  const u = requiereUsuario(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND usuario_id = ?').get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
  decidirFallido(e, texto(body.decision, 10), 'el cliente');
  return { ok: true };
});
// Si el cliente no elige a tiempo, el paquete va a la sede
function decisionesVencidas() {
  const minutos = Math.round(horasDecidir() * 60);
  for (const e of db.prepare("SELECT * FROM envios WHERE estado = 'fallido' AND fallo_en < datetime('now', ?)").all(`-${minutos} minutes`)) {
    try { decidirFallido(e, 'sede', 'automático'); } catch (err) { console.error('Decisión automática:', err.message); }
  }
}
if (require.main === module) setInterval(() => { try { decisionesVencidas(); } catch (err) { console.error(err.message); } }, 60_000).unref();

// Paquete en la sede: lo retira alguien (se cobra lo de la sede) o se manda de nuevo con un piloto
function retirarDeSede(e, recibio, quien) {
  if (e.estado !== 'en_sede') falla(400, 'Este paquete no está en la sede.');
  if (recibio.length < 2) falla(400, 'Escribe el nombre de quien retiró el paquete.');
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE envios SET sede_salida = datetime('now'), recibio = ? WHERE id = ?").run(recibio, e.id);
    const f = db.prepare('SELECT * FROM envios WHERE id = ?').get(e.id);
    crearCargo(e.usuario_id, e.id, e.pedido_id ? 'bodega_empresa' : 'bodega', cargoBodega(f), `${diasEnSede(f)} día(s) en la sede`);
    // Lo pendiente del cliente se paga en la sede al retirar (a las tiendas se les carga a su cuenta)
    if (!e.pedido_id) db.prepare("UPDATE cargos SET pagado_en = datetime('now'), pagado_como = 'en la sede' WHERE usuario_id = ? AND pagado_en IS NULL AND anulado_en IS NULL AND cobrado_envio_id IS NULL").run(e.usuario_id);
    cambiarEstado(e.id, 'entregado', `Retirado en la sede por ${recibio} (${quien})`);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
function reenviarDesdeSede(e, quien) {
  if (e.estado !== 'en_sede') falla(400, 'Este paquete no está en la sede.');
  const sede = sedeUbicacion();
  if (!sede) falla(400, 'Falta la ubicación de la sede (panel > Tarifas y ajustes).');
  const aj = getAjustes();
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE envios SET sede_salida = datetime('now') WHERE id = ?").run(e.id);
    const f = db.prepare('SELECT * FROM envios WHERE id = ?').get(e.id);
    crearCargo(e.usuario_id, e.id, 'bodega', cargoBodega(f), `${diasEnSede(f)} día(s) en la sede`);
    const cargoRe = Number(aj.cargo_reentrega) || 0;
    crearCargo(e.usuario_id, e.id, 'reentrega', cargoRe);
    // El enlace de quien recibe pasa al envío nuevo, así sigue funcionando el mismo
    const token = e.receptor_token;
    db.prepare('UPDATE envios SET receptor_token = NULL WHERE id = ?').run(e.id);
    const guia = nuevaGuia();
    const r = db.prepare(`INSERT INTO envios (guia, usuario_id, vehiculo_id, peso, descripcion, origen_direccion, origen_zona, origen_telefono, origen_lat, origen_lng,
        destino_nombre, destino_telefono, destino_direccion, destino_zona, destino_lat, destino_lng, tipo_tarifa, precio, precio_base, metodo_pago, cobro_destinatario,
        notas, fragil, codigo_entrega, receptor_token, receptor_nombre, receptor_confirmado_en, receptor_lat, receptor_lng, receptor_ubic_fecha, receptor_omitido,
        origen_quien, origen_nombre, origen_ubic_fecha, ganancia_piloto, reentrega_de, valor_declarado, seguro)
      VALUES (?, ?, ?, ?, ?, ?, 'Sede Vaelo', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'zona', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sede', 'Sede Vaelo', datetime('now'), ?, ?, ?, ?)`).run(
      guia, e.usuario_id, e.vehiculo_id, e.peso, e.descripcion, aj.sede_direccion || 'Sede Vaelo', e.origen_telefono, sede.lat, sede.lng,
      e.destino_nombre, e.destino_telefono, e.destino_direccion, e.destino_zona, e.destino_lat, e.destino_lng, e.metodo_pago === 'credito' ? 'credito' : 'efectivo', e.cobro_destinatario,
      `Nueva entrega del envío ${e.guia} desde la sede`, e.fragil, e.codigo_entrega, token, e.receptor_nombre, e.receptor_confirmado_en, e.receptor_lat, e.receptor_lng, e.receptor_ubic_fecha, e.receptor_omitido,
      gananciaPiloto(cargoRe), e.id, e.valor_declarado, e.seguro);
    const nuevo = Number(r.lastInsertRowid);
    db.prepare('UPDATE envios SET comision_cobro = ? WHERE id = ?').run(Number(e.comision_cobro) || 0, nuevo);
    db.prepare('UPDATE envios SET codigo_corto = ? WHERE id = ?').run(e.codigo_corto || null, nuevo);   // el paquete ya trae su código escrito
    db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(nuevo, 'pendiente', `Nueva entrega del envío ${e.guia} desde la sede`);
    cambiarEstado(e.id, 'reenviado', `Sale de la sede con la guía ${guia} (${quien})`);
    db.exec('COMMIT');
    return { guia, id: nuevo };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
ruta('POST', '/api/envios/:id/reenviar', ({ req, params }) => {
  const u = requiereUsuario(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND usuario_id = ?').get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
  if (e.pedido_id) falla(400, 'Los pedidos de empresa que quedan en la sede se recogen ahí con el código del pedido.');
  return { ok: true, ...reenviarDesdeSede(e, 'pedido por el cliente') };
});
// Panel: decidir por el cliente, recibir en la sede, entregar en la sede o mandar de nuevo
ruta('POST', '/api/admin/envios/:id/fallido', ({ req, params, body }) => {
  const quien = requiereStaff(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  const accion = texto(body.accion, 20), nombre = quien.nombre.split(' ')[0];
  if (accion === 'devolver' || accion === 'sede') { decidirFallido(e, accion, `la oficina (${nombre})`); return { ok: true }; }
  if (accion === 'recibido') {
    if (e.estado !== 'a_sede') falla(400, 'Este paquete no va para la sede.');
    db.prepare("UPDATE envios SET sede_llegada = datetime('now') WHERE id = ?").run(e.id);
    cambiarEstado(e.id, 'en_sede', `Recibido en la sede (${nombre})`);
    return { ok: true };
  }
  if (accion === 'retirar') { retirarDeSede(e, texto(body.recibio, 100), nombre); return { ok: true }; }
  if (accion === 'reenviar') return { ok: true, ...reenviarDesdeSede(e, nombre) };
  falla(400, 'Acción no válida.');
});
// Panel: cargos de los clientes (anular un cargo o marcarlo pagado)
ruta('GET', '/api/admin/cargos', ({ req }) => {
  requiereRol(req, 'admin');
  return { cargos: db.prepare(`SELECT c.*, u.nombre AS cliente, u.empresa_nombre, e.guia, ec.guia AS cobrado_guia FROM cargos c JOIN usuarios u ON u.id = c.usuario_id
      LEFT JOIN envios e ON e.id = c.envio_id LEFT JOIN envios ec ON ec.id = c.cobrado_envio_id ORDER BY c.pagado_en IS NULL AND c.anulado_en IS NULL AND c.cobrado_envio_id IS NULL DESC, c.id DESC LIMIT 200`).all(),
    tipos: TIPOS_CARGO };
});
ruta('POST', '/api/admin/cargos/:id', ({ req, params, body }) => {
  const u = requiereRol(req, 'admin');
  const c = db.prepare('SELECT * FROM cargos WHERE id = ?').get(Number(params.id));
  if (!c) falla(404, 'No encontramos ese cargo.');
  if (c.anulado_en || c.pagado_en) falla(400, 'Este cargo ya está cerrado.');
  if (body.accion === 'anular') {
    if (c.cobrado_envio_id) {   // se quita del envío con el que se iba a cobrar
      db.prepare('UPDATE envios SET cargos_extra = MAX(0, cargos_extra - ?) WHERE id = ?').run(c.monto, c.cobrado_envio_id);
    }
    db.prepare("UPDATE cargos SET anulado_en = datetime('now'), anulado_por = ?, cobrado_envio_id = NULL WHERE id = ?").run(texto(body.nota, 200) || u.nombre, c.id);
  } else if (body.accion === 'pagado') {
    if (c.cobrado_envio_id) falla(400, 'Este cargo se cobra con otro envío.');
    db.prepare("UPDATE cargos SET pagado_en = datetime('now'), pagado_como = ? WHERE id = ?").run(texto(body.nota, 100) || 'marcado en el panel', c.id);
  } else falla(400, 'Acción no válida.');
  return { ok: true };
});

// ---------- Transferencias: comprobante y revisión ----------
ruta('POST', '/api/envios/:id/comprobante', ({ req, params, body }) => {
  const u = requiereUsuario(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND usuario_id = ?').get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
  if (e.metodo_pago !== 'transferencia') falla(400, 'Este envío no se paga por transferencia.');
  if (e.pago_estado === 'verificado') falla(400, 'Tu pago ya fue verificado.');
  guardarArchivoEnvio(e.id, 'comprobante', body.archivo);
  db.prepare("UPDATE envios SET pago_estado = 'por_revisar', pago_nota = NULL WHERE id = ?").run(e.id);
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, 'El cliente subió el comprobante de transferencia');
  avisarEnvio(e.id, 'comprobante');
  return { ok: true };
}, { limite: 1_000_000 });
ruta('GET', '/api/admin/pagos', ({ req }) => {
  requiereRol(req, 'admin');
  return { pagos: db.prepare(`SELECT e.id, e.guia, e.precio, e.cargos_extra, e.pago_estado, e.pago_nota, e.creado, e.estado, u.nombre AS cliente, u.empresa_nombre
    FROM envios e JOIN usuarios u ON u.id = e.usuario_id WHERE e.metodo_pago = 'transferencia' AND e.estado != 'cancelado' AND COALESCE(e.pago_estado, '') != 'verificado'
    ORDER BY CASE e.pago_estado WHEN 'por_revisar' THEN 0 ELSE 1 END, e.id DESC LIMIT 100`).all() };
});
ruta('POST', '/api/admin/pagos/:id', ({ req, params, body }) => {
  const u = requiereRol(req, 'admin');
  const e = db.prepare("SELECT * FROM envios WHERE id = ? AND metodo_pago = 'transferencia'").get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  const estado = body.estado === 'verificado' ? 'verificado' : body.estado === 'rechazado' ? 'rechazado' : falla(400, 'Estado no válido.');
  const nota = texto(body.nota, 200);
  if (estado === 'rechazado' && nota.length < 4) falla(400, 'Escribe por qué se rechaza, para que el cliente lo corrija.');
  db.prepare('UPDATE envios SET pago_estado = ?, pago_nota = ? WHERE id = ?').run(estado, nota || null, e.id);
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, estado === 'verificado' ? `Transferencia verificada (${u.nombre.split(' ')[0]})` : `Comprobante rechazado: ${nota}`);
  if (estado === 'rechazado') avisar(e.usuario_id, { titulo: 'Revisa tu comprobante', cuerpo: `${e.guia}: ${nota}`, url: `/mi-cuenta?envio=${e.id}` });
  return { ok: true };
});
ruta('GET', '/api/admin/envios/:id/comprobante', ({ req, res, params }) => {
  requiereStaff(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  return enviarArchivoEnvio(res, e, 'comprobante');
});

// ---------- Olvidé mi contraseña (clientes y pilotos) ----------
ruta('POST', '/api/clave/olvide', async ({ req, body }) => {
  if (limitar(ipDe(req), 'clave-olvide', 6, 3600_000)) falla(429, 'Demasiados intentos. Espera una hora.');
  const email = texto(body.email, 150).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) falla(400, 'Escribe tu correo.');
  if (!correoActivo()) falla(503, 'El envío de correos todavía no está configurado. Escríbenos por WhatsApp para cambiar tu contraseña.');
  const u = db.prepare("SELECT * FROM usuarios WHERE email = ? AND rol IN ('cliente','mensajero') AND activo = 1").get(email);
  // Siempre se responde igual, así nadie puede averiguar qué correos tienen cuenta
  if (u && !limitar(email, 'clave-correo', 3, 3600_000)) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM tokens_clave WHERE usuario_id = ?').run(u.id);
    db.prepare('INSERT INTO tokens_clave (token, usuario_id, expira) VALUES (?, ?, ?)').run(token, u.id, Date.now() + 3600_000);
    await enviarCorreo(u.email, 'Crea una contraseña nueva en Vaelo',
      correoVaelo(`Hola, ${u.nombre.split(' ')[0]}`, ['Pediste crear una contraseña nueva para tu cuenta de Vaelo.', 'El enlace sirve durante 1 hora. Si no fuiste tú, ignora este correo: tu contraseña sigue igual.'],
        { texto: 'Crear contraseña nueva', url: `/recuperar?t=${token}` }),
      `Crea una contraseña nueva en Vaelo (vence en 1 hora): ${URL_SITIO}/recuperar?t=${token}`);
  }
  return { ok: true };
});
ruta('POST', '/api/clave/nueva', ({ req, body }) => {
  if (limitar(ipDe(req), 'clave-nueva', 10, 3600_000)) falla(429, 'Demasiados intentos. Espera una hora.');
  const token = String(body.token || '');
  const fila = /^[a-f0-9]{64}$/.test(token) && db.prepare('SELECT * FROM tokens_clave WHERE token = ?').get(token);
  if (!fila || fila.expira < Date.now()) falla(400, 'El enlace venció o ya se usó. Pide uno nuevo.');
  const nueva = String(body.password || '');
  if (nueva.length < 8) falla(400, 'La contraseña debe tener al menos 8 caracteres.');
  const u = db.prepare('SELECT id, rol FROM usuarios WHERE id = ?').get(fila.usuario_id);
  db.prepare('UPDATE usuarios SET password_hash = ?, email_verificado = 1 WHERE id = ?').run(hashPassword(nueva), u.id);
  db.prepare('DELETE FROM tokens_clave WHERE usuario_id = ?').run(u.id);
  db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(u.id);
  return { ok: true, destino: u.rol === 'mensajero' ? RUTA_PILOTO : '/entrar' };
});

// ---------- Zona de un punto (para elegirla sola en el formulario) ----------
ruta('GET', '/api/zona', ({ query }) => {
  const c = coordenada(query.get('lat'), query.get('lng'));
  return { zona: c ? zonaDePunto(c) : null, hay_formas: zonasConForma().length > 0 };
});

// ---------- Salud del servidor y respaldo descargable ----------
ruta('GET', '/api/salud', () => { db.prepare('SELECT 1').get(); return { ok: true, hora: new Date().toISOString() }; });
ruta('GET', '/api/admin/respaldo', ({ req, res }) => {
  requiereRol(req, 'admin');
  const dir = path.join(DATA_DIR, 'respaldos');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `descarga-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const datos = require('node:zlib').gzipSync(fs.readFileSync(tmp));
  fs.rmSync(tmp, { force: true });
  res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': datos.length, 'Content-Disposition': `attachment; filename="vaelo-respaldo-${hoyGT()}.db.gz"`, 'Cache-Control': 'no-store', ...CABECERAS_SEGURIDAD });
  res.end(datos);
  return { _enviado: true };
});


// =====================================================================
// Versión 4: fletes en pickup, reclamos, empresas con contrato y envíos a la sede
// =====================================================================

// ---------- Fletes (pickup): se piden por WhatsApp y la oficina los crea con el precio que acordó ----------
function usuarioWhatsapp() {
  const correo = 'clientes-whatsapp@vaelo.interno';
  let u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(correo);
  if (!u) {
    db.prepare("INSERT INTO usuarios (nombre, email, telefono, password_hash, rol, activo, email_verificado, verificacion) VALUES ('Cliente por WhatsApp', ?, '', ?, 'cliente', 0, 1, 'verificado')")
      .run(correo, hashPassword(crypto.randomBytes(24).toString('hex')));
    u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(correo);
  }
  return u;
}
// La oficina pone el precio acordado, el vehículo y el piloto. Se genera un enlace (/flete/<clave>) para que el cliente
// complete los datos de quien entrega y quien recibe; después se comparten las ubicaciones en vivo como en un envío normal.
const MAX_AYUDANTES = 5;
const precioAyudante = () => Math.max(0, Number(getAjustes().precio_ayudante) || 0);
ruta('GET', '/api/admin/fletes/config', ({ req }) => { requiereStaff(req); return { precio_ayudante: precioAyudante(), max_ayudantes: MAX_AYUDANTES,
  vehiculos: db.prepare('SELECT id, nombre, peso_max, solo_oficina FROM vehiculos WHERE activo = 1 ORDER BY id').all() }; });   // los empleados no ven tarifas, pero sí los vehículos
ruta('POST', '/api/admin/fletes', ({ req, body }) => {
  const quien = requiereStaff(req);
  const precioFlete = numero(body.precio);
  if (!(precioFlete > 0 && precioFlete <= 100000)) falla(400, 'Escribe el precio que acordaron con el cliente.');
  // Ayudantes: el precio por persona lo pone la administración; el total se suma a lo que paga el cliente
  const ayudantes = Math.round(numero(body.ayudantes || 0));
  if (!(ayudantes >= 0 && ayudantes <= MAX_AYUDANTES)) falla(400, `Puedes mandar de 0 a ${MAX_AYUDANTES} ayudantes.`);
  const montoAyud = redondear(ayudantes * precioAyudante());
  const precio = redondear(precioFlete + montoAyud);
  const v = db.prepare('SELECT * FROM vehiculos WHERE id = ?').get(numero(body.vehiculo_id));
  if (!v) falla(400, 'Elige el vehículo.');
  const m = pilotoPorId(numero(body.mensajero_id));
  if (!m || !puedeTrabajar(m)) falla(400, 'Elige un piloto aprobado y con sus documentos vigentes.');
  const tel = texto(body.cliente_telefono, 30);
  const cliente = usuarioWhatsapp();
  const guia = nuevaGuia(), token = nuevoTokenReceptor();
  const r = db.prepare(`INSERT INTO envios (guia, usuario_id, vehiculo_id, peso, descripcion, origen_direccion, origen_zona, origen_telefono,
      destino_nombre, destino_telefono, destino_direccion, destino_zona, tipo_tarifa, precio, precio_base, metodo_pago, notas,
      estado, mensajero_id, asignacion, asignado_en, flete, flete_token, flete_telefono, origen_quien, ganancia_piloto, ayudantes, ayudantes_monto, flete_precio)
    VALUES (?, ?, ?, 0, ?, '', ?, ?, '', '', '', ?, 'zona', ?, ?, 'efectivo', ?, 'pendiente', ?, 'aceptado', datetime('now'), 1, ?, ?, 'tercero', ?, ?, ?, ?)`).run(
    guia, cliente.id, v.id, texto(body.descripcion, 200), OTRA_ZONA, tel, OTRA_ZONA, precio, precio, texto(body.notas, 300), m.id, token, tel || null,
    gananciaPiloto(precioFlete), ayudantes, montoAyud, redondear(precioFlete));   // el piloto gana sobre el flete; lo de los ayudantes es para pagarles a ellos
  const id = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(id, 'pendiente',
    `Flete en ${v.nombre.toLowerCase()} acordado por WhatsApp: Q${precio.toFixed(2)}${ayudantes ? ` (flete Q${precioFlete.toFixed(2)} + ${ayudantes} ayudante${ayudantes === 1 ? '' : 's'} Q${montoAyud.toFixed(2)})` : ''}, con ${m.nombre.split(' ')[0]} (${quien.nombre.split(' ')[0]}). Esperando que el cliente complete los datos`);
  avisar(m.id, { titulo: 'Flete asignado', cuerpo: `${guia}: cobra Q${precio.toFixed(2)}${ayudantes ? `. Van ${ayudantes} ayudante${ayudantes === 1 ? '' : 's'} contigo` : ''}. Te avisamos cuando el cliente complete los datos.`, url: RUTA_PILOTO, etiqueta: 'piloto-' + id });
  return { _status: 201, ok: true, id, guia, enlace: '/flete/' + token };
});
function fletePorToken(token) {
  if (!/^[a-f0-9]{32}$/.test(String(token || ''))) falla(404, 'Este enlace no es válido. Pide uno nuevo por WhatsApp.');
  const e = db.prepare(`${SQL_ENVIO} WHERE e.flete_token = ?`).get(token);
  if (!e) falla(404, 'Este enlace no es válido. Pide uno nuevo por WhatsApp.');
  return e;
}
ruta('GET', '/api/flete/:token', ({ params }) => {
  const e = fletePorToken(params.token);
  const aj = getAjustes();
  return { guia: e.guia, precio: e.precio, vehiculo: e.vehiculo, estado: e.estado, configurado: !!e.flete_configurado_en, piloto: (e.mensajero_nombre || '').split(' ')[0],
    flete_precio: e.flete_precio ?? e.precio, ayudantes: e.ayudantes || 0, ayudantes_monto: e.ayudantes_monto || 0, precio_ayudante: e.ayudantes ? redondear(e.ayudantes_monto / e.ayudantes) : precioAyudante(),
    descripcion: e.descripcion, metodo_pago: e.metodo_pago, pago_estado: e.pago_estado, whatsapp_pagos: aj.whatsapp_pagos || '50237731793', datos_transferencia: aj.datos_transferencia || '',
    origen: e.flete_configurado_en ? { nombre: e.origen_nombre, telefono: e.origen_telefono, direccion: e.origen_direccion, zona: e.origen_zona, confirmado: !!e.origen_confirmado_en } : null,
    destino: e.flete_configurado_en ? { nombre: e.destino_nombre, telefono: e.destino_telefono, direccion: e.destino_direccion, zona: e.destino_zona, confirmado: !!e.receptor_confirmado_en } : null,
    enlace_entrega: e.flete_configurado_en && e.estado === 'pendiente' && e.origen_token ? '/entrega/' + e.origen_token : null,
    enlace_recibe: e.flete_configurado_en && ESTADOS_ACTIVOS.includes(e.estado) && e.receptor_token ? '/recibe/' + e.receptor_token : null,
    codigo_entrega: e.flete_configurado_en && ESTADOS_ACTIVOS.includes(e.estado) ? e.codigo_entrega : null,
    zonas: [...zonasFijas().map((z) => z.nombre), OTRA_ZONA] };
});
ruta('POST', '/api/flete/:token', ({ req, params, body }) => {
  if (limitar(ipDe(req), 'flete-config', 20, 3600_000)) falla(429, 'Demasiados intentos. Espera un momento.');
  const e = fletePorToken(params.token);
  if (e.flete_configurado_en) falla(400, 'Este flete ya tiene sus datos. Si necesitas cambiar algo, escríbenos por WhatsApp.');
  if (e.estado !== 'pendiente') falla(400, 'Este flete ya no se puede configurar.');
  const d = {
    origen_nombre: texto(body.origen_nombre, 100), origen_telefono: texto(body.origen_telefono, 30), origen_direccion: texto(body.origen_direccion, 300), origen_zona: texto(body.origen_zona, 60) || OTRA_ZONA,
    destino_nombre: texto(body.destino_nombre, 100), destino_telefono: texto(body.destino_telefono, 30), destino_direccion: texto(body.destino_direccion, 300), destino_zona: texto(body.destino_zona, 60) || OTRA_ZONA,
    descripcion: texto(body.descripcion, 200) || e.descripcion, notas: texto(body.notas, 300),
  };
  if (d.origen_nombre.length < 2 || d.origen_telefono.replace(/\D/g, '').length < 8) falla(400, 'Escribe el nombre y teléfono de quien entrega la carga.');
  if (d.destino_nombre.length < 2 || d.destino_telefono.replace(/\D/g, '').length < 8) falla(400, 'Escribe el nombre y teléfono de quien recibe.');
  if (d.descripcion.length < 3) falla(400, 'Escribe qué se va a llevar.');
  if (!body.foto) falla(400, 'Toma una foto de lo que se va a llevar.');
  const metodo = 'efectivo';
  const cobro = body.cobro_destinatario === '' || body.cobro_destinatario == null ? 0 : numero(body.cobro_destinatario);
  if (!Number.isFinite(cobro) || cobro < 0 || cobro > 50000) falla(400, 'Revisa el monto a cobrar a quien recibe.');
  db.exec('BEGIN');
  try {
    guardarArchivoEnvio(e.id, 'paquete', body.foto);
    db.prepare(`UPDATE envios SET origen_nombre = ?, origen_telefono = ?, origen_direccion = ?, origen_zona = ?, destino_nombre = ?, destino_telefono = ?, destino_direccion = ?, destino_zona = ?,
        descripcion = ?, notas = TRIM(COALESCE(notas, '') || ' ' || ?), metodo_pago = ?, pago_estado = ?, cobro_destinatario = ?, flete_cliente = ?, flete_telefono = COALESCE(flete_telefono, ?),
        origen_token = ?, receptor_token = ?, codigo_entrega = ?, flete_configurado_en = datetime('now'), actualizado = datetime('now') WHERE id = ?`).run(
      d.origen_nombre, d.origen_telefono, d.origen_direccion, d.origen_zona, d.destino_nombre, d.destino_telefono, d.destino_direccion, d.destino_zona,
      d.descripcion, d.notas, metodo, metodo === 'transferencia' ? 'sin_comprobante' : null, redondear(cobro), d.origen_nombre, d.origen_telefono,
      nuevoTokenReceptor(), nuevoTokenReceptor(), String(crypto.randomInt(1000, 10000)), e.id);
    db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, 'pendiente', 'El cliente completó los datos del flete. Esperando las ubicaciones en vivo');
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  if (e.mensajero_id) avisar(e.mensajero_id, { titulo: 'Flete con datos completos', cuerpo: `${e.guia}: recoger con ${d.origen_nombre}, entregar a ${d.destino_nombre}.`, url: RUTA_PILOTO, etiqueta: 'piloto-' + e.id, urgente: true });
  avisarStaff({ titulo: 'Flete configurado', cuerpo: `${e.guia}: ${d.descripcion}`, url: RUTA_ADMIN, etiqueta: 'flete-' + e.id });
  return { ok: true };
}, { limite: 1_200_000 });

// ---------- Reclamos: paquete perdido, dañado o incompleto ----------
// El cliente lo reporta; la oficina evalúa según lo que llevaba (foto y valor declarado), decide cuánto se le devuelve
// y cuánto paga el piloto responsable (se descuenta de su próximo pago).
const TIPOS_RECLAMO = { perdido: 'El paquete se perdió', danado: 'Llegó dañado', incompleto: 'Llegó incompleto', otro: 'Otro problema' };
ruta('POST', '/api/envios/:id/reclamo', ({ req, params, body }) => {
  const u = requiereUsuario(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND usuario_id = ?').get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
  if (['pendiente', 'cancelado'].includes(e.estado)) falla(400, 'Puedes reportar un problema cuando el paquete ya está en manos de Vaelo o fue entregado.');
  const dias = Number(getAjustes().dias_reclamo) || 3;
  if (e.estado === 'entregado' && e.entregado_en && fechaMs(e.entregado_en) < Date.now() - dias * 86400_000) falla(400, `Los problemas se reportan dentro de ${dias} días después de la entrega.`);
  if (db.prepare("SELECT 1 FROM reclamos WHERE envio_id = ? AND estado = 'abierto'").get(e.id)) falla(400, 'Ya tienes un reporte abierto para este envío. Te contactaremos.');
  const tipo = TIPOS_RECLAMO[body.tipo] ? body.tipo : falla(400, 'Elige qué pasó.');
  const desc = texto(body.descripcion, 1000);
  if (desc.length < 10) falla(400, 'Cuéntanos qué pasó y qué llevaba el paquete.');
  const r = db.prepare('INSERT INTO reclamos (envio_id, usuario_id, tipo, descripcion, piloto_id) VALUES (?, ?, ?, ?, ?)').run(e.id, u.id, tipo, desc, e.mensajero_id);
  const id = Number(r.lastInsertRowid);
  if (body.foto) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.foto));
    if (m) {
      const datos = Buffer.from(m[2], 'base64');
      if (datos.length > 300 && datos.length < 700_000) {
        const nombre = `reclamo-${id}-${crypto.randomBytes(6).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
        fs.mkdirSync(DOCS_DIR, { recursive: true, mode: 0o750 });
        fs.writeFileSync(path.join(DOCS_DIR, nombre), datos, { mode: 0o640 });
        db.prepare('UPDATE reclamos SET foto = ? WHERE id = ?').run(nombre, id);
      }
    }
  }
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, `El cliente reportó un problema: ${TIPOS_RECLAMO[tipo]}`);
  avisarStaff({ titulo: 'Reclamo de un cliente', cuerpo: `${e.guia}: ${TIPOS_RECLAMO[tipo]}`, url: RUTA_ADMIN, etiqueta: 'reclamo-' + id, urgente: true });
  return { _status: 201, ok: true };
}, { limite: 1_000_000 });
const reclamosDe = (envioId) => db.prepare('SELECT r.*, u.nombre AS piloto FROM reclamos r LEFT JOIN usuarios u ON u.id = r.piloto_id WHERE r.envio_id = ? ORDER BY r.id').all(envioId)
  .map((r) => ({ ...r, tipo_texto: TIPOS_RECLAMO[r.tipo], tiene_foto: !!r.foto, foto: undefined }));
ruta('GET', '/api/envios/:id/reclamos', ({ req, params }) => {
  const u = requiereUsuario(req);
  const e = db.prepare('SELECT id FROM envios WHERE id = ? AND usuario_id = ?').get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
  return { reclamos: reclamosDe(e.id).map(({ monto_piloto, piloto, piloto_id, descontado_pago_id, ...r }) => r), dias: Number(getAjustes().dias_reclamo) || 3 };
});
// Quejas de clientes y empresas (apartado propio del panel): filtros por estado y búsqueda
const SQL_QUEJAS = `SELECT r.*, e.guia, e.valor_declarado, e.pedido_id, e.estado AS envio_estado, e.destino_nombre, e.precio AS envio_precio, c.nombre AS cliente, c.telefono AS cliente_telefono,
    c.empresa_nombre, c.tipo_cuenta, p.nombre AS piloto FROM reclamos r JOIN envios e ON e.id = r.envio_id
    JOIN usuarios c ON c.id = r.usuario_id LEFT JOIN usuarios p ON p.id = r.piloto_id`;
const FILTROS_QUEJA = { abiertos: "r.estado = 'abierto'", devolver: "r.estado = 'aprobado' AND r.monto_cliente > 0 AND r.devuelto_en IS NULL",
  resueltos: "r.estado != 'abierto'", todos: '1 = 1' };
ruta('GET', '/api/admin/reclamos', ({ req, query }) => {
  requiereStaff(req);
  const filtro = FILTROS_QUEJA[query.get('estado')] || "(r.estado = 'abierto' OR (r.estado = 'aprobado' AND r.devuelto_en IS NULL AND r.monto_cliente > 0)) OR r.creado >= datetime('now','-30 days')";
  const q = texto(query.get('q'), 60);
  const extra = q ? ' AND (e.guia LIKE ? OR c.nombre LIKE ? OR c.empresa_nombre LIKE ? OR p.nombre LIKE ? OR r.descripcion LIKE ?)' : '';
  const reclamos = db.prepare(`${SQL_QUEJAS} WHERE (${filtro})${extra}
    ORDER BY CASE WHEN r.estado = 'abierto' THEN 0 WHEN r.estado = 'aprobado' AND r.devuelto_en IS NULL AND r.monto_cliente > 0 THEN 1 ELSE 2 END, r.id DESC LIMIT 200`)
    .all(...(q ? Array(5).fill(`%${q}%`) : []))
    .map((r) => ({ ...r, tipo_texto: TIPOS_RECLAMO[r.tipo], tiene_foto: !!r.foto, foto: undefined, es_empresa: r.tipo_cuenta === 'empresa' }));
  const cuenta = (w) => db.prepare(`SELECT COUNT(*) AS n FROM reclamos r WHERE ${w}`).get().n;
  return { reclamos, conteo: { abiertos: cuenta(FILTROS_QUEJA.abiertos), devolver: cuenta(FILTROS_QUEJA.devolver), resueltos: cuenta(FILTROS_QUEJA.resueltos), todos: cuenta('1 = 1') } };
});
ruta('GET', '/api/admin/reclamos/:id/foto', ({ req, res, params }) => {
  requiereStaff(req);
  const r = db.prepare('SELECT foto FROM reclamos WHERE id = ?').get(Number(params.id));
  if (!r || !r.foto) falla(404, 'No hay foto.');
  return enviarArchivoEnvio(res, { foto_entrega: r.foto }, 'foto');
});
ruta('POST', '/api/admin/reclamos/:id', ({ req, params, body }) => {
  const quien = requiereRol(req, 'admin');
  const r = db.prepare('SELECT * FROM reclamos WHERE id = ?').get(Number(params.id));
  if (!r) falla(404, 'No encontramos ese reclamo.');
  const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(r.envio_id);
  const nombre = quien.nombre.split(' ')[0];
  if (body.accion === 'aprobar' || body.accion === 'rechazar') {
    if (r.estado !== 'abierto') falla(400, 'Este reclamo ya se resolvió.');
    const resolucion = texto(body.resolucion, 500);
    if (resolucion.length < 5) falla(400, 'Escribe qué se evaluó y qué se decidió. El cliente lo verá.');
    let cupon = 0;
    if (body.accion === 'aprobar') {
      const mc = numero(body.monto_cliente) || 0, mp = numero(body.monto_piloto) || 0;
      cupon = numero(body.cupon_monto) || 0;
      if (!(mc >= 0 && mc <= 100000) || !(mp >= 0 && mp <= 100000) || !(cupon >= 0 && cupon <= 5000)) falla(400, 'Revisa los montos.');
      db.prepare("UPDATE reclamos SET estado = 'aprobado', monto_cliente = ?, monto_piloto = ?, resolucion = ?, resuelto_por = ?, resuelto_en = datetime('now') WHERE id = ?")
        .run(redondear(mc), r.piloto_id ? redondear(mp) : 0, resolucion, nombre, r.id);
      // Descuento para su próximo envío: solo para este cliente, se usa una vez y vale 30 días (se aplica solo al cotizar)
      if (cupon > 0) {
        const hoy = hoyGT();
        const pr = db.prepare(`INSERT INTO promociones (nombre, codigo, tipo, valor, desde, hasta, usos_max, usos_por_cliente, usuario_id, reclamo_id)
          VALUES (?, NULL, 'monto', ?, ?, ?, 1, 1, ?, ?)`).run(`Disculpa por ${e.guia}`, redondear(cupon), hoy, sumarDias(hoy, 30), r.usuario_id, r.id);
        db.prepare('UPDATE reclamos SET cupon_monto = ?, cupon_promo_id = ? WHERE id = ?').run(redondear(cupon), Number(pr.lastInsertRowid), r.id);
      }
      db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, `Reclamo evaluado: se devolverán Q${redondear(mc).toFixed(2)} al cliente${cupon > 0 ? ` y tiene Q${redondear(cupon).toFixed(2)} de descuento en su próximo envío` : ''}`);
      if (r.piloto_id && mp > 0) avisar(r.piloto_id, { titulo: 'Descuento por reclamo', cuerpo: `${e.guia}: se descontarán Q${redondear(mp).toFixed(2)} de tu próximo pago. ${resolucion}`, url: RUTA_PILOTO });
    } else {
      db.prepare("UPDATE reclamos SET estado = 'rechazado', resolucion = ?, resuelto_por = ?, resuelto_en = datetime('now') WHERE id = ?").run(resolucion, nombre, r.id);
    }
    const textoCupon = cupon > 0 ? `Además tienes Q${redondear(cupon).toFixed(2)} de descuento en tu próximo envío (se aplica solo, vale 30 días).` : '';
    avisar(r.usuario_id, { titulo: 'Revisamos tu reporte', cuerpo: `${e.guia}: ${resolucion}${textoCupon ? ' ' + textoCupon : ''}`, url: `/mi-cuenta?envio=${e.id}` });
    correoA(r.usuario_id, `Tu reporte del envío ${e.guia}`, 'Revisamos tu reporte', [resolucion,
      body.accion === 'aprobar' && numero(body.monto_cliente) > 0 ? `Te devolveremos Q${redondear(numero(body.monto_cliente)).toFixed(2)}. Te contactaremos para coordinar la devolución.` : '', textoCupon].filter(Boolean),
      { texto: 'Ver mi envío', url: `/mi-cuenta?envio=${e.id}` });
    return { ok: true };
  }
  if (body.accion === 'devuelto') {
    if (r.estado !== 'aprobado' || r.devuelto_en) falla(400, 'No hay devolución pendiente en este reclamo.');
    db.prepare("UPDATE reclamos SET devuelto_en = datetime('now') WHERE id = ?").run(r.id);
    return { ok: true };
  }
  falla(400, 'Acción no válida.');
});
// Descuentos al piloto por reclamos aprobados que todavía no se descontaron
const descuentosPiloto = (pilotoId) => db.prepare(`SELECT r.id, r.monto_piloto, r.resolucion, r.resuelto_en, e.guia FROM reclamos r JOIN envios e ON e.id = r.envio_id
  WHERE r.piloto_id = ? AND r.estado = 'aprobado' AND r.monto_piloto > 0 AND r.descontado_pago_id IS NULL ORDER BY r.id`).all(pilotoId);

// ---------- Empresas: solicitud de contrato ----------
const CAMPOS_EMPRESA = { empresa_nombre: 100, razon_social: 150, nit: 20, giro: 120, sitio_web: 200, direccion: 300, zona: 60, telefono: 30, correo: 150,
  rep_nombre: 100, rep_cargo: 80, rep_dpi: 17, rep_telefono: 30, rep_correo: 150 };
const DOCS_EMPRESA = { foto_sede_frente: { nombre: 'Fachada de la sede' }, foto_sede_interior: { nombre: 'Interior o bodega de la sede' }, foto_rep: { nombre: 'Foto del representante' },
  dpi_rep_frente: { nombre: 'DPI del representante (frente)' }, dpi_rep_reverso: { nombre: 'DPI del representante (reverso)' },
  patente: { nombre: 'Patente de comercio', pdf: true }, rtu: { nombre: 'RTU de la SAT', pdf: true, opcional: true } };
const ESTADOS_SOLICITUD = { borrador: 'Sin enviar', enviada: 'En revisión', cita: 'Cita para firmar', aprobada: 'Contrato firmado', rechazada: 'Rechazada' };
function solicitudDe(usuarioId, crear = false) {
  let s = db.prepare('SELECT * FROM solicitudes_empresa WHERE usuario_id = ?').get(usuarioId);
  if (!s && crear) { db.prepare('INSERT INTO solicitudes_empresa (usuario_id) VALUES (?)').run(usuarioId); s = db.prepare('SELECT * FROM solicitudes_empresa WHERE usuario_id = ?').get(usuarioId); }
  return s;
}
function solicitudSalida(s) {
  if (!s) return null;
  const out = { ...s, docs: {}, estado_texto: ESTADOS_SOLICITUD[s.estado] };
  for (const k of Object.keys(DOCS_EMPRESA)) { out.docs[k] = !!s[k]; delete out[k]; }
  const falta = [];
  for (const k of ['empresa_nombre', 'nit', 'giro', 'direccion', 'zona', 'telefono', 'correo', 'rep_nombre', 'rep_cargo', 'rep_dpi', 'rep_telefono']) if (!s[k]) falta.push(k);
  if (!s.paquetes_mes) falta.push('paquetes_mes');
  for (const [k, d] of Object.entries(DOCS_EMPRESA)) if (!d.opcional && !s[k]) falta.push(k);
  out.falta = falta;
  return out;
}
ruta('GET', '/api/empresa/solicitud', ({ req }) => {
  const u = requiereRol(req, 'cliente');
  return { solicitud: solicitudSalida(solicitudDe(u.id)), documentos: DOCS_EMPRESA, estados: ESTADOS_SOLICITUD,
    es_empresa: db.prepare('SELECT tipo_cuenta FROM usuarios WHERE id = ?').get(u.id).tipo_cuenta === 'empresa',
    es_minorista: db.prepare('SELECT tipo_cuenta FROM usuarios WHERE id = ?').get(u.id).tipo_cuenta === 'minorista' };
});
ruta('PUT', '/api/empresa/solicitud', ({ req, body }) => {
  const u = requiereRol(req, 'cliente');
  const s = solicitudDe(u.id, true);
  if (!['borrador', 'rechazada'].includes(s.estado)) falla(400, 'Tu solicitud ya se envió. Si necesitas cambiar algo, escríbenos por WhatsApp.');
  const datos = {};
  for (const [k, max] of Object.entries(CAMPOS_EMPRESA)) if (body[k] !== undefined) datos[k] = texto(String(body[k]), max) || null;
  if (datos.rep_dpi) { datos.rep_dpi = datos.rep_dpi.replace(/\D/g, ''); if (datos.rep_dpi.length !== 13) falla(400, 'El DPI del representante debe tener 13 dígitos.'); }
  if (datos.correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(datos.correo)) falla(400, 'Revisa el correo de la empresa.');
  if (datos.nit) datos.nit = datos.nit.toUpperCase().replace(/\s/g, '');
  if (body.paquetes_mes !== undefined) { const n = Math.round(numero(body.paquetes_mes)); datos.paquetes_mes = n > 0 ? Math.min(n, 1_000_000) : null; }
  const claves = Object.keys(datos);
  if (claves.length) db.prepare(`UPDATE solicitudes_empresa SET ${claves.map((k) => `${k} = ?`).join(', ')}, actualizado = datetime('now') WHERE id = ?`).run(...claves.map((k) => datos[k]), s.id);
  return { ok: true, solicitud: solicitudSalida(solicitudDe(u.id)) };
});
ruta('POST', '/api/empresa/solicitud/documento', ({ req, body }) => {
  const u = requiereRol(req, 'cliente');
  const s = solicitudDe(u.id, true);
  if (!['borrador', 'rechazada'].includes(s.estado)) falla(400, 'Tu solicitud ya se envió.');
  const d = DOCS_EMPRESA[body.campo];
  if (!d) falla(400, 'Documento no válido.');
  const m = /^data:(image\/(jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.archivo || ''));
  if (!m) falla(400, d.pdf ? 'Sube una foto o un PDF.' : 'Sube una foto.');
  const esPdf = m[1] === 'application/pdf';
  if (esPdf && !d.pdf) falla(400, `${d.nombre}: tiene que ser una foto.`);
  const datos = Buffer.from(m[3], 'base64');
  if (datos.length < 1500 || datos.length > 700_000) falla(400, 'El archivo está vacío o pesa más de 700 KB.');
  const ext = esPdf ? 'pdf' : (m[2] === 'jpeg' ? 'jpg' : m[2]);
  if (!FIRMAS[ext].every((b, i) => datos[i] === b)) falla(400, 'El archivo no es válido.');
  fs.mkdirSync(DOCS_DIR, { recursive: true, mode: 0o750 });
  const nombre = `empresa-${s.id}-${body.campo}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(DOCS_DIR, nombre), datos, { mode: 0o640 });
  if (s[body.campo]) fs.rm(path.join(DOCS_DIR, path.basename(s[body.campo])), () => {});
  db.prepare(`UPDATE solicitudes_empresa SET ${body.campo} = ?, actualizado = datetime('now') WHERE id = ?`).run(nombre, s.id);
  return { ok: true };
}, { limite: 1_000_000 });
function enviarDocEmpresa(res, s, campo) {
  if (!s || !DOCS_EMPRESA[campo] || !s[campo]) falla(404, 'No hay archivo.');
  return enviarArchivoEnvio(res, { foto_entrega: s[campo] }, 'foto');
}
ruta('GET', '/api/empresa/solicitud/documento/:campo', ({ req, res, params }) => enviarDocEmpresa(res, solicitudDe(requiereRol(req, 'cliente').id), params.campo));
ruta('POST', '/api/empresa/solicitud/enviar', ({ req, body }) => {
  const u = requiereRol(req, 'cliente');
  const s = solicitudDe(u.id);
  if (!s || !['borrador', 'rechazada'].includes(s.estado)) falla(400, 'No hay una solicitud por enviar.');
  if (solicitudSalida(s).falta.length) falla(400, 'Completa todos los datos y documentos antes de enviar.');
  if (body.acepto_politica !== true) falla(400, 'Para enviar la solicitud acepta las políticas para empresas.');
  db.prepare("UPDATE solicitudes_empresa SET estado = 'enviada', acepto_politica = datetime('now'), enviada_en = datetime('now'), motivo_rechazo = NULL, actualizado = datetime('now') WHERE id = ?").run(s.id);
  db.prepare("UPDATE usuarios SET politica_empresa = datetime('now') WHERE id = ?").run(u.id);
  avisarStaff({ titulo: 'Solicitud de empresa', cuerpo: `${s.empresa_nombre} quiere usar los pilotos de Vaelo (${s.paquetes_mes} paquetes al mes).`, url: RUTA_ADMIN, etiqueta: 'empresa-' + s.id });
  return { ok: true };
});
// Panel: revisar solicitudes, poner la cita para firmar y activar la cuenta de empresa
ruta('GET', '/api/admin/empresas', ({ req }) => {
  requiereRol(req, 'admin');
  return { solicitudes: db.prepare(`SELECT s.*, u.nombre AS usuario, u.email AS usuario_email FROM solicitudes_empresa s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.estado != 'borrador' ORDER BY CASE s.estado WHEN 'enviada' THEN 0 WHEN 'cita' THEN 1 WHEN 'aprobada' THEN 2 ELSE 3 END, s.actualizado DESC`).all()
      .map((s) => ({ ...solicitudSalida(s), usuario: s.usuario, usuario_email: s.usuario_email })),
    documentos: DOCS_EMPRESA, estados: ESTADOS_SOLICITUD };
});
ruta('GET', '/api/admin/empresas/:id/documento/:campo', ({ req, res, params }) => {
  requiereRol(req, 'admin');
  return enviarDocEmpresa(res, db.prepare('SELECT * FROM solicitudes_empresa WHERE id = ?').get(Number(params.id)), params.campo);
});
ruta('POST', '/api/admin/empresas/:id', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const s = db.prepare('SELECT * FROM solicitudes_empresa WHERE id = ?').get(Number(params.id));
  if (!s) falla(404, 'No encontramos esa solicitud.');
  const url = '/mi-cuenta?empresa=1';
  if (body.accion === 'cita') {
    if (!['enviada', 'cita'].includes(s.estado)) falla(400, 'Esta solicitud no está en revisión.');
    const f = texto(body.fecha, 16);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(f)) falla(400, 'Elige la fecha y hora de la cita.');
    const lugar = texto(body.lugar, 200) || getAjustes().sede_direccion || 'Sede de Vaelo';
    db.prepare("UPDATE solicitudes_empresa SET estado = 'cita', cita_fecha = ?, cita_lugar = ?, nota_admin = ?, actualizado = datetime('now') WHERE id = ?").run(f, lugar, texto(body.nota, 500) || null, s.id);
    const cuando = new Date(f + ':00-06:00').toLocaleString('es-GT', { timeZone: 'America/Guatemala', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
    avisar(s.usuario_id, { titulo: 'Cita para firmar tu contrato', cuerpo: `${cuando} en ${lugar}`, url });
    correoA(s.usuario_id, 'Cita para firmar tu contrato con Vaelo', `Tu cita es el ${cuando}`, [`Lugar: ${lugar}.`, 'Lleva el DPI del representante y la patente de comercio originales.', texto(body.nota, 500)].filter(Boolean), { texto: 'Ver mi solicitud', url });
    return { ok: true };
  }
  if (body.accion === 'aprobar') {
    if (!['enviada', 'cita'].includes(s.estado)) falla(400, 'Esta solicitud no está en revisión.');
    db.prepare("UPDATE solicitudes_empresa SET estado = 'aprobada', aprobada_en = datetime('now'), actualizado = datetime('now') WHERE id = ?").run(s.id);
    db.prepare("UPDATE usuarios SET tipo_cuenta = 'empresa', empresa_nombre = ?, credito_permitido = 0 WHERE id = ?").run(s.empresa_nombre, s.usuario_id);
    avisar(s.usuario_id, { titulo: 'Bienvenido a Vaelo Empresas', cuerpo: `${s.empresa_nombre} ya puede usar el apartado de empresa.`, url });
    correoA(s.usuario_id, 'Tu cuenta de empresa está activa', `Bienvenido, ${s.empresa_nombre}`, ['Tu contrato quedó firmado. Ya puedes enviar paquetes como empresa, mandar envíos a nuestra sede y ver tus estadísticas.'], { texto: 'Entrar al apartado de empresa', url });
    return { ok: true };
  }
  if (body.accion === 'rechazar') {
    const motivo = texto(body.motivo, 500);
    if (motivo.length < 5) falla(400, 'Escribe el motivo para que la empresa sepa qué corregir.');
    db.prepare("UPDATE solicitudes_empresa SET estado = 'rechazada', motivo_rechazo = ?, actualizado = datetime('now') WHERE id = ?").run(motivo, s.id);
    avisar(s.usuario_id, { titulo: 'Revisa tu solicitud de empresa', cuerpo: motivo, url });
    return { ok: true };
  }
  falla(400, 'Acción no válida.');
});

// ---------- Tienda minorista: cuenta normal que vende en lives o redes y manda varios pedidos a la vez ----------
const esNegocio = (u) => !!u && (u.tipo_cuenta === 'empresa' || u.tipo_cuenta === 'minorista');
function revisarSinPedidosAbiertos(uid) {
  const n = db.prepare("SELECT COUNT(*) AS n FROM pedidos_empresa WHERE usuario_id = ? AND estado IN ('pendiente','esperando','confirmado','vencido','no_puede') AND lote_id IS NULL").get(uid).n;
  const l = db.prepare("SELECT COUNT(*) AS n FROM lotes_empresa WHERE usuario_id = ? AND estado IN ('nuevo','en_ruta')").get(uid).n;
  if (n || l) falla(400, 'Primero termina o borra los pedidos que tienes en tus carpetas.');
}
ruta('POST', '/api/cuenta/minorista', ({ req, body }) => {
  const yo = requiereRol(req, 'cliente');
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(yo.id);
  if (u.tipo_cuenta === 'empresa') falla(400, 'Tu cuenta ya es de empresa: ya tienes todo lo de la tienda.');
  if (body.activar === false) {
    if (u.tipo_cuenta !== 'minorista') return { ok: true };
    revisarSinPedidosAbiertos(u.id);
    db.prepare("UPDATE usuarios SET tipo_cuenta = 'personal', empresa_nombre = NULL WHERE id = ?").run(u.id);
    return { ok: true, tipo_cuenta: 'personal' };
  }
  const tienda = texto(body.tienda, 60);
  if (tienda.length < 2) falla(400, 'Escribe el nombre de tu tienda (el que ven tus clientes en tus lives).');
  const solicitud = leerSolicitudTienda(body);
  db.prepare("UPDATE usuarios SET tipo_cuenta = 'minorista', empresa_nombre = ?, descuento_empresa = 0 WHERE id = ?").run(tienda, u.id);
  // Una tienda que Vaelo ya aprobó no vuelve a revisión por guardar otra vez sus datos o por reactivar la tienda
  if (u.tienda_estado === 'aprobada') {
    db.prepare('UPDATE usuarios SET tienda_red = COALESCE(?, tienda_red), tienda_zona = COALESCE(?, tienda_zona), tienda_semana = COALESCE(?, tienda_semana) WHERE id = ?')
      .run(solicitud.red, solicitud.zona, solicitud.semana, u.id);
    return { ok: true, tipo_cuenta: 'minorista', pendiente: false, minimo: minimoLote({ tipo_cuenta: 'minorista' }) };
  }
  guardarSolicitudTienda(u.id, u.nombre, tienda, solicitud);
  return { ok: true, tipo_cuenta: 'minorista', pendiente: true, minimo: minimoLote({ tipo_cuenta: 'minorista' }) };
});

// ---------- Empresas: envíos a la sede de Vaelo (10 paquetes o más) ----------
// ---------- Solicitud de cuenta minorista ----------
function leerSolicitudTienda(b) {
  const zona = texto(b.tienda_zona, 60);
  if (zona && zona !== OTRA_ZONA && !zonasFijas().some((z) => z.nombre === zona)) falla(400, 'Elige la zona donde más vendes de la lista.');
  const semana = b.tienda_semana === undefined || b.tienda_semana === '' ? null : Math.round(numero(b.tienda_semana));
  if (semana !== null && !(semana >= 0 && semana <= 5000)) falla(400, 'Escribe cuántos pedidos mandas por semana, más o menos.');
  return { red: texto(b.tienda_red, 200) || null, zona: zona || null, semana };
}
function guardarSolicitudTienda(id, nombre, tienda, s) {
  db.prepare("UPDATE usuarios SET tienda_estado = 'pendiente', tienda_red = ?, tienda_zona = ?, tienda_semana = ?, tienda_solicitud_en = datetime('now'), tienda_nota = NULL WHERE id = ?")
    .run(s.red, s.zona, s.semana, id);
  avisarStaff({ titulo: 'Nueva solicitud de tienda', cuerpo: `${nombre} quiere abrir la tienda «${tienda}»${s.zona ? ` (vende más en ${s.zona})` : ''}. Revísala en Planes.`, url: RUTA_ADMIN, etiqueta: 'tienda-' + id, urgente: true });
}
// Lo que le recomienda el panel a la oficina según lo que contó la tienda
function recomendacionTienda(u) {
  const z = u.tienda_zona, semana = Number(u.tienda_semana) || 0;
  const dibujada = z && zonasConForma().some((x) => x.nombre === z);
  if (!z || z === OTRA_ZONA) return { foco: false, texto: 'Vende en varias zonas o fuera de las zonas de Vaelo: conviene empezar sin zona foco y revisar en un mes.' };
  if (!dibujada) return { foco: false, texto: `${z} no está dibujada en el mapa de zonas: dibújala antes de darle zona foco.` };
  if (semana < 3) return { foco: false, zona: z, texto: `Vende más en ${z}, pero manda pocos pedidos por semana (${semana}). Conviene empezar sin zona foco y activarla cuando junte al menos 3 por carpeta.` };
  return { foco: true, zona: z, texto: `Se recomienda zona foco ${z}: vende sobre todo ahí y manda unos ${semana} pedidos por semana, así que sus carpetas pueden llegar al mínimo de 3 en ${z}.` };
}
const tiendaEnRevision = (u) => u.tipo_cuenta === 'minorista' && (u.tienda_estado === 'pendiente' || u.tienda_estado === 'rechazada');
function requiereEmpresa(req) {
  const u = requiereRol(req, 'cliente');
  const f = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.id);
  if (!esNegocio(f)) falla(403, 'Este apartado es para empresas y tiendas.');
  return f;
}
// La bodega en la sede (10 paquetes o más) es solo para empresas con contrato
function requiereEmpresaFirmada(req) {
  const f = requiereEmpresa(req);
  if (f.tipo_cuenta !== 'empresa') falla(403, 'Este apartado es para empresas con contrato firmado.');
  return f;
}
function cobrarBodegaEmpresa(e) {
  const lote = db.prepare('SELECT * FROM lotes_sede WHERE id = ?').get(e.lote_sede_id);
  if (!lote || !lote.recibido_en) return;
  // Días completos en la sede: el día que llegó no cuenta si sale ese mismo día
  const llegada = new Date(fechaMs(lote.recibido_en) - 6 * 3600_000).toISOString().slice(0, 10);
  const dias = Math.max(0, Math.round((Date.parse(hoyGT()) - Date.parse(llegada)) / 86400_000));
  if (!dias) return;
  const monto = dias * (Number(getAjustes().cargo_bodega_empresa) || 0) * (e.paquetes || 1);
  crearCargo(e.usuario_id, e.id, 'bodega_empresa', monto, `${e.paquetes > 1 ? e.paquetes + ' paquetes, ' : ''}${dias} día(s) en la sede`);
}
ruta('POST', '/api/empresa/lote-sede', async ({ req, body }) => {
  const u = requiereEmpresaFirmada(req);
  const aj = getAjustes(), minimo = Number(aj.min_paquetes_sede) || 10;
  if (!sedeUbicacion()) falla(400, 'Todavía no está configurada la ubicación de la sede. Escríbenos por WhatsApp.');
  const filas = Array.isArray(body.filas) ? body.filas : [];
  const total = filas.reduce((t, f) => t + Math.max(1, Math.round(numero(f.paquetes)) || 1), 0);
  if (total < minimo) falla(400, `Un envío a la sede lleva al menos ${minimo} paquetes. Este tiene ${total}.`);
  if (filas.length > 300) falla(400, 'Máximo 300 entregas por envío a la sede.');
  const desde = texto(body.entregar_desde, 10);
  if (desde && (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || desde < hoyGT())) falla(400, 'Revisa la fecha para repartir.');
  const metodo = ['recibe', 'efectivo'].includes(body.metodo_pago) ? body.metodo_pago : 'recibe';
  const preparados = [], errores = [];
  for (const [i, fila] of filas.entries()) {
    const b = { destino_nombre: fila.destino_nombre, destino_telefono: fila.destino_telefono, destino_direccion: fila.destino_direccion, destino_zona: fila.destino_zona || OTRA_ZONA,
      peso: fila.peso || 1, descripcion: fila.descripcion, cobro_destinatario: fila.cobro_destinatario, notas: fila.notas, paquetes: fila.paquetes, fragil: fila.fragil === true || /^s/i.test(String(fila.fragil || '')),
      vehiculo_id: db.prepare('SELECT id FROM vehiculos WHERE activo = 1 AND solo_oficina = 0 ORDER BY orden, id LIMIT 1').get()?.id,
      origen_quien: 'sede', origen_zona: zonaDePunto(sedeUbicacion()) || zonasFijas()[0]?.nombre || OTRA_ZONA,   // la sede cuenta como zona preferencial
      origen_direccion: aj.sede_direccion || 'Sede Vaelo', origen_telefono: u.telefono, metodo_pago: metodo, _lote_sede_id: -1 };
    try {
      const d = validarPedido(u, b);
      const c = await cotizar({ ...b, origen_lat: sedeUbicacion().lat, origen_lng: sedeUbicacion().lng });
      preparados.push({ b, d, c, desc: mejorDescuento(c.precio, u.id, '') });
    } catch (err) { errores.push(`Fila ${i + 2}: ${err.message}`); }
  }
  if (errores.length) return { _status: 400, ok: false, errores };
  db.exec('BEGIN');
  try {
    const lote = Number(db.prepare('INSERT INTO lotes_sede (usuario_id, paquetes, entregar_desde, nota) VALUES (?, ?, ?, ?)').run(u.id, total, desde || null, texto(body.nota, 300) || null).lastInsertRowid);
    const programado = desde && desde > hoyGT() ? new Date(Date.parse(desde + 'T08:00:00Z') + 6 * 3600_000).toISOString().slice(0, 19).replace('T', ' ') : null;
    const creados = preparados.map((x) => insertarEnvio(u, { ...x.b, _lote_sede_id: lote }, x.d, x.c, x.desc, programado));
    db.exec('COMMIT');
    avisarStaff({ titulo: 'Envío de empresa a la sede', cuerpo: `${u.empresa_nombre || u.nombre} traerá ${total} paquetes a la sede.`, url: RUTA_ADMIN, etiqueta: 'lote-' + lote });
    return { _status: 201, ok: true, lote, paquetes: total, envios: creados.length, guias: creados.map((x) => x.guia), enlaces: creados.map((x) => ({ guia: x.guia, enlace: x.enlace_receptor })) };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}, { limite: 800_000 });
function lotesDe(usuarioId) {
  const tarifa = Number(getAjustes().cargo_bodega_empresa) || 0;
  return db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM envios e WHERE e.lote_sede_id = l.id) AS entregas,
      (SELECT COALESCE(SUM(e.paquetes), 0) FROM envios e WHERE e.lote_sede_id = l.id AND e.estado = 'pendiente') AS en_sede,
      (SELECT COUNT(*) FROM envios e WHERE e.lote_sede_id = l.id AND e.estado = 'entregado') AS entregados
    FROM lotes_sede l WHERE (? IS NULL OR l.usuario_id = ?) ORDER BY l.id DESC LIMIT 100`).all(usuarioId, usuarioId).map((l) => {
    let dias = 0;
    if (l.recibido_en && l.en_sede) dias = Math.max(0, Math.round((Date.parse(hoyGT()) - Date.parse(new Date(fechaMs(l.recibido_en) - 6 * 3600_000).toISOString().slice(0, 10))) / 86400_000));
    return { ...l, dias_en_sede: dias, costo_hoy: redondear(dias * tarifa * l.en_sede) };
  });
}
ruta('GET', '/api/empresa/lotes', ({ req }) => ({ lotes: lotesDe(requiereEmpresaFirmada(req).id), tarifa: Number(getAjustes().cargo_bodega_empresa) || 0, minimo: Number(getAjustes().min_paquetes_sede) || 10,
  sede: getAjustes().sede_direccion || '' }));
ruta('GET', '/api/admin/lotes-sede', ({ req }) => {
  requiereStaff(req);
  return { lotes: lotesDe(null).map((l) => ({ ...l, empresa: db.prepare('SELECT COALESCE(empresa_nombre, nombre) AS n FROM usuarios WHERE id = ?').get(l.usuario_id).n })) };
});
ruta('POST', '/api/admin/lotes-sede/:id', ({ req, params, body }) => {
  const quien = requiereStaff(req);
  const l = db.prepare('SELECT * FROM lotes_sede WHERE id = ?').get(Number(params.id));
  if (!l) falla(404, 'No encontramos ese envío a la sede.');
  if (body.accion === 'recibido') {
    if (l.estado !== 'esperando') falla(400, 'Este envío ya se recibió o se canceló.');
    db.prepare("UPDATE lotes_sede SET estado = 'recibido', recibido_en = datetime('now'), recibido_por = ? WHERE id = ?").run(quien.nombre.split(' ')[0], l.id);
    for (const e of db.prepare("SELECT id FROM envios WHERE lote_sede_id = ? AND estado = 'pendiente'").all(l.id))
      db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, 'pendiente', 'El paquete llegó a la sede de Vaelo');
    avisar(l.usuario_id, { titulo: 'Recibimos tus paquetes', cuerpo: `${l.paquetes} paquetes en la sede de Vaelo. Los que salgan hoy no pagan bodega.`, url: '/mi-cuenta?empresa=1' });
    return { ok: true };
  }
  if (body.accion === 'cancelar') {
    if (l.estado !== 'esperando') falla(400, 'Solo se cancela un envío que todavía no llega a la sede.');
    db.prepare("UPDATE lotes_sede SET estado = 'cancelado' WHERE id = ?").run(l.id);
    for (const e of db.prepare("SELECT id FROM envios WHERE lote_sede_id = ? AND estado = 'pendiente'").all(l.id)) cambiarEstado(e.id, 'cancelado', 'Se canceló el envío de paquetes a la sede');
    return { ok: true };
  }
  falla(400, 'Acción no válida.');
});

// ---------- Empresas: estadísticas ----------
ruta('GET', '/api/empresa/estadisticas', ({ req, query }) => {
  const u = requiereEmpresa(req);
  const hoy = hoyGT();
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(query.get('desde') || '') ? query.get('desde') : sumarDias(hoy, -29);
  const hasta = /^\d{4}-\d{2}-\d{2}$/.test(query.get('hasta') || '') ? query.get('hasta') : hoy;
  const rango = "e.usuario_id = ? AND date(e.creado, '-6 hours') BETWEEN ? AND ?";
  const g = db.prepare(`SELECT COUNT(*) AS envios, COALESCE(SUM(e.paquetes), 0) AS paquetes, SUM(e.estado = 'entregado') AS entregados, SUM(e.fallo_en IS NOT NULL) AS fallidos,
      SUM(e.estado = 'cancelado') AS cancelados, SUM(e.estado IN ${SQL_PILOTO_ACTIVO}) AS en_curso, SUM(e.pedido_id IS NOT NULL) AS de_pedidos,
      AVG(CASE WHEN e.estado = 'entregado' AND e.entregado_en IS NOT NULL THEN (julianday(e.entregado_en) - julianday(COALESCE(e.programado_para, e.creado))) * 1440 END) AS minutos
    FROM envios e WHERE ${rango}`).get(u.id, desde, hasta);
  const porDia = db.prepare(`SELECT date(e.creado, '-6 hours') AS dia, COUNT(*) AS envios, SUM(e.estado = 'entregado') AS entregados FROM envios e WHERE ${rango} GROUP BY dia ORDER BY dia`).all(u.id, desde, hasta);
  const porZona = db.prepare(`SELECT e.destino_zona AS zona, COUNT(*) AS envios FROM envios e WHERE ${rango} AND e.estado != 'cancelado' GROUP BY zona ORDER BY envios DESC LIMIT 8`).all(u.id, desde, hasta);
  const porFallo = db.prepare(`SELECT e.fallo_motivo AS motivo, COUNT(*) AS n FROM envios e WHERE ${rango} AND e.fallo_en IS NOT NULL GROUP BY motivo ORDER BY n DESC`).all(u.id, desde, hasta)
    .map((x) => ({ ...x, texto: MOTIVOS_FALLO[x.motivo] || x.motivo }));
  const porHorario = db.prepare(`SELECT COALESCE(e.horario, 'cualquiera') AS horario, COUNT(*) AS envios, SUM(e.estado = 'entregado') AS entregados FROM envios e WHERE ${rango} AND e.pedido_id IS NOT NULL GROUP BY 1`).all(u.id, desde, hasta)
    .map((x) => ({ ...x, texto: HORARIOS[x.horario] || x.horario }));
  const porDiaSemana = db.prepare(`SELECT CAST(strftime('%w', e.creado, '-6 hours') AS INTEGER) AS d, COUNT(*) AS envios FROM envios e WHERE ${rango} GROUP BY d ORDER BY d`).all(u.id, desde, hasta);
  const enSede = db.prepare("SELECT e.guia, e.destino_nombre, e.sede_llegada, e.sede_salida FROM envios e WHERE e.usuario_id = ? AND e.estado IN ('a_sede','en_sede')").all(u.id)
    .map((e) => ({ guia: e.guia, destino_nombre: e.destino_nombre, dias: e.sede_llegada ? diasEnSede(e) : 0 }));
  const entregadosOk = g.entregados || 0, terminados = entregadosOk + (g.fallidos || 0);
  return { desde, hasta, general: { ...g, entregados: entregadosOk, fallidos: g.fallidos || 0, cancelados: g.cancelados || 0, en_curso: g.en_curso || 0,
      exito: terminados ? Math.round((entregadosOk / terminados) * 100) : null, minutos: g.minutos ? Math.round(g.minutos) : null, de_pedidos: g.de_pedidos || 0 },
    porDia, porZona, porFallo, porHorario, porDiaSemana, en_sede: enSede };
});
// =====================================================================================================
// ---------- Versión 5: pedidos de empresas, rutas, sueldos de pilotos, cierres del día y buscador ----------
// =====================================================================================================
// La empresa registra sus pedidos y su cliente confirma día, horario y ubicación con un enlace (/pedido/<clave>).
// Con 10 pedidos confirmados para el mismo día aparece "Enviar a Vaelo": una moto, varias motos o pickup.
// En el panel se dividen en rutas (la más cercana primero) y se asignan. Vaelo solo cobra el envío.
const TAMANOS = { sobre: { nombre: 'Sobre', ayuda: 'Papeles, documentos', puntos: 1 }, pequeno: { nombre: 'Pequeño', ayuda: 'Cabe en la caja de la moto', puntos: 5 },
  mediano: { nombre: 'Mediano', ayuda: 'Una moto lleva uno o dos', puntos: 15 }, grande: { nombre: 'Grande', ayuda: 'Solo en pickup', puntos: null } };
const HORARIOS = { manana: 'En la mañana', tarde: 'En la tarde', cualquiera: 'A cualquier hora' };
const MODOS_LOTE = { una_moto: 'Una moto para todo', motos: 'Varias motos', un_paquete: 'Un paquete por moto', pickup: 'Pickup' };
const ESTADOS_PEDIDO = { pendiente: 'Falta información', esperando: 'Esperando a tu cliente', confirmado: 'Confirmado', en_vaelo: 'Enviado a Vaelo', enviado: 'En reparto', vencido: 'Venció sin confirmar', no_puede: 'No puede ese día', cancelado: 'Cancelado' };
const ajNum = (k, d) => { const v = Number(getAjustes()[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const vehiculoMoto = () => db.prepare('SELECT * FROM vehiculos WHERE activo = 1 AND solo_oficina = 0 ORDER BY orden, id LIMIT 1').get();
const vehiculoPickup = () => db.prepare('SELECT * FROM vehiculos WHERE activo = 1 AND solo_oficina = 1 ORDER BY orden, id LIMIT 1').get()
  || db.prepare('SELECT * FROM vehiculos WHERE activo = 1 ORDER BY peso_max DESC LIMIT 1').get();
const puntosDe = (t) => TAMANOS[t]?.puntos ?? 999;
const fechaLarga = (dia) => new Date(dia + 'T12:00:00Z').toLocaleDateString('es-GT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const nombreEmpresa = (uid) => db.prepare('SELECT COALESCE(empresa_nombre, nombre) AS n FROM usuarios WHERE id = ?').get(uid)?.n || 'la empresa';
const digitos = (t) => String(t || '').replace(/\D/g, '');

// ---------- Planes de tiendas: lo que recibe una minorista o una empresa ----------
// Cada tienda tiene un plan (el de fábrica según su tipo de cuenta, o el que le ponga administración) y puede tener
// excepciones propias con fecha de vencimiento. Un valor vacío significa "el general" de Tarifas y ajustes.
const CAMPOS_PLAN = {
  precio_zona: { tipo: 'dinero', min: 1, max: 500 },            // precio del envío dentro de las zonas preferenciales
  precio_fuera: { tipo: 'dinero', min: 1, max: 500 },           // precio hacia otras zonas y municipios
  volumen_desde: { tipo: 'entero', min: 1, max: 10000 },        // desde cuántas entregas en el mes aplica el precio por volumen
  volumen_precio_zona: { tipo: 'dinero', min: 1, max: 500 },
  volumen_precio_fuera: { tipo: 'dinero', min: 1, max: 500 },
  minimo: { tipo: 'entero', min: 1, max: 500 },                 // pedidos confirmados para que pasemos a recoger
  cobro_permitido: { tipo: 'si_no' },                           // el piloto puede cobrar el producto al entregar
  comision_tipo: { tipo: 'opcion', opciones: ['ninguna', 'fija', 'porcentaje'] },
  comision_valor: { tipo: 'dinero', min: 0, max: 500 },
  cobro_tope: { tipo: 'dinero', min: 1, max: 50000 },           // máximo a cobrar por paquete
  bodega_dias_gratis: { tipo: 'entero', min: 0, max: 60 },      // días en la sede sin costo cuando no se pudo entregar
  bodega_dia: { tipo: 'dinero', min: 0, max: 1000 },            // después, cuánto cuesta cada día
  ascenso_desde: { tipo: 'entero', min: 1, max: 10000, soloPlan: true },   // avisar a oficina cuando una tienda llega a estas entregas al mes
  // Zona foco: carpetas concentradas en la zona donde más vende la tienda (el piloto maneja poco y gana lo acordado)
  foco_zona: { tipo: 'zona' },
  foco_modo: { tipo: 'opcion', opciones: ['solo', 'vecinas'] },   // solo zona foco | zona foco y zonas vecinas
  foco_vecinas: { tipo: 'zonas' },
  foco_precio: { tipo: 'dinero', min: 0, max: 500 },
  foco_ganancia: { tipo: 'dinero', min: 0, max: 500 },        // lo que gana el piloto por cada entrega de zona foco
  foco_min_solo: { tipo: 'entero', min: 1, max: 500 },        // pedidos mínimos cuando todos son de la zona foco
  foco_min_mixto: { tipo: 'entero', min: 1, max: 500 },       // pedidos mínimos en la zona foco cuando hay de otras zonas
  foco_mayoria: { tipo: 'entero', min: 1, max: 99 },          // y deben ser más de este porcentaje del total
};
// Lee y revisa las condiciones que manda el panel. Vacío = no definido (se usa el general o, en una excepción, el del plan)
function leerCondiciones(b, esExcepcion = false) {
  const out = {};
  if (!b || typeof b !== 'object') return out;
  for (const [k, def] of Object.entries(CAMPOS_PLAN)) {
    if (esExcepcion && def.soloPlan) continue;
    const v = b[k];
    if (v === undefined || v === null || v === '') continue;
    if (def.tipo === 'si_no') { out[k] = v === true || v === 1 || v === '1' || v === 'si'; continue; }
    if (def.tipo === 'opcion') { if (!def.opciones.includes(v)) falla(400, `Revisa «${NOMBRES_CAMPO[k]}».`); out[k] = v; continue; }
    if (def.tipo === 'zona') { if (!zonasFijas().some((z) => z.nombre === v)) falla(400, 'Elige una zona foco de las zonas dibujadas en el mapa.'); out[k] = v; continue; }
    if (def.tipo === 'zonas') {
      const validas = new Set(zonasFijas().map((z) => z.nombre));
      const lista = [...new Set((Array.isArray(v) ? v : String(v).split(',')).map((z) => String(z).trim()).filter((z) => validas.has(z)))].slice(0, 12);
      if (lista.length) out[k] = lista;
      continue;
    }
    const n = numero(v);
    if (!Number.isFinite(n) || n < def.min || n > def.max) falla(400, `Revisa «${NOMBRES_CAMPO[k]}»: debe estar entre ${def.min} y ${def.max}.`);
    out[k] = def.tipo === 'entero' ? Math.round(n) : redondear(n);
  }
  if (out.comision_tipo === 'porcentaje' && (out.comision_valor ?? 0) > 50) falla(400, 'La comisión en porcentaje no puede pasar de 50%.');
  if (out.comision_tipo && out.comision_tipo !== 'ninguna' && !(out.comision_valor > 0)) falla(400, 'Escribe de cuánto es la comisión del cobro.');
  if (out.comision_tipo === 'ninguna') delete out.comision_valor;
  if (out.volumen_desde && out.volumen_precio_zona == null && out.volumen_precio_fuera == null) falla(400, 'Escribe el precio por volumen (en zona, fuera o los dos).');
  if (!out.volumen_desde) { delete out.volumen_precio_zona; delete out.volumen_precio_fuera; }
  if (out.foco_precio != null && out.foco_ganancia != null && out.foco_ganancia > out.foco_precio) falla(400, 'En zona foco el piloto no puede ganar más que el precio del envío.');
  if (out.foco_modo !== 'vecinas') delete out.foco_vecinas;
  if (out.foco_zona && out.foco_vecinas) out.foco_vecinas = out.foco_vecinas.filter((z) => z !== out.foco_zona);
  return out;
}
const NOMBRES_CAMPO = { precio_zona: 'Precio en zonas preferenciales', precio_fuera: 'Precio a otras zonas', volumen_desde: 'Entregas al mes para el precio por volumen',
  volumen_precio_zona: 'Precio por volumen en zona', volumen_precio_fuera: 'Precio por volumen fuera', minimo: 'Mínimo de pedidos para recoger', cobro_permitido: 'Cobro del producto',
  comision_tipo: 'Comisión del cobro', comision_valor: 'Valor de la comisión', cobro_tope: 'Máximo a cobrar por paquete', bodega_dias_gratis: 'Días de bodega sin costo',
  bodega_dia: 'Bodega por día', ascenso_desde: 'Aviso de ascenso', foco_zona: 'Zona foco', foco_modo: 'A qué pedidos aplica la zona foco', foco_vecinas: 'Zonas vecinas',
  foco_precio: 'Precio en zona foco', foco_ganancia: 'Ganancia del piloto en zona foco', foco_min_solo: 'Mínimo si todos son de zona foco', foco_min_mixto: 'Mínimo en zona foco si hay otras zonas',
  foco_mayoria: 'Porcentaje mínimo en zona foco' };
const jsonSeguro = (t) => { try { const o = JSON.parse(t || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } };
const planPorClave = (clave) => db.prepare('SELECT * FROM planes WHERE clave = ?').get(clave);
function planDe(u) {
  return (u.plan_id && db.prepare('SELECT * FROM planes WHERE id = ?').get(u.plan_id)) || planPorClave(u.tipo_cuenta === 'minorista' ? 'minorista' : 'empresa');
}
// Entregas de pedidos de la tienda en el mes en curso (hora de Guatemala)
const entregasDelMes = (uid) => db.prepare("SELECT COUNT(*) AS n FROM envios WHERE usuario_id = ? AND pedido_id IS NOT NULL AND estado = 'entregado' AND strftime('%Y-%m', entregado_en, '-6 hours') = ?").get(uid, hoyGT().slice(0, 7)).n;
// Las condiciones que valen hoy para una tienda: plan + excepciones vigentes + generales donde no hay nada escrito
function condicionesDe(usuario) {
  const u = usuario && usuario.tipo_cuenta !== undefined && 'plan_id' in usuario ? usuario
    : db.prepare('SELECT id, tipo_cuenta, plan_id, condiciones_propias, condiciones_vence, condiciones_nota FROM usuarios WHERE id = ?').get(usuario?.id ?? usuario?.usuario_id ?? usuario);
  if (!u) return condicionesFinales({}, 'empresa');
  const plan = planDe(u);
  const propias = jsonSeguro(u.condiciones_propias);
  const vigente = Object.keys(propias).length > 0 && (!u.condiciones_vence || u.condiciones_vence >= hoyGT());
  const c = condicionesFinales({ ...jsonSeguro(plan?.condiciones), ...(vigente ? propias : {}) }, u.tipo_cuenta);
  c.plan = plan ? { id: plan.id, nombre: plan.nombre, clave: plan.clave } : null;
  c.excepciones = vigente ? { campos: Object.keys(propias), vence: u.condiciones_vence || null, nota: u.condiciones_nota || null } : null;
  c.usuario_id = u.id;
  return c;
}
function condicionesFinales(c, tipoCuenta) {
  const moto = vehiculoMoto(), aj = getAjustes();
  const out = {
    precio_zona: c.precio_zona ?? redondear(moto ? moto.tarifa_zona : 35),
    precio_fuera: c.precio_fuera ?? redondear(moto ? tarifaFuera(moto) : 45),
    volumen_desde: c.volumen_desde ?? null, volumen_precio_zona: c.volumen_precio_zona ?? null, volumen_precio_fuera: c.volumen_precio_fuera ?? null,
    minimo: c.minimo ?? (tipoCuenta === 'minorista' ? Math.max(1, Math.round(ajNum('min_pedidos_minorista', 3))) : Math.max(1, Math.round(ajNum('min_pedidos_lote', 10)))),
    cobro_permitido: c.cobro_permitido !== false,
    comision_tipo: c.comision_tipo || 'ninguna', comision_valor: c.comision_tipo && c.comision_tipo !== 'ninguna' ? Number(c.comision_valor) || 0 : 0,
    cobro_tope: c.cobro_tope ?? null,
    bodega_dias_gratis: c.bodega_dias_gratis ?? 0,
    bodega_dia: c.bodega_dia ?? null,          // null: cada pantalla usa la tarifa general de bodega
    ascenso_desde: c.ascenso_desde ?? null,
    // Valores tal como están escritos (para las pistas del panel)
    foco_zona: c.foco_zona ?? null, foco_modo: c.foco_modo ?? null, foco_vecinas: c.foco_vecinas ?? null, foco_precio: c.foco_precio ?? null, foco_ganancia: c.foco_ganancia ?? null,
    foco_min_solo: c.foco_min_solo ?? null, foco_min_mixto: c.foco_min_mixto ?? null, foco_mayoria: c.foco_mayoria ?? null,
  };
  // La zona foco funciona solo con zona, precio y ganancia del piloto definidos (en el plan o en la tienda)
  out.foco = c.foco_zona && c.foco_precio != null && c.foco_ganancia != null ? {
    zona: c.foco_zona, modo: c.foco_modo === 'vecinas' ? 'vecinas' : 'solo', vecinas: c.foco_modo === 'vecinas' ? (c.foco_vecinas || []).filter((z) => z !== c.foco_zona) : [],
    precio: redondear(c.foco_precio), ganancia: redondear(Math.min(c.foco_ganancia, c.foco_precio)),
    min_solo: c.foco_min_solo ?? 3, min_mixto: c.foco_min_mixto ?? 5, mayoria: c.foco_mayoria ?? 50 } : null;
  out.precio_propio = c.precio_zona != null || c.precio_fuera != null;
  return out;
}
// Precio que le toca hoy a la tienda: el del plan o, si ya llegó a las entregas del mes, el de volumen
function preciosDe(c) {
  let zona = c.precio_zona, fuera = c.precio_fuera, volumen = false;
  if (c.volumen_desde && c.usuario_id && entregasDelMes(c.usuario_id) >= c.volumen_desde) {
    if (c.volumen_precio_zona != null) { zona = c.volumen_precio_zona; volumen = true; }
    if (c.volumen_precio_fuera != null) { fuera = c.volumen_precio_fuera; volumen = true; }
  }
  return { zona: redondear(zona), fuera: redondear(Math.max(fuera, 0)), volumen };
}
// Lo que Vaelo se queda del cobro del producto (0 si el plan no cobra comisión)
function comisionCobro(c, cobro) {
  const m = Number(cobro) || 0;
  if (!(m > 0) || c.comision_tipo === 'ninguna' || !(c.comision_valor > 0)) return 0;
  return redondear(Math.min(m, c.comision_tipo === 'fija' ? c.comision_valor : (m * c.comision_valor) / 100));
}
function revisarCobroPlan(u, cobro) {
  if (!(cobro > 0)) return cobro;
  const c = condicionesDe(u);
  if (!c.cobro_permitido) falla(400, 'Tu plan no incluye el cobro del producto al entregar. Deja ese campo vacío o escríbenos para activarlo.');
  if (c.cobro_tope != null && cobro > c.cobro_tope) falla(400, `Con tu plan el piloto puede cobrar hasta ${qtz(c.cobro_tope)} por paquete.`);
  return cobro;
}
const qtz = (n) => 'Q' + (Number(n) || 0).toFixed(2);
// Bodega de un pedido que no se pudo entregar: días sin costo y tarifa del plan (o la general)
function cargoSedePedido(e, tarifaGeneral) {
  const c = condicionesDe(e.usuario_id);
  const dias = Math.max(0, diasEnSede(e) - c.bodega_dias_gratis);
  return redondear(dias * (c.bodega_dia ?? tarifaGeneral));
}
// Las condiciones en palabras sencillas: lo mismo que ve la tienda en «Mi tienda» y la vista previa del panel
function resumenCondiciones(c, entregasMes = null) {
  const p = c.usuario_id ? preciosDe(c) : { zona: c.precio_zona, fuera: c.precio_fuera, volumen: false };
  const lineas = [
    { titulo: 'Precio del envío', texto: `${qtz(p.zona)} en zonas preferenciales y ${qtz(p.fuera)} a otras zonas. Lo paga quien recibe.${p.volumen ? ' Ya tienes el precio por volumen de este mes.' : ''}` },
  ];
  if (c.volumen_desde && !p.volumen) {
    const precios = [c.volumen_precio_zona != null ? `${qtz(c.volumen_precio_zona)} en zona` : null, c.volumen_precio_fuera != null ? `${qtz(c.volumen_precio_fuera)} a otras zonas` : null].filter(Boolean).join(' y ');
    const faltan = entregasMes == null ? null : Math.max(0, c.volumen_desde - entregasMes);
    lineas.push({ titulo: 'Precio por volumen', texto: `Desde ${c.volumen_desde} entregas en el mes, tus envíos bajan a ${precios}.${faltan != null ? ` Llevas ${entregasMes}: te faltan ${faltan}.` : ''}` });
  }
  lineas.push({ titulo: 'Recogida', texto: `Pasamos por tus paquetes desde ${c.minimo} ${c.minimo === 1 ? 'pedido confirmado' : 'pedidos confirmados'} para el mismo día.` });
  if (!c.cobro_permitido) lineas.push({ titulo: 'Cobro de tu producto', texto: 'Tu plan no incluye que el piloto cobre el producto: tu cliente te paga antes.' });
  else {
    const com = c.comision_tipo === 'fija' ? `Vaelo descuenta ${qtz(c.comision_valor)} por cada paquete cobrado.` : c.comision_tipo === 'porcentaje' ? `Vaelo descuenta el ${c.comision_valor}% de lo cobrado.` : 'Sin comisión: te entregamos todo lo cobrado.';
    lineas.push({ titulo: 'Cobro de tu producto', texto: `El piloto cobra tu producto al entregar${c.cobro_tope != null ? `, hasta ${qtz(c.cobro_tope)} por paquete` : ''}. ${com}` });
  }
  if (c.foco) {
    const f = c.foco, donde = f.vecinas.length ? `${f.zona} y sus zonas vecinas (${f.vecinas.join(', ')})` : f.zona;
    const mayoria = f.mayoria === 50 ? 'más de la mitad' : `más del ${f.mayoria}%`;
    lineas.push({ titulo: `Zona foco: ${f.zona}`, texto: `Cuando tu carpeta es de ${f.zona}, tus envíos a ${donde} cuestan ${qtz(f.precio)}. Aplica si todos tus pedidos son de ${f.zona} (desde ${f.min_solo}) o si tienes al menos ${f.min_mixto} en ${f.zona} y son ${mayoria} de la carpeta. Los envíos a otras zonas pagan el precio normal.` });
  }
  const tarifa = c.bodega_dia ?? ajNum('cargo_bodega_empresa', 10);
  lineas.push({ titulo: 'Si no se pudo entregar', texto: `Guardamos el paquete en la sede${c.bodega_dias_gratis > 0 ? ` ${c.bodega_dias_gratis} ${c.bodega_dias_gratis === 1 ? 'día' : 'días'} sin costo; después` : ';'} cuesta ${qtz(tarifa)} por día.` });
  return lineas;
}
// Texto corto para el historial: qué quedó escrito en un plan o en una excepción
function condicionesEnTexto(c) {
  const partes = Object.entries(c).map(([k, v]) => `${NOMBRES_CAMPO[k] || k}: ${typeof v === 'boolean' ? (v ? 'sí' : 'no') : Array.isArray(v) ? v.join(', ') : v}`);
  return partes.length ? partes.join('; ') : 'todo en los valores generales';
}

// Lo que ve la tienda de sus condiciones (sin datos internos)
function condicionesTienda(u) {
  const c = condicionesDe(u), mes = entregasDelMes(u.id);
  const lineas = resumenCondiciones(c, mes);
  // La firma cambia cuando cambian sus condiciones (no por el avance del mes): así el aviso aparece solo cuando hay algo nuevo
  const firma = crypto.createHash('sha1').update(JSON.stringify(resumenCondiciones({ ...c, usuario_id: null }))).digest('hex').slice(0, 16);
  return { plan: c.plan?.nombre || '', lineas, cobro_permitido: c.cobro_permitido, cobro_tope: c.cobro_tope, foco: c.foco ? { zona: c.foco.zona, precio: c.foco.precio, vecinas: c.foco.vecinas } : null,
    vence: c.excepciones?.vence || null, entregas_mes: mes, firma, vista: u.condiciones_vistas === firma,
    estado: u.tipo_cuenta === 'minorista' ? (u.tienda_estado || 'aprobada') : 'aprobada', nota: u.tienda_estado === 'rechazada' ? u.tienda_nota || '' : null };
}
ruta('POST', '/api/empresa/condiciones/visto', ({ req, body }) => {
  const u = requiereEmpresa(req);
  db.prepare('UPDATE usuarios SET condiciones_vistas = ? WHERE id = ?').run(texto(body.firma, 20), u.id);
  return { ok: true };
});
// Solicitudes de tiendas (oficina)
ruta('GET', '/api/admin/tiendas/solicitudes', ({ req }) => {
  requiereStaff(req);
  return { solicitudes: db.prepare("SELECT * FROM usuarios WHERE tipo_cuenta = 'minorista' AND tienda_estado = 'pendiente' ORDER BY tienda_solicitud_en").all()
    .map((u) => ({ id: u.id, tienda: u.empresa_nombre, nombre: u.nombre, telefono: u.telefono, email: u.email, red: u.tienda_red, zona: u.tienda_zona, semana: u.tienda_semana,
      creado: u.tienda_solicitud_en, correo_confirmado: !!u.email_verificado, recomendacion: recomendacionTienda(u),
      carpetas: db.prepare("SELECT COUNT(*) AS n FROM pedidos_empresa WHERE usuario_id = ? AND estado = 'confirmado' AND lote_id IS NULL").get(u.id).n })) };
});
ruta('POST', '/api/admin/tiendas/:id/aprobar', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const u = db.prepare("SELECT * FROM usuarios WHERE id = ? AND tipo_cuenta = 'minorista'").get(Number(params.id)) || falla(404, 'No encontramos esa tienda.');
  if (u.tienda_estado !== 'pendiente' && u.tienda_estado !== 'rechazada') falla(400, 'Esta tienda ya está aprobada.');
  let planId = u.plan_id ?? null;   // sin plan nuevo, conserva el que ya le pusieron en sus condiciones
  if (body.plan_id) { const p = db.prepare('SELECT * FROM planes WHERE id = ?').get(Number(body.plan_id)) || falla(400, 'Ese plan ya no existe.'); planId = p.clave === 'minorista' ? null : p.id; }
  let propias = jsonSeguro(u.condiciones_propias);
  if (body.foco_zona) propias = { ...propias, ...leerCondiciones({ foco_zona: body.foco_zona }, true) };
  db.prepare("UPDATE usuarios SET tienda_estado = 'aprobada', tienda_nota = NULL, plan_id = ?, condiciones_propias = ? WHERE id = ?").run(planId, Object.keys(propias).length ? JSON.stringify(propias) : null, u.id);
  avisar(u.id, { titulo: 'Tu tienda ya está activa', cuerpo: 'Ya puedes enviar tus carpetas a Vaelo. Revisa en «Mi tienda» cómo funcionan tus descuentos.', url: '/tienda', etiqueta: 'tienda-activa' });
  enviarCorreo(u.email, 'Tu tienda ya está activa en Vaelo',
    correoVaelo(`Hola, ${u.nombre.split(' ')[0]}`, [`Revisamos tu solicitud y tu tienda «${u.empresa_nombre}» ya está activa.`, 'Ya puedes enviar tus carpetas a Vaelo. En «Mi tienda» verás tus condiciones y cómo funcionan tus descuentos.'],
      { texto: 'Ir a mi tienda', url: '/tienda' }), `Tu tienda ${u.empresa_nombre} ya está activa en Vaelo: ${URL_SITIO}/tienda`).catch(() => {});
  return { ok: true };
});
ruta('POST', '/api/admin/tiendas/:id/rechazar', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const u = db.prepare("SELECT * FROM usuarios WHERE id = ? AND tipo_cuenta = 'minorista' AND tienda_estado = 'pendiente'").get(Number(params.id)) || falla(404, 'No encontramos esa solicitud.');
  const nota = texto(body.nota, 300);
  db.prepare("UPDATE usuarios SET tienda_estado = 'rechazada', tienda_nota = ? WHERE id = ?").run(nota || null, u.id);
  avisar(u.id, { titulo: 'Revisamos tu solicitud de tienda', cuerpo: nota || 'Por ahora no pudimos aprobarla. Escríbenos por WhatsApp para revisarla juntos.', url: '/tienda', etiqueta: 'tienda-activa' });
  return { ok: true };
});
const planSalida = (p) => {
  const cond = jsonSeguro(p.condiciones);
  const tipo = p.clave === 'minorista' ? 'minorista' : 'empresa';
  return { id: p.id, clave: p.clave, nombre: p.nombre, descripcion: p.descripcion, condiciones: cond, de_fabrica: !!p.clave, actualizado: p.actualizado,
    tiendas: db.prepare(`SELECT COUNT(*) AS n FROM usuarios WHERE tipo_cuenta IN ('empresa','minorista') AND (plan_id = ? OR (plan_id IS NULL AND ? IS NOT NULL AND tipo_cuenta = ?))`).get(p.id, p.clave, p.clave).n,
    resumen: resumenCondiciones(condicionesFinales(cond, tipo)) };
};
// Tiendas que ya llegaron a las entregas del mes que marca su plan: oficina decide si las sube de plan
function sugerenciasDeAscenso() {
  const mes = hoyGT().slice(0, 7);
  return db.prepare(`SELECT u.id, COALESCE(u.empresa_nombre, u.nombre) AS nombre, u.tipo_cuenta, u.plan_id, COUNT(e.id) AS entregas FROM usuarios u
      JOIN envios e ON e.usuario_id = u.id AND e.pedido_id IS NOT NULL AND e.estado = 'entregado' AND strftime('%Y-%m', e.entregado_en, '-6 hours') = ?
    WHERE u.tipo_cuenta IN ('empresa','minorista') GROUP BY u.id`).all(mes)
    .map((t) => { const plan = planDe(t); const desde = jsonSeguro(plan?.condiciones).ascenso_desde; return desde && t.entregas >= desde ? { id: t.id, nombre: t.nombre, entregas: t.entregas, plan: plan.nombre, desde } : null; })
    .filter(Boolean);
}
// Valores generales para las pistas del editor y lo que gana el piloto en un envío normal (para mostrar lo que le queda a Vaelo)
function generalesPlan() {
  const g = condicionesFinales({}, 'minorista');
  return { precio_zona: g.precio_zona, precio_fuera: g.precio_fuera, minimo_minorista: g.minimo, minimo_empresa: condicionesFinales({}, 'empresa').minimo, bodega_dia: ajNum('cargo_bodega_empresa', 10),
    piloto_zona: gananciaPiloto(g.precio_zona), piloto_fuera: gananciaPiloto(g.precio_fuera), foco_min_solo: 3, foco_min_mixto: 5, foco_mayoria: 50 };
}
ruta('GET', '/api/admin/planes', ({ req }) => {
  const quien = requiereStaff(req);
  const g = condicionesFinales({}, 'minorista');
  return { planes: db.prepare('SELECT * FROM planes ORDER BY clave IS NULL, id').all().map(planSalida), puede_editar: esAdmin(quien), sugerencias: sugerenciasDeAscenso(),
    generales: generalesPlan(), zonas: zonasFijas().map((z) => z.nombre) };
});
// Vista previa: así lo vería la tienda con estas condiciones (no guarda nada)
ruta('GET', '/api/admin/planes/vista', ({ req, query }) => {
  requiereStaff(req);
  const cond = leerCondiciones(jsonSeguro(query.get('c')));
  return { lineas: resumenCondiciones(condicionesFinales(cond, query.get('tipo') === 'minorista' ? 'minorista' : 'empresa')) };
});
function leerPlan(body) {
  const nombre = texto(body.nombre, 40);
  if (nombre.length < 3) falla(400, 'Escribe el nombre del plan (3 letras o más).');
  return { nombre, descripcion: texto(body.descripcion, 160), condiciones: JSON.stringify(leerCondiciones(body.condiciones)) };
}
ruta('POST', '/api/admin/planes', ({ req, body }) => {
  requiereRol(req, 'admin');
  const d = leerPlan(body);
  if (db.prepare('SELECT 1 FROM planes WHERE lower(nombre) = lower(?)').get(d.nombre)) falla(400, 'Ya hay un plan con ese nombre.');
  if (db.prepare('SELECT COUNT(*) AS n FROM planes').get().n >= 12) falla(400, 'Ya hay 12 planes. Borra uno que no uses o usa excepciones por tienda.');
  const id = Number(db.prepare('INSERT INTO planes (nombre, descripcion, condiciones) VALUES (?, ?, ?)').run(d.nombre, d.descripcion, d.condiciones).lastInsertRowid);
  return { _status: 201, ok: true, plan: planSalida(db.prepare('SELECT * FROM planes WHERE id = ?').get(id)) };
});
ruta('PUT', '/api/admin/planes/:id', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const p = db.prepare('SELECT * FROM planes WHERE id = ?').get(Number(params.id)) || falla(404, 'No encontramos ese plan.');
  const d = leerPlan(body);
  if (db.prepare('SELECT 1 FROM planes WHERE lower(nombre) = lower(?) AND id <> ?').get(d.nombre, p.id)) falla(400, 'Ya hay un plan con ese nombre.');
  db.prepare("UPDATE planes SET nombre = ?, descripcion = ?, condiciones = ?, actualizado = datetime('now') WHERE id = ?").run(d.nombre, d.descripcion, d.condiciones, p.id);
  return { ok: true, plan: planSalida(db.prepare('SELECT * FROM planes WHERE id = ?').get(p.id)) };
});
ruta('DELETE', '/api/admin/planes/:id', ({ req, params }) => {
  requiereRol(req, 'admin');
  const p = db.prepare('SELECT * FROM planes WHERE id = ?').get(Number(params.id)) || falla(404, 'No encontramos ese plan.');
  if (p.clave) falla(400, 'Los planes Minorista y Empresa no se pueden borrar: son los que recibe una tienda al crearse.');
  // Las tiendas que lo tenían vuelven al plan de su tipo de cuenta
  const r = db.prepare('UPDATE usuarios SET plan_id = NULL WHERE plan_id = ?').run(p.id);
  db.prepare('DELETE FROM planes WHERE id = ?').run(p.id);
  return { ok: true, tiendas: Number(r.changes) };
});
// Condiciones de una tienda: su plan y sus excepciones
function tiendaDePlan(id) {
  return db.prepare("SELECT * FROM usuarios WHERE id = ? AND tipo_cuenta IN ('empresa','minorista')").get(Number(id)) || falla(404, 'No encontramos esa tienda.');
}
ruta('GET', '/api/admin/empresas/:id/condiciones', ({ req, params }) => {
  const quien = requiereStaff(req);
  const u = tiendaDePlan(params.id);
  const c = condicionesDe(u), propias = jsonSeguro(u.condiciones_propias), mes = entregasDelMes(u.id);
  return { tienda: u.empresa_nombre || u.nombre, tipo_cuenta: u.tipo_cuenta, plan_id: u.plan_id || null, plan: c.plan, propias, vence: u.condiciones_vence || null, nota: u.condiciones_nota || '',
    vencidas: Object.keys(propias).length > 0 && !c.excepciones, entregas_mes: mes, lineas: resumenCondiciones(c, mes), puede_editar: esAdmin(quien),
    del_plan: condicionesFinales(jsonSeguro(planDe(u)?.condiciones), u.tipo_cuenta),
    planes: db.prepare('SELECT id, clave, nombre FROM planes ORDER BY clave IS NULL, id').all(), generales: generalesPlan(), zonas: zonasFijas().map((z) => z.nombre) };
});
ruta('PUT', '/api/admin/empresas/:id/condiciones', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const u = tiendaDePlan(params.id);
  let planId = null;
  if (body.plan_id) { const p = db.prepare('SELECT * FROM planes WHERE id = ?').get(Number(body.plan_id)) || falla(400, 'Ese plan ya no existe.'); planId = p.clave === (u.tipo_cuenta === 'minorista' ? 'minorista' : 'empresa') ? null : p.id; }
  const propias = leerCondiciones(body.propias, true);
  const hay = Object.keys(propias).length > 0;
  let vence = null;
  if (hay && body.vence) {
    vence = texto(body.vence, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(vence)) falla(400, 'Revisa la fecha en que vencen las excepciones.');
    if (vence < hoyGT()) falla(400, 'La fecha de vencimiento ya pasó. Elige una fecha de hoy en adelante o déjala vacía.');
  }
  db.prepare('UPDATE usuarios SET plan_id = ?, condiciones_propias = ?, condiciones_vence = ?, condiciones_nota = ? WHERE id = ?')
    .run(planId, hay ? JSON.stringify(propias) : null, vence, hay ? texto(body.nota, 200) || null : null, u.id);
  const f = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.id);
  return { ok: true, lineas: resumenCondiciones(condicionesDe(f), entregasDelMes(u.id)) };
});

// ---------- Zona foco: ¿esta carpeta califica? ----------
// La zona de cada pedido sale del punto marcado (donde va el piloto), no de lo que se escribió.
function zonaDelPedido(p, formas = zonasConForma()) {
  if (formas.length && p.lat != null) return zonaDeFormas({ lat: p.lat, lng: p.lng }, formas) || OTRA_ZONA;
  return p.zona || OTRA_ZONA;
}
function evaluarFoco(cond, pedidos) {
  const f = cond && cond.foco;
  if (!f) return null;
  const formas = zonasConForma();
  const conZona = pedidos.map((p) => ({ id: p.id, zona: zonaDelPedido(p, formas) }));
  const enFoco = conZona.filter((x) => x.zona === f.zona);
  const enVecinas = conZona.filter((x) => f.vecinas.includes(x.zona));
  const total = conZona.length, n = enFoco.length;
  let aplica, texto, falta = null;
  if (!total) { aplica = false; texto = `Todavía no hay pedidos confirmados en ${f.zona}.`; }
  else if (n === total) {
    aplica = n >= f.min_solo;
    texto = aplica ? `Los ${n} pedidos son de ${f.zona}.` : `Los ${n} pedidos son de ${f.zona}, pero se necesitan al menos ${f.min_solo}.`;
    if (!aplica) falta = `Te ${f.min_solo - n === 1 ? 'falta 1 pedido' : `faltan ${f.min_solo - n} pedidos`} en ${f.zona}.`;
  } else {
    const pct = (n * 100) / total;
    aplica = n >= f.min_mixto && pct > f.mayoria;
    const mayoria = f.mayoria === 50 ? 'más de la mitad' : `más del ${f.mayoria}%`;
    if (aplica) texto = `${n} de ${total} pedidos son de ${f.zona}.`;
    else if (n < f.min_mixto) { texto = `${n} de ${total} pedidos son de ${f.zona}. Como hay pedidos en otras zonas, se necesitan al menos ${f.min_mixto} en ${f.zona}.`; falta = `Te ${f.min_mixto - n === 1 ? 'falta 1 pedido' : `faltan ${f.min_mixto - n} pedidos`} en ${f.zona}.`; }
    else texto = `${n} de ${total} pedidos son de ${f.zona}: deben ser ${mayoria} de la carpeta.`;
  }
  // Los que ya pagaron por transferencia cuentan para calificar, pero conservan el precio que pagaron
  const yaPagado = new Set(pedidos.filter((p) => p.metodo_pago === 'transferencia').map((p) => p.id));
  const elegibles = aplica ? [...enFoco, ...(f.modo === 'vecinas' ? enVecinas : [])].map((x) => x.id).filter((id) => !yaPagado.has(id)) : [];
  return { aplica, zona: f.zona, modo: f.modo, vecinas: f.vecinas, precio: f.precio, ganancia: f.ganancia, total, en_foco: n, en_vecinas: enVecinas.length,
    otras: total - n - enVecinas.length, elegibles, con_descuento: elegibles.length, texto, falta };
}
const focoDeLote = (loteId) => { if (!loteId) return null; const l = db.prepare('SELECT foco FROM lotes_empresa WHERE id = ?').get(loteId); const f = l ? jsonSeguro(l.foco) : {}; return f.zona ? f : null; };
// Precio normal (el general, sin plan): con él se calcula lo que gana el piloto, que no cambia por los descuentos de la tienda
function precioGeneralPedido(p) {
  const conZona = !!p.zona && p.zona !== OTRA_ZONA && zonasFijas().some((z) => z.nombre === p.zona);
  const formas = zonasConForma();
  const dentro = conZona && (!formas.length || p.lat == null || !!zonaDeFormas({ lat: p.lat, lng: p.lng }, formas));
  const g = condicionesFinales({}, 'empresa');
  return dentro ? g.precio_zona : g.precio_fuera;
}
// Precio del envío que paga quien recibe: el del plan de la tienda (por defecto Q35 en las zonas con tarifa fija y Q45 fuera).
// Un pedido ya confirmado conserva el precio con el que se confirmó, aunque después cambie el plan.
const claveLugar = (p) => `${p.zona || ''}|${p.lat ?? ''}|${p.lng ?? ''}`;
function precioPedido(p, vivo = false) {
  const base = precioPedidoBase(p, vivo);
  // Carpeta enviada con zona foco: los pedidos que califican bajan al precio de zona foco (nunca suben)
  if (!vivo && p.lote_id && p.id) {
    const f = focoDeLote(p.lote_id);
    if (f && f.aplica && f.elegibles.includes(p.id) && f.precio < base.precio) return { ...base, precio: redondear(f.precio), foco: true, precio_normal: base.precio };
  }
  return base;
}
function precioPedidoBase(p, vivo) {
  if (!vivo && p.precio_fijado != null && ['confirmado', 'enviado'].includes(p.estado) && p.precio_fijado_clave === claveLugar(p)) return { precio: redondear(p.precio_fijado), preferencial: !!p.precio_fijado_pref };
  const conZona = !!p.zona && p.zona !== OTRA_ZONA && zonasFijas().some((z) => z.nombre === p.zona);
  const formas = zonasConForma();
  const dentro = conZona && (!formas.length || p.lat == null || !!zonaDeFormas({ lat: p.lat, lng: p.lng }, formas));
  const precios = preciosDe(p.usuario_id ? condicionesDe(p.usuario_id) : condicionesFinales({}, 'empresa'));
  return { precio: dentro ? precios.zona : precios.fuera, preferencial: dentro };
}
const pedidoCompleto = (p) => !!(p.dia && p.horario && p.lat != null && p.direccion && p.zona && p.recibe_nombre && p.recibe_telefono && p.metodo_pago);
function estadoPedido(p) { return p.estado === 'pendiente' && p.enlace_enviado_en ? 'esperando' : p.estado === 'confirmado' && p.lote_id ? 'en_vaelo' : p.estado; }
// Lo que ve la empresa de un pedido (sin dinero)
function pedidoSalida(p, conDinero = false) {
  const out = { id: p.id, codigo: p.codigo, codigo_corto: p.estado === 'cancelado' ? p.codigo_corto : codigoCortoPedido(p), descripcion: p.descripcion, tamano: p.tamano, tamano_texto: TAMANOS[p.tamano]?.nombre || p.tamano,
    cliente_nombre: p.cliente_nombre, cliente_telefono: p.cliente_telefono, dia: p.dia, horario: p.horario, horario_texto: HORARIOS[p.horario] || '',
    direccion: p.direccion, zona: p.zona, lat: p.lat, lng: p.lng, referencias: p.referencias, recibe_nombre: p.recibe_nombre, recibe_telefono: p.recibe_telefono, ubicacion_manual: !!p.ubicacion_manual,
    metodo_pago: p.metodo_pago, cobro: Number(p.cobro) || 0, envio_pagado: !!p.envio_pagado, estado: estadoPedido(p), estado_texto: ESTADOS_PEDIDO[estadoPedido(p)], tiene_foto: !!p.foto, enlace: '/pedido/' + p.token,
    confirmado_por: p.confirmado_por, confirmado_en: p.confirmado_en, enlace_enviado_en: p.enlace_enviado_en, lote_id: p.lote_id, creado: p.creado,
    transferencia_ok: !!p.transferencia_ok, avisos: db.prepare('SELECT COUNT(*) AS n FROM push_pedidos WHERE pedido_id = ?').get(p.id).n };
  if (conDinero) out.precio = precioPedido(p).precio;
  if (p.envio_id) {
    const e = db.prepare('SELECT e.*, m.nombre AS piloto FROM envios e LEFT JOIN usuarios m ON m.id = e.mensajero_id WHERE e.id = ?').get(p.envio_id);
    if (e) {
      out.envio = { id: e.id, guia: e.guia, estado: e.estado, piloto: e.asignacion === 'aceptado' && e.piloto ? e.piloto.split(' ')[0] : null, parada: e.parada,
        paradas: e.grupo ? db.prepare('SELECT COUNT(*) AS n FROM envios WHERE grupo = ?').get(e.grupo).n : 1, recibio: e.recibio, entregado_en: e.entregado_en,
        fallo: e.fallo_en ? (MOTIVOS_FALLO[e.fallo_motivo] || 'No se pudo entregar') : null, dias_sede: e.sede_llegada ? diasEnSede(e) : null,
        llega: ['recogido', 'en_camino'].includes(e.estado) && e.llega_desde ? `${horaGT(e.llega_desde)} – ${horaGT(e.llega_hasta)}` : null };
      if (conDinero && e.sede_llegada) out.envio.cargo_sede = cargoSedePedido(e, ajNum('cargo_bodega_empresa', 10));
    }
  }
  return out;
}
function leerDatosEntrega(body, parcial = false) {
  const d = {};
  const dia = texto(body.dia, 10);
  if (dia || !parcial) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) falla(400, 'Elige el día en que puedes recibir.');
    if (dia < hoyGT()) falla(400, 'Ese día ya pasó. Elige otro.');
    if (dia > sumarDias(hoyGT(), 30)) falla(400, 'Elige un día dentro del próximo mes.');
    d.dia = dia;
  }
  if (body.horario !== undefined || !parcial) { if (!HORARIOS[body.horario]) falla(400, 'Elige el horario: mañana, tarde o cualquier hora.'); d.horario = body.horario; }
  if (body.lat !== undefined || !parcial) {
    const c = coordenada(body.lat, body.lng);
    if (!c) falla(400, 'Marca en el mapa dónde se entrega.');
    d.lat = c.lat; d.lng = c.lng;
  }
  if (body.direccion !== undefined || !parcial) { d.direccion = texto(body.direccion, 300); if (d.direccion.length < 5) falla(400, d.direccion ? 'Escribe la dirección más completa (por ejemplo: 5a calle 3-20, casa azul).' : 'Escribe la dirección de entrega.'); }
  if (body.zona !== undefined || !parcial) {
    const z = texto(body.zona, 60);
    if (z !== OTRA_ZONA && !zonasFijas().some((x) => x.nombre === z)) falla(400, 'Elige la zona o municipio.');
    d.zona = z;
  }
  if (body.referencias !== undefined) d.referencias = texto(body.referencias, 300) || null;
  if (body.recibe_nombre !== undefined || !parcial) { d.recibe_nombre = texto(body.recibe_nombre, 100); if (d.recibe_nombre.length < 2) falla(400, 'Escribe el nombre de quien recibe.'); }
  if (body.recibe_telefono !== undefined || !parcial) { d.recibe_telefono = texto(body.recibe_telefono, 30); if (digitos(d.recibe_telefono).length < 8) falla(400, 'Escribe el teléfono de quien recibe (8 dígitos).'); }
  if (!parcial) d.metodo_pago = 'efectivo';   // el envío se paga en efectivo al recibir
  return d;
}
const guardarPedido = (id, datos) => {
  const k = Object.keys(datos);
  if (k.length) db.prepare(`UPDATE pedidos_empresa SET ${k.map((x) => `${x} = ?`).join(', ')}, actualizado = datetime('now') WHERE id = ?`).run(...k.map((x) => datos[x]), id);
  return db.prepare('SELECT * FROM pedidos_empresa WHERE id = ?').get(id);
};
function guardarFotoPedido(p, dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) falla(400, 'Toma una foto del paquete.');
  const datos = Buffer.from(m[2], 'base64');
  if (datos.length < 300 || datos.length > 700_000) falla(400, 'La foto está vacía o pesa más de 700 KB.');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  if (!FIRMAS[ext].every((b, i) => datos[i] === b)) falla(400, 'La foto no es válida.');
  fs.mkdirSync(DOCS_DIR, { recursive: true, mode: 0o750 });
  const nombre = `pedido-${p.id}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(DOCS_DIR, nombre), datos, { mode: 0o640 });
  if (p.foto && !db.prepare('SELECT 1 FROM envios WHERE foto_paquete = ?').get(p.foto)) fs.rm(path.join(DOCS_DIR, path.basename(p.foto)), () => {});
  db.prepare("UPDATE pedidos_empresa SET foto = ?, actualizado = datetime('now') WHERE id = ?").run(nombre, p.id);
}
// ---------- Código corto del paquete (se escribe a mano con marcador: TB-07) ----------
// Iniciales de la empresa o del cliente + número del día. Es único entre los paquetes de ese remitente ese día,
// que es lo que el piloto lleva junto en su ruta.
function prefijoCodigo(nombre) {
  const w = String(nombre || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!w.length) return 'VA';
  return w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2).padEnd(2, 'X');
}
const numeroCodigo = (c) => Number(String(c || '').split('-')[1]) || 0;
// Números ya ocupados para unas iniciales: los de ese día (de cualquier cliente o empresa) y los de paquetes que siguen
// en camino de días anteriores. Así dos remitentes con las mismas iniciales nunca tienen el mismo código a la vez.
const ACTIVOS_CODIGO = "('pendiente','recogido','en_camino','fallido','devolviendo','a_sede','en_sede')";
function codigosOcupados(prefijo, dia, excluirPedido = 0, excluirEnvio = 0) {
  const like = prefijo + '-%';
  const env = db.prepare(`SELECT codigo_corto AS c FROM envios WHERE codigo_corto LIKE ? AND id != ?
    AND (date(creado, '-6 hours') = ? OR estado IN ${ACTIVOS_CODIGO})`).all(like, excluirEnvio, dia);
  const ped = db.prepare(`SELECT codigo_corto AS c FROM pedidos_empresa WHERE codigo_corto LIKE ? AND id != ? AND estado != 'cancelado'
    AND (COALESCE(codigo_dia, '') = ? OR envio_id IS NULL)`).all(like, excluirPedido, dia);
  return new Set([...env, ...ped].map((x) => x.c));
}
const siguienteCodigo = (prefijo, ocupados) => {
  let n = 1;
  while (ocupados.has(`${prefijo}-${String(n).padStart(2, '0')}`)) n++;
  return `${prefijo}-${String(n).padStart(2, '0')}`;
};
function codigoCortoPedido(p) {
  if (!p) return null;
  const dia = p.dia || hoyGT();
  if (p.codigo_corto && (p.envio_id || (p.codigo_dia || '') === dia)) return p.codigo_corto;
  const u = db.prepare('SELECT nombre, empresa_nombre FROM usuarios WHERE id = ?').get(p.usuario_id) || {};
  const prefijo = prefijoCodigo(u.empresa_nombre || u.nombre);
  const ocupados = codigosOcupados(prefijo, dia, p.id);
  // Se conserva el que ya tenía si sigue libre en el día nuevo (por si ya lo escribieron en el paquete)
  const codigo = p.codigo_corto && p.codigo_corto.startsWith(prefijo + '-') && !ocupados.has(p.codigo_corto) ? p.codigo_corto : siguienteCodigo(prefijo, ocupados);
  db.prepare('UPDATE pedidos_empresa SET codigo_corto = ?, codigo_dia = ? WHERE id = ?').run(codigo, dia, p.id);
  return codigo;
}
// Envío de un cliente: sus iniciales y el siguiente número libre del día (LP-01, LP-02…)
// Envío suelto: el código para escribir en el paquete solo hace falta cuando quien manda tiene 2 o más envíos en curso
// (o un pedido con varios destinos). Con uno solo, el piloto lo reconoce por la guía y el cliente no tiene que escribir nada.
const necesitaCodigoSuelto = (e) => !!e.grupo || db.prepare("SELECT COUNT(*) AS n FROM envios WHERE usuario_id = ? AND pedido_id IS NULL AND flete = 0 AND estado IN ('pendiente','recogido','en_camino')").get(e.usuario_id).n >= 2;
function codigoCortoEnvio(envioId) {
  const e = db.prepare('SELECT id, usuario_id, pedido_id, codigo_corto, creado, estado, grupo FROM envios WHERE id = ?').get(envioId);
  if (!e || e.codigo_corto) return e?.codigo_corto || null;
  if (!e.pedido_id && (e.estado !== 'pendiente' || !necesitaCodigoSuelto(e))) return null;
  if (e.pedido_id) {
    const p = db.prepare('SELECT * FROM pedidos_empresa WHERE id = ?').get(e.pedido_id);
    const c = codigoCortoPedido(p);
    db.prepare('UPDATE envios SET codigo_corto = ? WHERE id = ?').run(c, e.id);
    return c;
  }
  const u = db.prepare('SELECT nombre, empresa_nombre FROM usuarios WHERE id = ?').get(e.usuario_id) || {};
  const prefijo = prefijoCodigo(u.empresa_nombre || u.nombre);
  const dia = db.prepare("SELECT date(?, '-6 hours') AS d").get(e.creado).d;
  const c = siguienteCodigo(prefijo, codigosOcupados(prefijo, dia, 0, e.id));
  db.prepare('UPDATE envios SET codigo_corto = ? WHERE id = ?').run(c, e.id);
  return c;
}

// Arreglo de una vez: si de antes quedaron dos paquetes en curso con el mismo código, el más nuevo recibe otro
function repararCodigosRepetidos() {
  let n = 0;
  for (const { c } of db.prepare(`SELECT codigo_corto AS c FROM envios WHERE codigo_corto IS NOT NULL AND estado IN ${ACTIVOS_CODIGO} GROUP BY codigo_corto HAVING COUNT(*) > 1`).all()) {
    const filas = db.prepare(`SELECT id FROM envios WHERE codigo_corto = ? AND estado IN ${ACTIVOS_CODIGO} ORDER BY id`).all(c);
    for (const f of filas.slice(1)) { db.prepare('UPDATE envios SET codigo_corto = NULL WHERE id = ?').run(f.id); codigoCortoEnvio(f.id); n++; }
  }
  return n;
}
if (require.main === module) { try { const n = repararCodigosRepetidos(); if (n) console.log(`Códigos de paquete repetidos corregidos: ${n}`); } catch (err) { console.error('Códigos:', err.message); } }

// Lo que la tienda cobra por su producto al entregar (contra entrega). 0 = no se cobra nada aparte del envío
function leerCobroPedido(v) {
  if (v === '' || v == null) return 0;
  const n = numero(v);
  if (!Number.isFinite(n) || n < 0 || n > 50000) falla(400, 'Revisa el monto a cobrar por el producto (de Q0 a Q50,000).');
  return redondear(n);
}
function crearPedido(u, b) {
  const tamano = TAMANOS[b.tamano] ? b.tamano : falla(400, 'Elige el tamaño del paquete.');
  const descripcion = texto(b.descripcion, 200);
  if (descripcion.length < 2) falla(400, 'Escribe qué es el paquete.');
  const cliente_nombre = texto(b.cliente_nombre, 100), cliente_telefono = texto(b.cliente_telefono, 30);
  if (cliente_nombre.length < 2) falla(400, 'Escribe el nombre de tu cliente.');
  if (digitos(cliente_telefono).length < 8) falla(400, 'Escribe el WhatsApp de tu cliente (8 dígitos).');
  const cobro = revisarCobroPlan(u, leerCobroPedido(b.cobro));
  const r = db.prepare('INSERT INTO pedidos_empresa (usuario_id, codigo, token, descripcion, tamano, cliente_nombre, cliente_telefono, cobro, envio_pagado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(u.id, nuevaGuia(), crypto.randomBytes(16).toString('hex'), descripcion, tamano, cliente_nombre, cliente_telefono, cobro, b.envio_pagado === true ? 1 : 0);
  return db.prepare('SELECT * FROM pedidos_empresa WHERE id = ?').get(Number(r.lastInsertRowid));
}
// Si ya tiene todos los datos de entrega, queda confirmado
function revisarConfirmado(p, quien) {
  if (['pendiente', 'confirmado'].includes(p.estado) && pedidoCompleto(p)) {
    if (p.estado !== 'confirmado' || p.confirmado_por !== quien) p = guardarPedido(p.id, { estado: 'confirmado', confirmado_en: db.prepare("SELECT datetime('now') AS t").get().t, confirmado_por: quien });
    // El precio queda fijo desde que se confirma (si después cambia el lugar de entrega, se vuelve a calcular)
    if (p.precio_fijado == null || p.precio_fijado_clave !== claveLugar(p)) {
      const pr = precioPedido(p, true);
      db.prepare('UPDATE pedidos_empresa SET precio_fijado = ?, precio_fijado_pref = ?, precio_fijado_clave = ? WHERE id = ?').run(pr.precio, pr.preferencial ? 1 : 0, claveLugar(p), p.id);
      p = db.prepare('SELECT * FROM pedidos_empresa WHERE id = ?').get(p.id);
    }
  }
  return p;
}
const pedidoDeEmpresa = (u, id) => db.prepare('SELECT * FROM pedidos_empresa WHERE id = ? AND usuario_id = ?').get(Number(id), u.id) || falla(404, 'No encontramos ese pedido.');
const editable = (p) => { if (!['pendiente', 'confirmado', 'vencido', 'no_puede'].includes(p.estado) || p.lote_id) falla(400, 'Este pedido ya se envió a Vaelo y no se puede cambiar.'); };
const carpetaDe = (p) => (p.carpeta_id ? db.prepare('SELECT * FROM carpetas_empresa WHERE id = ?').get(p.carpeta_id) : null);

// ---------- Rutas: el recorrido más corto, respetando el horario del cliente (mañana → cualquiera → tarde) ----------
// 1) Se arma con "la más cercana primero". 2) Se mejora quitando cruces (2-opt) y moviendo paradas sueltas a donde
// queden mejor (or-opt). Con matriz de tiempos reales por calle (Mapbox u OSRM) se ordena por minutos; si no, por distancia.
const ORDEN_HORARIO = ['manana', 'cualquiera', 'tarde'];
const rangoHorario = (p) => ORDEN_HORARIO.indexOf(HORARIOS[p.horario] ? p.horario : 'cualquiera');
function ordenarParadas(origen, pedidos, matriz = null) {
  const n = pedidos.length;
  if (n <= 1) return [...pedidos];
  // Índices: 0 = punto de recogida, i + 1 = pedidos[i]
  const pts = [origen, ...pedidos];
  const costo = matriz ? (a, b) => matriz[a][b] : (a, b) => distanciaRecta(pts[a], pts[b]);
  const rango = [-1, ...pedidos.map(rangoHorario)];
  // Vecino más cercano por bloques de horario
  let orden = [], actual = 0;
  for (let h = 0; h < ORDEN_HORARIO.length; h++) {
    const resto = pedidos.map((_, i) => i + 1).filter((i) => rango[i] === h);
    while (resto.length) {
      let mejor = 0, menor = Infinity;
      resto.forEach((i, k) => { const d = costo(actual, i); if (d < menor) { menor = d; mejor = k; } });
      actual = resto.splice(mejor, 1)[0]; orden.push(actual);
    }
  }
  const largo = (o) => { let t = 0, a = 0; for (const i of o) { t += costo(a, i); a = i; } return t; };
  const valido = (o) => o.every((i, k) => k === 0 || rango[o[k - 1]] <= rango[i]);
  let mejorLargo = largo(orden);
  for (let vuelta = 0, mejoro = true; mejoro && vuelta < 60; vuelta++) {
    mejoro = false;
    // 2-opt: invertir un tramo
    for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
      const o = [...orden.slice(0, i), ...orden.slice(i, j + 1).reverse(), ...orden.slice(j + 1)];
      if (!valido(o)) continue;
      const l = largo(o); if (l < mejorLargo - 1e-9) { orden = o; mejorLargo = l; mejoro = true; }
    }
    // or-opt: mover 1 a 3 paradas seguidas a otro lugar
    for (let tam = 1; tam <= 3; tam++) for (let i = 0; i + tam <= n; i++) {
      const tramo = orden.slice(i, i + tam), resto = [...orden.slice(0, i), ...orden.slice(i + tam)];
      for (let j = 0; j <= resto.length; j++) {
        if (j === i) continue;
        const o = [...resto.slice(0, j), ...tramo, ...resto.slice(j)];
        if (!valido(o)) continue;
        const l = largo(o); if (l < mejorLargo - 1e-9) { orden = o; mejorLargo = l; mejoro = true; }
      }
    }
  }
  return orden.map((i) => pedidos[i - 1]);
}
// Tiempos y distancias reales por calle entre todos los puntos (máx. 25 con Mapbox); null si no se puede
async function matrizCalles(puntos, trafico = false) {
  const coords = puntos.map((x) => `${Number(x.lng).toFixed(5)},${Number(x.lat).toFixed(5)}`).join(';');
  const token = getAjustes().mapbox_token || process.env.MAPBOX_TOKEN || '';
  if (token && puntos.length <= 25) {
    try {
      const perfil = trafico && puntos.length <= 10 ? 'driving-traffic' : 'driving';   // con tráfico en vivo: máx. 10 puntos
      const r = await fetch(`https://api.mapbox.com/directions-matrix/v1/mapbox/${perfil}/${coords}?annotations=duration,distance&access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j.code === 'Ok' && j.durations) return { tiempos: j.durations, metros: j.distances };
    } catch { /* se intenta con OSRM */ }
  }
  if (OSRM_URL && puntos.length <= 100) {
    try {
      const r = await fetch(`${OSRM_URL}/table/v1/driving/${coords}?annotations=duration,distance`, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Vaelo-Mensajeria/1.0' } });
      const j = await r.json();
      if (j.code === 'Ok' && j.durations) return { tiempos: j.durations, metros: j.distances };
    } catch { /* sin matriz */ }
  }
  return null;
}
// Ordena una ruta con tiempos reales si se puede, y la mide (km y minutos por calle)
async function ordenarYMedir(origen, pedidos, pickup = false) {
  const m = pedidos.length ? await matrizCalles([origen, ...pedidos]) : null;
  const ok = m && m.tiempos.every((f) => f.every((x) => x != null));
  const orden = ordenarParadas(origen, pedidos, ok ? m.tiempos : null);
  const medida = medirRuta(origen, orden, pickup);
  if (ok) {
    const idx = new Map(pedidos.map((p, i) => [p, i + 1]));
    let seg = 0, met = 0, a = 0;
    for (const p of orden) { const b = idx.get(p); seg += m.tiempos[a][b]; met += m.metros ? m.metros[a][b] : 0; a = b; }
    if (met) medida.km = Math.round(met / 100) / 10;
    medida.minutos = Math.round(seg / 60 + orden.length * 7 + 10);
    medida.por_calle = true;
  }
  return { orden, ...medida };
}
function medirRuta(origen, paradas, pickup = false) {
  let km = 0, a = origen;
  for (const p of paradas) { km += distanciaRecta(a, p) * 1.4; a = p; }
  const vel = pickup ? 18 : 22;
  return { km: Math.round(km * 10) / 10, minutos: Math.round((km / vel) * 60 + paradas.length * 7 + 10), puntos: paradas.reduce((t, p) => t + (pickup ? 0 : puntosDe(p.tamano)), 0) };
}
// Barrido por ángulo alrededor del punto de recogida: grupos de entregas cercanas entre sí, con carga parecida
function dividirEnRutas(origen, pedidos, k) {
  k = Math.max(1, Math.min(k, pedidos.length));
  if (k === 1) return [ordenarParadas(origen, pedidos)];
  const cosLat = Math.cos((origen.lat * Math.PI) / 180);
  const lista = pedidos.map((p) => ({ p, a: Math.atan2(p.lat - origen.lat, (p.lng - origen.lng) * cosLat) })).sort((x, y) => x.a - y.a);
  // Se empieza a cortar después del hueco más grande, así ningún grupo da la vuelta completa
  let hueco = 0, mayor = -1;
  for (let i = 0; i < lista.length; i++) {
    const sig = lista[(i + 1) % lista.length], d = (sig.a - lista[i].a + 2 * Math.PI) % (2 * Math.PI) || (lista.length === 1 ? 2 * Math.PI : 0);
    if (d > mayor) { mayor = d; hueco = (i + 1) % lista.length; }
  }
  const orden = [...lista.slice(hueco), ...lista.slice(0, hueco)].map((x) => x.p);
  const peso = (p) => puntosDe(p.tamano) + 4;
  const total = orden.reduce((t, p) => t + peso(p), 0);
  const grupos = [];
  let actual = [], acum = 0;
  orden.forEach((p, i) => {
    actual.push(p); acum += peso(p);
    const quedan = orden.length - i - 1, faltanGrupos = k - grupos.length - 1;
    if (faltanGrupos > 0 && (acum >= (total * (grupos.length + 1)) / k || quedan === faltanGrupos)) { grupos.push(actual); actual = []; }
  });
  if (actual.length) grupos.push(actual);
  return balancearRutas(origen, grupos.map((g) => ordenarParadas(origen, g)));
}
// Reparte mejor el trabajo: pasa paradas de la ruta más pesada a otra mientras baje el tiempo de la más larga
// (y el cupo de las motos que se pasan). Así ninguna moto termina con 4 h y otra con 1 h.
function balancearRutas(origen, rutas) {
  if (rutas.length < 2) return rutas;
  const cupo = ajNum('cupo_moto', 30);
  const peso = (r) => { if (!r.length) return 0; const m = medirRuta(origen, r); return m.minutos + 6 * Math.max(0, m.puntos - cupo); };
  let pesos = rutas.map(peso);
  const nota = () => Math.max(...pesos) * 1000 + pesos.reduce((t, x) => t + x, 0);
  let actual = nota();
  for (let vuelta = 0; vuelta < 80; vuelta++) {
    let mejor = null;
    const i = pesos.indexOf(Math.max(...pesos));   // la ruta más pesada
    for (let a = 0; a < rutas[i].length; a++) {
      if (rutas[i].length <= 1) break;
      for (let j = 0; j < rutas.length; j++) {
        if (j === i) continue;
        const desde = ordenarParadas(origen, rutas[i].filter((_, k) => k !== a));
        const hacia = ordenarParadas(origen, [...rutas[j], rutas[i][a]]);
        const p2 = [...pesos]; p2[i] = peso(desde); p2[j] = peso(hacia);
        const n = Math.max(...p2) * 1000 + p2.reduce((t, x) => t + x, 0);
        if (n < actual - 1e-6 && (!mejor || n < mejor.n)) mejor = { n, i, j, desde, hacia, p2 };
      }
    }
    if (!mejor) break;
    rutas[mejor.i] = mejor.desde; rutas[mejor.j] = mejor.hacia; pesos = mejor.p2; actual = mejor.n;
  }
  return rutas.filter((r) => r.length);
}
function recomendar(origen, pedidos) {
  const cupo = ajNum('cupo_moto', 30), horas = ajNum('horas_ruta_moto', 4);
  const puntos = pedidos.reduce((t, p) => t + (p.tamano === 'grande' ? 0 : puntosDe(p.tamano)), 0);
  const una = medirRuta(origen, ordenarParadas(origen, pedidos));
  const base = { puntos, cupo, horas, minutos_una: una.minutos, km_una: una.km };
  if (pedidos.some((p) => p.tamano === 'grande')) return { ...base, modo: 'pickup', motos: 0, razon: 'Hay paquetes grandes: solo caben en pickup.' };
  if (puntos <= cupo && una.minutos <= horas * 60) return { ...base, modo: 'una_moto', motos: 1, razon: `Todo cabe en una moto y la ruta dura unas ${(una.minutos / 60).toFixed(1).replace('.0', '')} h.` };
  let k = Math.max(2, Math.ceil(puntos / cupo), Math.ceil(una.minutos / (horas * 60)));
  for (; k < pedidos.length; k++) {
    if (dividirEnRutas(origen, pedidos, k).every((r) => { const m = medirRuta(origen, r); return m.puntos <= cupo && m.minutos <= horas * 60; })) break;
  }
  const razon = puntos > cupo ? `No cabe todo en una moto (${puntos} de ${cupo} de cupo).` : `Una sola moto se tardaría unas ${(una.minutos / 60).toFixed(1)} h.`;
  return { ...base, modo: 'motos', motos: k, razon: `${razon} Se recomiendan ${k} motos.` };
}
function puntoEmpresa(u) {
  const f = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.id);
  return f && f.empresa_lat != null ? { lat: f.empresa_lat, lng: f.empresa_lng, direccion: f.empresa_direccion || '', zona: f.empresa_zona || '',
    contacto: f.punto_contacto || f.nombre, telefono: f.punto_telefono || f.telefono || '', fuente: f.punto_fuente || 'mapa', precision: f.punto_precision, actualizado: f.punto_actualizado } : null;
}
// Enlace pendiente para que otra persona comparta la ubicación del lugar donde están los paquetes
function puntoPendiente(u) {
  const f = db.prepare('SELECT punto_token, punto_token_vence, punto_pend_nombre, punto_pend_telefono FROM usuarios WHERE id = ?').get(u.id);
  if (!f || !f.punto_token || !f.punto_token_vence || f.punto_token_vence < db.prepare("SELECT datetime('now') AS t").get().t) return null;
  return { nombre: f.punto_pend_nombre, telefono: f.punto_pend_telefono, enlace: '/punto/' + f.punto_token, vence: f.punto_token_vence };
}
const PRECISION_MAX_PUNTO = 250;   // metros: con más error el piloto podría llegar a la cuadra equivocada
function guardarPuntoGps(uid, body, contacto, telefono, fuente) {
  const c = coordenada(body.lat, body.lng);
  if (!c) falla(400, 'No pudimos leer la ubicación. Toca otra vez el botón y permite la ubicación.');
  const precision = numero(body.precision);
  if (Number.isFinite(precision) && precision > PRECISION_MAX_PUNTO) falla(400, `La señal del GPS está débil (unos ${Math.round(precision)} m de error). Acércate a una ventana o sal a la puerta y vuelve a intentar.`);
  const direccion = texto(body.direccion, 300);
  if (direccion.length < 5) falla(400, 'Escribe la dirección o una referencia del lugar (ej. 5a calle 3-20, portón negro).');
  db.prepare(`UPDATE usuarios SET empresa_lat = ?, empresa_lng = ?, empresa_direccion = ?, empresa_zona = ?, punto_contacto = ?, punto_telefono = ?, punto_fuente = ?, punto_precision = ?,
    punto_actualizado = datetime('now') WHERE id = ?`).run(c.lat, c.lng, direccion, zonaDePunto(c) || OTRA_ZONA, contacto, telefono, fuente, Number.isFinite(precision) ? Math.round(precision) : null, uid);
}
const origenLote = (l) => l.recogida === 'sede' ? sedeUbicacion() : (l.origen_lat != null ? { lat: l.origen_lat, lng: l.origen_lng } : null);

// ---------- Empresa: registrar pedidos ----------
// Mínimo de pedidos para "Enviar a Vaelo": las tiendas minoristas (ventas en lives) mandan menos
const minimoLote = (u) => {
  if (u && (u.usuario_id || u.id)) return condicionesDe(u.usuario_id || u.id).minimo;
  return condicionesFinales({}, u?.tipo_cuenta).minimo;
};
ruta('GET', '/api/empresa/pedidos', ({ req }) => {
  const u = requiereEmpresa(req);
  const filas = db.prepare(`SELECT * FROM pedidos_empresa WHERE usuario_id = ? AND (estado IN ('pendiente','confirmado','vencido')
    OR (estado = 'enviado' AND actualizado >= datetime('now', '-15 days'))) ORDER BY CASE estado WHEN 'pendiente' THEN 0 WHEN 'confirmado' THEN 1 WHEN 'vencido' THEN 2 ELSE 3 END, COALESCE(dia, '9999'), id DESC LIMIT 500`).all(u.id);
  const pedidos = filas.map((p) => pedidoSalida(p));
  // Días con pedidos confirmados sin enviar: ahí aparece "Enviar a Vaelo"
  const dias = {};
  for (const p of filas) if (p.estado === 'confirmado' && !p.lote_id && p.dia >= hoyGT()) {
    dias[p.dia] = dias[p.dia] || { dia: p.dia, confirmados: 0, sin_foto: 0, grandes: 0 };
    dias[p.dia].confirmados++; if (!p.foto) dias[p.dia].sin_foto++; if (p.tamano === 'grande') dias[p.dia].grandes++;
  }
  const lotes = db.prepare("SELECT * FROM lotes_empresa WHERE usuario_id = ? AND (estado IN ('nuevo','en_ruta') OR creado >= datetime('now','-7 days')) ORDER BY id DESC LIMIT 30").all(u.id)
    .map((l) => ({ id: l.id, dia: l.dia, modo: l.modo, modo_texto: MODOS_LOTE[l.modo], recogida: l.recogida, paga: l.paga, estado: l.estado, creado: l.creado, recibido_en: l.recibido_en,
      pedidos: db.prepare('SELECT COUNT(*) AS n FROM pedidos_empresa WHERE lote_id = ?').get(l.id).n,
      entregados: db.prepare("SELECT COUNT(*) AS n FROM envios WHERE lote_empresa_id = ? AND estado = 'entregado'").get(l.id).n }));
  return { pedidos, dias: Object.values(dias).sort((a, b) => a.dia.localeCompare(b.dia)), lotes, minimo: minimoLote(u), punto: puntoEmpresa(u), tamanos: TAMANOS, horarios: HORARIOS,
    modos: MODOS_LOTE, empresa: u.empresa_nombre || u.nombre, whatsapp: getAjustes().whatsapp || '', sede: getAjustes().sede_direccion || '',
    zonas: [...zonasFijas().map((z) => z.nombre), OTRA_ZONA] };
});
// "Usar mi ubicación en tiempo real": la tienda está en el lugar y su celular manda dónde está
ruta('PUT', '/api/empresa/punto', ({ req, body }) => {
  const u = requiereEmpresa(req);
  guardarPuntoGps(u.id, body, u.nombre, u.telefono || '', 'gps');
  db.prepare('UPDATE usuarios SET punto_token = NULL, punto_token_vence = NULL WHERE id = ?').run(u.id);
  return { ok: true, punto: puntoEmpresa(u), pendiente: null };
});
// "Lo tengo en otro lugar": se le manda un enlace a la persona que está ahí; al abrirlo acepta y comparte su ubicación
ruta('POST', '/api/empresa/punto/enlace', ({ req, body }) => {
  const u = requiereEmpresa(req);
  const nombre = texto(body.nombre, 80), telefono = texto(body.telefono, 30);
  if (nombre.length < 2) falla(400, 'Escribe el nombre de la persona que va a entregar los paquetes.');
  if (digitos(telefono).length < 8) falla(400, 'Escribe el WhatsApp de esa persona (8 dígitos).');
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare("UPDATE usuarios SET punto_token = ?, punto_token_vence = datetime('now', '+3 days'), punto_pend_nombre = ?, punto_pend_telefono = ? WHERE id = ?").run(token, nombre, telefono, u.id);
  return { _status: 201, pendiente: puntoPendiente(u) };
});
ruta('DELETE', '/api/empresa/punto/enlace', ({ req }) => {
  const u = requiereEmpresa(req);
  db.prepare('UPDATE usuarios SET punto_token = NULL, punto_token_vence = NULL WHERE id = ?').run(u.id);
  return { ok: true };
});
const usuarioPorTokenPunto = (token) => {
  if (!/^[a-f0-9]{32}$/.test(String(token || ''))) falla(404, 'Este enlace no es válido.');
  const f = db.prepare("SELECT * FROM usuarios WHERE punto_token = ? AND punto_token_vence >= datetime('now')").get(token);
  return f || falla(404, 'Este enlace ya no sirve: se usó o venció. Pide que te manden uno nuevo.');
};
ruta('GET', '/api/punto/:token', ({ params }) => {
  const f = usuarioPorTokenPunto(params.token);
  return { tienda: f.empresa_nombre || f.nombre, nombre: f.punto_pend_nombre, quien_pide: f.nombre.split(' ')[0] };
});
ruta('POST', '/api/punto/:token', ({ req, params, body }) => {
  if (limitar(ipDe(req), 'punto', 20, 600_000)) falla(429, 'Demasiados intentos. Espera unos minutos.');
  const f = usuarioPorTokenPunto(params.token);
  if (body.acepto !== true) falla(400, 'Acepta que en este lugar vas a entregar los paquetes al piloto.');
  guardarPuntoGps(f.id, body, f.punto_pend_nombre, f.punto_pend_telefono, 'enlace');
  db.prepare('UPDATE usuarios SET punto_token = NULL, punto_token_vence = NULL WHERE id = ?').run(f.id);
  avisar(f.id, { titulo: 'Lugar de recogida listo', cuerpo: `${f.punto_pend_nombre} compartió la ubicación. Ahí pasarán los pilotos por tus paquetes.`, url: '/mi-cuenta?empresa=1', etiqueta: 'punto-recogida' });
  return { ok: true, tienda: f.empresa_nombre || f.nombre };
});
ruta('POST', '/api/empresa/pedidos', ({ req, body }) => {
  const u = requiereEmpresa(req);
  if (db.prepare("SELECT COUNT(*) AS n FROM pedidos_empresa WHERE usuario_id = ? AND estado IN ('pendiente','confirmado')").get(u.id).n >= 1000) falla(400, 'Tienes demasiados pedidos sin enviar.');
  db.exec('BEGIN');
  try {
    let p = crearPedido(u, body);
    if (body.foto) guardarFotoPedido(p, body.foto);
    if (body.llenar === true) p = guardarPedido(p.id, leerDatosEntrega(body));
    p = revisarConfirmado(db.prepare('SELECT * FROM pedidos_empresa WHERE id = ?').get(p.id), 'empresa');
    db.exec('COMMIT');
    return { _status: 201, pedido: pedidoSalida(p) };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}, { limite: 1_000_000 });
ruta('PUT', '/api/empresa/pedidos/:id', ({ req, params, body }) => {
  const u = requiereEmpresa(req);
  let p = pedidoDeEmpresa(u, params.id);
  editable(p);
  const datos = {};
  if (body.descripcion !== undefined) { datos.descripcion = texto(body.descripcion, 200); if (datos.descripcion.length < 2) falla(400, 'Escribe qué es el paquete.'); }
  if (body.tamano !== undefined) datos.tamano = TAMANOS[body.tamano] ? body.tamano : falla(400, 'Elige el tamaño.');
  if (body.cobro !== undefined) datos.cobro = revisarCobroPlan(u, leerCobroPedido(body.cobro));
  if (body.envio_pagado !== undefined) datos.envio_pagado = body.envio_pagado === true ? 1 : 0;
  if (body.cliente_nombre !== undefined) { datos.cliente_nombre = texto(body.cliente_nombre, 100); if (datos.cliente_nombre.length < 2) falla(400, 'Escribe el nombre de tu cliente.'); }
  if (body.cliente_telefono !== undefined) { datos.cliente_telefono = texto(body.cliente_telefono, 30); if (digitos(datos.cliente_telefono).length < 8) falla(400, 'Revisa el WhatsApp de tu cliente.'); }
  const cp = carpetaDe(p);
  if (cp && body.lat !== undefined) body.dia = cp.dia;
  Object.assign(datos, leerDatosEntrega(body, true));
  if (['vencido', 'no_puede'].includes(p.estado)) { datos.estado = 'pendiente'; datos.no_puede_nota = null; }
  p = guardarPedido(p.id, datos);
  p = revisarConfirmado(p, 'empresa');
  return { pedido: pedidoSalida(p) };
});
ruta('POST', '/api/empresa/pedidos/:id/foto', ({ req, params, body }) => {
  const u = requiereEmpresa(req);
  const p = pedidoDeEmpresa(u, params.id);
  editable(p);
  guardarFotoPedido(p, body.foto);
  return { ok: true };
}, { limite: 1_000_000 });
ruta('GET', '/api/empresa/pedidos/:id/foto', ({ req, res, params }) => {
  const u = requiereEmpresa(req);
  const p = pedidoDeEmpresa(u, params.id);
  return enviarArchivoEnvio(res, { foto_entrega: p.foto }, 'foto');
});
ruta('POST', '/api/empresa/pedidos/:id/enlace', ({ req, params }) => {
  const u = requiereEmpresa(req);
  const p = pedidoDeEmpresa(u, params.id);
  if (!p.enlace_enviado_en) db.prepare("UPDATE pedidos_empresa SET enlace_enviado_en = datetime('now') WHERE id = ?").run(p.id);
  return { ok: true };
});
ruta('DELETE', '/api/empresa/pedidos/:id', ({ req, params }) => {
  const u = requiereEmpresa(req);
  const p = pedidoDeEmpresa(u, params.id);
  editable(p);
  db.prepare("UPDATE pedidos_empresa SET estado = 'cancelado', actualizado = datetime('now') WHERE id = ?").run(p.id);
  return { ok: true };
});
// Subir muchos pedidos de un Excel o CSV: Descripción, Tamaño, Cliente, WhatsApp
const COLUMNAS_ARCHIVO = { descripcion: /descrip|producto|paquete|qu[eé]/i, tamano: /tama/i, cliente_nombre: /cliente|nombre/i, cliente_telefono: /whats|tel[eé]f|celular|n[uú]mero/i };
function tamanoDeTexto(t) {
  const s = String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/sobre|papel|document/.test(s)) return 'sobre';
  if (/media|mediano/.test(s)) return 'mediano';
  if (/grande/.test(s)) return 'grande';
  return 'pequeno';
}
function leerArchivoPedidos(body) {
  const m = /^data:([^;]*);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.archivo || ''));
  if (!m) falla(400, 'Sube un archivo de Excel (.xlsx) o CSV.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2_000_000) falla(400, 'El archivo pesa más de 2 MB.');
  let filas;
  try { filas = buf.subarray(0, 2).toString() === 'PK' ? leerExcel(buf) : leerCsv(buf.toString('utf8')); }
  catch (err) { falla(400, err.message || 'No pudimos leer el archivo.'); }
  if (filas.length < 2) falla(400, 'El archivo no tiene pedidos: la primera fila son los títulos y debajo un pedido por fila.');
  const cab = filas[0];
  const idx = {};
  for (const [k, re] of Object.entries(COLUMNAS_ARCHIVO)) idx[k] = cab.findIndex((t, i) => re.test(t) && !Object.values(idx).includes(i));
  if (idx.cliente_nombre < 0 || idx.cliente_telefono < 0 || idx.descripcion < 0) falla(400, 'Faltan columnas. Usa la plantilla: Descripción, Tamaño, Cliente, WhatsApp.');
  if (filas.length > 301) falla(400, 'Máximo 300 pedidos por archivo.');
  const errores = [], listos = [];
  filas.slice(1).forEach((f, i) => {
    const b = { descripcion: f[idx.descripcion], tamano: tamanoDeTexto(idx.tamano >= 0 ? f[idx.tamano] : ''), cliente_nombre: f[idx.cliente_nombre], cliente_telefono: f[idx.cliente_telefono] };
    if (!texto(b.descripcion) || texto(b.descripcion).length < 2) errores.push(`Fila ${i + 2}: falta qué es el paquete.`);
    else if (!texto(b.cliente_nombre) || texto(b.cliente_nombre).length < 2) errores.push(`Fila ${i + 2}: falta el nombre del cliente.`);
    else if (digitos(b.cliente_telefono).length < 8) errores.push(`Fila ${i + 2}: el WhatsApp del cliente no tiene 8 dígitos.`);
    else listos.push(b);
  });
  return { listos, errores };
}
ruta('POST', '/api/empresa/pedidos/archivo', ({ req, body }) => {
  const u = requiereEmpresa(req);
  const { listos, errores } = leerArchivoPedidos(body);
  if (errores.length) return { _status: 400, ok: false, errores: errores.slice(0, 30) };
  db.exec('BEGIN');
  try { for (const b of listos) crearPedido(u, b); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { _status: 201, ok: true, creados: listos.length };
}, { limite: 3_000_000 });
ruta('GET', '/api/empresa/pedidos/plantilla', ({ req, res }) => {
  requiereEmpresa(req);
  const buf = crearExcel([{ nombre: 'Pedidos', columnas: [{ titulo: 'Descripción', ancho: 30 }, { titulo: 'Tamaño', ancho: 14 }, { titulo: 'Cliente', ancho: 26 }, { titulo: 'WhatsApp', ancho: 16 }],
    filas: [['Blusa talla M', 'Pequeño', 'María López', '55551234'], ['Factura y contrato', 'Sobre', 'José Pérez', '44443333']] }]);
  return enviarExcel(res, buf, 'plantilla-pedidos-vaelo.xlsx');
});
// Recomendación para un día: una moto, varias o pickup
ruta('GET', '/api/empresa/recomendacion', ({ req, query }) => {
  const u = requiereEmpresa(req);
  const dia = query.get('dia') || '';
  const pedidos = db.prepare("SELECT * FROM pedidos_empresa WHERE usuario_id = ? AND dia = ? AND estado = 'confirmado' AND lote_id IS NULL").all(u.id, dia);
  if (!pedidos.length) falla(404, 'No hay pedidos confirmados para ese día.');
  const origen = puntoEmpresa(u) || sedeUbicacion();
  return { recomendacion: origen ? recomendar(origen, pedidos) : null, pedidos: pedidos.length, minimo: minimoLote(u) };
});
ruta('POST', '/api/empresa/enviar', ({ req, body }) => {
  const u = requiereEmpresa(req);
  revisarDeudaTienda(u);
  const dia = texto(body.dia, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || dia < hoyGT()) falla(400, 'Elige un día de hoy en adelante.');
  const pedidos = db.prepare("SELECT * FROM pedidos_empresa WHERE usuario_id = ? AND dia = ? AND estado = 'confirmado' AND lote_id IS NULL").all(u.id, dia);
  return crearLoteEmpresa(u, pedidos, dia, body);
});
function crearLoteEmpresa(u, pedidos, dia, body, alCrear) {
  const recogida = body.recogida === 'sede' ? 'sede' : 'empresa';
  const paga = body.modo === 'pickup' && body.paga === 'empresa' ? 'empresa' : 'clientes';
  if (!['una_moto', 'motos', 'pickup'].includes(body.modo)) falla(400, 'Elige cómo quieres que se repartan: una moto, varias motos o pickup.');
  if (pedidos.length < minimoLote(u)) falla(400, `Necesitas al menos ${minimoLote(u)} envíos confirmados para el mismo día. Tienes ${pedidos.length}.`);
  const sinFoto = pedidos.filter((p) => !p.foto);
  if (sinFoto.length) falla(400, `Falta la foto del paquete de ${sinFoto.slice(0, 5).map((p) => `${p.cliente_nombre} (${codigoCortoPedido(p)})`).join(', ')}${sinFoto.length > 5 ? ` y ${sinFoto.length - 5} más` : ''}. Tómala desde «Tomar foto».`);
  if (body.modo !== 'pickup' && pedidos.some((p) => p.tamano === 'grande')) falla(400, 'Hay paquetes grandes: esos solo van en pickup.');
  const punto = puntoEmpresa(u);
  if (recogida === 'empresa' && !punto) falla(400, 'Marca primero dónde recoge el piloto los paquetes (tu local).');
  if (recogida === 'sede' && !sedeUbicacion()) falla(400, 'Todavía no está configurada la sede de Vaelo. Escríbenos por WhatsApp.');
  const origen = recogida === 'sede' ? sedeUbicacion() : punto;
  const rec = recomendar(origen, pedidos);
  const foco = paga === 'empresa' ? null : evaluarFoco(condicionesDe(u), pedidos);
  db.exec('BEGIN');
  let lote;
  try {
    lote = Number(db.prepare(`INSERT INTO lotes_empresa (usuario_id, dia, modo, recogida, paga, recomendado, nota, origen_lat, origen_lng, origen_direccion, marcado)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(u.id, dia, body.modo, recogida, paga, JSON.stringify(rec), texto(body.nota, 300) || null,
      origen.lat, origen.lng, recogida === 'sede' ? (getAjustes().sede_direccion || 'Sede Vaelo') : punto.direccion, marcadoValido(body._marcado)).lastInsertRowid);
    db.prepare(`UPDATE pedidos_empresa SET lote_id = ?, actualizado = datetime('now') WHERE id IN (${pedidos.map(() => '?').join(',')})`).run(lote, ...pedidos.map((p) => p.id));
    if (foco) db.prepare('UPDATE lotes_empresa SET foco = ? WHERE id = ?').run(JSON.stringify(foco), lote);
    if (alCrear) alCrear(lote);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  avisarStaff({ titulo: 'Pedidos de empresa para repartir', cuerpo: `${u.empresa_nombre || u.nombre}: ${pedidos.length} pedidos para el ${fechaLarga(dia)} (${MODOS_LOTE[body.modo]}).`, url: RUTA_ADMIN, etiqueta: 'lote-emp-' + lote, urgente: true });
  let whatsapp = null;
  if (body.modo === 'pickup' && paga === 'empresa') {
    const tel = digitos(getAjustes().whatsapp);
    const zonas = [...new Set(pedidos.map((p) => p.zona))].join(', ');
    whatsapp = tel ? `https://wa.me/${tel}?text=${encodeURIComponent(`Hola Vaelo, somos ${u.empresa_nombre || u.nombre}. Queremos un pickup para ${pedidos.length} pedidos el ${fechaLarga(dia)} (zonas: ${zonas}). Recogida: ${recogida === 'sede' ? 'los llevamos a la sede' : punto.direccion}. Lote #${lote}. ¿Precio y promoción?`)}` : null;
  }
  return { _status: 201, ok: true, lote, pedidos: pedidos.length, whatsapp, foco: foco ? { aplica: foco.aplica, texto: foco.texto, con_descuento: foco.con_descuento, precio: foco.precio, zona: foco.zona } : null };
}
ruta('POST', '/api/empresa/lotes/:id/cancelar', ({ req, params }) => {
  const u = requiereEmpresa(req);
  const l = db.prepare("SELECT * FROM lotes_empresa WHERE id = ? AND usuario_id = ?").get(Number(params.id), u.id) || falla(404, 'No encontramos ese envío.');
  if (l.estado !== 'nuevo') falla(400, 'Vaelo ya asignó los pilotos: para cambiar algo escríbenos por WhatsApp.');
  cancelarLote(l);
  return { ok: true };
});
function cancelarLote(l) {
  db.prepare("UPDATE lotes_empresa SET estado = 'cancelado' WHERE id = ?").run(l.id);
  db.prepare("UPDATE pedidos_empresa SET lote_id = NULL, actualizado = datetime('now') WHERE lote_id = ? AND estado = 'confirmado'").run(l.id);
  db.prepare("UPDATE carpetas_empresa SET estado = 'abierta', lote_id = NULL, actualizado = datetime('now') WHERE lote_id = ?").run(l.id);
}
// Excel del día para la empresa: sus pedidos, sin dinero
ruta('GET', '/api/empresa/excel', ({ req, res, query }) => {
  const u = requiereEmpresa(req);
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(query.get('dia') || '') ? query.get('dia') : hoyGT();
  const filas = db.prepare('SELECT * FROM pedidos_empresa WHERE usuario_id = ? AND dia = ? AND estado != ? ORDER BY id').all(u.id, dia, 'cancelado').map((p) => pedidoSalida(p));
  const ESTADO_ENVIO = { pendiente: 'Por recoger', recogido: 'Recogido', en_camino: 'En camino', entregado: 'Entregado', fallido: 'No se entregó', a_sede: 'Va a la sede', en_sede: 'En la sede', devuelto: 'Devuelto', reenviado: 'Reenviado', cancelado: 'Cancelado' };
  const buf = crearExcel([{ nombre: 'Pedidos', titulo: `${u.empresa_nombre || u.nombre} · pedidos del ${fechaLarga(dia)}`,
    columnas: [{ titulo: 'Código', ancho: 14 }, { titulo: 'Descripción', ancho: 28 }, { titulo: 'Tamaño', ancho: 10 }, { titulo: 'Cliente', ancho: 22 }, { titulo: 'WhatsApp', ancho: 14 },
      { titulo: 'Zona', ancho: 14 }, { titulo: 'Dirección', ancho: 34 }, { titulo: 'Horario', ancho: 16 }, { titulo: 'Recibe', ancho: 20 }, { titulo: 'Estado', ancho: 18 },
      { titulo: 'Piloto', ancho: 14 }, { titulo: 'Parada', tipo: 'numero', ancho: 8 }, { titulo: 'Recibió', ancho: 18 }, { titulo: 'Motivo si no se entregó', ancho: 28 }, { titulo: 'Días en sede', tipo: 'numero', ancho: 12 }],
    filas: filas.map((p) => [p.codigo, p.descripcion, p.tamano_texto, p.cliente_nombre, p.cliente_telefono, p.zona, p.direccion, p.horario_texto, p.recibe_nombre,
      p.envio ? ESTADO_ENVIO[p.envio.estado] || p.envio.estado : p.estado_texto, p.envio?.piloto || '', p.envio?.parada || '', p.envio?.recibio || '', p.envio?.fallo || '', p.envio?.dias_sede ?? '']) }]);
  return enviarExcel(res, buf, `vaelo-pedidos-${dia}.xlsx`);
});
function enviarExcel(res, buf, nombre) {
  res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${nombre}"`,
    'Content-Length': buf.length, 'Cache-Control': 'no-store', ...CABECERAS_SEGURIDAD });
  res.end(buf);
  return { _enviado: true };
}

// ---------- Carpetas: la empresa arma una carpeta con un día de entrega y adentro añade sus envíos ----------
const carpetaDeEmpresa = (u, id) => db.prepare('SELECT * FROM carpetas_empresa WHERE id = ? AND usuario_id = ?').get(Number(id), u.id) || falla(404, 'No encontramos esa carpeta.');
const carpetaAbierta = (c) => { if (c.estado !== 'abierta') falla(400, 'Esta carpeta ya se mandó a Vaelo: crea una nueva para más envíos.'); };
function leerDiaCarpeta(v) {
  const dia = texto(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) falla(400, 'Elige el día de entrega.');
  if (dia < hoyGT()) falla(400, 'Ese día ya pasó. Elige otro.');
  if (dia > sumarDias(hoyGT(), 30)) falla(400, 'Elige un día dentro del próximo mes.');
  return dia;
}
const MARCADOS = { etiqueta: 'Guía impresa', codigo: 'Código escrito a mano con el nombre abajo' };
const marcadoValido = (m) => (MARCADOS[m] ? m : 'codigo');
function carpetaSalida(c, conPedidos = false) {
  const filas = db.prepare("SELECT * FROM pedidos_empresa WHERE carpeta_id = ? AND estado != 'cancelado' ORDER BY id").all(c.id);
  const cuenta = (f) => filas.filter(f).length;
  const out = { id: c.id, nombre: c.nombre, dia: c.dia, dia_texto: fechaLarga(c.dia), estado: c.estado, creado: c.creado, marcado: marcadoValido(c.marcado), marcado_texto: MARCADOS[marcadoValido(c.marcado)],
    total: filas.length, confirmados: cuenta((p) => p.estado === 'confirmado'), esperando: cuenta((p) => p.estado === 'pendiente' && p.enlace_enviado_en),
    sin_datos: cuenta((p) => p.estado === 'pendiente' && !p.enlace_enviado_en), no_puede: cuenta((p) => ['no_puede', 'vencido'].includes(p.estado)),
    sin_foto: cuenta((p) => p.estado !== 'cancelado' && !p.foto), grandes: cuenta((p) => p.tamano === 'grande'), minimo: minimoLote(c) };
  if (!c.lote_id) out.foco = evaluarFoco(condicionesDe(c.usuario_id), filas.filter((p) => p.estado === 'confirmado' && !p.lote_id));
  else { const f = focoDeLote(c.lote_id); if (f) out.foco = f; }
  if (out.foco) { delete out.foco.elegibles; delete out.foco.ganancia; }
  if (c.lote_id) {
    const l = db.prepare('SELECT * FROM lotes_empresa WHERE id = ?').get(c.lote_id);
    if (l) out.lote = { id: l.id, estado: l.estado, modo: l.modo, modo_texto: MODOS_LOTE[l.modo], recogida: l.recogida, recibido_en: l.recibido_en,
      entregados: db.prepare("SELECT COUNT(*) AS n FROM envios WHERE lote_empresa_id = ? AND estado = 'entregado'").get(l.id).n,
      en_camino: db.prepare("SELECT COUNT(*) AS n FROM envios WHERE lote_empresa_id = ? AND estado IN ('recogido','en_camino')").get(l.id).n,
      en_sede: db.prepare("SELECT COUNT(*) AS n FROM envios WHERE lote_empresa_id = ? AND estado IN ('a_sede','en_sede')").get(l.id).n };
    out.total = db.prepare('SELECT COUNT(*) AS n FROM pedidos_empresa WHERE lote_id = ?').get(c.lote_id).n;
  }
  if (conPedidos) out.pedidos = (c.lote_id ? db.prepare('SELECT * FROM pedidos_empresa WHERE lote_id = ? ORDER BY id').all(c.lote_id) : filas).map((p) => pedidoSalida(p))
    .map((p) => (out.marcado === 'codigo' ? p : { ...p, codigo_corto: null }));   // con etiqueta o nombre no se usa el código
  return out;
}
// Lo que el piloto cobró por los productos de la tienda: lo que Vaelo todavía le tiene que entregar y lo ya entregado
// Cuentas con la tienda: lo cobrado de sus productos (menos la comisión) menos los envíos que ella ya le cobró a sus clientes.
// Si da negativo, la tienda le debe a Vaelo (saldo).
// Lo que Vaelo le debe a la tienda por cada envío. Un paquete que la tienda retiró en la sede no se le cobró a nadie: ahí no hay producto que entregarle
const SQL_COBRO_HECHO = 'e.cobro_destinatario > 0 AND e.sede_llegada IS NULL AND e.cobro_devuelto_en IS NULL';
const SQL_ENVIO_TIENDA = "e.metodo_pago = 'tienda' AND e.sede_llegada IS NULL";   // si no se entregó, se cobra como intento fallido (cargo)
const SQL_NETO_TIENDA = `(CASE WHEN ${SQL_COBRO_HECHO} THEN e.cobro_destinatario - e.comision_cobro ELSE 0 END - CASE WHEN ${SQL_ENVIO_TIENDA} THEN e.precio ELSE 0 END)`;
const SQL_CUENTA_TIENDA = `e.estado = 'entregado' AND ((${SQL_COBRO_HECHO}) OR (${SQL_ENVIO_TIENDA}))`;
// Cargos que van a la cuenta de la tienda (no al próximo envío): entregas fallidas, bodega y nuevas entregas de sus pedidos
const SQL_CARGO_TIENDA = "c.pagado_en IS NULL AND c.anulado_en IS NULL AND c.cobrado_envio_id IS NULL AND (c.tipo IN ('bodega_empresa','intento_fallido') OR c.envio_id IN (SELECT id FROM envios WHERE pedido_id IS NOT NULL))";
function cobrosProducto(uid) {
  const f = db.prepare(`SELECT COALESCE(SUM(CASE WHEN e.cobro_pagado_en IS NULL THEN ${SQL_NETO_TIENDA} END), 0) AS neto, COUNT(CASE WHEN e.cobro_pagado_en IS NULL AND ${SQL_COBRO_HECHO} THEN 1 END) AS envios,
    COALESCE(SUM(CASE WHEN e.cobro_pagado_en IS NULL AND ${SQL_COBRO_HECHO} THEN e.comision_cobro END), 0) AS comision,
    COALESCE(SUM(CASE WHEN e.cobro_pagado_en IS NULL AND ${SQL_ENVIO_TIENDA} THEN e.precio END), 0) AS envios_tienda, COUNT(CASE WHEN e.cobro_pagado_en IS NULL AND ${SQL_ENVIO_TIENDA} THEN 1 END) AS n_tienda,
    MIN(CASE WHEN e.cobro_pagado_en IS NULL AND ${SQL_ENVIO_TIENDA} THEN e.entregado_en END) AS saldo_desde,
    COALESCE(SUM(CASE WHEN e.cobro_pagado_en >= datetime('now', '-30 days') THEN ${SQL_NETO_TIENDA} END), 0) AS pagado_30, MAX(e.cobro_pagado_en) AS ultimo_pago
    FROM envios e WHERE e.usuario_id = ? AND ${SQL_CUENTA_TIENDA}`).get(uid);
  // Solo las tiendas minoristas: a las empresas con contrato se les cobra en su estado de cuenta del mes
  const cargos = db.prepare(`SELECT c.tipo, COUNT(*) AS n, COALESCE(SUM(c.monto), 0) AS monto FROM cargos c JOIN usuarios u ON u.id = c.usuario_id
    WHERE c.usuario_id = ? AND u.tipo_cuenta = 'minorista' AND ${SQL_CARGO_TIENDA} GROUP BY c.tipo`).all(uid);
  const totalCargos = redondear(cargos.reduce((t, c) => t + c.monto, 0));
  const neto = redondear(f.neto - totalCargos), saldo = neto < 0 ? redondear(-neto) : 0;
  const dias = ajNum('dias_saldo_tienda', 7);
  const limite = saldo > 0 && f.saldo_desde ? new Date(fechaMs(f.saldo_desde) + dias * 86400_000 - 6 * 3600_000).toISOString().slice(0, 10) : null;
  // Con cargos (entrega fallida, bodega, nueva entrega) que no alcanza a cubrir lo que Vaelo le debe: paga antes de enviar otra carpeta
  const debeCargos = saldo > 0 && totalCargos > 0;
  return { pendiente: Math.max(0, neto), saldo, comision: redondear(f.comision), envios: f.envios, envios_tienda: redondear(f.envios_tienda), n_envios_tienda: f.n_tienda,
    cargos: totalCargos, cargos_detalle: cargos.map((c) => ({ tipo: c.tipo, nombre: TIPOS_CARGO[c.tipo] || c.tipo, n: c.n, monto: redondear(c.monto) })), debe_cargos: debeCargos,
    saldo_limite: debeCargos ? null : limite, saldo_vencido: debeCargos || (!!limite && limite < hoyGT()), pagado_30: Math.max(0, redondear(f.pagado_30)), ultimo_pago: f.ultimo_pago };
}
function revisarDeudaTienda(u) {
  const c = cobrosProducto(u.id);
  if (!c.saldo_vencido) return;
  if (c.debe_cargos) falla(403, `Debes Q${c.saldo.toFixed(2)} a Vaelo (${c.cargos_detalle.map((x) => x.nombre.toLowerCase()).join(', ')}). Págalo y avísanos por WhatsApp para poder enviar esta carpeta.`);
  falla(403, `Tienes un saldo de Q${c.saldo.toFixed(2)} por envíos que tus clientes te pagaron a ti. Págalo por transferencia y avísanos para poder enviar esta carpeta.`);
}
const datosPanelEmpresa = (u) => ({ minorista: u.tipo_cuenta === 'minorista', condiciones: condicionesTienda(u), minimo: minimoLote(u), punto: puntoEmpresa(u), punto_pendiente: puntoPendiente(u), cobros_producto: cobrosProducto(u.id), tamanos: TAMANOS, horarios: HORARIOS, modos: MODOS_LOTE, empresa: u.empresa_nombre || u.nombre,
  whatsapp: getAjustes().whatsapp || '', sede: getAjustes().sede_direccion || '', zonas: [...zonasFijas().map((z) => z.nombre), OTRA_ZONA], hoy: hoyGT() });
ruta('GET', '/api/empresa/carpetas', ({ req }) => {
  const u = requiereEmpresa(req);
  const abiertas = db.prepare("SELECT * FROM carpetas_empresa WHERE usuario_id = ? AND estado = 'abierta' ORDER BY dia, id").all(u.id);
  const enviadas = db.prepare(`SELECT c.* FROM carpetas_empresa c LEFT JOIN lotes_empresa l ON l.id = c.lote_id WHERE c.usuario_id = ? AND c.estado = 'enviada'
    AND (l.estado IN ('nuevo','en_ruta') OR c.actualizado >= datetime('now', '-15 days')) ORDER BY c.dia DESC, c.id DESC LIMIT 20`).all(u.id);
  return { abiertas: abiertas.map((c) => carpetaSalida(c)), enviadas: enviadas.map((c) => carpetaSalida(c)), ...datosPanelEmpresa(u) };
});
ruta('POST', '/api/empresa/carpetas', ({ req, body }) => {
  const u = requiereEmpresa(req);
  const dia = leerDiaCarpeta(body.dia);
  if (db.prepare("SELECT COUNT(*) AS n FROM carpetas_empresa WHERE usuario_id = ? AND estado = 'abierta'").get(u.id).n >= 30) falla(400, 'Tienes demasiadas carpetas abiertas.');
  const nombre = texto(body.nombre, 60) || `Envíos del ${fechaLarga(dia)}`;
  const id = Number(db.prepare('INSERT INTO carpetas_empresa (usuario_id, nombre, dia, marcado) VALUES (?, ?, ?, ?)').run(u.id, nombre, dia, marcadoValido(db.prepare('SELECT marcado_paquetes FROM usuarios WHERE id = ?').get(u.id)?.marcado_paquetes)).lastInsertRowid);
  return { _status: 201, carpeta: carpetaSalida(carpetaDeEmpresa(u, id)) };
});
ruta('GET', '/api/empresa/carpetas/:id', ({ req, params }) => {
  const u = requiereEmpresa(req);
  return { carpeta: carpetaSalida(carpetaDeEmpresa(u, params.id), true), ...datosPanelEmpresa(u) };
});
// Cambiar nombre o día. Si cambia el día, los clientes que ya confirmaron lo tienen que confirmar de nuevo.
ruta('PUT', '/api/empresa/carpetas/:id', ({ req, params, body }) => {
  const u = requiereEmpresa(req);
  const c = carpetaDeEmpresa(u, params.id);
  carpetaAbierta(c);
  // Cómo marca los paquetes de esta carpeta (se recuerda para las carpetas nuevas)
  if (body.marcado !== undefined && Object.keys(body).length === 1) {
    if (!MARCADOS[body.marcado]) falla(400, 'Elige cómo vas a marcar los paquetes.');
    db.prepare("UPDATE carpetas_empresa SET marcado = ?, actualizado = datetime('now') WHERE id = ?").run(body.marcado, c.id);
    db.prepare('UPDATE usuarios SET marcado_paquetes = ? WHERE id = ?').run(body.marcado, u.id);
    return { carpeta: carpetaSalida(carpetaDeEmpresa(u, c.id)) };
  }
  const nombre = body.nombre !== undefined ? (texto(body.nombre, 60) || c.nombre) : c.nombre;
  const dia = body.dia !== undefined ? leerDiaCarpeta(body.dia) : c.dia;
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE carpetas_empresa SET nombre = ?, dia = ?, actualizado = datetime('now') WHERE id = ?").run(nombre, dia, c.id);
    if (dia !== c.dia) {
      db.prepare("UPDATE pedidos_empresa SET dia = ?, actualizado = datetime('now') WHERE carpeta_id = ? AND estado != 'cancelado'").run(dia, c.id);
      db.prepare("UPDATE pedidos_empresa SET estado = 'pendiente', confirmado_en = NULL, recordado_en = NULL WHERE carpeta_id = ? AND (confirmado_por = 'cliente' AND estado = 'confirmado' OR estado IN ('vencido','no_puede'))").run(c.id);
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { carpeta: carpetaSalida(carpetaDeEmpresa(u, c.id), true) };
});
ruta('DELETE', '/api/empresa/carpetas/:id', ({ req, params }) => {
  const u = requiereEmpresa(req);
  const c = carpetaDeEmpresa(u, params.id);
  carpetaAbierta(c);
  db.prepare("UPDATE pedidos_empresa SET estado = 'cancelado', actualizado = datetime('now') WHERE carpeta_id = ? AND lote_id IS NULL").run(c.id);
  db.prepare("UPDATE carpetas_empresa SET estado = 'cancelada', actualizado = datetime('now') WHERE id = ?").run(c.id);
  return { ok: true };
});
// "Añadir envío" dentro de la carpeta: lo mínimo; los datos de entrega los llena el cliente con su enlace o la empresa
ruta('POST', '/api/empresa/carpetas/:id/pedidos', ({ req, params, body }) => {
  const u = requiereEmpresa(req);
  const c = carpetaDeEmpresa(u, params.id);
  carpetaAbierta(c);
  if (db.prepare("SELECT COUNT(*) AS n FROM pedidos_empresa WHERE carpeta_id = ? AND estado != 'cancelado'").get(c.id).n >= 300) falla(400, 'Una carpeta lleva hasta 300 envíos. Crea otra.');
  db.exec('BEGIN');
  try {
    let p = crearPedido(u, body);
    db.prepare('UPDATE pedidos_empresa SET carpeta_id = ?, dia = ? WHERE id = ?').run(c.id, c.dia, p.id);
    if (body.foto) guardarFotoPedido(p, body.foto);
    if (body.llenar === true) p = guardarPedido(p.id, leerDatosEntrega({ ...body, dia: c.dia }));
    p = revisarConfirmado(db.prepare('SELECT * FROM pedidos_empresa WHERE id = ?').get(p.id), 'empresa');
    db.exec('COMMIT');
    return { _status: 201, pedido: pedidoSalida(p) };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}, { limite: 1_000_000 });
ruta('POST', '/api/empresa/carpetas/:id/archivo', ({ req, params, body }) => {
  const u = requiereEmpresa(req);
  const c = carpetaDeEmpresa(u, params.id);
  carpetaAbierta(c);
  const { listos, errores } = leerArchivoPedidos(body);
  if (errores.length) return { _status: 400, ok: false, errores: errores.slice(0, 30) };
  db.exec('BEGIN');
  try {
    for (const b of listos) { const p = crearPedido(u, b); db.prepare('UPDATE pedidos_empresa SET carpeta_id = ?, dia = ? WHERE id = ?').run(c.id, c.dia, p.id); }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { _status: 201, ok: true, creados: listos.length };
}, { limite: 3_000_000 });
// Mover un envío a otra carpeta (otro día). Si su cliente ya había confirmado, confirma de nuevo con la nueva fecha.
ruta('PUT', '/api/empresa/pedidos/:id/carpeta', ({ req, params, body }) => {
  const u = requiereEmpresa(req);
  const p = pedidoDeEmpresa(u, params.id);
  editable(p);
  const c = carpetaDeEmpresa(u, body.carpeta_id);
  carpetaAbierta(c);
  if (c.id === p.carpeta_id) return { pedido: pedidoSalida(p) };
  const { f, reconfirmar } = moverPedidoACarpeta(p, c);
  return { pedido: pedidoSalida(f), reconfirmar };
});
// Pasa un pedido a otra carpeta: si cambia el día, su cliente confirma de nuevo
function moverPedidoACarpeta(p, c) {
  const datos = { carpeta_id: c.id, dia: c.dia };
  if (c.dia !== p.dia && (p.confirmado_por === 'cliente' || ['no_puede', 'vencido'].includes(p.estado))) Object.assign(datos, { estado: 'pendiente', confirmado_en: null, no_puede_nota: null, recordado_en: null });
  else if (['no_puede', 'vencido'].includes(p.estado)) Object.assign(datos, { estado: 'pendiente', no_puede_nota: null });
  const reconfirmar = datos.estado === 'pendiente';
  let f = guardarPedido(p.id, datos);
  if (!reconfirmar) f = revisarConfirmado(f, 'empresa');
  return { f, reconfirmar };
}
// Juntar dos carpetas: los pedidos que quedaron sueltos (pocos, o de un día que ya pasó) pasan a otra carpeta y esta se cierra
ruta('POST', '/api/empresa/carpetas/:id/juntar', ({ req, params, body }) => {
  const u = requiereEmpresa(req);
  const origen = carpetaDeEmpresa(u, params.id);
  carpetaAbierta(origen);
  const destino = carpetaDeEmpresa(u, body.carpeta_id);
  carpetaAbierta(destino);
  if (destino.id === origen.id) falla(400, 'Elige otra carpeta.');
  if (destino.dia < hoyGT()) falla(400, 'El día de esa carpeta ya pasó. Elige una de hoy o de otro día que venga.');
  const pedidos = db.prepare("SELECT * FROM pedidos_empresa WHERE carpeta_id = ? AND lote_id IS NULL AND estado IN ('pendiente','confirmado','vencido','no_puede')").all(origen.id);
  if (db.prepare("SELECT COUNT(*) AS n FROM pedidos_empresa WHERE carpeta_id = ? AND estado != 'cancelado'").get(destino.id).n + pedidos.length > 300) falla(400, 'Una carpeta lleva hasta 300 envíos.');
  const reconfirmar = [];
  db.exec('BEGIN');
  try {
    for (const p of pedidos) if (moverPedidoACarpeta(p, destino).reconfirmar) reconfirmar.push(p.cliente_nombre);
    db.prepare("UPDATE carpetas_empresa SET estado = 'cancelada', actualizado = datetime('now') WHERE id = ? AND NOT EXISTS (SELECT 1 FROM pedidos_empresa WHERE carpeta_id = ? AND estado != 'cancelado')").run(origen.id, origen.id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { ok: true, movidos: pedidos.length, reconfirmar, carpeta: carpetaSalida(carpetaDeEmpresa(u, destino.id)) };
});
ruta('GET', '/api/empresa/carpetas/:id/recomendacion', ({ req, params }) => {
  const u = requiereEmpresa(req);
  const c = carpetaDeEmpresa(u, params.id);
  const pedidos = db.prepare("SELECT * FROM pedidos_empresa WHERE carpeta_id = ? AND estado = 'confirmado' AND lote_id IS NULL").all(c.id);
  if (!pedidos.length) falla(404, 'Todavía no hay envíos confirmados en esta carpeta.');
  const origen = puntoEmpresa(u) || sedeUbicacion();
  return { recomendacion: origen ? recomendar(origen, pedidos) : null, pedidos: pedidos.length, minimo: minimoLote(u) };
});
// Mandar la carpeta a Vaelo: salen los confirmados; los que siguen sin confirmar pasan a una carpeta nueva
ruta('POST', '/api/empresa/carpetas/:id/enviar', ({ req, params, body }) => {
  const u = requiereEmpresa(req);
  if (u.tienda_estado === 'pendiente') falla(403, 'Tu tienda está en revisión. Puedes preparar tu carpeta y tus clientes pueden confirmar: en cuanto Vaelo la apruebe, la envías.');
  if (u.tienda_estado === 'rechazada') falla(403, 'Tu solicitud de tienda no fue aprobada. Escríbenos por WhatsApp para revisarla.');
  revisarDeudaTienda(u);
  const c = carpetaDeEmpresa(u, params.id);
  carpetaAbierta(c);
  if (c.dia < hoyGT()) falla(400, 'El día de esta carpeta ya pasó. Cámbialo y pide a tus clientes que confirmen de nuevo.');
  const pedidos = db.prepare("SELECT * FROM pedidos_empresa WHERE carpeta_id = ? AND estado = 'confirmado' AND lote_id IS NULL").all(c.id);
  let pendientes = 0;
  const r = crearLoteEmpresa(u, pedidos, c.dia, { ...body, _marcado: c.marcado }, (lote) => {
    const resto = db.prepare("SELECT id FROM pedidos_empresa WHERE carpeta_id = ? AND lote_id IS NULL AND estado IN ('pendiente','vencido','no_puede')").all(c.id);
    pendientes = resto.length;
    if (resto.length) {
      const nueva = Number(db.prepare('INSERT INTO carpetas_empresa (usuario_id, nombre, dia) VALUES (?, ?, ?)').run(u.id, `${c.nombre} (pendientes)`.slice(0, 60), c.dia).lastInsertRowid);
      db.prepare(`UPDATE pedidos_empresa SET carpeta_id = ? WHERE id IN (${resto.map(() => '?').join(',')})`).run(nueva, ...resto.map((x) => x.id));
    }
    db.prepare("UPDATE carpetas_empresa SET estado = 'enviada', lote_id = ?, actualizado = datetime('now') WHERE id = ?").run(lote, c.id);
  });
  return { ...r, pendientes };
});

// ---------- El enlace del cliente de la empresa: /pedido/<clave> ----------
function pedidoPorToken(token) {
  if (!/^[a-f0-9]{32}$/.test(String(token || ''))) falla(404, 'Este enlace no es válido. Pide a la tienda que te lo mande de nuevo.');
  return db.prepare('SELECT * FROM pedidos_empresa WHERE token = ?').get(token) || falla(404, 'Este enlace no es válido. Pide a la tienda que te lo mande de nuevo.');
}
ruta('GET', '/api/pedido/:token', ({ params }) => {
  const p = pedidoPorToken(params.token);
  const aj = getAjustes();
  const out = { codigo: p.codigo, empresa: nombreEmpresa(p.usuario_id), descripcion: p.descripcion, tamano: TAMANOS[p.tamano]?.nombre, cliente_nombre: p.cliente_nombre,
    estado: estadoPedido(p), dia: p.dia, horario: p.horario, direccion: p.direccion, zona: p.zona, lat: p.lat, lng: p.lng, referencias: p.referencias,
    recibe_nombre: p.recibe_nombre || p.cliente_nombre, recibe_telefono: p.recibe_telefono || p.cliente_telefono, ubicacion_manual: !!p.ubicacion_manual, metodo_pago: p.metodo_pago, cobro: Number(p.cobro) || 0, envio_pagado: !!p.envio_pagado,
    editable: ['pendiente', 'confirmado', 'vencido', 'no_puede'].includes(p.estado) && !p.lote_id, en_lote: !!p.lote_id,
    dia_fijo: p.carpeta_id ? carpetaDe(p)?.dia || null : null, no_puede_nota: p.no_puede_nota,
    precio: p.lat != null || p.zona ? precioPedido(p) : null, tarifa_zona: preciosDe(condicionesDe(p.usuario_id)).zona, tarifa_fuera: preciosDe(condicionesDe(p.usuario_id)).fuera,
    zonas: [...zonasFijas().map((z) => z.nombre), OTRA_ZONA], horarios: HORARIOS, hoy: hoyGT() };
  if (p.envio_id) {
    const e = db.prepare(`${SQL_ENVIO} WHERE e.id = ?`).get(p.envio_id);
    if (e) {
      const enCurso = ['pendiente', 'recogido', 'en_camino'].includes(e.estado);
      out.envio = { estado: e.estado, guia: e.guia, parada: e.parada, paradas: e.grupo ? db.prepare('SELECT COUNT(*) AS n FROM envios WHERE grupo = ?').get(e.grupo).n : 1,
        antes: e.grupo && e.parada ? db.prepare(`SELECT COUNT(*) AS n FROM envios WHERE grupo = ? AND parada < ? AND estado IN ('pendiente','recogido','en_camino')`).get(e.grupo, e.parada).n : 0,
        codigo_entrega: enCurso ? e.codigo_entrega : null, precio: e.metodo_pago === 'recibe' || e.metodo_pago === 'transferencia' ? e.precio : 0, metodo_pago: e.metodo_pago,
        piloto: e.asignacion === 'aceptado' && e.mensajero_nombre ? { nombre: e.mensajero_nombre.split(' ')[0], ...(() => { const m = pilotoPorId(e.mensajero_id); return m ? { vehiculo: m.vehiculo, color: m.veh_color, placa: m.veh_placa } : {}; })() } : null,
        proximo: !!e.aviso_proximo && enCurso, llega: enCurso && e.llega_desde ? { desde: horaGT(e.llega_desde), hasta: horaGT(e.llega_hasta) } : null, recibio: e.recibio, entregado_en: e.entregado_en, fallo: e.fallo_en ? (MOTIVOS_FALLO[e.fallo_motivo] || '') : null };
    }
  }
  return out;
});
ruta('POST', '/api/pedido/:token/precio', ({ params, body }) => {
  const ped = pedidoPorToken(params.token);
  const c = coordenada(body.lat, body.lng);
  return precioPedido({ usuario_id: ped.usuario_id, zona: texto(body.zona, 60), lat: c?.lat ?? null, lng: c?.lng ?? null });
});
ruta('POST', '/api/pedido/:token', ({ req, params, body }) => {
  const p = pedidoPorToken(params.token);
  if (limitar(ipDe(req), 'pedido', 30, 600_000)) falla(429, 'Demasiados intentos. Espera unos minutos.');
  if (!['pendiente', 'confirmado', 'vencido', 'no_puede'].includes(p.estado) || p.lote_id) falla(400, 'Tu pedido ya va en camino: ya no se puede cambiar. Si necesitas algo, escríbele a la tienda.');
  const cp = carpetaDe(p);
  if (cp) body.dia = cp.dia;   // en una carpeta el día lo pone la empresa: el cliente confirma que puede
  const d = leerDatosEntrega(body);
  d.no_puede_nota = null;
  d.ubicacion_manual = body.ubicacion_manual === true ? 1 : 0;   // sin ubicación en tiempo real: el piloto llama antes
  if (!d.referencias) d.referencias = null;
  const antes = p.estado;
  let f = guardarPedido(p.id, { ...d, estado: 'pendiente' });
  f = revisarConfirmado(f, 'cliente');
  if (antes !== 'confirmado') avisar(p.usuario_id, { titulo: 'Un cliente confirmó su pedido', cuerpo: `${f.cliente_nombre}: ${fechaLarga(f.dia)}, ${HORARIOS[f.horario].toLowerCase()}.`, url: '/mi-cuenta?empresa=1', etiqueta: 'pedidos-confirmados' });
  return { ok: true, precio: precioPedido(f) };
});
ruta('POST', '/api/pedido/:token/no-puedo', ({ req, params, body }) => {
  const p = pedidoPorToken(params.token);
  if (limitar(ipDe(req), 'pedido', 30, 600_000)) falla(429, 'Demasiados intentos. Espera unos minutos.');
  if (!['pendiente', 'confirmado', 'vencido', 'no_puede'].includes(p.estado) || p.lote_id) falla(400, 'Tu pedido ya va en camino: escríbele a la tienda.');
  const nota = texto(body.nota, 200) || null;
  guardarPedido(p.id, { estado: 'no_puede', no_puede_nota: nota, confirmado_en: null });
  avisar(p.usuario_id, { titulo: `${p.cliente_nombre.split(' ')[0]} no puede ese día`, cuerpo: `${p.codigo}${nota ? ': ' + nota : ''}. Cámbialo de carpeta o de día.`, url: '/mi-cuenta?empresa=1', etiqueta: 'pedido-' + p.id });
  return { ok: true };
});
ruta('POST', '/api/pedido/:token/push', ({ params, body }) => {
  const p = pedidoPorToken(params.token);
  const s = body.suscripcion || {};
  const endpoint = texto(s.endpoint, 1000), p256dh = texto(s.keys?.p256dh, 200), auth = texto(s.keys?.auth, 100);
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) falla(400, 'Suscripción no válida.');
  db.prepare('DELETE FROM push_pedidos WHERE endpoint = ?').run(endpoint);
  db.prepare('INSERT INTO push_pedidos (pedido_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)').run(p.id, endpoint, p256dh, auth);
  avisarCliente(p.id, { titulo: 'Avisos activados', cuerpo: `Te avisaremos cuando tu pedido de ${nombreEmpresa(p.usuario_id)} salga y cuando seas la próxima entrega.`, url: '/pedido/' + p.token, etiqueta: 'pedido-' + p.id });
  return { ok: true };
});
async function avisarPedidoPush(pedidoId, datos) {
  for (const s of db.prepare('SELECT * FROM push_pedidos WHERE pedido_id = ?').all(pedidoId)) {
    if ((await push.enviar(s, datos)) === 'vencida') db.prepare('DELETE FROM push_pedidos WHERE id = ?').run(s.id);
  }
}
const avisarCliente = (pedidoId, datos) => { avisarPedidoPush(pedidoId, datos).catch(() => {}); };

// Avisos de un envío que viene de un pedido de empresa: al cliente (navegador) y a la empresa (resumido por ruta)
function avisarPedido(e, tipo) {
  const p = db.prepare('SELECT * FROM pedidos_empresa WHERE id = ?').get(e.pedido_id);
  if (!p) return;
  const emp = nombreEmpresa(e.usuario_id), piloto = (e.mensajero_nombre || 'El piloto').split(' ')[0];
  const total = e.grupo ? db.prepare('SELECT COUNT(*) AS n FROM envios WHERE grupo = ?').get(e.grupo).n : 1;
  const url = '/pedido/' + p.token, urlEmp = '/mi-cuenta?empresa=1';
  switch (tipo) {
    case 'aceptado':
      avisarCliente(p.id, { titulo: `Tu pedido de ${emp} va en camino`, cuerpo: `${piloto} lo lleva.${total > 1 ? ` Eres la entrega ${e.parada} de ${total}.` : ''} Ten a mano tu código de entrega.`, url, etiqueta: 'pedido-' + p.id });
      if ((e.parada || 1) === 1) {
        avisar(e.usuario_id, { titulo: `${piloto} aceptó tu ruta`, cuerpo: `${total} pedido(s) en camino.`, url: urlEmp, etiqueta: 'ruta-' + (e.grupo || e.id) });
        correoA(e.usuario_id, `${piloto} aceptó tu ruta de ${total} pedido(s)`, 'Tus pedidos van en camino', [`${piloto} aceptó la ruta con ${total} pedido(s). Puedes seguir cada entrega en tu panel.`], { texto: 'Ver mis pedidos', url: urlEmp });
      }
      break;
    case 'recogido':   // pedido suelto: empieza el conteo al recogerlo (las rutas lo hacen al recoger todo)
      if (!e.grupo) estimarSinEsperar(e, coordenada(e.mensajero_lat, e.mensajero_lng) || coordenada(e.origen_lat, e.origen_lng));
      break;
    case 'hora': avisarCliente(p.id, { titulo: `Tu pedido de ${emp} ya va en camino`, cuerpo: `${piloto} lo recogió. Llega ${ventanaTexto(e)} (puede variar por el tráfico).`, url, etiqueta: 'pedido-' + p.id }); break;
    case 'atraso': avisarCliente(p.id, { titulo: 'Tu pedido viene un poco tarde', cuerpo: `Por el tráfico, ahora llega ${ventanaTexto(e)}. Disculpa la espera.`, url, etiqueta: 'pedido-' + p.id }); break;
    case 'llegando': avisarCliente(p.id, { titulo: 'Tu pedido está llegando', cuerpo: `${piloto} está llegando con tu pedido de ${emp}. Ten a mano tu código.`, url, etiqueta: 'pedido-' + p.id, urgente: true }); break;
    case 'entregado':
      avisarCliente(p.id, { titulo: 'Pedido entregado', cuerpo: `Tu pedido de ${emp} fue entregado${e.recibio ? ' a ' + e.recibio : ''}. ¡Gracias!`, url, etiqueta: 'pedido-' + p.id });
      avisarSiguienteParada(e); rutaTerminada(e);
      if (e.grupo) estimarSinEsperar(e, coordenada(e.destino_lat, e.destino_lng));   // se ajusta la hora de las que faltan
      break;
    case 'fallido': {
      const motivo = MOTIVOS_FALLO[e.fallo_motivo] || 'motivo no indicado';
      avisarCliente(p.id, { titulo: 'No pudimos entregar tu pedido', cuerpo: `Queda en la sede de Vaelo. Escríbele a ${emp} para coordinar.`, url, etiqueta: 'pedido-' + p.id });
      avisar(e.usuario_id, { titulo: 'Un pedido no se pudo entregar', cuerpo: `${e.guia} (${p.cliente_nombre}): ${motivo}. Queda en la sede de Vaelo.`, url: urlEmp, etiqueta: 'fallo-' + e.id, urgente: true });
      correoA(e.usuario_id, `No se pudo entregar el pedido ${e.guia}`, 'Un pedido quedó en la sede', [`El pedido ${e.guia} de ${p.cliente_nombre} no se pudo entregar: ${motivo}.`,
        'El paquete queda guardado en la sede de Vaelo. Manda a alguien a recogerlo con el código del pedido; la bodega se cobra por día y se coordina por WhatsApp.'], { texto: 'Ver mis pedidos', url: urlEmp });
      avisarStaff({ titulo: 'Pedido de empresa no entregado', cuerpo: `${e.guia}: ${motivo}`, url: RUTA_ADMIN, etiqueta: 'fallido-' + e.id });
      avisarSiguienteParada(e);
      if (e.grupo) estimarSinEsperar(e, coordenada(e.destino_lat, e.destino_lng));
      break;
    }
    case 'a_sede': rutaTerminada(e); break;
    case 'en_sede': avisar(e.usuario_id, { titulo: 'Tu pedido está en la sede', cuerpo: `${e.guia} ya está guardado en la sede de Vaelo. Pasa a recogerlo con el código.`, url: urlEmp, etiqueta: 'sede-' + e.id }); break;
  }
}
// "Eres el próximo": a quien sigue en la ruta
function avisarSiguienteParada(e) {
  if (!e.grupo) return;
  const sig = db.prepare(`SELECT * FROM envios WHERE grupo = ? AND estado IN ('recogido','en_camino') AND aviso_proximo IS NULL AND pedido_id IS NOT NULL ORDER BY parada LIMIT 1`).get(e.grupo);
  if (!sig) return;
  const desde = e.destino_lat != null ? { lat: e.destino_lat, lng: e.destino_lng } : e.origen_lat != null ? { lat: e.origen_lat, lng: e.origen_lng } : null;
  const min = desde && sig.destino_lat != null ? Math.max(5, Math.round((distanciaRecta(desde, { lat: sig.destino_lat, lng: sig.destino_lng }) * 1.4 / 22) * 60 + 3)) : null;
  db.prepare("UPDATE envios SET aviso_proximo = datetime('now') WHERE id = ?").run(sig.id);
  const p = db.prepare('SELECT * FROM pedidos_empresa WHERE id = ?').get(sig.pedido_id);
  const piloto = (db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(sig.mensajero_id)?.nombre || 'El piloto').split(' ')[0];
  if (p) avisarCliente(p.id, { titulo: 'Eres la próxima entrega', cuerpo: `${piloto} va hacia ti${min ? `, llega en unos ${min} minutos` : ''}. Ten a mano tu código de entrega.`, url: '/pedido/' + p.token, etiqueta: 'pedido-' + p.id, urgente: true });
}
function rutaTerminada(e) {
  const abiertos = (cond, v) => db.prepare(`SELECT COUNT(*) AS n FROM envios WHERE ${cond} AND estado IN ('pendiente','recogido','en_camino','fallido')`).get(v).n;
  if (e.grupo && !abiertos('grupo = ?', e.grupo)) {
    const r = db.prepare("SELECT SUM(estado = 'entregado') AS ok, SUM(estado IN ('a_sede','en_sede')) AS sede, COUNT(*) AS n FROM envios WHERE grupo = ?").get(e.grupo);
    const cuerpo = `${r.ok} de ${r.n} entregados${r.sede ? `, ${r.sede} en la sede de Vaelo` : ''}.`;
    avisar(e.usuario_id, { titulo: 'Ruta terminada', cuerpo, url: '/mi-cuenta?empresa=1', etiqueta: 'ruta-' + e.grupo });
    correoA(e.usuario_id, 'Ruta terminada', 'Terminó la ruta de tus pedidos', [cuerpo, r.sede ? 'Los que quedaron en la sede se recogen ahí con el código del pedido.' : 'Gracias por usar Vaelo.'], { texto: 'Ver mis pedidos', url: '/mi-cuenta?empresa=1' });
  }
  if (e.lote_empresa_id && !abiertos('lote_empresa_id = ?', e.lote_empresa_id)) db.prepare("UPDATE lotes_empresa SET estado = 'terminado' WHERE id = ? AND estado = 'en_ruta'").run(e.lote_empresa_id);
}
// Cada hora: a la empresa se le avisa de los clientes que no llenan su enlace, y los pedidos de días que ya pasaron vencen
function revisarPedidos() {
  const horas = ajNum('horas_recordatorio', 24);
  const sinLlenar = db.prepare(`SELECT usuario_id, COUNT(*) AS n FROM pedidos_empresa WHERE estado = 'pendiente' AND enlace_enviado_en IS NOT NULL AND recordado_en IS NULL
    AND enlace_enviado_en < datetime('now', ?) GROUP BY usuario_id`).all(`-${Math.round(horas * 60)} minutes`);
  for (const r of sinLlenar) {
    avisar(r.usuario_id, { titulo: 'Clientes sin confirmar', cuerpo: `${r.n} cliente(s) todavía no llenan su enlace. Reenvíaselo por WhatsApp desde tu panel.`, url: '/mi-cuenta?empresa=1', etiqueta: 'recordatorio' });
    db.prepare(`UPDATE pedidos_empresa SET recordado_en = datetime('now') WHERE usuario_id = ? AND estado = 'pendiente' AND enlace_enviado_en IS NOT NULL AND recordado_en IS NULL AND enlace_enviado_en < datetime('now', ?)`).run(r.usuario_id, `-${Math.round(horas * 60)} minutes`);
  }
  // Confirmados para un día que ya pasó y que nunca se mandaron a Vaelo
  const vencidos = db.prepare("SELECT usuario_id, COUNT(*) AS n FROM pedidos_empresa WHERE estado = 'confirmado' AND lote_id IS NULL AND dia < ? GROUP BY usuario_id").all(hoyGT());
  for (const r of vencidos) avisar(r.usuario_id, { titulo: 'Pedidos sin enviar', cuerpo: `${r.n} pedido(s) eran para un día que ya pasó. Pide a tus clientes una fecha nueva.`, url: '/mi-cuenta?empresa=1', etiqueta: 'vencidos' });
  db.prepare("UPDATE pedidos_empresa SET estado = 'vencido', actualizado = datetime('now') WHERE estado = 'confirmado' AND lote_id IS NULL AND dia < ?").run(hoyGT());
}
if (require.main === module) setInterval(() => { try { revisarPedidos(); } catch (err) { console.error('Pedidos:', err.message); } }, 3600_000).unref();

// ---------- Panel: empresas activas, sus pedidos y "Dividir pedidos" ----------
function resumenEmpresa(uid) {
  const n = (sql, ...a) => db.prepare(sql).get(uid, ...a).n;
  return {
    por_confirmar: n("SELECT COUNT(*) AS n FROM pedidos_empresa WHERE usuario_id = ? AND estado = 'pendiente'"),
    confirmados: n("SELECT COUNT(*) AS n FROM pedidos_empresa WHERE usuario_id = ? AND estado = 'confirmado' AND lote_id IS NULL"),
    lotes_nuevos: n("SELECT COUNT(*) AS n FROM lotes_empresa WHERE usuario_id = ? AND estado = 'nuevo'"),
    en_ruta: n("SELECT COUNT(*) AS n FROM envios WHERE usuario_id = ? AND pedido_id IS NOT NULL AND estado IN ('pendiente','recogido','en_camino')"),
    en_sede: n("SELECT COUNT(*) AS n FROM envios WHERE usuario_id = ? AND pedido_id IS NOT NULL AND estado IN ('fallido','a_sede','en_sede')"),
    entregados_mes: n("SELECT COUNT(*) AS n FROM envios WHERE usuario_id = ? AND pedido_id IS NOT NULL AND estado = 'entregado' AND strftime('%Y-%m', entregado_en, '-6 hours') = ?", hoyGT().slice(0, 7)),
  };
}
// La empresa solo ve lo que gana ella (nunca las cifras de Vaelo)
ruta('GET', '/api/empresa/bono', ({ req }) => {
  const u = requiereUsuario(req);
  if (u.rol !== 'cliente') falla(403, 'Solo para empresas.');
  const r = resumenBono(u.id);
  if (!r.activo) return { activo: false };   // sin bono activado no ve nada
  const ultimos = db.prepare(`SELECT b.monto, b.creado, e.guia, e.destino_nombre FROM bonos_empresa b JOIN envios e ON e.id = b.envio_id
    WHERE b.usuario_id = ? ORDER BY b.id DESC LIMIT 15`).all(u.id);
  return { ...r, ultimos };
});
ruta('GET', '/api/admin/bonos', ({ req }) => {
  requiereRol(req, 'admin');
  const lista = db.prepare("SELECT id, nombre, empresa_nombre, bono_envio, bono_modo, bono_activo FROM usuarios WHERE tipo_cuenta = 'empresa' AND rol = 'cliente' ORDER BY COALESCE(empresa_nombre, nombre)").all()
    .map((u) => { const r = resumenBono(u.id); return { id: u.id, empresa: u.empresa_nombre || u.nombre, propio: u.bono_envio, ...r, liquidaciones: undefined }; });
  return { general: Number(getAjustes().bono_empresa) || 0, tope: TOPE_BONO, empresas: lista,
    pendiente: redondear(lista.reduce((t, x) => t + x.pendiente, 0)) };
});
ruta('PUT', '/api/admin/bonos/:id', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const u = db.prepare("SELECT id FROM usuarios WHERE id = ? AND tipo_cuenta = 'empresa'").get(Number(params.id));
  if (!u) falla(404, 'No encontramos esa empresa.');
  let propio = null;
  if (body.bono_envio !== '' && body.bono_envio != null) {
    propio = numero(body.bono_envio);
    if (!(propio >= 0 && propio <= TOPE_BONO)) falla(400, `El bono por envío va de Q0 a Q${TOPE_BONO}.`);
  }
  const modo = body.bono_modo === 'descuento' ? 'descuento' : 'pago';
  db.prepare('UPDATE usuarios SET bono_envio = ?, bono_modo = ?, bono_activo = ? WHERE id = ?').run(propio, modo, body.bono_activo ? 1 : 0, u.id);
  return { ok: true, ...resumenBono(u.id) };
});
ruta('POST', '/api/admin/bonos/:id/liquidar', ({ req, params, body }) => {
  const yo = requiereRol(req, 'admin');
  const u = db.prepare("SELECT id, bono_modo FROM usuarios WHERE id = ? AND tipo_cuenta = 'empresa'").get(Number(params.id));
  if (!u) falla(404, 'No encontramos esa empresa.');
  const p = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(monto), 0) AS total FROM bonos_empresa WHERE usuario_id = ? AND liquidacion_id IS NULL').get(u.id);
  if (!p.n) falla(400, 'No tiene nada pendiente.');
  db.exec('BEGIN');
  try {
    const id = Number(db.prepare('INSERT INTO liquidaciones_bono (usuario_id, monto, entregas, modo, nota, hecho_por) VALUES (?, ?, ?, ?, ?, ?)')
      .run(u.id, redondear(p.total), p.n, u.bono_modo || 'pago', texto(body.nota, 200) || null, yo.id).lastInsertRowid);
    db.prepare('UPDATE bonos_empresa SET liquidacion_id = ? WHERE usuario_id = ? AND liquidacion_id IS NULL').run(id, u.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true, ...resumenBono(u.id) };
});
// Recogidas fijas que tocan hoy (hora de Guatemala)
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const textoRecogida = (u) => u.recogida_dias ? `${u.recogida_dias.split(',').map((d) => DIAS_SEMANA[d]).join(', ')} a las ${u.recogida_hora}` : null;
function recogidasDeHoy() {
  const dia = new Date(Date.now() - 6 * 3600_000).getUTCDay();
  return db.prepare("SELECT id, nombre, empresa_nombre, telefono, recogida_dias, recogida_hora FROM usuarios WHERE tipo_cuenta = 'empresa' AND rol = 'cliente' AND recogida_dias IS NOT NULL").all()
    .filter((u) => u.recogida_dias.split(',').map(Number).includes(dia))
    .map((u) => ({ id: u.id, empresa: u.empresa_nombre || u.nombre, telefono: u.telefono, hora: u.recogida_hora,
      listos: db.prepare("SELECT COUNT(*) AS n FROM pedidos_empresa WHERE usuario_id = ? AND estado = 'confirmado' AND lote_id IS NULL").get(u.id).n }))
    .sort((a, b) => a.hora.localeCompare(b.hora));
}
// Estado de cuenta del mes de una empresa (Excel) para facturar
ruta('GET', '/api/admin/empresas/:id/estado-cuenta', ({ req, res, params, query }) => {
  requiereRol(req, 'admin');
  const u = db.prepare("SELECT * FROM usuarios WHERE id = ? AND tipo_cuenta = 'empresa'").get(Number(params.id));
  if (!u) falla(404, 'No encontramos esa empresa.');
  const mes = /^\d{4}-\d{2}$/.test(query.get('mes') || '') ? query.get('mes') : hoyGT().slice(0, 7);
  const filas = db.prepare(`SELECT e.guia, e.creado, e.entregado_en, e.destino_nombre, e.destino_zona, e.estado, e.metodo_pago, e.precio, e.cobro_destinatario, e.sede_llegada,
      (SELECT monto FROM bonos_empresa b WHERE b.envio_id = e.id) AS bono
    FROM envios e WHERE e.usuario_id = ? AND e.estado != 'cancelado' AND strftime('%Y-%m', COALESCE(e.entregado_en, e.creado), '-6 hours') = ? ORDER BY e.id`).all(u.id, mes);
  const cargos = db.prepare("SELECT tipo, monto, creado, pagado_en FROM cargos WHERE usuario_id = ? AND anulado_en IS NULL AND strftime('%Y-%m', creado, '-6 hours') = ?").all(u.id, mes);
  const pagaEmpresa = filas.filter((f) => f.metodo_pago !== 'recibe' && f.estado === 'entregado').reduce((t, f) => t + (f.precio || 0), 0);
  const buf = crearExcel([
    { nombre: 'Resumen', titulo: `${u.empresa_nombre || u.nombre} · estado de cuenta ${mes}`, columnas: [{ titulo: 'Concepto', ancho: 40 }, { titulo: 'Valor', ancho: 26 }],
      filas: [['Empresa', u.empresa_nombre || u.nombre], ['NIT', u.fact_nit || 'Falta'], ['Nombre para la factura', u.fact_nombre || u.empresa_nombre || u.nombre], ['Dirección fiscal', u.fact_direccion || 'Ciudad'],
        ['Mes', mes], ['Envíos', filas.length], ['Entregados', filas.filter((f) => f.estado === 'entregado').length],
        ['Envíos pagados por la empresa (Q)', redondear(pagaEmpresa)], ['Envíos pagados por quien recibe (Q)', redondear(filas.filter((f) => f.metodo_pago === 'recibe' && f.estado === 'entregado' && !f.sede_llegada).reduce((t, f) => t + (f.precio || 0), 0))],
        ['Cobrado a sus clientes por su producto (Q)', redondear(filas.filter((f) => f.estado === 'entregado' && !f.sede_llegada).reduce((t, f) => t + (f.cobro_destinatario || 0), 0))],
        ['Cargos (bodega, devoluciones, etc.) (Q)', redondear(cargos.reduce((t, c) => t + c.monto, 0))], ['Bono ganado por la empresa (Q)', redondear(filas.reduce((t, f) => t + (f.bono || 0), 0))]] },
    { nombre: 'Envíos', columnas: [{ titulo: 'Guía', ancho: 14 }, { titulo: 'Creado', ancho: 17 }, { titulo: 'Entregado', ancho: 17 }, { titulo: 'Recibe', ancho: 24 }, { titulo: 'Zona', ancho: 14 },
      { titulo: 'Estado', ancho: 14 }, { titulo: 'Paga', ancho: 16 }, { titulo: 'Precio', tipo: 'dinero' }, { titulo: 'Cobro producto', tipo: 'dinero' }, { titulo: 'Bono', tipo: 'dinero' }],
      filas: filas.map((f) => [f.guia, fechaGT(f.creado), fechaGT(f.entregado_en), f.destino_nombre, f.destino_zona, ESTADO_TEXTO[f.estado] || f.estado,
        f.metodo_pago === 'recibe' ? 'Quien recibe' : 'La empresa', f.precio || 0, f.cobro_destinatario || 0, f.bono || 0]) },
    { nombre: 'Cargos', columnas: [{ titulo: 'Fecha', ancho: 17 }, { titulo: 'Tipo', ancho: 24 }, { titulo: 'Monto', tipo: 'dinero' }, { titulo: 'Pagado', ancho: 17 }],
      filas: cargos.map((c) => [fechaGT(c.creado), c.tipo, c.monto, fechaGT(c.pagado_en)]) },
  ]);
  return enviarExcel(res, buf, `vaelo-${(u.empresa_nombre || u.nombre).replace(/[^\w-]+/g, '-')}-${mes}.xlsx`);
});
ruta('GET', '/api/admin/empresas-activas', ({ req }) => {
  requiereStaff(req);
  const lista = db.prepare("SELECT id, nombre, empresa_nombre, telefono, email, tipo_cuenta, tienda_estado FROM usuarios WHERE tipo_cuenta IN ('empresa','minorista') AND rol = 'cliente' ORDER BY COALESCE(empresa_nombre, nombre)").all()
    .map((u) => ({ ...u, ...resumenEmpresa(u.id) }));
  lista.sort((a, b) => b.lotes_nuevos - a.lotes_nuevos || b.en_ruta - a.en_ruta || b.en_sede - a.en_sede || b.confirmados - a.confirmados);
  return { empresas: lista, recogidas_hoy: recogidasDeHoy(), lotes_nuevos: lista.reduce((t, e) => t + e.lotes_nuevos, 0), solicitudes: db.prepare("SELECT COUNT(*) AS n FROM solicitudes_empresa WHERE estado = 'enviada'").get().n,
    tiendas_pendientes: lista.filter((e) => e.tipo_cuenta === 'minorista' && e.tienda_estado === 'pendiente').length };
});
function loteSalida(l, conDinero) {
  const pedidos = db.prepare('SELECT * FROM pedidos_empresa WHERE lote_id = ? ORDER BY id').all(l.id).map((p) => pedidoSalida(p, conDinero));
  let rec = null; try { rec = JSON.parse(l.recomendado || 'null'); } catch { /* vacío */ }
  const foco = focoDeLote(l.id);
  if (foco) { const ids = new Set(foco.elegibles); for (const p of pedidos) p.zona_foco = ids.has(p.id); delete foco.elegibles; if (!conDinero) { delete foco.precio; delete foco.ganancia; } }
  return { ...l, foco, modo_texto: MODOS_LOTE[l.modo], recomendacion: rec, pedidos, origen: origenLote(l), empresa: nombreEmpresa(l.usuario_id),
    telefono_empresa: db.prepare('SELECT telefono FROM usuarios WHERE id = ?').get(l.usuario_id)?.telefono || '',
    dias_sede: l.recibido_en && l.estado === 'nuevo' ? Math.max(0, Math.round((Date.parse(hoyGT()) - Date.parse(new Date(fechaMs(l.recibido_en) - 6 * 3600_000).toISOString().slice(0, 10))) / 86400_000)) : 0,
    se_puede_asignar: l.dia <= hoyGT() };
}
ruta('GET', '/api/admin/empresas-activas/:id', ({ req, params }) => {
  const quien = requiereStaff(req);
  const conDinero = !esOperador(quien);
  const u = db.prepare("SELECT * FROM usuarios WHERE id = ? AND tipo_cuenta IN ('empresa','minorista')").get(Number(params.id)) || falla(404, 'No encontramos esa empresa.');
  const s = solicitudDe(u.id);
  const lotes = db.prepare("SELECT * FROM lotes_empresa WHERE usuario_id = ? AND estado IN ('nuevo','en_ruta') ORDER BY dia, id").all(u.id).map((l) => loteSalida(l, conDinero));
  const enRuta = db.prepare(`${SQL_ENVIO} WHERE e.usuario_id = ? AND e.pedido_id IS NOT NULL AND e.estado IN ('pendiente','recogido','en_camino') ORDER BY e.grupo, e.parada`).all(u.id)
    .map((e) => ({ id: e.id, guia: e.guia, estado: e.estado, destino_nombre: e.destino_nombre, destino_zona: e.destino_zona, piloto: e.mensajero_nombre, asignacion: e.asignacion, parada: e.parada, grupo: e.grupo, horario: e.horario }));
  const tarifa = ajNum('cargo_bodega_empresa', 10);
  const enSede = db.prepare(`${SQL_ENVIO} WHERE e.usuario_id = ? AND e.pedido_id IS NOT NULL AND e.estado IN ('fallido','a_sede','en_sede') ORDER BY e.id`).all(u.id)
    .map((e) => ({ id: e.id, guia: e.guia, estado: e.estado, destino_nombre: e.destino_nombre, fallo: MOTIVOS_FALLO[e.fallo_motivo] || '', llegada: e.sede_llegada,
      dias: e.sede_llegada ? diasEnSede(e) : 0, ...(conDinero ? { cargo: e.sede_llegada ? cargoSedePedido(e, tarifa) : 0 } : {}) }));
  const historial = db.prepare(`${SQL_ENVIO} WHERE e.usuario_id = ? AND e.pedido_id IS NOT NULL ORDER BY e.id DESC LIMIT 200`).all(u.id)
    .map((e) => ({ id: e.id, guia: e.guia, estado: e.estado, creado: e.creado, entregado_en: e.entregado_en, destino_nombre: e.destino_nombre, destino_zona: e.destino_zona, piloto: e.mensajero_nombre }));
  const porConfirmar = db.prepare("SELECT dia, COUNT(*) AS n FROM pedidos_empresa WHERE usuario_id = ? AND estado = 'confirmado' AND lote_id IS NULL GROUP BY dia ORDER BY dia").all(u.id);
  return { empresa: { id: u.id, nombre: u.empresa_nombre || u.nombre, contacto: u.nombre, telefono: u.telefono, email: u.email, punto: puntoEmpresa(u),
      solicitud: s ? { rep_nombre: s.rep_nombre, rep_telefono: s.rep_telefono, direccion: s.direccion, zona: s.zona, nit: s.nit, giro: s.giro, aprobada_en: s.aprobada_en, id: s.id } : null, ...resumenEmpresa(u.id) },
    lotes, en_ruta: enRuta, en_sede: enSede, historial, confirmados_por_dia: porConfirmar, tarifa_bodega: conDinero ? tarifa : null };
});
const loteParaPanel = (id) => db.prepare('SELECT * FROM lotes_empresa WHERE id = ?').get(Number(id)) || falla(404, 'No encontramos ese envío de empresa.');
function pilotosPara(vehiculoId) {
  return db.prepare(`${SQL_PILOTO} WHERE u.rol = 'mensajero' AND u.estado_piloto = 'aprobado' AND u.activo = 1`).all()
    .filter((p) => puedeTrabajar(p) && (!vehiculoId || p.vehiculo_id === vehiculoId))
    .map((p) => ({ id: p.id, nombre: p.nombre, vehiculo: p.vehiculo, vehiculo_id: p.vehiculo_id, en_linea: enLineaReal(p), activos: p.activos, carga: cargaPiloto(p.id), lat: enLineaReal(p) ? p.ubic_lat : null, lng: enLineaReal(p) ? p.ubic_lng : null }));
}
ruta('GET', '/api/admin/lotes-empresa/:id', ({ req, params }) => {
  const quien = requiereStaff(req);
  const l = loteParaPanel(params.id);
  const moto = vehiculoMoto(), pick = vehiculoPickup();
  return { lote: loteSalida(l, !esOperador(quien)), pilotos_moto: pilotosPara(moto?.id), pilotos_pickup: pick ? pilotosPara(pick.id) : [], modos: MODOS_LOTE,
    cupo: ajNum('cupo_moto', 30), horas: ajNum('horas_ruta_moto', 4), tamanos: TAMANOS, whatsapp_empresa: digitos(db.prepare('SELECT telefono FROM usuarios WHERE id = ?').get(l.usuario_id)?.telefono) };
});
// Calcula rutas: una moto, dividir entre N motos o pickup
ruta('POST', '/api/admin/lotes-empresa/:id/calcular', async ({ req, params, body }) => {
  requiereStaff(req);
  const l = loteParaPanel(params.id);
  const origen = origenLote(l) || falla(400, 'Falta el punto de recogida.');
  const pedidos = db.prepare("SELECT * FROM pedidos_empresa WHERE lote_id = ? AND estado = 'confirmado'").all(l.id);
  if (!pedidos.length) falla(400, 'Este envío ya no tiene pedidos por repartir.');
  const modo = MODOS_LOTE[body.modo] ? body.modo : 'una_moto';
  const k = modo === 'motos' ? Math.max(1, Math.min(pedidos.length, Math.round(numero(body.motos)) || 2)) : modo === 'un_paquete' ? pedidos.length : 1;
  const rutas = modo === 'un_paquete' ? pedidos.map((p) => [p]) : dividirEnRutas(origen, pedidos, k);
  const cupo = ajNum('cupo_moto', 30), horas = ajNum('horas_ruta_moto', 4);
  const medidas = modo === 'un_paquete' ? rutas.map((r) => ({ orden: r, ...medirRuta(origen, r) }))   // uno por moto: no hay orden que calcular
    : await Promise.all(rutas.map((r) => ordenarYMedir(origen, r, modo === 'pickup')));
  return { modo, rutas: medidas.map(({ orden, ...m }) => ({ pedidos: orden.map((p) => p.id), ...m, excede_cupo: modo !== 'pickup' && m.puntos > cupo, excede_horas: m.minutos > horas * 60 })) };
});
// Reordena una ruta por el camino más rápido (después de mover paradas entre rutas)
ruta('POST', '/api/admin/lotes-empresa/:id/ordenar', async ({ req, params, body }) => {
  requiereStaff(req);
  const l = loteParaPanel(params.id);
  const origen = origenLote(l) || falla(400, 'Falta el punto de recogida.');
  const ids = Array.isArray(body.pedidos) ? body.pedidos.map(Number) : [];
  const pedidos = ids.map((id) => db.prepare('SELECT * FROM pedidos_empresa WHERE id = ? AND lote_id = ?').get(id, l.id)).filter(Boolean);
  if (!pedidos.length) falla(400, 'Esa ruta no tiene pedidos.');
  const { orden, ...m } = await ordenarYMedir(origen, pedidos, body.modo === 'pickup');
  return { pedidos: orden.map((p) => p.id), ...m };
});
ruta('POST', '/api/admin/lotes-empresa/:id/medir', ({ req, params, body }) => {
  requiereStaff(req);
  const l = loteParaPanel(params.id);
  const origen = origenLote(l) || falla(400, 'Falta el punto de recogida.');
  const ids = Array.isArray(body.pedidos) ? body.pedidos.map(Number) : [];
  const pedidos = ids.map((id) => db.prepare('SELECT * FROM pedidos_empresa WHERE id = ? AND lote_id = ?').get(id, l.id)).filter(Boolean);
  return medirRuta(origen, pedidos, body.modo === 'pickup');
});
ruta('POST', '/api/admin/lotes-empresa/:id/recibido', ({ req, params }) => {
  const quien = requiereStaff(req);
  const l = loteParaPanel(params.id);
  if (l.recogida !== 'sede' || l.recibido_en) falla(400, 'Este envío no espera paquetes en la sede.');
  db.prepare("UPDATE lotes_empresa SET recibido_en = datetime('now'), recibido_por = ? WHERE id = ?").run(quien.nombre.split(' ')[0], l.id);
  avisar(l.usuario_id, { titulo: 'Recibimos tus paquetes', cuerpo: 'Tus paquetes ya están en la sede de Vaelo. Los que salen hoy no pagan bodega.', url: '/mi-cuenta?empresa=1', etiqueta: 'lote-emp-' + l.id });
  return { ok: true };
});
ruta('POST', '/api/admin/lotes-empresa/:id/cancelar', ({ req, params }) => {
  requiereStaff(req);
  const l = loteParaPanel(params.id);
  if (l.estado !== 'nuevo') falla(400, 'Este envío ya tiene pilotos asignados.');
  cancelarLote(l);
  avisar(l.usuario_id, { titulo: 'Envío a Vaelo cancelado', cuerpo: 'Tus pedidos vuelven a estar como confirmados. Escríbenos por WhatsApp si tienes dudas.', url: '/mi-cuenta?empresa=1' });
  return { ok: true };
});
// La oficina confirma la transferencia del cliente o cambia el pago a "al recibir"
ruta('POST', '/api/admin/pedidos/:id/pago', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const p = db.prepare('SELECT * FROM pedidos_empresa WHERE id = ?').get(Number(params.id)) || falla(404, 'No encontramos ese pedido.');
  if (p.estado !== 'confirmado') falla(400, 'Este pedido ya salió.');
  if (body.accion === 'transferencia_ok') db.prepare("UPDATE pedidos_empresa SET transferencia_ok = datetime('now') WHERE id = ?").run(p.id);
  else if (body.accion === 'efectivo') db.prepare("UPDATE pedidos_empresa SET metodo_pago = 'efectivo', transferencia_ok = NULL WHERE id = ?").run(p.id);
  else falla(400, 'Acción no válida.');
  return { ok: true };
});
// Confirmar las rutas: se crean los envíos (con el mismo código del pedido) y se ofrecen a los pilotos
ruta('POST', '/api/admin/lotes-empresa/:id/confirmar', ({ req, params, body }) => {
  const quien = requiereStaff(req);
  const l = loteParaPanel(params.id);
  if (l.estado !== 'nuevo') falla(400, 'Este envío ya tiene sus rutas.');
  if (l.dia > hoyGT()) falla(400, `Las rutas se asignan el mismo día de la entrega (${fechaLarga(l.dia)}).`);
  if (l.recogida === 'sede' && !l.recibido_en) falla(400, 'Primero marca que los paquetes llegaron a la sede.');
  const origen = origenLote(l) || falla(400, 'Falta el punto de recogida.');
  const modo = MODOS_LOTE[body.modo] ? body.modo : falla(400, 'Elige cómo se reparte.');
  const pedidos = db.prepare("SELECT * FROM pedidos_empresa WHERE lote_id = ? AND estado = 'confirmado'").all(l.id);
  const porId = new Map(pedidos.map((p) => [p.id, p]));
  const esPickup = modo === 'pickup';
  if (!esPickup && pedidos.some((p) => p.tamano === 'grande')) falla(400, 'Hay paquetes grandes: solo se pueden mandar en pickup.');
  const pagaEmpresa = esPickup && l.paga === 'empresa';
  if (!pagaEmpresa) {
    const sinPago = pedidos.filter((p) => p.metodo_pago === 'transferencia' && !p.transferencia_ok);
    if (sinPago.length) falla(400, `Falta confirmar la transferencia de: ${sinPago.map((p) => p.codigo).join(', ')}. Márcala recibida o cámbiala a pago al recibir.`);
  }
  let rutas = Array.isArray(body.rutas) ? body.rutas : [];
  if (modo === 'un_paquete' && !rutas.length) rutas = pedidos.map((p) => ({ pedidos: [p.id] }));
  if (esPickup && rutas.length !== 1) falla(400, 'En pickup va una sola ruta con todos los pedidos.');
  const usados = new Set();
  for (const r of rutas) {
    if (!Array.isArray(r.pedidos) || !r.pedidos.length) falla(400, 'Hay una ruta vacía.');
    for (const id of r.pedidos) { if (!porId.has(Number(id)) || usados.has(Number(id))) falla(400, 'Las rutas no coinciden con los pedidos de este envío. Vuelve a calcular.'); usados.add(Number(id)); }
  }
  if (usados.size !== pedidos.length) falla(400, 'Falta poner algunos pedidos en una ruta.');
  const vehiculo = esPickup ? vehiculoPickup() : vehiculoMoto();
  if (!vehiculo) falla(400, 'No hay vehículo configurado para este tipo de envío.');
  // Pilotos elegidos: aprobados, al día y con el vehículo correcto
  const pilotos = rutas.map((r) => {
    if (r.piloto_id === '' || r.piloto_id == null) return null;
    const m = pilotoPorId(numero(r.piloto_id));
    if (!m) falla(400, 'Uno de los pilotos elegidos ya no existe.');
    if (!puedeTrabajar(m)) falla(400, `${m.nombre} no puede trabajar ahora: ${porQueNoTrabaja(m)}.`);
    if (m.vehiculo_id !== vehiculo.id) falla(400, `${m.nombre.split(' ')[0]} no tiene ${vehiculo.nombre.toLowerCase()}.`);
    return m;
  });
  if (esPickup && !pilotos[0]) falla(400, 'Elige el piloto del pickup.');
  let precioTotal = 0, metodoEmpresa = null;
  if (pagaEmpresa) {
    precioTotal = redondear(numero(body.pickup_precio));
    if (!(precioTotal > 0)) falla(400, 'Escribe el precio que se acordó con la empresa por WhatsApp.');
    metodoEmpresa = 'efectivo';   // la empresa le paga al piloto en efectivo al recoger
  }
  const emp = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(l.usuario_id);
  const condTienda = condicionesDe(emp);
  const focoLote = focoDeLote(l.id);
  const programado = l.dia > hoyGT() ? new Date(Date.parse(l.dia + 'T07:00:00Z') + 6 * 3600_000).toISOString().slice(0, 19).replace('T', ' ') : null;
  const totalEnvios = pedidos.length;
  const partes = pagaEmpresa ? pedidos.map((_, i) => { const base = Math.floor((precioTotal / totalEnvios) * 100) / 100; return i === 0 ? redondear(precioTotal - base * (totalEnvios - 1)) : base; }) : null;
  let iParte = 0;
  const creados = [];
  // Con las zonas dibujadas, el piloto ve la zona real del punto marcado (no la que escribió el cliente)
  const formasZona = zonasConForma();
  const zonaReal = (p) => (formasZona.length && p.lat != null ? (zonaDeFormas({ lat: p.lat, lng: p.lng }, formasZona) || OTRA_ZONA) : p.zona);
  db.exec('BEGIN');
  try {
    rutas.forEach((r, ri) => {
      const grupo = r.pedidos.length > 1 ? `R${l.id}-${ri + 1}-${crypto.randomBytes(3).toString('hex')}` : null;
      const ordenados = r.pedidos.map((id) => porId.get(Number(id)));
      ordenados.forEach((p, i) => {
        const pr = pagaEmpresa ? null : precioPedido(p);
        const precio = pagaEmpresa ? partes[iParte++] : pr.precio;
        // El piloto gana lo de un envío normal aunque la tienda tenga descuento; en zona foco gana lo acordado en el plan
        const enFoco = !!(pr && pr.foco && focoLote);
        const acordada = pagaEmpresa ? null : enFoco ? focoLote.ganancia : gananciaPiloto(precioGeneralPedido(p));
        // envio_pagado: la tienda ya le cobró el envío a su cliente (el piloto no lo cobra; se le descuenta a la tienda)
        const metodo = pagaEmpresa ? metodoEmpresa : p.envio_pagado ? 'tienda' : p.metodo_pago === 'transferencia' ? 'transferencia' : 'recibe';
        const pagoEstado = metodo === 'transferencia' ? 'verificado' : null;
        const piloto = pilotos[ri];
        const res = db.prepare(`INSERT INTO envios (guia, usuario_id, vehiculo_id, peso, descripcion, origen_direccion, origen_zona, origen_telefono, origen_lat, origen_lng, origen_quien, origen_nombre, origen_ubic_fecha,
            destino_nombre, destino_telefono, destino_direccion, destino_zona, destino_lat, destino_lng, tipo_tarifa, precio, precio_base, metodo_pago, cobro_destinatario, notas,
            codigo_entrega, programado_para, receptor_token, receptor_nombre, receptor_confirmado_en, receptor_lat, receptor_lng, receptor_ubic_fecha, pago_estado, paquetes,
            foto_paquete, pedido_id, lote_empresa_id, parada, tamano, horario, grupo, cobro_en_recogida, mensajero_id, asignacion, asignado_en, asignado_por, precio_d_lat, precio_d_lng)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, 'zona', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${piloto ? "datetime('now')" : 'NULL'}, ?, ?, ?)`).run(
          p.codigo, l.usuario_id, vehiculo.id, p.descripcion, l.origen_direccion || '', l.recogida === 'sede' ? (zonaDePunto(origen) || OTRA_ZONA) : (emp.empresa_zona || zonaDePunto(origen) || OTRA_ZONA),
          l.recogida === 'sede' ? (emp.telefono || '') : (emp.punto_telefono || emp.telefono || ''), origen.lat, origen.lng, l.recogida === 'sede' ? 'sede' : 'cliente',
          l.recogida === 'sede' ? 'Sede Vaelo' : (emp.empresa_nombre || emp.nombre) + (emp.punto_contacto && emp.punto_contacto !== emp.nombre ? ` (entrega ${emp.punto_contacto})` : ''),
          p.recibe_nombre, p.recibe_telefono, p.direccion, zonaReal(p), p.lat, p.lng, precio, precio, metodo, redondear(Number(p.cobro) || 0), [p.ubicacion_manual ? 'Ubicación marcada a mano, no en tiempo real: llama a quien recibe antes de llegar' : null, p.referencias, `Cliente de ${emp.empresa_nombre || emp.nombre}`].filter(Boolean).join('. '),
          String(crypto.randomInt(1000, 10000)), programado, crypto.randomBytes(16).toString('hex'), p.recibe_nombre, p.confirmado_en, p.lat, p.lng, p.confirmado_en, pagoEstado,
          p.foto, p.id, l.id, grupo ? i + 1 : null, p.tamano, p.horario, grupo, pagaEmpresa && metodoEmpresa === 'efectivo' ? precioTotal : null,
          piloto ? piloto.id : null, piloto ? 'por_aceptar' : null, piloto ? 'oficina' : null, p.lat, p.lng);
        const id = Number(res.lastInsertRowid);
        db.prepare('UPDATE envios SET codigo_corto = ?, marcado = ?, comision_cobro = ?, ganancia_acordada = ?, tarifa_foco = ? WHERE id = ?').run(codigoCortoPedido(p), marcadoValido(l.marcado), comisionCobro(condTienda, p.cobro), acordada, enFoco ? 1 : 0, id);
        db.prepare("UPDATE pedidos_empresa SET estado = 'enviado', envio_id = ?, actualizado = datetime('now') WHERE id = ?").run(id, p.id);
        db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(id, 'pendiente', `Pedido de ${emp.empresa_nombre || emp.nombre}${grupo ? `, parada ${i + 1} de ${ordenados.length}` : ''}${piloto ? `. Asignado a ${piloto.nombre.split(' ')[0]}, esperando que acepte` : ''} (${quien.nombre.split(' ')[0]})`);
        creados.push({ id, ruta: ri, piloto });
      });
    });
    db.prepare("UPDATE lotes_empresa SET estado = 'en_ruta', modo = ?, pickup_precio = ?, pickup_metodo = ?, confirmado_por = ?, confirmado_en = datetime('now') WHERE id = ?")
      .run(modo, pagaEmpresa ? precioTotal : null, metodoEmpresa, quien.nombre.split(' ')[0], l.id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  // Aviso al piloto de cada ruta (uno por ruta)
  const avisadas = new Set();
  for (const c of creados) if (c.piloto && !avisadas.has(c.ruta)) { avisadas.add(c.ruta); avisarEnvio(c.id, 'asignado'); }
  avisar(l.usuario_id, { titulo: 'Vaelo preparó tus rutas', cuerpo: `${pedidos.length} pedidos en ${rutas.length} ruta(s). Te avisamos cuando cada piloto acepte.`, url: '/mi-cuenta?empresa=1', etiqueta: 'lote-emp-' + l.id });
  return { ok: true, envios: creados.length, rutas: rutas.length };
});

// ---------- Hora estimada de llegada ----------
// No se promete nada antes de que el piloto tenga el paquete: al recogerlo empieza el conteo (tiempo por calle, con tráfico
// si se puede, más 7 min por cada entrega antes). Se da una ventana con margen por tráfico o bloqueos: 30 min y hasta 1 h.
const MIN_POR_PARADA = 7;
const horaGT = (utc) => new Date(utc.replace(' ', 'T') + 'Z').toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour: 'numeric', minute: '2-digit' });
const ventanaTexto = (e) => (e.llega_desde ? `entre ${horaGT(e.llega_desde)} y ${horaGT(e.llega_hasta)}` : '');
const sqlFecha = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
async function estimarLlegadas(envio, desde) {
  const lista = envio.grupo
    ? db.prepare("SELECT * FROM envios WHERE grupo = ? AND mensajero_id = ? AND estado IN ('recogido','en_camino') ORDER BY COALESCE(parada, 999), id").all(envio.grupo, envio.mensajero_id)
    : db.prepare("SELECT * FROM envios WHERE id = ? AND estado IN ('recogido','en_camino')").all(envio.id);
  const paradas = lista.filter((e) => e.destino_lat != null);
  if (!paradas.length || !desde) return;
  const pickup = vehiculoPickup()?.id === envio.vehiculo_id;
  const pts = [desde, ...paradas.map((e) => ({ lat: e.destino_lat, lng: e.destino_lng }))];
  const m = await matrizCalles(pts, true).catch(() => null);
  const ahora = Date.now();
  let seg = 0;
  paradas.forEach((e, k) => {
    const tramo = m && m.tiempos[k] && m.tiempos[k][k + 1] != null ? m.tiempos[k][k + 1] : (distanciaRecta(pts[k], pts[k + 1]) * 1.4 / (pickup ? 18 : 22)) * 3600;
    seg += tramo + (k > 0 ? MIN_POR_PARADA * 60 : 0);
    const inicio = Math.floor((ahora + seg * 1000) / 300_000) * 300_000;   // redondeado a 5 minutos
    const margen = Math.min(60, 30 + 5 * k) * 60_000;
    const nueva = { desde: sqlFecha(inicio), hasta: sqlFecha(inicio + margen) };
    const atraso = e.llega_hasta && nueva.desde > e.llega_hasta;   // ya no llega dentro de lo que se le dijo
    db.prepare('UPDATE envios SET llega_desde = ?, llega_hasta = ? WHERE id = ?').run(nueva.desde, nueva.hasta, e.id);
    if (!e.llega_desde || atraso) avisarEnvio(e.id, atraso ? 'atraso' : 'hora');
  });
}
const estimarSinEsperar = (envio, desde) => { estimarLlegadas(envio, desde).catch(() => {}); };

// ---------- Piloto: recoger toda la ruta (marcando o escaneando cada paquete) ----------
ruta('POST', '/api/piloto/ruta/:grupo/recoger', ({ req, params, body }) => {
  const p = requierePilotoTrabajando(req);
  const grupo = String(params.grupo || '');
  const c = leerPosicion(body, true);
  const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(Number));
  const lista = db.prepare("SELECT * FROM envios WHERE grupo = ? AND mensajero_id = ? AND asignacion = 'aceptado' AND estado = 'pendiente' ORDER BY parada").all(grupo, p.id);
  if (!lista.length) falla(400, 'No tienes paquetes por recoger en esta ruta.');
  const marcar = lista.filter((e) => ids.has(e.id));
  if (!marcar.length) falla(400, 'Marca o escanea los paquetes que recibiste.');
  if (marcar[0].origen_lat != null) {
    const km = distanciaRecta(c, { lat: marcar[0].origen_lat, lng: marcar[0].origen_lng });
    if (km > 0.5) falla(400, `Estás a ${km.toFixed(1)} km del punto de recogida. Márcalo cuando estés ahí.`);
  }
  registrarUbicacion(p, c, numero(body.precision), true);
  for (const e of marcar) cambiarEstado(e.id, 'recogido', 'Paquete recogido', c.lat, c.lng);
  // Al tener todo, a la primera parada le llega "eres la próxima entrega"
  if (marcar.length === lista.length) {
    avisarSiguienteParada({ ...marcar[0], destino_lat: null, destino_lng: null });
    estimarSinEsperar(marcar[0], c);   // empieza el conteo de la hora de llegada
  }
  return { ok: true, recogidos: marcar.length, faltan: lista.length - marcar.length };
});

// ---------- Sueldo de cada piloto: lo que ganó menos el efectivo que trae ----------
const ULTIMO_PAGO = (pid) => db.prepare('SELECT creado FROM cuentas_piloto WHERE piloto_id = ? ORDER BY id DESC LIMIT 1').get(pid)?.creado
  || db.prepare('SELECT MAX(creado) AS c FROM pagos_piloto WHERE piloto_id = ?').get(pid)?.c || null;
const FRECUENCIAS = { diaria: { nombre: 'Cada día', dias: 1 }, semanal: { nombre: 'Cada semana', dias: 7 }, quincenal: { nombre: 'Cada quincena', dias: 15 } };
function cuentaPiloto(pid) {
  const filas = db.prepare(`SELECT e.id, e.guia, e.estado, e.destino_zona, e.piloto_cerro_en, e.metodo_pago, e.precio, e.cargos_extra, e.ganancia_piloto, e.pago_piloto_id, e.liquidado_id, ${SQL_EFECTIVO} AS efectivo
    FROM envios e WHERE e.mensajero_id = ? AND e.piloto_cerro_en IS NOT NULL AND (e.pago_piloto_id IS NULL OR (e.liquidado_id IS NULL AND ${SQL_EFECTIVO} > 0)) ORDER BY e.piloto_cerro_en`).all(pid);
  const ganancia = redondear(filas.filter((e) => !e.pago_piloto_id).reduce((t, e) => t + (e.ganancia_piloto || 0), 0));
  const efectivo = redondear(filas.filter((e) => !e.liquidado_id).reduce((t, e) => t + (e.efectivo || 0), 0));
  const transferencias = redondear(filas.filter((e) => !e.pago_piloto_id && e.metodo_pago === 'transferencia' && e.estado !== 'cancelado').reduce((t, e) => t + e.precio + (e.cargos_extra || 0), 0));
  const desc = descuentosPiloto(pid), descuentos = redondear(desc.reduce((t, x) => t + x.monto_piloto, 0));
  const neto = redondear(ganancia - descuentos - efectivo);
  const u = db.prepare('SELECT frecuencia_pago FROM usuarios WHERE id = ?').get(pid) || {};
  const frecuencia = FRECUENCIAS[u.frecuencia_pago] ? u.frecuencia_pago : 'diaria';
  const ultimo = ULTIMO_PAGO(pid);
  const primero = filas[0]?.piloto_cerro_en || null;
  const desdeMs = ultimo ? fechaMs(ultimo) : (primero ? fechaMs(primero) : Date.now());
  const dias = Math.floor((Date.now() - desdeMs) / 86400_000);
  const hay = filas.length > 0;
  const leToca = hay && (frecuencia === 'diaria' || neto < 0 || dias >= FRECUENCIAS[frecuencia].dias);
  const hoy = hoyGT();
  const deHoy = filas.filter((e) => new Date(fechaMs(e.piloto_cerro_en) - 6 * 3600_000).toISOString().slice(0, 10) === hoy);
  return { envios: filas.length, entregas: filas.filter((e) => e.estado === 'entregado').length, ganancia, efectivo, transferencias, descuentos, descuentos_detalle: desc, neto,
    frecuencia, frecuencia_texto: FRECUENCIAS[frecuencia].nombre, ultimo_pago: ultimo, dias_desde: dias, le_toca: leToca,
    hoy: { envios: deHoy.length, ganancia: redondear(deHoy.reduce((t, e) => t + (e.ganancia_piloto || 0), 0)), efectivo: redondear(deHoy.reduce((t, e) => t + (e.efectivo || 0), 0)) },
    detalle: filas.map((e) => ({ id: e.id, guia: e.guia, estado: e.estado, destino_zona: e.destino_zona, piloto_cerro_en: e.piloto_cerro_en, metodo_pago: e.metodo_pago,
      ganancia: e.pago_piloto_id ? 0 : (e.ganancia_piloto || 0), efectivo: e.liquidado_id ? 0 : (e.efectivo || 0) })) };
}
ruta('GET', '/api/admin/sueldos', ({ req }) => {
  requiereRol(req, 'admin');
  const pilotos = db.prepare("SELECT id, nombre, telefono, foto_perfil IS NOT NULL AS tiene_foto, veh_placa FROM usuarios WHERE rol = 'mensajero' AND estado_piloto IN ('aprobado','suspendido') ORDER BY nombre").all()
    .map((p) => ({ ...p, ...cuentaPiloto(p.id), deuda: deudaVencida(p.id) }));
  const conCuenta = pilotos.filter((p) => p.envios || p.descuentos);
  return { pilotos: conCuenta, sin_cuenta: pilotos.length - conCuenta.length, total_pagar: redondear(conCuenta.reduce((t, p) => t + Math.max(0, p.neto), 0)),
    total_recibir: redondear(conCuenta.reduce((t, p) => t + Math.max(0, -p.neto), 0)), frecuencias: FRECUENCIAS };
});
ruta('GET', '/api/admin/sueldos/:id', ({ req, params }) => {
  requiereRol(req, 'admin');
  const p = db.prepare("SELECT id, nombre, telefono, veh_placa FROM usuarios WHERE id = ? AND rol = 'mensajero'").get(Number(params.id)) || falla(404, 'No encontramos ese piloto.');
  return { piloto: p, cuenta: cuentaPiloto(p.id), historial: db.prepare('SELECT * FROM cuentas_piloto WHERE piloto_id = ? ORDER BY id DESC LIMIT 30').all(p.id) };
});
// "Ya fue pagado": se cierra la cuenta (efectivo recibido y ganancia pagada) en un solo paso
ruta('POST', '/api/admin/sueldos/:id/pagado', ({ req, params, body }) => {
  const quien = requiereRol(req, 'admin');
  const pid = Number(params.id);
  if (!db.prepare("SELECT 1 FROM usuarios WHERE id = ? AND rol = 'mensajero'").get(pid)) falla(404, 'No encontramos ese piloto.');
  const c = cuentaPiloto(pid);
  if (!c.envios && !c.descuentos) falla(400, 'Este piloto no tiene nada pendiente.');
  if (body.neto !== undefined && redondear(numero(body.neto)) !== c.neto) falla(409, 'La cuenta cambió mientras la veías (entró otro envío). Revísala de nuevo.');
  const nota = texto(body.nota, 300);
  let cuentaId;
  db.exec('BEGIN');
  try {
    let liq = null, pago = null;
    const conEfectivo = db.prepare(`SELECT e.id, ${SQL_EFECTIVO} AS efectivo FROM envios e WHERE e.mensajero_id = ? AND e.piloto_cerro_en IS NOT NULL AND e.liquidado_id IS NULL AND ${SQL_EFECTIVO} > 0`).all(pid);
    if (conEfectivo.length) {
      const esperado = redondear(conEfectivo.reduce((t, x) => t + x.efectivo, 0));
      liq = Number(db.prepare('INSERT INTO liquidaciones (piloto_id, esperado, recibido, envios, nota) VALUES (?, ?, ?, ?, ?)').run(pid, esperado, esperado, conEfectivo.length, 'Cuenta cerrada: ' + (nota || 'pagado')).lastInsertRowid);
      for (const x of conEfectivo) db.prepare('UPDATE envios SET liquidado_id = ? WHERE id = ?').run(liq, x.id);
    }
    const porPagar = db.prepare('SELECT id FROM envios WHERE mensajero_id = ? AND piloto_cerro_en IS NOT NULL AND pago_piloto_id IS NULL').all(pid);
    if (porPagar.length || c.descuentos) {
      pago = Number(db.prepare('INSERT INTO pagos_piloto (piloto_id, monto, envios, nota) VALUES (?, ?, ?, ?)').run(pid, redondear(c.ganancia - c.descuentos), porPagar.length,
        [`Cuenta cerrada. Neto ${c.neto >= 0 ? 'pagado al piloto' : 'entregado por el piloto'}: Q${Math.abs(c.neto).toFixed(2)}`, c.descuentos ? `Descuento por reclamos: Q${c.descuentos.toFixed(2)}` : '', nota].filter(Boolean).join('. ')).lastInsertRowid);
      for (const x of porPagar) db.prepare('UPDATE envios SET pago_piloto_id = ? WHERE id = ?').run(pago, x.id);
      for (const x of c.descuentos_detalle) db.prepare('UPDATE reclamos SET descontado_pago_id = ? WHERE id = ?').run(pago, x.id);
    }
    cuentaId = Number(db.prepare(`INSERT INTO cuentas_piloto (piloto_id, envios, ganancia, descuentos, efectivo, transferencias, neto, liquidacion_id, pago_id, cerrado_por, nota)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(pid, c.envios, c.ganancia, c.descuentos, c.efectivo, c.transferencias, c.neto, liq, pago, quien.nombre.split(' ')[0], nota || null).lastInsertRowid);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  avisar(pid, { titulo: 'Cuenta cerrada', cuerpo: c.neto >= 0 ? `Vaelo te pagó Q${c.neto.toFixed(2)} por ${c.envios} envío(s).` : `Entregaste Q${(-c.neto).toFixed(2)} de efectivo. Cuenta al día.`, url: RUTA_PILOTO + '?pestana=ganancias' });
  return { ok: true, id: cuentaId, neto: c.neto };
});
ruta('PUT', '/api/piloto/frecuencia', ({ req, body }) => {
  const p = requierePiloto(req);
  if (!FRECUENCIAS[body.frecuencia]) falla(400, 'Elige cada día, cada semana o cada quincena.');
  db.prepare('UPDATE usuarios SET frecuencia_pago = ? WHERE id = ?').run(body.frecuencia, p.id);
  return { ok: true };
});

// ---------- Cierre del día (botón) y reportes en Excel ----------
const DIR_REPORTES = path.join(DATA_DIR, 'reportes');
const utcAhora = () => db.prepare("SELECT datetime('now') AS t").get().t;
const diaJornada = (utc) => new Date(fechaMs(utc) - 6 * 3600_000 - 5 * 3600_000).toISOString().slice(0, 10);   // el día empieza a las 5 a. m.
function inicioJornada() {
  return db.prepare('SELECT hasta FROM cierres ORDER BY id DESC LIMIT 1').get()?.hasta
    || db.prepare("SELECT datetime(MIN(creado)) AS t FROM envios").get()?.t || db.prepare("SELECT datetime('now', '-1 day') AS t").get().t;
}
function datosPeriodo(desde, hasta) {
  const rango = (col) => `${col} >= ? AND ${col} < ?`;
  const envios = db.prepare(`${SQL_ENVIO} WHERE (${rango('e.creado')}) OR (${rango('e.piloto_cerro_en')}) ORDER BY e.id`).all(desde, hasta, desde, hasta);
  const hechos = envios.filter((e) => e.piloto_cerro_en && e.piloto_cerro_en >= desde && e.piloto_cerro_en < hasta);
  const ingresos = redondear(hechos.filter((e) => e.estado !== 'cancelado').reduce((t, e) => t + e.precio + (e.cargos_extra || 0), 0));
  const ganancias = redondear(hechos.reduce((t, e) => t + (e.ganancia_piloto || 0), 0));
  // Bono a empresas por esos envíos entregados (sale de lo que gana Vaelo)
  const idsHechos = hechos.filter((e) => e.estado === 'entregado').map((e) => e.id);
  const bonos = idsHechos.length ? redondear(db.prepare(`SELECT COALESCE(SUM(monto), 0) AS t FROM bonos_empresa WHERE envio_id IN (${idsHechos.join(',')})`).get().t) : 0;
  const cuentas = db.prepare(`SELECT c.*, u.nombre FROM cuentas_piloto c JOIN usuarios u ON u.id = c.piloto_id WHERE ${rango('c.creado')} ORDER BY c.id`).all(desde, hasta);
  const liquidaciones = db.prepare(`SELECT l.*, u.nombre FROM liquidaciones l JOIN usuarios u ON u.id = l.piloto_id WHERE ${rango('l.creado')} ORDER BY l.id`).all(desde, hasta);
  const pagos = db.prepare(`SELECT p.*, u.nombre FROM pagos_piloto p JOIN usuarios u ON u.id = p.piloto_id WHERE ${rango('p.creado')} ORDER BY p.id`).all(desde, hasta);
  const porPiloto = {};
  for (const e of hechos) if (e.mensajero_id) {
    const k = e.mensajero_id;
    porPiloto[k] = porPiloto[k] || { nombre: e.mensajero_nombre, entregas: 0, fallidos: 0, ganancia: 0, efectivo: 0, transferencias: 0 };
    if (e.estado === 'entregado') porPiloto[k].entregas++; else porPiloto[k].fallidos++;
    porPiloto[k].ganancia += e.ganancia_piloto || 0;
    if (e.metodo_pago === 'transferencia') porPiloto[k].transferencias += e.precio + (e.cargos_extra || 0);
  }
  for (const e of db.prepare(`SELECT e.mensajero_id, ${SQL_EFECTIVO} AS ef FROM envios e WHERE e.mensajero_id IS NOT NULL AND ${rango('e.piloto_cerro_en')}`).all(desde, hasta)) if (porPiloto[e.mensajero_id]) porPiloto[e.mensajero_id].efectivo += e.ef || 0;
  const empresas = db.prepare(`SELECT COALESCE(u.empresa_nombre, u.nombre) AS empresa, COUNT(*) AS pedidos, SUM(e.estado = 'entregado') AS entregados, SUM(e.estado IN ('fallido','a_sede','en_sede')) AS sede
    FROM envios e JOIN usuarios u ON u.id = e.usuario_id WHERE e.pedido_id IS NOT NULL AND ((${rango('e.creado')}) OR (${rango('e.piloto_cerro_en')})) GROUP BY u.id ORDER BY pedidos DESC`).all(desde, hasta, desde, hasta);
  const resumen = {
    desde, hasta, creados: envios.filter((e) => e.creado >= desde && e.creado < hasta).length, entregados: hechos.filter((e) => e.estado === 'entregado').length,
    no_entregados: hechos.filter((e) => !['entregado', 'cancelado'].includes(e.estado)).length, cancelados: envios.filter((e) => e.estado === 'cancelado' && e.actualizado >= desde && e.actualizado < hasta).length,
    ingresos, ganancias_pilotos: ganancias, bonos_empresas: bonos, vaelo: redondear(ingresos - ganancias - bonos),
    efectivo_recibido: redondear(liquidaciones.reduce((t, l) => t + l.recibido, 0)), pagado_pilotos: redondear(pagos.reduce((t, p) => t + p.monto, 0)),
    transferencias: redondear(hechos.filter((e) => e.metodo_pago === 'transferencia' && e.estado !== 'cancelado').reduce((t, e) => t + e.precio + (e.cargos_extra || 0), 0)),
    cuentas_cerradas: cuentas.length, pedidos_empresa: empresas.reduce((t, x) => t + x.pedidos, 0),
  };
  return { resumen, envios, hechos, cuentas, pilotos: Object.values(porPiloto), empresas };
}
const fechaGT = (utc) => utc ? new Date(fechaMs(utc) - 6 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') : '';
const ESTADO_TEXTO = { pendiente: 'Pendiente', recogido: 'Recogido', en_camino: 'En camino', entregado: 'Entregado', fallido: 'No entregado', devolviendo: 'Devolviendo', devuelto: 'Devuelto', a_sede: 'Va a la sede', en_sede: 'En la sede', reenviado: 'Reenviado', cancelado: 'Cancelado' };
function excelPeriodo(titulo, d) {
  const r = d.resumen;
  const tot = (lista, i) => redondear(lista.reduce((t, f) => t + (Number(f[i]) || 0), 0));
  const filasPil = d.pilotos.map((p) => [p.nombre, p.entregas, p.fallidos, redondear(p.ganancia), redondear(p.efectivo), redondear(p.transferencias), redondear(p.ganancia - p.efectivo)]);
  const filasCuentas = d.cuentas.map((c) => [fechaGT(c.creado), c.nombre, c.envios, c.ganancia, c.descuentos, c.efectivo, c.neto, c.cerrado_por, c.nota || '']);
  return crearExcel([
    { nombre: 'Resumen', titulo, columnas: [{ titulo: 'Concepto', ancho: 36 }, { titulo: 'Valor', ancho: 18, tipo: 'numero' }],
      filas: [['Desde', fechaGT(r.desde)], ['Hasta', fechaGT(r.hasta)], ['Envíos creados', r.creados], ['Entregados', r.entregados], ['No entregados (sede o devolución)', r.no_entregados],
        ['Cancelados', r.cancelados], ['Pedidos de empresas', r.pedidos_empresa], ['Ingresos por envíos (Q)', r.ingresos], ['Ganancia de pilotos (Q)', r.ganancias_pilotos], ['Bono a empresas (Q)', r.bonos_empresas || 0], ['Para Vaelo (Q)', r.vaelo],
        ['Efectivo recibido de pilotos (Q)', r.efectivo_recibido], ['Pagado a pilotos (Q)', r.pagado_pilotos], ['Cobrado por transferencia (Q)', r.transferencias], ['Cuentas de pilotos cerradas', r.cuentas_cerradas]] },
    { nombre: 'Envíos', columnas: [{ titulo: 'Guía', ancho: 14 }, { titulo: 'Creado', ancho: 17 }, { titulo: 'Terminado', ancho: 17 }, { titulo: 'Cliente', ancho: 24 }, { titulo: 'Recibe', ancho: 22 },
      { titulo: 'Zona', ancho: 14 }, { titulo: 'Vehículo', ancho: 10 }, { titulo: 'Piloto', ancho: 20 }, { titulo: 'Estado', ancho: 14 }, { titulo: 'Pago', ancho: 14 },
      { titulo: 'Precio', tipo: 'dinero', ancho: 11 }, { titulo: 'Cargos', tipo: 'dinero', ancho: 10 }, { titulo: 'Gana piloto', tipo: 'dinero', ancho: 12 }],
      filas: d.envios.map((e) => [e.guia, fechaGT(e.creado), fechaGT(e.piloto_cerro_en), e.pedido_id ? `${e.cliente_nombre} (empresa)` : e.cliente_nombre, e.destino_nombre, e.destino_zona, e.vehiculo,
        e.mensajero_nombre || '', ESTADO_TEXTO[e.estado] || e.estado, { efectivo: 'Efectivo', transferencia: 'Transferencia', recibe: 'Paga quien recibe', credito: 'Crédito' }[e.metodo_pago] || e.metodo_pago,
        e.precio, e.cargos_extra || 0, e.ganancia_piloto ?? '']) },
    { nombre: 'Pilotos y sueldos', columnas: [{ titulo: 'Piloto', ancho: 24 }, { titulo: 'Entregas', tipo: 'numero' }, { titulo: 'No entregados', tipo: 'numero' }, { titulo: 'Ganó', tipo: 'dinero' },
      { titulo: 'Efectivo cobrado', tipo: 'dinero' }, { titulo: 'Transferencias', tipo: 'dinero' }, { titulo: 'Neto (+ Vaelo paga / − piloto entrega)', tipo: 'dinero', ancho: 34 }],
      filas: filasPil, total: filasPil.length ? ['Total', tot(filasPil, 1), tot(filasPil, 2), tot(filasPil, 3), tot(filasPil, 4), tot(filasPil, 5), tot(filasPil, 6)] : null },
    { nombre: 'Cuentas cerradas', columnas: [{ titulo: 'Fecha', ancho: 17 }, { titulo: 'Piloto', ancho: 24 }, { titulo: 'Envíos', tipo: 'numero' }, { titulo: 'Ganancia', tipo: 'dinero' },
      { titulo: 'Descuentos', tipo: 'dinero' }, { titulo: 'Efectivo', tipo: 'dinero' }, { titulo: 'Neto', tipo: 'dinero' }, { titulo: 'Cerró', ancho: 12 }, { titulo: 'Nota', ancho: 30 }],
      filas: filasCuentas, total: filasCuentas.length ? ['Total', '', tot(filasCuentas, 2), tot(filasCuentas, 3), tot(filasCuentas, 4), tot(filasCuentas, 5), tot(filasCuentas, 6), '', ''] : null },
    { nombre: 'Empresas', columnas: [{ titulo: 'Empresa', ancho: 30 }, { titulo: 'Pedidos', tipo: 'numero' }, { titulo: 'Entregados', tipo: 'numero' }, { titulo: 'En sede', tipo: 'numero' }],
      filas: d.empresas.map((x) => [x.empresa, x.pedidos, x.entregados || 0, x.sede || 0]) },
  ]);
}
ruta('GET', '/api/admin/cierres', ({ req }) => {
  requiereRol(req, 'admin');
  const desde = inicioJornada(), ahora = utcAhora();
  const d = datosPeriodo(desde, ahora);
  const horas = Math.round((Date.now() - fechaMs(desde)) / 3600_000);
  return { jornada: { desde, horas, dia: diaJornada(ahora), resumen: d.resumen, pendiente_cerrar: horas >= 20 },
    cierres: db.prepare('SELECT id, desde, hasta, dia, resumen, cerrado_por, creado FROM cierres ORDER BY id DESC LIMIT 60').all().map((c) => ({ ...c, resumen: JSON.parse(c.resumen) })) };
});
ruta('POST', '/api/admin/cierres', ({ req, body }) => {
  const quien = requiereRol(req, 'admin');
  const desde = inicioJornada(), hasta = utcAhora();
  if (db.prepare('SELECT 1 FROM cierres LIMIT 1').get() && fechaMs(hasta) - fechaMs(desde) < 60_000) falla(400, 'El día se acaba de cerrar.');
  const dia = diaJornada(hasta);
  const d = datosPeriodo(desde, hasta);
  const buf = excelPeriodo(`Vaelo · cierre del ${fechaLarga(dia)}`, d);
  fs.mkdirSync(DIR_REPORTES, { recursive: true, mode: 0o750 });
  const archivo = `cierre-${dia}-${crypto.randomBytes(4).toString('hex')}.xlsx`;
  fs.writeFileSync(path.join(DIR_REPORTES, archivo), buf, { mode: 0o640 });
  const id = Number(db.prepare('INSERT INTO cierres (desde, hasta, dia, resumen, archivo, cerrado_por) VALUES (?, ?, ?, ?, ?, ?)').run(desde, hasta, dia, JSON.stringify({ ...d.resumen, nota: texto(body.nota, 300) || null }), archivo, quien.nombre.split(' ')[0]).lastInsertRowid);
  const r = d.resumen;
  enviarCorreo(ADMIN_EMAIL, `Cierre del ${fechaLarga(dia)}`, correoVaelo(`Cierre del ${fechaLarga(dia)}`, [`${r.entregados} entregados, ${r.no_entregados} no entregados y ${r.creados} envíos nuevos.`,
    `Ingresos Q${r.ingresos.toFixed(2)}; para Vaelo Q${r.vaelo.toFixed(2)}. Pagado a pilotos Q${r.pagado_pilotos.toFixed(2)}; efectivo recibido Q${r.efectivo_recibido.toFixed(2)}.`,
    'El Excel del día está en el panel, en Reportes > Cierres del día.'], { texto: 'Abrir el panel', url: RUTA_ADMIN }), `Cierre del ${dia}`).catch(() => {});
  return { _status: 201, ok: true, id, dia, resumen: d.resumen };
});
ruta('GET', '/api/admin/cierres/:id/excel', ({ req, res, params }) => {
  requiereRol(req, 'admin');
  const c = db.prepare('SELECT * FROM cierres WHERE id = ?').get(Number(params.id)) || falla(404, 'No encontramos ese cierre.');
  let buf;
  try { buf = fs.readFileSync(path.join(DIR_REPORTES, path.basename(c.archivo || ''))); } catch { buf = excelPeriodo(`Vaelo · cierre del ${fechaLarga(c.dia)}`, datosPeriodo(c.desde, c.hasta)); }
  return enviarExcel(res, buf, `vaelo-cierre-${c.dia}.xlsx`);
});
// Semana, mes o año (siempre al día, calculado al pedirlo)
ruta('GET', '/api/admin/reporte-excel', ({ req, res, query }) => {
  requiereRol(req, 'admin');
  const periodo = ['dia', 'semana', 'mes', 'anio'].includes(query.get('periodo')) ? query.get('periodo') : 'mes';
  const f = /^\d{4}-\d{2}-\d{2}$/.test(query.get('fecha') || '') ? query.get('fecha') : hoyGT();
  let ini = f, fin = sumarDias(f, 1), nombre = `día ${f}`;
  if (periodo === 'semana') { const dow = (new Date(f + 'T12:00:00Z').getUTCDay() + 6) % 7; ini = sumarDias(f, -dow); fin = sumarDias(ini, 7); nombre = `semana del ${ini}`; }
  if (periodo === 'mes') { ini = f.slice(0, 8) + '01'; fin = sumarMeses(ini, 1); nombre = `mes ${f.slice(0, 7)}`; }
  if (periodo === 'anio') { ini = f.slice(0, 4) + '-01-01'; fin = (Number(f.slice(0, 4)) + 1) + '-01-01'; nombre = `año ${f.slice(0, 4)}`; }
  // Días de Guatemala desde las 5 a. m. hasta las 5 a. m. del día siguiente (en hora UTC: +11 horas)
  const aUtc = (dia) => new Date(Date.parse(dia + 'T05:00:00Z') + 6 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  const buf = excelPeriodo(`Vaelo · ${nombre}`, datosPeriodo(aUtc(ini), aUtc(fin)));
  return enviarExcel(res, buf, `vaelo-${periodo}-${ini}.xlsx`);
});

// ---------- Buscador del panel: pilotos, envíos, pedidos, empresas y clientes ----------
ruta('GET', '/api/admin/buscar', ({ req, query }) => {
  const quien = requiereStaff(req);
  const q = (query.get('q') || '').trim().slice(0, 60);
  if (q.length < 2) return { pilotos: [], envios: [], pedidos: [], empresas: [], clientes: [] };
  const like = `%${q}%`, tel = digitos(q), likeTel = tel.length >= 3 ? `%${tel}%` : '%__nada__%';
  const codigo = q.toUpperCase().replace(/\s+/g, '');
  const pilotos = db.prepare(`SELECT u.id, u.nombre, u.telefono, u.veh_placa, u.estado_piloto, u.foto_perfil IS NOT NULL AS tiene_foto, v.nombre AS vehiculo FROM usuarios u LEFT JOIN vehiculos v ON v.id = u.vehiculo_id
    WHERE u.rol = 'mensajero' AND (u.nombre LIKE ? OR REPLACE(u.telefono, '-', '') LIKE ? OR u.veh_placa LIKE ? OR u.dpi LIKE ?) ORDER BY u.estado_piloto = 'aprobado' DESC, u.nombre LIMIT 6`).all(like, likeTel, like, likeTel)
    .map((p) => { if (!esOperador(quien)) { const c = cuentaPiloto(p.id); p.neto = c.neto; p.pendiente = c.envios > 0; } return p; });
  const envios = db.prepare(`SELECT e.id, e.guia, e.estado, e.destino_nombre, e.destino_zona, e.creado, u.nombre AS cliente, u.empresa_nombre, m.nombre AS piloto FROM envios e JOIN usuarios u ON u.id = e.usuario_id
    LEFT JOIN usuarios m ON m.id = e.mensajero_id WHERE e.guia LIKE ? OR e.destino_nombre LIKE ? OR REPLACE(e.destino_telefono, '-', '') LIKE ? ORDER BY e.guia = ? DESC, e.id DESC LIMIT 8`).all(`%${codigo}%`, like, likeTel, codigo);
  const pedidos = db.prepare(`SELECT p.id, p.codigo, p.estado, p.cliente_nombre, p.dia, p.usuario_id, COALESCE(u.empresa_nombre, u.nombre) AS empresa FROM pedidos_empresa p JOIN usuarios u ON u.id = p.usuario_id
    WHERE p.envio_id IS NULL AND p.estado != 'cancelado' AND (p.codigo LIKE ? OR p.cliente_nombre LIKE ? OR REPLACE(p.cliente_telefono, '-', '') LIKE ?) ORDER BY p.id DESC LIMIT 6`).all(`%${codigo}%`, like, likeTel);
  const empresas = db.prepare(`SELECT id, COALESCE(empresa_nombre, nombre) AS nombre, telefono FROM usuarios WHERE tipo_cuenta IN ('empresa','minorista') AND rol = 'cliente' AND (empresa_nombre LIKE ? OR nombre LIKE ?) LIMIT 5`).all(like, like);
  const clientes = db.prepare(`SELECT id, nombre, telefono, email FROM usuarios WHERE rol = 'cliente' AND COALESCE(tipo_cuenta, 'personal') NOT IN ('empresa','minorista') AND (nombre LIKE ? OR email LIKE ? OR REPLACE(telefono, '-', '') LIKE ?) LIMIT 5`).all(like, like, likeTel);
  return { pilotos, envios, pedidos, empresas, clientes };
});

// ---------- Asignación automática al piloto más cercano ----------
// Cada 10 segundos: si un piloto no acepta a tiempo pasa al siguiente; los envíos sin piloto se ofrecen al más cercano libre.
function asignacionAutomatica() {
  const a = getAjustes();
  if (a.auto_asignar !== '1') return;
  const segundos = Math.max(20, Number(a.segundos_aceptar) || 60);
  const excluidos = (e) => { try { return JSON.parse(e.excluidos || '[]'); } catch { return []; } };
  // 1) Se venció el tiempo para aceptar
  for (const e of db.prepare(`SELECT e.*, u.nombre AS piloto FROM envios e JOIN usuarios u ON u.id = e.mensajero_id
      WHERE e.asignacion = 'por_aceptar' AND e.estado = 'pendiente' AND COALESCE(e.asignado_por, '') != 'oficina' AND e.asignado_en < datetime('now', ?)`).all(`-${segundos} seconds`)) {
    db.prepare('UPDATE envios SET mensajero_id = NULL, asignacion = NULL, excluidos = ? WHERE id = ?').run(JSON.stringify([...excluidos(e), e.mensajero_id]), e.id);
    db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, `${e.piloto.split(' ')[0]} no respondió a tiempo. Buscando otro piloto`);
  }
  // 2) Envíos sin piloto (los programados, 30 minutos antes)
  const pendientes = db.prepare(`SELECT * FROM envios WHERE estado = 'pendiente' AND mensajero_id IS NULL AND origen_lat IS NOT NULL
    AND (programado_para IS NULL OR programado_para <= datetime('now', '+30 minutes')) ORDER BY pedido_id IS NULL, COALESCE(programado_para, creado), parada LIMIT 60`).all();
  if (exigeReceptor()) for (let i = pendientes.length - 1; i >= 0; i--) if (!receptorListo(pendientes[i])) pendientes.splice(i, 1);
  // Transferencias sin pago confirmado y paquetes de empresa que todavía no llegan a la sede: no se ofrecen a pilotos
  for (let i = pendientes.length - 1; i >= 0; i--) if (!listoParaPiloto(pendientes[i])) pendientes.splice(i, 1);
  if (!pendientes.length) return;
  const libres = db.prepare(`${SQL_PILOTO} WHERE u.rol = 'mensajero' AND u.estado_piloto = 'aprobado' AND u.activo = 1 AND u.en_linea = 1`).all()
    .filter((p) => enLineaReal(p) && puedeTrabajar(p));
  const yaAsignados = new Set();
  for (const e of pendientes) {
    if (yaAsignados.has(e.id)) continue;
    // Varias entregas en un solo viaje: todo el grupo se ofrece junto al mismo piloto
    const grupo = e.grupo ? pendientes.filter((x) => x.grupo === e.grupo && !yaAsignados.has(x.id)) : [e];
    const fuera = excluidos(e);
    const o = { lat: e.origen_lat, lng: e.origen_lng };
    const delVehiculo = libres.filter((p) => p.vehiculo_id === e.vehiculo_id && !p._ocupado && (grupo.length > 1 ? p.activos === 0 : p.activos < 3));
    const candidatos = delVehiculo.filter((p) => !fuera.includes(p.id))
      .map((p) => ({ p, km: distanciaRecta(o, { lat: p.ubic_lat, lng: p.ubic_lng }) })).sort((x, y) => x.km - y.km || x.p.activos - y.p.activos);
    if (!candidatos.length) {
      // Todos los pilotos libres ya lo dejaron pasar: se vuelve a ofrecer desde el principio y se avisa a la oficina
      if (delVehiculo.length && fuera.length) {
        for (const x of grupo) db.prepare('UPDATE envios SET excluidos = NULL WHERE id = ?').run(x.id);
        db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, 'Ningún piloto disponible aceptó. Se vuelve a ofrecer');
        if (Date.now() - (avisoSinPiloto.get(e.id) || 0) > 15 * 60_000) {
          avisoSinPiloto.set(e.id, Date.now());
          avisarStaff({ titulo: 'Envío sin piloto', cuerpo: `${e.guia}: ningún piloto aceptó. Revísalo en el panel.`, url: RUTA_ADMIN, etiqueta: 'sinpiloto-' + e.id, urgente: true });
        }
      }
      continue;
    }
    const elegido = candidatos[0];
    elegido.p._ocupado = true;   // un envío (o un grupo) nuevo por piloto en cada vuelta
    for (const x of grupo) {
      yaAsignados.add(x.id);
      db.prepare("UPDATE envios SET mensajero_id = ?, asignacion = 'por_aceptar', asignado_en = datetime('now'), actualizado = datetime('now') WHERE id = ?").run(elegido.p.id, x.id);
      db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(x.id, x.estado, `Asignado automáticamente a ${elegido.p.nombre.split(' ')[0]} (a ${elegido.km.toFixed(1)} km)${grupo.length > 1 ? `, junto con ${grupo.length - 1} entrega(s) más` : ''}, esperando que acepte`);
    }
    avisarEnvio(e.id, 'asignado');
  }
}
const avisoSinPiloto = new Map();
if (require.main === module) setInterval(() => { try { asignacionAutomatica(); } catch (err) { console.error('Asignación automática:', err.message); } }, 10_000).unref();

// Administración
ruta('GET', '/api/admin/resumen', ({ req }) => {
  const quien = requiereStaff(req);
  const porEstado = {};
  for (const s of ESTADOS) porEstado[s] = 0;
  for (const r of db.prepare('SELECT estado, COUNT(*) AS n FROM envios GROUP BY estado').all()) porEstado[r.estado] = r.n;
  const hoy = db.prepare("SELECT COUNT(*) AS n FROM envios WHERE date(creado, '-6 hours') = date('now', '-6 hours')").get().n;
  // Ingresos del mes por la fecha en que se hizo el viaje (no por la última vez que se modificó el envío)
  const mes = db.prepare(`SELECT SUM(e.estado = 'entregado') AS n, COALESCE(SUM(e.precio), 0) AS total FROM envios e
    WHERE ${SQL_VIAJE_HECHO} AND strftime('%Y-%m', COALESCE(e.piloto_cerro_en, e.entregado_en, e.actualizado), '-6 hours') = strftime('%Y-%m', 'now', '-6 hours')`).get();
  const sinAsignar = db.prepare("SELECT COUNT(*) AS n FROM envios WHERE mensajero_id IS NULL AND estado = 'pendiente' AND pedido_id IS NULL").get().n;
  const clientes = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'cliente'").get().n;
  return { porEstado, hoy, sinAsignar, entregadosMes: mes.n || 0, ingresosMes: esOperador(quien) ? null : redondear(mes.total), clientes,
    rol: esOperador(quien) ? 'operador' : 'admin', nombre: quien.nombre, permisos: esOperador(quien) ? permisosDe(quien) : Object.keys(AREAS_PANEL) };
});

// Historial (solo administración): qué hizo cada persona del panel
ruta('GET', '/api/admin/historial', ({ req, query }) => {
  requiereRol(req, 'admin');
  const cond = [], args = [];
  const q = (query.get('q') || '').trim();
  if (q) { cond.push('(accion LIKE ? OR detalle LIKE ? OR nombre LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const persona = Number(query.get('persona'));
  if (persona) { cond.push('usuario_id = ?'); args.push(persona); }
  const dia = query.get('dia');
  if (/^\d{4}-\d{2}-\d{2}$/.test(dia || '')) { cond.push("date(creado, '-6 hours') = ?"); args.push(dia); }
  const filas = db.prepare(`SELECT * FROM historial ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`).all(...args);
  const personas = db.prepare('SELECT DISTINCT usuario_id AS id, nombre, rol FROM historial ORDER BY nombre').all();
  return { acciones: filas, personas, ultimo: db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM historial').get().n };
});

// ---------- Envíos atascados: avisos en el panel para que nadie se quede esperando ----------
const LIMITES_ATASCO = { sin_piloto: 15, sin_recoger: 30, en_camino: 60, sin_ubicacion: 30, sin_cerrar: 180 };   // minutos
function enviosAtascados() {
  const ya = "(e.programado_para IS NULL OR e.programado_para <= datetime('now'))";
  const mins = (col) => `CAST((julianday('now') - julianday(${col})) * 1440 AS INTEGER)`;
  const sel = (motivo, desde, cond) => db.prepare(`SELECT e.id, e.guia, e.estado, e.origen_zona, e.destino_zona, u.nombre AS cliente_nombre, m.nombre AS piloto,
      '${motivo}' AS motivo, ${mins(desde)} AS minutos FROM envios e JOIN usuarios u ON u.id = e.usuario_id LEFT JOIN usuarios m ON m.id = e.mensajero_id
      WHERE e.flete = 0 AND ${cond} ORDER BY minutos DESC LIMIT 30`).all();
  const lista = [
    ...sel('sin_piloto', 'COALESCE(e.programado_para, e.creado)', `e.estado = 'pendiente' AND e.mensajero_id IS NULL AND ${ya} AND ${mins('COALESCE(e.programado_para, e.creado)')} >= ${LIMITES_ATASCO.sin_piloto}`),
    ...sel('sin_recoger', 'e.asignado_en', `e.estado = 'pendiente' AND e.mensajero_id IS NOT NULL AND e.asignacion = 'aceptado' AND e.asignado_en IS NOT NULL AND ${ya} AND ${mins('e.asignado_en')} >= ${LIMITES_ATASCO.sin_recoger}`),
    ...sel('en_camino', "(SELECT MIN(v.creado) FROM eventos v WHERE v.envio_id = e.id AND v.estado IN ('recogido','en_camino'))",
      `e.estado IN ('recogido','en_camino') AND ${mins("(SELECT MIN(v.creado) FROM eventos v WHERE v.envio_id = e.id AND v.estado IN ('recogido','en_camino'))")} >= ${LIMITES_ATASCO.en_camino}`),
    ...sel('sin_cerrar', 'e.actualizado', `e.estado IN ('devolviendo','a_sede') AND ${mins('e.actualizado')} >= ${LIMITES_ATASCO.sin_cerrar}`),
    ...sel('sin_ubicacion', 'e.creado', `e.estado IN ('pendiente','recogido','en_camino') AND e.pedido_id IS NULL AND e.receptor_lat IS NULL AND e.destino_lat IS NULL AND ${mins('e.creado')} >= ${LIMITES_ATASCO.sin_ubicacion}`),
  ];
  const textos = { sin_piloto: 'Sin piloto', sin_recoger: 'El piloto no ha recogido', en_camino: 'Mucho tiempo en camino', sin_ubicacion: 'Quien recibe no comparte su ubicación', sin_cerrar: 'Devolución o paso a la sede sin terminar' };
  return lista.map((x) => ({ ...x, motivo_texto: textos[x.motivo] }));
}

// Aviso de pedidos nuevos: el panel pregunta cada pocos segundos si hay envíos con número mayor al último que vio
ruta('GET', '/api/admin/nuevos', ({ req, query }) => {
  const quien = requiereStaff(req);
  const ultimo = db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM envios').get().n;
  const desde = Number(query.get('desde'));
  const ahora = db.prepare("SELECT datetime('now') AS t").get().t;
  const desdeT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(query.get('desde_t') || '') ? query.get('desde_t') : ahora;
  const rechazados = db.prepare(`SELECT e.id, e.guia, e.creado, e.precio, e.origen_zona, e.destino_zona, u.nombre AS cliente_nombre
    FROM envios e JOIN usuarios u ON u.id = e.usuario_id WHERE e.rechazado_en > ? AND e.mensajero_id IS NULL AND e.estado = 'pendiente'`).all(desdeT);
  const atascados = enviosAtascados();
  const quejas = db.prepare("SELECT COUNT(*) AS n FROM reclamos WHERE estado = 'abierto'").get().n;
  // A la administración le llega el aviso de acciones nuevas de los empleados (se ven en Historial)
  const h = Number(query.get('h'));
  const historial = esAdmin(quien) && Number.isInteger(h) && h >= 0
    ? db.prepare("SELECT COUNT(*) AS n, MAX(id) AS ultimo FROM historial WHERE id > ? AND rol = 'operador'").get(h) : null;
  if (!Number.isInteger(desde) || desde < 0 || query.get('desde') === null) return { ultimo, nuevos: [], rechazados, ahora, alertas: alertasAbiertas(), atascados, historial, quejas };
  const nuevos = db.prepare(`SELECT e.id, e.guia, e.creado, e.precio, e.origen_zona, e.destino_zona, v.nombre AS vehiculo, u.nombre AS cliente_nombre
    FROM envios e JOIN vehiculos v ON v.id = e.vehiculo_id JOIN usuarios u ON u.id = e.usuario_id
    WHERE e.id > ? AND e.estado != 'cancelado' ORDER BY e.id DESC LIMIT 50`).all(desde);
  return { ultimo, nuevos, rechazados, ahora, alertas: alertasAbiertas(), atascados, historial, quejas };
});

ruta('GET', '/api/admin/envios', ({ req, query }) => {
  const quien = requiereStaff(req);
  const cond = [], args = [];
  const estado = query.get('estado');
  if (estado === 'sin_asignar') cond.push("e.mensajero_id IS NULL AND e.estado = 'pendiente'");
  else if (estado === 'atencion') cond.push("e.estado IN ('fallido','devolviendo','a_sede','en_sede')");
  else if (estado === 'activos') cond.push("e.estado IN ('pendiente','recogido','en_camino','fallido','devolviendo','a_sede','en_sede')");
  else if (estado && ESTADOS.includes(estado)) { cond.push('e.estado = ?'); args.push(estado); }
  const q = (query.get('q') || '').trim().slice(0, 100);
  // Los pedidos de empresas viven en su pestaña; aquí solo con el filtro "De empresas" o al buscar
  if (estado === 'empresas') cond.push('e.pedido_id IS NOT NULL');
  else if (!q) cond.push('e.pedido_id IS NULL');
  if (q) {
    cond.push('(e.guia LIKE ? OR e.destino_nombre LIKE ? OR u.nombre LIKE ? OR e.destino_telefono LIKE ? OR u.telefono LIKE ? OR e.codigo_corto = ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like, like, q.toUpperCase());
  }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return { envios: db.prepare(`${SQL_ENVIO} ${where} ORDER BY e.id DESC LIMIT 300`).all(...args).map((e) => {
    const out = sinCamposReceptor(envioSalida(e));
    out.receptor_confirmado = !!e.receptor_confirmado_en; out.receptor_listo = receptorListo(e);
    Object.assign(out, infoExtra(e));
    return out;
  }) };
});

ruta('GET', '/api/admin/envios/:id', ({ req, params }) => {
  const quien = requiereStaff(req);
  const e = db.prepare(`${SQL_ENVIO} WHERE e.id = ?`).get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  const cliente = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(e.usuario_id);
  const out = envioSalida(e);
  out.tiene_foto_entrega = !!e.foto_entrega; out.tiene_firma_entrega = !!e.firma_entrega; out.tiene_foto_fallo = !!e.fallo_foto;
  Object.assign(out, infoExtra(e));
  out.cargos = db.prepare('SELECT * FROM cargos WHERE envio_id = ? OR cobrado_envio_id = ? ORDER BY id').all(e.id, e.id);
  out.reclamos = reclamosDe(e.id);
  out.listo_para_piloto = listoParaPiloto(e); out.motivo_no_listo = out.listo_para_piloto ? null : motivoNoListo(e);
  out.flete_enlace = e.flete && !e.flete_configurado_en && e.flete_token ? '/flete/' + e.flete_token : null;
  // Cuánto es del piloto y cuánto de Vaelo (Vaelo se queda con su parte fija de cada envío)
  { const piloto = e.ganancia_piloto ?? e.ganancia_acordada ?? gananciaPiloto(e.precio); const bono = db.prepare('SELECT monto FROM bonos_empresa WHERE envio_id = ?').get(e.id)?.monto || 0;
    out.reparto = { piloto: redondear(piloto), bono: redondear(bono), vaelo: redondear(e.precio - piloto - bono) }; }
  out.receptor = { ...datosReceptor(e, true), enlace: ESTADOS_ACTIVOS.includes(e.estado) ? '/recibe/' + tokenReceptor(e) : null };
  out.origen = { ...datosOrigen(e, true), enlace: e.origen_quien === 'tercero' && e.estado === 'pendiente' && e.origen_token ? '/entrega/' + e.origen_token : null };
  sinCamposReceptor(out);
  if (esOperador(quien)) for (const k of ['ganancia_piloto', 'liquidado_id', 'pago_piloto_id']) delete out[k];
  return { envio: out, eventos: eventosDe(e.id), cliente: cliente ? { ...datosCliente(cliente), ...califCliente(cliente.id) } : null,
    piloto: e.mensajero_id ? pilotoParaCliente(e.mensajero_id) : null };
});

ruta('POST', '/api/admin/envios/:id/estado', ({ req, params, body }) => {
  const quien = requiereStaff(req);
  const estado = texto(body.estado, 20);
  // A mano solo se mueven envíos en curso entre los estados normales. La devolución y la sede tienen sus propios botones,
  // y un envío cerrado o que ya entró a la caja no se puede reabrir (descuadraría la caja y los reportes).
  if (!['pendiente', 'recogido', 'en_camino', 'entregado', 'cancelado'].includes(estado)) falla(400, 'Estado no válido.');
  const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  if (!['pendiente', 'recogido', 'en_camino'].includes(e.estado)) falla(400, 'Este envío ya está cerrado o en devolución; usa los botones de entrega fallida.');
  if (e.liquidado_id || e.pago_piloto_id) falla(400, 'Este envío ya entró en la caja y no se puede cambiar.');
  if (estado === e.estado) falla(400, 'El envío ya está en ese estado.');
  const nota = texto(body.nota, 300);
  if (nota.length < 4) falla(400, 'Escribe por qué se cambia el estado a mano.');
  cambiarEstado(e.id, estado, `${nota} (cambio manual: ${quien.nombre.split(' ')[0]})`);
  return { ok: true };
});

ruta('POST', '/api/admin/envios/:id/asignar', ({ req, params, body }) => {
  const quien = requiereStaff(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  if (!ESTADOS_PILOTO_ACTIVO.includes(e.estado)) falla(400, 'Este envío ya está cerrado o está en la sede.');
  if (e.piloto_cerro_en) falla(400, 'El piloto ya terminó su parte de este envío.');
  if (body.mensajero_id === '' || body.mensajero_id == null) {
    db.prepare('UPDATE envios SET mensajero_id = NULL, asignacion = NULL, asignado_en = NULL, llego_origen = 0, llegando_destino = 0 WHERE id = ?').run(e.id);
    db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, 'Se quitó el piloto asignado');
    return { ok: true };
  }
  const m = pilotoPorId(numero(body.mensajero_id));
  if (!m) falla(400, 'Elige un piloto.');
  if (!puedeTrabajar(m)) falla(400, `${m.nombre} no puede trabajar ahora: ${porQueNoTrabaja(m)}.`);
  if (!listoParaPiloto(e)) falla(400, motivoNoListo(e));
  db.prepare(`UPDATE envios SET mensajero_id = ?, asignacion = 'por_aceptar', asignado_en = datetime('now'), llego_origen = 0, llegando_destino = 0,
    actualizado = datetime('now') WHERE id = ?`).run(m.id, e.id);
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, `Asignado a ${m.nombre.split(' ')[0]}, esperando que acepte`);
  avisarEnvio(e.id, 'asignado');
  return { ok: true, en_linea: enLineaReal(m) };
});

ruta('GET', '/api/admin/tarifas', ({ req }) => {
  requiereRol(req, 'admin');
  return {
    vehiculos: db.prepare('SELECT * FROM vehiculos ORDER BY orden, id').all(),
    zonas: db.prepare('SELECT * FROM zonas_fijas ORDER BY id').all(),
    ajustes: getAjustes(),
  };
});

ruta('PUT', '/api/admin/vehiculos/:id', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const v = db.prepare('SELECT * FROM vehiculos WHERE id = ?').get(Number(params.id));
  if (!v) falla(404, 'No encontramos ese vehículo.');
  const nombre = texto(body.nombre ?? v.nombre, 40), descripcion = texto(body.descripcion ?? v.descripcion, 120);
  const nums = {};
  for (const k of ['peso_max', 'tarifa_zona', 'tarifa_base']) {
    nums[k] = body[k] !== undefined ? numero(body[k]) : v[k];
    if (!(nums[k] >= 0 && nums[k] <= 100000)) falla(400, 'Revisa los números: deben ser cantidades válidas.');
  }
  if (nombre.length < 2) falla(400, 'Escribe el nombre del vehículo.');
  const activo = body.activo !== undefined ? (body.activo ? 1 : 0) : v.activo;
  const soloOficina = body.solo_oficina !== undefined ? (body.solo_oficina ? 1 : 0) : v.solo_oficina;
  db.prepare('UPDATE vehiculos SET nombre=?, descripcion=?, peso_max=?, tarifa_zona=?, tarifa_base=?, precio_km=?, activo=?, solo_oficina=? WHERE id=?')
    .run(nombre, descripcion, nums.peso_max, redondear(nums.tarifa_zona), redondear(nums.tarifa_base), 0, activo, soloOficina, v.id);
  return { ok: true };
});

ruta('POST', '/api/admin/zonas', ({ req, body }) => {
  requiereRol(req, 'admin');
  const nombre = texto(body.nombre, 60);
  if (nombre.length < 2 || nombre === OTRA_ZONA) falla(400, 'Escribe el nombre de la zona, por ejemplo "Zona 10".');
  db.prepare('INSERT INTO zonas_fijas (nombre) VALUES (?)').run(nombre);
  return { _status: 201, ok: true };
});

ruta('PUT', '/api/admin/zonas/:id', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const z = db.prepare('SELECT * FROM zonas_fijas WHERE id = ?').get(Number(params.id));
  if (!z) falla(404, 'No encontramos esa zona.');
  const nombre = body.nombre !== undefined ? texto(body.nombre, 60) : z.nombre;
  if (nombre.length < 2 || nombre === OTRA_ZONA) falla(400, 'Escribe el nombre de la zona.');
  let poligono = z.poligono;
  if (body.poligono !== undefined) {
    // Forma de la zona dibujada en el mapa: lista de puntos [lng, lat] dentro de Guatemala
    if (body.poligono === null || (Array.isArray(body.poligono) && !body.poligono.length)) poligono = null;
    else {
      if (!Array.isArray(body.poligono) || body.poligono.length < 3 || body.poligono.length > 200) falla(400, 'Dibuja la zona con al menos 3 puntos.');
      const pts = body.poligono.map((x) => { const c = Array.isArray(x) && coordenada(x[1], x[0]); if (!c) falla(400, 'Hay un punto de la zona fuera de Guatemala.'); return [Math.round(c.lng * 1e6) / 1e6, Math.round(c.lat * 1e6) / 1e6]; });
      poligono = JSON.stringify(pts);
    }
  }
  db.prepare('UPDATE zonas_fijas SET nombre = ?, activa = ?, poligono = ? WHERE id = ?').run(nombre, body.activa !== undefined ? (body.activa ? 1 : 0) : z.activa, poligono, z.id);
  return { ok: true };
});

// ---------- Traer las formas de las zonas desde OpenStreetMap ----------
// El servidor descarga los límites de las zonas de la Ciudad de Guatemala y de los municipios del departamento,
// arma cada forma con sus tramos, la simplifica (máximo 200 puntos) y llena las zonas que tengan el mismo nombre.
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const CONSULTA_ZONAS = `[out:json][timeout:120];
area(id:3600067992)->.ciudad;
area(id:3600214704)->.depto;
(
  rel(area.ciudad)["boundary"="administrative"]["name"~"^Zona [0-9]+$"];
  rel(area.depto)["boundary"="administrative"]["admin_level"="6"];
);
out geom;`;
async function descargarZonasOsm() {
  if (process.env.VAELO_OVERPASS_ARCHIVO) return JSON.parse(fs.readFileSync(process.env.VAELO_OVERPASS_ARCHIVO, 'utf8')).elements;   // solo para pruebas sin internet
  let ultimoError = null;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(CONSULTA_ZONAS), signal: AbortSignal.timeout(150000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Vaelo-Mensajeria/1.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return (await r.json()).elements || [];
    } catch (e) { ultimoError = e; }
  }
  throw ultimoError || new Error('sin respuesta');
}
// Une los tramos (ways) "outer" de una relación en anillos cerrados y devuelve el más grande, como [[lng, lat], ...]
function anilloDeRelacion(rel) {
  const clave = (p) => p[0].toFixed(7) + ',' + p[1].toFixed(7);
  let tramos = (rel.members || []).filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === '') && Array.isArray(m.geometry) && m.geometry.length > 1)
    .map((m) => m.geometry.map((g) => [g.lon, g.lat]));
  const anillos = [];
  while (tramos.length) {
    let actual = tramos.shift();
    for (let vueltas = 0; vueltas < 5000 && clave(actual[0]) !== clave(actual[actual.length - 1]); vueltas++) {
      const fin = clave(actual[actual.length - 1]), ini = clave(actual[0]);
      const i = tramos.findIndex((t) => [fin, ini].includes(clave(t[0])) || [fin, ini].includes(clave(t[t.length - 1])));
      if (i < 0) break;
      const t = tramos.splice(i, 1)[0];
      if (clave(t[0]) === fin) actual = actual.concat(t.slice(1));
      else if (clave(t[t.length - 1]) === fin) actual = actual.concat(t.slice(0, -1).reverse());
      else if (clave(t[t.length - 1]) === ini) actual = t.slice(0, -1).concat(actual);
      else actual = t.slice(1).reverse().concat(actual);
    }
    if (actual.length >= 4) anillos.push(actual);
  }
  const area = (a) => Math.abs(a.reduce((s, p, i) => { const q = a[(i + 1) % a.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  return anillos.sort((x, y) => area(y) - area(x))[0] || null;
}
// Simplifica una forma cerrada (Douglas-Peucker) hasta que tenga como máximo `max` puntos
function simplificarAnillo(anillo, max = 200) {
  let pts = clave0(anillo);
  function clave0(a) { const b = a.slice(); if (b.length > 1 && b[0][0] === b[b.length - 1][0] && b[0][1] === b[b.length - 1][1]) b.pop(); return b; }
  const dp = (lista, tol) => {
    if (lista.length < 3) return lista;
    const [a, b] = [lista[0], lista[lista.length - 1]];
    let maxD = -1, idx = 0;
    for (let i = 1; i < lista.length - 1; i++) {
      const p = lista[i], dx = b[0] - a[0], dy = b[1] - a[1];
      const d = dx === 0 && dy === 0 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / Math.hypot(dx, dy);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD <= tol) return [a, b];
    return dp(lista.slice(0, idx + 1), tol).slice(0, -1).concat(dp(lista.slice(idx), tol));
  };
  // Se parte en dos mitades para que el primer punto no quede fijo como esquina
  const mitad = Math.floor(pts.length / 2);
  let tol = 0.00001, salida = pts;
  while (salida.length > max && tol < 0.05) {
    salida = dp(pts.slice(0, mitad + 1), tol).slice(0, -1).concat(dp(pts.slice(mitad).concat([pts[0]]), tol).slice(0, -1));
    tol *= 1.6;
  }
  return salida.map(([lng, lat]) => [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]);
}
const normalNombreZona = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
ruta('POST', '/api/admin/zonas/importar', async ({ req, body }) => {
  requiereRol(req, 'admin');
  let elementos;
  try { elementos = await descargarZonasOsm(); }
  catch { falla(502, 'No pudimos conectarnos con el mapa (OpenStreetMap). Intenta de nuevo en unos minutos.'); }
  // Forma de cada nombre: zonas de la capital ("Zona 10") y municipios ("Mixco", "Villa Nueva")
  const formas = new Map();
  for (const e of elementos) {
    if (e.type !== 'relation' || !e.tags?.name) continue;
    const nombre = e.tags.name.trim();
    if (formas.has(normalNombreZona(nombre))) continue;
    const anillo = anilloDeRelacion(e);
    if (anillo) formas.set(normalNombreZona(nombre), { nombre, puntos: simplificarAnillo(anillo), municipio: e.tags.admin_level === '6' });
  }
  const zonas = db.prepare('SELECT * FROM zonas_fijas').all();
  const llenadas = [], sinForma = [], conservadas = [];
  const agregar = Array.isArray(body.agregar) ? body.agregar.map(normalNombreZona) : [];
  db.exec('BEGIN');
  try {
    for (const z of zonas) {
      const f = formas.get(normalNombreZona(z.nombre));
      if (!f) { sinForma.push(z.nombre); continue; }
      if (z.poligono && body.reemplazar !== true) { conservadas.push(z.nombre); continue; }
      db.prepare('UPDATE zonas_fijas SET poligono = ? WHERE id = ?').run(JSON.stringify(f.puntos), z.id); llenadas.push(z.nombre);
    }
    const yaEstan = new Set(zonas.map((z) => normalNombreZona(z.nombre)));
    for (const k of agregar) {
      const f = formas.get(k);
      if (!f || yaEstan.has(k)) continue;
      db.prepare('INSERT INTO zonas_fijas (nombre, poligono) VALUES (?, ?)').run(f.nombre, JSON.stringify(f.puntos)); llenadas.push(f.nombre); yaEstan.add(k);
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  const orden = (a, b) => (parseInt(a.replace(/\D/g, '')) || 999) - (parseInt(b.replace(/\D/g, '')) || 999) || a.localeCompare(b);
  const yaEstan = new Set(db.prepare('SELECT nombre FROM zonas_fijas').all().map((z) => normalNombreZona(z.nombre)));
  const disponibles = [...formas.values()].filter((f) => !yaEstan.has(normalNombreZona(f.nombre)));
  return { ok: true, llenadas, sin_forma: sinForma, conservadas,
    disponibles_zonas: disponibles.filter((f) => !f.municipio).map((f) => f.nombre).sort(orden),
    disponibles_municipios: disponibles.filter((f) => f.municipio).map((f) => f.nombre).sort(orden) };
});

ruta('PUT', '/api/admin/ajustes', ({ req, body }) => {
  requiereRol(req, 'admin');
  const up = db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor');
  if (body.whatsapp !== undefined) up.run('whatsapp', String(body.whatsapp).replace(/\D/g, '').slice(0, 15));
  if (body.horario !== undefined) up.run('horario', texto(String(body.horario), 120));
  if (body.recargo_fragil !== undefined) {
    const n = numero(body.recargo_fragil);
    if (!(n >= 0 && n <= 1000)) falla(400, 'Revisa el recargo por frágil.');
    up.run('recargo_fragil', String(redondear(n)));
  }
  if (body.exigir_receptor !== undefined) up.run('exigir_receptor', body.exigir_receptor === true || body.exigir_receptor === '1' ? '1' : '0');
  if (body.precio_ayudante !== undefined) {
    const pa = numero(body.precio_ayudante);
    if (!(pa >= 0 && pa <= 5000)) falla(400, 'Revisa el precio por ayudante.');
    up.run('precio_ayudante', String(redondear(pa)));
  }
  if (body.bono_empresa !== undefined) {
    const b = numero(body.bono_empresa);
    if (!(b >= 0 && b <= TOPE_BONO)) falla(400, `El bono general para empresas va de Q0 a Q${TOPE_BONO}.`);
    up.run('bono_empresa', String(redondear(b)));
  }
  if (body.tema_navidad !== undefined) up.run('tema_navidad', body.tema_navidad === true || body.tema_navidad === '1' ? '1' : '0');
  if (body.auto_asignar !== undefined) up.run('auto_asignar', body.auto_asignar === true || body.auto_asignar === '1' ? '1' : '0');
  if (body.segundos_aceptar !== undefined) {
    const n = numero(body.segundos_aceptar);
    if (!(Number.isInteger(n) && n >= 20 && n <= 600)) falla(400, 'El tiempo para aceptar debe ser de 20 a 600 segundos.');
    up.run('segundos_aceptar', String(n));
  }
  if (body.comision_tipo !== undefined) up.run('comision_tipo', ['fijo', 'vaelo_fijo'].includes(body.comision_tipo) ? body.comision_tipo : 'porcentaje');
  if (body.comision_valor !== undefined) {
    const n = numero(body.comision_valor);
    if (!(n >= 0 && n <= (body.comision_tipo === 'porcentaje' ? 100 : 1000))) falla(400, 'Revisa lo que gana el piloto por entrega.');
    up.run('comision_valor', String(redondear(n)));
  }
  if (body.mapbox_token !== undefined) {
    const t = String(body.mapbox_token || '').trim();
    if (t && !/^pk\.[A-Za-z0-9._-]{20,}$/.test(t)) falla(400, 'La clave de Mapbox debe ser la pública (empieza con pk.).');
    up.run('mapbox_token', t);
  }
  if (body.whatsapp_pagos !== undefined) up.run('whatsapp_pagos', String(body.whatsapp_pagos).replace(/\D/g, '').slice(0, 15));
  // Montos de cargos, seguro y tarifa fija
  const montos = { dias_liquidar: [1, 60], efectivo_aviso_monto: [0, 100000], hora_cierre_efectivo: [12, 23], dias_saldo_tienda: [1, 60], cargo_bodega_empresa: [0, 1000], min_paquetes_sede: [1, 500], min_pedidos_lote: [1, 500], min_pedidos_minorista: [1, 100], dias_reclamo: [1, 60], cargo_devolucion: [0, 1000], cargo_bodega_dia: [0, 1000], cargo_reentrega: [0, 1000], cargo_cancelacion: [0, 1000], pct_piloto_cancelacion: [0, 100],
    horas_decidir_fallido: [0.25, 48], seguro_pct: [0, 50], seguro_minimo: [0, 1000], responsabilidad_max: [0, 100000], km_max_tarifa_fija: [1, 200] };
  for (const [k, [min, max]] of Object.entries(montos)) {
    if (body[k] === undefined) continue;
    const n = numero(body[k]);
    if (!(n >= min && n <= max)) falla(400, `Revisa el valor de "${k.replace(/_/g, ' ')}" (de ${min} a ${max}).`);
    up.run(k, String(redondear(n)));
  }
  if (body.sede_direccion !== undefined) up.run('sede_direccion', texto(String(body.sede_direccion), 200));
  if (body.sede_lat !== undefined || body.sede_lng !== undefined) {
    const c = coordenada(body.sede_lat, body.sede_lng);
    if ((body.sede_lat || body.sede_lng) && !c) falla(400, 'La ubicación de la sede debe estar en Guatemala.');
    up.run('sede_lat', c ? String(c.lat) : ''); up.run('sede_lng', c ? String(c.lng) : '');
  }
  if (body.datos_transferencia !== undefined) up.run('datos_transferencia', texto(String(body.datos_transferencia), 600));
  if (body.correo_respaldos !== undefined) {
    const c = texto(String(body.correo_respaldos), 150).toLowerCase();
    if (c && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) falla(400, 'Escribe un correo válido para los respaldos.');
    up.run('correo_respaldos', c);
  }
  if (body.vigencia_antecedentes !== undefined) {
    const n = numero(body.vigencia_antecedentes);
    if (!(Number.isInteger(n) && n >= 1 && n <= 24)) falla(400, 'La vigencia de los antecedentes debe ser de 1 a 24 meses.');
    up.run('vigencia_antecedentes', String(n));
  }
  return { ok: true };
});

// ---------- Archivos estáticos ----------
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
};
const PAGINAS = { '/': 'index.html', '/entrar': 'entrar.html', '/registro': 'registro.html', '/mi-cuenta': 'cliente.html', '/tienda': 'cliente.html',
  '/enviar': 'cliente.html', '/rastreo': 'rastreo.html', '/recuperar': 'recuperar.html', '/terminos': 'terminos.html', '/privacidad': 'privacidad.html',
  '/empresas': 'empresas.html', '/tiendas': 'tiendas.html', '/influencers': 'influencers.html', '/politica-pilotos': 'politica-pilotos.html', '/politicas-empresas': 'politicas-empresas.html' };
// Páginas que piden cuenta: si no has iniciado sesión, el servidor te manda a entrar antes de mostrar nada
const PIDEN_CUENTA = { '/enviar': ['cliente', 'admin'], '/mi-cuenta': ['cliente', 'admin'], '/tienda': ['cliente', 'admin'] };

// Cada vez que el servidor arranca (cada actualización) cambia este número; se agrega a comun.js y styles.css en las páginas
// para que los navegadores bajen siempre la versión nueva en vez de usar una copia vieja guardada
const VERSION_ARCHIVOS = Date.now().toString(36);
// Si hay clave de Mapbox (se pone en el panel, Tarifas y ajustes), las páginas con mapa cargan Mapbox; si no, el mapa gratis
const MAPBOX_VERSION = 'v3.8.0';
function conVersion(html) {
  let out = html.replace(/(\/js\/(?:comun|empresa|qr)\.js|\/css\/styles\.css)\?v=[a-z0-9]+/g, `$1?v=${VERSION_ARCHIVOS}`);
  // Tema de Navidad: se activa o desactiva en el panel (Tarifas y ajustes) y aparece en todas las páginas
  if (getAjustes().tema_navidad === '1') {
    out = out.replace(/<html lang="es"(?: class="([^"]*)")?>/, (m, c) => `<html lang="es" class="${c ? c + ' ' : ''}navidad">`)
      .replace('</head>', `  <link rel="stylesheet" href="/css/navidad.css?v=${VERSION_ARCHIVOS}">\n</head>`)
      .replace('</body>', `  <script src="/js/navidad.js?v=${VERSION_ARCHIVOS}" defer></script>\n</body>`);
  }
  const token = getAjustes().mapbox_token || process.env.MAPBOX_TOKEN || '';
  if (token && /^pk\.[A-Za-z0-9._-]+$/.test(token) && out.includes('/vendor/maplibre/maplibre-gl.js')) {
    out = out.replace(/(<link rel="stylesheet" href="\/vendor\/maplibre\/maplibre-gl\.css[^"]*">)/,
      `<link rel="stylesheet" href="https://api.mapbox.com/mapbox-gl-js/${MAPBOX_VERSION}/mapbox-gl.css">\n  $1`);
    out = out.replace(/(<script src="\/vendor\/maplibre\/maplibre-gl\.js[^"]*"><\/script>)/,
      `<script src="https://api.mapbox.com/mapbox-gl-js/${MAPBOX_VERSION}/mapbox-gl.js"></script>\n  <script>window.VAELO_MAPBOX = ${JSON.stringify(token)};</script>\n  $1`);
  }
  return out;
}

function redirigir(res, destino) {
  res.writeHead(302, { Location: destino, 'Cache-Control': 'no-store', ...CABECERAS_SEGURIDAD });
  res.end();
}
function servirPrivado(res, archivo, tipo = 'text/html; charset=utf-8') {
  fs.readFile(path.join(PRIVADO_DIR, archivo), (err, datos) => {
    if (err) { res.writeHead(500); return res.end('Error'); }
    if (tipo.startsWith('text/html')) datos = Buffer.from(conVersion(datos.toString('utf8')));
    res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', ...CABECERAS_SEGURIDAD });
    res.end(datos);
  });
}

function servirEstatico(req, res, pathname) {
  const rel = PAGINAS[pathname] || pathname.replace(/^\/+/, '');
  const archivo = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!archivo.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(archivo, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...CABECERAS_SEGURIDAD });
      return fs.createReadStream(path.join(PUBLIC_DIR, '404.html')).on('error', () => res.end('No encontrado')).pipe(res);
    }
    const ext = path.extname(archivo).toLowerCase();
    // HTML, JS y CSS propios se revisan siempre (así cada actualización se ve de inmediato); imágenes y la librería del mapa se guardan 1 hora
    const sinCache = ext === '.html' || ext === '.webmanifest' || ((ext === '.js' || ext === '.css') && !rel.startsWith('vendor/'));
    res.writeHead(200, {
      'Content-Type': TIPOS[ext] || 'application/octet-stream',
      ...(ext === '.html' ? {} : { 'Content-Length': st.size }),   // en HTML el tamaño cambia al poner la versión
      'Cache-Control': sinCache ? 'no-cache' : 'public, max-age=3600',
      ...CABECERAS_SEGURIDAD,
    });
    if (req.method === 'HEAD') return res.end();
    // /tienda es la misma página de la cuenta, pero se instala como la app "Vaelo Tiendas"
    const paraTiendas = (t) => pathname === '/tienda' ? t.replace('/manifest.webmanifest', '/manifest-tiendas.webmanifest').replace('/img/apple-touch-icon.png', '/img/icono-tiendas-192.png')
      .replace(/<title>[^<]*<\/title>/, '<title>Vaelo Tiendas</title>').replace('<meta name="apple-mobile-web-app-title" content="Vaelo">', '<meta name="apple-mobile-web-app-title" content="Vaelo Tiendas">') : t;
    if (ext === '.html') return fs.readFile(archivo, 'utf8', (e, t) => res.end(e ? '' : conVersion(paraTiendas(t))));
    fs.createReadStream(archivo).pipe(res);
  });
}

// ---------- Servidor ----------
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      // Protección CSRF básica: las peticiones que cambian datos deben venir de nuestra propia página
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origen = req.headers.origin;
        if (origen && new URL(origen).host !== req.headers.host) falla(403, 'Origen no permitido.');
        if (!(req.headers['content-type'] || '').includes('application/json')) falla(415, 'Formato no permitido.');
      }
      for (const r of rutas) {
        if (r.metodo !== req.method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const params = {};
        r.claves.forEach((k, i) => { params[k] = m[i + 1]; });
        const body = req.method === 'GET' ? {} : await leerJson(req, r.limite);
        // Historial: toda acción del personal en el panel queda guardada (quién, qué y cuándo)
        const actor = req.method !== 'GET' && pathname.startsWith('/api/admin/') ? usuarioActual(req) : null;
        const previo = actor ? contextoAccion(r.patron, params) : null;
        const out = (await r.fn({ req, res, params, body, query: url.searchParams })) || {};
        if (actor && (esAdmin(actor) || esOperador(actor))) { try { guardarHistorial(actor, r.patron, params, body, previo); } catch (err) { console.error('Historial:', err.message); } }
        if (out._enviado) return;
        const { _status = 200, _headers = {}, ...data } = out;
        return json(res, _status, data, _headers);
      }
      falla(404, 'Ruta no encontrada.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') falla(405, 'Método no permitido.');
    const limpia = pathname.replace(/\/+$/, '') || '/';
    // Panel de administración: sin sesión de administrador se muestra solo el acceso
    if (limpia === RUTA_ADMIN) { const u = usuarioActual(req); return servirPrivado(res, esAdmin(u) || esOperador(u) ? 'admin.html' : 'acceso.html'); }
    // Modo mensajero: página propia y escondida (entrar, registrarse como piloto y trabajar)
    if (limpia === RUTA_PILOTO) return servirPrivado(res, 'modomensajero.html');
    if (limpia === '/manifest-piloto.webmanifest') return servirPrivado(res, 'manifest-piloto.webmanifest', 'application/manifest+json');
    // Enlace del correo de confirmación
    if (limpia === '/confirmar-correo') {
      const t = url.searchParams.get('t') || '';
      const fila = /^[a-f0-9]{64}$/.test(t) && db.prepare('SELECT * FROM tokens_correo WHERE token = ?').get(t);
      if (!fila || fila.expira < Date.now()) return redirigir(res, '/entrar?correo=vencido');
      db.prepare('UPDATE usuarios SET email_verificado = 1 WHERE id = ?').run(fila.usuario_id);
      db.prepare('DELETE FROM tokens_correo WHERE usuario_id = ?').run(fila.usuario_id);
      return redirigir(res, usuarioActual(req) ? '/mi-cuenta?correo=confirmado' : '/entrar?correo=confirmado');
    }
    // Página para quien recibe: /recibe/<clave>
    if (/^\/(recibe|entrega)\/[a-f0-9]{32}$/.test(limpia)) return servirEstatico(req, res, '/recibe.html');
    if (/^\/flete\/[a-f0-9]{32}$/.test(limpia)) return servirEstatico(req, res, '/flete.html');
    if (/^\/pedido\/[a-f0-9]{32}$/.test(limpia)) return servirEstatico(req, res, '/pedido.html');
    if (/^\/punto\/[a-f0-9]{32}$/.test(limpia)) return servirEstatico(req, res, '/punto.html');
    if (PIDEN_CUENTA[limpia] && usuarioActual(req)?.rol === 'mensajero') return redirigir(res, RUTA_PILOTO);
    if (PIDEN_CUENTA[limpia]) {
      const u = usuarioActual(req);
      if (!u) return redirigir(res, "/entrar?volver=" + encodeURIComponent(limpia));
      if (!PIDEN_CUENTA[limpia].includes(u.rol)) return redirigir(res, '/mi-cuenta');
    }
    servirEstatico(req, res, pathname);
  } catch (err) {
    if (err instanceof ErrorHttp) return json(res, err.status, { error: err.message });
    console.error(new Date().toISOString(), req.method, pathname, err);
    let quien = ''; try { const u = usuarioActual(req); if (u) quien = `${u.nombre || ''} (${u.email || u.rol || ''})`; } catch { /* sin sesión */ }
    avisarError('página o sistema', err, { ruta: `${req.method} ${pathname}`, 'Usuario': quien });
    json(res, 500, { error: 'Ocurrió un error en el servidor. Inténtalo de nuevo en un momento.' });
  }
});

if (require.main === module) {
  servidor.listen(PORT, HOST, () => console.log(`Vaelo funcionando en http://${HOST}:${PORT}`));
}
module.exports = { recordarEfectivo, efectivoEnMano, servidor, hashPassword, asignacionAutomatica, decisionesVencidas, push, enviosAtascados, ordenarParadas, estimarLlegadas, avisarVencimientos };
