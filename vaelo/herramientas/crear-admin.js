// Crea la cuenta de administración (o le cambia la contraseña).
// Solo existe un administrador: administracionvaelo@vaelomensajeria.com
// Uso en el servidor (lo hace solo deploy/actualizar.sh la primera vez):
//   VAELO_ADMIN_PASSWORD='la-contraseña' node herramientas/crear-admin.js
'use strict';
const { db } = require('../db');
const { hashPassword } = require('../server');

const email = String(process.env.VAELO_ADMIN_EMAIL_UNICO || 'administracionvaelo@vaelomensajeria.com').trim().toLowerCase();
const password = String(process.env.VAELO_ADMIN_PASSWORD || '');
const nombre = String(process.env.VAELO_ADMIN_NOMBRE || 'Administración Vaelo').trim();

if (password.length < 12) { console.error('La contraseña de administración debe tener al menos 12 caracteres.'); process.exit(1); }

const existe = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
if (existe) {
  db.prepare("UPDATE usuarios SET rol = 'admin', activo = 1, password_hash = ? WHERE id = ?").run(hashPassword(password), existe.id);
  db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(existe.id);
  console.log(`Listo: contraseña de ${email} actualizada.`);
} else {
  db.prepare("INSERT INTO usuarios (nombre, email, telefono, password_hash, rol) VALUES (?, ?, '', ?, 'admin')")
    .run(nombre, email, hashPassword(password));
  console.log(`Listo: cuenta de administración creada para ${email}.`);
}
