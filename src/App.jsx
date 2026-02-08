// src/App.jsx
import React from 'react'
import LogConsole from './components/LogConsole'
import { checkForUpdates, loadLocalIndexIfPresent } from './otaUpdater'
import logger from './logger'

export default function App() {
  React.useEffect(() => {
    // On essaye de charger le bundle local (si existant).
    // Si loadLocalIndexIfPresent réussit, l'app naviguera hors de React.
    loadLocalIndexIfPresent().then(found => {
      if (!found) {
        logger.info('Pas de bundle local au démarrage, UI React lancée.')
      } else {
        logger.info('Bundle local chargé au démarrage.')
      }
    })
  }, [])

  const handleCheck = async () => {
    logger.info('Trigger manuel de checkForUpdates()')
    await checkForUpdates(true)
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>Jolibois</h1>
      <p>Utilise le bouton ci-dessous pour forcer une vérification OTA et voir les logs en temps réel.</p>

      <div style={{ marginBottom: 12 }}>
        <button onClick={handleCheck} style={{ padding: '8px 12px' }}>Vérifier mise à jour</button>
        <button onClick={() => logger.info('Bouton test: log info')} style={{ marginLeft: 8, padding: '8px 12px' }}>Log test</button>
      </div>

      <div style={{ border: '1px solid #ddd', padding: 12, borderRadius: 8, background: '#fafafa' }}>
        <p>Contenu de l'app embarquée (test) — remplace par ton UI réelle.</p>
        <p>Tu verras les logs s'afficher via la console rouge flottante en bas à droite.</p>
      </div>

      <LogConsole initiallyOpen={false} />
    </div>
  )
}
