// src/otaUpdater.js
import JSZip from 'jszip'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Preferences } from '@capacitor/preferences'
import { Capacitor } from '@capacitor/core'
import logger from './logger'

const VERSION_URL = 'https://onyx-hue.github.io/my-app/version.json'
const BUNDLE_URL = 'https://onyx-hue.github.io/my-app/app.zip'
const LOCAL_WWW_DIR = 'www'

// Clés de stockage
const KEY_VERSION = 'appVersion'
const KEY_BUILD_ID = 'appBuildId' // Nouvelle clé pour le timestamp

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
      // Fallback suppression fichier par fichier... (inchangé)
      logger.warn('clearLocalBundle: rm fallback...')
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

  // Reset des préférences
  try {
    await Preferences.set({ key: KEY_VERSION, value: '0.0.0' })
    await Preferences.remove({ key: KEY_BUILD_ID }) // On supprime l'ID de build
    logger.info('clearLocalBundle: preferences reset')
  } catch (e) {
    logger.warn('clearLocalBundle: unable to reset preferences: ' + e)
  }
}

// ... (Gardez la fonction injectLocalIndexIntoContainer telle quelle, elle ne change pas) ...
export async function injectLocalIndexIntoContainer(containerId = 'localAppContainer') {
  // CODE INCHANGÉ POUR CETTE FONCTION (copie-colle ton code existant ici)
  // Pour la réponse, je ne le répète pas pour gagner de la place,
  // mais garde bien tout le bloc "injectLocalIndexIntoContainer" original.
  try {
    const idxPath = `${LOCAL_WWW_DIR}/index.html`
    if (!(await fileExists(idxPath))) {
      logger.info('injectLocalIndex: index absent: ' + idxPath)
      return false
    }
    const file = await Filesystem.readFile({ path: idxPath, directory: Directory.Data })
    const html = atob(file.data || file)
    const uriResult = await Filesystem.getUri({ directory: Directory.Data, path: idxPath })
    const fileUri = uriResult.uri || uriResult
    const webFriendly = Capacitor.convertFileSrc(fileUri)
    const baseUrl = webFriendly.replace(/index\.html?$/i, '')
    
    // ... suite de ta logique d'injection ...
    // (Je remets juste le bloc minimal pour que le code soit valide si tu copies tout)
    const container = document.getElementById(containerId)
    if (!container) return false
    
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    let baseTag = doc.querySelector('base')
    if (!baseTag) {
      baseTag = doc.createElement('base')
      doc.head.insertBefore(baseTag, doc.head.firstChild)
    }
    baseTag.setAttribute('href', baseUrl)
    
    // Injection Head
    try {
        const temp = document.createElement('div')
        temp.innerHTML = doc.head.innerHTML
        Array.from(temp.children).forEach(node => {
            const tag = node.tagName && node.tagName.toLowerCase()
            if (['link', 'style', 'meta'].includes(tag)) {
                document.head.appendChild(node.cloneNode(true))
            }
        })
    } catch(e) {}

    container.innerHTML = doc.body.innerHTML

    const scripts = Array.from(doc.querySelectorAll('script'))
    for (const s of scripts) {
       // ... ta logique de script ...
        try {
        const newScript = document.createElement('script')
        const copyAttr = (name) => { if (s.hasAttribute && s.hasAttribute(name)) newScript.setAttribute(name, s.getAttribute(name)) }
        copyAttr('type'); copyAttr('nomodule'); copyAttr('defer'); copyAttr('async'); copyAttr('crossorigin'); copyAttr('integrity');
        const inlineText = s.textContent || ''
        const looksLikeModule = (s.getAttribute && s.getAttribute('type') === 'module') || /(^|\n|\s)import\s+|import\(|import\.meta/.test(inlineText)
        if (s.src) {
            let src = s.getAttribute('src')
            try { src = new URL(src, baseUrl).toString() } catch (e) {}
            newScript.src = src
            if (looksLikeModule) newScript.type = 'module'
            newScript.async = false
            container.appendChild(newScript)
        } else {
            if (looksLikeModule) newScript.type = 'module'
            newScript.text = inlineText
            container.appendChild(newScript)
        }
      } catch (e) {}
    }
    return true
  } catch(e) { return false }
}

export async function loadLocalIndexIfPresent() {
  // CODE INCHANGÉ
  const injected = await injectLocalIndexIntoContainer()
  if (injected) {
    logger.info('loadLocalIndexIfPresent: injected local index')
    return true
  }
  try {
    const idxPath = `${LOCAL_WWW_DIR}/index.html`
    if (!(await fileExists(idxPath))) return false
    const uriResult = await Filesystem.getUri({ directory: Directory.Data, path: idxPath })
    const fileUri = uriResult.uri || uriResult
    const webFriendly = Capacitor.convertFileSrc(fileUri)
    window.location.href = webFriendly
    return true
  } catch (e) {
    return false
  }
}

// ---------- C'EST ICI QUE CA CHANGE ----------

export async function checkForUpdates(showPrompts = true) {
  try {
    logger.info('checkForUpdates: starting check...')
    
    // 1. Récupérer le version.json distant
    const r = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' })
    if (!r.ok) {
      logger.warn('Impossible de récupérer version.json (status ' + r.status + ')')
      return
    }
    const remote = await r.json() 
    // remote ressemble maintenant à : { version: "0.0.2", buildId: "1739850000" }

    // 2. Récupérer les infos locales
    const localVerPref = await Preferences.get({ key: KEY_VERSION })
    const localBuildPref = await Preferences.get({ key: KEY_BUILD_ID })
    
    const localVersion = localVerPref?.value || '0.0.0'
    const localBuildId = localBuildPref?.value || null

    logger.info(`Etat: Local[v=${localVersion}, id=${localBuildId}] / Remote[v=${remote.version}, id=${remote.buildId}]`)

    // 3. Comparaison basée sur le buildId (si disponible) OU la version
    let updateAvailable = false

    if (remote.buildId) {
        // Si le serveur a un buildId, on l'utilise comme source de vérité absolue
        if (remote.buildId !== localBuildId) {
            logger.info('OTA: Nouveau Build ID détecté !')
            updateAvailable = true
        } else {
            logger.info('OTA: Build ID identique.')
        }
    } else {
        // Fallback ancienne méthode (si tu oublies de mettre à jour le workflow)
        if (localVersion !== remote.version) {
            logger.info('OTA: Nouvelle version (fallback version check)')
            updateAvailable = true
        }
    }

    if (!updateAvailable) return

    // 4. Téléchargement
    logger.info(`Téléchargement mise à jour... (v${remote.version} - Build ${remote.buildId})`)
    const z = await fetch(BUNDLE_URL + '?t=' + Date.now())
    if (!z.ok) {
      logger.error('Erreur téléchargement bundle: ' + z.status)
      return
    }

    const arrayBuffer = await z.arrayBuffer()
    logger.info('Bundle téléchargé. Extraction...')
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
      })())
    })

    await Promise.all(writePromises)

    // 5. Sauvegarde des nouvelles métadonnées
    await Preferences.set({ key: KEY_VERSION, value: remote.version })
    if (remote.buildId) {
        await Preferences.set({ key: KEY_BUILD_ID, value: String(remote.buildId) })
    }

    logger.info('OTA: Mise à jour appliquée.')

    if (showPrompts) {
      if (confirm(`Mise à jour disponible (Build du ${new Date(parseInt(remote.buildId)*1000).toLocaleString()}). Charger ?`)) {
        const ok = await injectLocalIndexIntoContainer()
        if (!ok) {
          window.location.reload() // Fallback reload complet
        }
      }
    } else {
      await injectLocalIndexIntoContainer()
    }
  } catch (err) {
    logger.error('checkForUpdates failed: ' + (err && err.message ? err.message : err))
  }
}