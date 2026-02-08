// src/main.jsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { loadLocalIndexIfPresent, checkForUpdates } from './otaUpdater'

// 1) Si un bundle local existe -> on bascule directement dessus (la fonction navigue et quitte si succès)
loadLocalIndexIfPresent().then(found => {
  if (!found) {
    // 2) Sinon on démarre l'app normale et on vérifie en background si une update est dispo
    ReactDOM.createRoot(document.getElementById('root')).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )
    // vérifie en background (silent). Tu peux appeler sans paramètre ou avec true pour prompts.
    checkForUpdates(false)
    // possibilité : checkForUpdates(true) si tu veux demander à l'utilisateur avant le reload
  }
})
