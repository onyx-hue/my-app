// src/otaUpdater.js
// OTA helper — utilise JSZip + @capacitor/filesystem + @capacitor/preferences
// Télécharge app.zip depuis GitHub Pages, extrait dans Directory.Data/www,
// propose injection dans le DOM (pour garder l'UI React + console visible),
// et fournit une fonction pour effacer le bundle local.
//
// URLs (déjà configurées pour ton repo)
import JSZip from 'jszip'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Preferences } from '@capacitor/preferences'
import { Capacitor } from '@capacitor/core'
import logger from './logger'

const VERSION_URL = 'https://onyx-hue.github.io/my-app/version.json'
const BUNDLE_URL = 'https://onyx-hue.github.io/my-app/app.zip'
const LOCAL_WWW_DIR = 'www' // on écrit dans Directory.Data/www

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
  } catch (e) {
    // ignore if exists / or not supported
  }
}

// Supprime le bundle local (safe): tentative d'appel Filesystem.rm, sinon ignore
export async function clearLocalBundle() {
  try {
    logger.info('clearLocalBundle: suppression du dossier local ' + LOCAL_WWW_DIR)
    // try rm (some Capacitor versions support it)
    try {
      await Filesystem.rm({ path: LOCAL_WWW_DIR, directory: Directory.Data, recursive: true })
      logger.info('clearLocalBundle: Filesystem.rm succeeded')
    } catch (eRm) {
      // fallback: try to remove files by listing
      logger.warn('clearLocalBundle: Filesystem.rm not available or failed, fallback: ' + (eRm && eRm.message ? eRm.message : eRm))
      try {
        const list = await Filesystem.readdir({ path: LOCAL_WWW_DIR, directory: Directory.Data }).catch(() => ({ files: [] }))
        if (list && list.files) {
          // attempt to remove each file — this may not remove directories recursively on all platforms
          for (const f of list.files) {
            const full = `${LOCAL_WWW_DIR}/${f}`
            try { await Filesystem.rm({ path: full, directory: Directory.Data, recursive: true }) } catch(e2) { /* ignore */ }
          }
        }
        // final attempt to remove the folder
        try { await Filesystem.rm({ path: LOCAL_WWW_DIR, directory: Directory.Data, recursive: true }) } catch(e3) {}
      } catch (e2) {
        logger.warn('clearLocalBundle fallback removal failed: ' + (e2 && e2.message ? e2.message : e2))
      }
    }
  } catch (e) {
    logger.warn('clearLocalBundle: erreur during removal: ' + (e && e.message ? e.message : e))
  }

  try {
    await Preferences.set({ key: 'appVersion', value: '0.0.0' })
    logger.info('clearLocalBundle: appVersion reset to 0.0.0')
  } catch (e) {
    logger.warn('clearLocalBundle: unable to reset appVersion: ' + (e && e.message ? e.message : e))
  }
}

// Injecte index.html local dans un container DOM (id par défaut 'localAppContainer').
// Cette méthode essaye d'ajouter <base> pour que les chemins relatifs résolvent vers le bundle local,
// injecte link/style/meta dans le head courant et ré-exécute les scripts (séquentiellement).
export async function injectLocalIndexIntoContainer(containerId = 'localAppContainer') {
  try {
    const idxPath = `${LOCAL_WWW_DIR}/index.html`
    if (!(await fileExists(idxPath))) {
      logger.info('injectLocalIndex: index absent: ' + idxPath)
      return false
    }

    const file = await Filesystem.readFile({ path: idxPath, directory: Directory.Data })
    const html = atob(file.data || file) // decode base64
    const uriResult = await Filesystem.getUri({ directory: Directory.Data, path: idxPath })
    const fileUri = uriResult.uri || uriResult
    const webFriendly = Capacitor.convertFileSrc(fileUri)
    const baseUrl = webFriendly.replace(/index\.html?$/i, '')

    logger.info('injectLocalIndex: baseUrl=' + baseUrl)

    const container = document.getElementById(containerId)
    if (!container) {
      logger.warn('injectLocalIndex: container introuvable: ' + containerId)
      return false
    }

    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')

    // ensure base tag
    let baseTag = doc.querySelector('base')
    if (!baseTag) {
      baseTag = doc.createElement('base')
      doc.head.insertBefore(baseTag, doc.head.firstChild)
    }
    baseTag.setAttribute('href', baseUrl)

    // inject link/style/meta tags from bundle head into current head
    try {
      const temp = document.createElement('div')
      temp.innerHTML = doc.head.innerHTML
      Array.from(temp.children).forEach(node => {
        const tagName = node.tagName && node.tagName.toLowerCase()
        if (['link', 'style', 'meta'].includes(tagName)) {
          document.head.appendChild(node.cloneNode(true))
        }
      })
    } catch (e) {
      logger.warn('injectLocalIndex: error injecting head tags: ' + (e && e.message ? e.message : e))
    }

    // set body
    container.innerHTML = doc.body.innerHTML

    // execute scripts sequentially and guarded
    const scripts = Array.from(doc.querySelectorAll('script'))
    for (const s of scripts) {
      try {
        const newScript = document.createElement('script')
        if (s.src) {
          let src = s.getAttribute('src')
          try { src = new URL(src, baseUrl).toString() } catch (e) {}
          newScript.src = src
          newScript.async = false
          container.appendChild(newScript)
          logger.info('Injected external script: ' + src)
          // wait for load or error to catch failures early
          await new Promise((res, rej) => {
            newScript.onload = () => res(true)
            newScript.onerror = () => rej(new Error('Script load failed: ' + src))
          })
        } else {
          newScript.text = s.textContent || ''
          container.appendChild(newScript)
        }
      } catch (e) {
        logger.error('injectLocalIndex: script injection error: ' + (e && e.message ? e.message : e))
        // if a critical script fails to load, abort injection
        return false
      }
    }

    logger.info('injectLocalIndex: injection réussie')
    return true
  } catch (e) {
    logger.error('injectLocalIndex failed: ' + (e && e.message ? e.message : e))
    return false
  }
}

// Charge local index si présent: on tente d'injecter d'abord, sinon on navigue vers le fichier local (fallback)
export async function loadLocalIndexIfPresent() {
  const injected = await injectLocalIndexIntoContainer()
  if (injected) {
    logger.info('loadLocalIndexIfPresent: injected local index')
    return true
  }

  // fallback navigation
  try {
    const idxPath = `${LOCAL_WWW_DIR}/index.html`
    if (!(await fileExists(idxPath))) return false
    const uriResult = await Filesystem.getUri({ directory: Directory.Data, path: idxPath })
    const fileUri = uriResult.uri || uriResult
    const webFriendly = Capacitor.convertFileSrc(fileUri)
    logger.info('Navigating to local index: ' + webFriendly)
    window.location.href = webFriendly
    return true
  } catch (e) {
    logger.error('loadLocalIndexIfPresent fallback failed: ' + (e && e.message ? e.message : e))
    return false
  }
}

// Check for updates: télécharge app.zip, extrait et écrit dans Directory.Data/www
export async function checkForUpdates(showPrompts = true) {
  try {
    logger.info('checkForUpdates: starting')
    const r = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' })
    if (!r.ok) {
      logger.warn('Impossible de récupérer version.json (status ' + r.status + ')')
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

    logger.info('OTA: nouvelle version détectée: ' + remote.version)
    const z = await fetch(BUNDLE_URL + '?t=' + Date.now())
    if (!z.ok) {
      logger.error('Erreur téléchargement bundle: ' + z.status)
      return
    }

    // téléchargement (fallback simple)
    const arrayBuffer = await z.arrayBuffer()
    logger.info('Bundle téléchargé (' + arrayBuffer.byteLength + ' bytes). Extraction...')
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
        logger.info('Wrote ' + fullPath)
      })())
    })

    await Promise.all(writePromises)
    await Preferences.set({ key: 'appVersion', value: remote.version })
    logger.info('OTA: bundle appliqué localement (version=' + remote.version + ')')

    if (showPrompts) {
      if (confirm(`Nouvelle version (${remote.version}) téléchargée. Charger maintenant ?`)) {
        const ok = await injectLocalIndexIntoContainer()
        if (!ok) {
          logger.warn('inject failed — fallback to navigation')
          await loadLocalIndexIfPresent()
        }
      }
    } else {
      await injectLocalIndexIntoContainer()
    }
  } catch (err) {
    logger.error('checkForUpdates failed: ' + (err && err.message ? err.message : err))
  }
}
