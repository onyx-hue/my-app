// src/main.jsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { loadLocalIndexIfPresent, checkForUpdates, applyPendingUpdateIfPresent } from './otaUpdater'

// 1. On rend l'application TOUT DE SUITE pour s'assurer que le DOM (et #localAppContainer) existe.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// 2. Ensuite, on applique d'abord une éventuelle mise à jour "staged" (pendante) si présente.
//    L'objectif : si un ZIP avait été téléchargé lors d'une précédente session, on l'applique maintenant
//    afin que l'utilisateur voit directement la version la plus récente qui a été téléchargée précédemment.
(async () => {
  try {
    const applied = await applyPendingUpdateIfPresent()
    if (applied) {
      console.log('Mise à jour en attente appliquée.')
      // applyPendingUpdateIfPresent fait l'injection dans le container si elle réussit
      // donc on peut considérer notre job ici terminé.
      return
    }
  } catch (e) {
    console.warn('Erreur lors de l\'application de la mise à jour pendante :', e)
  }

  // 3. Si aucune mise à jour pendante n'a été appliquée, on tente de charger un bundle local si présent.
  const found = await loadLocalIndexIfPresent()
  if (found) {
    console.log('Bundle local chargé avec succès.')
    return
  }

  // 4. Sinon, on vérifie la mise à jour distante (téléchargement en arrière-plan).
  //    On passe showPrompts=false pour que le téléchargement se fasse silencieusement :
  //    la nouvelle version sera stockée en pending et appliquée au prochain lancement.
  console.log('Pas de bundle local, vérification distante...')
  checkForUpdates(false)
})()
