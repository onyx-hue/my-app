import React, { useEffect, useState, useRef } from 'react'
import LogConsole from './components/LogConsole'
import { checkForUpdates, loadLocalIndexIfPresent, clearLocalBundle } from './otaUpdater'
import logger from './logger'

export default function App() {
  // 'booting' = écran blanc au départ, on ne sait pas encore quoi afficher
  // 'local' = le contenu téléchargé est affiché
  // 'default' = pas de contenu local, on affiche l'app par défaut (tes boutons de debug)
  const [mode, setMode] = useState('booting') 
  const mountedRef = useRef(false)

  useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true

    const bootSequence = async () => {
      // 1. Essayer de charger le site local IMMÉDIATEMENT
      // On passe l'ID du container qu'on a rendu dans le return plus bas
      const loaded = await loadLocalIndexIfPresent('localAppContainer')

      if (loaded) {
        // SUCCÈS : On fige React sur le mode 'local'.
        // Le contenu HTML a été injecté dans la div #localAppContainer
        setMode('local')
        logger.info('Mode Local activé.')
      } else {
        // ÉCHEC : Pas de version locale, on affiche l'interface de secours/debug
        setMode('default')
        logger.info('Mode Défaut activé (pas de bundle local).')
      }

      // 2. Dans TOUS les cas, on lance la vérification de mise à jour en arrière-plan
      // false = pas de popup, tout se fait en silence
      checkForUpdates(false)
    }

    bootSequence()
  }, [])

  // Rendu conditionnel pour éviter le clignotement
  return (
    <div style={{ width: '100%', height: '100%' }}>
      
      {/* Ce conteneur est TOUJOURS présent dans le DOM.
         S'il y a une version locale, 'loadLocalIndexIfPresent' va remplir ce div.
         Si on est en mode 'local', on s'assure qu'il est visible.
         Sinon, on peut le cacher.
      */}
      <div 
        id="localAppContainer" 
        style={{ 
          display: mode === 'local' ? 'block' : 'none',
          minHeight: '100vh' 
        }} 
      />

      {/* Si on est encore au démarrage, on n'affiche RIEN (ou un loading) pour éviter le flash */}
      {mode === 'booting' && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 50 }}>
          Chargement...
        </div>
      )}

      {/* Si et seulement si on n'a PAS trouvé de site local, on affiche ton interface de debug */}
      {mode === 'default' && (
        <div style={{ padding: 16 }}>
          <h1>Grimdel</h1>
          <p>Aucune version locale trouvée. Téléchargement en cours en arrière-plan...</p>
          <p>Au prochain démarrage, la nouvelle version s'affichera ici.</p>
          
          <hr />
          <h3>Actions Debug</h3>
          <button onClick={() => checkForUpdates(true)}>Forcer Vérification MAJ</button>
          <button onClick={async () => { await clearLocalBundle(); alert('Supprimé. Redémarre l\'app.'); }} style={{marginLeft: 10, background: 'red', color: 'white'}}>
            Reset Local Bundle
          </button>
          
          <LogConsole initiallyOpen={true} />
        </div>
      )}

      {/* En mode local, on peut quand même garder la console accessible si besoin, ou la masquer */}
      {mode === 'local' && <LogConsole initiallyOpen={false} />}
    </div>
  )
}