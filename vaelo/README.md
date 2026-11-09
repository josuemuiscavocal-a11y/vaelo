# Vaelo Mensajería

Página web y app (instalable en el celular) de Vaelo, mensajería en moto y pickup en Guatemala. Los clientes crean su cuenta, envían paquetes marcando recogida y entrega en el mapa, y siguen al mensajero hasta la entrega.

**Precios:** tarifa fija cuando recogida y entrega están en las zonas cubiertas (1, 6, 16, 17, 18 y 24, editables). Fuera de ellas: arranque + kilómetros × precio por km, según el vehículo. Todo se edita en el panel → Tarifas y ajustes.

## Qué incluye

| Dirección | Para quién | Qué hace |
|---|---|---|
| `/` | Todos | Página principal, cotizador de precios y rastreo |
| `/registro`, `/entrar` | Clientes | Crear cuenta e iniciar sesión |
| `/enviar`, `/mi-cuenta` | Clientes | Enviar paquetes (vehículo, peso, mapa), seguirlos en el mapa, imprimir la guía |
| `/mensajero` | Mensajeros | Ver entregas asignadas, navegar con Google Maps o Waze, marcar recogido/entregado, compartir ubicación |
| `/rastreo` | Todos | Seguir un envío con el número de guía |
| `/familiatecun` | Administración | Aviso de pedidos nuevos, asignar mensajeros, cambiar estados, mapa de la flota, empleados (con fecha de nacimiento, DPI y fotos del DPI), clientes, vehículos, zonas y precios |

## Acceso de administración

- El panel está en `vaelomensajeria.com/familiatecun` (la dirección `/admin` ya no existe).
- Solo puede entrar **administracionvaelo@vaelomensajeria.com**. Esa cuenta no entra por `/entrar`.
- La contraseña no está en el código. Se escribe en el servidor la primera vez que corres `deploy/actualizar.sh`.
  Para cambiarla: `bash /opt/vaelo/deploy/actualizar.sh --clave-admin`
- 5 intentos fallidos bloquean ese internet por 30 minutos. La sesión del panel dura 12 horas.
- Las fotos del DPI de los empleados se guardan en `/var/lib/vaelo/documentos/` y solo se ven desde el panel.

## Tecnología

- **Node.js 22**, sin paquetes externos (no hace falta `npm install`).
- **SQLite** como base de datos: un solo archivo en `/var/lib/vaelo/vaelo.db`, con copia de seguridad diaria en `/var/lib/vaelo/respaldos/` (se guardan 14 días).
- **Nginx** recibe las visitas y se las pasa al sistema.
- **Mapas:** Leaflet con OpenStreetMap (gratis, sin llave). Kilómetros por calle con el servicio público de OSRM; si no responde, se estima con la distancia en línea recta × 1.4.

## Instalar en el servidor (una sola vez)

En la Web Console de DigitalOcean:

```bash
git clone https://github.com/TU_USUARIO/vaelo.git /opt/vaelo
bash /opt/vaelo/deploy/install.sh
```

Al final te pide el correo y la contraseña de tu cuenta de administrador.

## Actualizar después de cambiar algo en GitHub

```bash
bash /opt/vaelo/deploy/actualizar.sh
```

## Comandos útiles

```bash
systemctl status vaelo          # ver si está funcionando
journalctl -u vaelo -n 50       # ver los últimos errores
systemctl restart vaelo         # reiniciar
```

## Logo

`public/img/logo-blanco.png` (barra y pie), `public/img/logo-negro.png` (guías) y los íconos de la app `icono-192.png`, `icono-512.png`, `apple-touch-icon.png`, `favicon.png`.
