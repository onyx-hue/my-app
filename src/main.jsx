import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// On utilise shell-root pour ne pas interférer avec le 'root' du bundle local
const container = document.getElementById('shell-root');
const root = ReactDOM.createRoot(container);

root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
);