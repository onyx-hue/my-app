// src/App.jsx
import React, { useState, useEffect } from 'react'
import LogConsole from './components/LogConsole'
import { downloadUpdateInBackground, clearLocalBundle } from './otaUpdater' // On importe la nouvelle fn
import logger from './logger'

export default function App() {
  const [status, setStatus] = useState('idle')

  // Lancement automatique du check background au montage de l'app
  useEffect(() => {
    downloadUpdateInBackground()
  }, [])

  // Bouton de reset manuel (pour debug)
  const handleReset = async () => {
    if (!confirm('Supprimer le bundle local et revenir au contenu embarqué ?')) return
    setStatus('resetting')
    try {
      await clearLocalBundle()
      logger.info('Reset effectué.')
      window.location.reload()
    } catch (e) {
      logger.error('Reset failed: ' + e)
    } finally {
      setStatus('idle')
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <h1>Mon app v{/* Tu peux lire la version ici si tu veux */}</h1>
      
      <p>L'application vérifie les mises à jour en arrière-plan.</p>
      <p>Si une mise à jour est trouvée, elle sera appliquée au prochain redémarrage.</p>

      <div style={{ marginBottom: 12 }}>
         <button onClick={handleReset} style={{ padding: 8, background: '#d9534f', color: '#fff' }}>
           Reset bundle local (Debug)
         </button>
      </div>

      <LogConsole initiallyOpen={false} />
    </div>
  )
}