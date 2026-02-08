// src/App.jsx
import React, { useEffect, useState } from 'react'
import LogConsole from './components/LogConsole'
import { checkForUpdates, loadLocalIndexIfPresent } from './otaUpdater'
import logger from './logger'
import { Filesystem, Directory } from '@capacitor/filesystem'

const LOCAL_WWW_DIR = 'www'

export default function App() {
  const [listing, setListing] = useState([])
  const [indexHtml, setIndexHtml] = useState('')
  const [loadingList, setLoadingList] = useState(false)

  useEffect(() => {
    // Try to inject or start UI normally
    loadLocalIndexIfPresent().then(found => {
      if (!found) {
        logger.info('No local bundle injected on startup; React UI remains visible.')
      } else {
        logger.info('Local bundle loaded on startup via inject/navigation.')
      }
    })
  }, [])

  async function listLocalFiles() {
    setLoadingList(true)
    try {
      // recursive listing helper
      async function readDir(path) {
        try {
          const res = await Filesystem.readdir({ path, directory: Directory.Data })
          const out = []
          for (const name of res.files || []) {
            const full = path ? `${path}/${name}` : name
            // try stat to know if dir
            try {
              const s = await Filesystem.stat({ path: full, directory: Directory.Data })
              if (s.type === 'directory') {
                out.push({ path: full, type: 'dir' })
                const child = await readDir(full)
                out.push(...child)
              } else {
                out.push({ path: full, type: 'file', size: s.size || 0 })
              }
            } catch (e) {
              out.push({ path: full, type: 'unknown' })
            }
          }
          return out
        } catch (e) {
          return []
        }
      }

      const files = await readDir(LOCAL_WWW_DIR)
      setListing(files)
      logger.info('Local listing completed: ' + files.length + ' items')
    } catch (e) {
      logger.error('listLocalFiles error: ' + e)
      setListing([])
    } finally {
      setLoadingList(false)
    }
  }

  async function showIndexHtml() {
    try {
      const idxPath = `${LOCAL_WWW_DIR}/index.html`
      const exists = await Filesystem.stat({ path: idxPath, directory: Directory.Data }).catch(() => null)
      if (!exists) {
        setIndexHtml('(index.html absent)')
        return
      }
      const f = await Filesystem.readFile({ path: idxPath, directory: Directory.Data })
      const text = atob(f.data)
      setIndexHtml(text)
      logger.info('Loaded local index.html (length=' + text.length + ')')
    } catch (e) {
      logger.error('showIndexHtml failed: ' + e)
      setIndexHtml('(erreur lecture index: ' + e + ')')
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <h1>Mon app — Debug OTA</h1>

      <div style={{ marginBottom: 12 }}>
        <button onClick={() => checkForUpdates(true)} style={{ padding: 8 }}>Vérifier MAJ (manuel)</button>
        <button onClick={() => loadLocalIndexIfPresent()} style={{ marginLeft: 8, padding: 8 }}>Charger bundle local</button>
        <button onClick={() => { listLocalFiles(); }} style={{ marginLeft: 8, padding: 8 }}>Lister fichiers locaux</button>
        <button onClick={() => showIndexHtml()} style={{ marginLeft: 8, padding: 8 }}>Afficher index.html</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ border: '1px solid #ddd', padding: 12, borderRadius: 8, minHeight: 200 }}>
          <h3>Fichiers locaux ({listing.length})</h3>
          {loadingList ? <div>Chargement...</div> : (
            <div style={{ maxHeight: 400, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>
              {listing.map((f, i) => (
                <div key={i} style={{ padding: '2px 0' }}>
                  <strong>{f.type}</strong> — {f.path} {f.size ? `(${f.size} bytes)` : ''}
                </div>
              ))}
              {listing.length === 0 && <div style={{ color: '#666' }}>Aucun fichier listé</div>}
            </div>
          )}
        </div>

        <div style={{ border: '1px solid #ddd', padding: 12, borderRadius: 8, minHeight: 200 }}>
          <h3>Contenu de index.html</h3>
          <div style={{ maxHeight: 400, overflow: 'auto', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {indexHtml || '(vide)'}
          </div>
        </div>
      </div>

      <hr style={{ margin: '12px 0' }} />

      <div>
        <h3>Zone d'injection (si bundle local chargé)</h3>
        <div id="localAppContainer" style={{ border: '1px dashed #ccc', minHeight: 300, padding: 8 }}></div>
        <p style={{ color: '#666', marginTop: 8 }}>Les ressources locales (CSS/JS) devraient être résolues par la fonction d'injection. Si tu vois un écran blanc, ouvre la console flottante (Logs) et regarde les erreurs.</p>
      </div>

      <LogConsole initiallyOpen={true} />
    </div>
  )
}
