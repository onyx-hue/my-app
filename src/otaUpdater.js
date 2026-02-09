// src/otaUpdater.js
// OTA helper — injection améliorée (préserve les attributs des <script> et supporte les modules)
// URLs configurées pour ton repo
import JSZip from 'jszip'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Preferences } from '@capacitor/preferences'
import { Capacitor } from '@capacitor/core'
import logger from './logger'

const VERSION_URL = 'https://onyx-hue.github.io/my-app/version.json'
const BUNDLE_URL = 'https://onyx-hue.github.io/my-app/app.zip'
const LOCAL_WWW_DIR = 'www'

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

export async function clearLocalBundle() {
  try {
    logger.info('clearLocalBundle: removing ' + LOCAL_WWW_DIR)
    try {
      await Filesystem.rm({ path: LOCAL_WWW_DIR, directory: Directory.Data, recursive: true })
      logger.info('clearLocalBundle: Filesystem.rm OK')
    } catch (e) {
      logger.warn('clearLocalBundle: rm fallback, error: ' + (e && e.message ? e.message : e))
      // best-effort fallback: try readdir + rm each
      const list = await Filesystem.readdir({ path: LOCAL_WWW_DIR, directory: Directory.Data }).catch(() => ({ files: [] }))
      if (list && list.files) {
        for (const f of list.files) {
          try { await Filesystem.rm({ path: `${LOCAL_WWW_DIR}/${f}`, directory: Directory.Data, recursive: true }) } catch (_) {}
        }
      }
      try { await Filesystem.rm({ path: LOCAL_WWW_DIR, directory: Directory.Data, recursive: true }) } catch (_) {}
    }
  } catch (e) {
    logger.warn('clearLocalBundle: error: ' + (e && e.message ? e.message : e))
  }

  try {
    await Preferences.set({ key: 'appVersion', value: '0.0.0' })
    logger.info('clearLocalBundle: appVersion reset to 0.0.0')
  } catch (e) {
    logger.warn('clearLocalBundle: unable to reset appVersion: ' + (e && e.message ? e.message : e))
  }
}

// ---------- injection du HTML local dans le container (préserve attributes, gère modules) ----------
export async function injectLocalIndexIntoContainer(containerId = 'localAppContainer') {
  try {
    const idxPath = `${LOCAL_WWW_DIR}/index.html`
    if (!(await fileExists(idxPath))) {
      logger.info('injectLocalIndex: index absent: ' + idxPath)
      return false
    }

    const file = await Filesystem.readFile({ path: idxPath, directory: Directory.Data })
    const html = atob(file.data || file) // decode base64 to string
    const uriResult = await Filesystem.getUri({ directory: Directory.Data, path: idxPath })
    const fileUri = uriResult.uri || uriResult
    const webFriendly = Capacitor.convertFileSrc(fileUri)
    const baseUrl = webFriendly.replace(/index\.html?$/i, '')

    logger.info('injectLocalIndex: baseUrl=' + baseUrl)

    const container = document.getElementById(containerId)
    if (!container) {
      logger.warn('injectLocalIndex: container not found: ' + containerId)
      return false
    }

    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')

    // ensure base tag so relative URLs resolve to local files
    let baseTag = doc.querySelector('base')
    if (!baseTag) {
      baseTag = doc.createElement('base')
      doc.head.insertBefore(baseTag, doc.head.firstChild)
    }
    baseTag.setAttribute('href', baseUrl)

    // inject link/style/meta tags into current head (non-destructive)
    try {
      const temp = document.createElement('div')
      temp.innerHTML = doc.head.innerHTML
      Array.from(temp.children).forEach(node => {
        const tag = node.tagName && node.tagName.toLowerCase()
        if (['link', 'style', 'meta'].includes(tag)) {
          // avoid duplicating identical tags too aggressively; simple clone is OK for debug
          document.head.appendChild(node.cloneNode(true))
        }
      })
    } catch (e) {
      logger.warn('injectLocalIndex: error injecting head tags: ' + (e && e.message ? e.message : e))
    }

    // set body content
    container.innerHTML = doc.body.innerHTML

    // find scripts in the parsed doc and re-create them preserving attributes
    const scripts = Array.from(doc.querySelectorAll('script'))
    for (const s of scripts) {
      try {
        const newScript = document.createElement('script')

        // copy common attributes if present
        const copyAttr = (name) => {
          if (s.hasAttribute && s.hasAttribute(name)) {
            newScript.setAttribute(name, s.getAttribute(name))
          }
        }
        copyAttr('type')
        copyAttr('nomodule')
        copyAttr('defer')
        copyAttr('async')
        copyAttr('crossorigin')
        copyAttr('integrity')

        // determine if script should be module:
        // If original had type="module" OR inline contains import / import.meta => module
        const inlineText = s.textContent || ''
        const looksLikeModule = (s.getAttribute && s.getAttribute('type') === 'module') ||
                                /(^|\n|\s)import\s+|import\(|import\.meta/.test(inlineText)

        if (s.src) {
          // external script: resolve relative to baseUrl and set type appropriately
          let src = s.getAttribute('src')
          try { src = new URL(src, baseUrl).toString() } catch (e) {}
          newScript.src = src
          if (looksLikeModule) newScript.type = 'module'
          newScript.async = false // keep order
          // attach and wait for load or error to detect broken scripts
          container.appendChild(newScript)
          logger.info('Injected external script: ' + src + (looksLikeModule ? ' (module)' : ''))
          await new Promise((res, rej) => {
            newScript.onload = () => res(true)
            newScript.onerror = (ev) => rej(new Error('Script load failed: ' + src))
          })
        } else {
          // inline script
          if (looksLikeModule) newScript.type = 'module'
          try {
            newScript.text = inlineText
            container.appendChild(newScript)
          } catch (e) {
            logger.warn('injectLocalIndex: failed to append inline script, attempting execution via eval')
            try { eval(inlineText) } catch (ee) { logger.error('eval inline script failed: ' + ee) }
          }
        }
      } catch (e) {
        logger.error('injectLocalIndex: script injection error: ' + (e && e.message ? e.message : e))
        // abort injection on critical script error
        return false
      }
    }

    logger.info('injectLocalIndex: injection succeeded')
    return true
  } catch (e) {
    logger.error('injectLocalIndex failed: ' + (e && e.message ? e.message : e))
    return false
  }
}

export async function loadLocalIndexIfPresent() {
  // try injection first to keep UI
  const injected = await injectLocalIndexIntoContainer()
  if (injected) {
    logger.info('loadLocalIndexIfPresent: injected local index')
    return true
  }

  // fallback navigation to local file (older method)
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

export async function checkForUpdates(showPrompts = false) {
  try {
    logger.info('checkForUpdates: starting check...')
    
    // 1. Vérifier la version distante
    const r = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' })
    if (!r.ok) return logger.warn('Check failed: version.json status ' + r.status)
    
    const remote = await r.json()
    const local = await Preferences.get({ key: 'appVersion' })
    const localVersion = local?.value || '0.0.0'

    logger.info(`Version: Local=${localVersion} / Remote=${remote.version}`)

    if (localVersion === remote.version) {
      logger.info('App déjà à jour.')
      return
    }

    // 2. Télécharger le ZIP
    logger.info(`Téléchargement update ${remote.version}...`)
    const z = await fetch(BUNDLE_URL + '?t=' + Date.now())
    if (!z.ok) return logger.error('Download failed: ' + z.status)

    const arrayBuffer = await z.arrayBuffer()
    const zip = await JSZip.loadAsync(arrayBuffer)

    // 3. IMPORTANT : Nettoyer l'ancienne version locale avant d'écrire la nouvelle
    // On appelle ta fonction existante pour faire place nette
    await clearLocalBundle() 
    logger.info('Ancienne version supprimée. Installation de la nouvelle...')

    // 4. Écrire les nouveaux fichiers
    const writePromises = []
    zip.forEach((relativePath, zipEntry) => {
      if (zipEntry.dir) return
      writePromises.push((async () => {
        const fullPath = `${LOCAL_WWW_DIR}/${relativePath}`
        const dir = fullPath.split('/').slice(0, -1).join('/')
        if (dir) await ensureDir(dir)
        
        // On utilise uint8array pour éviter les soucis de mémoire avec base64 sur gros fichiers si possible
        // Mais gardons ta méthode base64 qui semble fonctionner pour toi :
        const base64 = await zipEntry.async('base64')
        await Filesystem.writeFile({
          path: fullPath,
          data: base64,
          directory: Directory.Data
        })
      })())
    })

    await Promise.all(writePromises)
    
    // 5. Mettre à jour le numéro de version
    await Preferences.set({ key: 'appVersion', value: remote.version })
    logger.info(`Mise à jour ${remote.version} installée avec succès ! Elle sera active au prochain démarrage.`)

    // Optionnel : Si on veut forcer le rechargement immédiat (attention ça peut couper l'utilisateur)
    if (showPrompts) {
       if (confirm(`Mise à jour ${remote.version} installée. Redémarrer maintenant ?`)) {
          window.location.reload()
       }
    }

  } catch (err) {
    logger.error('checkForUpdates failed: ' + (err && err.message ? err.message : err))
  }
}