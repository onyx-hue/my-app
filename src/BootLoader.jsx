// src/BootLoader.jsx
import React, { useEffect, useState } from 'react'
import { installPendingUpdate, loadLocalIndexIfPresent } from './otaUpdater'
import App from './App'
import logger from './logger'

export default function BootLoader() {
  const [stage, setStage] = useState('loading')

  useEffect(() => {
    async function init() {
      try {
        // 1. Tenter d'installer s'il y a un zip
        await installPendingUpdate()

        // 2. Tenter de charger le contenu local
        // On s'assure que le DOM est prêt avant de chercher le container
        const loaded = await loadLocalIndexIfPresent('localAppContainer')
        
        if (loaded) {
          logger.info('BootLoader: Bundle local injecté.')
          setStage('ready-local')
          // On cache le root React pour laisser la place au bundle injecté
          document.getElementById('root').style.display = 'none'
        } else {
          logger.info('BootLoader: Pas de bundle local, chargement App usine.')
          setStage('ready-bundled')
        }
      } catch (e) {
        logger.error('BootLoader Error: ' + e.message)
        setStage('ready-bundled') // En cas de bug, on lance l'app par défaut
      }
    }
    init()
  }, [])

  if (stage === 'loading') {
    return (
      <div style={{ 
        height: '100vh', display: 'flex', flexDirection: 'column',
        justifyContent: 'center', alignItems: 'center', background: '#fff' 
      }}>
        <p>Chargement des ressources...</p>
        {/* Tu peux ajouter un spinner CSS ici */}
      </div>
    )
  }

  if (stage === 'ready-bundled') {
    return <App />
  }

  // Si stage === 'ready-local', on retourne null car 
  // le contenu est déjà injecté dans 'localAppContainer' par le script
  return null
}