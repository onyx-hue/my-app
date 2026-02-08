// src/otaUpdater.js
// OTA simple : télécharge app.zip depuis GH Pages, dézippe dans le stockage interne et écrit les fichiers.
// Utilise JSZip + @capacitor/filesystem + @capacitor/preferences
import JSZip from 'jszip'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Preferences } from '@capacitor/preferences'
import { Capacitor } from '@capacitor/core'
import logger from './logger'

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
  try {
    await Filesystem.mkdir({ path, directory: Directory.Data, recursive: true })
  } catch (e) { /* ignore */ }
}

export async function loadLocalIndexIfPresent() {
  const idxPath = `${LOCAL_WWW_DIR}/index.html`
  if (!(await fileExists(idxPath))) {
    logger.info('loadLocalIndexIfPresent: no local index found')
    return false
  }

  try {
    const uriResult = await Filesystem.getUri({ directory: Directory.Data, path: idxPath })
    const fileUri = uriResult.uri || uriResult
    const webFriendly = Capacitor.convertFileSrc(fileUri)
    logger.info('Loading local index: ' + webFriendly)
    window.location.href = webFriendly
    return true
  } catch (e) {
    logger.error('Erreur en chargeant index local: ' + e)
    return false
  }
}

export async function checkForUpdates(showPrompts = true) {
  try {
    logger.info('Vérification de mise à jour en cours...')
    const r = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' })
    if (!r.ok) {
      logger.warn('Impossible de récupérer version.json, code ' + r.status)
      return
    }
    const remote = await r.json()
    const local = await Preferences.get({ key: 'appVersion' })
    const localVersion = local?.value || '0.0.0'
    logger.info(`Version locale=${localVersion} remote=${remote.version}`)

    if (localVersion === remote.version) {
      logger.info('OTA: déjà à jour')
      return
    }

    logger.info('Nouvelle version détectée: ' + remote.version)
    logger.info('Téléchargement du bundle...')
    const z = await fetch(BUNDLE_URL + '?t=' + Date.now())
    if (!z.ok) {
      logger.error('Erreur téléchargement bundle: ' + z.status)
      throw new Error('Erreur téléchargement bundle: ' + z.status)
    }

    // streaming progress: try to read and log progress if possible
    try {
      const reader = z.body?.getReader?.()
      if (reader) {
        let received = 0
        const contentLength = +z.headers.get('Content-Length') || 0
        logger.info('Taille annoncée: ' + (contentLength || 'inconnue') + ' bytes')
        const chunks = []
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          received += value.length
          if (contentLength) {
            const pct = Math.round((received / contentLength) * 100)
            logger.info(`Download progress: ${pct}% (${received}/${contentLength})`)
          } else {
            logger.info(`Download received ${received} bytes`)
          }
        }
        // concat
        const total = chunks.reduce((acc, c) => {
          const t = new Uint8Array(acc.length + c.length)
          t.set(acc, 0)
          t.set(c, acc.length)
          return t
        }, new Uint8Array())
        const arrayBuffer = total.buffer
        await _processZip(arrayBuffer, remote.version)
        return
      }
    } catch (e) {
      logger.warn('Progress streaming non disponible: ' + e)
    }

    // fallback: blob -> arrayBuffer
    const blob = await z.blob()
    const arrayBuffer = await blob.arrayBuffer()
    await _processZip(arrayBuffer, remote.version)

  } catch (err) {
    logger.error('OTA check failed: ' + (err && err.message ? err.message : err))
  }
}

async function _processZip(arrayBuffer, remoteVersion) {
  try {
    logger.info('Extraction du zip...')
    const zip = await JSZip.loadAsync(arrayBuffer)

    const writePromises = []
    zip.forEach((relativePath, zipEntry) => {
      if (zipEntry.dir) return
      writePromises.push((async () => {
        const fullPath = `${LOCAL_WWW_DIR}/${relativePath}`
        const dir = fullPath.split('/').slice(0, -1).join('/')
        if (dir) await ensureDir(dir)
        const base64 = await zipEntry.async('base64')
        await Filesystem.writeFile({
          path: fullPath,
          data: base64,
          directory: Directory.Data
        })
        logger.info(`Wrote ${fullPath}`)
      })())
    })

    await Promise.all(writePromises)
    await Preferences.set({ key: 'appVersion', value: remoteVersion })
    logger.info('OTA: mise à jour téléchargée et appliquée localement (version=' + remoteVersion + ')')
    // Option: loader showing prompt to restart is left to UI
  } catch (e) {
    logger.error('Erreur pendant extraction/écriture du zip: ' + e)
    throw e
  }
}