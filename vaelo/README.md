# Vaelo Mensajería

Página web y app (instalable en el celular) de Vaelo, mensajería en moto y pickup en Guatemala. Los clientes crean su cuenta, envían paquetes marcando recogida y entrega en el mapa, y siguen al mensajero hasta la entrega.

**Precios:** tarifa fija cuando recogida y entrega están en las zonas cubiertas (1, 6, 16, 17, 18 y 24, editables). Fuera de ellas: otra tarifa fija (Q35 dentro y Q45 fuera en moto). Ya no se cobra por kilómetro. De cada envío Vaelo se queda con Q5 y el resto es del piloto. Todo se edita en el panel → Tarifas y ajustes.

## Qué incluye

| Dirección | Para quién | Qué hace |
|---|---|---|
| `/` | Todos | Página principal, cotizador de precios y rastreo |
| `/registro`, `/entrar` | Clientes | Crear cuenta e iniciar sesión |
| `/enviar`, `/mi-cuenta` | Clientes | Enviar paquetes (vehículo, peso, mapa), seguirlos en el mapa, imprimir la guía |
| `/modomensajero` | Pilotos | Registrarse y subir documentos, conectarse con GPS, aceptar o rechazar envíos, navegar con Google Maps o Waze, marcar recogido/entregado |
| `/rastreo` | Todos | Seguir un envío con el número de guía |
| `/familiatecun` | Administración | Aviso de pedidos nuevos, entregas fallidas y sede, asignar al piloto más cercano, GPS en vivo de la flota, aprobar pilotos y revisar sus documentos, verificar la identidad de los clientes, tarifas |

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
- Las renovaciones quedan **por revisar**: la oficina compara la fecha escrita con la foto en la ficha del piloto y la confirma o la rechaza con una nota. Mientras tanto vale la licencia o los antecedentes anteriores.
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
- Precio: por la zona elegida en la lista. Fuera de las zonas preferenciales se cobra la tarifa fija de fuera (Q45). Si la ubicación real que comparte quien recibe cae en otra zona, el precio se ajusta solo y se avisa.
- Hasta tener las dos ubicaciones no se busca piloto ni se puede recoger. En cada envío el panel puede autorizar una excepción con motivo; también se puede apagar en Tarifas y ajustes ("Pedir ubicaciones en vivo antes de recoger").
- Quien envía no ve la ubicación de quien recibe, ni aparece en el rastreo público. Las ubicaciones se dejan de compartir al recoger y al entregar, y se borran 30 días después.

## Políticas

- **Clientes:** `/terminos` y `/privacidad`. Sin tope fijo de responsabilidad: cada reclamo se evalúa según lo que llevaba el paquete y, si corresponde, se devuelve el dinero.
- **Pilotos:** `/politica-pilotos`. Se acepta al registrarse; los pilotos ya aprobados la aceptan al entrar antes de poder conectarse. Si cambia, sube `POLITICA_PILOTO_VERSION` en `server.js` y todos la vuelven a aceptar.
- **Empresas:** `/politicas-empresas`. Se acepta al enviar la solicitud de contrato.

## Cómo se cobra

- De cada envío **Vaelo cobra Q5** y el resto es para el piloto (Tarifas y ajustes > Asignación y pago de pilotos).
- **Foto del paquete obligatoria** al pedir: la ven el piloto, la oficina y el cliente.
- **Solo efectivo:** el envío se paga en efectivo al piloto (o paga quien recibe, en cuentas de empresa). Ya no hay transferencias ni pago a fin de mes; los pendientes viejos pasaron solos a efectivo.
- **Sin valor del contenido:** si pasa algo con un envío, la administración lo revisa con la foto del paquete, la foto de entrega y el recorrido.
- **Efectivo de los pilotos:** si un piloto no entrega el efectivo en la sede en 3 días (editable), no puede conectarse hasta liquidar.
- **Reclamos:** el cliente reporta desde el envío (3 días después de la entrega, editable). En Caja > Reclamos se decide cuánto se le devuelve al cliente y cuánto paga el piloto; eso se descuenta solo de su próximo pago.

## Fletes en pickup

- El pickup ya no aparece para los clientes: se pide por WhatsApp y servicio al cliente acuerda qué se lleva y el precio.
- En el panel, **Envíos > Nuevo flete**: solo precio acordado, vehículo, piloto y (opcional) el WhatsApp del cliente. Se genera un enlace `/flete/...` que se manda por WhatsApp.
- Con ese enlace el cliente llena quién entrega y quién recibe, qué se lleva (con foto), y la forma de pago. Luego cada uno comparte su ubicación en tiempo real, igual que en un envío normal. El precio no cambia.
- El piloto ve el flete «esperando datos» y puede salir cuando el cliente termina.
- Cualquier vehículo se puede marcar «Solo flete» en Tarifas y ajustes.

## Empresas

1. La empresa entra a **vaelomensajeria.com/empresas** (en el menú principal), crea su cuenta y llena la solicitud: datos de la empresa, representante, fotos de la sede, DPI del representante y patente de comercio.
2. La oficina la revisa en el panel (**Empresas**), pone la **cita para firmar** (la empresa recibe aviso y correo) y, ya firmado, **activa la empresa**.
3. Ya activa, en **Mi empresa** tiene dos pestañas: **Carpetas de envíos** y **Analítica**. En su panel **no aparece dinero**: Vaelo solo le presta los pilotos y cobra el envío.

### Carpetas de envíos
- La empresa crea una **carpeta** con el **día de entrega** (y un nombre si quiere). Adentro toca **«Añadir envío»**: qué es, **tamaño** (sobre, pequeño, mediano, grande), **foto** y el nombre y WhatsApp de su cliente. Se pueden añadir varios seguidos, o subir un Excel (hay plantilla).
- Por cada envío elige **«Le mando el enlace»** (se abre WhatsApp con el mensaje listo) o **«Lo lleno yo»**. Su cliente abre `/pedido/...`, ve que su pedido llega ese día y confirma **horario** (mañana, tarde o cualquier hora), **ubicación** y **quién recibe**; paga el envío en efectivo al recibir. Si no puede ese día toca **«No puedo ese día»** y la empresa recibe el aviso. Ahí mismo activa **«Avísame cuando el piloto salga»**.
- Con **10 confirmados** (se cambia en Tarifas y ajustes) aparece **«Enviar a Vaelo»** en la carpeta, con tres opciones y una recomendada según tamaños, cupo y tiempo de ruta: **una moto para todo**, **varias motos** o **pickup**. Los que no confirmaron pasan solos a una carpeta nueva.
- **Pickup:** lo paga la empresa en efectivo al piloto (habla primero por WhatsApp con Vaelo: precio y promoción) o cada cliente (Q35 en zonas preferenciales, Q45 fuera).
- Cada pedido tiene su código, que es también la guía, y la empresa imprime **etiquetas con código QR** para pegarlas en los paquetes.
- Si un pedido no se entrega, **queda en la sede de Vaelo**: la empresa manda a alguien a recogerlo con el código y la bodega se le cobra por día por WhatsApp.

- En cada envío hay un botón principal (Tomar foto / Mandar enlace / Recordar) y el menú **«⋯»** con lo demás: copiar enlace, llenar datos, cambiar foto, **mover a otra carpeta** (si el cliente no puede ese día) y quitar.
- **«Recordar a los que faltan»** abre la lista de clientes sin confirmar con un botón de WhatsApp para cada uno.
- **«📋 Pegar datos de WhatsApp»** al añadir un envío: pegas lo que mandó el cliente (nombre, teléfono, dirección) y se llenan solos los campos.

### En el panel de Vaelo (Empresas)
- Lista de empresas activas, con las que tienen pedidos por repartir arriba. Al tocar una: **Por repartir, En ruta, En sede, Historial y Datos**. Las solicitudes de contrato están en su propia sub-pestaña.
- **Dividir pedidos:** el mapa arma las rutas solo (primero la mañana, después lo más cercano). «Dividir entre N motos», «Una moto», «Un paquete por moto» o «Pickup»; se pueden pasar pedidos entre rutas y cambiar el orden. Luego se asigna cada ruta a un piloto.
- Los pedidos de empresas tienen **prioridad** y no se mezclan con la lista general de Envíos (filtro «De empresas»).
- El piloto acepta **la ruta completa**, escanea las etiquetas al recoger y entrega en orden. A la empresa le llega aviso y correo; a cada cliente «va en camino, eres la parada 3 de 5» y «eres el próximo». Si el cliente no activó los avisos, el piloto tiene el botón **«Avisar por WhatsApp»**.

## Entregas fallidas, sede y cargos

- Si el piloto no puede entregar (no contestan, no hay nadie, dirección incorrecta, rechazo o no pagaron el cobro), toca **No pude entregar** estando en el lugar.
- El cliente recibe un aviso y elige en su cuenta:
  - **Devolvérselo** (Q35 al inicio): el piloto lo regresa al punto de recogida con foto y nombre de quien lo recibe.
  - **Guardarlo en la sede** (Q20 por día o fracción): el piloto lo deja en la sede. Desde ahí lo retiran (lo marca la oficina) o se manda de nuevo con un piloto (Q35 más los días en la sede). El enlace y el código de quien recibe siguen sirviendo.
- Si el cliente no elige en 2 horas, el paquete va a la sede solo. La oficina también puede decidir por él desde el envío.
- Cancelar con el piloto ya en camino cuesta Q15; el piloto gana el 50 %.
- Los cargos pendientes se suman al siguiente envío del cliente. En **Caja > Cargos a clientes** se marcan pagados o se anulan.
- Todos los montos, el plazo y la ubicación de la sede se cambian en **Tarifas y ajustes**.

## Precio con los puntos reales

- Cada zona con tarifa fija se puede **dibujar en el mapa** (Tarifas y ajustes > Zonas > Dibujar).
- Con zonas dibujadas, la tarifa fija solo vale si la recogida y la entrega reales caen dentro de alguna. Si no, se cobra la tarifa de fuera de zonas.
- Sin zonas dibujadas, la tarifa fija vale hasta 15 km (editable).
- Si quien recibe (o quien entrega) se mueve más de 1 km, el precio se vuelve a calcular y se le avisa al cliente.
- Con clave de Mapbox, los km se miden con el servicio de rutas de Mapbox (más confiable que el servidor público de OSRM).

## Avisos al celular (push) y por correo

- Clientes, pilotos y oficina activan los avisos con el botón **Activar avisos**. Llegan aunque Vaelo esté cerrado.
- Cliente: piloto aceptó, recogido, llegando, entregado, no se pudo entregar, precio actualizado, devuelto, en la sede. Los importantes también por correo (con Resend configurado).
- Piloto: envío nuevo asignado, envío cancelado, devolver o llevar a la sede.
- Oficina: pedido nuevo, entrega fallida, envío sin piloto.
- En iPhone los avisos funcionan solo con Vaelo instalado en la pantalla de inicio (iOS 16.4 o más nuevo).
- **Límite que sigue igual:** el GPS del piloto solo funciona con la app abierta y la pantalla encendida.

## Para usar todos los días
- **Cliente:** la zona de recogida sale sola con su ubicación; en el celular el precio y el botón «Enviar» quedan fijos abajo; los avisos de «Instalar» y «Activar avisos» se pueden cerrar; «Mis envíos» separa **En curso** e **Historial**; **«Repetir»** copia un envío anterior (solo falta la foto nueva). Quien recibe ve **«Llamar a [piloto]»**.
- **Oficina:** la lista de envíos abre en **Activos**; los que no tienen piloto traen el botón **«Al más cercano»** (asigna al piloto en línea más cercano con ese vehículo). En el detalle se ve el **reparto**: cuánto es del piloto y cuánto de Vaelo. «Cambiar estado a mano» queda plegado.
- **Piloto:** lo terminado queda plegado en «Terminados»; la foto de entrega se toma con un botón de cámara; el botón de emergencia es más chico.

## Otras funciones

- **Olvidé mi contraseña** para clientes y pilotos (`/recuperar`, necesita Resend). La administración cambia la suya con `actualizar.sh --clave-admin`.
- **Mis ganancias** del piloto: por cobrar, hoy, semana, mes, efectivo que debe entregar y pagos anteriores.
- **Calificación del cliente:** el piloto califica al cliente al terminar; la oficina ve el promedio.
- **Varios envíos desde el mismo lugar** (cualquier cliente): en «El paquete», **«+ Agregar otro envío»** abre una tarjeta con el paquete (peso, contenido, foto) y quién lo recibe (nombre, teléfono, zona). Hasta 3 envíos extra, 4 en total. Cada envío se cobra aparte según su zona (Q35 o Q45) y el total aparece abajo. Salen juntos con el mismo piloto y al final sale el enlace de cada quien recibe para mandarlo por WhatsApp.
- **Tema de Navidad**: se activa y desactiva en el panel, Tarifas y ajustes.
- **Términos** (`/terminos`) y **privacidad** (`/privacidad`). Al registrarse se aceptan. Conviene que un abogado los revise.

## Seguridad y servidor

- `actualizar.sh` configura Nginx para tomar la IP real **solo** de Cloudflare. Así los bloqueos por intentos fallidos no se pueden saltar.
- Los intentos fallidos se cuentan por internet y por correo; los inicios de sesión correctos no cuentan.
- Al cambiar la contraseña se cierran las demás sesiones.
- Un envío cerrado o que ya está en la caja no se puede cambiar a mano, y todo cambio manual pide motivo.
- **Respaldos:** cada noche (comprimidos, 14 días). Si escribes un correo en Tarifas y ajustes > Copias de seguridad, también llegan por correo. Botón para descargar una copia al momento.
- **Vigilante:** cada 5 minutos revisa que Vaelo responda; si no, lo reinicia y avisa al correo de respaldos. Para enterarte si se apaga todo el servidor, agrega `https://vaelomensajeria.com/api/salud` a un monitor gratis como UptimeRobot.
- Pruebas automáticas: `node --test pruebas/flujos.test.js`.

## App en el celular (se instala desde Chrome, sin .apk ni Play Store)

- **Clientes:** en la página principal, el recuadro "Instala la app de Vaelo en tu celular" tiene el botón **Instalar la app**. Chrome abre su ventana para instalar y la app queda en la pantalla de inicio (abre en `/mi-cuenta`).
- **Pilotos:** el recuadro "¿Buscas trabajo?" lleva a `/modomensajero`, donde aparece el aviso **Instala Vaelo Pilotos en tu celular** (abre en `/modomensajero`).
- Si el navegador no muestra la ventana para instalar, la página explica los pasos: en Chrome, menú ⋮ → "Instalar app" o "Agregar a pantalla principal"; en iPhone, Safari → Compartir → "Agregar a pantalla de inicio".
- No hay nada que subir en el panel. Ya no existen `/descargas/vaelo.apk`, `/descargas/vaelo-piloto.apk` ni `/.well-known/assetlinks.json`.

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
- **Caja** (solo administración): **sueldo de cada piloto en una sola cuenta**: lo que ganó menos el efectivo que trae. Sale «Vaelo le paga Q90» o «Debe entregar Q50» y el botón **«Ya fue pagado»** (solo administradores) la cierra y la guarda en el historial. Cada piloto elige en su app si cobra cada día, cada semana o cada quincena.
- **Cerrar día** (Caja): se toca al final del día, cuando ya no falta nada. Guarda el Excel del día (resumen, envíos, sueldos, caja y empresas) y el conteo empieza de nuevo. En **Reportes** quedan todos los cierres y los Excel de la semana, el mes y el año, que se calculan solos.
- **Buscador** arriba del panel (tecla **/**): pilotos con su neto del día, guías, pedidos, empresas y clientes. El botón **QR** escanea la etiqueta de un paquete con la cámara.
- **Descuentos:** promociones automáticas por fechas (se anuncian en la página) y cupones. Se aplica el mejor para el cliente, no se suman.
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
