// src/otaUpdater.js
// OTA updater (version corrigée) — atomic update with robust delete fallback & readdir handling

import JSZip from 'jszip'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Preferences } from '@capacitor/preferences'
import { Capacitor } from '@capacitor/core'
import logger from './logger'

/* ---------------- Config ---------------- */
const VERSION_URL = 'https://onyx-hue.github.io/my-app/version.json'
const BUNDLE_URL = 'https://onyx-hue.github.io/my-app/app.zip'

const LOCAL_WWW_DIR = 'www'
const TMP_WWW_DIR = 'www_tmp'
const BACKUP_WWW_DIR = 'www_backup'

const KEY_VERSION = 'appVersion'
const KEY_BUILD_ID = 'appBuildId'
const KEY_UPDATE_IN_PROGRESS = 'updateInProgress'

/* -------------- Helpers FS --------------- */
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
    // ignore if exists/permission
  }
}

/**
 * safeRm(path) :
 * - essaie Filesystem.rm si présent,
 * - sinon tente plusieurs méthodes alternatives exposées par le plugin,
 * - sinon effectue une suppression récursive manuelle via fallbackDeleteDir.
 */
async function safeRm(path) {
  // direct call if implemented
  try {
    if (typeof Filesystem.rm === 'function') {
      await Filesystem.rm({ path, directory: Directory.Data, recursive: true })
      return
    }
  } catch (e) {
    // si NotImplemented ou autre -> on passe au fallback
    logger.warn(`safeRm: Filesystem.rm failed: ${e && e.message ? e.message : e}`)
  }

  // Try some possible alternative method names that some Capacitor builds might expose
  const candidateFns = ['deleteFile', 'removeFile', 'unlink', 'rmdir', 'rmrf', 'remove'] // best-effort
  for (const fn of candidateFns) {
    try {
      if (typeof Filesystem[fn] === 'function') {
        // attempt to call with likely signatures
        try {
          // try recursive true
          await Filesystem[fn]({ path, directory: Directory.Data, recursive: true })
        } catch (_) {
          // fallback to non-recursive
          await Filesystem[fn]({ path, directory: Directory.Data })
        }
        return
      }
    } catch (e) {
      logger.warn(`safeRm: candidate ${fn} failed: ${e && e.message ? e.message : e}`)
    }
  }

  // Last resort: manual recursive delete by listing content and deleting files
  try {
    await fallbackDeleteDir(path)
    return
  } catch (e) {
    logger.warn('safeRm: fallbackDeleteDir failed: ' + (e && e.message ? e.message : e))
    throw e
  }
}

/**
 * fallbackDeleteDir(path) :
 * récursive : lit le dossier puis supprime fichier par fichier / dossier par dossier.
 * Gère le cas où readdir() renvoie des strings ou des objets { name, uri, ... }.
 */
async function fallbackDeleteDir(path) {
  logger.info('fallbackDeleteDir: ' + path)
  // list entries
  let list = { files: [] }
  try {
    list = await Filesystem.readdir({ path, directory: Directory.Data })
  } catch (e) {
    // if readdir fails because dir doesn't exist, nothing to do
    logger.warn('fallbackDeleteDir: readdir failed for ' + path + ' -> ' + (e && e.message ? e.message : e))
    throw e
  }

  const entries = list && list.files ? list.files : []

  for (const entry of entries) {
    // normalize name (entry can be string or object)
    let name
    if (typeof entry === 'string') name = entry
    else if (entry && typeof entry === 'object' && ('name' in entry)) name = entry.name
    else if (entry && typeof entry === 'object' && ('uri' in entry)) {
      // sometimes entry.uri contains path-like data; try to derive a name
      name = String(entry.uri).split('/').pop()
    } else {
      // fallback to string-conversion
      name = String(entry)
    }
    const childPath = path + '/' + name

    // try stat to know if directory
    let st = null
    try {
      st = await Filesystem.stat({ path: childPath, directory: Directory.Data })
    } catch (e) {
      // if stat fails, assume it's a file and try deletion
      st = null
    }

    if (st && st.type === 'directory') {
      // recursive
      await fallbackDeleteDir(childPath)
      // after children removed, try to remove the empty directory with safeRm on it (may be no-op)
      try { await safeRm(childPath) } catch (e) { /* ignore */ }
    } else {
      // try to remove file via available methods
      let deleted = false
      try {
        // attempt Filesystem.rm file
        if (typeof Filesystem.rm === 'function') {
          await Filesystem.rm({ path: childPath, directory: Directory.Data, recursive: false })
          deleted = true
        }
      } catch (e) { /* ignore */ }

      if (!deleted) {
        // try a set of alternative delete methods
        const alt = ['deleteFile', 'removeFile', 'unlink', 'remove']
        for (const fn of alt) {
          try {
            if (typeof Filesystem[fn] === 'function') {
              await Filesystem[fn]({ path: childPath, directory: Directory.Data })
              deleted = true
              break
            }
          } catch (e) {
            // continue trying other function names
          }
        }
      }

      if (!deleted) {
        // fallback: try to write empty file (overwrite), then rm the parent later
        try {
          await Filesystem.writeFile({ path: childPath, data: '', directory: Directory.Data })
          // attempt remove again
          try { await safeRm(childPath) } catch (_) {}
        } catch (e) {
          logger.warn('fallbackDeleteDir: unable to delete file ' + childPath + ' : ' + (e && e.message ? e.message : e))
        }
      }
    }
  }

  // finally attempt to remove the directory itself
  try {
    if (typeof Filesystem.rm === 'function') {
      await Filesystem.rm({ path, directory: Directory.Data, recursive: false })
    } else {
      // try candidate rmdir-like names
      const candidates = ['rmdir', 'removeDir', 'remove', 'deleteDir']
      for (const c of candidates) {
        if (typeof Filesystem[c] === 'function') {
          try { await Filesystem[c]({ path, directory: Directory.Data }) ; break } catch (e) {}
        }
      }
    }
  } catch (e) {
    // ignore not-critical
    logger.warn('fallbackDeleteDir: final removal of dir failed: ' + (e && e.message ? e.message : e))
  }
}

/* -------------- Copy Dir Helper --------------- */
/**
 * copyDir(src, dst)
 * - gère les entrées de readdir qui sont string ou objets
 * - lit file.data (base64) et écrit directement sur dst
 */
async function copyDir(src, dst) {
  logger.info(`copyDir: ${src} -> ${dst}`)
  await ensureDir(dst)

  let list = { files: [] }
  try {
    list = await Filesystem.readdir({ path: src, directory: Directory.Data })
  } catch (e) {
    logger.warn('copyDir: readdir failed for ' + src + ' : ' + (e && e.message ? e.message : e))
    throw e
  }

  const files = list && list.files ? list.files : []

  for (const ent of files) {
    let name
    if (typeof ent === 'string') name = ent
    else if (ent && typeof ent === 'object' && 'name' in ent) name = ent.name
    else name = String(ent)

    const srcPath = `${src}/${name}`
    const dstPath = `${dst}/${name}`

    // stat to check directory
    let stat = null
    try {
      stat = await Filesystem.stat({ path: srcPath, directory: Directory.Data })
    } catch (e) {
      stat = null
    }

    if (stat && stat.type === 'directory') {
      await copyDir(srcPath, dstPath)
    } else {
      try {
        const file = await Filesystem.readFile({ path: srcPath, directory: Directory.Data })
        const base64 = file && (file.data || file)
        const parent = dstPath.split('/').slice(0, -1).join('/')
        if (parent) await ensureDir(parent)
        await Filesystem.writeFile({ path: dstPath, data: base64, directory: Directory.Data })
      } catch (e) {
        logger.warn(`copyDir: error copying ${srcPath} -> ${dstPath} : ${e && e.message ? e.message : e}`)
        throw e
      }
    }
  }
}

/* ---------- Write zip -> dir ---------- */
async function writeZipToDir(zip, dir) {
  logger.info('writeZipToDir -> ' + dir)
  await ensureDir(dir)
  const tasks = []
  zip.forEach((relativePath, zipEntry) => {
    if (zipEntry.dir) return
    tasks.push((async () => {
      const fullPath = `${dir}/${relativePath}`
      const dirpath = fullPath.split('/').slice(0, -1).join('/')
      if (dirpath) await ensureDir(dirpath)
      const base64 = await zipEntry.async('base64')
      await Filesystem.writeFile({ path: fullPath, data: base64, directory: Directory.Data })
    })())
  })
  await Promise.all(tasks)
}

/* ---------- Injection (support dir param) ---------- */
export async function injectLocalIndexIntoContainer(containerId = 'localAppContainer', dir = LOCAL_WWW_DIR) {
  try {
    const idxPath = `${dir}/index.html`
    if (!(await fileExists(idxPath))) {
      logger.info('injectLocalIndex: index absent: ' + idxPath)
      return false
    }

    const file = await Filesystem.readFile({ path: idxPath, directory: Directory.Data })
    const b64 = file.data || file
    // base64 -> uint8array -> utf8 string
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const html = new TextDecoder('utf-8').decode(bytes)

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

    // inject head (link/style/meta)
    try {
      const temp = document.createElement('div')
      temp.innerHTML = doc.head.innerHTML
      Array.from(temp.children).forEach(node => {
        const tag = node.tagName && node.tagName.toLowerCase()
        if (['link', 'style', 'meta'].includes(tag)) {
          document.head.appendChild(node.cloneNode(true))
        }
      })
    } catch (e) {
      logger.warn('injectLocalIndex: error injecting head: ' + (e && e.message ? e.message : e))
    }

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
      } catch (e) { /* ignore individual script errors */ }
    }

    return true
  } catch (e) {
    logger.warn('injectLocalIndexIntoContainer failed: ' + (e && e.message ? e.message : e))
    return false
  }
}

/* --------- loadLocalIndexIfPresent (with recovery) --------- */
export async function loadLocalIndexIfPresent() {
  try {
    await recoverIfNeeded()
  } catch (e) {
    logger.warn('loadLocalIndexIfPresent: recoverIfNeeded error: ' + (e && e.message ? e.message : e))
  }

  const injected = await injectLocalIndexIntoContainer('localAppContainer', LOCAL_WWW_DIR)
  if (injected) {
    logger.info('loadLocalIndexIfPresent: injected local index (container)')
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
    logger.warn('loadLocalIndexIfPresent: fallback redirect failed: ' + (e && e.message ? e.message : e))
    return false
  }
}

/* ------------ clearLocalBundle (improved) ------------- */
export async function clearLocalBundle() {
  try {
    logger.info('clearLocalBundle: removing ' + LOCAL_WWW_DIR)
    try {
      await safeRm(LOCAL_WWW_DIR)
      logger.info('clearLocalBundle: safeRm OK')
    } catch (e) {
      logger.warn('clearLocalBundle: safeRm failed, attempting fallback per-file removal: ' + (e && e.message ? e.message : e))
      try {
        await fallbackDeleteDir(LOCAL_WWW_DIR)
      } catch (er) {
        logger.warn('clearLocalBundle: fallbackDeleteDir also failed: ' + (er && er.message ? er.message : er))
      }
    }
  } catch (e) {
    logger.warn('clearLocalBundle: error: ' + (e && e.message ? e.message : e))
  }

  try {
    await Preferences.set({ key: KEY_VERSION, value: '0.0.0' })
    await Preferences.remove({ key: KEY_BUILD_ID })
    await Preferences.remove({ key: KEY_UPDATE_IN_PROGRESS })
    logger.info('clearLocalBundle: preferences reset')
  } catch (e) {
    logger.warn('clearLocalBundle: unable to reset preferences: ' + (e && e.message ? e.message : e))
  }
}

/* ------------- Recovery -------------- */
async function recoverIfNeeded() {
  const backupExists = await fileExists(BACKUP_WWW_DIR)
  const wwwExists = await fileExists(LOCAL_WWW_DIR)

  // if an update flag is present, try to recover
  try {
    const inProg = await Preferences.get({ key: KEY_UPDATE_IN_PROGRESS })
    if (inProg && inProg.value) {
      logger.info('recoverIfNeeded: found updateInProgress flag, attempting recovery or cleanup')
      // if backup exists and www is missing -> restore
      if (backupExists && !wwwExists) {
        logger.info('recoverIfNeeded: restoring backup -> www')
        await copyDir(BACKUP_WWW_DIR, LOCAL_WWW_DIR)
        try { await safeRm(BACKUP_WWW_DIR) } catch (e) {}
      }
      await Preferences.remove({ key: KEY_UPDATE_IN_PROGRESS })
    }
  } catch (e) {
    logger.warn('recoverIfNeeded: error checking updateInProgress flag: ' + (e && e.message ? e.message : e))
  }

  // If backup exists and www is missing (no flag), still restore
  if (backupExists && !wwwExists) {
    logger.info('recoverIfNeeded: backup found and www missing -> restoring backup')
    await copyDir(BACKUP_WWW_DIR, LOCAL_WWW_DIR)
    try { await safeRm(BACKUP_WWW_DIR) } catch (e) {}
  }
}

/* ------------- Atomic update flow -------------- */
async function performAtomicUpdateFromZip(arrayBuffer) {
  try {
    logger.info('performAtomicUpdateFromZip: starting atomic update')
    // set flag
    await Preferences.set({ key: KEY_UPDATE_IN_PROGRESS, value: '1' })

    // cleanup tmp and backup
    try { await safeRm(TMP_WWW_DIR) } catch (e) {}
    try { await safeRm(BACKUP_WWW_DIR) } catch (e) {}

    // create backup if exists
    if (await fileExists(LOCAL_WWW_DIR)) {
      logger.info('performAtomicUpdateFromZip: creating backup from ' + LOCAL_WWW_DIR)
      await copyDir(LOCAL_WWW_DIR, BACKUP_WWW_DIR)
    }

    // extract zip into TMP_WWW_DIR
    logger.info('performAtomicUpdateFromZip: extracting zip into tmp dir')
    const zip = await JSZip.loadAsync(arrayBuffer)
    await writeZipToDir(zip, TMP_WWW_DIR)

    // test injection from tmp
    logger.info('performAtomicUpdateFromZip: testing injection from tmp dir')
    const injectedTmp = await injectLocalIndexIntoContainer('localAppContainer', TMP_WWW_DIR)
    if (!injectedTmp) {
      logger.warn('performAtomicUpdateFromZip: injection from tmp failed -> cleaning tmp and restoring (if backup)')
      try { await safeRm(TMP_WWW_DIR) } catch (e) {}
      if (await fileExists(BACKUP_WWW_DIR)) {
        await copyDir(BACKUP_WWW_DIR, LOCAL_WWW_DIR)
        try { await safeRm(BACKUP_WWW_DIR) } catch (e) {}
      }
      await Preferences.remove({ key: KEY_UPDATE_IN_PROGRESS })
      return false
    }

    // apply swap: remove old www, copy tmp -> www
    logger.info('performAtomicUpdateFromZip: applying swap (tmp -> www)')
    try { await safeRm(LOCAL_WWW_DIR) } catch (e) {}
    await copyDir(TMP_WWW_DIR, LOCAL_WWW_DIR)

    // cleanup tmp & backup
    try { await safeRm(TMP_WWW_DIR) } catch (e) {}
    try { await safeRm(BACKUP_WWW_DIR) } catch (e) {}

    // remove flag
    await Preferences.remove({ key: KEY_UPDATE_IN_PROGRESS })

    // re-inject from real LOCAL_WWW_DIR to set correct base URLs
    try {
      await injectLocalIndexIntoContainer('localAppContainer', LOCAL_WWW_DIR)
    } catch (e) { /* ignore */ }

    logger.info('performAtomicUpdateFromZip: success')
    return true
  } catch (e) {
    logger.error('performAtomicUpdateFromZip failed: ' + (e && e.message ? e.message : e))
    // try to restore from backup
    try {
      await safeRm(TMP_WWW_DIR)
      if (await fileExists(BACKUP_WWW_DIR)) {
        await safeRm(LOCAL_WWW_DIR)
        await copyDir(BACKUP_WWW_DIR, LOCAL_WWW_DIR)
        await safeRm(BACKUP_WWW_DIR)
      }
    } catch (er) {
      logger.warn('performAtomicUpdateFromZip: restore attempt failed: ' + (er && er.message ? er.message : er))
    }
    await Preferences.remove({ key: KEY_UPDATE_IN_PROGRESS })
    return false
  }
}

/* ------------- Check for updates -------------- */
export async function checkForUpdates(showPrompts = true) {
  try {
    logger.info('checkForUpdates: starting check...')

    const r = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' })
    if (!r.ok) {
      logger.warn('Impossible de récupérer version.json (status ' + r.status + ')')
      return
    }
    const remote = await r.json()

    const localVerPref = await Preferences.get({ key: KEY_VERSION })
    const localBuildPref = await Preferences.get({ key: KEY_BUILD_ID })

    const localVersion = localVerPref?.value || '0.0.0'
    const localBuildId = localBuildPref?.value || null

    logger.info(`Etat: Local[v=${localVersion}, id=${localBuildId}] / Remote[v=${remote.version}, id=${remote.buildId}]`)

    let updateAvailable = false
    if (remote.buildId) {
      if (remote.buildId !== localBuildId) {
        logger.info('OTA: Nouveau Build ID détecté !')
        updateAvailable = true
      } else {
        logger.info('OTA: Build ID identique.')
      }
    } else {
      if (localVersion !== remote.version) {
        logger.info('OTA: Nouvelle version (fallback version check)')
        updateAvailable = true
      }
    }

    if (!updateAvailable) return

    logger.info(`Téléchargement mise à jour... (v${remote.version} - Build ${remote.buildId})`)
    const z = await fetch(BUNDLE_URL + '?t=' + Date.now())
    if (!z.ok) {
      logger.error('Erreur téléchargement bundle: ' + z.status)
      return
    }

    const arrayBuffer = await z.arrayBuffer()
    logger.info('Bundle téléchargé. Appel performAtomicUpdateFromZip()')
    const ok = await performAtomicUpdateFromZip(arrayBuffer)

    if (!ok) {
      logger.warn('OTA: mise à jour échouée (performAtomicUpdateFromZip)')
      return
    }

    // save prefs
    await Preferences.set({ key: KEY_VERSION, value: remote.version })
    if (remote.buildId) {
      await Preferences.set({ key: KEY_BUILD_ID, value: String(remote.buildId) })
    }

    logger.info('OTA: Mise à jour appliquée avec succès.')

    if (showPrompts) {
      try {
        if (confirm(`Mise à jour disponible (Build du ${remote.buildId ? new Date(parseInt(remote.buildId) * 1000).toLocaleString() : remote.version}). Charger ?`)) {
          const injected = await injectLocalIndexIntoContainer('localAppContainer', LOCAL_WWW_DIR)
          if (!injected) {
            window.location.reload()
          }
        }
      } catch (e) { /* ignore */ }
    } else {
      await injectLocalIndexIntoContainer('localAppContainer', LOCAL_WWW_DIR)
    }
  } catch (err) {
    logger.error('checkForUpdates failed: ' + (err && err.message ? err.message : err))
  }
}
