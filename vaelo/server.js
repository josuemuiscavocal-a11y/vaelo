// Servidor de Vaelo Mensajería (Guatemala)
// Funciona solo con Node.js 22 (sin paquetes extra). Inicia con: node server.js
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR } = require('./db');

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

const ESTADOS = ['pendiente', 'recogido', 'en_camino', 'entregado', 'cancelado'];
const ESTADOS_MENSAJERO = ['recogido', 'en_camino', 'entregado'];
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
  if (OSRM_URL) {
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

  if (oz !== OTRA_ZONA && dz !== OTRA_ZONA) {
    let km = null;
    if (origen && destino) km = (await kilometros(origen, destino)).km;
    return conFragil({ tipo: 'zona', km, precio: redondear(vehiculo.tarifa_zona), vehiculo, peso,
      detalle: `Tarifa fija en zonas cubiertas (${vehiculo.nombre})` }, body);
  }
  if (!origen || !destino) falla(400, 'Para envíos fuera de las zonas cubiertas, marca en el mapa el punto de recogida y el de entrega para calcular los kilómetros.');
  const { km, fuente } = await kilometros(origen, destino);
  const precio = redondear(Math.max(vehiculo.tarifa_zona, vehiculo.tarifa_base + km * vehiculo.precio_km));
  return conFragil({ tipo: 'km', km, precio, vehiculo, peso, fuente,
    detalle: `Q${vehiculo.tarifa_base.toFixed(2)} + ${km} km × Q${vehiculo.precio_km.toFixed(2)}${fuente === 'estimado' ? ' (distancia aproximada)' : ''}` }, body);
}
// Paquete frágil (cuidado especial): se suma el recargo que está en Tarifas y ajustes (Q10 al inicio)
function conFragil(c, body) {
  const fragil = body.fragil === true || body.fragil === 'si' || body.fragil === 1;
  const recargo = fragil ? redondear(Number(getAjustes().recargo_fragil) || 0) : 0;
  return { ...c, fragil, recargo_fragil: recargo, precio: redondear(c.precio + recargo),
    detalle: c.detalle + (recargo ? ` + Q${recargo.toFixed(2)} por frágil` : '') };
}

// Límite simple de intentos (por IP) para login y registro
const intentos = new Map();
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
const ipDe = (req) => req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '';

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
  db.prepare("UPDATE envios SET estado = ?, actualizado = datetime('now') WHERE id = ?").run(estado, envioId);
  if (estado === 'entregado') {
    const e = db.prepare('SELECT precio, mensajero_id, ganancia_piloto FROM envios WHERE id = ?').get(envioId);
    db.prepare("UPDATE envios SET entregado_en = COALESCE(entregado_en, datetime('now')), ganancia_piloto = ? WHERE id = ?")
      .run(e.mensajero_id ? (e.ganancia_piloto ?? gananciaPiloto(e.precio)) : null, envioId);
  }
  db.prepare('INSERT INTO eventos (envio_id, estado, nota, lat, lng) VALUES (?, ?, ?, ?, ?)')
    .run(envioId, estado, nota, c ? c.lat : null, c ? c.lng : null);
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
  };
});

ruta('POST', '/api/cotizar', async ({ req, body }) => {
  const c = await cotizar(body);
  const u = usuarioActual(req);
  const desc = mejorDescuento(c.precio, u ? u.id : null, body.cupon);
  return { tipo: c.tipo, km: c.km, precio_base: c.precio, precio: desc.precio, descuento: desc.descuento, promocion: desc.promocion,
    error_cupon: desc.errorCupon, detalle: c.detalle, recargo_fragil: c.recargo_fragil };
});


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
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) falla(409, 'Ya existe una cuenta con ese correo. Inicia sesión.');
  const r = db.prepare('INSERT INTO usuarios (nombre, email, telefono, password_hash, email_verificado) VALUES (?, ?, ?, ?, 0)')
    .run(nombre, email, telefono, hashPassword(password));
  const id = Number(r.lastInsertRowid);
  const enviado = await enviarConfirmacion({ id, nombre, email });
  return { _status: 201, _headers: { 'Set-Cookie': crearSesion(req, id) }, ok: true, rol: 'cliente', correo_enviado: enviado };
});

ruta('POST', '/api/login', ({ req, body }) => {
  if (limitar(ipDe(req), 'login', 10, 900_000)) falla(429, 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.');
  const email = texto(body.email, 150).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
  if (!u || !verificarPassword(password, u.password_hash)) falla(401, 'Correo o contraseña incorrectos.');
  // La cuenta de administración solo entra por su propia página; aquí responde igual que una contraseña equivocada
  if (u.rol === 'admin') falla(401, 'Correo o contraseña incorrectos.');
  if (u.rol === 'mensajero' || u.rol === 'operador') falla(401, 'Correo o contraseña incorrectos.');
  if (!u.activo) falla(403, 'Esta cuenta está desactivada. Comunícate con Vaelo.');
  return { _headers: { 'Set-Cookie': crearSesion(req, u.id) }, ok: true, rol: u.rol };
});

// Acceso de administración (solo desde /familiatecun y solo con el correo permitido)
ruta('POST', '/api/acceso-familia', ({ req, body }) => {
  // Solo cuentan los intentos fallidos: 5 errores bloquean ese internet por 30 minutos
  const clave = `acceso-familia:${ipDe(req)}`, ahora = Date.now();
  const fallos = (intentos.get(clave) || []).filter((t) => ahora - t < 1800_000);
  if (fallos.length >= 5) falla(429, 'Demasiados intentos. Espera 30 minutos.');
  const email = texto(body.email, 150).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
  const ok = u && u.activo && ((email === ADMIN_EMAIL && u.rol === 'admin') || u.rol === 'operador') && verificarPassword(password, u.password_hash);
  if (!ok) { intentos.set(clave, [...fallos, ahora]); falla(401, 'Datos incorrectos.'); }
  intentos.delete(clave);
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
  return { ok: true };
});

// Cliente: envíos
ruta('GET', '/api/envios', ({ req }) => {
  const u = requiereUsuario(req);
  return { envios: db.prepare(`${SQL_ENVIO} WHERE e.usuario_id = ? ORDER BY e.id DESC LIMIT 200`).all(u.id).map(envioSalida) };
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
  for (const k of ['foto_entrega', 'firma_entrega', 'liquidado_id', 'pago_piloto_id', 'ganancia_piloto', 'excluidos', 'intentos_codigo']) delete out[k];
  return { envio: out, eventos: eventosDe(e.id), piloto: aceptado ? pilotoParaCliente(e.mensajero_id) : null };
});


ruta('POST', '/api/envios/:id/cancelar', ({ req, params }) => {
  const u = requiereUsuario(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND usuario_id = ?').get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
  if (e.estado !== 'pendiente') falla(400, 'Solo puedes cancelar envíos que todavía no hemos recogido.');
  cambiarEstado(e.id, 'cancelado', 'Cancelado por el cliente');
  return { ok: true };
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
    (SELECT COUNT(*) FROM envios WHERE mensajero_id = u.id AND estado IN ('pendiente','recogido','en_camino')) AS activos
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
  const activo = db.prepare("SELECT id FROM envios WHERE mensajero_id = ? AND asignacion = 'aceptado' AND estado IN ('pendiente','recogido','en_camino') ORDER BY id LIMIT 1").get(piloto.id);
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
      } else if (e.llego_origen && km >= 0.3) {
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
  const clave = `piloto:${ipDe(req)}`, ahora = Date.now();
  const fallos = (intentos.get(clave) || []).filter((t) => ahora - t < 900_000);
  if (fallos.length >= 8) falla(429, 'Demasiados intentos. Espera 15 minutos.');
  const email = texto(body.email, 150).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const u = db.prepare("SELECT * FROM usuarios WHERE email = ? AND rol = 'mensajero'").get(email);
  if (!u || !verificarPassword(password, u.password_hash)) { intentos.set(clave, [...fallos, ahora]); falla(401, 'Correo o contraseña incorrectos.'); }
  if (u.estado_piloto === 'baja' || !u.activo) falla(403, 'Esta cuenta ya no está activa. Comunícate con Vaelo.');
  intentos.delete(clave);
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
  const activos = db.prepare("SELECT COUNT(*) AS n FROM envios WHERE mensajero_id = ? AND asignacion = 'aceptado' AND estado IN ('pendiente','recogido','en_camino')").get(p.id).n;
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
    AND (e.estado IN ('pendiente','recogido','en_camino') OR (e.estado = 'entregado' AND date(e.actualizado) >= date('now','-1 day')))
    ORDER BY CASE WHEN e.asignacion = 'por_aceptar' THEN 0 WHEN e.estado = 'en_camino' THEN 1 WHEN e.estado = 'recogido' THEN 2 WHEN e.estado = 'pendiente' THEN 3 ELSE 4 END, e.id`).all(p.id);
  return { envios: filas.map((e) => {
    const out = envioSalida(e);
    for (const k of ['codigo_entrega', 'intentos_codigo', 'foto_entrega', 'firma_entrega', 'precio_base', 'descuento', 'promocion_id', 'liquidado_id', 'pago_piloto_id', 'excluidos', 'ganancia_piloto']) delete out[k];
    const c = db.prepare('SELECT verificacion, foto_perfil FROM usuarios WHERE id = ?').get(e.usuario_id) || {};
    out.cliente_verificado = c.verificacion === 'verificado';
    out.cliente_tiene_foto = !!c.foto_perfil;
    return out;
  }), en_linea: enLineaReal(p) || !!p.en_linea };
});

ruta('POST', '/api/piloto/envios/:id/aceptar', ({ req, params, body }) => {
  const p = requierePilotoTrabajando(req);
  const c = leerPosicion(body, true);
  const e = db.prepare("SELECT * FROM envios WHERE id = ? AND mensajero_id = ? AND asignacion = 'por_aceptar'").get(Number(params.id), p.id);
  if (!e) falla(404, 'Este envío ya no está esperando tu respuesta.');
  if (e.estado === 'cancelado') falla(400, 'El cliente canceló este envío.');
  db.prepare("UPDATE envios SET asignacion = 'aceptado', actualizado = datetime('now') WHERE id = ?").run(e.id);
  db.prepare('UPDATE usuarios SET en_linea = 1 WHERE id = ?').run(p.id);
  db.prepare('INSERT INTO eventos (envio_id, estado, nota, lat, lng) VALUES (?, ?, ?, ?, ?)')
    .run(e.id, e.estado, `${p.nombre.split(' ')[0]} aceptó el envío y va hacia la recogida`, c.lat, c.lng);
  registrarUbicacion({ ...p, en_linea: 1 }, c, numero(body.precision), true);
  return { ok: true };
});

ruta('POST', '/api/piloto/envios/:id/rechazar', ({ req, params, body }) => {
  const p = requierePiloto(req);
  const e = db.prepare("SELECT * FROM envios WHERE id = ? AND mensajero_id = ? AND asignacion = 'por_aceptar'").get(Number(params.id), p.id);
  if (!e) falla(404, 'Este envío ya no está esperando tu respuesta.');
  const motivo = texto(body.motivo, 200);
  db.prepare("UPDATE envios SET mensajero_id = NULL, asignacion = NULL, rechazado_en = datetime('now') WHERE id = ?").run(e.id);
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, `${p.nombre.split(' ')[0]} no aceptó el envío${motivo ? ': ' + motivo : ''}. Buscando otro piloto`);
  return { ok: true };
});

ruta('POST', '/api/piloto/envios/:id/estado', ({ req, params, body }) => {
  const p = requierePiloto(req);
  const e = db.prepare("SELECT * FROM envios WHERE id = ? AND mensajero_id = ? AND asignacion = 'aceptado'").get(Number(params.id), p.id);
  if (!e) falla(404, 'Este envío no está asignado a ti.');
  const estado = texto(body.estado, 20);
  if (!ESTADOS_MENSAJERO.includes(estado)) falla(400, 'Estado no válido.');
  if (['entregado', 'cancelado'].includes(e.estado)) falla(400, 'Este envío ya está cerrado.');
  const c = leerPosicion(body, true);
  let nota = texto(body.nota, 300);
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

ruta('GET', '/api/piloto/envios/:id/foto-cliente', ({ req, res, params }) => {
  const p = requierePiloto(req);
  const e = db.prepare("SELECT usuario_id FROM envios WHERE id = ? AND mensajero_id = ? AND estado IN ('pendiente','recogido','en_camino')").get(Number(params.id), p.id);
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
      WHERE mensajero_id = ? AND estado IN ('pendiente','recogido','en_camino') ORDER BY CASE WHEN asignacion = 'aceptado' THEN 0 ELSE 1 END, id LIMIT 1`).get(p.id);
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
    SELECT u.*, (SELECT COUNT(*) FROM envios e WHERE e.usuario_id = u.id) AS envios
    FROM usuarios u WHERE u.rol = 'cliente'
    ORDER BY CASE u.verificacion WHEN 'por_revisar' THEN 0 ELSE 1 END, u.id DESC LIMIT 500`).all().map((u) => ({ ...datosCliente(u), envios: u.envios })),
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
const ARCHIVOS_ENTREGA = { foto: 'foto_entrega', firma: 'firma_entrega' };
function guardarArchivoEnvio(envioId, tipo, dataUrl) {
  const col = ARCHIVOS_ENTREGA[tipo];
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) falla(400, tipo === 'foto' ? 'Toma la foto del paquete entregado.' : 'La firma no es válida.');
  const datos = Buffer.from(m[2], 'base64');
  if (datos.length < 300) falla(400, tipo === 'foto' ? 'La foto está vacía.' : 'La firma está vacía.');
  if (datos.length > 700_000) falla(413, 'La foto es demasiado grande.');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  if (!FIRMAS[ext].every((b, i) => datos[i] === b)) falla(400, 'El archivo no es válido.');
  fs.mkdirSync(DOCS_DIR, { recursive: true, mode: 0o750 });
  const nombre = `envio-${envioId}-${tipo}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(DOCS_DIR, nombre), datos, { mode: 0o640 });
  db.prepare(`UPDATE envios SET ${col} = ? WHERE id = ?`).run(nombre, envioId);
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
  if (d.origen_direccion.length < 5) falla(400, 'Escribe la dirección donde recogemos el paquete.');
  if (d.origen_telefono.replace(/\D/g, '').length < 8) falla(400, 'Escribe un teléfono de contacto para la recogida.');
  if (d.destino_nombre.length < 2) falla(400, 'Escribe el nombre de quien recibe.');
  if (d.destino_telefono.replace(/\D/g, '').length < 8) falla(400, 'Escribe el teléfono de quien recibe (8 dígitos).');
  if (d.destino_direccion.length < 5) falla(400, 'Escribe la dirección de entrega.');
  if (!METODOS_PAGO.includes(d.metodo_pago)) falla(400, 'Elige cómo vas a pagar el envío.');
  if (d.metodo_pago === 'credito' && !db.prepare('SELECT credito_permitido FROM usuarios WHERE id = ?').get(u.id)?.credito_permitido) falla(400, 'Tu cuenta no tiene pago a fin de mes. Elige efectivo o transferencia.');
  if (!Number.isFinite(d.cobro_destinatario) || d.cobro_destinatario < 0 || d.cobro_destinatario > 50000) falla(400, 'El monto a cobrar a quien recibe no es válido.');
  return d;
}
function insertarEnvio(u, body, d, c, desc, programado) {
  const o = coordenada(body.origen_lat, body.origen_lng), de = coordenada(body.destino_lat, body.destino_lng);
  const guia = nuevaGuia();
  const codigo = String(crypto.randomInt(1000, 10000));
  const r = db.prepare(`INSERT INTO envios
    (guia, usuario_id, vehiculo_id, peso, descripcion, origen_direccion, origen_zona, origen_telefono, origen_lat, origen_lng,
     destino_nombre, destino_telefono, destino_direccion, destino_zona, destino_lat, destino_lng,
     tipo_tarifa, km, precio, metodo_pago, cobro_destinatario, notas, fragil, recargo_fragil,
     precio_base, descuento, promocion_id, codigo_entrega, programado_para)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    guia, u.id, c.vehiculo.id, c.peso, d.descripcion, d.origen_direccion, texto(body.origen_zona, 60), d.origen_telefono,
    o ? o.lat : null, o ? o.lng : null, d.destino_nombre, d.destino_telefono, d.destino_direccion, texto(body.destino_zona, 60),
    de ? de.lat : null, de ? de.lng : null, c.tipo, c.km, desc.precio, d.metodo_pago, redondear(d.cobro_destinatario), d.notas,
    c.fragil ? 1 : 0, c.recargo_fragil, c.precio, desc.descuento, desc.promocion_id, codigo, programado);
  const id = Number(r.lastInsertRowid);
  const nota = programado ? 'Solicitud recibida (programada)' : 'Solicitud recibida';
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(id, 'pendiente', nota + (desc.promocion ? `. Descuento: ${desc.promocion}` : ''));
  return { id, guia, precio: desc.precio, descuento: desc.descuento, codigo_entrega: codigo };
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
  if (f.verificacion === 'rechazado') falla(403, `Tu verificación de identidad fue rechazada: ${f.verificacion_nota || 'revisa tus datos'}. Corrígela en Mis datos.`);
  if (f.verificacion === 'sin_datos') falla(403, 'Para cuidar a nuestros pilotos, completa tu verificación de identidad en Mis datos (DPI, foto y dirección) antes de enviar.');
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
    if (body.guardar_origen) guardarDireccion(u.id, body.guardar_origen, { direccion: d.origen_direccion, zona: texto(body.origen_zona, 60), telefono: d.origen_telefono, lat: numero(body.origen_lat), lng: numero(body.origen_lng) });
    if (body.guardar_destino) guardarDireccion(u.id, body.guardar_destino, { direccion: d.destino_direccion, zona: texto(body.destino_zona, 60), telefono: d.destino_telefono, contacto: d.destino_nombre, lat: numero(body.destino_lat), lng: numero(body.destino_lng) });
    db.exec('COMMIT');
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
    vehiculo_id: body.vehiculo_id, metodo_pago: body.metodo_pago };
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
    const creados = preparados.map((x) => insertarEnvio(u, x.b, x.d, x.c, x.desc, programado));
    db.exec('COMMIT');
    return { _status: 201, ok: true, creados: creados.length, total: redondear(creados.reduce((s, x) => s + x.precio, 0)), guias: creados.map((x) => x.guia) };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}, { limite: 400_000 });

ruta('GET', '/api/envios/:id/entrega/:tipo', ({ req, res, params }) => {
  const u = requiereUsuario(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND usuario_id = ?').get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
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
    destino_lat: e.estado !== 'entregado' ? e.destino_lat : null, destino_lng: e.estado !== 'entregado' ? e.destino_lng : null, piloto,
    eventos: eventosDe(e.id).map(({ estado, nota, creado }) => ({ estado, nota, creado })),
  };
});

// ---------- Botón de emergencia del piloto ----------
const TIPOS_EMERGENCIA = { accidente: 'Accidente', asalto: 'Asalto o robo', salud: 'Problema de salud', otro: 'Otra emergencia' };
ruta('POST', '/api/piloto/emergencia', ({ req, body }) => {
  const p = requierePiloto(req);
  const tipo = TIPOS_EMERGENCIA[body.tipo] ? body.tipo : 'otro';
  const c = coordenada(body.lat, body.lng) || (p.ubic_lat != null ? { lat: p.ubic_lat, lng: p.ubic_lng } : null);
  const activo = db.prepare("SELECT id FROM envios WHERE mensajero_id = ? AND estado IN ('pendiente','recogido','en_camino') ORDER BY id LIMIT 1").get(p.id);
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
const SQL_EFECTIVO = `(CASE WHEN e.metodo_pago = 'efectivo' THEN e.precio ELSE 0 END + e.cobro_destinatario)`;
ruta('GET', '/api/admin/caja', ({ req }) => {
  requiereRol(req, 'admin');
  const pilotos = db.prepare(`SELECT u.id, u.nombre, u.telefono,
      (SELECT COALESCE(SUM(${SQL_EFECTIVO}), 0) FROM envios e WHERE e.mensajero_id = u.id AND e.estado = 'entregado' AND e.liquidado_id IS NULL) AS efectivo,
      (SELECT COUNT(*) FROM envios e WHERE e.mensajero_id = u.id AND e.estado = 'entregado' AND e.liquidado_id IS NULL AND ${SQL_EFECTIVO} > 0) AS envios_efectivo,
      (SELECT COALESCE(SUM(e.ganancia_piloto), 0) FROM envios e WHERE e.mensajero_id = u.id AND e.estado = 'entregado' AND e.pago_piloto_id IS NULL) AS ganancia,
      (SELECT COUNT(*) FROM envios e WHERE e.mensajero_id = u.id AND e.estado = 'entregado' AND e.pago_piloto_id IS NULL) AS envios_ganancia
    FROM usuarios u WHERE u.rol = 'mensajero' ORDER BY u.nombre`).all().filter((p) => p.efectivo > 0 || p.ganancia > 0);
  const detalle = (id) => db.prepare(`SELECT e.id, e.guia, e.entregado_en, e.precio, e.metodo_pago, e.cobro_destinatario, ${SQL_EFECTIVO} AS efectivo
    FROM envios e WHERE e.mensajero_id = ? AND e.estado = 'entregado' AND e.liquidado_id IS NULL AND ${SQL_EFECTIVO} > 0 ORDER BY e.id`).all(id);
  const cobros = db.prepare(`SELECT u.id, u.nombre, u.telefono, u.empresa_nombre, COUNT(*) AS envios, SUM(e.cobro_destinatario) AS monto
    FROM envios e JOIN usuarios u ON u.id = e.usuario_id WHERE e.estado = 'entregado' AND e.cobro_destinatario > 0 AND e.cobro_pagado_en IS NULL
    GROUP BY u.id ORDER BY monto DESC`).all();
  const credito = db.prepare(`SELECT u.id, u.nombre, u.empresa_nombre, COUNT(*) AS envios, SUM(e.precio) AS monto, MIN(e.creado) AS desde
    FROM envios e JOIN usuarios u ON u.id = e.usuario_id WHERE e.metodo_pago = 'credito' AND e.estado = 'entregado' AND e.credito_pagado_en IS NULL
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
  const envios = db.prepare(`SELECT e.id, ${SQL_EFECTIVO} AS efectivo FROM envios e WHERE e.mensajero_id = ? AND e.estado = 'entregado' AND e.liquidado_id IS NULL AND ${SQL_EFECTIVO} > 0`).all(id);
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
  const envios = db.prepare("SELECT id, ganancia_piloto FROM envios WHERE mensajero_id = ? AND estado = 'entregado' AND pago_piloto_id IS NULL").all(id);
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
  const r = db.prepare("UPDATE envios SET credito_pagado_en = datetime('now') WHERE usuario_id = ? AND metodo_pago = 'credito' AND estado = 'entregado' AND credito_pagado_en IS NULL").run(numero(body.cliente_id));
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
      SUM(e.estado = 'entregado') AS entregados, SUM(e.estado = 'cancelado') AS cancelados,
      COALESCE(SUM(CASE WHEN e.estado = 'entregado' THEN e.precio END), 0) AS ingresos,
      COALESCE(SUM(CASE WHEN e.estado = 'entregado' THEN e.descuento END), 0) AS descuentos,
      COALESCE(SUM(CASE WHEN e.estado = 'entregado' THEN e.ganancia_piloto END), 0) AS pagos_pilotos,
      AVG(CASE WHEN e.estado = 'entregado' AND e.entregado_en IS NOT NULL THEN (julianday(e.entregado_en) - julianday(COALESCE(e.programado_para, e.creado))) * 1440 END) AS minutos,
      COUNT(DISTINCT e.usuario_id) AS clientes
    FROM envios e WHERE ${FILTRO_RANGO}`).get(desde, hasta);
  const porDia = db.prepare(`SELECT date(e.creado, '-6 hours') AS dia, COUNT(*) AS envios, COALESCE(SUM(CASE WHEN e.estado = 'entregado' THEN e.precio END), 0) AS ingresos
    FROM envios e WHERE ${FILTRO_RANGO} GROUP BY dia ORDER BY dia`).all(desde, hasta);
  const porZona = db.prepare(`SELECT e.destino_zona AS zona, COUNT(*) AS envios FROM envios e WHERE ${FILTRO_RANGO} AND e.estado != 'cancelado' GROUP BY zona ORDER BY envios DESC LIMIT 12`).all(desde, hasta);
  const porHora = db.prepare(`SELECT CAST(strftime('%H', e.creado, '-6 hours') AS INTEGER) AS hora, COUNT(*) AS envios FROM envios e WHERE ${FILTRO_RANGO} GROUP BY hora ORDER BY hora`).all(desde, hasta);
  const pilotos = db.prepare(`SELECT u.nombre, COUNT(*) AS entregas, ROUND(AVG(e.calificacion), 1) AS calificacion,
      ROUND(AVG((julianday(e.entregado_en) - julianday(COALESCE(e.programado_para, e.creado))) * 1440)) AS minutos, COALESCE(SUM(e.ganancia_piloto), 0) AS ganancia
    FROM envios e JOIN usuarios u ON u.id = e.mensajero_id WHERE ${FILTRO_RANGO} AND e.estado = 'entregado' GROUP BY u.id ORDER BY entregas DESC`).all(desde, hasta);
  const promos = db.prepare(`SELECT p.nombre, COUNT(*) AS usos, SUM(e.descuento) AS descontado FROM envios e JOIN promociones p ON p.id = e.promocion_id
    WHERE ${FILTRO_RANGO} AND e.estado != 'cancelado' GROUP BY p.id ORDER BY usos DESC`).all(desde, hasta);
  return { desde, hasta, general: { ...g, ingresos: redondear(g.ingresos), descuentos: redondear(g.descuentos), pagos_pilotos: redondear(g.pagos_pilotos),
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
    AND (programado_para IS NULL OR programado_para <= datetime('now', '+30 minutes')) ORDER BY COALESCE(programado_para, creado) LIMIT 20`).all();
  if (!pendientes.length) return;
  const libres = db.prepare(`${SQL_PILOTO} WHERE u.rol = 'mensajero' AND u.estado_piloto = 'aprobado' AND u.activo = 1 AND u.en_linea = 1`).all()
    .filter((p) => enLineaReal(p) && puedeTrabajar(p) && p.activos < 3);
  for (const e of pendientes) {
    const fuera = excluidos(e);
    const o = { lat: e.origen_lat, lng: e.origen_lng };
    const candidatos = libres.filter((p) => p.vehiculo_id === e.vehiculo_id && !fuera.includes(p.id) && !p._ocupado)
      .map((p) => ({ p, km: distanciaRecta(o, { lat: p.ubic_lat, lng: p.ubic_lng }) })).sort((x, y) => x.km - y.km || x.p.activos - y.p.activos);
    const elegido = candidatos[0];
    if (!elegido) continue;
    elegido.p._ocupado = true;   // un envío nuevo por piloto en cada vuelta
    db.prepare("UPDATE envios SET mensajero_id = ?, asignacion = 'por_aceptar', asignado_en = datetime('now'), actualizado = datetime('now') WHERE id = ?").run(elegido.p.id, e.id);
    db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, `Asignado automáticamente a ${elegido.p.nombre.split(' ')[0]} (a ${elegido.km.toFixed(1)} km), esperando que acepte`);
  }
}
if (require.main === module) setInterval(() => { try { asignacionAutomatica(); } catch (err) { console.error('Asignación automática:', err.message); } }, 10_000).unref();

// Administración
ruta('GET', '/api/admin/resumen', ({ req }) => {
  const quien = requiereStaff(req);
  const porEstado = {};
  for (const s of ESTADOS) porEstado[s] = 0;
  for (const r of db.prepare('SELECT estado, COUNT(*) AS n FROM envios GROUP BY estado').all()) porEstado[r.estado] = r.n;
  const hoy = db.prepare("SELECT COUNT(*) AS n FROM envios WHERE date(creado, '-6 hours') = date('now', '-6 hours')").get().n;
  const mes = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(precio), 0) AS total FROM envios
    WHERE estado = 'entregado' AND strftime('%Y-%m', actualizado, '-6 hours') = strftime('%Y-%m', 'now', '-6 hours')`).get();
  const sinAsignar = db.prepare("SELECT COUNT(*) AS n FROM envios WHERE mensajero_id IS NULL AND estado = 'pendiente'").get().n;
  const clientes = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'cliente'").get().n;
  return { porEstado, hoy, sinAsignar, entregadosMes: mes.n, ingresosMes: esOperador(quien) ? null : redondear(mes.total), clientes,
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
  else if (estado && ESTADOS.includes(estado)) { cond.push('e.estado = ?'); args.push(estado); }
  const q = (query.get('q') || '').trim().slice(0, 100);
  if (q) {
    cond.push('(e.guia LIKE ? OR e.destino_nombre LIKE ? OR u.nombre LIKE ? OR e.destino_telefono LIKE ? OR u.telefono LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like, like);
  }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return { envios: db.prepare(`${SQL_ENVIO} ${where} ORDER BY e.id DESC LIMIT 300`).all(...args).map(envioSalida) };
});

ruta('GET', '/api/admin/envios/:id', ({ req, params }) => {
  const quien = requiereStaff(req);
  const e = db.prepare(`${SQL_ENVIO} WHERE e.id = ?`).get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  const cliente = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(e.usuario_id);
  const out = envioSalida(e);
  out.tiene_foto_entrega = !!e.foto_entrega; out.tiene_firma_entrega = !!e.firma_entrega;
  if (esOperador(quien)) for (const k of ['ganancia_piloto', 'liquidado_id', 'pago_piloto_id']) delete out[k];
  return { envio: out, eventos: eventosDe(e.id), cliente: cliente ? datosCliente(cliente) : null,
    piloto: e.mensajero_id ? pilotoParaCliente(e.mensajero_id) : null };
});

ruta('POST', '/api/admin/envios/:id/estado', ({ req, params, body }) => {
  const quien = requiereStaff(req);
  const estado = texto(body.estado, 20);
  if (!ESTADOS.includes(estado)) falla(400, 'Estado no válido.');
  const e = db.prepare('SELECT id FROM envios WHERE id = ?').get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  cambiarEstado(e.id, estado, texto(body.nota, 300));
  return { ok: true };
});

ruta('POST', '/api/admin/envios/:id/asignar', ({ req, params, body }) => {
  const quien = requiereStaff(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  if (['entregado', 'cancelado'].includes(e.estado)) falla(400, 'Este envío ya está cerrado.');
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
  db.prepare('UPDATE zonas_fijas SET nombre = ?, activa = ? WHERE id = ?').run(nombre, body.activa !== undefined ? (body.activa ? 1 : 0) : z.activa, z.id);
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
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};
const PAGINAS = { '/': 'index.html', '/entrar': 'entrar.html', '/registro': 'registro.html', '/mi-cuenta': 'cliente.html',
  '/enviar': 'cliente.html', '/rastreo': 'rastreo.html' };
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
module.exports = { servidor, hashPassword };
