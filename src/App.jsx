// src/App.jsx
import React, { useState } from 'react'
import LogConsole from './components/LogConsole'
import { checkForUpdates, loadLocalIndexIfPresent, clearLocalBundle } from './otaUpdater'
import logger from './logger'

export default function App() {
  const [status, setStatus] = useState('idle')

  const handleCheck = async () => {
    setStatus('checking')
    await checkForUpdates(true)
    setStatus('idle')
  }

  const handleLoadLocal = async () => {
    setStatus('loading-local')
    try {
      const ok = await loadLocalIndexIfPresent()
      if (!ok) {
        logger.warn('Aucun bundle local trouvé ou échec de chargement.')
        alert('Aucun bundle local présent ou échec de chargement. Vérifie les logs.')
      }
    } catch (e) {
      logger.error('Erreur loadLocal: ' + e)
      alert('Erreur lors du chargement local — voir la console.')
    } finally {
      setStatus('idle')
    }
  }

  const handleReset = async () => {
    if (!confirm('Supprimer le bundle local et revenir au contenu embarqué ?')) return
    setStatus('resetting')
    try {
      await clearLocalBundle()
      logger.info('Reset effectué — redémarrage de l\'app pour charger le bundle embarqué.')
      // reload to use bundled assets
      window.location.reload()
    } catch (e) {
      logger.error('Reset failed: ' + e)
    } finally {
      setStatus('idle')
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <h1>Nouveau</h1>

      <div style={{ marginBottom: 12 }}>
        <button onClick={handleCheck} style={{ padding: 8 }}>Vérifier MAJ (manuel)</button>
        <button onClick={handleLoadLocal} style={{ marginLeft: 8, padding: 8 }}>Charger bundle local</button>
        <button onClick={handleReset} style={{ marginLeft: 8, padding: 8, background: '#d9534f', color: '#fff' }}>
          Reset bundle local
        </button>
      </div>

      <div style={{ marginTop: 8, marginBottom: 12 }}>
        <strong>Statut:</strong> {status}
      </div>

      <div id="localAppContainer" style={{ border: '1px dashed #ccc', minHeight: 320, padding: 8 }}>
        <p style={{ color: '#666' }}>Contenu local injecté (si tu appuies sur "Charger bundle local").</p>
      </div>

      <LogConsole initiallyOpen={true} />
    </div>
  )
}
