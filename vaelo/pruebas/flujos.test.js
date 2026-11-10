// Pruebas de los flujos principales de Vaelo. Uso: node --test pruebas/
// Arranca el servidor con una base de datos temporal (no toca la real).
'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vaelo-prueba-'));
process.env.VAELO_DATA = DIR;
process.env.VAELO_OSRM = 'no';
const { db } = require('../db');
const { servidor, hashPassword, asignacionAutomatica, decisionesVencidas, push } = require('../server');

let BASE;
const ZONA1 = { lat: 14.6407, lng: -90.5133 };      // centro de la capital
const CERCA = { lat: 14.6100, lng: -90.4700 };      // a unos 5 km
const LEJOS = { lat: 14.3000, lng: -90.7800 };      // a más de 40 km

// Cliente HTTP con cookie de sesión
function cliente() {
  let cookie = '';
  return async function pedir(metodo, ruta, body, cabeceras = {}) {
    const r = await fetch(BASE + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...cabeceras },
      body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, j };
  };
}
const FOTO = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2000)]).toString('base64');
const ajuste = (k, v) => db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor').run(k, String(v));

let admin, ana, piloto, pilotoId, anaId;

test.before(async () => {
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  BASE = `http://127.0.0.1:${servidor.address().port}`;
  const h = hashPassword('clave-de-prueba-123');
  db.prepare("INSERT INTO usuarios (nombre,email,telefono,password_hash,rol,email_verificado,verificacion) VALUES ('Admin','administracionvaelo@vaelomensajeria.com','55550000',?,'admin',1,'verificado')").run(h);
  pilotoId = Number(db.prepare(`INSERT INTO usuarios (nombre,email,telefono,password_hash,rol,email_verificado,verificacion,estado_piloto,vehiculo_id,
    fecha_nacimiento,dpi,doc_frente,doc_reverso,foto_perfil,direccion,emergencia_nombre,emergencia_telefono,penales_doc,penales_fecha,policiacos_doc,policiacos_fecha,
    licencia_numero,licencia_tipo,licencia_vence,licencia_frente,veh_placa,veh_marca,veh_modelo,veh_color,veh_tarjeta,veh_foto_frente,reglas_aceptadas)
    VALUES ('Carlos Pérez','carlos@prueba.com','55552222',?,'mensajero',1,'verificado','aprobado',1,'1995-01-01','1234567890123','x','x','x','Zona 6','Mamá','55553333','x',date('now','-10 days'),'x',date('now','-10 days'),
    'L1','M',date('now','+300 days'),'x','M-123ABC','Honda','XR','Rojo','x','x',datetime('now'))`).run(h).lastInsertRowid);
  admin = cliente(); ana = cliente(); piloto = cliente();
  assert.equal((await admin('POST', '/api/acceso-familia', { email: 'administracionvaelo@vaelomensajeria.com', password: 'clave-de-prueba-123' })).status, 200);
  assert.equal((await piloto('POST', '/api/piloto/entrar', { email: 'carlos@prueba.com', password: 'clave-de-prueba-123' })).status, 200);
  const sinTerminos = await ana('POST', '/api/registro', { nombre: 'Ana López', email: 'ana@prueba.com', telefono: '55551111', password: 'clave-de-prueba-123' });
  assert.equal(sinTerminos.status, 400, 'pide aceptar los términos');
  assert.equal((await ana('POST', '/api/registro', { nombre: 'Ana López', email: 'ana@prueba.com', telefono: '55551111', password: 'clave-de-prueba-123', acepto_terminos: true })).status, 201);
  anaId = db.prepare("SELECT id FROM usuarios WHERE email = 'ana@prueba.com'").get().id;
  db.prepare('UPDATE usuarios SET email_verificado = 1 WHERE id = ?').run(anaId);
  ajuste('sede_lat', 14.6200); ajuste('sede_lng', -90.5200); ajuste('sede_direccion', 'Sede Vaelo, Zona 9');
  db.prepare("UPDATE usuarios SET politica_piloto_version = 1 WHERE id = ?").run(pilotoId);
});
test.after(() => { servidor.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

// Crea un envío de Ana, quien recibe confirma en "destino", y el piloto lo acepta y lo recoge
async function envioEnCamino(destino = CERCA) {
  const r = await ana('POST', '/api/envios', { vehiculo_id: 1, peso: 2, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    destino_nombre: 'Luis Gómez', destino_telefono: '55554444', destino_direccion: 'Casa verde', metodo_pago: 'efectivo', foto_paquete: FOTO });
  assert.equal(r.status, 201, JSON.stringify(r.j));
  const token = r.j.enlace_receptor.split('/').pop();
  assert.equal((await cliente()('POST', `/api/recibe/${token}/confirmar`, { nombre: 'Luis Gómez', lat: destino.lat, lng: destino.lng })).status, 200);
  await new Promise((ok) => setTimeout(ok, 50));
  db.prepare("UPDATE envios SET mensajero_id = ?, asignacion = 'por_aceptar', asignado_en = datetime('now') WHERE id = ?").run(pilotoId, r.j.id);
  assert.equal((await piloto('POST', `/api/piloto/envios/${r.j.id}/aceptar`, { lat: ZONA1.lat, lng: ZONA1.lng })).status, 200);
  assert.equal((await piloto('POST', `/api/piloto/envios/${r.j.id}/estado`, { estado: 'recogido', lat: ZONA1.lat, lng: ZONA1.lng })).status, 200);
  return r.j;
}
const fila = (id) => db.prepare('SELECT * FROM envios WHERE id = ?').get(id);

test('los intentos fallidos no se saltan cambiando la cabecera CF-Connecting-IP', async () => {
  const c = cliente();
  let ultimo;
  for (let i = 0; i < 10; i++) ultimo = await c('POST', '/api/login', { email: 'x@x.com', password: 'mala' }, { 'CF-Connecting-IP': `10.0.0.${i}` });
  assert.equal(ultimo.status, 429);
});

test('un login correcto no cuenta como intento fallido', async () => {
  for (let i = 0; i < 12; i++) assert.equal((await cliente()('POST', '/api/login', { email: 'ana@prueba.com', password: 'clave-de-prueba-123' })).status, 200);
});

test('la tarifa fija cambia a precio por km si la entrega queda lejos', async () => {
  const r = await ana('POST', '/api/envios', { vehiculo_id: 1, peso: 2, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    destino_nombre: 'Luis', destino_telefono: '55554444', destino_direccion: 'x', metodo_pago: 'efectivo', foto_paquete: FOTO });
  assert.equal(r.j.precio, 35);
  const token = r.j.enlace_receptor.split('/').pop();
  await cliente()('POST', `/api/recibe/${token}/confirmar`, { nombre: 'Luis Gómez', lat: LEJOS.lat, lng: LEJOS.lng });
  const e = fila(r.j.id);
  assert.equal(e.tipo_tarifa, 'km');
  assert.ok(e.precio > 100, `precio por km ${e.precio}`);
  // Quien recibe se acerca más de 1 km: se recalcula y vuelve a tarifa fija
  await cliente()('POST', `/api/recibe/${token}/ubicacion`, { lat: CERCA.lat, lng: CERCA.lng });
  assert.equal(fila(r.j.id).precio, 35);
  await ana('POST', `/api/envios/${r.j.id}/cancelar`, {});
});

test('con zonas dibujadas, fuera de la forma no hay tarifa fija', async () => {
  const z = db.prepare("SELECT id FROM zonas_fijas WHERE nombre = 'Zona 1'").get().id;
  const forma = [[-90.53, 14.63], [-90.50, 14.63], [-90.50, 14.65], [-90.53, 14.65]];
  assert.equal((await admin('PUT', `/api/admin/zonas/${z}`, { poligono: forma })).status, 200);
  const c = await ana('POST', '/api/cotizar', { vehiculo_id: 1, peso: 2, origen_zona: 'Zona 1', destino_zona: 'Zona 1', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng, destino_lat: CERCA.lat, destino_lng: CERCA.lng });
  assert.equal(c.j.tipo, 'km');
  assert.equal((await cliente()('GET', `/api/zona?lat=${ZONA1.lat}&lng=${ZONA1.lng}`)).j.zona, 'Zona 1');
  await admin('PUT', `/api/admin/zonas/${z}`, { poligono: null });
});

test('entrega fallida: el cliente elige devolver y se cobra la devolución', async () => {
  const env = await envioEnCamino();
  const lejos = await piloto('POST', `/api/piloto/envios/${env.id}/no-entregado`, { motivo: 'no_contesta', lat: ZONA1.lat, lng: ZONA1.lng });
  assert.equal(lejos.status, 400, 'pide estar en el lugar');
  const r = await piloto('POST', `/api/piloto/envios/${env.id}/no-entregado`, { motivo: 'no_contesta', lat: CERCA.lat, lng: CERCA.lng, foto: FOTO });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const vista = await ana('GET', `/api/envios/${env.id}`);
  assert.equal(vista.j.envio.estado, 'fallido');
  assert.ok(vista.j.envio.fallo.decidir_antes);
  assert.equal((await ana('POST', `/api/envios/${env.id}/decidir`, { decision: 'devolver' })).status, 200);
  assert.equal(fila(env.id).estado, 'devolviendo');
  assert.equal(db.prepare("SELECT monto FROM cargos WHERE envio_id = ? AND tipo = 'devolucion'").get(env.id).monto, 35);
  const dev = await piloto('POST', `/api/piloto/envios/${env.id}/estado`, { estado: 'devuelto', recibio: 'Ana', foto: FOTO, lat: ZONA1.lat, lng: ZONA1.lng });
  assert.equal(dev.status, 200, JSON.stringify(dev.j));
  const f = fila(env.id);
  assert.equal(f.estado, 'devuelto');
  assert.ok(f.piloto_cerro_en);
  assert.equal(f.ganancia_piloto, 60, 'gana el envío menos Q5 (30) y la devolución menos Q5 (30)');
  // El piloto califica al cliente
  assert.equal((await piloto('POST', `/api/piloto/envios/${env.id}/calificar-cliente`, { estrellas: 4 })).status, 200);
});

test('entrega fallida sin respuesta: va a la sede, cobra por día y se reenvía', async () => {
  const env = await envioEnCamino();
  await piloto('POST', `/api/piloto/envios/${env.id}/no-entregado`, { motivo: 'no_esta', lat: CERCA.lat, lng: CERCA.lng });
  db.prepare("UPDATE envios SET fallo_en = datetime('now', '-3 hours') WHERE id = ?").run(env.id);
  decisionesVencidas();
  assert.equal(fila(env.id).estado, 'a_sede');
  assert.equal(fila(env.id).fallo_decidido_por, 'automático');
  assert.equal((await piloto('POST', `/api/piloto/envios/${env.id}/estado`, { estado: 'en_sede', lat: 14.6201, lng: -90.5201 })).status, 200);
  db.prepare("UPDATE envios SET sede_llegada = datetime('now', '-50 hours') WHERE id = ?").run(env.id);
  const vista = await ana('GET', `/api/envios/${env.id}`);
  assert.equal(vista.j.envio.sede.dias, 3);
  assert.equal(vista.j.envio.sede.cargo, 60);
  const re = await ana('POST', `/api/envios/${env.id}/reenviar`, {});
  assert.equal(re.status, 200, JSON.stringify(re.j));
  assert.equal(fila(env.id).estado, 'reenviado');
  const hijo = fila(re.j.id);
  assert.equal(hijo.origen_quien, 'sede');
  assert.ok(hijo.receptor_token, 'el enlace de quien recibe pasa al envío nuevo');
  const cargos = await ana('GET', '/api/yo/cargos');
  assert.equal(cargos.j.total, 60 + 35);
  // El siguiente envío de Ana cobra esos cargos
  const sig = await ana('POST', '/api/envios', { vehiculo_id: 1, peso: 2, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    destino_nombre: 'Luis', destino_telefono: '55554444', destino_direccion: 'x', metodo_pago: 'efectivo', foto_paquete: FOTO });
  assert.equal(sig.j.cargos_extra, 95);
  assert.equal((await ana('GET', '/api/yo/cargos')).j.total, 0);
  // Si se cancela, los cargos vuelven a quedar pendientes
  await ana('POST', `/api/envios/${sig.j.id}/cancelar`, {});
  assert.equal((await ana('GET', '/api/yo/cargos')).j.total, 95);
});

test('cancelar con el piloto en camino pide aceptar el cargo', async () => {
  const r = await ana('POST', '/api/envios', { vehiculo_id: 1, peso: 2, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    destino_nombre: 'Luis', destino_telefono: '55554444', destino_direccion: 'x', metodo_pago: 'efectivo', foto_paquete: FOTO });
  db.prepare("UPDATE envios SET mensajero_id = ?, asignacion = 'aceptado' WHERE id = ?").run(pilotoId, r.j.id);
  const sinAceptar = await ana('POST', `/api/envios/${r.j.id}/cancelar`, {});
  assert.equal(sinAceptar.status, 409);
  assert.equal(sinAceptar.j.cargo, 15);
  assert.equal((await ana('POST', `/api/envios/${r.j.id}/cancelar`, { aceptar_cargo: true })).status, 200);
  assert.equal(fila(r.j.id).ganancia_piloto, 7.5);
  // Lo que gana el piloto aparece en "Mis ganancias"
  const g = await piloto('GET', '/api/piloto/ganancias');
  assert.ok(g.j.por_cobrar >= 7.5 + 60);
});

test('el panel no puede reabrir un envío cerrado y pide motivo', async () => {
  const e = db.prepare("SELECT id FROM envios WHERE estado = 'devuelto' LIMIT 1").get();
  assert.equal((await admin('POST', `/api/admin/envios/${e.id}/estado`, { estado: 'pendiente', nota: 'prueba' })).status, 400);
  const r = await ana('POST', '/api/envios', { vehiculo_id: 1, peso: 2, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    destino_nombre: 'Luis', destino_telefono: '55554444', destino_direccion: 'x', metodo_pago: 'efectivo', foto_paquete: FOTO });
  assert.equal((await admin('POST', `/api/admin/envios/${r.j.id}/estado`, { estado: 'cancelado' })).status, 400);
  assert.equal((await admin('POST', `/api/admin/envios/${r.j.id}/estado`, { estado: 'cancelado', nota: 'Cliente llamó' })).status, 200);
});

test('asignación automática: si todos lo rechazan, se vuelve a ofrecer', async () => {
  ajuste('auto_asignar', 1);
  db.prepare("UPDATE usuarios SET en_linea = 1, ubic_lat = ?, ubic_lng = ?, ubic_fecha = datetime('now') WHERE id = ?").run(ZONA1.lat, ZONA1.lng, pilotoId);
  db.prepare("UPDATE envios SET mensajero_id = NULL WHERE estado = 'pendiente' AND asignacion IS NULL").run();
  const r = await ana('POST', '/api/envios', { vehiculo_id: 1, peso: 2, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    destino_nombre: 'Luis', destino_telefono: '55554444', destino_direccion: 'x', metodo_pago: 'efectivo', foto_paquete: FOTO });
  db.prepare("UPDATE envios SET receptor_omitido = 'prueba' WHERE id = ?").run(r.j.id);
  // Se liberan los envíos activos del piloto para que esté libre
  db.prepare("UPDATE envios SET estado = 'cancelado' WHERE estado IN ('pendiente','recogido','en_camino','fallido','devolviendo','a_sede') AND id != ?").run(r.j.id);
  asignacionAutomatica();
  assert.equal(fila(r.j.id).mensajero_id, pilotoId);
  await piloto('POST', `/api/piloto/envios/${r.j.id}/rechazar`, {});
  asignacionAutomatica();   // el único piloto ya lo rechazó: se limpia la lista
  assert.equal(fila(r.j.id).excluidos, null);
  asignacionAutomatica();   // y se le vuelve a ofrecer
  assert.equal(fila(r.j.id).mensajero_id, pilotoId);
  ajuste('auto_asignar', 0);
});

test('comprobante de transferencia y revisión en el panel', async () => {
  const r = await ana('POST', '/api/envios', { vehiculo_id: 1, peso: 2, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    destino_nombre: 'Luis', destino_telefono: '55554444', destino_direccion: 'x', metodo_pago: 'transferencia', foto_paquete: FOTO });
  assert.equal(fila(r.j.id).pago_estado, 'sin_comprobante');
  assert.equal((await ana('POST', `/api/envios/${r.j.id}/comprobante`, { archivo: FOTO })).status, 200);
  assert.ok((await admin('GET', '/api/admin/pagos')).j.pagos.some((p) => p.id === r.j.id && p.pago_estado === 'por_revisar'));
  const sinPago = await admin('POST', `/api/admin/envios/${r.j.id}/asignar`, { mensajero_id: pilotoId });
  assert.equal(sinPago.status, 400, 'no se manda al piloto sin confirmar el pago');
  assert.equal((await admin('POST', `/api/admin/pagos/${r.j.id}`, { estado: 'verificado' })).status, 200);
  assert.equal((await admin('POST', `/api/admin/envios/${r.j.id}/asignar`, { mensajero_id: pilotoId })).status, 200);
});

test('contraseña nueva con el enlace del correo', async () => {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO tokens_clave (token, usuario_id, expira) VALUES (?, ?, ?)').run(token, anaId, Date.now() + 60_000);
  assert.equal((await cliente()('POST', '/api/clave/nueva', { token, password: 'otra-clave-123' })).status, 200);
  assert.equal((await cliente()('POST', '/api/clave/nueva', { token, password: 'otra-clave-123' })).status, 400, 'el enlace sirve una sola vez');
  assert.equal((await cliente()('POST', '/api/login', { email: 'ana@prueba.com', password: 'otra-clave-123' })).status, 200);
  ana = cliente();
  await ana('POST', '/api/login', { email: 'ana@prueba.com', password: 'otra-clave-123' });
});

test('cuenta de empresa activada desde el panel', async () => {
  await admin('PUT', `/api/admin/clientes/${anaId}/empresa`, { tipo_cuenta: 'empresa', empresa_nombre: 'Tienda Ana' });
});

test('el cifrado de los avisos push se puede descifrar con las claves del celular', () => {
  const ua = crypto.createECDH('prime256v1'); const uaPub = ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const b64 = (b) => b.toString('base64url');
  const cuerpo = push.cifrar({ p256dh: b64(uaPub), auth: b64(auth) }, '{"titulo":"hola"}');
  const sal = cuerpo.subarray(0, 16), idlen = cuerpo[20], asPub = cuerpo.subarray(21, 21 + idlen), cifrado = cuerpo.subarray(21 + idlen);
  const compartido = ua.computeSecret(asPub);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', compartido, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, sal, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, sal, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cifrado.subarray(-16));
  const plano = Buffer.concat([d.update(cifrado.subarray(0, -16)), d.final()]);
  assert.equal(plano.subarray(0, -1).toString(), '{"titulo":"hola"}');
  assert.equal(plano[plano.length - 1], 2);
});

test('el pedido sin foto del paquete no se acepta y el pickup solo es flete', async () => {
  const sin = await ana('POST', '/api/envios', { vehiculo_id: 1, peso: 2, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    destino_nombre: 'Luis', destino_telefono: '55554444', destino_direccion: 'x', metodo_pago: 'efectivo' });
  assert.equal(sin.status, 400);
  const pickup = db.prepare("SELECT id FROM vehiculos WHERE solo_oficina = 1").get();
  assert.ok(pickup, 'el pickup queda solo para fletes');
  const c = await ana('POST', '/api/cotizar', { vehiculo_id: pickup.id, peso: 50, origen_zona: 'Zona 1', destino_zona: 'Zona 16' });
  assert.equal(c.status, 400);
  assert.ok(!(await cliente()('GET', '/api/config')).j.vehiculos.some((v) => v.id === pickup.id));
});

test('flete: la oficina pone precio y piloto; el cliente completa los datos con su enlace', async () => {
  db.prepare('UPDATE usuarios SET vehiculo_id = ? WHERE id = ?').run(db.prepare("SELECT id FROM vehiculos WHERE solo_oficina = 1").get().id, pilotoId);
  const r = await admin('POST', '/api/admin/fletes', { vehiculo_id: 2, mensajero_id: pilotoId, precio: 250, cliente_telefono: '55557777' });
  assert.equal(r.status, 201, JSON.stringify(r.j));
  assert.match(r.j.enlace, /^\/flete\/[a-f0-9]{32}$/);
  const token = r.j.enlace.split('/').pop();
  assert.equal((await admin('POST', `/api/admin/envios/${r.j.id}/asignar`, { mensajero_id: pilotoId })).status, 400, 'no sale hasta que el cliente complete los datos');
  const c = cliente();
  assert.equal((await c('GET', `/api/flete/${token}`)).j.configurado, false);
  const sinFoto = await c('POST', `/api/flete/${token}`, { origen_nombre: 'Don Pedro', origen_telefono: '55557777', origen_direccion: 'Bodega z12', destino_nombre: 'María', destino_telefono: '55558888', destino_direccion: 'Casa z18', descripcion: 'Refrigeradora' });
  assert.equal(sinFoto.status, 400);
  assert.equal((await c('POST', `/api/flete/${token}`, { origen_nombre: 'Don Pedro', origen_telefono: '55557777', origen_direccion: 'Bodega z12', destino_nombre: 'María', destino_telefono: '55558888', destino_direccion: 'Casa z18', descripcion: 'Refrigeradora', foto: FOTO })).status, 200);
  const info = (await c('GET', `/api/flete/${token}`)).j;
  assert.equal(info.configurado, true);
  assert.ok(info.enlace_entrega && info.enlace_recibe && info.codigo_entrega);
  // Quien entrega y quien recibe comparten su ubicación con sus enlaces, como en un envío normal
  await cliente()('POST', `/api/recibe/${info.enlace_entrega.split('/').pop()}/confirmar`, { nombre: 'Don Pedro', lat: 14.60, lng: -90.52 });
  await cliente()('POST', `/api/recibe/${info.enlace_recibe.split('/').pop()}/confirmar`, { nombre: 'María', lat: 14.58, lng: -90.48 });
  assert.equal((await piloto('POST', `/api/piloto/envios/${r.j.id}/estado`, { estado: 'recogido', lat: 14.60, lng: -90.52 })).status, 200);
  const ent = await piloto('POST', `/api/piloto/envios/${r.j.id}/estado`, { estado: 'entregado', codigo: info.codigo_entrega, recibio: 'María', foto: FOTO, lat: 14.58, lng: -90.48 });
  assert.equal(ent.status, 200, JSON.stringify(ent.j));
  assert.equal(fila(r.j.id).ganancia_piloto, 245);
  assert.equal(fila(r.j.id).precio, 250, 'el precio del flete no cambia con las ubicaciones');
  db.prepare('UPDATE usuarios SET vehiculo_id = 1 WHERE id = ?').run(pilotoId);
});

test('renovación de licencia: la fecha nueva vale hasta que la oficina la confirma', async () => {
  const antes = db.prepare('SELECT licencia_vence FROM usuarios WHERE id = ?').get(pilotoId).licencia_vence;
  assert.equal((await piloto('PUT', '/api/piloto/perfil', { licencia_vence: '2031-01-01', telefono: '55552222' })).status, 200);
  assert.equal(db.prepare('SELECT licencia_vence FROM usuarios WHERE id = ?').get(pilotoId).licencia_vence, antes, 'todavía no cambia');
  const ficha = (await admin('GET', `/api/admin/mensajeros/${pilotoId}`)).j.piloto;
  assert.equal(ficha.renovacion.campos.licencia_vence, '2031-01-01');
  assert.equal((await admin('POST', `/api/admin/mensajeros/${pilotoId}/renovacion`, { accion: 'aprobar' })).status, 200);
  assert.equal(db.prepare('SELECT licencia_vence, renovacion_pendiente FROM usuarios WHERE id = ?').get(pilotoId).licencia_vence, '2031-01-01');
});

test('reclamo: se evalúa, se devuelve al cliente y se descuenta al piloto', async () => {
  const e = db.prepare("SELECT id FROM envios WHERE estado = 'entregado' AND usuario_id = ? AND mensajero_id = ? LIMIT 1").get(anaId, pilotoId)
    || { id: (await envioEnCamino()).id };
  db.prepare("UPDATE envios SET estado = 'entregado', entregado_en = datetime('now'), piloto_cerro_en = COALESCE(piloto_cerro_en, datetime('now')), ganancia_piloto = COALESCE(ganancia_piloto, 30) WHERE id = ?").run(e.id);
  assert.equal((await ana('POST', `/api/envios/${e.id}/reclamo`, { tipo: 'danado', descripcion: 'La caja llegó rota y el vaso quebrado' })).status, 201);
  const lista = (await admin('GET', '/api/admin/reclamos')).j.reclamos;
  const rec = lista.find((x) => x.envio_id === e.id);
  assert.equal((await admin('POST', `/api/admin/reclamos/${rec.id}`, { accion: 'aprobar', monto_cliente: 120, monto_piloto: 20, resolucion: 'Se revisó la foto: el vaso valía Q120' })).status, 200);
  const caja = (await admin('GET', '/api/admin/caja')).j;
  assert.ok(caja.reembolsos.some((x) => x.id === rec.id && x.monto_cliente === 120));
  const p = caja.pilotos.find((x) => x.id === pilotoId);
  assert.equal(p.descuentos, 20);
  const pago = await admin('POST', '/api/admin/caja/pagar-piloto', { piloto_id: pilotoId });
  assert.equal(pago.j.descuento, 20);
  assert.equal((await admin('POST', `/api/admin/reclamos/${rec.id}`, { accion: 'devuelto' })).status, 200);
});

test('piloto con efectivo sin liquidar después del plazo no puede trabajar', async () => {
  db.prepare("UPDATE envios SET liquidado_id = NULL, piloto_cerro_en = datetime('now', '-5 days') WHERE mensajero_id = ? AND piloto_cerro_en IS NOT NULL AND metodo_pago = 'efectivo' AND estado != 'cancelado'").run(pilotoId);
  const r = await piloto('POST', '/api/piloto/en-linea', { en_linea: true, lat: ZONA1.lat, lng: ZONA1.lng });
  assert.equal(r.status, 403);
  assert.match(r.j.error, /liquidar/);
  const caja = (await admin('GET', '/api/admin/caja')).j.pilotos.find((x) => x.id === pilotoId);
  await admin('POST', '/api/admin/caja/liquidar', { piloto_id: pilotoId, recibido: caja.efectivo });
  assert.equal((await piloto('POST', '/api/piloto/en-linea', { en_linea: true, lat: ZONA1.lat, lng: ZONA1.lng })).status, 200);
});

test('empresa: solicitud de contrato, cita, aprobación y envío de 10 paquetes a la sede', async () => {
  const beto = cliente();
  await beto('POST', '/api/registro', { nombre: 'Beto Tienda', email: 'beto@prueba.com', telefono: '55556666', password: 'clave-de-prueba-123', acepto_terminos: true });
  const datos = { empresa_nombre: 'Tienda Beto', nit: '1234567-8', giro: 'Ropa en línea', direccion: '6a avenida 1-1', zona: 'Zona 1', telefono: '55556666', correo: 'ventas@beto.com',
    rep_nombre: 'Beto Pérez', rep_cargo: 'Gerente', rep_dpi: '1234 56789 0123', rep_telefono: '55556666', paquetes_mes: 300 };
  assert.equal((await beto('PUT', '/api/empresa/solicitud', datos)).status, 200);
  assert.equal((await beto('POST', '/api/empresa/solicitud/enviar', { acepto_politica: true })).status, 400, 'faltan documentos');
  for (const campo of ['foto_sede_frente', 'foto_sede_interior', 'foto_rep', 'dpi_rep_frente', 'dpi_rep_reverso', 'patente'])
    assert.equal((await beto('POST', '/api/empresa/solicitud/documento', { campo, archivo: FOTO })).status, 200);
  assert.equal((await beto('POST', '/api/empresa/solicitud/enviar', { acepto_politica: true })).status, 200);
  const sol = (await admin('GET', '/api/admin/empresas')).j.solicitudes.find((x) => x.empresa_nombre === 'Tienda Beto');
  assert.equal((await admin('POST', `/api/admin/empresas/${sol.id}`, { accion: 'cita', fecha: '2026-12-01T10:00', lugar: 'Sede Vaelo' })).status, 200);
  assert.equal((await beto('GET', '/api/empresa/estadisticas')).status, 403, 'sin contrato no hay apartado de empresa');
  assert.equal((await admin('POST', `/api/admin/empresas/${sol.id}`, { accion: 'aprobar' })).status, 200);
  const filas = Array.from({ length: 9 }, (_, i) => ({ destino_nombre: 'Cliente ' + i, destino_telefono: '5555000' + i, destino_direccion: 'Casa ' + i, destino_zona: 'Zona 16', peso: 1 }));
  assert.equal((await beto('POST', '/api/empresa/lote-sede', { filas })).status, 400, 'menos de 10 paquetes');
  filas[0].paquetes = 2;   // dos paquetes a la misma dirección, mismo precio
  const lote = await beto('POST', '/api/empresa/lote-sede', { filas, metodo_pago: 'recibe' });
  assert.equal(lote.status, 201, JSON.stringify(lote.j));
  assert.equal(lote.j.paquetes, 10);
  const uno = db.prepare('SELECT * FROM envios WHERE lote_sede_id = ? ORDER BY id LIMIT 1').get(lote.j.lote);
  assert.equal(uno.precio, 35); assert.equal(uno.paquetes, 2); assert.equal(uno.origen_quien, 'sede');
  db.prepare("UPDATE envios SET receptor_omitido = 'prueba' WHERE lote_sede_id = ?").run(lote.j.lote);
  assert.equal((await admin('POST', `/api/admin/envios/${uno.id}/asignar`, { mensajero_id: pilotoId })).status, 400, 'los paquetes no han llegado a la sede');
  assert.equal((await admin('POST', `/api/admin/lotes-sede/${lote.j.lote}`, { accion: 'recibido' })).status, 200);
  db.prepare("UPDATE lotes_sede SET recibido_en = datetime('now', '-2 days') WHERE id = ?").run(lote.j.lote);
  assert.equal((await admin('POST', `/api/admin/envios/${uno.id}/asignar`, { mensajero_id: pilotoId })).status, 200);
  await piloto('POST', `/api/piloto/envios/${uno.id}/aceptar`, { lat: 14.62, lng: -90.52 });
  assert.equal((await piloto('POST', `/api/piloto/envios/${uno.id}/estado`, { estado: 'recogido', lat: 14.62, lng: -90.52 })).status, 200);
  const cargo = db.prepare("SELECT * FROM cargos WHERE envio_id = ? AND tipo = 'bodega_empresa'").get(uno.id);
  assert.equal(cargo.monto, 2 * 10 * 2, '2 días × Q10 × 2 paquetes');
  const st = await beto('GET', '/api/empresa/estadisticas');
  assert.equal(st.status, 200);
  assert.equal(st.j.general.envios, 9);
});

test('pedidos de empresa: enlace del cliente, enviar a Vaelo, dividir en rutas, avisos y sede', async () => {
  const { crearExcel } = require('../lib/xlsx');
  db.prepare('UPDATE usuarios SET vehiculo_id = 1 WHERE id = ?').run(pilotoId);
  db.prepare("UPDATE envios SET estado = 'cancelado' WHERE estado IN ('pendiente','recogido','en_camino') AND mensajero_id = ?").run(pilotoId);
  const beto = cliente();
  assert.equal((await beto('POST', '/api/login', { email: 'beto@prueba.com', password: 'clave-de-prueba-123' })).status, 200);
  const hoy = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
  const LOCAL = { lat: 14.6420, lng: -90.5150 };
  assert.equal((await beto('PUT', '/api/empresa/punto', { lat: LOCAL.lat, lng: LOCAL.lng, direccion: 'Bodega de Tienda Beto, 6a av' })).status, 200);
  // Excel con dos pedidos (quedan esperando que el cliente llene su enlace)
  const xls = crearExcel([{ nombre: 'Pedidos', columnas: [{ titulo: 'Descripción' }, { titulo: 'Tamaño' }, { titulo: 'Cliente' }, { titulo: 'WhatsApp' }],
    filas: [['Camisa', 'Pequeño', 'Rosa Díaz', '55557001'], ['Factura', 'Sobre', 'Juan Paz', '55557002']] }]);
  const sub = await beto('POST', '/api/empresa/pedidos/archivo', { archivo: 'data:application/octet-stream;base64,' + xls.toString('base64') });
  assert.equal(sub.status, 201, JSON.stringify(sub.j)); assert.equal(sub.j.creados, 2);
  // 9 pedidos que llena la empresa, cerca de su local (Zona 1: Q35)
  const puntos = Array.from({ length: 9 }, (_, i) => ({ lat: 14.632 + (i % 3) * 0.006, lng: -90.528 + Math.floor(i / 3) * 0.009 }));
  for (const [i, pt] of puntos.entries()) {
    const r = await beto('POST', '/api/empresa/pedidos', { descripcion: 'Paquete ' + i, tamano: i === 0 ? 'mediano' : 'sobre', cliente_nombre: 'Cliente ' + i, cliente_telefono: '5555800' + i,
      foto: FOTO, llenar: true, dia: hoy, horario: i === 1 ? 'tarde' : 'cualquiera', direccion: 'Casa ' + i, zona: 'Zona 1', lat: pt.lat, lng: pt.lng, recibe_nombre: 'Recibe ' + i, recibe_telefono: '5555900' + i, metodo_pago: 'efectivo' });
    assert.equal(r.status, 201, JSON.stringify(r.j));
    assert.equal(r.j.pedido.estado, 'confirmado'); assert.equal(r.j.pedido.precio, undefined, 'la empresa no ve dinero');
  }
  let lista = (await beto('GET', '/api/empresa/pedidos')).j;
  const rosa = lista.pedidos.find((p) => p.cliente_nombre === 'Rosa Díaz');
  assert.equal(rosa.estado, 'pendiente');
  assert.equal((await beto('POST', '/api/empresa/enviar', { dia: hoy, modo: 'una_moto' })).status, 400, 'solo 9 confirmados');
  // Rosa llena su enlace: fuera de las zonas con tarifa fija (Q45) y paga por transferencia
  const token = rosa.enlace.split('/').pop();
  const anon = cliente();
  assert.equal((await anon('GET', `/api/pedido/${token}`)).j.empresa, 'Tienda Beto');
  const conf = await anon('POST', `/api/pedido/${token}`, { dia: hoy, horario: 'manana', direccion: 'Colonia lejana', zona: 'Otra zona o municipio', lat: CERCA.lat, lng: CERCA.lng, recibe_nombre: 'Rosa Díaz', recibe_telefono: '55557001', metodo_pago: 'transferencia' });
  assert.equal(conf.status, 200, JSON.stringify(conf.j)); assert.equal(conf.j.precio.precio, 45);
  assert.equal((await beto('POST', '/api/empresa/enviar', { dia: hoy, modo: 'una_moto' })).status, 400, 'falta la foto del pedido de Rosa');
  assert.equal((await beto('POST', `/api/empresa/pedidos/${rosa.id}/foto`, { foto: FOTO })).status, 200);
  const rec = await beto('GET', `/api/empresa/recomendacion?dia=${hoy}`);
  assert.equal(rec.status, 200); assert.ok(['una_moto', 'motos'].includes(rec.j.recomendacion.modo));
  const env = await beto('POST', '/api/empresa/enviar', { dia: hoy, modo: 'motos', recogida: 'empresa' });
  assert.equal(env.status, 201, JSON.stringify(env.j)); assert.equal(env.j.pedidos, 10);
  assert.equal((await anon('POST', `/api/pedido/${token}`, { dia: hoy, horario: 'tarde', direccion: 'x', zona: 'Zona 16', lat: CERCA.lat, lng: CERCA.lng, recibe_nombre: 'Rosa', recibe_telefono: '55557001', metodo_pago: 'efectivo' })).status, 400, 'ya no se cambia');
  // Panel: la empresa aparece primero, se calculan 2 rutas y se confirman
  const emp = (await admin('GET', '/api/admin/empresas-activas')).j;
  assert.equal(emp.empresas[0].empresa_nombre, 'Tienda Beto'); assert.equal(emp.empresas[0].lotes_nuevos, 1);
  const calc = await admin('POST', `/api/admin/lotes-empresa/${env.j.lote}/calcular`, { modo: 'motos', motos: 2 });
  assert.equal(calc.j.rutas.length, 2);
  assert.equal(calc.j.rutas.reduce((t, r) => t + r.pedidos.length, 0), 10);
  const rutas = calc.j.rutas.map((r, i) => ({ pedidos: r.pedidos, piloto_id: i === 0 ? pilotoId : null }));
  const sinPago = await admin('POST', `/api/admin/lotes-empresa/${env.j.lote}/confirmar`, { modo: 'motos', rutas });
  assert.equal(sinPago.status, 400); assert.match(sinPago.j.error, /transferencia/);
  assert.equal((await admin('POST', `/api/admin/pedidos/${rosa.id}/pago`, { accion: 'transferencia_ok' })).status, 200);
  const ok = await admin('POST', `/api/admin/lotes-empresa/${env.j.lote}/confirmar`, { modo: 'motos', rutas });
  assert.equal(ok.status, 200, JSON.stringify(ok.j)); assert.equal(ok.j.envios, 10);
  const rosaEnvio = db.prepare('SELECT * FROM envios WHERE pedido_id = ?').get(rosa.id);
  assert.equal(rosaEnvio.guia, rosa.codigo, 'el código del pedido es la guía'); assert.equal(rosaEnvio.precio, 45); assert.equal(rosaEnvio.metodo_pago, 'transferencia');
  // Ruta del piloto: la acepta completa, recoge escaneando y entrega en orden
  const ruta1 = db.prepare('SELECT * FROM envios WHERE lote_empresa_id = ? AND mensajero_id = ? ORDER BY parada').all(env.j.lote, pilotoId);
  assert.equal(ruta1.length, rutas[0].pedidos.length);
  assert.ok(ruta1[0].grupo && ruta1.every((e, i) => e.parada === i + 1));
  if (ruta1.some((e) => e.horario === 'tarde')) assert.equal(ruta1[ruta1.length - 1].horario, 'tarde', 'la tarde va al final');
  const acepta = await piloto('POST', `/api/piloto/envios/${ruta1[0].id}/aceptar`, { lat: LOCAL.lat, lng: LOCAL.lng });
  assert.equal(acepta.status, 200, JSON.stringify(acepta.j)); assert.equal(acepta.j.aceptados, ruta1.length);
  const lejos = await piloto('POST', `/api/piloto/ruta/${ruta1[0].grupo}/recoger`, { ids: ruta1.map((e) => e.id), lat: CERCA.lat, lng: CERCA.lng });
  assert.equal(lejos.status, 400, 'lejos del local');
  const rec2 = await piloto('POST', `/api/piloto/ruta/${ruta1[0].grupo}/recoger`, { ids: ruta1.map((e) => e.id), lat: LOCAL.lat, lng: LOCAL.lng });
  assert.equal(rec2.status, 200, JSON.stringify(rec2.j)); assert.equal(rec2.j.faltan, 0);
  assert.ok(fila(ruta1[0].id).aviso_proximo, 'a la primera parada le llega "eres la próxima"');
  const lp = (await piloto('GET', '/api/piloto/envios')).j.envios.find((e) => e.id === ruta1[0].id);
  assert.equal(lp.empresa, 'Tienda Beto'); assert.equal(lp.parada, 1);
  const p1 = fila(ruta1[0].id);
  const ent = await piloto('POST', `/api/piloto/envios/${p1.id}/estado`, { estado: 'entregado', codigo: p1.codigo_entrega, recibio: 'Recibe', foto: FOTO, lat: p1.destino_lat, lng: p1.destino_lng });
  assert.equal(ent.status, 200, JSON.stringify(ent.j));
  if (ruta1.length > 1) {
    assert.ok(fila(ruta1[1].id).aviso_proximo, 'la siguiente parada recibe "eres el próximo"');
    const p2 = fila(ruta1[1].id);
    const no = await piloto('POST', `/api/piloto/envios/${p2.id}/no-entregado`, { motivo: 'no_esta', lat: p2.destino_lat, lng: p2.destino_lng });
    assert.equal(no.status, 200); assert.equal(no.j.sede, true);
    assert.equal(fila(p2.id).estado, 'a_sede', 'pedido de empresa no entregado va directo a la sede');
    assert.equal((await beto('POST', `/api/envios/${p2.id}/decidir`, { decision: 'devolver' })).status, 400);
  }
  const vista = (await anon('GET', `/api/pedido/${db.prepare('SELECT token FROM pedidos_empresa WHERE id = ?').get(ruta1[0].pedido_id).token}`)).j;
  assert.equal(vista.envio.estado, 'entregado');
  // La empresa no ve sus pedidos en "Mis envíos" ni dinero en su analítica
  assert.ok(!(await beto('GET', '/api/envios')).j.envios.some((e) => e.pedido_id));
  const st = (await beto('GET', '/api/empresa/estadisticas')).j;
  assert.equal(st.general.gasto, undefined); assert.equal(st.cargos_pendientes, undefined);
  assert.equal((await beto('GET', `/api/empresa/excel?dia=${hoy}`)).status, 200);
  // Ficha de la empresa en el panel
  const ficha = (await admin('GET', `/api/admin/empresas-activas/${db.prepare("SELECT id FROM usuarios WHERE email = 'beto@prueba.com'").get().id}`)).j;
  assert.ok(ficha.en_ruta.length >= 1);
});

test('sueldo del piloto: neto del día, "Ya fue pagado", cierre del día con Excel y buscador', async () => {
  const s = (await admin('GET', '/api/admin/sueldos')).j;
  const c = s.pilotos.find((p) => p.id === pilotoId);
  assert.ok(c, 'el piloto tiene cuenta pendiente');
  assert.equal(c.neto, Math.round((c.ganancia - c.descuentos - c.efectivo) * 100) / 100);
  assert.equal((await admin('POST', `/api/admin/sueldos/${pilotoId}/pagado`, { neto: c.neto + 1 })).status, 409, 'si la cuenta cambió, no se cierra');
  assert.equal((await admin('POST', `/api/admin/sueldos/${pilotoId}/pagado`, { neto: c.neto })).status, 200);
  const despues = (await admin('GET', `/api/admin/sueldos/${pilotoId}`)).j;
  assert.equal(despues.cuenta.envios, 0); assert.equal(despues.historial[0].neto, c.neto);
  const g = (await piloto('GET', '/api/piloto/ganancias')).j;
  assert.equal(g.cuenta.neto, 0); assert.equal(g.cuentas[0].neto, c.neto);
  assert.equal((await piloto('PUT', '/api/piloto/frecuencia', { frecuencia: 'semanal' })).status, 200);
  // Operadores no pueden marcar pagos
  const cierre = await admin('POST', '/api/admin/cierres', {});
  assert.equal(cierre.status, 201, JSON.stringify(cierre.j));
  const lista = (await admin('GET', '/api/admin/cierres')).j;
  assert.equal(lista.cierres[0].id, cierre.j.id);
  const r = await fetch(`${BASE}/api/admin/cierres/${cierre.j.id}/excel`, { headers: { Cookie: '' } });
  assert.equal(r.status, 401, 'el Excel pide sesión de administrador');
  for (const periodo of ['semana', 'mes', 'anio']) assert.equal((await admin('GET', `/api/admin/reporte-excel?periodo=${periodo}`)).status, 200);
  const b = (await admin('GET', '/api/admin/buscar?q=Carlos')).j;
  assert.equal(b.pilotos[0].id, pilotoId); assert.equal(typeof b.pilotos[0].neto, 'number');
  const guia = db.prepare('SELECT guia FROM envios ORDER BY id DESC LIMIT 1').get().guia;
  assert.equal((await admin('GET', `/api/admin/buscar?q=${guia.slice(0, 7)}`)).j.envios.some((e) => e.guia === guia), true);
});
