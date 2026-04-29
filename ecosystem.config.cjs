module.exports = {
  apps: [
    {
      name: "lark-h5-bug-bot-worker",
      cwd: `${__dirname}/worker`,
      script: "pnpm",
      args: "start",
      interpreter: "none",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
