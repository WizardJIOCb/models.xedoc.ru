#!/usr/bin/env bash
set -euo pipefail

repo_dir=/var/www/models.xedoc.ru
site_available=/etc/nginx/sites-available/models.xedoc.ru.conf
site_enabled=/etc/nginx/sites-enabled/models.xedoc.ru.conf

if [[ "$(realpath -m "$repo_dir")" != "/var/www/models.xedoc.ru" ]]; then
    echo "Unexpected deployment path" >&2
    exit 1
fi

if [[ ! -d "$repo_dir/.git" ]]; then
    git clone https://github.com/WizardJIOCb/models.xedoc.ru.git "$repo_dir"
else
    git -C "$repo_dir" fetch --prune origin
    git -C "$repo_dir" reset --hard origin/main
fi

install -m 0644 "$repo_dir/.deploy/nginx.conf" "$site_available"
ln -sfn "$site_available" "$site_enabled"
nginx -t
systemctl reload nginx
