// src/otaUpdater.js
// OTA simple : télécharge app.zip depuis GH Pages, dézippe dans le stockage interne et écrit les fichiers.
// Utilise JSZip + @capacitor/filesystem + @capacitor/preferences
import JSZip from 'jszip'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Preferences } from '@capacitor/preferences'
import { Capacitor } from '@capacitor/core'

const VERSION_URL = 'https://onyx-hue.github.io/my-app/version.json'
const BUNDLE_URL = 'https://onyx-hue.github.io/my-app/app.zip'
const LOCAL_WWW_DIR = 'www' // on écrira dans data/www/

async function fileExists(path) {
  try {
    await Filesystem.stat({ path, directory: Directory.Data })
    return true
  } catch (e) {
    return false
  }
}

async function ensureDir(path) {
  // Filesystem.mkdir échoue si le dossier existe déjà, donc on ignore les erreurs
  try {
    await Filesystem.mkdir({ path, directory: Directory.Data, recursive: true })
  } catch (e) {
    // ignore
  }
}

export async function loadLocalIndexIfPresent() {
  // Si un bundle local a déjà été appliqué, on charge index.html local
  const idxPath = `${LOCAL_WWW_DIR}/index.html`
  if (!(await fileExists(idxPath))) return false

  try {
    const uriResult = await Filesystem.getUri({ directory: Directory.Data, path: idxPath })
    const fileUri = uriResult.uri || uriResult // compat
    const webFriendly = Capacitor.convertFileSrc(fileUri)
    // Navigue vers le index local (remplace le contenu courant de la WebView)
    window.location.href = webFriendly
    return true
  } catch (e) {
    console.error('Erreur en chargeant index local', e)
    return false
  }
}

export async function checkForUpdates(showPrompts = true) {
  try {
    const r = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' })
    if (!r.ok) {
      console.warn('Impossible de récupérer version.json', r.status)
      return
    }
    const remote = await r.json()
    const local = await Preferences.get({ key: 'appVersion' })
    const localVersion = local?.value || '0.0.0'
    if (localVersion === remote.version) {
      console.log('OTA: déjà à jour', localVersion)
      return
    }

    console.log('OTA: nouvelle version détectée', remote.version)
    // Télécharge le zip
    const z = await fetch(BUNDLE_URL + '?t=' + Date.now())
    if (!z.ok) throw new Error('Erreur téléchargement bundle: ' + z.status)
    const blob = await z.blob()
    const arrayBuffer = await blob.arrayBuffer()
    // JSZip peut charger un ArrayBuffer directement
    const zip = await JSZip.loadAsync(arrayBuffer)

    // Écrire chaque fichier du zip dans Directory.Data/www/...
    // On parcourt toutes les entrées
    const writePromises = []
    zip.forEach((relativePath, zipEntry) => {
      if (zipEntry.dir) return // ignorer dossiers
      writePromises.push((async () => {
        // s'assurer que le dossier existe
        const fullPath = `${LOCAL_WWW_DIR}/${relativePath}`
        const dir = fullPath.split('/').slice(0, -1).join('/')
        if (dir) await ensureDir(dir)
        const base64 = await zipEntry.async('base64')
        await Filesystem.writeFile({
          path: fullPath,
          data: base64,
          directory: Directory.Data
        })
      })())
    })

    await Promise.all(writePromises)

    // mise à jour de la version
    await Preferences.set({ key: 'appVersion', value: remote.version })

    if (showPrompts) {
      // demander à l'utilisateur de recharger (ou recharger automatiquement)
      if (confirm(`Nouvelle version (${remote.version}) téléchargée. Redémarrer pour appliquer ?`)) {
        // charger le index local fraîchement écrit
        const load = await loadLocalIndexIfPresent()
        if (!load) {
          // fallback : recharger la WebView (cela charge le bundle intégré si la navigation locale échoue)
          window.location.reload()
        }
      }
    } else {
      // silent fallback: tenter de charger le local sans demander
      await loadLocalIndexIfPresent()
    }
  } catch (err) {
    console.error('OTA check failed', err)
  }
}
