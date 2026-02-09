// src/otaUpdater.js
import JSZip from 'jszip'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Preferences } from '@capacitor/preferences'
import { Capacitor } from '@capacitor/core'
import logger from './logger'

const VERSION_URL = 'https://onyx-hue.github.io/my-app/version.json'
const BUNDLE_URL = 'https://onyx-hue.github.io/my-app/app.zip'
const LOCAL_WWW_DIR = 'www'
const STAGING_DIR = 'staging_www'
const PENDING_ZIP = 'pending_update.zip'
const STAGING_MANIFEST = 'staging_manifest.json'

// Clés de stockage
const KEY_VERSION = 'appVersion'
const KEY_BUILD_ID = 'appBuildId' // build appliqué
const KEY_PENDING_VERSION = 'pendingVersion'
const KEY_PENDING_BUILD_ID = 'pendingBuildId'

// --- helpers ---
async function fileExists(path, directory = Directory.Data) {
  try {
    await Filesystem.stat({ path, directory })
    return true
  } catch (e) {
    return false
  }
}

async function ensureDir(path, directory = Directory.Data) {
  try {
    await Filesystem.mkdir({ path, directory, recursive: true })
  } catch (e) {
    // ignore if exists
  }
}

async function safeReaddir(path, directory = Directory.Data) {
  try {
    const res = await Filesystem.readdir({ path, directory })
    // Normalise shape: if res.files exists, return it; otherwise try to parse.
    if (res && res.files) return res.files
    if (Array.isArray(res)) return res
    return []
  } catch (e) {
    return []
  }
}

async function removeDirRecursive(path, directory = Directory.Data) {
  // Try rm recursive first
  try {
    await Filesystem.rm({ path, directory, recursive: true })
    return
  } catch (e) {
    // fallback: list files and remove file-by-file
  }
  const list = await safeReaddir(path, directory)
  for (const f of list) {
    const candidate = `${path}/${f}`
    try {
      await Filesystem.rm({ path: candidate, directory, recursive: true })
    } catch (_) {
      // ignore
    }
  }
  try { await Filesystem.rm({ path, directory, recursive: true }) } catch (_) {}
}

// convert arrayBuffer -> base64
function arrayBufferToBase64(buffer) {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

// convert base64 -> ArrayBuffer
function base64ToArrayBuffer(base64) {
  const binary_string = atob(base64)
  const len = binary_string.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i)
  }
  return bytes.buffer
}

// write a base64 string to a path
async function writeBase64File(path, base64, directory = Directory.Data) {
  await ensureDir(path.split('/').slice(0, -1).join('/') || '', directory)
  await Filesystem.writeFile({ path, data: base64, directory })
}

// read file and return base64 string (Filesystem.readFile returns .data)
async function readFileAsBase64(path, directory = Directory.Data) {
  const res = await Filesystem.readFile({ path, directory })
  return res && res.data ? res.data : res
}

// --- clearLocalBundle (modifié : ne supprime plus forcément pending metadata) ---
export async function clearLocalBundle() {
  try {
    logger.info('clearLocalBundle: removing ' + LOCAL_WWW_DIR)
    try {
      await Filesystem.rm({ path: LOCAL_WWW_DIR, directory: Directory.Data, recursive: true })
      logger.info('clearLocalBundle: Filesystem.rm OK')
    } catch (e) {
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

  // Reset applied preferences
  try {
    await Preferences.set({ key: KEY_VERSION, value: '0.0.0' })
    await Preferences.remove({ key: KEY_BUILD_ID })
    logger.info('clearLocalBundle: preferences reset')
  } catch (e) {
    logger.warn('clearLocalBundle: unable to reset preferences: ' + e)
  }
}

// --- Inject local index into container (ta version inchangée mais incluse pour complétude) ---
export async function injectLocalIndexIntoContainer(containerId = 'localAppContainer') {
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

// --- loadLocalIndexIfPresent (modifié pour tenter injection) ---
export async function loadLocalIndexIfPresent() {
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

// --- applyPendingUpdateIfPresent ---
// If there is a pending zip (PENDING_ZIP), unzip it into a staging folder, then replace LOCAL_WWW_DIR atomically (as much as possible)
// pending metadata (version/buildId) is expected to be saved previously under pending keys.
export async function applyPendingUpdateIfPresent() {
  try {
    const exists = await fileExists(PENDING_ZIP)
    if (!exists) {
      logger.info('applyPendingUpdateIfPresent: no pending zip')
      return false
    }
    logger.info('applyPendingUpdateIfPresent: found pending zip, applying...')

    // 1) Read pending zip (base64) and unzip into STAGING_DIR, saving manifest
    const base64zip = await readFileAsBase64(PENDING_ZIP)
    const zipBuffer = base64ToArrayBuffer(base64zip)
    const zip = await JSZip.loadAsync(zipBuffer)

    // clear staging dir first
    await removeDirRecursive(STAGING_DIR)

    const manifest = []
    const writePromises = []
    zip.forEach((relativePath, zipEntry) => {
      if (zipEntry.dir) return
      writePromises.push((async () => {
        const fullPath = `${STAGING_DIR}/${relativePath}`
        const dir = fullPath.split('/').slice(0, -1).join('/')
        if (dir) await ensureDir(dir)
        const fileBase64 = await zipEntry.async('base64')
        await Filesystem.writeFile({
          path: fullPath,
          data: fileBase64,
          directory: Directory.Data
        })
        manifest.push(relativePath)
      })())
    })
    await Promise.all(writePromises)

    // Save manifest (so we can move files deterministically)
    await Filesystem.writeFile({ path: STAGING_MANIFEST, data: btoa(JSON.stringify(manifest)), directory: Directory.Data })

    // 2) Replace LOCAL_WWW_DIR with staging contents
    // Remove current www (but do NOT reset preferences here)
    await removeDirRecursive(LOCAL_WWW_DIR)

    // Read manifest and copy files from staging -> www
    const manifestB64 = await readFileAsBase64(STAGING_MANIFEST)
    const manifestJson = JSON.parse(atob(manifestB64))
    const copyPromises = []
    for (const rel of manifestJson) {
      copyPromises.push((async () => {
        const stagingPath = `${STAGING_DIR}/${rel}`
        const targetPath = `${LOCAL_WWW_DIR}/${rel}`
        // Ensure directory exists
        const dir = targetPath.split('/').slice(0, -1).join('/')
        if (dir) await ensureDir(dir)
        const fBase64 = await readFileAsBase64(stagingPath)
        await Filesystem.writeFile({ path: targetPath, data: fBase64, directory: Directory.Data })
      })())
    }
    await Promise.all(copyPromises)

    // 3) Cleanup staging and pending zip
    await removeDirRecursive(STAGING_DIR)
    try { await Filesystem.rm({ path: PENDING_ZIP, directory: Directory.Data }) } catch (_) {}
    try { await Filesystem.rm({ path: STAGING_MANIFEST, directory: Directory.Data }) } catch (_) {}

    // 4) Promote pending metadata -> applied metadata
    try {
      const pendingVer = (await Preferences.get({ key: KEY_PENDING_VERSION }))?.value
      const pendingBuild = (await Preferences.get({ key: KEY_PENDING_BUILD_ID }))?.value
      if (pendingVer) await Preferences.set({ key: KEY_VERSION, value: pendingVer })
      if (pendingBuild) await Preferences.set({ key: KEY_BUILD_ID, value: pendingBuild })
      // cleanup pending keys
      await Preferences.remove({ key: KEY_PENDING_VERSION })
      await Preferences.remove({ key: KEY_PENDING_BUILD_ID })
    } catch (e) {
      logger.warn('applyPendingUpdateIfPresent: error promoting prefs: ' + e)
    }

    // 5) inject
    const injected = await injectLocalIndexIntoContainer()
    if (injected) logger.info('applyPendingUpdateIfPresent: applied & injected')
    else logger.info('applyPendingUpdateIfPresent: applied but injection failed (will fallback to full reload on next step)')
    return true
  } catch (e) {
    logger.error('applyPendingUpdateIfPresent failed: ' + (e && e.message ? e.message : e))
    return false
  }
}

// --- checkForUpdates ---
// Behavior:
// - fetch version.json remote
// - if remote buildId differs from saved applied buildId => download remote app.zip and save to PENDING_ZIP (do NOT apply immediately)
// - if showPrompts === true, after download propose to apply now (prompt user) — if user accepts, apply immediately
export async function checkForUpdates(showPrompts = true) {
  try {
    logger.info('checkForUpdates: starting check...')

    // 1. Récupérer version.json distant
    const r = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' })
    if (!r.ok) {
      logger.warn('Impossible de récupérer version.json (status ' + r.status + ')')
      return
    }
    const remote = await r.json()
    // Ex: { version: "0.0.2", buildId: "1739850000" }

    // 2. Récupérer infos locales appliquées
    const localVerPref = await Preferences.get({ key: KEY_VERSION })
    const localBuildPref = await Preferences.get({ key: KEY_BUILD_ID })
    const localVersion = localVerPref?.value || '0.0.0'
    const localBuildId = localBuildPref?.value || null

    logger.info(`Etat: Local[v=${localVersion}, id=${localBuildId}] / Remote[v=${remote.version}, id=${remote.buildId}]`)

    // 3. Determine update
    let updateAvailable = false
    if (remote.buildId) {
      if (remote.buildId !== localBuildId) updateAvailable = true
    } else {
      if (localVersion !== remote.version) updateAvailable = true
    }
    if (!updateAvailable) {
      logger.info('checkForUpdates: pas de nouvelle mise à jour')
      return
    }

    // 4. Download bundle, but write to a pending zip (do NOT apply immediately)
    logger.info(`checkForUpdates: téléchargement de ${BUNDLE_URL} en attente (build ${remote.buildId})`)
    const z = await fetch(BUNDLE_URL + '?t=' + Date.now())
    if (!z.ok) {
      logger.error('Erreur téléchargement bundle: ' + z.status)
      return
    }
    const arrayBuffer = await z.arrayBuffer()
    const base64 = arrayBufferToBase64(arrayBuffer)

    // Save as pending_update.zip (atomic from our POV: write once)
    await Filesystem.writeFile({
      path: PENDING_ZIP,
      data: base64,
      directory: Directory.Data
    })

    // Save pending metadata
    if (remote.version) await Preferences.set({ key: KEY_PENDING_VERSION, value: remote.version })
    if (remote.buildId) await Preferences.set({ key: KEY_PENDING_BUILD_ID, value: String(remote.buildId) })

    logger.info('checkForUpdates: bundle téléchargé et stocké en pending.')

    if (showPrompts) {
      // Proposer d'appliquer maintenant
      if (confirm(`Mise à jour disponible (Build ${remote.buildId || remote.version}). Appliquer maintenant ?`)) {
        // apply immediately
        const ok = await applyPendingUpdateIfPresent()
        if (!ok) {
          // fallback full reload
          window.location.reload()
        }
      } else {
        logger.info('checkForUpdates: utilisateur a choisi d\'appliquer la mise à jour plus tard.')
      }
    } else {
      // silent download, will be applied at next launch by applyPendingUpdateIfPresent()
      logger.info('checkForUpdates: téléchargement silencieux complété; appliquera au prochain lancement.')
    }
  } catch (err) {
    logger.error('checkForUpdates failed: ' + (err && err.message ? err.message : err))
  }
}
