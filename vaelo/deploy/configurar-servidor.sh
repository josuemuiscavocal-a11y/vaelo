#!/usr/bin/env bash
# Ajustes del servidor que se aplican en cada actualización (los llaman install.sh y actualizar.sh).
#  1) IP real de los visitantes detrás de Cloudflare (para que los límites de intentos funcionen y no se puedan saltar)
#  2) Copia de seguridad diaria y vigilante que reinicia Vaelo si deja de responder
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR=/var/lib/vaelo
NODE_FLAGS="--disable-warning=ExperimentalWarning"
NODE_BIN="$(command -v node)"

# 1) Nginx solo acepta la cabecera CF-Connecting-IP cuando la petición viene de una dirección de Cloudflare
CF_CONF=/etc/nginx/conf.d/vaelo-cloudflare.conf
RANGOS="$(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v4 2>/dev/null; echo; curl -fsS --max-time 15 https://www.cloudflare.com/ips-v6 2>/dev/null)" || true
if ! echo "$RANGOS" | grep -Eq '^[0-9a-f:.]+/[0-9]+$'; then
  # Sin internet hacia Cloudflare: lista conocida (se actualiza sola la próxima vez)
  RANGOS="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20
197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22
2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"
fi
{
  echo "# Generado por Vaelo (deploy/configurar-servidor.sh). IP real detrás de Cloudflare."
  for r in $RANGOS; do echo "$r" | grep -Eq '^[0-9a-f:.]+/[0-9]+$' && echo "set_real_ip_from $r;"; done
  echo "real_ip_header CF-Connecting-IP;"
} > "$CF_CONF.nuevo"
if ! cmp -s "$CF_CONF.nuevo" "$CF_CONF" 2>/dev/null; then
  mv "$CF_CONF.nuevo" "$CF_CONF"
  if nginx -t 2>/dev/null; then systemctl reload nginx; echo "IP real de Cloudflare configurada."; else rm -f "$CF_CONF"; echo "Aviso: Nginx no aceptó la configuración de Cloudflare; se dejó como estaba."; fi
else
  rm -f "$CF_CONF.nuevo"
fi

# 2) Respaldo diario (3:30 a. m. de Guatemala) y vigilante cada 5 minutos
cat > /etc/cron.d/vaelo-respaldo <<CRON
30 9 * * * vaelo VAELO_DATA=$DATA_DIR $NODE_BIN $NODE_FLAGS $APP_DIR/herramientas/respaldo.js >>$DATA_DIR/respaldo.log 2>&1
CRON
cat > /etc/cron.d/vaelo-vigilante <<CRON
*/5 * * * * root $NODE_BIN $NODE_FLAGS $APP_DIR/herramientas/vigilante.js >>/var/log/vaelo-vigilante.log 2>&1
CRON
chmod 644 /etc/cron.d/vaelo-respaldo /etc/cron.d/vaelo-vigilante
