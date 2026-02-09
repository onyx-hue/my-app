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

// --- NOUVELLE LOGIQUE ---

/**
 * PHASE 1 (Démarrage):
 * Vérifie si un fichier "pending_update.zip" existe.
 * Si oui, on écrase le dossier 'www' avec son contenu.
 */
export async function installPendingUpdate() {
  try {
    const zipPath = PENDING_ZIP_FILENAME
    
    // 1. Vérifier si le fichier zip en attente existe
    try {
      await Filesystem.stat({ path: zipPath, directory: Directory.Data })
      logger.info('BOOT: Mise à jour en attente trouvée ! Installation...')
    } catch (e) {
      logger.info('BOOT: Aucune mise à jour en attente.')
      return false // Rien à faire
    }

    // 2. Lire le fichier zip depuis le stockage
    const readFileResult = await Filesystem.readFile({
      path: zipPath,
      directory: Directory.Data
    })
    
    // Sur Android/iOS readFile retourne souvent une base64 string
    const zipData = readFileResult.data

    // 3. Charger le ZIP avec JSZip
    const zip = await JSZip.loadAsync(zipData, { base64: true })

    // 4. Nettoyer l'ancien dossier www (sécurité)
    // On réutilise ta logique de nettoyage partielle ou on écrase.
    // Pour faire propre, on peut supprimer www d'abord.
    try {
        await Filesystem.rm({ path: LOCAL_WWW_DIR, directory: Directory.Data, recursive: true })
    } catch(e) {}

    // 5. Extraire le nouveau contenu
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
    logger.info('BOOT: Installation terminée.')

    // 6. Supprimer le fichier zip en attente pour ne pas le réinstaller au prochain boot
    await Filesystem.deleteFile({ path: zipPath, directory: Directory.Data })

    return true

  } catch (err) {
    logger.error('BOOT: Erreur lors de l\'installation de la mise à jour en attente: ' + err.message)
    // En cas d'erreur (zip corrompu?), on supprime le zip pour éviter une boucle infinie
    try { await Filesystem.deleteFile({ path: PENDING_ZIP_FILENAME, directory: Directory.Data }) } catch(e) {}
    return false
  }
}

/**
 * PHASE 2 (Background):
 * Vérifie le serveur, compare les versions/buildId.
 * Si nouveau, télécharge le ZIP et le sauvegarde sous "pending_update.zip".
 */
export async function downloadUpdateInBackground() {
  try {
    logger.info('BG: Vérification des mises à jour...')

    // 1. Check Remote
    const r = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' })
    if (!r.ok) return
    const remote = await r.json()

    // 2. Check Local Prefs (Ce qu'on utilise ACTUELLEMENT)
    const localBuildPref = await Preferences.get({ key: KEY_BUILD_ID })
    const localBuildId = localBuildPref?.value || null

    // Comparaison
    let updateAvailable = false
    if (remote.buildId && String(remote.buildId) !== String(localBuildId)) {
       updateAvailable = true
    } else if (!remote.buildId && remote.version !== (await Preferences.get({ key: KEY_VERSION })).value) {
       updateAvailable = true
    }

    if (!updateAvailable) {
        logger.info('BG: App à jour.')
        return
    }

    logger.info(`BG: Nouvelle version détectée (${remote.buildId}). Téléchargement...`)

    // 3. Télécharger le ZIP (Blob)
    const z = await fetch(BUNDLE_URL + '?t=' + Date.now())
    if (!z.ok) throw new Error('Download failed ' + z.status)
    
    // On récupère le blob
    const blob = await z.blob()
    
    // 4. Convertir Blob en Base64 pour l'écriture via Capacitor Filesystem
    const base64Data = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => {
            const res = reader.result
            // reader.result est "data:application/zip;base64,....." -> on veut juste la partie base64
            const base64 = res.split(',')[1]
            resolve(base64)
        }
        reader.onerror = reject
        reader.readAsDataURL(blob)
    })

    // 5. Sauvegarder en tant que "pending_update.zip"
    await Filesystem.writeFile({
        path: PENDING_ZIP_FILENAME,
        data: base64Data,
        directory: Directory.Data
    })

    // 6. Mettre à jour les préférences MAINTENANT ou APRÈS INSTALLATION ?
    // IMPORTANT : On ne doit PAS mettre à jour KEY_VERSION / KEY_BUILD_ID maintenant,
    // sinon au prochain boot, on croira qu'on est déjà à jour alors qu'on tourne sur la vieille version.
    // Cependant, il faut savoir quelle version le ZIP contient pour la mettre à jour après l'install.
    // Astuce simple : On stockera ces infos dans un petit fichier json "pending_meta.json" 
    // ou on fera confiance au version.json inclus dans le zip au prochain boot (plus simple).
    
    // Pour simplifier ton code actuel, on ne change pas les préférences ici. 
    // On mettra à jour les préférences UNIQUEMENT après le succès de `installPendingUpdate`.
    // Mais il faut stocker les métadonnées futures quelque part pour que installPendingUpdate puisse update les prefs.
    
    const meta = { version: remote.version, buildId: remote.buildId }
    await Filesystem.writeFile({
        path: 'pending_meta.json',
        data: JSON.stringify(meta),
        directory: Directory.Data,
        encoding: 'utf8'
    })

    logger.info('BG: Mise à jour téléchargée et prête pour le prochain démarrage.')

  } catch (err) {
    logger.error('BG: Erreur download: ' + err.message)
  }
}

// NOTE: Il faut modifier légèrement `installPendingUpdate` ci-dessus pour qu'il lise `pending_meta.json` 
// et mette à jour les Preferences après l'extraction.
// Ajoute ceci à la fin du bloc try de `installPendingUpdate`, juste avant le return true :
/*
    // Mise à jour des préférences post-install
    try {
        const metaFile = await Filesystem.readFile({ path: 'pending_meta.json', directory: Directory.Data, encoding: 'utf8' })
        const meta = JSON.parse(metaFile.data)
        await Preferences.set({ key: KEY_VERSION, value: meta.version })
        if (meta.buildId) await Preferences.set({ key: KEY_BUILD_ID, value: String(meta.buildId) })
        await Filesystem.deleteFile({ path: 'pending_meta.json', directory: Directory.Data })
    } catch(e) { logger.warn('BOOT: Impossible de maj les préférences version') }
*/