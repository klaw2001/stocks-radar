module.exports = {
  apps: [{
    name: "results-radar",
    script: "server.cjs",
    env: {
      NODE_ENV: "production",
      PORT: 5000
    },
    watch: false,
    autorestart: true,
    max_memory_restart: "300M",
    log_date_format: "YYYY-MM-DD HH:mm:ss"
  }]
}
