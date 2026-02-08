// src/components/LogConsole.jsx
import React, { useEffect, useState, useRef } from 'react'
import logger from '../logger'

export default function LogConsole({ initiallyOpen = false }) {
  const [open, setOpen] = useState(initiallyOpen)
  const [logs, setLogs] = useState([])
  const [autoScroll, setAutoScroll] = useState(true)
  const containerRef = useRef(null)

  useEffect(() => {
    const unsub = logger.subscribe(setLogs)
    return () => unsub()
  }, [])

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  function handleClear() {
    logger.clear()
  }

  function handleExport() {
    const data = JSON.stringify(logs, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'app-logs.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{
      position: 'fixed',
      right: 12,
      bottom: 12,
      width: open ? 520 : 48,
      height: open ? 360 : 48,
      background: 'rgba(20,20,20,0.95)',
      color: '#fff',
      borderRadius: 8,
      boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
      zIndex: 9999,
      overflow: 'hidden',
      fontFamily: 'monospace',
      fontSize: 12
    }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 8px', gap: 8, background: 'rgba(255,255,255,0.03)' }}>
        <button onClick={() => setOpen(o => !o)} style={{ padding: 6 }}>
          {open ? 'Fermer' : 'Logs'}
        </button>
        {open && (
          <>
            <button onClick={handleClear} style={{ padding: 6 }}>Effacer</button>
            <button onClick={handleExport} style={{ padding: 6 }}>Exporter</button>
            <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} /> Auto-scroll
            </label>
          </>
        )}
      </div>

      {open ? (
        <div ref={containerRef} style={{ padding: 8, height: 'calc(100% - 40px)', overflowY: 'auto' }}>
          {logs.length === 0 && <div style={{ color: 'rgba(255,255,255,0.6)' }}>Aucun log</div>}
          {logs.map((l, i) => (
            <div key={i} style={{ marginBottom: 6, lineHeight: '1.2' }}>
              <div style={{ color: 'rgba(255,255,255,0.55)' }}>{l.ts}</div>
              <div>
                <span style={{
                  padding: '2px 6px',
                  borderRadius: 4,
                  marginRight: 8,
                  background: l.level === 'error' ? '#8b2d2d' : (l.level === 'warn' ? '#7a5a00' : '#2a6b2a'),
                  color: '#fff',
                  fontWeight: 700
                }}>{l.level.toUpperCase()}</span>
                <span style={{ color: '#fff' }}>{l.msg}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
