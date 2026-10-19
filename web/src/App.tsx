import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './layout/AppShell'
import { Home } from './pages/Home'
import { Inbox } from './pages/Inbox'
import { Settings } from './pages/Settings'
import { ProjectLayout } from './pages/project/ProjectLayout'
import { useApp } from './store/app'

export function App() {
  const connect = useApp(s => s.connect)
  useEffect(() => connect(), [connect])
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/settings/*" element={<Settings />} />
        <Route path="/p/:id/*" element={<ProjectLayout />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}
