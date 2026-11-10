// Archivos de Excel (.xlsx) sin librerías: crear con varias hojas y leer la primera hoja de un archivo subido.
'use strict';
const zlib = require('node:zlib');

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const columna = (i) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

// ---------- ZIP (sin compresión al escribir; al leer acepta "deflate") ----------
function zip(archivos) {
  const partes = [], central = [];
  let pos = 0;
  for (const [nombre, contenido] of archivos) {
    const datos = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido, 'utf8');
    const n = Buffer.from(nombre, 'utf8'), crc = zlib.crc32(datos);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(datos.length, 18); local.writeUInt32LE(datos.length, 22);
    local.writeUInt16LE(n.length, 26); local.writeUInt16LE(0, 28);
    const cab = Buffer.alloc(46);
    cab.writeUInt32LE(0x02014b50, 0); cab.writeUInt16LE(20, 4); cab.writeUInt16LE(20, 6); cab.writeUInt16LE(0x0800, 8); cab.writeUInt16LE(0, 10);
    cab.writeUInt32LE(0, 12); cab.writeUInt32LE(crc, 16); cab.writeUInt32LE(datos.length, 20); cab.writeUInt32LE(datos.length, 24);
    cab.writeUInt16LE(n.length, 28); cab.writeUInt32LE(pos, 42);
    partes.push(local, n, datos); central.push(cab, n);
    pos += 30 + n.length + datos.length;
  }
  const c = Buffer.concat(central), fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(archivos.length, 8); fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(c.length, 12); fin.writeUInt32LE(pos, 16);
  return Buffer.concat([...partes, c, fin]);
}
function unzip(buf) {
  let fin = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
  if (fin < 0) throw new Error('El archivo no es un Excel válido.');
  const total = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);
  const out = {};
  for (let k = 0; k < total; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10), tam = buf.readUInt32LE(p + 20), ln = buf.readUInt16LE(p + 28), le = buf.readUInt16LE(p + 30), lc = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42), nombre = buf.toString('utf8', p + 46, p + 46 + ln);
    const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const datos = buf.subarray(ini, ini + tam);
    if (/^(xl\/(sharedStrings|workbook)\.xml|xl\/worksheets\/sheet\d+\.xml|xl\/_rels\/workbook\.xml\.rels)$/.test(nombre)) {
      out[nombre] = (metodo === 8 ? zlib.inflateRawSync(datos, { maxOutputLength: 20_000_000 }) : datos).toString('utf8');
    }
    p += 46 + ln + le + lc;
  }
  return out;
}

// ---------- Crear ----------
// hojas: [{ nombre, columnas: [{ titulo, ancho, tipo: 'texto'|'numero'|'dinero' }], filas: [[...]], total?: [...] }]
function crearExcel(hojas) {
  const hojaXml = (h) => {
    const cols = h.columnas.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.ancho || 16}" customWidth="1"/>`).join('');
    const celda = (v, ref, estilo, tipo) => {
      if (v === null || v === undefined || v === '') return `<c r="${ref}" s="${estilo}"/>`;
      if ((tipo === 'numero' || tipo === 'dinero') && Number.isFinite(Number(v))) return `<c r="${ref}" s="${estilo}"><v>${Number(v)}</v></c>`;
      return `<c r="${ref}" s="${estilo}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    };
    const filas = [];
    let r = 1;
    if (h.titulo) { filas.push(`<row r="${r}">${celda(h.titulo, 'A' + r, 3, 'texto')}</row>`); r++; filas.push(`<row r="${r}"/>`); r++; }
    const cabecera = r;
    filas.push(`<row r="${r}">${h.columnas.map((c, i) => celda(c.titulo, columna(i) + r, 1, 'texto')).join('')}</row>`); r++;
    const estiloDe = (c) => (c.tipo === 'dinero' ? 2 : 0);
    for (const f of h.filas) { filas.push(`<row r="${r}">${h.columnas.map((c, i) => celda(f[i], columna(i) + r, estiloDe(c), c.tipo)).join('')}</row>`); r++; }
    if (h.total) filas.push(`<row r="${r}">${h.columnas.map((c, i) => celda(h.total[i], columna(i) + r, c.tipo === 'dinero' ? 5 : 4, c.tipo)).join('')}</row>`);
    const congelar = `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${cabecera}" topLeftCell="A${cabecera + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${congelar}<cols>${cols}</cols><sheetData>${filas.join('')}</sheetData></worksheet>`;
  };
  const nombres = hojas.map((h, i) => (String(h.nombre || `Hoja ${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31)) || `Hoja ${i + 1}`);
  const archivos = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${hojas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${nombres.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    // Estilos: 0 normal, 1 encabezado, 2 dinero, 3 título, 4 total, 5 total en dinero
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;Q&quot;#,##0.00"/></numFmts><fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FF0E2463"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0E2463"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFE9A8"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="3" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ...hojas.map((h, i) => [`xl/worksheets/sheet${i + 1}.xml`, hojaXml(h)]),
  ];
  return zip(archivos);
}

// ---------- Leer (primera hoja, como lista de filas de texto) ----------
const desescapar = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const textoDe = (xml) => desescapar([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
function leerExcel(buf) {
  const f = unzip(buf);
  const compartidos = f['xl/sharedStrings.xml'] ? [...f['xl/sharedStrings.xml'].matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textoDe(m[1])) : [];
  const hoja = f['xl/worksheets/sheet1.xml'] || Object.entries(f).find(([k]) => /worksheets\/sheet\d+\.xml$/.test(k))?.[1];
  if (!hoja) throw new Error('El Excel no tiene hojas.');
  const filas = [];
  for (const fila of hoja.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const celdas = [];
    for (const c of fila[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], dentro = c[2] || '';
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const tipo = /t="([^"]+)"/.exec(attrs)?.[1];
      let valor = '';
      if (tipo === 'inlineStr') valor = textoDe(dentro);
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(dentro)?.[1] ?? '';
        valor = tipo === 's' ? (compartidos[Number(v)] ?? '') : desescapar(v);
      }
      const idx = ref ? ref.split('').reduce((t, ch) => t * 26 + ch.charCodeAt(0) - 64, 0) - 1 : celdas.length;
      celdas[idx] = valor.trim();
    }
    filas.push(Array.from(celdas, (v) => v ?? ''));
  }
  return filas.filter((f) => f.some((v) => v !== ''));
}

// CSV (separado por coma o punto y coma, con comillas)
function leerCsv(texto) {
  const t = String(texto).replace(/^﻿/, '');
  const sep = (t.split('\n')[0].match(/;/g) || []).length > (t.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const filas = [];
  let fila = [], campo = '', comillas = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (comillas) {
      if (ch === '"' && t[i + 1] === '"') { campo += '"'; i++; } else if (ch === '"') comillas = false; else campo += ch;
    } else if (ch === '"') comillas = true;
    else if (ch === sep) { fila.push(campo.trim()); campo = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; fila.push(campo.trim()); filas.push(fila); fila = []; campo = ''; }
    else campo += ch;
  }
  if (campo || fila.length) { fila.push(campo.trim()); filas.push(fila); }
  return filas.filter((f) => f.some((v) => v !== ''));
}

module.exports = { crearExcel, leerExcel, leerCsv };
