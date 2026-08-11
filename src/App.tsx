import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';

import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider, ProtectedRoute } from './components/auth';
import { TaskMasterProvider } from './contexts/TaskMasterContext';
import { TasksSettingsProvider } from './contexts/TasksSettingsContext';
import { TenantProvider } from './contexts/TenantContext';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { PluginsProvider } from './contexts/PluginsContext';
import AppContent from './components/app/AppContent';
import AdminPage from './components/admin/AdminPage';
import i18n from './i18n/config.js';

export default function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <AuthProvider>
          <TenantProvider>
            <WebSocketProvider>
              <PluginsProvider>
                <TasksSettingsProvider>
                  <TaskMasterProvider>
                    <ProtectedRoute>
                      <Router basename={window.__ROUTER_BASENAME__ || ''}>
                        <Routes>
                          <Route path="/" element={<AppContent />} />
                          <Route path="/session/:sessionId" element={<AppContent />} />
                          <Route path="/agent-graph" element={<AppContent />} />
                          <Route path="/admin" element={<AdminPage />} />
                        </Routes>
                      </Router>
                    </ProtectedRoute>
                  </TaskMasterProvider>
                </TasksSettingsProvider>
              </PluginsProvider>
            </WebSocketProvider>
          </TenantProvider>
        </AuthProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
