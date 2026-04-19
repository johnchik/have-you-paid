import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
import './App.css'
import { AppLayout } from './components/AppLayout'
import { Home } from './pages/Home'
import { JoinPage } from './pages/JoinPage'
import { SessionPage } from './pages/SessionPage'

const basename = import.meta.env.BASE_URL.replace(/\/$/, '')

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter basename={basename || undefined}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Home />} />
            <Route path="/join/:sessionId" element={<JoinPage />} />
            <Route path="/session/:sessionId" element={<SessionPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
