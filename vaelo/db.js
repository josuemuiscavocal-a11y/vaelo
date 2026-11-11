// Base de datos de Vaelo (SQLite integrado en Node.js 22, sin instalar nada extra)
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.VAELO_DATA || path.join(__dirname, 'datos');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'vaelo.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

const columnas = (tabla) => db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
const existeTabla = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

// ---------- Migración desde la versión 1 (El Salvador) ----------
db.exec('PRAGMA foreign_keys = OFF');
if (existeTabla('usuarios')) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='usuarios'").get().sql;
  if (!sql.includes('mensajero')) {
    db.exec(`
      BEGIN;
      CREATE TABLE usuarios_nueva (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        telefono TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        rol TEXT NOT NULL DEFAULT 'cliente' CHECK (rol IN ('cliente','admin','mensajero')),
        vehiculo_id INTEGER,
        activo INTEGER NOT NULL DEFAULT 1,
        ubic_lat REAL, ubic_lng REAL, ubic_fecha TEXT,
        creado TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO usuarios_nueva (id, nombre, email, telefono, password_hash, rol, creado)
        SELECT id, nombre, email, telefono, password_hash, rol, creado FROM usuarios;
      DROP TABLE usuarios;
      ALTER TABLE usuarios_nueva RENAME TO usuarios;
      COMMIT;`);
  }
}
if (existeTabla('envios') && !columnas('envios').includes('vehiculo_id')) {
  // Los envíos de prueba de la versión anterior se guardan aparte, no se borran
  db.exec('ALTER TABLE envios RENAME TO envios_v1; ALTER TABLE eventos RENAME TO eventos_v1;');
}
db.exec('PRAGMA foreign_keys = ON');

// ---------- Esquema actual ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    telefono TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    rol TEXT NOT NULL DEFAULT 'cliente' CHECK (rol IN ('cliente','admin','mensajero','operador')),
    vehiculo_id INTEGER,
    activo INTEGER NOT NULL DEFAULT 1,
    ubic_lat REAL, ubic_lng REAL, ubic_fecha TEXT,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    token TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vehiculos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    descripcion TEXT NOT NULL DEFAULT '',
    peso_max REAL NOT NULL,          -- libras
    tarifa_zona REAL NOT NULL,       -- precio fijo dentro de las zonas de la capital
    tarifa_base REAL NOT NULL,       -- precio de arranque fuera de esas zonas
    precio_km REAL NOT NULL,         -- precio por kilómetro fuera de esas zonas
    activo INTEGER NOT NULL DEFAULT 1,
    orden INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS zonas_fijas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    activa INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS envios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guia TEXT NOT NULL UNIQUE,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    vehiculo_id INTEGER NOT NULL REFERENCES vehiculos(id),
    peso REAL NOT NULL,
    descripcion TEXT NOT NULL DEFAULT '',
    origen_direccion TEXT NOT NULL,
    origen_zona TEXT NOT NULL,
    origen_telefono TEXT NOT NULL,
    origen_lat REAL, origen_lng REAL,
    destino_nombre TEXT NOT NULL,
    destino_telefono TEXT NOT NULL,
    destino_direccion TEXT NOT NULL,
    destino_zona TEXT NOT NULL,
    destino_lat REAL, destino_lng REAL,
    tipo_tarifa TEXT NOT NULL CHECK (tipo_tarifa IN ('zona','km')),
    km REAL,
    precio REAL NOT NULL,
    metodo_pago TEXT NOT NULL DEFAULT 'efectivo',
    cobro_destinatario REAL NOT NULL DEFAULT 0,
    notas TEXT NOT NULL DEFAULT '',
    estado TEXT NOT NULL DEFAULT 'pendiente',
    mensajero_id INTEGER REFERENCES usuarios(id),
    creado TEXT NOT NULL DEFAULT (datetime('now')),
    actualizado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_envios_usuario ON envios(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_envios_estado ON envios(estado);
  CREATE INDEX IF NOT EXISTS idx_envios_mensajero ON envios(mensajero_id);

  CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    envio_id INTEGER NOT NULL REFERENCES envios(id) ON DELETE CASCADE,
    estado TEXT NOT NULL,
    nota TEXT NOT NULL DEFAULT '',
    lat REAL, lng REAL,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ajustes (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );
`);

// ---------- Columnas agregadas después (se crean solas si faltan) ----------
function agregarColumnas(tabla, lista) {
  const hay = columnas(tabla);
  for (const [col, tipo] of lista) if (!hay.includes(col)) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${tipo}`);
}
const columnasPilotoNuevas = !columnas('usuarios').includes('estado_piloto');
agregarColumnas('usuarios', [
  // Identidad (pilotos y clientes)
  ['fecha_nacimiento', 'TEXT'], ['dpi', 'TEXT'], ['doc_frente', 'TEXT'], ['doc_reverso', 'TEXT'], ['foto_perfil', 'TEXT'],
  ['direccion', 'TEXT'], ['doc_recibo', 'TEXT'],
  // Cliente: correo confirmado y revisión de identidad
  ['email_verificado', 'INTEGER NOT NULL DEFAULT 0'], ['verificacion', "TEXT NOT NULL DEFAULT 'sin_datos'"], ['verificacion_nota', 'TEXT'],
  // Piloto: estado, contacto de emergencia y datos fiscales
  ['estado_piloto', 'TEXT'], ['en_linea', 'INTEGER NOT NULL DEFAULT 0'],
  ['emergencia_nombre', 'TEXT'], ['emergencia_parentesco', 'TEXT'], ['emergencia_telefono', 'TEXT'], ['nit', 'TEXT'], ['referencias', 'TEXT'],
  // Piloto: antecedentes y licencia
  ['penales_doc', 'TEXT'], ['penales_fecha', 'TEXT'], ['policiacos_doc', 'TEXT'], ['policiacos_fecha', 'TEXT'],
  ['licencia_numero', 'TEXT'], ['licencia_tipo', 'TEXT'], ['licencia_vence', 'TEXT'], ['licencia_frente', 'TEXT'], ['licencia_reverso', 'TEXT'],
  // Piloto: vehículo
  ['veh_placa', 'TEXT'], ['veh_marca', 'TEXT'], ['veh_modelo', 'TEXT'], ['veh_anio', 'INTEGER'], ['veh_color', 'TEXT'],
  ['veh_tarjeta', 'TEXT'], ['veh_foto_frente', 'TEXT'], ['veh_foto_lado', 'TEXT'], ['veh_foto_placa', 'TEXT'],
  ['veh_propio', 'INTEGER NOT NULL DEFAULT 1'], ['veh_carta', 'TEXT'], ['seguro_aseguradora', 'TEXT'], ['seguro_vence', 'TEXT'],
  // Piloto: equipo entregado, reglas aceptadas y notas internas
  ['equipo', 'TEXT'], ['reglas_aceptadas', 'TEXT'], ['nota_admin', 'TEXT'],
]);
if (columnasPilotoNuevas) {
  // Las cuentas que ya existían no se bloquean: mensajeros aprobados y correos dados por confirmados
  db.exec("UPDATE usuarios SET estado_piloto = 'aprobado' WHERE rol = 'mensajero'");
  db.exec('UPDATE usuarios SET email_verificado = 1');
}
agregarColumnas('envios', [
  ['fragil', 'INTEGER NOT NULL DEFAULT 0'], ['recargo_fragil', 'REAL NOT NULL DEFAULT 0'],
  ['asignacion', 'TEXT'], ['asignado_en', 'TEXT'], ['rechazado_en', 'TEXT'],
  ['llego_origen', 'INTEGER NOT NULL DEFAULT 0'], ['llegando_destino', 'INTEGER NOT NULL DEFAULT 0'],
  ['calificacion', 'INTEGER'], ['calificacion_comentario', 'TEXT'],
]);
agregarColumnas('usuarios', [
  // Cuentas de empresa: precio especial y pago a fin de mes
  ['tipo_cuenta', "TEXT NOT NULL DEFAULT 'personal'"], ['empresa_nombre', 'TEXT'], ['descuento_empresa', 'REAL NOT NULL DEFAULT 0'], ['credito_permitido', 'INTEGER NOT NULL DEFAULT 0'],
]);
agregarColumnas('envios', [
  // Entrega segura: código que da quien recibe, foto y firma
  ['codigo_entrega', 'TEXT'], ['intentos_codigo', 'INTEGER NOT NULL DEFAULT 0'], ['foto_entrega', 'TEXT'], ['firma_entrega', 'TEXT'], ['recibio', 'TEXT'], ['entregado_en', 'TEXT'],
  // Descuentos y programación
  ['precio_base', 'REAL'], ['descuento', 'REAL NOT NULL DEFAULT 0'], ['promocion_id', 'INTEGER'], ['programado_para', 'TEXT'],
  // Dinero: efectivo que entrega el piloto, lo que gana, cobros a devolver y crédito de empresas
  ['liquidado_id', 'INTEGER'], ['ganancia_piloto', 'REAL'], ['pago_piloto_id', 'INTEGER'], ['cobro_pagado_en', 'TEXT'], ['credito_pagado_en', 'TEXT'],
  // Asignación automática: pilotos que ya no aceptaron este envío
  ['excluidos', 'TEXT'],
]);
agregarColumnas('envios', [
  // Enlace para quien recibe: confirma con su foto y comparte su ubicación en vivo hasta la entrega
  ['receptor_token', 'TEXT'], ['receptor_nombre', 'TEXT'], ['receptor_foto', 'TEXT'], ['receptor_confirmado_en', 'TEXT'],
  ['receptor_lat', 'REAL'], ['receptor_lng', 'REAL'], ['receptor_precision', 'REAL'], ['receptor_ubic_fecha', 'TEXT'],
  ['receptor_omitido', 'TEXT'],
]);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_envios_receptor ON envios(receptor_token)');
agregarColumnas('envios', [
  // Recogida en la ubicación en vivo: la da quien pide ('cliente') u otra persona con su propio enlace ('tercero')
  ['origen_quien', "TEXT NOT NULL DEFAULT 'cliente'"], ['origen_nombre', 'TEXT'], ['origen_token', 'TEXT'], ['origen_foto', 'TEXT'],
  ['origen_confirmado_en', 'TEXT'], ['origen_ubic_fecha', 'TEXT'], ['origen_precision', 'REAL'],
  // Fuera de las zonas fijas el precio por km se calcula cuando ya se conocen las dos ubicaciones
  ['precio_por_confirmar', 'INTEGER NOT NULL DEFAULT 0'],
]);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_envios_origen_token ON envios(origen_token)');
// Se permite el rol "operador" (empleados de oficina) en bases creadas antes
{
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='usuarios'").get().sql;
  if (!sql.includes("'operador'")) {
    const nueva = sql.replace(/CREATE TABLE\s+"?usuarios"?/, 'CREATE TABLE usuarios_nueva')
      .replace(/CHECK\s*\(rol IN \('cliente','admin','mensajero'\)\)/, "CHECK (rol IN ('cliente','admin','mensajero','operador'))");
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(nueva);
      db.exec('INSERT INTO usuarios_nueva SELECT * FROM usuarios; DROP TABLE usuarios; ALTER TABLE usuarios_nueva RENAME TO usuarios;');
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    db.exec('PRAGMA foreign_keys = ON');
  }
}
db.exec(`
  CREATE TABLE IF NOT EXISTS promociones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    codigo TEXT,
    tipo TEXT NOT NULL CHECK (tipo IN ('porcentaje','monto','gratis')),
    valor REAL NOT NULL DEFAULT 0,
    desde TEXT NOT NULL, hasta TEXT NOT NULL,
    solo_primer_envio INTEGER NOT NULL DEFAULT 0,
    usos_max INTEGER, usos_por_cliente INTEGER, minimo REAL,
    activa INTEGER NOT NULL DEFAULT 1,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS direcciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL, direccion TEXT NOT NULL, zona TEXT NOT NULL, telefono TEXT, contacto TEXT,
    lat REAL, lng REAL,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS liquidaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    piloto_id INTEGER NOT NULL REFERENCES usuarios(id),
    esperado REAL NOT NULL, recibido REAL NOT NULL, envios INTEGER NOT NULL, nota TEXT,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pagos_piloto (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    piloto_id INTEGER NOT NULL REFERENCES usuarios(id),
    monto REAL NOT NULL, envios INTEGER NOT NULL, nota TEXT,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS alertas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    piloto_id INTEGER NOT NULL REFERENCES usuarios(id),
    tipo TEXT NOT NULL, lat REAL, lng REAL, envio_id INTEGER,
    creado TEXT NOT NULL DEFAULT (datetime('now')), atendida_en TEXT, atendida_por TEXT
  );
  CREATE TABLE IF NOT EXISTS tokens_correo (
    token TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira INTEGER NOT NULL
  );
  -- Recorrido GPS de los pilotos (se guarda 30 días, por si hay un accidente o un reclamo)
  CREATE TABLE IF NOT EXISTS ubicaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    envio_id INTEGER,
    lat REAL NOT NULL, lng REAL NOT NULL, precision_m REAL,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ubicaciones_envio ON ubicaciones(envio_id);
  CREATE INDEX IF NOT EXISTS idx_ubicaciones_usuario ON ubicaciones(usuario_id, creado);
`);
// Solo un correo puede ser administrador; cualquier otra cuenta de administrador pasa a ser cuenta de cliente
db.prepare("UPDATE usuarios SET rol = 'cliente' WHERE rol = 'admin' AND email != ?")
  .run(String(process.env.VAELO_ADMIN_EMAIL_UNICO || 'administracionvaelo@vaelomensajeria.com').toLowerCase());

// ---------- Datos iniciales (se cambian desde el panel) ----------
if (!db.prepare('SELECT COUNT(*) AS n FROM vehiculos').get().n) {
  const ins = db.prepare(`INSERT INTO vehiculos (nombre, descripcion, peso_max, tarifa_zona, tarifa_base, precio_km, orden)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  ins.run('Moto', 'Sobres, paquetes y cajas pequeñas', 30, 35, 45, 0, 1);
  ins.run('Pickup', 'Cajas grandes, varios bultos o mercadería', 1500, 150, 150, 8, 2);
}
if (!db.prepare('SELECT COUNT(*) AS n FROM zonas_fijas').get().n) {
  const ins = db.prepare('INSERT INTO zonas_fijas (nombre) VALUES (?)');
  ['Zona 1', 'Zona 6', 'Zona 16', 'Zona 17', 'Zona 18', 'Zona 24'].forEach((z) => ins.run(z));
}
const insAj = db.prepare('INSERT OR IGNORE INTO ajustes (clave, valor) VALUES (?, ?)');
insAj.run('whatsapp', '');
insAj.run('horario', 'Lunes a sábado, 8:00 a. m. a 6:00 p. m.');
insAj.run('recargo_fragil', '10');            // Q extra por paquete frágil
insAj.run('precio_ayudante', '50');            // Q por cada ayudante en un flete (solo lo cambia administración)
insAj.run('bono_empresa', '0');               // Q que gana cada empresa por envío entregado (0 = apagado)
insAj.run('vigencia_antecedentes', '6');      // meses que valen los antecedentes penales y policiacos
insAj.run('auto_asignar', '0');               // asignar solo al piloto más cercano
insAj.run('segundos_aceptar', '60');          // tiempo que tiene el piloto para aceptar antes de pasar al siguiente
insAj.run('comision_tipo', 'porcentaje');     // lo que gana el piloto por entrega: porcentaje del envío o monto fijo
insAj.run('comision_valor', '70');
insAj.run('exigir_receptor', '1');         // quien recibe debe confirmar con foto y ubicación antes de que se recoja el paquete
// Ajustes de la versión 1 que ya no se usan
db.prepare("DELETE FROM ajustes WHERE clave IN ('recargo_mediano','recargo_grande')").run();

// ---------- Versión 3: entregas fallidas, cargos, avisos, precios por zona dibujada, seguro y tiendas ----------
agregarColumnas('usuarios', [
  ['terminos_aceptados', 'TEXT'],
  // Tiendas en línea: clave de la API (se guarda solo su huella) y dirección para avisar cambios de estado
  ['api_clave_hash', 'TEXT'], ['api_clave_pista', 'TEXT'], ['webhook_url', 'TEXT'], ['webhook_secreto', 'TEXT'],
]);
agregarColumnas('envios', [
  // Entrega fallida: el cliente elige devolver (cargo fijo) o guardar en la sede (cargo por día)
  ['fallo_motivo', 'TEXT'], ['fallo_nota', 'TEXT'], ['fallo_en', 'TEXT'], ['fallo_foto', 'TEXT'],
  ['fallo_decision', 'TEXT'], ['fallo_decidido_en', 'TEXT'], ['fallo_decidido_por', 'TEXT'],
  ['sede_llegada', 'TEXT'], ['sede_salida', 'TEXT'], ['devuelto_en', 'TEXT'], ['devuelto_a', 'TEXT'],
  ['reentrega_de', 'INTEGER'],
  // Momento en que el piloto terminó su parte (entregó, devolvió, dejó en la sede o le cancelaron yendo en camino)
  ['piloto_cerro_en', 'TEXT'],
  // Cargos pendientes del cliente que se cobran junto con este envío
  ['cargos_extra', 'REAL NOT NULL DEFAULT 0'],
  // Valor declarado y seguro opcional
  ['valor_declarado', 'REAL NOT NULL DEFAULT 0'], ['seguro', 'REAL NOT NULL DEFAULT 0'],
  // Transferencia: foto del comprobante y revisión
  ['comprobante', 'TEXT'], ['pago_estado', 'TEXT'], ['pago_nota', 'TEXT'],
  // El piloto califica al cliente
  ['calif_cliente', 'INTEGER'], ['calif_cliente_comentario', 'TEXT'],
  // Varias entregas en un solo viaje (envíos por archivo)
  ['grupo', 'TEXT'],
  // Puntos con los que se calculó el precio: si se mueven más de 1 km se vuelve a calcular
  ['precio_o_lat', 'REAL'], ['precio_o_lng', 'REAL'], ['precio_d_lat', 'REAL'], ['precio_d_lng', 'REAL'],
]);
agregarColumnas('zonas_fijas', [['poligono', 'TEXT']]);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_envios_grupo ON envios(grupo);
  -- Cargos al cliente: cancelación tardía, devolución, días en la sede y nueva entrega desde la sede
  CREATE TABLE IF NOT EXISTS cargos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    envio_id INTEGER REFERENCES envios(id),
    tipo TEXT NOT NULL,
    monto REAL NOT NULL,
    nota TEXT,
    cobrado_envio_id INTEGER,          -- se cobró junto con otro envío (lo recibe su piloto o va en su transferencia)
    pagado_en TEXT, pagado_como TEXT,  -- pagado directo en la sede o marcado por la administración
    anulado_en TEXT, anulado_por TEXT,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cargos_usuario ON cargos(usuario_id);
  -- Avisos al celular (notificaciones push)
  CREATE TABLE IF NOT EXISTS push_suscripciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Enlaces para crear una contraseña nueva
  CREATE TABLE IF NOT EXISTS tokens_clave (
    token TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira INTEGER NOT NULL
  );
`);
// Envíos que ya estaban entregados antes de esta versión: el piloto ya había terminado su parte
db.exec("UPDATE envios SET piloto_cerro_en = COALESCE(entregado_en, actualizado) WHERE estado = 'entregado' AND mensajero_id IS NOT NULL AND piloto_cerro_en IS NULL");
insAj.run('cargo_devolucion', '35');         // devolver el paquete a quien lo envió
insAj.run('cargo_bodega_dia', '20');          // cada día (o fracción) que el paquete está en la sede
insAj.run('cargo_reentrega', '35');           // volver a llevarlo desde la sede
insAj.run('horas_decidir_fallido', '2');      // si el cliente no elige en este tiempo, el paquete va a la sede
insAj.run('cargo_cancelacion', '15');         // cancelar cuando el piloto ya va a recoger
insAj.run('pct_piloto_cancelacion', '50');    // parte del cargo por cancelación que gana el piloto
insAj.run('sede_direccion', '');
insAj.run('sede_lat', '');
insAj.run('sede_lng', '');
insAj.run('seguro_pct', '2');                 // costo del seguro: % del valor declarado
insAj.run('seguro_minimo', '5');
insAj.run('responsabilidad_max', '300');      // lo máximo que Vaelo responde por un paquete sin seguro
insAj.run('km_max_tarifa_fija', '15');        // sin zonas dibujadas: más km que esto deja de ser tarifa fija
insAj.run('datos_transferencia', '');
insAj.run('correo_respaldos', '');

// ---------- Versión 4: políticas, reclamos, fletes, empresas con contrato y bodega ----------
agregarColumnas('usuarios', [
  ['politica_piloto', 'TEXT'],           // fecha en que el piloto aceptó la versión vigente de la política
  ['politica_piloto_version', 'INTEGER'],
  ['politica_empresa', 'TEXT'],
]);
agregarColumnas('vehiculos', [['solo_oficina', 'INTEGER NOT NULL DEFAULT 0']]);   // pickup: solo como flete por WhatsApp
agregarColumnas('envios', [
  ['foto_paquete', 'TEXT'],              // foto que toma el cliente al pedir: muestra qué lleva
  ['paquetes', 'INTEGER NOT NULL DEFAULT 1'],   // varios paquetes a la misma dirección, mismo precio
  ['flete', 'INTEGER NOT NULL DEFAULT 0'],      // flete en pickup creado por la oficina (precio a mano)
  ['flete_cliente', 'TEXT'], ['flete_telefono', 'TEXT'],
  ['lote_sede_id', 'INTEGER'],           // paquete de un envío de empresa a la sede de Vaelo
]);
db.exec(`
  -- Reclamos por paquete perdido, dañado o incompleto: se evalúa y se devuelve dinero al cliente
  CREATE TABLE IF NOT EXISTS reclamos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    envio_id INTEGER NOT NULL REFERENCES envios(id),
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    tipo TEXT NOT NULL, descripcion TEXT NOT NULL, foto TEXT,
    estado TEXT NOT NULL DEFAULT 'abierto',          -- abierto, aprobado, rechazado
    monto_cliente REAL NOT NULL DEFAULT 0,           -- devolución al cliente
    monto_piloto REAL NOT NULL DEFAULT 0,            -- lo que paga el piloto responsable
    piloto_id INTEGER, resolucion TEXT, resuelto_por TEXT, resuelto_en TEXT,
    devuelto_en TEXT,                                -- cuándo se le pagó al cliente
    descontado_pago_id INTEGER,                      -- pago al piloto donde se descontó
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Solicitud de contrato de empresa: datos, fotos de la sede y del representante, cita y firma
  CREATE TABLE IF NOT EXISTS solicitudes_empresa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
    estado TEXT NOT NULL DEFAULT 'borrador',         -- borrador, enviada, cita, aprobada, rechazada
    empresa_nombre TEXT, razon_social TEXT, nit TEXT, giro TEXT, sitio_web TEXT,
    direccion TEXT, zona TEXT, telefono TEXT, correo TEXT, paquetes_mes INTEGER,
    rep_nombre TEXT, rep_cargo TEXT, rep_dpi TEXT, rep_telefono TEXT, rep_correo TEXT,
    foto_sede_frente TEXT, foto_sede_interior TEXT, foto_rep TEXT, dpi_rep_frente TEXT, dpi_rep_reverso TEXT, patente TEXT, rtu TEXT,
    acepto_politica TEXT,
    cita_fecha TEXT, cita_lugar TEXT, nota_admin TEXT, motivo_rechazo TEXT,
    enviada_en TEXT, aprobada_en TEXT,
    creado TEXT NOT NULL DEFAULT (datetime('now')), actualizado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Envío de una empresa a la sede de Vaelo (10 paquetes o más) para repartirlos desde ahí
  CREATE TABLE IF NOT EXISTS lotes_sede (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    paquetes INTEGER NOT NULL,
    estado TEXT NOT NULL DEFAULT 'esperando',        -- esperando (la empresa los lleva), recibido, cancelado
    entregar_desde TEXT,                             -- fecha en que la empresa quiere que salgan
    nota TEXT, recibido_en TEXT, recibido_por TEXT,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_envios_lote_sede ON envios(lote_sede_id);
`);
// Pickup: solo como flete pedido por WhatsApp (se marca una sola vez; desde el panel se puede cambiar)
if (!db.prepare("SELECT 1 FROM ajustes WHERE clave = 'v4_migrado'").get()) {
  db.exec("UPDATE vehiculos SET solo_oficina = 1 WHERE lower(nombre) LIKE '%pick%'");
  // Vaelo cobra Q5 fijos de cada envío; el resto es para el piloto
  db.exec("INSERT INTO ajustes (clave, valor) VALUES ('comision_tipo', 'vaelo_fijo') ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor");
  db.exec("INSERT INTO ajustes (clave, valor) VALUES ('comision_valor', '5') ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor");
  db.exec("UPDATE ajustes SET valor = '50237731793' WHERE clave = 'whatsapp' AND valor = ''");
  db.exec("INSERT INTO ajustes (clave, valor) VALUES ('v4_migrado', datetime('now'))");
}
agregarColumnas('envios', [['flete_token', 'TEXT'], ['flete_configurado_en', 'TEXT']]);
// Sin transferencias ni crédito: lo pendiente pasa a efectivo (una sola vez)
if (!db.prepare("SELECT 1 FROM ajustes WHERE clave = 'v6_solo_efectivo'").get()) {
  db.exec("UPDATE envios SET metodo_pago = 'efectivo', pago_estado = NULL WHERE metodo_pago IN ('transferencia', 'credito') AND COALESCE(pago_estado, '') != 'verificado' AND estado IN ('pendiente', 'recogido', 'en_camino')");
  db.exec("UPDATE usuarios SET credito_permitido = 0");
  db.exec("INSERT INTO ajustes (clave, valor) VALUES ('v6_solo_efectivo', datetime('now'))");
}
agregarColumnas('usuarios', [['renovacion_pendiente', 'TEXT']]);   // licencia o antecedentes renovados que la oficina todavía no confirma
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_envios_flete_token ON envios(flete_token)');
insAj.run('whatsapp_pagos', '50237731793');   // WhatsApp oficial donde se mandan los comprobantes de transferencia
insAj.run('dias_liquidar', '3');              // días que puede pasar un piloto sin entregar el efectivo en la sede
insAj.run('cargo_bodega_empresa', '10');      // Q por paquete por día en la sede (envíos de empresa)
insAj.run('min_paquetes_sede', '10');         // mínimo de paquetes para un envío de empresa a la sede
insAj.run('dias_reclamo', '3');               // días después de la entrega para reportar un problema

// ---------- Versión 5: pedidos de empresas con enlace, rutas, sueldos de pilotos y cierres del día ----------
db.exec(`
  -- Pedido que registra una empresa: su cliente confirma día, horario y ubicación con un enlace
  CREATE TABLE IF NOT EXISTS pedidos_empresa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    codigo TEXT NOT NULL UNIQUE,                     -- el mismo código queda como guía del envío
    token TEXT NOT NULL UNIQUE,                      -- enlace del cliente: /pedido/<token>
    descripcion TEXT NOT NULL DEFAULT '', tamano TEXT NOT NULL DEFAULT 'pequeno', foto TEXT,
    cliente_nombre TEXT NOT NULL, cliente_telefono TEXT NOT NULL,
    dia TEXT, horario TEXT,                          -- AAAA-MM-DD y manana | tarde | cualquiera
    direccion TEXT, zona TEXT, lat REAL, lng REAL, referencias TEXT,
    recibe_nombre TEXT, recibe_telefono TEXT,
    metodo_pago TEXT,                                -- efectivo (al recibir) | transferencia
    estado TEXT NOT NULL DEFAULT 'pendiente',        -- pendiente, confirmado, enviado, vencido, cancelado
    enlace_enviado_en TEXT, confirmado_en TEXT, confirmado_por TEXT, recordado_en TEXT, vencido_aviso TEXT,
    transferencia_ok TEXT,                           -- la oficina confirmó la transferencia del cliente
    lote_id INTEGER, envio_id INTEGER,
    creado TEXT NOT NULL DEFAULT (datetime('now')), actualizado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pedidos_usuario ON pedidos_empresa(usuario_id, estado);
  CREATE INDEX IF NOT EXISTS idx_pedidos_lote ON pedidos_empresa(lote_id);
  -- Avisos al navegador del cliente de la empresa (no tiene cuenta)
  CREATE TABLE IF NOT EXISTS push_pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_id INTEGER NOT NULL REFERENCES pedidos_empresa(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- "Enviar a Vaelo": los pedidos confirmados de un día que la empresa manda juntos
  CREATE TABLE IF NOT EXISTS lotes_empresa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    dia TEXT NOT NULL,
    modo TEXT NOT NULL,                              -- una_moto | motos | pickup
    recogida TEXT NOT NULL DEFAULT 'empresa',        -- empresa (el piloto recoge) | sede (la empresa los lleva)
    paga TEXT NOT NULL DEFAULT 'clientes',           -- clientes | empresa (solo pickup, se acuerda por WhatsApp)
    recomendado TEXT, nota TEXT,
    estado TEXT NOT NULL DEFAULT 'nuevo',            -- nuevo, en_ruta, terminado, cancelado
    recibido_en TEXT, recibido_por TEXT,             -- paquetes recibidos en la sede
    origen_lat REAL, origen_lng REAL, origen_direccion TEXT,
    pickup_precio REAL, pickup_metodo TEXT, confirmado_por TEXT, confirmado_en TEXT,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Cuenta cerrada con un piloto: lo que ganó menos el efectivo que traía ("Ya fue pagado")
  CREATE TABLE IF NOT EXISTS cuentas_piloto (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    piloto_id INTEGER NOT NULL REFERENCES usuarios(id),
    envios INTEGER NOT NULL, ganancia REAL NOT NULL, descuentos REAL NOT NULL, efectivo REAL NOT NULL, transferencias REAL NOT NULL DEFAULT 0,
    neto REAL NOT NULL,                              -- positivo: Vaelo le pagó; negativo: el piloto entregó
    liquidacion_id INTEGER, pago_id INTEGER, cerrado_por TEXT NOT NULL, nota TEXT,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Cierre del día (botón en el panel): resumen y Excel guardados
  CREATE TABLE IF NOT EXISTS cierres (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    desde TEXT NOT NULL, hasta TEXT NOT NULL, dia TEXT NOT NULL,
    resumen TEXT NOT NULL, archivo TEXT, cerrado_por TEXT NOT NULL,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
agregarColumnas('envios', [
  ['pedido_id', 'INTEGER'], ['lote_empresa_id', 'INTEGER'], ['parada', 'INTEGER'], ['tamano', 'TEXT'], ['horario', 'TEXT'],
  ['cobro_en_recogida', 'REAL'],        // pickup que paga la empresa en efectivo: el piloto lo cobra al recoger
  ['aviso_proximo', 'TEXT'],            // ya se le avisó a quien recibe que es la próxima parada
  ['asignado_por', 'TEXT'],             // oficina: la ruta la asignó una persona y no vence si el piloto tarda en aceptar
]);
db.exec('CREATE INDEX IF NOT EXISTS idx_envios_pedido ON envios(pedido_id)');
agregarColumnas('usuarios', [
  ['frecuencia_pago', "TEXT NOT NULL DEFAULT 'diaria'"],   // piloto: diaria | semanal | quincenal
  ['empresa_lat', 'REAL'], ['empresa_lng', 'REAL'], ['empresa_direccion', 'TEXT'], ['empresa_zona', 'TEXT'],   // punto de recogida de la empresa
]);
insAj.run('tarifa_empresa_fuera', '45');      // pedidos de empresa fuera de las zonas con tarifa fija
insAj.run('min_pedidos_lote', '10');
insAj.run('min_pedidos_minorista', '3');    // lo mismo para tiendas minoristas (ventas en lives)          // pedidos confirmados del mismo día para "Enviar a Vaelo"
insAj.run('cupo_moto', '30');                 // cupo de una moto: sobre 1, pequeño 5, mediano 15
insAj.run('horas_ruta_moto', '4');            // más que esto en una sola moto: se recomienda partir la ruta
insAj.run('horas_recordatorio', '24');        // si el cliente no llena su enlace en este tiempo, se avisa a la empresa

// ---------- Versión 6: carpetas de envíos de empresa ----------
// La empresa arma una carpeta con un día de entrega y adentro va añadiendo envíos; cada cliente confirma con su enlace.
db.exec(`
  CREATE TABLE IF NOT EXISTS carpetas_empresa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    nombre TEXT NOT NULL,
    dia TEXT NOT NULL,                              -- AAAA-MM-DD: día en que se entregan
    estado TEXT NOT NULL DEFAULT 'abierta',          -- abierta | enviada | cancelada
    lote_id INTEGER,
    creado TEXT NOT NULL DEFAULT (datetime('now')), actualizado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_carpetas_usuario ON carpetas_empresa(usuario_id, estado);
`);
agregarColumnas('pedidos_empresa', [['carpeta_id', 'INTEGER'], ['no_puede_nota', 'TEXT']]);
// Bono para empresas: una parte de lo que gana Vaelo por cada envío entregado. La administración decide el monto
// (general o por empresa) y si se le paga o se le descuenta, según lo que acuerden.
agregarColumnas('usuarios', [['bono_envio', 'REAL'], ['bono_modo', "TEXT NOT NULL DEFAULT 'pago'"], ['bono_activo', 'INTEGER NOT NULL DEFAULT 0']]);
// Permisos de cada empleado de oficina: áreas del panel separadas por coma (vacío = todas)
agregarColumnas('usuarios', [['permisos', 'TEXT']]);
// Quien recibe también califica al piloto (de 1 a 5 estrellas)
agregarColumnas('envios', [['calif_receptor', 'INTEGER'], ['calif_receptor_comentario', 'TEXT']]);
// Empresas: recogida fija (días de la semana 0-6 separados por coma y hora) y datos para facturar
// Código corto para escribir a mano en el paquete (TB-07): sin impresora, el piloto sabe cuál es cuál
agregarColumnas('envios', [['codigo_corto', 'TEXT']]);
agregarColumnas('pedidos_empresa', [['codigo_corto', 'TEXT'], ['codigo_dia', 'TEXT']]);
agregarColumnas('pedidos_empresa', [['cobro', 'REAL NOT NULL DEFAULT 0']]);
// Punto de recogida de empresas y tiendas: siempre con la ubicación real del celular en el lugar.
// Si los paquetes están en otro lugar, una persona de ahí lo confirma con un enlace (/punto/<clave>).
agregarColumnas('usuarios', [['punto_contacto', 'TEXT'], ['punto_telefono', 'TEXT'], ['punto_fuente', 'TEXT'], ['punto_precision', 'REAL'], ['punto_actualizado', 'TEXT'],
  ['punto_token', 'TEXT'], ['punto_token_vence', 'TEXT'], ['punto_pend_nombre', 'TEXT'], ['punto_pend_telefono', 'TEXT']]);   // lo que la tienda cobra por su producto al entregar
// Cómo marca la empresa sus paquetes: etiqueta impresa, código escrito (TB-07) o nombre del cliente escrito
agregarColumnas('carpetas_empresa', [['marcado', "TEXT NOT NULL DEFAULT 'codigo'"]]);
agregarColumnas('lotes_empresa', [['marcado', "TEXT NOT NULL DEFAULT 'codigo'"]]);
agregarColumnas('envios', [['marcado', 'TEXT']]);
agregarColumnas('usuarios', [['marcado_paquetes', 'TEXT']]);
// Ya no existe marcar con el nombre del cliente: lo que estaba así pasa a código escrito (código + nombre abajo)
for (const t of ['carpetas_empresa', 'lotes_empresa', 'envios']) db.exec(`UPDATE ${t} SET marcado = 'codigo' WHERE marcado = 'nombre'`);
db.exec("UPDATE usuarios SET marcado_paquetes = 'codigo' WHERE marcado_paquetes = 'nombre'");
// Promociones por horas (hora de inicio y fin opcionales) y cupones personales de compensación por un reclamo
agregarColumnas('promociones', [['desde_hora', 'TEXT'], ['hasta_hora', 'TEXT'], ['usuario_id', 'INTEGER'], ['reclamo_id', 'INTEGER']]);
agregarColumnas('reclamos', [['cupon_monto', 'REAL'], ['cupon_promo_id', 'INTEGER']]);
// Avisos de documentos por vencer de cada piloto (uno por documento, fecha y aviso: 15, 7 y 1 día antes, y al vencer)
db.exec(`CREATE TABLE IF NOT EXISTS avisos_vencimiento (id INTEGER PRIMARY KEY, piloto_id INTEGER NOT NULL, doc TEXT NOT NULL, vence TEXT NOT NULL, hito INTEGER NOT NULL,
  creado TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (piloto_id, doc, vence, hito))`);
// Hora estimada de llegada (rutas de empresa): se calcula al recoger y se ajusta con cada entrega
agregarColumnas('envios', [['llega_desde', 'TEXT'], ['llega_hasta', 'TEXT']]);
// Fletes: ayudantes que van con el piloto para subir, bajar y mover la carga (0 a 5)
agregarColumnas('envios', [['ayudantes', 'INTEGER NOT NULL DEFAULT 0'], ['ayudantes_monto', 'REAL NOT NULL DEFAULT 0'], ['flete_precio', 'REAL']]);
agregarColumnas('usuarios', [['recogida_dias', 'TEXT'], ['recogida_hora', 'TEXT'], ['fact_nit', 'TEXT'], ['fact_nombre', 'TEXT'], ['fact_direccion', 'TEXT']]);
db.exec(`
  CREATE TABLE IF NOT EXISTS bonos_empresa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    envio_id INTEGER NOT NULL UNIQUE,
    monto REAL NOT NULL,
    creado TEXT NOT NULL DEFAULT (datetime('now')),
    liquidacion_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_bonos_empresa ON bonos_empresa(usuario_id, liquidacion_id);
  CREATE TABLE IF NOT EXISTS historial (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER, nombre TEXT, rol TEXT,
    accion TEXT NOT NULL, detalle TEXT, ruta TEXT,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_historial_creado ON historial(creado);
  CREATE TABLE IF NOT EXISTS liquidaciones_bono (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    monto REAL NOT NULL, entregas INTEGER NOT NULL, modo TEXT NOT NULL, nota TEXT,
    hecho_por INTEGER, creado TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// Hasta 3 paquetes en un mismo envío: el primero vive en el envío; el 2.º y el 3.º aquí, cada uno con su peso, contenido y foto
db.exec(`
  CREATE TABLE IF NOT EXISTS paquetes_envio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    envio_id INTEGER NOT NULL REFERENCES envios(id),
    n INTEGER NOT NULL,                              -- 2 o 3
    peso REAL, descripcion TEXT, foto TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_paquetes_envio ON paquetes_envio(envio_id);
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_pedidos_carpeta ON pedidos_empresa(carpeta_id)');
if (!db.prepare("SELECT 1 FROM ajustes WHERE clave = 'v6_carpetas'").get()) {
  // Sin transferencias: lo que quedó pendiente se paga en efectivo al recibir
  db.exec("UPDATE pedidos_empresa SET metodo_pago = 'efectivo' WHERE metodo_pago = 'transferencia' AND estado IN ('pendiente', 'confirmado', 'vencido')");
  // Los pedidos sueltos que todavía no se mandan quedan en una carpeta por día
  const sueltos = db.prepare("SELECT usuario_id, COALESCE(dia, date('now', '-6 hours', '+1 day')) AS dia, COUNT(*) AS n FROM pedidos_empresa WHERE carpeta_id IS NULL AND lote_id IS NULL AND estado IN ('pendiente', 'confirmado', 'vencido') GROUP BY usuario_id, 2").all();
  for (const g of sueltos) {
    const id = Number(db.prepare('INSERT INTO carpetas_empresa (usuario_id, nombre, dia) VALUES (?, ?, ?)').run(g.usuario_id, 'Envíos del ' + g.dia, g.dia).lastInsertRowid);
    db.prepare("UPDATE pedidos_empresa SET carpeta_id = ?, dia = ? WHERE usuario_id = ? AND COALESCE(dia, date('now', '-6 hours', '+1 day')) = ? AND carpeta_id IS NULL AND lote_id IS NULL AND estado IN ('pendiente', 'confirmado', 'vencido')")
      .run(id, g.dia, g.usuario_id, g.dia);
  }
  db.exec("INSERT INTO ajustes (clave, valor) VALUES ('v6_carpetas', datetime('now'))");
}

// Precio fijo: Q35 en zonas preferenciales y Q45 fuera (tarifa_base guarda la de fuera). Ya no se cobra por km.
if (!db.prepare("SELECT 1 FROM ajustes WHERE clave = 'v6_tarifa_fija'").get()) {
  db.exec("UPDATE vehiculos SET tarifa_base = 45, precio_km = 0 WHERE solo_oficina = 0 AND lower(nombre) LIKE '%moto%'");
  db.exec("UPDATE vehiculos SET precio_km = 0 WHERE solo_oficina = 0");
  db.exec("INSERT INTO ajustes (clave, valor) VALUES ('comision_tipo', 'vaelo_fijo') ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor");
  db.exec("INSERT INTO ajustes (clave, valor) VALUES ('comision_valor', '5') ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor");
  db.exec("INSERT INTO ajustes (clave, valor) VALUES ('v6_tarifa_fija', datetime('now'))");
}
module.exports = { db, DB_PATH, DATA_DIR };
