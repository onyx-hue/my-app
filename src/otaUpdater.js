// src/otaUpdater.js
// OTA updater avec stratégie "backup -> tmp -> swap -> cleanup" (échange atomique)
// Remplace entièrement le fichier précédent.

import JSZip from 'jszip'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Preferences } from '@capacitor/preferences'
import { Capacitor } from '@capacitor/core'
import logger from './logger'

/**
 * Config
 */
const VERSION_URL = 'https://onyx-hue.github.io/my-app/version.json'
const BUNDLE_URL = 'https://onyx-hue.github.io/my-app/app.zip'

const LOCAL_WWW_DIR = 'www'
const TMP_WWW_DIR = 'www_tmp'
const BACKUP_WWW_DIR = 'www_backup'

const KEY_VERSION = 'appVersion'
const KEY_BUILD_ID = 'appBuildId' // timestamp / build id

/**
 * Helpers Filesystem
 */
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
  } catch (e) { /* ignore if exists */ }
}

async function removeDirIfExists(path) {
  try {
    if (await fileExists(path)) {
      await Filesystem.rm({ path, directory: Directory.Data, recursive: true })
    }
  } catch (e) {
    logger.warn('removeDirIfExists error: ' + (e && e.message ? e.message : e))
  }
}

/**
 * Copie récursive d'un dossier dans un autre (lecture base64 -> écriture base64).
 * Note: copie fichier par fichier via readFile/writeFile.
 */
async function copyDir(src, dst) {
  logger.info(`copyDir: ${src} -> ${dst}`)
  // ensure dst exists
  await ensureDir(dst)

  const list = await Filesystem.readdir({ path: src, directory: Directory.Data }).catch(() => ({ files: [] }))
  const files = list && list.files ? list.files : []

  for (const name of files) {
    const srcPath = `${src}/${name}`
    const dstPath = `${dst}/${name}`

    // heuristique : essayer stat pour savoir si dossier
    let stat = null
    try {
      stat = await Filesystem.stat({ path: srcPath, directory: Directory.Data })
    } catch (e) {
      stat = null
    }

    if (stat && stat.type === 'directory') {
      await copyDir(srcPath, dstPath)
    } else if (name.endsWith('/')) {
      // defensive: skip
      continue
    } else {
      try {
        const file = await Filesystem.readFile({ path: srcPath, directory: Directory.Data })
        // file.data est base64 (selon ton usage existant)
        await ensureDir(dst) // ensure parent
        await Filesystem.writeFile({ path: dstPath, data: file.data, directory: Directory.Data })
      } catch (e) {
        logger.warn(`copyDir: erreur fichier ${srcPath} -> ${dstPath}: ${e && e.message ? e.message : e}`)
        throw e
      }
    }
  }
}

/**
 * Écrit le contenu d'un JSZip dans un dossier spécifique (base64)
 * zip: instance JSZip
 * dir: target directory (ex: TMP_WWW_DIR)
 */
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

/**
 * injectLocalIndexIntoContainer adapté pour accepter un dossier arbitraire (dir param)
 * Par défaut dir = LOCAL_WWW_DIR (comportement ancien)
 */
export async function injectLocalIndexIntoContainer(containerId = 'localAppContainer', dir = LOCAL_WWW_DIR) {
  try {
    const idxPath = `${dir}/index.html`
    if (!(await fileExists(idxPath))) {
      logger.info('injectLocalIndex: index absent: ' + idxPath)
      return false
    }

    const file = await Filesystem.readFile({ path: idxPath, directory: Directory.Data })
    // file.data est base64 => décoder proprement en UTF-8
    const b64 = file.data || file
    // Base64 -> Uint8Array -> string UTF-8
    const binaryString = atob(b64)
    const len = binaryString.length
    const bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i)
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

    // Injection Head (link, meta, style)
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

    // Remplacer le body
    container.innerHTML = doc.body.innerHTML

    // Recréation contrôlée des scripts
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
          try { src = new URL(src, baseUrl).toString() } catch (e) { /* keep as-is */ }
          newScript.src = src
          if (looksLikeModule) newScript.type = 'module'
          newScript.async = false
          container.appendChild(newScript)
        } else {
          if (looksLikeModule) newScript.type = 'module'
          newScript.text = inlineText
          container.appendChild(newScript)
        }
      } catch (e) {
        // ignore script errors to avoid plantage complet
      }
    }

    return true
  } catch (e) {
    logger.warn('injectLocalIndexIntoContainer failed: ' + (e && e.message ? e.message : e))
    return false
  }
}

/**
 * loadLocalIndexIfPresent : essaie l'injection depuis LOCAL_WWW_DIR,
 * sinon tente le redirect classique. On effectue aussi une récupération si backup existant.
 */
export async function loadLocalIndexIfPresent() {
  // recovery step: si backup existe et www absent -> restore
  try {
    await recoverIfNeeded()
  } catch (e) {
    logger.warn('loadLocalIndexIfPresent: recoverIfNeeded error: ' + (e && e.message ? e.message : e))
  }

  // Try inject first
  const injected = await injectLocalIndexIntoContainer('localAppContainer', LOCAL_WWW_DIR)
  if (injected) {
    logger.info('loadLocalIndexIfPresent: injected local index (container)')
    return true
  }

  // fallback : redirect to local index file
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

/**
 * Nettoyage complet du bundle local (identique à ton code)
 */
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

  // Reset prefs
  try {
    await Preferences.set({ key: KEY_VERSION, value: '0.0.0' })
    await Preferences.remove({ key: KEY_BUILD_ID })
    logger.info('clearLocalBundle: preferences reset')
  } catch (e) {
    logger.warn('clearLocalBundle: unable to reset preferences: ' + (e && e.message ? e.message : e))
  }
}

/**
 * Recovery au démarrage si un backup est présent mais le www est absent/corrompu.
 * Comportement :
 *  - si BACKUP_WWW_DIR existe et LOCAL_WWW_DIR absent => restore (copy backup -> www), supprimer backup
 *  - si BACKUP_WWW_DIR existe et LOCAL_WWW_DIR existe => on conserve le backup (optionnel: supprimer)
 */
async function recoverIfNeeded() {
  const backupExists = await fileExists(BACKUP_WWW_DIR)
  const wwwExists = await fileExists(LOCAL_WWW_DIR)
  if (!backupExists) return

  logger.info('recoverIfNeeded: found backup dir: ' + BACKUP_WWW_DIR)
  if (!wwwExists) {
    logger.info('recoverIfNeeded: www absent -> restoring backup')
    await copyDir(BACKUP_WWW_DIR, LOCAL_WWW_DIR)
    await removeDirIfExists(BACKUP_WWW_DIR)
    logger.info('recoverIfNeeded: restore done')
  } else {
    // Situation ambigüe (backup present and www present). On garde le backup par sécurité.
    logger.info('recoverIfNeeded: both backup and www exist -> leaving backup in place for safety')
  }
}

/**
 * Effectue l'échange atomique :
 * 1) sauvegarde www -> BACKUP_WWW_DIR
 * 2) écriture du zip dans TMP_WWW_DIR
 * 3) test d'injection depuis TMP_WWW_DIR
 * 4) si OK : supprimer www, copier TMP_WWW_DIR -> www, supprimer TMP_WWW_DIR, supprimer BACKUP_WWW_DIR
 * 5) si KO : restaurer depuis BACKUP_WWW_DIR (si présent) et supprimer TMP_WWW_DIR
 */
async function performAtomicUpdateFromZip(arrayBuffer) {
  try {
    logger.info('performAtomicUpdateFromZip: starting atomic update')

    // 1) cleanup tmp and backup (pour état propre)
    await removeDirIfExists(TMP_WWW_DIR)
    // if a previous backup exists, remove it (or you can keep multiple backups, ici on écrase)
    await removeDirIfExists(BACKUP_WWW_DIR)

    // 2) create backup if www exists
    if (await fileExists(LOCAL_WWW_DIR)) {
      logger.info('performAtomicUpdateFromZip: creating backup from ' + LOCAL_WWW_DIR)
      await copyDir(LOCAL_WWW_DIR, BACKUP_WWW_DIR)
    } else {
      logger.info('performAtomicUpdateFromZip: no existing www to backup')
    }

    // 3) extract zip into TMP_WWW_DIR
    logger.info('performAtomicUpdateFromZip: extracting zip into tmp dir')
    const zip = await JSZip.loadAsync(arrayBuffer)
    await writeZipToDir(zip, TMP_WWW_DIR)

    // 4) test injection depuis TMP_WWW_DIR (n'affiche rien si showPrompts false)
    logger.info('performAtomicUpdateFromZip: testing injection from tmp dir')
    const injectedTmp = await injectLocalIndexIntoContainer('localAppContainer', TMP_WWW_DIR)
    if (!injectedTmp) {
      // tentative fallback : redirect vers tmp index (peut échouer en contexte in-app)
      try {
        const idxPath = `${TMP_WWW_DIR}/index.html`
        if (await fileExists(idxPath)) {
          const uriResult = await Filesystem.getUri({ directory: Directory.Data, path: idxPath })
          const fileUri = uriResult.uri || uriResult
          const webFriendly = Capacitor.convertFileSrc(fileUri)
          // attention : redirection ici fera quitter l'UI "native"
          window.location.href = webFriendly
          // si redirect ok on ne revient pas en JS ; si on revient c'est que ça a échoué
          return true
        }
      } catch (e) { /* ignore */ }

      // injection tmp a échoué -> restaure depuis backup
      logger.warn('performAtomicUpdateFromZip: injection from tmp failed -> will restore backup')
      // cleanup tmp
      await removeDirIfExists(TMP_WWW_DIR)
      if (await fileExists(BACKUP_WWW_DIR)) {
        // restore backup -> www
        await copyDir(BACKUP_WWW_DIR, LOCAL_WWW_DIR)
      }
      return false
    }

    // 5) injection depuis tmp a fonctionné => appliquer le swap
    logger.info('performAtomicUpdateFromZip: tmp injection OK -> applying swap')

    // supprimer l'ancien www (on l'a déjà backupé)
    await removeDirIfExists(LOCAL_WWW_DIR)

    // copier tmp -> www (effectue le "move")
    await copyDir(TMP_WWW_DIR, LOCAL_WWW_DIR)

    // supprimer tmp
    await removeDirIfExists(TMP_WWW_DIR)

    // supprimer backup (on a réussi)
    await removeDirIfExists(BACKUP_WWW_DIR)

    logger.info('performAtomicUpdateFromZip: atomic update success')
    return true
  } catch (e) {
    logger.error('performAtomicUpdateFromZip failed: ' + (e && e.message ? e.message : e))
    // Tentative de restauration
    try {
      await removeDirIfExists(TMP_WWW_DIR)
      if (await fileExists(BACKUP_WWW_DIR)) {
        await removeDirIfExists(LOCAL_WWW_DIR)
        await copyDir(BACKUP_WWW_DIR, LOCAL_WWW_DIR)
        await removeDirIfExists(BACKUP_WWW_DIR)
      }
    } catch (er) {
      logger.warn('performAtomicUpdateFromZip restore failed: ' + (er && er.message ? er.message : er))
    }
    return false
  }
}

/**
 * checkForUpdates : récupère version.json, compare buildId (ou version fallback),
 * puis télécharge app.zip et appelle performAtomicUpdateFromZip.
 */
export async function checkForUpdates(showPrompts = true) {
  try {
    logger.info('checkForUpdates: starting check...')

    const r = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' })
    if (!r.ok) {
      logger.warn('Impossible de récupérer version.json (status ' + r.status + ')')
      return
    }
    const remote = await r.json() // { version, buildId, ... }

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

    // si tout OK : sauvegarder prefs
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
      } catch (e) {
        // ignore confirm errors
      }
    } else {
      // auto-inject already happened during performAtomicUpdateFromZip (we injected tmp for test),
      // but after swap we may want to re-inject from real LOCAL_WWW_DIR to have correct baseUrl.
      await injectLocalIndexIntoContainer('localAppContainer', LOCAL_WWW_DIR)
    }
  } catch (err) {
    logger.error('checkForUpdates failed: ' + (err && err.message ? err.message : err))
  }
}
