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
const { servidor, hashPassword, asignacionAutomatica, decisionesVencidas, push, recordarEfectivo } = require('../server');

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

test('si la entrega queda lejos se cobra la tarifa fija de fuera (Q45), sin km', async () => {
  const r = await ana('POST', '/api/envios', { vehiculo_id: 1, peso: 2, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    destino_nombre: 'Luis', destino_telefono: '55554444', destino_direccion: 'x', metodo_pago: 'efectivo', foto_paquete: FOTO });
  assert.equal(r.j.precio, 35);
  const token = r.j.enlace_receptor.split('/').pop();
  await cliente()('POST', `/api/recibe/${token}/confirmar`, { nombre: 'Luis Gómez', lat: LEJOS.lat, lng: LEJOS.lng });
  const e = fila(r.j.id);
  assert.equal(e.tipo_tarifa, 'km', 'en la base, km = fuera de zonas');
  assert.equal(e.precio, 45, 'fuera de zonas: Q45 fijo');
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
  assert.equal(c.j.tipo, 'fuera'); assert.equal(c.j.precio, 45);
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

test('solo efectivo: ya no hay transferencia ni pago a fin de mes', async () => {
  const base = { vehiculo_id: 1, peso: 2, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    destino_nombre: 'Luis', destino_telefono: '55554444', destino_direccion: 'x', foto_paquete: FOTO };
  assert.equal((await ana('POST', '/api/envios', { ...base, metodo_pago: 'transferencia' })).status, 400);
  assert.equal((await ana('POST', '/api/envios', { ...base, metodo_pago: 'credito' })).status, 400);
  const r = await ana('POST', '/api/envios', { ...base, metodo_pago: 'efectivo', valor_declarado: 900 });
  assert.equal(r.status, 201);
  assert.equal(fila(r.j.id).valor_declarado, 0, 'ya no se guarda el valor del contenido');
  assert.equal((await admin('POST', `/api/admin/envios/${r.j.id}/asignar`, { mensajero_id: pilotoId })).status, 200);
});

test('caja de envíos: varios destinatarios en un solo viaje, cada uno con su enlace', async () => {
  const comun = { vehiculo_id: 1, metodo_pago: 'efectivo', origen_zona: 'Zona 1', origen_telefono: '55551111', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng, origen_quien: 'cliente' };
  const uno = { peso: 1, foto_paquete: FOTO, destino_nombre: 'Luis', destino_telefono: '55554444', destino_zona: 'Zona 16' };
  const sinFoto = await ana('POST', '/api/envios/caja', { ...comun, envios: [uno, { ...uno, foto_paquete: null, destino_nombre: 'Marta' }] });
  assert.equal(sinFoto.status, 400); assert.match(sinFoto.j.error, /Marta/);
  const r = await ana('POST', '/api/envios/caja', { ...comun, envios: [uno, { ...uno, destino_nombre: 'Marta', destino_telefono: '55553333' }] });
  assert.equal(r.status, 201, JSON.stringify(r.j));
  assert.equal(r.j.envios.length, 2);
  assert.ok(r.j.envios.every((e) => /^\/recibe\/[a-f0-9]+$/.test(e.enlace_receptor)), 'cada quien recibe tiene su enlace');
  const [a, b] = r.j.envios.map((e) => fila(e.id));
  assert.ok(a.grupo && a.grupo === b.grupo, 'van juntos en un solo viaje');
  assert.equal(b.destino_nombre, 'Marta');
  db.prepare("UPDATE envios SET estado = 'cancelado' WHERE grupo = ?").run(a.grupo);
});

test('hasta 3 paquetes en un envío: mismo precio, peso sumado y foto de cada uno', async () => {
  const base = { vehiculo_id: 1, peso: 2, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng, metodo_pago: 'efectivo',
    destino_nombre: 'Luis', destino_telefono: '55554444', foto_paquete: FOTO };
  const solo = await ana('POST', '/api/envios', base);
  const sinFoto = await ana('POST', '/api/envios', { ...base, extras: [{ peso: 3 }] });
  assert.equal(sinFoto.status, 400); assert.match(sinFoto.j.error, /paquete 2/);
  const cuatro = await ana('POST', '/api/envios', { ...base, extras: [1, 2, 3].map(() => ({ peso: 1, foto: FOTO })) });
  assert.equal(cuatro.status, 400);
  const r = await ana('POST', '/api/envios', { ...base, extras: [{ peso: 3, descripcion: 'ropa', foto: FOTO }, { peso: 1, foto: FOTO }] });
  assert.equal(r.status, 201, JSON.stringify(r.j));
  assert.equal(r.j.precio, solo.j.precio, 'mismo precio');
  const e = fila(r.j.id);
  assert.equal(e.peso, 6); assert.equal(e.paquetes, 3);
  const d = await ana('GET', `/api/envios/${r.j.id}`);
  assert.deepEqual(d.j.envio.paquetes_extra.map((x) => [x.n, x.peso, x.descripcion]), [[2, 3, 'ropa'], [3, 1, null]]);
  assert.equal(d.j.envio.peso_paquete1, 2);
  assert.equal((await ana('GET', `/api/envios/${r.j.id}/paquete/2`)).status, 200);
  db.prepare("UPDATE envios SET estado = 'cancelado' WHERE id IN (?, ?)").run(r.j.id, solo.j.id);
});

test('cuenta personal: "paga quien recibe" y quien recibe ve cuánto paga', async () => {
  const comun = { vehiculo_id: 1, metodo_pago: 'recibe', origen_zona: 'Zona 1', origen_telefono: '55551111', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng, origen_quien: 'cliente' };
  const uno = { peso: 1, foto_paquete: FOTO, destino_nombre: 'Luis', destino_telefono: '55554444', destino_zona: 'Zona 16' };
  const r = await ana('POST', '/api/envios/caja', { ...comun, envios: [uno, { ...uno, destino_nombre: 'Marta' }, { ...uno, destino_nombre: 'Rosa' }, { ...uno, destino_nombre: 'Juan' }] });
  assert.equal(r.status, 201, JSON.stringify(r.j));
  assert.equal(r.j.envios.length, 4);
  const e = fila(r.j.envios[0].id);
  assert.equal(e.metodo_pago, 'recibe');
  const v = await cliente()('GET', '/api/recibe/' + e.receptor_token);
  assert.equal(v.j.cobro, e.precio); assert.equal(v.j.paga_envio, true);
  db.prepare("UPDATE envios SET estado = 'cancelado' WHERE grupo = ?").run(e.grupo);
});

test('oficina: asignar al piloto en línea más cercano con un toque', async () => {
  const r = await ana('POST', '/api/envios', { vehiculo_id: 1, peso: 1, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    destino_nombre: 'Luis', destino_telefono: '55554444', metodo_pago: 'efectivo', foto_paquete: FOTO });
  db.prepare("UPDATE envios SET receptor_omitido = 'prueba' WHERE id = ?").run(r.j.id);
  db.prepare("UPDATE usuarios SET en_linea = 1, ubic_lat = ?, ubic_lng = ?, ubic_fecha = datetime('now') WHERE id = ?").run(ZONA1.lat, ZONA1.lng, pilotoId);
  const x = await admin('POST', `/api/admin/envios/${r.j.id}/asignar-cercano`, {});
  assert.equal(x.status, 200, JSON.stringify(x.j));
  assert.equal(fila(r.j.id).mensajero_id, pilotoId);
  assert.equal((await admin('POST', `/api/admin/envios/${r.j.id}/asignar-cercano`, {})).status, 400, 'ya tiene piloto');
  const det = (await admin('GET', `/api/admin/envios/${r.j.id}`)).j.envio;
  assert.deepEqual(det.reparto, { piloto: 30, bono: 0, vaelo: 5 }, 'Vaelo se queda con Q5');
  await ana('POST', `/api/envios/${r.j.id}/cancelar`, { aceptar_cargo: true });
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

test('carpetas de empresa: añadir envíos, enlace del cliente, enviar a Vaelo, dividir en rutas, avisos y sede', async () => {
  const { crearExcel } = require('../lib/xlsx');
  db.prepare('UPDATE usuarios SET vehiculo_id = 1 WHERE id = ?').run(pilotoId);
  db.prepare("UPDATE envios SET estado = 'cancelado' WHERE estado IN ('pendiente','recogido','en_camino') AND mensajero_id = ?").run(pilotoId);
  const beto = cliente();
  assert.equal((await beto('POST', '/api/login', { email: 'beto@prueba.com', password: 'clave-de-prueba-123' })).status, 200);
  const hoy = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
  const LOCAL = { lat: 14.6420, lng: -90.5150 };
  assert.equal((await beto('PUT', '/api/empresa/punto', { lat: LOCAL.lat, lng: LOCAL.lng, direccion: 'Bodega de Tienda Beto, 6a av' })).status, 200);
  // Carpeta para hoy
  const cr = await beto('POST', '/api/empresa/carpetas', { dia: hoy });
  assert.equal(cr.status, 201, JSON.stringify(cr.j));
  const carpeta = cr.j.carpeta.id;
  // Excel con dos envíos (quedan esperando que el cliente llene su enlace) y uno que no podrá ese día
  const xls = crearExcel([{ nombre: 'Pedidos', columnas: [{ titulo: 'Descripción' }, { titulo: 'Tamaño' }, { titulo: 'Cliente' }, { titulo: 'WhatsApp' }],
    filas: [['Camisa', 'Pequeño', 'Rosa Díaz', '55557001'], ['Factura', 'Sobre', 'Juan Paz', '55557002']] }]);
  const sub = await beto('POST', `/api/empresa/carpetas/${carpeta}/archivo`, { archivo: 'data:application/octet-stream;base64,' + xls.toString('base64') });
  assert.equal(sub.status, 201, JSON.stringify(sub.j)); assert.equal(sub.j.creados, 2);
  // 9 pedidos que llena la empresa, cerca de su local (Zona 1: Q35)
  const puntos = Array.from({ length: 9 }, (_, i) => ({ lat: 14.632 + (i % 3) * 0.006, lng: -90.528 + Math.floor(i / 3) * 0.009 }));
  for (const [i, pt] of puntos.entries()) {
    const r = await beto('POST', `/api/empresa/carpetas/${carpeta}/pedidos`, { descripcion: 'Paquete ' + i, tamano: i === 0 ? 'mediano' : 'sobre', cliente_nombre: 'Cliente ' + i, cliente_telefono: '5555800' + i,
      foto: FOTO, llenar: true, dia: hoy, horario: i === 1 ? 'tarde' : 'cualquiera', direccion: 'Casa ' + i, zona: 'Zona 1', lat: pt.lat, lng: pt.lng, recibe_nombre: 'Recibe ' + i, recibe_telefono: '5555900' + i, metodo_pago: 'efectivo' });
    assert.equal(r.status, 201, JSON.stringify(r.j));
    assert.equal(r.j.pedido.estado, 'confirmado'); assert.equal(r.j.pedido.precio, undefined, 'la empresa no ve dinero');
  }
  let lista = (await beto('GET', `/api/empresa/carpetas/${carpeta}`)).j.carpeta;
  assert.equal(lista.confirmados, 9); assert.equal(lista.total, 11);
  const rosa = lista.pedidos.find((p) => p.cliente_nombre === 'Rosa Díaz'), juan = lista.pedidos.find((p) => p.cliente_nombre === 'Juan Paz');
  assert.equal(rosa.estado, 'pendiente');
  assert.equal((await beto('POST', `/api/empresa/carpetas/${carpeta}/enviar`, { modo: 'una_moto' })).status, 400, 'solo 9 confirmados');
  // Juan no puede ese día
  const anon = cliente();
  assert.equal((await anon('POST', `/api/pedido/${juan.enlace.split('/').pop()}/no-puedo`, { nota: 'Mejor el viernes' })).status, 200);
  // Rosa confirma con su enlace: el día es el de la carpeta (aunque mande otro), fuera de las zonas con tarifa fija (Q45), paga en efectivo
  const token = rosa.enlace.split('/').pop();
  const vistaRosa = (await anon('GET', `/api/pedido/${token}`)).j;
  assert.equal(vistaRosa.empresa, 'Tienda Beto'); assert.equal(vistaRosa.dia_fijo, hoy);
  const conf = await anon('POST', `/api/pedido/${token}`, { dia: '2099-01-01', horario: 'manana', direccion: 'Colonia lejana', zona: 'Otra zona o municipio', lat: CERCA.lat, lng: CERCA.lng, recibe_nombre: 'Rosa Díaz', recibe_telefono: '55557001' });
  assert.equal(conf.status, 200, JSON.stringify(conf.j)); assert.equal(conf.j.precio.precio, 45);
  assert.equal(db.prepare('SELECT dia, metodo_pago FROM pedidos_empresa WHERE id = ?').get(rosa.id).dia, hoy);
  assert.equal((await beto('POST', `/api/empresa/carpetas/${carpeta}/enviar`, { modo: 'una_moto' })).status, 400, 'falta la foto del pedido de Rosa');
  assert.equal((await beto('POST', `/api/empresa/pedidos/${rosa.id}/foto`, { foto: FOTO })).status, 200);
  const rec = await beto('GET', `/api/empresa/carpetas/${carpeta}/recomendacion`);
  assert.equal(rec.status, 200); assert.ok(['una_moto', 'motos'].includes(rec.j.recomendacion.modo));
  const env = await beto('POST', `/api/empresa/carpetas/${carpeta}/enviar`, { modo: 'motos', recogida: 'empresa' });
  assert.equal(env.status, 201, JSON.stringify(env.j)); assert.equal(env.j.pedidos, 10); assert.equal(env.j.pendientes, 1, 'Juan pasa a una carpeta nueva');
  // Juan (no podía) se mueve a otra carpeta: queda esperando que confirme la nueva fecha
  const otra = (await beto('POST', '/api/empresa/carpetas', { dia: new Date(Date.now() - 6 * 3600_000 + 2 * 86400_000).toISOString().slice(0, 10) })).j.carpeta;
  const mov = await beto('PUT', `/api/empresa/pedidos/${juan.id}/carpeta`, { carpeta_id: otra.id });
  assert.equal(mov.status, 200, JSON.stringify(mov.j)); assert.equal(mov.j.reconfirmar, true);
  assert.equal(db.prepare('SELECT carpeta_id, estado FROM pedidos_empresa WHERE id = ?').get(juan.id).estado, 'pendiente');
  const carpetas = (await beto('GET', '/api/empresa/carpetas')).j;
  assert.equal(carpetas.enviadas[0].id, carpeta);
  assert.ok(carpetas.abiertas.some((c) => c.id === otra.id && c.total === 1));
  assert.equal((await anon('POST', `/api/pedido/${token}`, { horario: 'tarde', direccion: 'x', zona: 'Zona 16', lat: CERCA.lat, lng: CERCA.lng, recibe_nombre: 'Rosa', recibe_telefono: '55557001' })).status, 400, 'ya no se cambia');
  // Panel: la empresa aparece primero, se calculan 2 rutas y se confirman
  const emp = (await admin('GET', '/api/admin/empresas-activas')).j;
  assert.equal(emp.empresas[0].empresa_nombre, 'Tienda Beto'); assert.equal(emp.empresas[0].lotes_nuevos, 1);
  const calc = await admin('POST', `/api/admin/lotes-empresa/${env.j.lote}/calcular`, { modo: 'motos', motos: 2 });
  assert.equal(calc.j.rutas.length, 2);
  assert.equal(calc.j.rutas.reduce((t, r) => t + r.pedidos.length, 0), 10);
  const rutas = calc.j.rutas.map((r, i) => ({ pedidos: r.pedidos, piloto_id: i === 0 ? pilotoId : null }));
  const ok = await admin('POST', `/api/admin/lotes-empresa/${env.j.lote}/confirmar`, { modo: 'motos', rutas });
  assert.equal(ok.status, 200, JSON.stringify(ok.j)); assert.equal(ok.j.envios, 10);
  const rosaEnvio = db.prepare('SELECT * FROM envios WHERE pedido_id = ?').get(rosa.id);
  assert.equal(rosaEnvio.guia, rosa.codigo, 'el código del pedido es la guía'); assert.equal(rosaEnvio.precio, 45); assert.equal(rosaEnvio.metodo_pago, 'recibe');
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

test('administración: eliminar una cuenta de prueba deja libre su correo y teléfono', async () => {
  const pr = cliente();
  assert.equal((await pr('POST', '/api/registro', { nombre: 'Prueba Borrar', email: 'borrar@prueba.com', telefono: '55990011', password: 'clave-de-prueba-123', acepto_terminos: true })).status, 201);
  const id = db.prepare("SELECT id FROM usuarios WHERE email = 'borrar@prueba.com'").get().id;
  const e = await pr('POST', '/api/envios', { vehiculo_id: 1, peso: 1, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    metodo_pago: 'efectivo', destino_nombre: 'Luis', destino_telefono: '55554444', foto_paquete: FOTO });
  assert.equal(e.status, 201, JSON.stringify(e.j));
  assert.equal((await ana('GET', `/api/admin/usuarios/${id}/eliminar`)).status, 403, 'solo administración');
  const r = await admin('GET', `/api/admin/usuarios/${id}/eliminar`);
  assert.equal(r.j.envios, 1); assert.equal(r.j.envios_en_curso, 1);
  assert.equal((await admin('POST', `/api/admin/usuarios/${id}/eliminar`, { confirmar: 'otro@correo.com' })).status, 400, 'pide escribir el correo');
  const yo = db.prepare("SELECT id FROM usuarios WHERE rol = 'admin'").get().id;
  assert.equal((await admin('POST', `/api/admin/usuarios/${yo}/eliminar`, { confirmar: 'administracionvaelo@vaelomensajeria.com' })).status, 400, 'no se borra a sí mismo');
  const ok = await admin('POST', `/api/admin/usuarios/${id}/eliminar`, { confirmar: 'BORRAR@prueba.com' });
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM usuarios WHERE id = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM envios WHERE id = ?').get(e.j.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos WHERE envio_id = ?').get(e.j.id).n, 0);
  // Se puede registrar otra vez con el mismo correo y teléfono
  assert.equal((await cliente()('POST', '/api/registro', { nombre: 'Prueba Borrar', email: 'borrar@prueba.com', telefono: '55990011', password: 'clave-de-prueba-123', acepto_terminos: true })).status, 201);
});

test('administración: eliminar un piloto devuelve sus envíos en curso a buscar piloto', async () => {
  const h = hashPassword('clave-de-prueba-123');
  const pid = Number(db.prepare("INSERT INTO usuarios (nombre,email,telefono,password_hash,rol,email_verificado,verificacion,estado_piloto) VALUES ('Piloto Prueba','pp@prueba.com','55001122',?,'mensajero',1,'verificado','aprobado')").run(h).lastInsertRowid);
  const e = await ana('POST', '/api/envios', { vehiculo_id: 1, peso: 1, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    metodo_pago: 'efectivo', destino_nombre: 'Luis', destino_telefono: '55554444', foto_paquete: FOTO });
  db.prepare("UPDATE envios SET mensajero_id = ?, estado = 'recogido' WHERE id = ?").run(pid, e.j.id);
  const ok = await admin('POST', `/api/admin/usuarios/${pid}/eliminar`, { confirmar: 'pp@prueba.com' });
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  const f = db.prepare('SELECT estado, mensajero_id FROM envios WHERE id = ?').get(e.j.id);
  assert.equal(f.estado, 'pendiente'); assert.equal(f.mensajero_id, null);
  db.prepare("UPDATE envios SET estado = 'cancelado' WHERE id = ?").run(e.j.id);
});

test('bono para empresas: suma al entregar, la empresa solo ve lo suyo y administración lo liquida', async () => {
  const em = cliente();
  assert.equal((await em('POST', '/api/registro', { nombre: 'Tienda Bono', email: 'bono@prueba.com', telefono: '55660011', password: 'clave-de-prueba-123', acepto_terminos: true })).status, 201);
  const uid = db.prepare("SELECT id FROM usuarios WHERE email = 'bono@prueba.com'").get().id;
  assert.equal((await admin('PUT', `/api/admin/clientes/${uid}/empresa`, { tipo_cuenta: 'empresa', empresa_nombre: 'Tienda Bono' })).status, 200);
  assert.equal((await admin('PUT', '/api/admin/ajustes', { bono_empresa: 9 })).status, 400, 'no más de Q5');
  assert.equal((await admin('PUT', '/api/admin/ajustes', { bono_empresa: 1 })).status, 200);
  const nuevo = () => em('POST', '/api/envios', { vehiculo_id: 1, peso: 1, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    metodo_pago: 'efectivo', destino_nombre: 'Luis', destino_telefono: '55554444', foto_paquete: FOTO });
  const cero = await nuevo();
  await admin('POST', `/api/admin/envios/${cero.j.id}/estado`, { estado: 'entregado', nota: 'prueba' });
  assert.deepEqual((await em('GET', '/api/empresa/bono')).j, { activo: false }, 'sin activar no gana ni ve nada');
  assert.equal((await admin('PUT', `/api/admin/bonos/${uid}`, { bono_envio: '', bono_modo: 'pago', bono_activo: true })).status, 200);
  const a = await nuevo(); const b = await nuevo(); const c = await nuevo();
  assert.equal(a.status, 201, JSON.stringify(a.j));
  await admin('POST', `/api/admin/envios/${a.j.id}/estado`, { estado: 'entregado', nota: 'prueba' });
  await admin('POST', `/api/admin/envios/${c.j.id}/estado`, { estado: 'cancelado', nota: 'prueba' });
  // Monto propio de Q2 para esta empresa: el siguiente entregado suma Q2
  assert.equal((await admin('PUT', `/api/admin/bonos/${uid}`, { bono_envio: 2, bono_modo: 'descuento', bono_activo: true })).status, 200);
  await admin('POST', `/api/admin/envios/${b.j.id}/estado`, { estado: 'entregado', nota: 'prueba' });
  const v = await em('GET', '/api/empresa/bono');
  assert.equal(v.j.pendiente, 3); assert.equal(v.j.entregas_pendientes, 2); assert.equal(v.j.por_envio, 2); assert.equal(v.j.modo, 'descuento');
  const texto = JSON.stringify(v.j);
  assert.ok(!/precio|vaelo|ganancia_piloto|comision/i.test(texto), 'la empresa no ve las cifras de Vaelo');
  assert.equal((await em('GET', '/api/admin/bonos')).status, 403);
  const l = await admin('POST', `/api/admin/bonos/${uid}/liquidar`, {});
  assert.equal(l.status, 200); assert.equal(l.j.pendiente, 0); assert.equal(l.j.recibido, 3);
  assert.equal((await admin('POST', `/api/admin/bonos/${uid}/liquidar`, {})).status, 400, 'nada pendiente');
  await admin('PUT', '/api/admin/ajustes', { bono_empresa: 0 });
});

test('control del panel: historial, permisos de empleados, estrellas de quien recibe, atascados y estado de cuenta', async () => {
  // Empleado con permiso solo para Envíos
  assert.equal((await admin('POST', '/api/admin/operadores', { nombre: 'Oficina Uno', email: 'oficina1@prueba.com', password: 'clave-larga-123' })).status, 201);
  const opId = db.prepare("SELECT id FROM usuarios WHERE email = 'oficina1@prueba.com'").get().id;
  assert.equal((await admin('PUT', `/api/admin/operadores/${opId}`, { permisos: [] })).status, 400, 'al menos un área');
  assert.equal((await admin('PUT', `/api/admin/operadores/${opId}`, { permisos: ['envios'] })).status, 200);
  const op = cliente();
  assert.equal((await op('POST', '/api/acceso-familia', { email: 'oficina1@prueba.com', password: 'clave-larga-123' })).status, 200);
  assert.equal((await op('GET', '/api/admin/envios')).status, 200);
  assert.equal((await op('GET', '/api/admin/clientes')).status, 403, 'sin permiso de Clientes');
  assert.equal((await op('GET', '/api/admin/historial')).status, 403, 'el historial es solo de administración');
  assert.deepEqual((await op('GET', '/api/admin/resumen')).j.permisos, ['envios']);
  // Una acción del empleado queda en el historial y le avisa a la administración
  const e = await ana('POST', '/api/envios', { vehiculo_id: 1, peso: 1, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    metodo_pago: 'efectivo', destino_nombre: 'Luis', destino_telefono: '55554444', foto_paquete: FOTO });
  db.prepare('UPDATE envios SET mensajero_id = ? WHERE id = ?').run(pilotoId, e.j.id);
  const antes = (await admin('GET', '/api/admin/historial')).j.ultimo;
  assert.equal((await op('POST', `/api/admin/envios/${e.j.id}/estado`, { estado: 'entregado', nota: 'llamó el cliente' })).status, 200);
  const h = (await admin('GET', '/api/admin/historial?q=Oficina')).j.acciones[0];
  assert.match(h.accion, /Cambió a mano el estado a «Entregado»/); assert.match(h.detalle, /Envío VA-/); assert.equal(h.rol, 'operador');
  assert.equal((await admin('GET', `/api/admin/nuevos?desde=0&h=${antes}`)).j.historial.n, 1);
  // Quien recibe califica al piloto y cuenta en su promedio
  const tok = db.prepare('SELECT receptor_token FROM envios WHERE id = ?').get(e.j.id).receptor_token;
  const vista = await cliente()('GET', '/api/recibe/' + tok);
  assert.equal(vista.j.puede_calificar, true);
  assert.equal((await cliente()('POST', `/api/recibe/${tok}/calificar`, { estrellas: 2, comentario: 'Llegó tarde' })).status, 200);
  assert.equal((await cliente()('POST', `/api/recibe/${tok}/calificar`, { estrellas: 5 })).status, 400, 'una sola vez');
  const ficha = (await admin('GET', `/api/admin/mensajeros/${pilotoId}`)).j;
  assert.ok(ficha.estrellas.total >= 1); assert.ok(ficha.estrellas.ultimas.some((x) => x.de === 'Quien recibió' && x.comentario === 'Llegó tarde'));
  // Atascados: un envío sin piloto de hace 20 minutos aparece
  const v = await ana('POST', '/api/envios', { vehiculo_id: 1, peso: 1, origen_zona: 'Zona 1', destino_zona: 'Zona 16', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    metodo_pago: 'efectivo', destino_nombre: 'Rosa', destino_telefono: '55554444', foto_paquete: FOTO });
  db.prepare("UPDATE envios SET creado = datetime('now', '-20 minutes'), mensajero_id = NULL WHERE id = ?").run(v.j.id);
  assert.ok((await admin('GET', '/api/admin/nuevos')).j.atascados.some((x) => x.id === v.j.id && x.motivo === 'sin_piloto'));
  db.prepare("UPDATE envios SET estado = 'cancelado' WHERE id = ?").run(v.j.id);
  // Estado de cuenta en Excel de una empresa con recogida fija y NIT
  const beto = db.prepare("SELECT id FROM usuarios WHERE tipo_cuenta = 'empresa' LIMIT 1").get();
  if (beto) {
    assert.equal((await admin('PUT', `/api/admin/clientes/${beto.id}/empresa`, { tipo_cuenta: 'empresa', empresa_nombre: 'Tienda', recogida_dias: '1,4', recogida_hora: '09:30', fact_nit: '1234567-8', fact_nombre: 'Tienda S.A.' })).status, 200);
    const f = await fetch(`${BASE}/api/admin/empresas/${beto.id}/estado-cuenta?mes=2026-11`, { headers: { cookie: '' } });
    assert.equal(f.status, 401);
    assert.equal((await admin('GET', `/api/admin/empresas/${beto.id}/estado-cuenta?mes=2026-11`)).status, 200);
  }
});

test('flete con ayudantes: Q50 cada uno, hasta 5, suma al total y el piloto gana solo sobre el flete', async () => {
  db.prepare('UPDATE usuarios SET vehiculo_id = ? WHERE id = ?').run(db.prepare("SELECT id FROM vehiculos WHERE solo_oficina = 1").get().id, pilotoId);
  assert.equal((await admin('GET', '/api/admin/fletes/config')).j.precio_ayudante, 50);
  assert.equal((await admin('POST', '/api/admin/fletes', { vehiculo_id: 2, mensajero_id: pilotoId, precio: 300, ayudantes: 6 })).status, 400);
  const r = await admin('POST', '/api/admin/fletes', { vehiculo_id: 2, mensajero_id: pilotoId, precio: 300, ayudantes: 2, cliente_telefono: '55557777' });
  assert.equal(r.status, 201, JSON.stringify(r.j));
  const e = db.prepare('SELECT precio, ayudantes, ayudantes_monto, flete_precio, ganancia_piloto FROM envios WHERE id = ?').get(r.j.id);
  assert.deepEqual({ ...e }, { precio: 400, ayudantes: 2, ayudantes_monto: 100, flete_precio: 300, ganancia_piloto: 295 });
  const f = (await cliente()('GET', '/api/flete/' + r.j.enlace.split('/').pop())).j;
  assert.equal(f.precio, 400); assert.equal(f.ayudantes, 2); assert.equal(f.flete_precio, 300); assert.equal(f.precio_ayudante, 50);
  // Solo administración cambia el precio por ayudante
  assert.equal((await admin('PUT', '/api/admin/ajustes', { precio_ayudante: 60 })).status, 200);
  assert.equal((await admin('GET', '/api/admin/fletes/config')).j.precio_ayudante, 60);
  assert.equal((await cliente()('PUT', '/api/admin/ajustes', { precio_ayudante: 1 })).status >= 400, true);
  await admin('PUT', '/api/admin/ajustes', { precio_ayudante: 50 });
  db.prepare("UPDATE envios SET estado = 'cancelado' WHERE id = ?").run(r.j.id);
});

test('zona preferencial mal elegida: al compartir quien recibe su ubicación real fuera de las zonas, el precio se corrige y se avisa', async () => {
  const z = db.prepare("SELECT id FROM zonas_fijas WHERE nombre = 'Zona 1'").get().id;
  const forma = [[-90.53, 14.63], [-90.50, 14.63], [-90.50, 14.65], [-90.53, 14.65]];
  await admin('PUT', `/api/admin/zonas/${z}`, { poligono: forma });
  // El cliente dice que entrega en Zona 1 (preferencial) sin ubicación del destino: se cotiza Q35
  const e = await ana('POST', '/api/envios', { vehiculo_id: 1, peso: 1, origen_zona: 'Zona 1', destino_zona: 'Zona 1', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    metodo_pago: 'efectivo', destino_nombre: 'Marta', destino_telefono: '55554444', foto_paquete: FOTO });
  assert.equal(e.status, 201, JSON.stringify(e.j));
  assert.equal(fila(e.j.id).precio, 35);
  // Marta comparte su ubicación real, lejos (fuera de la forma de Zona 1)
  const tok = db.prepare('SELECT receptor_token FROM envios WHERE id = ?').get(e.j.id).receptor_token;
  assert.equal((await cliente()('POST', `/api/recibe/${tok}/confirmar`, { nombre: 'Marta López', lat: 14.55, lng: -90.70 })).status, 200);
  const f = fila(e.j.id);
  assert.equal(f.precio, 45); assert.equal(f.tipo_tarifa, 'km');
  assert.equal(f.destino_zona, 'Otra zona o municipio', 'el nombre de la zona se corrige con la ubicación real');
  assert.ok(db.prepare("SELECT 1 FROM eventos WHERE envio_id = ? AND nota LIKE 'Zona corregida%eligieron Zona 1%'").get(e.j.id));
  // El piloto ve la ruta completa (él → recoger → entregar) antes de aceptar
  db.prepare("UPDATE envios SET mensajero_id = ?, asignacion = 'por_aceptar' WHERE id = ?").run(pilotoId, e.j.id);
  const r = await piloto('GET', `/api/piloto/envios/${e.j.id}/ruta?lat=14.60&lng=-90.52`);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.paradas.map((x) => x.tipo), ['yo', 'recoger', 'entregar']);
  assert.equal(r.j.tramos.length, 2); assert.ok(r.j.linea.length >= 3); assert.ok(r.j.tramos.every((t) => t.km > 0 && t.min > 0));
  const ev = db.prepare('SELECT nota FROM eventos WHERE envio_id = ? ORDER BY id DESC LIMIT 1').get(e.j.id).nota;
  db.prepare("UPDATE envios SET estado = 'cancelado' WHERE id = ?").run(e.j.id);
  await admin('PUT', `/api/admin/zonas/${z}`, { poligono: null });
});

test('rutas de empresa: orden sin cruces y respetando mañana → cualquier hora → tarde', () => {
  const { ordenarParadas } = require('../server');
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const d = (a, b) => { const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  const O = { lat: 14.6196, lng: -90.5156 };
  const s = [['z1', 14.6407, -90.5133, 'manana'], ['z10', 14.5990, -90.5070], ['z15', 14.5925, -90.4890], ['z12', 14.5866, -90.5530], ['z7', 14.6380, -90.5520, 'tarde'], ['mixco', 14.6330, -90.6060],
    ['z18', 14.6560, -90.4740], ['z9', 14.6046, -90.5150, 'manana'], ['z11', 14.6122, -90.5418], ['z16', 14.6100, -90.4720], ['z5', 14.6230, -90.4960], ['z13', 14.5830, -90.5290], ['z6', 14.6560, -90.5070, 'tarde'], ['z14', 14.5800, -90.5100]]
    .map(([n, lat, lng, horario]) => ({ n, lat, lng, horario: horario || 'cualquiera' }));
  const largo = (o) => { let t = 0, a = O; for (const p of o) { t += d(a, p); a = p; } return t; };
  // El orden de antes ("la más cercana primero") hacía 62 km en línea recta con estos 14 puntos
  const orden = ordenarParadas(O, s);
  assert.equal(orden.length, 14);
  assert.ok(largo(orden) < 55, `ruta de ${largo(orden).toFixed(1)} km`);
  const r = { manana: 0, cualquiera: 1, tarde: 2 };
  assert.ok(orden.every((p, i) => i === 0 || r[orden[i - 1].horario] <= r[p.horario]), 'mañana primero y tarde al final');
});

test('hora estimada: solo después de recoger, con ventana de margen, y la ve quien recibe', async () => {
  const lote = db.prepare("SELECT envio_id FROM pedidos_empresa WHERE envio_id IS NOT NULL ORDER BY id DESC LIMIT 1").get();
  assert.ok(lote, 'hay un pedido de empresa con envío');
  const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(lote.envio_id);
  db.prepare("UPDATE envios SET estado = 'recogido', llega_desde = NULL, llega_hasta = NULL WHERE id = ?").run(e.id);
  const { estimarLlegadas } = require('../server');
  await estimarLlegadas({ ...e, grupo: null }, { lat: 14.6420, lng: -90.5150 });
  const f = db.prepare('SELECT llega_desde, llega_hasta FROM envios WHERE id = ?').get(e.id);
  assert.ok(f.llega_desde && f.llega_hasta);
  const minutos = (Date.parse(f.llega_hasta.replace(' ', 'T') + 'Z') - Date.parse(f.llega_desde.replace(' ', 'T') + 'Z')) / 60000;
  assert.ok(minutos >= 30 && minutos <= 60, `margen de ${minutos} min`);
  const tok = db.prepare('SELECT token FROM pedidos_empresa WHERE envio_id = ?').get(e.id).token;
  const vista = (await cliente()('GET', '/api/pedido/' + tok)).j;
  assert.ok(vista.envio.llega && vista.envio.llega.desde, JSON.stringify(vista.envio));
});

test('las páginas no tienen errores de sintaxis en su JavaScript', () => {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const raiz = path.join(__dirname, '..');
  const paginas = [...fs.readdirSync(path.join(raiz, 'public')).filter((f) => f.endsWith('.html')).map((f) => path.join(raiz, 'public', f)),
    ...fs.readdirSync(path.join(raiz, 'privado')).filter((f) => f.endsWith('.html')).map((f) => path.join(raiz, 'privado', f))];
  for (const p of paginas) {
    for (const [, codigo] of fs.readFileSync(p, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new vm.Script(codigo, { filename: path.basename(p) }), `${path.basename(p)} tiene un error de sintaxis`);
    }
  }
  for (const f of fs.readdirSync(path.join(raiz, 'public', 'js')).filter((f) => f.endsWith('.js'))) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(raiz, 'public', 'js', f), 'utf8'), { filename: f }), `${f} tiene un error de sintaxis`);
  }
});

test('documentos por vencer: aviso al piloto 15, 7 y 1 día antes y al vencer, una sola vez cada uno', () => {
  const { avisarVencimientos } = require('../server');
  const hoy = new Date(Date.now() - 6 * 3600_000);
  const en = (d) => new Date(hoy.getTime() + d * 86400_000).toISOString().slice(0, 10);
  db.prepare('DELETE FROM avisos_vencimiento').run();
  db.prepare("UPDATE usuarios SET licencia_vence = ?, seguro_vence = NULL, penales_fecha = NULL, policiacos_fecha = NULL WHERE id = ?").run(en(10), pilotoId);
  avisarVencimientos();
  assert.ok(db.prepare("SELECT 1 FROM avisos_vencimiento WHERE piloto_id = ? AND doc = 'licencia' AND hito = 15").get(pilotoId));
  avisarVencimientos();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM avisos_vencimiento WHERE piloto_id = ?").get(pilotoId).n, 1, 'no se repite');
  db.prepare('UPDATE usuarios SET licencia_vence = ? WHERE id = ?').run(en(1), pilotoId);
  avisarVencimientos();
  assert.ok(db.prepare("SELECT 1 FROM avisos_vencimiento WHERE piloto_id = ? AND hito = 1").get(pilotoId));
  db.prepare('UPDATE usuarios SET licencia_vence = ? WHERE id = ?').run(en(400), pilotoId);
});

test('queja con compensación: descuento solo para ese cliente en su próximo envío; cupones por horas', async () => {
  const e = { id: (await envioEnCamino()).id };
  db.prepare("UPDATE envios SET estado = 'entregado', entregado_en = datetime('now'), piloto_cerro_en = COALESCE(piloto_cerro_en, datetime('now')), ganancia_piloto = COALESCE(ganancia_piloto, 30) WHERE id = ?").run(e.id);
  assert.equal((await ana('POST', `/api/envios/${e.id}/reclamo`, { tipo: 'otro', descripcion: 'El piloto llegó dos horas tarde y fue grosero' })).status, 201);
  const rec = (await admin('GET', '/api/admin/reclamos')).j.reclamos.find((x) => x.envio_id === e.id);
  assert.equal((await admin('POST', `/api/admin/reclamos/${rec.id}`, { accion: 'aprobar', monto_cliente: 0, monto_piloto: 10, cupon_monto: 15, resolucion: 'Se confirmó el retraso con el GPS' })).status, 200);
  const cot = { vehiculo_id: 1, peso: 2, origen_zona: 'Zona 1', destino_zona: 'Zona 1' };
  const conCupon = (await ana('POST', '/api/cotizar', cot)).j;
  assert.equal(conCupon.descuento, 15, JSON.stringify(conCupon));
  const otro = cliente(); await otro('POST', '/api/login', { email: 'lucia@prueba.com', password: 'clave-lucia-123' });
  assert.notEqual((await otro('POST', '/api/cotizar', cot)).j.descuento, 15, 'otro cliente no lo tiene');
  assert.ok(!(await cliente()('GET', '/api/config')).j.promocion || !/Disculpa/.test((await cliente()('GET', '/api/config')).j.promocion.nombre));
  db.prepare('DELETE FROM promociones WHERE reclamo_id = ?').run(rec.id);
  // Cupón por horas: vale solo en su rango de hora
  const ahora = new Date(Date.now() - 6 * 3600_000), hhmm = (d) => d.toISOString().slice(11, 16), dia = (d) => d.toISOString().slice(0, 10);
  const antes = new Date(ahora.getTime() - 3 * 3600_000), desp = new Date(ahora.getTime() - 3600_000);
  assert.equal((await admin('POST', '/api/admin/promociones', { nombre: 'Flash vencida', tipo: 'monto', valor: 7, desde: dia(antes), desde_hora: hhmm(antes), hasta: dia(desp), hasta_hora: hhmm(desp), codigo: 'FLASHX' })).status, 201);
  assert.match((await ana('POST', '/api/cotizar', { ...cot, cupon: 'FLASHX' })).j.error_cupon || '', /venció/);
  const fin = new Date(ahora.getTime() + 2 * 3600_000);
  assert.equal((await admin('POST', '/api/admin/promociones', { nombre: 'Flash 2 horas', tipo: 'monto', valor: 7, desde: dia(antes), desde_hora: hhmm(antes), hasta: dia(fin), hasta_hora: hhmm(fin), codigo: 'FLASH2H' })).status, 201);
  assert.equal((await ana('POST', '/api/cotizar', { ...cot, cupon: 'FLASH2H' })).j.descuento, 7);
  db.prepare("UPDATE promociones SET activa = 0 WHERE codigo IN ('FLASHX','FLASH2H')").run();
});

test('descuentos a fondo: límite de usos total y por cliente, horas, programada, pausada, mínimo, primer envío y cancelados', async () => {
  const cuenta = async (email) => {
    db.prepare("INSERT OR IGNORE INTO usuarios (nombre,email,telefono,password_hash,rol,email_verificado,verificacion) VALUES (?,?,?,?,'cliente',1,'verificado')")
      .run('Cliente ' + email.split('@')[0], email, '5' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0'), await hashPassword('clave-cupon-123'));
    const c = cliente(); assert.equal((await c('POST', '/api/login', { email, password: 'clave-cupon-123' })).status, 200); return c;
  };
  const lucia = await cuenta('cupones@prueba.com');
  const ahora = new Date(Date.now() - 6 * 3600_000), dia = (d) => d.toISOString().slice(0, 10), hh = (d) => d.toISOString().slice(11, 16), mas = (h) => new Date(ahora.getTime() + h * 3600_000);
  const crear = async (p) => { const r = await admin('POST', '/api/admin/promociones', { tipo: 'monto', valor: 10, desde: dia(mas(-1)), hasta: dia(mas(48)), ...p }); assert.equal(r.status, 201, JSON.stringify(r.j)); return db.prepare('SELECT id FROM promociones WHERE codigo = ?').get(p.codigo).id; };
  const cot = (quien, cupon, extra = {}) => quien('POST', '/api/cotizar', { vehiculo_id: 1, peso: 2, origen_zona: 'Zona 1', destino_zona: 'Zona 1', cupon, ...extra });
  const enviar = (quien, cupon) => quien('POST', '/api/envios', { vehiculo_id: 1, peso: 1, origen_zona: 'Zona 1', destino_zona: 'Zona 1', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    metodo_pago: 'efectivo', destino_nombre: 'Prueba Cupón', destino_telefono: '55554444', foto_paquete: FOTO, cupon });

  // 1) Límite total: 2 usos; al tercero ya se agotó (y si se cancela uno, se libera)
  await crear({ nombre: 'Dos usos', codigo: 'DOSUSOS', usos_max: 2 });
  const e1 = await enviar(ana, 'DOSUSOS'); assert.equal(e1.status, 201, JSON.stringify(e1.j));
  const f1 = db.prepare('SELECT precio, descuento, promocion_id FROM envios WHERE id = ?').get(e1.j.id);
  assert.equal(f1.descuento, 10); assert.equal(f1.precio, 25, 'Q35 - Q10');
  assert.equal((await enviar(lucia, 'DOSUSOS')).status, 201);
  assert.match((await cot(ana, 'DOSUSOS')).j.error_cupon, /agotó/);
  assert.equal((await enviar(ana, 'DOSUSOS')).status, 400, 'no deja crear el envío con un cupón agotado');
  db.prepare("UPDATE envios SET estado = 'cancelado' WHERE id = ?").run(e1.j.id);
  assert.equal((await cot(ana, 'DOSUSOS')).j.descuento, 10, 'al cancelar un envío, el uso se libera');

  // 2) Una vez por cliente: Ana lo usa, ya no puede; Lucía sí
  await crear({ nombre: 'Uno por cliente', codigo: 'UNOXCLI', usos_por_cliente: 1 });
  assert.equal((await enviar(ana, 'UNOXCLI')).status, 201);
  assert.match((await cot(ana, 'UNOXCLI')).j.error_cupon, /ya lo usaste/);
  assert.equal((await cot(lucia, 'UNOXCLI')).j.descuento, 10);

  // 3) Por horas: empieza en 2 horas (programada) → todavía no vale
  await crear({ nombre: 'Más tarde', codigo: 'MASTARDE', desde: dia(mas(2)), desde_hora: hh(mas(2)), hasta: dia(mas(4)), hasta_hora: hh(mas(4)) });
  assert.match((await cot(ana, 'MASTARDE')).j.error_cupon, /no existe o ya venció/);
  const lista = (await admin('GET', '/api/admin/promociones')).j.promociones;
  assert.equal(lista.find((p) => p.codigo === 'MASTARDE').estado, 'programada');

  // 4) Pausada → no vale; al activarla, sí
  const idPausa = await crear({ nombre: 'Pausable', codigo: 'PAUSA' });
  await admin('PUT', '/api/admin/promociones/' + idPausa, { activa: false });
  assert.match((await cot(ana, 'PAUSA')).j.error_cupon, /no existe o ya venció/);
  await admin('PUT', '/api/admin/promociones/' + idPausa, { activa: true });
  assert.equal((await cot(ana, 'PAUSA')).j.descuento, 10);

  // 5) Mínimo de Q40: un envío de Q35 no califica; uno de fuera de zona (Q45) sí
  await crear({ nombre: 'Mínimo 40', codigo: 'MIN40', minimo: 40 });
  assert.match((await cot(ana, 'MIN40')).j.error_cupon, /desde Q40/);
  assert.equal((await cot(ana, 'MIN40', { destino_zona: 'Otra zona o municipio' })).j.descuento, 10);

  // 6) Solo primer envío: Ana ya tiene envíos, una cuenta nueva sí
  await crear({ nombre: 'Bienvenida', codigo: 'BIENVENIDA', solo_primer_envio: true });
  assert.match((await cot(ana, 'BIENVENIDA')).j.error_cupon, /primer envío/);
  const nuevo = await cuenta('primerenvio@prueba.com');
  assert.equal((await cot(nuevo, 'BIENVENIDA')).j.descuento, 10, 'cuenta sin envíos sí lo tiene');

  // 7) Porcentaje y envío gratis
  await crear({ nombre: 'Veinte por ciento', codigo: 'VEINTE', tipo: 'porcentaje', valor: 20 });
  assert.equal((await cot(ana, 'VEINTE')).j.descuento, 7, '20% de Q35');
  await crear({ nombre: 'Gratis', codigo: 'GRATIS1', tipo: 'gratis' });
  const g = (await cot(ana, 'GRATIS1')).j; assert.equal(g.descuento, 35); assert.equal(g.precio, 0);

  // 8) Cupón vencido por horas (terminó hace 1 hora)
  await crear({ nombre: 'Ya pasó', codigo: 'YAPASO', desde: dia(mas(-5)), desde_hora: hh(mas(-5)), hasta: dia(mas(-1)), hasta_hora: hh(mas(-1)) });
  assert.match((await cot(ana, 'YAPASO')).j.error_cupon, /no existe o ya venció/);

  // 9) Reglas al crear: fin antes del inicio, hora mal escrita
  assert.equal((await admin('POST', '/api/admin/promociones', { nombre: 'Mal', tipo: 'monto', valor: 5, desde: dia(ahora), desde_hora: '18:00', hasta: dia(ahora), hasta_hora: '17:00', codigo: 'MAL1' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/promociones', { nombre: 'Mal', tipo: 'monto', valor: 5, desde: dia(ahora), desde_hora: '25:00', hasta: dia(mas(24)), codigo: 'MAL2' })).status, 400);
  db.prepare("UPDATE promociones SET activa = 0 WHERE codigo IN ('DOSUSOS','UNOXCLI','MASTARDE','PAUSA','MIN40','BIENVENIDA','VEINTE','GRATIS1','YAPASO')").run();
});

test('código corto para escribir en el paquete: por remitente y por día, sin repetirse', async () => {
  const lucia = cliente();
  db.prepare("INSERT OR IGNORE INTO usuarios (nombre,email,telefono,password_hash,rol,email_verificado,verificacion) VALUES ('Marta López Ruiz','codigos@prueba.com','55998877',?,'cliente',1,'verificado')").run(await hashPassword('clave-codigo-123'));
  await lucia('POST', '/api/login', { email: 'codigos@prueba.com', password: 'clave-codigo-123' });
  const base = { vehiculo_id: 1, peso: 1, origen_zona: 'Zona 1', destino_zona: 'Zona 1', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng, metodo_pago: 'efectivo', destino_telefono: '55554444', foto_paquete: FOTO };
  const a = await lucia('POST', '/api/envios', { ...base, destino_nombre: 'Uno' });
  assert.equal(a.status, 201, JSON.stringify(a.j)); assert.equal(a.j.codigo_corto, 'ML-01');
  const caja = await lucia('POST', '/api/envios/caja', { vehiculo_id: 1, metodo_pago: 'efectivo', origen_quien: 'cliente', origen_zona: 'Zona 1', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    envios: [{ peso: 1, destino_nombre: 'Dos', destino_telefono: '55554444', destino_zona: 'Zona 1', foto_paquete: FOTO }, { peso: 1, destino_nombre: 'Tres', destino_telefono: '55554445', destino_zona: 'Zona 1', foto_paquete: FOTO }] });
  assert.equal(caja.status, 201, JSON.stringify(caja.j));
  assert.deepEqual(caja.j.envios.map((x) => x.codigo_corto), ['ML-02', 'ML-03']);
  // El piloto y la administración lo ven; se puede buscar por el código
  const lista = (await admin('GET', '/api/admin/envios?q=ml-02')).j.envios;
  assert.ok(lista.some((x) => x.codigo_corto === 'ML-02'));
  // Pedidos de empresa: iniciales de la empresa y número del día, y el envío conserva el código
  const ped = db.prepare("SELECT p.*, e.codigo_corto AS c_envio FROM pedidos_empresa p JOIN envios e ON e.id = p.envio_id ORDER BY p.id DESC LIMIT 1").get();
  if (ped) { assert.match(ped.c_envio || '', /^[A-Z0-9]{2}-\d{2}$/); }
  for (const x of [a.j.id, ...caja.j.envios.map((y) => y.id)]) db.prepare("UPDATE envios SET estado = 'cancelado' WHERE id = ?").run(x);
});

test('cómo marca la empresa los paquetes: con etiqueta o nombre no se usa el código', async () => {
  const beto = cliente(); await beto('POST', '/api/login', { email: 'beto@prueba.com', password: 'clave-de-prueba-123' });
  const dia = new Date(Date.now() - 6 * 3600_000 + 3 * 86400_000).toISOString().slice(0, 10);
  const c = (await beto('POST', '/api/empresa/carpetas', { dia })).j.carpeta;
  assert.equal(c.marcado, 'codigo', 'por defecto, código escrito');
  const p = await beto('POST', `/api/empresa/carpetas/${c.id}/pedidos`, { descripcion: 'Blusa', tamano: 'sobre', cliente_nombre: 'Ana Ruiz', cliente_telefono: '55551234' });
  assert.equal(p.status, 201, JSON.stringify(p.j));
  assert.match((await beto('GET', `/api/empresa/carpetas/${c.id}`)).j.carpeta.pedidos[0].codigo_corto, /^TB-\d{2}$/);
  assert.equal((await beto('PUT', `/api/empresa/carpetas/${c.id}`, { marcado: 'etiqueta' })).status, 200);
  const v = (await beto('GET', `/api/empresa/carpetas/${c.id}`)).j.carpeta;
  assert.equal(v.marcado, 'etiqueta'); assert.equal(v.pedidos[0].codigo_corto, null);
  assert.equal((await beto('PUT', `/api/empresa/carpetas/${c.id}`, { marcado: 'otra' })).status, 400);
  assert.equal((await beto('PUT', `/api/empresa/carpetas/${c.id}`, { marcado: 'nombre' })).status, 400, 'ya no existe marcar solo con el nombre');
  // La siguiente carpeta recuerda lo que eligió
  const c2 = (await beto('POST', '/api/empresa/carpetas', { dia: new Date(Date.now() - 6 * 3600_000 + 4 * 86400_000).toISOString().slice(0, 10) })).j.carpeta;
  assert.equal(c2.marcado, 'etiqueta');
  await beto('PUT', `/api/empresa/carpetas/${c2.id}`, { marcado: 'codigo' });
  // Un envío de empresa marcado con nombre: el piloto no ve el código
  const e = db.prepare("SELECT id FROM envios WHERE pedido_id IS NOT NULL AND mensajero_id = ? ORDER BY id DESC LIMIT 1").get(pilotoId);
  if (e) {
    db.prepare("UPDATE envios SET marcado = 'etiqueta', estado = 'recogido' WHERE id = ?").run(e.id);
    const x = (await piloto('GET', '/api/piloto/envios')).j.envios.find((y) => y.id === e.id);
    if (x) { assert.equal(x.codigo_corto, null); assert.match(x.marcado_texto, /Guía impresa/); }
    db.prepare("UPDATE envios SET marcado = NULL, estado = 'entregado' WHERE id = ?").run(e.id);
  }
});

test('códigos sin cruzarse: clientes con las mismas iniciales, empresa con las mismas iniciales y paquetes de ayer aún en camino', async () => {
  const crearCuenta = async (nombre, email, tipo = 'personal', empresa = null) => {
    db.prepare("INSERT OR IGNORE INTO usuarios (nombre,email,telefono,password_hash,rol,email_verificado,verificacion,tipo_cuenta,empresa_nombre) VALUES (?,?,?,?,'cliente',1,'verificado',?,?)")
      .run(nombre, email, '5' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0'), await hashPassword('clave-cruce-123'), tipo, empresa);
    const c = cliente(); assert.equal((await c('POST', '/api/login', { email, password: 'clave-cruce-123' })).status, 200); return c;
  };
  const a = await crearCuenta('Zoe Quintana', 'zq1@prueba.com'), b = await crearCuenta('Zacarías Quiñónez', 'zq2@prueba.com'), c = await crearCuenta('Zulma Quan', 'zq3@prueba.com');
  const emp = await crearCuenta('Dueño', 'zq4@prueba.com', 'empresa', 'Zapatería Quetzal');
  const envio = (q) => q('POST', '/api/envios', { vehiculo_id: 1, peso: 1, origen_zona: 'Zona 1', destino_zona: 'Zona 1', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
    metodo_pago: 'efectivo', destino_nombre: 'Recibe', destino_telefono: '55554444', foto_paquete: FOTO });
  // Un paquete de ayer, con ZQ-01, que sigue en camino
  const ayer = await envio(a); assert.equal(ayer.status, 201, JSON.stringify(ayer.j));
  db.prepare("UPDATE envios SET creado = datetime('now', '-1 day'), estado = 'en_camino' WHERE id = ?").run(ayer.j.id);
  assert.equal(db.prepare('SELECT codigo_corto FROM envios WHERE id = ?').get(ayer.j.id).codigo_corto, 'ZQ-01');
  // Hoy: los tres clientes mandan envíos intercalados y la empresa registra pedidos
  const codigos = [];
  for (let i = 0; i < 4; i++) for (const q of [a, b, c]) { const r = await envio(q); assert.equal(r.status, 201); codigos.push(r.j.codigo_corto); }
  const dia = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
  const carpeta = (await emp('POST', '/api/empresa/carpetas', { dia })).j.carpeta;
  for (let i = 0; i < 5; i++) assert.equal((await emp('POST', `/api/empresa/carpetas/${carpeta.id}/pedidos`, { descripcion: 'Zapatos ' + i, tamano: 'pequeno', cliente_nombre: 'Comprador ' + i, cliente_telefono: '5555123' + i })).status, 201);
  codigos.push(...(await emp('GET', `/api/empresa/carpetas/${carpeta.id}`)).j.carpeta.pedidos.map((p) => p.codigo_corto));
  assert.ok(codigos.every((x) => /^ZQ-\d{2,}$/.test(x)), codigos.join(','));
  assert.ok(!codigos.includes('ZQ-01'), 'el ZQ-01 de ayer sigue en camino: nadie más lo usa');
  assert.equal(new Set(codigos).size, codigos.length, 'ningún código repetido: ' + codigos.join(','));
  // Revisión general: entre todos los paquetes en curso no hay dos con el mismo código
  const activos = db.prepare("SELECT codigo_corto AS c, COUNT(*) AS n FROM envios WHERE codigo_corto IS NOT NULL AND estado IN ('pendiente','recogido','en_camino') GROUP BY codigo_corto HAVING n > 1").all();
  assert.deepEqual(activos, [], 'códigos repetidos en curso: ' + JSON.stringify(activos));
  db.prepare("UPDATE envios SET estado = 'cancelado' WHERE usuario_id IN (SELECT id FROM usuarios WHERE email LIKE 'zq%@prueba.com')").run();
});

test('panel: el piloto en ruta de empresa sale marcado y "Al más cercano" no le carga envíos sueltos', async () => {
  const e = db.prepare("SELECT id FROM envios WHERE pedido_id IS NOT NULL ORDER BY id DESC LIMIT 1").get();
  if (!e) return;
  db.prepare("UPDATE envios SET mensajero_id = ?, asignacion = 'aceptado', estado = 'en_camino' WHERE id = ?").run(pilotoId, e.id);
  const pil = (await admin('GET', '/api/admin/mensajeros')).j.mensajeros.find((p) => p.id === pilotoId);
  assert.equal(pil.carga.tipo, 'empresa'); assert.match(pil.carga.texto, /En envíos de empresa/); assert.equal(pil.carga.distrae, true);
  // Un envío suelto: en la lista de cercanos sale con su aviso y abajo de los libres
  const s = await envioEnCamino().catch(() => null);
  if (s) {
    db.prepare("UPDATE envios SET mensajero_id = NULL, asignacion = NULL, estado = 'pendiente' WHERE id = ?").run(s.id);
    const lista = (await admin('GET', `/api/admin/envios/${s.id}/cercanos`)).j.pilotos;
    const yo = lista.find((p) => p.id === pilotoId);
    assert.ok(yo && yo.carga && yo.carga.distrae);
    db.prepare("UPDATE envios SET estado = 'cancelado' WHERE id = ?").run(s.id);
  }
  db.prepare("UPDATE envios SET estado = 'entregado' WHERE id = ?").run(e.id);
});

test('tienda minorista: cuenta normal que se activa sola, manda carpetas con menos pedidos y cobra su producto al entregar', async () => {
  const lupe = cliente();
  const ip = { 'x-real-ip': '10.9.8.' + Math.floor(Math.random() * 200) };
  assert.equal((await lupe('POST', '/api/registro', { nombre: 'Lupe Ramírez', email: 'lupe@prueba.com', telefono: '55554321', password: 'clave-de-prueba-123', acepto_terminos: true }, ip)).status, 201);
  const lupeId = db.prepare("SELECT id FROM usuarios WHERE email = 'lupe@prueba.com'").get().id;
  assert.equal((await lupe('GET', '/api/empresa/carpetas')).status, 403, 'una cuenta personal no tiene carpetas');
  assert.equal((await lupe('POST', '/api/cuenta/minorista', { tienda: '' })).status, 400, 'pide el nombre de la tienda');
  const act = await lupe('POST', '/api/cuenta/minorista', { tienda: 'Moda Lupe' });
  assert.equal(act.status, 200, JSON.stringify(act.j)); assert.equal(act.j.tipo_cuenta, 'minorista'); assert.equal(act.j.minimo, 3);
  // La cuenta de tienda queda en revisión hasta que la oficina la apruebe
  assert.equal(act.j.pendiente, true);
  assert.equal(db.prepare('SELECT tienda_estado FROM usuarios WHERE id = ?').get(lupeId).tienda_estado, 'pendiente');
  assert.ok((await admin('GET', '/api/admin/tiendas/solicitudes')).j.solicitudes.some((x) => x.id === lupeId));
  assert.equal((await admin('POST', `/api/admin/tiendas/${lupeId}/aprobar`, {})).status, 200);
  assert.equal((await admin('POST', `/api/admin/tiendas/${lupeId}/aprobar`, {})).status, 400, 'ya aprobada');
  const sol = (await lupe('GET', '/api/empresa/solicitud')).j;
  assert.equal(sol.es_minorista, true); assert.equal(sol.es_empresa, false);
  assert.equal((await lupe('POST', '/api/empresa/lote-sede', { filas: [] })).status, 403, 'la bodega en la sede es solo para empresas con contrato');
  assert.equal((await lupe('GET', '/api/empresa/bono')).j.activo, false);
  const hoy = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
  const carpeta = (await lupe('POST', '/api/empresa/carpetas', { dia: hoy })).j.carpeta.id;
  assert.equal((await lupe('POST', `/api/empresa/carpetas/${carpeta}/pedidos`, { descripcion: 'Blusa', tamano: 'pequeno', cliente_nombre: 'Clienta', cliente_telefono: '55556000', cobro: -5 })).status, 400, 'cobro negativo');
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await lupe('POST', `/api/empresa/carpetas/${carpeta}/pedidos`, { descripcion: 'Blusa ' + i, tamano: 'pequeno', cliente_nombre: 'Clienta ' + i, cliente_telefono: '5555600' + i, cobro: i === 0 ? 150 : '',
      foto: FOTO, llenar: true, dia: hoy, horario: 'cualquiera', direccion: 'Casa ' + i, zona: 'Zona 1', lat: 14.633 + i * 0.004, lng: -90.52, recibe_nombre: 'Clienta ' + i, recibe_telefono: '5555600' + i, metodo_pago: 'efectivo' });
    assert.equal(r.status, 201, JSON.stringify(r.j)); ids.push(r.j.pedido.id);
    if (i === 0) assert.equal(r.j.pedido.cobro, 150);
    if (i === 1) {
      const c = (await lupe('GET', `/api/empresa/carpetas/${carpeta}`)).j.carpeta;
      assert.equal(c.minimo, 3, 'la tienda minorista necesita 3, no 10');
      assert.equal((await lupe('POST', `/api/empresa/carpetas/${carpeta}/enviar`, { modo: 'una_moto', recogida: 'sede' })).status, 400, 'solo 2 confirmados');
    }
  }
  assert.equal((await lupe('PUT', `/api/empresa/pedidos/${ids[1]}`, { cobro: 80 })).status, 200);
  const anon = cliente();
  const vista = (await anon('GET', '/api/pedido/' + db.prepare('SELECT token FROM pedidos_empresa WHERE id = ?').get(ids[0]).token)).j;
  assert.equal(vista.cobro, 150, 'quien compra ve cuánto paga por su producto'); assert.equal(vista.empresa, 'Moda Lupe');
  const env = await lupe('POST', `/api/empresa/carpetas/${carpeta}/enviar`, { modo: 'una_moto', recogida: 'sede' });
  assert.equal(env.status, 201, JSON.stringify(env.j)); assert.equal(env.j.pedidos, 3);
  assert.equal((await lupe('POST', '/api/cuenta/minorista', { activar: false })).status, 400, 'no vuelve a personal con pedidos en curso');
  const emp = (await admin('GET', '/api/admin/empresas-activas')).j.empresas.find((x) => x.id === lupeId);
  assert.ok(emp, 'la oficina ve la tienda en Empresas activas'); assert.equal(emp.tipo_cuenta, 'minorista'); assert.equal(emp.lotes_nuevos, 1);
  assert.equal((await admin('GET', `/api/admin/empresas-activas/${lupeId}`)).status, 200);
  assert.equal((await admin('POST', `/api/admin/lotes-empresa/${env.j.lote}/recibido`, {})).status, 200);
  const calc = await admin('POST', `/api/admin/lotes-empresa/${env.j.lote}/calcular`, { modo: 'una_moto', motos: 1 });
  assert.equal(calc.status, 200, JSON.stringify(calc.j));
  const ok = await admin('POST', `/api/admin/lotes-empresa/${env.j.lote}/confirmar`, { modo: 'una_moto', rutas: calc.j.rutas.map((r) => ({ pedidos: r.pedidos, piloto_id: null })) });
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  assert.equal(db.prepare('SELECT cobro_destinatario FROM envios WHERE pedido_id = ?').get(ids[0]).cobro_destinatario, 150, 'el piloto cobra el producto');
  assert.equal(db.prepare('SELECT cobro_destinatario FROM envios WHERE pedido_id = ?').get(ids[1]).cobro_destinatario, 80);
  assert.equal(db.prepare('SELECT cobro_destinatario FROM envios WHERE pedido_id = ?').get(ids[2]).cobro_destinatario, 0);
  // La oficina también puede cambiar el tipo de cuenta
  const otra = db.prepare("SELECT id FROM usuarios WHERE email = 'ana@prueba.com'").get().id;
  assert.equal((await admin('PUT', `/api/admin/clientes/${otra}/empresa`, { tipo_cuenta: 'minorista', empresa_nombre: 'Tienda Ana' })).status, 200);
  assert.equal(db.prepare('SELECT tipo_cuenta FROM usuarios WHERE id = ?').get(otra).tipo_cuenta, 'minorista');
  assert.equal((await admin('PUT', `/api/admin/clientes/${otra}/empresa`, { tipo_cuenta: 'personal' })).status, 200);
  assert.equal(db.prepare('SELECT tipo_cuenta, empresa_nombre FROM usuarios WHERE id = ?').get(otra).empresa_nombre, null);
});

test('lugar de recogida: con el GPS en el lugar o con el enlace de la persona que está en otro lugar', async () => {
  const beto = cliente();
  assert.equal((await beto('POST', '/api/login', { email: 'beto@prueba.com', password: 'clave-de-prueba-123' })).status, 200);
  assert.equal((await beto('PUT', '/api/empresa/punto', { lat: 14.64, lng: -90.51, precision: 900, direccion: 'Bodega 6a av' })).status, 400, 'GPS muy débil');
  const ok = await beto('PUT', '/api/empresa/punto', { lat: 14.641, lng: -90.512, precision: 25, direccion: 'Bodega 6a av, portón gris' });
  assert.equal(ok.status, 200, JSON.stringify(ok.j)); assert.equal(ok.j.punto.fuente, 'gps'); assert.equal(ok.j.punto.contacto, db.prepare("SELECT nombre FROM usuarios WHERE email = 'beto@prueba.com'").get().nombre);
  // Otro lugar: la persona de ahí recibe un enlace
  assert.equal((await beto('POST', '/api/empresa/punto/enlace', { nombre: 'Marta', telefono: '123' })).status, 400);
  const en = await beto('POST', '/api/empresa/punto/enlace', { nombre: 'Doña Marta', telefono: '5555 7777' });
  assert.equal(en.status, 201); const tok = en.j.pendiente.enlace.split('/').pop();
  assert.equal((await beto('GET', '/api/empresa/carpetas')).j.punto_pendiente.nombre, 'Doña Marta');
  const anon = cliente();
  assert.equal((await anon('GET', '/api/punto/' + tok)).j.tienda, 'Tienda Beto');
  assert.equal((await anon('POST', '/api/punto/' + tok, { lat: 14.62, lng: -90.53, precision: 20, direccion: 'Casa de Marta, zona 7' })).status, 400, 'tiene que aceptar');
  const conf = await anon('POST', '/api/punto/' + tok, { lat: 14.62, lng: -90.53, precision: 20, direccion: 'Casa de Marta, zona 7', acepto: true });
  assert.equal(conf.status, 200, JSON.stringify(conf.j));
  const r = (await beto('GET', '/api/empresa/carpetas')).j;
  assert.equal(r.punto.contacto, 'Doña Marta'); assert.equal(r.punto.telefono, '5555 7777'); assert.equal(r.punto.fuente, 'enlace'); assert.equal(r.punto_pendiente, null);
  assert.equal((await anon('GET', '/api/punto/' + tok)).status, 404, 'el enlace se usa una vez');
  assert.equal((await cliente()('GET', '/punto/' + tok)).status, 200, 'la página existe');
});

test('códigos de tiendas minoristas: dos tiendas y un cliente con las mismas iniciales no se cruzan, ni con la tienda del mismo nombre', async () => {
  const crear = async (nombre, email, tipo, tienda) => {
    db.prepare("INSERT OR IGNORE INTO usuarios (nombre,email,telefono,password_hash,rol,email_verificado,verificacion,tipo_cuenta,empresa_nombre) VALUES (?,?,?,?,'cliente',1,'verificado',?,?)")
      .run(nombre, email, '5' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0'), await hashPassword('clave-tienda-123'), tipo, tienda);
    const c = cliente(); assert.equal((await c('POST', '/api/login', { email, password: 'clave-tienda-123' })).status, 200); return c;
  };
  const t1 = await crear('Rosa Méndez', 'xr1@prueba.com', 'minorista', 'Rosita Modas');
  const t2 = await crear('Raquel Mus', 'xr2@prueba.com', 'minorista', 'Rosita Modas');   // otra tienda con el mismo nombre
  const t3 = await crear('Rita Mejía', 'xr3@prueba.com', 'minorista', 'Ropa Mía');
  const p = await crear('Raúl Morales', 'xr4@prueba.com', 'personal', null);
  const dia = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
  const codigos = [];
  for (const [i, t] of [t1, t2, t3, t1, t2, t3].entries()) {
    const c = (await t('POST', '/api/empresa/carpetas', { dia })).j.carpeta || (await t('GET', '/api/empresa/carpetas')).j.abiertas[0];
    assert.equal((await t('POST', `/api/empresa/carpetas/${c.id}/pedidos`, { descripcion: 'Blusa ' + i, tamano: 'pequeno', cliente_nombre: 'Clienta ' + i, cliente_telefono: '5555321' + i })).status, 201);
    const r = await p('POST', '/api/envios', { vehiculo_id: 1, peso: 1, origen_zona: 'Zona 1', destino_zona: 'Zona 1', origen_lat: ZONA1.lat, origen_lng: ZONA1.lng,
      metodo_pago: 'efectivo', destino_nombre: 'Recibe', destino_telefono: '55554444', foto_paquete: FOTO });
    assert.equal(r.status, 201); codigos.push(r.j.codigo_corto);
  }
  for (const t of [t1, t2, t3]) for (const c of (await t('GET', '/api/empresa/carpetas')).j.abiertas) codigos.push(...(await t('GET', `/api/empresa/carpetas/${c.id}`)).j.carpeta.pedidos.map((x) => x.codigo_corto));
  assert.equal(codigos.length, 12);
  assert.ok(codigos.every((x) => /^RM-\d{2,}$/.test(x)), codigos.join(','));
  assert.equal(new Set(codigos).size, codigos.length, 'ningún código repetido: ' + codigos.join(','));
});

test('sesiones separadas: la tienda, el panel y el piloto abiertos en el mismo navegador no se sacan entre sí', async () => {
  const sacar = async (ruta, body) => { const r = await fetch(BASE + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return (r.headers.get('set-cookie') || '').split(';')[0]; };
  const tienda = await sacar('/api/login', { email: 'lupe@prueba.com', password: 'clave-de-prueba-123' });
  const panel = await sacar('/api/acceso-familia', { email: 'administracionvaelo@vaelomensajeria.com', password: 'clave-de-prueba-123' });
  const piloto = await sacar('/api/piloto/entrar', { email: 'carlos@prueba.com', password: 'clave-de-prueba-123' });
  assert.ok(tienda.startsWith('vaelo_sesion=') && panel.startsWith('vaelo_panel=') && piloto.startsWith('vaelo_piloto='), [tienda, panel, piloto].join(' | '));
  const todas = [tienda, panel, piloto].join('; ');
  const yo = async (desde) => (await (await fetch(BASE + '/api/yo', { headers: { Cookie: todas, Referer: BASE + desde } })).json()).usuario;
  assert.equal((await yo('/mi-cuenta')).email, 'lupe@prueba.com');
  assert.equal((await yo('/tienda')).email, 'lupe@prueba.com');
  assert.equal((await yo('/familiatecun')).rol, 'admin');
  assert.equal((await yo('/modomensajero')).email, 'carlos@prueba.com');
  // Abrir una dirección del panel escribiéndola (sin página de origen) usa la sesión del panel
  assert.equal((await fetch(BASE + '/api/admin/tarifas', { headers: { Cookie: todas } })).status, 200);
  assert.equal((await fetch(BASE + '/api/admin/tarifas', { headers: { Cookie: tienda } })).status, 403, 'la tienda sola no entra al panel');
  // La tienda sigue con sus carpetas aunque el panel esté abierto en otra pestaña
  const r = await fetch(BASE + '/api/empresa/solicitud', { headers: { Cookie: todas, Referer: BASE + '/mi-cuenta' } });
  assert.equal(r.status, 200);
  // Salir del panel no cierra la tienda
  await fetch(BASE + '/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: todas, Referer: BASE + '/familiatecun' }, body: '{}' });
  assert.equal(await yo('/familiatecun'), null);
  assert.equal((await yo('/mi-cuenta')).email, 'lupe@prueba.com');
  assert.equal((await yo('/modomensajero')).email, 'carlos@prueba.com');
});

test('zonas desde el mapa: arma la forma con sus tramos, la simplifica y llena las zonas que se llaman igual', async () => {
  const datos = fs.readFileSync(path.join(__dirname, 'datos', 'overpass-zonas.json'), 'utf8');
  const original = globalThis.fetch;
  globalThis.fetch = async (url, op) => (String(url).includes('overpass') ? new Response(datos, { status: 200, headers: { 'Content-Type': 'application/json' } }) : original(url, op));
  try {
    db.prepare('UPDATE zonas_fijas SET poligono = NULL').run();
    const r = await admin('POST', '/api/admin/zonas/importar', {});
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.ok(r.j.llenadas.includes('Zona 1') && r.j.llenadas.includes('Zona 6'), JSON.stringify(r.j));
    assert.ok(r.j.sin_forma.includes('Zona 16'), 'Zona 16 no viene en el mapa de prueba');
    assert.ok(r.j.disponibles_zonas.includes('Zona 19')); assert.ok(r.j.disponibles_municipios.includes('Mixco'));
    // La forma queda bien armada: un punto adentro sí, uno afuera no
    const z1 = JSON.parse(db.prepare("SELECT poligono FROM zonas_fijas WHERE nombre = 'Zona 1'").get().poligono);
    assert.ok(z1.length >= 4 && z1.length <= 200);
    const zona = async (lat, lng) => (await admin('GET', `/api/zona?lat=${lat}&lng=${lng}`)).j.zona;
    assert.equal(await zona(14.637, -90.512), 'Zona 1'); assert.equal(await zona(14.652, -90.497), 'Zona 6'); assert.equal(await zona(14.70, -90.40), null);
    // Agregar Mixco: su forma real (muchos puntos) se arma de 3 tramos y queda en 200 puntos o menos
    const m = await admin('POST', '/api/admin/zonas/importar', { agregar: ['Mixco'] });
    assert.ok(m.j.llenadas.includes('Mixco'), JSON.stringify(m.j));
    const mixco = JSON.parse(db.prepare("SELECT poligono FROM zonas_fijas WHERE nombre = 'Mixco'").get().poligono);
    assert.ok(mixco.length >= 20 && mixco.length <= 200, 'puntos de Mixco: ' + mixco.length);
    assert.equal(await zona(14.6330, -90.6064), 'Mixco', 'el centro de Mixco cae dentro de su forma');
    // Las que ya tienen forma no se tocan si no se pide
    assert.ok((await admin('POST', '/api/admin/zonas/importar', {})).j.conservadas.includes('Zona 1'));
  } finally {
    globalThis.fetch = original;
    db.prepare("DELETE FROM zonas_fijas WHERE nombre = 'Mixco'").run();
    db.prepare('UPDATE zonas_fijas SET poligono = NULL').run();
  }
});

test('zonas dibujadas a mano: la franja entre dos vecinas (unos metros) cuenta como zona; lejos de todas, no', async () => {
  const antes = db.prepare('SELECT id, poligono FROM zonas_fijas').all();
  try {
    // Dos zonas vecinas con una franja de unos 11 m entre ellas (0.0001° de longitud)
    const a = [[-90.5200, 14.6300], [-90.5100, 14.6300], [-90.5100, 14.6400], [-90.5200, 14.6400]];
    const b = [[-90.5099, 14.6300], [-90.5000, 14.6300], [-90.5000, 14.6400], [-90.5099, 14.6400]];
    const z = db.prepare('SELECT id, nombre FROM zonas_fijas WHERE activa = 1 ORDER BY id LIMIT 2').all();
    db.prepare('UPDATE zonas_fijas SET poligono = NULL').run();
    db.prepare('UPDATE zonas_fijas SET poligono = ? WHERE id = ?').run(JSON.stringify(a), z[0].id);
    db.prepare('UPDATE zonas_fijas SET poligono = ? WHERE id = ?').run(JSON.stringify(b), z[1].id);
    const zona = async (lat, lng) => (await admin('GET', `/api/zona?lat=${lat}&lng=${lng}`)).j.zona;
    assert.equal(await zona(14.635, -90.515), z[0].nombre, 'dentro de la primera');
    assert.ok([z[0].nombre, z[1].nombre].includes(await zona(14.635, -90.50995)), 'la franja de 11 m entre las dos tiene zona');
    assert.equal(await zona(14.635, -90.5202), z[0].nombre, 'a unos 20 m del borde todavía cuenta');
    assert.equal(await zona(14.635, -90.5215), null, 'a unos 160 m ya es fuera de zona');
  } finally {
    for (const x of antes) db.prepare('UPDATE zonas_fijas SET poligono = ? WHERE id = ?').run(x.poligono, x.id);
  }
});

test('precios con las zonas reales de Vaelo: Q35 dentro, Q45 fuera, y la ubicación de quien recibe corrige la zona elegida', async () => {
  const reales = JSON.parse(fs.readFileSync(path.join(__dirname, 'datos', 'zonas-reales.json'), 'utf8'));
  const antes = db.prepare('SELECT * FROM zonas_fijas').all();
  db.exec('DELETE FROM zonas_fijas');
  for (const z of reales) db.prepare('INSERT INTO zonas_fijas (nombre, activa, poligono) VALUES (?, ?, ?)').run(z.nombre, z.activa, z.poligono);
  try {
    const L = { Z1: [14.6360, -90.5130], Cayala: [14.6133, -90.4858], Z10: [14.5990, -90.5070], Z17: [14.6408, -90.4752], Mixco: [14.6330, -90.6064],
      borde1516: [14.59040, -90.48390], Z24: [14.6183, -90.4368], Z6: [14.6650, -90.4900], Z18: [14.6808, -90.4460], Z15: [14.5990, -90.4930] };
    const casos = [['Z1', 'Zona 1', 'Cayala', 'Zona 16', 35], ['Z1', 'Zona 1', 'Z10', 'Zona 16', 45], ['Z1', 'Zona 1', 'Z17', 'Otra zona o municipio', 35],
      ['Mixco', 'Otra zona o municipio', 'Z1', 'Zona 1', 45], ['borde1516', 'Zona 15', 'Z24', 'Zona 24', 35], ['Z6', 'Zona 6', 'Z18', 'Otra zona o municipio', 45],
      ['Z15', 'Zona 15', 'Z24', 'Zona 24', 35], ['Mixco', 'Zona 1', 'Z6', 'Zona 6', 45]];
    for (const [o, oz, de, dz, esperado] of casos) {
      const r = await ana('POST', '/api/envios', { vehiculo_id: 1, peso: 2, origen_zona: oz, destino_zona: dz, origen_lat: L[o][0], origen_lng: L[o][1],
        destino_nombre: 'Recibe', destino_telefono: '55554444', destino_direccion: 'Casa', metodo_pago: 'efectivo', foto_paquete: FOTO });
      assert.equal(r.status, 201, JSON.stringify(r.j));
      await cliente()('POST', `/api/recibe/${r.j.enlace_receptor.split('/').pop()}/confirmar`, { nombre: 'Recibe', lat: L[de][0], lng: L[de][1] });
      await new Promise((ok) => setTimeout(ok, 30));
      assert.equal(fila(r.j.id).precio, esperado, `${o} (${oz}) → ${de} (${dz})`);
      await ana('POST', `/api/envios/${r.j.id}/cancelar`, {});
    }
  } finally {
    db.exec('DELETE FROM zonas_fijas');
    for (const z of antes) db.prepare('INSERT INTO zonas_fijas (id, nombre, activa, poligono) VALUES (?, ?, ?, ?)').run(z.id, z.nombre, z.activa, z.poligono);
  }
});

test('planes de tiendas: precio, mínimo, cobro con comisión, volumen, excepciones con vencimiento, permisos e historial', async () => {
  db.exec('UPDATE zonas_fijas SET poligono = NULL');   // sin formas: la zona elegida manda
  const hoy = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
  const rosa = cliente();
  assert.equal((await rosa('POST', '/api/registro', { nombre: 'Rosa Paz', email: 'rosa@prueba.com', telefono: '55557788', password: 'clave-de-prueba-123', acepto_terminos: true, tienda: 'Rosa Shop' }, { 'x-real-ip': '10.7.7.7' })).status, 201);
  const rosaId = db.prepare("SELECT id FROM usuarios WHERE email = 'rosa@prueba.com'").get().id;
  assert.equal((await admin('POST', `/api/admin/tiendas/${rosaId}/aprobar`, {})).status, 200);
  assert.equal(db.prepare('SELECT tipo_cuenta FROM usuarios WHERE id = ?').get(rosaId).tipo_cuenta, 'minorista');
  const carpeta = (await rosa('POST', '/api/empresa/carpetas', { dia: hoy })).j.carpeta.id;
  let n = 0;
  const pedido = async (cobro = '') => { n++; return rosa('POST', `/api/empresa/carpetas/${carpeta}/pedidos`, { descripcion: 'Vestido ' + n, tamano: 'pequeno', cliente_nombre: 'Compradora ' + n, cliente_telefono: '5555710' + n, cobro,
    foto: FOTO, llenar: true, dia: hoy, horario: 'cualquiera', direccion: 'Casa ' + n, zona: 'Zona 1', lat: 14.633, lng: -90.52, recibe_nombre: 'Compradora ' + n, recibe_telefono: '5555710' + n, metodo_pago: 'efectivo' }); };
  const precioDe = async (id) => (await cliente()('GET', '/api/pedido/' + db.prepare('SELECT token FROM pedidos_empresa WHERE id = ?').get(id).token)).j;

  // De fábrica: dos planes y nada cambia (Q35, mínimo 3)
  const lista = (await admin('GET', '/api/admin/planes')).j;
  assert.deepEqual(lista.planes.map((p) => p.clave), ['minorista', 'empresa']); assert.equal(lista.puede_editar, true);
  const planMin = lista.planes[0];
  assert.equal(planMin.tiendas >= 1, true); assert.match(planMin.resumen[0].texto, /Q35\.00 en zonas preferenciales y Q45\.00/);
  const p1 = (await pedido(150)).j.pedido;
  assert.equal((await precioDe(p1.id)).precio.precio, 35);
  let panel = (await rosa('GET', '/api/empresa/carpetas')).j;
  assert.equal(panel.minimo, 3); assert.equal(panel.condiciones.plan, 'Minorista'); assert.match(panel.condiciones.lineas.map((l) => l.texto).join(' '), /desde 3 pedidos confirmados/);

  // Validaciones del editor
  const cambiar = (condiciones, nombre = 'Minorista') => admin('PUT', `/api/admin/planes/${planMin.id}`, { nombre, descripcion: 'Lives', condiciones });
  assert.equal((await cambiar({ precio_zona: 0 })).status, 400, 'precio fuera de rango');
  assert.equal((await cambiar({ comision_tipo: 'porcentaje', comision_valor: 80 })).status, 400, 'comisión de más de 50%');
  assert.equal((await cambiar({ comision_tipo: 'fija' })).status, 400, 'comisión sin valor');
  assert.equal((await cambiar({ volumen_desde: 5 })).status, 400, 'volumen sin precio');
  assert.equal((await cambiar({}, 'Empresa')).status, 400, 'nombre repetido');
  assert.equal((await admin('DELETE', `/api/admin/planes/${planMin.id}`)).status, 400, 'los de fábrica no se borran');
  const vista = (await admin('GET', '/api/admin/planes/vista?tipo=minorista&c=' + encodeURIComponent(JSON.stringify({ precio_zona: 30, comision_tipo: 'porcentaje', comision_valor: 3 })))).j;
  assert.match(vista.lineas[0].texto, /Q30\.00/); assert.match(vista.lineas.map((l) => l.texto).join(' '), /descuenta el 3%/);

  // El plan cambia: precio Q32, mínimo 2, comisión Q5, tope Q300, 2 días de bodega gratis, volumen desde 2 entregas a Q30
  const ok = await cambiar({ precio_zona: 32, minimo: 2, comision_tipo: 'fija', comision_valor: 5, cobro_tope: 300, bodega_dias_gratis: 2, volumen_desde: 2, volumen_precio_zona: 30, ascenso_desde: 2 });
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  assert.equal((await precioDe(p1.id)).precio.precio, 35, 'el pedido ya confirmado conserva su precio');
  assert.equal((await pedido(500)).status, 400, 'cobro por encima del tope del plan');
  const p2 = (await pedido(80)).j.pedido;
  const v2 = await precioDe(p2.id);
  assert.equal(v2.precio.precio, 32, 'el pedido nuevo usa el precio del plan'); assert.equal(v2.tarifa_zona, 32);
  panel = (await rosa('GET', '/api/empresa/carpetas')).j;
  assert.equal(panel.minimo, 2); assert.equal(panel.condiciones.cobro_tope, 300);
  assert.match(panel.condiciones.lineas.map((l) => l.texto).join(' '), /Q32\.00 en zonas.*Desde 2 entregas en el mes.*Llevas 0: te faltan 2.*descuenta Q5\.00.*2 días sin costo/);

  // Con 2 confirmados ya se puede enviar; cada envío sale con su precio y la comisión del cobro
  const env = await rosa('POST', `/api/empresa/carpetas/${carpeta}/enviar`, { modo: 'una_moto', recogida: 'sede' });
  assert.equal(env.status, 201, JSON.stringify(env.j));
  assert.equal((await admin('POST', `/api/admin/lotes-empresa/${env.j.lote}/recibido`, {})).status, 200);
  const calc = await admin('POST', `/api/admin/lotes-empresa/${env.j.lote}/calcular`, { modo: 'una_moto', motos: 1 });
  assert.equal((await admin('POST', `/api/admin/lotes-empresa/${env.j.lote}/confirmar`, { modo: 'una_moto', rutas: calc.j.rutas.map((r) => ({ pedidos: r.pedidos, piloto_id: null })) })).status, 200);
  const e1 = db.prepare('SELECT * FROM envios WHERE pedido_id = ?').get(p1.id), e2 = db.prepare('SELECT * FROM envios WHERE pedido_id = ?').get(p2.id);
  assert.equal(e1.precio, 35); assert.equal(e2.precio, 32); assert.equal(e1.comision_cobro, 5); assert.equal(e2.comision_cobro, 5);
  assert.equal((await precioDe(p2.id)).precio.precio, 32, 'ya enviado, sigue con su precio');

  // Entregados: a la tienda se le debe lo cobrado menos la comisión, igual en la caja de oficina
  db.prepare("UPDATE envios SET estado = 'entregado', entregado_en = datetime('now') WHERE id IN (?, ?)").run(e1.id, e2.id);
  const cp = (await rosa('GET', '/api/empresa/carpetas')).j.cobros_producto;
  assert.equal(cp.pendiente, 220, '150 + 80 menos Q5 de comisión por cada uno'); assert.equal(cp.comision, 10);
  const enCaja = (await admin('GET', '/api/admin/caja')).j.cobros.find((x) => x.id === rosaId);
  assert.equal(enCaja.monto, 220); assert.equal(enCaja.comision, 10);
  assert.equal((await admin('POST', '/api/admin/caja/pagar-cobros', { cliente_id: rosaId })).status, 200);
  assert.equal((await rosa('GET', '/api/empresa/carpetas')).j.cobros_producto.pendiente, 0);

  // Con 2 entregas en el mes aplica el precio por volumen, y el panel avisa que puede subir de plan
  const carpeta2 = (await rosa('POST', '/api/empresa/carpetas', { dia: hoy, nombre: 'Segunda' })).j.carpeta.id;
  const pedido2 = async (extra = {}) => { n++; return rosa('POST', `/api/empresa/carpetas/${carpeta2}/pedidos`, { descripcion: 'Falda ' + n, tamano: 'pequeno', cliente_nombre: 'Compradora ' + n, cliente_telefono: '5555720' + n,
    foto: FOTO, llenar: true, dia: hoy, horario: 'cualquiera', direccion: 'Casa ' + n, zona: 'Zona 1', lat: 14.633, lng: -90.52, recibe_nombre: 'Compradora ' + n, recibe_telefono: '5555720' + n, metodo_pago: 'efectivo', ...extra }); };
  const p3 = (await pedido2()).j.pedido;
  assert.equal((await precioDe(p3.id)).precio.precio, 30, 'precio por volumen');
  const sug = (await admin('GET', '/api/admin/planes')).j.sugerencias.find((s) => s.id === rosaId);
  assert.ok(sug, 'aviso de ascenso'); assert.equal(sug.entregas, 2);

  // Excepción solo para esta tienda, con vencimiento
  const manana = new Date(Date.now() + 18 * 3600_000).toISOString().slice(0, 10);
  assert.equal((await admin('PUT', `/api/admin/empresas/${rosaId}/condiciones`, { plan_id: planMin.id, propias: { precio_zona: 28 }, vence: '2020-01-01' })).status, 400, 'vencimiento en el pasado');
  const exc = await admin('PUT', `/api/admin/empresas/${rosaId}/condiciones`, { plan_id: planMin.id, propias: { precio_zona: 28, volumen_desde: 999, volumen_precio_zona: 27, cobro_permitido: 'no' }, vence: manana, nota: 'Trato de bienvenida' });
  assert.equal(exc.status, 200, JSON.stringify(exc.j));
  assert.equal((await precioDe(p3.id)).precio.precio, 30, 'el confirmado no cambia');
  const p4 = (await pedido2()).j.pedido;
  assert.equal((await precioDe(p4.id)).precio.precio, 28, 'excepción vigente');
  assert.equal((await pedido2({ cobro: 50 })).status, 400, 'la excepción quitó el cobro del producto');
  let cond = (await admin('GET', `/api/admin/empresas/${rosaId}/condiciones`)).j;
  assert.deepEqual(cond.propias, { precio_zona: 28, volumen_desde: 999, volumen_precio_zona: 27, cobro_permitido: false }); assert.equal(cond.vencidas, false); assert.equal(cond.del_plan.precio_zona, 32);
  assert.equal((await rosa('GET', '/api/empresa/carpetas')).j.condiciones.vence, manana);
  // Al vencer vuelve sola a su plan
  db.prepare("UPDATE usuarios SET condiciones_vence = '2020-01-01' WHERE id = ?").run(rosaId);
  const p5 = (await pedido2({ cobro: 50 })).j.pedido;
  assert.equal((await precioDe(p5.id)).precio.precio, 30, 'vencida la excepción, vuelve al plan (con volumen)');
  cond = (await admin('GET', `/api/admin/empresas/${rosaId}/condiciones`)).j;
  assert.equal(cond.vencidas, true);
  // Si quien recibe cambia el lugar a otra zona, el precio se vuelve a calcular con las condiciones de hoy
  const tok = db.prepare('SELECT token FROM pedidos_empresa WHERE id = ?').get(p4.id).token;
  const mov = await cliente()('POST', '/api/pedido/' + tok, { dia: hoy, horario: 'tarde', lat: 14.9, lng: -90.9, zona: 'Otra zona o municipio', direccion: 'Finca', recibe_nombre: 'Compradora', recibe_telefono: '55557209' });
  assert.equal(mov.status, 200, JSON.stringify(mov.j)); assert.equal(mov.j.precio.precio, 45);

  // Bodega: 2 días sin costo y después la tarifa general
  db.prepare("UPDATE envios SET estado = 'en_sede', sede_llegada = datetime('now', '-60 hours') WHERE id = ?").run(e1.id);
  const sede = (await admin('GET', `/api/admin/empresas-activas/${rosaId}`)).j.en_sede.find((x) => x.id === e1.id);
  assert.equal(sede.dias, 3); assert.equal(sede.cargo, 10, '3 días menos 2 gratis, a Q10');
  db.prepare("UPDATE envios SET estado = 'entregado', sede_llegada = NULL WHERE id = ?").run(e1.id);

  // Plan nuevo: se asigna, se borra y la tienda vuelve al de su tipo de cuenta
  const nuevo = await admin('POST', '/api/admin/planes', { nombre: 'Tienda frecuente', descripcion: 'Más de 40 al mes', condiciones: { precio_zona: 29, minimo: 1 } });
  assert.equal(nuevo.status, 201, JSON.stringify(nuevo.j));
  assert.equal((await admin('POST', '/api/admin/planes', { nombre: 'tienda FRECUENTE', condiciones: {} })).status, 400, 'nombre repetido');
  assert.equal((await admin('PUT', `/api/admin/empresas/${rosaId}/condiciones`, { plan_id: nuevo.j.plan.id, propias: {} })).status, 200);
  assert.equal(db.prepare('SELECT plan_id, condiciones_propias FROM usuarios WHERE id = ?').get(rosaId).plan_id, nuevo.j.plan.id);
  panel = (await rosa('GET', '/api/empresa/carpetas')).j;
  assert.equal(panel.minimo, 1); assert.equal(panel.condiciones.plan, 'Tienda frecuente');
  assert.equal((await precioDe((await pedido2()).j.pedido.id)).precio.precio, 29);
  const borrar = await admin('DELETE', `/api/admin/planes/${nuevo.j.plan.id}`);
  assert.equal(borrar.status, 200); assert.equal(borrar.j.tiendas, 1);
  assert.equal((await rosa('GET', '/api/empresa/carpetas')).j.condiciones.plan, 'Minorista');

  // Permisos: oficina ve, solo administración cambia; una tienda no entra
  db.prepare("INSERT OR IGNORE INTO usuarios (nombre,email,telefono,password_hash,rol,email_verificado,verificacion,permisos) VALUES ('Oficina Planes','oficina.planes@prueba.com','55559911',?,'operador',1,'verificado','envios,empresas')").run(hashPassword('clave-larga-123'));
  const op = cliente();
  assert.equal((await op('POST', '/api/acceso-familia', { email: 'oficina.planes@prueba.com', password: 'clave-larga-123' })).status, 200);
  const deOficina = await op('GET', '/api/admin/planes');
  assert.equal(deOficina.status, 200); assert.equal(deOficina.j.puede_editar, false);
  assert.equal((await op('PUT', `/api/admin/planes/${planMin.id}`, { nombre: 'Minorista', condiciones: {} })).status, 403);
  assert.equal((await op('PUT', `/api/admin/empresas/${rosaId}/condiciones`, { propias: {} })).status, 403);
  assert.equal((await op('GET', `/api/admin/empresas/${rosaId}/condiciones`)).j.puede_editar, false);
  assert.ok([401, 403].includes((await rosa('GET', '/api/admin/planes', null, { Referer: BASE + '/tienda' })).status));
  db.prepare("UPDATE usuarios SET permisos = 'envios' WHERE email = 'oficina.planes@prueba.com'").run();
  assert.equal((await op('GET', '/api/admin/planes')).status, 403, 'sin permiso de Empresas no ve los planes');

  // Historial: qué cambió y cómo estaba antes
  const h = db.prepare("SELECT accion, detalle FROM historial WHERE ruta = '/api/admin/planes/:id' AND accion LIKE 'Cambió el plan%' ORDER BY id DESC LIMIT 1").get();
  assert.match(h.accion, /Cambió el plan «Minorista»: .*Precio en zonas preferenciales: 32/); assert.match(h.detalle, /Plan «Minorista»\. Antes: todo en los valores generales/);
  const h2 = db.prepare("SELECT accion, detalle FROM historial WHERE ruta = '/api/admin/empresas/:id/condiciones' AND accion LIKE '%excepciones: %' ORDER BY id DESC LIMIT 1").get();
  assert.match(h2.accion, /Precio en zonas preferenciales: 28.*vencen el/); assert.match(h2.detalle, /Rosa Shop/);

  // Dejar el plan como estaba para no afectar otras pruebas
  assert.equal((await cambiar({})).status, 200);
  assert.equal((await rosa('GET', '/api/empresa/carpetas')).j.minimo, 3);
});

test('efectivo en la mano del piloto: alerta por niveles según la hora, recordatorios, no termina el día sin entregarlo y la oficina lo marca entregado', async () => {
  const gt = (h, m = 0) => new Date(Date.UTC(2026, 10, 11, h + 6, m));   // hora de Guatemala del 11 de noviembre
  const yo = async () => (await piloto('GET', '/api/piloto/yo')).j.piloto.efectivo;
  db.prepare('UPDATE envios SET liquidado_id = 999 WHERE mensajero_id = ? AND liquidado_id IS NULL').run(pilotoId);   // empieza sin efectivo
  db.prepare('UPDATE usuarios SET efectivo_aviso = NULL, efectivo_nivel = NULL, efectivo_nivel_en = NULL WHERE id = ?').run(pilotoId);
  db.prepare("UPDATE envios SET estado = 'cancelado' WHERE mensajero_id = ? AND estado IN ('pendiente','recogido','en_camino','fallido','devolviendo','a_sede')").run(pilotoId);   // sin entregas en curso
  assert.equal(await yo(), null);
  assert.equal(recordarEfectivo(gt(10)), 0);
  // Entrega con cobro del producto: Q35 de envío (paga quien recibe) + Q400 del producto
  const id = db.prepare('SELECT id FROM envios WHERE mensajero_id = ? ORDER BY id LIMIT 1').get(pilotoId).id;
  const cerrado = (t) => db.prepare(`UPDATE envios SET estado = 'entregado', metodo_pago = 'recibe', precio = 35, cargos_extra = 0, cobro_destinatario = 400, sede_llegada = NULL, entregado_en = ${t}, piloto_cerro_en = ${t}, liquidado_id = NULL WHERE id = ?`).run(id);
  cerrado("'2026-11-11 15:00:00'");   // 9 de la mañana en Guatemala
  let ef = await yo();
  assert.equal(ef.monto, 435); assert.equal(ef.envios, 1); assert.equal(ef.mucho, false); assert.equal(ef.nivel, null, 'con poco efectivo no hay alerta por niveles');
  assert.match(ef.limite, /^\d{4}-\d{2}-\d{2}$/); assert.match(ef.sede, /Sede Vaelo/); assert.equal(ef.cierre, '10:00 p. m.');
  assert.equal(recordarEfectivo(gt(10)), 0, 'es poco y falta para el plazo: no molesta');
  assert.equal((await piloto('POST', '/api/piloto/en-linea', { en_linea: true, lat: ZONA1.lat, lng: ZONA1.lng })).status, 200);
  assert.equal((await piloto('POST', '/api/piloto/en-linea', { en_linea: false })).status, 200, 'con poco efectivo se desconecta normal');

  // Ya es bastante (desde Q400): la alerta sube con la hora
  ajuste('efectivo_aviso_monto', 400);
  const nivelA = (h) => { const { DatabaseSync } = require('node:sqlite'); void DatabaseSync; return require('../server').efectivoEnMano(pilotoId, gt(h)).nivel; };
  assert.equal(nivelA(9), 'verde'); assert.equal(nivelA(11), 'verde'); assert.equal(nivelA(12), 'naranja'); assert.equal(nivelA(18), 'naranja'); assert.equal(nivelA(19), 'rojo'); assert.equal(nivelA(21), 'rojo'); assert.equal(nivelA(23), 'rojo');
  // Mañana: un solo aviso verde
  assert.equal(recordarEfectivo(gt(9, 30)), 1); assert.equal(recordarEfectivo(gt(10, 30)), 0); assert.equal(recordarEfectivo(gt(11, 55)), 0);
  // Tarde: naranja cada hora
  assert.equal(recordarEfectivo(gt(12, 0)), 1, 'cambia a naranja'); assert.equal(recordarEfectivo(gt(12, 30)), 0); assert.equal(recordarEfectivo(gt(13, 0)), 1); assert.equal(recordarEfectivo(gt(13, 45)), 0); assert.equal(recordarEfectivo(gt(14, 0)), 1);
  // Últimas 3 horas: rojo cada 15 minutos, hasta que cierra
  assert.equal(recordarEfectivo(gt(19, 0)), 1, 'cambia a rojo'); assert.equal(recordarEfectivo(gt(19, 5)), 0); assert.equal(recordarEfectivo(gt(19, 10)), 0);
  assert.equal(recordarEfectivo(gt(19, 15)), 1); assert.equal(recordarEfectivo(gt(19, 30)), 1); assert.equal(recordarEfectivo(gt(19, 40)), 0); assert.equal(recordarEfectivo(gt(21, 45)), 1);
  assert.equal(recordarEfectivo(gt(22, 0)), 0, 'Vaelo ya cerró: no avisa'); assert.equal(recordarEfectivo(gt(23, 30)), 0); assert.equal(recordarEfectivo(gt(6 + 24, 0)), 0, 'de madrugada tampoco');
  // Al día siguiente todavía lo trae: empieza en naranja desde la mañana
  const manana8 = new Date(Date.UTC(2026, 10, 12, 14, 0));
  assert.equal(require('../server').efectivoEnMano(pilotoId, manana8).nivel, 'naranja');
  assert.equal(recordarEfectivo(manana8), 1);

  // No termina el día sin entregarlo: solo puede dejar de recibir envíos para ir a la sede
  assert.equal((await piloto('POST', '/api/piloto/en-linea', { en_linea: true, lat: ZONA1.lat, lng: ZONA1.lng })).status, 200);
  const no = await piloto('POST', '/api/piloto/en-linea', { en_linea: false });
  assert.equal(no.status, 409); assert.match(no.j.error, /Q435\.00 de Vaelo.*entrégalo en la sede/);
  assert.equal(db.prepare('SELECT en_linea FROM usuarios WHERE id = ?').get(pilotoId).en_linea, 1);
  assert.equal((await piloto('POST', '/api/piloto/en-linea', { en_linea: false, voy_a_sede: true })).status, 200);
  assert.equal((await yo()).monto, 435, 'la alerta sigue hasta que la oficina lo marque');

  // La oficina marca «Dinero entregado»: desaparece la alerta, no se le bloquea y su ganancia se sigue juntando
  const antes = (await admin('GET', '/api/admin/sueldos')).j.pilotos.find((x) => x.id === pilotoId);
  assert.equal(antes.efectivo, 435);
  assert.equal((await admin('POST', '/api/admin/caja/liquidar', { piloto_id: pilotoId, recibido: 435, nota: 'Dinero entregado en la sede' })).status, 200);
  assert.equal(await yo(), null);
  assert.equal(recordarEfectivo(gt(20)), 0);
  const despues = (await admin('GET', '/api/admin/sueldos')).j.pilotos.find((x) => x.id === pilotoId);
  if (despues) { assert.equal(despues.efectivo, 0); assert.equal(despues.ganancia, antes.ganancia, 'lo ganado sigue pendiente de pago'); }
  assert.equal((await piloto('POST', '/api/piloto/en-linea', { en_linea: true, lat: ZONA1.lat, lng: ZONA1.lng })).status, 200);
  assert.equal((await piloto('POST', '/api/piloto/en-linea', { en_linea: false })).status, 200);

  // Plazo de días (para montos pequeños): aviso un día antes y al vencer, una vez cada uno
  ajuste('efectivo_aviso_monto', 1000);
  // Un momento de día (entre 8 a. m. y 9 p. m. de Guatemala) cercano a la hora real, para que la prueba no dependa del reloj
  const ahoraReal = new Date(), horaGT = (ahoraReal.getUTCHours() + 18) % 24;
  const medio = horaGT >= 8 && horaGT < 21 ? ahoraReal : new Date(Math.floor((ahoraReal.getTime() - 18 * 3600_000) / 86400_000) * 86400_000 + 18 * 3600_000);
  const hace = (h) => `'${new Date(medio.getTime() - h * 3600_000).toISOString().slice(0, 19).replace('T', ' ')}'`;
  cerrado(hace(50));
  ef = require('../server').efectivoEnMano(pilotoId, medio); assert.ok(ef.horas <= 24 && ef.horas > 0, 'horas: ' + ef.horas); assert.equal(ef.nivel, null);
  assert.equal(recordarEfectivo(medio), 1); assert.equal(recordarEfectivo(medio), 0);
  cerrado(hace(80));
  db.prepare("UPDATE usuarios SET efectivo_aviso = (SELECT piloto_cerro_en FROM envios WHERE id = ?) || '|manana' WHERE id = ?").run(id, pilotoId);
  assert.equal((await yo()).vencido, true);
  assert.equal(recordarEfectivo(medio), 1); assert.equal(recordarEfectivo(medio), 0);
  assert.equal((await piloto('POST', '/api/piloto/en-linea', { en_linea: true, lat: ZONA1.lat, lng: ZONA1.lng })).status, 403);
  db.prepare('UPDATE envios SET liquidado_id = 999 WHERE id = ?').run(id);
});

// Crea una tienda minorista lista para enviar (registro + aprobación de la oficina si hace falta)
async function tiendaLista(email, tienda) {
  const t = cliente();
  const r = await t('POST', '/api/registro', { nombre: 'Dueña ' + tienda, email, telefono: '5' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0'), password: 'clave-de-prueba-123', acepto_terminos: true, tienda,
    tienda_red: 'facebook.com/' + tienda.replace(/\W/g, ''), tienda_zona: 'Zona 24', tienda_semana: 20 }, { 'x-real-ip': '10.9.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250) });
  assert.equal(r.status, 201, JSON.stringify(r.j));
  const id = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email).id;
  if (db.prepare('SELECT tienda_estado FROM usuarios WHERE id = ?').get(id)?.tienda_estado === 'pendiente') {
    const ap = await admin('POST', `/api/admin/tiendas/${id}/aprobar`, { plan_id: db.prepare("SELECT id FROM planes WHERE clave = 'minorista'").get().id });
    assert.equal(ap.status, 200, JSON.stringify(ap.j));
  }
  return { t, id };
}

test('zona foco: cada carpeta se revisa sola, baja el precio solo a lo que califica y el piloto gana lo acordado', async () => {
  const reales = JSON.parse(fs.readFileSync(path.join(__dirname, 'datos', 'zonas-reales.json'), 'utf8'));
  const antes = db.prepare('SELECT * FROM zonas_fijas').all();
  db.exec('PRAGMA foreign_keys = OFF; DELETE FROM zonas_fijas');
  for (const z of reales) db.prepare('INSERT INTO zonas_fijas (nombre, activa, poligono) VALUES (?, ?, ?)').run(z.nombre, z.activa, z.poligono);
  try {
    const hoy = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
    const L = { 'Zona 24': [14.6183, -90.4368], 'Zona 17': [14.6408, -90.4752], 'Zona 1': [14.6360, -90.5130] };
    const { t: sofi, id: sofiId } = await tiendaLista('sofi.lives@prueba.com', 'Sofi Lives');
    const minorista = db.prepare("SELECT id FROM planes WHERE clave = 'minorista'").get().id;
    const cond = (propias) => admin('PUT', `/api/admin/empresas/${sofiId}/condiciones`, { plan_id: minorista, propias });
    // Validaciones
    assert.equal((await cond({ foco_zona: 'Zona 99', foco_precio: 20, foco_ganancia: 10 })).status, 400, 'zona que no existe');
    assert.equal((await cond({ foco_zona: 'Zona 24', foco_precio: 20, foco_ganancia: 25 })).status, 400, 'el piloto no gana más que el precio');
    const ok = await cond({ foco_zona: 'Zona 24', foco_precio: 20, foco_ganancia: 10 });
    assert.equal(ok.status, 200, JSON.stringify(ok.j));
    assert.match(ok.j.lineas.map((l) => l.texto).join(' '), /tus envíos a Zona 24 cuestan Q20\.00.*desde 3.*al menos 5 en Zona 24/);
    let n = 0;
    const carpeta = async (zonas) => {
      const c = (await sofi('POST', '/api/empresa/carpetas', { dia: hoy, nombre: 'C' + n })).j.carpeta.id;
      const ids = [];
      for (const z of zonas) { n++;
        const r = await sofi('POST', `/api/empresa/carpetas/${c}/pedidos`, { descripcion: 'Blusa ' + n, tamano: 'pequeno', cliente_nombre: 'Clienta ' + n, cliente_telefono: '5566' + String(n).padStart(4, '0'), foto: FOTO, llenar: true,
          dia: hoy, horario: 'cualquiera', direccion: 'Casa ' + n, zona: z, lat: L[z][0] + n * 1e-5, lng: L[z][1], recibe_nombre: 'Clienta ' + n, recibe_telefono: '5566' + String(n).padStart(4, '0'), metodo_pago: 'efectivo' });
        assert.equal(r.status, 201, JSON.stringify(r.j)); ids.push(r.j.pedido.id); }
      return { c, ids };
    };
    const vista = async (c) => (await sofi('GET', '/api/empresa/carpetas')).j.abiertas.find((x) => x.id === c).foco;
    const enviar = async (c) => {
      const r = await sofi('POST', `/api/empresa/carpetas/${c}/enviar`, { modo: 'una_moto', recogida: 'sede' }); assert.equal(r.status, 201, JSON.stringify(r.j));
      assert.equal((await admin('POST', `/api/admin/lotes-empresa/${r.j.lote}/recibido`, {})).status, 200);
      const calc = await admin('POST', `/api/admin/lotes-empresa/${r.j.lote}/calcular`, { modo: 'una_moto', motos: 1 });
      const lote = (await admin('GET', `/api/admin/lotes-empresa/${r.j.lote}`)).j.lote;
      assert.equal((await admin('POST', `/api/admin/lotes-empresa/${r.j.lote}/confirmar`, { modo: 'una_moto', rutas: calc.j.rutas.map((x) => ({ pedidos: x.pedidos, piloto_id: null })) })).status, 200);
      return { r: r.j, lote };
    };
    const envio = (pid) => db.prepare('SELECT precio, ganancia_acordada, tarifa_foco FROM envios WHERE pedido_id = ?').get(pid);

    // A: 3 pedidos, todos de Zona 24 → aplica
    const A = await carpeta(['Zona 24', 'Zona 24', 'Zona 24']);
    let f = await vista(A.c);
    assert.equal(f.aplica, true); assert.equal(f.con_descuento, 3); assert.equal(f.precio, 20); assert.equal(f.ganancia, undefined, 'la tienda no ve lo que gana el piloto');
    const tokA = db.prepare('SELECT token FROM pedidos_empresa WHERE id = ?').get(A.ids[0]).token;
    const antesEnviar = (await cliente()('GET', '/api/pedido/' + tokA)).j;
    assert.equal(antesEnviar.precio.precio, 35, 'antes de enviar, la compradora ve el precio normal: ' + JSON.stringify(antesEnviar.precio));
    const sa = await enviar(A.c);
    assert.equal(sa.r.foco.aplica, true); assert.equal(sa.lote.foco.aplica, true); assert.equal(sa.lote.foco.ganancia, 10);
    assert.equal(sa.lote.pedidos.filter((p) => p.zona_foco).length, 3);
    for (const id of A.ids) assert.deepEqual(envio(id), { precio: 20, ganancia_acordada: 10, tarifa_foco: 1 });
    const pa = (await cliente()('GET', '/api/pedido/' + tokA)).j;
    assert.equal(pa.precio.precio, 20); assert.equal(pa.precio.foco, true); assert.equal(pa.envio.precio, 20);
    // Al entregar, el piloto gana lo acordado
    const eA = db.prepare('SELECT id FROM envios WHERE pedido_id = ?').get(A.ids[0]).id;
    db.prepare("UPDATE envios SET mensajero_id = ?, asignacion = 'aceptado' WHERE id = ?").run(pilotoId, eA);
    db.prepare("UPDATE envios SET estado = 'en_camino' WHERE id = ?").run(eA);
    const dA = db.prepare('SELECT codigo_entrega, destino_lat, destino_lng FROM envios WHERE id = ?').get(eA);
    const ent = await piloto('POST', `/api/piloto/envios/${eA}/estado`, { estado: 'entregado', codigo: dA.codigo_entrega, foto: FOTO, recibio: 'Clienta', lat: dA.destino_lat, lng: dA.destino_lng });
    assert.equal(ent.status, 200, JSON.stringify(ent.j));
    assert.equal(db.prepare('SELECT ganancia_piloto FROM envios WHERE id = ?').get(eA).ganancia_piloto, 10);
    const pil = (await piloto('GET', '/api/piloto/envios')).j;
    const lista = pil.envios || pil.activos || pil;
    if (Array.isArray(lista)) { const x = lista.find((e) => e.id === db.prepare('SELECT id FROM envios WHERE pedido_id = ?').get(A.ids[1]).id); if (x) { assert.equal(x.tarifa_foco, 1); assert.equal(x.ganancia_acordada, undefined); } }

    // B: 4 en Zona 24 + 2 en Zona 17 → no aplica (hay otras zonas y menos de 5 en foco)
    const B = await carpeta(['Zona 24', 'Zona 24', 'Zona 24', 'Zona 24', 'Zona 17', 'Zona 17']);
    f = await vista(B.c);
    assert.equal(f.aplica, false); assert.match(f.texto, /al menos 5 en Zona 24/); assert.match(f.falta, /falta 1 pedido en Zona 24/);
    const sb = await enviar(B.c);
    assert.equal(sb.lote.foco.aplica, false);
    for (const id of B.ids) { const e = envio(id); assert.equal(e.precio, 35); assert.equal(e.tarifa_foco, 0); assert.equal(e.ganancia_acordada, 30, 'el piloto gana lo normal'); }

    // C: 10 en Zona 24 + 2 en Zona 17, solo zona foco → aplica a los 10; los de Zona 17 pagan normal
    const C = await carpeta([...Array(10).fill('Zona 24'), 'Zona 17', 'Zona 17']);
    f = await vista(C.c); assert.equal(f.aplica, true); assert.equal(f.con_descuento, 10);
    await enviar(C.c);
    assert.equal(C.ids.filter((id) => envio(id).tarifa_foco).length, 10);
    for (const id of C.ids.slice(10)) assert.deepEqual(envio(id), { precio: 35, ganancia_acordada: 30, tarifa_foco: 0 });

    // D: lo mismo con «zona foco con zonas vecinas» (Zona 17) → los 12 con descuento
    assert.equal((await cond({ foco_zona: 'Zona 24', foco_precio: 20, foco_ganancia: 10, foco_modo: 'vecinas', foco_vecinas: ['Zona 17', 'Zona 24'] })).status, 200);
    assert.deepEqual(jsonPropias(sofiId).foco_vecinas, ['Zona 17'], 'la zona foco no se repite como vecina');
    const D = await carpeta([...Array(10).fill('Zona 24'), 'Zona 17', 'Zona 1']);
    f = await vista(D.c); assert.equal(f.aplica, true); assert.equal(f.con_descuento, 11); assert.equal(f.en_vecinas, 1); assert.equal(f.otras, 1);
    await enviar(D.c);
    assert.equal(envio(D.ids[10]).precio, 20, 'Zona 17 vecina con descuento'); assert.deepEqual(envio(D.ids[11]), { precio: 35, ganancia_acordada: 30, tarifa_foco: 0 }, 'Zona 1 (no es vecina) paga normal');

    // E: 5 en Zona 24 + 6 en Zona 17 (solo foco) → la mayoría está fuera, no aplica
    assert.equal((await cond({ foco_zona: 'Zona 24', foco_precio: 20, foco_ganancia: 10 })).status, 200);
    const E = await carpeta([...Array(5).fill('Zona 24'), ...Array(6).fill('Zona 17')]);
    f = await vista(E.c); assert.equal(f.aplica, false); assert.match(f.texto, /más de la mitad/);
    // Los mínimos y el porcentaje se editan: con 40% sí aplica
    assert.equal((await cond({ foco_zona: 'Zona 24', foco_precio: 20, foco_ganancia: 10, foco_mayoria: 40 })).status, 200);
    f = await vista(E.c); assert.equal(f.aplica, true); assert.equal(f.con_descuento, 5);

    // Precio de plan más bajo: la compradora paga menos, pero el piloto gana lo normal
    assert.equal((await cond({ precio_zona: 30 })).status, 200);
    const G = await carpeta(['Zona 17', 'Zona 17', 'Zona 17']);
    await enviar(G.c);
    for (const id of G.ids) assert.deepEqual(envio(id), { precio: 30, ganancia_acordada: 30, tarifa_foco: 0 });
    assert.equal((await cond({})).status, 200);
  } finally {
    db.exec('DELETE FROM zonas_fijas');
    for (const z of antes) db.prepare('INSERT INTO zonas_fijas (id, nombre, activa, poligono) VALUES (?, ?, ?, ?)').run(z.id, z.nombre, z.activa, z.poligono);
    db.exec('PRAGMA foreign_keys = ON');
  }
});
const jsonPropias = (id) => JSON.parse(db.prepare('SELECT condiciones_propias FROM usuarios WHERE id = ?').get(id).condiciones_propias || '{}');
