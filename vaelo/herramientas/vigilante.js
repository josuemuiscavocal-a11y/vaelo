// Revisa que Vaelo responda. Si no responde, lo reinicia y avisa por correo.
// Lo corre el cron cada 5 minutos (como root, para poder reiniciar el servicio).
'use strict';
const fs = require('node:fs');
const { execSync } = require('node:child_process');
try {
  for (const linea of fs.readFileSync('/etc/vaelo.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(linea);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* sin archivo */ }

const responde = async () => {
  try { const r = await fetch('http://127.0.0.1:3000/api/salud', { signal: AbortSignal.timeout(8000) }); return r.ok; } catch { return false; }
};
(async () => {
  if (await responde()) return;
  await new Promise((ok) => setTimeout(ok, 15000));   // una segunda oportunidad antes de reiniciar
  if (await responde()) return;
  let log = '';
  try { log = execSync('journalctl -u vaelo -n 40 --no-pager', { encoding: 'utf8' }); } catch { /* sin registro */ }
  try { execSync('systemctl restart vaelo'); } catch { /* sigue */ }
  await new Promise((ok) => setTimeout(ok, 8000));
  const volvio = await responde();
  console.error(`Vaelo no respondía. Reiniciado: ${volvio ? 'funciona otra vez' : 'SIGUE SIN RESPONDER'}`);
  let para = '';
  try { para = execSync(`runuser -u vaelo -- env VAELO_DATA=/var/lib/vaelo node --disable-warning=ExperimentalWarning -e "const {db}=require('${__dirname}/../db');console.log(db.prepare(\\"SELECT valor FROM ajustes WHERE clave='correo_respaldos'\\").get()?.valor||'')"`, { encoding: 'utf8' }).trim(); } catch { /* sin base */ }
  if (!para || !process.env.RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.VAELO_CORREO_REMITENTE || 'Vaelo Mensajería <no-responder@vaelomensajeria.com>', to: [para],
      subject: volvio ? 'Vaelo se reinició solo' : 'URGENTE: Vaelo no responde',
      text: `${volvio ? 'Vaelo dejó de responder y se reinició solo. Ya funciona.' : 'Vaelo dejó de responder y no volvió después de reiniciarlo. Entra al servidor.'}\n\nÚltimas líneas del registro:\n${log}` }),
  }).catch(() => {});
})();
