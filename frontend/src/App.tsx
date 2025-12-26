import { useState } from 'react';
import './App.css';
import Login from './pages/Login';
import FileBrowser from './components/FileBrowser';
import { main } from '../wailsjs/go/models';

type AppView = 'login' | 'dashboard';

function App() {
  const [currentView, setCurrentView] = useState<AppView>('login');
  const [currentConfig, setCurrentConfig] = useState<main.OSSConfig | null>(null);

  const handleLoginSuccess = (config: main.OSSConfig) => {
    setCurrentConfig(config);
    setCurrentView('dashboard');
  };

  const handleLogout = () => {
    setCurrentConfig(null);
    setCurrentView('login');
  };

  if (currentView === 'login') {
    return <Login onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <h1>Walioss</h1>
        <div className="header-info">
          <span>Region: {currentConfig?.region}</span>
          <button className="btn-logout" onClick={handleLogout}>Logout</button>
        </div>
      </header>
      <main className="dashboard-main">
        {currentConfig && <FileBrowser config={currentConfig} />}
      </main>
    </div>
  );
}

export default App;
