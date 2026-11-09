// Avisos al celular (Web Push) sin paquetes extra: firma VAPID y cifrado aes128gcm (RFC 8291 y RFC 8292).
// Las claves se crean solas la primera vez y se guardan en la carpeta de datos (vapid.json).
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const desdeB64url = (t) => Buffer.from(String(t).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function crearPush({ dataDir, contacto }) {
  const archivo = path.join(dataDir, 'vapid.json');
  let claves;
  try { claves = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { /* se crean */ }
  if (!claves || !claves.publica || !claves.privadaJwk) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    claves = { publica: b64url(publicKey.export({ format: 'der', type: 'spki' }).subarray(-65)), privadaJwk: privateKey.export({ format: 'jwk' }) };
    fs.writeFileSync(archivo, JSON.stringify(claves), { mode: 0o600 });
  }
  const privada = crypto.createPrivateKey({ key: claves.privadaJwk, format: 'jwk' });

  function jwtVapid(audiencia) {
    const cab = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const cuerpo = b64url(JSON.stringify({ aud: audiencia, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contacto }));
    const firma = crypto.sign('sha256', Buffer.from(`${cab}.${cuerpo}`), { key: privada, dsaEncoding: 'ieee-p1363' });
    return `${cab}.${cuerpo}.${b64url(firma)}`;
  }

  // Cifra el mensaje para una suscripción (aes128gcm, un solo bloque)
  function cifrar(sub, texto) {
    const uaPublica = desdeB64url(sub.p256dh);
    const secreto = desdeB64url(sub.auth);
    const ecdh = crypto.createECDH('prime256v1');
    const asPublica = ecdh.generateKeys();
    const compartido = ecdh.computeSecret(uaPublica);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublica, asPublica]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', compartido, secreto, info, 32));
    const sal = crypto.randomBytes(16);
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, sal, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, sal, Buffer.from('Content-Encoding: nonce\0'), 12));
    const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const cifrado = Buffer.concat([c.update(Buffer.concat([Buffer.from(texto), Buffer.from([2])])), c.final(), c.getAuthTag()]);
    const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
    return Buffer.concat([sal, rs, Buffer.from([asPublica.length]), asPublica, cifrado]);
  }

  // Devuelve 'ok', 'vencida' (borrar la suscripción) o 'error'
  async function enviar(sub, datos) {
    try {
      const url = new URL(sub.endpoint);
      const cuerpo = cifrar(sub, JSON.stringify(datos));
      const r = await fetch(sub.endpoint, {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { TTL: '86400', Urgency: datos.urgente ? 'high' : 'normal', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
          Authorization: `vapid t=${jwtVapid(url.origin)}, k=${claves.publica}` },
        body: cuerpo,
      });
      if (r.status === 404 || r.status === 410) return 'vencida';
      if (!r.ok) { console.error('Aviso push rechazado:', r.status, (await r.text()).slice(0, 200)); return 'error'; }
      return 'ok';
    } catch (err) { console.error('Aviso push falló:', err.message); return 'error'; }
  }

  return { clavePublica: claves.publica, enviar, cifrar };
}

module.exports = { crearPush };
