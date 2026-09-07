#!/bin/sh
set -eu
target=/etc/nginx/sites-available/models.xedoc.ru.conf
expected=9c3b56af5881b702e014f89918b9c1dbc4b87b248bf7d59f232481f482955562
actual=$(sha256sum "$target" | cut -d ' ' -f 1)
if [ "$actual" != "$expected" ]; then
  echo 'Nginx config changed since review. Inspect before deploying.' >&2
  exit 1
fi
curl --fail --silent --max-time 30 http://127.0.0.1:18095/api/model-studio/health | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("service")=="model-studio" and d["online"]'
backup="$target.before-studio-$(date +%Y%m%d-%H%M%S)"
cp -p "$target" "$backup"
cp -p /var/www/models.xedoc.ru/.deploy/offline.html /var/www/models.xedoc.ru/.deploy/offline.before-studio.html
install -m 644 /tmp/models-studio-offline.html /var/www/models.xedoc.ru/.deploy/offline.html
install -m 644 /tmp/models-studio-nginx.conf "$target"
if nginx -t; then
  systemctl reload nginx
  printf 'Deployed. Backup: %s\n' "$backup"
  sha256sum "$target"
else
  cp -p "$backup" "$target"
  echo 'Validation failed; original config restored.' >&2
  exit 1
fi
