module.exports = {
  apps: [
    {
      name: "models-xedoc-server",
      cwd: "/var/www/models.xedoc.ru/apps/server",
      script: "dist/index.js",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        PORT: "3421",
        HOST: "127.0.0.1",
        DATA_DIR: "/var/www/models.xedoc.ru/data"
      }
    }
  ]
};
