// src/otaUpdater.js
import JSZip from 'jszip'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Preferences } from '@capacitor/preferences'
import { Capacitor } from '@capacitor/core'
import logger from './logger'

const VERSION_URL = 'https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO/version.json'
const BUNDLE_URL = 'https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO/app.zip'
const LOCAL_WWW_DIR = 'www' // path under Directory.Data

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

// New: try to inject local index into a container instead of navigating away
export async function injectLocalIndexIntoContainer(containerId = 'localAppContainer') {
  try {
    const idxPath = `${LOCAL_WWW_DIR}/index.html`
    if (!(await fileExists(idxPath))) {
      logger.info('injectLocalIndex: no local index found at ' + idxPath)
      return false
    }

    // read index.html as base64 then decode
    const file = await Filesystem.readFile({ path: idxPath, directory: Directory.Data })
    const html = atob(file.data) // decode base64 to string
    // get uri for index to compute base
    const uriResult = await Filesystem.getUri({ directory: Directory.Data, path: idxPath })
    const fileUri = uriResult.uri || uriResult
    const webFriendly = Capacitor.convertFileSrc(fileUri)
    // compute base url by removing trailing index.html
    const baseUrl = webFriendly.replace(/index\.html?$/i, '')

    logger.info('injectLocalIndex: baseUrl=' + baseUrl)

    // find container in current document
    const container = document.getElementById(containerId)
    if (!container) {
      logger.warn('injectLocalIndex: container not found: ' + containerId)
      return false
    }

    // construct a DOM parser to extract head/body
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')

    // set base tag so relative URLs resolve to local files
    let baseTag = doc.querySelector('base')
    if (!baseTag) {
      baseTag = doc.createElement('base')
      doc.head.insertBefore(baseTag, doc.head.firstChild)
    }
    baseTag.setAttribute('href', baseUrl)

    // Serialize the modified document's body and head (we will set container.innerHTML to body content)
    const bodyHtml = doc.body.innerHTML
    const headHtml = doc.head.innerHTML

    // Optional: insert head tags (styles, meta) into current document head
    // We'll append link/style tags into current head
    (function injectHead() {
      // create a temporary element to parse headHtml
      const temp = document.createElement('div')
      temp.innerHTML = headHtml
      // move only link, style, meta tags
      Array.from(temp.children).forEach(node => {
        const tagName = node.tagName && node.tagName.toLowerCase()
        if (['link', 'style', 'meta'].includes(tagName)) {
          // clone node into current document
          document.head.appendChild(node.cloneNode(true))
        }
      })
    })()

    // Set container content (body). This will not execute <script> tags automatically reliably.
    container.innerHTML = bodyHtml

    // Re-execute scripts: find script tags in parsed doc and create new script elements with absolute src
    const scripts = Array.from(doc.querySelectorAll('script'))
    for (const s of scripts) {
      const newScript = document.createElement('script')
      if (s.src) {
        // resolve relative src using baseUrl by creating a URL
        let src = s.getAttribute('src')
        // if src is relative, make absolute against baseUrl
        try {
          src = new URL(src, baseUrl).toString()
        } catch (e) {
          // fallback: use as-is
        }
        newScript.src = src
        newScript.async = false // preserve execution order
        container.appendChild(newScript)
        logger.info('Injected external script: ' + src)
      } else {
        // inline script: copy text
        try {
          newScript.text = s.textContent
          container.appendChild(newScript)
        } catch (e) {
          logger.warn('Failed to inject inline script: ' + e)
        }
      }
    }

    logger.info('injectLocalIndex: injection completed')
    return true
  } catch (e) {
    logger.error('injectLocalIndex failed: ' + (e && e.message ? e.message : e))
    return false
  }
}

export async function loadLocalIndexIfPresent() {
  // First try the inject approach so we keep the React app and the logger UI alive
  const injected = await injectLocalIndexIntoContainer()
  if (injected) {
    logger.info('loadLocalIndexIfPresent: injected local index successfully')
    return true
  }

  // fallback: navigate to file (previous approach)
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
    logger.error('Fallback loadLocalIndex failed: ' + e)
    return false
  }
}

export async function checkForUpdates(showPrompts = true) {
  try {
    logger.info('checkForUpdates: start')
    const r = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' })
    if (!r.ok) {
      logger.warn('Impossible de récupérer version.json, status=' + r.status)
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

    logger.info('OTA: Nouvelle version détectée: ' + remote.version)
    const z = await fetch(BUNDLE_URL + '?t=' + Date.now())
    if (!z.ok) {
      logger.error('Erreur téléchargement bundle: ' + z.status)
      return
    }

    logger.info('Téléchargement terminé, traitement du zip (peut prendre du temps)...')
    const arrayBuffer = await z.arrayBuffer()
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
    logger.info('OTA: bundle appliqué. version=' + remote.version)

    if (showPrompts) {
      if (confirm(`Nouvelle version (${remote.version}) téléchargée. Charger maintenant ?`)) {
        // try injection (keeps UI)
        const ok = await injectLocalIndexIntoContainer()
        if (!ok) {
          logger.warn('Injection failed, fallback to navigate')
          await loadLocalIndexIfPresent()
        }
      }
    } else {
      // silent: try injection
      await injectLocalIndexIntoContainer()
    }
  } catch (err) {
    logger.error('checkForUpdates failed: ' + (err && err.message ? err.message : err))
  }
}
