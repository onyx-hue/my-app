import React, { useEffect, useState, useRef } from 'react'
import LogConsole from './components/LogConsole'
import { checkForUpdates, loadLocalIndexIfPresent, clearLocalBundle } from './otaUpdater'
import logger from './logger'

export default function App() {
  const [mode, setMode] = useState('booting') 
  const mountedRef = useRef(false)

  useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true

    const bootSequence = async () => {
      // 1. Essayer de charger le site local (injecte dans localAppContainer)
      const loaded = await loadLocalIndexIfPresent('localAppContainer')

      if (loaded) {
        setMode('local')
        logger.info('Mode Local activé : Le bundle a été injecté.')
      } else {
        setMode('default')
        logger.info('Mode Défaut activé : Utilisation de l’interface de secours.')
      }

      // 2. Vérification silencieuse de mise à jour en arrière-plan
      checkForUpdates(false)
    }

    bootSequence()
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
      
      {/* Conteneur pour le bundle téléchargé */}
      <div 
        id="localAppContainer" 
        style={{ 
          display: mode === 'local' ? 'block' : 'none',
          width: '100%',
          height: '100%',
          position: 'absolute',
          top: 0,
          left: 0
        }} 
      />

      {/* Écran de chargement initial */}
      {mode === 'booting' && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
          <p>Initialisation...</p>
        </div>
      )}

      {/* Interface de secours (visible uniquement si pas de bundle local) */}
      {mode === 'default' && (
        <div style={{ padding: 20 }}>
          <h1>Grimdel</h1>
          <p>Recherche de mise à jour en cours...</p>
          <hr />
          <button onClick={() => checkForUpdates(true)}>Vérifier maintenant</button>
          <button 
            onClick={async () => { await clearLocalBundle(); window.location.reload(); }} 
            style={{ marginLeft: 10, background: '#d9534f', color: 'white' }}
          >
            Reset Bundle
          </button>
          <LogConsole initiallyOpen={true} />
        </div>
      )}

      {/* La console reste accessible même en mode local via un petit bouton (géré dans LogConsole) */}
      {mode === 'local' && <LogConsole initiallyOpen={false} />}
    </div>
  )
}