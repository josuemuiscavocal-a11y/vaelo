#!/usr/bin/env bash
# Descarga los últimos cambios desde GitHub y reinicia Vaelo.
# Uso:  bash /opt/vaelo/deploy/actualizar.sh
# Para cambiar la contraseña de administración:  bash /opt/vaelo/deploy/actualizar.sh --clave-admin
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
APP_DIR="$(pwd)"
DATA_DIR=/var/lib/vaelo
NODE_FLAGS="--disable-warning=ExperimentalWarning"
ADMIN_EMAIL="administracionvaelo@vaelomensajeria.com"

if [ "${1:-}" != "--clave-admin" ]; then
  git pull --ff-only
  systemctl restart vaelo
  sleep 2
  if systemctl is-active --quiet vaelo; then echo "Vaelo actualizado y funcionando."; else journalctl -u vaelo -n 30 --no-pager; exit 1; fi
fi

# Cuenta de administración: se crea la primera vez (o se cambia la contraseña con --clave-admin)
HAY_ADMIN="$(runuser -u vaelo -- env VAELO_DATA=$DATA_DIR node $NODE_FLAGS -e "const {db}=require('$APP_DIR/db');console.log(db.prepare(\"SELECT COUNT(*) n FROM usuarios WHERE email=? AND rol='admin'\").get('$ADMIN_EMAIL').n)")"
if [ "$HAY_ADMIN" = "0" ] || [ "${1:-}" = "--clave-admin" ]; then
  echo
  echo "Contraseña para entrar al panel en vaelomensajeria.com/familiatecun"
  echo "Correo: $ADMIN_EMAIL"
  while :; do
    read -r -s -p "Escribe la contraseña (mínimo 12 caracteres, no se ve al escribir): " CLAVE </dev/tty; echo
    read -r -s -p "Escríbela otra vez: " CLAVE2 </dev/tty; echo
    if [ "$CLAVE" != "$CLAVE2" ]; then echo "No coinciden, inténtalo de nuevo."; continue; fi
    [ "${#CLAVE}" -ge 12 ] && break
    echo "Muy corta, inténtalo de nuevo."
  done
  runuser -u vaelo -- env VAELO_DATA="$DATA_DIR" VAELO_ADMIN_PASSWORD="$CLAVE" node $NODE_FLAGS "$APP_DIR/herramientas/crear-admin.js"
  unset CLAVE CLAVE2
fi
