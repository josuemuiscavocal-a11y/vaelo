// Servidor de Vaelo Mensajería (Guatemala)
// Funciona solo con Node.js 22 (sin paquetes extra). Inicia con: node server.js
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR } = require('./db');
const { crearPush } = require('./push');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PRIVADO_DIR = path.join(__dirname, 'privado');   // páginas que solo se entregan con permiso (panel de administración)
const SESION_DIAS = 30;
const SESION_ADMIN_HORAS = 12;                         // la sesión del administrador vence más rápido
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
const METODOS_PAGO = ['efectivo', 'transferencia', 'credito'];
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
    if (!db.prepare('SELECT 1 FROM envios WHERE guia = ?').get(guia)) return guia;
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
const zonaDePunto = (p) => zonasConForma().find((z) => dentroDe(p, z.puntos))?.nombre || null;
const kmMaxFija = () => Number(getAjustes().km_max_tarifa_fija) || 15;
// ¿Se puede cobrar tarifa fija? (null en un punto = todavía no se conoce)
function aplicaTarifaFija(oz, dz, origen, destino, km) {
  if (oz === OTRA_ZONA || dz === OTRA_ZONA) return false;
  const formas = zonasConForma();
  if (formas.length) {
    for (const p of [origen, destino]) if (p && !formas.some((z) => dentroDe(p, z.puntos))) return false;
    return true;
  }
  return km == null || km <= kmMaxFija();
}

// Calcula el precio: tarifa fija si recogida y entrega están en zonas cubiertas; si no, por kilómetro
async function cotizar(body) {
  const vehiculo = db.prepare('SELECT * FROM vehiculos WHERE id = ? AND activo = 1').get(numero(body.vehiculo_id));
  if (!vehiculo) falla(400, 'Elige el vehículo para tu envío.');
  const peso = numero(body.peso);
  if (!(peso > 0)) falla(400, 'Escribe el peso aproximado del paquete en libras.');
  if (peso > vehiculo.peso_max) falla(400, `Ese peso supera lo que lleva una ${vehiculo.nombre.toLowerCase()} (máximo ${vehiculo.peso_max} lb). Elige otro vehículo.`);
  const nombresZonas = zonasFijas().map((z) => z.nombre);
  const oz = texto(body.origen_zona, 60), dz = texto(body.destino_zona, 60);
  for (const z of [oz, dz]) if (z !== OTRA_ZONA && !nombresZonas.includes(z)) falla(400, 'Elige la zona de recogida y la de entrega.');
  const origen = coordenada(body.origen_lat, body.origen_lng);
  const destino = coordenada(body.destino_lat, body.destino_lng);
  const km = origen && destino ? (await kilometros(origen, destino)) : null;

  if (aplicaTarifaFija(oz, dz, origen, destino, km ? km.km : null)) {
    return conExtras({ tipo: 'zona', km: km ? km.km : null, precio: redondear(vehiculo.tarifa_zona), vehiculo, peso,
      detalle: `Tarifa fija en zonas cubiertas (${vehiculo.nombre})` }, body);
  }
  // Todavía no se conocen las dos ubicaciones en vivo: se muestra la tarifa mínima y el precio final se calcula después
  if (!km) {
    return conExtras({ tipo: 'km', km: null, por_confirmar: true, precio: redondear(Math.max(vehiculo.tarifa_zona, vehiculo.tarifa_base)), vehiculo, peso,
      detalle: `Precio desde. Fuera de las zonas fijas se cobra Q${vehiculo.tarifa_base.toFixed(2)} + Q${vehiculo.precio_km.toFixed(2)} por km; el total se calcula cuando quien entrega y quien recibe compartan su ubicación` }, body);
  }
  const precio = redondear(Math.max(vehiculo.tarifa_zona, vehiculo.tarifa_base + km.km * vehiculo.precio_km));
  return conExtras({ tipo: 'km', km: km.km, precio, vehiculo, peso, fuente: km.fuente,
    detalle: `Q${vehiculo.tarifa_base.toFixed(2)} + ${km.km} km × Q${vehiculo.precio_km.toFixed(2)}${km.fuente === 'estimado' ? ' (distancia aproximada)' : ''}` }, body);
}
// Paquete frágil (recargo de Tarifas y ajustes) y seguro opcional según el valor declarado
function conExtras(c, body) {
  const aj = getAjustes();
  const fragil = body.fragil === true || body.fragil === 'si' || body.fragil === 1;
  const recargo = fragil ? redondear(Number(aj.recargo_fragil) || 0) : 0;
  const valor = body.valor_declarado === '' || body.valor_declarado == null ? 0 : numero(body.valor_declarado);
  if (!Number.isFinite(valor) || valor < 0 || valor > 100000) falla(400, 'Revisa el valor declarado del paquete.');
  const asegurar = (body.asegurar === true || body.asegurar === 'si' || body.asegurar === 1) && valor > 0;
  const seguro = asegurar ? redondear(Math.max(Number(aj.seguro_minimo) || 0, (valor * (Number(aj.seguro_pct) || 0)) / 100)) : 0;
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
const cookieSesion = (req, token, maxAge) => `vaelo_sesion=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${esHttps(req) ? '; Secure' : ''}`;
// La IP real la pone Nginx en X-Real-IP (con Cloudflare, Nginx la toma de CF-Connecting-IP solo si la petición viene de Cloudflare).
// No se lee CF-Connecting-IP directo porque cualquiera puede inventarla si entra sin pasar por Cloudflare.
const ipDe = (req) => {
  const directa = req.socket.remoteAddress || '';
  const local = directa === '127.0.0.1' || directa === '::1' || directa === '::ffff:127.0.0.1';
  return (local && req.headers['x-real-ip']) || directa;
};

function usuarioActual(req) {
  const token = leerCookies(req).vaelo_sesion;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return db.prepare(`
    SELECT u.id, u.nombre, u.email, u.telefono, u.rol, u.vehiculo_id, u.estado_piloto, u.email_verificado, u.verificacion FROM sesiones s
    JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token = ? AND s.expira > ? AND u.activo = 1`).get(token, Date.now()) || null;
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
function requiereStaff(req) {
  const u = requiereUsuario(req);
  if (!esAdmin(u) && !esOperador(u)) falla(403, 'No tienes permiso para esta sección.');
  return u;
}
function crearSesion(req, usuarioId, maxAge = SESION_DIAS * 86400) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sesiones (token, usuario_id, expira) VALUES (?, ?, ?)').run(token, usuarioId, Date.now() + maxAge * 1000);
  return cookieSesion(req, token, maxAge);
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
    let gana = antes.ganancia_piloto ?? gananciaPiloto(antes.precio);
    if (estado === 'devuelto') gana = redondear(gana + gananciaPiloto(Number(getAjustes().cargo_devolucion) || 0));
    db.prepare("UPDATE envios SET piloto_cerro_en = datetime('now'), ganancia_piloto = ? WHERE id = ?").run(gana, envioId);
  }
  // Cancelado: los cargos pendientes que iban a cobrarse con este envío vuelven a quedar pendientes
  if (estado === 'cancelado') liberarCargos(envioId);
  db.prepare('INSERT INTO eventos (envio_id, estado, nota, lat, lng) VALUES (?, ?, ?, ?, ?)')
    .run(envioId, estado, nota, c ? c.lat : null, c ? c.lng : null);
  if (antes.estado !== estado) avisarEnvio(envioId, estado);
}

// ---------- Rutas de la API ----------
const rutas = [];
function ruta(metodo, patron, fn, opciones = {}) {
  const claves = [];
  const re = new RegExp('^' + patron.replace(/:(\w+)/g, (_, k) => { claves.push(k); return '([^/]+)'; }) + '$');
  rutas.push({ metodo, re, claves, fn, limite: opciones.limite });
}

// Público
ruta('GET', '/api/config', () => {
  const aj = getAjustes();
  return {
    vehiculos: db.prepare('SELECT id, nombre, descripcion, peso_max, tarifa_zona, tarifa_base, precio_km FROM vehiculos WHERE activo = 1 ORDER BY orden, id').all(),
    zonas: zonasFijas().map((z) => z.nombre),
    otraZona: OTRA_ZONA,
    whatsapp: aj.whatsapp || '',
    horario: aj.horario || '',
    recargo_fragil: Number(aj.recargo_fragil) || 0,
    promocion: promocionAnunciada(),
    seguro: { pct: Number(aj.seguro_pct) || 0, minimo: Number(aj.seguro_minimo) || 0, responsabilidad_max: Number(aj.responsabilidad_max) || 0 },
    datos_transferencia: aj.datos_transferencia || '',
    cargos: { devolucion: Number(aj.cargo_devolucion) || 0, bodega_dia: Number(aj.cargo_bodega_dia) || 0, reentrega: Number(aj.cargo_reentrega) || 0,
      cancelacion: Number(aj.cargo_cancelacion) || 0, horas_decidir: Number(aj.horas_decidir_fallido) || 2 },
  };
});

ruta('POST', '/api/cotizar', async ({ req, body }) => {
  const c = await cotizar(body);
  const u = usuarioActual(req);
  const desc = mejorDescuento(c.precio, u ? u.id : null, body.cupon);
  const pendientes = u ? redondear(cargosPendientes(u.id).reduce((t, x) => t + x.monto, 0)) : 0;
  return { tipo: c.tipo, km: c.km, precio_base: c.precio, precio: desc.precio, descuento: desc.descuento, promocion: desc.promocion,
    error_cupon: desc.errorCupon, detalle: c.detalle, recargo_fragil: c.recargo_fragil, seguro: c.seguro, cargos_pendientes: pendientes,
    por_confirmar: !!c.por_confirmar };
});

// Datos de entrega fallida, sede, cargos y pago que ven el cliente y el panel
const CAMPOS_INTERNOS = ['foto_entrega', 'firma_entrega', 'liquidado_id', 'pago_piloto_id', 'ganancia_piloto', 'excluidos', 'intentos_codigo', 'fallo_foto', 'comprobante',
  'calif_cliente', 'calif_cliente_comentario', 'precio_o_lat', 'precio_o_lng', 'precio_d_lat', 'precio_d_lng'];
function infoExtra(e) {
  const aj = getAjustes();
  const out = { tiene_comprobante: !!e.comprobante };
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
  if (body.acepto_terminos !== true) falla(400, 'Para crear tu cuenta acepta los términos y el aviso de privacidad.');
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) falla(409, 'Ya existe una cuenta con ese correo. Inicia sesión.');
  const r = db.prepare("INSERT INTO usuarios (nombre, email, telefono, password_hash, email_verificado, terminos_aceptados) VALUES (?, ?, ?, ?, 0, datetime('now'))")
    .run(nombre, email, telefono, hashPassword(password));
  const id = Number(r.lastInsertRowid);
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
  return { _headers: { 'Set-Cookie': crearSesion(req, u.id) }, ok: true, rol: u.rol };
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
  db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(u.id);   // cierra cualquier otra sesión abierta
  return { _headers: { 'Set-Cookie': crearSesion(req, u.id, SESION_ADMIN_HORAS * 3600) }, ok: true };
});

ruta('POST', '/api/logout', ({ req }) => {
  const token = leerCookies(req).vaelo_sesion;
  if (token) db.prepare('DELETE FROM sesiones WHERE token = ?').run(token);
  return { _headers: { 'Set-Cookie': cookieSesion(req, '', 0) }, ok: true };
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
  db.prepare('DELETE FROM sesiones WHERE usuario_id = ? AND token != ?').run(u.id, leerCookies(req).vaelo_sesion || '');
  return { ok: true };
});

// Cliente: envíos
ruta('GET', '/api/envios', ({ req }) => {
  const u = requiereUsuario(req);
  return { envios: db.prepare(`${SQL_ENVIO} WHERE e.usuario_id = ? ORDER BY e.id DESC LIMIT 200`).all(u.id).map((e) => {
    const out = sinCamposReceptor(envioSalida(e));
    out.receptor_confirmado = !!e.receptor_confirmado_en; out.receptor_listo = receptorListo(e);
    out.destino_lat = null; out.destino_lng = null;   // quien envía no ve dónde está quien recibe
    Object.assign(out, infoExtra(e));
    for (const k of CAMPOS_INTERNOS) delete out[k];
    return out;
  }), datos_transferencia: getAjustes().datos_transferencia || '' };
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
  return { envio: out, eventos: eventosDe(e.id), piloto: aceptado ? pilotoParaCliente(e.mensajero_id) : null, datos_transferencia: getAjustes().datos_transferencia || '' };
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
const enLineaReal = (u) => !!u.en_linea && !!u.ubic_fecha && Date.now() - fechaMs(u.ubic_fecha) < MIN_UBIC_VIVA * 60_000;
const puedeTrabajar = (u, r = revisarPiloto(u)) => u.rol === 'mensajero' && u.estado_piloto === 'aprobado' && !!u.activo && !r.vencidos.length;
const SQL_PILOTO = `SELECT u.*, v.nombre AS vehiculo,
    (SELECT ROUND(AVG(calificacion), 1) FROM envios WHERE mensajero_id = u.id AND calificacion IS NOT NULL) AS calificacion,
    (SELECT COUNT(*) FROM envios WHERE mensajero_id = u.id AND calificacion IS NOT NULL) AS calificaciones,
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
  return { ...out, equipo, docs: docsDe(u), revision: r, puede_trabajar: puedeTrabajar(u, r), en_linea_real: enLineaReal(u) };
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
  db.prepare('DELETE FROM tokens_correo WHERE usuario_id = ?').run(usuario.id);
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
    tipo_cuenta: u.tipo_cuenta, empresa_nombre: u.empresa_nombre, descuento_empresa: u.descuento_empresa, credito_permitido: !!u.credito_permitido };
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
function automatizarEnvios(pilotoId, c) {
  const envios = db.prepare("SELECT * FROM envios WHERE mensajero_id = ? AND asignacion = 'aceptado' AND estado IN ('pendiente','recogido','en_camino')").all(pilotoId);
  for (const e of envios) {
    const o = e.origen_lat != null ? { lat: e.origen_lat, lng: e.origen_lng } : null;
    const d = e.destino_lat != null ? { lat: e.destino_lat, lng: e.destino_lng } : null;
    let estado = e.estado;
    if (estado === 'pendiente' && o) {
      const km = distanciaRecta(c, o);
      if (!e.llego_origen && km <= 0.12) {
        db.prepare('UPDATE envios SET llego_origen = 1 WHERE id = ?').run(e.id);
        db.prepare('INSERT INTO eventos (envio_id, estado, nota, lat, lng) VALUES (?, ?, ?, ?, ?)').run(e.id, 'pendiente', 'El piloto llegó al punto de recogida', c.lat, c.lng);
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
  if (body.acepto_reglas === true && !p.reglas_aceptadas) datos.reglas_aceptadas = new Date().toISOString().slice(0, 19).replace('T', ' ');
  guardarCampos(p.id, datos);
  return { ok: true, piloto: pilotoSalida(pilotoPorId(p.id)) };
});

ruta('POST', '/api/piloto/documento', ({ req, body }) => {
  const p = requierePiloto(req);
  const d = DOCUMENTOS[body.tipo];
  if (!d) falla(400, 'Tipo de documento no válido.');
  if (p.estado_piloto !== 'en_revision' && !d.renovable) falla(403, 'Este documento solo lo puede cambiar la administración de Vaelo.');
  guardarDocumento(p.id, body.tipo, body.archivo);
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
  db.prepare('UPDATE usuarios SET en_linea = 0 WHERE id = ?').run(p.id);
  return { ok: true, en_linea: false };
});

ruta('POST', '/api/piloto/ubicacion', ({ req, body }) => {
  const p = requierePiloto(req);
  const c = leerPosicion(body, true);
  registrarUbicacion(p, c, numero(body.precision));
  return { ok: true };
});

ruta('GET', '/api/piloto/envios', ({ req }) => {
  const p = requierePiloto(req);
  const filas = db.prepare(`${SQL_ENVIO} WHERE e.mensajero_id = ?
    AND (e.estado IN ${SQL_PILOTO_ACTIVO} OR (e.piloto_cerro_en IS NOT NULL AND e.piloto_cerro_en >= datetime('now','-1 day')))
    ORDER BY CASE WHEN e.asignacion = 'por_aceptar' THEN 0 WHEN e.estado IN ('fallido','devolviendo','a_sede') THEN 1 WHEN e.estado = 'en_camino' THEN 2 WHEN e.estado = 'recogido' THEN 3 WHEN e.estado = 'pendiente' THEN 4 ELSE 5 END, e.id`).all(p.id);
  return { envios: filas.map((e) => {
    const out = envioSalida(e);
    const extra = infoExtra(e);
    if (extra.fallo) out.fallo = extra.fallo;
    if (e.estado === 'a_sede') { const sede = sedeUbicacion(); out.sede = { lat: sede?.lat ?? null, lng: sede?.lng ?? null, direccion: getAjustes().sede_direccion || '' }; }
    out.ya_califique_cliente = !!e.calif_cliente;
    for (const k of ['codigo_entrega', 'intentos_codigo', 'foto_entrega', 'firma_entrega', 'precio_base', 'descuento', 'promocion_id', 'liquidado_id', 'pago_piloto_id', 'excluidos', ...CAMPOS_INTERNOS]) delete out[k];
    out.ganancia_piloto = e.ganancia_piloto;
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
ruta('GET', '/api/piloto/ganancias', ({ req }) => {
  const p = requierePiloto(req);
  const suma = (cond) => redondear(db.prepare(`SELECT COALESCE(SUM(e.ganancia_piloto), 0) AS t FROM envios e WHERE e.mensajero_id = ? AND e.piloto_cerro_en IS NOT NULL AND ${cond}`).get(p.id).t);
  const efectivo = db.prepare(`SELECT COALESCE(SUM(${SQL_EFECTIVO}), 0) AS t, COUNT(*) AS n FROM envios e WHERE e.mensajero_id = ? AND e.piloto_cerro_en IS NOT NULL AND e.liquidado_id IS NULL AND ${SQL_EFECTIVO} > 0`).get(p.id);
  const hoy = hoyGT();
  return {
    por_cobrar: suma('e.pago_piloto_id IS NULL'),
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
  };
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
  return { mensajeros: filas.map(pilotoSalida), estados: ESTADOS_PILOTO };
});

ruta('GET', '/api/admin/mensajeros/:id', ({ req, params }) => {
  requiereRol(req, 'admin');
  const p = pilotoPorId(Number(params.id));
  if (!p) falla(404, 'No encontramos ese piloto.');
  const ultimos = db.prepare(`SELECT id, guia, estado, creado, calificacion, calificacion_comentario FROM envios WHERE mensajero_id = ? ORDER BY id DESC LIMIT 10`).all(p.id);
  return { piloto: pilotoSalida(p), envios: ultimos, estados: ESTADOS_PILOTO, equipo: EQUIPO, documentos: Object.fromEntries(Object.entries(DOCUMENTOS).map(([k, d]) => [k, d.nombre])),
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
      activos: p.activos, envio: activo || null };
  }) };
});

// Pilotos ordenados por cercanía al punto de recogida de un envío
ruta('GET', '/api/admin/envios/:id/cercanos', ({ req, params }) => {
  const quien = requiereStaff(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  const o = e.origen_lat != null ? { lat: e.origen_lat, lng: e.origen_lng } : null;
  const lista = db.prepare(`${SQL_PILOTO} WHERE u.rol = 'mensajero' AND u.estado_piloto = 'aprobado' AND u.activo = 1`).all()
    .filter((p) => puedeTrabajar(p))
    .map((p) => ({ id: p.id, nombre: p.nombre, vehiculo: p.vehiculo, vehiculo_id: p.vehiculo_id, placa: p.veh_placa, activos: p.activos,
      calificacion: p.calificacion, en_linea: enLineaReal(p),
      km: o && p.ubic_lat != null && enLineaReal(p) ? Math.round(distanciaRecta(o, { lat: p.ubic_lat, lng: p.ubic_lng }) * 10) / 10 : null }));
  lista.sort((a, b) => (b.en_linea - a.en_linea) || ((a.km ?? 9999) - (b.km ?? 9999)) || (a.activos - b.activos));
  return { pilotos: lista, con_ubicacion: !!o };
});

ruta('GET', '/api/admin/envios/:id/recorrido', ({ req, params }) => {
  const quien = requiereStaff(req);
  return { puntos: db.prepare('SELECT lat, lng, creado FROM ubicaciones WHERE envio_id = ? ORDER BY id').all(Number(params.id)) };
});

// ---------- Administración: clientes ----------
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
const ARCHIVOS_ENTREGA = { foto: 'foto_entrega', firma: 'firma_entrega', receptor: 'receptor_foto', origen: 'origen_foto', fallo: 'fallo_foto', comprobante: 'comprobante' };
const FALTA_ARCHIVO = { foto: 'Toma la foto del paquete.', firma: 'La firma no es válida.', receptor: 'La foto no es válida. Elige otra.', origen: 'La foto no es válida. Elige otra.', fallo: 'La foto no es válida.', comprobante: 'Sube una foto o PDF del comprobante.' };
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
const gananciaPiloto = (precio) => {
  const a = getAjustes(), v = Number(a.comision_valor) || 0;
  return redondear(a.comision_tipo === 'fijo' ? v : (precio * v) / 100);
};

// ---------- Descuentos y promociones ----------
const promocionesVigentes = () => { const hoy = hoyGT(); return db.prepare('SELECT * FROM promociones WHERE activa = 1 AND desde <= ? AND hasta >= ? ORDER BY id').all(hoy, hoy); };
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
  for (const p of promocionesVigentes()) {
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
  const errorCupon = codigo && !cuponValido ? (motivoCupon ? `Ese cupón ${motivoCupon}.` : 'Ese cupón no existe o ya venció.') : '';
  return { descuento: mejor ? mejor.monto : 0, promocion_id: mejor ? mejor.id : null, promocion: mejor ? mejor.nombre : '', precio: redondear(precio - (mejor ? mejor.monto : 0)), errorCupon };
}
// Promoción automática que se anuncia en la página (la de mayor beneficio entre las que no piden código)
function promocionAnunciada() {
  const p = promocionesVigentes().filter((x) => !x.codigo && !x.solo_primer_envio)
    .sort((a, b) => (b.tipo === 'gratis') - (a.tipo === 'gratis') || b.valor - a.valor)[0];
  return p ? { nombre: p.nombre, tipo: p.tipo, valor: p.valor, hasta: p.hasta } : null;
}

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
  d.origen_quien = body.origen_quien === 'tercero' ? 'tercero' : 'cliente';
  d.origen_nombre = d.origen_quien === 'tercero' ? texto(body.origen_nombre, 100) : null;
  if (d.origen_quien === 'tercero' && d.origen_nombre.length < 2) falla(400, 'Escribe el nombre de quien entrega el paquete al piloto.');
  if (d.origen_telefono.replace(/\D/g, '').length < 8) falla(400, d.origen_quien === 'tercero' ? 'Escribe el teléfono de quien entrega el paquete (8 dígitos).' : 'Escribe un teléfono de contacto para la recogida.');
  if (d.destino_nombre.length < 2) falla(400, 'Escribe el nombre de quien recibe.');
  if (d.destino_telefono.replace(/\D/g, '').length < 8) falla(400, 'Escribe el teléfono de quien recibe (8 dígitos).');
  if (!METODOS_PAGO.includes(d.metodo_pago)) falla(400, 'Elige cómo vas a pagar el envío.');
  if (d.metodo_pago === 'credito' && !db.prepare('SELECT credito_permitido FROM usuarios WHERE id = ?').get(u.id)?.credito_permitido) falla(400, 'Tu cuenta no tiene pago a fin de mes. Elige efectivo o transferencia.');
  if (!Number.isFinite(d.cobro_destinatario) || d.cobro_destinatario < 0 || d.cobro_destinatario > 50000) falla(400, 'El monto a cobrar a quien recibe no es válido.');
  return d;
}
function insertarEnvio(u, body, d, c, desc, programado, grupo = null) {
  // La recogida es donde está quien pide (su ubicación al enviar) o, si entrega otra persona, donde ella comparta la suya.
  // La entrega es donde comparta su ubicación quien recibe: al crear el envío todavía no hay punto.
  const o = d.origen_quien === 'cliente' ? coordenada(body.origen_lat, body.origen_lng) : null, de = null;
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
     valor_declarado, seguro, grupo, precio_o_lat, precio_o_lng, pago_estado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${o ? "datetime('now')" : 'NULL'}, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    guia, u.id, c.vehiculo.id, c.peso, d.descripcion, d.origen_direccion, texto(body.origen_zona, 60), d.origen_telefono,
    o ? o.lat : null, o ? o.lng : null, d.destino_nombre, d.destino_telefono, d.destino_direccion, texto(body.destino_zona, 60),
    de ? de.lat : null, de ? de.lng : null, c.tipo, c.km, desc.precio, d.metodo_pago, redondear(d.cobro_destinatario), d.notas,
    c.fragil ? 1 : 0, c.recargo_fragil, c.precio, desc.descuento, desc.promocion_id, codigo, programado, token,
    d.origen_quien, d.origen_nombre, tokenEntrega, o ? (Number.isFinite(numero(body.origen_precision)) ? Math.round(numero(body.origen_precision)) : null) : null, c.por_confirmar ? 1 : 0,
    c.valor_declarado || 0, c.seguro || 0, grupo, o ? o.lat : null, o ? o.lng : null, d.metodo_pago === 'transferencia' ? 'sin_comprobante' : null);
  const id = Number(r.lastInsertRowid);
  // Los cargos pendientes del cliente (cancelación, devolución, sede) se cobran junto con este envío
  const extra = sumarCargosPendientes(u.id, id);
  const nota = programado ? 'Solicitud recibida (programada)' : 'Solicitud recibida';
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(id, 'pendiente', nota + (desc.promocion ? `. Descuento: ${desc.promocion}` : ''));
  return { id, guia, precio: desc.precio, descuento: desc.descuento, cargos_extra: extra, codigo_entrega: codigo, enlace_receptor: '/recibe/' + token,
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
  const u = requiereUsuario(req);
  revisarClienteParaEnviar(u);
  const d = validarPedido(u, body);
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
});

// Empresas: varios envíos desde un archivo (mismo punto de recogida). Solo zonas con tarifa fija.
ruta('POST', '/api/envios/lote', async ({ req, body }) => {
  const u = requiereUsuario(req);
  const f = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.id);
  if (f.tipo_cuenta !== 'empresa') falla(403, 'Los envíos por archivo son para cuentas de empresa. Escríbenos para activarla.');
  revisarClienteParaEnviar(u);
  const filas = Array.isArray(body.filas) ? body.filas : [];
  if (!filas.length) falla(400, 'El archivo no tiene envíos.');
  if (filas.length > 100) falla(400, 'Máximo 100 envíos por archivo.');
  const programado = programadoUtc(body.programado_para);
  const base = { origen_direccion: body.origen_direccion, origen_telefono: body.origen_telefono, origen_zona: body.origen_zona, origen_lat: body.origen_lat, origen_lng: body.origen_lng,
    origen_precision: body.origen_precision, origen_quien: 'cliente', vehiculo_id: body.vehiculo_id, metodo_pago: body.metodo_pago };
  if (!coordenada(body.origen_lat, body.origen_lng)) falla(400, 'Necesitamos tu ubicación actual: el piloto llega a recoger a donde estás. Activa la ubicación (GPS) y permite que Vaelo la use.');
  const preparados = [], errores = [];
  for (const [i, fila] of filas.entries()) {
    const b = { ...base, destino_nombre: fila.destino_nombre, destino_telefono: fila.destino_telefono, destino_direccion: fila.destino_direccion,
      destino_zona: fila.destino_zona, peso: fila.peso, descripcion: fila.descripcion, cobro_destinatario: fila.cobro_destinatario, notas: fila.notas, fragil: fila.fragil };
    try {
      if (b.destino_zona === OTRA_ZONA) falla(400, 'por archivo solo se aceptan zonas con tarifa fija; ese envío hazlo uno por uno');
      const d = validarPedido(u, b);
      const c = await cotizar(b);
      preparados.push({ b, d, c, desc: mejorDescuento(c.precio, u.id, body.cupon) });
    } catch (err) { errores.push(`Fila ${i + 2}: ${err.message}`); }
  }
  if (errores.length) return { _status: 400, ok: false, errores };
  db.exec('BEGIN');
  try {
    // Todos van en un solo viaje: la asignación automática los ofrece juntos al mismo piloto
    const grupo = preparados.length > 1 ? 'G' + crypto.randomBytes(6).toString('hex') : null;
    const creados = preparados.map((x) => insertarEnvio(u, x.b, x.d, x.c, x.desc, programado, grupo));
    db.exec('COMMIT');
    avisarStaff({ titulo: `${creados.length} envíos nuevos por archivo`, cuerpo: `${f.empresa_nombre || f.nombre}, total Q${creados.reduce((s, x) => s + x.precio, 0).toFixed(2)}`, url: RUTA_ADMIN, etiqueta: 'nuevo' });
    return { _status: 201, ok: true, creados: creados.length, total: redondear(creados.reduce((s, x) => s + x.precio, 0)), guias: creados.map((x) => x.guia) };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}, { limite: 400_000 });

ruta('GET', '/api/envios/:id/entrega/:tipo', ({ req, res, params }) => {
  const u = requiereUsuario(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND usuario_id = ?').get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
  if (!['foto', 'firma', 'fallo', 'comprobante'].includes(params.tipo)) falla(404, 'No hay archivo.');
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
const CAMPOS_RECEPTOR = ['receptor_token', 'receptor_foto', 'receptor_lat', 'receptor_lng', 'receptor_precision', 'receptor_ubic_fecha', 'receptor_nombre', 'receptor_confirmado_en', 'receptor_omitido',
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
async function revisarPrecio(id) {
  const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(id);
  if (!e || !['pendiente', 'recogido', 'en_camino'].includes(e.estado) || e.origen_lat == null || e.destino_lat == null) return;
  const o = { lat: e.origen_lat, lng: e.origen_lng }, d = { lat: e.destino_lat, lng: e.destino_lng };
  const movido = (lat, lng, p) => lat == null || distanciaRecta({ lat, lng }, p) > 1;
  if (!e.precio_por_confirmar && !movido(e.precio_o_lat, e.precio_o_lng, o) && !movido(e.precio_d_lat, e.precio_d_lng, d)) return;
  const v = db.prepare('SELECT * FROM vehiculos WHERE id = ?').get(e.vehiculo_id);
  const { km } = await kilometros(o, d);
  const fija = aplicaTarifaFija(e.origen_zona, e.destino_zona, o, d, km);
  const viaje = fija ? v.tarifa_zona : Math.max(v.tarifa_zona, v.tarifa_base + km * v.precio_km);
  const base = redondear(viaje + (e.recargo_fragil || 0) + (e.seguro || 0));
  let descuento = 0;
  const p = e.promocion_id ? db.prepare('SELECT * FROM promociones WHERE id = ?').get(e.promocion_id) : null;
  if (p) descuento = montoPromo(p, base);
  else if (e.descuento > 0) {
    const u = db.prepare('SELECT tipo_cuenta, descuento_empresa FROM usuarios WHERE id = ?').get(e.usuario_id);
    if (u && u.tipo_cuenta === 'empresa' && u.descuento_empresa > 0) descuento = redondear((base * Math.min(100, u.descuento_empresa)) / 100);
  }
  const precio = redondear(base - descuento);
  const r = db.prepare(`UPDATE envios SET tipo_tarifa = ?, km = ?, precio_base = ?, descuento = ?, precio = ?, precio_por_confirmar = 0,
      precio_o_lat = ?, precio_o_lng = ?, precio_d_lat = ?, precio_d_lng = ? WHERE id = ? AND estado IN ('pendiente','recogido','en_camino')`)
    .run(fija ? 'zona' : 'km', km, base, descuento, precio, o.lat, o.lng, d.lat, d.lng, id);
  if (!r.changes || Math.abs(precio - e.precio) < 0.01) return;
  const razon = e.tipo_tarifa === 'zona' && !fija ? 'La entrega queda fuera de las zonas con tarifa fija' : e.precio_por_confirmar ? 'Precio final' : 'Cambió el punto de recogida o de entrega';
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(id, e.estado, `${razon}: ${'Q' + precio.toFixed(2)}${fija ? ' (tarifa fija)' : ` por ${km} km`}`);
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
    if (p) piloto = { nombre: p.nombre.split(' ')[0], vehiculo: p.vehiculo, color: p.veh_color, placa: p.veh_placa, tiene_foto: !!p.foto_perfil,
      lat: vivo ? p.ubic_lat : null, lng: vivo ? p.ubic_lng : null, actualizado: vivo ? p.ubic_fecha : null };
  }
  const confirmado = entrega ? !!e.origen_confirmado_en : !!e.receptor_confirmado_en;
  return {
    rol: e._rol, guia: e.guia, estado: e.estado, activo, vehiculo: e.vehiculo, fragil: !!e.fragil, descripcion: e.descripcion,
    remitente: e.tipo_cuenta === 'empresa' && e.empresa_nombre ? e.empresa_nombre : (e.remitente || '').split(/\s+/)[0],
    destinatario: e.destino_nombre, destino_zona: e.destino_zona, referencias: entrega ? e.origen_direccion : e.destino_direccion,
    nombre_sugerido: entrega ? e.origen_nombre : e.destino_nombre, origen_zona: e.origen_zona,
    cobro: entrega ? 0 : Number(e.cobro_destinatario) || 0, programado_para: e.programado_para,
    confirmado, omitido: !!e.receptor_omitido, exigido: exigeReceptor(),
    // El código solo lo ve quien recibe y cuando ya confirmó: lo da al piloto al tener el paquete en la mano
    codigo_entrega: !entrega && activo && (confirmado || e.receptor_omitido) ? e.codigo_entrega : null,
    piloto, recibio: entrega ? null : e.recibio, entregado_en: entrega ? null : e.entregado_en,
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
  + CASE WHEN e.estado = 'entregado' AND e.sede_llegada IS NULL THEN e.cobro_destinatario ELSE 0 END)`;
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
  const cobros = db.prepare(`SELECT u.id, u.nombre, u.telefono, u.empresa_nombre, COUNT(*) AS envios, SUM(e.cobro_destinatario) AS monto
    FROM envios e JOIN usuarios u ON u.id = e.usuario_id WHERE e.estado = 'entregado' AND e.cobro_destinatario > 0 AND e.cobro_pagado_en IS NULL
    GROUP BY u.id ORDER BY monto DESC`).all();
  const credito = db.prepare(`SELECT u.id, u.nombre, u.empresa_nombre, COUNT(*) AS envios, SUM(e.precio + e.cargos_extra) AS monto, MIN(e.creado) AS desde
    FROM envios e JOIN usuarios u ON u.id = e.usuario_id WHERE e.metodo_pago = 'credito' AND ${SQL_VIAJE_HECHO} AND e.credito_pagado_en IS NULL
    GROUP BY u.id ORDER BY monto DESC`).all();
  const historial = db.prepare(`SELECT 'liquidacion' AS tipo, l.id AS id, l.creado AS creado, u.nombre AS nombre, l.esperado AS esperado, l.recibido AS monto, l.envios AS envios, l.nota AS nota FROM liquidaciones l JOIN usuarios u ON u.id = l.piloto_id
    UNION ALL SELECT 'pago' AS tipo, p.id, p.creado, u.nombre, NULL, p.monto, p.envios, p.nota FROM pagos_piloto p JOIN usuarios u ON u.id = p.piloto_id
    ORDER BY creado DESC LIMIT 40`).all();
  return { pilotos: pilotos.map((p) => ({ ...p, efectivo: redondear(p.efectivo), ganancia: redondear(p.ganancia), detalle: detalle(p.id) })),
    cobros: cobros.map((c) => ({ ...c, monto: redondear(c.monto) })), credito: credito.map((c) => ({ ...c, monto: redondear(c.monto) })), historial };
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
  const monto = redondear(envios.reduce((s, x) => s + (x.ganancia_piloto || 0), 0));
  db.exec('BEGIN');
  try {
    const r = db.prepare('INSERT INTO pagos_piloto (piloto_id, monto, envios, nota) VALUES (?, ?, ?, ?)').run(id, monto, envios.length, texto(body.nota, 300));
    const marcar = db.prepare('UPDATE envios SET pago_piloto_id = ? WHERE id = ?');
    for (const x of envios) marcar.run(Number(r.lastInsertRowid), x.id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { ok: true, monto };
});
ruta('POST', '/api/admin/caja/pagar-cobros', ({ req, body }) => {
  requiereRol(req, 'admin');
  const r = db.prepare("UPDATE envios SET cobro_pagado_en = datetime('now') WHERE usuario_id = ? AND estado = 'entregado' AND cobro_destinatario > 0 AND cobro_pagado_en IS NULL").run(numero(body.cliente_id));
  return { ok: true, envios: Number(r.changes) };
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
  return { nombre, tipo, valor, desde, hasta, codigo, solo_primer_envio: body.solo_primer_envio ? 1 : 0,
    usos_max: entero(body.usos_max), usos_por_cliente: entero(body.usos_por_cliente), minimo: body.minimo ? numero(body.minimo) || null : null };
}
ruta('GET', '/api/admin/promociones', ({ req }) => {
  requiereRol(req, 'admin');
  const hoy = hoyGT();
  return { hoy, promociones: db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM envios e WHERE e.promocion_id = p.id AND e.estado != 'cancelado') AS usos,
    (SELECT COALESCE(SUM(e.descuento), 0) FROM envios e WHERE e.promocion_id = p.id AND e.estado != 'cancelado') AS total_descontado
    FROM promociones p ORDER BY p.hasta DESC, p.id DESC`).all().map((p) => ({ ...p,
      estado: !p.activa ? 'pausada' : p.hasta < hoy ? 'terminada' : p.desde > hoy ? 'programada' : 'activa' })) };
});
ruta('POST', '/api/admin/promociones', ({ req, body }) => {
  requiereRol(req, 'admin');
  const p = leerPromocion(body);
  if (p.codigo && db.prepare('SELECT 1 FROM promociones WHERE codigo = ?').get(p.codigo)) falla(409, 'Ya existe una promoción con ese cupón.');
  db.prepare(`INSERT INTO promociones (nombre, codigo, tipo, valor, desde, hasta, solo_primer_envio, usos_max, usos_por_cliente, minimo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.nombre, p.codigo, p.tipo, p.valor, p.desde, p.hasta, p.solo_primer_envio, p.usos_max, p.usos_por_cliente, p.minimo);
  return { _status: 201, ok: true };
});
ruta('PUT', '/api/admin/promociones/:id', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const actual = db.prepare('SELECT * FROM promociones WHERE id = ?').get(Number(params.id));
  if (!actual) falla(404, 'No encontramos esa promoción.');
  if (body.activa !== undefined && Object.keys(body).length === 1) { db.prepare('UPDATE promociones SET activa = ? WHERE id = ?').run(body.activa ? 1 : 0, actual.id); return { ok: true }; }
  const p = leerPromocion(body);
  if (p.codigo && db.prepare('SELECT 1 FROM promociones WHERE codigo = ? AND id != ?').get(p.codigo, actual.id)) falla(409, 'Ya existe una promoción con ese cupón.');
  db.prepare(`UPDATE promociones SET nombre = ?, codigo = ?, tipo = ?, valor = ?, desde = ?, hasta = ?, solo_primer_envio = ?, usos_max = ?, usos_por_cliente = ?, minimo = ? WHERE id = ?`)
    .run(p.nombre, p.codigo, p.tipo, p.valor, p.desde, p.hasta, p.solo_primer_envio, p.usos_max, p.usos_por_cliente, p.minimo, actual.id);
  return { ok: true };
});

// ---------- Cuentas de empresa (panel) ----------
ruta('PUT', '/api/admin/clientes/:id/empresa', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const u = db.prepare("SELECT id FROM usuarios WHERE id = ? AND rol = 'cliente'").get(Number(params.id));
  if (!u) falla(404, 'No encontramos ese cliente.');
  const empresa = body.tipo_cuenta === 'empresa';
  const desc = empresa ? numero(body.descuento_empresa || 0) : 0;
  if (!(desc >= 0 && desc <= 90)) falla(400, 'El descuento de empresa debe ser de 0 a 90%.');
  db.prepare('UPDATE usuarios SET tipo_cuenta = ?, empresa_nombre = ?, descuento_empresa = ?, credito_permitido = ? WHERE id = ?')
    .run(empresa ? 'empresa' : 'personal', empresa ? texto(body.empresa_nombre, 100) || null : null, desc, empresa && body.credito_permitido ? 1 : 0, u.id);
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
  // Cargos a clientes (cancelación tardía, devoluciones, días en la sede y nuevas entregas)
  const cargos = db.prepare(`SELECT c.tipo, COUNT(*) AS n, SUM(c.monto) AS monto FROM cargos c
    WHERE c.anulado_en IS NULL AND date(c.creado, '-6 hours') BETWEEN ? AND ? GROUP BY c.tipo`).all(desde, hasta);
  return { desde, hasta, cargos, general: { ...g, fallidos: g.fallidos || 0, ingresos: redondear(g.ingresos), descuentos: redondear(g.descuentos), pagos_pilotos: redondear(g.pagos_pilotos),
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
  return { operadores: db.prepare("SELECT id, nombre, email, activo, creado FROM usuarios WHERE rol = 'operador' ORDER BY nombre").all() };
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
  if (!u) return;
  enviarCorreo(u.email, asunto, correoVaelo(titulo, parrafos, boton), [titulo, ...parrafos, boton ? URL_SITIO + boton.url : ''].join('\n')).catch(() => {});
}
// Qué se avisa en cada momento del envío (al cliente, al piloto y a la oficina) y a la tienda conectada
function avisarEnvio(envioId, tipo, extra = {}) {
  try {
    const e = db.prepare(`${SQL_ENVIO} WHERE e.id = ?`).get(envioId);
    if (!e) return;
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
      case 'asignado': pil('Nuevo envío para ti', `${e.origen_zona} → ${e.destino_zona} · ${e.vehiculo}. Tienes ${Math.max(20, Number(getAjustes().segundos_aceptar) || 60)} segundos para aceptar.`); break;
      case 'precio': cli('Precio de tu envío actualizado', `${guia}: ${extra.razon}. Total Q${Number(extra.precio).toFixed(2)}.`, true); break;
      case 'comprobante': avisarStaff({ titulo: 'Comprobante de transferencia', cuerpo: `${guia} · ${e.cliente_nombre} · Q${(e.precio + e.cargos_extra).toFixed(2)}`, url: RUTA_ADMIN, etiqueta: 'pago-' + e.id }); break;
    }
    if (ESTADOS.includes(tipo) || tipo === 'precio' || tipo === 'aceptado') avisarTienda(e, tipo);
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
const TIPOS_CARGO = { cancelacion: 'Cancelación con el piloto en camino', devolucion: 'Devolución del paquete', bodega: 'Días en la sede', reentrega: 'Nueva entrega desde la sede' };
function crearCargo(usuarioId, envioId, tipo, monto, nota) {
  if (!(monto > 0)) return;
  db.prepare('INSERT INTO cargos (usuario_id, envio_id, tipo, monto, nota) VALUES (?, ?, ?, ?, ?)').run(usuarioId, envioId, tipo, redondear(monto), nota || TIPOS_CARGO[tipo]);
}
// Al crear un envío, los cargos pendientes se cobran con él
function sumarCargosPendientes(usuarioId, envioId) {
  const r = db.prepare("UPDATE cargos SET cobrado_envio_id = ? WHERE usuario_id = ? AND cobrado_envio_id IS NULL AND pagado_en IS NULL AND anulado_en IS NULL").run(envioId, usuarioId);
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
  const pendientes = cargosPendientes(u.id);
  const historial = db.prepare(`SELECT c.*, e.guia, ec.guia AS cobrado_guia FROM cargos c LEFT JOIN envios e ON e.id = c.envio_id LEFT JOIN envios ec ON ec.id = c.cobrado_envio_id
    WHERE c.usuario_id = ? ORDER BY c.id DESC LIMIT 50`).all(u.id);
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
const cargoBodega = (e) => redondear(diasEnSede(e) * (Number(getAjustes().cargo_bodega_dia) || 0));
function decidirFallido(e, decision, por) {
  if (e.estado !== 'fallido') falla(400, 'Este envío ya no está esperando una decisión.');
  if (!['devolver', 'sede'].includes(decision)) falla(400, 'Elige devolver el paquete o guardarlo en la sede.');
  const aj = getAjustes();
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE envios SET fallo_decision = ?, fallo_decidido_en = datetime('now'), fallo_decidido_por = ? WHERE id = ?").run(decision, por, e.id);
    if (decision === 'devolver') {
      crearCargo(e.usuario_id, e.id, 'devolucion', Number(aj.cargo_devolucion) || 0);
      cambiarEstado(e.id, 'devolviendo', `Se devolverá a quien lo envió (decidió: ${por}). Cargo: Q${(Number(aj.cargo_devolucion) || 0).toFixed(2)}`);
    } else {
      cambiarEstado(e.id, 'a_sede', `Se guardará en la sede (decidió: ${por}). Q${(Number(aj.cargo_bodega_dia) || 0).toFixed(2)} por día`);
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
    crearCargo(e.usuario_id, e.id, 'bodega', cargoBodega(f), `${diasEnSede(f)} día(s) en la sede`);
    // Lo pendiente del cliente se paga en la sede al retirar
    db.prepare("UPDATE cargos SET pagado_en = datetime('now'), pagado_como = 'en la sede' WHERE usuario_id = ? AND pagado_en IS NULL AND anulado_en IS NULL AND cobrado_envio_id IS NULL").run(e.usuario_id);
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
  db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(hashPassword(nueva), u.id);
  db.prepare('DELETE FROM tokens_clave WHERE usuario_id = ?').run(u.id);
  db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(u.id);
  return { ok: true, destino: u.rol === 'mensajero' ? RUTA_PILOTO : '/entrar' };
});

// ---------- Tiendas en línea: clave de la API y avisos (webhook) ----------
const huella = (t) => crypto.createHash('sha256').update(t).digest('hex');
ruta('GET', '/api/yo/tienda', ({ req }) => {
  const u = requiereRol(req, 'cliente');
  const f = db.prepare('SELECT tipo_cuenta, api_clave_pista, webhook_url FROM usuarios WHERE id = ?').get(u.id);
  return { empresa: f.tipo_cuenta === 'empresa', clave_pista: f.api_clave_pista, webhook_url: f.webhook_url,
    recogida: db.prepare('SELECT id, nombre, direccion, zona FROM direcciones WHERE usuario_id = ? AND lat IS NOT NULL ORDER BY nombre').all(u.id) };
});
ruta('POST', '/api/yo/tienda', ({ req, body }) => {
  const u = requiereRol(req, 'cliente');
  const f = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.id);
  if (f.tipo_cuenta !== 'empresa') falla(403, 'La conexión con tiendas es para cuentas de empresa. Escríbenos para activarla.');
  const out = { ok: true };
  if (body.nueva_clave) {
    const clave = 'vaelo_' + crypto.randomBytes(24).toString('hex');
    const secreto = f.webhook_secreto || crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE usuarios SET api_clave_hash = ?, api_clave_pista = ?, webhook_secreto = ? WHERE id = ?').run(huella(clave), clave.slice(0, 10) + '…' + clave.slice(-4), secreto, u.id);
    out.clave = clave; out.secreto = secreto;   // se muestran una sola vez
  }
  if (body.quitar_clave) db.prepare('UPDATE usuarios SET api_clave_hash = NULL, api_clave_pista = NULL WHERE id = ?').run(u.id);
  if (body.webhook_url !== undefined) {
    const w = texto(body.webhook_url, 300);
    if (w && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(w)) falla(400, 'La dirección para avisos debe empezar con https://');
    db.prepare('UPDATE usuarios SET webhook_url = ?, webhook_secreto = COALESCE(webhook_secreto, ?) WHERE id = ?').run(w || null, crypto.randomBytes(24).toString('hex'), u.id);
    if (w) out.secreto = db.prepare('SELECT webhook_secreto FROM usuarios WHERE id = ?').get(u.id).webhook_secreto;
  }
  return out;
});
function usuarioApi(req) {
  const m = /^Bearer\s+(vaelo_[a-f0-9]{48})$/.exec(req.headers.authorization || '');
  if (!m) falla(401, 'Falta la clave de la API (Authorization: Bearer vaelo_...).');
  if (limitar(m[1].slice(-12), 'api', 120, 60_000)) falla(429, 'Demasiadas peticiones. Máximo 120 por minuto.');
  const u = db.prepare("SELECT * FROM usuarios WHERE api_clave_hash = ? AND activo = 1 AND rol = 'cliente' AND tipo_cuenta = 'empresa'").get(huella(m[1]));
  if (!u) falla(401, 'La clave de la API no es válida.');
  return u;
}
function envioParaTienda(e) {
  return { guia: e.guia, estado: e.estado, precio: e.precio, cargos_extra: e.cargos_extra, destino_nombre: e.destino_nombre, destino_zona: e.destino_zona,
    enlace_receptor: e.receptor_token && ESTADOS_ACTIVOS.includes(e.estado) ? URL_SITIO + '/recibe/' + e.receptor_token : null,
    rastreo: `${URL_SITIO}/rastreo?guia=${e.guia}`, recibio: e.recibio, entregado_en: e.entregado_en, creado: e.creado, actualizado: e.actualizado };
}
// Crear un envío desde la tienda. La recogida sale de una dirección guardada con ubicación (direccion_id) o de origen_lat/origen_lng.
ruta('POST', '/api/v1/envios', async ({ req, body }) => {
  const u = usuarioApi(req);
  const b = { ...body, origen_quien: 'cliente' };
  if (body.direccion_id) {
    const dir = db.prepare('SELECT * FROM direcciones WHERE id = ? AND usuario_id = ? AND lat IS NOT NULL').get(numero(body.direccion_id), u.id);
    if (!dir) falla(400, 'direccion_id no existe o no tiene ubicación en el mapa.');
    Object.assign(b, { origen_lat: dir.lat, origen_lng: dir.lng, origen_direccion: dir.direccion, origen_zona: dir.zona, origen_telefono: dir.telefono || u.telefono });
  }
  if (!b.origen_zona) b.origen_zona = (coordenada(b.origen_lat, b.origen_lng) && zonaDePunto(coordenada(b.origen_lat, b.origen_lng))) || OTRA_ZONA;
  if (!b.destino_zona) b.destino_zona = OTRA_ZONA;
  if (!b.vehiculo_id) b.vehiculo_id = db.prepare('SELECT id FROM vehiculos WHERE activo = 1 ORDER BY orden, id LIMIT 1').get()?.id;
  const d = validarPedido(u, b);
  const c = await cotizar(b);
  const desc = mejorDescuento(c.precio, u.id, b.cupon);
  db.exec('BEGIN');
  let out;
  try { out = insertarEnvio(u, b, d, c, desc, programadoUtc(b.programado_para)); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; }
  avisarEnvio(out.id, 'nuevo');
  const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(out.id);
  return { _status: 201, ...envioParaTienda(e), codigo_entrega: out.codigo_entrega, precio_por_confirmar: out.precio_por_confirmar };
});
ruta('GET', '/api/v1/envios/:guia', ({ req, params }) => {
  const u = usuarioApi(req);
  const e = db.prepare('SELECT * FROM envios WHERE guia = ? AND usuario_id = ?').get(decodeURIComponent(params.guia).toUpperCase(), u.id);
  if (!e) falla(404, 'No encontramos esa guía en tu cuenta.');
  return { ...envioParaTienda(e), eventos: eventosDe(e.id).map(({ estado, nota, creado }) => ({ estado, nota, creado })) };
});
// Aviso a la tienda en cada cambio, firmado con su secreto (cabecera X-Vaelo-Firma: sha256=...)
function avisarTienda(e, tipo) {
  const u = db.prepare('SELECT webhook_url, webhook_secreto FROM usuarios WHERE id = ?').get(e.usuario_id);
  if (!u || !u.webhook_url || !u.webhook_secreto) return;
  const fila = db.prepare('SELECT * FROM envios WHERE id = ?').get(e.id);
  const cuerpo = JSON.stringify({ evento: tipo, envio: envioParaTienda(fila), enviado: new Date().toISOString() });
  const firma = crypto.createHmac('sha256', u.webhook_secreto).update(cuerpo).digest('hex');
  fetch(u.webhook_url, { method: 'POST', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json', 'X-Vaelo-Firma': 'sha256=' + firma, 'User-Agent': 'Vaelo-Webhook/1.0' }, body: cuerpo })
    .catch((err) => console.error('Aviso a tienda falló:', err.message));
}

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

// ---------- Asignación automática al piloto más cercano ----------
// Cada 10 segundos: si un piloto no acepta a tiempo pasa al siguiente; los envíos sin piloto se ofrecen al más cercano libre.
function asignacionAutomatica() {
  const a = getAjustes();
  if (a.auto_asignar !== '1') return;
  const segundos = Math.max(20, Number(a.segundos_aceptar) || 60);
  const excluidos = (e) => { try { return JSON.parse(e.excluidos || '[]'); } catch { return []; } };
  // 1) Se venció el tiempo para aceptar
  for (const e of db.prepare(`SELECT e.*, u.nombre AS piloto FROM envios e JOIN usuarios u ON u.id = e.mensajero_id
      WHERE e.asignacion = 'por_aceptar' AND e.estado = 'pendiente' AND e.asignado_en < datetime('now', ?)`).all(`-${segundos} seconds`)) {
    db.prepare('UPDATE envios SET mensajero_id = NULL, asignacion = NULL, excluidos = ? WHERE id = ?').run(JSON.stringify([...excluidos(e), e.mensajero_id]), e.id);
    db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, `${e.piloto.split(' ')[0]} no respondió a tiempo. Buscando otro piloto`);
  }
  // 2) Envíos sin piloto (los programados, 30 minutos antes)
  const pendientes = db.prepare(`SELECT * FROM envios WHERE estado = 'pendiente' AND mensajero_id IS NULL AND origen_lat IS NOT NULL
    AND (programado_para IS NULL OR programado_para <= datetime('now', '+30 minutes')) ORDER BY COALESCE(programado_para, creado) LIMIT 40`).all();
  if (exigeReceptor()) for (let i = pendientes.length - 1; i >= 0; i--) if (!receptorListo(pendientes[i])) pendientes.splice(i, 1);
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
  const sinAsignar = db.prepare("SELECT COUNT(*) AS n FROM envios WHERE mensajero_id IS NULL AND estado = 'pendiente'").get().n;
  const clientes = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'cliente'").get().n;
  return { porEstado, hoy, sinAsignar, entregadosMes: mes.n || 0, ingresosMes: esOperador(quien) ? null : redondear(mes.total), clientes,
    rol: esOperador(quien) ? 'operador' : 'admin', nombre: quien.nombre };
});

// Aviso de pedidos nuevos: el panel pregunta cada pocos segundos si hay envíos con número mayor al último que vio
ruta('GET', '/api/admin/nuevos', ({ req, query }) => {
  const quien = requiereStaff(req);
  const ultimo = db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM envios').get().n;
  const desde = Number(query.get('desde'));
  const ahora = db.prepare("SELECT datetime('now') AS t").get().t;
  const desdeT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(query.get('desde_t') || '') ? query.get('desde_t') : ahora;
  const rechazados = db.prepare(`SELECT e.id, e.guia, e.creado, e.precio, e.origen_zona, e.destino_zona, u.nombre AS cliente_nombre
    FROM envios e JOIN usuarios u ON u.id = e.usuario_id WHERE e.rechazado_en > ? AND e.mensajero_id IS NULL AND e.estado = 'pendiente'`).all(desdeT);
  if (!Number.isInteger(desde) || desde < 0 || query.get('desde') === null) return { ultimo, nuevos: [], rechazados, ahora, alertas: alertasAbiertas() };
  const nuevos = db.prepare(`SELECT e.id, e.guia, e.creado, e.precio, e.origen_zona, e.destino_zona, v.nombre AS vehiculo, u.nombre AS cliente_nombre
    FROM envios e JOIN vehiculos v ON v.id = e.vehiculo_id JOIN usuarios u ON u.id = e.usuario_id
    WHERE e.id > ? AND e.estado != 'cancelado' ORDER BY e.id DESC LIMIT 50`).all(desde);
  return { ultimo, nuevos, rechazados, ahora, alertas: alertasAbiertas() };
});

ruta('GET', '/api/admin/envios', ({ req, query }) => {
  const quien = requiereStaff(req);
  const cond = [], args = [];
  const estado = query.get('estado');
  if (estado === 'sin_asignar') cond.push("e.mensajero_id IS NULL AND e.estado = 'pendiente'");
  else if (estado === 'atencion') cond.push("e.estado IN ('fallido','devolviendo','a_sede','en_sede')");
  else if (estado && ESTADOS.includes(estado)) { cond.push('e.estado = ?'); args.push(estado); }
  const q = (query.get('q') || '').trim().slice(0, 100);
  if (q) {
    cond.push('(e.guia LIKE ? OR e.destino_nombre LIKE ? OR u.nombre LIKE ? OR e.destino_telefono LIKE ? OR u.telefono LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like, like);
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
  if (!m || !puedeTrabajar(m)) falla(400, 'Elige un piloto aprobado y con sus documentos vigentes.');
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
  for (const k of ['peso_max', 'tarifa_zona', 'tarifa_base', 'precio_km']) {
    nums[k] = body[k] !== undefined ? numero(body[k]) : v[k];
    if (!(nums[k] >= 0 && nums[k] <= 100000)) falla(400, 'Revisa los números: deben ser cantidades válidas.');
  }
  if (nombre.length < 2) falla(400, 'Escribe el nombre del vehículo.');
  const activo = body.activo !== undefined ? (body.activo ? 1 : 0) : v.activo;
  db.prepare('UPDATE vehiculos SET nombre=?, descripcion=?, peso_max=?, tarifa_zona=?, tarifa_base=?, precio_km=?, activo=? WHERE id=?')
    .run(nombre, descripcion, nums.peso_max, redondear(nums.tarifa_zona), redondear(nums.tarifa_base), redondear(nums.precio_km), activo, v.id);
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
  if (body.auto_asignar !== undefined) up.run('auto_asignar', body.auto_asignar === true || body.auto_asignar === '1' ? '1' : '0');
  if (body.segundos_aceptar !== undefined) {
    const n = numero(body.segundos_aceptar);
    if (!(Number.isInteger(n) && n >= 20 && n <= 600)) falla(400, 'El tiempo para aceptar debe ser de 20 a 600 segundos.');
    up.run('segundos_aceptar', String(n));
  }
  if (body.comision_tipo !== undefined) up.run('comision_tipo', body.comision_tipo === 'fijo' ? 'fijo' : 'porcentaje');
  if (body.comision_valor !== undefined) {
    const n = numero(body.comision_valor);
    if (!(n >= 0 && n <= (body.comision_tipo === 'fijo' ? 1000 : 100))) falla(400, 'Revisa lo que gana el piloto por entrega.');
    up.run('comision_valor', String(redondear(n)));
  }
  if (body.mapbox_token !== undefined) {
    const t = String(body.mapbox_token || '').trim();
    if (t && !/^pk\.[A-Za-z0-9._-]{20,}$/.test(t)) falla(400, 'La clave de Mapbox debe ser la pública (empieza con pk.).');
    up.run('mapbox_token', t);
  }
  // Montos de cargos, seguro y tarifa fija
  const montos = { cargo_devolucion: [0, 1000], cargo_bodega_dia: [0, 1000], cargo_reentrega: [0, 1000], cargo_cancelacion: [0, 1000], pct_piloto_cancelacion: [0, 100],
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
const PAGINAS = { '/': 'index.html', '/entrar': 'entrar.html', '/registro': 'registro.html', '/mi-cuenta': 'cliente.html',
  '/enviar': 'cliente.html', '/rastreo': 'rastreo.html', '/recuperar': 'recuperar.html', '/terminos': 'terminos.html', '/privacidad': 'privacidad.html',
  '/tiendas': 'tiendas.html' };
// Páginas que piden cuenta: si no has iniciado sesión, el servidor te manda a entrar antes de mostrar nada
const PIDEN_CUENTA = { '/enviar': ['cliente', 'admin'], '/mi-cuenta': ['cliente', 'admin'] };

// Cada vez que el servidor arranca (cada actualización) cambia este número; se agrega a comun.js y styles.css en las páginas
// para que los navegadores bajen siempre la versión nueva en vez de usar una copia vieja guardada
const VERSION_ARCHIVOS = Date.now().toString(36);
// Si hay clave de Mapbox (se pone en el panel, Tarifas y ajustes), las páginas con mapa cargan Mapbox; si no, el mapa gratis
const MAPBOX_VERSION = 'v3.8.0';
function conVersion(html) {
  let out = html.replace(/(\/js\/comun\.js|\/css\/styles\.css)\?v=[a-z0-9]+/g, `$1?v=${VERSION_ARCHIVOS}`);
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
    if (ext === '.html') return fs.readFile(archivo, 'utf8', (e, t) => res.end(e ? '' : conVersion(t)));
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
        const out = (await r.fn({ req, res, params, body, query: url.searchParams })) || {};
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
    json(res, 500, { error: 'Ocurrió un error en el servidor. Inténtalo de nuevo en un momento.' });
  }
});

if (require.main === module) {
  servidor.listen(PORT, HOST, () => console.log(`Vaelo funcionando en http://${HOST}:${PORT}`));
}
module.exports = { servidor, hashPassword, asignacionAutomatica, decisionesVencidas, push };
