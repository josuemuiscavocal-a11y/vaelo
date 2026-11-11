// Borra los datos de prueba y deja Vaelo en blanco. Antes de borrar guarda una copia completa de la base de datos.
// Uso en el servidor:
//   bash /opt/vaelo/vaelo/deploy/actualizar.sh --borrar-pruebas
// Borra: envíos, pedidos y carpetas de tiendas, rutas, reclamos, cobros, pagos y cuentas de pilotos, cierres del día,
//        historial, cuentas de clientes, tiendas, empresas y pilotos, con sus fotos y documentos.
// NO borra: la cuenta de administración, el equipo de oficina, vehículos, tarifas, zonas, ajustes (sede, correo)
//           ni las promociones generales.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('../db');

if (process.env.VAELO_CONFIRMAR !== 'BORRAR') { console.error('Falta la confirmación. Usa deploy/actualizar.sh --borrar-pruebas'); process.exit(1); }

const dirRespaldos = path.join(DATA_DIR, 'respaldos');
fs.mkdirSync(dirRespaldos, { recursive: true });
const sello = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const respaldo = path.join(dirRespaldos, `antes-de-borrar-${sello}.db`);
db.exec(`VACUUM INTO '${respaldo.replace(/'/g, "''")}'`);
console.log(`Copia de seguridad guardada en ${respaldo}`);

const ROLES_EQUIPO = "('admin','operador')";
const cuenta = (sql) => db.prepare(sql).get().n;
const antes = {
  envios: cuenta('SELECT COUNT(*) n FROM envios'),
  pedidos: cuenta('SELECT COUNT(*) n FROM pedidos_empresa'),
  cuentas: cuenta(`SELECT COUNT(*) n FROM usuarios WHERE rol NOT IN ${ROLES_EQUIPO}`),
};

// Tablas que se conservan. Todas las demás se vacían (así una tabla nueva también se limpia).
const SE_QUEDAN = new Set(['ajustes', 'zonas_fijas', 'vehiculos', 'sqlite_sequence']);
// Tablas que se conservan solo para el equipo (admin y oficina)
const SOLO_EQUIPO = { usuarios: 'id', sesiones: 'usuario_id', push_suscripciones: 'usuario_id', tokens_clave: 'usuario_id', tokens_correo: 'usuario_id' };

const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
const columnas = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const equipoIds = `(SELECT id FROM usuarios WHERE rol IN ${ROLES_EQUIPO})`;

// Archivos que siguen siendo del equipo (foto de perfil, etc.): no se tocan
const delEquipo = new Set();
for (const u of db.prepare(`SELECT * FROM usuarios WHERE rol IN ${ROLES_EQUIPO}`).all()) {
  for (const v of Object.values(u)) if (typeof v === 'string' && v) delEquipo.add(path.basename(v));
}

db.exec('PRAGMA foreign_keys = OFF');
db.exec('BEGIN');
try {
  for (const t of tablas) {
    if (SE_QUEDAN.has(t)) continue;
    if (t === 'promociones') {
      // Solo los cupones personales (compensaciones de reclamos); las promociones generales se quedan
      const c = columnas(t);
      if (c.includes('usuario_id')) db.exec('DELETE FROM promociones WHERE usuario_id IS NOT NULL' + (c.includes('reclamo_id') ? ' OR reclamo_id IS NOT NULL' : ''));
      continue;
    }
    if (SOLO_EQUIPO[t]) {
      if (t === 'usuarios') db.exec(`DELETE FROM usuarios WHERE rol NOT IN ${ROLES_EQUIPO}`);
      else db.exec(`DELETE FROM ${t} WHERE ${SOLO_EQUIPO[t]} NOT IN ${equipoIds}`);
      continue;
    }
    db.exec(`DELETE FROM ${t}`);
  }
  // Los números de envío, pedido, etc. vuelven a empezar desde 1 (usuarios y promociones siguen su cuenta)
  const reiniciar = tablas.filter((t) => !SE_QUEDAN.has(t) && t !== 'usuarios' && t !== 'promociones');
  if (tablas.includes('sqlite_sequence') || db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) {
    const del = db.prepare('DELETE FROM sqlite_sequence WHERE name = ?');
    for (const t of reiniciar) del.run(t);
  }
  const rotas = db.prepare('PRAGMA foreign_key_check').all();
  if (rotas.length) throw new Error(`Quedaron referencias rotas en: ${[...new Set(rotas.map((r) => r.table))].join(', ')}`);
  db.exec('COMMIT');
} catch (err) { db.exec('ROLLBACK'); db.exec('PRAGMA foreign_keys = ON'); throw err; }
db.exec('PRAGMA foreign_keys = ON');

// Fotos, firmas y documentos (envíos, pedidos, reclamos, empresas, pilotos y clientes)
let archivos = 0;
const docsDir = path.join(DATA_DIR, 'documentos');
try {
  for (const f of fs.readdirSync(docsDir)) {
    if (delEquipo.has(f)) continue;
    try { fs.unlinkSync(path.join(docsDir, f)); archivos++; } catch { /* ya no estaba */ }
  }
} catch { /* sin carpeta */ }
// Excel de los cierres del día de prueba
try {
  const rep = path.join(DATA_DIR, 'reportes');
  for (const f of fs.readdirSync(rep)) if (f.startsWith('cierre-')) { fs.unlinkSync(path.join(rep, f)); archivos++; }
} catch { /* sin carpeta */ }

db.exec('VACUUM');
console.log(`Listo. Se borraron ${antes.envios} envíos, ${antes.pedidos} pedidos de tiendas, ${antes.cuentas} cuentas (clientes, tiendas, empresas y pilotos) y ${archivos} archivos.`);
console.log('Se conservaron: administración, oficina, vehículos, tarifas, zonas, ajustes y promociones generales.');
console.log('Si necesitas recuperar algo, la copia de arriba tiene todo como estaba.');
