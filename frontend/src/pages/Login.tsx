import { useState, useEffect } from 'react';
import './Login.css';
import { TestConnection, LoadProfiles, SaveProfile, GetDefaultProfile, CheckOssutilInstalled } from '../../wailsjs/go/main/OSSService';
import { main } from '../../wailsjs/go/models';

interface LoginProps {
  onLoginSuccess: (config: main.OSSConfig) => void;
}

function Login({ onLoginSuccess }: LoginProps) {
  const [accessKeyId, setAccessKeyId] = useState('');
  const [accessKeySecret, setAccessKeySecret] = useState('');
  const [region, setRegion] = useState('cn-hangzhou');
  const [endpoint, setEndpoint] = useState('');
  
  const [profiles, setProfiles] = useState<main.OSSProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState('');
  
  const [saveAsProfile, setSaveAsProfile] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [setAsDefault, setSetAsDefault] = useState(false);
  
  const [loading, setLoading] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    initializeApp();
  }, []);

  const initializeApp = async () => {
    // Check if ossutil is installed
    const result = await CheckOssutilInstalled();
    if (!result.success) {
      setMessage({ type: 'error', text: `ossutil not found: ${result.message}. Please install ossutil v2 first.` });
    } else {
      setMessage({ type: 'info', text: `ossutil detected: ${result.message}` });
      setTimeout(() => setMessage(null), 3000);
    }

    // Load saved profiles
    try {
      const savedProfiles = await LoadProfiles();
      setProfiles(savedProfiles || []);

      // Load default profile if exists
      const defaultProfile = await GetDefaultProfile();
      if (defaultProfile) {
        loadProfile(defaultProfile);
        setSelectedProfile(defaultProfile.name);
      }
    } catch (error) {
      console.error('Failed to load profiles:', error);
    }
  };

  const loadProfile = (profile: main.OSSProfile) => {
    setAccessKeyId(profile.config.accessKeyId);
    setAccessKeySecret(profile.config.accessKeySecret);
    setRegion(profile.config.region);
    setEndpoint(profile.config.endpoint || '');
  };

  const handleProfileChange = (profileName: string) => {
    setSelectedProfile(profileName);
    const profile = profiles.find(p => p.name === profileName);
    if (profile) {
      loadProfile(profile);
    } else {
      // Clear form for new profile
      setAccessKeyId('');
      setAccessKeySecret('');
      setRegion('cn-hangzhou');
      setEndpoint('');
    }
  };

  const handleTestConnection = async () => {
    if (!accessKeyId || !accessKeySecret || !region) {
      setMessage({ type: 'error', text: 'Please fill in required fields' });
      return;
    }

    setTestingConnection(true);
    setMessage(null);

    try {
      const config: main.OSSConfig = {
        accessKeyId,
        accessKeySecret,
        region,
        endpoint,
      };

      const result = await TestConnection(config);
      if (result.success) {
        setMessage({ type: 'success', text: 'Connection successful!' });
      } else {
        setMessage({ type: 'error', text: result.message });
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Connection test failed' });
    } finally {
      setTestingConnection(false);
    }
  };

  const handleConnect = async () => {
    if (!accessKeyId || !accessKeySecret || !region) {
      setMessage({ type: 'error', text: 'Please fill in required fields' });
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const config: main.OSSConfig = {
        accessKeyId,
        accessKeySecret,
        region,
        endpoint,
      };

      // Test connection first
      const result = await TestConnection(config);
      if (!result.success) {
        setMessage({ type: 'error', text: result.message });
        setLoading(false);
        return;
      }

      // Save profile if requested
      if (saveAsProfile && profileName) {
        const profile = new main.OSSProfile({
          name: profileName,
          config,
          isDefault: setAsDefault,
        });
        await SaveProfile(profile);
        
        // Refresh profiles
        const savedProfiles = await LoadProfiles();
        setProfiles(savedProfiles || []);
      }

      // On success, notify parent
      onLoginSuccess(config);
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Connection failed' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-header">
          <svg className="login-logo" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="64" height="64" rx="16" fill="url(#logo-gradient)"/>
            <path d="M20 32C20 25.373 25.373 20 32 20C38.627 20 44 25.373 44 32" stroke="white" strokeWidth="3" strokeLinecap="round"/>
            <path d="M26 32C26 28.686 28.686 26 32 26C35.314 26 38 28.686 38 32" stroke="white" strokeWidth="3" strokeLinecap="round"/>
            <circle cx="32" cy="32" r="3" fill="white"/>
            <path d="M32 35V44" stroke="white" strokeWidth="3" strokeLinecap="round"/>
            <defs>
              <linearGradient id="logo-gradient" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
                <stop stopColor="#4facfe"/>
                <stop offset="1" stopColor="#00f2fe"/>
              </linearGradient>
            </defs>
          </svg>
          <h1 className="login-title">Walioss</h1>
          <p className="login-subtitle">Connect to Alibaba Cloud OSS</p>
        </div>

        <div className="login-form">
          {profiles.length > 0 && (
            <div className="profile-section">
              <select 
                className="profile-select"
                value={selectedProfile}
                onChange={(e) => handleProfileChange(e.target.value)}
              >
                <option value="">Select a profile...</option>
                {profiles.map(p => (
                  <option key={p.name} value={p.name}>
                    {p.name} {p.isDefault ? '(Default)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">AccessKey ID *</label>
            <input
              type="text"
              className="form-input"
              placeholder="Enter your AccessKey ID"
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="form-group">
            <label className="form-label">AccessKey Secret *</label>
            <input
              type="password"
              className="form-input"
              placeholder="Enter your AccessKey Secret"
              value={accessKeySecret}
              onChange={(e) => setAccessKeySecret(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Region *</label>
              <input
                type="text"
                className="form-input"
                placeholder="e.g. cn-hangzhou"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Endpoint</label>
              <input
                type="text"
                className="form-input"
                placeholder="Custom endpoint (optional)"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </div>
          </div>

          <div className="save-profile-section">
            <label>
              <input
                type="checkbox"
                checked={saveAsProfile}
                onChange={(e) => setSaveAsProfile(e.target.checked)}
              />
              Save as profile
            </label>
            {saveAsProfile && (
              <>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Profile name"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  style={{ maxWidth: '150px' }}
                />
                <label>
                  <input
                    type="checkbox"
                    checked={setAsDefault}
                    onChange={(e) => setSetAsDefault(e.target.checked)}
                  />
                  Default
                </label>
              </>
            )}
          </div>

          {message && (
            <div className={`message ${message.type}`}>
              <span className="message-icon">
                {message.type === 'success' && '✓'}
                {message.type === 'error' && '✕'}
                {message.type === 'info' && 'ℹ'}
              </span>
              <span>{message.text}</span>
            </div>
          )}

          <div className="button-group">
            <button
              className="btn btn-secondary"
              onClick={handleTestConnection}
              disabled={testingConnection || loading}
            >
              {testingConnection ? (
                <>
                  <span className="spinner"></span>
                  Testing...
                </>
              ) : (
                'Test Connection'
              )}
            </button>
            <button
              className="btn btn-primary"
              onClick={handleConnect}
              disabled={loading || testingConnection}
            >
              {loading ? (
                <>
                  <span className="spinner"></span>
                  Connecting...
                </>
              ) : (
                'Connect'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Login;
