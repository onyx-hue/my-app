// scripts/set-remote-capacitor-config.js
// Usage: node scripts/set-remote-capacitor-config.js https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO_NAME
const fs = require('fs')
const path = require('path')

const remoteUrl = process.argv[2]
if (!remoteUrl) {
  console.error('Usage: node scripts/set-remote-capacitor-config.js <remoteUrl>')
  process.exit(1)
}

const rootConfigPath = path.resolve('capacitor.config.json')
let cfg = {}
if (fs.existsSync(rootConfigPath)) {
  cfg = JSON.parse(fs.readFileSync(rootConfigPath, 'utf8'))
}
cfg.server = cfg.server || {}
cfg.server.url = remoteUrl
// write into android assets (Android uses android/app/src/main/assets/capacitor.config.json)
const androidAssetsPath = path.resolve('android/app/src/main/assets')
if (!fs.existsSync(androidAssetsPath)) fs.mkdirSync(androidAssetsPath, { recursive: true })
fs.writeFileSync(path.join(androidAssetsPath, 'capacitor.config.json'), JSON.stringify(cfg, null, 2))
console.log('Wrote android/app/src/main/assets/capacitor.config.json with server.url=' + remoteUrl)
