// src/BootLoader.jsx
import React, { useEffect, useState } from 'react'
import { installPendingUpdate, loadLocalIndexIfPresent } from './otaUpdater'
import App from './App'

export default function BootLoader() {
  // 'loading' | 'ready-local' | 'ready-bundled'
  const [stage, setStage] = useState('loading')

  useEffect(() => {
    const init = async () => {
      // 1. Vérifier et installer la mise à jour en attente (s'il y en a une)
      // Cela dézippe le fichier "pending" dans "www"
      await installPendingUpdate()

      // 2. Tenter de charger l'index local (celui qu'on vient d'installer ou un ancien)
      const loaded = await loadLocalIndexIfPresent()
      
      if (loaded) {
        // Si loadLocalIndexIfPresent renvoie true, il a injecté le HTML
        // et le navigateur va basculer dessus. On ne fait rien de plus côté React.
        setStage('ready-local')
      } else {
        // Sinon, on charge l'App React par défaut (bundled)
        setStage('ready-bundled')
      }
    }

    init()
  }, [])

  if (stage === 'loading') {
    return (
      <div style={{ 
        height: '100vh', 
        display: 'flex', 
        flexDirection: 'column',
        justifyContent: 'center', 
        alignItems: 'center',
        background: '#f0f0f0',
        fontFamily: 'sans-serif'
      }}>
        <div className="loader" style={{ 
            border: '4px solid #f3f3f3', 
            borderTop: '4px solid #3498db', 
            borderRadius: '50%', 
            width: 40, 
            height: 40, 
            animation: 'spin 1s linear infinite',
            marginBottom: 20
        }}></div>
        <p style={{ color: '#666' }}>Chargement...</p>
        <style>{`
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        `}</style>
      </div>
    )
  }

  // Si on est ici, c'est que le bundle local n'a pas pu être chargé,
  // on affiche l'application "Usine" (celle compilée dans l'APK/IPA)
  if (stage === 'ready-bundled') {
    return <App />
  }

  return null // Cas 'ready-local', l'écran est géré par l'injection HTML
}