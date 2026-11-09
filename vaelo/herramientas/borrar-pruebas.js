// Borra los datos de prueba y deja Vaelo en blanco. Antes de borrar guarda una copia completa de la base de datos.
// Uso en el servidor:
//   bash /opt/vaelo/vaelo/deploy/actualizar.sh --borrar-pruebas
// Borra: todos los envíos y su historial, recorridos GPS, cuentas de clientes y de pilotos, y sus documentos.
// NO borra: la cuenta de administración, vehículos, tarifas, zonas ni ajustes.
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

const cuenta = (sql) => db.prepare(sql).get().n;
const antes = {
  envios: cuenta('SELECT COUNT(*) n FROM envios'),
  clientes: cuenta("SELECT COUNT(*) n FROM usuarios WHERE rol = 'cliente'"),
  pilotos: cuenta("SELECT COUNT(*) n FROM usuarios WHERE rol = 'mensajero'"),
};

// Documentos de las cuentas que se van a borrar (los del administrador no se tocan)
const COLUMNAS_DOC = ['foto_perfil', 'doc_frente', 'doc_reverso', 'doc_recibo', 'penales_doc', 'policiacos_doc', 'licencia_frente', 'licencia_reverso',
  'veh_tarjeta', 'veh_foto_frente', 'veh_foto_lado', 'veh_foto_placa', 'veh_carta'];
const docsDir = path.join(DATA_DIR, 'documentos');
for (const u of db.prepare("SELECT * FROM usuarios WHERE rol IN ('cliente','mensajero')").all()) {
  for (const c of COLUMNAS_DOC) if (u[c]) { try { fs.unlinkSync(path.join(docsDir, path.basename(u[c]))); } catch { /* ya no estaba */ } }
}

db.exec('BEGIN');
try {
  db.exec(`
    DELETE FROM eventos;
    DELETE FROM ubicaciones;
    DELETE FROM envios;
    DELETE FROM tokens_correo;
    DELETE FROM sesiones WHERE usuario_id IN (SELECT id FROM usuarios WHERE rol IN ('cliente','mensajero'));
    DELETE FROM usuarios WHERE rol IN ('cliente','mensajero');
    DELETE FROM sqlite_sequence WHERE name IN ('envios','eventos','ubicaciones');
  `);
  db.exec('COMMIT');
} catch (err) { db.exec('ROLLBACK'); throw err; }

console.log(`Listo. Se borraron ${antes.envios} envíos, ${antes.clientes} clientes y ${antes.pilotos} pilotos.`);
console.log('Si necesitas recuperar algo, la copia de arriba tiene todo como estaba.');
