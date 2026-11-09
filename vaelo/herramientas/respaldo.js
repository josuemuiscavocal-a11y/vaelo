// Copia de seguridad diaria de la base de datos. Guarda los últimos 14 días en el servidor y, si hay un correo
// para respaldos (panel > Tarifas y ajustes) y el correo automático está configurado, manda la copia comprimida
// por correo para que exista también fuera del servidor.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// El cron no carga /etc/vaelo.env: se lee aquí (RESEND_API_KEY y remitente)
try {
  for (const linea of fs.readFileSync('/etc/vaelo.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(linea);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* sin archivo */ }
const { db, DATA_DIR } = require('../db');

const dir = path.join(DATA_DIR, 'respaldos');
fs.mkdirSync(dir, { recursive: true });
const fecha = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const destino = path.join(dir, `vaelo-${fecha}.db`);
if (fs.existsSync(destino)) fs.unlinkSync(destino);
db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
const gz = zlib.gzipSync(fs.readFileSync(destino), { level: 9 });
fs.writeFileSync(destino + '.gz', gz);
fs.unlinkSync(destino);

const viejos = fs.readdirSync(dir).filter((f) => /^vaelo-\d{4}-\d{2}-\d{2}\.db(\.gz)?$/.test(f)).sort().reverse().slice(14);
for (const f of viejos) fs.unlinkSync(path.join(dir, f));
console.log(`Respaldo guardado: ${destino}.gz (${Math.round(gz.length / 1024)} KB)`);

(async () => {
  const para = db.prepare("SELECT valor FROM ajustes WHERE clave = 'correo_respaldos'").get()?.valor;
  const clave = process.env.RESEND_API_KEY;
  if (!para || !clave) return;
  if (gz.length > 30 * 1024 * 1024) { console.error('El respaldo pesa más de 30 MB: no se manda por correo. Descárgalo desde el panel.'); return; }
  const de = process.env.VAELO_CORREO_REMITENTE || 'Vaelo Mensajería <no-responder@vaelomensajeria.com>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${clave}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: de, to: [para], subject: `Respaldo de Vaelo ${fecha}`,
      text: `Copia de seguridad de la base de datos de Vaelo del ${fecha}. Guárdala en un lugar seguro.`,
      attachments: [{ filename: `vaelo-${fecha}.db.gz`, content: gz.toString('base64') }] }),
  });
  if (!r.ok) console.error('No se pudo mandar el respaldo por correo:', r.status, await r.text());
  else console.log(`Respaldo enviado a ${para}`);
})();
