// Código QR propio (sin librerías): modo byte, corrección M, versiones 1 a 10. Sirve para las etiquetas de los paquetes.
'use strict';
(function (global) {
  // [bloques, codewords de corrección por bloque, codewords totales] para la corrección M
  const TABLA = [null, [1, 10, 26], [1, 16, 44], [1, 26, 70], [2, 18, 100], [2, 24, 134], [4, 16, 172], [4, 18, 196], [4, 22, 242], [5, 22, 292], [5, 26, 346]];
  const ALINEACION = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const bit = (x, i) => ((x >>> i) & 1) !== 0;
  function mul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
    return z;
  }
  function divisor(grado) {
    const r = new Array(grado).fill(0); r[grado - 1] = 1;
    let raiz = 1;
    for (let i = 0; i < grado; i++) {
      for (let j = 0; j < r.length; j++) { r[j] = mul(r[j], raiz); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
      raiz = mul(raiz, 2);
    }
    return r;
  }
  function residuo(datos, div) {
    const r = new Array(div.length).fill(0);
    for (const b of datos) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= mul(c, f); }); }
    return r;
  }

  function matriz(texto) {
    const bytes = Array.from(new TextEncoder().encode(String(texto)));
    let version = 0;
    for (let v = 1; v <= 10; v++) {
      const [b, ec, total] = TABLA[v];
      if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= (total - b * ec) * 8) { version = v; break; }
    }
    if (!version) throw new Error('Texto demasiado largo para el código QR');
    const [nBloques, ecLen, total] = TABLA[version];
    const capacidad = (total - nBloques * ecLen) * 8;
    // Bits de datos
    const bits = [];
    const poner = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    poner(4, 4); poner(bytes.length, version < 10 ? 8 : 16); bytes.forEach((b) => poner(b, 8));
    poner(0, Math.min(4, capacidad - bits.length));
    poner(0, (8 - (bits.length % 8)) % 8);
    for (let p = 0xec; bits.length < capacidad; p ^= 0xec ^ 0x11) poner(p, 8);
    const datos = [];
    for (let i = 0; i < bits.length; i += 8) datos.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    // Bloques con corrección de errores, intercalados
    const cortos = nBloques - (total % nBloques), largoCorto = Math.floor(total / nBloques);
    const div = divisor(ecLen), bloques = [];
    for (let i = 0, k = 0; i < nBloques; i++) {
      const dat = datos.slice(k, k + largoCorto - ecLen + (i < cortos ? 0 : 1));
      k += dat.length;
      const ec = residuo(dat, div);
      if (i < cortos) dat.push(0);
      bloques.push(dat.concat(ec));
    }
    const finales = [];
    for (let i = 0; i < bloques[0].length; i++) bloques.forEach((b, j) => { if (i !== largoCorto - ecLen || j >= cortos) finales.push(b[i]); });

    const n = version * 4 + 17;
    const m = Array.from({ length: n }, () => new Array(n).fill(false));
    const fija = Array.from({ length: n }, () => new Array(n).fill(false));
    const set = (x, y, v) => { m[y][x] = v; fija[y][x] = true; };
    for (let i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < n && y >= 0 && y < n) set(x, y, d !== 2 && d !== 4);
      }
    }
    const al = ALINEACION[version], ult = al.length - 1;
    al.forEach((a, i) => al.forEach((b, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === ult) || (i === ult && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const formato = (mascara) => {
      const d = (0 << 3) | mascara;   // corrección M = 00
      let r = d;
      for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      const b = ((d << 10) | r) ^ 0x5412;
      for (let i = 0; i <= 5; i++) set(8, i, bit(b, i));
      set(8, 7, bit(b, 6)); set(8, 8, bit(b, 7)); set(7, 8, bit(b, 8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(b, i));
      for (let i = 0; i < 8; i++) set(n - 1 - i, 8, bit(b, i));
      for (let i = 8; i < 15; i++) set(8, n - 15 + i, bit(b, i));
      set(8, n - 8, true);
    };
    formato(0);
    if (version >= 7) {
      let r = version;
      for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
      const b = (version << 12) | r;
      for (let i = 0; i < 18; i++) { const a = n - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, bit(b, i)); set(c, a, bit(b, i)); }
    }
    // Datos en zigzag
    let i = 0;
    for (let der = n - 1; der >= 1; der -= 2) {
      if (der === 6) der = 5;
      for (let v = 0; v < n; v++) for (let j = 0; j < 2; j++) {
        const x = der - j, arriba = ((der + 1) & 2) === 0, y = arriba ? n - 1 - v : v;
        if (!fija[y][x] && i < finales.length * 8) { m[y][x] = bit(finales[i >>> 3], 7 - (i & 7)); i++; }
      }
    }
    const MASCARAS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
    const aplicar = (k) => { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fija[y][x] && MASCARAS[k](x, y)) m[y][x] = !m[y][x]; };
    const castigo = () => {
      let p = 0;
      const lineas = [];
      for (let y = 0; y < n; y++) lineas.push(m[y]);
      for (let x = 0; x < n; x++) lineas.push(m.map((f) => f[x]));
      for (const l of lineas) {
        let corrida = 1;
        for (let k = 1; k <= n; k++) {
          if (k < n && l[k] === l[k - 1]) corrida++;
          else { if (corrida >= 5) p += corrida - 2; corrida = 1; }
        }
        const t = l.map((v) => (v ? 1 : 0)).join('');
        for (const pat of ['10111010000', '00001011101']) { let pos = t.indexOf(pat); while (pos !== -1) { p += 40; pos = t.indexOf(pat, pos + 1); } }
      }
      for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3; }
      const oscuros = m.reduce((t, f) => t + f.filter(Boolean).length, 0);
      p += Math.floor(Math.abs(oscuros * 20 - n * n * 10) / (n * n)) * 10;
      return p;
    };
    let mejor = 0, menor = Infinity;
    for (let k = 0; k < 8; k++) {
      aplicar(k); formato(k);
      const c = castigo();
      if (c < menor) { menor = c; mejor = k; }
      aplicar(k);
    }
    aplicar(mejor); formato(mejor);
    return m;
  }

  // SVG listo para pintar (con margen blanco de 4 módulos)
  function svg(texto, lado = 160) {
    const m = matriz(texto), n = m.length, t = n + 8;
    let d = '';
    m.forEach((f, y) => f.forEach((v, x) => { if (v) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${t} ${t}" width="${lado}" height="${lado}" shape-rendering="crispEdges" role="img" aria-label="Código QR ${String(texto).replace(/[<&"]/g, '')}"><rect width="${t}" height="${t}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }
  // El mismo dibujo como nodo SVG (sin innerHTML), para ponerlo en la página
  function nodo(texto, lado = 160) {
    const NS = 'http://www.w3.org/2000/svg', m = matriz(texto), n = m.length, t = n + 8;
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', `0 0 ${t} ${t}`); s.setAttribute('width', lado); s.setAttribute('height', lado); s.setAttribute('shape-rendering', 'crispEdges');
    s.setAttribute('role', 'img'); s.setAttribute('aria-label', 'Código QR ' + texto);
    const fondo = document.createElementNS(NS, 'rect'); fondo.setAttribute('width', t); fondo.setAttribute('height', t); fondo.setAttribute('fill', '#fff');
    let d = '';
    m.forEach((f, y) => f.forEach((v, x) => { if (v) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
    const camino = document.createElementNS(NS, 'path'); camino.setAttribute('d', d); camino.setAttribute('fill', '#000');
    s.append(fondo, camino);
    return s;
  }
  const qr = { matriz, svg, nodo };
  if (typeof module !== 'undefined' && module.exports) module.exports = qr;
  else global.qrVaelo = qr;
})(typeof window !== 'undefined' ? window : globalThis);
