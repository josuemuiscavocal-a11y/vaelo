# Vaelo Mensajería

Página web y app (instalable en el celular) de Vaelo, mensajería en moto y pickup en Guatemala. Los clientes crean su cuenta, envían paquetes marcando recogida y entrega en el mapa, y siguen al mensajero hasta la entrega.

**Precios:** tarifa fija cuando recogida y entrega están en las zonas cubiertas (1, 6, 16, 17, 18 y 24, editables). Fuera de ellas: arranque + kilómetros × precio por km, según el vehículo. Todo se edita en el panel → Tarifas y ajustes.

## Qué incluye

| Dirección | Para quién | Qué hace |
|---|---|---|
| `/` | Todos | Página principal, cotizador de precios y rastreo |
| `/registro`, `/entrar` | Clientes | Crear cuenta e iniciar sesión |
| `/enviar`, `/mi-cuenta` | Clientes | Enviar paquetes (vehículo, peso, mapa), seguirlos en el mapa, imprimir la guía |
| `/modomensajero` | Pilotos | Registrarse y subir documentos, conectarse con GPS, aceptar o rechazar envíos, navegar con Google Maps o Waze, marcar recogido/entregado |
| `/rastreo` | Todos | Seguir un envío con el número de guía |
| `/familiatecun` | Administración | Aviso de pedidos nuevos, asignar al piloto más cercano, GPS en vivo de la flota, aprobar pilotos y revisar sus documentos, verificar la identidad de los clientes, tarifas |

## Acceso de administración

- El panel está en `vaelomensajeria.com/familiatecun` (la dirección `/admin` ya no existe).
- Solo puede entrar **administracionvaelo@vaelomensajeria.com**. Esa cuenta no entra por `/entrar`.
- La contraseña no está en el código. Se escribe en el servidor la primera vez que corres `deploy/actualizar.sh`.
  Para cambiarla: `bash /opt/vaelo/vaelo/deploy/actualizar.sh --clave-admin`
- 5 intentos fallidos bloquean ese internet por 30 minutos. La sesión del panel dura 12 horas.
- Las fotos del DPI de los empleados se guardan en `/var/lib/vaelo/documentos/` y solo se ven desde el panel.

## Pilotos (modo mensajero)

- Página escondida: `vaelomensajeria.com/modomensajero`. Los pilotos no entran por `/entrar`.
- El piloto se registra, sube DPI, foto, antecedentes penales y policiacos, licencia, datos y fotos del vehículo, y contacto de emergencia.
  Queda "En revisión" hasta que la administración lo aprueba desde la ficha del piloto.
- Ya aprobado solo puede cambiar su contacto y renovar licencia y antecedentes; lo demás lo cambia la administración.
- Con la licencia o los antecedentes vencidos (vigencia configurable, 6 meses al inicio) no puede conectarse ni recibir envíos.
- Para estar "en línea" y para aceptar un envío necesita la ubicación encendida. Con una entrega en curso no puede desconectarse.
- El estado del envío cambia solo con el GPS: llegó a recoger, en camino (al salir del punto de recogida) y llegando.
  "Entregado" lo marca el piloto en el lugar (a menos de 500 m del punto de entrega). La administración puede cambiarlo a mano.
- El recorrido GPS de cada envío se guarda 30 días.
- **Límite importante:** es una app web. El GPS funciona con la app abierta y la pantalla encendida (la app pide mantenerla encendida).
  Para seguir la ubicación con el teléfono bloqueado hace falta una app nativa de Play Store / App Store.

## Clientes

- Crean su cuenta con nombre, teléfono, correo y contraseña. No se pide DPI ni fotos para enviar; la foto de perfil es opcional (se elige de la galería).
- Paquete frágil: recargo configurable en Tarifas y ajustes (Q10 al inicio).

## Ubicaciones en vivo (sin marcar direcciones en el mapa)

- Recogida: donde está quien pide. Al enviar, Vaelo toma su ubicación y la sigue compartiendo con el piloto mientras tenga la página abierta y el paquete no se haya recogido.
- Si el paquete lo entrega otra persona (una tienda, un familiar), quien pide escribe su nombre y teléfono, y le manda un enlace (`/entrega/...`) para que comparta su ubicación.
- Entrega: donde está quien recibe. Recibe un enlace (`/recibe/...`), confirma su nombre, comparte su ubicación (foto opcional) y ve a su piloto, el mapa y su código de entrega.
- El piloto ve a cada persona con su teléfono y referencias, y los botones "Recoger el pedido" (bajo quien entrega) y "Dejar el pedido" (bajo quien recibe) en Waze o Google Maps, siempre a la última ubicación.
- Precio: por la zona elegida en la lista. Fuera de las zonas fijas se muestra un precio "desde" y el total por kilómetro se calcula cuando las dos personas comparten su ubicación.
- Hasta tener las dos ubicaciones no se busca piloto ni se puede recoger. En cada envío el panel puede autorizar una excepción con motivo; también se puede apagar en Tarifas y ajustes ("Pedir ubicaciones en vivo antes de recoger").
- Quien envía no ve la ubicación de quien recibe, ni aparece en el rastreo público. Las ubicaciones se dejan de compartir al recoger y al entregar, y se borran 30 días después.

## App para Android (.apk, se descarga solo desde la página)

1. En pwabuilder.com escribe `https://vaelomensajeria.com` (app de clientes) o `https://vaelomensajeria.com/modomensajero` (app de pilotos) y genera el paquete de Android. Descarga el zip.
2. Guarda en un lugar seguro la llave de firma que viene en el zip (signing.keystore y su contraseña): sin ella no podrás publicar actualizaciones de la misma app.
3. Panel > Tarifas y ajustes > App para Android: sube el `.apk` y pega el contenido de `assetlinks.json`.
4. La app de clientes aparece en la página principal (`/descargas/vaelo.apk`); la de pilotos solo dentro de /modomensajero (`/descargas/vaelo-piloto.apk`). El servidor publica `/.well-known/assetlinks.json` solo.

## Correo de confirmación (Resend)

DigitalOcean bloquea el envío de correo directo, por eso se usa Resend (gratis hasta 3,000 correos al mes).
Mientras no esté configurado, no se exige confirmar el correo.

1. Crea una cuenta en resend.com y agrega el dominio `vaelomensajeria.com`.
2. Copia en Cloudflare (DNS) los registros que te da Resend y espera a que salga "Verified".
3. En Resend crea una API key.
4. En el servidor: `nano /etc/vaelo.env`, agrega la línea `RESEND_API_KEY=re_tu_clave`, guarda (Ctrl+O, Enter, Ctrl+X) y corre `systemctl restart vaelo`.

## Operación diaria

- **Entrega segura:** cada envío tiene un código de 4 números que el cliente le da a quien recibe. El piloto no puede marcar
  "entregado" sin ese código, una foto del paquete y el nombre de quien recibió (la firma es opcional). 5 códigos equivocados bloquean la entrega.
- **Asignación automática** (Tarifas y ajustes): cada pedido se ofrece al piloto libre más cercano con el vehículo correcto; si no acepta a tiempo pasa al siguiente.
- **Caja** (solo administración): efectivo que cada piloto debe entregar en la sede, pago a pilotos (comisión configurable),
  cobros contra entrega por devolver a las tiendas y crédito de empresas por cobrar.
- **Descuentos:** promociones automáticas por fechas (se anuncian en la página) y cupones. Se aplica el mejor para el cliente, no se suman.
- **Empresas:** precio especial, pago a fin de mes y varios envíos subiendo un archivo CSV.
- **Programar envíos**, **direcciones guardadas**, **rastreo público con el piloto en vivo** y **ruta sugerida** cuando el piloto lleva varios paquetes.
- **Botón de emergencia** del piloto: avisa al panel con su ubicación y suena hasta que alguien lo marca como atendido.
- **Reportes** con descarga para Excel.
- **Equipo de oficina:** empleados que entran por /familiatecun con permisos limitados (sin caja, reportes, descuentos ni tarifas).

## Mapa con Mapbox (opcional)

Con una clave pública de Mapbox (empieza con `pk.`) el mapa usa el estilo moderno de Mapbox y su buscador de direcciones.
Se pega en el panel → Tarifas y ajustes → "Clave pública de Mapbox". Si se deja vacía, o si Mapbox no responde, se usa el mapa gratis.
Gratis hasta 50,000 cargas del mapa al mes. En mapbox.com → Tokens, restringe la clave a `https://vaelomensajeria.com`.

## Borrar datos de prueba

```bash
bash /opt/vaelo/vaelo/deploy/actualizar.sh --borrar-pruebas
```
Borra envíos, clientes y pilotos (no la cuenta de administración ni las tarifas). Antes guarda una copia en `/var/lib/vaelo/respaldos/`.

## Tecnología

- **Node.js 22**, sin paquetes externos (no hace falta `npm install`).
- **SQLite** como base de datos: un solo archivo en `/var/lib/vaelo/vaelo.db`, con copia de seguridad diaria en `/var/lib/vaelo/respaldos/` (se guardan 14 días).
- **Nginx** recibe las visitas y se las pasa al sistema.
- **Mapas:** MapLibre (incluido en `public/vendor/maplibre`, no depende de otro servidor) con el mapa de OpenFreeMap; si no carga, CARTO. Buscador de direcciones con sugerencias (Photon) y dirección del punto marcado. Gratis, sin llave. Kilómetros por calle con el servicio público de OSRM; si no responde, se estima con la distancia en línea recta × 1.4.

## Instalar en el servidor (una sola vez)

En la Web Console de DigitalOcean:

```bash
git clone https://github.com/TU_USUARIO/vaelo.git /opt/vaelo
bash /opt/vaelo/deploy/install.sh
```

Al final te pide el correo y la contraseña de tu cuenta de administrador.

## Actualizar después de cambiar algo en GitHub

```bash
bash /opt/vaelo/vaelo/deploy/actualizar.sh
```

## Comandos útiles

```bash
systemctl status vaelo          # ver si está funcionando
journalctl -u vaelo -n 50       # ver los últimos errores
systemctl restart vaelo         # reiniciar
```

## Logo

`public/img/logo-blanco.png` (barra y pie), `public/img/logo-negro.png` (guías) y los íconos de la app `icono-192.png`, `icono-512.png`, `apple-touch-icon.png`, `favicon.png`.
