// src/main.jsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { loadLocalIndexIfPresent, checkForUpdates } from './otaUpdater'

// 1. On rend l'application TOUT DE SUITE pour s'assurer que le DOM (et #localAppContainer) existe.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// 2. Ensuite, on vérifie si on doit injecter le contenu local par dessus
loadLocalIndexIfPresent().then(found => {
  if (found) {
    // Si trouvé et injecté avec succès, l'écran sera mis à jour automatiquement
    // car injectLocalIndexIntoContainer remplace le HTML du conteneur.
    console.log('Bundle local chargé avec succès.')
  } else {
    // 3. Sinon, on lance la vérification de mise à jour en background
    console.log('Pas de bundle local, vérification distante...')
    checkForUpdates(false)
  }
})