// src/main.jsx
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// On lance React tout de suite. C'est App.jsx qui décidera d'afficher blanc, le site local, ou le menu debug.
ReactDOM.createRoot(document.getElementById('root')).render(
    <App />
)